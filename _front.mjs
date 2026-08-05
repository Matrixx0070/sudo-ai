const j = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const pg = j.find(t => t.type === 'page' && t.url.includes('web.telegram.org'));
const ws = new WebSocket(pg.webSocketDebuggerUrl);
let id=0; const P=new Map();
ws.addEventListener('message',e=>{const m=JSON.parse(e.data); if(m.id&&P.has(m.id)){P.get(m.id)(m.result);P.delete(m.id);}});
await new Promise(r=>ws.addEventListener('open',r));
const S=(m,p={})=>new Promise(res=>{const i=++id;P.set(i,res);ws.send(JSON.stringify({id:i,method:m,params:p}));});
const E=async x=>(await S('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true}))?.result?.value;
await S('Page.bringToFront');
// Wait for the chat LIST to hydrate, then click the Sudo-Ai row (the #hash
// deep-link renders the list but never opens the conversation).
let ok=false;
for(let i=0;i<25;i++){
  await new Promise(r=>setTimeout(r,3000));
  const n=await E(`document.querySelectorAll('.chatlist-chat').length`);
  if(n>0){ok=true;console.log(`list hydrated ~${(i+1)*3}s, ${n} chats`);break;}
}
if(!ok){console.log('LIST NEVER HYDRATED');process.exit(1);}
console.log('open:', await E(`(()=>{const r=[...document.querySelectorAll('.chatlist-chat')].find(x=>(x.innerText||'').includes('Sudo-Ai'));if(!r)return 'no-row';r.click();return 'clicked';})()`));
for(let i=0;i<12;i++){
  await new Promise(r=>setTimeout(r,2000));
  if(await E(`!!document.querySelector('.input-message-input[data-peer-id]')`)){console.log('chat open');break;}
}
console.log('focused:', await E(`(()=>{const el=document.querySelector('.input-message-input[data-peer-id]');if(!el)return 'no-input';el.focus();return document.activeElement===el?'yes':'no';})()`));
ws.close();
