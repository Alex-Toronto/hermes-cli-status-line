const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const vm=require('node:vm')
const source=fs.readFileSync(__dirname+'/plugin.js','utf8').replace(/^import .*$/gm,'').replace('export default {','const plugin = {')
function load(){
  let options
  const ctx={atom:v=>({get:()=>v,set:x=>{v=x}}),useQuery:o=>{options=o;return {data:{providers:[]}}},host:{},setInterval,clearInterval}
  vm.createContext(ctx)
  vm.runInContext(source+'\nthis.api={useAccountLimits,pickWindows,limitParts,limitCard};',ctx)
  return {api:ctx.api,options:()=>options}
}
test('missing Claude and cold caches never trigger fast subscription polling',()=>{
  const x=load();x.api.useAccountLimits()
  const opt=x.options()
  for(const providers of [[],[{slug:'openai-codex',usage:{windows:[{label:'Weekly',used_percent:12}]}}]]){
    const interval=typeof opt.refetchInterval==='function'?opt.refetchInterval({state:{data:{providers}}}):opt.refetchInterval
    assert.equal(interval,120000)
  }
  assert.equal(opt.refetchOnWindowFocus,false)
  assert.equal(opt.refetchOnReconnect,false)
})
test('weekly-only usage is never classified or displayed as a five-hour limit',()=>{
  const {api}=load()
  const weekly={label:'Weekly',used_percent:37,resets_at:'2026-10-22T00:00:00Z'}
  const picked=api.pickWindows({usage:{windows:[weekly]}})
  assert.equal(picked.short,null)
  assert.equal(picked.week,weekly)
  const l={...picked,label:'GPT',name:'ChatGPT'}
  for(const compact of [false,true]){
    assert.equal(api.limitParts(l,compact).map(p=>p.text).join(''),'GPT wk 63% left')
  }
  const card=api.limitCard(l,Date.parse('2026-10-15T00:00:00Z'))
  assert.equal(card.rows.length,1)
  assert.equal(card.rows[0][0],'Weekly')
})
test('dual windows retain their reported labels and percentages',()=>{
  const {api}=load()
  const picked=api.pickWindows({usage:{windows:[{label:'5h',used_percent:9},{label:'Weekly',used_percent:42}]}})
  const l={...picked,label:'GPT',name:'ChatGPT'}
  assert.equal(api.limitParts(l,false).map(p=>p.text).join(''),'GPT 5h 91% left wk 58% left')
  assert.equal(api.limitParts(l,true).map(p=>p.text).join(''),'GPT 5h 91% left / wk 58% left')
  assert.equal(api.limitCard(l,Date.now()).rows.length,2)
})
test('unknown window labels are preserved rather than guessed',()=>{
  const {api}=load()
  const picked=api.pickWindows({usage:{windows:[{label:'Monthly',used_percent:11}]}})
  assert.equal(picked.short,null);assert.equal(picked.week,null)
  assert.equal(api.limitParts({...picked,label:'GPT'},false).map(p=>p.text).join(''),'GPT Monthly 89% left')
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
test('remaining allowance is clamped and low remaining keeps warning colours',()=>{
  const {api}=load()
  for(const [used,remaining,tone] of [[0,100,'good'],[90,10,'bad'],[100,0,'critical'],[110,0,'critical'],[-5,100,'good']]){
    const l={label:'GPT',name:'ChatGPT',short:null,week:{label:'Weekly',used_percent:used},extras:[]}
    const parts=api.limitParts(l,false)
    assert.equal(parts.map(p=>p.text).join(''),`GPT wk ${remaining}% left`)
    assert.equal(parts.at(-1).tone,tone)
    const card=api.limitCard(l,Date.now())
    assert.match(card.rows[0][1],new RegExp(`^${remaining}% remaining`))
    assert.match(card.note,/At 0%/)
  }
})
