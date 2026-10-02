// Broadcast-safe desktop: one public snapshot feed, no wallet or machine controls.
(() => {
  const $ = id => document.getElementById(id);
  const raw = location.pathname.split('/').pop(); const token = /^0x/i.test(raw) ? raw.toLowerCase() : raw;   // an EVM address is case-insensitive; a Solana mint is not
  if (!/^(0x[0-9a-f]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(token)) { $('connection').textContent = 'Choose a community to open its desktop'; return; }
  const apps = new Set(['home', 'community', 'projects', 'browser']);
  let activeApp = 'home';
  function openApp(name) {
    if (!apps.has(name)) return;
    activeApp = name;
    document.querySelectorAll('[data-app-panel]').forEach(panel => { panel.hidden = panel.dataset.appPanel !== name; });
    document.querySelectorAll('.dock-app').forEach(button => {
      if (button.dataset.openApp === name) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    const heading = document.querySelector(`[data-app-panel="${name}"] h1`);
    if (heading) { heading.setAttribute('tabindex','-1'); heading.focus({preventScroll:true}); }
    // Let the 3D scene suspend its render loop in hidden application panels.
    $('kurtScene').dispatchEvent(new Event('gateway-scene-visibility'));
  }
  document.querySelectorAll('[data-open-app]').forEach(button => button.addEventListener('click', () => openApp(button.dataset.openApp)));
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && activeApp !== 'home') openApp('home'); });
  for (const id of ['openCommunity','browserChannel']) $(id).href = `/t/${token}`;
  $('browserWebsite').href = `/w/${token}`;
  $('desktopFullscreen').addEventListener('click', async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch { $('desktopFullscreen').title = 'Full screen is unavailable in this browser'; }
  });
  function clock() {
    const now = new Date();
    $('desktopClock').textContent = now.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'UTC'})+' UTC';
    $('desktopClock').dateTime = now.toISOString();
    $('desktopDate').textContent = now.toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',timeZone:'UTC'});
  }
  clock(); let clockTimer = setInterval(clock,30_000);
  const stateLabels = {voting:'Open for voting',queued:'In the queue',in_progress:'In progress',done:'Output saved',paused:'Paused',cancelled:'Withdrawn',not_approved:'Not approved',reported_complete:'Reported complete · not verified',rejected_by_rules:'Cannot proceed'};
  function node(tag,className,text) { const el=document.createElement(tag); if(className)el.className=className; if(text!=null)el.textContent=String(text); return el; }
  function empty(target,text) { target.replaceChildren(node('p','empty-state',text)); }
  function render(t) {
    if (String(t?.address).toLowerCase() !== token.toLowerCase()) return;
    window.GatewayKurt?.update(t);
    $('desktopCommunity').textContent = String(t.name || 'Your community').slice(0,80);
    $('desktopCaption').textContent = String(t.symbol || 'Community').slice(0,20)+' · Kurt’s workspace';
    const tasks = Array.isArray(t.community?.tasks) ? t.community.tasks.slice(0,30) : [];
    const next = tasks.find(task=>['in_progress','queued','voting'].includes(task.state));
    const current = $('desktopTask');
    current.replaceChildren(node('span','',next?.title || 'Room for the next idea'));
    current.append(node('small','',next ? stateLabels[next.state] : 'Community proposals appear here'));
    const messages = Array.isArray(t.messages) ? t.messages.slice(-16) : [];
    const conversation = $('desktopMessages'); const follow = conversation.scrollHeight-conversation.scrollTop-conversation.clientHeight<80; const scroll=conversation.scrollTop;
    conversation.replaceChildren(...messages.map(m=>{
      const article=node('article','conversation-message');
      const holder=String(m.holder||''); const name=t.profiles?.[holder] ? '@'+t.profiles[holder] : holder ? holder.slice(0,6)+'…'+holder.slice(-4) : 'Community member';
      article.append(node('small','',name),node('p','',String(m.text||'').slice(0,4000)));
      if(typeof m.reply?.text==='string'){const reply=node('div','answer');reply.append(node('small','','Kurt'),node('p','',m.reply.text.slice(0,6000)));article.append(reply);}
      return article;
    }));
    if(!messages.length)empty(conversation,'No conversation yet. Holders can join from their own devices.');
    conversation.scrollTop=follow?conversation.scrollHeight:scroll;
    $('desktopTasks').replaceChildren(...tasks.map(task=>{const item=node('article','work-item');item.append(node('strong','',task.title||'Community task'),node('small','',stateLabels[task.state]||'Awaiting an update'));return item;}));
    if(!tasks.length)empty($('desktopTasks'),'No tasks yet. The community chooses what comes next.');
    const files=(Array.isArray(t.community?.artifacts)?t.community.artifacts:[]).filter(a=>/^delivery-[a-f0-9]{24}$/.test(a.id)).slice(0,30);
    $('desktopFiles').replaceChildren(...files.map(file=>{const item=node('article','work-item');item.append(node('strong','',file.title||'Saved output'),node('small','',file.kind==='website'?'Website source':'Written output'));const link=node('a','','Download saved output');link.href=`/api/site/token/${token}/deliveries/${file.id}`;link.setAttribute('download','');item.append(link);return item;}));
    if(!files.length)empty($('desktopFiles'),'Finished work will be saved here. No private machine files are shown.');
    const published=!!(t.website?.version && t.website?.content);
    $('browserWebsite').hidden=!published; $('websitePending').hidden=published;
    renderStage(t.desktop && t.desktop.embedUrl ? t.desktop : null);
  }
  // A page or video an ORDER-role holder asked Kurt to show: framed inside the Browser app.
  let stageView = null;
  function renderStage(stage) {
    if (!stageView) {
      stageView = node('div','stage-view'); stageView.id='stageView'; stageView.hidden = true;
      const bar = node('div','stage-bar'); bar.append(node('span','stage-title'), node('span','stage-by'));
      const frame = document.createElement('iframe'); frame.id='stageFrame'; frame.title='Shared screen'; frame.setAttribute('allow','autoplay; fullscreen; picture-in-picture; encrypted-media'); frame.setAttribute('referrerpolicy','no-referrer'); frame.setAttribute('sandbox','allow-scripts allow-same-origin allow-forms allow-popups allow-presentation');
      stageView.append(bar, frame);
      document.querySelector('[data-app-panel="browser"]').append(stageView);
    }
    const frame = $('stageFrame');
    if (stage) {
      if (stageView.dataset.url !== stage.embedUrl) {
        stageView.dataset.url = stage.embedUrl; frame.src = stage.embedUrl;
        stageView.querySelector('.stage-title').textContent = String(stage.title || stage.url).slice(0,120);
        stageView.querySelector('.stage-by').textContent = 'requested by ' + String(stage.setBy || 'a holder').slice(0,40);
        stageView.hidden = false; openApp('browser');
      }
    } else if (stageView.dataset.url) {
      delete stageView.dataset.url; frame.src = 'about:blank'; stageView.hidden = true;
      if (activeApp === 'browser') openApp('home');
    }
  }
  const live=GatewayLiveToken({token,render,status:state=>{$('connection').textContent=({live:'Updates connected',connecting:'Connecting',reconnecting:'Reconnecting'})[state]||'Connecting';}});
  live.start();
  window.addEventListener('pagehide',()=>{live.stop();clearInterval(clockTimer);clockTimer=null;});
  window.addEventListener('pageshow',()=>{live.start();clock();clockTimer ||= setInterval(clock,30_000);});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)live.stop();else live.start();});
})();
