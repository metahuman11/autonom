(function(root){
  'use strict';
  const names={funding:'Initial funds',banner:'Banner',allocation:'Computer',boot:'Desktop',agent:'AI connection',voice:'Voice',dex:'DEX Screener',socialAccount:'X account',stream:'Live video'};
  const labels={complete:'Done',active:'In progress',pending:'Waiting',blocked:'Not ready',error:'Needs attention',paused:'Paused',unknown:'Checking'};
  // Support destination: empty until the brand's own channel exists — no personal handle on the site (owner 2026-09-25).
  const reportUrl='';
  function model(t){
    const s=t.startup?.version===1?t.startup:null;
    const paused=s?.state==='paused'||t.lock?.state==='paused';
    const stale=t.clientSnapshotExpired===true||['reconnecting','connection_stale'].includes(s?.state)||t.vps?.health?.status==='connection_stale';
    const simulated=s?.state==='simulation'||t.vps?.mode==='sim';
    const offline=t.runtime?.online===false||t.vps?.health?.agentOnline===false;
    const supplied=new Map((s?.steps||[]).map(x=>[x.id,x]));
    const waiting={funding:'Waiting for the initial funds.',allocation:'No computer rented yet.',boot:'After the computer is rented.',agent:'After the desktop is ready.',stream:'Waiting for live video.'};
    const working={funding:'Collecting the initial balance.',allocation:'Confirming the computer rental.',boot:'Installing the desktop and software.',agent:'Desktop ready. Connecting the AI.',stream:'AI connected. Waiting for video.'};
    const completed={funding:'Initial funds received.',allocation:'Computer rented.',boot:'Desktop ready.',agent:'AI connection confirmed.',stream:'Live video confirmed.'};
    const rows=['funding','allocation','boot','agent','stream'].map(id=>{
      const status=supplied.get(id)?.status;
      let state=['complete','active','error','pending'].includes(status)?status:'unknown';
      if(id==='funding'&&t.launchPackage?.funded===true)state='complete';
      if(id==='allocation'&&s?.state==='queued'&&state==='active')state='pending';
      if(simulated&&id!=='funding')state='unknown';
      else if(state!=='error'&&(stale&&(['agent','stream'].includes(id)||state==='active')||offline&&['agent','stream'].includes(id)&&state==='complete'||id==='stream'&&t.vps?.health?.streamReady===false&&state==='complete'))state='unknown';
      else if(paused&&state!=='error'&&(state!=='complete'||['agent','stream'].includes(id)))state='paused';
      let detail=state==='complete'?completed[id]:state==='active'?working[id]:state==='error'?(s?.detail||'An operator needs to check this step.'):state==='paused'?'Paused.':state==='unknown'?'Waiting for a fresh update.':waiting[id];
      if(id==='allocation'&&s?.state==='queued')detail='Queued. No computer rented yet.';
      if(id==='allocation'&&state==='active'&&s?.state==='checking_offer')detail='Checking availability and price. No rental yet.';
      return {id,title:names[id],state,detail};
    });
    const funds=root.GatewayProjectFunds?.model(t);
    if(funds){
      const funding=rows.find(row=>row.id==='funding'),usd=value=>value===null?'—':'$'+value.toFixed(2);
      if(funding&&funding.state!=='complete')funding.detail=funds.totalUsd===null?'Updating project funds…':`${usd(funds.totalUsd)} / ${usd(funds.targetUsd)} collected`+(funds.pendingCollection?' · awaiting reward collection.':'.');
    }
    const banner=t.launchAssets?.banner;
    const bannerReady=banner?.state==='ready'&&banner.width===600&&banner.height===200&&typeof t.address==='string'&&banner.projectAddress?.toLowerCase()===t.address.toLowerCase();
    const missingLogo=banner?.state==='missing_logo'||banner?.reason==='missing_logo';
    rows.splice(1,0,{id:'banner',title:names.banner,state:bannerReady?'complete':missingLogo?'blocked':banner?.state==='generating'?'active':banner?.state==='failed'?'error':'pending',detail:bannerReady?'600 × 200 · Ready':missingLogo?'The banner service has no usable logo yet.':banner?.state==='generating'?'Creating a banner from the logo.':banner?.state==='failed'?'Banner creation failed.':'No banner ready yet.'});
    const voice=t.runtime?.voice;
    const voiceReady=voice?.available===true&&voice?.nativeStreamAudio===true;
    const voiceState=paused?'paused':stale||simulated||offline?'unknown':voiceReady?'complete':voice?.status==='starting'?'active':voice?'blocked':'unknown';
    rows.splice(5,0,{id:'voice',title:names.voice,state:voiceState,detail:voiceState==='complete'?'Voice connected to the stream.':voiceState==='unknown'?'Voice connection not confirmed.':voiceState==='paused'?'Voice paused.':voiceState==='active'?'Starting voice. Stream audio is not confirmed.':voice?.status==='ready'?'Speech ready; stream audio unconfirmed.':'Voice or billing is not connected.'});
    const dex=t.launchPackage;
    const paid=dex?.paid===true,published=paid&&dex.publication==='published';
    // Operator detail is fixed-length plain text from the server; it is only ever written with textContent.
    const note=value=>typeof value==='string'&&value.trim()?' '+value.slice(0,200):'';
    const retryClock=value=>{const ms=Date.parse(value||'');return Number.isFinite(ms)?new Date(ms).toISOString().slice(11,16)+' UTC':null;};
    const dexState=dex?.state==='reconciliation_required'?'error':published?'complete':paid?'active':
      ['preparing','payment_pending','submitted'].includes(dex?.state)?'active':dex?.state==='prepared'?'pending':
      dex?.state==='not_connected'||dex?.automaticPaymentConnected===false||t.runtime?.dexPayments==='not_connected'?'blocked':'pending';
    const bridgeDetails={reserved:'Transferring the listing budget. Listing not paid yet.',submitted:'Transferring the listing budget. Listing not paid yet.',delivering:'Funds delivered. Checking the receiving wallet.',delivered:'Funds delivered. Checking the receiving wallet.',paying:'Paying the order. Confirmation pending.'};
    const dexDetails={preparing:'Preparing the listing order.',prepared:'Order ready. No payment sent.',payment_pending:'Checking the payment request.',submitted:'Waiting for payment confirmation.'};
    const dexRetry=dex?.state==='prepared'?retryClock(dex.nextAttemptAt):null;
    const dexDetail=dexState==='error'?(dex?.terminal===true?'Operator review needed. No repeat payment.':'Checking the earlier attempt. No repeat payment.')+note(dex?.detail):published?'Paid and listed.':paid?'Paid. Listing publication still pending.':dexState==='blocked'?'Checkout unavailable. No payment confirmed.':dexRetry?'Transfer retry at '+dexRetry+'. No payment sent.'+note(dex?.detail):(['payment_pending','submitted'].includes(dex?.state)&&bridgeDetails[dex?.bridgeState])||dexDetails[dex?.state]||'Waiting for the listing order and payment.';
    if(dex?.dexBudgetMicros > 0 || dex?.paid === true || ['payment_pending','submitted','reconciliation_required'].includes(dex?.state)) rows.splice(6,0,{id:'dex',title:names.dex,state:dexState,detail:dexDetail});
    if(dex?.socialAccountBudgetMicros > 0){
      const account=dex.socialAccount,accountState=account?.state;
      const acquired=account?.acquired===true,accountPaid=account?.paid===true;
      const complete=accountState==='settled'&&acquired&&accountPaid;
      const state=accountState==='reconciliation_required'||accountState==='settled'&&!complete?'error':complete?'complete':
        ['preparing','payment_pending','submitted'].includes(accountState)?'active':
        accountState==='not_connected'?'blocked':['funding','queued','prepared'].includes(accountState)?'pending':'unknown';
      const details={funding:'Collecting the account budget.',queued:'Waiting for an account; no purchase confirmed.',
        not_connected:'Account service unavailable; no purchase confirmed.',
        preparing:'Preparing the account request; no purchase confirmed.',prepared:'Account request ready; payment unconfirmed.',
        payment_pending:'Checking payment; account not confirmed yet.',
        submitted:accountPaid?'Account paid; checking assignment and balance.':'Checking the account request; payment unconfirmed.',
        reconciliation_required:'Checking the earlier account request. No repeat payment.'};
      const detail=complete?'Account assigned and paid.':state==='error'?(account?.terminal===true?'Operator review needed. No repeat payment.':details.reconciliation_required)+note(account?.detail):
        details[accountState]||'Waiting for account details.';
      rows.splice(7,0,{id:'socialAccount',title:names.socialAccount,state,detail:detail+' Posting readiness is separate.'});
    }
    // Later mandatory stages must never be described as optional add-ons.
    if(t.startupStages?.version===1){
      const stateMap={pending:'pending',funding:'pending',ready:'pending',processing:'active',complete:'complete',attention_required:'error'};
      const copy={
        'Starts after the AI computer is online.':'After the computer is online.',
        'Waiting for an available verified account. No payment taken.':'Waiting for an account. No payment taken.',
        'The account payment and assignment are verified.':'Account assigned and paid.',
        'Account funding preserves the running computer budget.':'Running costs stay covered.',
        'Starts after the X account is verified.':'After the X account is ready.',
        'Payment and listing publication are verified.':'Paid and listed.',
        'A verified order, payment receipt and published listing are required.':'Order, payment and listing are checked separately.'
      };
      for(const [id,stageId] of [['socialAccount','social'],['dex','dex']]){
        const row=rows.find(r=>r.id===id),stage=t.startupStages.stages?.find(r=>r.id===stageId);
        if(row&&stage&&Object.hasOwn(stateMap,stage.state)){row.state=stateMap[stage.state];row.detail=copy[stage.detail]||String(stage.detail||'').slice(0,300);}
      }
      const xIndex=rows.findIndex(r=>r.id==='socialAccount'),dexIndex=rows.findIndex(r=>r.id==='dex');
      if(dexIndex>=0&&xIndex>dexIndex){const [row]=rows.splice(dexIndex,1);rows.splice(xIndex,0,row);}
    }
    for(const row of rows)row.optional=['banner','voice'].includes(row.id);
    // Historic confirmations survive a dropped data feed; unfinished work must
    // not pretend to be current activity based on an expired snapshot.
    if(stale||simulated)for(const row of rows)if(row.state==='active'){
      row.state='unknown';row.detail=simulated?'Demo mode; real work is not confirmed.':'Connection lost. Waiting for a fresh update.';
    }
    const problems=rows.filter(x=>['error','blocked'].includes(x.state));
    const activity={funding:'Collecting funds',banner:'Creating banner',allocation:s?.state==='checking_offer'?'Checking availability':'Confirming rental',boot:'Preparing desktop',agent:'Connecting AI',voice:'Starting voice',stream:'Connecting video',dex:paid?'Checking publication':dex?.state==='preparing'?'Preparing order':['reserved','submitted'].includes(dex?.bridgeState)?'Bridging allocation':['delivering','delivered'].includes(dex?.bridgeState)?'Verifying delivery':dex?.bridgeState==='paying'?'Paying order':'Checking payment',socialAccount:dex?.socialAccount?.state==='preparing'?'Preparing account':'Checking purchase'};
    const active=rows.filter(x=>x.state==='active').map(row=>({...row,activity:activity[row.id]}));
    const complete=rows.every(x=>x.state==='complete');
    const funded=dex?.funded===true;
    const target=Number.isSafeInteger(dex?.activationMicros)&&dex.activationMicros>0?'$'+(dex.activationMicros/1e6).toLocaleString('en-US',{maximumFractionDigits:2}):null;
    const fundingText=funded?(target?target+' initial funds received':'Initial funds received'):null;
    const hasError=problems.some(x=>x.state==='error'||!x.optional)||s?.state==='attention_required';
    const title=stale?'Reconnecting':simulated?'Demo setup':hasError?'Setup needs attention':complete?'Setup complete':paused?'Paused':s?.state==='retry_wait'?'Waiting to retry':active.length?active.length===1?active[0].activity+'…':'Setting up':problems.length?(s?.state==='live'?'Live · extras pending':s?.title||'Extras pending'):funded?'Funded · waiting to start':s?.title||'Setup';
    const detail=stale?'Showing the last confirmed update.':simulated?'Demo mode. No real purchases or live AI are confirmed.':hasError?(s?.state==='attention_required'||s?.state==='retry_wait'?s.detail:'Open the steps to see what needs attention.'):complete?'All steps confirmed.':paused?'Paused. Adding funds will not restart it.':funded?'Funded. The remaining steps still need confirmation.':s?.detail||'Waiting for an update.';
    const displayDetail=s?.state==='funding'&&funds?(funds.totalUsd===null?'Updating project funds…':funds.pendingCollection?'Initial target reached. Setup waits for reward collection.':funds.remainingUsd!==null?'$'+funds.remainingUsd.toFixed(2)+' to the initial budget.':detail):detail;
    return {title,detail:displayDetail,rows,active,problems,fundingText,updatedAt:s?.updatedAt||null,complete,reportUrl};
  }
  let panel,last='',lastAnnouncement='';
  function render(t){
    const host=root.document?.getElementById('desktopPanel');if(!host)return;
    if(!panel){
      panel=document.createElement('section');panel.className='launch-progress';panel.setAttribute('aria-label','Setup progress');
      panel.innerHTML='<div class="lp-heading"><div><span class="lp-eyebrow">SETUP</span><h2></h2></div><span class="lp-count"></span></div><p class="lp-funded" hidden></p><p class="lp-detail"></p><ul class="lp-now" aria-label="Current setup activity"></ul><p class="lp-problem" hidden></p><details><summary>Step details <span aria-hidden="true">↗</span></summary><ol></ol></details><div class="lp-footer"><p class="lp-update"></p><a class="lp-report" href="#" hidden target="_blank" rel="noopener noreferrer" aria-label="Report a problem">Report <span aria-hidden="true">↗</span></a></div><p class="lp-support" hidden></p><span class="lp-announcement" role="status" aria-live="polite"></span>';
      // The workspace has a dedicated setup tab; older rooms keep the panel
      // below the desktop so startup details never push the stream down.
      const setupHost=root.document?.getElementById('roomSetupDetails');
      if(setupHost)setupHost.prepend(panel);else host.after(panel);
    }
    const value=model(t),key=JSON.stringify(value);if(key===last)return;last=key;
    panel.querySelector('h2').textContent=value.title;
    panel.querySelector('.lp-detail').textContent=value.detail;
    const funded=panel.querySelector('.lp-funded');funded.hidden=!value.fundingText;funded.textContent=value.fundingText||'';
    panel.querySelector('.lp-count').textContent=value.rows.filter(x=>x.state==='complete').length+' / '+value.rows.length+' done';
    const now=panel.querySelector('.lp-now');now.hidden=value.active.length<2;now.textContent='';
    for(const row of value.active){const item=document.createElement('li');item.textContent=row.title+' · '+row.activity;now.append(item);}
    const problem=panel.querySelector('.lp-problem');problem.hidden=!value.problems.length;
    const onlyOptional=value.problems.length>0&&value.problems.every(row=>row.optional===true&&row.state==='blocked');
    if(problem.classList)problem.classList.toggle('lp-note',onlyOptional);
    problem.textContent=onlyOptional?'Optional steps: '+value.problems.map(row=>row.title).join(' · ')+'.':value.problems.map(row=>row.title+' — '+labels[row.state]).join(' · ')+ (value.problems.length?'. See step details.':'');
    const list=panel.querySelector('ol');
    const currentIds=new Set(value.rows.map(row=>row.id));
    for(const item of list.querySelectorAll('[data-step]'))if(!currentIds.has(item.dataset.step))item.remove();
    for(const [index,row] of value.rows.entries()){
      let item=list.querySelector('[data-step="'+row.id+'"]');
      if(!item){item=document.createElement('li');item.dataset.step=row.id;item.innerHTML='<i aria-hidden="true"></i><div><strong></strong><p></p></div><span></span>';list.append(item);}
      if(list.children[index]!==item)list.insertBefore(item,list.children[index]||null);
      item.dataset.state=row.state;item.querySelector('i').textContent=row.state==='complete'?'✓':row.state==='error'?'!':String(index+1);
      item.querySelector('strong').textContent=row.title;item.querySelector('p').textContent=row.detail;item.querySelector('span').textContent=labels[row.state];
    }
    const ts=Date.parse(value.updatedAt||'');panel.querySelector('.lp-update').textContent=Number.isFinite(ts)?'Updated '+new Date(ts).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'No update yet';
    const announcement=value.title+'|'+value.rows.map(x=>x.id+':'+x.state).join('|');
    if(announcement!==lastAnnouncement){panel.querySelector('.lp-announcement').textContent=value.title+'. '+value.problems.map(x=>x.title+': '+labels[x.state]).join('. ');lastAnnouncement=announcement;}
  }
  root.GatewayLaunchProgress={model,render};
})(globalThis);
