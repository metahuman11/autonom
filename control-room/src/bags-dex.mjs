// Fixed-origin transport only; never a wallet, browser login, or arbitrary URL proxy.
// Current REST schema uses paymentSignature (on-chain tx id), NOT serialized bytes.
import { positiveInteger, validateDexPayload } from './dex-policy.mjs';
const ORIGIN = 'https://public-api-v2.bags.fm';
const BASE = '/api/v1/solana/dexscreener/';
const fail = (code,message) => Object.assign(new Error(message),{status:502,code});
const keyPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export function priceMicros(value) {
  const s = String(value);
  if (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,6})?$/.test(s)) throw fail('invalid_quote','Invalid provider price');
  const [whole,fraction=''] = s.split('.');
  return positiveInteger(Number(BigInt(whole)*1_000_000n+BigInt(fraction.padEnd(6,'0'))),'provider price');
}
export function createBagsDexClient({apiKey,fetchImpl=fetch}={}) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey)) throw fail('not_configured','Bags account is not connected');
  async function request(path,{method='GET',body}={}) {
    let response;
    try { response=await fetchImpl(ORIGIN+BASE+path,{method,redirect:'error',signal:AbortSignal.timeout(20_000),
      headers:{'x-api-key':apiKey,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}); }
    catch { throw fail('provider_uncertain','Bags response unavailable; do not automatically repeat this order'); }
    // Do not include remote errors or request credentials in logs/public responses.
    if (!response.ok) throw fail('provider_rejected',`Bags request failed (HTTP ${response.status})`);
    const reader=response.body.getReader();let size=0;const chunks=[];
    try { while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>65_536)throw new Error('large');chunks.push(value);} }
    catch { await reader.cancel().catch(()=>{});throw fail('invalid_response','Bags returned an invalid response'); }
    let json;try{json=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail('invalid_response','Bags returned invalid JSON');}
    if (json?.success!==true) throw fail('provider_rejected','Bags did not accept the request');
    return json.response;
  }
  return Object.freeze({
    async available(tokenAddress) {
      if (!keyPattern.test(tokenAddress)) throw fail('invalid_target','Solana token required');
      const r=await request('order-availability?tokenAddress='+encodeURIComponent(tokenAddress));
      if(typeof r?.available!=='boolean')throw fail('invalid_response','Bags availability response is invalid');
      return r.available;
    },
    async createOrder(intent,payerWallet) {
      validateDexPayload('DEX_UPDATE',intent);
      if(intent.provider!==undefined)throw fail('invalid_provider','A Padre approval cannot be submitted to Bags');
      if(intent.chain!=='solana'||!keyPattern.test(payerWallet))throw fail('invalid_target','Solana token and payer required');
      const {tokenAddress,description,iconImageUrl,headerImageUrl,links}=intent;
      const r=await request('create-order',{method:'POST',body:{tokenAddress,description,iconImageUrl,headerImageUrl,links,payerWallet,payWithSol:false}});
      if(!/^[a-zA-Z0-9-]{1,128}$/.test(r?.orderUUID||'')||!keyPattern.test(r?.recipientWallet||'')||
        typeof r?.transaction!=='string'||!r.transaction.length||r.transaction.length>20_000||
        !Number.isSafeInteger(r?.lastValidBlockHeight)||r.lastValidBlockHeight<=0)throw fail('invalid_quote','Bags returned an incomplete payment order');
      return {orderUUID:r.orderUUID,recipientWallet:r.recipientWallet,priceMicros:priceMicros(r.priceUSDC),
        transaction:r.transaction,lastValidBlockHeight:r.lastValidBlockHeight,currency:'USDC',cluster:'mainnet-beta'};
    },
    async submitPayment(orderUUID,paymentSignature) {
      if(!/^[a-zA-Z0-9-]{1,128}$/.test(orderUUID)||!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(paymentSignature))throw fail('invalid_receipt','Order and payment transaction signature required');
      await request('submit-payment',{method:'POST',body:{orderUUID,paymentSignature}});
      return {acknowledged:true}; // Not proof of payment or profile publication.
    },
  });
}
