(() => {
  const $=id=>document.getElementById(id), TYPE='PROJECT_PROFILE_UPDATE';
  const fields={displayName:'profileDisplayName',tagline:'profileTagline',description:'profileDescription',audience:'profileAudience',logoBrief:'profileLogoBrief',brandColor:'profileBrandColor'};
  let current=null,token='',draft=null,logo=undefined,loading=false,readId=0,shownLogo='';
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const labels={displayName:'Project name',tagline:'Tagline',description:'Description',audience:'Audience',logoBrief:'Logo direction',brandColor:'Brand color',logoPng:'Logo'};
  const templates={
    identity:['TASK','Project identity ideas','Suggest project names, a slogan, a color palette and a written logo design brief for this project\nAudience and tone\nDeliver a written draft only. No image generation, official identity change or token rename.'],
    report:['TASK','Research report','/research Describe the public topic here\nDeliver a written report with sources, dates and clear limitations'],
    content:['TASK','Community content','Prepare announcement or article drafts for this project\nAudience, language and purpose\nDeliver the actual text. Do not publish to social accounts.'],
    website:['WEBSITE_UPDATE','Community website','Create a simple static page about this community using its approved project profile\nInclude an AI agent disclosure\nNo forms scripts external tracking or payments'],
    roadmap:['TASK','Proposed roadmap','Draft priorities and milestones for this project\nExplain the user benefit and what is currently feasible\nDistinguish suggestions from approved commitments'],
    community:['TASK','Community welcome guide','Write a welcome guide and frequently asked questions for this community\nExplain participation and current limitations in plain language'],
    transparency:['TASK','Project progress review','Summarize the recorded decisions, delivered work and available spending information\nState missing information explicitly. Do not invent income, performance or completed work.'],
    mission:['MISSION_CHANGE','Update the ongoing mission','Describe the new ongoing focus for this project\nExisting safety rules, permissions and payment limits remain unchanged'],
  };
  function mode(){
    const editing=$('propType').value===TYPE;
    $('projectFields').hidden=!editing;$('propText').parentElement.hidden=editing;$('propText').required=!editing;
    if(editing&&current&&!draft)fill();
  }
  function fill(){
    draft={...current};logo=undefined;readId++;loading=false;
    for(const [field,id]of Object.entries(fields))$(id).value=current[field]||'';
    $('profileLogoFile').value='';$('profileRemoveLogo').checked=false;
    $('profileLogoPreview').hidden=true;$('profileLogoPreview').removeAttribute('src');$('profileLogoNotice').textContent='';
    $('projectEditNotice').textContent=`Editing project profile v${draft.version}. Only these exact voted changes can be applied. The token contract, symbol, Kurt and permissions stay unchanged.`;
  }
  $('propType').addEventListener('change',mode);
  $('editProjectProfile').addEventListener('click',()=>{
    if(!current)return;fill();$('propType').value=TYPE;mode();$('propTitle').value='Update the project profile';$('profileDisplayName').focus();
  });
  $('profileRemoveLogo').addEventListener('change',()=>{
    readId++;loading=false;logo=$('profileRemoveLogo').checked?null:undefined;
    $('profileLogoFile').value='';$('profileLogoPreview').hidden=true;$('profileLogoPreview').removeAttribute('src');$('profileLogoNotice').textContent='';
  });
  $('profileLogoFile').addEventListener('change',async()=>{
    const id=++readId,file=$('profileLogoFile').files[0];logo=undefined;$('profileRemoveLogo').checked=false;
    $('profileLogoPreview').hidden=true;$('profileLogoPreview').removeAttribute('src');
    if(!file){loading=false;return;}
    loading=true;$('profileLogoNotice').textContent='Preparing logo…';
    try{
      if(file.size>2_000_000||!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('Choose a PNG, JPEG or WebP under 2 MB.');
      const image=await createImageBitmap(file);
      const scale=Math.min(1,128/Math.max(image.width,image.height));
      const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));
      try{canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);}finally{image.close();}
      const value=canvas.toDataURL('image/png');if(value.length>131072)throw new Error('This logo is too large. Use a simpler image.');
      if(id!==readId)return;logo=value;$('profileLogoPreview').src=value;$('profileLogoPreview').hidden=false;$('profileLogoNotice').textContent='Ready for voting. This does not change the current logo.';
    }catch(e){if(id===readId){$('profileLogoNotice').textContent=e.message;$('profileLogoFile').value='';}}
    finally{if(id===readId)loading=false;}
  });
  function payload(){
    if(loading)throw new Error('Wait until the logo is ready.');
    if(!draft||!current)throw new Error('Load the project profile first.');
    if(current.version!==draft.version)throw new Error('The profile changed while you were editing. Click Propose a profile change to review the new version.');
    const changes={};for(const[field,id]of Object.entries(fields)){const value=$(id).value.trim();if(value!==(draft[field]||''))changes[field]=value;}
    if(logo!==undefined)changes.logoPng=logo;
    if(!Object.keys(changes).length)throw new Error('Change at least one project field.');
    return{baseVersion:draft.version,changes};
  }
  function render(t){
    if(!t.project)return;current=t.project;const address=String(t.address);token=/^0x[0-9a-fA-F]{40}$/.test(address)?address.toLowerCase():address;
    if($('propType').value===TYPE&&!draft)fill();
    $('projectName').textContent=current.displayName;$('projectTagline').textContent=current.tagline;
    $('projectDescription').textContent=current.description||'No community-approved description yet.';
    $('projectAudience').textContent='Audience: '+(current.audience||'Not defined yet');
    $('projectLogoBrief').textContent='Logo direction: '+(current.logoBrief||'Not defined yet');
    $('projectVersion').textContent=current.version?`Community-approved profile v${current.version} · token name remains ${t.name} (${t.symbol})`:`Initial project name · token ${t.symbol} · changes require a community vote`;
    $('projectLogo').hidden=!current.logoUrl;
    const nextLogo=current.logoUrl?`/api/site/token/${token}/project-logo?v=${Number(current.version)||0}`:'';
    if(nextLogo!==shownLogo){if(nextLogo)$('projectLogo').src=nextLogo;else $('projectLogo').removeAttribute('src');shownLogo=nextLogo;}
    if(/^#[a-fA-F0-9]{6}$/.test(current.brandColor))$('projectName').style.borderInlineStart='4px solid '+current.brandColor;
    $('projectHistory').replaceChildren(...(current.history||[]).slice(-8).reverse().map(h=>{const p=document.createElement('p');p.textContent=`v${h.version} · ${h.displayName} · ${(h.fields||[]).map(k=>labels[k]||k).join(', ')} · ${h.proposalId}`;return p;}));
    if(draft&&current.version!==draft.version)$('projectEditNotice').textContent='A newer profile was approved. Your draft is preserved, but you must reopen the latest profile before submitting.';
  }
  function ballot(p){
    if(p.type!==TYPE)return '';
    const items=Object.entries(p.payload?.changes||{}).map(([key,value])=>`<li><b>${esc(labels[key]||key)}</b>: ${esc(value||'(empty)')}</li>`).join('');
    const preview=p.logoPreviewUrl&&/^prop_[a-zA-Z0-9_]{1,80}$/.test(p.id)?`<img width="64" height="64" alt="Logo proposed in this vote" src="/api/site/token/${token}/project-logo?proposalId=${encodeURIComponent(p.id)}">`:'';
    return `<div class="profile-ballot"><p>Exact changes to profile v${esc(p.payload?.baseVersion)} · on-chain token unchanged</p><ul>${items}</ul>${preview}</div>`;
  }
  window.GatewayProject={templates,payload,render,ballot};mode();
})();

// Live-room read-only metrics.
(() => {
  let latest=null, ready=false;
  const finite=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
  function metrics(t,now=Date.now()) {
    const balance=[t.funding?.treasuryUsd,t.lock?.treasuryUsd,t.budget?.remainingUsd].find(finite)??null;
    const fx=[t.treasury?.ethUsd,t.funding?.ethUsd].find(v=>finite(v)&&v>0);
    const cap=t.market?.mcapEth, product=finite(cap)&&fx?cap*fx:null;
    const mcap=finite(product)?product:null;
    const timestamp=Date.parse(t.market?.updatedAt||'');
    const marketNote=!Number.isFinite(timestamp)?'Update unavailable':t.market?.error||now-timestamp>180000||timestamp>now?'Last known price':'On-chain estimate · USD';
    // The startup target, read the same way the funding meter reads it: how full, what is missing.
    const target=[t.funding?.activationUsd,t.lock?.activationUsd,t.plan?.activationUsd].find(v=>finite(v)&&v>0)??null;
    const complete=(t.startup?.version===1&&t.startup.fundingComplete===true)||(balance!==null&&target!==null&&balance>=target);
    const raw=complete?100:balance!==null&&target!==null?Math.min(100,Math.max(0,balance/target*100)):null;
    const pct=raw===null?null:raw>0&&raw<10?raw.toFixed(1):String(Math.round(raw));
    const missing=balance!==null&&target!==null?Math.max(0,target-balance):null;
    const running=t.vps?.mode==='real'&&t.vps?.state==='running'&&t.lock?.state!=='paused',hours=finite(t.budget?.runwayHours)?t.budget.runwayHours:null;
    const runwayDays=running&&hours!==null?Math.round(hours/24*10)/10:null;
    const earned=finite(t.funding?.taxUsd)?t.funding.taxUsd:null;
    return {balance,mcap,marketNote,target,complete,pct,missing,running,runwayDays,earned};
  }
  function fundBalance(t) { return globalThis.GatewayProjectFunds.model(t).totalUsd; }
  const usd=n=>n===null?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:2}).format(n);
  function renderStages(t) {
    const root=document.getElementById('projectStages'),note=document.getElementById('projectStagesNote'), data=t.startupStages;
    const ids=['runtime','social','dex','holders'], states=['pending','funding','ready','processing','complete','attention_required'];
    const valid=data?.version===1&&Array.isArray(data.stages)&&data.stages.length===4&&data.stages.every((s,i)=>s?.id===ids[i]&&states.includes(s.state));
    root.hidden=!valid;note.hidden=!valid;if(!valid)return;
    const list=document.getElementById('projectStagesList');
    const labels={pending:'Next',funding:'Collecting',ready:'Ready',processing:'In progress',complete:'Done',attention_required:'Needs attention'};
    const stageNames={runtime:'AI & computer',social:'X account',dex:'DEX Screener',holders:'Community work'};
    const shortDetails={
      'The AI computer is online.':'Computer online.',
      'Starting the AI computer.':'Starting the computer.',
      'Collecting the initial AI and computer budget.':'First, fund the AI and computer.',
      'Starts after the AI computer is online.':'After the computer is online.',
      'Waiting for an available verified account. No payment taken.':'Waiting for an account. No payment taken.',
      'The account payment and assignment are verified.':'Assigned and paid.',
      'Account funding preserves the running computer budget.':'Running costs stay covered.',
      'Starts after the X account is verified.':'After the X account is ready.',
      'Payment and listing publication are verified.':'Paid and listed.',
      'A verified order, payment receipt and published listing are required.':'Order, payment and listing are checked separately.',
      'Custom holder work opens after the AI computer, X account and DEX listing are ready.':'After all three steps are complete.'
    };
    const displayed=globalThis.GatewayProjectFunds.model(t);
    const stamp=JSON.stringify([data.stages,displayed.totalUsd,displayed.targetUsd,displayed.pendingCollection,displayed.initialFunded]);
    if(list.dataset.snapshot!==stamp){
      const rows=data.stages.map((s,index)=>{
        const li=document.createElement('li');li.className='project-stage';li.dataset.state=s.state;
        if(data.activeStage===s.id)li.setAttribute('aria-current','step');
        const number=document.createElement('span');number.className='project-stage-number';number.textContent=s.state==='complete'?'✓':String(index+1);number.setAttribute('aria-hidden','true');
        const content=document.createElement('div'),label=document.createElement('strong'),state=document.createElement('small'),detail=document.createElement('p');
        label.textContent=stageNames[s.id]||String(s.label||s.id).slice(0,80);state.textContent=labels[s.state];detail.textContent=shortDetails[s.detail]||String(s.detail||'').slice(0,300);
        if(s.id==='runtime'&&!displayed.initialFunded)detail.textContent=displayed.totalUsd===null?'Updating project funds…':displayed.pendingCollection?'Target collected. Waiting for reward collection.':displayed.remainingUsd!==null?usd(displayed.remainingUsd)+' to the initial budget.':detail.textContent;
        content.append(label,state,detail);
        if(Number.isSafeInteger(s.requiredMicros)&&s.requiredMicros>0){
          const amount=document.createElement('b');amount.className='project-stage-amount';
          amount.textContent=s.state==='complete'?'Confirmed':s.id==='runtime'&&displayed.initialFunded?'Initial budget funded':s.id==='runtime'?usd(displayed.totalUsd)+' / '+usd(s.requiredMicros/1e6):s.state==='pending'?usd(s.requiredMicros/1e6)+' budget':Number.isSafeInteger(s.availableMicros)&&s.availableMicros>=0?usd(Math.min(s.availableMicros,s.requiredMicros)/1e6)+' / '+usd(s.requiredMicros/1e6):usd(s.requiredMicros/1e6)+' budget';
          content.append(amount);
        }
        li.append(number,content);return li;
      });
      list.replaceChildren(...rows);list.dataset.snapshot=stamp;
    }
    document.getElementById('projectStagesReserve').textContent=Number.isSafeInteger(data.operatingReserveMicros)&&data.operatingReserveMicros>0?'Operating reserve target: '+usd(data.operatingReserveMicros/1e6):'';
    note.textContent=data.holderWorkAllowed?'Ready for approved work, within the available budget.':'Fund balance includes creator rewards. Payments use collected funds; ongoing costs stay reserved.';
  }
  function renderPublicAccount(t) {
    const $=id=>document.getElementById(id),s=t.social?.milestone||{},account=t.social?.x||null;
    const valid=account&&/^[a-zA-Z0-9_]{1,15}$/.test(account.handle||'')&&/^[1-9][0-9]{0,29}$/.test(String(account.userId||''));
    const threshold=Number.isSafeInteger(s.thresholdMicros)&&s.thresholdMicros>0?s.thresholdMicros/1e6:null;
    const collected=Number.isSafeInteger(s.collectedMicros)&&s.collectedMicros>=0?s.collectedMicros/1e6:null;
    const allocation=t.launchPackage?.socialAccount,waiting=!valid&&s.state==='waiting_for_account'&&s.funded===true;
    const reserved=waiting&&allocation?.paid===false&&allocation?.spentMicros===0&&Number.isSafeInteger(allocation?.reservedMicros)&&allocation.reservedMicros>0&&allocation.reservedMicros===s.thresholdMicros;
    const status=valid?'Assigned':s.state||'checking';
    const labels={checking:'Checking',funding:'Collecting',paused:'Paused',awaiting_previous_stage:'Up next',waiting_for_account:'Waiting',not_connected:'Unavailable',assigning:'Assigning',payment_pending:'Confirming',review_required:'Needs review'};
    $('projectXStatus').textContent=waiting?'Funded · waiting':labels[status]||status;
    for(const id of ['projectXPublicLink','projectXHeaderLink']){
      const link=$(id);link.hidden=!valid;
      if(valid){link.textContent='@'+account.handle+(id==='projectXPublicLink'?' ↗':'');link.href='https://x.com/'+account.handle;}
      else{link.removeAttribute('href');link.textContent='';}
    }
    const details={checking:'Checking account status.',funding:'Collecting the account budget.',paused:'Resumes when the project resumes.',awaiting_previous_stage:'After the AI computer is online.',waiting_for_account:'Waiting for a verified account.',not_connected:'Waiting for the account service.',assigning:'Assigning a verified account.',payment_pending:'Checking the original request and payment.',review_required:'An earlier request needs review. No new payment.'};
    $('projectXDetail').textContent=valid?'For approved posts and account updates.':waiting?'Waiting for an available verified X account. No additional X setup funding is needed.':(details[s.state]||(typeof s.detail==='string'?s.detail:'Checking account status.'))+(s.state==='funding'&&s.accountAvailable===false?' No verified account is available yet.':'');
    $('projectXProgress').hidden=valid||threshold===null||collected===null;
    const progress=threshold&&collected!==null?Math.min(100,collected/threshold*100):0;
    $('projectXProgress').setAttribute('aria-valuenow',String(Math.round(progress)));
    $('projectXBar').style.width=progress+'%';
    $('projectXAmounts').textContent=valid?(t.runtime?.social==='approved_actions_only'?'Posting connected · signed approval required':'Posting connection not yet confirmed'):reserved?usd(allocation.reservedMicros/1e6)+' reserved · not charged':threshold===null||collected===null?'':s.state==='awaiting_previous_stage'?usd(threshold)+' setup budget':usd(collected)+' / '+usd(threshold);
  }
  function render(t) {
    latest=t;if(!ready)return;renderPublicAccount(t);renderStages(t);
    const $=id=>document.getElementById(id),m=metrics(t);
    $('roomMcap').textContent=m.mcap===null?'—':m.mcap<1000?usd(m.mcap):new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',notation:'compact',maximumFractionDigits:2}).format(m.mcap);
    $('roomMcap').title=m.mcap===null?'Market cap is unavailable':usd(m.mcap)+' estimated token market cap; not project funds';
    $('roomMcapNote').textContent=m.mcap===null?'Price unavailable':m.marketNote;
    const early=m.running&&m.target!==null&&m.balance!==null&&m.balance<m.target;
    // The startup-fund tile next to this button carries the percentage and the bar (owner 2026-09-24);
    // this button is the money itself, and the way into the spending details.
    void early;
    const fees=t.creatorFees,fresh=fees?.fresh===true&&finite(fees.pendingUsd);
    $('roomRewards').textContent=usd(fresh?fees.pendingUsd:m.earned);
    $('roomRewardsLabel').textContent=fresh?'Unclaimed fees':'Est. creator fees';
    $('roomRewardsNote').textContent=fresh?'Not yet in the balance':m.earned===null?'Fees unavailable':'Trade estimate · not spendable';
    $('roomRewards').title=fresh?'On-chain fees awaiting collection. '+fees.thresholdSol+' SOL minimum; network fees also apply.':'Creator fees recorded in indexed trades, valued at the current price. These are not the spendable wallet balance.';
    const total=fundBalance(t,m.balance);
    $('budgetOverview').textContent=usd(total);
    $('budgetOverview').title='Wallet funds plus creator rewards awaiting collection';
    $('roomBudgetNote').textContent=total===null?'Updating balance…':'View funding';
    const balanceLabel=$('roomBalanceLabel');if(balanceLabel&&balanceLabel.lastChild)balanceLabel.lastChild.textContent='Fund balance';
    const work=(t.community?.tasks||[]).find(x=>x.state==='in_progress');
    document.body.classList.toggle('room-has-task',!!work);
    // A live project leads with its screen (the layout orders by CSS, see .room-live in the stylesheet).
    document.body.classList.toggle('room-live',t.vps?.mode==='real'&&t.vps?.state==='running'&&t.vps?.phase==='live');
    $('roomWorkStatus').textContent=work?'Working on: '+String(work.title||'Community task').slice(0,180):'Tasks & results';
    $('roomWorkCount').textContent=String((t.community?.artifacts||[]).length)+' saved outputs';
    if(work){$('nowtitle').textContent=String(work.title||'Community task').slice(0,180);$('nowsub').textContent='Progress reported by Kurt';}
    try{const u=new URL(t.onchain?.pons||'');$('roomTokenLink').hidden=u.protocol!=='https:'||u.origin!=='https://www.ponsfamily.com'||!!u.username||!!u.password;if(!$('roomTokenLink').hidden)$('roomTokenLink').href=u.href;}catch{$('roomTokenLink').hidden=true;}
  }
  window.GatewayRoom={metrics,fundBalance,render,start(){ready=true;if(latest)render(latest);}};
})();

// Stable room presentation. Controls and sections are authored in token.html.
document.addEventListener('DOMContentLoaded', () => {
  const $=id=>document.getElementById(id);
  if(document.body.dataset.roomStatic!=='1'||!$('proposals')||document.body.dataset.roomEnhanced)return;
  document.body.dataset.roomEnhanced='1';
  // Mirror clipboard results from the existing native handlers; never write a
  // second address or infer success from a click alone.
  function copyFeedback(buttonId,addressId,labelId,sourceId,statusId,kind){
    const button=$(buttonId),address=$(addressId),label=$(labelId),source=$(sourceId),status=$(statusId);
    if(!button||!address||!label||!source||!status)return;
    const originalLabel=button.getAttribute('aria-label');let reset=null;
    function selectAddress(){
      try{const selection=window.getSelection?.(),range=document.createRange?.();if(!selection||!range)return false;range.selectNodeContents(address);selection.removeAllRanges();selection.addRange(range);return true;}catch{return false;}
    }
    function sync(){
      const result=source.textContent.trim(),copied=/\bcopied\b/i.test(result),failed=/unavailable|select.*copy/i.test(result);
      button.dataset.copyState=copied?'copied':failed?'error':'idle';
      button.setAttribute('aria-label',copied?kind+' address copied. Copy again':originalLabel);
      if(source!==label){
        label.textContent=copied?'Copied':failed?'Select & copy':'Copy';
        clearTimeout(reset);
        if(copied)reset=setTimeout(()=>{if(source.textContent===result)source.textContent='';},2000);
      }else if(status!==source){
        status.textContent=copied?kind+' address copied':failed?'Copy unavailable. Select and copy the address above.':'';
      }
      if(failed)selectAddress();
    }
    new MutationObserver(sync).observe(source,{childList:true,characterData:true,subtree:true});sync();
  }
  copyFeedback('contract','contractAddress','contractCopyLabel','copyStatus','copyStatus','Token contract');
  copyFeedback('aiWalletCopy','aiWalletAddress','aiWalletCopyLabel','aiWalletCopyLabel','aiWalletCopyStatus','AI wallet');
  const examples=document.querySelector('.idea-examples');
  examples?.addEventListener('click',event=>{if(event.target.closest('[data-template]'))examples.open=false;});

  // Presentation only: retain the existing forms, player and render targets.
  // Enhanced panes are enabled only after every authored tab has a real panel.
  const workspace=(() => {
    const dock=$('roomDock'),names=['ideas','work','budget','setup','services'];
    if(!dock)return null;
    const tablist=dock.querySelector('.workspace-tabs');
    const tabs=names.map(name=>tablist?.querySelector('[data-workspace-tab="'+name+'"]'));
    const panels=names.map(name=>dock.querySelector('[data-workspace-panel="'+name+'"]'));
    if(tabs.some(x=>!x)||panels.some(x=>!x))return null;
    const views=['live','chat','funds','work'];
    const viewButtons=[...document.querySelectorAll('button[data-workspace-view]')].filter(b=>views.includes(b.dataset.workspaceView));
    const wideScreen=typeof window.matchMedia==='function'?window.matchMedia('(min-width:1180px)'):null;
    const xDetails=$('projectXMilestone');let mobileChatVisited=false;
    let selected='ideas';
    tablist.setAttribute('role','tablist');
    tabs.forEach((button,index)=>{
      button.id ||= 'roomTab'+names[index][0].toUpperCase()+names[index].slice(1);
      panels[index].id ||= 'roomPanel'+names[index][0].toUpperCase()+names[index].slice(1);
      button.setAttribute('role','tab');button.setAttribute('aria-controls',panels[index].id);
      panels[index].setAttribute('role','tabpanel');panels[index].setAttribute('aria-labelledby',button.id);
      panels[index].tabIndex=-1;
    });
    function considerXDisclosure(view){
      if(view!=='chat'||wideScreen?.matches!==false||mobileChatVisited)return;
      mobileChatVisited=true;
      // Keep an already assigned account visible. Otherwise collapse once,
      // leaving subsequent open/close choices to the reader.
      if(xDetails?.tagName==='DETAILS'&&$('projectXPublicLink')?.hidden!==false)xDetails.open=false;
    }
    function setView(view){
      if(!views.includes(view))return false;
      document.body.dataset.workspaceView=view;
      considerXDisclosure(view);
      for(const button of viewButtons){const active=button.dataset.workspaceView===view;button.setAttribute('aria-pressed',String(active));button.classList.toggle('is-active',active);}
      return true;
    }
    function selectTab(name,{focus=false,changeView=true}={}){
      const index=names.indexOf(name);if(index<0)return false;
      selected=name;
      tabs.forEach((button,i)=>{
        const active=i===index;
        button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;button.classList.toggle('is-active',active);
        panels[i].hidden=!active;panels[i].inert=!active;
      });
      if(changeView)setView('work');
      if(focus)tabs[index].focus({preventScroll:true});
      return true;
    }
    tablist.addEventListener('click',event=>{const button=event.target.closest('[data-workspace-tab]');if(button&&tabs.includes(button))selectTab(button.dataset.workspaceTab);});
    tablist.addEventListener('keydown',event=>{
      const button=event.target.closest('[data-workspace-tab]'),index=tabs.indexOf(button);if(index<0)return;
      let next;
      if(event.key==='Home')next=0;
      else if(event.key==='End')next=tabs.length-1;
      else if(event.key==='ArrowRight')next=(index+1)%tabs.length;
      else if(event.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;
      else return;
      event.preventDefault();selectTab(names[next],{focus:true});
    });
    for(const button of viewButtons)button.addEventListener('click',()=>{
      const view=button.dataset.workspaceView;
      if(view==='work')selectTab('work');else setView(view);
    });
    function reveal(target){
      const panel=target.closest('[data-workspace-panel]');
      if(panel&&names.includes(panel.dataset.workspacePanel))selectTab(panel.dataset.workspacePanel);
      else if(target.closest('#roomInspector'))setView('funds');
      else if(target.closest('aside.chat'))setView('chat');
      else if(target.id==='live'||target.closest('#desktopPanel'))setView('live');
    }
    // Copy the host's already-rendered funding strings, never recalculate money.
    const mirrors=[['fundNow','workspaceFundNow'],['fundOf','workspaceFundOf'],['fundLine','workspaceFundLine']];
    function mirrorFunding(){
      for(const [sourceId,targetId] of mirrors){const source=$(sourceId),target=$(targetId);if(source&&target&&target.textContent!==source.textContent)target.textContent=source.textContent;}
      const source=$('fundBar'),target=$('workspaceFundBar');
      if(source&&target&&source.style.width!==target.style.width)target.style.width=source.style.width;
      const progress=$('fundingProgress'),mirror=target?.closest('[role="progressbar"]');
      if(progress&&mirror)for(const name of ['aria-valuemin','aria-valuemax','aria-valuenow','aria-valuetext']){
        const value=progress.getAttribute(name);
        if(value===null)mirror.removeAttribute(name);else if(mirror.getAttribute(name)!==value)mirror.setAttribute(name,value);
      }
    }
    const fundingObserver=new MutationObserver(mirrorFunding);
    for(const id of [...mirrors.map(([id])=>id),'fundBar','fundingProgress']){
      const source=$(id);if(source)fundingObserver.observe(source,{childList:true,characterData:true,subtree:true,attributes:true,attributeFilter:['style','aria-valuemin','aria-valuemax','aria-valuenow','aria-valuetext']});
    }
    const addresses=$('workspaceAddresses');
    if(wideScreen){
      const syncDisclosures=()=>{
        if(addresses)addresses.open=wideScreen.matches;
        mobileChatVisited=false;
        considerXDisclosure(document.body.dataset.workspaceView);
      };
      syncDisclosures();
      // Only a breakpoint crossing resets this. A user's mobile disclosure
      // choice survives live data updates and resizing within the same range.
      if(typeof wideScreen.addEventListener==='function')wideScreen.addEventListener('change',syncDisclosures);
      else if(typeof wideScreen.addListener==='function')wideScreen.addListener(syncDisclosures);
    }
    selectTab(selected,{changeView:false});setView('live');mirrorFunding();
    document.body.dataset.workspaceEnhanced='1';
    return {reveal,selectTab};
  })();

  const about=$('aboutDialog'),idea=$('ideaComposer'),dialogs=[about,idea],suggest=$('suggestIdea');
  let returnFocus=null;
  function openDialog(target,opener){
    returnFocus=opener||document.activeElement;
    for(const d of dialogs)if(d!==target&&d.open)d.close();
    if(!target.open)target.showModal();
  }
  for(const d of dialogs){
    d.querySelector('[data-close-dialog]')?.addEventListener('click',()=>d.close());
    d.addEventListener('close',()=>{
      if(dialogs.some(x=>x.open))return;
      const visible=returnFocus?.checkVisibility?returnFocus.checkVisibility():returnFocus?.getClientRects().length;
      (visible?returnFocus:suggest)?.focus();
    });
  }
  function openIdea(opener,focus=true){openDialog(idea,opener);if(focus)$('propTitle').focus();}
  function revealSection(id){
    const target=$(id);if(!target)return false;
    workspace?.reveal(target);
    if(!target.hasAttribute('tabindex'))target.setAttribute('tabindex','-1');
    target.scrollIntoView({block:'start',behavior:'instant'});target.focus({preventScroll:true});return true;
  }
  window.GatewayRoomDialogs={idea:openIdea,budget:()=>revealSection('budget')};
  suggest.addEventListener('click',()=>openIdea(suggest));
  $('roomBudgetButton').addEventListener('click',()=>revealSection('budget'));
  $('roomAboutButton').addEventListener('click',()=>openDialog(about,$('roomAboutButton')));
  document.addEventListener('click',event=>{
    const button=event.target.closest('[data-workspace-open]');if(!button)return;
    const name=button.dataset.workspaceOpen;
    const target={ideas:'proposals',work:'roomWork',budget:'budget',setup:'roomSetupDetails',services:'roomServices'}[name];
    if(target&&revealSection(target))event.preventDefault();
  });
  for(const id of ['editProjectProfile','suggestDexUpdate','suggestDexBoost'])$(id)?.addEventListener('click',()=>openIdea($(id),false),{capture:true});
  const history=$('roomPastIdeas'),empty=$('ideasEmpty'),props=$('props');
  const applyFilter=()=>{let visible=0;for(const row of props.children){const state=row.dataset.ideaState;row.hidden=!state||(!history.checked&&state!=='voting');if(!row.hidden)visible++;}empty.hidden=visible>0;empty.textContent=history.checked?'No decisions yet.':'No open votes.';};
  history.addEventListener('change',applyFilter);new MutationObserver(applyFilter).observe(props,{childList:true});applyFilter();
  const handleAnchor=id=>{
    if(id==='socialBudget')return revealSection('budget');
    if(id==='funds')return revealSection('roomInspector');
    if(id==='setup')return revealSection('roomSetupDetails');
    if(id==='services')return revealSection('roomServices');
    if(id==='chat')return revealSection('msgs');
    if(['budget','funding','market','dexPayments','work','deliveries','live','roomWork','roomSetupDetails','roomServices','launchSetup','projectStages','projectXMilestone','xAccountCard'].includes(id))return revealSection(id);
    if(['about','community'].includes(id)){openDialog(about,$('roomAboutButton'));return true;}
    if(['ideas','proposals'].includes(id))return revealSection('proposals');
    return false;
  };
  document.addEventListener('click',event=>{const link=event.target.closest('a[href^="#"]');if(!link)return;const id=link.getAttribute('href').slice(1);if(link.closest('#work')&&id==='proposals'){event.preventDefault();openIdea(link);return;}if(handleAnchor(id))event.preventDefault();});
  window.addEventListener('hashchange',()=>handleAnchor(location.hash.slice(1)));
  window.GatewayRoom.start();handleAnchor(location.hash.slice(1));
});
