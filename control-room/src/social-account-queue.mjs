// Single-writer account acquisition coordinator. No network, secret, or provider
// access by default. A trusted adapter must atomically reuse verified unassigned
// stock before buying ONE account, enforce budgetMicros, and retain a provider
// journal keyed by job.id. It must never retry an uncertain purchase. Inventory
// credentials remain inside that adapter; accountId is the immutable numeric X ID.
import { createHash } from 'node:crypto';
import { packageTerms, isPackageFunded, markPackageFunded, hasFreshMarketingObservation, socialAccountReserveMicros, socialAccountFundingCreditMicros, isStagedLaunch, launchProjectKey, launchTreasuryKey } from './launch-package.mjs';
import { stageFundingOf } from './startup-stages.mjs';
import { heldUsage, packageHolds } from './usage-budget.mjs';

const LIMIT = 5, active = new Set(), externalCalls = new Map(), lastServed = new Map();
let turn = 0;
const occupied = () => new Set([...active, ...externalCalls.keys()]).size;
const idOk = value => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,180}$/.test(value) && !['__proto__','constructor','prototype'].includes(value);
const handleOk = value => typeof value === 'string' && /^[a-zA-Z0-9_]{1,15}$/.test(value);
const accountOk = value => typeof value === 'string' && /^[1-9][0-9]{0,29}$/.test(value);
const keyOf = launchProjectKey;
const payerOf = launchTreasuryKey;
const bindingOf = t => createHash('sha256').update(JSON.stringify({ terms: packageTerms(t), project: keyOf(t),
  treasury: payerOf(t), launchTx: t.onchain.launchTx })).digest('hex');
const interrupted = new Set(['payment_pending', 'submitted', 'reconciliation_required']);
const states = new Set(['queued', 'not_connected', ...interrupted, 'settled']);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const date = value => typeof value === 'string' ? Date.parse(value) : NaN;
// Operator-facing detail: a short code or message, never a URL (RPC keys) and never long.
const clip = value => typeof value === 'string' && value.trim() ? value.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 200) || null : null;
const errorDetail = e => clip(typeof e?.code === 'string' && e.code ? e.code : e?.message);

// Pure display and acquisition funding view. Pending creator-fee estimates are
// deliberately excluded: only the observed treasury and certified prior account
// spend count. The account's own unused reserve is excluded once; all other
// liabilities remain held. Provider readiness and registry identity are separate.
export function socialFundingStatus(t, { now = Date.now() } = {}) {
  if (isStagedLaunch(t)) return stageFundingOf(t, 'social', {now});
  const thresholdMicros = packageTerms(t)?.socialAccountBudgetMicros || 0;
  const creditedMicros = socialAccountFundingCreditMicros(t);
  const balanceValid = Number.isSafeInteger(t.treasury?.micros) && t.treasury.micros >= 0;
  const fresh = balanceValid && hasFreshMarketingObservation(t, now);
  const ownHeldMicros = packageHolds(t).social;
  const otherHeldMicros = Math.max(0, heldUsage(t) - ownHeldMicros);
  const availableMicros = balanceValid ? Math.max(0, t.treasury.micros - otherHeldMicros) : 0;
  const collectedMicros = Math.min(thresholdMicros, availableMicros + creditedMicros);
  const funded = thresholdMicros > 0 && (creditedMicros >= thresholdMicros || fresh && collectedMicros >= thresholdMicros);
  const allocationClear = thresholdMicros > 0 && socialAccountReserveMicros(t) === thresholdMicros && ownHeldMicros === thresholdMicros;
  const ready = funded && fresh && allocationClear && t.lock?.state !== 'paused';
  const blockedReason = creditedMicros >= thresholdMicros && thresholdMicros > 0 ? null :
    t.lock?.state === 'paused' ? 'paused' : !fresh ? 'balance_unavailable' :
    !allocationClear ? 'account_reconciliation' : !funded ? 'funding' : null;
  return { thresholdMicros, collectedMicros, availableMicros, creditedMicros, otherHeldMicros, fresh, funded,
    ready, blockedReason, waitingPreviousStage: false };
}

export function createSocialAccountQueue({ tokens, persist, registry, adapter = null, now = Date.now, timeoutMs = 30_000 } = {}) {
  if (typeof tokens !== 'function' || typeof persist !== 'function' || !(typeof registry === 'function' || record(registry)))
    throw new Error('A single-writer durable store and private assignment registry are required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Invalid provider deadline');
  const assignments = () => {
    const r = typeof registry === 'function' ? registry() : registry;
    if (!record(r) || !record(r.accounts) || !record(r.projects)) throw new Error('Invalid private assignment registry');
    return r;
  };
  function durable(t, mutate) {
    const r = assignments(), upgradeBefore = structuredClone(t.launchPackageUpgrade), before = structuredClone(t.launchPackageRun), ledgerBefore = structuredClone(t.treasury.ledger), registryBefore = structuredClone(r);
    try {
      if (mutate(r) === false) return;
      const saved = persist();
      if (saved?.then) throw new Error('Persistence must be synchronous');
    } catch {
      if (upgradeBefore === undefined) delete t.launchPackageUpgrade; else t.launchPackageUpgrade = upgradeBefore;
      if (before === undefined) delete t.launchPackageRun; else t.launchPackageRun = before;
      if (ledgerBefore === undefined) delete t.treasury.ledger; else t.treasury.ledger = ledgerBefore;
      for (const key of Object.keys(r)) delete r[key];
      Object.assign(r, registryBefore);
      throw Object.assign(new Error('Social account state could not be saved'), { code: 'social_persistence_failed' });
    }
  }
  const update = (t, patch) => durable(t, () => {
    t.launchPackageRun.socialAccount = { ...t.launchPackageRun.socialAccount, ...patch, updatedAt: new Date(now()).toISOString() };
  });
  const snapshot = t => structuredClone(t.launchPackageRun.socialAccount);
  const projectOf = t => Object.freeze({ key: keyOf(t), chain: t.chain, token: t.address, treasury: t.treasury.wallet,
    launchTx: t.onchain.launchTx, budgetMicros: packageTerms(t).socialAccountBudgetMicros });
  function journalHistory() {
    const projects = new Map(), accounts = new Map();
    for (const t of tokens()) {
      const job = t.launchPackageRun?.socialAccount;
      if (job === undefined) continue;
      const projectKey = keyOf(t);
      if (!record(job) || !(packageTerms(t)?.version >= 2) || !t.onchain?.launchTx ||
          !t.treasury?.wallet || job.version !== 1 || !states.has(job.state) || projects.has(projectKey))
        throw new Error('Invalid social acquisition journal');
      isPackageFunded(t); // Validate funded or explicit social-only history.
      const binding = bindingOf(t);
      if (job.binding !== binding || job.id !== `launch-social:${binding}`)
        throw new Error('Stored acquisition binding changed');
      const claimed = job.accountId !== undefined || job.acquisitionVerified === true || job.paymentVerified === true || job.state === 'settled';
      if (claimed && (job.acquisitionVerified !== true || job.paymentVerified !== true || !accountOk(job.accountId) ||
          !idOk(job.purchaseReference) || !idOk(job.orderId) || !idOk(job.paymentReference) ||
          !Number.isSafeInteger(job.actualMicros) || job.actualMicros <= 0 || job.actualMicros > packageTerms(t).socialAccountBudgetMicros ||
          !['submitted','reconciliation_required','settled'].includes(job.state) ||
          (job.handle !== undefined && !handleOk(job.handle)) ||
          (job.state === 'settled' && socialAccountReserveMicros(t) !== 0)))
        throw new Error('Invalid verified account journal');
      projects.set(projectKey, { job, binding, claimed });
      if (claimed) {
        if (accounts.has(job.accountId)) throw new Error('Account claimed by multiple project journals');
        accounts.set(job.accountId, projectKey);
      }
    }
    return { projects, accounts };
  }
  function registryConsistent(r, history) {
    for (const [projectKey, { job, binding, claimed }] of history.projects) {
      if (!claimed) continue;
      const account = r.accounts[job.accountId], project = r.projects[projectKey];
      if (!record(account) || !record(project) || account.projectKey !== projectKey || account.jobId !== job.id || account.binding !== binding ||
          project.accountId !== job.accountId || project.jobId !== job.id || project.binding !== binding) return false;
    }
    // Orphaned, partial or differently bound registry entries also stop buying.
    for (const [accountId, account] of Object.entries(r.accounts)) {
      const expected = record(account) && history.projects.get(account.projectKey);
      if (!expected?.claimed || expected.job.accountId !== accountId || expected.job.id !== account.jobId || expected.binding !== account.binding) return false;
    }
    for (const [projectKey, project] of Object.entries(r.projects)) {
      const expected = history.projects.get(projectKey);
      if (!record(project) || !expected?.claimed || expected.job.accountId !== project.accountId || expected.job.id !== project.jobId || expected.binding !== project.binding) return false;
    }
    return true;
  }
  function unchanged(t, binding) {
    if (!tokens().includes(t) || !(packageTerms(t)?.version >= 2) || bindingOf(t) !== binding)
      throw new Error('Project acquisition binding changed');
    isPackageFunded(t); // A social-only journal is valid but cannot unlock the VPS.
  }
  function uniqueTreasury(t) {
    return !tokens().some(other => other !== t && payerOf(other) === payerOf(t));
  }
  function mayStart(t, binding) {
    unchanged(t, binding);
    if (!uniqueTreasury(t) || !socialFundingStatus(t, { now: now() }).ready) return false;
    if (![10_000_000,20_000_000].includes(packageTerms(t).socialAccountBudgetMicros)) return false;
    // Existing assignment evidence must be reconciled, never replaced by a buy.
    const r = assignments();
    if (Object.hasOwn(r.projects, keyOf(t)) || Object.values(r.accounts).some(a => a?.projectKey === keyOf(t)))
      throw new Error('Existing assignment requires reconciliation');
    // Missing registry metadata is not empty inventory. Stop all new purchases
    // until trusted reconciliation restores agreement with every existing job.
    try { if (!registryConsistent(r, journalHistory())) return false; } catch { return false; }
    return true;
  }
  async function bounded(fn, input, t) {
    const key = keyOf(t), controller = new AbortController();
    if (externalCalls.has(key)) throw new Error('Previous provider call remains outstanding');
    externalCalls.set(key, payerOf(t));
    const operation = Promise.resolve().then(() => fn.call(adapter, { ...input, signal: controller.signal }));
    operation.then(() => externalCalls.delete(key), () => externalCalls.delete(key));
    let timer;
    try {
      return await Promise.race([operation, new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Provider outcome uncertain')); }, timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }
  async function reconcile(t, binding) {
    const job = snapshot(t);
    if (typeof adapter?.reconcile !== 'function') return;
    const result = await bounded(adapter.reconcile, { project: projectOf(t), job, paused: t.lock?.state === 'paused' }, t);
    unchanged(t, binding);
    if (!result || result.jobId !== job.id) throw new Error('Acquisition is not bound to this job');
    if (result.acquisitionVerified !== true || result.paymentVerified !== true) {
      // No negative/unknown result changes the attempt; only the operator detail is kept.
      const detail = clip(result.reason);
      if (detail !== (job.detail ?? null)) update(t, { detail });
      return;
    }
    if (!idOk(result.purchaseReference) || !idOk(result.orderId) || !accountOk(result.accountId) || !idOk(result.paymentReference) ||
        !Number.isSafeInteger(result.actualMicros) || result.actualMicros <= 0 || result.actualMicros > packageTerms(t).socialAccountBudgetMicros ||
        ['purchaseReference','orderId','accountId','paymentReference','actualMicros'].some(k => job[k] !== undefined && job[k] !== result[k]) ||
        (result.handle !== undefined && !handleOk(result.handle)) || (job.handle !== undefined && result.handle !== undefined && job.handle !== result.handle))
      throw new Error('Acquisition evidence does not match this job and allocation');
    const history = journalHistory(), previousOwner = history.accounts.get(result.accountId);
    if (previousOwner !== undefined && previousOwner !== keyOf(t))
      throw new Error('Account belongs to another project journal');
    const paid = date(result.paidAt), start = date(result.sourceObservationStartedAt), observed = date(result.sourceObservedAt), reconciled = date(result.sourceReconciledAt);
    const accounted = result.sourceBalanceReconciled === true && [paid,start,observed,reconciled].every(Number.isFinite) &&
      paid <= start && start <= observed && observed <= reconciled && reconciled <= now() && now() - start <= 30_000 &&
      result.sourceObservationStartedAt === t.treasury.marketingObservationStartedAt && result.sourceObservedAt === t.treasury.marketingObservedAt &&
      Number.isSafeInteger(t.treasury.micros) && t.treasury.micros >= 0;
    const r = assignments(), projectKey = keyOf(t), existingAccount = r.accounts[result.accountId], existingProject = r.projects[projectKey];
    if ((existingAccount && (existingAccount.projectKey !== projectKey || existingAccount.jobId !== job.id || existingAccount.binding !== binding)) ||
        (existingProject && (existingProject.accountId !== result.accountId || existingProject.jobId !== job.id || existingProject.binding !== binding)) ||
        Object.entries(r.accounts).some(([id, value]) => value?.projectKey === projectKey && id !== result.accountId) ||
        Object.entries(r.projects).some(([key, value]) => value?.accountId === result.accountId && key !== projectKey))
      throw new Error('Account is already assigned or project has a different account');
    durable(t, registryState => {
      // Allowlisted non-secret identifiers only; no raw provider object is stored.
      registryState.accounts[result.accountId] = { projectKey, jobId: job.id, binding };
      registryState.projects[projectKey] = { accountId: result.accountId, jobId: job.id, binding };
      const evidence = Object.fromEntries(['purchaseReference','orderId','accountId','paymentReference','actualMicros'].map(k => [k,result[k]]));
      if (handleOk(result.handle)) evidence.handle = result.handle;
      for (const k of ['paidAt','sourceObservationStartedAt','sourceObservedAt','sourceReconciledAt']) if (Number.isFinite(date(result[k]))) evidence[k] = result[k];
      Object.assign(t.launchPackageRun.socialAccount, evidence, { acquisitionVerified: true, paymentVerified: true,
        sourceBalanceReconciled: accounted, state: accounted ? 'settled' : 'submitted', detail: null, updatedAt: new Date(now()).toISOString() });
      // The $10 debit is booked once, the first time the job becomes accounted. The charge
      // books it itself (ledgerKey socialAccountJobId); this row is only a fallback.
      if (accounted && job.state !== 'settled' && !(t.treasury.ledger || []).some(row => row.socialAccountJobId === job.id))
        (t.treasury.ledger ||= []).unshift({ simAt: new Date(now()).toISOString(), deltaMicros: -result.actualMicros,
          balanceMicros: t.treasury.micros, reason: 'Project X account acquisition', socialAccountJobId: job.id });
    });
  }
  async function work(t) {
    const key = keyOf(t), binding = bindingOf(t), id = `launch-social:${binding}`;
    active.add(key);
    lastServed.set(key, ++turn);
    try {
      let job = t.launchPackageRun.socialAccount;
      if (job !== undefined && (!record(job) || job.version !== 1 || job.id !== id || job.binding !== binding || !states.has(job.state)))
        throw Object.assign(new Error('Stored acquisition binding changed'), { code: 'social_journal_invalid' });
      if (job === undefined) { update(t, { version: 1, id, binding, state: 'queued', createdAt: new Date(now()).toISOString() }); job = t.launchPackageRun.socialAccount; }
      if (job.state === 'settled') return;
      if (!adapter) { if (!interrupted.has(job.state) && job.state !== 'not_connected') update(t, { state: 'not_connected' }); return; }
      if (interrupted.has(job.state)) { await reconcile(t, binding); return; }
      if (!mayStart(t, binding)) return;
      if (typeof adapter.acquireOne !== 'function' || typeof adapter.reconcile !== 'function') throw new Error('Complete account acquisition adapter required');
      // Inventory inspection is read-only and does not create a purchase attempt.
      // Empty stock therefore stays queued instead of fabricating an uncertain debit.
      if (typeof adapter.checkAvailability === 'function') {
        let availability;
        try { availability = await bounded(adapter.checkAvailability, { project: projectOf(t), job: snapshot(t) }, t); }
        catch (error) { update(t, { state: 'queued', detail: errorDetail(error) }); return; }
        unchanged(t, binding);
        if (availability?.available !== true) {
          const detail = availability?.reason === 'X_POOL_EMPTY' ? 'X_POOL_EMPTY' : 'X_ACCOUNT_UNAVAILABLE';
          if (job.state !== 'queued' || job.detail !== detail) update(t, { state: 'queued', detail });
          return;
        }
        if (!mayStart(t, binding)) return; // Source funds/holds may change during the read.
      }
      update(t, { state: 'payment_pending', detail: null }); // Durable BEFORE any possible purchase.
      const result = await bounded(adapter.acquireOne, { project: projectOf(t), job: snapshot(t) }, t);
      unchanged(t, binding);
      if (!idOk(result?.purchaseReference)) throw new Error('Purchase reference unavailable');
      update(t, { state: 'submitted', purchaseReference: result.purchaseReference });
      await reconcile(t, binding);
    } catch (error) {
      if (!['social_persistence_failed','social_journal_invalid'].includes(error.code) && t.launchPackageRun?.socialAccount?.state !== 'settled')
        update(t, { state: 'reconciliation_required', detail: errorDetail(error) });
    } finally { active.delete(key); }
  }
  async function tick() {
    const candidates = [];
    for (const t of tokens()) {
      try {
        if (!(packageTerms(t)?.version >= 2) || !t.onchain?.launchTx || t.treasury?.mode !== 'wallet' || !t.treasury.wallet || !uniqueTreasury(t)) continue;
        if (!isPackageFunded(t)) durable(t, () => markPackageFunded(t, { now: now(), availableMicros: t.treasury.micros - heldUsage(t) }));
        if (isStagedLaunch(t) && !isPackageFunded(t)) continue;
        if (!isPackageFunded(t) && t.launchPackageRun == null) {
          const budget = packageTerms(t).socialAccountBudgetMicros;
          if (![10_000_000,20_000_000].includes(budget) || !socialFundingStatus(t, { now: now() }).ready) continue;
          durable(t, () => { t.launchPackageRun = { version: 1, fundingStage: 'social' }; });
        }
        const job = t.launchPackageRun.socialAccount, key = keyOf(t);
        if (job?.state === 'settled' || active.has(key) || externalCalls.has(key) || [...externalCalls.values()].includes(payerOf(t))) continue;
        if (t.lock?.state === 'paused' && !interrupted.has(job?.state)) continue;
        candidates.push(t);
      } catch { /* Invalid projects cannot stop independent jobs. */ }
    }
    // Unknown provider results still consume a turn: five unresolved accounts
    // must not starve every later project's acquisition or reconciliation.
    candidates.sort((a,b) => (lastServed.get(keyOf(a)) || 0) - (lastServed.get(keyOf(b)) || 0) ||
      (date(a.launchPackageRun.socialAccount?.updatedAt) || 0) - (date(b.launchPackageRun.socialAccount?.updatedAt) || 0));
    const tasks = [];
    for (const t of candidates) {
      if (occupied() >= LIMIT) break;
      if (!active.has(keyOf(t)) && !externalCalls.has(keyOf(t))) tasks.push(work(t));
    }
    await Promise.allSettled(tasks);
    return { processed: tasks.length, active: occupied(), capacity: LIMIT };
  }
  return { tick, capacity: LIMIT };
}
