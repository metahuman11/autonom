// Off-chain project identity. Only a finalized, intact vote may change it.
import { inflateSync } from 'node:zlib';
import { payloadHash } from './canonical.mjs';
import { requirePublicText, publicText } from './public-safety.mjs';
import { recoveredLaunchLogo } from './launch-logo-repairs.mjs';

export const PROFILE_TYPE = 'PROJECT_PROFILE_UPDATE';
export const PROFILE_FIELDS = Object.freeze({ displayName: 60, tagline: 120, description: 1000, audience: 240, logoBrief: 500, brandColor: 7 });
const fail = (message, status=400) => Object.assign(new Error(message), {status});
const object = x => x && typeof x === 'object' && !Array.isArray(x);
// EVM addresses are case-insensitive; Solana base58 mint identity is not.
const logoAddress = t => /^0x[0-9a-fA-F]{40}$/.test(t.address) ? t.address.toLowerCase() : t.address;
const crc32 = bytes => { let n=0xffffffff; for(const b of bytes){n^=b;for(let k=0;k<8;k++)n=(n>>>1)^((n&1)?0xedb88320:0);}return (n^0xffffffff)>>>0; };

export function logoBytes(value) {
  if(typeof value!=='string' || value.length>131072 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) throw fail('Logo must be a small PNG image');
  const encoded=value.slice(22), b=Buffer.from(encoded,'base64');
  if(b.toString('base64')!==encoded || b.length>98304 || b.length<45 || b.subarray(0,8).toString('hex')!=='89504e470d0a1a0a') throw fail('Invalid PNG logo');
  let offset=8, width=0, height=0, channels=0, ended=false, data=[];
  while(offset<b.length){
    if(offset+12>b.length)throw fail('Incomplete PNG logo');
    const len=b.readUInt32BE(offset), end=offset+12+len;
    if(end>b.length)throw fail('Incomplete PNG chunk');
    const kind=b.toString('ascii',offset+4,offset+8), chunk=b.subarray(offset+8,offset+8+len);
    if(crc32(b.subarray(offset+4,offset+8+len))!==b.readUInt32BE(offset+8+len))throw fail('Invalid PNG checksum');
    if(offset===8){
      if(kind!=='IHDR'||len!==13)throw fail('Invalid PNG header');
      width=chunk.readUInt32BE(0);height=chunk.readUInt32BE(4);
      if(!width||!height||width>256||height>256||chunk[8]!==8||![2,6].includes(chunk[9])||chunk[10]||chunk[11]||chunk[12])throw fail('Logo must be a non-interlaced RGB PNG up to 256 × 256');
      channels=chunk[9]===6?4:3;
    } else if(kind==='IDAT')data.push(chunk);
    else if(kind==='IEND'){if(len||end!==b.length)throw fail('Invalid PNG end');ended=true;}
    else if(!({sRGB:1,gAMA:4,pHYs:9,cHRM:32}[kind]===len))throw fail('Logo metadata or animation is not allowed');
    offset=end;
  }
  if(!ended||!data.length)throw fail('Incomplete PNG image');
  const stride=1+width*channels, expected=stride*height;
  let pixels;try{pixels=inflateSync(Buffer.concat(data),{maxOutputLength:expected});}catch{throw fail('Invalid or oversized PNG pixels');}
  if(pixels.length!==expected)throw fail('Invalid PNG pixel count');
  for(let y=0;y<height;y++)if(pixels[y*stride]>4)throw fail('Invalid PNG filter');
  return b;
}

export function validateProfilePayload(payload) {
  if(!object(payload)||Object.keys(payload).some(k=>!['baseVersion','changes'].includes(k))||!Number.isSafeInteger(payload.baseVersion)||payload.baseVersion<0||!object(payload.changes))throw fail('A profile version and exact changes are required');
  const entries=Object.entries(payload.changes);
  if(!entries.length||entries.length>7)throw fail('Choose at least one profile change');
  for(const [key,value] of entries){
    if(key==='logoPng'){if(value!==null)logoBytes(value);continue;}
    if(!Object.hasOwn(PROFILE_FIELDS,key)||typeof value!=='string'||value.length>PROFILE_FIELDS[key]||value!==value.trim())throw fail('Invalid project field: '+key);
    requirePublicText(value);
    if(/[<>]/.test(value))throw fail('Project fields must be plain text');
    if(key==='displayName'&&!value)throw fail('Project name cannot be empty');
    if(key==='brandColor'&&!/^#[a-fA-F0-9]{6}$/.test(value))throw fail('Choose a six-digit brand color');
  }
  return payload;
}

export function projectProfile(t) {
  const p=t.projectProfile || {};
  return { version:p.version||0, displayName:publicText(p.displayName??t.name).slice(0,60),
    tagline:p.tagline||'',description:p.description||'',audience:p.audience||'',logoBrief:p.logoBrief||'',brandColor:p.brandColor||'#52748a',
    logoUrl:(p.logoPng||recoveredLaunchLogo(t))?`/api/site/token/${logoAddress(t)}/project-logo?v=${p.version||0}`:null,
    updatedAt:p.updatedAt||null,proposalId:p.proposalId||null,
    history:(p.history||[]).map(x=>({...x})),
    identityScope:'offchain_project_only',imageGeneration:'not_connected',socialPublishing:'not_connected' };
}

export function profileContext(t) {
  const {history,logoUrl,imageGeneration,socialPublishing,...p}=projectProfile(t);
  return {...p,hasLogo:!!logoUrl,logoNote:'Logo image is not sent to this text model; logoBrief is descriptive reference only.'};
}

export function validateNewProfileProposal(t,payload) {
  validateProfilePayload(payload);
  if(payload.baseVersion!==projectProfile(t).version)throw fail('Project profile changed. Review the latest version before proposing.',409);
  if(t.proposals.filter(p=>p.type===PROFILE_TYPE&&p.status==='voting'&&!p.cancelledAt&&!p.revokedAt).length>=8)throw fail('There are already eight open profile votes',429);
  const bytes=t.proposals.filter(p=>p.type===PROFILE_TYPE).reduce((n,p)=>n+(p.payload?.changes?.logoPng?.length||0),0);
  if(bytes+(payload.changes.logoPng?.length||0)>1_048_576||(t.projectProfile?.history?.length||0)>=100)throw fail('Project history needs archival before another update',429);
}

export function applyApprovedProfile(t,p) {
  if(!t.proposals.includes(p)||p.tally?.passed!==true||p.type!==PROFILE_TYPE||p.status!=='approved'||p.cancelledAt||p.revokedAt||p.payloadHash!==payloadHash({type:p.type,payload:p.payload}))throw fail('Only the unchanged approved profile can be applied',403);
  if(p.result?.profileVersion&&t.projectProfile?.history?.some(h=>h.proposalId===p.id))return p.result;
  validateProfilePayload(p.payload);
  const current=projectProfile(t);
  if(current.version!==p.payload.baseVersion)throw fail('A newer profile was approved. Submit a new proposal against that version.',409);
  const at=new Date().toISOString(), changes=p.payload.changes, next={...current,...changes,version:current.version+1,updatedAt:at,proposalId:p.id};
  next.logoPng=Object.hasOwn(changes,'logoPng')?changes.logoPng:Object.hasOwn(t.projectProfile||{},'logoPng')?t.projectProfile.logoPng:recoveredLaunchLogo(t);
  next.history=[...(t.projectProfile?.history||[]),{version:next.version,proposalId:p.id,updatedAt:at,fields:Object.keys(changes),displayName:next.displayName,logoChanged:Object.hasOwn(changes,'logoPng')}];
  delete next.logoUrl;delete next.identityScope;delete next.imageGeneration;delete next.socialPublishing;
  t.projectProfile=next;
  return {profileVersion:next.version,summary:'Community-approved project profile applied. On-chain token and AI permissions are unchanged.'};
}

export function publicProfileProposal(t,p) {
  if(p.type!==PROFILE_TYPE)return p;
  const changes={...p.payload.changes};
  if(Object.hasOwn(changes,'logoPng'))changes.logoPng=changes.logoPng?'Uploaded PNG':'Remove logo';
  return {...p,payload:{baseVersion:p.payload.baseVersion,changes},logoPreviewUrl:p.payload.changes.logoPng?`/api/site/token/${logoAddress(t)}/project-logo?proposalId=${encodeURIComponent(p.id)}`:null};
}

export function projectLogo(t,proposalId=null) {
  let value=proposalId?null:t.projectProfile?.logoPng||recoveredLaunchLogo(t);
  if(proposalId){
    const p=t.proposals.find(p=>p.id===proposalId&&p.type===PROFILE_TYPE);
    if(!p||p.payloadHash!==payloadHash({type:p.type,payload:p.payload}))return null;
    value=p.payload.changes.logoPng;
  }
  return value?logoBytes(value):null;
}
