// Central custody adapter. No model-supplied transaction bytes or destinations.
// A source-reviewed immutable deployment policy is mandatory, not just an ABI.
import {ethers} from 'ethers';
import {payloadHash} from './canonical.mjs';
import {validateWalletPayload} from './wallet-proposals.mjs';

const TOKEN=new ethers.Interface(['function burn(uint256)','function decimals() view returns(uint8)',
  'function balanceOf(address) view returns(uint256)','function totalSupply() view returns(uint256)',
  'event Transfer(address indexed from,address indexed to,uint256 value)']);
const FACTORY=new ethers.Interface(['function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists) launched)']);
const CURVE=new ethers.Interface(['function graduated() view returns(bool)','function token() view returns(address)',
  'function factory() view returns(address)','function pairToken() view returns(address)','function sellableTokens() view returns(uint256)',
  'function buy(uint256 quoteIn,uint256 minTokensOut,address recipient) payable returns(uint256 tokensOut)',
  'event CurveBuy(address indexed buyer,address indexed recipient,uint256 quoteIn,uint256 tokensOut,uint256 fee,uint256 tax)']);
const PONS_FACTORY='0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e';
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const requireThat=(ok,message)=>{if(!ok)throw Object.assign(new Error(message),{status:409});};
const unit=10n**18n;
const usd=(wei,price)=>(BigInt(wei)*BigInt(price)+unit-1n)/unit;
const serial=tx=>Object.fromEntries(Object.entries(tx).map(([k,v])=>[k,typeof v==='bigint'?v.toString():v]));
// Retry only an explicitly underpriced, read-only simulation. Never retry a
// signature or broadcast, and never alter an intent already returned to custody.
const underpriced=e=>/max fee per gas less than block base fee|gas price less than (?:block )?base fee/i.test(
  [e?.message,e?.shortMessage,e?.info?.error?.message,e?.error?.message].filter(Boolean).join(' '));
export function validCommunityPolicy(p) {
  return !!p && p.version===1 && p.chainId===4663 && p.immutable===true
    && typeof p.review==='string' && p.review.trim().length>=12
    && [p.projectToken,p.wallet].every(x=>/^0x[0-9a-f]{40}$/i.test(x||''))
    && /^0x[0-9a-f]{64}$/i.test(p.tokenCodeHash||'')
    && Array.isArray(p.types) && p.types.length>0 && p.types.every(x=>['TREASURY_BUY','TREASURY_BURN'].includes(x))
    && (!p.types.includes('TREASURY_BURN')||p.burnMethod==='burn(uint256)')
    && (!p.types.includes('TREASURY_BUY')||p.buyMethod==='curve.buy(uint256,uint256,address)'&&same(p.factory,PONS_FACTORY)
      && /^0x[0-9a-f]{40}$/i.test(p.curve||'')
      && [p.factoryCodeHash,p.curveCodeHash].every(x=>/^0x[0-9a-f]{64}$/i.test(x||'')));
}
export function createCommunityEvmAdapter({policy,provider,signerFor,nativePrice,now=Date.now}) {
  requireThat(validCommunityPolicy(policy),'Source-reviewed immutable contract policy required');
  const pin=JSON.parse(JSON.stringify(policy));
  const policyHash=payloadHash(pin);
  async function read(address,iface,fn,args=[],blockTag='latest',from) {
    const raw=await provider.call({to:address,data:iface.encodeFunctionData(fn,args),blockTag,...(from?{from}:{})});
    return iface.decodeFunctionResult(fn,raw);
  }
  function own(t,p) {
    validateWalletPayload(p.type,p.payload);
    requireThat(pin.types.includes(p.type)&&same(t.address,pin.projectToken)&&same(p.payload.token,pin.projectToken)
      && same(t.treasury.wallet,pin.wallet)&&same(p.payload.wallet,pin.wallet)&&p.payload.chainId===pin.chainId,'Action outside reviewed project policy');
  }
  async function code(address,hash) {
    const bytes=await provider.getCode(address);
    requireThat(bytes!=='0x'&&same(ethers.keccak256(bytes),hash),'Contract bytecode changed or unavailable');
  }
  async function chain(t,p) {
    own(t,p);
    requireThat(BigInt(await provider.send('eth_chainId',[]))===BigInt(pin.chainId),'Wrong RPC chain');
    await code(pin.projectToken,pin.tokenCodeHash);
    if(p.type==='TREASURY_BUY') {
      await Promise.all([code(pin.factory,pin.factoryCodeHash),code(pin.curve,pin.curveCodeHash)]);
      const [launch]=await read(pin.factory,FACTORY,'getLaunchedToken',[pin.projectToken]);
      const [[graduated],[curveToken],[curveFactory],[pairToken]]=await Promise.all(['graduated','token','factory','pairToken'].map(fn=>read(pin.curve,CURVE,fn)));
      requireThat(launch.exists&&same(launch.token,pin.projectToken)&&same(launch.curve,pin.curve)
        &&same(launch.pairToken,ethers.ZeroAddress)&&same(pairToken,ethers.ZeroAddress)&&same(curveToken,pin.projectToken)
        &&same(curveFactory,pin.factory)&&graduated===false,'Only the reviewed native Pons bonding curve is supported');
    }
  }
  async function price() {
    const q=await nativePrice();
    requireThat(Number.isSafeInteger(q?.microsPerNative)&&q.microsPerNative>0&&Number.isSafeInteger(q.observedAt)
      &&q.observedAt<=now()&&now()-q.observedAt<=30000,'Fresh native USD price required');
    return q.microsPerNative;
  }
  async function prepare(t,p) {
    await chain(t,p);
    const x=p.payload,cost=await price();
    let data,value=0n,evidence;
    if(p.type==='TREASURY_BUY') {
      requireThat(x.maxSlippageBps<10000,'Zero minimum output is not permitted');
      value=BigInt(x.maxSpendUsdMicros)*unit/BigInt(cost);
      requireThat(value>0n,'Purchase is below native precision');
      const probe=CURVE.encodeFunctionData('buy',[value,1n,pin.wallet]);
      const result=CURVE.decodeFunctionResult('buy',await provider.call({from:pin.wallet,to:pin.curve,data:probe,value}));
      const [sellable]=await read(pin.curve,CURVE,'sellableTokens');
      requireThat(result.tokensOut<sellable,'Purchase would exhaust the curve; reduce the budget and propose again');
      const minimum=result.tokensOut*BigInt(10000-x.maxSlippageBps)/10000n;
      requireThat(minimum>0n,'Invalid simulated purchase quote');
      data=CURVE.encodeFunctionData('buy',[value,minimum,pin.wallet]);
      evidence={minimum:minimum.toString()};
    } else {
      const [decimals]=await read(pin.projectToken,TOKEN,'decimals');
      requireThat(decimals>=0n&&decimals<=18n,'Unsupported token decimals');
      const amount=ethers.parseUnits(x.amountTokens,Number(decimals));
      const [balance]=await read(pin.projectToken,TOKEN,'balanceOf',[pin.wallet]);
      requireThat(amount>0n&&balance>=amount,'Treasury does not hold the approved burn amount');
      data=TOKEN.encodeFunctionData('burn',[amount]);evidence={amount:amount.toString()};
    }
    const [pending,latest]=await Promise.all([provider.getTransactionCount(pin.wallet,'pending'),provider.getTransactionCount(pin.wallet,'latest')]);
    requireThat(pending===latest&&Number.isSafeInteger(pending),'Another treasury nonce is pending');
    const base={from:pin.wallet,to:p.type==='TREASURY_BUY'?pin.curve:pin.projectToken,data,value};
    const gasLimit=(await provider.estimateGas(base))*120n/100n;
    requireThat(gasLimit>0n&&gasLimit<=3000000n,'Unreasonable transaction gas requirement');
    const preparedAt=now();
    for(let attempt=0;attempt<3;attempt++) {
      // Fetch AFTER estimateGas; modest headroom tolerates new blocks during
      // validation. The full buffered cost still has to fit the voted USD cap.
      const fees=await provider.getFeeData();
      requireThat(typeof fees.gasPrice==='bigint'&&fees.gasPrice>0n,'Network fee unavailable');
      const gasPrice=(fees.gasPrice*125n+99n)/100n;
      const tx=serial({to:base.to,data,value,gasLimit,gasPrice,type:0,nonce:pending,chainId:pin.chainId});
      const prepared={transaction:tx,evidence,preparedAt,policyHash};
      try {await revalidate(t,p,prepared);return prepared;}
      catch(e) {if(e.code!=='FEE_QUOTE_STALE'||attempt===2)throw e;}
    }
  }
  function intent(t,p,prepared) {
    own(t,p);
    const tx=prepared.transaction;
    requireThat(prepared.policyHash===policyHash&&tx.chainId===pin.chainId&&tx.type===0&&Number.isSafeInteger(tx.nonce)
      &&tx.nonce>=0&&Object.keys(tx).sort().join(',')==='chainId,data,gasLimit,gasPrice,nonce,to,type,value','Invalid transaction intent');
    requireThat(BigInt(tx.gasLimit)>0n&&BigInt(tx.gasLimit)<=3000000n&&BigInt(tx.gasPrice)>0n,'Invalid bounded gas');
    if(p.type==='TREASURY_BUY') {
      const a=CURVE.decodeFunctionData('buy',tx.data);
      requireThat(same(tx.to,pin.curve)&&same(a.recipient,pin.wallet)
        &&a.quoteIn===BigInt(tx.value)&&a.quoteIn>0n&&a.minTokensOut===BigInt(prepared.evidence.minimum)&&a.minTokensOut>0n,'Purchase transaction does not match approved scope');
    } else {
      const a=TOKEN.decodeFunctionData('burn',tx.data);
      requireThat(same(tx.to,pin.projectToken)&&BigInt(tx.value)===0n&&a[0]===BigInt(prepared.evidence.amount)&&a[0]>0n,'Burn transaction does not match approved scope');
    }
  }
  async function revalidate(t,p,prepared) {
    await chain(t,p);intent(t,p,prepared);
    finalCheck(t,p,prepared);
    const tx=prepared.transaction,priceMicros=await price();
    requireThat(usd(tx.value,priceMicros)<=BigInt(p.payload.maxSpendUsdMicros||'0')
      &&usd(BigInt(tx.gasLimit)*BigInt(tx.gasPrice),priceMicros)<=BigInt(p.payload.maxNetworkFeeUsdMicros),'Transaction exceeds voted USD limits');
    const [balance,pending,latest]=await Promise.all([provider.getBalance(pin.wallet),provider.getTransactionCount(pin.wallet,'pending'),provider.getTransactionCount(pin.wallet,'latest')]);
    requireThat(pending===tx.nonce&&latest===tx.nonce,'Treasury nonce changed');
    requireThat(balance>=BigInt(tx.value)+BigInt(tx.gasLimit)*BigInt(tx.gasPrice),'Insufficient native funds including gas');
    if(p.type==='TREASURY_BURN') {
      const [decimals]=await read(pin.projectToken,TOKEN,'decimals');
      requireThat(ethers.parseUnits(p.payload.amountTokens,Number(decimals))===BigInt(prepared.evidence.amount),'Burn amount changed');
    }
    try {await provider.call({...tx,from:pin.wallet});}
    catch(e) {
      if(underpriced(e))throw Object.assign(new Error('Network fee changed; refresh the transaction preview'),{status:409,code:'FEE_QUOTE_STALE'});
      throw e;
    }
  }
  function finalCheck(t,p,prepared) {
    intent(t,p,prepared);
    requireThat(Number.isSafeInteger(prepared.preparedAt)&&prepared.preparedAt<=now()&&now()-prepared.preparedAt<=30000,'Transaction quote expired');
    requireThat(Date.parse(p.payload.expiresAt)>now(),'Approval expired');
  }
  async function verifySigned(t,prepared,signed) {
    const tx=ethers.Transaction.from(signed.raw),want=prepared.transaction;
    requireThat(same(tx.from,pin.wallet)&&same(tx.hash,signed.hash),'Incorrect signing identity');
    for(const k of Object.keys(want)) requireThat(String(tx[k]).toLowerCase()===String(want[k]).toLowerCase(),'Signed transaction differs from approved intent');
    requireThat(tx.accessList==null&&tx.authorizationList==null,'Unexpected transaction authorization');
  }
  async function receipt(t,p,r) {
    intent(t,p,r.prepared);
    const checkedAt=now(),rc=await provider.getTransactionReceipt(r.transactionHash);
    if(!rc)return null;
    const [finalized,canonical,tx]=await Promise.all([provider.getBlock('finalized'),provider.getBlock(rc.blockNumber),provider.getTransaction(r.transactionHash)]);
    if(!finalized||finalized.number<rc.blockNumber)return null;
    requireThat(same(canonical?.hash,rc.blockHash)&&same(rc.hash,r.transactionHash)&&same(tx?.from,pin.wallet),'Receipt not canonical or wrong sender');
    for(const [k,v] of Object.entries(r.prepared.transaction)) requireThat(String(tx[k]).toLowerCase()===String(v).toLowerCase(),'Mined transaction differs from intent');
    requireThat(rc.status===0||rc.status===1,'Unknown receipt status');
    if(rc.status===1) {
      let amount=0n;
      for(const log of rc.logs) {
        if(!same(log.address,pin.projectToken))continue;
        try {const ev=TOKEN.parseLog(log);if(ev?.name==='Transfer'&&(p.type==='TREASURY_BUY'?same(ev.args.to,pin.wallet):same(ev.args.from,pin.wallet)&&same(ev.args.to,ethers.ZeroAddress)))amount+=ev.args.value;}catch{}
      }
      if(p.type==='TREASURY_BUY') {
        const buys=rc.logs.filter(l=>same(l.address,pin.curve)).map(l=>{try{return CURVE.parseLog(l);}catch{return null;}}).filter(e=>e?.name==='CurveBuy'&&same(e.args.buyer,pin.wallet)&&same(e.args.recipient,pin.wallet));
        requireThat(buys.length===1,'Receipt lacks a unique treasury CurveBuy event');
        const ev=buys[0].args,value=BigInt(r.prepared.transaction.value);
        requireThat(ev.quoteIn>0n&&ev.quoteIn<=value&&ev.tokensOut===amount&&amount>0n
          &&ev.quoteIn*BigInt(r.prepared.evidence.minimum)<=value*amount,'Receipt violates the voted purchase price bound');
      } else requireThat(amount===BigInt(r.prepared.evidence.amount),'Receipt lacks the required token transfer/burn');
      if(p.type==='TREASURY_BURN') {
        const [[before],[after]]=await Promise.all([read(pin.projectToken,TOKEN,'totalSupply',[],rc.blockNumber-1),read(pin.projectToken,TOKEN,'totalSupply',[],rc.blockNumber)]);
        requireThat(before-after>=amount,'Burn did not reduce total supply');
      }
    }
    return {finalized:true,success:rc.status===1,transactionHash:r.transactionHash,blockNumber:rc.blockNumber,blockHash:rc.blockHash,checkedAt};
  }
  return {chainId:pin.chainId,policyHash,prepare,revalidate,finalCheck,verifySigned,receipt,
    async sign(t,prepared) {const signer=await signerFor(t);requireThat(same(await signer.getAddress(),pin.wallet),'Custody wallet mismatch');
      const raw=await signer.signTransaction(prepared.transaction);return {raw,hash:ethers.keccak256(raw)};},
    async broadcast(raw) {return (await provider.broadcastTransaction(raw)).hash;}};
}
