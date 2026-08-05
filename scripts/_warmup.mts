import { getWarmGrokBrowser } from '../src/llm/grok-warm-browser.js';
import { getGrokStatsigOracle } from '../src/llm/grok-statsig-oracle.js';
import WebSocket from 'ws';
process.env['SUDO_GROK_WARM_PROFILE']='/root/grok-warm-profile'; process.env['SUDO_GROK_WARM_DISPLAY']=':10'; process.env['SUDO_GROK_WARM_PORT']='9223';
const cdpUrl = await getWarmGrokBrowser().ensureRunning();
console.log('warm', cdpUrl);
const oracle = getGrokStatsigOracle({cdpUrl});
// robust warm-up: retry oracle.mint (exposes __grokMint) then direct-eval until token
const list = await (await fetch(cdpUrl+'/json/list')).json();
const tab = list.filter((t:any)=>t.type==='page').find((p:any)=>p.url.includes('grok.com'));
console.log('tab url', tab?.url);
const ws=new WebSocket(tab.webSocketDebuggerUrl,{maxPayload:64*1024*1024});
let id=0;const pend=new Map<number,any>();
const send=(m:string,p?:any)=>new Promise<any>((r,j)=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p||{}}));setTimeout(()=>j(new Error('t')),20000)});
ws.on('message',(d:any)=>{const m=JSON.parse(d);if(m.id&&pend.has(m.id)){pend.get(m.id)!(m.result);pend.delete(m.id)}});
await new Promise<void>((res,rej)=>{ws.on('open',()=>res());ws.on('error',rej);});
await send('Runtime.enable');
const present=async()=>(await send('Runtime.evaluate',{expression:"typeof globalThis.__grokMint",returnByValue:true})).result?.value;
const rs=async()=>(await send('Runtime.evaluate',{expression:"document.readyState+'|'+(document.querySelector('meta[name^=gr]')?1:0)",returnByValue:true})).result?.value;
for(let i=0;i<12;i++){
  console.log(`try ${i}: readyState=${await rs()} __grokMint=${await present()}`);
  try { const t=await oracle.mint('/rest/app-chat/conversations/new','POST'); console.log('  oracle.mint OK len',t.length); break; } catch(e){ /*wrapper bug*/ }
  const direct=(await send('Runtime.evaluate',{expression:"(globalThis.__grokMint&&globalThis.__grokMint('/rest/app-chat/conversations/new','POST'))||''",returnByValue:true,awaitPromise:true})).result?.value;
  if(direct){ console.log('  DIRECT mint OK len',direct.length); break; }
  await new Promise(r=>setTimeout(r,4000));
}
ws.close(); process.exit(0);
