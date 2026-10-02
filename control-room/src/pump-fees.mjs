// Sweeps a pump.fun-launched project's creator fee into its treasury. On the curve the fee
// sits as native SOL in pump.fun's creator vault (collect is permissionless, the treasury
// only pays the network fee); after graduation it sits as WSOL in PumpSwap's coin creator
// vault (the treasury signs, then unwraps). Every send is simulated first and journaled
// before it leaves, so a crash mid-way is resolved from the journal, never re-sent.
import { createHash } from "node:crypto";
import { get, save, event } from "./store.mjs";
import * as wallets from "./wallets.mjs";
import * as pump from "./pump.mjs";
import { RENT_EXEMPT_MIN_LAMPORTS, WSOL_MINT, TOKEN_PROGRAM, signTransaction, send, confirmBounded, checkSignature, LAMPORTS_PER_SOL } from "./solana.mjs";
import { solanaRpc, refreshSolanaTreasury } from "./solana-billing.mjs";
import { withBillingTreasury } from "./treasury-lock.mjs";

export const SWEEP_MIN_LAMPORTS = 100_000_000;        // 0.1 SOL above the vault's rent floor
export const SWEEP_FEE_RESERVE_LAMPORTS = 50_000;      // the treasury must be able to pay the network fee
export const SWEEP_COMPUTE_UNITS = 200_000;
const iso = (now) => new Date(typeof now === 'function' ? now() : now).toISOString();
export const isPumpProject = (t) => t?.chain === "solana" && t?.treasury?.mode === "wallet" && t?.launchIdentity?.kind === "pump";

function sol(lamports) { return `${(Number(lamports) / LAMPORTS_PER_SOL).toFixed(6)} SOL`; }

/// The bookkeeping of a confirmed sweep — treasury refresh, ledger row, event — done exactly
/// once, whether the confirmation arrived in the sending pass or on a later settle.
async function book(t, rec, rpc, now) {
  if (rec.booked) return;
  await refreshSolanaTreasury(t, { rpc }).catch(() => {});
  // Same row shape as every other treasury movement (billing.mjs `ledger`): micro-USD at the
  // treasury's current SOL price, the balance after, a reason, and the receipt.
  const expected = rec.expectedLamports;
  const deltaMicros = t.treasury.solUsd ? Math.round((expected / LAMPORTS_PER_SOL) * t.treasury.solUsd * 1e6) : 0;
  t.treasury.ledger.unshift({ simAt: iso(now), deltaMicros, balanceMicros: t.treasury.micros, reason: `pump.fun creator fee swept from the ${rec.kind} vault (${sol(expected)})`, signature: rec.signature, lamports: expected, kind: "creator_fee" });
  if (t.treasury.ledger.length > 400) t.treasury.ledger.length = 400;
  event("billing", `${t.symbol}: creator fee ${sol(expected)} swept into the treasury`, { token: t.address });
  rec.booked = true;
  // A pre-collection vault balance is no longer a fresh pending-fee observation.
  delete t.creatorFeeObservation;
}

/// Resolves a journaled sweep that was sent but not confirmed (restart, timeout).
async function settle(t, rec, rpc, now) {
  const v = await checkSignature(rpc, rec.signature, { lastValidBlockHeight: rec.lastValidBlockHeight });
  if (v.state === "pending") return false;
  rec.state = v.state === "confirmed" ? "confirmed" : v.state === "expired" ? "expired" : "failed";
  rec.resolvedAt = iso(now); rec.err = v.err ?? null;
  if (rec.state === "confirmed") await book(t, rec, rpc, now);
  return true;
}

// A broker-owned claim is recovered only through its original durable intent.
// The injected adapter is operator code; default null keeps this path disabled.
async function settleSponsored(t, rec, sponsor, rpc, now) {
  if (rec.state === 'confirmed' && rec.booked === true) return true;
  if (!sponsor || typeof sponsor.claim !== 'function') return false;
  const result = await sponsor.claim({ mint: t.address, treasury: t.treasury.wallet, intentId: rec.sponsorIntentId });
  if (!result || result.intentId !== rec.sponsorIntentId || result.mint !== t.address || result.treasury !== t.treasury.wallet) throw new Error('creator-fee sponsor binding changed');
  if (!['waiting','signed','submitted','uncertain','review','failed','expired','confirmed'].includes(result.state)) throw new Error('creator-fee sponsor state is invalid');
  Object.assign(rec, { sponsorCheckedAt: iso(now), sponsorState: result.state,
    sponsorMint: t.address, sponsorTreasury: t.treasury.wallet, feePayer: sponsor.feePayer,
    sponsorReason: result.reason === 'CLAIM_SPONSOR_UNFUNDED' ? result.reason : null });
  if (t.creatorFeeObservation) Object.assign(t.creatorFeeObservation, { sponsorConnected: true,
    sponsorCheckedAt: rec.sponsorCheckedAt, sponsorState: rec.sponsorState, sponsorReason: rec.sponsorReason });
  rec.detail = result.reason || null;
  if (['waiting', 'signed', 'submitted', 'uncertain', 'review'].includes(result.state)) {
    if (result.signature) rec.signature = result.signature;
    rec.state = 'uncertain';
    return false;
  }
  if (['failed', 'expired'].includes(result.state)) { rec.state = result.state; rec.resolvedAt = iso(now); return true; }
  if (result.state !== 'confirmed' || result.feePayer !== sponsor.feePayer || result.feePayer === t.treasury.wallet ||
      !Number.isSafeInteger(result.claimedLamports) || result.claimedLamports <= 0 ||
      !Number.isSafeInteger(result.networkFeeLamports) || result.networkFeeLamports < 0 || result.networkFeeLamports > 25_000 ||
      typeof result.signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(result.signature)) throw new Error('creator-fee sponsor receipt is invalid');
  const verdict = await checkSignature(rpc, result.signature, {});
  if (verdict.state !== 'confirmed') { rec.state = 'uncertain'; return false; }
  Object.assign(rec, { state: 'confirmed', signature: result.signature, feePayer: result.feePayer,
    platformNetworkFeeLamports: result.networkFeeLamports, expectedLamports: result.claimedLamports, slot: result.slot, resolvedAt: iso(now) });
  await book(t, rec, rpc, now);
  return true;
}

/// One sweep attempt for one project. Returns what happened without throwing on the
/// ordinary "nothing to do" outcomes; RPC failures propagate to the caller's loop.
export async function sweepCreatorFees(t, { rpc = solanaRpc(), signer = null, sponsor = null, now = Date.now, sleep, persist = save, minLamports = SWEEP_MIN_LAMPORTS } = {}) {
  if (!isPumpProject(t)) return { state: "skipped", reason: "not_pump" };
  if (t.lock?.state === "paused") return { state: "skipped", reason: "paused" };
  const treasury = signer || (sponsor ? { address: t.treasury.wallet } : wallets.solanaTreasurySigner(t.address));
  if (treasury.address !== t.treasury.wallet) throw new Error("treasury signer does not match the project treasury");
  const journal = (t.pumpFeeSweeps ||= {});
  const open = Object.values(journal).find((r) => r.state === "sent" || r.state === "uncertain");
  if (open) {
    const done = open.sponsorIntentId ? await settleSponsored(t, open, sponsor, rpc, now) : await settle(t, open, rpc, now);
    persist();
    if (!done) return { state: "waiting", reason: "previous_sweep_pending", signature: open.signature };
  }
  const vault = await pump.pdas.creatorVault(treasury.address);
  const vaultLamports = await rpc.getBalance(vault);
  const collectable = Math.max(0, vaultLamports - RENT_EXEMPT_MIN_LAMPORTS);
  const treasuryLamports = await rpc.getBalance(treasury.address);
  const curveInfo = await rpc.getAccountInfo(await pump.pdas.bondingCurve(t.address));
  const curve = curveInfo ? pump.decodeBondingCurve(curveInfo.data[0]) : null;
  const observe = (reason, { kind = 'curve', claimableLamports = collectable, sourceVault = vault } = {}) => {
    // Only a real Pump-owned curve can bind this public observation to the project.
    if (!curve || curveInfo?.owner !== pump.PUMP_PROGRAM) { delete t.creatorFeeObservation; return; }
    const sponsorConfigured = kind === 'curve' && typeof sponsor?.claim === 'function' &&
      /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(sponsor.feePayer || '') && sponsor.feePayer !== treasury.address;
    const recent = sponsorConfigured ? Object.values(journal).filter(r => r.sponsorMint === t.address &&
      r.sponsorTreasury === treasury.address && r.feePayer === sponsor.feePayer && Number.isFinite(Date.parse(r.sponsorCheckedAt || '')))
      .sort((a,b) => Date.parse(b.sponsorCheckedAt) - Date.parse(a.sponsorCheckedAt))[0] : null;
    t.creatorFeeObservation = { version: 1, mint: t.address, treasury: treasury.address,
      vault: sourceVault, kind, observedAt: iso(now), claimableLamports,
      treasuryLamports, thresholdLamports: minLamports, gasReserveLamports: SWEEP_FEE_RESERVE_LAMPORTS,
      creatorMatches: curve.creator === treasury.address, reason, sponsorConfigured,
      gasFunding: sponsorConfigured ? 'platform' : 'project', sponsorConnected: !!recent,
      ...(recent ? { sponsorCheckedAt: recent.sponsorCheckedAt, sponsorState: recent.sponsorState, sponsorReason: recent.sponsorReason } : {}) };
  };
  if (curve && curve.creator !== treasury.address) { observe('creator_mismatch'); return { state: "skipped", reason: "creator_mismatch" }; }
  let instructions = [], expected = 0, kind = "curve";
  let sourceVault = vault;
  if (collectable >= minLamports) {
    instructions.push(await pump.collectCreatorFeeV2({ creator: treasury.address })); expected = collectable;
  } else if (curve?.complete) {
    const { vaultAuthority } = await pump.collectCoinCreatorFee({ coinCreator: treasury.address });
    const wsolVault = await pump.pdas.ata(vaultAuthority, WSOL_MINT, TOKEN_PROGRAM);
    const wsol = await rpc.getTokenAccountBalance(wsolVault);
    if (wsol == null || wsol < minLamports) { observe('below_minimum', { kind: 'pool', claimableLamports: wsol ?? 0, sourceVault: wsolVault }); return { state: "skipped", reason: "below_minimum", vaultLamports, poolWsol: wsol ?? 0 }; }
    const ownAta = await pump.pdas.ata(treasury.address, WSOL_MINT, TOKEN_PROGRAM);
    instructions = [await pump.createAtaIdempotent({ payer: treasury.address, owner: treasury.address, mint: WSOL_MINT, tokenProgram: TOKEN_PROGRAM }), await pump.collectCoinCreatorFee({ coinCreator: treasury.address }), pump.closeTokenAccount({ account: ownAta, destination: treasury.address, owner: treasury.address })];
    expected = wsol; kind = "pool"; sourceVault = wsolVault;
  } else { observe('below_minimum'); return { state: "skipped", reason: "below_minimum", vaultLamports }; }
  observe(kind === 'curve' && sponsor ? 'ready' : treasuryLamports < SWEEP_FEE_RESERVE_LAMPORTS ? 'gas_required' : 'ready', { kind, claimableLamports: expected, sourceVault });
  if (kind === 'curve' && sponsor && typeof sponsor.claim === 'function') {
    // Optional, fixed-threshold broker hook. This file does not select a platform
    // signer, alter creator allocation, or lower the broker's authoritative gate.
    const intentId = createHash('sha256').update(JSON.stringify({ kind: 'pump-curve-fee', mint: t.address, treasury: treasury.address, vault, observedLamports: vaultLamports, at: iso(now) })).digest('hex');
    const id = `sweep:curve:sponsor:${intentId}`;
    if (journal[id]) {
      await settleSponsored(t, journal[id], sponsor, rpc, now);
      persist();
      return { state: journal[id].state, kind: 'curve', signature: journal[id].signature || null, expectedLamports: journal[id].expectedLamports, gasFunding: 'platform' };
    }
    const rec = { id, kind: 'curve', sponsorIntentId: intentId, gasFunding: 'platform', state: 'sent', sentAt: iso(now), expectedLamports: expected, booked: false };
    await withBillingTreasury(t, async () => {
      journal[id] = rec;
      try { persist(); } catch (e) { delete journal[id]; throw e; }
      await settleSponsored(t, rec, sponsor, rpc, now);
      persist();
    });
    return { state: rec.state, kind: 'curve', signature: rec.signature || null, expectedLamports: rec.expectedLamports, gasFunding: 'platform' };
  }
  if (treasuryLamports < SWEEP_FEE_RESERVE_LAMPORTS) return { state: "skipped", reason: "treasury_cannot_pay_fee", treasuryLamports };
  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash("confirmed");
  const message = pump.buildMessage({ feePayer: treasury.address, blockhash, lastValidBlockHeight, instructions, computeUnitLimit: SWEEP_COMPUTE_UNITS });
  const selfPayer = signer || (typeof treasury.sign === 'function' ? treasury : wallets.solanaTreasurySigner(t.address));
  const { wire, signature } = await signTransaction(message, selfPayer);
  const sim = await rpc.simulateTransaction(wire, { sigVerify: false, replaceRecentBlockhash: false });
  if (sim?.err) { event("billing", `${t.symbol}: creator-fee sweep simulation failed — ${JSON.stringify(sim.err).slice(0, 120)}`, { token: t.address, level: "warn" }); return { state: "failed", reason: "simulation", err: sim.err }; }
  const id = `sweep:${kind}:${signature.slice(0, 16)}`;
  // The same message (same blockhash, same accounts) signs to the same signature: a record
  // that already exists is that very transaction, so it is settled, never re-journaled.
  if (journal[id]) { const done = await settle(t, journal[id], rpc, now); persist(); return { state: done ? journal[id].state : "waiting", reason: "duplicate_signature", signature }; }
  // The send shares the treasury's mutex with every debit, so a sweep never interleaves with a
  // VPS-hour or package transfer; a busy treasury simply waits for the next pass.
  let rec;
  try {
    await withBillingTreasury(t, async () => {
      journal[id] = { id, kind, signature, lastValidBlockHeight, expectedLamports: expected, state: "sent", sentAt: iso(now), booked: false };
      observe('pending', { kind, claimableLamports: expected, sourceVault });
      persist();
      await send(rpc, wire, { signature });
      const verdict = await confirmBounded(rpc, signature, { lastValidBlockHeight, timeoutMs: 60_000, now, ...(sleep ? { sleep } : {}) });
      rec = journal[id];
      rec.state = verdict.state === "confirmed" ? "confirmed" : verdict.state === "unknown" ? "uncertain" : verdict.state;
      rec.slot = verdict.slot ?? null; rec.err = verdict.err ?? null; rec.resolvedAt = rec.state === "uncertain" ? null : iso(now);
      if (rec.state === "confirmed") await book(t, rec, rpc, now);
    });
  } catch (e) {
    if (e?.status === 409 && !journal[id]) return { state: "waiting", reason: "treasury_busy" };
    throw e;
  }
  persist();
  return { state: rec.state, kind, signature, expectedLamports: expected };
}

/// All pump-launched projects, sequentially; one project's RPC trouble never blocks the others.
export async function sweepAll(opts = {}) {
  const out = [];
  for (const t of Object.values(get().tokens)) {
    if (!isPumpProject(t)) continue;
    try { out.push({ token: t.address, ...(await sweepCreatorFees(t, opts)) }); }
    catch (e) { if (t.creatorFeeObservation) t.creatorFeeObservation.errorAt = iso(opts.now || Date.now); out.push({ token: t.address, state: "error", error: String(e.message || e).slice(0, 160) }); }
  }
  return out;
}
