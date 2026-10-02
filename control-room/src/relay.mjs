// Relay (relay.link) bridging, the way NoFee uses it: quote → verify what the quote
// says against what we asked → send the quoted transaction(s) ourselves → poll the
// status endpoint the quote named until it settles. Nothing in a Relay response is
// trusted beyond that: recipient, chains, currencies and the fee ratio are checked
// before any transaction is signed.
import { ethers } from "ethers";
import { env } from "./env.mjs";

export const RELAY_API = () => env("RELAY_API_BASE", "https://api.relay.link").replace(/\/$/, "");
const NATIVE = "0x0000000000000000000000000000000000000000";
const fail = (status, message) => Object.assign(new Error(message), { status });
const lc = (s) => String(s || "").toLowerCase();

async function relayFetch(path, init = {}) {
  const key = env("RELAY_API_KEY");
  const res = await fetch(`${RELAY_API()}${path}`, { ...init, headers: { "Content-Type": "application/json", Accept: "application/json", ...(key ? { "x-api-key": key } : {}), ...(init.headers || {}) }, signal: AbortSignal.timeout(45_000) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, json, text };
}

/// A verified quote. `amount` is in the origin currency's base units for
/// EXACT_INPUT, in the destination currency's for EXACT_OUTPUT.
export const SOLANA_CHAIN_ID = 792703809;            // Relay's chain id for Solana mainnet
export const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export function recipientFor(destinationChainId, recipient) {
  if (Number(destinationChainId) === SOLANA_CHAIN_ID) {
    if (!SOLANA_ADDRESS.test(String(recipient || ""))) throw fail(400, "a base58 Solana recipient is required");
    return String(recipient);
  }
  return ethers.getAddress(recipient);
}
/// Relay's deposit receiver on the origin chain (RelayReceiver.forward, selector 0x49290c1c,
/// observed live for Robinhood 4663 → Solana and → Base on 2026-09-21). The treasury signer
/// only ever executes quote steps whose `to` is one of these contracts and whose value is
/// the native deposit: a compromised or spoofed quote cannot make it call a token contract.
export const RELAY_RECEIVERS = () => new Set(env("RELAY_RECEIVERS", "0x4cd00e387622c35bddb9b4c962c136462338bc31").split(",").map((a) => a.trim().toLowerCase()).filter(Boolean));
export function assertNativeDepositSteps(txs, receivers = RELAY_RECEIVERS()) {
  if (!Array.isArray(txs) || !txs.length) throw fail(502, "Relay quote contains no transaction");
  for (const tx of txs) {
    if (!receivers.has(String(tx.to || "").toLowerCase())) throw fail(502, `Relay step targets an unknown contract ${String(tx.to).slice(0, 12)}…; only the Relay receiver is allowed`);
    if (!(BigInt(tx.value || 0) > 0n)) throw fail(502, "Relay step carries no native deposit");
  }
}
export async function quote({ user, recipient, originChainId, originCurrency = NATIVE, destinationChainId, destinationCurrency, amount, tradeType = "EXACT_INPUT", maxFeeRatio = 0.06 }) {
  // refundTo: without it Relay disables automatic refunds on the origin chain (docs);
  // a failed bridge must always refund the treasury that paid, never disappear.
  const body = { user: ethers.getAddress(user), recipient: recipientFor(destinationChainId, recipient), refundTo: ethers.getAddress(user), originChainId, destinationChainId, originCurrency, destinationCurrency, amount: String(amount), tradeType };
  const r = await relayFetch("/quote/v2", { method: "POST", body: JSON.stringify(body) });
  if (r.status !== 200 || !r.json?.steps) throw fail(502, `Relay quote failed (${r.status}): ${(r.json?.message || r.text).slice(0, 160)}`);
  const q = r.json;
  const det = q.details || {};
  if (Number(det.currencyIn?.currency?.chainId) !== originChainId || lc(det.currencyIn?.currency?.address) !== lc(originCurrency)) throw fail(502, "Relay quote origin does not match the request");
  if (Number(det.currencyOut?.currency?.chainId) !== destinationChainId || lc(det.currencyOut?.currency?.address) !== lc(destinationCurrency)) throw fail(502, "Relay quote destination does not match the request");
  if (lc(det.recipient) !== lc(recipient)) throw fail(502, "Relay quote recipient changed");
  const inUsd = Number(det.currencyIn?.amountUsd || 0), outUsd = Number(det.currencyOut?.amountUsd || 0);
  if (!(inUsd > 0) || !(outUsd > 0)) throw fail(502, "Relay quote carries no USD values");
  if (inUsd >= 1 && (inUsd - outUsd) / inUsd > maxFeeRatio) throw fail(502, `Relay fees too high: $${inUsd.toFixed(4)} in → $${outUsd.toFixed(4)} out`);
  const txs = [];
  let check = null, requestId = null;
  for (const step of q.steps) {
    if (step.kind !== "transaction") throw fail(502, `unsupported Relay step kind ${step.kind}`);
    for (const item of step.items || []) {
      const d = item.data || {};
      if (Number(d.chainId) !== originChainId) throw fail(502, "Relay step is on another chain");
      txs.push({ to: ethers.getAddress(d.to), data: d.data || "0x", value: BigInt(d.value || 0), chainId: originChainId, gas: d.gas ? BigInt(d.gas) : undefined, stepId: step.id });
      if (item.check?.endpoint) { check = item.check.endpoint; requestId = step.requestId || null; }
    }
  }
  if (!txs.length) throw fail(502, "Relay quote contains no transaction");
  if (originCurrency === NATIVE) assertNativeDepositSteps(txs);
  if (!check || !/^\/intents\/status\/v[23]\?requestId=0x[0-9a-fA-F]{64}$/.test(check)) throw fail(502, "Relay quote has no usable status endpoint");
  return {
    requestId: requestId || check.split("requestId=")[1], check, txs,
    inAmount: det.currencyIn?.amount, inFormatted: det.currencyIn?.amountFormatted, inUsd, outAmount: det.currencyOut?.amount, outFormatted: det.currencyOut?.amountFormatted, outUsd,
    feesUsd: { gas: Number(q.fees?.gas?.amountUsd || 0), relayer: Number(q.fees?.relayer?.amountUsd || 0) }, etaSeconds: Number(det.timeEstimate || 0), symbolOut: det.currencyOut?.currency?.symbol,
  };
}

/// Sends the quoted transactions in order with `signer` (an ethers Wallet on the
/// origin chain). Returns the hashes.
export async function execute(signer, q) {
  const hashes = [];
  for (const tx of q.txs) {
    const sent = await signer.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, ...(tx.gas ? { gasLimit: tx.gas } : {}) });
    const rc = await sent.wait();
    if (!rc || rc.status !== 1) throw fail(502, `Relay ${tx.stepId} transaction reverted (${sent.hash})`);
    hashes.push(sent.hash);
  }
  return hashes;
}

/// Polls the status endpoint from the quote. Terminal: success | failure | refund.
export async function status(check) {
  const r = await relayFetch(check, { method: "GET" });
  if (r.status !== 200 || !r.json) throw fail(502, `Relay status failed (${r.status})`);
  return { status: String(r.json.status || "unknown"), txHashes: r.json.txHashes || [], inTxHashes: r.json.inTxHashes || [], details: r.json.details || null };
}

export async function waitSettled(check, { timeoutMs = 10 * 60_000, everyMs = 4_000 } = {}) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    try { last = await status(check); } catch (e) { last = { status: "unknown", error: e.message }; }
    if (["success", "failure", "refund"].includes(last.status)) return last;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return { ...(last || {}), status: "timeout" };
}

/// USD per 1 native unit on a chain, from a tiny Relay quote (cached 5 min).
const priceCache = new Map();
export async function nativeUsd(chainId, usdcOn = { chainId: 8453, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, probe = "0x000000000000000000000000000000000000dEaD", maxAgeMs=300_000) {
  const c = priceCache.get(chainId);
  if (c && Date.now() - c.at < maxAgeMs) return c.usd;
  const r = await relayFetch("/quote/v2", { method: "POST", body: JSON.stringify({ user: probe, recipient: probe, originChainId: chainId, destinationChainId: usdcOn.chainId, originCurrency: NATIVE, destinationCurrency: usdcOn.address, amount: "1000000000000000", tradeType: "EXACT_INPUT" }) });
  const usdPerMilli = Number(r.json?.details?.currencyIn?.amountUsd || 0);
  if (!(usdPerMilli > 0)) throw fail(502, "could not price the native currency");
  const usd = usdPerMilli * 1000;
  priceCache.set(chainId, { at: Date.now(), usd });
  return usd;
}

// ── Solana → Base USDC (a Solana project's AI pocket) ────────────────────────────────────
// Relay answers with the Solana instructions the treasury must sign (its own deposit program,
// one signer, an address lookup table) plus a status endpoint. Nothing is trusted beyond what
// we asked for: origin, destination, recipient, input amount, USD values, the fee ratio, the
// programs touched and that the treasury is the only signer.
export const SOLANA_NATIVE = "11111111111111111111111111111111";
export const RELAY_SOLANA_PROGRAMS = () => new Set(env("RELAY_SOLANA_PROGRAMS", "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2").split(",").map((a) => a.trim()).filter(Boolean));
// Besides Relay's own deposit program only these may appear, each in one harmless shape: a compute
// budget instruction, a memo, an associated-token-account create (rent bounded by the SOL delta) and
// a System transfer (bounded by the SOL delta). The Token program is never allowed directly — an
// appended Approve / SetAuthority would pass a balance simulation yet hand the account away.
const SYSTEM_PROGRAM = "11111111111111111111111111111111", COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111", ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const SOLANA_COMMON_PROGRAMS = [SYSTEM_PROGRAM, COMPUTE_BUDGET, ATA_PROGRAM, MEMO_PROGRAM];
function assertCommonShape(programId, data, accounts, user) {
  if (programId === SYSTEM_PROGRAM) {
    // System::Transfer = u32 LE 2 + u64 lamports (12 bytes); nothing else (Assign/Allocate/CreateAccount) may touch the treasury.
    if (data.length !== 12 || data[0] !== 2 || data[1] !== 0 || data[2] !== 0 || data[3] !== 0) throw fail(502, "Relay step carries a System instruction other than a transfer");
  } else if (programId === ATA_PROGRAM) {
    if (data.length > 1 || (data.length === 1 && data[0] !== 1)) throw fail(502, "Relay step carries an unexpected associated-token instruction");
  } else if (programId === COMPUTE_BUDGET) {
    if (accounts.length) throw fail(502, "compute budget instructions take no accounts");
  }
}
/// Relay serialises instruction data as hex (observed 2026-09-22); base64 and byte arrays are accepted too.
export function decodeInstructionData(data) {
  if (Array.isArray(data)) return Uint8Array.from(data.map((n) => { if (!Number.isInteger(n) || n < 0 || n > 255) throw fail(502, "Relay instruction data byte out of range"); return n; }));
  const s = String(data ?? "");
  if (!s) return new Uint8Array();
  const hex = s.replace(/^0x/, "");
  if (/^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0) return Uint8Array.from(Buffer.from(hex, "hex"));
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(s) && s.length % 4 === 0) return Uint8Array.from(Buffer.from(s, "base64"));
  throw fail(502, "Relay instruction data is not hex or base64");
}
export async function quoteSolanaToBase({ user, recipient, originCurrency = "SOL", amount, maxFeeRatio = 0.06, destinationCurrency = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }) {
  if (!SOLANA_ADDRESS.test(String(user || ""))) throw fail(400, "a base58 Solana treasury is required");
  const origin = originCurrency === "USDC" ? SOLANA_USDC : originCurrency === "SOL" ? SOLANA_NATIVE : null;
  if (!origin) throw fail(400, "origin currency must be SOL or USDC");
  if (!/^\d+$/.test(String(amount)) || BigInt(amount) <= 0n) throw fail(400, "amount must be a positive integer in base units");
  const to = ethers.getAddress(recipient);
  const body = { user, recipient: to, refundTo: user, originChainId: SOLANA_CHAIN_ID, destinationChainId: 8453, originCurrency: origin, destinationCurrency, amount: String(amount), tradeType: "EXACT_INPUT" };
  const r = await relayFetch("/quote/v2", { method: "POST", body: JSON.stringify(body) });
  if (r.status !== 200 || !r.json?.steps) throw fail(502, `Relay quote failed (${r.status}): ${(r.json?.message || r.text).slice(0, 160)}`);
  const q = r.json, det = q.details || {};
  if (Number(det.currencyIn?.currency?.chainId) !== SOLANA_CHAIN_ID || det.currencyIn?.currency?.address !== origin) throw fail(502, "Relay quote origin does not match the request");
  if (Number(det.currencyOut?.currency?.chainId) !== 8453 || lc(det.currencyOut?.currency?.address) !== lc(destinationCurrency)) throw fail(502, "Relay quote destination does not match the request");
  if (lc(det.recipient) !== lc(to)) throw fail(502, "Relay quote recipient changed");
  if (String(det.currencyIn?.amount) !== String(amount)) throw fail(502, "Relay quote input amount changed");
  const inUsd = Number(det.currencyIn?.amountUsd || 0), outUsd = Number(det.currencyOut?.amountUsd || 0);
  if (!(inUsd > 0) || !(outUsd > 0)) throw fail(502, "Relay quote carries no USD values");
  if (inUsd >= 1 && (inUsd - outUsd) / inUsd > maxFeeRatio) throw fail(502, `Relay fees too high: $${inUsd.toFixed(4)} in → $${outUsd.toFixed(4)} out`);
  if (!Array.isArray(q.steps) || q.steps.length !== 1 || q.steps[0].kind !== "transaction" || (q.steps[0].items || []).length !== 1) throw fail(502, "Relay quote is not a single Solana deposit step");
  const step = q.steps[0], item = step.items[0], d = item.data || {};
  if (!Array.isArray(d.instructions) || !d.instructions.length || d.instructions.length > 6) throw fail(502, "Relay step carries no usable Solana instructions");
  const allowed = new Set([...RELAY_SOLANA_PROGRAMS(), ...SOLANA_COMMON_PROGRAMS]);
  let relayProgramSeen = false, treasurySignsDeposit = false;
  const instructions = d.instructions.map((ix) => {
    if (!SOLANA_ADDRESS.test(String(ix.programId || ""))) throw fail(502, "Relay instruction has no program");
    if (!allowed.has(ix.programId)) throw fail(502, `Relay instruction targets an unknown program ${String(ix.programId).slice(0, 12)}…`);
    if (RELAY_SOLANA_PROGRAMS().has(ix.programId)) relayProgramSeen = true;
    const data = decodeInstructionData(ix.data);
    const accounts = (ix.keys || []).map((k) => {
      if (!SOLANA_ADDRESS.test(String(k.pubkey || ""))) throw fail(502, "Relay instruction key is not an address");
      if (k.isSigner && k.pubkey !== user) throw fail(502, "Relay instruction expects a signer other than the treasury");
      return { address: String(k.pubkey), role: (k.isSigner ? 2 : 0) | (k.isWritable ? 1 : 0) };
    });
    assertCommonShape(String(ix.programId), data, accounts, user);
    if (RELAY_SOLANA_PROGRAMS().has(ix.programId) && accounts.some((a) => a.address === user && (a.role & 2))) treasurySignsDeposit = true;
    return { programAddress: String(ix.programId), accounts, data };
  });
  if (!relayProgramSeen) throw fail(502, "Relay step never calls the Relay deposit program");
  if (!treasurySignsDeposit) throw fail(502, "the treasury does not sign the Relay deposit instruction");
  const lookupTables = (d.addressLookupTableAddresses || []).map((a) => { if (!SOLANA_ADDRESS.test(String(a || ""))) throw fail(502, "Relay lookup table is not an address"); return String(a); });
  if (lookupTables.length > 4) throw fail(502, "Relay step uses too many lookup tables");
  const check = item.check?.endpoint;
  if (!check || !/^\/intents\/status\/v[23]\?requestId=0x[0-9a-fA-F]{64}$/.test(check)) throw fail(502, "Relay quote has no usable status endpoint");
  const checkId = check.split("requestId=")[1];
  if (step.requestId && lc(step.requestId) !== lc(checkId)) throw fail(502, "Relay step id and status endpoint disagree");
  const outMicros = Number(det.currencyOut?.amount);
  if (!Number.isSafeInteger(outMicros) || outMicros <= 0) throw fail(502, "Relay quote carries no output amount");
  return { requestId: checkId.toLowerCase(), check, instructions, lookupTables, origin: originCurrency,
    inAmount: String(det.currencyIn.amount), inFormatted: det.currencyIn.amountFormatted, inUsd, outMicros, outFormatted: det.currencyOut.amountFormatted, outUsd,
    feesUsd: { gas: Number(q.fees?.gas?.amountUsd || 0), relayer: Number(q.fees?.relayer?.amountUsd || 0) }, etaSeconds: Number(det.timeEstimate || 0) };
}
