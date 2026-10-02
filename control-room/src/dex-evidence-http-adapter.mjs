// Bounded explicit transport for READ-ONLY provider evidence and RPC queries.
// No global fetch fallback, credentials, redirects, retries, stores or app imports.
const fail = () => Object.assign(new Error('Independent DEX evidence is unavailable'), {code:'dex_evidence_unavailable'});
export function createDexEvidenceTransport({fetchImpl,timeoutMs = 10_000} = {}) {
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw fail();
  return async function request(url, {rpcBody, image = false} = {}) {
    if (rpcBody && (image || !['getGenesisHash','getSignatureStatuses','getTransaction'].includes(rpcBody.method))) throw fail();
    const controller = new AbortController();
    let reader, timer, listener;
    const deadline = new Promise((_,reject) => {
      listener = () => reject(fail());
      controller.signal.addEventListener('abort',listener,{once:true});
      timer = setTimeout(() => controller.abort(),timeoutMs);
    });
    const task = (async () => {
      const response = await fetchImpl(url, {method:rpcBody ? 'POST' : 'GET',redirect:'error',credentials:'omit',
        signal:controller.signal,headers:{Accept:image ? 'image/png,image/jpeg,image/webp' : 'application/json',
          ...(rpcBody ? {'Content-Type':'application/json'} : {})},...(rpcBody ? {body:JSON.stringify(rpcBody)} : {})});
      if (!response.ok || response.redirected || controller.signal.aborted) throw fail();
      const limit = image ? 2_000_000 : 1_000_000, length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw fail();
      const mime = response.headers.get('content-type') || '';
      if (!(image ? /^image\/(png|jpeg|webp)(?:\s*;|$)/i : /^application\/json(?:\s*;|$)/i).test(mime) || !response.body?.getReader) throw fail();
      reader = response.body.getReader();
      const chunks = []; let size = 0;
      for (;;) { const {done,value} = await reader.read(); if (done) break; size += value.byteLength; if (size > limit) throw fail(); chunks.push(value); }
      const bytes = Buffer.concat(chunks);
      return image ? bytes : JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    })();
    try { return await Promise.race([task,deadline]); }
    catch { controller.abort(); if (reader) void reader.cancel().catch(() => {}); throw fail(); }
    finally { clearTimeout(timer); controller.signal.removeEventListener('abort',listener); }
  };
}
