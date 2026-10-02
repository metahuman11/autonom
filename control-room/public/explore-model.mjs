export const isAddress=v=>/^0x[0-9a-f]{40}$/i.test(v||'')||/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v||'');
export function projectLogoUrl(c){
 const url=c.detail?.project?.logoUrl;
 if(!isAddress(c.address)||typeof url!=='string')return null;
 const evm=/^0x[0-9a-f]{40}$/i.test(c.address);
 const expected='/api/site/token/'+(evm?c.address.toLowerCase():c.address)+'/project-logo';
 const actual=evm?url.toLowerCase():url;
 return actual===expected||actual.startsWith(expected+'?v=')&&/^\d+$/.test(actual.split('?v=')[1]||'')?url:null;
}
export const number=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
// One state per card: what a visitor should take in first.
export const channelState=c=>c.lock?.state==='paused'?'paused':c.live===true?'live':['renting','booting','stopping','reconciliation_required'].includes(c.phase)?'starting':c.lock?.state==='locked'?'funding':'offline';
export function capUsd(c){const native=number(c.market?.mcapEth),fx=number(c.detail?.treasury?.ethUsd);return native!==null&&fx>0&&Number.isFinite(native*fx)?native*fx:null;}
export function filterChannels(channels,{query='',sort='trending',chain='',status='',min='',max='',showPaused=false}={}){
 const q=query.trim().toLocaleLowerCase(),limit=v=>v===''?null:number(Number(v)),lo=limit(min),hi=limit(max);
 return channels.filter(c=>isAddress(c.address)).filter(c=>!q||[c.name,c.symbol,c.address].some(v=>String(v||'').toLocaleLowerCase().includes(q))).filter(c=>!chain||c.chain===chain).filter(c=>!status||(status==='live'?c.live===true:status==='funding'?c.lock?.state==='locked':!c.live)).filter(c=>status!==''||showPaused||channelState(c)!=='paused').filter(c=>{const n=capUsd(c);return (lo===null||n!==null&&n>=lo)&&(hi===null||n!==null&&n<=hi);}).sort((a,b)=>{
   const metric=c=>sort==='cap'?capUsd(c):sort==='new'?(Number.isFinite(Date.parse(c.createdAt))?Date.parse(c.createdAt):null):number(c.market?.trades);
   const x=metric(a),y=metric(b);return (x===null&&y!==null?1:y===null&&x!==null?-1:(y??0)-(x??0))||a.address.localeCompare(b.address);
 });
}

// Use the same current funds as the token room. Directory rows do not contain
// creator-fee vault observations, so wait for a detail read rather than show zero.
export function projectFunds(c, model){
 const funds=c.detail&&typeof model==='function'?model(c.detail):null;
 return {balance:number(funds?.totalUsd),target:number(funds?.targetUsd)??number(c.lock?.activationUsd),
  progress:number(funds?.progressPct),remaining:number(funds?.remainingUsd),initialFunded:funds?.initialFunded===true};
}
