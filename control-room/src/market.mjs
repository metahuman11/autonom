// The market of a Pons-launched token, read from the chain: holders from Transfer
// logs, trades from the curve's CurveBuy/CurveSell logs, the price from reserves,
// candles from the trades. Runs every ~20 s per token; nothing is trusted from
// anywhere but the chain. Holder balances feed the same quota/vote logic the
// simulation used, so the agent's community is the token's real community.
import { ethers } from "ethers";
import { get, save, event } from "./store.mjs";
import { env } from "./env.mjs";
import { provider, CURVE_IFACE, TOKEN_IFACE, curveState } from "./pons.mjs";
import { rollEpochFor } from "./economy.mjs";
import { createSolanaMarket, candleize, solanaRpcUrl } from "./solana-market.mjs";

// Chain dispatch: a token with chain 'solana' is served by solana-market.mjs (Helius +
// DexScreener), everything else by the Pons indexer below. The Pons provider is never
// called for a Solana token. Candles are built by the same function on both chains.
export { candleize };
export const isSolanaToken = (t) => t?.chain === "solana";
let solanaCache = null;
export function solanaMarket() {
  const url = solanaRpcUrl();
  if (!solanaCache || solanaCache.url !== url) solanaCache = { url, market: createSolanaMarket({ rpcUrl: url }) };   // chain data only: Helius RPC + the treasury's SOL/USD oracle
  return solanaCache.market;
}

const LOG_CHUNK = 5_000;
const MAX_TRADES = 3_000;
const CANDLE_SECONDS = { "1m": 60, "5m": 300, "1h": 3600 };
let timer = null;
let busy = false;

const topicBuy = CURVE_IFACE.getEvent("CurveBuy").topicHash;
const topicSell = CURVE_IFACE.getEvent("CurveSell").topicHash;
const topicTransfer = TOKEN_IFACE.getEvent("Transfer").topicHash;

function ensure(t) {
  t.market ||= { lastBlock: t.onchain.launchBlock - 1, trades: [], balancesWei: {}, candles: {}, price: null, updatedAt: null, error: null };
  return t.market;
}

async function getLogs(filter, from, to) {
  const out = [];
  for (let a = from; a <= to; a += LOG_CHUNK) {
    const b = Math.min(to, a + LOG_CHUNK - 1);
    out.push(...await provider().getLogs({ ...filter, fromBlock: a, toBlock: b }));
  }
  return out;
}

/// One incremental pass over a token's chain history.
export async function indexToken(t) {
  if (isSolanaToken(t)) {
    const m = await solanaMarket().indexToken(t);
    if (!Object.keys(t.epoch?.weights || {}).length && Object.keys(t.balances || {}).length) rollEpochFor(t);
    return m;
  }
  const m = ensure(t);
  const p = provider();
  const head = await p.getBlockNumber();
  const from = m.lastBlock + 1, to = head;
  if (to >= from) {
    const [transfers, curveLogs] = await Promise.all([
      getLogs({ address: t.address, topics: [topicTransfer] }, from, to),
      getLogs({ address: t.curveAddress, topics: [[topicBuy, topicSell]] }, from, to),
    ]);
    for (const l of transfers) {
      const ev = TOKEN_IFACE.parseLog({ topics: [...l.topics], data: l.data });
      const fromA = ev.args.from.toLowerCase(), toA = ev.args.to.toLowerCase(), v = ev.args.value;
      if (fromA !== ethers.ZeroAddress) m.balancesWei[fromA] = (BigInt(m.balancesWei[fromA] || 0) - v).toString();
      if (toA !== ethers.ZeroAddress) m.balancesWei[toA] = (BigInt(m.balancesWei[toA] || 0) + v).toString();
    }
    const blockTs = new Map();
    for (const l of curveLogs) {
      if (!blockTs.has(l.blockNumber)) blockTs.set(l.blockNumber, (await p.getBlock(l.blockNumber)).timestamp);
      const ev = CURVE_IFACE.parseLog({ topics: [...l.topics], data: l.data });
      const buy = ev.name === "CurveBuy";
      const quote = Number(ethers.formatEther(buy ? ev.args.quoteIn : ev.args.quoteOut));
      const tokens = Number(ethers.formatEther(buy ? ev.args.tokensOut : ev.args.tokensIn));
      m.trades.push({ side: buy ? "buy" : "sell", who: ev.args.recipient.toLowerCase(), quoteEth: quote, tokens, price: tokens > 0 ? quote / tokens : 0, creatorTaxEth: Number(ethers.formatEther(ev.args.creatorTax)), tx: l.transactionHash, block: l.blockNumber, ts: blockTs.get(l.blockNumber) });
    }
    if (m.trades.length > MAX_TRADES) m.trades.splice(0, m.trades.length - MAX_TRADES);
    m.lastBlock = to;
  }
  // balances → the community the quotas and votes are computed from (curve excluded)
  const balances = {};
  for (const [a, wei] of Object.entries(m.balancesWei)) { const n = Number(ethers.formatEther(wei)); if (n > 0) balances[a] = Math.floor(n); }
  t.balances = balances;
  t.supply = Object.values(balances).reduce((s, v) => s + v, 0) || t.supply;
  if (!Object.keys(t.epoch.weights || {}).length && Object.keys(balances).some((a) => a !== t.curveAddress.toLowerCase())) rollEpochFor(t);
  const st = await curveState(t.address, t.curveAddress);
  m.price = st; m.candles = candleize(m.trades); m.updatedAt = new Date().toISOString(); m.error = null;
  return m;
}

/// One wallet's balance straight from the chain (used before accepting a message).
export async function refreshHolderBalance(t, holder) {
  if (isSolanaToken(t)) return solanaMarket().refreshHolderBalance(t, holder);
  const c = new ethers.Contract(t.address, TOKEN_IFACE, provider());
  const [wei, total] = await Promise.all([c.balanceOf(holder), c.totalSupply()]);
  t.totalSupplyWei = total.toString();
  t.supply = Number(ethers.formatEther(total));
  t.holderBalancesWei ||= {}; t.holderBalancesWei[holder.toLowerCase()] = wei.toString();
  const m = t.market; if (m) m.balancesWei[holder.toLowerCase()] = wei.toString();
  const n = Number(ethers.formatEther(wei));
  if (n > 0) t.balances[holder.toLowerCase()] = n; else delete t.balances[holder.toLowerCase()];
  return n;
}

export async function proposalSnapshot(t, holder) {
  if (isSolanaToken(t)) return solanaMarket().proposalSnapshot(t, holder);
  const rpc = provider(), block = await rpc.getBlock("latest");
  if (!block?.hash || !Number.isSafeInteger(block.number)) throw Object.assign(new Error("chain snapshot unavailable"), { status: 503 });
  const c = new ethers.Contract(t.address, TOKEN_IFACE, rpc);
  const [total, balance] = await Promise.all([c.totalSupply({ blockTag: block.number }), c.balanceOf(holder, { blockTag: block.number })]);
  if (total <= 0n) throw Object.assign(new Error("token supply unavailable"), { status: 503 });
  return { blockNumber: block.number, blockHash: block.hash, totalSupplyWei: total.toString(), proposerBalanceWei: balance.toString() };
}

// Refresh before finalization and before approved side effects. A provider which
// does not support finalized history must be configured/fixed, never guessed.
export async function verifyProposalChain(t,p) {
  if (isSolanaToken(t)) return solanaMarket().verifyProposalChain(t,p);
  const {verifyGovernanceSnapshot}=await import('./governance-guard.mjs');
  return verifyGovernanceSnapshot(t,p,tag => provider().getBlock(tag));
}
export async function verifyDueGovernance(t) {
  if (!t.onchain) return;
  for (const p of t.proposals) {
    if (p.governanceVersion !== 2 || p.status !== 'voting' || p.cancelledAt || p.revokedAt || !p.endsAt || Date.parse(p.endsAt) > Date.now()) continue;
    try {await verifyProposalChain(t,p);} catch { /* fail closed; next poll retries */ }
  }
}

export async function snapshotVoteWeight(t, proposal, holder) {
  if (isSolanaToken(t)) return solanaMarket().snapshotVoteWeight(t, proposal, holder);
  const rpc = provider(), block = await rpc.getBlock(proposal.snapshotBlock);
  if (!block?.hash || block.hash !== proposal.snapshotBlockHash) throw Object.assign(new Error("voting snapshot changed on chain; vote paused for review"), { status: 409 });
  const c = new ethers.Contract(t.address, TOKEN_IFACE, rpc);
  return (await c.balanceOf(holder, { blockTag: proposal.snapshotBlock })).toString();
}

export async function indexAll() {
  if (busy) return; busy = true;
  try {
    for (const t of Object.values(get().tokens)) {
      if (!(t.onchain?.pons || (isSolanaToken(t) && t.onchain))) continue;
      try { await indexToken(t); } catch (e) { (t.market || ensure(t)).error = e.message.slice(0, 160); }
    }
    save();
  } finally { busy = false; }
}

export function startMarketPoll(everyMs = 20_000) {
  if (timer) return timer;
  timer = setInterval(() => indexAll().catch((e) => console.error("[market]", e.message)), everyMs);
  timer.unref?.();
  indexAll().catch(() => {});
  return timer;
}

/// What the channel page shows: price, candles, recent trades, creator tax earned.
export function marketOf(t) {
  if (isSolanaToken(t)) return solanaMarket().marketOf(t);
  const m = t.market;
  if (!m) return null;
  const price = m.price || {};
  const taxEth = m.trades.reduce((s, x) => s + (x.creatorTaxEth || 0), 0);
  const vol24 = m.trades.filter((x) => x.ts >= Date.now() / 1000 - 86400).reduce((s, x) => s + x.quoteEth, 0);
  return {
    priceEth: price.priceEth ?? null, quoteReserveEth: price.quoteReserveEth ?? null, tokenReserve: price.tokenReserve ?? null, totalSupply: price.totalSupply ?? null,
    mcapEth: price.priceEth != null && price.totalSupply ? price.priceEth * price.totalSupply : null,
    graduated: !!price.graduated, phase: price.phase ?? null, graduationThresholdEth: price.graduationThresholdEth ?? null,
    progress: price.graduationThresholdEth ? Math.min(1, (price.quoteReserveEth || 0) / price.graduationThresholdEth) : null,
    creatorTaxBps: price.creatorTaxBps ?? t.onchain?.creatorTaxBps ?? null, creatorTaxEarnedEth: Number(taxEth.toFixed(6)), volume24hEth: Number(vol24.toFixed(6)),
    trades: m.trades.slice(-60).reverse(), tradeCount: m.trades.length, candles: m.candles, updatedAt: m.updatedAt, error: m.error, lastBlock: m.lastBlock,
    explorer: `https://robin.etherscan.io/token/${t.address}`, curve: t.curveAddress,
  };
}
