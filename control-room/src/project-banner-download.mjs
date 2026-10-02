// Fetch only a creator/community-approved raster URL. No credentials, redirects,
// proxy environment, private addresses or provider-generated URLs are accepted.
import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';

const fail = () => Object.assign(new Error('Project logo download unavailable'), {code:'logo_download_unavailable'});
const BASE58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE32='abcdefghijklmnopqrstuvwxyz234567';
// Deliberately narrow support: canonical CIDv0 dag-pb/sha2-256, or lowercase
// base32 CIDv1 dag-pb/raw + sha2-256. No IPNS, arbitrary multicodecs or gateways.
function supportedCid(value) {
  if(/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(value)) {
    let number=0n;
    for(const char of value)number=number*58n+BigInt(BASE58.indexOf(char));
    const hex=number.toString(16);
    if(hex.length!==68)return false;
    const bytes=Buffer.from(hex,'hex');
    return bytes.length===34&&bytes[0]===0x12&&bytes[1]===0x20;
  }
  if(!/^b[a-z2-7]{58}$/.test(value))return false;
  const bytes=[];let bits=0,number=0;
  for(const char of value.slice(1)){
    number=(number<<5)|BASE32.indexOf(char);bits+=5;
    if(bits>=8){bits-=8;bytes.push(number>>bits);number&=(1<<bits)-1;}
  }
  return number===0&&bytes.length===36&&bytes[0]===1&&
    [0x55,0x70].includes(bytes[1])&&bytes[2]===0x12&&bytes[3]===0x20;
}
function ipfsLogoUrl(value) {
  // Parse before URL normalization: do not lowercase CIDv0 or erase dot segments.
  const match=/^ipfs:\/\/([^/?#]+)(?:\/([^?#]*))?$/.exec(value);
  if(!match||!supportedCid(match[1]))throw fail();
  const path=match[2]||'';
  if(path&&path.split('/').some(segment=>
    !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(segment)))throw fail();
  // A fixed public HTTPS path gateway reuses ALL download/DNS/redirect controls.
  // Public gateway outages/rate limits or redirects fail closed. This is not a
  // local IPFS node or trustless verification of a file's full UnixFS DAG.
  return `https://ipfs.io/ipfs/${match[1]}${path?'/'+path:''}`;
}
export function publicLogoAddress(ip) {
  if(isIP(ip)!==4)return false;
  const [a,b,c]=ip.split('.').map(Number);
  return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||
    (a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0||b===88&&c===99))||
    (a===198&&(b===18||b===19||b===51&&c===100))||(a===203&&b===0&&c===113));
}
export function projectLogoUrl(value) {
  if(typeof value!=='string'||value.length>2048)throw fail();
  if(value.startsWith('ipfs://'))value=ipfsLogoUrl(value);
  let url;try{url=new URL(value);}catch{throw fail();}
  const host=url.hostname.toLowerCase().replace(/\.$/,'');
  if(url.protocol!=='https:'||url.port||url.username||url.password||url.hash||isIP(host)||
    !host.includes('.')||/(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host))throw fail();
  return url;
}
export async function downloadProjectLogo(value,{signal,lookupImpl=lookup,getImpl=https.get,timeoutMs=8000}={}) {
  const url=projectLogoUrl(value);
  const controller=new AbortController();
  const abort=()=>controller.abort();
  signal?.throwIfAborted();signal?.addEventListener('abort',abort,{once:true});
  let timer;
  try {
    const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fail());},timeoutMs);});
    return await Promise.race([deadline,(async()=>{
      const addresses=await lookupImpl(url.hostname,{all:true,family:4});
      controller.signal.throwIfAborted();
      if(!addresses.length||addresses.some(x=>!publicLogoAddress(x.address)))throw fail();
      return await new Promise((resolve,reject)=>{
        const req=getImpl(url,{signal:controller.signal,agent:false,
          headers:{Accept:'image/png,image/jpeg,image/webp','Accept-Encoding':'identity'},
          lookup:(_host,options,cb)=>options?.all?cb(null,[{address:addresses[0].address,family:4}]):cb(null,addresses[0].address,4)
        },async res=>{
          try {
            const type=String(res.headers['content-type']||'').split(';')[0].toLowerCase();
            if(res.statusCode!==200||!['image/png','image/jpeg','image/webp'].includes(type)||
              res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'||
              Number(res.headers['content-length']||0)>2_000_000){res.destroy();throw fail();}
            let length=0;const chunks=[];
            for await(const chunk of res){length+=chunk.length;if(length>2_000_000){res.destroy();throw fail();}chunks.push(Buffer.from(chunk));}
            controller.signal.throwIfAborted();
            if(!length)throw fail();
            resolve(Buffer.concat(chunks));
          }catch{res.destroy();reject(fail());}
        });
        req.on('error',()=>reject(fail()));
      });
    })()]);
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
