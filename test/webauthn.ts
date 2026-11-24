// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";

// A software passkey for tests: it builds real WebAuthn responses (CBOR
// attestation, authenticator data, ECDSA P-256 signatures), so the server
// verifies them with the same library code that checks a phone's passkey.

type Cbor = number | string | Uint8Array | Cbor[] | Map<number | string, Cbor>;

function head(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
  if (length < 0x10000) {
    const buffer = Buffer.alloc(3);
    buffer[0] = (major << 5) | 25;
    buffer.writeUInt16BE(length, 1);
    return buffer;
  }
  const buffer = Buffer.alloc(5);
  buffer[0] = (major << 5) | 26;
  buffer.writeUInt32BE(length, 1);
  return buffer;
}

export function cbor(value: Cbor): Buffer {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  const parts = [head(5, value.size)];
  for (const [key, item] of value) parts.push(cbor(key), cbor(item));
  return Buffer.concat(parts);
}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest();
const b64 = (data: Buffer | Uint8Array) => Buffer.from(data).toString("base64url");

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED_DATA = 0x40;

export interface Overrides {
  origin?: string;
  rpId?: string;
  challenge?: string;
  userVerified?: boolean;
  counter?: number;
  signingKey?: KeyObject;
  type?: string;
  crossOrigin?: boolean;
}

export class SoftAuthenticator {
  readonly credentialId = randomBytes(32);
  counter = 0;
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private readonly rpId: string;
  private readonly origin: string;
  private userHandle: string | undefined;

  constructor(rpId: string, origin: string) {
    this.rpId = rpId;
    this.origin = origin;
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
  }

  get id(): string {
    return b64(this.credentialId);
  }

  register(options: { challenge: string; user: { id: string } }, overrides: Overrides = {}) {
    this.userHandle = options.user.id;
    const jwk = this.publicKey.export({ format: "jwk" });
    const coseKey = new Map<number, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x as string, "base64url")],
      [-3, Buffer.from(jwk.y as string, "base64url")],
    ]);
    const credentialLength = Buffer.alloc(2);
    credentialLength.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      this.authenticatorData(overrides, FLAG_ATTESTED_DATA),
      Buffer.alloc(16),
      credentialLength,
      this.credentialId,
      cbor(coseKey),
    ]);
    const attestationObject = cbor(
      new Map<string, Cbor>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: this.clientData("webauthn.create", options.challenge, overrides),
        attestationObject: b64(attestationObject),
        transports: ["internal", "hybrid"],
      },
    };
  }

  authenticate(options: { challenge: string }, overrides: Overrides = {}) {
    this.counter = overrides.counter ?? this.counter + 1;
    const authData = this.authenticatorData(overrides, 0);
    const clientDataJSON = this.clientData("webauthn.get", options.challenge, overrides);
    const signature = sign(
      "sha256",
      Buffer.concat([authData, sha256(Buffer.from(clientDataJSON, "base64url"))]),
      overrides.signingKey ?? this.privateKey,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON,
        authenticatorData: b64(authData),
        signature: b64(signature),
        ...(this.userHandle === undefined ? {} : { userHandle: this.userHandle }),
      },
    };
  }

  private authenticatorData(overrides: Overrides, extraFlags: number): Buffer {
    const flags = FLAG_USER_PRESENT | (overrides.userVerified === false ? 0 : FLAG_USER_VERIFIED) | extraFlags;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    return Buffer.concat([sha256(overrides.rpId ?? this.rpId), Buffer.from([flags]), counter]);
  }

  private clientData(type: string, challenge: string, overrides: Overrides): string {
    return b64(
      Buffer.from(
        JSON.stringify({
          type: overrides.type ?? type,
          challenge: overrides.challenge ?? challenge,
          origin: overrides.origin ?? this.origin,
          crossOrigin: overrides.crossOrigin ?? false,
        }),
      ),
    );
  }
}

export function otherKey(): KeyObject {
  return generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
}
