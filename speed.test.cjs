const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const vm=require('node:vm')
const raw=fs.readFileSync(__dirname+'/plugin.js','utf8')
const source=raw.replace(/^import .*$/gm,'').replace('export default {','const plugin = {')
function load(){
  const ctx={atom:v=>({get:()=>v,set:x=>{v=x}}),useQuery:()=>({data:{}}),useValue:a=>a.get(),host:{},setInterval,clearInterval,Date,
    COMPOSER_AREAS:{underside:'composer.underside'},PALETTE_AREA:'palette',jsx:()=>null,jsxs:()=>null}
  vm.createContext(ctx)
  vm.runInContext(source+'\nthis.api={recordDeltaAt,liveRate,lastBurst,bursts,subagentEvent,subagentView,$subagentDone,redactSecrets,plugin};',ctx)
  return ctx.api
}

test('nothing is saved: no storage writes anywhere, and old saved data is removed on load',()=>{
  assert.doesNotMatch(raw,/storage\.set\(/)
  assert.doesNotMatch(raw,/localStorage|sessionStorage|indexedDB|document\.cookie/)
  const api=load()
  const removed=[]
  const ctx={storage:{remove:k=>removed.push(k),get:()=>{throw new Error('must not read')},set:()=>{throw new Error('must not write')}},
    register:()=>{},onEvent:()=>{}}
  api.plugin.register(ctx)
  assert.equal(removed.join(','),'visible,limitMode,sessionAvg')
})
test('no network or code-loading of its own; only read-only Hermes requests',()=>{
  assert.doesNotMatch(raw,/\bfetch\(|XMLHttpRequest|WebSocket|EventSource|\beval\(|new Function|import\(|innerHTML|dangerouslySetInnerHTML/)
  const methods=[...raw.matchAll(/host\.request\('([^']+)'/g)].map(m=>m[1]).sort()
  assert.equal(methods.join(','),'model.options,process.list,session.list,session.status,subagent.list')
})
test('live rate uses 5 s; the last stretch survives after streaming stops',()=>{
  const api=load()
  const t0=1_000_000
  for(let i=0;i<=10;i++) api.recordDeltaAt('s',40,t0+i*300)   // 440 chars over 3 s
  assert.ok(api.liveRate('s',t0+3000)>0)
  assert.equal(api.liveRate('s',t0+3000+5001),null)
  const last=api.lastBurst('s',t0+20000)
  assert.equal(last.tokens,110);assert.equal(last.seconds,3);assert.equal(Math.round(last.rate),37)
  api.recordDeltaAt('s',8,t0+30000)                            // a new stretch after a >2 s gap
  assert.equal(api.lastBurst('s',t0+30000).tokens,2)
})
test('in-memory speed tracking is capped at 20 chats',()=>{
  const api=load()
  for(let i=0;i<50;i++) api.recordDeltaAt('chat'+i,10,1000+i)
  assert.equal(api.bursts.size,20)
  assert.equal(api.lastBurst('chat0',2000),null)
  assert.ok(api.lastBurst('chat49',2000))
})
test('subagents: running list comes from Hermes; finished runs held in memory with their speed',()=>{
  const api=load()
  const t0=5_000_000
  const running=[{subagent_id:'a',goal:'Read the docs',status:'running',started_at:t0/1000}]
  assert.equal(api.subagentView([],[],t0),null)
  assert.equal(api.subagentView(running,[],t0).running.length,1)
  api.subagentEvent('subagent.complete',{session_id:'p',payload:{subagent_id:'a',goal:'Read the docs',status:'completed',output_tokens:1200,duration_seconds:60}},t0)
  const done=api.$subagentDone.get().p
  assert.equal(done.length,1);assert.equal(done[0].out/done[0].seconds,20)
  assert.ok(api.subagentView([],done,t0+299000))
  assert.equal(api.subagentView([],done,t0+301000),null)      // gone 5 min after the last one
  for(let i=0;i<30;i++) api.subagentEvent('subagent.complete',{session_id:'c'+i,payload:{output_tokens:1,duration_seconds:1}},t0+i)
  assert.ok(Object.keys(api.$subagentDone.get()).length<=20)
})
test('secrets are hidden in displayed commands and goals',()=>{
  const {redactSecrets:r}=load()
  const cases=[
    ['OPENAI_API_KEY=sk-abcdefghijklmnop123 node server.js','OPENAI_API_KEY=•••• node server.js'],
    ['curl -H "Authorization: Bearer abc.def.ghijklmn" https://x','curl -H "Authorization: Bearer ••••" https://x'],
    ['mytool --token s3cr3tvalue --port 80','mytool --token •••• --port 80'],
    ['app --password="hunter2 two" run','app --password=•••• run'],
    ['git clone https://alex:ghp_abcdefghijklmnopqrstu@github.com/x','git clone https://alex:••••@github.com/x'],
    ['echo ghp_abcdefghijklmnopqrstuvwx done','echo •••• done'],
    ['use xoxb-1234567890-abcdef please','use •••• please'],
    ['AKIAABCDEFGHIJKLMNOP is aws','•••• is aws'],
    ['jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abcdefghijkl end','jwt •••• end'],
    ['npm run build && npm test','npm run build && npm test'],
    ['python -m http.server 8000','python -m http.server 8000']
  ]
  for(const [input,expected] of cases) assert.equal(r(input),expected,input)
})
