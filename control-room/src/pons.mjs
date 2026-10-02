// Pons V2 (Robinhood Chain launchpad): tokens are launched ON PONS from the creator's
// own wallet — one transaction creates the token, its bonding curve and the first buy.
// The token's creator-tax recipient is set to the Gateway treasury wallet, so every
// buy and sell on the curve sends the creator tax (ETH) straight into the treasury
// that pays for the machine and the AI. The site never holds the creator's keys: it
// only encodes the call and, once mined, reads the receipt to bind the channel.
//
// ABI recovered from Ponstream's client (2026-09-15) and checked against the launch
// tx 0xbd022b65… on robin.etherscan.io. Contracts (chain 4663):
//   router  0xe33e9e479df8802cb0866d5d05258bec4cf62948  "pons: Launch and Buy" — launchAndBuy, buy, sell
//   factory 0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e  "pons: V2 Factory"     — launchFee, getLaunchedToken, TokenLaunched
import { ethers } from "ethers";
import { env } from "./env.mjs";

export const CHAIN_ID = 4663;
export const ROUTER = "0xe33e9e479df8802cb0866d5d05258bec4cf62948";
export const FACTORY = "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e";
export const EXPLORER = "https://robin.etherscan.io";
export const PONS_APP = "https://www.ponsfamily.com/launchpad/";
const NATIVE = ethers.ZeroAddress;

export const ROUTER_ABI = [
  "function launchAndBuy((string name,string symbol,string logo,string description,(string twitter,string telegram,string discord,string website,string farcaster) socials,address creatorFeeRecipient,uint16 creatorTaxBps,bool buybackEnabled,bytes32 expectedEconomics,bytes32 salt) params,uint256 launchConfigId,address pairToken,uint256 quoteIn,uint256 minTokensOut,address recipient,address[] snipeTaxExemptions) payable returns (address token,address curve,uint256 tokensOut)",
  "function buy(address token,address curve,uint256 quoteIn,uint256 minTokensOut,address recipient) payable returns (uint256 tokensOut,uint256 quoteSpent,uint256 platformFee)",
  "function sell(address token,address curve,uint256 tokensIn,uint256 minQuoteOut,address recipient) returns (uint256 quoteOut,uint256 platformFee)",
];
export const FACTORY_ABI = [
  "function launchFee() view returns (uint256)",
  "function launchEnabled() view returns (bool)",
  "function canLaunch(address launcher) view returns (bool)",
  "function previewLaunchEconomics(uint256 launchConfigId,address pairToken) view returns (bytes32)",
  "function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists) launched)",
  "event TokenLaunched(address indexed token,address indexed curve,address indexed deployer,address pairToken,uint256 launchConfigId,uint256 graduationThreshold)",
];
export const CURVE_ABI = [
  "function getReserves() view returns (uint256 quoteReserve,uint256 tokenReserve)",
  "function feeBps() view returns (uint256)",
  "function creatorTaxBps() view returns (uint256)",
  "function graduated() view returns (bool)",
  "function readyToGraduate() view returns (bool)",
  "function sellableTokens() view returns (uint256)",
  // Verified on the sample launch: (router, buyer, 0.01 ETH, 5.74M tokens, 1% fee, 2% creator tax).
  "event CurveBuy(address indexed buyer,address indexed recipient,uint256 quoteIn,uint256 tokensOut,uint256 fee,uint256 creatorTax)",
  // Assumed mirror of CurveBuy (topic 0x8113d738…); confirmed the first time a sell is indexed.
  "event CurveSell(address indexed seller,address indexed recipient,uint256 tokensIn,uint256 quoteOut,uint256 fee,uint256 creatorTax)",
];
export const TOKEN_ABI = [
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
];
export const ROUTER_IFACE = new ethers.Interface(ROUTER_ABI);
export const FACTORY_IFACE = new ethers.Interface(FACTORY_ABI);
export const CURVE_IFACE = new ethers.Interface(CURVE_ABI);
export const TOKEN_IFACE = new ethers.Interface(TOKEN_ABI);

let providerCache = null;
export function provider() {
  const url = env("ROBINHOOD_RPC", "https://rpc.mainnet.chain.robinhood.com");
  if (!providerCache || providerCache._url !== url) { providerCache = new ethers.JsonRpcProvider(url, CHAIN_ID, { staticNetwork: true, batchMaxCount: 1 }); providerCache._url = url; }
  return providerCache;
}
const factory = () => new ethers.Contract(FACTORY, FACTORY_ABI, provider());

/// What a launch costs right now (cached 60 s): fee + the economics hash the router
/// requires for the ETH pair.
let infoCache = null;
export async function launchInfo() {
  if (infoCache && Date.now() - infoCache.at < 60_000) return infoCache.value;
  const f = factory();
  const [fee, enabled, expected] = await Promise.all([f.launchFee(), f.launchEnabled(), f.previewLaunchEconomics(0, NATIVE)]);
  infoCache = { at: Date.now(), value: { launchFeeWei: fee.toString(), launchFeeEth: ethers.formatEther(fee), enabled, expectedEconomics: expected, launchConfigId: 0, pairToken: NATIVE } };
  return infoCache.value;
}

/// Encodes launchAndBuy for the creator's wallet. The creator tax goes to `treasury`.
/// minTokensOut is 0 on purpose: the token does not exist before this transaction, so
/// nothing can front-run the first buy.
export function encodeLaunch({ name, symbol, logo = "", description = "", website = "", twitter = "", treasury, creatorTaxBps, expectedEconomics, salt, creator, quoteInWei, launchFeeWei }) {
  const params = {
    name, symbol, logo, description,
    socials: { twitter, telegram: "", discord: "", website, farcaster: "" },
    creatorFeeRecipient: ethers.getAddress(treasury), creatorTaxBps: Number(creatorTaxBps), buybackEnabled: false,
    expectedEconomics, salt,
  };
  const data = ROUTER_IFACE.encodeFunctionData("launchAndBuy", [params, 0, NATIVE, quoteInWei, 0, ethers.getAddress(creator), []]);
  const value = (BigInt(launchFeeWei) + BigInt(quoteInWei)).toString();
  return { to: ethers.getAddress(ROUTER), data, value, chainId: CHAIN_ID };
}

/// Reads a mined launch back: who sent it, which token/curve it created, and whether
/// the creator tax really points at the treasury we expected.
export async function readLaunch(txHash, { expectedCreator, expectedTreasury }) {
  const p = provider();
  // Raw JSON-RPC on purpose: no provider-side caching of a "not mined yet" answer.
  const [tx, rc] = await Promise.all([p.send("eth_getTransactionByHash", [txHash]), p.send("eth_getTransactionReceipt", [txHash])]);
  if (!tx || !rc || rc.blockNumber == null) return { status: "pending" };
  if (Number(rc.status) !== 1) return { status: "failed" };
  if (String(tx.to || "").toLowerCase() !== ROUTER) throw fail(400, "that transaction did not go to the Pons launch router");
  if (String(tx.from).toLowerCase() !== String(expectedCreator).toLowerCase()) throw fail(400, "that transaction was sent by another wallet");
  let launched = null;
  for (const l of rc.logs) {
    if (String(l.address).toLowerCase() !== FACTORY) continue;
    try { const ev = FACTORY_IFACE.parseLog({ topics: [...l.topics], data: l.data }); if (ev?.name === "TokenLaunched") launched = ev.args; } catch { /* other factory event */ }
  }
  if (!launched) throw fail(400, "the transaction was mined but contains no Pons TokenLaunched event");
  const info = await factory().getLaunchedToken(launched.token);
  if (!info.exists) throw fail(400, "Pons does not know this token");
  if (info.creatorFeeRecipient.toLowerCase() !== String(expectedTreasury).toLowerCase()) throw fail(400, "the creator-tax recipient of this token is not its Gateway treasury");
  let firstBuy = null;
  for (const l of rc.logs) {
    if (String(l.address).toLowerCase() !== launched.curve.toLowerCase()) continue;
    try { const ev = CURVE_IFACE.parseLog({ topics: [...l.topics], data: l.data }); if (ev?.name === "CurveBuy") firstBuy = { quoteIn: ev.args.quoteIn.toString(), tokensOut: ev.args.tokensOut.toString(), creatorTax: ev.args.creatorTax.toString() }; } catch { /* not a curve event */ }
  }
  return {
    status: "mined", token: launched.token.toLowerCase(), curve: launched.curve.toLowerCase(), deployer: launched.deployer.toLowerCase(), pairToken: launched.pairToken.toLowerCase(),
    graduationThreshold: launched.graduationThreshold.toString(), creatorTaxBps: Number(info.creatorTaxBps), block: Number(rc.blockNumber), txHash, firstBuy,
  };
}

/// Live curve state: price in quote per whole token, reserves, graduation progress.
export async function curveState(token, curve) {
  const p = provider();
  const c = new ethers.Contract(curve, CURVE_ABI, p);
  const t = new ethers.Contract(token, TOKEN_ABI, p);
  const [reserves, graduated, supply, info] = await Promise.all([c.getReserves(), c.graduated().catch(() => false), t.totalSupply(), factory().getLaunchedToken(token)]);
  const quote = reserves[0], tokens = reserves[1];
  const priceWeiPerToken = tokens > 0n ? (quote * 10n ** 18n) / tokens : 0n;   // wei per 1e18 token units = wei per whole token
  return {
    quoteReserveEth: Number(ethers.formatEther(quote)), tokenReserve: Number(ethers.formatEther(tokens)), totalSupply: Number(ethers.formatEther(supply)),
    priceEth: Number(ethers.formatEther(priceWeiPerToken)), graduated: !!graduated, phase: Number(info.phase),
    graduationThresholdEth: Number(ethers.formatEther(info.graduationThreshold)), creatorTaxBps: Number(info.creatorTaxBps),
  };
}

const fail = (status, message) => Object.assign(new Error(message), { status });
