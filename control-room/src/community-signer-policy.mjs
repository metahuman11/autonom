// Operator-owned, reviewed deployments ONLY. Never populate from chat, API input,
// token metadata or an environment flag. Copying a live code hash alone is not
// a security review. Unlisted projects remain disabled.
// Schema and activation checklist: docs/community-signer.md
export const REVIEWED_COMMUNITY_SIGNERS = Object.freeze([Object.freeze({
  version:1,chainId:4663,immutable:true,
  review:'docs/metahuman1-signer-review-2026-09-19.md',
  projectToken:'0x7939C648312e1B5E6E045197E9c884586D420584',
  wallet:'0xf37F5F4D2Bc2b441fA037d36c914f0CC8dF21821',
  tokenCodeHash:'0x0a31eb75c17385fb415bfeb295102cf989e019d444ff2aa94c06580106d9bf2a',
  types:Object.freeze(['TREASURY_BUY','TREASURY_BURN']),
  burnMethod:'burn(uint256)',buyMethod:'curve.buy(uint256,uint256,address)',
  factory:'0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e',
  curve:'0x59dC904D00A9F534BE746D588c397db222F64B64',
  factoryCodeHash:'0x89a27da6f703e0a7cdd4f233e7cb57604ff75b164530962d3ff7cf8483a67d84',
  curveCodeHash:'0x265de93479004a1fbabb6b4c7261b24c387dedba1c5af5eb6b84ec8e8824c9ee'
})]);
export function reviewedCommunitySigner(t) {
  return REVIEWED_COMMUNITY_SIGNERS.find(p => p.projectToken.toLowerCase() === t.address.toLowerCase()
    && p.wallet.toLowerCase() === String(t.treasury?.wallet).toLowerCase()) || null;
}
