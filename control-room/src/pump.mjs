// pump.fun client rail: the program addresses, PDAs, hand-encoded instructions
// (create_v2, buy_v2, sell_v2, init_user_volume_accumulator, collect_creator_fee_v2,
// ATA create), account decoders (Global, BondingCurve, FeeConfig), the curve maths
// and the metadata upload. Nothing here holds a key, sends or persists: the caller
// signs with wallets.mjs signers and sends through solana.mjs.
//
// Every layout below was checked byte-for-byte against a real mainnet CreateV2+BuyV2
// transaction (test/fixtures/pump-real-create.json) and the published IDLs
// (pump-fun/pump-public-docs idl/pump.json, pump_fees.json) on 2026-09-21.
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { getAddressEncoder, getProgramDerivedAddress } from "@solana/addresses";
import { AccountRole } from "@solana/instructions";
import { appendTransactionMessageInstructions, compressTransactionMessageUsingAddressLookupTables, createTransactionMessage, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from "@solana/transaction-messages";
import { ASSOCIATED_TOKEN_PROGRAM, DEFAULT_COMPUTE_UNIT_PRICE, SYSTEM_PROGRAM, TOKEN_PROGRAM, WSOL_MINT, base58Decode, base58Encode, instructions as budget, isSolanaAddress } from "./solana.mjs";

// ---------------------------------------------------------------- programs & limits
export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_FEE_PROGRAM = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";
export const PUMP_AMM_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const MAYHEM_PROGRAM = "MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const PUMP_IPFS_URL = "https://pump.fun/api/ipfs";
export const TOKEN_DECIMALS = 6;
export const NAME_MAX = 32;
export const SYMBOL_MAX = 13;
export const URI_MAX = 200;
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/// Curve trades pay 1.25 % in total (protocol + creator) at the tier a new coin sits in.
export const CURVE_FEE_BPS = 125;
export const BPS = 10_000n;
/// pump.fun's SDK example; a bundled create + buy consumed ~250k CU on chain.
export const CREATE_COMPUTE_UNITS = 400_000;
export const TRADE_COMPUTE_UNITS = 400_000;
export const COLLECT_COMPUTE_UNITS = 100_000;

const fail = (message, code, extra) => Object.assign(new Error(message), { code, ...extra });
const isUint = (x) => Number.isSafeInteger(x) && x >= 0;
const assertAddress = (v, what) => { if (!isSolanaAddress(v)) throw fail(`${what} is not a base58 Solana address`, "pump_address_invalid"); return v; };
const MAX_U64 = (1n << 64n) - 1n;
const toU64 = (v, what) => {
  const n = typeof v === "bigint" ? v : BigInt(v);
  if (n < 0n || n > MAX_U64) throw fail(`${what} is outside u64`, "pump_amount_invalid");
  return n;
};

/// Anchor's instruction discriminator: sha256("global:<name>")[0..8].
export const discriminator = (name) => Uint8Array.from(createHash("sha256").update(`global:${name}`).digest().subarray(0, 8));
export const DISCRIMINATORS = Object.freeze(Object.fromEntries(
  ["create_v2", "buy_v2", "sell_v2", "init_user_volume_accumulator", "collect_creator_fee_v2", "distribute_creator_fees_v2", "migrate_v2"].map((n) => [n, discriminator(n)]),
));

// ---------------------------------------------------------------- PDAs
const enc = getAddressEncoder();
const utf8 = (s) => new TextEncoder().encode(s);
const pda = async (seeds, programAddress) => (await getProgramDerivedAddress({ programAddress, seeds }))[0];
export const pdas = Object.freeze({
  global: () => pda([utf8("global")], PUMP_PROGRAM),
  mintAuthority: () => pda([utf8("mint-authority")], PUMP_PROGRAM),
  eventAuthority: (program = PUMP_PROGRAM) => pda([utf8("__event_authority")], program),
  bondingCurve: (mint) => pda([utf8("bonding-curve"), enc.encode(assertAddress(mint, "mint"))], PUMP_PROGRAM),
  creatorVault: (creator) => pda([utf8("creator-vault"), enc.encode(assertAddress(creator, "creator"))], PUMP_PROGRAM),
  globalVolumeAccumulator: () => pda([utf8("global_volume_accumulator")], PUMP_PROGRAM),
  userVolumeAccumulator: (user) => pda([utf8("user_volume_accumulator"), enc.encode(assertAddress(user, "user"))], PUMP_PROGRAM),
  feeConfig: () => pda([utf8("fee_config"), enc.encode(PUMP_PROGRAM)], PUMP_FEE_PROGRAM),
  sharingConfig: (mint) => pda([utf8("sharing-config"), enc.encode(assertAddress(mint, "mint"))], PUMP_FEE_PROGRAM),
  mayhemGlobalParams: () => pda([utf8("global-params")], MAYHEM_PROGRAM),
  mayhemSolVault: () => pda([utf8("sol-vault")], MAYHEM_PROGRAM),
  mayhemState: (mint) => pda([utf8("mayhem-state"), enc.encode(assertAddress(mint, "mint"))], MAYHEM_PROGRAM),
  /// Associated token account of `owner` for `mint` under `tokenProgram` (Token or Token-2022).
  ata: (owner, mint, tokenProgram) => pda([enc.encode(assertAddress(owner, "owner")), enc.encode(assertAddress(tokenProgram, "token program")), enc.encode(assertAddress(mint, "mint"))], ASSOCIATED_TOKEN_PROGRAM),
});

// ---------------------------------------------------------------- borsh helpers
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(toU64(n, "u64")); return b; };
const bool = (v) => Buffer.from([v ? 1 : 0]);
const str = (s, max, what) => {
  if (typeof s !== "string") throw fail(`${what} must be a string`, "pump_field_invalid");
  const bytes = Buffer.from(s, "utf8");
  if (bytes.length === 0 || bytes.length > max) throw fail(`${what} must be 1..${max} bytes`, "pump_field_invalid");
  return Buffer.concat([u32le(bytes.length), bytes]);
};
const pubkey = (a, what) => Buffer.from(base58Decode(assertAddress(a, what)));
const data = (...parts) => Uint8Array.from(Buffer.concat(parts.map((p) => Buffer.from(p))));
const R = (address) => ({ address, role: AccountRole.READONLY });
const W = (address) => ({ address, role: AccountRole.WRITABLE });
const RS = (address) => ({ address, role: AccountRole.READONLY_SIGNER });
const WS = (address) => ({ address, role: AccountRole.WRITABLE_SIGNER });

// ---------------------------------------------------------------- instructions
/// Associated Token Program `CreateIdempotent` (u8 1): [payer, ata, owner, mint, system, tokenProgram].
export async function createAtaIdempotent({ payer, owner, mint, tokenProgram = TOKEN_2022_PROGRAM }) {
  const ata = await pdas.ata(owner, mint, tokenProgram);
  return { programAddress: ASSOCIATED_TOKEN_PROGRAM, accounts: [WS(assertAddress(payer, "payer")), W(ata), R(owner), R(mint), R(SYSTEM_PROGRAM), R(tokenProgram)], data: Uint8Array.from([1]), ata };
}

/// `create_v2(name, symbol, uri, creator, is_mayhem_mode, is_cashback_enabled, creator_fee_bps, is_holder_reward)`.
/// `user` pays the rent and signs with the new `mint`; `creator` is who earns the creator fee
/// and may differ from `user`. Mayhem, cashback and holder-reward are always off: the creator
/// fee goes to `creator` (for us: the project's treasury), never to pump.fun's holder wallet.
/// `creator_fee_bps` is ignored by the program on SOL-paired coins and encoded as 0.
export async function createV2({ mint, user, creator, name, symbol, uri }) {
  assertAddress(mint, "mint"); assertAddress(user, "user"); assertAddress(creator, "creator");
  const bondingCurve = await pdas.bondingCurve(mint);
  const solVault = await pdas.mayhemSolVault();
  // mayhem_token_vault is the sol-vault PDA's Token-2022 ATA for the mint (checked against a real CreateV2).
  const accounts = [
    WS(mint), R(await pdas.mintAuthority()), W(bondingCurve), W(await pdas.ata(bondingCurve, mint, TOKEN_2022_PROGRAM)),
    R(await pdas.global()), WS(user), R(SYSTEM_PROGRAM), R(TOKEN_2022_PROGRAM), R(ASSOCIATED_TOKEN_PROGRAM),
    W(MAYHEM_PROGRAM), R(await pdas.mayhemGlobalParams()), W(solVault), W(await pdas.mayhemState(mint)), W(await pdas.ata(solVault, mint, TOKEN_2022_PROGRAM)),
    R(await pdas.eventAuthority()), R(PUMP_PROGRAM),
  ];
  return { programAddress: PUMP_PROGRAM, accounts, data: data(DISCRIMINATORS.create_v2, str(name, NAME_MAX, "name"), str(symbol, SYMBOL_MAX, "symbol"), str(uri, URI_MAX, "uri"), pubkey(creator, "creator"), bool(false), bool(false), u64le(0), bool(false)), bondingCurve };
}

/// The 25 accounts shared by buy_v2 / sell_v2 (buy adds global_volume_accumulator before the user's).
async function tradeAccounts({ mint, user, creator, feeRecipient, buybackFeeRecipient, withGlobalVolume }) {
  assertAddress(mint, "mint"); assertAddress(user, "user"); assertAddress(creator, "creator");
  assertAddress(feeRecipient, "fee recipient"); assertAddress(buybackFeeRecipient, "buyback fee recipient");
  const bondingCurve = await pdas.bondingCurve(mint);
  const creatorVault = await pdas.creatorVault(creator);
  const uva = await pdas.userVolumeAccumulator(user);
  const wsolAta = (owner) => pdas.ata(owner, WSOL_MINT, TOKEN_PROGRAM);
  return [
    R(await pdas.global()), R(mint), R(WSOL_MINT), R(TOKEN_2022_PROGRAM), R(TOKEN_PROGRAM), R(ASSOCIATED_TOKEN_PROGRAM),
    W(feeRecipient), W(await wsolAta(feeRecipient)), W(buybackFeeRecipient), W(await wsolAta(buybackFeeRecipient)),
    W(bondingCurve), W(await pdas.ata(bondingCurve, mint, TOKEN_2022_PROGRAM)), W(await wsolAta(bondingCurve)),
    WS(user), W(await pdas.ata(user, mint, TOKEN_2022_PROGRAM)), W(await wsolAta(user)),
    W(creatorVault), W(await wsolAta(creatorVault)),
    R(await pdas.sharingConfig(mint)),
    ...(withGlobalVolume ? [R(await pdas.globalVolumeAccumulator())] : []),
    W(uva), W(await wsolAta(uva)),
    R(await pdas.feeConfig()), R(PUMP_FEE_PROGRAM), R(SYSTEM_PROGRAM), R(await pdas.eventAuthority()), R(PUMP_PROGRAM),
  ];
}

/// `buy_v2(amount, max_sol_cost)`: `amount` base units to receive, `max_sol_cost` lamports
/// INCLUDING protocol + creator fees. `creator` is the curve's creator (BondingCurve.creator).
export async function buyV2({ mint, user, creator, feeRecipient, buybackFeeRecipient, amount, maxSolCost }) {
  const accounts = await tradeAccounts({ mint, user, creator, feeRecipient, buybackFeeRecipient, withGlobalVolume: true });
  return { programAddress: PUMP_PROGRAM, accounts, data: data(DISCRIMINATORS.buy_v2, u64le(amount), u64le(maxSolCost)) };
}

/// `sell_v2(amount, min_sol_output)`: `min_sol_output` is the net lamports after fees.
export async function sellV2({ mint, user, creator, feeRecipient, buybackFeeRecipient, amount, minSolOutput }) {
  const accounts = await tradeAccounts({ mint, user, creator, feeRecipient, buybackFeeRecipient, withGlobalVolume: false });
  return { programAddress: PUMP_PROGRAM, accounts, data: data(DISCRIMINATORS.sell_v2, u64le(amount), u64le(minSolOutput)) };
}

export async function initUserVolumeAccumulator({ payer, user }) {
  return { programAddress: PUMP_PROGRAM, accounts: [WS(assertAddress(payer, "payer")), R(assertAddress(user, "user")), W(await pdas.userVolumeAccumulator(user)), R(SYSTEM_PROGRAM), R(await pdas.eventAuthority()), R(PUMP_PROGRAM)], data: data(DISCRIMINATORS.init_user_volume_accumulator) };
}

/// `collect_creator_fee_v2`: permissionless. Moves the creator vault's lamports (minus its
/// rent floor) to `creator`; the vault's WSOL ATA is only used by non-SOL-quoted coins.
export async function collectCreatorFeeV2({ creator }) {
  assertAddress(creator, "creator");
  const vault = await pdas.creatorVault(creator);
  const accounts = [W(creator), W(await pdas.ata(creator, WSOL_MINT, TOKEN_PROGRAM)), W(vault), W(await pdas.ata(vault, WSOL_MINT, TOKEN_PROGRAM)),
    R(WSOL_MINT), R(TOKEN_PROGRAM), R(ASSOCIATED_TOKEN_PROGRAM), R(SYSTEM_PROGRAM), R(await pdas.eventAuthority()), R(PUMP_PROGRAM)];
  return { programAddress: PUMP_PROGRAM, accounts, data: data(DISCRIMINATORS.collect_creator_fee_v2), vault };
}

/// PumpSwap `collect_coin_creator_fee`: after graduation the creator fee accrues as WSOL in
/// the coin creator vault ATA; the coin creator signs and receives it in its own WSOL ATA.
export async function collectCoinCreatorFee({ coinCreator }) {
  assertAddress(coinCreator, "coin creator");
  const authority = await pda([utf8("creator_vault"), enc.encode(coinCreator)], PUMP_AMM_PROGRAM);
  const accounts = [R(WSOL_MINT), R(TOKEN_PROGRAM), RS(coinCreator), R(authority), W(await pdas.ata(authority, WSOL_MINT, TOKEN_PROGRAM)), W(await pdas.ata(coinCreator, WSOL_MINT, TOKEN_PROGRAM)),
    R(await pdas.eventAuthority(PUMP_AMM_PROGRAM)), R(PUMP_AMM_PROGRAM)];
  return { programAddress: PUMP_AMM_PROGRAM, accounts, data: data(discriminator("collect_coin_creator_fee")), vaultAuthority: authority };
}

/// SPL Token `CloseAccount` (u8 9): [account, destination, owner (signer)] — unwraps a WSOL ATA into SOL.
export function closeTokenAccount({ account, destination, owner, tokenProgram = TOKEN_PROGRAM }) {
  return { programAddress: tokenProgram, accounts: [W(assertAddress(account, "account")), W(assertAddress(destination, "destination")), RS(assertAddress(owner, "owner"))], data: Uint8Array.from([9]) };
}

// ---------------------------------------------------------------- transaction message
/// A v0 message: compute limit + price first, then `instructions`. Nothing is signed here.
export function buildMessage({ feePayer, blockhash, lastValidBlockHeight, instructions, computeUnitLimit, computeUnitPrice = DEFAULT_COMPUTE_UNIT_PRICE, lookupTables = {} }) {
  assertAddress(feePayer, "fee payer");
  if (!isSolanaAddress(blockhash)) throw fail("blockhash must be base58 (32 bytes)", "blockhash_invalid");
  if (!isUint(lastValidBlockHeight)) throw fail("lastValidBlockHeight must be a non-negative integer", "blockhash_invalid");
  if (!isUint(computeUnitLimit) || computeUnitLimit === 0 || computeUnitLimit > 1_400_000) throw fail("computeUnitLimit out of range", "compute_budget_invalid");
  if (!isUint(computeUnitPrice)) throw fail("computeUnitPrice must be a non-negative integer", "compute_budget_invalid");
  if (!Array.isArray(instructions) || instructions.length === 0) throw fail("at least one instruction is required", "pump_field_invalid");
  let message = createTransactionMessage({ version: 0 });
  message = setTransactionMessageFeePayer(feePayer, message);
  message = setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight: BigInt(lastValidBlockHeight) }, message);
  message = appendTransactionMessageInstructions([budget.setComputeUnitLimit(computeUnitLimit), budget.setComputeUnitPrice(computeUnitPrice), ...instructions.map(({ programAddress, accounts, data: d }) => ({ programAddress, accounts, data: d }))], message);
  if (Object.keys(lookupTables).length) message = compressTransactionMessageUsingAddressLookupTables(message, lookupTables);
  return message;
}

// ---------------------------------------------------------------- account decoders
const reader = (bytes) => {
  const b = Buffer.from(bytes);
  let o = 0;
  const need = (n) => { if (o + n > b.length) throw fail("account data is shorter than its layout", "pump_layout_invalid"); };
  return {
    u8: () => { need(1); return b[o++]; },
    bool: () => { need(1); return b[o++] === 1; },
    u64: () => { need(8); const v = b.readBigUInt64LE(o); o += 8; return v; },
    u128: () => { need(16); const lo = b.readBigUInt64LE(o), hi = b.readBigUInt64LE(o + 8); o += 16; return (hi << 64n) | lo; },
    pubkey: () => { need(32); const v = base58Encode(b.subarray(o, o + 32)); o += 32; return v; },
    u32: () => { need(4); const v = b.readUInt32LE(o); o += 4; return v; },
    skip: (n) => { need(n); o += n; },
    get offset() { return o; },
  };
};
const fromB64 = (v) => (typeof v === "string" ? Buffer.from(v, "base64") : Buffer.from(v));

/// pump.fun `Global` (1087 bytes on 2026-09-21), field order from idl/pump.json.
export function decodeGlobal(bytes) {
  const r = reader(fromB64(bytes)); r.skip(8);
  const g = { initialized: r.bool(), authority: r.pubkey(), feeRecipient: r.pubkey(), initialVirtualTokenReserves: r.u64(), initialVirtualSolReserves: r.u64(), initialRealTokenReserves: r.u64(), tokenTotalSupply: r.u64(), feeBasisPoints: r.u64(), withdrawAuthority: r.pubkey(), enableMigrate: r.bool(), poolMigrationFee: r.u64(), creatorFeeBasisPoints: r.u64() };
  g.feeRecipients = Array.from({ length: 7 }, () => r.pubkey());
  g.setCreatorAuthority = r.pubkey(); g.adminSetCreatorAuthority = r.pubkey(); g.createV2Enabled = r.bool(); g.whitelistPda = r.pubkey(); g.reservedFeeRecipient = r.pubkey(); g.mayhemModeEnabled = r.bool();
  g.reservedFeeRecipients = Array.from({ length: 7 }, () => r.pubkey());
  g.isCashbackEnabled = r.bool();
  g.buybackFeeRecipients = Array.from({ length: 8 }, () => r.pubkey());
  g.buybackBasisPoints = r.u64(); g.initialVirtualQuoteReserves = r.u64(); g.whitelistedQuoteMints = [r.pubkey()]; g.creatorFeeConfigurable = r.bool(); g.maxConfigurableCreatorFeeBps = r.u64(); g.holderRewardClaimAuthority = r.pubkey(); g.isHolderRewardEnabled = r.bool();
  return g;
}

/// pump.fun `BondingCurve`, field order from idl/pump.json (the account carries trailing padding).
/// `quoteMint` is the all-zero pubkey on SOL-quoted coins; `quoteIsSol` says so plainly.
export const SOL_QUOTE = "11111111111111111111111111111111";
export function decodeBondingCurve(bytes) {
  const r = reader(fromB64(bytes)); r.skip(8);
  const c = { virtualTokenReserves: r.u64(), virtualQuoteReserves: r.u64(), realTokenReserves: r.u64(), realQuoteReserves: r.u64(), tokenTotalSupply: r.u64(), complete: r.bool(), creator: r.pubkey(), isMayhemMode: r.bool(), isCashbackCoin: r.bool(), quoteMint: r.pubkey(), creatorFeeBps: r.u64(), canEditCreatorFee: r.bool(), isHolderReward: r.bool() };
  c.quoteIsSol = c.quoteMint === SOL_QUOTE || c.quoteMint === WSOL_MINT;
  return c;
}

/// Pump Fees `FeeConfig`: flat fees, market-cap tiers (SOL-quoted), stable tiers, exotic flat fees.
export function decodeFeeConfig(bytes) {
  const r = reader(fromB64(bytes)); r.skip(8);
  const fees = () => ({ lpFeeBps: r.u64(), protocolFeeBps: r.u64(), creatorFeeBps: r.u64() });
  const tiers = () => Array.from({ length: r.u32() }, () => ({ marketCapLamportsThreshold: r.u128(), fees: fees() }));
  return { bump: r.u8(), admin: r.pubkey(), flatFees: fees(), feeTiers: tiers(), stableFeeTiers: tiers(), exoticFlatFees: fees() };
}

/// The tier the fee program applies at `marketCapLamports` (pump-public-docs FEE_PROGRAM_README):
/// below the first threshold the first tier; otherwise the highest tier whose threshold is met.
export function feeTierFor(feeConfig, marketCapLamports) {
  const tiers = feeConfig.feeTiers;
  if (!tiers.length) return feeConfig.flatFees;
  const cap = BigInt(marketCapLamports);
  if (cap < tiers[0].marketCapLamportsThreshold) return tiers[0].fees;
  for (let i = tiers.length - 1; i >= 0; i--) if (cap >= tiers[i].marketCapLamportsThreshold) return tiers[i].fees;
  return tiers[0].fees;
}

// ---------------------------------------------------------------- curve maths (BigInt, floor like the program)
/// marketCap = virtualQuote × totalSupply ÷ virtualToken, in lamports.
export const marketCapLamports = (curve) => (curve.virtualQuoteReserves * curve.tokenTotalSupply) / curve.virtualTokenReserves;

/// Tokens the curve gives for `solIn` lamports (fees excluded), capped at the real reserve.
export function quoteBuy(curve, solIn, feeBps = CURVE_FEE_BPS) {
  const s = toU64(solIn, "solIn");
  if (s === 0n) throw fail("solIn must be positive", "pump_amount_invalid");
  let tokens = (s * curve.virtualTokenReserves) / (curve.virtualQuoteReserves + s);
  if (tokens > curve.realTokenReserves) tokens = curve.realTokenReserves;
  const fee = (s * BigInt(feeBps) + BPS - 1n) / BPS;
  return { tokensOut: tokens, solCost: s, feeLamports: fee, totalLamports: s + fee };
}

/// Lamports the curve pays for `tokens` base units, and the net after fees.
export function quoteSell(curve, tokens, feeBps = CURVE_FEE_BPS) {
  const t = toU64(tokens, "tokens");
  if (t === 0n) throw fail("tokens must be positive", "pump_amount_invalid");
  const gross = (t * curve.virtualQuoteReserves) / (curve.virtualTokenReserves + t);
  const fee = (gross * BigInt(feeBps) + BPS - 1n) / BPS;
  return { solOut: gross, feeLamports: fee, netLamports: gross - fee };
}

// ---------------------------------------------------------------- mint keypair
/// A fresh ed25519 keypair as a `{ address, sign }` signer whose secret never leaves the closure.
/// The mint signs its own `create_v2` once; afterwards pump.fun's PDA is the mint authority.
export function generateMintSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const address = base58Encode(Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url"));
  return Object.freeze({ address, chain: "solana", sign: async (message) => Uint8Array.from(edSign(null, Buffer.from(message), privateKey)) });
}

// ---------------------------------------------------------------- metadata
/// Uploads the logo + JSON to pump.fun's IPFS uploader (no session needed on 2026-09-21) and
/// returns `{ metadataUri, metadata }`. Only https `ipfs.io` / pump-hosted URIs are accepted back.
export async function uploadMetadata({ name, symbol, description = "", image, imageType = "image/png", website, twitter, telegram, showName = true, fetch: fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  str(name, NAME_MAX, "name"); str(symbol, SYMBOL_MAX, "symbol");
  if (typeof description !== "string" || Buffer.byteLength(description, "utf8") > 1_000) throw fail("description must be at most 1000 bytes", "pump_field_invalid");
  const bytes = image instanceof Uint8Array ? image : null;
  if (!bytes || bytes.length === 0 || bytes.length > IMAGE_MAX_BYTES) throw fail(`image must be 1..${IMAGE_MAX_BYTES} bytes`, "pump_field_invalid");
  if (!/^image\/(png|jpeg|gif|webp)$/.test(imageType)) throw fail("imageType must be png, jpeg, gif or webp", "pump_field_invalid");
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: imageType }), `logo.${imageType.split("/")[1]}`);
  form.append("name", name); form.append("symbol", symbol); form.append("description", description); form.append("showName", showName ? "true" : "false");
  for (const [k, v] of Object.entries({ website, twitter, telegram })) if (typeof v === "string" && v) { if (!/^https:\/\/[^\s]{1,190}$/.test(v)) throw fail(`${k} must be an https URL`, "pump_field_invalid"); form.append(k, v); }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response, text;
  try {
    response = await fetchImpl(PUMP_IPFS_URL, { method: "POST", body: form, signal: controller.signal, redirect: "error", headers: { accept: "application/json", "user-agent": "Mozilla/5.0" } });
    text = await response.text();
  } catch (e) { throw fail(`metadata upload failed: ${controller.signal.aborted ? "timeout" : String(e?.message || e)}`, "pump_upload_failed"); }
  finally { clearTimeout(timer); }
  if (!response.ok) throw fail(`metadata upload failed: HTTP ${response.status}`, "pump_upload_failed", { status: response.status });
  let json;
  try { json = JSON.parse(text); } catch { throw fail("metadata upload returned no JSON", "pump_upload_failed"); }
  const uri = json?.metadataUri;
  if (typeof uri !== "string" || uri.length > URI_MAX || !/^https:\/\/(ipfs\.io|[a-z0-9.-]*pump\.fun)\/[A-Za-z0-9./_-]+$/.test(uri)) throw fail("metadata upload returned an unexpected URI", "pump_upload_failed");
  return { metadataUri: uri, metadata: json.metadata ?? null };
}

/// Picks the fee recipients a trade must name: one of pump.fun's normal recipients and one
/// buyback recipient, both from the live Global (never hard-coded).
export function pickFeeRecipients(global, seed = Date.now()) {
  const normal = [global.feeRecipient, ...global.feeRecipients].filter(isSolanaAddress);
  const buyback = global.buybackFeeRecipients.filter(isSolanaAddress);
  if (!normal.length || !buyback.length) throw fail("Global has no fee recipients", "pump_layout_invalid");
  const i = Math.abs(Number(seed) | 0);
  return { feeRecipient: normal[i % normal.length], buybackFeeRecipient: buyback[i % buyback.length] };
}
