// Trusted Unix-socket adapter. No network, runtime state, keys or signer imported.
const ADDRESS=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/,SIG=/^[1-9A-HJ-NP-Za-km-z]{64,88}$/,ID=/^[a-f0-9]{64}$/;
const STATES=new Set(['waiting','signed','submitted','uncertain','confirmed','failed','expired','review']);
export function createPumpFeeSponsorClient({call,feePayer}={}){
 if(typeof call!=='function'||!ADDRESS.test(feePayer||''))throw new TypeError('A pinned platform payer and trusted broker transport are required');
 return Object.freeze({feePayer,async claim({mint,treasury,intentId}){
  if(!ADDRESS.test(mint||'')||!ADDRESS.test(treasury||'')||!ID.test(intentId||'')||treasury===feePayer)throw Error('Invalid sponsored creator-fee binding');
  const response=await call('POST','/pump-creator-fee-claim',{mint,treasury,intentId});
  if(response?.status!==200)throw Object.assign(new Error('Platform creator-fee sponsor is unavailable'),{code:'creator_fee_sponsor_unavailable'});
  const r=response.json;
  if(!r||r.mint!==mint||r.treasury!==treasury||!STATES.has(r.state))throw Error('Sponsored creator-fee result has the wrong project binding');
  if(r.intentId!==intentId){if(r.requestedIntentId===intentId&&ID.test(r.intentId||''))return {state:'waiting',reason:'previous_claim_pending',intentId,mint,treasury};throw Error('Sponsored creator-fee result has the wrong intent');}
  if(r.state!=='waiting'&&(r.feePayer!==feePayer||!SIG.test(r.signature||'')))throw Error('Sponsored creator-fee result has the wrong payer or signature');
  if(r.state==='confirmed'&&(!Number.isSafeInteger(r.claimedLamports)||r.claimedLamports<=0||!Number.isSafeInteger(r.networkFeeLamports)||r.networkFeeLamports<0||r.networkFeeLamports>25000||!Number.isSafeInteger(r.slot)||r.slot<0))throw Error('Sponsored creator-fee receipt is incomplete');
  return {state:r.state,intentId,mint,treasury,feePayer:r.feePayer||null,signature:r.signature||null,claimedLamports:r.claimedLamports??null,networkFeeLamports:r.networkFeeLamports??null,slot:r.slot??null,reason:typeof r.reason==='string'&&/^[A-Z_]{1,64}$/.test(r.reason)?r.reason:null};
 }});
}
