// Structured community instructions only. No keys, RPC, signing or transfers here.
// A separately audited signer/receipt reconciler must be connected before execution.
export const WALLET_TYPES = Object.freeze(['TREASURY_BUY', 'TREASURY_BURN']);
export const isWalletType = type => WALLET_TYPES.includes(type);
const fail = message => Object.assign(new Error(message), {status:400});
const address = v => typeof v === 'string' && /^0x[0-9a-f]{40}$/i.test(v) && !/^0x0{40}$/i.test(v);
const integer = v => typeof v === 'string' && /^[1-9][0-9]{0,77}$/.test(v);
export function validateWalletPayload(type, p) {
  if (!isWalletType(type) || !p || typeof p !== 'object' || Array.isArray(p)) throw fail('Invalid wallet proposal');
  const common=['version','chainId','token','wallet','expiresAt','maxNetworkFeeUsdMicros'];
  const fields=common.concat(type==='TREASURY_BUY'?['maxSpendUsdMicros','maxSlippageBps']:['amountTokens','method']);
  if (fields.some(k=>!Object.hasOwn(p,k)) || Object.keys(p).some(k=>!fields.includes(k))) throw fail('Unexpected or missing wallet proposal field');
  if(p.version!==1 || !Number.isSafeInteger(p.chainId) || p.chainId<=0 || !address(p.token) || !address(p.wallet)) throw fail('Exact chain, project token and project treasury wallet required');
  if(typeof p.expiresAt!=='string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(p.expiresAt) || !Number.isFinite(Date.parse(p.expiresAt))) throw fail('Invalid approval expiry');
  if(!integer(p.maxNetworkFeeUsdMicros)) throw fail('Specify a positive maximum network fee');
  if(type==='TREASURY_BUY') {
    if(!integer(p.maxSpendUsdMicros)) throw fail('Specify a positive purchase budget');
    if(!Number.isInteger(p.maxSlippageBps)||p.maxSlippageBps<1||p.maxSlippageBps>10000) throw fail('Invalid maximum slippage');
  } else {
    if(typeof p.amountTokens!=='string'||! /^(0|[1-9][0-9]{0,59})(\.[0-9]{1,18})?$/.test(p.amountTokens)||!/[1-9]/.test(p.amountTokens)) throw fail('Specify a positive exact token amount without commas or exponents');
    // Transfers to a dead address are NOT represented as a total-supply burn.
    if(p.method!=='burn') throw fail('Only a verified token burn method is supported');
  }
  return p;
}
export function validateNewWalletProposal(t,type,p,{chainId,votingHours,now=Date.now()}) {
  validateWalletPayload(type,p);
  if(t.governanceVersion!==2) throw fail('Wallet actions require total-supply governance');
  if(p.chainId!==chainId || p.token.toLowerCase()!==t.address.toLowerCase() || p.wallet.toLowerCase()!==String(t.treasury?.wallet||'').toLowerCase()) throw fail('Proposal must use this project token and treasury on its own chain');
  const end=now+Number(votingHours)*3600000,expiry=Date.parse(p.expiresAt);
  if(!Number.isFinite(end)||expiry<=end||expiry>end+7*86400000) throw fail('Approval must expire after voting and within seven days of it');
}
export function walletPolicyOf(t,chainId,capability=null) {
  return {version:1,chainId,token:t.address,wallet:t.treasury?.wallet||null,
    proposals:t.governanceVersion===2,execution:false,status:'signer_not_connected',
    reason:'Trading and burning are not connected. Approved proposals cannot move funds yet.',
    types:WALLET_TYPES,requires:'More than 15% of total supply, more yes than no, and voting closed',...(capability||{})};
}
export function finalizeWalletProposal(p) {
  if(!isWalletType(p.type)||p.status!=='approved')return;
  p.agentStatus='paused';
  p.agentReason='Awaiting central VPS validation and an available project agent. No purchase or burn has been submitted.';
  p.result={executionState:'blocked',reason:'signer_not_connected',transactionHash:null};
}
