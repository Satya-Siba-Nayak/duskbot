import { observePairing } from "@/lib/product-analytics";
import { appLinkFromUniversal, parseSignInLink, DEFAULT_MOBILE_RELAY, MOBILE_LOOKUP_SALT, pairingFromPayload, parseMobilePayload, parseMobilePairingLink, type MobileRedeemRequest, type MobileRedeemResponse, type MobileCapabilities, type MobileConnectionRecord, type MobilePairingPayload, type MobileTransport, type SignInService } from "../../../shared/mobile-link";
import { qrEndpoints, type CompanionEndpoint } from "../../../shared/pairing-link";
import { randomUuid } from "@/lib/random-uuid";
import { cleanPhoneSignInCode } from "../../../shared/account-api";
import type { MobilePlatform } from "../platform";
import { createRelaySecrets, hex, hkdf, sha256hex, subtle, unbase64, unseal, UnsupportedCryptoError, utf8, type RelaySecrets } from "../transport/link-crypto";
import { open as openRelay } from "../transport/relay";

export type TypedPairing = MobilePairingPayload;
export type TypedCode = { kind: "code"; code: string };
type PairErrorCode = "expired" | "unknown" | "store-qr" | "used" | "sign-in" | "limited" | "unreachable" | "mismatch" | "refused" | "relay-unavailable" | "invalid" | "unsupported";

export function routeTimeoutMs(route: MobileTransport): number {
  if (route.kind !== "companion") return 12_000;
  if (route.net === "hosted") return 8_000;
  if (route.net === "tailnet") return 8_000;
  if (route.net === "bonjour") return 4_000;
  return 8_000;
}

export function orderRoutesForDevice(routes: readonly MobileTransport[]): MobileTransport[] {
  const netRank = (route: MobileTransport): number => {
    if (route.kind !== "companion") return route.kind === "https" ? 0 : 10;
    if (route.net === "lan") return 1;
    if (route.net === "tailnet") return 2;
    if (route.net === "hosted") return 3;
    if (route.net === "bonjour") return 4;
    return 5;
  };
  return [...routes].sort((a, b) => netRank(a) - netRank(b));
}

// the desktop's clock stamps a grant's end; a phone a little ahead of it still tries, and the desktop decides
const CLOCK_SKEW_MS = 2 * 60_000;
const lapsed = (expiresAt: number | undefined) => Boolean(expiresAt && expiresAt + CLOCK_SKEW_MS <= Date.now());

export class PairError extends Error {
  readonly code: PairErrorCode;
  readonly details?: string;
  constructor(code: PairErrorCode, details?: string) {
    super(`mobile.pair.${code}`);
    this.name = "PairError";
    this.code = code;
    if (details) this.details = details;
  }
}

/** the desktop's App Store qr, read by a phone that already has the app */
export function isStoreLink(input: string): boolean {
  return /^https:\/\/(apps\.apple\.com|play\.google\.com)\//i.test(input.trim()) || /^https:\/\/dusk\.bot\/download\/?$/i.test(input.trim());
}

/** What a scanned qr is, whichever kind the desktop, the site or an older build drew: the https universal links and their
 * duskbot:// forms (a pairing, a dusk cloud log in), the old store qr, or a typed code. Null for anything else. */
export type Scanned = { kind: "store" } | { kind: "signin"; email: string; code?: string; service?: SignInService } | { kind: "pair"; payload: TypedPairing } | TypedCode
  /** a desktop's dusk cloud code (8 letters): it logs the phone in to the account */
  | { kind: "account"; code: string };
export function readScanned(input: string): Scanned | null {
  if (isStoreLink(input)) return { kind: "store" };
  const signIn = parseSignInLink(input);
  if (signIn) return { kind: "signin", email: signIn.email, ...(signIn.code ? { code: signIn.code } : {}), ...(signIn.service ? { service: signIn.service } : {}) };
  const account = cleanPhoneSignInCode(input);
  if (account) return { kind: "account", code: account };
  const parsed = parseTypedPairing(input);
  if (!parsed) return null;
  return "kind" in parsed ? parsed : { kind: "pair", payload: parsed };
}

export function parseTypedPairing(input: string): MobilePairingPayload | TypedCode | null {
  // the desktop's qr is an https link (a camera opens the app with it); the app's own scanner reads it the same way
  const value = appLinkFromUniversal(input) ?? input.trim();
  if (value.startsWith("duskbot:")) return parseMobilePairingLink(value);
  const code = value.replace(/[-\s]/g, "").toUpperCase();
  if (/^[A-Z0-9]{12}$/.test(code)) return { kind: "code", code };
  const match = /^(\S+)\s+([A-Za-z0-9]{12})$/.exec(value);
  if (!match) return null;
  try {
    const origin = new URL(match[1].includes("://") ? match[1] : `https://${match[1]}`);
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash || match[1].includes("\\")) return null;
    return { v: 1, transport: "https", origin: origin.origin, credential: "", code: match[2].toUpperCase() };
  } catch { return null; }
}

const pendingAttempts = new WeakMap<MobilePlatform, Map<string, Promise<string>>>();

async function attemptId(payload: TypedPairing, platform: MobilePlatform, origin: string): Promise<string> {
  const digest = await subtle().digest("SHA-256", new TextEncoder().encode(payload.credential || `${origin}\0${payload.code}`));
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 12);
  const key = payload.via ? `dusk.mobile.attempt.${payload.grantId}` : `dusk.mobile.pairAttempt.${hash}`;
  let attempts = pendingAttempts.get(platform);
  if (!attempts) { attempts = new Map(); pendingAttempts.set(platform, attempts); }
  const existing = attempts.get(key);
  if (existing) return existing;
  const request = (async () => {
    const saved = await platform.prefs.get(key);
    if (saved) return saved;
    const id = randomUuid();
    await platform.prefs.set(key, id);
    return id;
  })().finally(() => attempts.delete(key));
  attempts.set(key, request);
  return request;
}

type PairAnswer = {
  token?: string;
  serverName?: string;
  device?: { id?: string; capabilities?: Partial<MobileCapabilities> };
  environmentId?: string;
  scopes?: string[];
  id?: string;
  capabilities?: Partial<MobileCapabilities>;
  endpoints?: CompanionEndpoint[];
  code?: string;
  error?: string;
};

async function answerOf(response: Response): Promise<PairAnswer> {
  const answer: unknown = await response.json().catch(() => null);
  return answer && typeof answer === "object" && !Array.isArray(answer) ? answer as PairAnswer : {};
}

function responseError(status: number, answer: PairAnswer, details?: string): PairError {
  const said = `${answer.code ?? ""} ${answer.error ?? ""}`.trim();
  const info = details ? `${details}${said ? ` (${said})` : ""}` : said || undefined;
  if (status === 410 || (status === 400 || status === 401) && /expired/i.test(said)) return new PairError("expired", info);
  if (status === 403 && /sign_in_instead/.test(said)) return new PairError("sign-in", info);
  if (status === 409) return new PairError("used", info);
  if (status === 429) return new PairError("limited", info);
  if (status === 401 || status === 403) return new PairError("refused", info);
  return new PairError(status >= 500 ? "unreachable" : "invalid", info);
}

function describeErr(error: unknown): string {
  if (error instanceof PairError) return error.details || error.code;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

async function redeemLegacyPairing(payload: MobilePairingPayload, platform: MobilePlatform): Promise<{ record: MobileConnectionRecord; token: string }> {
  if (payload.transport === "relay") throw new PairError("relay-unavailable");
  let origin: URL;
  try {
    origin = new URL(payload.origin ?? "");
    if (!(["https:", ...(payload.transport === "companion" ? ["http:"] : [])].includes(origin.protocol)) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new PairError("invalid");
  } catch { throw new PairError("invalid"); }
  if (payload.credential ? !/^(?:dusk|omb)_pair_[A-Za-z0-9_-]{43}$/.test(payload.credential) : !(payload.transport === "companion" ? /^\d{6}$/ : /^[A-Za-z0-9]{12}$/).test(payload.code ?? "")) throw new PairError("invalid");
  if (lapsed(payload.expiresAt)) throw new PairError("expired");
  const trace: string[] = [];
  try {
    const pairRequestId = await attemptId(payload, platform, origin.origin);
    const endpointUrls = payload.endpoints?.map((item) => item.url) ?? [];
    const candidateOrigins = [...new Set([origin.origin, ...endpointUrls])];
    let paired: PairAnswer | undefined;
    let activeOrigin = origin;
    let lastError = new PairError("unreachable");
    for (let i = 0; i < candidateOrigins.length; i++) {
      const candidateUrl = candidateOrigins[i]!;
      let parsedCandidate: URL;
      try { parsedCandidate = new URL(candidateUrl); } catch { continue; }
      let response: Response;
      try {
        response = await fetch(`${parsedCandidate.origin}/api/pair`, {
          method: "POST", headers: { "Content-Type": "application/json" }, credentials: "omit", mode: "cors", redirect: "error",
          body: JSON.stringify({ ...(payload.credential ? { credential: payload.credential } : {}), ...(payload.code ? { code: payload.code } : {}), deviceName: platform.deviceName(), pairRequestId }),
          signal: AbortSignal.timeout(6_000),
        });
      } catch (error) {
        trace.push(`POST ${parsedCandidate.origin}/api/pair -> ${describeErr(error)}`);
        lastError = pairError(error, trace.join("\n"));
        continue;
      }
      const answer = await answerOf(response);
      if (response.status !== 200 && response.status !== 201) {
        trace.push(`POST ${parsedCandidate.origin}/api/pair -> HTTP ${response.status}${answer.error ? ` (${answer.error})` : ""}`);
        const err = responseError(response.status, answer, trace.join("\n"));
        if (err.code === "expired" || err.code === "used" || err.code === "sign-in" || i === candidateOrigins.length - 1) throw err;
        lastError = err;
        continue;
      }
      if (typeof answer.token !== "string" || !answer.token) throw new PairError("invalid", `POST ${parsedCandidate.origin}/api/pair -> missing token`);
      paired = answer;
      activeOrigin = parsedCandidate;
      break;
    }
    if (!paired || typeof paired.token !== "string") throw new PairError(lastError.code, trace.join("\n") || lastError.details);
    const sessionResponse = await fetch(`${activeOrigin.origin}/api/auth/session`, {
      headers: { Authorization: `Bearer ${paired.token}` }, credentials: "omit", mode: "cors", redirect: "error",
      signal: AbortSignal.timeout(6_000),
    });
    const session = await answerOf(sessionResponse);
    const companionRefused = payload.transport === "companion" && [403, 404].includes(sessionResponse.status);
    if (!sessionResponse.ok && !companionRefused) throw responseError(sessionResponse.status, session, `GET ${activeOrigin.origin}/api/auth/session -> HTTP ${sessionResponse.status}`);
    const identity = companionRefused ? {} : session;
    if (payload.environmentId && typeof identity.environmentId === "string" && payload.environmentId !== identity.environmentId) throw new PairError("mismatch");
    const advertised = { ...paired.device?.capabilities, ...paired.capabilities, ...identity.capabilities };
    const direct = payload.transport === "https";
    const capability = (key: keyof MobileCapabilities) => typeof advertised[key] === "boolean" ? advertised[key] : direct;
    const id = randomUuid();
    const now = Date.now();
    const validEndpoints = payload.transport === "companion"
      ? qrEndpoints([...(Array.isArray(paired.endpoints) ? paired.endpoints : []), ...(payload.endpoints ?? [])])
      : [];
    const via: MobileTransport[] | undefined = validEndpoints.length
      ? validEndpoints.map((endpoint) => ({ kind: "companion", url: endpoint.url, net: endpoint.kind, priority: endpoint.priority }))
      : undefined;
    const record: MobileConnectionRecord = {
      id, environmentId: typeof identity.environmentId === "string" ? identity.environmentId : activeOrigin.origin,
      label: payload.name || (typeof paired.serverName === "string" && paired.serverName) || activeOrigin.host,
      transport: payload.transport, origin: activeOrigin.origin, sessionRef: `token.${id}`,
      ...(via ? { via } : {}),
      ...(typeof identity.id === "string" ? { sessionId: identity.id } : typeof paired.device?.id === "string" ? { sessionId: paired.device.id } : {}),
      capabilities: {
        chat: true, uploads: true, computerView: true,
        computerControl: capability("computerControl"), routines: capability("routines"), notifications: capability("notifications"),
        settingsWrite: Array.isArray(identity.scopes) && identity.scopes.includes("admin"), openOnDesktop: false,
      },
      addedAt: now, lastUsedAt: now,
    };
    return { record, token: paired.token };
  } catch (error) {
    throw pairError(error, trace.length ? trace.join("\n") : undefined);
  }
}

export function pairError(error: unknown, details?: string): PairError {
  if (error instanceof PairError) {
    return details && !error.details ? new PairError(error.code, details) : error;
  }
  const code = error instanceof UnsupportedCryptoError ? "unsupported" : "unreachable";
  const msg = details || (error instanceof Error ? `${error.name}: ${error.message}` : undefined);
  return new PairError(code, msg);
}

async function resolveTypedCodeResult(code: string, relayBase = DEFAULT_MOBILE_RELAY): Promise<MobilePairingPayload> {
  const normalized = code.replace(/[-\s]/g, "").toUpperCase();
  if (!/^[A-Z0-9]{12}$/.test(normalized)) throw new PairError("invalid", "Code must be 12 alphanumeric characters");
  try {
    const id = hex(await hkdf(utf8(normalized), MOBILE_LOOKUP_SALT, "lookup", 16));
    const key = await hkdf(utf8(normalized), MOBILE_LOOKUP_SALT, "seal", 32);
    const lookupUrl = `${relayBase.replace(/\/$/, "")}/v1/lookups/${id}`;
    let response: Response;
    try {
      response = await fetch(lookupUrl, { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(10_000) });
    } catch (firstError) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      response = await fetch(lookupUrl, { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(10_000) }).catch((retryErr) => {
        throw pairError(firstError, `[ERR_LOOKUP_NET] GET ${lookupUrl} -> ${describeErr(retryErr ?? firstError)}`);
      });
    }
    // the relay forgets a lookup when its code ends, and never had one for a code made elsewhere (a browser's /pair code)
    if (response.status === 404) throw new PairError("unknown");
    if (!response.ok) throw responseError(response.status, await answerOf(response), `[ERR_LOOKUP_${response.status}] GET ${lookupUrl}`);
    let payload;
    try {
      const answer = await response.json() as { sealed: string };
      payload = parseMobilePayload(JSON.parse(new TextDecoder().decode(await unseal(key, id, answer.sealed))));
    } catch (err) { throw new PairError("invalid", `[ERR_LOOKUP_DECODE] ${describeErr(err)}`); }
    if (!payload) throw new PairError("invalid", "[ERR_LOOKUP_PAYLOAD] Unsealed lookup payload failed validation");
    if (lapsed(payload.grant.expiresAt)) throw new PairError("expired", "[ERR_LOOKUP_EXPIRED] Grant timestamp expired");
    return pairingFromPayload(payload);
  } catch (error) { throw pairError(error); }
}

const pendingKeys = new WeakMap<MobilePlatform, Map<string, Promise<RelaySecrets>>>();

async function relaySecrets(platform: MobilePlatform, id: string): Promise<RelaySecrets> {
  let pending = pendingKeys.get(platform);
  if (!pending) { pending = new Map(); pendingKeys.set(platform, pending); }
  const existing = pending.get(id);
  if (existing) return existing;
  const request = (async () => {
    const saved = await platform.secrets.get(`relay.${id}`);
    if (saved) return JSON.parse(saved) as RelaySecrets;
    const keys = await createRelaySecrets();
    await platform.secrets.set(`relay.${id}`, JSON.stringify(keys));
    return keys;
  })().finally(() => pending.delete(id));
  pending.set(id, request);
  return request;
}

async function redeemPairingResult(payload: MobilePairingPayload, platform: MobilePlatform): Promise<{ record: MobileConnectionRecord; token: string }> {
  if (!payload.via) return redeemLegacyPairing(payload, platform);
  if (!payload.grantId || !payload.credential || !payload.via.length) throw new PairError("invalid", "[ERR_GRANT_INVALID] Missing grantId, credential, or routes");
  if (lapsed(payload.expiresAt)) throw new PairError("expired", "[ERR_GRANT_EXPIRED] Pairing grant expired");
  const trace: string[] = [];
  try {
    const id = await attemptId(payload, platform, payload.origin ?? "");
    const grantRelay = payload.via.find((route) => route.kind === "relay");
    let keys: RelaySecrets | undefined;
    if (grantRelay) {
      try { keys = await relaySecrets(platform, id); }
      catch (error) { if (!(error instanceof UnsupportedCryptoError)) throw error; }
    }
    const request: MobileRedeemRequest = {
      secret: payload.credential, attemptId: id,
      device: { name: platform.deviceName(), platform: platform.kind === "web" ? "other" : platform.kind, app: platform.appVersion },
      ...(keys ? { relay: { pub: keys.pub, verifier: await sha256hex(keys.token) } } : {}),
    };
    const orderedVia = orderRoutesForDevice(payload.via);
    let lastError = new PairError("unreachable");
    for (const route of orderedVia) {
      const routeTag = route.kind === "companion" ? `[${route.net}] ${route.url}` : route.kind === "https" ? `[https] ${route.url}` : `[relay] ${route.base}`;
      if (route.kind === "relay" && !keys) {
        trace.push(`${routeTag} -> skipped (no X25519 relay keys)`);
        lastError = new PairError("unsupported", trace.join("\n"));
        continue;
      }
      if (route.kind === "companion" && !platform.native) {
        trace.push(`${routeTag} -> skipped (requires native app)`);
        lastError = new PairError("unsupported", trace.join("\n"));
        continue;
      }
      let channel: ReturnType<typeof openRelay> | undefined;
      let response: Response;
      let answer: unknown;
      try {
        const headers = { "Content-Type": "application/json" };
        const body = JSON.stringify(request);
        if (route.kind === "relay") {
          channel = openRelay(route.base, route.channel, route.token, unbase64(route.key));
          response = await channel.request("POST", "/api/mobile/redeem", headers, utf8(body), AbortSignal.timeout(15_000));
        } else {
          response = await fetch(`${route.url}/api/mobile/redeem`, { method: "POST", headers, body, credentials: "omit", redirect: "error", signal: AbortSignal.timeout(routeTimeoutMs(route)) });
        }
        answer = await response.json().catch(() => null);
      } catch (error) {
        trace.push(`${routeTag} -> ${describeErr(error)}`);
        lastError = pairError(error, trace.join("\n"));
        continue;
      }
      finally { channel?.close(); }
      if (!response.ok) {
        const ansObj = answer && typeof answer === "object" ? answer as PairAnswer : {};
        trace.push(`${routeTag} -> HTTP ${response.status}${ansObj.error ? ` (${ansObj.error})` : ""}`);
        const err = responseError(response.status, ansObj, trace.join("\n"));
        if (err.code === "expired" || err.code === "used" || err.code === "sign-in" || (route.kind === "https" && response.status < 500)) {
          throw err;
        }
        lastError = err;
        continue;
      }
      const paired = answer as MobileRedeemResponse | null;
      if (!paired || typeof paired.token !== "string" || !paired.token || typeof paired.device?.id !== "string" || typeof paired.workspace?.name !== "string" || !Array.isArray(paired.scopes)) {
        trace.push(`${routeTag} -> HTTP ${response.status} invalid redeem response JSON`);
        lastError = new PairError("invalid", trace.join("\n"));
        continue;
      }
      if (payload.environmentId && paired.workspace.environmentId && payload.environmentId !== paired.workspace.environmentId) throw new PairError("mismatch", `${routeTag} -> environment mismatch`);
      const origin = route.kind === "relay" ? undefined : route.url;
      const relay = paired.relay ?? (route.kind === "relay" ? { base: route.base, channel: route.channel } : undefined);
      const now = Date.now();
      const record: MobileConnectionRecord = {
        id, environmentId: paired.workspace.environmentId ?? origin ?? relay!.channel, label: paired.workspace.name,
        transport: route.kind, ...(origin ? { origin } : {}), ...(relay ? { relay } : {}), via: payload.via,
        deviceId: paired.device.id, sessionRef: `token.${id}`,
        capabilities: {
          chat: true, uploads: true, computerView: true, computerControl: route.kind !== "companion", routines: route.kind !== "companion",
          notifications: route.kind !== "companion", settingsWrite: paired.scopes.includes("admin"), openOnDesktop: false,
        },
        addedAt: now, lastUsedAt: now,
      };
      return { record, token: paired.token };
    }
    throw pairError(lastError, trace.join("\n"));
  } catch (error) { throw pairError(error, trace.length ? trace.join("\n") : undefined); }
}

export const resolveTypedCode = (code: string, relayBase = DEFAULT_MOBILE_RELAY) => observePairing(() => resolveTypedCodeResult(code, relayBase));
export const redeemPairing = (payload: MobilePairingPayload, platform: MobilePlatform) => observePairing(() => redeemPairingResult(payload, platform));
