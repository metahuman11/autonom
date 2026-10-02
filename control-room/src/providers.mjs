// AI providers the operator can pick for an agent. Keys live only in the server's
// .env; the VPS calls the gateway's proxy with its session and never sees them.
// Every provider here speaks the OpenAI chat-completions dialect.
import { env } from "./env.mjs";

const CATALOG = [
  { id: "simulated", name: "Simülasyon (ücretsiz, sabit cevaplar)", baseUrl: null, keyEnv: null, defaultModel: "simulated" },
  // No key: every request is paid from the token's treasury (Base USDC) via x402.
  { id: "nanogpt-x402", name: "NanoGPT · hazine cüzdanından öde (anahtarsız)", baseUrl: "https://nano-gpt.com/api/v1", keyEnv: null, defaultModel: "anthropic/claude-sonnet-5", x402: true },
  { id: "nanogpt", name: "NanoGPT (Claude, GPT, açık modeller)", baseUrl: "https://nano-gpt.com/api/v1", keyEnv: "NANOGPT_API_KEY", defaultModel: "anthropic/claude-sonnet-5" },
  { id: "minirouter", name: "MiniRouter (Solana ile ödeme)", baseUrl: "https://api.minirouter.sh/v1", keyEnv: "MINIROUTER_API_KEY", defaultModel: "anthropic/claude-haiku-4.5" },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", defaultModel: "anthropic/claude-sonnet-4.5" },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", defaultModel: "gpt-5-mini" },
];

const modelCache = new Map();
export const X402_ID = "nanogpt-x402";

// The upstream's own model card, rather than the router's broad modality tags,
// defines this known incompatibility. Keep the ID selectable in stored projects
// and in the pricing cache; do not silently replace it or rewrite its prompts.
// https://docs.ionos.com/cloud/ai/ai-model-hub/models/ocr-models/lightonocr-2-1b
/// The models a project may run its agent on: frontier conversational models that follow
/// instructions and return text. NanoGPT's catalogue (500+ entries: OCR, vision-only, embedding,
/// speech, image, tiny and roleplay models) is kept for pricing only; nothing outside this list
/// is offered to a creator, accepted by a plan, or run for an agent.
export const AGENT_MODELS = [   // owner 2026-10-02: only the models our agent runtime is built for — Claude and OpenAI GPT/Codex
  "anthropic/claude-fable-5.1", "anthropic/claude-opus-5", "anthropic/claude-sonnet-5", "anthropic/claude-haiku-4.5",
  "openai/gpt-5.5", "openai/gpt-5.4", "openai/gpt-5.4-mini", "openai/gpt-5-mini", "openai/gpt-5.1-codex-mini",
];
const AGENT_MODEL_IDS = new Set(AGENT_MODELS.map((m) => m.toLowerCase()));
export function agentModelCompatibility(model) {
  const id = typeof model === 'string' ? model.trim().toLowerCase() : '';
  if (!id) return { supported: false, code: 'ai_model_required', message: 'No AI model is set for this project.' };
  if (AGENT_MODEL_IDS.has(id)) return { supported: true, code: null, message: null };
  return {
    supported: false, code: 'ai_model_incompatible',
    message: `The model ${model} is not a conversational agent model and cannot run this project's AI. Pick one of the supported chat models.`,
  };
}
/// The catalogue entries (with live prices) for AGENT_MODELS, in that order; what the launch page
/// and the control room offer.
export async function listAgentModels() {
  const all = await listModelsDetailed();
  const byId = new Map(all.map((m) => [m.id.toLowerCase(), m]));
  return AGENT_MODELS.map((id) => byId.get(id.toLowerCase())).filter(Boolean).map((m) => ({ ...m, featured: true }));
}
export function assertAgentModelCompatible(model) {
  const compatibility = agentModelCompatibility(model);
  if (!compatibility.supported) throw Object.assign(new Error(compatibility.message), { status: 409, code: compatibility.code });
}

export function listProviders() {
  return CATALOG.map((p) => ({ id: p.id, name: p.name, defaultModel: p.defaultModel, configured: !p.keyEnv || !!env(p.keyEnv), x402: !!p.x402 }));
}

export function providerOf(id) {
  const p = CATALOG.find((x) => x.id === id);
  if (!p) throw Object.assign(new Error("unknown AI provider"), { status: 400 });
  if (p.keyEnv && !env(p.keyEnv)) throw Object.assign(new Error(`${p.name}: ${p.keyEnv} is not set in .env`), { status: 400 });
  return p;
}

/// Model ids the provider advertises (cached 10 min); empty when it cannot say.
export async function listModels(id) {
  const p = providerOf(id);
  if (!p.baseUrl) return ["simulated"];
  const c = modelCache.get(id);
  if (c && Date.now() - c.at < 600_000) return c.models;
  try {
    const res = await fetch(`${p.baseUrl}/models`, { headers: p.keyEnv ? { Authorization: `Bearer ${env(p.keyEnv)}` } : {}, signal: AbortSignal.timeout(15_000) });
    const j = await res.json();
    const models = (j?.data || []).map((m) => m.id).filter(Boolean).sort();
    modelCache.set(id, { at: Date.now(), models });
    return models;
  } catch { return []; }
}

// The models the operator picks from. NanoGPT is the only rail: the treasury pays each
// request via x402, so the choice is *which model to rent*, shown with its price.
// Prices come from NanoGPT's own catalog (USD per million tokens, at cost).
const FEATURED = [
  "anthropic/claude-fable-5.1", "anthropic/claude-opus-5", "anthropic/claude-sonnet-5", "anthropic/claude-haiku-4.5",
  "openai/gpt-5.5", "openai/gpt-5.4", "openai/gpt-5.4-mini",
  "google/gemini-3.5-pro", "google/gemini-3.5-flash",
  "deepseek/deepseek-v4-pro", "moonshotai/kimi-k2.6", "qwen/qwen3.6-plus",
];
const VENDOR_NAMES = { anthropic: "Anthropic (Claude)", openai: "OpenAI (GPT)", google: "Google (Gemini)", deepseek: "DeepSeek", moonshotai: "Moonshot (Kimi)", qwen: "Qwen", "x-ai": "xAI (Grok)", "meta-llama": "Meta (Llama)", mistralai: "Mistral" };
// Used when NanoGPT cannot be reached, so the picker is never empty (2026-09-15 prices).
const FALLBACK_MODELS = [
  { id: "anthropic/claude-fable-5.1", name: "Claude Fable 5.1", promptUsd: 10, completionUsd: 50, context: 1_000_000 },
  { id: "anthropic/claude-opus-5", name: "Claude Opus 5", promptUsd: 5, completionUsd: 25, context: 1_000_000 },
  { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", promptUsd: 2, completionUsd: 10, context: 1_000_000 },
  { id: "anthropic/claude-haiku-4.5", name: "Claude Haiku 4.5", promptUsd: 1, completionUsd: 5, context: 200_000 },
  { id: "openai/gpt-5.5", name: "GPT 5.5", promptUsd: 5, completionUsd: 30, context: 400_000 },
  { id: "google/gemini-3.5-flash", name: "Gemini 3.5 Flash", promptUsd: 1.5, completionUsd: 9, context: 1_000_000 },
  { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", promptUsd: 1.1, completionUsd: 2.2, context: 1_000_000 },
];
let detailedCache = null;

/// NanoGPT's text chat models with prices: {id, name, vendor, vendorName, promptUsd,
/// completionUsd (per 1M tokens), context, maxOutput, featured}. Featured ones first.
export async function listModelsDetailed() {
  if (detailedCache && Date.now() - detailedCache.at < 600_000) return detailedCache.models;
  const base = env("NANOGPT_X402_BASE", "https://nano-gpt.com/api/v1").replace(/\/$/, "");
  let raw = [];
  if (env("GATEWAY_OFFLINE")) return FALLBACK_MODELS.map((m) => ({ ...m, maxOutput: null, vendor: m.id.split("/")[0], vendorName: VENDOR_NAMES[m.id.split("/")[0]] || m.id.split("/")[0], featured: FEATURED.includes(m.id) }));
  try {
    const res = await fetch(`${base}/models?detailed=true`, { signal: AbortSignal.timeout(15_000) });
    const j = await res.json();
    raw = Array.isArray(j?.data) ? j.data : [];
  } catch { raw = []; }
  const seen = new Set();
  let models = raw.map((m) => {
    const out = m.architecture?.output_modalities;
    if (Array.isArray(out) && !out.includes("text")) return null;
    const p = Number(m.pricing?.prompt), c = Number(m.pricing?.completion);
    if (!m.id || !(p >= 0) || !(c >= 0) || String(m.pricing?.unit || "per_million_tokens") !== "per_million_tokens") return null;
    if (/^(Uncensored|Roleplay\/storytelling models)$/.test(String(m.category || ""))) return null;
    return { id: m.id, name: m.name || m.id, promptUsd: p, completionUsd: c, context: Number(m.context_length) || null, maxOutput: Number(m.max_output_tokens) || null };
  }).filter((m) => m && !seen.has(m.id) && seen.add(m.id));
  const source = models.length ? "nanogpt" : "fallback";
  if (!models.length) models = FALLBACK_MODELS.map((m) => ({ ...m, maxOutput: null }));
  for (const m of models) {
    m.vendor = m.id.includes("/") ? m.id.split("/")[0] : "other";
    m.vendorName = VENDOR_NAMES[m.vendor] || m.vendor;
    m.featured = FEATURED.indexOf(m.id);
  }
  models.sort((a, b) => (a.featured < 0) - (b.featured < 0) || (a.featured >= 0 ? a.featured - b.featured : 0) || a.vendorName.localeCompare(b.vendorName) || a.promptUsd - b.promptUsd || a.name.localeCompare(b.name));
  for (const m of models) m.featured = m.featured >= 0;
  if (source === "nanogpt") detailedCache = { at: Date.now(), models };
  return models;
}

/// The default rental: the first featured model NanoGPT actually lists.
export async function defaultModel() {
  const models = await listAgentModels();
  return models[0]?.id || CATALOG.find((p) => p.id === X402_ID).defaultModel;
}

// Private diagnostic for an upstream rejection. Preserve only request shape,
// never prompts, arbitrary field names, headers, URLs or provider error prose.
// An unknown error remains unknown; this is not evidence for a model adapter.
const DIAGNOSTIC_FIELDS = new Set(['model', 'messages', 'stream', 'max_tokens', 'max_completion_tokens', 'max_output_tokens',
  'n', 'temperature', 'top_p', 'top_k', 'min_p', 'stop', 'seed', 'presence_penalty', 'frequency_penalty',
  'repetition_penalty', 'logit_bias', 'logprobs', 'top_logprobs', 'tools', 'tool_choice', 'parallel_tool_calls',
  'functions', 'function_call', 'response_format', 'reasoning', 'reasoning_effort', 'provider', 'user',
  'stream_options', 'modalities', 'audio', 'prediction', 'service_tier', 'store', 'metadata']);
const DIAGNOSTIC_ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool', 'function']);
const DIAGNOSTIC_ERROR_TYPES = new Set(['invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error',
  'rate_limit_error', 'insufficient_quota', 'api_error', 'server_error', 'upstream_error', 'context_length_exceeded', 'validation_error']);
const DIAGNOSTIC_ERROR_CODES = new Set(['invalid_request', 'invalid_request_error', 'invalid_request_parameters', 'invalid_parameter',
  'unsupported_parameter', 'unsupported_value', 'context_length_exceeded', 'max_tokens_exceeded', 'model_not_found',
  'invalid_model', 'invalid_api_key', 'missing_api_key', 'insufficient_quota', 'rate_limit_exceeded', 'rate_limit_error',
  'server_error', 'upstream_error', 'provider_error', 'validation_error', 'bad_request']);
const diagnosticEnum = (value, allowed) => typeof value === 'string' && allowed.has(value.toLowerCase()) ? value.toLowerCase() : null;
const diagnosticType = value => value === null ? 'null' : Array.isArray(value) ? 'array'
  : ['string', 'number', 'boolean', 'object', 'undefined'].includes(typeof value) ? typeof value : 'unknown';
const diagnosticParam = value => {
  if (typeof value !== 'string' || value.length > 100) return null;
  if (DIAGNOSTIC_FIELDS.has(value)) return value;
  // These paths contain only numeric positions and known schema keys.
  return /^(?:messages(?:\.[0-9]{1,4}|\[[0-9]{1,4}\])(?:\.(?:role|content|name|tool_calls|tool_call_id))?|tools(?:\.[0-9]{1,4}|\[[0-9]{1,4}\])(?:\.(?:type|function|name|parameters))?)$/.test(value) ? value : null;
};
export function providerRequestDiagnostic(id, model, payload, upstreamStatus, error) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const fields = payload && typeof payload === 'object' && !Array.isArray(payload) ? Object.keys(payload) : [];
  const contentBytes = value => {
    try { return Math.min(1_000_000, Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value) || '', 'utf8')); }
    catch { return null; }
  };
  const safeModel = typeof model === 'string' && model.length <= 160 && !model.includes('://') &&
    /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(model) ? model : null;
  return { version: 1, provider: CATALOG.some(p => p.id === id) ? id : null, model: safeModel,
    upstreamStatus: Number.isInteger(upstreamStatus) && upstreamStatus >= 100 && upstreamStatus <= 599 ? upstreamStatus : null,
    messageCount: Math.min(100_000, messages.length),
    messages: messages.slice(0, 64).map((message, index) => ({ index,
      role: DIAGNOSTIC_ROLES.has(message?.role) ? message.role : 'unknown', contentUtf8Bytes: contentBytes(message?.content) })),
    messageDetailsTruncated: messages.length > 64,
    topLevelFields: fields.filter(name => DIAGNOSTIC_FIELDS.has(name)).sort().map(name => ({ name, type: diagnosticType(payload[name]) })),
    unknownTopLevelFieldCount: Math.min(100_000, fields.filter(name => !DIAGNOSTIC_FIELDS.has(name)).length),
    error: { param: diagnosticParam(error?.param), type: diagnosticEnum(error?.type, DIAGNOSTIC_ERROR_TYPES),
      code: diagnosticEnum(error?.code, DIAGNOSTIC_ERROR_CODES) } };
}

/// Forwards one non-streaming chat completion. Returns the provider's JSON.
export async function complete(id, model, body) {
  const p = providerOf(id);
  if (!p.baseUrl) throw Object.assign(new Error("simulated provider has no upstream"), { status: 400 });
  const payload = { ...body, model: model || p.defaultModel, stream: false };
  delete payload.user;
  const res = await fetch(`${p.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env(p.keyEnv)}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok) throw Object.assign(new Error(`${p.name} → ${res.status}: ${(json?.error?.message || text).slice(0, 200)}`), {
    status: 502, requestDiagnostic: providerRequestDiagnostic(p.id, payload.model, payload, res.status, json?.error),
  });
  // NanoGPT reports the charge inside usage.cost (USD); MiniRouter in a header.
  const cost = Number(json?.usage?.cost) || Number(res.headers.get("x-minirouter-cost-usd") || res.headers.get("x-nano-cost") || 0) || null;
  return { json, costUsd: cost };
}

// ── Account billing (an API key with a prepaid balance) for wallet treasuries ──────────────────
/// The keyed provider that pays for wallet-mode projects when AI_ACCOUNT_PROVIDER names one whose key
/// is set (2026-09-23: NanoGPT's accountless x402 rails were refused by its Coinbase facilitator, so the
/// owner's NanoGPT account pays and the treasury settles the cost on-chain afterwards). Null = x402.
export function accountAiProvider() {
  const id = env("AI_ACCOUNT_PROVIDER");
  if (!id) return null;
  const p = CATALOG.find((x) => x.id === id);
  return p && !p.x402 && (!p.keyEnv || env(p.keyEnv)) ? p.id : null;
}
/// Per-million-token prices for a model from the catalog (or the detailed cache); a conservative
/// fallback for unknown models so a hold is never too small.
export function catalogPrices(model) {
  const known = (detailedCache?.models || []).find((m) => m.id === model) || FALLBACK_MODELS.find((m) => m.id === model);
  const promptUsd = Number(known?.promptUsd), completionUsd = Number(known?.completionUsd);
  return { promptUsd: Number.isFinite(promptUsd) && promptUsd >= 0 ? promptUsd : 15, completionUsd: Number.isFinite(completionUsd) && completionUsd >= 0 ? completionUsd : 75, known: !!known };
}
/// The most a request can cost, in micro-USD: prompt bytes at 3 bytes per token (conservative for
/// English and for JSON), the output cap, catalog prices, 15 % headroom, never under one cent.
export function estimateMaxMicros(model, body) {
  const { promptUsd, completionUsd } = catalogPrices(model);
  const promptTokens = Math.ceil(Buffer.byteLength(JSON.stringify(body?.messages || []), "utf8") / 3) + Math.ceil(Buffer.byteLength(JSON.stringify(body?.tools || []), "utf8") / 3);
  const maxOut = Number.isInteger(body?.max_tokens) && body.max_tokens > 0 ? body.max_tokens : 1500;
  const usd = (promptTokens * promptUsd + maxOut * completionUsd) / 1e6;
  return Math.max(10_000, Math.ceil(usd * 1e6 * 1.15));
}
/// What a completed request cost, in micro-USD: the provider's own figure when it gives one, else
/// its token usage at catalog prices.
export function actualCostMicros(model, json, costUsd = null) {
  if (Number.isFinite(costUsd) && costUsd > 0) return Math.ceil(costUsd * 1e6);
  const { promptUsd, completionUsd } = catalogPrices(model), u = json?.usage || {};
  const usd = ((Number(u.prompt_tokens) || 0) * promptUsd + (Number(u.completion_tokens) || 0) * completionUsd) / 1e6;
  return Math.max(1, Math.ceil(usd * 1e6));
}
/// The account's prepaid balance in USD (NanoGPT: POST /api/check-balance with the key), or null when
/// the provider has no such endpoint or it fails. Never logs the key.
export async function accountBalanceUsd(id, { fetchImpl = fetch } = {}) {
  const prov = CATALOG.find((x) => x.id === id);
  if (!prov || prov.id !== "nanogpt" || !env(prov.keyEnv)) return null;
  try {
    const res = await fetchImpl("https://nano-gpt.com/api/check-balance", { method: "POST", headers: { "x-api-key": env(prov.keyEnv), "Content-Type": "application/json", Accept: "application/json" }, body: "{}", signal: AbortSignal.timeout(15_000), redirect: "error" });
    const j = await res.json().catch(() => null);
    const usd = Number(j?.usd_balance);
    return res.status === 200 && Number.isFinite(usd) && usd >= 0 ? usd : null;
  } catch { return null; }
}
