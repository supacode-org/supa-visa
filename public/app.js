// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

const STRINGS = {
  "zh-Hant": {
    yourIp: "你的 IP",
    unknownIp: "無法取得你的 IP（請透過 Cloudflare 存取這個頁面）",
    notAllowed: "目前未放行",
    allowedFor: (minutes) => `已放行，剩餘 ${minutes} 分鐘`,
    expiresAt: (time) => `到期時間 ${time}`,
    duration: "放行時長",
    range: "放行範圍",
    rangeLabel: (prefix) => (prefix === 128 ? "只有這個位址" : `/${prefix} 網段`),
    coveredBy: (target) => `經 ${target} 放行`,
    note: "備註（可選，例如「飯店 Wi-Fi」）",
    manualToggle: "指定對象（為其他 IP 或網段簽發）",
    manualPlaceholder: "例如 203.0.113.7 或 198.51.100.0/24",
    manualHint: "填了就只為這個 IP 或網段簽發，不放行你現在的位址。",
    passkeyCreated: (time) => `建立於 ${time}`,
    passkeyUsed: (time) => `最後使用 ${time}`,
    passkeyNeverUsed: "還沒用過",
    deletePasskey: "刪除",
    confirmDeletePasskey: "刪除這把 passkey 後，它就不能再用來簽發或管理。確定刪除？",
    passkeyDeleted: (left) => `已刪除，剩 ${left} 把 passkey`,
    lookUpFailed: (family) => `${family}：查不到`,
    issuedMany: (targets, time) => `已簽發 ${targets.join("、")}，到期時間 ${time}`,
    issue: "簽發",
    issueAgain: "重新簽發",
    issued: (time) => `已簽發，到期時間 ${time}`,
    savedNotSynced: "已存檔，但 Cloudflare 同步失敗，會自動重試。",
    manage: "管理",
    visas: "有效的簽證",
    noVisas: "目前沒有有效的簽證",
    issuedAt: (time) => `簽發 ${time}`,
    lastSeen: (time) => `最後活動 ${time}`,
    manual: "手動",
    revoke: "撤銷",
    revoked: (target) => `已撤銷 ${target}`,
    services: "受保護的服務",
    noServices: "還沒有登記服務。登記後，這些主機名只放行有簽證的 IP。",
    addService: "新增",
    hostnamePlaceholder: "nas.example.com",
    remove: "刪除",
    serviceAdded: (host) => `已登記 ${host}`,
    serviceRemoved: (host) => `已刪除 ${host}`,
    confirmRemove: (host) => `刪除後 ${host} 不再受 Supa Visa 保護，任何人都能存取。確定刪除？`,
    passkeys: (count) => `已註冊 ${count} 把 passkey`,
    onlyOnePasskey: "只有一把 passkey。遺失它時只能在伺服器上重置，建議再註冊一把備用的。",
    addPasskey: "新增 passkey",
    passkeyAdded: "已新增 passkey",
    sync: "Cloudflare 同步",
    syncOk: (time) => `正常，上次成功 ${time}`,
    syncNever: "尚未完成同步",
    syncFailing: (time) => `${time} 起同步失敗，會自動重試`,
    setupTitle: "首次設定",
    setupIntro: "在伺服器日誌裡找到設定碼（SETUP CODE），輸入後用 Face ID 或指紋建立第一把 passkey。",
    setupCode: "設定碼",
    createPasskey: "建立 passkey",
    setupDone: "設定完成。建議再新增一把備用的 passkey。",
    setupLocked: "設定碼錯誤太多次，設定已鎖住。請重啟服務，或在伺服器上執行 supa-visa reset-passkeys。",
    blocked: (time) => `這個 IP 因多次認證失敗已被封鎖，到 ${time} 解除。擁有者可以在伺服器上執行 supa-visa unblock 提前解除。`,
    cancelled: "已取消",
    authFailed: "驗證失敗",
    wrongCode: "設定碼錯誤或已過期，請到伺服器日誌查看最新的設定碼。",
    noPasskeySupport: "這個瀏覽器不支援 passkey。",
    failed: "操作失敗，請稍後再試。",
    invalid: (message) => `輸入不正確：${message}`,
    durationLabel: (value) => value.replace(/(\d+)m$/, "$1 分鐘").replace(/(\d+)h$/, "$1 小時").replace(/(\d+)d$/, "$1 天"),
  },
  en: {
    yourIp: "Your IP",
    unknownIp: "Your IP could not be determined (open this page through Cloudflare)",
    notAllowed: "Not allowed in",
    allowedFor: (minutes) => `Allowed in, ${minutes} min left`,
    expiresAt: (time) => `Expires at ${time}`,
    duration: "Allow for",
    range: "Allow",
    rangeLabel: (prefix) => (prefix === 128 ? "This address" : `/${prefix} network`),
    coveredBy: (target) => `Allowed through ${target}`,
    note: "Note (optional, such as \"hotel Wi-Fi\")",
    manualToggle: "Issue for another IP or range",
    manualPlaceholder: "such as 203.0.113.7 or 198.51.100.0/24",
    manualHint: "When filled in, only this IP or range is allowed, not your current address.",
    passkeyCreated: (time) => `Added ${time}`,
    passkeyUsed: (time) => `last used ${time}`,
    passkeyNeverUsed: "never used",
    deletePasskey: "Delete",
    confirmDeletePasskey: "After deleting this passkey, it can no longer issue or manage. Delete it?",
    passkeyDeleted: (left) => `Deleted; ${left} passkey${left === 1 ? "" : "s"} left`,
    lookUpFailed: (family) => `${family}: not found`,
    issuedMany: (targets, time) => `Issued ${targets.join(", ")}, expires at ${time}`,
    issue: "Issue",
    issueAgain: "Issue again",
    issued: (time) => `Issued, expires at ${time}`,
    savedNotSynced: "Saved, but syncing with Cloudflare failed. It will retry on its own.",
    manage: "Manage",
    visas: "Active visas",
    noVisas: "No active visas",
    issuedAt: (time) => `Issued ${time}`,
    lastSeen: (time) => `Last seen ${time}`,
    manual: "manual",
    revoke: "Revoke",
    revoked: (target) => `Revoked ${target}`,
    services: "Protected services",
    noServices: "No services registered yet. Registered hostnames only let in IPs with a visa.",
    addService: "Add",
    hostnamePlaceholder: "nas.example.com",
    remove: "Remove",
    serviceAdded: (host) => `Registered ${host}`,
    serviceRemoved: (host) => `Removed ${host}`,
    confirmRemove: (host) => `After removal, ${host} is no longer protected by Supa Visa and anyone can reach it. Remove it?`,
    passkeys: (count) => `${count} passkey${count === 1 ? "" : "s"} registered`,
    onlyOnePasskey: "Only one passkey. If you lose it, it can only be reset on the server. Add a backup passkey.",
    addPasskey: "Add a passkey",
    passkeyAdded: "Passkey added",
    sync: "Cloudflare sync",
    syncOk: (time) => `Working, last success ${time}`,
    syncNever: "Not synced yet",
    syncFailing: (time) => `Failing since ${time}, retrying on its own`,
    setupTitle: "First-time setup",
    setupIntro: "Find the setup code (SETUP CODE) in the server log, enter it, then create the first passkey with Face ID or a fingerprint.",
    setupCode: "Setup code",
    createPasskey: "Create passkey",
    setupDone: "Setup complete. Add a backup passkey as well.",
    setupLocked: "Too many wrong setup codes; setup is locked. Restart the service, or run supa-visa reset-passkeys on the server.",
    blocked: (time) => `This IP is blocked after repeated failed sign-ins, until ${time}. The owner can lift it early with supa-visa unblock on the server.`,
    cancelled: "Cancelled",
    authFailed: "Authentication failed",
    wrongCode: "Wrong or expired setup code. Check the server log for the latest one.",
    noPasskeySupport: "This browser does not support passkeys.",
    failed: "Something went wrong. Try again later.",
    invalid: (message) => `Invalid input: ${message}`,
    durationLabel: (value) => value,
  },
};

const language = (navigator.language || "").toLowerCase().startsWith("zh") ? "zh-Hant" : "en";
const t = STRINGS[language];
document.documentElement.lang = language;

const app = document.getElementById("app");
// Choices the page keeps across the 30-second refresh, which redraws everything.
const state = {
  me: null,
  owner: null,
  notice: null,
  busy: false,
  setupCode: "",
  duration: null,
  ipv6Prefix: null,
  note: "",
  manualTarget: "",
  // Both of this device's addresses as Cloudflare sees them, and whether to include the other one.
  // Per family: status is "pending", "ok" or "failed".
  addresses: { ipv4: { status: "pending", address: null }, ipv6: { status: "pending", address: null } },
  includeOther: true,
};

// Where to ask which address this device uses, per family, tried in order until one
// answers. Each name has only an A or only an AAAA record, so each request can only
// go out over its family. Several services, because proxy rules and DNS filters
// block or reroute some of them (Cloudflare's are DNS-over-HTTPS hosts).
const TRACE = {
  ipv4: [
    "https://api.ipify.org/",
    "https://api-ipv4.ip.sb/ip",
    "https://ipv4.icanhazip.com/",
    "https://ipv4.cloudflare-dns.com/cdn-cgi/trace",
    "https://v4.ident.me/",
  ],
  ipv6: [
    "https://api6.ipify.org/",
    "https://api-ipv6.ip.sb/ip",
    "https://ipv6.icanhazip.com/",
    "https://ipv6.cloudflare-dns.com/cdn-cgi/trace",
    "https://v6.ident.me/",
  ],
};

// The answer is either the bare address or Cloudflare's key=value trace.
async function traceAddress(url, ipv6) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000), credentials: "omit", referrerPolicy: "no-referrer" });
    if (!response.ok) return null;
    const text = (await response.text()).slice(0, 256);
    const line = text.split("\n").find((entry) => entry.startsWith("ip="));
    const address = (line === undefined ? text : line.slice(3)).trim();
    return /^[0-9a-fA-F:.]{2,45}$/.test(address) && address.includes(":") === ipv6 ? address : null;
  } catch {
    return null;
  }
}

// Looks up every family not found yet, both at once; called again until both are found.
let lookingUp = false;
async function lookUpAddresses() {
  if (lookingUp) return;
  lookingUp = true;
  try {
    await Promise.all(
      Object.entries(TRACE).map(async ([family, urls]) => {
        if (state.addresses[family].status === "ok") return;
        state.addresses = { ...state.addresses, [family]: { status: "pending", address: null } };
        render();
        let address = null;
        for (const url of urls) {
          address = await traceAddress(url, family === "ipv6");
          if (address !== null) break;
        }
        state.addresses = { ...state.addresses, [family]: address === null ? { status: "failed", address: null } : { status: "ok", address } };
      }),
    );
  } finally {
    lookingUp = false;
  }
  render();
}

// Whether the address that matters (the other family) is still unknown; before
// the page knows its own family, either one.
function missingAddress() {
  const lookup = otherLookup();
  return lookup === null ? Object.values(state.addresses).some((entry) => entry.status !== "ok") : lookup.status !== "ok";
}

// The lookup for the family this page was not loaded over.
function otherLookup() {
  const ip = state.me?.ip;
  if (!ip) return null;
  return ip.includes(":") ? { family: "IPv4", ...state.addresses.ipv4 } : { family: "IPv6", ...state.addresses.ipv6 };
}

// The address of the family this page was not loaded over, if Cloudflare reported one.
function otherAddress() {
  return otherLookup()?.address ?? null;
}

// Builds DOM nodes; text always goes in through textContent, never as HTML.
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const clock = (iso) => new Date(iso).toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" });
const dateTime = (iso) =>
  new Date(iso).toLocaleString(language, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const minutesLeft = (iso) => Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 60000));

async function post(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  let data = null;
  try {
    data = await response.json();
  } catch {}
  return { ok: response.ok, status: response.status, data };
}

class UserFacingError extends Error {}

function failure(result) {
  const error = result.data?.error;
  if (error === "auth_failed") return new UserFacingError(t.authFailed);
  if (error === "blocked" && typeof result.data.until === "string") {
    // The next render shows only the blocked notice.
    if (state.me !== null) state.me = { ...state.me, blocked: { until: result.data.until } };
    return new UserFacingError(t.blocked(dateTime(result.data.until)));
  }
  if (error === "invalid_input") return new UserFacingError(t.invalid(result.data.message ?? ""));
  return new UserFacingError(t.failed);
}

function webauthn() {
  if (!window.SimpleWebAuthnBrowser?.browserSupportsWebAuthn()) throw new UserFacingError(t.noPasskeySupport);
  return window.SimpleWebAuthnBrowser;
}

// Runs an action that needs a passkey: the server stores the action with the
// challenge, so the second request only carries the passkey's answer.
async function withPasskey(action) {
  const challenge = await post("/api/challenge", { action });
  if (!challenge.ok) throw failure(challenge);
  const credential = await webauthn().startAuthentication({ optionsJSON: challenge.data.options });
  const result = await post("/api/actions", { challengeId: challenge.data.challengeId, credential });
  if (!result.ok) throw failure(result);
  state.owner = result.data.state;
  return result.data.result;
}

async function run(task) {
  if (state.busy) return;
  state.busy = true;
  render();
  try {
    state.notice = (await task()) ?? null;
  } catch (error) {
    state.notice = { kind: "error", text: describe(error) };
  } finally {
    state.busy = false;
    await refresh();
  }
}

function describe(error) {
  if (error instanceof UserFacingError) return error.message;
  if (error?.name === "NotAllowedError" || error?.name === "AbortError") return t.cancelled;
  return t.failed;
}

const syncNotice = (result, text) =>
  result.synced ? { kind: "ok", text } : { kind: "warn", text: `${text}. ${t.savedNotSynced}` };

async function refresh() {
  const response = await fetch("/api/me", { credentials: "same-origin" });
  const previous = state.me?.ip;
  state.me = await response.json();
  // A new network means the other family's address changed too: look it up again
  // instead of issuing for the last network's address.
  if (previous !== undefined && previous !== state.me.ip) {
    state.addresses = { ipv4: { status: "pending", address: null }, ipv6: { status: "pending", address: null } };
    lookUpAddresses();
  }
  render();
}

function render() {
  const { me } = state;
  if (me === null) return;
  const view = me.blocked
    ? [card(h("p", { class: "notice error", text: t.blocked(dateTime(me.blocked.until)) }))]
    : me.setup === "active"
      ? renderSetup()
      : me.setup === "locked"
        ? [card(h("p", { text: t.setupLocked }))]
        : renderMain();
  app.replaceChildren(...view);
}

function card(...children) {
  return h("section", { class: "card" }, ...children);
}

function notice() {
  if (state.notice === null) return null;
  return h("p", { class: `notice ${state.notice.kind}`, role: "status", text: state.notice.text });
}

function renderSetup() {
  const input = h("input", {
    type: "text",
    class: "code",
    inputmode: "text",
    autocomplete: "one-time-code",
    autocapitalize: "characters",
    spellcheck: "false",
    maxlength: "64",
    placeholder: "XXXX-XXXX",
    "aria-label": t.setupCode,
    value: state.setupCode,
    oninput: (event) => (state.setupCode = event.target.value),
  });
  const submit = () =>
    run(async () => {
      const begin = await post("/setup/begin", { code: input.value });
      if (!begin.ok) throw begin.data?.error === "auth_failed" ? new UserFacingError(t.wrongCode) : failure(begin);
      const credential = await webauthn().startRegistration({ optionsJSON: begin.data.options });
      const done = await post("/setup/complete", { challengeId: begin.data.challengeId, credential });
      if (!done.ok) throw failure(done);
      return { kind: "ok", text: t.setupDone };
    });
  return [
    card(
      h("h1", { text: t.setupTitle }),
      h("p", { class: "muted", text: t.setupIntro }),
      h(
        "form",
        { class: "stack", onsubmit: (event) => (event.preventDefault(), submit()) },
        input,
        h("button", { class: "wide", type: "submit", disabled: state.busy, text: t.createPasskey }),
      ),
      notice(),
    ),
  ];
}

function renderMain() {
  const { me } = state;
  const views = [card(...renderStatus(me), notice())];
  if (state.owner !== null) views.push(...renderOwner(state.owner));
  else views.push(h("button", { class: "secondary wide", disabled: state.busy, onclick: () => run(() => withPasskey({ kind: "list" })), text: t.manage }));
  return views;
}

function renderStatus(me) {
  if (me.ip === null) return [h("p", { class: "muted", text: t.yourIp }), h("p", { text: t.unknownIp })];
  const choices = me.durations.map((value, index) =>
    h(
      "label",
      {},
      h("input", {
        type: "radio",
        name: "duration",
        value,
        checked: state.duration === null ? index === 0 : value === state.duration,
        onchange: () => (state.duration = value),
      }),
      h("span", { text: t.durationLabel(value) }),
    ),
  );
  const issue = () =>
    run(async () => {
      const duration = app.querySelector('input[name="duration"]:checked')?.value;
      const action = { kind: "issue", duration };
      const note = state.note.trim();
      if (note !== "") action.note = note;
      const manualTarget = state.manualTarget.trim();
      if (me.manual && manualTarget !== "") {
        action.manualTarget = manualTarget;
        const result = await withPasskey(action);
        return syncNotice(result, t.issued(clock(result.visas[0].expiresAt)));
      }
      const other = state.includeOther ? otherAddress() : null;
      if (other !== null) action.otherAddress = other;
      const prefix = app.querySelector('input[name="ipv6Prefix"]:checked')?.value;
      if (prefix !== undefined && (me.ip.includes(":") || other?.includes(":"))) action.ipv6Prefix = Number(prefix);
      const result = await withPasskey(action);
      const targets = result.visas.map((visa) => visa.target);
      return syncNotice(result, targets.length > 1 ? t.issuedMany(targets, clock(result.visas[0].expiresAt)) : t.issued(clock(result.visas[0].expiresAt)));
    });
  return [
    h("p", { class: "muted", text: t.yourIp }),
    h("div", { class: "ip", text: me.ip }),
    renderOtherAddress(),
    me.visa === null
      ? h("span", { class: "status off", text: t.notAllowed })
      : h("div", { class: "row" }, h("span", { class: "status ok", text: t.allowedFor(minutesLeft(me.visa.expiresAt)) }), h("span", { class: "muted", text: t.expiresAt(clock(me.visa.expiresAt)) })),
    me.visa !== null && me.visa.target !== me.ip ? h("p", { class: "muted", text: t.coveredBy(me.visa.target) }) : null,
    h("input", {
      type: "text",
      class: "note",
      maxlength: "40",
      placeholder: t.note,
      "aria-label": t.note,
      value: state.note,
      oninput: (event) => (state.note = event.target.value),
    }),
    me.manual
      ? h(
          "details",
          { class: "manual", open: state.manualTarget !== "" },
          h("summary", { text: t.manualToggle }),
          h("input", {
            type: "text",
            maxlength: "64",
            placeholder: t.manualPlaceholder,
            autocapitalize: "none",
            spellcheck: "false",
            value: state.manualTarget,
            oninput: (event) => (state.manualTarget = event.target.value),
          }),
          h("p", { class: "muted", text: t.manualHint }),
        )
      : null,
    h("fieldset", { class: "durations", "aria-label": t.duration }, ...choices),
    me.ipv6Prefixes || otherAddress()?.includes(":")
      ? h(
          "div",
          {},
          h("p", { class: "muted", text: t.range }),
          h(
            "fieldset",
            { class: "durations ranges", "aria-label": t.range },
            ...[128, 64, 56, 48].map((prefix) =>
              h(
                "label",
                { title: t.rangeLabel(prefix) },
                h("input", { type: "radio", name: "ipv6Prefix", value: String(prefix), checked: prefix === (state.ipv6Prefix ?? me.ipv6Prefix ?? 64), onchange: () => (state.ipv6Prefix = prefix) }),
                h("span", { text: prefix === 128 ? "/128" : `/${prefix}` }),
              ),
            ),
          ),
        )
      : null,
    h("button", { class: "wide", disabled: state.busy, onclick: issue, text: me.visa === null ? t.issue : t.issueAgain }),
  ];
}

// The other family's address sits right under this connection's, ticked to be let
// in too; while it is being looked up, a spinner takes its place.
function renderOtherAddress() {
  const lookup = otherLookup();
  if (lookup === null) return null;
  if (lookup.address !== null) {
    return h(
      "label",
      { class: "other-ip" },
      h("input", { type: "checkbox", checked: state.includeOther, onchange: (event) => (state.includeOther = event.target.checked) }),
      h("span", { text: lookup.address }),
    );
  }
  return lookup.status === "pending"
    ? h("div", { class: "muted looking-up", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("span", { text: lookup.family }))
    : h("div", { class: "muted looking-up", text: t.lookUpFailed(lookup.family) });
}

function renderOwner(owner) {
  const visas = owner.visas.length === 0
    ? h("p", { class: "muted", text: t.noVisas })
    : h(
        "ul",
        { class: "items" },
        owner.visas.map((visa) =>
          h(
            "li",
            {},
            h(
              "div",
              { class: "item-main" },
              h("div", { class: "item-title", text: visa.target }),
              h("div", { class: "muted", text: [t.expiresAt(dateTime(visa.expiresAt)), t.issuedAt(dateTime(visa.issuedAt)), visa.lastSeen ? t.lastSeen(dateTime(visa.lastSeen)) : null, visa.manual ? t.manual : null, visa.note].filter(Boolean).join(" · ") }),
              visa.geo ? h("div", { class: "muted", text: [visa.geo.city, visa.geo.country ?? visa.geo.countryCode, [visa.geo.asn, visa.geo.asName].filter(Boolean).join(" ")].filter(Boolean).join(" · ") }) : null,
            ),
            h("button", {
              class: "danger small",
              disabled: state.busy,
              text: t.revoke,
              onclick: () =>
                run(async () => syncNotice(await withPasskey({ kind: "revoke", id: visa.id }), t.revoked(visa.target))),
            }),
          ),
        ),
      );

  const hostname = h("input", { type: "text", placeholder: t.hostnamePlaceholder, autocapitalize: "none", spellcheck: "false", maxlength: "253", "aria-label": t.services });
  const services = h(
    "div",
    { class: "stack" },
    owner.services.length === 0
      ? h("p", { class: "muted", text: t.noServices })
      : h(
          "ul",
          { class: "items" },
          owner.services.map((service) =>
            h(
              "li",
              {},
              h("div", { class: "item-main" }, h("div", { class: "item-title", text: service.hostname })),
              h("button", {
                class: "danger small",
                disabled: state.busy,
                text: t.remove,
                onclick: () => {
                  if (!window.confirm(t.confirmRemove(service.hostname))) return;
                  run(async () => syncNotice(await withPasskey({ kind: "remove-service", hostname: service.hostname }), t.serviceRemoved(service.hostname)));
                },
              }),
            ),
          ),
        ),
    h(
      "form",
      {
        class: "row",
        onsubmit: (event) => {
          event.preventDefault();
          run(async () => {
            const result = await withPasskey({ kind: "add-service", hostname: hostname.value });
            return syncNotice(result, t.serviceAdded(result.hostname));
          });
        },
      },
      h("div", { class: "grow" }, hostname),
      h("button", { type: "submit", disabled: state.busy, text: t.addService }),
    ),
  );

  const addPasskey = () =>
    run(async () => {
      const challenge = await post("/api/passkeys/challenge", {});
      if (!challenge.ok) throw failure(challenge);
      const proof = await webauthn().startAuthentication({ optionsJSON: challenge.data.options });
      const registration = await post("/api/passkeys/authorize", { challengeId: challenge.data.challengeId, credential: proof });
      if (!registration.ok) throw failure(registration);
      const credential = await webauthn().startRegistration({ optionsJSON: registration.data.options });
      const done = await post("/api/passkeys", { challengeId: registration.data.challengeId, credential });
      if (!done.ok) throw failure(done);
      state.owner = { ...state.owner, passkeys: done.data.passkeys };
      return { kind: "ok", text: t.passkeyAdded };
    });

  const sync = owner.sync.failingSince
    ? h("p", { class: "notice warn", text: t.syncFailing(dateTime(owner.sync.failingSince)) })
    : h("p", { class: "muted", text: owner.sync.lastSuccessAt ? t.syncOk(dateTime(owner.sync.lastSuccessAt)) : t.syncNever });

  return [
    card(h("h2", { text: t.visas }), visas),
    card(h("h2", { text: t.services }), services),
    card(
      h("h2", { text: t.passkeys(owner.passkeys) }),
      h(
        "ul",
        { class: "items" },
        (owner.passkeyList ?? []).map((passkey) =>
          h(
            "li",
            {},
            h(
              "div",
              { class: "item-main" },
              h("div", { class: "item-title", text: `${passkey.id.slice(0, 12)}…` }),
              h("div", { class: "muted", text: [t.passkeyCreated(dateTime(passkey.createdAt)), passkey.lastUsedAt ? t.passkeyUsed(dateTime(passkey.lastUsedAt)) : t.passkeyNeverUsed].join(" · ") }),
            ),
            h("button", {
              class: "danger small",
              disabled: state.busy || owner.passkeys <= 1,
              text: t.deletePasskey,
              onclick: () => {
                if (!window.confirm(t.confirmDeletePasskey)) return;
                run(async () => {
                  const result = await withPasskey({ kind: "delete-passkey", id: passkey.id });
                  return { kind: "ok", text: t.passkeyDeleted(result.remaining) };
                });
              },
            }),
          ),
        ),
      ),
      owner.passkeys === 1 ? h("p", { class: "notice warn", text: t.onlyOnePasskey }) : null,
      h("button", { class: "secondary", disabled: state.busy, onclick: addPasskey, text: t.addPasskey }),
    ),
    card(h("h2", { text: t.sync }), sync),
  ];
}

refresh();
lookUpAddresses().then(() => {
  // One quick retry for a lookup that failed on a flaky first try; after that,
  // every refresh tries again.
  if (missingAddress()) setTimeout(lookUpAddresses, 5000);
});
setInterval(() => {
  if (state.busy || document.visibilityState !== "visible") return;
  refresh();
  if (missingAddress()) lookUpAddresses();
}, 30_000);
