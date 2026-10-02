// Defense in depth for user-visible text, not a substitute for secret isolation.
import { isIP } from "node:net";
const PRIVATE = [
  /-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END (?:[A-Z ]*PRIVATE KEY)-----/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]{8,}/gi,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|gb_api_[A-Za-z0-9_-]{16,})\b/g,
  /\b(?:0x)?[a-fA-F0-9]{64}\b/g,
  /(?:\b(?:password|passwd|secret|api[_ -]?key|access[_ -]?token|private[_ -]?key|mnemonic|seed[_ -]?phrase|sifre|parola)|şifre)["']?\s*[=:]\s*["']?[^\s"',;}{]{4,}/gi,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  /([?&](?:token|key|password|secret|api_key|access_token)=)[^&#\s]+/gi,
];
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
export function publicText(value) {
  let text = String(value ?? "").normalize("NFKC").replace(INVISIBLE, "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  for (const pattern of PRIVATE) text = text.replace(pattern, "[REDACTED]");
  text = text.replace(/(?<![\w:])(?:[a-fA-F0-9]*:){2,}[a-fA-F0-9]*(?![\w:])/g, (part) => isIP(part) === 6 ? "[REDACTED]" : part);
  return text;
}
export function requirePublicText(value) {
  if (typeof value !== "string" || publicText(value) !== value) throw Object.assign(new Error("content contains protected information or control characters"), { status: 400 });
  return value;
}
export function publicTree(value, depth = 0) {
  if (depth > 32) return "[REDACTED]";
  if (typeof value === "string") return publicText(value);
  if (Array.isArray(value)) return value.map((item) => publicTree(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(?:password|passwd|secret|secrets|apiKey|api_key|accessToken|access_token|privateKey|private_key|mnemonic|session|sessionHash|streamKey|streamKeyHash|ssh_host|host|hostname|ip)$/i.test(publicText(key))).map(([key, item]) => [publicText(key), publicTree(item, depth + 1)]));
  return value;
}
export function pickPublic(value, keys) {
  return Object.fromEntries(keys.filter((key) => value && Object.hasOwn(value, key)).map((key) => [key, publicTree(value[key])]));
}
export const publicOffer = (value) => pickPublic(value, ["id", "gpu", "dph", "ramGb", "cpus", "diskGb", "numGpus", "gpuRamGb", "cuda", "geo", "upMbps", "downMbps", "uploadMbps", "downloadMbps", "reliability", "simulated"]);

// Only call on typed on-chain/ledger DTOs produced by trusted indexers. Never
// exempt arbitrary model JSON merely because it calls a field "tx" or "hash".
// A trade/ledger tx id is an EVM 0x-64-hex hash or a Solana base58 signature (64-88 chars).
export const TX_ID_RE = /^(?:0x[a-fA-F0-9]{64}|[1-9A-HJ-NP-Za-km-z]{64,88})$/;
export function publicTransactions(entries) {
  return (entries || []).map((entry) => {
    const safe = publicTree(entry);
    if (typeof entry.tx === "string" && TX_ID_RE.test(entry.tx)) safe.tx = entry.tx;
    return safe;
  });
}
export function publicMarket(value) {
  if (!value) return value;
  return { ...publicTree(value), trades: publicTransactions(value.trades) };
}

export function requireInertHtml(value) {
  const text = String(value ?? "").normalize("NFKC");
  // Conservative rejection, not regex HTML sanitization. CSP separately disables
  // active behavior even if malformed browser syntax eludes this explicit check.
  if (/<\s*\/?\s*(?:script|meta|base|form|input|button|select|textarea|iframe|frame|frameset|object|embed|svg|math)\b/i.test(text) || /\son[a-z]+\s*=/i.test(text)) {
    throw Object.assign(new Error("active HTML, forms, redirects and embedded documents are not permitted"), { status: 403 });
  }
  return text;
}
