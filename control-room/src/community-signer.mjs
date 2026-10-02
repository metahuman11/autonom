// Deterministic, vote-scoped central-VPS transaction coordinator.
// Request bodies carry IDs only, never a transaction, destination, key or RPC.
import {payloadHash} from './canonical.mjs';
import {checkVotedActionScope} from './community-actions.mjs';
import {heldUsage} from './usage-budget.mjs';
import {withTreasuryLock, assertTreasuryClear} from './treasury-lock.mjs';

const fail = (status, message) => Object.assign(new Error(message), {status});
const view = r => ({proposalId:r.proposalId, state:r.state, executionState:r.executionState,
  transactionHash:r.transactionHash || null, reason:r.reason || null});
const recordHash = r => { const {integrityHash,...fields}=r; return payloadHash(fields); };
const safeHash = x => typeof x === 'string' && /^0x[0-9a-f]{64}$/i.test(x);

export function createCommunitySigner({persist, verifyVote, refreshBalance, adapterFor, now=Date.now}) {
  for (const fn of [persist,verifyVote,refreshBalance,adapterFor]) if (typeof fn !== 'function') throw new Error('Trusted signer dependencies required');
  // Persistence MUST be synchronous and atomic, like store.save. A failed write
  // freezes this process; it must not accidentally permit a later broadcaster.
  let storageFailed = false;
  function save() {
    if (storageFailed) throw fail(503,'Signer storage requires operator reconciliation');
    try { const result=persist(); if (result?.then) throw new Error('Synchronous persistence required'); }
    catch { storageFailed=true; throw fail(503,'Signer state could not be saved; no automatic retry'); }
  }
  function project(t, contextValid) {
    if (storageFailed) throw fail(503,'Signer storage requires operator reconciliation');
    if (contextValid?.() !== true) throw fail(401,'Active project agent session required');
    if (t.treasury?.mode !== 'wallet' || t.vps?.mode !== 'real' || t.vps?.state !== 'running'
      || t.vps?.reconciliationRequired || ['stopping','error'].includes(t.vps?.phase)
      || t.agent?.state === 'paused' || t.lock?.state === 'paused') throw fail(409,'Project is not available for treasury execution');
  }
  function reference(t, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== 2 || !Object.hasOwn(body,'proposalId') || !Object.hasOwn(body,'approvedPayloadHash')
      || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.proposalId || '')) throw fail(400,'Only proposalId and approvedPayloadHash are accepted');
    const matches=(t.proposals || []).filter(p=>p.id===body.proposalId);
    const p=matches[0];
    if (matches.length !== 1 || p.payloadHash !== body.approvedPayloadHash
      || p.payloadHash !== payloadHash({type:p.type,payload:p.payload})) throw fail(403,'Exact project-owned approved payload required');
    return p;
  }
  function validateRecord(t,p,r) {
    if (r.version !== 1 || r.proposalId !== p.id || r.payloadHash !== p.payloadHash
      || r.projectToken !== t.address.toLowerCase() || r.wallet !== t.treasury.wallet.toLowerCase()
      || !['reserved','submitted','uncertain','settled','released'].includes(r.state)
      || !Number.isSafeInteger(r.limitMicros) || r.limitMicros <= 0
      || r.integrityHash !== recordHash(r)) throw fail(409,'Transaction journal changed; operator reconciliation required');
  }
  function update(p,r,patch) {
    Object.assign(r,patch,{updatedAt:new Date(now()).toISOString()});
    r.integrityHash=recordHash(r);
    p.agentStatus=r.executionState === 'confirmed' ? 'done' : 'paused';
    p.agentReason=r.reason || null;
    p.result={executionState:r.executionState,transactionHash:r.transactionHash || null};
    save();
  }
  async function authorize(t,p,body,adapter,contextValid,own=0) {
    project(t,contextValid);
    if (reference(t,body)!==p) throw fail(403,'Proposal replaced');
    await verifyVote(t,p);
    await refreshBalance(t);
    project(t,contextValid);
    if (reference(t,body)!==p) throw fail(403,'Proposal replaced');
    const current=adapterFor(t,p);
    if (!current || current.policyHash !== adapter.policyHash) throw fail(409,'Signer policy changed');
    return checkVotedActionScope(t,p,{chainId:adapter.chainId,
      availableMicros:t.treasury.micros-heldUsage(t)+own,
      balanceObservedAt:Date.parse(t.treasury.marketingObservedAt),now:now()});
  }
  async function execute(t,body,{contextValid}={}) {
    return withTreasuryLock(t,async()=>{
      project(t,contextValid);
      const p=reference(t,body),existing=t.communityActionReservations?.[p.id];
      if (existing) {validateRecord(t,p,existing);return {action:view(existing),duplicate:true};}
      assertTreasuryClear(t);
      if ([...Object.values(t.vpsUsageReservations||{}),...Object.values(t.bridgeUsageReservations||{})]
        .some(r=>!['settled','released'].includes(r.state))) throw fail(409,'Existing billing transaction requires reconciliation');
      const adapter=adapterFor(t,p);
      if (!adapter) throw fail(503,'This action has no reviewed contract adapter; no transaction signed');
      const scope=await authorize(t,p,body,adapter,contextValid);
      const prepared=await adapter.prepare(t,p);
      await authorize(t,p,body,adapter,contextValid);
      if (Object.keys(t.communityActionReservations || {}).length >= 10000) throw fail(429,'Transaction journal requires archival');
      // Reserve the full voted spend + fee ceiling, not the estimated quote.
      const r={version:1,proposalId:p.id,projectToken:t.address.toLowerCase(),wallet:t.treasury.wallet.toLowerCase(),
        payloadHash:p.payloadHash,policyHash:adapter.policyHash,chainId:adapter.chainId,
        limitMicros:Number(scope.maxTotalUsdMicros),state:'reserved',executionState:'preparing',
        prepared,createdAt:new Date(now()).toISOString()};
      (t.communityActionReservations ||= {})[p.id]=r;
      update(p,r,{});
      let signingStarted=false;
      try {
        await adapter.revalidate(t,p,prepared);
        await authorize(t,p,body,adapter,contextValid,r.limitMicros);
        // Durable ambiguity marker BEFORE asking custody to sign. Never retry an
        // interrupted attempt even if no transaction hash reached this process.
        signingStarted=true;
        update(p,r,{state:'submitted',executionState:'signing'});
        const signed=await adapter.sign(t,prepared);
        if (!safeHash(signed?.hash) || typeof signed.raw !== 'string') throw fail(502,'Invalid signer response');
        await adapter.verifySigned(t,prepared,signed);
        await adapter.revalidate(t,p,prepared);
        await authorize(t,p,body,adapter,contextValid,r.limitMicros);
        adapter.finalCheck(t,p,prepared);
        // Signed bytes never enter state, public responses or agent memory.
        update(p,r,{transactionHash:signed.hash,executionState:'submitted',reason:'Submitted intent; awaiting a finalized chain receipt'});
        project(t,contextValid);
        const hash=await adapter.broadcast(signed.raw);
        if (hash.toLowerCase() !== signed.hash.toLowerCase()) throw fail(502,'Broadcast hash mismatch');
        return {action:view(r)};
      } catch {
        if (!storageFailed) update(p,r,{state:signingStarted?'uncertain':'released',executionState:signingStarted?'reconciliation_required':'failed',
          reason:signingStarted?'Signing or submission interrupted; reconcile this intent without another payment':'Pre-sign validation failed; no transaction signed. A new vote is required'});
        if (storageFailed) throw fail(503,'Signer state requires operator reconciliation');
        return {action:view(r)};
      }
    });
  }
  async function check(t,body,{contextValid}={}) {
    return withTreasuryLock(t,async()=>{
      // Receipts remain readable after expiry/revocation/pause. Never sign here.
      if (contextValid?.() !== true) throw fail(401,'Active project agent session required');
      const p=reference(t,body),r=t.communityActionReservations?.[p.id];
      if (!r) throw fail(404,'No transaction intent exists');
      validateRecord(t,p,r);
      if (['settled','released'].includes(r.state) || !r.transactionHash) return {action:view(r)};
      const adapter=adapterFor(t,p);
      if (!adapter || adapter.policyHash !== r.policyHash) throw fail(409,'Original reviewed policy required for reconciliation');
      const receipt=await adapter.receipt(t,p,r);
      if (contextValid?.() !== true) throw fail(401,'Agent session expired');
      validateRecord(t,p,r);
      if (!receipt?.finalized) return {action:view(r)};
      if (receipt.transactionHash !== r.transactionHash || typeof receipt.success !== 'boolean') throw fail(502,'Invalid finalized receipt');
      // Refresh before releasing a hold; do not expose a pre-spend cache as funds.
      await refreshBalance(t);
      const observed=Date.parse(t.treasury.marketingObservationStartedAt);
      if (!Number.isSafeInteger(observed)||observed<receipt.checkedAt||now()-observed>30000) throw fail(503,'Fresh post-receipt treasury balance required');
      validateRecord(t,p,r);
      if (contextValid?.() !== true) throw fail(401,'Agent session expired');
      update(p,r,{state:'settled',executionState:receipt.success?'confirmed':'reverted',receipt,
        reason:receipt.success?'Finalized transaction and action evidence verified':'Transaction reverted on chain; network fee was charged. A new vote is required'});
      return {action:view(r)};
    });
  }
  return {execute,check};
}
