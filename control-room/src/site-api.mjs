// The Gateway website API, exactly as AGENT_SYSTEM_PROMPT.md describes it.
//   Agent side:  /api/site/agent/:token/{heartbeat,budget,inbox,replies,proposals,...}
//   Holder side: /api/site/holder/:token/{message,proposal,vote}   (wallet-signed)
//   Public:      /api/site/token/:token                            (read-only page data)
// Every state-changing call is an EIP-191 signature over canonical JSON; the site checks
// the signer, token binding, freshness, nonce reuse and the Idempotency-Key.
import { randomBytes } from 'node:crypto';
import { get, save, event } from "./store.mjs";
import { recoverSigner, canonicalize, payloadHash } from "./canonical.mjs";
import { tokenOf, budgetOf, usd, postMessage, createProposal, vote, quotaOf, allowanceOf, allowanceText, eligibleSupply, finalizeDue, spendStats, fundingOf, holderRole, setUsername } from "./economy.mjs";
import { refreshHolderBalance, proposalSnapshot, snapshotVoteWeight, verifyDueGovernance } from "./market.mjs";
import { sessionOf } from "./auth.mjs";
import { lockStatus } from "./plan.mjs";
import { viewersOf } from "./viewers.mjs";
import { catalogPrices, agentModelCompatibility } from "./providers.mjs";
import { vpsHealthOf } from './deploy.mjs';
import { chainIdOf as ecoChainIdOf } from "./economy.mjs";
import { isSolanaChain, tokenKey, holderKey, holderPattern, sameHolder, verifySolanaSignature, SOLANA_CHAIN_ID } from "./solana-auth.mjs";
import { createChatSessions, CHAT_STATEMENT, CHAT_TTL } from "./chat-session.mjs";
import { communityOf, rememberConversation } from "./community.mjs";
import { marketOf } from "./market.mjs";
import { KURT } from "../public/kurt/profile.mjs";
import { projectProfile, publicProfileProposal } from './project-profile.mjs';
import { isDexType } from './dex-policy.mjs';
import { dexPaymentsOf } from './dex-payments.mjs';
import { xAccountOf, xPostsOf, xUsageOf, xActionsOf, xProfileOf, validateXAction, validateXImage, xPosts, X_PROFILE_LIMITS, X_AVATAR_MAX_BYTES, X_BANNER_MAX_BYTES } from './x-posts.mjs';
import { publicLaunchPackage } from './launch-package.mjs';
import { publicCreatorFees } from './fee-public.mjs';
import { socialMilestoneOf } from './social-milestone.mjs';
import { startupStagesOf } from './startup-stages.mjs';
import { publicText, publicTree, pickPublic, publicOffer, publicMarket, publicTransactions } from "./public-safety.mjs";
import { consumeReplayNonce, SIGNATURE_FRESH_MS } from './replay-window.mjs';
import { acknowledgeRuntime, runtimeCapabilitiesOf } from './runtime-capabilities.mjs';
import { PROPOSAL_USAGE_POLICY } from './usage-budget.mjs';
import { startupStatusOf } from './startup-status.mjs';
import { voiceStatus, voicePlayback, voiceStatusForAgent, autoVoiceOnReply } from './local-services.mjs';
import { enforceChatModeration } from './chat-moderation.mjs';
import { applyChatActions, publicDesktop } from './chat-actions.mjs';
import { isWalletType, walletPolicyOf } from './wallet-proposals.mjs';
import { needsAgentReply } from './chat-policy.mjs';
import {isLaunchType,communityActionCapabilities,COMMUNITY_ACTION_RULES} from './community-actions.mjs';
import {communityActionEnabled,communitySignerStatus} from './community-signer-runtime.mjs';
import {publicBanner} from './project-banner-runtime.mjs';

let snapshotSequence = 0;

const FRESH_MS = SIGNATURE_FRESH_MS;
const fail = (status, message) => Object.assign(new Error(message), { status });

// economy.mjs's CHAIN_IDS table has no Solana entry; chat sessions and wallet DTOs
// need a truthy id, so Solana resolves to relay.mjs's SOLANA_CHAIN_ID here.
export const chainIdOf = (chain) => (isSolanaChain(chain) ? SOLANA_CHAIN_ID : ecoChainIdOf(chain));

// Holder balance / governance reads go through market.mjs, which dispatches by chain
// (Pons indexer for EVM projects, the Solana market module for chain 'solana').
const refreshHolder = async (t, holder) => { if (t.onchain) await refreshHolderBalance(t, holder); };

function replayOf(t) {
  const s = get();
  return (s.replay[tokenKey(t.chain, t.address)] ||= { nonces: {}, idem: {} });
}

/// Returns a stored response for a repeated Idempotency-Key, or null for a new request.
function idempotent(t, key, body) {
  if (!key) return null;
  const r = replayOf(t);
  const seen = r.idem[key];
  if (!seen) return null;
  if (seen.bodyHash !== payloadHash(body)) throw fail(409, "Idempotency-Key reused with a different request");
  return { ...seen.response, duplicate: true };
}

function remember(t, key, body, response) {
  if (!key) return;
  const r = replayOf(t);
  r.idem[key] = { bodyHash: payloadHash(body), response };
  const keys = Object.keys(r.idem);
  if (keys.length > 5000) delete r.idem[keys[0]];
}

// The verifier is chosen by the SIGNER ROLE: the agent wallet is always an ethers
// key (EIP-191), a holder signs with the token's chain — Ed25519 (Phantom/Solflare
// signMessage) on Solana, EIP-191 elsewhere. Nonce, freshness and field rules are
// identical on both chains. Exported for tests only.
export function verifyEnvelope(t, body, { type, signer, fields, optional = [], role = "holder", extra = [] }) {
  const p = body?.payload;
  if (!p || typeof p !== "object" || typeof body.signature !== "string") throw fail(400, "expected {payload, signature}");
  if (Object.keys(body).some((key) => !["payload", "signature", ...extra].includes(key))) throw fail(400, "unexpected envelope field");
  if (p.schemaVersion !== 1 || p.type !== type) throw fail(400, `payload.type must be ${type} with schemaVersion 1`);
  if (typeof p.tokenAddress !== "string" || tokenKey(t.chain, p.tokenAddress) !== tokenKey(t.chain, t.address)) throw fail(400, "payload is bound to another token");
  for (const f of fields) if (!(f in p)) throw fail(400, `payload.${f} is required`);
  for (const f of Object.keys(p)) if (![...fields, ...optional].includes(f)) throw fail(400, `unexpected payload field: ${f}`);
  const ts = Date.parse(p.timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > FRESH_MS) throw fail(400, "timestamp is missing or stale");
  if (!/^0x[0-9a-f]{32}$/.test(String(p.nonce))) throw fail(400, "nonce must be 16 random bytes as hex");
  if (role === "holder" && isSolanaChain(t.chain)) {
    // Exact-case base58 public key === payload.holder; a 64-byte Ed25519 signature
    // over the canonical JSON. An EIP-191 hex signature never verifies here.
    if (!verifySolanaSignature(p, body.signature, String(signer))) throw fail(401, "bad signature");
    return p;
  }
  let who;
  try { who = recoverSigner(p, body.signature); } catch { throw fail(401, "bad signature"); }
  if (who.toLowerCase() !== String(signer).toLowerCase()) throw fail(401, "signature is not from the expected wallet");
  return p;
}

function consumeNonce(t, p) {
  const r = replayOf(t);
  consumeReplayNonce(r.nonces, p.nonce);
}

const BASE = ["schemaVersion", "type", "tokenAddress", "timestamp", "nonce"];
const chatSessions = createChatSessions();

// A chat cookie is deliberately NOT accepted by handleHolder or any agent route.
/// Why the agent's error reply happened, when the gateway knows it (a failed AI request in the last
/// five minutes). The agent's own text is generic ("connection or budget issue"); the gateway is the
/// one that saw the provider's answer.
export function aiFailureNote(t, m = null, e = t.agent?.lastAiError) {
  if (!m?.id) return "";
  // Current configuration is safe to explain on a new error reply even if the
  // running agent stopped at GET budget before making an AI request. This does
  // not infer a past charge or rewrite any stored reply.
  const compatibility = agentModelCompatibility(t.agent?.ai?.model);
  if (!compatibility.supported) return ' Current AI configuration: ' + compatibility.message + ' Community chat is still available.';
  // The most recent mission or another holder's error is not this reply's cause.
  // Legacy unscoped diagnostics remain in the operator log, never appended here.
  const age = Date.now() - Date.parse(e?.at || '');
  if (!e || e.messageId !== m.id || !(age >= 0 && age <= 5 * 60_000)) return "";
  const runtimeReasons = {
    ai_model_incompatible: 'The model used for this request cannot run agent chat. Community chat is still available.',
    vps_usage_review_required: 'AI requests are paused while project funds are reserved for server usage that needs review. Your personal allowance is unchanged. Community chat is still available.',
    runtime_liabilities_unverified: 'AI requests are paused while the operator checks outstanding project costs. Your personal allowance is unchanged. Community chat is still available.',
    runtime_balance_unverified: 'The project balance could not be verified for this AI request. Your personal allowance is unchanged. Community chat is still available.',
    runtime_funding_required: 'The project has too little unreserved budget for this AI request after covering server costs and existing commitments. Your personal allowance is unchanged. Community chat is still available.'
  };
  const runtimeReason = Object.hasOwn(runtimeReasons, e.code) ? e.code : Object.hasOwn(runtimeReasons, e.reason) ? e.reason : null;
  if (runtimeReason) return ' Reason: ' + runtimeReasons[runtimeReason];
  if (/personal usage allowance/.test(String(e.message || "")) && m?.holder) {
    try {
      const a = allowanceOf(t, m.holder), need = e.holdMicros || 0, { promptUsd } = catalogPrices(a.model);
      const needTokens = promptUsd > 0 ? Math.floor(need / promptUsd).toLocaleString("en-US") + " tokens, " : "";
      return ` Reason: ${allowanceText({ ...a, exhausted: true })} This answer needs about ${needTokens}$${(need / 1e6).toFixed(2)}. Nothing was charged.`;
    } catch { /* fall through */ }
  }
  if (e.code === "payment_refused") return " Reason: the AI provider refused this project's payment on its side (not this project's budget) — nothing was charged and the treasury is untouched.";
  if (e.code === "provider_not_confirming") return " Reason: the AI provider is not confirming payments right now, so this message was not charged. Kurt answers again as soon as the provider recovers.";
  if (e.code === "payment_unconfirmed") return " Reason: the payment for this answer went out on Base but the AI provider has not confirmed it; it is recorded and will be reconciled. Nothing else was charged.";
  return ` Reason: ${String(e.message || "").slice(0, 160)}`;
}
/// What a visitor needs to judge a vote: Yes/No as a share of the governing supply, the threshold,
/// whether it is passing right now, and who voted (address or @name, weight, optional comment).
/// Holder addresses and weights are public on-chain facts; comments pass publicText.
export function voteSummary(t, p) {
  const s = get(), v2 = p.governanceVersion === 2, rows = Object.entries(p.votes || {});
  const total = v2 ? BigInt(p.totalSupplyWei || "0") : Number(p.snapshotTotal) || 0;
  const pct = (w) => v2 ? (total > 0n ? Number(BigInt(w) * 1_000_000n / total) / 10_000 : 0) : (total > 0 ? (Number(w) / total) * 100 : 0);
  const round = (n) => Math.round(n * 100) / 100;
  const sum = (side) => v2 ? rows.filter(([, v]) => !!v.support === side).reduce((n, [, v]) => n + BigInt(v.weightWei || "0"), 0n) : rows.filter(([, v]) => !!v.support === side).reduce((n, [, v]) => n + (Number(v.weight) || 0), 0);
  const yes = sum(true), no = sum(false);
  const voters = rows.map(([h, v]) => ({ holder: h, username: s.profiles?.[h]?.username || null, support: !!v.support, sharePct: round(pct(v2 ? v.weightWei || "0" : v.weight || 0)), at: v.at || null, comment: v.comment ? publicText(String(v.comment)).slice(0, 280) : null }))
    .sort((a, b) => b.sharePct - a.sharePct).slice(0, 100);
  const base = { yesPct: round(pct(yes)), noPct: round(pct(no)), voters, endsAt: p.endsAt || null, closed: p.status !== "voting" || !!p.cancelledAt || !!p.revokedAt };
  if (v2) {
    const approvalBps = BigInt(p.approvalBps ?? 1500), passing = total > 0n && yes * 10_000n > total * approvalBps && (!p.requireMajority || yes > no);
    return { ...base, version: 2, basis: "total supply", approvalPct: Number(approvalBps) / 100, requireMajority: !!p.requireMajority, passing, needsPct: Math.max(0, round(Number(approvalBps) / 100 - base.yesPct)) };
  }
  const cast = yes + no, quorum = total > 0 && cast * 10_000 >= total * s.settings.quorumBps, pass = cast > 0 && yes * 10_000 > cast * s.settings.passBps;
  return { ...base, version: 1, basis: "the opening snapshot", quorumPct: s.settings.quorumBps / 100, passPct: s.settings.passBps / 100, passing: quorum && pass, needsPct: Math.max(0, round(s.settings.quorumBps / 100 - base.yesPct - base.noPct)) };
}
export async function handleHolderChat(req, token, rest, body, origin) {
  if (req.method !== "POST") throw fail(405, "POST required");
  if (req.headers.origin !== origin || !/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "") ||
      (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin")) throw fail(403, "same-origin JSON request required");
  const t = tokenOf(token);
  if (rest === "chat-logout") return { json: { disconnected: true }, cookie: chatSessions.revoke(req, token) };
  const holder = rest === "chat-session" ? body?.payload?.holder : body?.holder;
  if (typeof holder !== "string" || !holderPattern(t).test(holder)) throw fail(400, "holder wallet is required");
  if (rest === "chat-session") {
    const p = verifyEnvelope(t, body, { type: "holder_chat_session", signer: holder, role: "holder", fields: [...BASE, "holder", "origin", "chainId", "scope", "expiresAt", "statement"] });
    const expires = Date.parse(p.expiresAt);
    if (p.origin !== origin || p.chainId !== chainIdOf(t.chain) || p.scope !== "chat" || p.statement !== CHAT_STATEMENT) throw fail(400, "invalid chat-only approval scope");
    if (!Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + CHAT_TTL) throw fail(400, "chat approval must expire within one hour");
    consumeNonce(t, p); save();
    await refreshHolder(t, holder);
    if (holderRole(t, holder).role === "none") throw fail(403, "Hold this token to join the chat.");
    const issued = chatSessions.issue(req, { token, holder, origin, expires });
    return { json: { active: true, holder: holderKey(t, holder), expiresAt: issued.expiresAt }, cookie: issued.cookie };
  }
  const allowed = rest === "chat-status" ? ["holder"] : ["holder", "text", "requestId"];
  if (!body || Object.keys(body).some(k => !allowed.includes(k))) throw fail(400, "unexpected chat field");
  const s = chatSessions.get(req, token, holder, origin);
  if (rest === "chat-status") return { json: { active: !!s, expiresAt: s ? new Date(s.expires).toISOString() : null, chainId: chainIdOf(t.chain), statement: CHAT_STATEMENT } };
  if (rest !== "chat-message") throw fail(404, "no chat route");
  if (!s) throw fail(401, "Chat approval expired. Send again to approve a new session.");
  enforceChatModeration(t,holder,body.text,{persist:save});
  if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 2000 || !/^[a-zA-Z0-9-]{16,64}$/.test(String(body.requestId))) throw fail(400, "invalid chat message");
  const digest = payloadHash(body), previous = s.requests.get(body.requestId);
  if (previous) {
    if (previous.digest !== digest) throw fail(409, "requestId already used for another message");
    return { json: { accepted: true, messageId: previous.id, duplicate: true } };
  }
  if (s.busy) throw fail(429, "A message is already sending. Please wait.");
  s.busy = true;
  try {
    await refreshHolder(t, holder);
    if (chatSessions.get(req, token, holder, origin) !== s) throw fail(401, "Chat approval expired. Please approve again.");
    const message = postMessage(t, holder, body.text, []);
    s.requests.set(body.requestId, { digest, id: message.id });
    if (s.requests.size > 128) s.requests.delete(s.requests.keys().next().value);
    save();
    return { json: { accepted: true, messageId: message.id } };
  } finally { s.busy = false; }
}

// ── agent endpoints ───────────────────────────────────────────────────────────

async function agentPost(t, req, body, { type, fields }, handler) {
  const key = req.headers["idempotency-key"] || null;
  // A real VPS authenticates with the session minted from its boot code; the
  // simulated agent (and any future VPS-side signer) sends signed envelopes.
  let p;
  if (sessionOf(req, t)) {
    p = body?.payload && typeof body.payload === "object" ? body.payload : body || {};
    for (const f of fields) if (!(f in p)) throw fail(400, `payload.${f} is required`);
    p = { ...p, type, tokenAddress: t.address, agentWalletAddress: t.agent.wallet, nonce: p.nonce || `0x${randomBytes(16).toString('hex')}` };
  } else {
    const optional = { heartbeat: ["currentProposalId", "capabilities"], holder_reply: ["stage"], proposal_status: ["reason", "result"], proposal_suggestion: ["rationale"], status_log: ["proposalId"] }[type] || [];
    p = verifyEnvelope(t, body, { type, signer: t.agent.wallet, role: "agent", fields: [...BASE, "agentWalletAddress", ...fields], optional });
    if (String(p.agentWalletAddress).toLowerCase() !== t.agent.wallet.toLowerCase()) throw fail(400, "agentWalletAddress mismatch");
  }
  // Authenticate before returning any cached response. An idempotency key is not a credential.
  const replay = idempotent(t, key, body);
  if (replay) return replay;
  if (!sessionOf(req, t)) consumeNonce(t, p);
  const response = await handler(p);
  remember(t, key, body, response);
  save();
  return response;
}

export async function handleAgent(req, token, rest, query, body) {
  const t = tokenOf(token);
  const s = get();
  const route = `${req.method} ${rest}`;

  if(route==='GET capabilities')return {capabilities:communityActionCapabilities(t,chainIdOf(t.chain),communitySignerStatus(t)),rules:COMMUNITY_ACTION_RULES};

  if (route === "POST context") {
    if (!sessionOf(req, t)) throw fail(401, "agent session required");
    if (!body || Object.keys(body).some(k => !["messageId"].includes(k))) throw fail(400, "invalid context request");
    const message = t.messages.find(m => m.id === body.messageId);
    if (!message) throw fail(404, "message not found");
    return rememberConversation(t, message.holder, message.id);
  }

  if (route === "POST message-status") {
    return agentPost(t, req, body, { type: "message_status", fields: ["messageId", "state"] }, async p => {
      if (!["working", "failed", "queued"].includes(p.state)) throw fail(400, "invalid message state");
      const m = t.messages.find(m => m.id === p.messageId);
      if (!m || m.cancelledAt || m.revokedAt) throw fail(404, "message unavailable");
      if (!needsAgentReply(m)) throw fail(403, 'Community messages do not have an AI job state.');
      if (t.replies.some(r => r.messageId === m.id) && !m.permissions?.length) return { accepted: true };
      m.chatState = p.state; m.statusAt = new Date().toISOString(); return { accepted: true };
    });
  }

  if (route === "GET budget") {
    const b = budgetOf(t), aiModelCompatibility = agentModelCompatibility(t.agent?.ai?.model);
    return { tokenAddress: t.address, status: b.status, remainingCredit: usd(b.remainingMicros).toFixed(6), currency: "USD", aiRequestsAllowed: b.aiRequestsAllowed && aiModelCompatibility.supported, validUntil: b.validUntil, aiAvailability: b.aiAvailability, aiAvailableMicros: b.aiAvailableMicros, aiModelCompatibility, voice: voiceStatusForAgent(t) };
  }

  if (route === "GET inbox") {
    const after = query.get("cursor") ? Number(query.get("cursor")) : 0;
    const msgs = t.messages.filter((m) => m.seq > after && needsAgentReply(m) && !t.replies.some(r => r.messageId === m.id)).slice(0, 50);
    return {
      tokenAddress: t.address,
      messages: msgs.map((m) => ({ id: m.id, text: publicText(m.text), language: "und", createdAt: m.createdAt, cursorAfter: String(m.seq), holder: m.holder, username: m.username || null, sharePct: m.sharePct ?? null, role: m.role || "chat", permissions: m.permissions || [], hasReply: t.replies.some(r => r.messageId === m.id), cancelledAt: m.cancelledAt || m.revokedAt || null })),
      nextCursor: msgs.length ? String(msgs[msgs.length - 1].seq) : String(t.messages.at(-1)?.seq || after || 0),
    };
  }

  if (route === "GET proposals") {
    if (query.get("status") !== "approved") throw fail(400, "only status=approved is served to the agent");
    const before = t.proposals.map(p => p.status).join(",");
    if (t.onchain) await verifyDueGovernance(t);
    finalizeDue(t);
    if (before !== t.proposals.map(p => p.status).join(",")) save();
    const approved = t.proposals.filter((p) => (isWalletType(p.type)
      ? (communityActionEnabled(t,p.type) || !!t.communityActionReservations?.[p.id]) && p.status === 'approved'
      : !isLaunchType(p.type) && p.type!=='PROJECT_PROFILE_UPDATE' && p.type!=='X_POST' && p.status === 'approved' && !p.cancelledAt && !p.revokedAt))
      .sort((a, b) => a.approvedOrder - b.approvedOrder);
    return { tokenAddress: t.address, proposals: approved.map((p) => ({ id: p.id, type: p.type, status: "approved", payloadHash: p.payloadHash, expiresAt: p.payload?.expiresAt || null, payload: p.payload, agentStatus: p.agentStatus,
      ...(isWalletType(p.type)?{executionState:p.result?.executionState||null,hasIntent:!!t.communityActionReservations?.[p.id]}:{}),
      ...(isDexType(p.type)?{paymentState:p.result?.paymentState||null}:{}) })) };
  }

  if (route === "POST heartbeat") {
    return agentPost(t, req, body, { type: "heartbeat", fields: ["state"] }, async (p) => {
      if (!["starting", "idle", "working", "paused"].includes(p.state)) throw fail(400, "invalid state");
      const capabilities = p.capabilities === undefined ? null : acknowledgeRuntime(t, p.capabilities);
      t.agent.state = p.state;
      t.agent.currentProposalId = p.currentProposalId ?? null;
      t.agent.lastHeartbeatAt = new Date().toISOString();
      // First check-in after a registration: the only honest "AI came up" timestamp.
      t.agent.firstHeartbeatAt ||= t.agent.lastHeartbeatAt;
      if (capabilities) t.vps.runtimeCapabilities = capabilities;
      else delete t.vps.runtimeCapabilities;
      return { accepted: true, serverTime: new Date().toISOString() };
    });
  }

  if (route === "POST replies") {
    return agentPost(t, req, body, { type: "holder_reply", fields: ["messageId", "text"] }, async (p) => {
      const m = t.messages.find((x) => x.id === p.messageId);
      if (!m) throw fail(404, "unknown message");
      if (!needsAgentReply(m)) throw fail(403, 'This message is community chat, not an AI request.');
      if (p.stage && !["reply", "error", "result", "ack"].includes(p.stage)) throw fail(400, "invalid reply stage");
      const existing = t.replies.find((r) => r.messageId === p.messageId);
      if (existing && p.stage !== "result") return { accepted: true, replyId: existing.id, messageId: p.messageId, duplicate: true };
      m.chatState = p.stage === "error" ? "failed" : m.permissions?.length && p.stage !== "result" ? "queued" : "replied";
      m.statusAt = new Date().toISOString();
      if (existing && p.stage === "result") {
        existing.text = publicText(p.text).slice(0, 2000); existing.completedAt = new Date().toISOString(); existing.stage = "result";
        return { accepted: true, replyId: existing.id, messageId: p.messageId, duplicate: false };
      }
      // A request nonce is not a globally unique reply identity. The former
      // timestamp-prefix scheme produced rep_000000000000 for real controllers.
      // Keep saved IDs stable on retries/results; allocate independent IDs only
      // for new replies so voice deduplication cannot collide across messages.
      // An ORDER-role holder's request may carry one ACTION line from the model; the gateway
      // performs it (live screen, X post) and the public reply shows the outcome instead.
      const replyText = p.stage === "error" ? p.text + aiFailureNote(t, m) : await applyChatActions(t, m, p.text);
      const r = { id: `rep_${randomBytes(16).toString('hex')}`, messageId: p.messageId, text: publicText(replyText).slice(0, 2000), at: new Date().toISOString(), stage: p.stage || "reply" };
      t.replies.push(r);
      if (r.stage !== 'error') setImmediate(() => { autoVoiceOnReply(t, r).catch(() => {}); });
      return { accepted: true, replyId: r.id, messageId: p.messageId, duplicate: false };
    });
  }

  const statusMatch = rest.match(/^proposals\/([^/]+)\/status$/);
  if (req.method === "POST" && statusMatch) {
    return agentPost(t, req, body, { type: "proposal_status", fields: ["proposalId", "approvedPayloadHash", "status"] }, async (p) => {
      const prop = t.proposals.find((x) => x.id === statusMatch[1]);
      if (!prop || p.proposalId !== prop.id) throw fail(404, "unknown proposal");
      if(isDexType(prop.type))throw fail(403,'Only the payment broker can report DEX payment status');
      if(isWalletType(prop.type))throw fail(403,'The AI cannot report wallet execution; a verified chain receipt is required');
      if(isLaunchType(prop.type))throw fail(403,'The AI cannot report a launch; a verified deployment receipt is required');
      if (prop.status !== "approved") throw fail(409, "proposal is not approved");
      if (p.approvedPayloadHash !== prop.payloadHash) throw fail(409, "payload hash does not match the approved proposal");
      if (!["in_progress", "done", "rejected_by_rules", "paused"].includes(p.status)) throw fail(400, "invalid status");
      if (prop.cancelledAt || prop.revokedAt) throw fail(409, "proposal cancelled");
      if (["done", "rejected_by_rules"].includes(prop.agentStatus)) {
        return { accepted: true, proposalId: prop.id, status: prop.agentStatus, duplicate: true };
      }
      prop.agentStatus = p.status;
      prop.agentReason = p.reason ?? null;
      prop.result = p.result ?? null;
      event("agent", `${t.symbol}: proposal "${prop.title}" → ${p.status}${p.reason ? ` (${p.reason})` : ""}`, { token: t.address });
      return { accepted: true, proposalId: prop.id, status: p.status, duplicate: false };
    });
  }

  if (route === "POST proposals/suggest") {
    return agentPost(t, req, body, { type: "proposal_suggestion", fields: ["proposalType", "title", "proposalPayload"] }, async (p) => {
      const sug = { id: `sug_${p.nonce.slice(2, 14)}`, type: p.proposalType, title: String(p.title).slice(0, 120), payload: p.proposalPayload, rationale: p.rationale ?? null, at: new Date().toISOString(), status: "pending" };
      t.suggestions.push(sug);
      return { accepted: true, suggestionId: sug.id, status: "pending" };
    });
  }

  if (route === "POST status-log") {
    return agentPost(t, req, body, { type: "status_log", fields: ["level", "event", "message"] }, async (p) => {
      if (!["info", "warning", "error"].includes(p.level)) throw fail(400, "invalid level");
      const e = { id: `log_${p.nonce.slice(2, 14)}`, at: new Date().toISOString(), simAt: new Date(s.clock.simMs).toISOString(), level: p.level, event: publicText(p.event).slice(0, 60), message: publicText(p.message).slice(0, 500), proposalId: p.proposalId ?? null };
      t.statusLog.unshift(e);
      if (t.statusLog.length > 300) t.statusLog.length = 300;
      return { accepted: true, entryId: e.id, duplicate: false };
    });
  }

  throw fail(404, `no agent route ${route}`);
}

// ── holder endpoints (wallet-signed) ──────────────────────────────────────────

export async function handleHolder(req, token, rest, body) {
  const t = tokenOf(token);
  const holder = body?.payload?.holder;
  if (typeof holder !== "string" || !holderPattern(t).test(holder)) throw fail(400, "payload.holder is required");
  const signed = (type, fields, optional = []) => {
    const p = verifyEnvelope(t, body, { type, signer: holder, role: "holder", fields: [...BASE, "holder", ...fields], optional });
    consumeNonce(t, p);
    return p;
  };
  let out;
  if (req.method === "POST" && rest === "message") {
    const p = signed("holder_message", ["text"], ["permissions"]);
    enforceChatModeration(t,holder,p.text,{persist:save});
    await refreshHolder(t, holder);   // the chain says what this wallet holds right now
    out = { accepted: true, message: postMessage(t, holder, p.text, p.permissions), role: holderRole(t, holder) };
  } else if (req.method === "POST" && rest === "username") {
    const p = signed("holder_username", ["username"]);
    out = { accepted: true, profile: setUsername(holder, p.username) };
  } else if (req.method === "POST" && rest === "proposal") {
    const p = signed("holder_proposal", ["proposalType", "title", "proposalPayload"]);
    enforceChatModeration(t,holder,[p.title,JSON.stringify(p.proposalPayload)].join('\n'),{persist:save});
    const chainSnapshot = t.governanceVersion === 2 ? await proposalSnapshot(t, holder) : null;
    out = { accepted: true, proposal: createProposal(t, holder, { type: p.proposalType, title: p.title, payload: p.proposalPayload, chainSnapshot }) };
  } else if (req.method === "POST" && rest === "vote") {
    const p = signed("holder_vote", ["proposalId", "support"], ["comment"]);
    if (Object.hasOwn(p, "comment") && p.comment != null && (typeof p.comment !== "string" || p.comment.trim().length > 280)) throw fail(400, "a vote comment is text of at most 280 characters");
    const comment = typeof p.comment === "string" ? p.comment.trim() : "";
    if (comment) enforceChatModeration(t, holder, comment, { persist: save });   // same rules as chat: no links, no abuse
    const prop = t.proposals.find(x => x.id === p.proposalId);
    const weight = prop?.governanceVersion === 2 ? await snapshotVoteWeight(t, prop, holder) : null;
    out = { accepted: true, proposal: vote(t, holder, p.proposalId, p.support, weight, comment || null) };
  } else if (req.method === "POST" && rest === "x-action") {
    // The project's X account, driven by its own community: a holder with more than 1 %
    // of the supply (the "order" role) posts, deletes a post, or changes the account's
    // identity — display name, bio, location, website, logo, banner — with one signature
    // and no vote. Image bytes travel beside the signature and are bound by their sha256.
    const p = verifyEnvelope(t, body, { type: "holder_x_action", signer: holder, role: "holder", extra: ["image"],
      fields: [...BASE, "holder", "action"], optional: ["text", "tweetId", "profile", "imageSha256"] });
    const { kind, payload } = validateXAction(p);
    const image = ["avatar", "banner"].includes(kind) ? validateXImage(kind, body.image, p.imageSha256) : null;
    consumeNonce(t, p); save();
    await refreshHolder(t, holder);                       // the chain decides who may act right now
    const role = holderRole(t, holder);
    if (role.role !== "order") throw fail(403, `holding more than ${role.orderMinPct}% of ${t.symbol} is required to act on the X account`);
    if (kind === "post") enforceChatModeration(t, holder, payload.text, { persist: save });
    const rec = await xPosts().submitAction(t, { holder: holderKey(t, holder), kind, payload, image: image?.base64 || null, intentId: payloadHash(p).slice(2) });
    out = { accepted: true, action: xActionsOf(t).find((a) => a.id === rec.id) || null, account: xAccountOf(t), role };
  } else if (req.method === "POST" && rest === "cancel") {
    const p = signed("holder_cancel", ["taskId"]);
    const task = t.proposals.find(x => x.id === p.taskId) || t.messages.find(x => x.id === p.taskId && x.permissions?.length);
    if (!task || !sameHolder(t, task.proposer || task.holder, holder)) throw fail(403, "only the submitting wallet can cancel this task");
    if (task.status === "approved") throw fail(409, "approved community work cannot be unilaterally cancelled");
    if (["done", "rejected_by_rules"].includes(task.agentStatus) || (t.artifacts || []).some(a => a.proposalId === task.id || a.orderId === task.id)) throw fail(409, "completed work cannot be cancelled");
    task.cancelledAt ||= new Date().toISOString(); out = { accepted: true, taskId: task.id };
  } else {
    throw fail(404, "no holder route");
  }
  save();
  return out;
}

// ── public page data ──────────────────────────────────────────────────────────

export function publicToken(token) {
  const t = tokenOf(token);
  const s = get();
  const b = budgetOf(t);
  const aiModelCompatibility = agentModelCompatibility(t.agent?.ai?.model);
  const viewers = viewersOf(t.address);
  const snapshotAtMs = Date.now();
  const lock = lockStatus(t);
  const health = vpsHealthOf(t, snapshotAtMs, viewers);
  const supply = eligibleSupply(t);
  // Solana projects have no bonding curve; the placeholder curve (if any) is still excluded.
  const curveKey = t.curveAddress ? t.curveAddress.toLowerCase() : null;
  const holders = Object.entries(t.balances)
    .filter(([a, v]) => a !== curveKey && v > 0)
    .map(([a, v]) => ({ address: a, balance: v, sharePct: holderRole(t, a).sharePct, quota: allowanceOf(t, a), username: s.profiles?.[a]?.username || null, role: holderRole(t, a).role }))
    .sort((x, y) => y.balance - x.balance);
  const result = {
    snapshotAtMs, snapshotSequence: ++snapshotSequence,
    startup: startupStatusOf(t, { health, lock, now: snapshotAtMs }),
    runtime: { ...runtimeCapabilitiesOf(t), voice: voiceStatus(t) },
    approvedWorkPolicy: { ...PROPOSAL_USAGE_POLICY, source: 'safety_ceiling_not_provider_price' },
    dexPayments: { ...dexPaymentsOf(t), serverTime: new Date().toISOString(), votingHours: s.settings.votingHours },
    launchPackage: publicLaunchPackage(t),
    creatorFees: publicCreatorFees(t, { now: snapshotAtMs }),
    startupStages: startupStagesOf(t, { now: snapshotAtMs }),
    launchAssets: {banner:publicBanner(t)},
    desktop: publicDesktop(t, snapshotAtMs),   // what an ORDER-role holder put on the live screen, if anything
    // Reference pricing, not a paid integration or a treasury allocation.
    // Never infer X spending from chat, casts, provider claims or generic deposits.
    // Live, measured X API usage: every post is billed at the
    // provider's actual credit deduction, booked to the project immediately and
    // settled treasury → operations in small batches. Reference = documented rate.
    socialCosts: (() => { const u = xUsageOf(t), x = xAccountOf(t); return {
      status: x ? 'connected' : 'not_connected', accountingStatus: 'measured_per_post', fundedMicros: null,
      spentMicros: u.settledMicros + u.unsettledMicros, unsettledMicros: u.unsettledMicros, settledMicros: u.settledMicros, remainingMicros: null, publishedPosts: u.posts, handle: x?.handle || null,
      unpricedPosts: u.unpricedPosts, pendingBatch: u.pendingBatch,
      reference: { provider: 'x-api', postMicros: 3150, currency: 'USD', network: 'provider credits (100000 = $1)', checkedOn: '2026-09-21', source: 'provider documentation',
        basis: 'documented_rate_actual_deduction_measured_per_post', premiumRequired: false,
        createsAccount: false, includesPremium: false, includesModel: false, includesNetworkFees: false },
    }; })(),
    project:projectProfile(t),
    companion: KURT,
    community: communityOf(t),
    governancePolicy: t.governanceVersion === 2 ? { version: 2, basis: "total supply", proposalPct: 1, approvalPct: 15, strict: true, requireMajority: true } : { version: 1, basis: "eligible supply" },
    walletActions: walletPolicyOf(t,chainIdOf(t.chain),communitySignerStatus(t)),
    communityActions: communityActionCapabilities(t,chainIdOf(t.chain),communitySignerStatus(t)),
    address: t.address, name: t.name, symbol: t.symbol, chain: t.chain, domain: t.domain,
    budget: { ...b, aiRequestsAllowed: b.aiRequestsAllowed && aiModelCompatibility.supported, aiModelCompatibility, remainingUsd: usd(b.remainingMicros), burnPerHourUsd: usd(b.burnPerHourMicros) },
    plan: t.plan ? { ...pickPublic(t.plan, ["provider", "model", "modelName", "promptUsd", "completionUsd", "gpuName", "numGpus", "activationUsd", "dailyUsd", "setAt"]), offer: publicOffer(t.plan.offer) } : null, lock, spend: spendStats(t), funding: fundingOf(t), onchain: t.onchain || null, market: t.onchain ? marketOf(t) : null, creator: t.creator || null,
    treasury: t.treasury.mode === "wallet"
      ? { mode: "wallet", chain: t.treasury.chain || (isSolanaChain(t.chain) ? "solana" : "robinhood"), wallet: t.treasury.wallet, robinhoodEth: t.treasury.robinhoodEth ?? null, ethUsd: t.treasury.ethUsd ?? null, ethValueUsd: (t.treasury.ethMicros || 0) / 1e6, usdcUsd: (t.treasury.usdcMicros || 0) / 1e6, usdgUsd: (t.treasury.usdgMicros || 0) / 1e6, refreshedAt: t.treasury.refreshedAt || null, bridge: t.treasury.bridge || null,
          // Solana treasuries (SOL + a USDC pocket); the EVM keys above keep their meaning.
          ...(t.treasury.chain === "solana" ? { sol: (t.treasury.solLamports || 0) / 1e9, solUsd: t.treasury.solUsd ?? null, solValueUsd: t.treasury.solUsd ? (t.treasury.solLamports || 0) / 1e9 * t.treasury.solUsd : null,
            basePocket: t.treasury.basePocket?.address ? { address: t.treasury.basePocket.address, usd: (t.treasury.basePocket.usdcMicros || 0) / 1e6, eth: (t.treasury.basePocket.ethWei || 0) / 1e18, refreshedAt: t.treasury.basePocket.refreshedAt || null } : null } : {}) }
      : { mode: "sim", wallet: null },
    treasuryLedger: t.treasury.ledger.slice(0, 60),
    volumeUsdPerHour: t.volumeUsdPerHour,
    vps: { ...pickPublic(t.vps, ["state", "phase", "mode", "streamLive", "bootStep", "bootStepAt", "updatedAt", "registeredAt", "workbenchEnabled", "reconciliationRequired"]), health, offer: publicOffer(t.vps.offer) },
    agent: { ...pickPublic(t.agent, ["wallet", "state", "lastHeartbeatAt", "firstHeartbeatAt", "currentProposalId", "lastAiError"]), ai: pickPublic(t.agent.ai, ["provider", "model", "name", "promptUsd", "completionUsd"]), farcaster: pickPublic(t.agent.farcaster, ["fid", "username", "bio", "displayName", "avatarUrl"]) }, viewers,
    epoch: { index: t.epoch.index, startedAt: new Date(t.epoch.realStartedAt || t.epoch.startedSimMs).toISOString(), chatPoolUsd: usd(t.epoch.chatPoolMicros) },
    usagePolicy: { unit: 'micro-USD', personalChat: true, personalActions: true, approvedWork: 'shared_treasury', voice: voiceStatus(t).status === 'ready' ? 'provider_account' : 'not_connected', chargeBasis: 'x402_authorized_payment', normalMaxOutputTokens: 1500, taskMaxOutputTokens: 6000, maxTaskCalls: 12, periodHours: s.settings.epochHours },
    holders, eligibleSupply: supply, curveReserve: (curveKey && t.balances[curveKey]) || 0, orderMinPct: s.settings.orderMinBps / 100,
    profiles: Object.fromEntries(Object.entries(s.profiles || {}).filter(([a]) => a in t.balances || t.messages.some((m) => m.holder === a)).map(([a, p]) => [a, p.username])),
    messages: t.messages.slice(-80).map((m) => {
      const reply = t.replies.find((r) => r.messageId === m.id), voice = reply ? voicePlayback(t, reply.id) : null;
      return { ...m, reply: reply ? { ...reply, ...(voice ? { voice } : {}) } : null };
    }),
    proposals: t.proposals.slice().reverse().map((p) => ({ ...publicProfileProposal(t,p), snapshot: undefined, voteCount: Object.keys(p.votes).length, votesSummary: voteSummary(t, p) })),
    suggestions: t.suggestions.slice(-20),
    social: { x: xAccountOf(t), usage: xUsageOf(t), profile: xProfileOf(t),
      milestone: socialMilestoneOf(t, { account: xAccountOf(t), broker: xPosts().status(), now: snapshotAtMs }),
      // What a >1 % holder may do with the account, and the limits the page enforces before signing.
      actions: { enabled: !!xAccountOf(t), minSharePct: get().settings.orderMinBps / 100, kinds: ["post", "delete", "profile", "avatar", "banner"],
        limits: { ...X_PROFILE_LIMITS, text: 280, avatarBytes: X_AVATAR_MAX_BYTES, bannerBytes: X_BANNER_MAX_BYTES }, recent: xActionsOf(t) } },
    xPosts: xPostsOf(t),
    casts: t.casts.slice(-50).reverse(),
    website: t.website,
    statusLog: t.statusLog.slice(0, 80),
    screen: s.agents[tokenKey(t.chain, t.address)]?.screen || null,
    settings: s.settings,
  };
  const safe = publicTree(result);
  safe.market = publicMarket(result.market);
  safe.treasuryLedger = publicTransactions(result.treasuryLedger);
  return safe;
}

export { canonicalize };
