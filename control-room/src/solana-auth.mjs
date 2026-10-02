// Token / holder identity helpers that work for both chains, and Ed25519 holder
// signatures for Solana projects. EVM identities are lowercased (checksum case is
// cosmetic); Solana base58 identities are case-SENSITIVE and kept verbatim.
//
// Same semantics as the economy.mjs contract (TOKEN_RE / isSolanaChain / tokenKey):
// kept dependency-free here so transport modules (realtime, chat sessions) do not
// pull the whole economy graph. The verifier uses node:crypto only (no tweetnacl).
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { canonicalize } from "./canonical.mjs";

export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const SOLANA_SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
export const TOKEN_RE = /^(?:0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
// The same alternation as a regex source, for building route patterns.
export const TOKEN_ROUTE_SOURCE = "(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})";
// relay.mjs SOLANA_CHAIN_ID (Relay's id for Solana mainnet); duplicated so this module stays import-light.
export const SOLANA_CHAIN_ID = 792703809;
export const SOLANA_CHAIN = "solana";

/// True for the chain name 'solana' or for a base58 (non-0x) token/holder identity.
export function isSolanaChain(chainOrToken) {
  const v = String(chainOrToken ?? "");
  if (v.toLowerCase() === SOLANA_CHAIN) return true;
  return !/^0x/i.test(v) && SOLANA_ADDRESS_RE.test(v);
}

/// Store/map key for an identity: lowercase ONLY for EVM (0x) values.
export function identityKey(value) {
  const v = String(value ?? "");
  return /^0x/i.test(v) ? v.toLowerCase() : v;
}

/// Store key for a token: lowercased for EVM chains, verbatim for Solana mints.
export function tokenKey(chain, address) {
  const v = String(address ?? "");
  if (chain == null || chain === "") return identityKey(v);
  return isSolanaChain(chain) ? v : v.toLowerCase();
}

/// Holder key on a given token: base58 verbatim on Solana, lowercase 0x elsewhere.
export const holderKey = (t, holder) => (isSolanaChain(t?.chain) ? String(holder ?? "") : String(holder ?? "").toLowerCase());
/// The holder address pattern a token's holder routes accept.
export const holderPattern = (t) => (isSolanaChain(t?.chain) ? SOLANA_ADDRESS_RE : EVM_ADDRESS_RE);
/// Same wallet? Exact on Solana, case-insensitive on EVM.
export const sameHolder = (t, a, b) => holderKey(t, a) === holderKey(t, b);

/// Chat cookie name: EVM keeps `__Secure-gwchat_<40 hex>`; a Solana mint is never
/// placed in a cookie name — its sha256(tokenKey) prefix is used instead.
export function chatCookieName(token) {
  const key = identityKey(token);
  if (isSolanaChain(key)) return `__Secure-gwchat_${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
  return `__Secure-gwchat_${key.slice(2)}`;
}

// ── base58 (Bitcoin alphabet, as Solana uses) ─────────────────────────────────
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));

export function base58Decode(text) {
  if (typeof text !== "string" || !text.length) throw new Error("invalid base58");
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros++;
  const bytes = [];
  for (let k = zeros; k < text.length; k++) {
    let carry = INDEX.get(text[k]);
    if (carry === undefined) throw new Error("invalid base58 character");
    for (let i = 0; i < bytes.length; i++) { carry += bytes[i] * 58; bytes[i] = carry & 0xff; carry >>= 8; }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  const out = Buffer.alloc(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}

export function base58Encode(bytes) {
  const input = Buffer.from(bytes);
  let zeros = 0;
  while (zeros < input.length && input[zeros] === 0) zeros++;
  const digits = [];
  for (let k = zeros; k < input.length; k++) {
    let carry = input[k];
    for (let i = 0; i < digits.length; i++) { carry += digits[i] * 256; digits[i] = carry % 58; carry = Math.floor(carry / 58); }
    while (carry > 0) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  return "1".repeat(zeros) + digits.reverse().map((d) => ALPHABET[d]).join("");
}

// ── Ed25519 holder signatures (Phantom / Solflare signMessage over the canonical JSON) ──
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/// Raw 32-byte public key → node KeyObject (SPKI DER, OID 1.3.101.112).
export function ed25519PublicKey(raw32) {
  const raw = Buffer.from(raw32);
  if (raw.length !== 32) throw new Error("ed25519 public key must be 32 bytes");
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki" });
}

/// True only when `signatureBase58` is a 64-byte Ed25519 signature by the key
/// `holderBase58` (exact case) over UTF-8(canonicalize(payload)). Never throws.
export function verifySolanaSignature(payload, signatureBase58, holderBase58) {
  try {
    if (typeof signatureBase58 !== "string" || typeof holderBase58 !== "string") return false;
    if (!SOLANA_ADDRESS_RE.test(holderBase58) || !SOLANA_SIGNATURE_RE.test(signatureBase58)) return false;
    const signature = base58Decode(signatureBase58);
    if (signature.length !== 64) return false;
    const key = base58Decode(holderBase58);
    if (key.length !== 32) return false;
    const message = Buffer.from(canonicalize(payload), "utf8");
    return cryptoVerify(null, message, ed25519PublicKey(key), signature) === true;
  } catch {
    return false;
  }
}
