// Read-only proposal preparation. No custody, reservations, signing or broadcasts.
import {validateWalletPayload} from './wallet-proposals.mjs';
const fail=(status,message)=>Object.assign(new Error(message),{status});
const UNIT=10n**18n, CENT=10000n;
const ceil=(a,b)=>(a+b-1n)/b;
export function createWalletPreview({estimate,refreshBalance,heldUsage,enabled,votingHours,now=Date.now}) {
  const inflight=new Map(),lastStarted=new Map();let active=0;
  async function calculate(t,body) {
    if(!body||Array.isArray(body)||Object.keys(body).sort().join(',')!=='amount,type'
      ||!['TREASURY_BUY','TREASURY_BURN'].includes(body.type)||typeof body.amount!=='string')throw fail(400,'Choose an action and amount');
    if(!enabled(t,body.type))throw fail(409,'Wallet actions are not available for this project yet');
    const buy=body.type==='TREASURY_BUY',hours=Number(votingHours());
    if(!Number.isFinite(hours)||hours<=0||hours>168)throw fail(503,'Voting settings unavailable');
    let spend=0n;
    if(buy){
      if(!/^(0|[1-9]\d{0,9})(\.\d{1,6})?$/.test(body.amount))throw fail(400,'Enter a positive USD amount');
      const [a,b='']=body.amount.split('.');spend=BigInt(a)*1000000n+BigInt(b.padEnd(6,'0'));
      if(spend<=0n||spend>BigInt(Number.MAX_SAFE_INTEGER))throw fail(400,'Invalid purchase amount');
    }
    const payload={version:1,chainId:4663,token:t.address,wallet:t.treasury?.wallet,
      expiresAt:new Date(now()+(hours+24)*3600000).toISOString(),maxNetworkFeeUsdMicros:'1',
      ...(buy?{maxSpendUsdMicros:spend.toString(),maxSlippageBps:100}:{amountTokens:body.amount,method:'burn'})};
    validateWalletPayload(body.type,payload);
    const key=t.address.toLowerCase();
    if(inflight.has(key)||active>=4||now()-(lastStarted.get(key)??-Infinity)<2000)throw fail(429,'Please wait a moment before checking again');
    // Bound rate-limit memory to actual project objects, with an explicit cap.
    if(!lastStarted.has(key)&&lastStarted.size>=10000)throw fail(503,'Fee preview is busy');
    lastStarted.set(key,now());inflight.set(key,true);active++;
    try{
      const wallet=t.treasury.wallet;
      await refreshBalance(t);
      const started=Date.parse(t.treasury.marketingObservationStartedAt);
      const available=t.treasury.micros-heldUsage(t);
      if(!Number.isSafeInteger(available)||available<=0||!Number.isSafeInteger(started)||started>now()||now()-started>30000)throw fail(503,'A fresh available balance is required');
      if(spend>=BigInt(available))throw fail(402,'Leave enough project funds for the network fee');
      // Temporary simulation-only ceiling. It is never returned for approval.
      payload.maxNetworkFeeUsdMicros=(BigInt(available)-spend).toString();
      const q=await estimate(t,{type:body.type,payload});
      if(wallet!==t.treasury.wallet||!enabled(t,body.type))throw fail(409,'Project wallet changed; check again');
      if(!Number.isSafeInteger(q.priceMicros)||q.priceMicros<=0||!Number.isSafeInteger(q.observedAt)||q.observedAt>now()||now()-q.observedAt>30000)throw fail(503,'Fresh network pricing unavailable');
      const gas=BigInt(q.gasLimit),price=BigInt(q.gasPrice),value=BigInt(q.value),native=BigInt(q.nativeBalance);
      if(gas<=0n||gas>3000000n||price<=0n||value<0n||native<0n)throw fail(503,'Network estimate unavailable');
      const fee=ceil(gas*price*BigInt(q.priceMicros),UNIT);
      // 2x current bounded estimate, rounded up to one cent. This is a ceiling,
      // not a charge. No percentage of the whole wallet is ever authorized.
      const cap=ceil(fee*2n,CENT)*CENT,total=spend+cap;
      const freshAvailable=t.treasury.micros-heldUsage(t);
      if(!Number.isSafeInteger(freshAvailable)||freshAvailable<0||total>BigInt(freshAvailable))throw fail(402,'Not enough unreserved project funds for this amount and network fee');
      if(value+ceil(cap*UNIT,BigInt(q.priceMicros))>native)throw fail(402,'Not enough native currency on this network for the amount and fee');
      payload.maxNetworkFeeUsdMicros=cap.toString();
      return {payload,estimatedFeeUsdMicros:fee.toString(),maximumTotalUsdMicros:total.toString(),availableUsdMicros:String(freshAvailable),
        validUntil:new Date(now()+30000).toISOString(),feePolicy:'2x current estimate rounded up to $0.01',priceProtectionBps:buy?100:null};
    }finally{active--;inflight.delete(key);}
  }
  return calculate;
}
