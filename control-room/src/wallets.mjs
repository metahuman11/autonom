// Private keys live ONLY in data/secrets/keys.json (mode 0600) and never leave this
// module: callers get addresses and signatures, never keys. Nothing here sends a
// transaction — the control room has no code path that moves funds.
//
// Treasury records come in two shapes under `treasuries[id]`:
//   EVM    { address, privateKey }                              (id = lowercased 0x / pending id)
//   Solana { chain:'solana', address, secretKey, createdAt }     (id = base58 mint, case-sensitive)
// where secretKey is base64 of 64 bytes (ed25519 seed ‖ public key, the Solana convention).
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign as ed25519Sign } from "node:crypto";
import { ethers } from "ethers";
import { DATA_DIR } from "./env.mjs";
import { canonicalize } from "./canonical.mjs";
import { base58Encode, isSolanaAddress } from "./solana.mjs";

const SECRETS_DIR = join(DATA_DIR, "secrets");
const KEYS_PATH = join(SECRETS_DIR, "keys.json");
// PKCS#8 DER prefix for a raw 32-byte ed25519 seed (RFC 8410), so node:crypto can sign.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/// Store key for a treasury id: EVM addresses and pending ids are lowercased exactly as
/// before; a base58 Solana mint is case-sensitive and kept as-is. Non-strings throw as before.
const POCKET_ID_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}:base-pocket$/;
const treasuryKey = (id) => (isSolanaAddress(id) || POCKET_ID_RE.test(id) ? id : id.toLowerCase());

function readKeys() {
  if (!existsSync(KEYS_PATH)) return { ops: null, agents: {}, holders: {} };
  return JSON.parse(readFileSync(KEYS_PATH, "utf8"));
}

function writeKeys(keys) {
  mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  chmodSync(SECRETS_DIR, 0o700);
  const tmp = `${KEYS_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(keys, null, 1), { mode: 0o600 });
  renameSync(tmp, KEYS_PATH);
  chmodSync(KEYS_PATH, 0o600);
}

export function opsAddress() {
  return readKeys().ops?.address || null;
}

/// The operations wallet you fund. Created once; a second call returns the same address.
export function createOpsWallet() {
  const keys = readKeys();
  if (keys.ops) return keys.ops.address;
  const w = ethers.Wallet.createRandom();
  keys.ops = { address: w.address, privateKey: w.privateKey, mnemonic: w.mnemonic?.phrase || null, createdAt: new Date().toISOString() };
  writeKeys(keys);
  return w.address;
}

/// The address that stands in for a token's contract until real launches exist. Its key
/// is KEPT (under `placeholders`) so money mistakenly sent to it is not lost — on
/// 2026-09-15 0.035 ETH went to a keyless placeholder and could not be recovered.
export function createPlaceholderAddress(label) {
  const keys = readKeys();
  keys.placeholders ||= {};
  const w = ethers.Wallet.createRandom();
  keys.placeholders[w.address.toLowerCase()] = { address: w.address, privateKey: w.privateKey, label, createdAt: new Date().toISOString() };
  writeKeys(keys);
  return w.address;
}

/// True when this process holds the key for `address` (any role). EVM addresses compare
/// case-insensitively as before; a base58 Solana address must match exactly.
export function haveKeyFor(address) {
  const keys = readKeys();
  const all = [keys.ops, ...Object.values(keys.agents || {}), ...Object.values(keys.treasuries || {}), ...Object.values(keys.placeholders || {}), ...Object.values(keys.holders || {})];
  if (!/^0x/i.test(String(address))) return all.some((w) => w && w.address === address);   // base58: exact, case-sensitive
  const a = String(address).toLowerCase();
  return all.some((w) => w && /^0x/i.test(String(w.address)) && String(w.address).toLowerCase() === a);
}

export function createAgentWallet(tokenAddress) {
  const keys = readKeys();
  const id = tokenAddress.toLowerCase();
  if (keys.agents[id]) return keys.agents[id].address;
  const w = ethers.Wallet.createRandom();
  keys.agents[id] = { address: w.address, privateKey: w.privateKey };
  writeKeys(keys);
  return w.address;
}

/// A treasury created before its token exists (a launch in flight) is filed under
/// the pending id; once the token is mined the same key is also filed under the
/// token address, so the treasury helpers keep working by token.
export function aliasTreasury(fromId, tokenAddress) {
  const keys = readKeys();
  keys.treasuries ||= {};
  const w = keys.treasuries[treasuryKey(String(fromId))];
  if (!w) throw new Error("no treasury under that id");
  keys.treasuries[treasuryKey(tokenAddress)] = w;
  writeKeys(keys);
  return w.address;
}

/// The token's treasury: the wallet holders fund and every AI request / VPS hour is
/// paid from. One per token; the key never leaves this module.
export function createTreasuryWallet(tokenAddress) {
  const keys = readKeys();
  keys.treasuries ||= {};
  const id = treasuryKey(tokenAddress);
  if (keys.treasuries[id]) {
    if (keys.treasuries[id].chain === "solana") throw new Error("treasury for this token is on Solana");
    return keys.treasuries[id].address;
  }
  const w = ethers.Wallet.createRandom();
  keys.treasuries[id] = { address: w.address, privateKey: w.privateKey };
  writeKeys(keys);
  return w.address;
}

/// The token's Solana treasury: an ed25519 keypair (node:crypto), filed under the same
/// `treasuries` map. Idempotent — a second call returns the existing address. Refuses an
/// id that already names an EVM treasury.
export function createSolanaTreasury(id) {
  const keys = readKeys();
  keys.treasuries ||= {};
  const key = treasuryKey(String(id));
  const existing = keys.treasuries[key];
  if (existing) {
    if (existing.chain !== "solana") throw new Error("treasury under that id is not on Solana");
    return existing.address;
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  if (seed.length !== 32 || pub.length !== 32) throw new Error("ed25519 key generation produced unexpected lengths");
  const address = base58Encode(pub);
  keys.treasuries[key] = { chain: "solana", address, secretKey: Buffer.concat([seed, pub]).toString("base64"), createdAt: new Date().toISOString() };
  writeKeys(keys);
  return address;
}

/// Removes a `pending:` treasury record that never became a project. Refuses any other id and
/// any pending record that was aliased to a token (the same key lives on under the token).
export function deletePendingTreasury(pendingId) {
  const id = treasuryKey(String(pendingId || ""));
  if (!id.startsWith("pending:")) throw new Error("only pending treasury records can be deleted");
  const keys = readKeys();
  const rec = keys.treasuries?.[id];
  if (!rec) return false;
  const aliased = Object.entries(keys.treasuries).some(([k, v]) => k !== id && v.address === rec.address);
  if (aliased) return false;
  delete keys.treasuries[id];
  writeKeys(keys);
  return true;
}

export function treasuryAddress(tokenAddress) {
  return readKeys().treasuries?.[treasuryKey(tokenAddress)]?.address || null;
}

/// The Solana treasury as a signer: `{ address, chain:'solana', sign(bytes) → Uint8Array(64) }`.
/// The key object stays inside the closure; the returned object serialises to the address
/// only. Refuses when the record is not a Solana treasury or does not match its own address.
export function solanaTreasurySigner(tokenId) {
  const rec = readKeys().treasuries?.[treasuryKey(tokenId)];
  if (!rec) throw new Error("no treasury wallet for this token");
  if (rec.chain !== "solana") throw new Error("treasury for this token is not on Solana");
  const bytes = Buffer.from(String(rec.secretKey || ""), "base64");
  if (bytes.length !== 64) throw new Error("solana treasury record is corrupt");
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, bytes.subarray(0, 32)]), format: "der", type: "pkcs8" });
  const pub = Buffer.from(createPublicKey(key).export({ format: "jwk" }).x, "base64url");
  if (!pub.equals(bytes.subarray(32)) || base58Encode(pub) !== rec.address) throw new Error("solana treasury record is corrupt");
  const address = rec.address;
  return Object.freeze({
    address, chain: "solana",
    sign: async (message) => {
      if (!(message instanceof Uint8Array)) throw new Error("sign() takes bytes");
      return Uint8Array.from(ed25519Sign(null, Buffer.from(message), key));
    },
  });
}

/// EIP-712 signature by the token's treasury — used ONLY for USDC
/// transferWithAuthorization (x402 payments and VPS hours). Amount and recipient are
/// the caller's; the caller is the gateway's own payment code, never a request body.
export async function signTypedDataAsTreasury(tokenAddress, domain, types, value) {
  const rec = readKeys().treasuries?.[treasuryKey(tokenAddress)];
  if (!rec) throw new Error("no treasury wallet for this token");
  if (rec.chain === "solana") throw new Error("treasury for this token is on Solana");
  return await new ethers.Wallet(rec.privateKey).signTypedData(domain, types, value);
}

/// The operations wallet as a signer, for submitting authorized USDC transfers (it
/// pays the gas) and for funding a token treasury from operations.
export function opsSigner(provider) {
  const rec = readKeys().ops;
  if (!rec) throw new Error("no operations wallet");
  return new ethers.Wallet(rec.privateKey, provider);
}
/// The treasury as a transaction signer — only billing.mjs uses it, only for the
/// hourly USDG transfer to operations.
opsSigner.treasury = (tokenAddress, provider) => {
  const rec = readKeys().treasuries?.[treasuryKey(tokenAddress)];
  if (!rec) throw new Error("no treasury wallet for this token");
  if (rec.chain === "solana") throw new Error("treasury for this token is on Solana");
  return new ethers.Wallet(rec.privateKey, provider);
};

export function createHolderWallet() {
  const keys = readKeys();
  const w = ethers.Wallet.createRandom();
  keys.holders[w.address.toLowerCase()] = w.privateKey;
  writeKeys(keys);
  return w.address;
}

/// EIP-191 personal_sign over the canonical JSON of `payload`, as the token's agent.
/// Only the simulated VPS signer service calls this.
export async function signAsAgent(tokenAddress, payload) {
  const rec = readKeys().agents[tokenAddress.toLowerCase()];
  if (!rec) throw new Error("no agent wallet for this token");
  return await new ethers.Wallet(rec.privateKey).signMessage(canonicalize(payload));
}

/// Simulated holder signatures, standing in for a holder's own wallet in the browser.
export async function signAsHolder(holderAddress, payload) {
  const pk = readKeys().holders[holderAddress.toLowerCase()];
  if (!pk) throw new Error("not a simulated holder wallet");
  return await new ethers.Wallet(pk).signMessage(canonicalize(payload));
}

/// A Solana project's AI pocket on Base: an EVM key filed under `<mint>:base-pocket` in the same
/// treasuries map (never the mint itself, which names the Solana treasury). NanoGPT's Solana x402
/// rail was refused by its facilitator (2026-09-22), its Base rail works — so a Solana project
/// keeps a Base USDC pocket, refilled from its own treasury through Relay, and signs EIP-3009
/// authorizations with this key. Idempotent; the key never leaves this module.
export const basePocketId = (mint) => `${String(mint)}:base-pocket`;
export function createBasePocket(mint) {
  if (!isSolanaAddress(String(mint || ""))) throw new Error("a base58 Solana mint is required for a Base pocket");
  return createTreasuryWallet(basePocketId(mint));
}
export function basePocketAddress(mint) { return treasuryAddress(basePocketId(mint)); }
/// The Base pocket as an ethers signer (pays its own gas for direct USDC transfers). The key
/// object stays inside ethers' Wallet; nothing here returns key material.
export function basePocketSigner(mint, provider) {
  const rec = readKeys().treasuries?.[treasuryKey(basePocketId(mint))];
  if (!rec) throw new Error("no Base pocket for this mint");
  if (rec.chain === "solana") throw new Error("the Base pocket record is not an EVM key");
  return new ethers.Wallet(rec.privateKey, provider);
}
