(() => {
  'use strict';
  const $=id=>document.getElementById(id),select=$('propType');if(!select)return;
  let current=null,artwork=null,readId=0,loading=false;
  const option=document.createElement('option');option.value='TOKEN_LAUNCH';option.textContent='Launch a new token · connection pending';select.append(option);
  const fields=document.createElement('fieldset');fields.id='launchVoteFields';fields.className='project-fields full';fields.hidden=true;
  fields.innerHTML='<legend>Vote on a new token launch</legend><p class="hint full" role="status" id="launchVoteNotice"></p><label>Launch platform<select id="launchVotePlatform"><option value="pumpfun">Pump.fun · Solana</option><option value="pons">Pons · Robinhood</option></select></label><label>Token symbol<input id="launchVoteSymbol" maxlength="10" placeholder="ALI" autocomplete="off"></label><label class="full">Token name<input id="launchVoteName" maxlength="32" autocomplete="off"></label><label class="full">Token description<textarea id="launchVoteDescription" maxlength="500" rows="2"></textarea></label><label>Maximum launch spend (USD)<input id="launchVoteSpend" inputmode="decimal" placeholder="Set a limit"></label><label>Maximum network fees (USD)<input id="launchVoteFee" inputmode="decimal" placeholder="Set a limit"></label><label class="full">Exact logo to vote on<input id="launchVoteFile" type="file" accept="image/png,image/jpeg,image/webp"><span class="hint">Up to 2 MB. The converted image is included in the vote. Changing it requires a new vote.</span></label><div class="full"><img id="launchVotePreview" width="80" height="80" alt="Exact proposed token logo" hidden><p id="launchVoteImageNotice" class="hint" role="status"></p></div><p class="hint full">This approves one exact launch only, not future launches or automatic trading. Voting must close with more than 15% of supply voting yes and more yes than no. Approval expires one day after voting closes.</p>';
  $('propText').parentElement.after(fields);
  function mode(){
    fields.hidden=select.value!=='TOKEN_LAUNCH';if(fields.hidden)return;
    for(const id of ['projectFields','dexFields','walletFields'])if($(id))$(id).hidden=true;
    $('propText').parentElement.hidden=true;$('propText').required=false;
    $('launchVoteNotice').textContent=current?.communityActions?.proposals?'You can submit an exact launch proposal. Pump.fun and Pons execution are not connected. Approval will not deploy a token or spend funds.':'Draft only. Launch proposals are not enabled on this server yet.';
  }
  select.addEventListener('change',mode);
  $('launchVoteFile').addEventListener('change',async()=>{
    const id=++readId,file=$('launchVoteFile').files[0];artwork=null;loading=!!file;
    $('launchVotePreview').hidden=true;$('launchVotePreview').removeAttribute('src');$('launchVoteImageNotice').textContent=file?'Preparing the exact voting image…':'';
    if(!file)return;
    try{
      if(file.size>2000000||!['image/png','image/jpeg','image/webp'].includes(file.type))throw Error('Use a PNG, JPEG or WebP under 2 MB');
      const image=await createImageBitmap(file),canvas=document.createElement('canvas');
      const scale=Math.min(1,128/Math.max(image.width,image.height));canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));
      try{canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);}finally{image.close();}
      const png=canvas.toDataURL('image/png');if(png.length>131072)throw Error('Use a simpler logo');
      const bytes=Uint8Array.from(atob(png.split(',')[1]),c=>c.charCodeAt(0));
      const digest=await crypto.subtle.digest('SHA-256',bytes);
      if(id!==readId)return;
      artwork={artworkPng:png,artworkSha256:'sha256:'+Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('')};
      $('launchVotePreview').src=png;$('launchVotePreview').hidden=false;$('launchVoteImageNotice').textContent='Image ready for the vote. Nothing has been launched.';
    }catch(e){if(id===readId)$('launchVoteImageNotice').textContent=e.message;}
    finally{if(id===readId)loading=false;}
  });
  const micros=value=>{if(!/^(0|[1-9]\d{0,9})(\.\d{1,6})?$/.test(value))throw Error('Enter a positive USD limit without commas');const[a,b='']=value.split('.');const n=BigInt(a)*1000000n+BigInt(b.padEnd(6,'0'));if(n<=0n||n>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Invalid spending limit');return n.toString();};
  function payload(){
    const policy=current?.communityActions,hours=current?.settings?.votingHours;
    if(!policy?.proposals||!policy.wallet||!policy.chainId||!Number.isFinite(hours))throw Error('Launch proposals are not enabled on this server. Nothing was submitted.');
    if(loading||!artwork)throw Error('Choose a logo and wait for it to be ready');
    return {version:1,projectToken:current.address,fundingChainId:policy.chainId,wallet:policy.wallet,platform:$('launchVotePlatform').value,launchChain:$('launchVotePlatform').value==='pumpfun'?'solana':'robinhood',name:$('launchVoteName').value.trim(),symbol:$('launchVoteSymbol').value.trim(),description:$('launchVoteDescription').value.trim(),...artwork,maxSpendUsdMicros:micros($('launchVoteSpend').value.trim()),maxNetworkFeeUsdMicros:micros($('launchVoteFee').value.trim()),expiresAt:new Date(Date.now()+(hours+24)*3600000).toISOString()};
  }
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function ballot(p){
    if(p.type!=='TOKEN_LAUNCH')return '';const x=p.payload||{};
    const logo=typeof x.artworkPng==='string'&&x.artworkPng.length<=131072&&/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(x.artworkPng)?`<img src="${x.artworkPng}" width="64" height="64" alt="Exact logo proposed in this vote">`:'';
    const usd=v=>/^\d{1,16}$/.test(String(v))?'$'+(Number(v)/1e6).toFixed(6):'Unavailable';
    return `<div class="wallet-ballot">${logo}<p><strong>${esc(x.name)} · $${esc(x.symbol)}</strong></p><p>${esc(x.platform)} · ${esc(x.launchChain)}</p><p>${esc(x.description)}</p><p>Launch limit ${esc(usd(x.maxSpendUsdMicros))} + network fee limit ${esc(usd(x.maxNetworkFeeUsdMicros))}</p><p>Project treasury ${esc(x.wallet)} · funding chain ${esc(x.fundingChainId)}</p><p>Expires ${esc(x.expiresAt)}</p><p>Execution is not connected. Approval does not deploy a token.</p></div>`;
  }
  window.GatewayActions={payload,ballot,render(t){current=t;mode();}};
  document.addEventListener('DOMContentLoaded',()=>{
    const catalog=document.querySelector('.community-more-ideas .idea-catalog')||document.querySelector('.idea-catalog');if(!catalog)return;
    const examples=[
      ['Revenue ideas','Research a useful business model','TASK','Research useful products or services this community could offer. Identify users, demand, competitors, costs and risks. Deliver a written business model only. No spending, purchases, token launches or promised income.'],
      ['Build a product plan','Plan a community product','TASK','Write an implementable plan for a useful tool or service. Include features, technical requirements, acceptance tests, costs and proposed revenue model. Deliver specifications only. Deployment, subscriptions, paid APIs and payments each need separately scoped approval.'],
      ['Revenue report','Review project income and costs','TASK','Review available project records. Separate external customer revenue from deposits, token sales, treasury transfers and projected income. Report verified income, recorded costs and unknowns. Cite evidence. Do not invent profit or token price effects.'],
      ['Buy our token','Buy our project token','TREASURY_BUY',''],
      ['Burn tokens','Burn treasury tokens','TREASURY_BURN',''],
      ['Launch a token','Propose a new token launch','TOKEN_LAUNCH','']
    ];
    for(const[label,title,type,text]of examples){
      const button=document.createElement('button');button.type='button';const b=document.createElement('b');b.textContent=label;const span=document.createElement('span');span.textContent=['TOKEN_LAUNCH','TREASURY_BUY','TREASURY_BURN'].includes(type)?'Vote only · execution not connected':'Written deliverable · community vote required';button.append(b,span);
      button.addEventListener('click',()=>{select.value=type;$('propTitle').value=title;$('propText').value=text;select.dispatchEvent(new Event('change'));$('propTitle').focus();});catalog.append(button);
    }
    const link=document.createElement('a');link.href='/agent-playbook.html';link.target='_blank';link.rel='noopener';link.textContent='What can the community ask the agent to do? ↗';link.className='hint';catalog.parentElement.after(link);
  });
})();
