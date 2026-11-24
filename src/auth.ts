// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { Clock } from "./clock.ts";
import { MINUTE } from "./duration.ts";
import { errorMessage, type Logger } from "./log.ts";
import type { Notify } from "./notify.ts";
import {
  isBase64Url,
  MAX_CREDENTIAL_ID_LENGTH,
  MAX_PUBLIC_KEY_LENGTH,
  type Passkey,
  shortId,
  type Transport,
  TRANSPORTS,
} from "./passkeys.ts";
import type { StateKeeper } from "./state.ts";
import { InvalidInputError } from "./validate.ts";

export const CHALLENGE_TTL = 2 * MINUTE;
export const SETUP_CODE_TTL = 10 * MINUTE;
export const SETUP_MAX_ATTEMPTS = 5;
export const MAX_PENDING_CHALLENGES = 1000;
// Per source, so one visitor cannot push out the owner's challenge.
export const MAX_CHALLENGES_PER_SOURCE = 5;
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
// Responses from the browser are tiny; anything larger is not a real response.
const MAX_RESPONSE_FIELD_LENGTH = 16_384;

// Callers learn only that authentication failed; the reason goes to the log.
export class AuthError extends Error {
  readonly reason: string;
  // Whether a credential or setup code was actually tested and failed. Only these
  // count towards a block: a lost or expired challenge can be caused by others.
  readonly counted: boolean;

  constructor(reason: string, counted = false) {
    super("authentication failed");
    this.name = "AuthError";
    this.reason = reason;
    this.counted = counted;
  }
}

type ChallengeKind = "action" | "add-passkey" | "setup" | "register";

interface PendingChallenge<Action> {
  readonly challenge: string;
  readonly kind: ChallengeKind;
  readonly source: string;
  // The reset count when the challenge was made: a challenge from before a
  // reset must never complete after it.
  readonly generation: number;
  readonly expiresAt: number;
  readonly action?: Action;
  readonly userId?: string;
}

export interface AuthenticatorOptions {
  readonly keeper: StateKeeper;
  readonly rpId: string;
  readonly origin: string;
  // A fixed setup code from SETUP_TOKEN; when absent, codes are generated.
  readonly setupToken: string | undefined;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly notify?: Notify;
}

export interface Ceremony<Options> {
  readonly challengeId: string;
  readonly options: Options;
}

export type SetupState = "inactive" | "active" | "locked";

interface SetupCode {
  // Stored without the hyphen.
  readonly code: string;
  readonly expiresAt: number | undefined;
  attempts: number;
}

// Owns passkey registration and verification. `Action` is whatever the caller
// wants to run after a successful check; it is stored with the challenge, so
// what gets verified and what gets executed are always the same thing.
export class Authenticator<Action> {
  private readonly options: AuthenticatorOptions & { readonly narrowsAccess?: (action: Action) => boolean };
  private readonly challenges = new Map<string, PendingChallenge<Action>>();
  private setup: SetupCode | undefined;
  private locked = false;
  private generation = 0;

  // `narrowsAccess` marks actions that only take access away (revoking): their
  // passkey check must not fail because the disk is full.
  constructor(options: AuthenticatorOptions & { readonly narrowsAccess?: (action: Action) => boolean }) {
    this.options = options;
  }

  get hasPasskeys(): boolean {
    return this.options.keeper.state.passkeys.length > 0;
  }

  get passkeyCount(): number {
    return this.options.keeper.state.passkeys.length;
  }

  start(): void {
    if (!this.hasPasskeys) this.newSetupCode();
  }

  // Also replaces an expired code, so the owner finds a fresh one in the log.
  setupState(): SetupState {
    if (this.hasPasskeys) return "inactive";
    if (this.locked) return "locked";
    const setup = this.setup;
    if (setup === undefined || (setup.expiresAt !== undefined && this.options.clock() >= setup.expiresAt)) {
      this.newSetupCode();
    }
    return "active";
  }

  async beginSetup(code: unknown, source = "unknown"): Promise<Ceremony<PublicKeyCredentialCreationOptionsJSON>> {
    if (this.setupState() !== "active") throw new AuthError("setup is not available");
    const setup = this.setup as SetupCode;
    if (!this.codeMatches(code, setup.code)) {
      setup.attempts++;
      this.options.logger.warn("setup.failed", { attempts: setup.attempts });
      if (setup.attempts >= SETUP_MAX_ATTEMPTS) {
        if (this.options.setupToken === undefined) {
          this.newSetupCode();
        } else {
          this.locked = true;
          this.options.logger.error("setup.locked");
        }
      }
      throw new AuthError("wrong setup code", true);
    }
    return this.registrationCeremony("setup", source);
  }

  async beginAction(action: Action, source = "unknown"): Promise<Ceremony<PublicKeyCredentialRequestOptionsJSON>> {
    return this.authenticationCeremony("action", action, source);
  }

  async beginAddPasskey(source = "unknown"): Promise<Ceremony<PublicKeyCredentialRequestOptionsJSON>> {
    return this.authenticationCeremony("add-passkey", undefined, source);
  }

  // Returns the action stored when the challenge was created.
  async completeAction(challengeId: unknown, response: unknown): Promise<Action> {
    const pending = this.take(challengeId, "action");
    await this.verifyAuthentication(pending, response, "action");
    return pending.action as Action;
  }

  // Proves the owner holds an existing passkey, then hands out a registration
  // challenge for the new one.
  async authorizeNewPasskey(
    challengeId: unknown,
    response: unknown,
    source = "unknown",
  ): Promise<Ceremony<PublicKeyCredentialCreationOptionsJSON>> {
    const pending = this.take(challengeId, "add-passkey");
    await this.verifyAuthentication(pending, response, "add-passkey");
    // The new challenge inherits the verified one's generation: a reset between
    // here and its use must void it, even after the owner has set up again.
    return this.registrationCeremony("register", source, pending.generation);
  }

  async completeRegistration(challengeId: unknown, input: unknown): Promise<Passkey> {
    const pending = this.takeRegistration(challengeId);
    const response = parseRegistrationResponse(input);
    const { keeper, logger, clock } = this.options;

    return keeper.exclusive(async () => {
      const state = keeper.state;
      this.requireCurrent(pending);
      if (pending.kind === "setup" && state.passkeys.length > 0) this.reject("setup already completed");
      // Adding a passkey presupposes one exists; after a reset only setup may register.
      if (pending.kind === "register" && state.passkeys.length === 0) this.reject("no passkey to add to");
      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response,
          expectedChallenge: pending.challenge,
          expectedOrigin: this.options.origin,
          expectedRPID: this.options.rpId,
          requireUserVerification: true,
        });
      } catch (error) {
        this.reject(`registration did not verify: ${errorMessage(error)}`, true);
      }
      if (!verification.verified) this.reject("registration did not verify", true);
      const { credential } = verification.registrationInfo;
      const publicKey = Buffer.from(credential.publicKey).toString("base64url");
      if (!isBase64Url(credential.id, 16, MAX_CREDENTIAL_ID_LENGTH) || publicKey.length > MAX_PUBLIC_KEY_LENGTH) {
        this.reject("credential is outside the accepted size", true);
      }
      if (state.passkeys.some((passkey) => passkey.id === credential.id)) this.reject("credential already registered", true);

      const passkey: Passkey = {
        id: credential.id,
        publicKey,
        counter: credential.counter,
        transports: (credential.transports ?? []).filter((transport): transport is Transport =>
          (TRANSPORTS as readonly string[]).includes(transport),
        ),
        createdAt: clock(),
        lastUsedAt: null,
      };
      await keeper.commit({
        ...state,
        passkeys: [...state.passkeys, passkey],
        webauthnUserId: state.webauthnUserId ?? pending.userId,
      });
      if (pending.kind === "setup") {
        this.setup = undefined;
        this.locked = false;
      }
      logger.info("passkey.register", { id: shortId(passkey.id), total: state.passkeys.length + 1 });
      this.options.notify?.({ type: "passkey_register", total: state.passkeys.length + 1 });
      return passkey;
    });
  }

  // Deletes one passkey; the last one cannot go (that is what reset-passkeys is for).
  async deletePasskey(id: string): Promise<{ remaining: number } | undefined> {
    const { keeper, logger } = this.options;
    return keeper.exclusive(async () => {
      const passkeys = keeper.state.passkeys;
      if (!passkeys.some((passkey) => passkey.id === id)) return undefined;
      if (passkeys.length === 1) throw new InvalidInputError("id", "is the last passkey and cannot be deleted");
      const remaining = passkeys.filter((passkey) => passkey.id !== id);
      await keeper.commit({ ...keeper.state, passkeys: remaining });
      logger.info("passkey.delete", { id: shortId(id), remaining: remaining.length });
      this.options.notify?.({ type: "passkey_delete", remaining: remaining.length });
      return { remaining: remaining.length };
    });
  }

  passkeyList(): { id: string; createdAt: number; lastUsedAt: number | null }[] {
    return this.options.keeper.state.passkeys.map(({ id, createdAt, lastUsedAt }) => ({ id, createdAt, lastUsedAt }));
  }

  // Removes every passkey and returns to setup mode. Like expiry, it takes effect
  // in memory even if the save fails: it is used when a passkey may be stolen.
  async reset(): Promise<void> {
    const { keeper } = this.options;
    // Before the first await: a registration or authentication already queued
    // behind the reset must find its challenge outdated, not an empty slate.
    this.generation++;
    this.challenges.clear();
    await keeper.exclusive(async () => {
      await keeper.apply({ ...keeper.state, passkeys: [], webauthnUserId: undefined });
    });
    this.locked = false;
    this.newSetupCode();
  }

  private async authenticationCeremony(
    kind: "action" | "add-passkey",
    action: Action | undefined,
    source: string,
  ): Promise<Ceremony<PublicKeyCredentialRequestOptionsJSON>> {
    if (this.options.keeper.state.passkeys.length === 0) throw new AuthError("no passkey is registered");
    // No allowCredentials: the passkeys are discoverable, and listing them would
    // tell any visitor their IDs and how many there are.
    const options = await generateAuthenticationOptions({
      rpID: this.options.rpId,
      userVerification: "required",
      timeout: CHALLENGE_TTL,
      allowCredentials: [],
    });
    return { challengeId: this.remember({ challenge: options.challenge, kind, action, source }), options };
  }

  private async registrationCeremony(
    kind: "setup" | "register",
    source: string,
    generation = this.generation,
  ): Promise<Ceremony<PublicKeyCredentialCreationOptionsJSON>> {
    const { passkeys, webauthnUserId } = this.options.keeper.state;
    const userId = webauthnUserId ?? randomBytes(32).toString("base64url");
    const options = await generateRegistrationOptions({
      rpName: "Supa Visa",
      rpID: this.options.rpId,
      userName: "owner",
      userDisplayName: "Supa Visa owner",
      userID: Buffer.from(userId, "base64url"),
      attestationType: "none",
      timeout: CHALLENGE_TTL,
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      excludeCredentials: passkeys.map((passkey) => ({ id: passkey.id, transports: [...passkey.transports] })),
    });
    return { challengeId: this.remember({ challenge: options.challenge, kind, userId, source }, generation), options };
  }

  private async verifyAuthentication(
    pending: PendingChallenge<Action>,
    input: unknown,
    label: string,
  ): Promise<void> {
    const response = parseAuthenticationResponse(input);
    const { keeper, logger, clock } = this.options;
    await keeper.exclusive(async () => {
      const state = keeper.state;
      this.requireCurrent(pending);
      const passkey = state.passkeys.find((candidate) => candidate.id === response.id);
      if (passkey === undefined) this.reject("unknown credential", true);
      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response,
          expectedChallenge: pending.challenge,
          expectedOrigin: this.options.origin,
          expectedRPID: this.options.rpId,
          requireUserVerification: true,
          credential: {
            id: passkey.id,
            publicKey: Buffer.from(passkey.publicKey, "base64url"),
            counter: passkey.counter,
            transports: [...passkey.transports],
          },
        });
      } catch (error) {
        this.reject(`authentication did not verify: ${errorMessage(error)}`, true);
      }
      if (!verification.verified) this.reject("authentication did not verify", true);
      const used: Passkey = { ...passkey, counter: verification.authenticationInfo.newCounter, lastUsedAt: clock() };
      const next = { ...state, passkeys: state.passkeys.map((candidate) => (candidate === passkey ? used : candidate)) };
      // The counter is kept in memory and saved later for those; everything else
      // needs the save to succeed.
      if (pending.action !== undefined && this.options.narrowsAccess?.(pending.action) === true) await keeper.apply(next);
      else await keeper.commit(next);
      // A reset that started while the counter was being saved voids this check.
      this.requireCurrent(pending);
      logger.info("passkey.use", { id: shortId(passkey.id), action: label });
    });
  }

  private remember(entry: Omit<PendingChallenge<Action>, "expiresAt" | "generation">, generation = this.generation): string {
    const now = this.options.clock();
    for (const [id, pending] of this.challenges) if (pending.expiresAt <= now) this.challenges.delete(id);
    // Unauthenticated callers can create challenges. A source that asks for more
    // than its share only pushes out its own oldest one, so a stranger cannot
    // evict the owner's challenge while the owner is answering the passkey prompt.
    const mine = [...this.challenges].filter(([, pending]) => pending.source === entry.source);
    for (const [id] of mine.slice(0, Math.max(0, mine.length - MAX_CHALLENGES_PER_SOURCE + 1))) {
      this.challenges.delete(id);
    }
    while (this.challenges.size >= MAX_PENDING_CHALLENGES) {
      this.challenges.delete(this.challenges.keys().next().value as string);
    }
    const challengeId = randomBytes(16).toString("base64url");
    this.challenges.set(challengeId, { ...entry, generation, expiresAt: now + CHALLENGE_TTL });
    return challengeId;
  }

  private requireCurrent(pending: PendingChallenge<Action>): void {
    if (pending.generation !== this.generation) this.reject("challenge was issued before a reset");
  }

  // Every challenge is single-use: it is removed here whether or not the
  // response that follows verifies.
  private take(challengeId: unknown, kind: ChallengeKind): PendingChallenge<Action> {
    if (typeof challengeId !== "string" || !isBase64Url(challengeId, 22, 22)) this.reject("malformed challenge id");
    const pending = this.challenges.get(challengeId);
    this.challenges.delete(challengeId);
    if (pending === undefined) this.reject("unknown or used challenge");
    if (pending.expiresAt <= this.options.clock()) this.reject("expired challenge");
    if (pending.kind !== kind) this.reject("challenge was issued for something else");
    this.requireCurrent(pending);
    return pending;
  }

  private takeRegistration(challengeId: unknown): PendingChallenge<Action> {
    if (typeof challengeId !== "string") this.reject("malformed challenge id");
    const kind = this.challenges.get(challengeId)?.kind;
    return this.take(challengeId, kind === "setup" ? "setup" : "register");
  }

  private codeMatches(input: unknown, code: string): boolean {
    if (typeof input !== "string" || input.length > 128) return false;
    let candidate = input;
    if (this.options.setupToken === undefined) {
      if (!/^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/.test(input)) return false;
      candidate = input.replace("-", "").toUpperCase();
    }
    // Hashing first gives equal-length buffers, so the comparison time does not
    // depend on where the input differs or on its length.
    const digest = (value: string) => createHash("sha256").update(value).digest();
    return timingSafeEqual(digest(candidate), digest(code));
  }

  private newSetupCode(): void {
    const { setupToken, clock, logger } = this.options;
    let code: string;
    let expiresAt: number | undefined;
    if (setupToken === undefined) {
      code = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
      expiresAt = clock() + SETUP_CODE_TTL;
    } else {
      code = setupToken;
    }
    this.setup = { code, expiresAt, attempts: 0 };
    // The one secret that is logged on purpose: only someone who can read the
    // server's logs may register the first passkey.
    logger.warn("setup.code", {
      code: setupToken === undefined ? `${code.slice(0, 4)}-${code.slice(4)}` : "(SETUP_TOKEN)",
      expiresAt: expiresAt === undefined ? null : new Date(expiresAt).toISOString(),
    });
  }

  private reject(reason: string, counted = false): never {
    this.options.logger.warn("passkey.rejected", { reason });
    throw new AuthError(reason, counted);
  }
}

// The browser's JSON, checked field by field before the library sees it.
export function parseAuthenticationResponse(input: unknown): AuthenticationResponseJSON {
  const credential = parseCredential(input);
  const response = credential.response;
  rejectCrossOrigin(field(response, "clientDataJSON"));
  return {
    id: credential.id,
    rawId: credential.rawId,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: field(response, "clientDataJSON"),
      authenticatorData: field(response, "authenticatorData"),
      signature: field(response, "signature"),
      ...(response.userHandle === undefined || response.userHandle === null
        ? {}
        : { userHandle: field(response, "userHandle") }),
    },
  };
}

export function parseRegistrationResponse(input: unknown): RegistrationResponseJSON {
  const credential = parseCredential(input);
  const response = credential.response;
  rejectCrossOrigin(field(response, "clientDataJSON"));
  const transports = response.transports ?? [];
  if (!Array.isArray(transports) || transports.length > TRANSPORTS.length || !transports.every((t) => typeof t === "string" && t.length <= 32)) {
    throw new AuthError("malformed response: transports", true);
  }
  return {
    id: credential.id,
    rawId: credential.rawId,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: field(response, "clientDataJSON"),
      attestationObject: field(response, "attestationObject"),
      transports: transports.filter((transport): transport is Transport =>
        (TRANSPORTS as readonly string[]).includes(transport),
      ),
    },
  };
}

// The page cannot be framed (frame-ancestors 'none'); refusing responses made
// inside a cross-origin frame keeps that true even if the header were lost.
function rejectCrossOrigin(clientDataJSON: string): void {
  let clientData: unknown;
  try {
    clientData = JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf8"));
  } catch {
    throw new AuthError("malformed response: clientDataJSON", true);
  }
  if (typeof clientData !== "object" || clientData === null) throw new AuthError("malformed response: clientDataJSON", true);
  if ((clientData as { crossOrigin?: unknown }).crossOrigin === true) throw new AuthError("cross-origin response", true);
}

function parseCredential(input: unknown): { id: string; rawId: string; response: Record<string, unknown> } {
  if (typeof input !== "object" || input === null) throw new AuthError("malformed response", true);
  const { id, rawId, type, response } = input as Record<string, unknown>;
  if (typeof id !== "string" || !isBase64Url(id, 16, MAX_CREDENTIAL_ID_LENGTH) || rawId !== id) {
    throw new AuthError("malformed response: id", true);
  }
  if (type !== "public-key") throw new AuthError("malformed response: type", true);
  if (typeof response !== "object" || response === null) throw new AuthError("malformed response: response", true);
  return { id, rawId: id, response: response as Record<string, unknown> };
}

function field(response: Record<string, unknown>, name: string): string {
  const value = response[name];
  if (typeof value !== "string" || !isBase64Url(value, 1, MAX_RESPONSE_FIELD_LENGTH)) {
    throw new AuthError(`malformed response: ${name}`, true);
  }
  return value;
}
