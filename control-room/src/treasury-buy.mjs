// Creator-ordered treasury buys (owner 2026-10-02: "ben devim, 100 dolarlık al deyince alsın"). The project's
// creator wallet — verified by the signed chat session — orders a market buy of the project's own token from
// its treasury. The gateway quotes and builds the swap through Jupiter (routes pump.fun curves and PumpSwap
// pools alike), signs with the treasury key it already holds for fee sweeps, sends, confirms and verifies
// the receipt on chain. Bounded: a floor and a cap per order, a share-of-treasury cap, one order in flight,
// never the same chat message twice. No model is involved in the decision.
import { createHash } from "node:crypto";
import { save, saveDurable, event } from "./store.mjs";
import * as wallets from "./wallets.mjs";
import { solanaRpc, refreshSolanaTreasury } from "./solana-billing.mjs";
import { WSOL_MINT, LAMPORTS_PER_SOL, TREASURY_SOL_RESERVE_LAMPORTS, base58Encode, confirmBounded, isSolanaAddress, signTransaction } from "./solana.mjs";
import * as pump from "./pump.mjs";
import { AccountRole } from "@solana/instructions";

export const BUY_MIN_USD = 5, BUY_MAX_USD = 1_000, BUY_MAX_TREASURY_SHARE = 0.2, BUY_SLIPPAGE_BPS = 300, BUY_MAX_PRIORITY_LAMPORTS = 2_000_000;
const JUP = "https://lite-api.jup.ag/swap/v1";
const fail = (status, message) => Object.assign(new Error(message), { status });

/// "buy $100", "buy 100$", "buy 100 dollars of our coin", "100 dolarlık al", "buy 0.5 sol" → {usd} | {sol} | null.
export function parseBuyIntent(text) {
  const raw = String(text || "").replace(/^\s*@kurt[,:]?\s*/i, "").trim(), low = raw.toLowerCase();
  if (!/\b(buy|purchase|al|alım|satın)\b/.test(low) || /\?\s*$/.test(low) || /\b(don'?t|do not|never|should i|can i|could i)\b/.test(low)) return null;
  if (/\b(sell|sat)\b/.test(low)) return null;
  const burn = /\b(burn|yak)\b/.test(low);                       // "buy 3 sol … and burn it"
  const sol = low.match(/(\d+(?:[.,]\d+)?)\s*sol(?:ana)?\b/);
  if (sol) return { sol: Number(sol[1].replace(",", ".")), burn };
  const usd = low.match(/\$\s*(\d+(?:[.,]\d+)?)|(\d+(?:[.,]\d+)?)\s*(?:\$|usd|dollars?|bucks|dolar(?:lık|lik)?)/);
  if (usd) return { usd: Number((usd[1] || usd[2]).replace(",", ".")), burn };
  return null;
}

export const isProjectCreator = (t, holder) => typeof t?.creator === "string" && t.creator === String(holder);

/// Decodes a base64 v0/legacy transaction, signs its message as the single fee-payer signer and returns the wire.
async function signSerialized(base64, signer) {
  const bytes = Buffer.from(base64, "base64");
  // compact-u16 signature count (always < 128 here), then 64-byte signature slots, then the message
  const count = bytes[0];
  if (count !== 1) throw fail(502, `swap transaction expects ${count} signatures; the treasury signs alone`);
  const message = bytes.subarray(1 + 64 * count);
  const sig = Uint8Array.from(await signer.sign(Uint8Array.from(message)));
  if (sig.length !== 64) throw fail(500, "treasury signature is not 64 bytes");
  const wire = Buffer.concat([bytes.subarray(0, 1), Buffer.from(sig), message]);
  return { wire: wire.toString("base64"), signature: base58Encode(sig) };
}
async function jup(path, init) {
  const r = await fetch(`${JUP}${path}`, { ...init, headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}) }, signal: AbortSignal.timeout(20_000) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw fail(502, `Jupiter ${path.split("?")[0]} → ${r.status}: ${String(j?.error || j?.message || "").slice(0, 120)}`);
  return j;
}
function tokenDelta(meta, owner, mint) {
  const sum = (rows) => (rows || []).filter((b) => b.owner === owner && b.mint === mint).reduce((n, b) => n + Number(b.uiTokenAmount?.uiAmount || 0), 0);
  return sum(meta?.postTokenBalances) - sum(meta?.preTokenBalances);
}

/// Executes one creator-ordered buy. `dryRun` quotes, builds, signs and simulates but never sends.
export async function treasuryBuy(t, m, amount, { dryRun = false, rpc = solanaRpc(), now = Date.now } = {}) {
  if (t.chain !== "solana" || t.treasury?.mode !== "wallet" || !isSolanaAddress(t.treasury?.wallet)) throw fail(400, "treasury buys run on Solana wallet projects only");
  if (!isProjectCreator(t, m.holder)) throw fail(403, "only the project creator's wallet can order treasury buys");
  const journal = (t.treasuryBuys ||= {});
  const prior = journal[m.id];
  if (prior) return { ...prior, duplicate: true };
  if (Object.values(journal).some((r) => r.state === "sent")) throw fail(409, "a treasury buy is still confirming; try again in a minute");
  await refreshSolanaTreasury(t, { rpc }).catch(() => {});
  const solUsd = Number(t.treasury.solUsd);
  if (!(solUsd > 0)) throw fail(503, "SOL price unavailable right now");
  const usd = amount.usd != null ? Number(amount.usd) : Number(amount.sol) * solUsd;
  if (!(usd >= BUY_MIN_USD)) throw fail(400, `the minimum treasury buy is $${BUY_MIN_USD}`);
  if (usd > BUY_MAX_USD) throw fail(400, `the maximum per order is $${BUY_MAX_USD}; split larger buys`);
  const spendableLamports = Math.max(0, (t.treasury.solLamports || 0) - TREASURY_SOL_RESERVE_LAMPORTS - 10_000_000);
  const lamports = Math.round((usd / solUsd) * LAMPORTS_PER_SOL);
  if (lamports > spendableLamports * BUY_MAX_TREASURY_SHARE) throw fail(400, `one order may use at most ${BUY_MAX_TREASURY_SHARE * 100}% of the treasury's SOL ($${((spendableLamports * BUY_MAX_TREASURY_SHARE / LAMPORTS_PER_SOL) * solUsd).toFixed(0)} now)`);
  const signer = wallets.solanaTreasurySigner(t.address);
  if (signer.address !== t.treasury.wallet) throw fail(500, "treasury signer does not match the project treasury");
  const quote = await jup(`/quote?inputMint=${WSOL_MINT}&outputMint=${t.address}&amount=${lamports}&slippageBps=${BUY_SLIPPAGE_BPS}&restrictIntermediateTokens=true`);
  if (quote?.outputMint !== t.address || !/^\d+$/.test(String(quote.outAmount || ""))) throw fail(502, "Jupiter returned no route for this token");
  const built = await jup("/swap", { method: "POST", body: JSON.stringify({ quoteResponse: quote, userPublicKey: signer.address, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: BUY_MAX_PRIORITY_LAMPORTS, priorityLevel: "high" } } }) });
  if (typeof built?.swapTransaction !== "string" || !Number.isSafeInteger(Number(built.lastValidBlockHeight))) throw fail(502, "Jupiter returned no swap transaction");
  const { wire, signature } = await signSerialized(built.swapTransaction, signer);
  const sim = await rpc.simulateTransaction(wire, { sigVerify: true, replaceRecentBlockhash: false });
  if (sim?.err) throw fail(502, `swap simulation failed: ${JSON.stringify(sim.err).slice(0, 120)}`);
  const expectedTokens = Number(quote.outAmount) / 1e6, priceImpactPct = Number(quote.priceImpactPct) || 0;
  if (dryRun) return { dryRun: true, usd, lamports, expectedTokens, priceImpactPct, route: (quote.routePlan || []).map((r) => r.swapInfo?.label).join(" → "), signature, unitsConsumed: sim?.unitsConsumed ?? null };
  const rec = { id: m.id, messageId: m.id, holder: m.holder, usd: Number(usd.toFixed(2)), lamports, expectedTokens, priceImpactPct, signature, lastValidBlockHeight: Number(built.lastValidBlockHeight), state: "sent", sentAt: new Date(now()).toISOString() };
  journal[m.id] = rec; saveDurable();                                  // durable BEFORE the broadcast: a crash never resends
  try { await rpc.sendTransaction(wire, { skipPreflight: false, maxRetries: 2, preflightCommitment: "confirmed" }); }
  catch (e) { rec.state = "failed"; rec.error = String(e?.message || e).slice(0, 160); save(); throw fail(502, `swap not sent: ${rec.error}`); }
  const verdict = await confirmBounded(rpc, signature, { lastValidBlockHeight: rec.lastValidBlockHeight, timeoutMs: 75_000, now });
  if (verdict.state !== "confirmed") { rec.state = verdict.state === "failed" || verdict.state === "expired" ? verdict.state : "uncertain"; rec.verdict = verdict.state; save(); throw fail(502, `swap ${rec.state}: ${verdict.err ? JSON.stringify(verdict.err).slice(0, 100) : "not confirmed in time"}`); }
  let tokens = null;
  try { const tx = await rpc.getTransaction(signature, { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }); tokens = tokenDelta(tx?.meta, t.treasury.wallet, t.address); } catch { /* the receipt read is best effort; the signature is confirmed */ }
  Object.assign(rec, { state: "confirmed", confirmedAt: new Date(now()).toISOString(), tokens });
  if (amount.burn) { rec.burn = { state: "pending" }; save(); try { rec.burn = await burnTokens(t, signer, tokens, rpc, now); } catch (e) { rec.burn = { state: "failed", error: String(e?.message || e).slice(0, 160) }; } }
  await refreshSolanaTreasury(t, { rpc }).catch(() => {});
  t.treasury.ledger.unshift({ simAt: new Date(now()).toISOString(), deltaMicros: -Math.round(usd * 1e6), balanceMicros: t.treasury.micros, reason: `Treasury buy ordered by the creator: $${usd.toFixed(2)} → ${tokens != null ? tokens.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "~" + expectedTokens.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${t.symbol} (Jupiter)`, signature, lamports, treasuryBuyId: rec.id });
  if (t.treasury.ledger.length > 400) t.treasury.ledger.length = 400;
  event("billing", `${t.symbol}: treasury bought ${tokens != null ? tokens.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "~" + expectedTokens.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${t.symbol} for $${usd.toFixed(2)} on the creator's order (${signature.slice(0, 12)}…)`, { token: t.address });
  save();
  return rec;
}
/// Burns `tokens` (ui amount) of the project token from the treasury's own token account (SPL / Token-2022
/// Burn, instruction 8). The treasury signs; the supply drops on chain; nothing leaves to anyone.
async function burnTokens(t, signer, tokens, rpc, now) {
  const decimals = Number.isInteger(t.onchain?.decimals) ? t.onchain.decimals : 6, tokenProgram = t.onchain?.tokenProgram || "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  if (!(tokens > 0)) throw fail(502, "the buy receipt shows no tokens to burn");
  const ata = await pump.pdas.ata(signer.address, t.address, tokenProgram);
  const raw = BigInt(Math.floor(tokens * 10 ** decimals));
  const data = Buffer.alloc(9); data[0] = 8; data.writeBigUInt64LE(raw, 1);
  const burn = { programAddress: tokenProgram, accounts: [{ address: ata, role: AccountRole.WRITABLE }, { address: t.address, role: AccountRole.WRITABLE }, { address: signer.address, role: AccountRole.READONLY_SIGNER }], data: Uint8Array.from(data) };
  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash("confirmed");
  const message = pump.buildMessage({ feePayer: signer.address, blockhash, lastValidBlockHeight, instructions: [burn], computeUnitLimit: 60_000 });
  const { wire, signature } = await signTransaction(message, signer);
  const sim = await rpc.simulateTransaction(wire, { sigVerify: true, replaceRecentBlockhash: false });
  if (sim?.err) throw fail(502, `burn simulation failed: ${JSON.stringify(sim.err).slice(0, 120)}`);
  const rec = { state: "sent", signature, tokens, raw: raw.toString(), sentAt: new Date(now()).toISOString() };
  await rpc.sendTransaction(wire, { skipPreflight: false, maxRetries: 2, preflightCommitment: "confirmed" });
  const verdict = await confirmBounded(rpc, signature, { lastValidBlockHeight, timeoutMs: 75_000, now });
  if (verdict.state !== "confirmed") throw fail(502, `burn ${verdict.state}: ${verdict.err ? JSON.stringify(verdict.err).slice(0, 100) : "not confirmed in time"}`);
  rec.state = "confirmed"; rec.confirmedAt = new Date(now()).toISOString();
  t.treasury.ledger.unshift({ simAt: rec.confirmedAt, deltaMicros: 0, balanceMicros: t.treasury.micros, reason: `Burned ${tokens.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${t.symbol} from the treasury on the creator's order`, signature });
  event("billing", `${t.symbol}: burned ${tokens.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${t.symbol} from the treasury on the creator's order (${signature.slice(0, 12)}…)`, { token: t.address });
  return rec;
}
export const _test = { signSerialized, tokenDelta, burnTokens };
