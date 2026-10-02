// Runs ONLY on the central gateway VPS. Agent VPSs never get wallet custody.
import {createCommunitySigner} from './community-signer.mjs';
import {createCommunityEvmAdapter,validCommunityPolicy} from './community-evm-adapter.mjs';
import {reviewedCommunitySigner} from './community-signer-policy.mjs';
import {verifyProposalChain} from './market.mjs';
import {refreshTreasury,rhRpc} from './billing.mjs';
import {opsSigner} from './wallets.mjs';
import {nativeUsd} from './relay.mjs';
import {saveDurable,get} from './store.mjs';
import {heldUsage} from './usage-budget.mjs';
import {createWalletPreview} from './wallet-preview.mjs';

export function communityActionEnabled(t,type) {
  const policy=reviewedCommunitySigner(t);
  return validCommunityPolicy(policy)&&policy.types.includes(type)&&t.chain==='robinhood'&&t.governanceVersion===2;
}
export function communitySignerStatus(t) {
  const readyTypes=['TREASURY_BUY','TREASURY_BURN'].filter(type=>communityActionEnabled(t,type));
  return {execution:readyTypes.length>0,readyTypes,status:readyTypes.length?'reviewed_adapter':'contract_review_required',
    reason:readyTypes.length?'Supported actions go through the central VPS after a valid closed vote and fresh transaction checks.':'No reviewed contract adapter is active for this project. Approval cannot move funds.'};
}
function adapterFor(t,p) {
  if(!communityActionEnabled(t,p.type))return null;
  return createCommunityEvmAdapter({policy:reviewedCommunitySigner(t),provider:rhRpc(),
    signerFor:()=>opsSigner.treasury(t.address,rhRpc()),
    nativePrice:async()=>{const observedAt=Date.now();const dollars=await nativeUsd(4663,undefined,undefined,0);
      return {microsPerNative:Math.ceil(dollars*1e6),observedAt};}});
}
export const communitySigner=createCommunitySigner({persist:saveDurable,verifyVote:verifyProposalChain,refreshBalance:refreshTreasury,adapterFor});
export const previewWalletAction=createWalletPreview({refreshBalance:refreshTreasury,heldUsage,enabled:communityActionEnabled,
  votingHours:()=>get().settings.votingHours,
  estimate:async(t,p)=>{
    try {
    const adapter=adapterFor(t,p);if(!adapter)throw Object.assign(new Error('Reviewed adapter unavailable'),{status:409});
    // prepare only simulates; sign/broadcast are deliberately never invoked.
    const {transaction:tx}=await adapter.prepare(t,p);
    const observedAt=Date.now(),dollars=await nativeUsd(4663,undefined,undefined,0);
    return {gasLimit:tx.gasLimit,gasPrice:tx.gasPrice,value:tx.value,
      nativeBalance:(await rhRpc().getBalance(t.treasury.wallet)).toString(),priceMicros:Math.ceil(dollars*1e6),observedAt};
    } catch(e) {
      if([400,402,409,429,503].includes(e.status))throw e;
      throw Object.assign(new Error('Unable to check this transaction on the network. Please try again.'),{status:503});
    }
  }});
