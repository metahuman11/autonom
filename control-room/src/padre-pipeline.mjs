// Preparation only. No account access, provider request, signing or payment.
import {payloadHash} from './canonical.mjs';
import {assertApprovedDexPurchase,assertDexApprovalMetadata} from './dex-approval.mjs';
const fail=(status,message)=>Object.assign(new Error(message),{status});
const PORTAL='https://terminal.pump.fun/';
const REASON='Padre preparation saved. Account and purchase workflow are not connected. No order or payment sent.';
const reasons=Object.freeze({
  awaiting_account:REASON,
  support_unverified:'Prepared for review only. Padre Boost support is unverified; no order or payment sent.',
  expired:'Purchase approval expired. The saved request is audit history, not authority to proceed.',
  revoked:'Approval is no longer active. Do not place an order or pay.',
  approval_changed:'Approved details or saved preparation changed. Operator review is required; do not pay.',
  payment_review_required:'An existing payment attempt needs reconciliation. Do not create another purchase.'
});
const requiredChecks=Object.freeze([
  'Connect an operator-owned account outside the public agent desktop.',
  'Verify this exact chain, token and service in the authenticated provider UI.',
  'Verify content and images match the community-approved payload.',
  'Verify payer, currency, network, recipient, price, fees and project-specific funding.',
  'Obtain explicit operator approval of the exact payment; a prepared request is not payment approval.',
  'Use a reviewed, crash-safe purchase runner; none is implemented or enabled.',
  'Reconcile existing orders and payments before any retry; independently verify payment and publication.'
]);

const identityOf=(t,p)=>({chain:t.chain,tokenAddress:t.chain==='solana'?t.address:t.address.toLowerCase(),proposalId:p.id,approvedPayloadHash:p.payloadHash});
function matchesApproval(t,p,r) {
  try{return r.id==='padre_'+payloadHash(identityOf(t,p)).slice(2)&&r.provider==='padre'&&p.payload.provider==='padre'&&
      r.payloadHash===p.payloadHash&&r.type===p.type&&r.chain===t.chain&&r.tokenAddress===p.payload.tokenAddress&&
      r.expiresAt===p.payload.expiresAt&&payloadHash({type:r.type,payload:r.payload})===p.payloadHash;
  }catch{return false;}
}
function stateOf(t,r,now) {
  const p=(t.proposals||[]).find(p=>p.id===r.proposalId);
  if(!p||p.status!=='approved'||p.cancelledAt||p.revokedAt)return 'revoked';
  if((t.dexPreparations||[]).filter(x=>x.proposalId===r.proposalId).length!==1||
    !matchesApproval(t,p,r)||payloadHash({type:p.type,payload:p.payload})!==r.payloadHash)return 'approval_changed';
  if(now>=Date.parse(r.expiresAt))return 'expired';
  try{assertDexApprovalMetadata(t,{proposalId:p.id,approvedPayloadHash:p.payloadHash},now);}catch{return 'approval_changed';}
  if((t.dexPayments||[]).some(x=>x.proposalId===r.proposalId))return 'payment_review_required';
  return r.type==='DEX_BOOST'?'support_unverified':'awaiting_account';
}
export function padrePreparationsOf(t,now=Date.now()) {
  return (t.dexPreparations||[]).map(r=>({
    id:r.id,proposalId:r.proposalId,payloadHash:r.payloadHash,provider:'padre',type:r.type,
    chain:r.chain,tokenAddress:r.tokenAddress,state:stateOf(t,r,now),reason:reasons[stateOf(t,r,now)],
    createdAt:r.createdAt,expiresAt:r.expiresAt,automaticPayment:false,actionable:false
  }));
}
export function createPadrePipeline({persist,now=Date.now}={}) {
  if(typeof persist!=='function')throw new Error('Durable persistence is required');
  function validate(t,body) {
    const p=assertApprovedDexPurchase(t,body,now());
    if(p.payload.provider!=='padre')throw fail(409,'A new Padre-specific community vote is required; old payment approvals cannot be rerouted');
    if((t.dexPayments||[]).some(r=>r.proposalId===p.id))throw fail(409,'An existing payment attempt requires review; do not create a second purchase');
    return p;
  }
  function existing(t,p) {
    const matches=(t.dexPreparations||[]).filter(r=>r.proposalId===p.id),r=matches[0];
    if(matches.length>1||(r&&!matchesApproval(t,p,r)))
      throw fail(409,'Stored preparation differs from approval; operator review required');
    return r;
  }
  function prepare(t,body) {
    const p=validate(t,body),old=existing(t,p);
    if(old)return {preparation:padrePreparationsOf(t,now()).find(r=>r.proposalId===p.id),duplicate:true};
    if((t.dexPreparations||[]).length>=100)throw fail(409,'Preparation history is full; operator review required');
    const identity=identityOf(t,p);
    const r={id:'padre_'+payloadHash(identity).slice(2),proposalId:p.id,payloadHash:p.payloadHash,provider:'padre',
      type:p.type,chain:t.chain,tokenAddress:p.payload.tokenAddress,payload:structuredClone(p.payload),
      createdAt:new Date(now()).toISOString(),expiresAt:p.payload.expiresAt};
    const before=t.dexPreparations,previous=['agentStatus','agentReason','result'].map(k=>[k,Object.hasOwn(p,k),p[k]]);
    t.dexPreparations=[...(before||[]),r];
    p.agentStatus='paused';p.agentReason=REASON;p.result={preparationState:r.type==='DEX_BOOST'?'support_unverified':'awaiting_account',provider:'padre',paymentState:null,fulfillment:'not_verified'};
    try{persist();}catch(e){if(before===undefined)delete t.dexPreparations;else t.dexPreparations=before;for(const [k,exists,value]of previous){if(exists)p[k]=value;else delete p[k];}throw e;}
    return {preparation:padrePreparationsOf(t,now()).find(x=>x.proposalId===p.id),duplicate:false};
  }
  function handoff(t,body) {
    const p=validate(t,body),r=existing(t,p);
    if(!r)throw fail(404,'Prepare this approved request first');
    // Inert data, not a browser script or executable provider request. No secrets.
    return {schemaVersion:1,provider:'padre',portalUrl:PORTAL,proposalId:p.id,approvedPayloadHash:p.payloadHash,
      approvedContent:structuredClone(r.payload),automaticPayment:false,actionable:false,requiredChecks:[...requiredChecks]};
  }
  return Object.freeze({prepare,handoff});
}
