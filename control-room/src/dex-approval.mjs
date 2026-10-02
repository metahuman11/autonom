// Shared approval check. No provider, wallet, environment or network access.
import {payloadHash} from './canonical.mjs';
import {isDexType,validateDexPayload} from './dex-policy.mjs';
import {checkProposal} from './rules.mjs';
import {assertGovernanceSnapshot} from './governance-guard.mjs';
const fail=(status,message)=>Object.assign(new Error(message),{status});

// Structural approval validation is useful for non-actionable public history.
// Only assertApprovedDexPurchase below may authorize a preparation or payment.
export function assertDexApprovalMetadata(t,body,now) {
  if(!body||Array.isArray(body)||Object.keys(body).sort().join(',')!=='approvedPayloadHash,proposalId')
    throw fail(400,'Only an approved proposal reference is accepted');
  if(typeof body.proposalId!=='string'||!body.proposalId.length||body.proposalId.length>128||
    typeof body.approvedPayloadHash!=='string'||!/^0x[0-9a-f]{64}$/.test(body.approvedPayloadHash))
    throw fail(400,'Invalid approved proposal reference');
  const matches=(t.proposals||[]).filter(p=>p.id===body.proposalId);
  if(matches.length!==1)throw fail(403,'One unique approved DEX purchase vote is required');
  const p=matches[0];
  if(!p||!isDexType(p.type)||p.status!=='approved'||p.cancelledAt||p.revokedAt)
    throw fail(403,'A current approved DEX purchase vote is required');
  if(p.payloadHash!==body.approvedPayloadHash||p.payloadHash!==payloadHash({type:p.type,payload:p.payload}))
    throw fail(403,'Approved purchase changed');
  validateDexPayload(p.type,p.payload,t);
  if(!checkProposal(p).ok)throw fail(403,'Purchase content violates the operating rules');
  const integer=x=>typeof x==='string'&&/^\d{1,80}$/.test(x);
  if(p.governanceVersion!==2||p.tally?.passed!==true||!integer(p.totalSupplyWei)||
     !integer(p.tally.yesWei)||!integer(p.tally.noWei))
    throw fail(403,'Verified total-supply community approval is required');
  const yes=BigInt(p.tally.yesWei),no=BigInt(p.tally.noWei),total=BigInt(p.totalSupplyWei);
  if(total<=0n||yes+no>total||yes*10_000n<=total*1500n||yes<=no)
    throw fail(403,'More than 15% of supply and Yes greater than No are required');
  if(!Number.isFinite(now)||now>=Date.parse(p.payload.expiresAt))
    throw fail(409,'Purchase approval expired; open a new vote');
  return p;
}

export function assertApprovedDexPurchase(t,body,now) {
  const p=assertDexApprovalMetadata(t,body,now);
  assertGovernanceSnapshot(t,p,now);
  return p;
}
