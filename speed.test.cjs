const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const vm=require('node:vm')
const source=fs.readFileSync(__dirname+'/plugin.js','utf8').replace(/^import .*$/gm,'').replace('export default {','const plugin = {')
function load(){
  const ctx={atom:v=>({get:()=>v,set:x=>{v=x}}),useQuery:()=>({data:{}}),host:{},setInterval,clearInterval,Date}
  vm.createContext(ctx)
  vm.runInContext(source+'\nthis.api={sessionAvgStep,sessionAvgValue,recordDeltaAt,liveRate,lastBurst,subagentEvent,subagentView,$subagents};',ctx)
  return ctx.api
}
// One usage snapshot after `calls` calls whose last-≤10 window averages tps over lat s/call.
const u=(calls,tps,lat)=>({calls,avg_tps:tps,avg_latency_s:lat})

test('a short session is averaged exactly from Hermes\'s window',()=>{
  const api=load()
  let s=api.sessionAvgStep(undefined,u(4,50,2))
  const v=api.sessionAvgValue(s,u(4,50,2))
  assert.equal(Math.round(v.tps),50);assert.equal(v.calls,4);assert.equal(v.total,4)
})
test('blocks of 10 combine weighted by time, not a plain mean of averages',()=>{
  const api=load()
  let s
  // calls 1-10: 100 t/s, 1 s each (1000 tokens / 10 s)
  for(let c=1;c<=10;c++) s=api.sessionAvgStep(s,u(c,100,1))
  // calls 11-20: 20 t/s, 4 s each (800 tokens / 40 s)
  for(let c=11;c<=20;c++) s=api.sessionAvgStep(s,u(c,20,4))
  const v=api.sessionAvgValue(s,u(20,20,4))
  assert.equal(v.calls,20)
  assert.equal(v.tps.toFixed(1),(1800/50).toFixed(1))   // 36 t/s, not (100+20)/2 = 60
})
test('between blocks the overlapping live window is not double counted',()=>{
  const api=load()
  let s
  for(let c=1;c<=10;c++) s=api.sessionAvgStep(s,u(c,100,1))
  s=api.sessionAvgStep(s,u(13,10,10))
  const v=api.sessionAvgValue(s,u(13,10,10))
  assert.equal(v.calls,10);assert.equal(v.total,13);assert.equal(Math.round(v.tps),100)
})
test('first seen mid-session: earlier calls are reported as not covered',()=>{
  const api=load()
  let s=api.sessionAvgStep(undefined,u(57,30,2))
  let v=api.sessionAvgValue(s,u(57,30,2))
  assert.equal(v.calls,10);assert.equal(v.total,57)
  for(let c=58;c<=67;c++) s=api.sessionAvgStep(s,u(c,30,2))
  v=api.sessionAvgValue(s,u(67,30,2))
  assert.equal(v.calls,20);assert.equal(v.total,67)
})
test('skipped updates still produce disjoint blocks',()=>{
  const api=load()
  let s=api.sessionAvgStep(undefined,u(10,40,1))
  s=api.sessionAvgStep(s,u(25,40,1))           // 11-15 never seen
  const v=api.sessionAvgValue(s,u(25,40,1))
  assert.equal(v.calls,20);assert.equal(v.total,25)
})
test('a counter reset (session resumed) keeps earlier blocks',()=>{
  const api=load()
  let s
  for(let c=1;c<=10;c++) s=api.sessionAvgStep(s,u(c,50,1))
  s=api.sessionAvgStep(s,u(3,50,1))
  const v=api.sessionAvgValue(s,u(3,50,1))
  assert.equal(v.calls,13)
})
test('no timing data means no session average (segment hidden)',()=>{
  const api=load()
  assert.equal(api.sessionAvgStep(undefined,{calls:5}),undefined)
  assert.equal(api.sessionAvgValue(undefined,{calls:5}),null)
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
test('subagents: counted while running; speed from tokens over run time once done',()=>{
  const api=load()
  const t0=5_000_000
  api.subagentEvent('subagent.start',{session_id:'p',payload:{subagent_id:'a',goal:'Read the docs'}},t0)
  api.subagentEvent('subagent.start',{session_id:'p',payload:{subagent_id:'b',goal:'Write tests'}},t0)
  let v=api.subagentView('p',t0+1000)
  assert.equal(v.running.length,2)
  api.subagentEvent('subagent.complete',{session_id:'p',payload:{subagent_id:'a',status:'completed',output_tokens:1200,duration_seconds:60}},t0+60000)
  v=api.subagentView('p',t0+61000)
  assert.equal(v.running.length,1);assert.equal(v.done[0].goal,'Read the docs');assert.equal(v.done[0].out/v.done[0].seconds,20)
  api.subagentEvent('subagent.complete',{session_id:'p',payload:{subagent_id:'b',output_tokens:10,duration_seconds:5}},t0+70000)
  assert.ok(api.subagentView('p',t0+70000+299000))
  assert.equal(api.subagentView('p',t0+70000+301000),null)      // gone 5 min after the last one
  assert.equal(api.subagentView('other',t0),null)
})
