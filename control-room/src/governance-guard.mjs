// Runtime-only evidence: a serialized proposal or chat cannot forge a chain
// verification. RPC is an operator-selected trust dependency, not user input.
import {payloadHash} from './canonical.mjs';
const grants = new WeakMap();
const attempts = new WeakMap();
const fail = message => Object.assign(new Error(message), {status:503});
const binding = (t,p) => payloadHash({token:t.address, id:p.id, governanceVersion:p.governanceVersion, status:p.status, tally:p.tally, payload:p.payload, payloadHash:p.payloadHash, type:p.type, votes:p.votes, snapshotBlock:p.snapshotBlock, snapshotBlockHash:p.snapshotBlockHash, totalSupplyWei:p.totalSupplyWei, approvalBps:p.approvalBps, requireMajority:p.requireMajority, endsAt:p.endsAt ?? null, cancelledAt:p.cancelledAt ?? null, revokedAt:p.revokedAt ?? null});
export const needsChainVerification = (t,p) => Boolean(t.onchain && p?.governanceVersion === 2);
// Snapshot identity: an EVM block hash (0x-64-hex, case-insensitive) or a Solana blockhash
// (base58, case-sensitive). The format is taken from the stored hash itself, so a project
// keyed by chain 'solana' that still carries EVM-style evidence keeps verifying as before.
const HEX_HASH=/^0x[0-9a-f]{64}$/i, B58_HASH=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const hashOk=(_t,h) => HEX_HASH.test(h || '') || B58_HASH.test(h || '');
const sameHash=(_t,a,b) => HEX_HASH.test(a||'') ? String(a||'').toLowerCase()===String(b||'').toLowerCase() : a===b;
export async function verifyGovernanceSnapshot(t,p,getBlock,now=Date.now()) {
  if (!needsChainVerification(t,p)) return;
  const attempt={}; attempts.set(p,attempt);
  grants.delete(p);
  p.governanceCheck={status:'pending',reason:'Canonical finalized snapshot verification required before action'};
  if (!Number.isSafeInteger(p.snapshotBlock) || p.snapshotBlock < 0 || !hashOk(t,p.snapshotBlockHash)) throw fail('governance snapshot is invalid; action paused');
  const before = binding(t,p);
  let timer;
  try {
    const [finalized,canonical] = await Promise.race([
      Promise.all([getBlock('finalized'),getBlock(p.snapshotBlock)]),
      new Promise((_,reject) => { timer=setTimeout(() => reject(fail('governance chain verification timed out; action paused')),8000); timer.unref?.(); })
    ]);
    if (attempts.get(p) !== attempt) throw fail('governance verification superseded; retry required');
    if (!Number.isSafeInteger(finalized?.number) || finalized.number < p.snapshotBlock || !hashOk(t,finalized?.hash)) throw fail('governance snapshot is not finalized; action paused');
    if (canonical?.number !== p.snapshotBlock || !hashOk(t,canonical?.hash) || !sameHash(t,canonical.hash,p.snapshotBlockHash)) throw fail('governance snapshot changed on chain; action paused for review');
    if (binding(t,p) !== before) throw fail('proposal changed during chain verification; retry required');
    grants.set(p,{binding:before,checkedAt:now});
    p.governanceCheck={status:'verified',checkedAt:new Date(now).toISOString()};
  } catch(e) {
    if (attempts.get(p) === attempt) {
      grants.delete(p);
      p.governanceCheck={status:'pending',reason:'Canonical finalized snapshot verification required before action'};
    }
    throw fail(e?.status === 503 ? e.message : 'governance chain verification unavailable; action paused');
  } finally {clearTimeout(timer);}
}
export function assertGovernanceSnapshot(t,p,now=Date.now()) {
  if (!needsChainVerification(t,p)) return;
  const grant=grants.get(p);
  if (!grant || now < grant.checkedAt || now-grant.checkedAt > 30_000 || grant.binding !== binding(t,p)) throw fail('fresh finalized governance snapshot verification required');
}
