import {isAddress} from './explore-model.mjs';

const STORAGE_KEY = 'autonom.saved-projects.v1';
const bookmark = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h12v17l-6-4-6 4Z"/></svg>';
const linkIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 13 4-4m-6 6-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m4 2 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 -1) scale(.92)"/></svg>';
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const canonical = address => /^0x/i.test(address) ? address.toLowerCase() : address;
const keys = ['all','saved','save','remove','local','copied','copy','copyFailed','savedNotice','removedNotice','sessionOnly','emptySaved','emptySavedBody','emptyFiltered','emptyFilteredBody','browse','retry','retrying','removeFilter','shortcut'];
const words = {
 en: ['All projects','Saved','Save project','Remove from saved','Saved in this browser','Link copied','Copy project link','Could not copy the link','Project saved','Project removed','Saved for this visit only; browser storage is unavailable.','Keep a project close.','Save a project with its bookmark, then find it here.','No saved projects match.','Try removing a filter, or explore all projects.','Explore all projects','Try again','Trying again…','Remove filter','Press / to search'],
 es: ['Todos los proyectos','Guardados','Guardar proyecto','Quitar de guardados','Guardados en este navegador','Enlace copiado','Copiar enlace del proyecto','No se pudo copiar el enlace','Proyecto guardado','Proyecto eliminado','Guardado solo durante esta visita; almacenamiento no disponible.','Ten un proyecto a mano.','Guarda un proyecto con su marcador y encuéntralo aquí.','Ningún proyecto guardado coincide.','Quita un filtro o explora todos los proyectos.','Explorar todos','Reintentar','Reintentando…','Quitar filtro','Pulsa / para buscar'],
 fr: ['Tous les projets','Enregistrés','Enregistrer le projet','Retirer des favoris','Enregistrés dans ce navigateur','Lien copié','Copier le lien du projet','Impossible de copier le lien','Projet enregistré','Projet retiré','Enregistré pour cette visite uniquement ; stockage indisponible.','Gardez un projet à portée.','Enregistrez un projet avec son signet pour le retrouver ici.','Aucun projet enregistré ne correspond.','Retirez un filtre ou explorez tous les projets.','Explorer tous les projets','Réessayer','Nouvel essai…','Retirer le filtre','Appuyez sur / pour rechercher'],
 de: ['Alle Projekte','Gespeichert','Projekt speichern','Aus gespeicherten entfernen','In diesem Browser gespeichert','Link kopiert','Projektlink kopieren','Link konnte nicht kopiert werden','Projekt gespeichert','Projekt entfernt','Nur für diesen Besuch gespeichert; Browserspeicher nicht verfügbar.','Behalte ein Projekt im Blick.','Speichere ein Projekt über das Lesezeichen und finde es hier.','Keine gespeicherten Projekte passen.','Entferne einen Filter oder entdecke alle Projekte.','Alle Projekte entdecken','Erneut versuchen','Neuer Versuch…','Filter entfernen','Mit / suchen'],
 pt: ['Todos os projetos','Salvos','Salvar projeto','Remover dos salvos','Salvos neste navegador','Link copiado','Copiar link do projeto','Não foi possível copiar o link','Projeto salvo','Projeto removido','Salvo apenas nesta visita; armazenamento indisponível.','Tenha um projeto por perto.','Salve um projeto no marcador para encontrá-lo aqui.','Nenhum projeto salvo corresponde.','Remova um filtro ou explore todos os projetos.','Explorar todos os projetos','Tentar novamente','Tentando…','Remover filtro','Pressione / para buscar'],
 it: ['Tutti i progetti','Salvati','Salva progetto','Rimuovi dai salvati','Salvati in questo browser','Link copiato','Copia link del progetto','Impossibile copiare il link','Progetto salvato','Progetto rimosso','Salvato solo per questa visita; archiviazione non disponibile.','Tieni un progetto vicino.','Salva un progetto con il segnalibro per ritrovarlo qui.','Nessun progetto salvato corrisponde.','Rimuovi un filtro o esplora tutti i progetti.','Esplora tutti i progetti','Riprova','Nuovo tentativo…','Rimuovi filtro','Premi / per cercare'],
 ja: ['すべてのプロジェクト','保存済み','プロジェクトを保存','保存を解除','このブラウザーに保存','リンクをコピーしました','プロジェクトのリンクをコピー','リンクをコピーできませんでした','保存しました','保存を解除しました','ブラウザー保存が利用できないため、今回の閲覧中のみ保存されます。','気になるプロジェクトを手元に。','ブックマークで保存すると、ここから見つけられます。','一致する保存済みプロジェクトはありません。','絞り込みを解除するか、すべてのプロジェクトをご覧ください。','すべてのプロジェクトを見る','再試行','再試行中…','絞り込みを解除','/ キーで検索'],
 ko: ['모든 프로젝트','저장됨','프로젝트 저장','저장 취소','이 브라우저에 저장됨','링크 복사됨','프로젝트 링크 복사','링크를 복사할 수 없습니다','프로젝트 저장됨','저장 취소됨','브라우저 저장소를 사용할 수 없어 이번 방문 중에만 저장됩니다.','관심 있는 프로젝트를 가까이.','북마크로 프로젝트를 저장하고 여기서 다시 찾아보세요.','조건에 맞는 저장된 프로젝트가 없습니다.','필터를 지우거나 모든 프로젝트를 살펴보세요.','모든 프로젝트 보기','다시 시도','다시 시도 중…','필터 제거','/ 키로 검색'],
 zh: ['所有项目','已保存','保存项目','取消保存','保存在此浏览器中','链接已复制','复制项目链接','无法复制链接','项目已保存','已取消保存','浏览器存储不可用，仅本次访问期间保存。','让关注的项目触手可及。','点击书签保存项目，即可在这里找到它。','没有符合条件的已保存项目。','请移除筛选条件，或浏览所有项目。','浏览所有项目','重试','正在重试…','移除筛选','按 / 搜索'],
 ar: ['كل المشاريع','المحفوظة','حفظ المشروع','إزالة من المحفوظة','محفوظة في هذا المتصفح','تم نسخ الرابط','نسخ رابط المشروع','تعذر نسخ الرابط','تم حفظ المشروع','تمت إزالة المشروع','محفوظ لهذه الزيارة فقط؛ تخزين المتصفح غير متاح.','احتفظ بمشروع قريباً.','احفظ مشروعاً بعلامته المرجعية لتجده هنا.','لا توجد مشاريع محفوظة مطابقة.','أزل مرشحاً أو استكشف كل المشاريع.','استكشف كل المشاريع','حاول مجدداً','جارٍ المحاولة…','إزالة المرشح','اضغط / للبحث']
};
const translate = key => (words[document.documentElement.lang] || words.en)[keys.indexOf(key)] || key;

export function readSavedProjects(raw) {
 try {
  const value = JSON.parse(raw || '[]');
  return new Set((Array.isArray(value) ? value : []).filter(item => typeof item === 'string' && isAddress(item)).slice(0,500).map(canonical));
 } catch { return new Set(); }
}

export function readDiscoveryLocation(search) {
 const params = new URLSearchParams(search);
 const cap = key => {const value=params.get(key);return value!==null && value.trim()!=='' && Number.isFinite(Number(value)) && Number(value)>=0 && Number(value)<=1e18 ? String(Number(value)) : '';};
 const chain=params.get('chain') || '';
 return {
  query:(params.get('q') || '').slice(0,160),
  chain:/^[\w -]{1,48}$/.test(chain) ? chain : '',
  status:['live','funding','offline'].includes(params.get('status')) ? params.get('status') : '',
  sort:['new','cap'].includes(params.get('sort')) ? params.get('sort') : 'trending',
  min:cap('min'),max:cap('max'),showPaused:params.get('paused')==='1',
  view:params.get('view')==='list' ? 'list' : 'grid',saved:params.get('saved')==='1'
 };
}

export function createDiscovery({state,onChange,onRetry}) {
 const section=document.getElementById('communities');
 const grid=document.getElementById('grid');
 let saved;
 try {saved=readSavedProjects(localStorage.getItem(STORAGE_KEY));} catch {saved=new Set();}
 let savedOnly=false,view='grid',lastURL='',noticeTimer,retrying=false;
 const tools=document.createElement('div');tools.className='discovery-tools';
 tools.innerHTML='<div class="discovery-tabs" role="group"><button type="button" data-discovery-all aria-pressed="true"></button><button type="button" data-discovery-saved aria-pressed="false">'+bookmark+'<span></span><b></b></button></div><span class="discovery-storage" hidden></span>';
 section.querySelector('.explore-toolbar').after(tools);
 const allButton=tools.querySelector('[data-discovery-all]'),savedButton=tools.querySelector('[data-discovery-saved]');
 const chips=document.createElement('div');chips.className='discovery-chips';chips.hidden=true;tools.after(chips);
 const notice=document.createElement('div');notice.className='discovery-toast';notice.setAttribute('role','status');notice.hidden=true;section.append(notice);
 const recovery=document.createElement('div');recovery.className='discovery-recovery';recovery.hidden=true;
 const refreshNotice=document.getElementById('refreshNotice');refreshNotice.before(recovery);recovery.append(refreshNotice);
 const retry=document.createElement('button');retry.type='button';retry.className='discovery-retry';retry.hidden=true;recovery.append(retry);
 const search=document.getElementById('search');const hint=document.createElement('kbd');hint.className='discovery-key';hint.textContent='/';hint.setAttribute('aria-hidden','true');search.parentElement.append(hint);

 function announce(message) {clearTimeout(noticeTimer);notice.textContent=message;notice.hidden=false;noticeTimer=setTimeout(()=>{notice.hidden=true;},3500);}
 function syncControls() {
  for(const [id,key] of [['search','query'],['chain','chain'],['status','status'],['minCap','min'],['maxCap','max']])document.getElementById(id).value=state[key];
  document.querySelectorAll('[data-sort]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.sort===state.sort)));
  document.querySelectorAll('[data-live-filter]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.liveFilter===state.status)));
  document.querySelectorAll('[data-view]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.view===view)));
  grid.classList.toggle('list-view',view==='list');
 }
 function restore() {
  const next=readDiscoveryLocation(location.search);savedOnly=next.saved;view=next.view;
  const {saved:discardSaved,view:discardView,...filters}=next;Object.assign(state,filters);syncControls();
 }
 function persistURL() {
  const url=new URL(location.href);
  for(const [key,value] of Object.entries({q:state.query,chain:state.chain,status:state.status,sort:state.sort==='trending'?'':state.sort,min:state.min,max:state.max,paused:state.showPaused?'1':'',view:view==='list'?'list':'',saved:savedOnly?'1':''})) {
   if(value!=='')url.searchParams.set(key,value);else url.searchParams.delete(key);
  }
  const next=url.pathname+url.search+url.hash;
  if(next!==lastURL){try{history.replaceState(history.state,'',next);lastURL=next;}catch{}}
 }
 function sync() {
  allButton.textContent=translate('all');allButton.setAttribute('aria-pressed',String(!savedOnly));
  savedButton.querySelector('span').textContent=translate('saved');savedButton.querySelector('b').textContent=saved.size;
  savedButton.setAttribute('aria-pressed',String(savedOnly));
  tools.querySelector('.discovery-tabs').setAttribute('aria-label',translate('all'));
  tools.querySelector('.discovery-storage').textContent=translate('local');tools.querySelector('.discovery-storage').hidden=!savedOnly;
  search.title=translate('shortcut');retry.textContent=translate(retrying?'retrying':'retry');
  const values=[['query',state.query],['chain',state.chain],['status',state.status ? document.querySelector(`#status option[value="${state.status}"]`)?.textContent : ''],['min',state.min ? '≥ $'+state.min : ''],['max',state.max ? '≤ $'+state.max : '']].filter(([,value])=>value);
  const html=values.map(([key,value])=>`<button type="button" data-remove-filter="${key}" aria-label="${escape(translate('removeFilter')+': '+value)}"><span>${escape(value)}</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8"/></svg></button>`).join('');
  if(chips.innerHTML!==html)chips.innerHTML=html;chips.hidden=!values.length;
  persistURL();
 }
 function resetFilters() {Object.assign(state,{query:'',chain:'',status:'',min:'',max:''});syncControls();}
 restore();
 allButton.addEventListener('click',()=>{savedOnly=false;onChange();});
 savedButton.addEventListener('click',()=>{savedOnly=true;onChange();});
 chips.addEventListener('click',event=>{const button=event.target.closest('[data-remove-filter]');if(!button)return;state[button.dataset.removeFilter]='';syncControls();onChange();search.focus({preventScroll:true});});
 document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>{view=button.dataset.view;persistURL();}));
 section.addEventListener('click',async event=>{
  const button=event.target.closest('[data-save-project],[data-copy-project],[data-discovery-browse]');if(!button)return;
  if(button.hasAttribute('data-discovery-browse')){savedOnly=false;resetFilters();onChange();allButton.focus({preventScroll:true});return;}
  const address=button.dataset.saveProject || button.dataset.copyProject;if(!isAddress(address))return;
  if(button.hasAttribute('data-copy-project')){
   try{await navigator.clipboard.writeText(new URL('/t/'+address,location.origin).href);announce(translate('copied'));}catch{announce(translate('copyFailed'));}return;
  }
  const key=canonical(address);const removing=saved.has(key);if(removing)saved.delete(key);else saved.add(key);
  let stored=true;try{localStorage.setItem(STORAGE_KEY,JSON.stringify([...saved]));}catch{stored=false;}
  onChange();announce(translate(stored?(removing?'removedNotice':'savedNotice'):'sessionOnly'));
  if(savedOnly&&removing)savedButton.focus({preventScroll:true});
 });
 retry.addEventListener('click',async()=>{if(retrying)return;retrying=true;retry.disabled=true;retry.textContent=translate('retrying');try{await onRetry();}finally{retrying=false;retry.disabled=false;retry.textContent=translate('retry');}});
 window.addEventListener('popstate',()=>{restore();onChange();});
 window.addEventListener('storage',event=>{if(event.key!==STORAGE_KEY&&event.key!==null)return;saved=readSavedProjects(event.newValue);onChange();});
 document.addEventListener('keydown',event=>{
  if(event.key!=='/'||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey||event.target.closest('input,textarea,select,[contenteditable="true"]')||document.querySelector('dialog[open]'))return;
  event.preventDefault();search.focus();search.scrollIntoView({block:'center',behavior:'instant'});
 });
 return {
  filter:rows=>savedOnly?rows.filter(project=>saved.has(canonical(project.address))):rows,
  render({loaded,stale}) {sync();recovery.hidden=!stale;recovery.classList.toggle('is-initial',!loaded);retry.hidden=!stale;retry.disabled=retrying;tools.hidden=!loaded&&!stale;},
  cardActions(project) {
   const active=saved.has(canonical(project.address));
   return `<div class="card-local-actions"><button type="button" data-save-project="${escape(project.address)}" aria-pressed="${active}" aria-label="${escape(translate(active?'remove':'save')+': '+(project.name||project.symbol||project.address))}">${bookmark}<span>${escape(translate(active?'saved':'save'))}</span></button><button type="button" data-copy-project="${escape(project.address)}" aria-label="${escape(translate('copy')+': '+(project.name||project.symbol||project.address))}" title="${escape(translate('copy'))}">${linkIcon}</button></div>`;
  },
  empty() {
   if(!savedOnly)return '';
   return `<div class="ref-empty discovery-empty"><span class="discovery-empty-icon">${bookmark}</span><h2>${escape(translate(saved.size?'emptyFiltered':'emptySaved'))}</h2><p>${escape(translate(saved.size?'emptyFilteredBody':'emptySavedBody'))}</p><button type="button" class="ref-button" data-discovery-browse>${escape(translate('browse'))}</button></div>`;
  }
 };
}
