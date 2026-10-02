// Verify only already-registered temporary preview metadata. No model URLs,
// credentials, redirects, scripts, signatures or purchases are accepted here.
import { runtimeCapabilitiesOf } from './runtime-capabilities.mjs';
import { createHash } from 'node:crypto';
const PREVIEW = /^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/;
export const PREVIEW_CSP = "sandbox; default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'none'; connect-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";
async function boundedBody(response, limit) {
  if (!response.ok || !response.body?.getReader || Number(response.headers.get('content-length') || 0) > limit) return null;
  const reader=response.body.getReader(), parts=[];let total=0;
  try {
    for (;;) { const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>limit)return null;parts.push(value); }
  } finally { await reader.cancel().catch(()=>{}); }
  return Buffer.concat(parts,total);
}
export function createPreviewChecker({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const cache = new Map();
  let active = 0;
  async function verify(token, w) {
    if (active >= 8) return false;
    active++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    timer.unref?.();
    try {
      const response = await fetchImpl(w.url + '/gateway-release.json', {
        method: 'GET', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      const bytes = await boundedBody(response,2048);if(!bytes)return false;
      const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if(manifest.release !== w.releaseHash || String(manifest.token).toLowerCase() !== token.toLowerCase())return false;
      const page=await fetchImpl(w.url+'/index.html',{method:'GET',redirect:'error',signal:controller.signal,headers:{Accept:'text/html'}});
      if(page.headers.get('content-security-policy')!==PREVIEW_CSP || page.headers.get('x-content-type-options')!=='nosniff' ||
         !/^text\/html(?:;|$)/i.test(page.headers.get('content-type')||''))return false;
      const content=await boundedBody(page,520000);if(!content?.length)return false;
      if(w.sourceIndexHash){
        if(!/^[a-f0-9]{64}$/.test(w.sourceIndexHash))return false;
        const footer=Buffer.from('<footer>Built by an AI agent · Token '+token+'</footer>');
        if(!content.subarray(-footer.length).equals(footer))return false;
        if(createHash('sha256').update(content.subarray(0,-footer.length)).digest('hex')!==w.sourceIndexHash)return false;
      }
      return true;
    } catch { return false; }
    finally { clearTimeout(timer); active--; }
  }
  return async function previewAvailable(t) {
    const w = { ...(t.website || {}) };
    if (w.hosting !== 'agent-vps' || !PREVIEW.test(w.url || '') ||
        !/^[a-f0-9]{64}$/.test(w.releaseHash || '') || !runtimeCapabilitiesOf(t, now()).preview) return false;
    const key = `${t.address.toLowerCase()}:${w.url}:${w.releaseHash}:${w.sourceIndexHash||''}`;
    const old = cache.get(key);
    let entry = old && now() - old.at < 15_000 ? old : null;
    if (!entry) {
      if (cache.size >= 128) cache.delete(cache.keys().next().value);
      entry = { at: now(), pending: verify(t.address, w) };
      cache.set(key, entry);
    }
    const available = await entry.pending;
    // A stop, replacement or publication change during the request invalidates it.
    return available && runtimeCapabilitiesOf(t, now()).preview &&
      t.website?.url === w.url && t.website?.releaseHash === w.releaseHash && t.website?.sourceIndexHash === w.sourceIndexHash;
  };
}
