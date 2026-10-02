// Project X (Twitter) accounts and vote-approved posts.
//
// The root-owned broker (integrations/twitter-account-setup/server-test/x-broker.mjs)
// holds every cookie, API key and proxy credential and listens only on a Unix
// socket. This module never sees a secret: it asks the broker which verified
// account is assigned to which project, and hands it {handle, project, intentId,
// text} for proposals the community approved. The broker keeps one durable
// receipt per intentId, so re-sending the same intent after a lost response can
// never publish twice. Nothing here is an authorization path: only an approved,
// finalized X_POST proposal whose payload hash still matches is ever posted.
import { request as httpRequest } from "node:http";
import { createHash } from "node:crypto";
import { get, save, event } from "./store.mjs";
import { env } from "./env.mjs";
import { payloadHash } from "./canonical.mjs";
import { checkProposal } from "./rules.mjs";
import { holderWorkAllowed, launchProjectKey, isStagedLaunch } from "./launch-package.mjs";

export const X_POST_TYPE = "X_POST";
export const X_TEXT_MAX = 280;
const FINAL = new Set(["posted", "not_confirmed", "uncertain", "refused"]);
const key = (t) => isStagedLaunch(t) && t.chain === 'solana' ? String(t.address) : String(t.address).toLowerCase();
const handleOk = (h) => typeof h === "string" && /^[a-z\d_]{1,15}$/i.test(h);
const accountIdOk = (id) => typeof id === "string" && /^[1-9][0-9]{0,29}$/.test(id);
export const intentIdFor = (t, proposalId) => createHash("sha256").update(`x-post:${key(t)}:${proposalId}`).digest("hex");

export function brokerSocketPath() { return env("X_BROKER_SOCKET", "/run/metahuman-x/broker.sock"); }

/// The broker's worst case for one /post (its own per-call provider timeouts, see
/// x-broker.mjs PROVIDER_TIMEOUT_MS / CREDITS_TIMEOUT_MS / BALANCE_RETRY_MS):
/// balance read 10 s + create 20 s + read-back 20 s + balance read 10 s + one
/// retried balance read (2 s wait + 10 s) = 72 s. The /post call waits 120 s so a
/// slow-but-succeeding post is not abandoned and re-sent as a duplicate.
export const X_POST_CALL_TIMEOUT_MS = 120_000;

/// One JSON request to the broker over its Unix socket. Connection failures and
/// timeouts reject with code BROKER_UNAVAILABLE; HTTP errors resolve normally.
export function brokerCall(method, path, body = null, { socketPath = brokerSocketPath(), timeoutMs = 90_000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const unavailable = (reason) => reject(Object.assign(new Error("X broker unavailable"), { code: "BROKER_UNAVAILABLE", reason }));
    const req = httpRequest({ socketPath, path, method, headers: { Accept: "application/json", ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) } }, (res) => {
      const chunks = [];
      res.on("data", (c) => { chunks.push(c); if (Buffer.concat(chunks).length > 65_536) { req.destroy(); unavailable("oversized"); } });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"); } catch { json = null; }
        resolve({ status: res.statusCode, json });
      });
      res.on("error", () => unavailable("response"));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); unavailable("timeout"); });
    req.on("error", (e) => unavailable(e.code || "connect"));
    if (data) req.write(data);
    req.end();
  });
}

/// Public view of a project's X account (never credentials).
export function xAccountOf(t) {
  const x = t.social?.x, identity = t.social?.xIdentity, acquiredId = t.launchPackageRun?.socialAccount?.accountId;
  const bound = (!identity || (identity.projectKey === launchProjectKey(t) && identity.userId === x?.userId)) &&
    (acquiredId === undefined || acquiredId === x?.userId);
  return x && bound && handleOk(x.handle) && accountIdOk(x.userId) ? { handle: x.handle, url: `https://x.com/${x.handle}`, userId: x.userId, assignedAt: x.assignedAt || null } : null;
}

/// Public view of posts made for approved proposals.
export function xPostsOf(t) {
  return Object.values(t.xPosts || {}).slice(-50).map((r) => ({
    proposalId: r.proposalId, state: r.state, handle: r.handle, text: r.text, tweetId: r.tweetId || null, url: r.url || null,
    verified: r.verified === true, reason: r.reason || null, createdAt: r.createdAt, updatedAt: r.updatedAt || null,
  }));
}

export const X_USAGE_SETTLE_MICROS = 1_000_000;     // settle accrued X API usage to operations once it reaches $1
export const X_USAGE_SETTLE_AGE_MS = 24 * 3_600_000;  // or once the oldest unsettled charge is a day old
export const X_USAGE_SETTLE_BACKOFF_MS = 15 * 60_000; // a batch the treasury could not cover is not re-opened for 15 min
export const X_USAGE_RELEASED_KEEP = 20;              // released batches kept per project (settled/submitted are never pruned)
export const X_POST_COST_CAP_MICROS = 100_000;        // $0.10: never book more than this per post (the measured cost is ≈ $0.0035)
export const X_POST_CREDITS_RETRY_MS = 30 * 60_000;   // a post the provider could not dispatch for lack of credits is retried after 30 min

/// Per-post X API usage. Every post the broker executes reports what the provider
/// deducted (costMicros). It is booked against the project immediately (a hold in
/// heldUsage), and settled treasury → operations in small batches through
/// chargeTreasuryOnce, idempotent by batch id, so a crash never double-settles.
export function accrueXUsage(t, micros, ref, now = Date.now) {
  if (!Number.isSafeInteger(micros) || micros <= 0) return null;
  const u = (t.socialUsage ||= { version: 1, unsettledMicros: 0, settledMicros: 0, batches: {}, batchCount: 0, entries: [] });
  u.unsettledMicros += micros;
  u.entries.push({ at: new Date(now()).toISOString(), micros, ...ref });
  if (u.entries.length > 500) u.entries.splice(0, u.entries.length - 500);
  u.oldestUnsettledAt ||= new Date(now()).toISOString();
  return u;
}
export function xUsageOf(t) {
  const u = t.socialUsage;
  // Posts the broker could not price (costReason on the receipt): nothing was booked for them, so they are counted, not guessed.
  const unpricedPosts = Object.values(t.xPosts || {}).filter((r) => r.costUnknown === true).length;
  const pending = u ? Object.values(u.batches || {}).find((b) => b.state === "submitted") : null;
  const pendingBatch = pending ? { id: pending.id, micros: pending.micros, createdAt: pending.createdAt } : null;
  return u ? { unsettledMicros: u.unsettledMicros, settledMicros: u.settledMicros, posts: u.entries.length, lastAt: u.entries.at(-1)?.at || null, unpricedPosts, pendingBatch }
    : { unsettledMicros: 0, settledMicros: 0, posts: 0, lastAt: null, unpricedPosts, pendingBatch };
}
/// Keeps the batch map bounded: only the X_USAGE_RELEASED_KEEP most recent released
/// (never dispatched) batches stay; settled and submitted batches are never pruned.
function pruneBatches(u) {
  const seq = (b) => Number(String(b.id).split(":").pop()) || 0;
  const released = Object.values(u.batches || {}).filter((b) => b.state === "released").sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || seq(a) - seq(b));
  for (const b of released.slice(0, Math.max(0, released.length - X_USAGE_RELEASED_KEEP))) delete u.batches[b.id];
}

// ── holder actions on the project's X account ────────────────────────────────
// A holder with more than 1 % of the supply (the "order" role) acts on the account
// directly — no vote: post, delete a post, and change the account's identity
// (display name, bio, location, website, logo, banner). Everything else about the
// account (the @username, the login) stays with the operator: X's API cannot rename
// an account. Every action is durable, idempotent by intent, rate limited and billed
// to the project at the measured provider cost.
export const X_ACTION_KINDS = Object.freeze(["post", "delete", "profile", "avatar", "banner"]);
export const X_PROFILE_LIMITS = Object.freeze({ name: 50, bio: 160, location: 30, website: 100 });
// Stricter than X's own 700 KB / 2 MB: the whole signed request must fit the 1 MB body limit.
export const X_AVATAR_MAX_BYTES = 500 * 1024, X_BANNER_MAX_BYTES = 700 * 1024;
export const X_ACTION_MIN_GAP_MS = 30_000;          // per project, in front of the broker's own slot
export const X_ACTION_CALL_TIMEOUT_MS = 120_000;
export const X_ACTION_RETRY_MS = 30 * 60_000;       // a credits-exhausted action is retried this much later
export const X_ACTION_KEEP = 200;
const ACTION_FINAL = new Set(["applied", "refused", "uncertain", "failed"]);
const TWEET_ID = /^\d{5,25}$/;
const SECRETISH = [/0x[a-f0-9]{64}/i, /[1-9A-HJ-NP-Za-km-z]{60,}/, /auth_token|ct0=|api[_-]?key/i];

/// PNG/JPEG by magic bytes and real dimensions (never by a caller's claim).
export function imageMeta(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (b.length > 32 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a && b.toString("latin1", 12, 16) === "IHDR")
    return { type: "image/png", width: b.readUInt32BE(16), height: b.readUInt32BE(20), bytes: b.length };
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1], len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { type: "image/jpeg", height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7), bytes: b.length };
      if (len < 2) break;
      i += 2 + len;
    }
  }
  return null;
}
const actionFail = (status, message) => Object.assign(new Error(message), { status });
/// Validates one holder action and returns { kind, payload } — payload is exactly what is
/// signed (images are bound by their sha256, the bytes travel beside the signature).
export function validateXAction({ action, text, tweetId, profile, imageSha256 } = {}) {
  const kind = String(action || "");
  if (!X_ACTION_KINDS.includes(kind)) throw actionFail(400, "unknown X action");
  if (kind === "post") {
    if (typeof text !== "string") throw actionFail(400, "post text is required");
    const clean = text.replace(/\u0000/g, "").trim();
    if (!clean.length || [...clean].length > X_TEXT_MAX) throw actionFail(400, `post text must be 1 to ${X_TEXT_MAX} characters`);
    if (SECRETISH.some((r) => r.test(clean))) throw actionFail(400, "post text looks like it carries a key or token");
    return { kind, payload: { text: clean } };
  }
  if (kind === "delete") {
    if (!TWEET_ID.test(String(tweetId || ""))) throw actionFail(400, "a tweet id is required");
    return { kind, payload: { tweetId: String(tweetId) } };
  }
  if (kind === "profile") {
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw actionFail(400, "profile fields are required");
    const out = {};
    for (const [field, limit] of Object.entries(X_PROFILE_LIMITS)) {
      if (profile[field] === undefined || profile[field] === null) continue;
      if (typeof profile[field] !== "string") throw actionFail(400, `${field} must be text`);
      const v = profile[field].replace(/[\u0000-\u001f\u007f]/g, "").trim();
      if ([...v].length > limit) throw actionFail(400, `${field} must be at most ${limit} characters`);
      if (v && SECRETISH.some((r) => r.test(v))) throw actionFail(400, `${field} looks like it carries a key or token`);
      if (field === "website" && v) {
        let u; try { u = new URL(v); } catch { throw actionFail(400, "website must be an https link"); }
        if (u.protocol !== "https:" || u.username || u.password) throw actionFail(400, "website must be an https link");
      }
      out[field] = v;
    }
    if (!Object.keys(out).length) throw actionFail(400, "nothing to change");
    return { kind, payload: { profile: out } };
  }
  if (!/^[a-f0-9]{64}$/.test(String(imageSha256 || ""))) throw actionFail(400, "imageSha256 is required");
  return { kind, payload: { imageSha256: String(imageSha256) } };
}
/// The uploaded bytes must be the image the holder signed for, and a usable PNG/JPEG.
export function validateXImage(kind, base64, sha256Expected) {
  if (typeof base64 !== "string" || !base64) throw actionFail(400, "the image is required");
  let bytes;
  try { bytes = Buffer.from(base64, "base64"); } catch { throw actionFail(400, "the image is not valid base64"); }
  if (!bytes.length || bytes.toString("base64") !== base64.replace(/\s+/g, "")) throw actionFail(400, "the image is not valid base64");
  if (createHash("sha256").update(bytes).digest("hex") !== sha256Expected) throw actionFail(400, "the image does not match the signed request");
  const max = kind === "avatar" ? X_AVATAR_MAX_BYTES : X_BANNER_MAX_BYTES;
  if (bytes.length > max) throw actionFail(400, `the image must be at most ${Math.round(max / 1024)} KB`);
  const meta = imageMeta(bytes);
  if (!meta) throw actionFail(400, "the image must be a PNG or JPEG");
  const min = kind === "avatar" ? [200, 200] : [600, 200];
  if (meta.width < min[0] || meta.height < min[1] || meta.width > 4096 || meta.height > 4096) throw actionFail(400, `the image must be between ${min[0]}x${min[1]} and 4096x4096`);
  return { base64: bytes.toString("base64"), ...meta };
}
/// Public view of the account actions holders have taken (no image bytes, no intents).
export function xActionsOf(t) {
  return Object.values(t.xActions || {}).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).slice(-50).map((r) => ({
    id: r.id, kind: r.kind, holder: r.holder, state: r.state, applied: r.applied || null, reason: r.reason || null,
    tweetId: r.tweetId || null, url: r.url || null, createdAt: r.createdAt, updatedAt: r.updatedAt || null,
    costMicros: r.costMicros || 0, image: r.image ? { type: r.image.type, width: r.image.width, height: r.image.height } : null,
  }));
}
/// The account identity as X last confirmed it (shown on the project page).
export const xProfileOf = (t) => t.social?.x?.profile || null;

/// The engine the HTTP layer uses for holder actions. server.mjs registers the polling
/// instance; a standalone one (tests, CLI) is created on demand and never polls.
let sharedEngine = null;
export function setXPosts(engine) { sharedEngine = engine; return engine; }
export function xPosts() { return (sharedEngine ||= createXPosts()); }

export function createXPosts({ call = brokerCall, persist = save, now = Date.now, charge = null, log = (...a) => console.error("[x-posts]", ...a) } = {}) {
  const status = { connected: false, checkedAt: null, error: null, accounts: 0, verifiedAccounts: 0, availableAccounts: 0, allocationReady: false };
  let refreshing = false, polling = false;

  /// Mirrors broker assignments into t.social.x. A broker outage leaves the last
  /// known assignment in place; it never invents or removes one on its own.
  async function refreshAccounts() {
    if (refreshing) return status;
    refreshing = true;
    try {
      let r;
      try { r = await call("GET", "/accounts"); }
      catch (e) { Object.assign(status, { connected: false, checkedAt: new Date(now()).toISOString(), error: e.code || "BROKER_UNAVAILABLE", allocationReady: false }); return status; }
      const accounts = Array.isArray(r.json?.accounts) ? r.json.accounts : null;
      if (r.status !== 200 || !accounts) { Object.assign(status, { connected: false, checkedAt: new Date(now()).toISOString(), error: "BROKER_INVALID_RESPONSE", allocationReady: false }); return status; }
      const verified = accounts.filter(a => a && handleOk(a.handle) && accountIdOk(a.userId) &&
        a.sessionStored === true && a.postVerified === true &&
        accounts.filter(x => x && (x.userId === a.userId ||
          (typeof x.handle === 'string' && x.handle.toLowerCase() === a.handle.toLowerCase()))).length === 1);
      const availableAccounts = verified.filter(a => a.assignedProject == null || a.assignedProject === '').length;
      Object.assign(status, { connected: true, checkedAt: new Date(now()).toISOString(), error: null,
        accounts: accounts.length, verifiedAccounts: verified.length, availableAccounts, allocationReady: availableAccounts > 0 });
      const s = get();
      let changed = false;
      for (const t of Object.values(s.tokens)) {
        const current = t.social?.x || null;
        const matches = accounts.filter((x) => x && x.assignedProject === key(t));
        const candidate = matches.length === 1 ? matches[0] : null;
        const projectKey = launchProjectKey(t);
        const registry = s.socialAccountRegistry;
        const binding = t.social?.xIdentity || null;
        const pinned = t.launchPackageRun?.socialAccount?.accountId || registry?.projects?.[projectKey]?.accountId || binding?.userId || current?.userId || null;
        // A handle is mutable. Bind publication to one numeric provider identity and
        // one project; duplicate/malformed broker rows must never pick a winner.
        const a = candidate && handleOk(candidate.handle) && accountIdOk(candidate.userId) &&
          candidate.postVerified === true && candidate.sessionStored === true &&
          (!pinned || pinned === candidate.userId) &&
          (!binding || (accountIdOk(binding.userId) && binding.projectKey === projectKey && binding.userId === candidate.userId)) &&
          (!registry?.accounts?.[candidate.userId] || registry.accounts[candidate.userId].projectKey === projectKey) &&
          accounts.filter(x => x && (x.userId === candidate.userId ||
            (typeof x.handle === 'string' && x.handle.toLowerCase() === candidate.handle.toLowerCase()))).length === 1 &&
          Object.values(s.tokens).filter(other => key(other) === key(t)).length === 1 ? candidate : null;
        if (a && (!current || !binding || current.handle !== a.handle || current.userId !== a.userId)) {
          t.social = { ...(t.social || {}), xIdentity: { projectKey, userId: a.userId },
            x: { handle: a.handle, userId: a.userId, assignedAt: current?.assignedAt || new Date(now()).toISOString() } };
          event("x", `${t.symbol}: X account @${a.handle} assigned`, { token: t.address });
          changed = true;
        } else if (!a && current) {
          const { x, ...rest } = t.social; t.social = rest;
          event("x", `${t.symbol}: X account @${current.handle} unassigned`, { token: t.address });
          changed = true;
        }
      }
      if (changed) persist();
      return status;
    } finally { refreshing = false; }
  }

  const snapshotProposal = (p) => ({ agentStatus: p.agentStatus, agentReason: p.agentReason, result: p.result });
  const restoreProposal = (p, snap) => { p.agentStatus = snap.agentStatus; p.agentReason = snap.agentReason; p.result = snap.result; };
  function markProposal(p, agentStatus, agentReason, result) {
    p.agentStatus = agentStatus; p.agentReason = agentReason;
    if (result) p.result = { ...(p.result || {}), ...result };
  }

  /// Authorization is re-derived before EVERY dispatch: an approved, live, unchanged
  /// X_POST proposal for a project that still has an assigned account. Nothing
  /// stored earlier (a waiting record, a stale intent) can outrank this check.
  function authorized(t, p) {
    if (p?.type !== X_POST_TYPE || p.status !== "approved" || p.cancelledAt || p.revokedAt) return { ok: false, reason: "proposal is not an approved, live X post" };
    if (p.payloadHash !== payloadHash({ type: p.type, payload: p.payload })) return { ok: false, reason: "approved payload changed" };
    const rules = checkProposal(p);
    if (!rules.ok) return { ok: false, reason: rules.reason };
    if (!xAccountOf(t)) return { ok: false, reason: "no verified X account is assigned" };
    return { ok: true };
  }
  /// Books the provider cost a bound receipt reports, once per receipt (rec.costMicros /
  /// rec.costUnknown guard every later view of the same receipt). Never more than
  /// X_POST_COST_CAP_MICROS per post: a larger figure is capped, flagged and warned.
  function bookCost(t, p, rec, j) {
    if (rec.costMicros || rec.costUnknown) return;
    if (Number.isSafeInteger(j.costMicros) && j.costMicros > 0) {
      const booked = Math.min(j.costMicros, X_POST_COST_CAP_MICROS);
      if (j.costMicros > X_POST_COST_CAP_MICROS) {
        rec.costCapped = true; rec.reportedCostMicros = j.costMicros;
        event("x", `${t.symbol}: X broker reported $${(j.costMicros / 1e6).toFixed(4)} for one post; booked the $${(X_POST_COST_CAP_MICROS / 1e6).toFixed(2)} per-post cap — operator review`, { token: t.address, level: "warn" });
      }
      rec.costMicros = booked; rec.costCredits = Number.isSafeInteger(j.costCredits) ? j.costCredits : null;
      accrueXUsage(t, booked, { proposalId: p.id, intentId: rec.intentId, handle: rec.handle, credits: rec.costCredits }, now);
    } else if (j.costMicros == null && typeof j.costReason === "string" && j.costReason) {
      // The broker could not measure this post (e.g. BALANCE_READ_FAILED): book nothing, count it as unpriced.
      rec.costUnknown = true; rec.costReason = j.costReason;
    }
  }
  async function postOne(t, p) {
    if (!holderWorkAllowed(t)) return { proposalId: p?.id, state: "waiting_startup", reason: "Required startup stages are not verified" };
    t.xPosts ||= {};
    let rec = t.xPosts[p.id];
    const account = xAccountOf(t), handle = account?.handle;
    const auth = authorized(t, p);
    if (!auth.ok) {
      if (rec && FINAL.has(rec.state)) return rec;
      const previous = snapshotProposal(p), had = rec;
      rec = t.xPosts[p.id] = { ...(rec || { proposalId: p.id, createdAt: new Date(now()).toISOString() }), handle: rec?.handle ?? handle ?? null, text: rec?.text ?? String(p.payload?.text ?? ""), state: "refused", reason: auth.reason, updatedAt: new Date(now()).toISOString() };
      markProposal(p, "rejected_by_rules", auth.reason);
      try { persist(); } catch (e) { if (had) t.xPosts[p.id] = had; else delete t.xPosts[p.id]; restoreProposal(p, previous); throw e; }
      return rec;
    }
    if (rec && (rec.handle !== handle || (rec.userId !== undefined && rec.userId !== account.userId) || rec.text !== String(p.payload.text) || rec.intentId !== intentIdFor(t, p.id))) {
      // The durable intent no longer matches the approved content/account: never dispatch it.
      const previous = snapshotProposal(p), had = rec;
      rec = t.xPosts[p.id] = { ...rec, state: "refused", reason: "stored intent does not match the approved post", updatedAt: new Date(now()).toISOString() };
      markProposal(p, "paused", "The saved X post no longer matches the approved content; operator review required.");
      try { persist(); } catch (e) { t.xPosts[p.id] = had; restoreProposal(p, previous); throw e; }
      return rec;
    }
    if (!rec) {
      const previous = snapshotProposal(p);
      rec = t.xPosts[p.id] = { proposalId: p.id, intentId: intentIdFor(t, p.id), handle, userId: account.userId, text: String(p.payload.text), state: "submitted", createdAt: new Date(now()).toISOString(), attempts: 0 };
      markProposal(p, "in_progress", "Posting on X");
      // Durable intent before any network dispatch. If it cannot be saved, nothing
      // is kept in memory either, so the next poll cannot dispatch an unsaved intent.
      try { persist(); } catch (e) { delete t.xPosts[p.id]; restoreProposal(p, previous); throw e; }
    }
    if (rec.state === "waiting" && Date.parse(rec.retryAt || "") > now()) return rec;
    let r;
    try { r = await call("POST", "/post", { handle: rec.handle, project: key(t), intentId: rec.intentId, text: rec.text }, { timeoutMs: X_POST_CALL_TIMEOUT_MS }); }
    catch (e) {
      // Response lost or broker down: the durable intent stays "submitted" and the
      // same intentId is re-sent later; the broker's receipt makes that safe.
      rec.attempts = (rec.attempts || 0) + 1; rec.lastError = e.code || "BROKER_UNAVAILABLE"; rec.updatedAt = new Date(now()).toISOString();
      persist();
      return rec;
    }
    const j = r.json || {};
    rec.updatedAt = new Date(now()).toISOString();
    const bound = r.status === 200 && (j.handle === undefined || j.handle === rec.handle) && (j.intentId === undefined || j.intentId === rec.intentId) && (j.project === undefined || j.project === key(t));
    // Provider usage is booked only from a receipt bound to THIS intent (a mismatched
    // receipt books nothing), once per receipt, duplicate view or not: after a lost
    // response the cost only ever arrives on the retry's duplicate:true view.
    if (bound) bookCost(t, p, rec, j);
    if (r.status === 200 && !bound) {
      Object.assign(rec, { state: "refused", reason: "BROKER_RECEIPT_MISMATCH" });
      markProposal(p, "paused", "The X broker returned a receipt for a different post; operator review required.");
    } else if (r.status === 200 && ["verified", "accepted", "verification-pending"].includes(j.stage) && /^\d+$/.test(String(j.tweetId || ""))) {
      Object.assign(rec, { state: "posted", tweetId: String(j.tweetId), url: j.url || `https://x.com/${rec.handle}/status/${j.tweetId}`, verified: j.stage === "verified", postedAt: rec.updatedAt, reason: null });
      markProposal(p, "done", j.stage === "verified" ? null : "Posted; X verification pending", { tweetUrl: rec.url, tweetId: rec.tweetId });
      event("x", `${t.symbol}: posted on X (@${rec.handle})`, { token: t.address });
    } else if (r.status === 200 && j.stage === "uncertain") {
      Object.assign(rec, { state: "uncertain", reason: "outcome unknown" });
      markProposal(p, "paused", "The X post outcome is unknown; an operator must reconcile it before anything is re-sent.");
    } else if (r.status === 200 && j.stage === "not-dispatched") {
      // The provider refused before creating anything (platform API key out of credits):
      // the vote stands, the durable intent stays retryable (the broker treats its
      // not-dispatched receipt as resumable) and the operator is told once per outage.
      const reason = typeof j.reason === "string" && j.reason ? j.reason : "PROVIDER_CREDITS_EXHAUSTED";
      if (rec.reason !== reason) event("x", `${t.symbol}: X post not dispatched — ${reason}; retried every 30 min until the X API key has credits`, { token: t.address, level: "error" });
      Object.assign(rec, { state: "waiting", reason, retryAt: new Date(now() + X_POST_CREDITS_RETRY_MS).toISOString() });
      markProposal(p, "in_progress", "Waiting for X API credits");
    } else if (r.status === 200 && j.stage === "not-confirmed") {
      Object.assign(rec, { state: "not_confirmed", reason: j.reason || "PROVIDER_NOT_CONFIRMED" });
      markProposal(p, "paused", `X did not confirm the post (${rec.reason}). A new vote is required to try again.`);
    } else if (r.status === 429) {
      Object.assign(rec, { state: "waiting", reason: "RATE_LIMITED", retryAt: new Date(now() + 5 * 60_000).toISOString() });
    } else {
      const code = j.error || `HTTP_${r.status}`;
      Object.assign(rec, { state: "refused", reason: code });
      markProposal(p, "paused", `The X broker refused the post (${code}).`);
    }
    persist();
    return rec;
  }

  // ── holder actions on the account (post, delete, profile, logo, banner) ─────
  function bookActionCost(t, rec, j) {
    if (rec.costMicros || rec.costUnknown) return;
    if (Number.isSafeInteger(j.costMicros) && j.costMicros > 0) {
      const booked = Math.min(j.costMicros, X_POST_COST_CAP_MICROS);
      if (j.costMicros > X_POST_COST_CAP_MICROS) {
        rec.costCapped = true; rec.reportedCostMicros = j.costMicros;
        event("x", `${t.symbol}: X broker reported $${(j.costMicros / 1e6).toFixed(4)} for one ${rec.kind} action; booked the $${(X_POST_COST_CAP_MICROS / 1e6).toFixed(2)} cap — operator review`, { token: t.address, level: "warn" });
      }
      rec.costMicros = booked; rec.costCredits = Number.isSafeInteger(j.costCredits) ? j.costCredits : null;
      accrueXUsage(t, booked, { actionId: rec.id, kind: rec.kind, intentId: rec.intentId, handle: rec.handle, credits: rec.costCredits }, now);
    } else if (j.costMicros == null && typeof j.costReason === "string" && j.costReason) {
      rec.costUnknown = true; rec.costReason = j.costReason;
    }
  }
  const actionsOf = (t) => (t.xActions ||= {});
  function pruneActions(t) {
    const rows = Object.values(actionsOf(t)).filter((r) => ACTION_FINAL.has(r.state)).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    for (const r of rows.slice(0, Math.max(0, Object.keys(actionsOf(t)).length - X_ACTION_KEEP))) delete actionsOf(t)[r.intentId];
  }
  /// One dispatch of a recorded action. The record is already durable: this only calls the
  /// broker and writes the outcome back, so a lost answer is re-sent with the same intent
  /// (the broker answers from its own receipt and never applies anything twice).
  async function dispatchAction(t, rec, image = null) {
    // Owner 2026-10-02: an assigned account is enough; the DEX stage is not a gate for holder posts.
    const account = xAccountOf(t);
    if (!account || rec.handle !== account.handle || (rec.userId !== undefined && rec.userId !== account.userId)) {
      Object.assign(rec, { state: 'refused', reason: 'X_ACCOUNT_IDENTITY_MISMATCH', updatedAt: new Date(now()).toISOString() });
      persist(); return rec;
    }
    const body = rec.kind === "post"
      ? { handle: rec.handle, project: key(t), intentId: rec.intentId, text: rec.payload.text }
      : { kind: rec.kind, handle: rec.handle, project: key(t), intentId: rec.intentId,
          ...(rec.kind === "delete" ? { tweetId: rec.payload.tweetId } : {}),
          ...(rec.kind === "profile" ? { profile: rec.payload.profile } : {}),
          ...(image ? { imageBase64: image } : {}) };
    let r;
    try { r = await call("POST", rec.kind === "post" ? "/post" : "/action", body, { timeoutMs: X_ACTION_CALL_TIMEOUT_MS }); }
    catch (e) {
      // Response lost or broker down: the durable record stays 'submitted' and the poll
      // re-sends the same intent later. Nothing is assumed to have happened.
      Object.assign(rec, { attempts: (rec.attempts || 0) + 1, lastError: e.code || "BROKER_UNAVAILABLE", updatedAt: new Date(now()).toISOString() });
      persist();
      return rec;
    }
    const j = r.json || {};
    rec.updatedAt = new Date(now()).toISOString();
    const bound = r.status === 200 && (j.handle === undefined || j.handle === rec.handle) && (j.intentId === undefined || j.intentId === rec.intentId) && (j.project === undefined || j.project === key(t));
    if (r.status === 200 && !bound) {
      Object.assign(rec, { state: "refused", reason: "BROKER_RECEIPT_MISMATCH" });
    } else if (r.status === 200) {
      bookActionCost(t, rec, j);
      const stage = String(j.stage || "");
      if (["verified", "accepted", "verification-pending"].includes(stage)) {
        Object.assign(rec, { state: "applied", verified: stage === "verified", reason: null,
          ...(j.tweetId ? { tweetId: String(j.tweetId), url: j.url || `https://x.com/${rec.handle}/status/${j.tweetId}` } : {}) });
        if (j.profile && typeof j.profile === "object") {
          // The account identity as X reports it after the change: shown on the project page.
          t.social = { ...(t.social || {}), x: { ...(t.social?.x || {}), profile: { name: j.profile.name || null, bio: j.profile.bio || null, location: j.profile.location || null, website: j.profile.website || null, avatarUrl: j.profile.avatarUrl || null, bannerUrl: j.profile.bannerUrl || null, checkedAt: rec.updatedAt } } };
        }
        event("x", `${t.symbol}: ${rec.kind === "post" ? "posted on X" : `X account ${rec.kind} updated`} by ${String(rec.holder).slice(0, 6)}… (@${rec.handle})`, { token: t.address });
      } else if (stage === "uncertain") {
        Object.assign(rec, { state: "uncertain", reason: "outcome unknown" });
        event("x", `${t.symbol}: X ${rec.kind} outcome is unknown; an operator must reconcile it before anything is re-sent`, { token: t.address, level: "warn" });
      } else if (stage === "not-dispatched") {
        Object.assign(rec, { state: "waiting", reason: j.reason || "PROVIDER_CREDITS_EXHAUSTED", retryAt: new Date(now() + X_ACTION_RETRY_MS).toISOString() });
        event("x", `${t.symbol}: X ${rec.kind} waiting for API credits; it is retried automatically`, { token: t.address, level: "error" });
      } else {
        Object.assign(rec, { state: "failed", reason: j.reason || "PROVIDER_NOT_CONFIRMED" });
      }
    } else if (r.status === 429) {
      Object.assign(rec, { state: "waiting", reason: "RATE_LIMITED", retryAt: new Date(now() + 5 * 60_000).toISOString() });
    } else {
      Object.assign(rec, { state: "refused", reason: j.error || `HTTP_${r.status}` });
    }
    pruneActions(t);
    persist();
    return rec;
  }
  /// The holder route's entry point: one validated action from a >1 % holder. Idempotent by
  /// intent — the same signed request answers from the stored record instead of acting twice.
  async function submitAction(t, { holder, kind, payload, image = null, intentId }) {
    // Owner 2026-10-02: once the project's X account exists, holders above the threshold use it;
    // the later DEX stage is not a precondition.
    if (!/^[a-f0-9]{64}$/.test(String(intentId || ""))) throw actionFail(400, "invalid action intent");
    const account = xAccountOf(t), handle = account?.handle;
    if (!account) throw actionFail(409, "this project has no X account verified yet");
    const existing = actionsOf(t)[intentId];
    if (existing) {
      if (existing.kind !== kind || payloadHash(existing.payload) !== payloadHash(payload)) throw actionFail(409, "this request id was used for another action");
      if (ACTION_FINAL.has(existing.state)) return existing;
      return dispatchAction(t, existing, image);
    }
    const last = Object.values(actionsOf(t)).reduce((ms, r) => Math.max(ms, Date.parse(r.createdAt || "") || 0), 0);
    if (now() - last < X_ACTION_MIN_GAP_MS) throw actionFail(429, `wait ${Math.ceil((X_ACTION_MIN_GAP_MS - (now() - last)) / 1000)} s before the next X action`);
    const rec = actionsOf(t)[intentId] = { id: `xact_${intentId.slice(0, 12)}`, intentId, kind, payload, holder, handle, userId: account.userId, state: "submitted",
      applied: kind === "profile" ? payload.profile : kind === "post" ? { text: payload.text } : kind === "delete" ? { tweetId: payload.tweetId } : null,
      ...(image ? { image: imageMeta(Buffer.from(image, "base64")) } : {}), createdAt: new Date(now()).toISOString(), attempts: 0 };
    // Durable intent before any dispatch: if this cannot be saved, nothing is sent.
    try { persist(); } catch (e) { delete actionsOf(t)[intentId]; throw e; }
    return dispatchAction(t, rec, image);
  }
  /// Re-sends actions whose answer was lost, and retries the ones waiting for API credits.
  /// Images are not kept, so an avatar/banner whose answer was lost is reported, not re-sent.
  async function retryActions(t) {
    for (const rec of Object.values(actionsOf(t))) {
      if (ACTION_FINAL.has(rec.state)) continue;
      if (rec.state === "waiting" && Date.parse(rec.retryAt || "") > now()) continue;
      if (["avatar", "banner"].includes(rec.kind) && rec.state === "submitted" && (rec.attempts || 0) > 0) {
        // The bytes are gone with the request; ask the broker for its receipt only.
        Object.assign(rec, { state: "uncertain", reason: "image upload outcome unknown; send it again if the account did not change", updatedAt: new Date(now()).toISOString() });
        persist(); continue;
      }
      if (["avatar", "banner"].includes(rec.kind) && rec.state === "waiting") continue;   // needs the bytes; the holder re-sends
      try { await dispatchAction(t, rec); } catch (e) { log(e.message); }
    }
  }

  /// Settles accrued X usage treasury → operations in one idempotent batch. A batch
  /// stays 'submitted' while its charge is in flight or uncertain (no new batch is
  /// opened until an operator reconciles it; the operator is warned once); a batch
  /// the treasury could not cover is released and settlement backs off 15 minutes.
  async function settleUsage(t) {
    if (typeof charge !== "function") return null;
    const u = t.socialUsage;
    if (!u) return null;
    let batch = Object.values(u.batches || {}).find((b) => b.state === "submitted");
    if (!batch) {
      if (Date.parse(u.nextSettleAt || "") > now()) return null; // backing off after a released batch
      const due = u.unsettledMicros >= X_USAGE_SETTLE_MICROS || (u.unsettledMicros > 0 && now() - Date.parse(u.oldestUnsettledAt || "") >= X_USAGE_SETTLE_AGE_MS);
      if (!due) return null;
      batch = { id: `package-social-usage:${key(t)}:${(u.batchCount || 0) + 1}`, micros: u.unsettledMicros, state: "submitted", createdAt: new Date(now()).toISOString() };
      u.batchCount = (u.batchCount || 0) + 1; (u.batches ||= {})[batch.id] = batch;
      persist(); // durable batch before any dispatch
    }
    let r;
    try { r = await charge(t, { id: batch.id, micros: batch.micros, reason: "X API usage", reservedMicros: batch.micros }); }
    catch (e) { r = { paid: false, pending: true, reason: `charge failed: ${e.message}` }; } // thrown mid-charge: outcome unknown, never repeated blindly
    if (!r || typeof r !== "object") r = { paid: false, pending: true, reason: "charge returned no result" };
    if (r.paid) {
      batch.state = "settled"; batch.tx = r.tx; batch.settledAt = r.settledAt || new Date(now()).toISOString();
      u.unsettledMicros = Math.max(0, u.unsettledMicros - batch.micros); u.settledMicros += batch.micros;
      u.oldestUnsettledAt = u.unsettledMicros > 0 ? new Date(now()).toISOString() : null;
      u.nextSettleAt = null; pruneBatches(u);
      persist();
      event("x", `${t.symbol}: X API usage settled $${(batch.micros / 1e6).toFixed(4)} treasury → operations`, { token: t.address });
    } else if (r.pending) {
      // In flight or uncertain: the batch keeps blocking new batches (the same id is
      // re-presented so the idempotent charge can resolve it) and the operator is told once.
      if (!batch.warnedAt) {
        batch.warnedAt = new Date(now()).toISOString(); batch.reason = r.reason || null; pruneBatches(u); persist();
        event("x", `${t.symbol}: X usage batch ${batch.id} is pending operator reconciliation`, { token: t.address, level: "warn" });
      }
    } else {
      // Stopped before dispatch (e.g. treasury too low): release the batch so the usage
      // stays unsettled, and do not open another batch on every poll.
      batch.state = "released"; batch.reason = r.reason || null; batch.releasedAt = new Date(now()).toISOString();
      u.nextSettleAt = new Date(now() + X_USAGE_SETTLE_BACKOFF_MS).toISOString();
      pruneBatches(u); persist();
    }
    return batch;
  }

  /// Executes approved X_POST proposals for projects with an assigned account.
  async function poll() {
    if (polling) return { skipped: true };
    polling = true;
    const done = [];
    try {
      const s = get();
      for (const t of Object.values(s.tokens)) {
        if (t.social?.x?.handle) {
          for (const p of t.proposals || []) {
            if (p.type !== X_POST_TYPE || p.status !== "approved" || p.cancelledAt || p.revokedAt) continue;
            const rec = t.xPosts?.[p.id];
            if (rec && FINAL.has(rec.state)) continue;
            try { done.push(await postOne(t, p)); } catch (e) { log(e.message); }
          }
        }
        // Holder actions whose answer was lost, or that are waiting for API credits.
        if (Object.keys(t.xActions || {}).length) { try { await retryActions(t); } catch (e) { log(e.message); } }
        // Usage booked by the posts above is settled in the same pass once it is due.
        try { await settleUsage(t); } catch (e) { log(e.message); }
      }
    } finally { polling = false; }
    return { processed: done.length };
  }

  function start({ refreshMs = 60_000, pollMs = 30_000 } = {}) {
    const a = setInterval(() => refreshAccounts().catch((e) => log(e.message)), refreshMs);
    const b = setInterval(() => poll().catch((e) => log(e.message)), pollMs);
    a.unref?.(); b.unref?.();
    refreshAccounts().catch((e) => log(e.message));
    return () => { clearInterval(a); clearInterval(b); };
  }

  return { refreshAccounts, poll, postOne, submitAction, retryActions, settleUsage, start, status: () => ({ ...status }) };
}
