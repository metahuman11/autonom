import {capUsd,channelState,filterChannels,isAddress,number,projectLogoUrl,projectFunds} from './explore-model.mjs?v=site-consistency-20260930';
import {syncStreamPreviews} from './stream-previews.js?v=unified-20260930';
import {createDiscovery} from './home-discovery.js?v=unified-20260930';
const $=id=>document.getElementById(id),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
import {copy,languages,languageOf} from './explore-i18n.mjs?v=site-consistency-20260930';
let lang='en';try{lang=languageOf(localStorage.getItem('mh-explore-language'));}catch{}
let channels=[],loaded=false,stale=false,pending=false,lastMarkup='';const details=new Map();
const state={query:'',sort:'trending',chain:'',status:'',min:'',max:'',showPaused:false};
const discovery=createDiscovery({state,onChange:()=>render(),onRetry:()=>refresh()});
// Public detail reads enrich visible cards independently of the directory poll.
// A slow provider never holds the list refresh or causes an offscreen request fan-out.
const DETAIL_TTL=12000,DETAIL_MAX_AGE=30000,DETAIL_TIMEOUT=5000,DETAIL_RETRY=15000;
const detailJobs=new Map(),detailAttempts=new Map();
let detailQueue=[],detailRenderTimer=0,detailScrollTimer=0,pageActive=true;
function stopDetailReads(){
 detailQueue=[];clearTimeout(detailRenderTimer);detailRenderTimer=0;clearTimeout(detailScrollTimer);detailScrollTimer=0;
 for(const job of detailJobs.values())job.cancel();
}
function queueVisibleDetails(){
 if(!pageActive||document.hidden||!loaded||stale){stopDetailReads();return;}
 const now=Date.now(),height=window.innerHeight||800,current=new Map(channels.map(c=>[c.address,c]));
 const visible=[...$('grid').querySelectorAll('[data-project]')].filter(card=>{const rect=card.getBoundingClientRect();return rect.bottom>=-200&&rect.top<=height+300;}).map(card=>card.dataset.project).filter(address=>current.has(address));
 const wanted=new Set(visible);
 for(const [address,job]of detailJobs)if(!wanted.has(address))job.cancel();
 detailQueue=visible.filter(address=>!detailJobs.has(address)&&(!details.has(address)||now-details.get(address).at>=DETAIL_TTL)&&(!detailAttempts.has(address)||now-detailAttempts.get(address)>=DETAIL_RETRY));
 drainDetailReads();
}
function scheduleDetailRender(){
 if(detailRenderTimer||!pageActive||document.hidden)return;
 detailRenderTimer=setTimeout(()=>{detailRenderTimer=0;if(pageActive&&!document.hidden)render();},0);
}
function drainDetailReads(){
 while(pageActive&&!document.hidden&&!stale&&detailJobs.size<2&&detailQueue.length){
  const address=detailQueue.shift();
  if(detailJobs.has(address)||!channels.some(c=>c.address===address))continue;
  const controller=new AbortController();let rejectDeadline;
  const deadline=new Promise((_,reject)=>{rejectDeadline=reject;});
  const job={cancelled:false,cancel(){if(this.cancelled)return;this.cancelled=true;detailAttempts.delete(address);controller.abort();rejectDeadline(new Error('cancelled'));}};
  const timer=setTimeout(()=>{controller.abort();rejectDeadline(new Error('timeout'));},DETAIL_TIMEOUT);
  detailJobs.set(address,job);detailAttempts.set(address,Date.now());
  const request=fetch(`/api/site/token/${address}`,{signal:controller.signal}).then(async response=>{if(!response.ok)throw Error('unavailable');return response.json();});
  Promise.race([request,deadline]).then(value=>{
   if(job.cancelled)return;
   const current=channels.find(c=>c.address===address);if(!current)return;
   details.set(address,{value,at:Date.now()});current.detail=value;scheduleDetailRender();
  }).catch(()=>{
   if(job.cancelled)return;
   details.delete(address);const current=channels.find(c=>c.address===address);if(current)current.detail=undefined;
   scheduleDetailRender();
  }).finally(()=>{clearTimeout(timer);if(detailJobs.get(address)===job)detailJobs.delete(address);if(pageActive&&!document.hidden)queueVisibleDetails();});
 }
}
const t=k=>copy[lang][k]||k;
const usd=n=>number(n)===null?'—':new Intl.NumberFormat(lang,{style:'currency',currency:'USD',notation:n>=1000?'compact':'standard',maximumFractionDigits:n>=1000?1:2}).format(n);
const fundsFor=c=>projectFunds(c,globalThis.GatewayProjectFunds?.model);
const arrow='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M7 7h10v10"/></svg>';
function status(c){if(stale)return t('fresh');if(c.lock?.state==='paused')return t('paused');if(c.phase==='reconciliation_required')return t('attention');if(c.phase==='stopping')return t('stopping');if(c.live)return t('live');if(['renting','booting'].includes(c.phase))return t('starting');if(c.lock?.state==='locked')return t('funding');return t('offline');}
function card(c){
 const cap=stale?null:capUsd(c),funds=fundsFor(c),idx=(parseInt(c.address.slice(2,6),16)||0)%5;
 const imageUrl=projectLogoUrl(c),initials=(c.symbol||c.name||'?').slice(0,2).toUpperCase();
 const kind=stale?'offline':channelState(c),funding=!stale&&c.lock?.state==='locked'&&!funds.initialFunded&&funds.target>0?fundingBlock(funds):'';
 const live=c.live===true&&kind==='live',logo=imageUrl?`<img src="${esc(imageUrl)}" data-initials="${esc(initials)}" alt="" loading="lazy" decoding="async">`:`<span>${esc(initials)}</span>`;
 const previewData=live?`data-stream="${c.address}" data-preview-loading="${esc(t('previewLoading'))}" data-preview-unavailable="${esc(t('previewUnavailable'))}" data-preview-play="${esc(t('previewPlay'))}" data-preview-pause="${esc(t('previewPause'))}" data-preview-paused="${esc(t('previewPaused'))}" data-preview-muted="${esc(t('previewMuted'))}"`:'';
 const previewControl=live?`<button type="button" class="card-preview-toggle" data-preview-toggle aria-label="${esc(t('previewPlay'))}" title="${esc(t('previewPlay'))}" aria-pressed="false"><svg class="preview-play-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 11 7-11 7Z"/></svg><svg class="preview-pause-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg></button><span class="card-preview-caption" aria-hidden="true">${esc(t('previewMuted'))}</span>`:'';
 return `<article class="ref-card broadcast-card palette-${idx} state-${kind}" data-project="${c.address}"><div class="card-media" ${previewData}><a class="card-stream-link" href="/t/${c.address}" aria-label="${esc(c.name)} · ${esc(live?t('preview'):status(c))}"><div class="stream-placeholder"><span class="cover-symbol" aria-hidden="true">$${esc(String(c.symbol||'').slice(0,8))}</span><div class="stream-project-avatar">${logo}</div><strong>${esc(c.name||c.symbol)}</strong><span class="preview-state">${live?esc(t('previewLoading')):esc(status(c))}</span></div><span class="card-status ${live?'is-live':''}">${esc(status(c))}</span>${!stale&&c.viewerStatus==='fresh'&&number(c.viewers)!==null?`<span class="card-watchers">${c.viewers} ${t('watching')}</span>`:''}<span class="card-chain">${esc(c.chain||'—')}</span><span class="card-open">${t('join')} ${arrow}</span></a>${previewControl}</div><a class="card-link" href="/t/${c.address}" aria-label="${esc(c.name)}"><div class="card-content"><div class="card-heading"><div class="community-avatar">${logo}</div><div class="community-identity"><h2>${esc(c.name||c.symbol)}</h2><span class="card-ticker">$${esc(c.symbol)} · ${esc(c.chain||'—')}</span></div>${arrow}</div>${primary(c,kind,funding)}${setup(c)}</div></a><section class="card-details" aria-label="${esc(t('details'))}"><h3 class="card-detail-heading">${t('details')}</h3><div class="card-values"><div><span>${t('estimate')}</span><strong title="${cap===null?t('unavailable'):cap.toFixed(2)+' USD'}">${usd(cap)}</strong></div><div><span>${t('budget')}</span><strong>${usd(stale?null:funds.balance)}</strong></div></div>${kind==='funding'?'':funding}${runway(c)}</section>${discovery.cardActions(c)}</article>`;
}
// What the creator chose, on the card itself (owner 2026-09-24): the GPU machine and the AI model from
// the project's own plan. No daily estimate (owner 2026-09-25). Labels are short codes, the same in every language.
function setup(c){
 const p=c.plan;if(!p||(!p.machine&&!p.model))return '';
 const chip=(label,value)=>value?`<span><b>${label}</b><em>${esc(value)}</em></span>`:'';
 return `<div class="card-setup">${chip('GPU',p.machine)}${chip('AI',p.model)}</div>`;
}
// The one thing a visitor should take in first, by state. Numbers come from the community's own reads.
function primary(c,kind,funding){
 const d=c.detail,hours=number(d?.budget?.runwayHours),days=hours!==null?Math.round(hours/24*10)/10:number(d?.spend?.remaining?.days),usdLeft=fundsFor(c).balance;
 const meta=[];if(stale)return `<div class="card-primary is-offline"><strong>${esc(t('fresh'))}</strong></div>`;if(!stale&&c.viewerStatus==='fresh'&&number(c.viewers)!==null)meta.push(`${c.viewers} ${t('watching')}`);if(usdLeft!==null)meta.push(usd(usdLeft));if(days!==null)meta.push(`≈ ${days} ${t('days')}`);
 if(kind==='live')return `<div class="card-primary is-live"><strong><i></i>${t('kurtOnline')}</strong><span>${esc(meta.join(' · '))}</span></div>`;
 if(kind==='funding'&&funding)return `<div class="card-primary is-funding">${funding}<span class="card-auto">${t('startsAuto')}</span></div>`;
 if(kind==='starting')return `<div class="card-primary is-starting"><strong>${esc(status(c))}</strong><span>${esc(meta.join(' · '))}</span></div>`;
 return `<div class="card-primary is-${kind}"><strong>${esc(status(c))}</strong>${meta.length?`<span>${esc(meta.join(' · '))}</span>`:''}</div>`;
}
// The startup target: how full it is, in words a visitor can read at a glance.
function fundingBlock(funds){
 const raw=funds.progress===null?null:Math.min(100,funds.progress),pct=raw===null?'—':raw>0&&raw<10?raw.toFixed(1):String(Math.round(raw));
 return `<div class="card-funding"><div class="funding-line"><strong>${pct}${raw===null?'':'%'} ${t('funded')}</strong>${funds.remaining!==null?`<em>${usd(funds.remaining)} ${t('toGo')}</em>`:''}</div><div class="bar" role="progressbar" aria-label="${esc(t('funded'))}" aria-valuemin="0" aria-valuemax="100"${raw===null?'':` aria-valuenow="${raw.toFixed(1)}"`}><i class="${raw>0?'some':''}" style="width:${raw??0}%"></i></div><span>${usd(funds.balance)} / ${usd(funds.target)} ${t('target')}</span></div>`;
}
// Where the budget goes, on the card itself: the community's own detail read (budget, spend and
// what is left at plan burn). Nothing is shown until that read exists — no invented zeros.
function runway(c){
 if(stale)return '';
 const d=c.detail,b=d?.budget,sp=d?.spend?.total,R=d?.spend?.remaining;
 if(!b||!sp)return '';
 const w=d.treasury?.wallet||c.treasury?.wallet,network=d.treasury?.chain||c.chain,networkLabel=network==='solana'?t('sendSol'):network==='robinhood'?t('sendEth'):network?String(network):t('unavailable');
 const n=v=>number(v),cell=(label,value)=>`<div><span>${label}</span><b>${value}</b></div>`;
 const days=R&&n(R.days)!==null?`${R.days} d`:d.plan?'—':t('planPending');
 const sub=[n(R?.vpsHours)!==null?`≈ ${R.vpsHours} ${t('hoursLeft')}`:'',n(R?.aiTokensM)!==null?`≈ ${R.aiTokensM}M ${t('tokensLeft')}`:''].filter(Boolean).join(' · ');
 return `<div class="card-runway"><div class="runway-head"><span>${t('runway')}</span>${typeof w==='string'&&w.length>12?`<em title="${esc(w)}">${esc(w.slice(0,4))}…${esc(w.slice(-4))} · ${esc(networkLabel)}</em>`:''}</div><div class="runway-grid">${cell(t('burnHour'),usd(n(b.burnPerHourUsd)))}${cell(t('aiSpent'),`${usd(n(sp.aiUsd))} · ${n(sp.aiRequests)??0} ${t('requests')}`)}${cell(t('serverSpent'),`${usd(n(sp.vpsUsd))} · ${n(sp.vpsHours)??0} h`)}${cell(t('daysLeft'),esc(days))}</div>${sub?`<div class="runway-sub">${sub}</div>`:''}</div>`;
}
function render(){
 const rows=discovery.filter(filterChannels(channels,state)),g=$('grid');
 discovery.render({loaded,stale});
 const pausedCount=discovery.filter(filterChannels(channels,{...state,showPaused:true})).length-discovery.filter(filterChannels(channels,{...state,showPaused:false})).length;
 const toggle=$('togglePaused');if(toggle){toggle.hidden=!(pausedCount>0||state.showPaused);toggle.textContent=(state.showPaused?t('hidePaused'):t('showPaused'))+(pausedCount>0?` (${pausedCount})`:'');}
 const liveCount=channels.filter(c=>c.live===true).length,liveNow=$('liveNow');if(liveNow)liveNow.textContent=stale?t('unavailable'):loaded?(liveCount||t('nothingLive')):'—';
 $('resultCount').textContent=loaded?`${rows.length} ${lang==='en'&&rows.length===1?'community':t('results')}`:t('loading');
 $('sortNote').textContent=t(state.sort==='trending'?'trendingNote':state.sort==='cap'?'capNote':'newNote');
 const count=[state.chain,state.status,state.min,state.max].filter(v=>v!=='').length;$('filterCount').hidden=!count;$('filterCount').textContent=count;
 if(!loaded)return;
 // Do not replace cards on clock-only polls, preserving keyboard focus.
 const html=rows.map(card).join('')||discovery.empty()||`<div class="ref-empty"><h2>${t('empty')}</h2><button class="ref-button" id="resetSearch">${t('reset')}</button></div>`;
 if(lastMarkup!==html){
   const focused=document.activeElement,focusedCard=focused?.closest('.ref-card'),focusAddress=focusedCard?.dataset.project;
   const focusKind=focused?.matches('[data-save-project]')?'[data-save-project]':focused?.matches('[data-copy-project]')?'[data-copy-project]':focused?.matches('[data-preview-toggle]')?'[data-preview-toggle]':focused?.matches('.card-stream-link')?'.card-stream-link':'.card-link';
   const previous=new Map([...g.querySelectorAll('[data-project]')].map(el=>[el.dataset.project,el]));
   const template=document.createElement('template');template.innerHTML=html;
   const desired=[];
   for(const next of template.content.children){
     const before=previous.get(next.dataset.project),oldMedia=before?.querySelector('[data-stream]'),newMedia=next.querySelector('[data-stream]');
     // Native HLS may restart even when the same video node is detached and reinserted.
     // Keep its entire article connected when only balances/viewer counts change.
     if(oldMedia&&newMedia){
       for(const [key,value] of Object.entries(newMedia.dataset))oldMedia.dataset[key]=value;
       oldMedia.querySelector('.card-stream-link').innerHTML=newMedia.querySelector('.card-stream-link').innerHTML;
       oldMedia.querySelector('.card-stream-link').setAttribute('aria-label',newMedia.querySelector('.card-stream-link').getAttribute('aria-label'));
       before.className=next.className;
       before.querySelector('.card-link').replaceWith(next.querySelector('.card-link'));
       before.querySelector('.card-details').replaceWith(next.querySelector('.card-details'));
       before.querySelector('.card-local-actions')?.replaceWith(next.querySelector('.card-local-actions'));
       desired.push(before);
     }else{
       desired.push(next);
     }
   }
   const retained=new Set(desired);
   for(const child of [...g.children])if(!retained.has(child))child.remove();
   let cursor=g.firstElementChild;
   for(const node of desired){
     if(node===cursor)cursor=cursor.nextElementSibling;
     else if(g.moveBefore&&node.parentNode===g)g.moveBefore(node,cursor);
     else g.insertBefore(node,cursor);
   }
   lastMarkup=html;syncStreamPreviews(g);
   $('resetSearch')?.addEventListener('click',reset);
   if(focusAddress)[...g.querySelectorAll('[data-project]')].find(el=>el.dataset.project===focusAddress)?.querySelector(focusKind)?.focus({preventScroll:true});
 }
 document.querySelectorAll('[data-live-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.liveFilter===state.status)));
 g.setAttribute('aria-busy','false');
 queueVisibleDetails();
}
function translate(){document.documentElement.lang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';document.querySelectorAll('[data-i18n]').forEach(e=>e.textContent=t(e.dataset.i18n));$('search').placeholder=t('search');$('languageCode').textContent=lang.toUpperCase();document.querySelectorAll('[data-lang]').forEach(e=>e.setAttribute('aria-pressed',String(e.dataset.lang===lang)));render();}
$('grid').addEventListener('error',event=>{const img=event.target;if(img instanceof HTMLImageElement&&img.hasAttribute('data-initials')){const fallback=document.createElement('span');fallback.textContent=img.dataset.initials;img.replaceWith(fallback);}},true);
function reset(){Object.assign(state,{query:'',chain:'',status:'',min:'',max:''});['search','chain','status','minCap','maxCap'].forEach(id=>$(id).value='');render();}
$('search').addEventListener('input',e=>{state.query=e.target.value;render();});
document.querySelectorAll('[data-live-filter]').forEach(b=>b.addEventListener('click',()=>{state.status=b.dataset.liveFilter;$('status').value=state.status;render();}));
document.querySelectorAll('[data-sort]').forEach(b=>b.addEventListener('click',()=>{state.sort=b.dataset.sort;document.querySelectorAll('[data-sort]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));render();}));
document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('[data-view]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));$('grid').classList.toggle('list-view',b.dataset.view==='list');}));
$('filters').addEventListener('click',()=>{const open=$('filterPanel').hidden;$('filterPanel').hidden=!open;$('filters').setAttribute('aria-expanded',String(open));});
for(const [id,key] of [['chain','chain'],['status','status'],['minCap','min'],['maxCap','max']])$(id).addEventListener('input',e=>{state[key]=e.target.value;render();});
$('clear').addEventListener('click',reset);$('togglePaused')?.addEventListener('click',()=>{state.showPaused=!state.showPaused;render();});$('language').addEventListener('click',()=>$('languageDialog').showModal());$('closeLanguage').addEventListener('click',()=>$('languageDialog').close());
$('languageOptions').innerHTML=languages.map(([code,label])=>`<button data-lang="${code}" lang="${code}" dir="auto"><span>${label}</span><small>${code.toUpperCase()}</small></button>`).join('');
document.querySelectorAll('[data-lang]').forEach(b=>b.addEventListener('click',()=>{lang=languageOf(b.dataset.lang);try{localStorage.setItem('mh-explore-language',lang);}catch{}translate();$('languageDialog').close();}));
async function refresh(){
 if(pending||document.hidden||!pageActive)return;pending=true;
 try{const r=await fetch('/api/site/channels',{signal:AbortSignal.timeout(12000)});if(!r.ok)throw Error('unavailable');const data=await r.json();if(!Array.isArray(data.channels))throw Error('invalid');channels=data.channels.filter(c=>isAddress(c.address));stale=false;loaded=true;$('refreshNotice').hidden=true;
 const chains=[...new Set(channels.map(c=>c.chain).filter(Boolean))].sort();const chainValue=state.chain;$('chain').innerHTML=`<option value="">${t('allChains')}</option>`+chains.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');$('chain').value=chainValue;
 const known=new Set(channels.map(c=>c.address));
 for(const address of details.keys())if(!known.has(address))details.delete(address);
 for(const address of detailAttempts.keys())if(!known.has(address))detailAttempts.delete(address);
 channels.forEach(c=>{const cached=details.get(c.address);c.detail=cached&&Date.now()-cached.at<DETAIL_MAX_AGE?cached.value:undefined;});render();
 }catch{stale=true;stopDetailReads();$('refreshNotice').hidden=false;$('refreshNotice').textContent=t(loaded?'stale':'error');if(loaded)render();else{discovery.render({loaded,stale});const liveNow=$('liveNow');if(liveNow)liveNow.textContent=t('unavailable');$('grid').innerHTML='';$('grid').setAttribute('aria-busy','false');$('resultCount').textContent=t('unavailable');}}
 finally{pending=false;}
}
document.addEventListener('visibilitychange',()=>{document.body.classList.toggle('page-hidden',document.hidden);if(document.hidden)stopDetailReads();else if(pageActive){queueVisibleDetails();refresh();}});
window.addEventListener('pagehide',()=>{pageActive=false;stopDetailReads();});
window.addEventListener('pageshow',()=>{pageActive=true;queueVisibleDetails();refresh();});
const scheduleVisibleDetails=()=>{if(detailScrollTimer||document.hidden||!pageActive)return;detailScrollTimer=setTimeout(()=>{detailScrollTimer=0;queueVisibleDetails();},100);};
window.addEventListener('scroll',scheduleVisibleDetails,{passive:true});
window.addEventListener('resize',scheduleVisibleDetails,{passive:true});
translate();refresh();setInterval(refresh,15000);
