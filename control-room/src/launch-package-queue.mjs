// One controller writer, five independent project jobs. No provider or signer is
// connected by default. The injected adapter is trusted operator code, never an
// AI tool, request body or token metadata. It must provide dedicated project
// funding, decoded/simulated signing, and independently verified settlement.
import { createHash } from 'node:crypto';
import { hasLaunchPackage, isPackageFunded, markPackageFunded, dexAllocationWaived, packageTerms, isStagedLaunch, launchProjectKey, launchTreasuryKey } from './launch-package.mjs';

import { heldUsage } from './usage-budget.mjs';
import { stageFundingOf } from './startup-stages.mjs';
const active = new Set(), payers = new Set();
// A timeout does not prove the remote call stopped. Keep its capacity slot and
// project lock until the underlying transport actually settles, even if it
// ignores AbortSignal. The persisted attempt independently prevents replay.
const externalCalls = new Map();
const occupied = () => new Set([...active, ...externalCalls.keys()]).size;
const LIMIT = 5;
const idOk = s => typeof s === 'string' && /^[a-zA-Z0-9:_-]{1,180}$/.test(s);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const keyOf = launchProjectKey;
const bindingOf = t => hash({ policy: isStagedLaunch(t) ? packageTerms(t) : t.launchPackage, token: keyOf(t),
  treasury: launchTreasuryKey(t), launchTx: t.onchain?.launchTx || null });
const interrupted = new Set(['preparing', 'payment_pending', 'submitted', 'reconciliation_required']);
const RETRY_MS = 5 * 60_000, PUBLICATION_CHECK_MS = 10 * 60_000;
// Operator-facing detail: a short code or message, never a URL (RPC keys) and never long.
const clip = value => typeof value === 'string' && value.trim() ? value.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 200) || null : null;
const errorDetail = e => clip(typeof e?.code === 'string' && e.code ? e.code : e?.message);

export function createLaunchPackageQueue({ tokens, persist, adapter = null, now = Date.now, timeoutMs = 30_000 } = {}) {
  if (typeof tokens !== 'function' || typeof persist !== 'function') throw new Error('A single-writer durable store is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Invalid provider deadline');
  // Synchronous persistence is deliberate: no other job can save half of a
  // reservation during a yielded write. Multi-process use needs a DB/outbox.
  function durable(t, mutate) {
    const upgradeBefore = structuredClone(t.launchPackageUpgrade);
    const before = t.launchPackageRun == null ? null : structuredClone(t.launchPackageRun);
    const ledgerBefore = t.treasury.ledger == null ? null : structuredClone(t.treasury.ledger);
    try {
      if (mutate() === false) return;
      const result = persist();
      if (result?.then) throw new Error('Async persistence is not supported by this single-writer queue');
    } catch (e) {
      if (upgradeBefore === undefined) delete t.launchPackageUpgrade; else t.launchPackageUpgrade = upgradeBefore;
      if (before == null) delete t.launchPackageRun; else t.launchPackageRun = before;
      if (ledgerBefore == null) delete t.treasury.ledger; else t.treasury.ledger = ledgerBefore;
      throw Object.assign(new Error('Launch package state could not be saved'), { code: 'package_persistence_failed' });
    }
  }
  function update(t, patch) {
    durable(t, () => { t.launchPackageRun.dex = { ...t.launchPackageRun.dex, ...patch, updatedAt: new Date(now()).toISOString() }; });
  }
  function unchanged(t, binding) {
    if (!tokens().includes(t) || !hasLaunchPackage(t) || !isPackageFunded(t) || bindingOf(t) !== binding)
      throw new Error('Project payment binding changed');
  }
  async function bounded(fn, input, t) {
    const controller = new AbortController();
    const key = keyOf(t);
    if (externalCalls.has(key)) throw new Error('A previous provider call is still outstanding');
    externalCalls.set(key, String(t.treasury.wallet).toLowerCase());
    const operation = Promise.resolve().then(() => fn({ ...input, signal: controller.signal }));
    operation.then(() => externalCalls.delete(key), () => externalCalls.delete(key));
    let timer;
    try {
      return await Promise.race([
        operation,
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Provider result is uncertain')); }, timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  const snapshot = t => structuredClone(t.launchPackageRun.dex);
  function orderValid(t, o) {
    return o && idOk(o.orderId) && /^[a-f0-9]{24}$/.test(o.paylinkId || '') &&
      o.targetChain === t.chain && (isStagedLaunch(t) && t.chain === 'solana' ? o.targetTokenAddress === t.address : String(o.targetTokenAddress).toLowerCase() === String(t.address).toLowerCase()) &&
      o.paymentChain === 'solana' && o.amountMicros === 299_000_000;
  }
  const safeOrder = order => Object.fromEntries(['orderId','paylinkId','targetChain','targetTokenAddress','paymentChain','amountMicros'].map(k => [k, order[k]]));
  function committedPayment(t, d) {
    if (!record(d) || d.terminal === true || !orderValid(t, d.order)) return false;
    // A previously verified payment only checks publication and accounting. It
    // cannot enter the adapter's bridge/payment path, including legacy receipts.
    if (d.paymentVerified === true) return idOk(d.paymentReference) &&
      Number.isSafeInteger(d.actualMicros) && d.actualMicros >= d.order.amountMicros && d.actualMicros <= packageTerms(t).dexBudgetMicros;
    // Failure to waive a record is NOT payment authority. An unverified job
    // needs both its durable dispatch attempt and the matching money movement.
    if (!['payment_pending', 'submitted', 'reconciliation_required', 'prepared'].includes(d.state) ||
        !Number.isSafeInteger(d.attempt) || d.attempt < 1 || !record(t.packageBridgeReservations)) return false;
    const prefix = `package-dex-bridge:${d.id}:a`, rows = Object.entries(t.packageBridgeReservations);
    if (rows.some(([id, row]) => !record(row) || row.id !== id)) return false;
    const refunded = rows.filter(([id, row]) => id.startsWith(prefix) && row.state === 'refunded').length;
    const id = prefix + (refunded + 1), r = t.packageBridgeReservations[id];
    if (!record(r) || r.version !== 1 || !['submitted', 'uncertain', 'settled'].includes(r.state) ||
        r.limitMicros !== packageTerms(t).dexBudgetMicros || !timestamp(r.submittedAt)) return false;
    if (t.treasury.chain === 'solana') return r.chain === 'solana' &&
      /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.recipient || '') && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(r.signature || '');
    return record(r.binding) && r.binding.token === String(t.address).toLowerCase() &&
      r.binding.treasury === String(t.treasury.wallet).toLowerCase() && r.binding.micros === packageTerms(t).dexBudgetMicros &&
      r.binding.reason === 'DEX Screener listing allocation' && /^0x[a-fA-F0-9]{64}$/.test(r.requestId || '') &&
      Array.isArray(r.txs) && r.txs.every(tx => /^0x[a-fA-F0-9]{64}$/.test(tx));
  }
  function verifiedReturnedAllocation(t,d) {
    if (!isStagedLaunch(t) || t.treasury.chain === 'solana' || d.paymentVerified || d.terminal || !orderValid(t,d.order) || !(d.attempt>=1)) return false;
    const prefix=`package-dex-bridge:${d.id}:a`,rows=Object.entries(t.packageBridgeReservations||{}).filter(([id])=>id.startsWith(prefix));
    return rows.length>0 && rows.length<3 && rows.every(([id,r],index)=>record(r)&&r.version===1&&r.id===id&&
      id===prefix+(index+1)&&r.state==='refunded'&&['refund','failure'].includes(r.relayStatus)&&timestamp(r.refundedAt)&&
      timestamp(r.submittedAt)&&r.limitMicros===packageTerms(t).dexBudgetMicros&&record(r.binding)&&
      r.binding.token===String(t.address).toLowerCase()&&r.binding.treasury===String(t.treasury.wallet).toLowerCase()&&
      r.binding.micros===packageTerms(t).dexBudgetMicros&&r.binding.reason==='DEX Screener listing allocation'&&
      /^0x[a-fA-F0-9]{64}$/.test(r.requestId||'')&&Array.isArray(r.txs)&&r.txs.length>0&&r.txs.every(tx=>/^0x[a-fA-F0-9]{64}$/.test(tx)));
  }
  // Non-final adapter results only refresh operator visibility (bridge state, detail,
  // the durable pay-attempt counter); they never change an attempt on their own.
  function progress(d, result) {
    const patch = {};
    if (typeof result.bridgeState === 'string' && /^[a-z_]{1,40}$/.test(result.bridgeState) && result.bridgeState !== (d.bridgeState ?? null)) patch.bridgeState = result.bridgeState;
    const detail = clip(result.reason);
    if (detail !== (d.detail ?? null)) patch.detail = detail;
    if (Number.isSafeInteger(result.payAttempt) && result.payAttempt >= 1 && result.payAttempt <= 3 && result.payAttempt !== (d.payAttempt ?? 1)) {
      patch.payAttempt = result.payAttempt;
      if (result.payAttempt > (d.payAttempt ?? 1)) patch.paymentReference = null; // the previous pay intent is dead; the next reference is the new intent
    }
    return patch;
  }
  async function reconcile(t, binding) {
    const d = t.launchPackageRun.dex;
    const recoveringOrder = isStagedLaunch(t) && !d.order && d.prepareAttempt === 1 && !d.attempt &&
      ['preparing','reconciliation_required'].includes(d.state) && stageFundingOf(t,'dex',{now:now()}).ready;
    if (!committedPayment(t, d) && !recoveringOrder) return;
    if (typeof adapter?.reconcile !== 'function') return;
    if (d.terminal === true) return; // parked for an operator: no bridge, no payment, no provider call
    if (d.state === 'settled') {
      const last = Date.parse(d.publicationCheckedAt || '');
      if (Number.isFinite(last) && now() - last < PUBLICATION_CHECK_MS) return;
    }
    const result = await bounded(adapter.reconcile, { job: snapshot(t), paused: t.lock?.state === 'paused' }, t);
    unchanged(t, binding);
    if (!result || result.jobId !== d.id) throw new Error('Settlement is not bound to this job');
    if (result.paymentVerified !== true) {
      // no negative/unknown result resets an attempt; a paid job never restarts
      if (d.paymentVerified === true || d.state === 'settled') { if (d.state === 'settled') update(t, { publicationCheckedAt: new Date(now()).toISOString() }); return; }
      if (!d.order && orderValid(t, result.recoveredOrder)) {
        // Recover only this bound intent; payment still needs a fresh stage gate.
        const order = safeOrder(result.recoveredOrder);
        update(t, { state: 'prepared', order, orderFingerprint: hash(order), detail: null });
        return;
      }
      const patch = progress(d, result);
      if (result.terminal === true) update(t, { ...patch, state: 'reconciliation_required', terminal: true, nextAttemptAt: null });
      else if (result.restartable === true) update(t, { ...patch, state: 'prepared', retryAuthorized: isStagedLaunch(t), paymentReference: null, nextAttemptAt: new Date(now() + RETRY_MS).toISOString() });
      else if (Object.keys(patch).length) update(t, patch);
      return;
    }
    if (!d.order || result.orderId !== d.order.orderId || !idOk(result.paymentReference) ||
        (d.paymentReference && d.paymentReference !== result.paymentReference) ||
        (d.paymentVerified && d.actualMicros !== result.actualMicros) ||
        !Number.isSafeInteger(result.actualMicros) || result.actualMicros < d.order.amountMicros ||
        result.actualMicros > packageTerms(t).dexBudgetMicros)
      throw new Error('Settlement does not match this order and its allocation');
    // Never release the hold merely on HTTP success. The restricted adapter must
    // verify the exact chain receipt, source debit and a fresh post-debit balance.
    const sourceAt = Date.parse(result.sourceObservedAt || ''), sourceStartedAt = Date.parse(t.treasury.marketingObservationStartedAt || ''), paidAt = Date.parse(result.paidAt || '');
    const accounted = d.state === 'settled' && d.sourceBalanceReconciled === true || result.sourceBalanceReconciled === true && Number.isFinite(sourceAt) && Number.isFinite(paidAt) &&
      Number.isFinite(sourceStartedAt) && sourceStartedAt >= paidAt && sourceAt >= sourceStartedAt && sourceAt <= now() && now() - sourceStartedAt <= 30_000 &&
      result.sourceObservedAt === t.treasury.marketingObservedAt;
    // The treasury debit is booked once, the first time this job becomes accounted. The
    // bridge books it itself (ledgerKey launchPackageJobId); the queue's row is only a
    // fallback for adapters that do not, and a later ledger trim never re-books it.
    const firstAccounting = accounted && d.state !== 'settled';
    durable(t, () => {
      Object.assign(t.launchPackageRun.dex, { state: accounted ? 'settled' : 'submitted', paymentVerified: true,
        paymentReference: result.paymentReference, actualMicros: result.actualMicros,
        sourceBalanceReconciled: accounted, paidAt: result.paidAt, updatedAt: new Date(now()).toISOString(),
        publication: result.publicationVerified === true ? 'published' : 'not_verified', publicationCheckedAt: new Date(now()).toISOString(),
        bridgeState: typeof result.bridgeState === 'string' && /^[a-z_]{1,40}$/.test(result.bridgeState) ? result.bridgeState : 'paid',
        detail: null, nextAttemptAt: null });
      if (firstAccounting && !(t.treasury.ledger || []).some(row => row.launchPackageJobId === d.id)) {
        (t.treasury.ledger ||= []).unshift({ simAt: new Date(now()).toISOString(),
          deltaMicros: -result.actualMicros, balanceMicros: t.treasury.micros,
          reason: 'DEX Screener launch package', launchPackageJobId: d.id,
          tx: result.paymentReference, chain: 'solana' });
      }
    });
  }
  async function work(t) {
    const key = keyOf(t), binding = bindingOf(t), payer = String(t.treasury.wallet).toLowerCase();
    active.add(key); payers.add(payer);
    try {
      let d = t.launchPackageRun.dex;
      const hasJournal = Object.hasOwn(t.launchPackageRun, 'dex');
      if (hasJournal && (!d || typeof d !== 'object' || Array.isArray(d) || d.version !== 1 || d.binding !== binding || d.id !== `launch-dex:${key}:v1` ||
          (d.order && d.orderFingerprint !== hash(d.order)))) return; // unknown history never authorizes a call or rewrite
      if (!isStagedLaunch(t)) {
        // Existing legacy obligations can settle; no new legacy checkout.
        if (hasJournal && d.order && adapter) await reconcile(t,binding);
        return;
      }
      if (!hasJournal) {
        if (!stageFundingOf(t,'dex',{now:now()}).ready) return;
        update(t,{version:1,id:`launch-dex:${key}:v1`,binding,state:'queued',createdAt:new Date(now()).toISOString()});
        d=t.launchPackageRun.dex;
      }
      if (d.terminal === true) return;
      if (d.state === 'settled') { if (d.publication !== 'published' && adapter) await reconcile(t,binding); return; }
      if (!adapter) { if (!interrupted.has(d.state) && d.state !== 'not_connected') update(t,{state:'not_connected'}); return; }
      if (interrupted.has(d.state)) {
        if (verifiedReturnedAllocation(t,d)) update(t,{state:'prepared',retryAuthorized:true,paymentReference:null,nextAttemptAt:new Date(now()+RETRY_MS).toISOString(),detail:'Allocation returned; waiting before a fresh funding check'});
        else await reconcile(t,binding);
        return;
      }
      if (!['queued','not_connected','prepared'].includes(d.state) || !stageFundingOf(t,'dex',{now:now()}).ready ||
          Date.parse(d.nextAttemptAt || '') > now()) return;
      if (!d.order) {
        if (typeof adapter.prepareOrder !== 'function') return;
        update(t,{state:'preparing',prepareAttempt:1,detail:null});
        const order=await bounded(adapter.prepareOrder,{project:{token:t.address,chain:t.chain},job:snapshot(t)},t);
        unchanged(t,binding);
        if (!orderValid(t,order)) throw new Error('DEX quote does not match this project and approved price');
        const safe=safeOrder(order); update(t,{state:'prepared',order:safe,orderFingerprint:hash(safe),detail:null});d=t.launchPackageRun.dex;
      }
      if (!stageFundingOf(t,'dex',{now:now()}).ready || typeof adapter.payOrder !== 'function') return;
      let quote;
      try { quote=typeof adapter.verifyOrder==='function' ? await bounded(adapter.verifyOrder,{project:{token:t.address,chain:t.chain},job:snapshot(t)},t) : null; }
      catch (error) { update(t,{state:'prepared',detail:errorDetail(error),nextAttemptAt:new Date(now()+RETRY_MS).toISOString()});return; }
      unchanged(t,binding);
      const quoteAt=Date.parse(quote?.checkedAt||'');
      if (quote?.verified!==true || quote.paylinkId!==d.order.paylinkId || quote.amountMicros!==d.order.amountMicros ||
          !Number.isFinite(quoteAt) || quoteAt>now() || now()-quoteAt>30_000) {
        update(t,{state:'prepared',detail:'DEX_QUOTE_UNVERIFIED',nextAttemptAt:new Date(now()+RETRY_MS).toISOString()});return;
      }
      if (!stageFundingOf(t,'dex',{now:now()}).ready) return;
      const bridgeRows=Object.entries(t.packageBridgeReservations||{}).filter(([id])=>id.startsWith(`package-dex-bridge:${d.id}:a`));
      if (bridgeRows.some(([id,r])=>!record(r)||r.id!==id||!['released','refunded'].includes(r.state))) return;
      if ((d.attempt||0)>0 && d.retryAuthorized!==true) return;
      update(t,{state:'payment_pending',attempt:(d.attempt||0)+1,retryAuthorized:false,detail:null,nextAttemptAt:null});
      const result=await bounded(adapter.payOrder,{project:{token:t.address,chain:t.chain},job:snapshot(t)},t);
      unchanged(t,binding);
      if (!idOk(result?.paymentReference)) throw new Error('DEX payment reference unavailable');
      update(t,{state:'submitted',paymentReference:result.paymentReference});
      await reconcile(t,binding);
    } catch (e) {
      const d = t.launchPackageRun?.dex;
      if (e.code === 'package_persistence_failed' || !d || typeof d !== 'object' || d.state === 'settled') return;
      const detail = errorDetail(e);
      // Preserve the existing adapter's progress/review evidence. A retryable
      // result does not grant this queue authority to dispatch another payment.
      if (e.retryable === true && d.paymentVerified !== true && d.terminal !== true && d.state !== 'submitted')
        update(t, { state: d.order ? 'prepared' : 'reconciliation_required', retryAuthorized: isStagedLaunch(t) && e.code === 'DEX_BRIDGE_NOT_DISPATCHED', nextAttemptAt: new Date(now() + RETRY_MS).toISOString(), detail });
      else update(t, { state: 'reconciliation_required', detail });
    } finally { active.delete(key); payers.delete(payer); }
  }
  async function tick() {
    const candidates = [];
    for (const t of tokens()) {
      try {
      if (!hasLaunchPackage(t) || !t.onchain?.launchTx || t.treasury?.mode !== 'wallet' || !t.treasury.wallet) continue;
      if (!isPackageFunded(t)) durable(t, () => markPackageFunded(t, { now: now(), availableMicros: t.treasury.micros - heldUsage(t) }));
      if (!isPackageFunded(t)) continue;
      // Preserve untouched journals; do not create an order, cancellation or
      // payment journal for a waived allocation. Committed jobs reconcile below.
      if (dexAllocationWaived(t)) continue;
      const d = t.launchPackageRun.dex, key = keyOf(t), payer = String(t.treasury.wallet).toLowerCase();
      if ((d?.state === 'settled' && (d.publication === 'published' || !adapter)) || active.has(key) || externalCalls.has(key) || payers.has(payer) || [...externalCalls.values()].includes(payer)) continue;
      if (t.lock?.state === 'paused' && !interrupted.has(d?.state)) continue;
      // Runtime treasuries are unique per project. Never treat two cached views
      // of a shared wallet as independent funds; a future shared-payer broker
      // needs its own transactional ledger before that topology is supported.
      if (tokens().some(other => other !== t && String(other.treasury?.wallet).toLowerCase() === payer)) continue;
      candidates.push(t);
      } catch { /* One invalid project's terms must not stop the other jobs. */ }
    }
    candidates.sort((a, b) => (Date.parse(a.launchPackageRun.dex?.updatedAt || '') || 0) - (Date.parse(b.launchPackageRun.dex?.updatedAt || '') || 0));
    const tasks = [];
    for (const t of candidates) {
      if (occupied() >= LIMIT) break;
      if (!payers.has(String(t.treasury.wallet).toLowerCase())) tasks.push(work(t));
    }
    await Promise.allSettled(tasks); // one project failure never rejects siblings
    return { processed: tasks.length, active: occupied(), capacity: LIMIT };
  }
  return { tick, capacity: LIMIT };
}
