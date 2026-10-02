// vast.ai client. Read calls (balance, offer search, instance list) go to the real API
// whenever VAST_API_KEY is set. Renting is simulated unless VAST_ALLOW_RENT=1 AND the
// caller explicitly asks for real mode — a real instance bills by the hour.
//
// Endpoints (docs.vast.ai/api-reference):
//   GET    /api/v0/users/current        balance
//   POST   /api/v0/bundles              search offers
//   PUT    /api/v0/asks/{id}            create instance from an offer
//   GET    /api/v1/instances            list instances
//   DELETE /api/v0/instances/{id}       destroy instance
import { env } from "./env.mjs";
import { MIN_RENTAL_SECONDS, assertExpectedRentalLifetime, offerRentalLifetime, sanitizeProviderEvidence } from './provider-evidence.mjs';
export { MIN_RENTAL_SECONDS, assertExpectedRentalLifetime } from './provider-evidence.mjs';

const BASE = "https://console.vast.ai";
// Searches are reads even though Vast uses POST. Share identical in-flight reads
// and honor the provider's cooldown across all projects. Never retry paid calls.
let searchRetryAt = 0;
const pendingSearches = new Map();
function rateLimitError(delay) {
  return Object.assign(new Error("VPS provider is busy; automatic retry is scheduled"),
    { providerStatus: 429, providerRetryAfterMs: Math.max(1, delay) });
}
function retryDelay(value, now = Date.now()) {
  const seconds = Number(value);
  const delay = value && Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value || "") - now;
  return Number.isFinite(delay) && delay > 0 ? Math.min(3_600_000, Math.max(60_000, delay)) : 60_000;
}

export const vastKeyConfigured = () => !!env("VAST_API_KEY");
export const vastRentAllowed = () => env("VAST_ALLOW_RENT", "0") === "1";

// Quotes and create requests must use the same allocation; disk_space is the
// host's available capacity, NOT the partition size included in our quote.
export function allocatedDiskGb(value = env("VAST_DISK_GB", "40")) {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 1 || size > 100_000) throw Object.assign(new Error("invalid VPS disk allocation"), { status: 400 });
  return size;
}

function instanceIdOf(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw Object.assign(new Error("invalid Vast instance or offer id"), { status: 400 });
  return id;
}

async function call(method, path, body) {
  const key = env("VAST_API_KEY");
  if (!key) throw new Error("VAST_API_KEY is not set in .env");
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep text for the error */ }
  if (!res.ok) {
    if (res.status === 429 && path === "/api/v0/bundles") {
      const delay = retryDelay(res.headers?.get?.("retry-after"));
      searchRetryAt = Math.max(searchRetryAt, Date.now() + delay);
      throw rateLimitError(delay);
    }
    throw Object.assign(new Error(`vast.ai ${method} ${path} → ${res.status}`), { providerStatus: res.status });
  }
  return json;
}

async function searchRead(body) {
  if (Date.now() < searchRetryAt) throw rateLimitError(searchRetryAt - Date.now());
  const key = JSON.stringify(body);
  if (pendingSearches.has(key)) return pendingSearches.get(key);
  const observedAtMs = Date.now();
  const pending = call("POST", "/api/v0/bundles", body).then(result => ({ result, observedAtMs }));
  pendingSearches.set(key, pending);
  try { return await pending; } finally { pendingSearches.delete(key); }
}

export async function vastAccount() {
  if (!vastKeyConfigured()) return { keyConfigured: false, rentAllowed: vastRentAllowed(), balance: null };
  const u = await call("GET", "/api/v0/users/current");
  const amount = v => v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null;
  return { keyConfigured: true, rentAllowed: vastRentAllowed(), balance: amount(u?.balance),
    credit: amount(u?.credit), canPay: typeof u?.can_pay === "boolean" ? u.can_pay : null, userId: u?.id ?? null };
}

const SAMPLE_OFFERS = [
  { id: 900001, dph_total: 0.052, cpu_ram: 32768, cpu_cores_effective: 8, disk_space: 64, inet_up: 400, inet_down: 800, geolocation: "DE", reliability: 0.991, gpu_name: "CPU-only", direct_port_count: 12, simulated: true },
  { id: 900002, dph_total: 0.071, cpu_ram: 32768, cpu_cores_effective: 16, disk_space: 120, inet_up: 900, inet_down: 900, geolocation: "US", reliability: 0.997, gpu_name: "RTX 3060", direct_port_count: 40, simulated: true },
  { id: 900003, dph_total: 0.039, cpu_ram: 32768, cpu_cores_effective: 6, disk_space: 40, inet_up: 150, inet_down: 500, geolocation: "PL", reliability: 0.982, gpu_name: "CPU-only", direct_port_count: 0, simulated: true },
];

/// Offers matching the filters, cheapest first. `gpuName` (exact vast.ai name, e.g.
/// "RTX 5070 Ti") and `numGpus` select GPU machines; `minCuda` guards against hosts whose
/// driver is too old for the card (RTX 50-series needs CUDA 12.8+).
export async function searchOffers({ gpuName = "", numGpus = 1, ramGb = 16, maxDph = 0.5, minUploadMbps = 100, minCuda = 0, limit = 20, diskGb, offerId = null, minRentalSeconds = MIN_RENTAL_SECONDS, requireLifetime = true } = {}) {
  const allocation = allocatedDiskGb(diskGb);
  if (!Number.isFinite(minRentalSeconds) || minRentalSeconds < MIN_RENTAL_SECONDS) throw Object.assign(new Error('invalid VPS minimum rental duration'), { status: 400 });
  // Use the request's start time, not its completion, so network latency cannot
  // overstate a duration-only offer's remaining rental commitment.
  let observedAtMs = Date.now();
  const shape = (o) => ({
    id: o.id, dph: Number(o.dph_total), allocatedDiskGb: allocation, ramGb: Math.round(Number(o.cpu_ram) / 1024), cpus: Number(o.cpu_cores_effective ?? o.cpu_cores),
    diskGb: Math.round(Number(o.disk_space)), upMbps: Math.round(Number(o.inet_up)), downMbps: Math.round(Number(o.inet_down)),
    geo: o.geolocation || "?", reliability: Number(o.reliability2 ?? o.reliability ?? 0), gpu: o.gpu_name ? `${o.num_gpus ?? 1}x ${o.gpu_name}` : "-",
    cuda: o.cuda_max_good ?? null, directPorts: Number(o.direct_port_count ?? 0), simulated: !!o.simulated,
    ...offerRentalLifetime(o, { observedAtMs }),
  });
  if (!vastKeyConfigured()) {
    return SAMPLE_OFFERS.filter((o) => o.cpu_ram >= ramGb * 1024 && o.dph_total <= maxDph && o.disk_space >= allocation && (offerId == null || o.id === instanceIdOf(offerId))).map(shape);
  }
  const body = {
    limit,
    type: "on-demand",
    verified: { eq: true },
    rentable: { eq: true },
    rented: { eq: false },
    allocated_storage: allocation,
    // Documented API units are seconds. The CLI accepts days and converts them;
    // do not send days or a guessed end_date query to this endpoint.
    duration: { gte: minRentalSeconds },
    disk_space: { gte: allocation },
    cpu_ram: { gte: Math.max(0, ramGb) * 1000 },
    dph_total: { lte: maxDph },
    inet_up: { gte: minUploadMbps },
    order: [["dph_total", "asc"]],
  };
  if (offerId != null) {
    // Search response `id` is the rentable ask contract ID. The bundles query's
    // generic `id` filter does not resolve it; use its explicit provider field.
    body.ask_contract_id = { eq: instanceIdOf(offerId) };
    // Exact-ID validation must not depend on a provider-side calculated-price
    // boundary. Read that one offer at the same disk allocation, then enforce
    // the original strict cap against its fresh returned price below.
    delete body.dph_total;
  }
  if (gpuName) { body.gpu_name = { in: [gpuName] }; body.num_gpus = { eq: Math.max(1, Number(numGpus) || 1) }; }
  if (Number(minCuda) > 0) body.cuda_max_good = { gte: Number(minCuda) };
  const read = await searchRead(body);
  const r = read.result;
  observedAtMs = read.observedAtMs;
  if (!Array.isArray(r?.offers)) throw new Error("Vast offer search returned an invalid response");
  return r.offers.map(shape).filter((o) => {
    if (!Number.isFinite(o.dph) || o.dph <= 0 || o.dph > maxDph || (offerId != null && Number(o.id) !== Number(offerId))) return false;
    if (!requireLifetime) return true;
    try { assertExpectedRentalLifetime(o, { minRentalSeconds }); return true; } catch { return false; }
  });
}

export async function quoteOffer(offerId, { diskGb, maxDph = 1000, minRentalSeconds = MIN_RENTAL_SECONDS } = {}) {
  const offers = await searchOffers({ offerId, diskGb, maxDph, minRentalSeconds, requireLifetime: false, ramGb: 0, minUploadMbps: 0, limit: 1 });
  const offer = offers.find((o) => Number(o.id) === Number(offerId) && !o.simulated);
  if (!offer) throw Object.assign(new Error("selected VPS offer is unavailable or exceeds the approved price; refresh the quote"), { status: 409 });
  return assertExpectedRentalLifetime(offer, { minRentalSeconds });
}

export async function listInstances() {
  if (!vastKeyConfigured()) return [];
  const r = await call("GET", "/api/v1/instances");
  return (r?.instances || []).map((i) => ({
    id: i.id, state: i.cur_state, intended: i.intended_status, label: i.label || null, dph: Number(i.dph_total ?? 0),
    ip: i.public_ipaddr || null, image: i.image_uuid || null,
  }));
}

/// Rent an offer with NO SSH and NO Jupyter: runtype "args" replaces the image
/// command with our boot command, so nobody — the operators included — has a login
/// on the machine. The command and image are visible in the vast.ai console and to
/// the host, so they carry only a short-lived, single-use boot code.
export async function rentOffer({ offerId, label, bootCommand, diskGb }) {
  if (!vastKeyConfigured()) throw new Error("VAST_API_KEY is not set in .env");
  if (!vastRentAllowed()) throw new Error("real rentals are disabled (set VAST_ALLOW_RENT=1 in .env)");
  const id = instanceIdOf(offerId), allocation = allocatedDiskGb(diskGb);
  let r;
  try { r = await call("PUT", `/api/v0/asks/${id}/`, {
    image: env("VAST_IMAGE", "nvidia/cuda:12.8.1-base-ubuntu22.04"),
    disk: allocation,
    runtype: "args",
    // NVIDIA's default compute/utility set omits the video encoder driver mounts.
    // This is a capability request, not a login or an exposed port.
    env: { NVIDIA_DRIVER_CAPABILITIES: "compute,utility,video" },
    // args only: sending `onstart` alongside makes vast exec the onstart text as a
    // binary ("no such file or directory") — verified 2026-09-15 on a real rental.
    args: ["bash", "-lc", bootCommand],
    label,
    cancel_unavail: true,
  }); } catch (e) {
    // A timeout, proxy error, or malformed success does not prove that no billed
    // contract was created. Never retry a create unless the provider rejected it.
    e.createOutcome = [400, 401, 403, 404, 409, 410, 422].includes(e.providerStatus) ? "rejected" : "unknown";
    throw e;
  }
  const instanceId = Number(r?.new_contract);
  if (r?.success !== true || !Number.isSafeInteger(instanceId) || instanceId <= 0) throw Object.assign(new Error("Vast rental outcome is unknown; reconcile the request before retrying"), { createOutcome: "unknown" });
  return { instanceId };
}

export async function showInstance(instanceId) {
  if (!vastKeyConfigured()) return null;
  const id = instanceIdOf(instanceId);
  const r = await call("GET", `/api/v0/instances/${id}/`);
  // Vast also represents an absent exact instance as HTTP 200 {instances:null}.
  // Keep this distinct from HTTP 404: ordinary polling must not infer a failed
  // allocation from a malformed/null read and initiate a replacement rental.
  if (r && Object.keys(r).length === 1 && Object.hasOwn(r, "instances") && r.instances === null)
    throw Object.assign(new Error("Vast reports the exact instance absent"), { providerInstanceAbsent: true });
  const i = r?.instances || r;
  if (!i || Number(i.id) !== id) throw new Error("Vast returned an invalid instance identity");
  // cur_state describes the contract/allocation, NOT the executing container.
  // Keep it for existing lifecycle reconciliation; expose actual_status separately
  // so an allocation marked running cannot mask a stopped/frozen container.
  const evidence = sanitizeProviderEvidence({ state: i.cur_state, actualState: i.actual_status,
    intended: i.intended_status, nextState: i.next_state, statusMsg: i.status_msg,
    startDate: i.start_date, endDate: i.end_date, isBid: i.is_bid });
  return { id: i.id, ...evidence, ip: i.public_ipaddr || null, dph: Number(i.dph_total ?? 0), gpu: i.gpu_name || null };
}

export async function destroyInstance(instanceId, { onAcknowledged } = {}) {
  if (!vastKeyConfigured()) throw new Error("VAST_API_KEY is not set in .env");
  const id = instanceIdOf(instanceId);
  // Even an acknowledged DELETE may still be pending. Conversely, a lost DELETE
  // response can have succeeded: reconcile by reading this exact instance only.
  let deletionAcknowledged = false;
  try {
    const result = await call("DELETE", `/api/v0/instances/${id}/`);
    deletionAcknowledged = result?.success === true;
  } catch (e) {
    // A later retry may explicitly report that an already-deleted instance is
    // absent. An unacknowledged timeout + a transient GET 404 alone is weaker.
    deletionAcknowledged = e.providerStatus === 404;
  }
  // Persist the acknowledgement before reading again: if this process exits
  // after an accepted DELETE, recovery can prove later absence without re-delete.
  if (deletionAcknowledged && onAcknowledged) onAcknowledged({ instanceId: id, deletionAcknowledged: true, acknowledgedAt: new Date().toISOString() });
  try {
    const remote = await showInstance(id);
    const active = new Set(['running', 'loading', 'created', 'rebooting', 'starting', 'pending']);
    if (remote?.state === "destroyed" && ![remote.actualState, remote.intended, remote.nextState].some(s => active.has(s)))
      return { success: true, confirmed: true, instanceId: id, deletionAcknowledged, deletionProof: 'exact-destroyed' };
  } catch (e) {
    if ((e.providerStatus === 404 || e.providerInstanceAbsent === true) && deletionAcknowledged)
      return { success: true, confirmed: true, instanceId: id, deletionAcknowledged, deletionProof: 'acknowledged-delete-then-absent' };
  }
  throw Object.assign(new Error("Vast instance deletion is not confirmed; billing may continue"), { status: 502, deletionConfirmed: false, deletionAcknowledged, instanceId: id });
}
