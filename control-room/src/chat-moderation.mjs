// Deterministic first layer, NOT a universal prompt-injection detector.
// Only apply after authentication. Never save attempted secret text in ban records.
const normalize = text => String(text??'').normalize('NFKC').replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g,'').toLowerCase().replace(/ı/g,'i');
export function requestsSecret(text) {
  const clauses=normalize(text).split(/[.!?\n;]/);
  // A safety discussion such as "never share your private key" is not a request.
  const secret='(?:private[ _-]*key|seed[ _-]*phrase|mnemonic|api[ _-]*key|özel anahtar|ozel anahtar|gizli anahtar|kurtarma kelimeleri)';
  return clauses.some(s=>{
    if(/\b(don['’]?t|do not|never)\s+(share|show|reveal|send|give|export)\b/.test(s)||/\b(paylaşma|paylasma|gösterme|gosterme|verme)\b/.test(s))return false;
    return new RegExp('(?:show|reveal|send|give|export|print|display|leak|tell me).{0,65}'+secret,'i').test(s) ||
      new RegExp(secret+'.{0,45}(?:göster|goster|gönder|gonder|paylaş|paylas|söyle|soyle|ver\\b|export|reveal)','i').test(s);
  });
}
export function enforceChatModeration(t,holder,text,{persist=()=>{},now=Date.now()}={}) {
  // EVM wallets (any case) or base58 Solana wallets (case-sensitive) — the same moderation applies on both chains.
  if(!/^(?:0x[0-9a-f]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/i.test(holder||''))throw Object.assign(new Error('Authenticated wallet required'),{status:403});
  const h=/^0x/i.test(holder)?holder.toLowerCase():holder,existing=t.chatModeration?.bans?.[h];
  if(existing)throw Object.assign(new Error('This wallet is banned from this community chat for requesting protected credentials'),{status:403,code:'chat_banned'});
  if(!requestsSecret(text))return;
  t.chatModeration ||= {bans:{}};t.chatModeration.bans ||= {};
  t.chatModeration.bans[h]={reason:'credential_extraction_request',at:new Date(now).toISOString()};
  persist();
  throw Object.assign(new Error('Request blocked. This wallet is banned from this community chat for requesting protected credentials'),{status:403,code:'chat_banned'});
}
