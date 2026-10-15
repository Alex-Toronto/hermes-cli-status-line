const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const vm=require('node:vm')
const source=fs.readFileSync(__dirname+'/plugin.js','utf8').replace(/^import .*$/gm,'').replace('export default {','const plugin = {')
function load(){
  let options
  const ctx={atom:v=>({get:()=>v,set:x=>{v=x}}),useQuery:o=>{options=o;return {data:{providers:[]}}},host:{},setInterval,clearInterval}
  vm.createContext(ctx)
  vm.runInContext(source+'\nthis.api={useAccountLimits,pickWindows,limitParts,limitCard,limitsRefetchInterval,limitsFromRows,toggleLimitMode,$limitMode};',ctx)
  return {api:ctx.api,options:()=>options}
}
const text=parts=>parts.map(p=>p.text).join('')
const weeklyRow={slug:'openai-codex',usage:{windows:[{label:'Weekly',used_percent:12}]}}

test('subscription polling is a fixed 2 minutes, never a fast loop, no focus/reconnect refetch',()=>{
  const x=load();x.api.useAccountLimits()
  const opt=x.options()
  const at=(providers,count)=>opt.refetchInterval({state:{data:{providers},dataUpdateCount:count}})
  assert.equal(at([weeklyRow],1),300000)
  for(const count of [2,3,10]) assert.equal(at([],count),300000)
  assert.equal(opt.refetchOnWindowFocus,false)
  assert.equal(opt.refetchOnReconnect,false)
  assert.equal(opt.staleTime,300000)
})
test('an empty first answer gets exactly one early re-check',()=>{
  const {api}=load()
  assert.equal(api.limitsRefetchInterval({state:{data:{providers:[]},dataUpdateCount:1}}),20000)
  assert.equal(api.limitsRefetchInterval({state:{data:{providers:[]},dataUpdateCount:2}}),300000)
})
test('weekly-only usage is never classified or displayed as a five-hour limit',()=>{
  const {api}=load()
  const weekly={label:'Weekly',used_percent:37,resets_at:'2026-10-22T00:00:00Z'}
  const picked=api.pickWindows({usage:{windows:[weekly]}})
  assert.equal(picked.short,null)
  assert.equal(picked.week,weekly)
  const l={...picked,label:'GPT',name:'ChatGPT'}
  for(const compact of [false,true]){
    assert.equal(text(api.limitParts(l,compact,'used')),'GPT wk 37%')
    assert.equal(text(api.limitParts(l,compact,'left')),'GPT wk 63% left')
  }
  const card=api.limitCard(l,Date.parse('2026-10-15T00:00:00Z'))
  assert.equal(card.rows.length,1)
  assert.equal(card.rows[0][0],'Weekly')
})
test('Codex "Session" and Claude "Current session" both read as 5h; used is the default view',()=>{
  const {api}=load()
  for(const [shortLabel,weekLabel] of [['Session','Weekly'],['Current session','Current week']]){
    const picked=api.pickWindows({usage:{windows:[{label:shortLabel,used_percent:9},{label:weekLabel,used_percent:42}]}})
    const l={...picked,label:'GPT',name:'ChatGPT'}
    assert.equal(text(api.limitParts(l,false)),'GPT 5h 9% wk 42%')
    assert.equal(text(api.limitParts(l,true)),'GPT 5h 9% / wk 42%')
    assert.equal(text(api.limitParts(l,false,'left')),'GPT 5h 91% left wk 58% left')
    assert.equal(api.limitCard(l,Date.now()).rows.length,2)
  }
})
test('model-only windows (Opus/Sonnet weeks) stay in the hover card, not on the line',()=>{
  const {api}=load()
  const picked=api.pickWindows({usage:{windows:[
    {label:'Current session',used_percent:10,scope:'account'},{label:'Current week',used_percent:60,scope:'account'},
    {label:'Opus week',used_percent:70,scope:'model'}]}})
  const l={...picked,label:'Claude',name:'Claude'}
  assert.equal(text(api.limitParts(l,false)),'Claude 5h 10% wk 60%')
  assert.equal(api.limitCard(l,Date.now()).rows.map(r=>r[0]).join('|'),'5-hour|Weekly|Opus week')
})
test('unknown window labels are preserved rather than guessed',()=>{
  const {api}=load()
  const picked=api.pickWindows({usage:{windows:[{label:'Monthly',used_percent:11}]}})
  assert.equal(picked.short,null);assert.equal(picked.week,null)
  assert.equal(text(api.limitParts({...picked,label:'GPT'},false)),'GPT mo 11%')
  assert.equal(text(api.limitParts({...picked,label:'GPT'},false,'left')),'GPT mo 89% left')
})
test('missing usage is omitted',()=>{
  const {api}=load()
  assert.equal(api.pickWindows(undefined),null)
  assert.equal(api.pickWindows({usage:{windows:[]}}),null)
})
test('weekly-only pooled account data uses the weekly slot',()=>{
  const {api}=load()
  const p=api.pickWindows({usage:{accounts:[{windows:[]},{windows:[{label:'7 days',used_percent:15}]}]}})
  assert.equal(p.short,null);assert.equal(p.week.label,'7 days')
})
test('used and left views clamp, and each has its own colour scheme',()=>{
  const {api}=load()
  const cases=[
    // used%, used tone, left text, left tone
    [0,'good','100% left','accent'],
    [55,'warn','45% left','warn'],
    [85,'bad','15% left','bad'],
    [100,'critical','0% left','critical'],
    [110,'critical','0% left','critical'],
    [-5,'good','100% left','accent']
  ]
  for(const [used,usedTone,leftText,leftTone] of cases){
    const l={label:'GPT',name:'ChatGPT',short:null,week:{label:'Weekly',used_percent:used},extras:[]}
    const u=api.limitParts(l,false,'used'), r=api.limitParts(l,false,'left')
    assert.equal(u.at(-1).tone,usedTone)
    assert.equal(r.at(-1).text,leftText)
    assert.equal(r.at(-1).tone,leftTone)
    assert.match(api.limitCard(l,Date.now()).rows[0][1],/^\d+% used · \d+% left · /)
  }
})
test('clicking flips used <-> left, and the hover says what a click does',()=>{
  const {api}=load()
  assert.equal(api.$limitMode.get(),'used')
  const l={label:'GPT',name:'ChatGPT',short:null,week:{label:'Weekly',used_percent:30},extras:[]}
  assert.match(api.limitCard(l,Date.now(),'used').note,/Click to show % left/)
  api.toggleLimitMode();assert.equal(api.$limitMode.get(),'left')
  assert.match(api.limitCard(l,Date.now(),'left').note,/Click to show % used/)
  api.toggleLimitMode();assert.equal(api.$limitMode.get(),'used')
})
test('every signed-in provider that reports limits is shown; Claude and GPT first',()=>{
  const {api}=load()
  const w=(label,p)=>({label,used_percent:p,scope:'account'})
  const rows=[
    {slug:'openrouter',name:'OpenRouter',usage:{windows:[w('API key quota',40)]}},
    {slug:'opencode-zen',name:'OpenCode Zen',usage:{windows:[w('Weekly',5)]}},
    {slug:'openai-codex',name:'OpenAI Codex',usage:{windows:[w('Session',10),w('Weekly',20)]}},
    {slug:'anthropic',name:'Anthropic',usage:{accounts:[{windows:[w('Current session',30),w('Current week',60)]}]}},
    {slug:'some-plugin',name:'Some Plugin Provider Name',usage:{windows:[w('Monthly',50)]}},
    {slug:'nousresearch',name:'Nous',usage:null},
    {slug:'gemini',name:'Gemini',authenticated:false,usage:{windows:[w('Weekly',1)]}}
  ]
  const l=api.limitsFromRows(rows)
  assert.equal(l.map(x=>x.label).join(','),'Claude,GPT,OpenRouter,Some Plugin Pr,Zen')
  const text=x=>api.limitParts(x,false).map(p=>p.text).join('')
  assert.equal(text(l[0]),'Claude 5h 30% wk 60%')
  assert.equal(text(l[2]),'OpenRouter quota 40%')
  assert.equal(text(l[3]),'Some Plugin Pr mo 50%')
})
test('no polling loop: over 24 h of any provider state, at most one check is faster than 5 minutes',()=>{
  const {api}=load()
  for(const providers of [[],[{slug:'anthropic',usage:null}],[{slug:'openrouter',usage:{windows:[{label:'API key quota',used_percent:1}]}}]]){
    let t=0,count=0,fast=0
    while(t<24*3600*1000){
      count++
      const iv=api.limitsRefetchInterval({state:{data:{providers},dataUpdateCount:count}})
      if(iv<300000) fast++
      assert.ok(iv>=20000)
      t+=iv
    }
    assert.ok(fast<=1,`fast checks: ${fast}`)
    assert.ok(count<=289,`checks per day: ${count}`)
  }
})
