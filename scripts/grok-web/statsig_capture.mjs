// statsig fingerprint capture/verification oracle (dev + maintenance tool — NOT run in CI).
//
// Drives throwaway grok.com/imagine tabs over a warm Chrome CDP endpoint (default
// ws://127.0.0.1:9223) and records, per load: the 48-byte seed, the exact Element.animate
// keyframes the minter builds (M(C[k])), the Animation.currentTime it samples at, the
// raw .r-gswh7 `<path d>`, the getComputedStyle pairs, and the SHA-256 message dHex.
// This is how the 4 spinner `d` tables and the deriveFingerprint fixtures in
// statsig_mint(.test).mjs were obtained and byte-verified (pure seed -> dHex, 24/24).
//
// Re-run this if the live gate starts returning 403 on an otherwise-correct token
// (grok reskinned the spinner -> the 4 R_GSWH7_PATHS in statsig_mint.mjs changed):
//   node scripts/grok-web/statsig_capture.mjs 18 /tmp/pathb.json
// then re-derive the 4 tables (group by seed[5]%4) and refresh R_GSWH7_PATHS.
// Requires a logged-in, Cloudflare-cleared warm grok browser on CDP 9223. Uses only
// throwaway tabs (/json/new + /json/close); never injects the production tab.
import WebSocket from 'ws';
import http from 'node:http';
import fs from 'node:fs';
const PORT=9223, N=parseInt(process.argv[2]||'6',10);
function httpJson(path){return new Promise((res,rej)=>{const req=http.request({host:'127.0.0.1',port:PORT,path,method:path.startsWith('/json/new')?'PUT':'GET'},r=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>{try{res(JSON.parse(b));}catch(e){res(b);}});});req.on('error',rej);req.end();});}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function withPage(tabId,fn){return new Promise((resolve,reject)=>{const ws=new WebSocket(`ws://127.0.0.1:${PORT}/devtools/page/${tabId}`,{perMessageDeflate:false,maxPayload:200*1024*1024});let id=0;const pend=new Map();const send=(m,p={})=>new Promise((res,rej)=>{const i=++id;pend.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p}));});ws.on('message',d=>{const m=JSON.parse(d);if(m.id&&pend.has(m.id)){const{res,rej}=pend.get(m.id);pend.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);}});ws.on('open',async()=>{try{const r=await fn(send);ws.close();resolve(r);}catch(e){ws.close();reject(e);}});ws.on('error',reject);});}

const inject=`(function(){
  window.__cap={seedBytes:null, anim:[], curT:[], dReads:[], gcs:[], msgs:[]};
  function readSeed(){ try{ var m=document.querySelector('meta[name^=gr]'); if(m){ window.__cap.seedBytes=[...atob(m.getAttribute('content'))].map(c=>c.charCodeAt(0)); } }catch(e){} }
  readSeed();
  // hook Element.animate -> capture the M(C[i]) keyframes object
  var oa=Element.prototype.animate;
  Element.prototype.animate=function(kf,opts){ try{ if(kf&&kf.color&&kf.transform&&window.__cap.anim.length<10){ window.__cap.anim.push({color:kf.color,transform:kf.transform,easing:kf.easing,opts:opts,tag:this.tagName}); if(!window.__cap.seedBytes)readSeed(); } }catch(e){} return oa.apply(this,arguments); };
  // hook Animation.currentTime setter
  try{ var d=Object.getOwnPropertyDescriptor(Animation.prototype,'currentTime');
    Object.defineProperty(Animation.prototype,'currentTime',{configurable:true,get(){return d.get.call(this);},set(v){ try{ if(window.__cap.curT.length<10) window.__cap.curT.push(v); }catch(e){} return d.set.call(this,v); }}); }catch(e){}
  // hook getAttribute('d') -> raw .r-gswh7 paths
  var rga=Element.prototype.getAttribute;
  Element.prototype.getAttribute=function(name){ var v=rga.apply(this,arguments); try{ if(name==='d'&&typeof v==='string'&&v[0]==='M'&&window.__cap.dReads.length<12){ window.__cap.dReads.push(v); } }catch(e){} return v; };
  var rg=window.getComputedStyle;
  window.getComputedStyle=function(el,ps){ var r=rg.apply(this,arguments); try{ if(el&&el.tagName==='DIV'&&!el.id&&!el.className&&window.__cap.gcs.length<60){ window.__cap.gcs.push({color:r.color,transform:r.transform}); } }catch(e){} return r; };
  var td=new TextDecoder(); var rd=SubtleCrypto.prototype.digest;
  SubtleCrypto.prototype.digest=function(alg,data){ try{ var s=td.decode(data.buffer?data.buffer:data); if(s.indexOf('obfiowerehiring')>=0&&window.__cap.msgs.length<5){ window.__cap.msgs.push(s); } }catch(e){} return rd.apply(this,arguments); };
})();`;

function computeDhex(c,t){const s=String(c||'')+String(t||'');return [...s.matchAll(/([\d.-]+)/g)].map(m=>Number(Number(m[0]).toFixed(2)).toString(16)).join('').replace(/[.-]/g,'');}
function dhexIn(m){var i=m.indexOf('obfiowerehiring');return i<0?null:m.slice(i+15);}
function ang(t){ if(!t||t==='none'||t==='matrix(1, 0, 0, 1, 0, 0)')return 0; var m=t.match(/matrix\(([^)]+)\)/); if(!m)return null; var p=m[1].split(',').map(parseFloat); return +(Math.atan2(p[1],p[0])*180/Math.PI).toFixed(4);}

async function oneLoad(){
  const t=await httpJson('/json/new?'+encodeURIComponent('about:blank'));
  const cap=await withPage(t.id,async(send)=>{
    await send('Page.enable');await send('Runtime.enable');
    await send('Page.addScriptToEvaluateOnNewDocument',{source:inject});
    await send('Page.navigate',{url:'https://grok.com/imagine'});
    await sleep(14000);
    const r=await send('Runtime.evaluate',{expression:'JSON.stringify(window.__cap||{})',returnByValue:true});
    return JSON.parse(r.result.value||'{}');
  });
  await httpJson('/json/close/'+t.id);
  const td=(cap.msgs&&cap.msgs[0])?dhexIn(cap.msgs[0]):null;
  let fp=null; for(const g of (cap.gcs||[])){ if(computeDhex(g.color,g.transform)===td){ fp={color:g.color,transform:g.transform,angle:ang(g.transform)};break; } }
  const sb=cap.seedBytes;
  // find the fingerprint animation (the one whose color[0] hex matches, if any)
  return { seedBytes:sb, bucket:sb?sb[5]%4:null, i:sb?sb[43]%16:null, S:sb?(sb[11]%16)*(sb[12]%16)*(sb[13]%16):null,
           anim:cap.anim, curT:cap.curT, obs:fp, targetDhex:td, dReads:cap.dReads };
}
(async()=>{const out=[];for(let k=0;k<N;k++){try{out.push(await oneLoad());}catch(e){out.push({error:String(e.message||e)});}}fs.writeFileSync(process.argv[3]||'/tmp/pathb_hookdata.json',JSON.stringify(out));console.log('WROTE /tmp/pathb_hookdata.json  loads='+out.length);for(const o of out){console.log(JSON.stringify({bucket:o.bucket,i:o.i,S:o.S,nAnim:(o.anim||[]).length,curT:o.curT,obs:o.obs,nD:(o.dReads||[]).length}));}process.exit(0);})();
