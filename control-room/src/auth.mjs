// Operator login (HTTP Basic), one-time VPS boot codes and VPS session tokens.
// Only hashes of codes and sessions are stored; the plaintext exists once, in the
// response that hands it to the VPS.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "./env.mjs";
import { get } from "./store.mjs";

const BOOT_CODE_TTL_MS = 20 * 60_000;
const SESSION_TTL_MS = 30 * 24 * 3_600_000;

export const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

/// True when the request carries the operator password. With no password
/// configured the control room is local-only and open (the server refuses to
/// bind a public interface in that case — see server.mjs).
export function adminOk(req) {
  const pass = env("GATEWAY_ADMIN_PASSWORD");
  if (!pass) return true;
  const h = String(req.headers.authorization || "");
  if (!h.startsWith("Basic ")) return false;
  const [user, ...rest] = Buffer.from(h.slice(6), "base64").toString("utf8").split(":");
  return user === env("GATEWAY_ADMIN_USER", "admin") && same(rest.join(":"), pass);
}

function vault(t) {
  const s = get();
  return (s.vpsAuth ||= {})[t.address.toLowerCase()] ||= { bootCodes: [], sessions: [] };
}

/// A fresh boot code for this token's next VPS. Returned once, in plaintext.
export function issueBootCode(t, meta = {}) {
  const v = vault(t);
  const code = randomBytes(24).toString("hex");
  v.bootCodes = v.bootCodes.filter((c) => !c.usedAt && Date.now() - c.at < BOOT_CODE_TTL_MS);
  v.bootCodes.push({ hash: sha(code), at: Date.now(), usedAt: null, meta });
  return code;
}

export function peekBootCode(t, code) {
  const c = vault(t).bootCodes.find((x) => same(x.hash, sha(code)));
  if (!c || c.usedAt || Date.now() - c.at > BOOT_CODE_TTL_MS) return null;
  return c;
}

/// Consumes a boot code and mints a session. Second use of the same code fails.
export function redeemBootCode(t, code, hostInfo = {}) {
  const c = peekBootCode(t, code);
  if (!c) return null;
  c.usedAt = Date.now();
  c.host = hostInfo;
  const session = randomBytes(32).toString("hex");
  const v = vault(t);
  v.sessions = v.sessions.filter((s) => !s.revokedAt && Date.now() - s.at < SESSION_TTL_MS);
  v.sessions.push({ hash: sha(session), at: Date.now(), lastSeenAt: Date.now(), revokedAt: null, instanceId: c.meta?.instanceId ?? null });
  return session;
}

export function sessionOf(req, t) {
  const h = String(req.headers.authorization || "");
  if (!h.startsWith("Bearer ")) return null;
  const token = h.slice(7).trim();
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const s = vault(t).sessions.find((x) => same(x.hash, sha(token)));
  if (!s || s.revokedAt || Date.now() - s.at > SESSION_TTL_MS) return null;
  s.lastSeenAt = Date.now();
  return s;
}

export function revokeSessions(t) {
  for (const s of vault(t).sessions) s.revokedAt = s.revokedAt || Date.now();
}

/// Stream publish credentials for MediaMTX. The key is returned once.
export function issueStreamKey(t) {
  const key = randomBytes(24).toString("hex");
  t.vps.streamKeyHash = sha(key);
  return key;
}

export function streamKeyOk(t, key) {
  return !!t.vps.streamKeyHash && same(t.vps.streamKeyHash, sha(key));
}
