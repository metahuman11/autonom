// The market of a Solana project token, read from the chain alone (Helius): holders
// from DAS getTokenAccounts aggregated per owner, trades from the mint's own
// transactions measured on the TRADER's side (their token delta against their SOL or
// stablecoin delta, fees and new-account rent removed), the pool and its vaults learned
// from those same transactions, price from the last trade, market cap from the supply,
// liquidity from the vault balances, volume and candles from the indexed trades. The only
// number that is not on-chain is SOL/USD, which comes from the treasury's own price oracle
// (solana.mjs: the median of three exchanges). No DexScreener, no GeckoTerminal.
// Same output shapes as market.mjs (Pons) so the channel page, quotas and votes read the
// same keys. Runs every ~20 s per token from market.mjs; everything is injectable for
// tests; the RPC URL (which may carry the Helius key) is never logged.
import { isAddress } from "@solana/addresses";
import { env } from "./env.mjs";
import { createHash } from "node:crypto";
import { base58Decode } from "./solana.mjs";
import { PUMP_PROGRAM, decodeBondingCurve } from "./pump.mjs";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const BURN_ADDRESS = "1nc1nerator11111111111111111111111111111111";
/// pump.fun's creator fee on the bonding curve: a flat 30 bps of the SOL side of every trade
/// (curve FeeConfig, read on chain 2026-09-21), paid to the coin's creator — here the AI wallet.
export const PUMP_CURVE_CREATOR_FEE_BPS = 30;
/// The creator fee a curve trade paid, in SOL; null for anything that is not a pump.fun curve trade.
export function pumpCreatorFee(trade, t) {
  if (!t?.onchain?.pump || trade?.dex !== "pumpfun") return null;
  if (Number.isFinite(trade.creatorTaxEth)) return trade.creatorTaxEth;        // read from the trade's own event
  if (!(trade.quoteSol > 0)) return null;
  return Number((trade.quoteSol * PUMP_CURVE_CREATOR_FEE_BPS / 10_000).toFixed(9));
}
/// pump.fun's curve sells 793.1M of the 1B supply before it graduates (Global.initial_real_token_reserves, read 2026-09-21).
export const PUMP_INITIAL_REAL_TOKEN_RESERVES = 793_100_000_000_000n;
// Anchor's self-CPI event tag, then sha256("event:TradeEvent")[:8]; the fixed prefix of the event is 233 bytes.
const ANCHOR_EVENT_TAG = "e445a52e51cb9a1d";
const TRADE_EVENT_TAG = createHash("sha256").update("event:TradeEvent").digest().subarray(0, 8).toString("hex");
const TRADE_EVENT_MIN_LEN = 233;
/// pump.fun's own record of a curve trade, emitted inside every buy/sell transaction: the SOL and
/// tokens as the program moved them, both fees, and the reserves after the trade. Verified
/// byte-exact against tx 3X7SjWX… (2026-09-22); fields pump.fun appended later are ignored.
export function pumpTradeEvents(tx, mint) {
  const out = [];
  const instructions = [...(tx?.meta?.innerInstructions || []).flatMap((g) => g?.instructions || []), ...(tx?.transaction?.message?.instructions || [])];
  for (const ins of instructions) {
    if (ins?.programId !== PUMP_PROGRAM || typeof ins.data !== "string") continue;
    let d; try { d = Buffer.from(base58Decode(ins.data)); } catch { continue; }
    if (d.length < TRADE_EVENT_MIN_LEN || d.subarray(0, 8).toString("hex") !== ANCHOR_EVENT_TAG || d.subarray(8, 16).toString("hex") !== TRADE_EVENT_TAG) continue;
    let o = 16;
    const pk = () => { const v = base58Encode(d.subarray(o, o + 32)); o += 32; return v; };
    const u64 = () => { const v = d.readBigUInt64LE(o); o += 8; return v; };
    const e = { mint: pk(), solAmount: u64(), tokenAmount: u64(), isBuy: d[o++] === 1, user: pk(), timestamp: Number(d.readBigInt64LE(o)) };
    o += 8;
    Object.assign(e, { virtualSolReserves: u64(), virtualTokenReserves: u64(), realSolReserves: u64(), realTokenReserves: u64(), feeRecipient: pk(), feeBasisPoints: u64(), fee: u64(), creator: pk(), creatorFeeBasisPoints: u64(), creatorFee: u64() });
    if (e.mint === mint) out.push(e);
  }
  return out;
}
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM, TOKEN_2022_PROGRAM]);
const USD_STABLES = new Set(["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]); // USDC, USDT
// Raydium AMM v4 / CPMM pool vaults are owned by a program authority shared by every pool,
// not by the pool itself; every other venue (PumpSwap, pump.fun, Meteora, Orca, Raydium CLMM) owns its vaults.
const SHARED_VAULT_AUTHORITIES = new Set(["5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL"]);
const CURVE_DEXES = new Set(["pumpfun", "moonshot", "launchlab", "boop", "bonkfun", "believe"]);
// Program id → venue, for labelling a trade and telling a bonding curve from an AMM.
const DEX_PROGRAMS = new Map(Object.entries({
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "pumpfun",
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA": "pumpswap",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "raydium",
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C": "raydium-cpmm",
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK": "raydium-clmm",
  "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj": "launchlab",
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo": "meteora-dlmm",
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG": "meteora-damm",
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB": "meteora",
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc": "orca",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4": "jupiter",
}));
const ROUTERS = new Set(["jupiter"]);                  // a router labels nothing: the venue is the other program in the transaction
const ATA_RENT_LAMPORTS = 2_039_280n;                  // a token account created inside the swap is not part of the price
const CANDLE_SECONDS = { "1m": 60, "5m": 300, "1h": 3600 };
const MAX_TRADES = 3_000;
const CANDLE_LIMIT = 600;
const PAIRS_EVERY_MS = 30_000;
const HOLDERS_EVERY_MS = 60_000;
const MAX_HOLDER_PAGES = 25;        // 25 000 token accounts per pass; beyond that holdersTruncated is set
const MAX_TX_PAGES = 5;             // Helius full-transaction pages per pass (100 each)
const MAX_TX_FETCH_PER_PASS = 40;   // getTransaction calls per pass on a plain RPC
const MAX_SIGNATURE_PAGES = 3;
const SKIPPED_SLOT_CODES = new Set([-32004, -32007, -32009]);

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58Encode(bytes) {
  let n = 0n; for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = ""; while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = "1" + out; }
  return out;
}
const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const clip = (s) => String(s ?? "").replace(/https?:\/\/\S+/g, "[url]").slice(0, 160);
const ui = (units, decimals) => Number(units) / 10 ** Number(decimals);
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null; };
const isSkipped = (e) => SKIPPED_SLOT_CODES.has(Number(e?.code)) || /skipped|not available|missing/i.test(String(e?.message || ""));

/// Candles from trades: OHLC of `priceKey`, volume = sum of `quoteKey`, per timeframe.
/// Defaults reproduce the Pons candles (price / quoteEth / volumeEth) exactly.
export function candleize(trades, { priceKey = "price", quoteKey = "quoteEth", volumeKey = "volumeEth", limit = CANDLE_LIMIT } = {}) {
  const out = {};
  for (const [name, secs] of Object.entries(CANDLE_SECONDS)) {
    const map = new Map();
    for (const tr of trades) {
      const price = tr[priceKey];
      if (!Number.isFinite(price) || !Number.isFinite(tr.ts)) continue;
      const bucket = Math.floor(tr.ts / secs) * secs;
      const c = map.get(bucket) || { time: bucket, open: price, high: price, low: price, close: price, [volumeKey]: 0 };
      c.high = Math.max(c.high, price); c.low = Math.min(c.low, price); c.close = price; c[volumeKey] += Number(tr[quoteKey]) || 0;
      map.set(bucket, c);
    }
    out[name] = [...map.values()].sort((a, b) => a.time - b.time).slice(-limit);
  }
  return out;
}

/// Roll a 1-minute series up into a coarser timeframe (used for backfilled candles).
function rollup(minute, secs, volumeKey) {
  const map = new Map();
  for (const c of minute) {
    const bucket = Math.floor(c.time / secs) * secs;
    const r = map.get(bucket);
    if (!r) map.set(bucket, { time: bucket, open: c.open, high: c.high, low: c.low, close: c.close, [volumeKey]: c[volumeKey] || 0 });
    else { r.high = Math.max(r.high, c.high); r.low = Math.min(r.low, c.low); r.close = c.close; r[volumeKey] += c[volumeKey] || 0; }
  }
  return [...map.values()].sort((a, b) => a.time - b.time);
}

export function solanaRpcUrl() {
  const url = env("SOLANA_RPC_URL");
  if (url) return url;
  const key = env("HELIUS_API_KEY");
  return key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : "https://api.mainnet-beta.solana.com";
}

/// JSON-RPC over fetch. Params may be an array (Solana RPC) or an object (Helius DAS).
/// Errors carry the method and the node's message, never the URL.
export function createRpc({ url = solanaRpcUrl(), fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  let endpoint;
  try { endpoint = new URL(url); } catch { throw new Error("invalid Solana RPC URL"); }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && local)) throw new Error("Solana RPC URL must use https");
  let id = 0;
  return async function rpc(method, params = []) {
    const res = await fetchImpl(endpoint.href, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw fail(502, `${method}: rpc http ${res.status}`, { code: res.status === 429 ? 429 : -32000 });
    const json = await res.json().catch(() => null);
    if (!json || typeof json !== "object") throw fail(502, `${method}: malformed rpc response`);
    if (json.error) throw fail(502, `${method}: ${clip(json.error.message || "rpc error")}`, { code: Number(json.error.code), rpc: true });
    return json.result;
  };
}


/// Account keys of a transaction in first-signer order, json or jsonParsed encoding,
/// plus the addresses loaded from lookup tables (writable first, then readonly).
function accountKeysOf(tx) {
  const raw = tx?.transaction?.message?.accountKeys || [];
  const keys = raw.map((k) => (typeof k === "string" ? k : k?.pubkey)).filter(Boolean);
  const loaded = tx?.meta?.loadedAddresses;
  if (loaded) keys.push(...(loaded.writable || []), ...(loaded.readonly || []));
  return keys;
}

export function createSolanaMarket({ rpc = null, rpcUrl = null, fetchImpl = fetch, solUsd = null, now = () => Date.now(), log = (...a) => console.error("[solana-market]", ...a) } = {}) {
  const call = rpc || createRpc({ url: rpcUrl || undefined, fetchImpl });
  // SOL/USD for the USD columns: the treasury's own oracle (median of three exchanges).
  const solUsdOf = solUsd || (async () => (await import("./solana.mjs")).solUsd({ fetch: fetchImpl }));
  // Capabilities discovered at runtime: Helius-only methods fall back to plain RPC.
  const caps = { das: null, txForAddress: null, programAccounts: null };
  const unsupported = (e) => Number(e?.code) === -32601 || /method not found|not supported|unknown method/i.test(String(e?.message || ""));

  const mintOf = (t) => {
    const mint = t.onchain?.mint || t.address;
    if (!isAddress(String(mint))) throw fail(400, "invalid Solana mint");
    return String(mint);
  };
  const decimalsOf = (t) => Number(t.onchain?.decimals ?? 9);
  function ensure(t) {
    t.onchain ||= { chain: "solana", mint: t.address };
    t.market ||= { chain: "solana", trades: [], balancesWei: {}, candles: {}, candlesUsd: {}, price: null, pair: null, vaults: [], updatedAt: null, error: null, lastSlot: null, lastSignature: null, holdersCheckedAt: null, pairsCheckedAt: null };
    t.market.vaults ||= []; t.market.trades ||= []; t.market.balancesWei ||= {};
    return t.market;
  }
  /// Wallets that hold the token without being community members: burn, pool vaults,
  /// the pair, the project treasury and any operator-configured list (t.onchain.excludedHolders).
  function exclusions(t, m) {
    const list = [BURN_ADDRESS, ...(m.vaults || []), m.pair?.address, t.treasury?.wallet, ...(Array.isArray(t.onchain?.excludedHolders) ? t.onchain.excludedHolders : [])];
    return [...new Set(list.filter((a) => typeof a === "string" && isAddress(a)))];
  }

  // ── mint ───────────────────────────────────────────────────────────────────
  async function ensureMint(t, m) {
    const mint = mintOf(t);
    // Classic SPL and Token-2022 are both read the same way here (balances come from
    // pre/postTokenBalances and DAS, which report either program). The program is recorded
    // because it decides how an associated token account is derived elsewhere.
    if (!TOKEN_PROGRAMS.has(t.onchain.tokenProgram) || t.onchain.decimals == null) {
      const info = await call("getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "confirmed" }]);
      const v = info?.value;
      if (!v) throw fail(404, "mint account not found on Solana");
      const parsed = v.data?.parsed;
      if (!TOKEN_PROGRAMS.has(v.owner) || parsed?.type !== "mint") throw fail(400, "address is not an SPL token mint");
      Object.assign(t.onchain, { chain: "solana", mint, tokenProgram: v.owner, decimals: Number(parsed.info.decimals), mintAuthority: parsed.info.mintAuthority ?? null, freezeAuthority: parsed.info.freezeAuthority ?? null });
    }
    const supply = await call("getTokenSupply", [mint, { commitment: "confirmed" }]);
    const amount = String(supply?.value?.amount ?? "");
    if (!/^\d+$/.test(amount)) throw fail(502, "token supply unavailable");
    t.totalSupplyWei = amount;
    t.supply = Math.floor(ui(BigInt(amount), supply.value.decimals ?? t.onchain.decimals));
    return mint;
  }

  // ── the pool: the biggest token account whose owner account belongs to a DEX program ──
  /// A wallet's account is owned by the System program; a pool (or its vault authority) is
  /// owned by the venue's program. That one difference finds the pool without any market list.
  async function discoverPool(t, m) {
    if (m.pair?.baseVault || !(m.topAccounts || []).length) return;
    const owners = [...new Set(m.topAccounts.map((a) => a.owner))].slice(0, 25);
    const infos = await call("getMultipleAccounts", [owners, { encoding: "jsonParsed", commitment: "confirmed" }]);
    const programOf = new Map();
    (infos?.value || []).forEach((v, i) => { if (v?.owner) programOf.set(owners[i], String(v.owner)); });
    for (const a of m.topAccounts) {
      const program = programOf.get(a.owner);
      if ((m.closedVenues || []).includes(a.owner)) continue;               // a graduated curve is not the venue any more
      // Only a known venue counts: the largest holder of a big token is usually a staking,
      // locker or bridge program, not a pool. An unknown program leaves discovery to the
      // bootstrap path, where an actual swap names the counterparty.
      const dexId = program ? DEX_PROGRAMS.get(program) : null;
      if (!dexId) continue;
      m.pair = { address: a.owner, baseVault: a.address, program, dexId,
        quoteMint: m.pair?.quoteMint || null, quoteSymbol: m.pair?.quoteSymbol || "SOL",
        phase: dexId && CURVE_DEXES.has(dexId) ? "curve" : "amm", discoveredAt: new Date(now()).toISOString() };
      m.vaults = [{ address: a.address, mint: mintOf(t), owner: a.owner }, ...(m.vaults || []).filter((v) => v.address !== a.address)];
      m.pairError = null;
      return;
    }
    if (!m.pair) m.pairError = "no known venue among the largest holders; waiting for a swap to name the pool";
  }


  const venueOf = (tx) => {
    const names = new Set();
    for (const key of accountKeysOf(tx)) { const name = DEX_PROGRAMS.get(key); if (name) names.add(name); }
    for (const name of names) if (!ROUTERS.has(name)) return name;      // the venue, not the router that reached it
    return [...names][0] || null;
  };
  /// Current reserves of the vaults a swap revealed → liquidity in USD. A bonding curve keeps
  /// its SOL on the pool account itself, so its lamports count as the quote side.
  async function refreshLiquidity(t, m, at) {
    const vaults = (m.vaults || []).filter((v) => v && isAddress(String(v.address)));
    if (!vaults.length || (m.liquidityCheckedAt && at - m.liquidityCheckedAt < PAIRS_EVERY_MS)) return;
    const accounts = await call("getMultipleAccounts", [vaults.map((v) => v.address), { encoding: "jsonParsed", commitment: "confirmed" }]);
    const values = accounts?.value || [];
    let base = 0n, quote = 0n, quoteDecimals = null, lamports = 0n;
    vaults.forEach((v, i) => {
      const info = values[i]?.data?.parsed?.info, amount = info?.tokenAmount?.amount;
      if (!/^\d+$/.test(String(amount ?? ""))) return;
      if (v.mint === mintOf(t)) base += BigInt(amount);
      else { quote += BigInt(amount); quoteDecimals = info.tokenAmount.decimals ?? quoteDecimals; }
    });
    if (quote === 0n && m.pair?.address) {
      const pool = await call("getAccountInfo", [m.pair.address, { encoding: "jsonParsed", commitment: "confirmed" }]).catch(() => null);
      lamports = BigInt(pool?.value?.lamports ?? 0);
    }
    m.reserves = { base: base.toString(), quote: quote.toString(), quoteDecimals, lamports: lamports.toString() };
    m.liquidityCheckedAt = at;
  }

  /// The venue's own state, read every pass: pump.fun's bonding curve (virtual reserves price
  /// the coin exactly as pump.fun shows it; the real SOL is its liquidity) or a PumpSwap pool
  /// (its two vaults plus BOOST's virtual quote reserves, u64 at byte 245 — verified on live
  /// pools 2026-09-22). A curve that completed is dropped as the venue so discovery can move
  /// to the pool. Anything unreadable leaves the previous state alone.
  async function refreshVenueState(t, m, at) {
    const dexId = m.pair?.dexId, address = m.pair?.address;
    if (!address || !isAddress(String(address)) || !["pumpfun", "pumpswap"].includes(dexId)) return;
    m.venueReadAt = at;
    const info = await call("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }]);
    const b64 = Array.isArray(info?.value?.data) ? info.value.data[0] : null;
    if (typeof b64 !== "string" || !b64) return;
    const slot = Number(info?.context?.slot) || null;
    if (dexId === "pumpfun") {
      let c; try { c = decodeBondingCurve(b64); } catch { return; }
      if (!(c.virtualTokenReserves > 0n)) return;
      m.curve = { virtualSolReserves: c.virtualQuoteReserves.toString(), virtualTokenReserves: c.virtualTokenReserves.toString(), realSolReserves: c.realQuoteReserves.toString(), realTokenReserves: c.realTokenReserves.toString(),
        complete: !!c.complete, quoteIsSol: c.quoteIsSol !== false, slot, readAt: new Date(at).toISOString() };
      if (c.complete) {
        m.graduatedAt ||= new Date(at).toISOString();
        m.closedVenues = [...new Set([...(m.closedVenues || []), address])];
        m.pair = null; m.vaults = (m.vaults || []).filter((v) => v.owner !== address);
        m.pairError = "graduated from the pump.fun curve; looking for the PumpSwap pool";
        await discoverPool(t, m);
        if (m.pair?.dexId === "pumpswap") await refreshVenueState(t, m, at);
      }
      return;
    }
    const d = Buffer.from(b64, "base64");
    if (d.length < 253) return;
    const baseVault = base58Encode(d.subarray(139, 171)), quoteVault = base58Encode(d.subarray(171, 203)), virtualQuote = d.readBigUInt64LE(245);
    const accounts = await call("getMultipleAccounts", [[baseVault, quoteVault], { encoding: "jsonParsed", commitment: "confirmed" }]);
    const amount = (i) => { const info = accounts?.value?.[i]?.data?.parsed?.info; return /^\d+$/.test(String(info?.tokenAmount?.amount ?? "")) ? { amount: BigInt(info.tokenAmount.amount), mint: String(info.mint), decimals: Number(info.tokenAmount.decimals ?? 9) } : null; };
    const base = amount(0), quote = amount(1);
    if (!base || !quote || base.mint !== mintOf(t)) return;
    m.pool = { baseVault, quoteVault, base: base.amount.toString(), quote: quote.amount.toString(), quoteMint: quote.mint, quoteDecimals: quote.decimals, virtualQuote: virtualQuote.toString(), slot, readAt: new Date(at).toISOString() };
    for (const v of [{ address: baseVault, mint: base.mint, owner: address }, { address: quoteVault, mint: quote.mint, owner: address }]) if (!m.vaults.some((x) => x.address === v.address)) m.vaults.push(v);
  }
  /// The freshest curve state: the account read, unless a later trade's own record is newer.
  const latestCurve = (m) => {
    const traded = [...m.trades].reverse().find((x) => x.exact && x.curve);
    const a = m.curve, b = traded ? { ...traded.curve, slot: traded.slot, complete: a?.complete ?? false, quoteIsSol: a?.quoteIsSol ?? true } : null;
    return a && b ? ((b.slot || 0) > (a.slot || 0) ? b : a) : a || b;
  };

  // ── holders ────────────────────────────────────────────────────────────────
  async function holdersViaDas(mint) {
    const owners = new Map(), accounts = []; let cursor, pages = 0, truncated = false;
    for (;;) {
      const r = await call("getTokenAccounts", { mint, limit: 1000, ...(cursor ? { cursor } : {}), options: { showZeroBalance: false } });
      const list = Array.isArray(r?.token_accounts) ? r.token_accounts : [];
      for (const a of list) {
        if (!isAddress(String(a?.owner || "")) || !/^\d+$/.test(String(a?.amount ?? ""))) continue;
        const amount = BigInt(a.amount); if (amount <= 0n) continue;
        owners.set(a.owner, (owners.get(a.owner) || 0n) + amount);
        if (isAddress(String(a.address || ""))) accounts.push({ address: a.address, owner: a.owner, amount });
      }
      pages++;
      cursor = r?.cursor || null;
      if (!cursor || !list.length || list.length < 1000) break;
      if (pages >= MAX_HOLDER_PAGES) { truncated = true; break; }
    }
    return { owners, accounts, pages, truncated, source: "das" };
  }
  async function holdersViaProgramAccounts(mint, tokenProgram = TOKEN_PROGRAM) {
    // Token-2022 accounts carry extensions, so their size is not fixed: only classic
    // accounts can be filtered by dataSize.
    const sized = tokenProgram === TOKEN_PROGRAM;
    const rows = await call("getProgramAccounts", [tokenProgram, { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 32, length: 40 }, filters: [...(sized ? [{ dataSize: 165 }] : []), { memcmp: { offset: 0, bytes: mint } }] }]);
    const owners = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const data = row?.account?.data; const b64 = Array.isArray(data) ? data[0] : data;
      if (typeof b64 !== "string") continue;
      const buf = Buffer.from(b64, "base64"); if (buf.length < 40) continue;
      const owner = base58Encode(buf.subarray(0, 32)), amount = buf.readBigUInt64LE(32);
      if (amount > 0n) owners.set(owner, (owners.get(owner) || 0n) + amount);
    }
    return { owners, accounts: [], pages: 1, truncated: false, source: "program-accounts" };
  }
  async function holdersViaLargest(mint) {
    const largest = await call("getTokenLargestAccounts", [mint, { commitment: "confirmed" }]);
    const addresses = (largest?.value || []).map((x) => x.address).filter((a) => isAddress(String(a)));
    const owners = new Map();
    if (addresses.length) {
      const infos = await call("getMultipleAccounts", [addresses, { encoding: "jsonParsed", commitment: "confirmed" }]);
      for (const acc of infos?.value || []) {
        const info = acc?.data?.parsed?.info; if (!info || !isAddress(String(info.owner || ""))) continue;
        const amount = BigInt(info.tokenAmount?.amount || 0); if (amount > 0n) owners.set(info.owner, (owners.get(info.owner) || 0n) + amount);
      }
    }
    return { owners, accounts: addresses.map((address, i) => ({ address, owner: [...owners.keys()][i] ?? null, amount: [...owners.values()][i] ?? 0n })), pages: 1, truncated: true, source: "largest-accounts" };
  }
  async function fetchHolders(mint, tokenProgram = TOKEN_PROGRAM) {
    if (caps.das !== false) {
      try { const r = await holdersViaDas(mint); caps.das = true; return r; }
      catch (e) { if (!unsupported(e)) throw e; caps.das = false; }
    }
    if (caps.programAccounts !== false) {
      try { const r = await holdersViaProgramAccounts(mint, tokenProgram); caps.programAccounts = true; return r; }
      catch (e) { if (Number(e?.code) === 429) throw e; caps.programAccounts = false; log("getProgramAccounts unavailable, using largest accounts:", clip(e.message)); }
    }
    return holdersViaLargest(mint);
  }
  function applyHolders(t, m, owners, meta) {
    const decimals = decimalsOf(t), excluded = new Set(exclusions(t, m));
    const balancesWei = {}, holderBalancesWei = {}, balances = {};
    for (const [owner, amount] of owners) {
      balancesWei[owner] = amount.toString();
      if (excluded.has(owner)) continue;
      holderBalancesWei[owner] = amount.toString();
      const whole = Math.floor(ui(amount, decimals));
      if (whole > 0) balances[owner] = whole;
    }
    m.balancesWei = balancesWei; t.holderBalancesWei = holderBalancesWei; t.balances = balances;
    m.holderCount = Object.keys(holderBalancesWei).length; m.holdersSource = meta.source; m.holdersTruncated = !!meta.truncated; m.holderPages = meta.pages;
  }
  async function refreshHolders(t, m, mint, at) {
    const every = Math.max(HOLDERS_EVERY_MS, (m.holderPages || 1) * 30_000);
    if (m.holdersCheckedAt && at - m.holdersCheckedAt < every) return;
    const r = await fetchHolders(mint, t.onchain?.tokenProgram || TOKEN_PROGRAM);
    applyHolders(t, m, r.owners, r);
    // The biggest token accounts are the pool-discovery candidates for this pass.
    m.topAccounts = (r.accounts || []).filter((a) => a.owner).sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0)).slice(0, 25)
      .map((a) => ({ address: a.address, owner: a.owner, amount: a.amount.toString() }));
    m.holdersCheckedAt = at;
  }

  // ── trades: measured on the trader's side of the mint's own transactions ────
  /// A swap moves the trader's token balance one way and their SOL (or stablecoin) the
  /// other. Network fees and any token account created inside the swap are removed, so the
  /// price is what the trader actually paid per token. The counterparty accounts are the
  /// pool's vaults; they are remembered for liquidity and excluded from the holder table.
  function deriveTrade(t, m, tx) {
    const mint = mintOf(t);
    if (!tx?.meta || tx.meta.err) return null;
    const keys = accountKeysOf(tx);
    const signature = tx.transaction?.signatures?.[0];
    if (!signature || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature) || !keys.length) return null;
    const trader = keys[0];
    const pre = new Map(), post = new Map(), decimals = new Map(), accountsOf = new Map();
    const add = (map, row) => {
      if (!row?.owner || !row?.mint || !/^\d+$/.test(String(row.uiTokenAmount?.amount ?? ""))) return;
      const k = `${row.owner}|${row.mint}`;
      map.set(k, (map.get(k) ?? 0n) + BigInt(row.uiTokenAmount.amount));
      if (row.uiTokenAmount.decimals != null) decimals.set(row.mint, Number(row.uiTokenAmount.decimals));
      const address = keys[row.accountIndex];
      if (address) accountsOf.set(`${row.owner}|${row.mint}`, address);
    };
    for (const row of tx.meta.preTokenBalances || []) add(pre, row);
    for (const row of tx.meta.postTokenBalances || []) add(post, row);
    const owners = new Set([...pre.keys(), ...post.keys()].map((k) => k.split("|")[0]));
    const delta = (owner, m2) => (post.get(`${owner}|${m2}`) ?? 0n) - (pre.get(`${owner}|${m2}`) ?? 0n);
    const dBase = delta(trader, mint);
    // The pool side of this transaction: whoever moved the mint against the trader.
    const vaults = [];
    for (const owner of owners) {
      if (owner === trader) continue;
      const d = delta(owner, mint);
      if (d === 0n || (d < 0n) === (dBase < 0n)) continue;
      for (const m2 of [mint, WSOL_MINT, ...USD_STABLES]) {
        const address = accountsOf.get(`${owner}|${m2}`);
        if (address && !vaults.some((v) => v.address === address)) vaults.push({ address, mint: m2, owner });
      }
    }
    // pump.fun writes every curve trade into the transaction itself; that record beats any
    // balance arithmetic (a tiny buy's fixed costs would otherwise pass for its price).
    const events = pumpTradeEvents(tx, mint);
    if (events.length) return { vaults, quoteMint: WSOL_MINT, dex: "pumpfun", trades: eventTrades(t, m, tx, signature, events) };
    if (dBase === 0n) return { vaults };
    // The trader's quote side: native SOL (fee and fresh-account rent removed) plus wSOL,
    // or a stablecoin when the pool is USD-quoted.
    const index = keys.indexOf(trader);
    let lamports = 0n;
    if (index >= 0 && Array.isArray(tx.meta.preBalances) && Array.isArray(tx.meta.postBalances))
      lamports = BigInt(tx.meta.postBalances[index] ?? 0) - BigInt(tx.meta.preBalances[index] ?? 0) + BigInt(tx.meta.fee ?? 0);
    // Token-account rent is not part of a price: a swap that opens an account costs the
    // trader rent, and closing one refunds it. Both are removed before the quote is read.
    const opened = [...post.keys()].filter((k) => k.startsWith(`${trader}|`) && !pre.has(k)).length;
    const closed = [...pre.keys()].filter((k) => k.startsWith(`${trader}|`) && !post.has(k)).length;
    if (opened) lamports += ATA_RENT_LAMPORTS * BigInt(opened);
    if (closed) lamports -= ATA_RENT_LAMPORTS * BigInt(closed);
    let quoteMint = WSOL_MINT, quoteDecimals = 9, dQuote = lamports + delta(trader, WSOL_MINT);
    if (dQuote === 0n || (dQuote < 0n) === (dBase < 0n)) {
      for (const stable of USD_STABLES) {
        const d = delta(trader, stable);
        if (d !== 0n && (d < 0n) !== (dBase < 0n)) { dQuote = d; quoteMint = stable; quoteDecimals = decimals.get(stable) ?? 6; break; }
      }
    }
    if (dQuote === 0n || (dQuote < 0n) === (dBase < 0n)) return { vaults };        // a transfer, a mint, a liquidity move — not a swap
    // A swap runs through a venue. An unknown program only counts once the pool it moves
    // against is one this token has already traded on, so a plain transfer never scores.
    const venue = venueOf(tx);
    const knownPool = vaults.some((v) => (m.vaults || []).some((x) => x.address === v.address));
    if (!venue && !knownPool) return { vaults };
    const side = dBase > 0n ? "buy" : "sell";
    const tokens = ui(dBase < 0n ? -dBase : dBase, decimalsOf(t));
    const quote = ui(dQuote < 0n ? -dQuote : dQuote, quoteDecimals);
    if (!(tokens > 0) || !(quote > 0)) return { vaults };
    const usdQuoted = USD_STABLES.has(quoteMint), solUsdNow = m.solUsd || null;
    const quoteSol = usdQuoted ? (solUsdNow ? quote / solUsdNow : null) : quote;
    const quoteUsd = usdQuoted ? quote : (solUsdNow ? quote * solUsdNow : null);
    const ts = Number.isFinite(tx.blockTime) && tx.blockTime > 0 ? tx.blockTime : Math.floor(now() / 1000);
    return {
      vaults, quoteMint, dex: venue,
      trades: [{ side, who: trader, quote, quoteSymbol: usdQuoted ? "USDC" : "SOL", quoteSol, quoteEth: quoteSol, quoteUsd, tokens,
        price: quoteSol != null ? quoteSol / tokens : null, priceUsd: quoteUsd != null ? quoteUsd / tokens : null,
        dex: venue, tx: signature, id: signature, slot: Number(tx.slot), block: Number(tx.slot), ts, exact: false }],
    };
  }
  /// Trades as pump.fun recorded them (one transaction may hold several, e.g. a bot's buy and
  /// sell): amounts, fees and the curve after each; the price is what the curve executed.
  function eventTrades(t, m, tx, signature, events) {
    const dec = decimalsOf(t), solUsdNow = m.solUsd || null;
    const fallbackTs = Number.isFinite(tx.blockTime) && tx.blockTime > 0 ? tx.blockTime : Math.floor(now() / 1000);
    return events.map((e, i) => {
      const tokens = ui(e.tokenAmount, dec), quoteSol = ui(e.solAmount, 9);
      if (!(tokens > 0) || !(quoteSol > 0)) return null;
      return { side: e.isBuy ? "buy" : "sell", who: e.user, quote: quoteSol, quoteSymbol: "SOL", quoteSol, quoteEth: quoteSol, quoteUsd: solUsdNow ? quoteSol * solUsdNow : null, tokens,
        price: quoteSol / tokens, priceUsd: solUsdNow ? quoteSol * solUsdNow / tokens : null,
        dex: "pumpfun", tx: signature, id: i ? `${signature}#${i}` : signature, slot: Number(tx.slot), block: Number(tx.slot), ts: e.timestamp > 0 ? e.timestamp : fallbackTs,
        exact: true, feeSol: ui(e.fee, 9), creatorTaxEth: ui(e.creatorFee, 9),
        curve: { virtualSolReserves: e.virtualSolReserves.toString(), virtualTokenReserves: e.virtualTokenReserves.toString(), realSolReserves: e.realSolReserves.toString(), realTokenReserves: e.realTokenReserves.toString() } };
    }).filter(Boolean);
  }
  /// Every transaction of the pool's vault (a swap always touches it), newest first.
  /// Before a pool is known, the mint itself is queried with a token-transfer filter, which
  /// Helius only serves at 'finalized' — enough to bootstrap, not to price a market.
  async function transactionsViaHelius(m, address, { tokenFilterMint = null } = {}) {
    const out = []; let paginationToken = null;
    for (let page = 0; page < MAX_TX_PAGES; page++) {
      const filters = { status: "succeeded", ...(tokenFilterMint ? { tokenTransfer: { mint: tokenFilterMint } } : {}), ...(m.lastSlot ? { slot: { gt: m.lastSlot } } : {}) };
      // Helius requires 'finalized' whenever the tokenTransfer filter is used (a few seconds
      // behind 'confirmed'; a trade is only indexed once it can no longer roll back).
      const r = await call("getTransactionsForAddress", [address, { transactionDetails: "full", encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: tokenFilterMint ? "finalized" : "confirmed", limit: 100, sortOrder: "desc", filters, ...(paginationToken ? { paginationToken } : {}) }]);
      const list = Array.isArray(r?.data) ? r.data : Array.isArray(r) ? r : [];
      out.push(...list);
      paginationToken = r?.paginationToken || null;
      if (!paginationToken || !list.length) break;
    }
    return out;
  }
  /// Plain-RPC fallback (no Helius): signatures of the mint, then each transaction.
  async function transactionsViaRpc(m, address) {
    const sigs = []; let before = null;
    for (let page = 0; page < MAX_SIGNATURE_PAGES; page++) {
      const r = await call("getSignaturesForAddress", [address, { limit: 100, commitment: "confirmed", ...(m.lastSignature ? { until: m.lastSignature } : {}), ...(before ? { before } : {}) }]);
      const list = Array.isArray(r) ? r : [];
      sigs.push(...list);
      if (list.length < 100) break;
      before = list[list.length - 1].signature;
    }
    const pending = sigs.filter((x) => x && x.err == null && typeof x.signature === "string").reverse().slice(0, MAX_TX_FETCH_PER_PASS);
    const out = [];
    for (const x of pending) {
      const tx = await call("getTransaction", [x.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
      if (tx) out.push(tx);
    }
    return out;
  }
  async function refreshTrades(t, m, mint) {
    // Measured pump.fun trades filed before the event reader existed are re-read once from
    // the curve's own records: that pass fetches the history from the start again.
    if (!m.exactTradesAt && m.trades.some((x) => x.dex === "pumpfun" && !x.exact)) {
      m.trades = m.trades.filter((x) => x.dex !== "pumpfun" || x.exact);
      m.lastSlot = null; m.lastSignature = null; m.exactTradesAt = new Date(now()).toISOString();
    }
    // The pool's vault sees every swap; the mint alone sees mostly plain transfers.
    const address = m.pair?.baseVault || mint;
    const bootstrapping = address === mint;
    let txs;
    if (caps.txForAddress !== false) {
      try { txs = await transactionsViaHelius(m, address, { tokenFilterMint: bootstrapping ? mint : null }); caps.txForAddress = true; }
      catch (e) { if (!unsupported(e)) throw e; caps.txForAddress = false; }
    }
    if (!txs) txs = await transactionsViaRpc(m, address);
    const seen = new Set(m.trades.map((x) => x.id || x.tx));
    const fresh = [];
    let newest = null, venue = null, quoteMint = null;
    for (const tx of txs) {
      const slot = Number(tx?.slot); if (!Number.isFinite(slot)) continue;
      if (!newest || slot > newest.slot) newest = { slot, signature: tx.transaction?.signatures?.[0] || null };
      const d = deriveTrade(t, m, tx); if (!d) continue;
      for (const v of d.vaults) if (!m.vaults.some((x) => x.address === v.address)) m.vaults.push(v);
      for (const trade of d.trades || []) {
        const key = trade.id || trade.tx;
        if (seen.has(key)) continue;
        seen.add(key); fresh.push(trade); venue ||= d.dex; quoteMint ||= d.quoteMint;
      }
    }
    if (fresh.length) {
      m.trades.push(...fresh);
      m.trades.sort((a, b) => a.slot - b.slot || a.ts - b.ts);
      if (m.trades.length > MAX_TRADES) m.trades.splice(0, m.trades.length - MAX_TRADES);
    }
    // The pool this token actually trades on, as the chain showed it.
    const poolOwner = m.pair?.address || m.vaults.find((v) => v.mint === mintOf(t))?.owner || m.vaults[0]?.owner || null;
    if (poolOwner) {
      const dexId = m.pair?.dexId || venue || null;
      const quote = m.pair?.quoteMint || quoteMint || WSOL_MINT;
      m.pair = { ...(m.pair || {}), address: poolOwner, dexId, quoteMint: quote,
        baseVault: m.pair?.baseVault || m.vaults.find((v) => v.mint === mintOf(t) && v.owner === poolOwner)?.address || null,
        quoteSymbol: USD_STABLES.has(quote) ? "USDC" : "SOL",
        phase: dexId && CURVE_DEXES.has(dexId) ? "curve" : "amm", discoveredAt: m.pair?.discoveredAt || new Date(now()).toISOString() };
      m.pairError = null;
    } else if (!m.pair) m.pairError = m.graduatedAt ? "graduated from the pump.fun curve; looking for the PumpSwap pool" : "no pool found for this mint yet";
    if (newest) { m.lastSlot = Math.max(m.lastSlot || 0, newest.slot); if (newest.signature) m.lastSignature = newest.signature; }
  }

  // ── candles ────────────────────────────────────────────────────────────────
  function buildCandles(m) {
    const priced = m.trades.filter((x) => Number.isFinite(x.price));
    const sol = candleize(priced, { priceKey: "price", quoteKey: "quoteSol", volumeKey: "volume" });
    const usd = candleize(m.trades.filter((x) => Number.isFinite(x.priceUsd)), { priceKey: "priceUsd", quoteKey: "quoteUsd", volumeKey: "volume" });
    const withEth = (series) => Object.fromEntries(Object.entries(series).map(([k, rows]) => [k, rows.map((c) => ({ ...c, volumeEth: c.volume }))]));
    return { sol: withEth(sol), usd: withEth(usd) };
  }
  /// Price from the most recent indexed trade, market cap from the supply, liquidity from
  /// the pool's own vaults. Nothing here comes from a third-party market list.
  function priceOf(t, m) {
    const last = [...m.trades].reverse().find((x) => Number.isFinite(x.price) || Number.isFinite(x.priceUsd));
    const solUsdNow = m.solUsd || null, dec = decimalsOf(t);
    // The venue's own state prices the coin when it can: pump.fun's curve (the virtual
    // reserves — the number pump.fun shows) or a PumpSwap pool (vaults plus the virtual
    // quote). Otherwise the last trade, measured on the trader's side.
    let priceSol = null, source = "chain", progress = null;
    const curve = m.pair?.dexId === "pumpfun" ? latestCurve(m) : null;
    if (curve && curve.quoteIsSol !== false && BigInt(curve.virtualTokenReserves) > 0n) {
      priceSol = Number(BigInt(curve.virtualSolReserves)) / Number(BigInt(curve.virtualTokenReserves)) * 10 ** dec / 1e9; source = "curve";
      progress = Math.max(0, Math.min(1, 1 - Number(BigInt(curve.realTokenReserves)) / Number(PUMP_INITIAL_REAL_TOKEN_RESERVES)));
    } else if (m.pair?.dexId === "pumpswap" && m.pool && BigInt(m.pool.base) > 0n && !USD_STABLES.has(m.pool.quoteMint)) {
      priceSol = Number(BigInt(m.pool.quote) + BigInt(m.pool.virtualQuote || 0)) / Number(BigInt(m.pool.base)) * 10 ** dec / 10 ** Number(m.pool.quoteDecimals ?? 9); source = "pool";
    }
    if (priceSol == null) priceSol = last?.price ?? (last?.priceUsd != null && solUsdNow ? last.priceUsd / solUsdNow : null);
    const priceUsd = source === "chain" && last?.priceUsd != null ? last.priceUsd : (priceSol != null && solUsdNow ? priceSol * solUsdNow : null);
    const supply = t.supply ?? null;
    const mcapUsd = priceUsd != null && supply ? priceUsd * supply : null;
    const r = m.reserves;
    let liquidityUsd = null;
    if (source === "curve") { if (solUsdNow) liquidityUsd = Number((ui(BigInt(curve.realSolReserves), 9) * solUsdNow).toFixed(2)); }
    else if (source === "pool") { if (solUsdNow) liquidityUsd = Number((ui(BigInt(m.pool.quote), Number(m.pool.quoteDecimals ?? 9)) * solUsdNow + ui(BigInt(m.pool.base), dec) * priceUsd).toFixed(2)); }
    else if (r) {
      const baseTokens = ui(BigInt(r.base || 0), decimalsOf(t));
      const quoteUnits = ui(BigInt(r.quote || 0), r.quoteDecimals ?? 9);
      const quoteUsd = USD_STABLES.has(m.pair?.quoteMint) ? quoteUnits : solUsdNow ? quoteUnits * solUsdNow : null;
      const lamportsUsd = solUsdNow ? ui(BigInt(r.lamports || 0), 9) * solUsdNow : null;
      const baseUsd = priceUsd != null ? baseTokens * priceUsd : null;
      const parts = [baseUsd, quoteUsd || lamportsUsd].filter((x) => Number.isFinite(x));
      if (parts.length) liquidityUsd = Number(parts.reduce((a, b) => a + b, 0).toFixed(2));
    }
    const since = now() / 1000 - 86_400;
    const day = m.trades.filter((x) => x.ts >= since);
    return {
      priceSol, priceUsd, mcapUsd, mcapSol: mcapUsd != null && solUsdNow ? mcapUsd / solUsdNow : null,
      liquidityUsd, volume24hUsd: Number(day.reduce((sum, x) => sum + (x.quoteUsd || 0), 0).toFixed(2)),
      txns24h: { buys: day.filter((x) => x.side === "buy").length, sells: day.filter((x) => x.side === "sell").length },
      pair: m.pair?.address ?? null, dexId: m.pair?.dexId ?? null, quoteSymbol: m.pair?.quoteSymbol ?? "SOL", quoteMint: m.pair?.quoteMint ?? null,
      phase: m.pair?.phase ?? (m.graduatedAt ? "amm" : null), graduated: m.pair?.phase === "amm" || !!m.graduatedAt, solUsd: solUsdNow, totalSupply: supply, progress, priceSource: source,
      lastTradeAt: last?.ts ? new Date(last.ts * 1000).toISOString() : null, source: "chain",
    };
  }

  // ── public API ─────────────────────────────────────────────────────────────
  return Object.freeze({
    capabilities: caps,
    /// One incremental pass: mint/supply, SOL/USD, trades (and the pool they reveal), holders (≥60 s), reserves (≥30 s), candles, price.
    async indexToken(t) {
      const m = ensure(t);
      const at = now();
      let mint;
      try { mint = await ensureMint(t, m); }
      catch (e) { m.error = clip(e.message); m.updatedAt = new Date(at).toISOString(); throw e; }
      const errors = [];
      const stage = async (name, fn) => { try { await fn(); } catch (e) { errors.push(`${name}: ${clip(e.message)}`); } };
      // SOL/USD first (the USD columns need it), then trades — the vaults a swap reveals are
      // excluded from the same pass's holder table — then holders and the pool's reserves.
      await stage("price", async () => { const usd = await solUsdOf(); if (usd > 0) m.solUsd = usd; });
      await stage("holders", () => refreshHolders(t, m, mint, at));
      await stage("pool", () => discoverPool(t, m));
      await stage("venue", () => refreshVenueState(t, m, at));
      await stage("trades", () => refreshTrades(t, m, mint));
      // A swap in this pass may have named the venue for the first time: price it now, not next pass.
      if (m.pair && m.venueReadAt !== at) await stage("venue", () => refreshVenueState(t, m, at));
      await stage("liquidity", () => refreshLiquidity(t, m, at));
      t.excludedHolders = exclusions(t, m);
      const candles = buildCandles(m);
      m.candles = candles.sol; m.candlesUsd = candles.usd;
      m.price = priceOf(t, m);
      m.updatedAt = new Date(at).toISOString();
      m.error = errors.length ? errors.join(" · ") : (m.pairError || null);
      return m;
    },
    /// One wallet's balance straight from the chain (used before accepting a message).
    async refreshHolderBalance(t, owner) {
      const holder = String(owner);
      if (!isAddress(holder)) throw fail(400, "invalid Solana wallet address");
      const m = ensure(t), mint = mintOf(t);
      const [accounts, supply] = await Promise.all([
        call("getTokenAccountsByOwner", [holder, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]),
        call("getTokenSupply", [mint, { commitment: "confirmed" }]),
      ]);
      let wei = 0n;
      for (const a of accounts?.value || []) { const amount = a?.account?.data?.parsed?.info?.tokenAmount?.amount; if (/^\d+$/.test(String(amount ?? ""))) wei += BigInt(amount); }
      if (supply?.value && /^\d+$/.test(String(supply.value.amount))) {
        t.totalSupplyWei = String(supply.value.amount);
        if (t.onchain.decimals == null && supply.value.decimals != null) t.onchain.decimals = Number(supply.value.decimals);
        t.supply = Math.floor(ui(BigInt(supply.value.amount), decimalsOf(t)));
      }
      const n = ui(wei, decimalsOf(t));
      t.holderBalancesWei ||= {}; t.holderBalancesWei[holder] = wei.toString();
      m.balancesWei[holder] = wei.toString();
      t.balances ||= {};
      if (n > 0) t.balances[holder] = n; else delete t.balances[holder];
      return n;
    },
    /// The block at a slot, stepping back over skipped slots; {number, hash} for the governance guard.
    async blockAt(slot, { stepBack = 0 } = {}) {
      for (let s = slot; s >= Math.max(0, slot - stepBack); s--) {
        try { const b = await call("getBlock", [s, { transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0, commitment: "confirmed" }]); if (b?.blockhash) return { number: s, hash: String(b.blockhash), blockTime: b.blockTime ?? null }; }
        catch (e) { if (!isSkipped(e)) throw e; }
      }
      return null;
    },
    /// getBlock(tag) for governance-guard: 'finalized' → latest finalized slot + blockhash; a slot → that slot's blockhash.
    async governanceBlock(tag) {
      if (tag === "finalized") {
        const r = await call("getLatestBlockhash", [{ commitment: "finalized" }]);
        if (!Number.isSafeInteger(r?.context?.slot) || typeof r?.value?.blockhash !== "string") throw fail(503, "finalized slot unavailable");
        return { number: r.context.slot, hash: r.value.blockhash };
      }
      const b = await this.blockAt(Number(tag));
      return b || { number: Number(tag), hash: null };   // a vanished block fails the canonical check, not the transport
    },
    /// Snapshot for a new proposal: confirmed slot + its blockhash, supply, the proposer's live balance and the holder table.
    async proposalSnapshot(t, proposer) {
      const holder = String(proposer);
      if (!isAddress(holder)) throw fail(400, "invalid Solana wallet address");
      const mint = mintOf(t);
      const slot = await call("getSlot", [{ commitment: "confirmed" }]);
      if (!Number.isSafeInteger(slot) || slot <= 0) throw fail(503, "chain snapshot unavailable");
      const block = await this.blockAt(slot, { stepBack: 8 });
      if (!block) throw fail(503, "chain snapshot unavailable");
      const [supply, accounts] = await Promise.all([
        call("getTokenSupply", [mint, { commitment: "confirmed" }]),
        call("getTokenAccountsByOwner", [holder, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]),
      ]);
      const total = String(supply?.value?.amount ?? "");
      if (!/^\d+$/.test(total) || BigInt(total) <= 0n) throw fail(503, "token supply unavailable");
      let mine = 0n;
      for (const a of accounts?.value || []) { const amount = a?.account?.data?.parsed?.info?.tokenAmount?.amount; if (/^\d+$/.test(String(amount ?? ""))) mine += BigInt(amount); }
      const excluded = new Set(exclusions(t, t.market || {}));
      const snapshotWei = {};
      for (const [a, v] of Object.entries(t.holderBalancesWei || {})) if (!excluded.has(a) && /^\d+$/.test(String(v)) && BigInt(v) > 0n) snapshotWei[a] = String(v);
      if (mine > 0n) snapshotWei[holder] = mine.toString(); else delete snapshotWei[holder];
      return { blockNumber: block.number, blockHash: block.hash, totalSupplyWei: total, proposerBalanceWei: mine.toString(), snapshotWei, holdersAt: t.market?.holdersCheckedAt ? new Date(t.market.holdersCheckedAt).toISOString() : null };
    },
    /// Vote weight from the persisted snapshot map, after re-checking the snapshot slot still carries the same blockhash.
    async snapshotVoteWeight(t, proposal, holder) {
      const h = String(holder);
      const block = await this.blockAt(Number(proposal.snapshotBlock));
      if (!block || block.hash !== proposal.snapshotBlockHash) throw fail(409, "voting snapshot changed on chain; vote paused for review");
      const wei = proposal.snapshotWei?.[h];
      return /^\d+$/.test(String(wei ?? "")) ? String(wei) : "0";
    },
    async verifyProposalChain(t, p) {
      const { verifyGovernanceSnapshot } = await import("./governance-guard.mjs");
      return verifyGovernanceSnapshot(t, p, (tag) => this.governanceBlock(tag));
    },
    /// What the channel page shows. Pons key names are kept (priceEth = price in SOL,
    /// the quote unit) and the Solana-native keys are added next to them.
    marketOf(t) {
      const m = t.market; if (!m) return null;
      const mint = t.onchain?.mint || t.address;
      const price = m.price || {};
      const since = now() / 1000 - 86_400;
      const day = m.trades.filter((x) => x.ts >= since);
      const vol24Sol = day.reduce((s, x) => s + (x.quoteSol || 0), 0);
      const vol24Usd = day.reduce((s, x) => s + (x.quoteUsd || 0), 0);
      const pair = price.pair || m.pair?.address || null;
      return {
        chain: "solana", quoteSymbol: "SOL", quoteMint: price.quoteMint ?? m.pair?.quoteMint ?? null,
        priceEth: price.priceSol ?? null, priceSol: price.priceSol ?? null, priceUsd: price.priceUsd ?? null,
        mcapEth: price.mcapSol ?? null, mcapUsd: price.mcapUsd ?? null, liquidityUsd: price.liquidityUsd ?? null, solUsd: price.solUsd ?? m.solUsd ?? null,
        volume24hEth: Number(vol24Sol.toFixed(6)), volume24hSol: Number(vol24Sol.toFixed(6)), volume24hUsd: price.volume24hUsd ?? Number(vol24Usd.toFixed(2)), volume24hIndexedUsd: Number(vol24Usd.toFixed(2)), txns24h: price.txns24h ?? null,
        quoteReserveEth: null, tokenReserve: null, totalSupply: t.supply ?? null, graduated: !!price.graduated, phase: price.phase ?? null, graduationThresholdEth: null, progress: price.progress ?? null, priceSource: price.priceSource ?? null,
        creatorTaxBps: t.onchain?.pump && !price.graduated ? PUMP_CURVE_CREATOR_FEE_BPS : null,
        creatorTaxEarnedEth: Number(m.trades.reduce((s, x) => s + (pumpCreatorFee(x, t) || 0), 0).toFixed(9)),
        trades: m.trades.slice(-60).reverse().map((x) => { const fee = pumpCreatorFee(x, t); return fee == null ? x : { ...x, creatorTaxEth: fee }; }), tradeCount: m.trades.length, candles: m.candles || {}, candlesUsd: m.candlesUsd || {},
        holderCount: m.holderCount ?? null, holdersSource: m.holdersSource ?? null, holdersTruncated: !!m.holdersTruncated,
        updatedAt: m.updatedAt, error: m.error, lastBlock: m.lastSlot ?? null, lastSlot: m.lastSlot ?? null,
        pair, dexId: price.dexId ?? m.pair?.dexId ?? null, curve: pair,
        explorer: `https://solscan.io/token/${mint}`, tradeApp: `https://jup.ag/swap/SOL-${mint}`, pairUrl: pair ? `https://solscan.io/account/${pair}` : null,
      };
    },
  });
}
