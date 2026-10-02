// Chat-only, memory-only credentials. Never serialize these into public token data.
import { randomBytes, createHash } from "node:crypto";
import { identityKey, chatCookieName } from "./solana-auth.mjs";

export const CHAT_TTL = 3_600_000;
export const CHAT_STATEMENT = "Allow public chat replies for 1 hour. No transfers, votes, file changes or publishing. Replies may use the project AI budget.";
const fail = (status, message) => Object.assign(new Error(message), { status });
const hash = value => createHash("sha256").update(value).digest("hex");
// EVM tokens/holders are lowercased (unchanged); Solana base58 identities stay verbatim
// and the mint never appears in the cookie name (see chatCookieName).
const key = identityKey;
export function createChatSessions({ now = Date.now, limit = 2048 } = {}) {
  const sessions = new Map();
  const name = chatCookieName;
  const cookie = (token, value, seconds) => `${name(token)}=${value}; Path=/api/site/holder/${key(token)}/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Strict`;
  function prune() { for (const [k, s] of sessions) if (s.expires <= now()) sessions.delete(k); }
  function find(req, token) {
    prune();
    const values = String(req.headers.cookie || "").split(";").map(x => x.trim()).filter(x => x.startsWith(name(token) + "="));
    if (values.length !== 1) return null;
    const raw = values[0].slice(name(token).length + 1);
    if (!/^[a-f0-9]{64}$/.test(raw)) return null;
    return sessions.get(hash(raw)) || null;
  }
  function get(req, token, holder, origin) {
    const s = find(req, token);
    return s && s.token === key(token) && s.holder === key(holder) && s.origin === origin ? s : null;
  }
  function revoke(req, token) {
    const s = find(req, token); if (s) sessions.delete(s.key);
    return cookie(token, "", 0);
  }
  function issue(req, { token, holder, origin, expires }) {
    prune();
    if (!Number.isFinite(expires) || expires <= now() || expires > now() + CHAT_TTL) throw fail(400, "chat approval must expire within one hour");
    revoke(req, token);
    const peers = [...sessions.values()].filter(s => s.token === key(token) && s.holder === key(holder));
    while (peers.length >= 4) sessions.delete(peers.shift().key);
    if (sessions.size >= limit) throw fail(503, "Chat is busy. Please try again shortly.");
    const raw = randomBytes(32).toString("hex"), k = hash(raw);
    const s = { key: k, token: key(token), holder: key(holder), origin, expires, busy: false, requests: new Map() };
    sessions.set(k, s);
    return { cookie: cookie(token, raw, Math.max(1, Math.floor((expires - now()) / 1000))), expiresAt: new Date(expires).toISOString() };
  }
  return { get, issue, revoke };
}
