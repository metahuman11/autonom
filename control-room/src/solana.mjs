// Solana treasury rail: pure primitives for reading a treasury, building / signing /
// guarding the ONE kind of outbound transaction the control room makes on Solana (a
// SOL or USDC transfer from a project treasury) and confirming / verifying it after.
//
// Nothing here holds a key or persists state: signers are injected as
// `{ address, sign(bytes) }` (wallets.mjs makes them), the RPC is injected for tests,
// and no function sends unless the caller calls `send()` itself — billing persists the
// signature first, then sends. Instruction bytes are hand-encoded against the published
// layouts (System transfer, ComputeBudget, SPL TransferChecked, Memo) so the pinned
// @solana/* 6.5.0 codecs stay the only Solana dependency: @solana/kit 8.3.0 cannot share
// a tree with the 6.5.0 pins the DEX receipt / Helio validators are provenance-locked to.
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { getAddressDecoder, getAddressEncoder, getProgramDerivedAddress } from "@solana/addresses";
import { AccountRole } from "@solana/instructions";
import { appendTransactionMessageInstructions, compressTransactionMessageUsingAddressLookupTables, createTransactionMessage, getCompiledTransactionMessageDecoder, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from "@solana/transaction-messages";
import { compileTransaction, getBase64EncodedWireTransaction, getTransactionDecoder } from "@solana/transactions";
import { env } from "./env.mjs";

// ---------------------------------------------------------------- constants
export const GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DECIMALS = 6;
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const LAMPORTS_PER_SOL = 1_000_000_000;
/// Rent-exempt minimum for a 0-byte account on mainnet (SIMD-0437 step 2, 2026-09-21).
/// Read `rpc.getMinimumBalanceForRentExemption(0)` for the live value; it drops again ~Nov 2026.
export const RENT_EXEMPT_MIN_LAMPORTS = 650_240;
/// A treasury never spends below this (fees for future transfers + rent floor).
export const TREASURY_SOL_RESERVE_LAMPORTS = 5_000_000;
export const BASE_FEE_LAMPORTS_PER_SIGNATURE = 5_000;
export const MAX_COMPUTE_UNITS = 1_400_000;
export const DEFAULT_COMPUTE_UNIT_LIMIT_SOL = 50_000;
export const DEFAULT_COMPUTE_UNIT_LIMIT_USDC = 200_000;
/// µlamports per compute unit: default when no Helius estimate, floor, and hard cap.
export const DEFAULT_COMPUTE_UNIT_PRICE = 20_000;
export const MIN_COMPUTE_UNIT_PRICE = 1_000;
export const MAX_COMPUTE_UNIT_PRICE = 100_000;
export const MAX_MEMO_BYTES = 128;
export const PUBLIC_RPC_URL = "https://api.mainnet-beta.solana.com";
export const SOL_USD_CACHE_MS = 30_000;
export const SOL_USD_MAX_SPREAD = 0.02;

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_INDEX = new Map([...B58_ALPHABET].map((c, i) => [c, i]));
const B58_RE = /^[1-9A-HJ-NP-Za-km-z]*$/;
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const MAX_U64 = (1n << 64n) - 1n;

const fail = (message, code, extra) => Object.assign(new Error(message), { code, ...extra });
const isUint = (x) => Number.isSafeInteger(x) && x >= 0;
const sha256hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

// ---------------------------------------------------------------- base58 / addresses
export function base58Encode(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  let zeros = 0;
  while (zeros < b.length && b[zeros] === 0) zeros++;
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let out = "";
  while (n > 0n) { out = B58_ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  return "1".repeat(zeros) + out;
}

export function base58Decode(text) {
  if (typeof text !== "string" || !B58_RE.test(text)) throw fail("not a base58 string", "base58_invalid");
  let n = 0n;
  for (const c of text) n = n * 58n + BigInt(B58_INDEX.get(c));
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros++;
  return Uint8Array.from([...new Array(zeros).fill(0), ...bytes]);
}

/// A base58 string that decodes to exactly 32 bytes (public key, mint, program id).
export function isSolanaAddress(value) {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) return false;
  try { return base58Decode(value).length === 32; } catch { return false; }
}

export function isSolanaSignature(value) {
  if (typeof value !== "string" || !SIGNATURE_RE.test(value)) return false;
  try { return base58Decode(value).length === 64; } catch { return false; }
}

function assertAddress(value, what) {
  if (!isSolanaAddress(value)) throw fail(`${what} is not a base58 Solana address`, "solana_address_invalid");
  return value;
}

/// The associated token account of `owner` for `mint` (legacy Token program only —
/// Token-2022 mints are out of scope and would derive a different address).
export async function ataOf(owner, mint = USDC_MINT, tokenProgram = TOKEN_PROGRAM) {
  assertAddress(owner, "owner"); assertAddress(mint, "mint"); assertAddress(tokenProgram, "token program");
  const enc = getAddressEncoder();
  const [ata] = await getProgramDerivedAddress({ programAddress: ASSOCIATED_TOKEN_PROGRAM, seeds: [enc.encode(owner), enc.encode(tokenProgram), enc.encode(mint)] });
  return ata;
}

/// Ed25519 verification with node:crypto over the raw 32-byte public key (no tweetnacl).
export function verifyEd25519(message, signature, publicKey) {
  const pub = typeof publicKey === "string" ? base58Decode(publicKey) : Uint8Array.from(publicKey);
  const sig = typeof signature === "string" ? base58Decode(signature) : Uint8Array.from(signature);
  if (pub.length !== 32 || sig.length !== 64) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(pub)]), format: "der", type: "spki" });
    return cryptoVerify(null, Buffer.from(message), key, Buffer.from(sig));
  } catch { return false; }
}

// ---------------------------------------------------------------- ops address
const opsFromEnv = env("SOLANA_OPS_ADDRESS", "DCB8WtbjRJ1DWntBo9LbtniCbkiVT5aoYp4mWPmPhe54");
if (!isSolanaAddress(opsFromEnv)) throw fail("SOLANA_OPS_ADDRESS is not a base58 Solana address", "solana_address_invalid");
/// Where every platform payment on Solana goes (DEX allocation, VPS hours, packages).
export const SOLANA_OPS_ADDRESS = opsFromEnv;

// ---------------------------------------------------------------- JSON-RPC client
function defaultRpcUrl() {
  const explicit = env("SOLANA_RPC_URL");
  if (explicit) return explicit;
  const key = env("HELIUS_API_KEY");
  return key ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}` : PUBLIC_RPC_URL;
}

const toSafeNumber = (value, what) => {
  const n = typeof value === "bigint" ? value : typeof value === "string" ? BigInt(value) : value;
  if (typeof n === "bigint") { if (n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) throw fail(`${what} is outside the safe integer range`, "rpc_unsafe_integer"); return Number(n); }
  if (!isUint(n)) throw fail(`${what} is not a non-negative safe integer`, "rpc_bad_result");
  return n;
};

/// JSON-RPC over fetch. `url` defaults to SOLANA_RPC_URL, else Helius from HELIUS_API_KEY,
/// else the public mainnet endpoint. https only; every call times out after `timeoutMs`;
/// a JSON-RPC error becomes an Error whose `.code` is the RPC error code (a number) and
/// transport failures get string codes (rpc_timeout / rpc_transport / rpc_http / rpc_bad_json).
/// The URL (which may carry an API key) is never included in errors; use `rpc.host`.
export function createRpc({ url, fetch: fetchImpl = globalThis.fetch, timeoutMs = 20_000 } = {}) {
  let endpoint;
  try { endpoint = new URL(url ?? defaultRpcUrl()); } catch { throw fail("SOLANA_RPC_URL is not a valid URL", "rpc_url_invalid"); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) throw fail("Solana RPC must be a plain https URL", "rpc_url_invalid");
  if (typeof fetchImpl !== "function") throw fail("fetch is required", "rpc_url_invalid");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw fail("timeoutMs out of range", "rpc_url_invalid");
  const isHelius = /(^|\.)helius-rpc\.com$/i.test(endpoint.hostname);
  let nextId = 0;

  async function call(method, params = []) {
    const id = ++nextId;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response, text;
    try {
      response = await fetchImpl(endpoint.href, {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
      text = await response.text();
    } catch (e) {
      const timedOut = controller.signal.aborted;
      throw fail(`${method}: ${timedOut ? `no answer within ${timeoutMs} ms` : String(e?.message || e)}`, timedOut ? "rpc_timeout" : "rpc_transport", { rpcMethod: method });
    } finally { clearTimeout(timer); }
    if (!response.ok) throw fail(`${method}: HTTP ${response.status}`, "rpc_http", { rpcMethod: method, status: response.status });
    let json;
    try { json = JSON.parse(text); } catch { throw fail(`${method}: response is not JSON`, "rpc_bad_json", { rpcMethod: method }); }
    if (!json || typeof json !== "object" || json.id !== id) throw fail(`${method}: response id mismatch`, "rpc_bad_json", { rpcMethod: method });
    if (json.error) {
      const code = Number.isFinite(json.error.code) ? json.error.code : "rpc_error";
      throw fail(`${method}: ${json.error.message || "RPC error"}`, code, { rpcMethod: method, data: json.error.data ?? null });
    }
    if (!Object.hasOwn(json, "result")) throw fail(`${method}: response has no result`, "rpc_bad_json", { rpcMethod: method });
    return json.result;
  }

  const assertWire = (wire) => {
    if (typeof wire !== "string" || wire.length === 0 || wire.length > 1644 || !BASE64_RE.test(wire)) throw fail("wire transaction must be base64 (≤ 1232 bytes)", "wire_invalid");
    return wire;
  };

  const rpc = {
    host: endpoint.hostname, isHelius, timeoutMs, call,
    async getGenesisHash() { const r = await call("getGenesisHash", []); if (typeof r !== "string") throw fail("getGenesisHash: bad result", "rpc_bad_result"); return r; },
    /// Lamports as a Number (throws above 2^53 — no single treasury holds that).
    async getBalance(address, commitment = "confirmed") { assertAddress(address, "address"); const r = await call("getBalance", [address, { commitment }]); return toSafeNumber(r?.value, "balance"); },
    /// Token base units (micros for USDC) as a Number, or null when the account does not exist.
    async getTokenAccountBalance(ata, commitment = "confirmed") {
      assertAddress(ata, "token account");
      try { const r = await call("getTokenAccountBalance", [ata, { commitment }]); return toSafeNumber(r?.value?.amount, "token balance"); }
      catch (e) { if (e?.code === -32602 && /could not find account/i.test(String(e.message))) return null; throw e; }
    },
    /// The `value` of getAccountInfo (null when the account does not exist).
    async getAccountInfo(address, { commitment = "confirmed", encoding = "base64" } = {}) { assertAddress(address, "address"); const r = await call("getAccountInfo", [address, { commitment, encoding }]); return r?.value ?? null; },
    async getLatestBlockhash(commitment = "confirmed") {
      const r = await call("getLatestBlockhash", [{ commitment }]);
      const blockhash = r?.value?.blockhash;
      if (!isSolanaAddress(blockhash)) throw fail("getLatestBlockhash: bad blockhash", "rpc_bad_result");
      return { blockhash, lastValidBlockHeight: toSafeNumber(r.value.lastValidBlockHeight, "lastValidBlockHeight"), slot: toSafeNumber(r?.context?.slot ?? 0, "slot") };
    },
    async getBlockHeight(commitment = "confirmed") { return toSafeNumber(await call("getBlockHeight", [{ commitment }]), "block height"); },
    async getSlot(commitment = "confirmed") { return toSafeNumber(await call("getSlot", [{ commitment }]), "slot"); },
    async getMinimumBalanceForRentExemption(bytes = 0) { return toSafeNumber(await call("getMinimumBalanceForRentExemption", [bytes]), "rent"); },
    /// Raw `{ context:{slot}, value:[status|null, ...] }`.
    async getSignatureStatuses(signatures, { searchTransactionHistory = false } = {}) {
      if (!Array.isArray(signatures) || signatures.length === 0 || signatures.length > 256 || !signatures.every(isSolanaSignature)) throw fail("signatures must be base58", "signature_invalid");
      const r = await call("getSignatureStatuses", [signatures, { searchTransactionHistory: !!searchTransactionHistory }]);
      if (!r || !Array.isArray(r.value) || r.value.length !== signatures.length) throw fail("getSignatureStatuses: bad result", "rpc_bad_result");
      return r;
    },
    /// jsonParsed transaction or null when unknown / not yet confirmed.
    async getTransaction(signature, { commitment = "confirmed", encoding = "jsonParsed", maxSupportedTransactionVersion = 0 } = {}) {
      if (!isSolanaSignature(signature)) throw fail("signature must be base58", "signature_invalid");
      return await call("getTransaction", [signature, { commitment, encoding, maxSupportedTransactionVersion }]);
    },
    /// Returns the transaction signature the node accepted (a receipt of forwarding, not of landing).
    async sendTransaction(wire, { skipPreflight = false, maxRetries = 0, preflightCommitment = "confirmed", minContextSlot } = {}) {
      assertWire(wire);
      const opts = { encoding: "base64", skipPreflight: !!skipPreflight, maxRetries, preflightCommitment, ...(minContextSlot != null ? { minContextSlot } : {}) };
      const r = await call("sendTransaction", [wire, opts]);
      if (!isSolanaSignature(r)) throw fail("sendTransaction: bad signature in result", "rpc_bad_result");
      return r;
    },
    /// The `value` of simulateTransaction ({ err, logs, unitsConsumed, accounts }).
    async simulateTransaction(wire, { sigVerify = false, replaceRecentBlockhash = true, accounts, commitment = "confirmed" } = {}) {
      assertWire(wire);
      const opts = { encoding: "base64", sigVerify: !!sigVerify, replaceRecentBlockhash: !!replaceRecentBlockhash, commitment };
      if (Array.isArray(accounts)) opts.accounts = { encoding: "base64", addresses: accounts.map((a) => assertAddress(a, "account")) };
      else if (accounts && typeof accounts === "object") opts.accounts = accounts;
      const r = await call("simulateTransaction", [wire, opts]);
      return r?.value ?? r;
    },
    /// µlamports per compute unit. Helius `getPriorityFeeEstimate` (recommended level) from a
    /// base64 wire transaction or an array of account keys; any other endpoint — or a Helius
    /// error / non-numeric answer — yields DEFAULT_COMPUTE_UNIT_PRICE. The caller clamps.
    async getPriorityFeeEstimate(wireOrAccountKeys) {
      if (!isHelius) return DEFAULT_COMPUTE_UNIT_PRICE;
      const param = Array.isArray(wireOrAccountKeys)
        ? { accountKeys: wireOrAccountKeys.map((a) => assertAddress(a, "account")), options: { recommended: true } }
        : { transaction: assertWire(wireOrAccountKeys), options: { recommended: true, transactionEncoding: "Base64" } };
      try {
        const r = await call("getPriorityFeeEstimate", [param]);
        const v = Number(r?.priorityFeeEstimate);
        return Number.isFinite(v) && v >= 0 ? Math.ceil(v) : DEFAULT_COMPUTE_UNIT_PRICE;
      } catch { return DEFAULT_COMPUTE_UNIT_PRICE; }
    },
  };
  return Object.freeze(rpc);
}

/// Refuse to talk to anything but mainnet-beta.
export async function assertGenesis(rpc) {
  const hash = await rpc.getGenesisHash();
  if (hash !== GENESIS) throw fail(`Solana RPC genesis ${hash} is not mainnet-beta`, "solana_wrong_cluster");
  return hash;
}

/// The recipient's USDC ATA must already exist (we never pay rent for someone else's account).
export async function assertAtaExists(rpc, ata, { mint = USDC_MINT, owner } = {}) {
  assertAddress(ata, "ata");
  const info = await rpc.getAccountInfo(ata, { encoding: "jsonParsed" });
  if (!info) throw fail(`token account ${ata} does not exist`, "ata_missing", { ata });
  const parsed = info.data?.parsed?.info;
  if (info.owner !== TOKEN_PROGRAM || info.data?.program !== "spl-token" || parsed?.mint !== mint || (owner && parsed?.owner !== owner)) {
    throw fail(`account ${ata} is not a ${mint} token account`, "ata_invalid", { ata });
  }
  return { ata, owner: parsed.owner, mint: parsed.mint, amountMicros: toSafeNumber(parsed.tokenAmount?.amount ?? "0", "token balance") };
}

// ---------------------------------------------------------------- SOL/USD price
let solUsdCache = null;   // { usd, sources, at }
export function resetSolUsdCache() { solUsdCache = null; }

async function fetchJson(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { method: "GET", redirect: "error", signal: controller.signal, headers: { accept: "application/json", "user-agent": "metahuman-control-room/1.0" } });
    if (!r.ok) throw fail(`HTTP ${r.status}`, "price_http");
    return await r.json();
  } finally { clearTimeout(timer); }
}

const positive = (x) => { const n = Number(x); return Number.isFinite(n) && n > 0 ? n : null; };
const PRICE_SOURCES = {
  async jupiter(get) {
    const path = `/price/v3?ids=${WSOL_MINT}`;
    let json;
    try { json = await get(`https://api.jup.ag${path}`); } catch { json = await get(`https://lite-api.jup.ag${path}`); }
    return positive(json?.[WSOL_MINT]?.usdPrice);
  },
  async coinbase(get) { const json = await get("https://api.exchange.coinbase.com/products/SOL-USD/ticker"); return positive(json?.price); },
  async kraken(get) {
    const json = await get("https://api.kraken.com/0/public/Ticker?pair=SOLUSD");
    if (Array.isArray(json?.error) && json.error.length) throw fail(json.error.join("; "), "price_http");
    const row = json?.result ? Object.values(json.result)[0] : null;
    return positive(row?.c?.[0]);
  },
};

/// Largest group of quotes within SOL_USD_MAX_SPREAD of each other; needs at least two.
export function agreeingMedian(quotes, maxSpread = SOL_USD_MAX_SPREAD) {
  const sorted = quotes.filter((q) => Number.isFinite(q.usd) && q.usd > 0).sort((a, b) => a.usd - b.usd);
  let best = [];
  for (let i = 0; i < sorted.length; i++) {
    const group = [sorted[i]];
    for (let j = i + 1; j < sorted.length && sorted[j].usd / sorted[i].usd - 1 <= maxSpread; j++) group.push(sorted[j]);
    if (group.length > best.length) best = group;
  }
  if (best.length < 2) throw fail(`SOL/USD sources disagree or are unavailable (${sorted.map((q) => `${q.source}=${q.usd}`).join(", ") || "none"})`, "sol_usd_unavailable");
  const values = best.map((q) => q.usd), mid = values.length >> 1;
  const usd = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  return { usd, sources: best.map((q) => q.source), rejected: sorted.filter((q) => !best.includes(q)).map((q) => q.source) };
}

/// Median of Jupiter (api.jup.ag, lite-api fallback), Coinbase and Kraken; ≥ 2 within 2 %
/// of each other or it throws (code sol_usd_unavailable). Cached 30 s. Returns
/// { usd, sources, rejected, errors, at, cached }.
export async function solUsdQuote({ fetch: fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 8_000, force = false } = {}) {
  const t = now();
  if (!force && solUsdCache && t - solUsdCache.at >= 0 && t - solUsdCache.at < SOL_USD_CACHE_MS) return { ...solUsdCache, cached: true };
  const get = (url) => fetchJson(fetchImpl, url, timeoutMs);
  const results = await Promise.allSettled(Object.entries(PRICE_SOURCES).map(async ([source, read]) => ({ source, usd: await read(get) })));
  const quotes = [], errors = {};
  results.forEach((r, i) => {
    const source = Object.keys(PRICE_SOURCES)[i];
    if (r.status === "fulfilled" && r.value.usd) quotes.push(r.value);
    else errors[source] = r.status === "rejected" ? String(r.reason?.message || r.reason) : "no price";
  });
  const { usd, sources, rejected } = agreeingMedian(quotes);
  solUsdCache = { usd, sources, rejected, errors, at: t };
  return { ...solUsdCache, cached: false };
}

export async function solUsd(opts) { return (await solUsdQuote(opts)).usd; }

/// Integer-exact conversions. `usd` is USD per SOL (any finite positive number, rounded to
/// micro-USD internally). lamportsFor rounds UP (the payer never underpays); microsFor rounds
/// to nearest (same formula as t.treasury.micros).
function usdMicrosOf(usd) {
  if (!Number.isFinite(usd) || usd <= 0) throw fail("solUsd must be a positive number", "sol_usd_invalid");
  const m = BigInt(Math.round(usd * 1_000_000));
  if (m <= 0n) throw fail("solUsd is too small", "sol_usd_invalid");
  return m;
}
export function lamportsFor(micros, usd) {
  if (!isUint(micros)) throw fail("micros must be a non-negative safe integer", "amount_invalid");
  const u = usdMicrosOf(usd);
  return Number((BigInt(micros) * 1_000_000_000n + u - 1n) / u);
}
export function microsFor(lamports, usd) {
  if (!isUint(lamports)) throw fail("lamports must be a non-negative safe integer", "amount_invalid");
  return Number((BigInt(lamports) * usdMicrosOf(usd) + 500_000_000n) / 1_000_000_000n);
}
export function feeBudgetLamports(computeUnitPrice, computeUnitLimit, signatures = 1) {
  return BASE_FEE_LAMPORTS_PER_SIGNATURE * signatures + Math.ceil(computeUnitPrice * computeUnitLimit / 1_000_000);
}

// ---------------------------------------------------------------- instructions (hand-encoded)
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const bytesOf = (...parts) => Uint8Array.from(Buffer.concat(parts.map((p) => (typeof p === "number" ? Buffer.from([p]) : Buffer.from(p)))));

export const instructions = Object.freeze({
  /// ComputeBudget::SetComputeUnitLimit = u8 2 + u32 LE units
  setComputeUnitLimit: (units) => ({ programAddress: COMPUTE_BUDGET_PROGRAM, accounts: [], data: bytesOf(2, u32le(units)) }),
  /// ComputeBudget::SetComputeUnitPrice = u8 3 + u64 LE µlamports/CU
  setComputeUnitPrice: (microLamports) => ({ programAddress: COMPUTE_BUDGET_PROGRAM, accounts: [], data: bytesOf(3, u64le(microLamports)) }),
  /// System::Transfer = u32 LE 2 + u64 LE lamports; accounts [from (writable signer), to (writable)]
  systemTransfer: (from, to, lamports) => ({ programAddress: SYSTEM_PROGRAM, accounts: [{ address: from, role: AccountRole.WRITABLE_SIGNER }, { address: to, role: AccountRole.WRITABLE }], data: bytesOf(u32le(2), u64le(lamports)) }),
  /// SPL Token::TransferChecked = u8 12 + u64 LE amount + u8 decimals; accounts [source, mint, destination, authority (signer)]
  transferChecked: (source, mint, destination, authority, amount, decimals) => ({ programAddress: TOKEN_PROGRAM, accounts: [{ address: source, role: AccountRole.WRITABLE }, { address: mint, role: AccountRole.READONLY }, { address: destination, role: AccountRole.WRITABLE }, { address: authority, role: AccountRole.READONLY_SIGNER }], data: bytesOf(12, u64le(amount), decimals) }),
  /// Memo v2: utf8 data, no accounts (unsigned memo).
  memo: (text) => ({ programAddress: MEMO_PROGRAM, accounts: [], data: Uint8Array.from(Buffer.from(text, "utf8")) }),
});

function amountKind({ lamports, usdcMicros }) {
  const hasSol = lamports != null, hasUsdc = usdcMicros != null;
  if (hasSol === hasUsdc) throw fail("exactly one of lamports or usdcMicros is required", "amount_invalid");
  const amount = hasSol ? lamports : usdcMicros;
  if (!isUint(amount) || amount === 0) throw fail("amount must be a positive safe integer", "amount_invalid");
  return { kind: hasSol ? "sol" : "usdc", amount };
}
function checkMemo(memo) {
  if (memo == null) return null;
  if (typeof memo !== "string" || memo.length === 0 || Buffer.byteLength(memo, "utf8") > MAX_MEMO_BYTES || /[ -]/.test(memo)) throw fail("memo must be 1..128 printable utf8 bytes", "memo_invalid");
  return memo;
}
function checkComputeBudget(computeUnitPrice, computeUnitLimit) {
  if (!isUint(computeUnitPrice) || computeUnitPrice > MAX_COMPUTE_UNIT_PRICE) throw fail(`computeUnitPrice must be 0..${MAX_COMPUTE_UNIT_PRICE} µlamports/CU`, "compute_budget_invalid");
  if (!isUint(computeUnitLimit) || computeUnitLimit === 0 || computeUnitLimit > MAX_COMPUTE_UNITS) throw fail(`computeUnitLimit must be 1..${MAX_COMPUTE_UNITS}`, "compute_budget_invalid");
}

/// A v0 message with ComputeBudget limit + price, then ONE transfer (System transfer for SOL,
/// SPL TransferChecked decimals 6 between the two USDC ATAs), then an optional memo. The
/// recipient ATA is NOT created here — call assertAtaExists first. Returns
/// { message, kind, from, to, lamports|usdcMicros, fromAta, toAta, computeUnitLimit, computeUnitPrice, maxFeeLamports, memo }.
export async function buildTransfer({ from, to, lamports, usdcMicros, blockhash, lastValidBlockHeight = 0, computeUnitPrice = DEFAULT_COMPUTE_UNIT_PRICE, computeUnitLimit, memo, feePayer = from } = {}) {
  assertAddress(from, "from"); assertAddress(to, "to"); assertAddress(feePayer, "fee payer");
  if (from === to) throw fail("from and to must differ", "amount_invalid");
  if (!isSolanaAddress(blockhash)) throw fail("blockhash must be base58 (32 bytes)", "blockhash_invalid");
  if (!isUint(lastValidBlockHeight)) throw fail("lastValidBlockHeight must be a non-negative integer", "blockhash_invalid");
  const { kind, amount } = amountKind({ lamports, usdcMicros });
  const limit = computeUnitLimit ?? (kind === "usdc" ? DEFAULT_COMPUTE_UNIT_LIMIT_USDC : DEFAULT_COMPUTE_UNIT_LIMIT_SOL);
  checkComputeBudget(computeUnitPrice, limit);
  const text = checkMemo(memo);
  const ixs = [instructions.setComputeUnitLimit(limit), instructions.setComputeUnitPrice(computeUnitPrice)];
  let fromAta = null, toAta = null;
  if (kind === "sol") ixs.push(instructions.systemTransfer(from, to, amount));
  else { fromAta = await ataOf(from); toAta = await ataOf(to); ixs.push(instructions.transferChecked(fromAta, USDC_MINT, toAta, from, amount, USDC_DECIMALS)); }
  if (text != null) ixs.push(instructions.memo(text));
  let message = createTransactionMessage({ version: 0 });
  message = setTransactionMessageFeePayer(feePayer, message);   // a sponsor (x402 facilitator) may pay the fee; `from` still signs the transfer
  message = setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight: BigInt(lastValidBlockHeight) }, message);
  message = appendTransactionMessageInstructions(ixs, message);
  return Object.freeze({ message, kind, from, to, feePayer, ...(kind === "sol" ? { lamports: amount } : { usdcMicros: amount }), fromAta, toAta, computeUnitLimit: limit, computeUnitPrice, maxFeeLamports: feeBudgetLamports(computeUnitPrice, limit), memo: text });
}

const messageOf = (built) => (built && typeof built === "object" && built.message ? built.message : built);

/// Base64 wire bytes of a message with an all-zero signature (for simulation / fee estimates).
export function unsignedWire(built) {
  return getBase64EncodedWireTransaction(compileTransaction(messageOf(built)));
}

/// Signs with `signer = { address, sign(bytes) → Uint8Array(64) }` (the fee payer). The
/// signature is verified locally before it is trusted. Returns
/// { wire (base64), signature (base58 — the idempotency key), messageBytes, messageSha256 }.
export async function signTransaction(built, signer) {
  const message = messageOf(built);
  if (!signer || !isSolanaAddress(signer.address) || typeof signer.sign !== "function") throw fail("signer must be { address, sign }", "signer_invalid");
  if (message?.feePayer?.address !== signer.address) throw fail("signer is not the fee payer of this message", "signer_invalid");
  const tx = compileTransaction(message);
  const sig = Uint8Array.from(await signer.sign(tx.messageBytes));
  if (sig.length !== 64) throw fail("signer returned a signature that is not 64 bytes", "signer_invalid");
  if (!verifyEd25519(tx.messageBytes, sig, signer.address)) throw fail("signer produced a signature that does not verify", "signer_invalid");
  const signed = { ...tx, signatures: Object.freeze({ ...tx.signatures, [signer.address]: sig }) };
  return Object.freeze({ wire: getBase64EncodedWireTransaction(signed), signature: base58Encode(sig), messageBytes: tx.messageBytes, messageSha256: sha256hex(tx.messageBytes) });
}

/// Signs a compiled message as ANY required signer (not necessarily the fee payer) — the
/// x402 Solana leg, where NanoGPT's facilitator is the fee payer and the treasury only
/// authorises the USDC transfer. Missing signatures stay zero (partially signed wire).
export async function partialSign(built, signer) {
  const message = messageOf(built);
  if (!signer || !isSolanaAddress(signer.address) || typeof signer.sign !== "function") throw fail("signer must be { address, sign }", "signer_invalid");
  const tx = compileTransaction(message);
  if (!Object.hasOwn(tx.signatures, signer.address)) throw fail("signer is not a required signer of this message", "signer_invalid");
  const sig = Uint8Array.from(await signer.sign(tx.messageBytes));
  if (sig.length !== 64 || !verifyEd25519(tx.messageBytes, sig, signer.address)) throw fail("signer produced a signature that does not verify", "signer_invalid");
  const signed = { ...tx, signatures: Object.freeze({ ...tx.signatures, [signer.address]: sig }) };
  return Object.freeze({ wire: getBase64EncodedWireTransaction(signed), signature: base58Encode(sig), messageBytes: tx.messageBytes, messageSha256: sha256hex(tx.messageBytes) });
}

/// Signs a foreign, unsigned wire transaction (e.g. a Jupiter swap built for our wallet as
/// fee payer) with `signer`. The caller has already decoded and simulated it. Returns
/// { wire, signature (base58 of the fee-payer signature = the transaction id) }.
export async function signWire(wire, signer) {
  if (!signer || !isSolanaAddress(signer.address) || typeof signer.sign !== "function") throw fail("signer must be { address, sign }", "signer_invalid");
  const bytes = Buffer.from(String(wire), "base64");
  let tx;
  try { tx = getTransactionDecoder().decode(bytes); } catch { throw fail("wire transaction does not decode", "wire_invalid"); }
  if (!Object.hasOwn(tx.signatures, signer.address)) throw fail("signer is not a required signer of this transaction", "signer_invalid");
  const sig = Uint8Array.from(await signer.sign(tx.messageBytes));
  if (sig.length !== 64 || !verifyEd25519(tx.messageBytes, sig, signer.address)) throw fail("signer produced a signature that does not verify", "signer_invalid");
  const signed = { ...tx, signatures: Object.freeze({ ...tx.signatures, [signer.address]: sig }) };
  return Object.freeze({ wire: getBase64EncodedWireTransaction(signed), signature: base58Encode(sig), messageSha256: sha256hex(tx.messageBytes) });
}

// ---------------------------------------------------------------- outbound guard
/// Decodes a base64 wire transaction into plain data:
/// { version, feePayer, blockhash, numSigners, staticAccounts, addressTableLookups, instructions:[{programId, accounts, data}], signature, signed, messageBytes, messageSha256 }.
/// Any account index that points into a lookup table decodes to undefined (and is refused by the guard).
export function decodeOutbound(wire) {
  if (typeof wire !== "string" || !BASE64_RE.test(wire)) throw fail("wire must be base64", "wire_invalid");
  const bytes = Buffer.from(wire, "base64");
  if (bytes.length === 0 || bytes.length > 1232 || bytes.toString("base64") !== wire) throw fail("wire must be canonical base64 of ≤ 1232 bytes", "wire_invalid");
  let tx, msg;
  try { tx = getTransactionDecoder().decode(bytes); msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes); }
  catch { throw fail("wire transaction does not decode", "wire_invalid"); }
  const staticAccounts = [...msg.staticAccounts];
  const instructionsOut = (msg.instructions ?? []).map((ix) => Object.freeze({
    programId: staticAccounts[ix.programAddressIndex],
    accounts: Object.freeze((ix.accountIndices ?? []).map((i) => staticAccounts[i])),
    data: Uint8Array.from(ix.data ?? []),
  }));
  const sigEntries = Object.values(tx.signatures ?? {});
  const first = sigEntries[0] ? Uint8Array.from(sigEntries[0]) : null;
  const signed = !!first && first.some((b) => b !== 0);
  return Object.freeze({
    version: msg.version, feePayer: staticAccounts[0], blockhash: msg.lifetimeToken,
    numSigners: msg.header?.numSignerAccounts ?? 0, numReadonlySigners: msg.header?.numReadonlySignerAccounts ?? 0, numReadonlyNonSigners: msg.header?.numReadonlyNonSignerAccounts ?? 0,
    staticAccounts: Object.freeze(staticAccounts), addressTableLookups: (msg.addressTableLookups ?? []).length,
    instructions: Object.freeze(instructionsOut), signature: signed ? base58Encode(first) : null, signed,
    messageBytes: tx.messageBytes, messageSha256: sha256hex(tx.messageBytes),
  });
}

const guardFail = (why) => fail(`outbound Solana transaction refused: ${why}`, "solana_outbound_rejected", { why });
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/// The outbound guard: refuses anything but exactly [SetComputeUnitLimit, SetComputeUnitPrice,
/// the one expected transfer, (memo iff expected)] from `from` to `to` with the exact amount,
/// one signer, no lookup tables, price ≤ maxComputeUnitPrice. Returns the parsed intent
/// { kind, from, to, lamports|usdcMicros, fromAta, toAta, computeUnitLimit, computeUnitPrice, maxFeeLamports, memo }.
export async function assertTransferShape(decoded, { from, to, lamports, usdcMicros, memo, maxComputeUnitPrice = MAX_COMPUTE_UNIT_PRICE } = {}) {
  assertAddress(from, "from"); assertAddress(to, "to");
  if (from === to) throw guardFail("from equals to");
  const { kind, amount } = amountKind({ lamports, usdcMicros });
  const text = checkMemo(memo);
  if (!decoded || typeof decoded !== "object" || !Array.isArray(decoded.instructions)) throw guardFail("not a decoded transaction");
  if (decoded.version !== 0) throw guardFail(`version ${decoded.version} is not v0`);
  if (decoded.addressTableLookups !== 0) throw guardFail("address lookup tables are not allowed");
  if (decoded.numSigners !== 1) throw guardFail(`${decoded.numSigners} signers, expected 1`);
  if (decoded.feePayer !== from) throw guardFail("fee payer is not the treasury");
  if (!isSolanaAddress(decoded.blockhash)) throw guardFail("missing blockhash");
  const expectedCount = text != null ? 4 : 3;
  if (decoded.instructions.length !== expectedCount) throw guardFail(`${decoded.instructions.length} instructions, expected ${expectedCount}`);
  const [limitIx, priceIx, transferIx, memoIx] = decoded.instructions;
  for (const ix of decoded.instructions) if (!ix.programId || ix.accounts.some((a) => !a)) throw guardFail("instruction references an account outside the static list");

  if (limitIx.programId !== COMPUTE_BUDGET_PROGRAM || limitIx.accounts.length !== 0 || limitIx.data.length !== 5 || limitIx.data[0] !== 2) throw guardFail("instruction 0 is not SetComputeUnitLimit");
  const computeUnitLimit = Buffer.from(limitIx.data).readUInt32LE(1);
  if (computeUnitLimit === 0 || computeUnitLimit > MAX_COMPUTE_UNITS) throw guardFail(`compute unit limit ${computeUnitLimit} out of range`);
  if (priceIx.programId !== COMPUTE_BUDGET_PROGRAM || priceIx.accounts.length !== 0 || priceIx.data.length !== 9 || priceIx.data[0] !== 3) throw guardFail("instruction 1 is not SetComputeUnitPrice");
  const priceBig = Buffer.from(priceIx.data).readBigUInt64LE(1);
  if (priceBig > BigInt(maxComputeUnitPrice)) throw guardFail(`compute unit price ${priceBig} exceeds ${maxComputeUnitPrice}`);
  const computeUnitPrice = Number(priceBig);

  let fromAta = null, toAta = null;
  if (kind === "sol") {
    if (transferIx.programId !== SYSTEM_PROGRAM) throw guardFail("instruction 2 is not a System transfer");
    if (!eq(transferIx.accounts, [from, to])) throw guardFail("System transfer accounts are not [from, to]");
    const d = Buffer.from(transferIx.data);
    if (d.length !== 12 || d.readUInt32LE(0) !== 2) throw guardFail("System instruction is not Transfer");
    if (d.readBigUInt64LE(4) !== BigInt(amount)) throw guardFail(`lamports ${d.readBigUInt64LE(4)} != expected ${amount}`);
  } else {
    fromAta = await ataOf(from); toAta = await ataOf(to);
    if (transferIx.programId !== TOKEN_PROGRAM) throw guardFail("instruction 2 is not an SPL Token instruction");
    if (!eq(transferIx.accounts, [fromAta, USDC_MINT, toAta, from])) throw guardFail("TransferChecked accounts are not [fromAta, USDC, toAta, from]");
    const d = Buffer.from(transferIx.data);
    if (d.length !== 10 || d[0] !== 12) throw guardFail("Token instruction is not TransferChecked");
    if (d.readBigUInt64LE(1) !== BigInt(amount)) throw guardFail(`usdc micros ${d.readBigUInt64LE(1)} != expected ${amount}`);
    if (d[9] !== USDC_DECIMALS) throw guardFail(`decimals ${d[9]} != ${USDC_DECIMALS}`);
  }
  if (text != null) {
    if (memoIx.programId !== MEMO_PROGRAM || memoIx.accounts.length !== 0 || Buffer.from(memoIx.data).toString("utf8") !== text) throw guardFail("memo instruction does not match");
  }
  const allowedAccounts = new Set([from, to, COMPUTE_BUDGET_PROGRAM, ...(kind === "sol" ? [SYSTEM_PROGRAM] : [TOKEN_PROGRAM, USDC_MINT, fromAta, toAta]), ...(text != null ? [MEMO_PROGRAM] : [])]);
  for (const a of decoded.staticAccounts) if (!allowedAccounts.has(a)) throw guardFail(`unexpected account ${a}`);
  return Object.freeze({ kind, from, to, ...(kind === "sol" ? { lamports: amount } : { usdcMicros: amount }), fromAta, toAta, computeUnitLimit, computeUnitPrice, maxFeeLamports: feeBudgetLamports(computeUnitPrice, computeUnitLimit), memo: text });
}

// ---------------------------------------------------------------- confirmation
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function statusVerdict(rpc, signature, searchTransactionHistory) {
  const res = await rpc.getSignatureStatuses([signature], { searchTransactionHistory });
  const st = res?.value?.[0] ?? null;
  const contextSlot = res?.context?.slot ?? null;
  if (!st) return { state: "pending", slot: null, err: null, confirmationStatus: null, contextSlot };
  const slot = st.slot ?? null, confirmationStatus = st.confirmationStatus ?? null;
  if (st.err != null) return { state: "failed", slot, err: st.err, confirmationStatus, contextSlot };
  if (confirmationStatus === "confirmed" || confirmationStatus === "finalized") return { state: "confirmed", slot, err: null, confirmationStatus, contextSlot };
  return { state: "pending", slot, err: null, confirmationStatus, contextSlot };   // processed: may still roll back
}

/// One-shot verdict for a signature persisted earlier (re-verification of an 'uncertain'
/// record): 'confirmed' | 'failed' | 'expired' (finalized block height passed
/// lastValidBlockHeight and history has no trace → can never land) | 'pending'.
export async function checkSignature(rpc, signature, { lastValidBlockHeight } = {}) {
  if (!isSolanaSignature(signature)) throw fail("signature must be base58", "signature_invalid");
  if (!isUint(lastValidBlockHeight)) throw fail("lastValidBlockHeight is required", "blockhash_invalid");
  const v = await statusVerdict(rpc, signature, true);
  if (v.state !== "pending" || v.slot != null) return v;
  const blockHeight = await rpc.getBlockHeight("finalized");
  if (blockHeight > lastValidBlockHeight) return { state: "expired", slot: null, err: null, confirmationStatus: null, blockHeight };
  return { ...v, blockHeight };
}

/// Polls getSignatureStatuses every `everyMs` until 'confirmed' | 'failed' (err from the
/// status) | 'expired' (finalized height > lastValidBlockHeight and searchTransactionHistory
/// still has nothing → the transaction can never land) | 'unknown' (timeout without a verdict —
/// the caller keeps the record 'uncertain' and calls checkSignature later). Transient RPC
/// errors are retried until the timeout; the last one is reported as `error`.
export async function confirmBounded(rpc, signature, { lastValidBlockHeight, everyMs = 2_000, timeoutMs = 90_000, now = Date.now, sleep = defaultSleep } = {}) {
  if (!isSolanaSignature(signature)) throw fail("signature must be base58", "signature_invalid");
  if (!isUint(lastValidBlockHeight)) throw fail("lastValidBlockHeight is required", "blockhash_invalid");
  const start = now();
  let last = null, lastError = null, polls = 0;
  for (;;) {
    try {
      polls++;
      const v = await statusVerdict(rpc, signature, false);
      last = v;
      if (v.state !== "pending") return { ...v, polls };
      if (v.slot == null) {
        const blockHeight = await rpc.getBlockHeight("finalized");
        if (blockHeight > lastValidBlockHeight) {
          const h = await statusVerdict(rpc, signature, true);
          if (h.state !== "pending") return { ...h, polls };
          if (h.slot == null) return { state: "expired", slot: null, err: null, confirmationStatus: null, blockHeight, polls };
          last = h;
        }
      }
    } catch (e) { lastError = e; }
    if (now() - start >= timeoutMs) return { state: "unknown", slot: last?.slot ?? null, err: null, confirmationStatus: last?.confirmationStatus ?? null, error: lastError ? String(lastError.message || lastError) : null, polls };
    await sleep(everyMs);
  }
}

// ---------------------------------------------------------------- transfer composition
/// blockhash → build → priority fee (Helius estimate clamped to [MIN, MAX] µlamports/CU) →
/// sign → guard. Returns { kind, wire, signature, blockhash, lastValidBlockHeight, computeUnitPrice,
/// computeUnitLimit, maxFeeLamports, messageSha256, from, to, lamports|usdcMicros, fromAta, toAta }
/// WITHOUT sending. For USDC the recipient ATA must exist (assertAtaExists runs first).
/// The caller persists `signature` before calling send(rpc, wire).
export async function transferOnce(rpc, { signer, to, lamports, usdcMicros, memo, computeUnitLimit, maxComputeUnitPrice = MAX_COMPUTE_UNIT_PRICE, minComputeUnitPrice = MIN_COMPUTE_UNIT_PRICE } = {}) {
  if (!signer || !isSolanaAddress(signer.address) || typeof signer.sign !== "function") throw fail("signer must be { address, sign }", "signer_invalid");
  assertAddress(to, "to");
  const { kind } = amountKind({ lamports, usdcMicros });
  if (!isUint(maxComputeUnitPrice) || maxComputeUnitPrice > MAX_COMPUTE_UNIT_PRICE || !isUint(minComputeUnitPrice) || minComputeUnitPrice > maxComputeUnitPrice) throw fail("compute unit price bounds are invalid", "compute_budget_invalid");
  const from = signer.address;
  if (kind === "usdc") await assertAtaExists(rpc, await ataOf(to), { owner: to });
  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash("confirmed");
  const base = { from, to, lamports, usdcMicros, blockhash, lastValidBlockHeight, computeUnitLimit, memo };
  const draft = await buildTransfer({ ...base, computeUnitPrice: DEFAULT_COMPUTE_UNIT_PRICE });
  const estimate = await rpc.getPriorityFeeEstimate([...new Set(draft.message.instructions.flatMap((ix) => [ix.programAddress, ...ix.accounts.map((a) => a.address)]))]);
  const computeUnitPrice = Math.min(maxComputeUnitPrice, Math.max(minComputeUnitPrice, Number.isFinite(estimate) ? Math.ceil(estimate) : DEFAULT_COMPUTE_UNIT_PRICE));
  const built = await buildTransfer({ ...base, computeUnitPrice });
  const { wire, signature, messageSha256 } = await signTransaction(built, signer);
  const shape = await assertTransferShape(decodeOutbound(wire), { from, to, lamports, usdcMicros, memo, maxComputeUnitPrice });
  return Object.freeze({ kind, wire, signature, blockhash, lastValidBlockHeight, computeUnitPrice: shape.computeUnitPrice, computeUnitLimit: shape.computeUnitLimit, maxFeeLamports: shape.maxFeeLamports, messageSha256, from, to, ...(kind === "sol" ? { lamports: shape.lamports } : { usdcMicros: shape.usdcMicros }), fromAta: shape.fromAta, toAta: shape.toAta, memo: shape.memo });
}

/// Broadcast previously signed wire bytes. Re-sending the same wire is always safe (one
/// signature lands at most once). When `signature` is given the node's answer must match it.
export async function send(rpc, wire, { signature, skipPreflight = false, maxRetries = 0, minContextSlot } = {}) {
  const accepted = await rpc.sendTransaction(wire, { skipPreflight, maxRetries, preflightCommitment: "confirmed", ...(minContextSlot != null ? { minContextSlot } : {}) });
  if (signature != null && accepted !== signature) throw fail(`node returned signature ${accepted}, expected ${signature}`, "send_signature_mismatch", { accepted, signature });
  return accepted;
}

// ---------------------------------------------------------------- receipt verification
const keyOf = (k) => (typeof k === "string" ? k : k?.pubkey);
function tokenDeltasByOwner(pre, post, mint) {
  const sum = (rows, sign, out) => {
    for (const row of rows ?? []) {
      if (row?.mint !== mint || !row.owner || typeof row.uiTokenAmount?.amount !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(row.uiTokenAmount.amount)) continue;
      const amount = BigInt(row.uiTokenAmount.amount);
      if (amount > MAX_U64) throw fail("token balance overflow", "receipt_invalid");
      out.set(row.owner, (out.get(row.owner) ?? 0n) + sign * amount);
    }
  };
  const deltas = new Map();
  sum(pre, -1n, deltas); sum(post, 1n, deltas);
  return deltas;
}

/// Reads the landed transaction and checks the real balance deltas: SOL — `from` lost exactly
/// lamports + fee and `to` gained exactly lamports; USDC — `from`'s USDC fell by usdcMicros,
/// `to`'s rose by usdcMicros, and `from` lost only the fee in SOL. Returns
/// { ok, state: 'verified'|'failed'|'missing'|'mismatch', slot, err, feeLamports, blockTime, deltas, why }.
export async function verifyTransfer(rpc, signature, { from, to, lamports, usdcMicros, commitment = "confirmed" } = {}) {
  if (!isSolanaSignature(signature)) throw fail("signature must be base58", "signature_invalid");
  assertAddress(from, "from"); assertAddress(to, "to");
  const { kind, amount } = amountKind({ lamports, usdcMicros });
  const tx = await rpc.getTransaction(signature, { commitment, encoding: "jsonParsed", maxSupportedTransactionVersion: 0 });
  if (!tx) return { ok: false, state: "missing", slot: null, err: null, feeLamports: null, blockTime: null, deltas: null, why: "not found at this commitment" };
  const meta = tx.meta ?? {};
  const slot = isUint(tx.slot) ? tx.slot : null, blockTime = isUint(tx.blockTime) ? tx.blockTime : null;
  const feeLamports = isUint(meta.fee) ? meta.fee : null;
  const mismatch = (why, deltas = null) => ({ ok: false, state: "mismatch", slot, err: null, feeLamports, blockTime, deltas, why });
  const signatures = tx.transaction?.signatures ?? [];
  if (signatures[0] !== signature) return mismatch("first signature differs");
  if (meta.err != null) return { ok: false, state: "failed", slot, err: meta.err, feeLamports, blockTime, deltas: null, why: "transaction failed on chain" };
  if (feeLamports == null) return mismatch("no fee in receipt");
  const keys = (tx.transaction?.message?.accountKeys ?? []).map(keyOf);
  const iFrom = keys.indexOf(from), iTo = keys.indexOf(to);
  const pre = meta.preBalances, post = meta.postBalances;
  if (iFrom < 0 || !Array.isArray(pre) || !Array.isArray(post) || pre.length !== keys.length || post.length !== keys.length || !pre.every(isUint) || !post.every(isUint)) return mismatch("payer not in transaction or balances missing");
  const fromLamports = post[iFrom] - pre[iFrom];
  if (kind === "sol") {
    if (iTo < 0) return mismatch("recipient not in transaction");
    const toLamports = post[iTo] - pre[iTo];
    const deltas = { fromLamports, toLamports };
    if (fromLamports !== -(amount + feeLamports)) return mismatch(`payer delta ${fromLamports} != -(${amount} + fee ${feeLamports})`, deltas);
    if (toLamports !== amount) return mismatch(`recipient delta ${toLamports} != ${amount}`, deltas);
    return { ok: true, state: "verified", slot, err: null, feeLamports, blockTime, deltas, why: null };
  }
  let byOwner;
  try { byOwner = tokenDeltasByOwner(meta.preTokenBalances, meta.postTokenBalances, USDC_MINT); } catch (e) { return mismatch(e.message); }
  const fromMicros = Number(byOwner.get(from) ?? 0n), toMicros = Number(byOwner.get(to) ?? 0n);
  const deltas = { fromLamports, fromMicros, toMicros };
  if (fromLamports !== -feeLamports) return mismatch(`payer SOL delta ${fromLamports} != -fee ${feeLamports}`, deltas);
  if (fromMicros !== -amount) return mismatch(`payer USDC delta ${fromMicros} != -${amount}`, deltas);
  if (toMicros !== amount) return mismatch(`recipient USDC delta ${toMicros} != ${amount}`, deltas);
  return { ok: true, state: "verified", slot, err: null, feeLamports, blockTime, deltas, why: null };
}

// ---------------------------------------------------------------- foreign v0 messages (Relay deposits)
export const LOOKUP_TABLE_PROGRAM = "AddressLookupTab1e1111111111111111111111111";
const LOOKUP_TABLE_META_BYTES = 56;
/// Address lookup tables by address, read from the chain: { [table]: [addresses…] }. A table
/// account is 56 bytes of metadata followed by 32-byte addresses.
export async function fetchLookupTables(rpc, addresses = []) {
  const out = {}, decoder = getAddressDecoder();
  for (const table of addresses) {
    assertAddress(table, "lookup table");
    const info = await rpc.getAccountInfo(table, { encoding: "base64" });
    if (!info) throw fail(`lookup table ${table} does not exist`, "lookup_table_missing");
    if (info.owner !== LOOKUP_TABLE_PROGRAM) throw fail(`lookup table ${table} is not owned by the lookup table program`, "lookup_table_invalid");
    const raw = Buffer.from(Array.isArray(info.data) ? String(info.data[0] || "") : String(info.data || ""), "base64");
    if (raw.length < LOOKUP_TABLE_META_BYTES || (raw.length - LOOKUP_TABLE_META_BYTES) % 32 !== 0) throw fail(`lookup table ${table} has an invalid size`, "lookup_table_invalid");
    const list = [];
    for (let o = LOOKUP_TABLE_META_BYTES; o < raw.length; o += 32) list.push(decoder.decode(raw.subarray(o, o + 32)));
    out[table] = list;
  }
  return out;
}

/// A foreign v0 message (a Relay deposit) built from plain instruction objects with the treasury
/// as fee payer and compressed with the given lookup tables. Returns { message, wire } where wire
/// is the unsigned base64 transaction — the caller decodes, simulates and bounds it before signing
/// (signWire), exactly like a Jupiter swap.
export function buildForeign({ feePayer, instructions, blockhash, lastValidBlockHeight = 0, lookupTables = {} } = {}) {
  assertAddress(feePayer, "fee payer");
  if (!isSolanaAddress(blockhash)) throw fail("blockhash must be base58 (32 bytes)", "blockhash_invalid");
  if (!isUint(lastValidBlockHeight)) throw fail("lastValidBlockHeight must be a non-negative integer", "blockhash_invalid");
  if (!Array.isArray(instructions) || !instructions.length || instructions.length > 8) throw fail("between 1 and 8 instructions are required", "instructions_invalid");
  const ixs = instructions.map((ix) => {
    assertAddress(ix.programAddress, "program");
    const accounts = (ix.accounts || []).map((a) => { assertAddress(a.address, "account"); if (![0, 1, 2, 3].includes(a.role)) throw fail("account role is invalid", "instructions_invalid"); return { address: a.address, role: a.role }; });
    return { programAddress: ix.programAddress, accounts, data: Uint8Array.from(ix.data || []) };
  });
  let message = createTransactionMessage({ version: 0 });
  message = setTransactionMessageFeePayer(feePayer, message);
  message = setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight: BigInt(lastValidBlockHeight) }, message);
  message = appendTransactionMessageInstructions(ixs, message);
  const tables = Object.fromEntries(Object.entries(lookupTables || {}).filter(([, list]) => Array.isArray(list) && list.length));
  if (Object.keys(tables).length) message = compressTransactionMessageUsingAddressLookupTables(message, tables);
  const built = Object.freeze({ message });
  return Object.freeze({ message, wire: unsignedWire(built) });
}
