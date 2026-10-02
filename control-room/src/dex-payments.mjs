// Durable purchase coordinator. Default runtime is intentionally unbound.
// Only trusted operator dependencies may connect availability, a provider or a
// payment broker. No account, signing adapter or real-payment enablement here.
import {payloadHash} from './canonical.mjs';
import {assertApprovedDexPurchase as approved} from './dex-approval.mjs';
import {padrePreparationsOf} from './padre-pipeline.mjs';
import {dexCapabilities,validateDexPayload} from './dex-policy.mjs';
const fail=(status,message)=>Object.assign(new Error(message),{status});
const locked=new Set();
const held=new Set(['ordering','reviewing','payment_pending','payment_uncertain']);
const keyPattern=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const signaturePattern=/^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const orderPattern=/^[a-zA-Z0-9-]{1,128}$/;
const states=new Set(['checking','blocked','failed','paid',...held]);
const tokenKey=t=>`${t.chain}:${t.chain==='solana'?t.address:t.address.toLowerCase()}`;
const transferOf=r=>Object.fromEntries(['proposalId','payloadHash','orderUUID','payer','recipient','amountMicros','maxCostMicros','maxNetworkFeeLamports','paymentSignature'].map(k=>[k,r[k]]));
const recordHash=r=>{const {integrityHash,...fields}=r;return payloadHash(fields);};
const proposalFields=['agentStatus','agentReason','result'];
const snapshotFields=p=>proposalFields.map(k=>[k,Object.hasOwn(p,k),p[k]]);
const restoreFields=(p,snapshot)=>{for(const [k,exists,value]of snapshot){if(exists)p[k]=value;else delete p[k];}};
export function dexPaymentsOf(t) {
  const records=(t.dexPayments||[]).map(r=>Object.fromEntries(['proposalId','type','state','reason','maxCostMicros','amountMicros','heldMicros','feeLamports','paymentSignature','createdAt','updatedAt','providerNotified','fulfillment'].filter(k=>r[k]!==undefined).map(k=>[k,r[k]])));
  return {capabilities:dexCapabilities(t),accountingStatus:'not_connected',fundedMicros:null,availableMicros:null,
    confirmedSpendMicros:records.filter(r=>r.state==='paid').reduce((n,r)=>n+r.amountMicros,0),
    reservedMicros:records.reduce((n,r)=>n+(r.heldMicros||0),0),records,preparations:padrePreparationsOf(t)};
}
/**
 * bindingFor and availabilityFor are trusted operator code, never request,
 * model or token claims. An enabled broker requires explicit operational state
 * {running:true, paused:false, exhausted:false}. This is not a balance check;
 * the broker must independently verify dedicated funds and payer-wide holds.
 * Persistence must atomically save the current store (sync or async). Errors
 * retain the last acknowledged state and stop the operation. One writer only.
 */
export function createDexPayments({persist,now=Date.now,bindingFor=()=>null,availabilityFor=()=>null,enabled=false}={}) {
  if(typeof persist!=='function')throw new Error('Durable persistence is required');
  async function durable(change,rollback){
    change();
    try{await persist();}catch{rollback();throw Object.assign(fail(503,'Payment state could not be saved. Stop and reconcile; do not pay again.'),{code:'dex_persistence_failed'});}
  }
  async function update(p,r,state,reason=null,patch={}){
    const before={...r},previous=snapshotFields(p);
    await durable(()=>{
      Object.assign(r,patch,{state,reason,updatedAt:new Date(now()).toISOString()});
      r.integrityHash=recordHash(r);
      p.agentStatus=state==='paid'?'done':'paused';p.agentReason=reason;p.result={paymentState:state,fulfillment:r.fulfillment||'not_verified'};
    },()=>{for(const k of Object.keys(r))delete r[k];Object.assign(r,before);restoreFields(p,previous);});
  }
  async function available(t){
    const a=await availabilityFor(t);
    if(a?.running!==true||a?.paused!==false||a?.exhausted!==false)
      throw fail(409,'Agent is paused, offline or its operating budget is unavailable. No new payment is permitted.');
  }
  function binding(t){
    const b=enabled?bindingFor(t):null;
    return b&&b.projectAddress===t.address&&b.cluster==='mainnet-beta'&&b.acceptanceVerified===true?b:null;
  }
  function unchanged(t,reference,p){
    if(approved(t,reference,now())!==p)throw fail(403,'Approved purchase changed');
  }
  function validateRecord(t,p,r){
    // These hashes bind stored fields; they are not signatures or protection
    // against a trusted-store attacker able to rewrite every field together.
    try{
      validateDexPayload(p.type,p.payload,t);
      if((t.dexPayments||[]).filter(x=>x.proposalId===p.id).length!==1||(t.proposals||[]).filter(x=>x.id===p.id).length!==1||
        r.recordVersion!==1||r.integrityHash!==recordHash(r)||!states.has(r.state)||r.proposalId!==p.id||r.type!==p.type||r.payloadHash!==p.payloadHash||
        r.payloadHash!==payloadHash({type:p.type,payload:p.payload})||
        r.payloadHash!==payloadHash(r.approval)||r.maxCostMicros!==p.payload.maxCostMicros||
        r.maxNetworkFeeLamports!==p.payload.maxNetworkFeeLamports||p.payload.provider!==undefined)
        throw new Error('approval');
      if(r.paymentSignature&&(!signaturePattern.test(r.paymentSignature)||!orderPattern.test(r.orderUUID)||
        !keyPattern.test(r.payer)||!keyPattern.test(r.recipient)||!Number.isSafeInteger(r.amountMicros)||
        r.amountMicros<=0||r.amountMicros>r.maxCostMicros||r.transferHash!==payloadHash(transferOf(r))))throw new Error('transfer');
      if((held.has(r.state)&&r.heldMicros!==r.maxCostMicros)||
        (!held.has(r.state)&&r.heldMicros!==0)||(['paid','failed','payment_pending'].includes(r.state)&&!r.paymentSignature))throw new Error('state');
    }catch{throw Object.assign(fail(409,'Payment record or approved content changed or needs migration. Operator reconciliation required.'),{code:'dex_record_invalid'});}
  }
  async function notify(p,r,b){
    if(r.providerNotified===true)return r;
    // Paid was durably saved before notification. Rechecking may repeat only
    // this original order/signature notification, never an order or transfer.
    let acknowledged=false;
    try{acknowledged=(await b.provider.submitPayment(r.orderUUID,r.paymentSignature))?.acknowledged===true;}catch{}
    await update(p,r,'paid',acknowledged?'Payment confirmed; provider notified. Publication is not yet verified.':'Payment confirmed; provider notification needs review. Do not pay again.',{providerNotified:acknowledged});
    return r;
  }
  async function reconcile(t,p,r,b){
    validateRecord(t,p,r);
    const receipt=await b.wallet.receipt(r.paymentSignature);
    validateRecord(t,p,r);
    if(!receipt||receipt.finalized!==true)return r;
    if(receipt.signature!==r.paymentSignature||!Number.isSafeInteger(receipt.feeLamports)||receipt.feeLamports<0)throw fail(502,'Invalid chain receipt');
    if(receipt.failed===true){
      if(r.state==='paid')throw fail(502,'Receipt conflicts with the recorded finalized payment');
      await update(p,r,'failed','Payment failed on chain; network fees may have been charged. A new vote is required.',{heldMicros:0,feeLamports:receipt.feeLamports});return r;
    }
    if(receipt.failed!==false||receipt.payer!==r.payer||receipt.recipient!==r.recipient||
       receipt.currency!=='USDC'||receipt.cluster!=='mainnet-beta'||receipt.amountMicros!==r.amountMicros||
       receipt.feeLamports>r.maxNetworkFeeLamports)
      throw fail(502,'Payment receipt does not match the approved transfer');
    if(r.state!=='paid')await update(p,r,'paid','Payment confirmed on chain; profile publication is not yet verified.',
      {heldMicros:0,feeLamports:receipt.feeLamports,fulfillment:'pending_provider',providerNotified:false});
    return notify(p,r,b);
  }
  async function execute(t,body){
    const key=tokenKey(t);if(locked.has(key))throw fail(409,'A DEX purchase is already being checked');locked.add(key);
    try{
      const p=approved(t,body,now()),reference={proposalId:p.id,approvedPayloadHash:p.payloadHash};
      const intent=structuredClone(p.payload);
      if(intent.provider==='padre'||(t.dexPreparations||[]).some(r=>r.proposalId===p.id))
        throw fail(409,'Padre requests use the preparation queue; automatic payment is not connected');
      const records=t.dexPayments||[],old=records.find(r=>r.proposalId===p.id);
      const finish=()=>({payment:dexPaymentsOf(t).records.find(x=>x.proposalId===p.id)});
      if(old){validateRecord(t,p,old);return {...finish(),duplicate:true};}
      if(records.length>=100)throw fail(409,'DEX purchase history is full; operator review required');
      const r={recordVersion:1,proposalId:p.id,type:p.type,payloadHash:p.payloadHash,approval:{type:p.type,payload:intent},
        state:'checking',maxCostMicros:intent.maxCostMicros,maxNetworkFeeLamports:intent.maxNetworkFeeLamports,heldMicros:0,createdAt:new Date(now()).toISOString()};
      r.integrityHash=recordHash(r);
      const previous=t.dexPayments;
      await durable(()=>{t.dexPayments=[...records,r];},()=>{if(previous===undefined)delete t.dexPayments;else t.dexPayments=previous;});
      if(p.type==='DEX_BOOST'||t.chain!=='solana'){
        await update(p,r,'blocked',p.type==='DEX_BOOST'?'A supported Boost purchase API has not been verified.':'The legacy Bags payment flow supports Solana tokens only. A new Padre-specific vote is required for preparation.');return finish();
      }
      const b=binding(t);
      if(!b){await update(p,r,'blocked','Payment wallet/provider is not connected and acceptance-tested. No money moved.');return finish();}
      try{
        await available(t);unchanged(t,reference,p);
        // A corrupted or unmigrated prior reservation cannot be interpreted as
        // free money. Check the whole project ledger before reading balances.
        for(const record of t.dexPayments){
          const proposal=(t.proposals||[]).find(x=>x.id===record.proposalId);
          if(!proposal)throw fail(409,'Payment history requires operator reconciliation');
          validateRecord(t,proposal,record);
        }
        const funds=await b.wallet.balance();
        const reserved=t.dexPayments.filter(x=>held.has(x.state)).reduce((n,x)=>n+(x.heldMicros||0),0);
        const reservedFees=t.dexPayments.filter(x=>held.has(x.state)).reduce((n,x)=>n+(x.maxNetworkFeeLamports||0),0);
        if(!Number.isSafeInteger(funds?.availableMicros)||!Number.isSafeInteger(funds?.availableFeeLamports)||funds.availableMicros<0||funds.availableFeeLamports<0||
          funds.availableMicros-reserved<intent.maxCostMicros||funds.availableFeeLamports-reservedFees<intent.maxNetworkFeeLamports)
          throw fail(402,'Insufficient dedicated payment balance; no treasury top-up was authorized');
        if(await b.provider.available(t.address)!==true)throw fail(409,'This token is not eligible for a new Dex Update order');
        await available(t);unchanged(t,reference,p);
        await update(p,r,'ordering',null,{heldMicros:intent.maxCostMicros});
        await available(t);unchanged(t,reference,p);
        const q=await b.provider.createOrder(structuredClone(intent),b.wallet.address);
        if(q?.currency!=='USDC'||q.cluster!=='mainnet-beta'||!Number.isSafeInteger(q.priceMicros)||q.priceMicros<=0||q.priceMicros>intent.maxCostMicros||
          !orderPattern.test(q.orderUUID||'')||!keyPattern.test(q.recipientWallet||'')||!keyPattern.test(b.wallet.address||'')){
          await update(p,r,'blocked','Provider price exceeds the approved limit or the quote is invalid. No payment sent.',{heldMicros:0});return finish();
        }
        await update(p,r,'reviewing',null,{orderUUID:q.orderUUID,amountMicros:q.priceMicros,payer:b.wallet.address,recipient:q.recipientWallet});
        await available(t);unchanged(t,reference,p);
        // Trusted broker must decode all instructions, verify token owners and
        // debits, simulate, enforce fee/cluster caps and bind the exact permit.
        const signed=await b.wallet.reviewAndSign(q,{projectAddress:t.address,proposalId:p.id,payloadHash:reference.approvedPayloadHash,
          payer:r.payer,recipient:r.recipient,amountMicros:r.amountMicros,currency:'USDC',cluster:'mainnet-beta',
          maxFeeLamports:intent.maxNetworkFeeLamports,expiresAt:intent.expiresAt});
        if(signed?.reviewed!==true||signed?.simulated!==true||signed?.payloadHash!==reference.approvedPayloadHash||
          !signaturePattern.test(signed?.signature||''))throw fail(502,'Payment review or simulation failed');
        const payment={...r,paymentSignature:signed.signature};
        await update(p,r,'payment_pending',null,{paymentSignature:signed.signature,transferHash:payloadHash(transferOf(payment))});
        await available(t);unchanged(t,reference,p);validateRecord(t,p,r);
        await b.wallet.broadcast(signed); // At most once; saved identity first.
        await reconcile(t,p,r,b);
        if(r.state==='payment_pending')await update(p,r,'payment_uncertain','Awaiting independent chain confirmation. Do not pay again.');
      }catch(e){
        if(e.code==='dex_persistence_failed'||e.code==='dex_record_invalid')throw e;
        if(r.state==='paid')return finish(); // A finalized payment cannot be undone by receipt/notification errors.
        const uncertain=held.has(r.state);
        await update(p,r,uncertain?'payment_uncertain':'blocked',uncertain?'Purchase needs reconciliation. No automatic retry or second payment.':'Purchase could not proceed; check agent availability, eligibility, wallet balance and provider configuration.',uncertain?{}:{heldMicros:0});
      }
      return finish();
    }finally{locked.delete(key);}
  }
  async function checkPayment(t,body){
    const key=tokenKey(t);if(locked.has(key))throw fail(409,'Payment check already running');locked.add(key);
    try{
      if(!body||Array.isArray(body)||Object.keys(body).join(',')!=='proposalId'||typeof body.proposalId!=='string')throw fail(400,'Only a proposal id is accepted');
      const r=t.dexPayments?.find(r=>r.proposalId===body.proposalId),p=(t.proposals||[]).find(p=>p.id===body.proposalId);
      if(!r||!p)throw fail(404,'Payment not found or approved content changed');
      validateRecord(t,p,r);
      const finish=()=>({payment:dexPaymentsOf(t).records.find(x=>x.proposalId===p.id)});
      if(!r.paymentSignature||r.state==='failed'||(r.state==='paid'&&r.providerNotified===true))return finish();
      // Read-only chain reconciliation and original-order notification remain
      // possible after expiry, revocation or operational pause. Never sign/send.
      const b=binding(t);
      if(!b||b.wallet.address!==r.payer)throw fail(503,'Payment reconciliation wallet is not connected');
      try{await reconcile(t,p,r,b);}catch(e){
        if(e.code==='dex_persistence_failed'||e.code==='dex_record_invalid')throw e;
        if(r.state!=='paid')await update(p,r,'payment_uncertain','Receipt not confirmed. No payment retried.');
      }
      return finish();
    }finally{locked.delete(key);}
  }
  return Object.freeze({execute,checkPayment});
}
