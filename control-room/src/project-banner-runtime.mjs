// The existing deterministic 600x200 template, now backed by a bounded automatic
// producer. No image-model charge, signing, payment or provider order creation.
import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,open,lstat,realpath,rename,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {projectBanner} from '../tools/project-banner.mjs';
import {logoBytes} from './project-profile.mjs';
import {downloadProjectLogo} from './project-banner-download.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const addressOk=x=>typeof x==='string'&&/^0x[a-fA-F0-9]{40}$/.test(x);
const nowIso=now=>new Date(now()).toISOString();
const safeFailure=code=>['missing_logo','unsupported_logo','logo_download_unavailable'].includes(code)?code:'banner_generation_failed';
export function bannerIdentity(t) {
  if(!addressOk(t.address)||typeof t.chain!=='string'||!/^[a-z0-9-]{1,32}$/.test(t.chain))return null;
  const profile=t.projectProfile||{},explicit=Object.hasOwn(profile,'logoPng');
  const value=explicit?profile.logoPng:t.launchIdentity?.logo;
  if(!value)return null;
  const kind=explicit?'approved_png':'launch_url';
  const name=profile.displayName||t.name;
  if(typeof name!=='string'||!name.trim()||name.length>100)return null;
  const key=`${t.chain}:${t.address.toLowerCase()}`;
  const sourceHash=sha(JSON.stringify({version:1,key,kind,value,name,profileVersion:profile.version||0}));
  return {key,sourceHash,name,value,kind,projectAddress:t.address.toLowerCase()};
}

export function createBannerStorage(directory) {
  const root=resolve(directory);let canonicalRoot=root;
  async function safeRoot(){
    await mkdir(root,{recursive:true,mode:0o700});
    const stat=await lstat(root);
    if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o022)!==0||
      typeof process.getuid==='function'&&stat.uid!==process.getuid())throw Error('Unsafe banner storage');
    // /tmp is a system symlink on macOS; pin the trusted root's canonical path
    // rather than rejecting every legitimate symlink in its ancestor chain.
    canonicalRoot=await realpath(root);
  }
  const filename=(key,digest)=>{
    if(!/^[a-f0-9]{64}$/.test(digest))throw Error('Invalid banner digest');
    return join(canonicalRoot,`${sha(key)}-${digest}.png`);
  };
  async function read(key,digest){
    await safeRoot();const fd=await open(filename(key,digest),constants.O_RDONLY|constants.O_NOFOLLOW);
    try{const stat=await fd.stat();if(!stat.isFile()||stat.size>2_000_000)throw Error('Invalid banner file');
      const bytes=await fd.readFile();if(sha(bytes)!==digest)throw Error('Banner integrity mismatch');return bytes;
    }finally{await fd.close();}
  }
  async function write(key,digest,bytes){
    if(!Buffer.isBuffer(bytes)||bytes.length>2_000_000||sha(bytes)!==digest)throw Error('Invalid banner bytes');
    await safeRoot();const target=filename(key,digest);
    async function existing(){
      let stat;try{stat=await lstat(target);}catch(e){if(e.code==='ENOENT')return false;throw e;}
      if(!stat.isFile()||stat.isSymbolicLink()||typeof process.getuid==='function'&&stat.uid!==process.getuid())throw Error('Unsafe banner file');
      return true;
    }
    if(await existing()){
      try{await read(key,digest);return;}catch{/* Regenerate this owned, generated cache entry atomically. */}
    }
    const temporary=join(canonicalRoot,`.banner-${randomUUID()}.tmp`);let published=false;
    try{
      const fd=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try{await fd.writeFile(bytes);await fd.sync();}finally{await fd.close();}
      // Never create the final filename until a complete image is durable. An
      // interrupted earlier version may have left a partial owned regular file.
      await existing();await rename(temporary,target);published=true;
      const dir=await open(canonicalRoot,constants.O_RDONLY);try{await dir.sync();}finally{await dir.close();}
    }finally{if(!published)await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
  }
  return {read,write};
}

export function publicBanner(t) {
  const identity=bannerIdentity(t),b=t.launchAssets?.banner;
  if(!identity)return {state:'missing_logo',projectAddress:String(t.address||'').toLowerCase(),width:600,height:200};
  if(!b||b.sourceHash!==identity.sourceHash)return {state:'pending',projectAddress:identity.projectAddress,width:600,height:200};
  const ready=b.state==='ready'&&b.width===600&&b.height===200&&b.projectAddress===identity.projectAddress&&/^[a-f0-9]{64}$/.test(b.sha256||'');
  return {state:ready?'ready':['generating','failed'].includes(b.state)?b.state:'pending',projectAddress:identity.projectAddress,
    width:600,height:200,updatedAt:b.updatedAt||null,reason:b.reason||null,
    ...(ready?{url:`/api/site/token/${identity.projectAddress}/project-banner?v=${b.sha256.slice(0,16)}`,bytes:b.bytes}: {})};
}

export function createProjectBannerPipeline({tokens,persist,storage,render=projectBanner,download=downloadProjectLogo,now=Date.now}={}) {
  if(typeof tokens!=='function'||typeof persist!=='function'||!storage?.read||!storage?.write)throw Error('Banner store required');
  const active=new Map(),retryAfter=new Map();let cursor=0;
  function save(t,banner){
    const before=t.launchAssets;
    t.launchAssets={...(before||{}),banner};
    try{const r=persist();if(r?.then)throw Error('Synchronous persistence required');}
    catch(e){if(before===undefined)delete t.launchAssets;else t.launchAssets=before;throw e;}
  }
  const intact=(t,id)=>tokens().includes(t)&&bannerIdentity(t)?.sourceHash===id.sourceHash;
  async function work(t,id){
    try{
      save(t,{version:1,state:'generating',sourceHash:id.sourceHash,projectAddress:id.projectAddress,width:600,height:200,updatedAt:nowIso(now)});
      const logo=id.kind==='approved_png'?logoBytes(id.value):await download(id.value);
      if(!intact(t,id))return;
      const result=await render({name:id.name,logo});
      if(!intact(t,id))return;
      if(result.width!==600||result.height!==200||!Buffer.isBuffer(result.png)||result.png.length>2_000_000||
        result.png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||result.png.length<24||
        result.png.readUInt32BE(16)!==600||result.png.readUInt32BE(20)!==200)throw Error('Invalid rendered banner');
      const digest=sha(result.png);await storage.write(id.key,digest,result.png);
      if(!intact(t,id))return;
      save(t,{version:1,state:'ready',sourceHash:id.sourceHash,projectAddress:id.projectAddress,width:600,height:200,
        sha256:digest,logoSha256:sha(logo),bytes:result.png.length,updatedAt:nowIso(now)});
      retryAfter.delete(id.key);
    }catch(e){
      retryAfter.set(id.key,now()+30_000);
      if(intact(t,id))try{save(t,{version:1,state:'failed',sourceHash:id.sourceHash,projectAddress:id.projectAddress,
        width:600,height:200,reason:safeFailure(e.code),updatedAt:nowIso(now)});}catch{ /* no ready state after failed persistence */ }
    }finally{active.delete(id.key);}
  }
  async function tick(){
    const list=tokens();if(!Array.isArray(list))throw Error('Project list required');
    const dispatched=[];
    for(let i=0;i<list.length&&active.size<5;i++){
      const t=list[(cursor+i)%list.length],id=bannerIdentity(t);
      if(!id||active.has(id.key)||retryAfter.get(id.key)>now()||publicBanner(t).state==='ready')continue;
      // Reserve synchronously before yielding so racing ticks never duplicate.
      active.set(id.key,true);dispatched.push(work(t,id));
    }
    if(list.length)cursor=(cursor+Math.max(1,dispatched.length))%list.length;
    await Promise.allSettled(dispatched);return {processed:dispatched.length,active:active.size};
  }
  async function read(t){
    const id=bannerIdentity(t),b=t.launchAssets?.banner;
    if(!id||publicBanner(t).state!=='ready')return null;
    try{const bytes=await storage.read(id.key,b.sha256);if(!intact(t,id))return null;return bytes;}
    catch{if(intact(t,id))save(t,{...b,state:'failed',reason:'banner_integrity_unavailable',updatedAt:nowIso(now)});return null;}
  }
  return {tick,read};
}
