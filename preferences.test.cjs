const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const vm=require('node:vm')
const source=fs.readFileSync(__dirname+'/plugin.js','utf8').replace(/^import .*$/gm,'').replace('export default {','const plugin = {')

function load(saved=new Map(),storageOverride){
  const writes=[],removed=[],contributions=[]
  const ctx={atom:v=>({get:()=>v,set:x=>{v=x}}),host:{},
    COMPOSER_AREAS:{underside:'composer.underside'},PALETTE_AREA:'palette',jsx:()=>null}
  vm.createContext(ctx)
  vm.runInContext(source+'\nthis.api={plugin,toggleLimitMode,cycleCtxMode,$limitMode,$ctxMode,$visible};',ctx)
  const storage=storageOverride || {
    get:(key,fallback)=>saved.has(key)?saved.get(key):fallback,
    set:(key,value)=>{writes.push([key,value]);saved.set(key,value)},
    remove:key=>{removed.push(key);saved.delete(key)}
  }
  const pluginCtx={storage,register:c=>contributions.push(c),onEvent:()=>{}}
  ctx.api.plugin.register(pluginCtx)
  return {api:ctx.api,pluginCtx,writes,removed,contributions,saved}
}

test('used/left choice survives a fresh plugin module and re-registration',()=>{
  const saved=new Map()
  const first=load(saved)
  assert.equal(first.api.$limitMode.get(),'used')
  assert.equal(first.writes.length,0)
  first.api.toggleLimitMode()
  assert.equal(first.api.$limitMode.get(),'left')
  assert.equal(saved.get('limitMode'),'left')
  const restarted=load(saved)
  assert.equal(restarted.api.$limitMode.get(),'left')
  assert.equal(restarted.writes.length,0)
  restarted.api.plugin.register(restarted.pluginCtx)
  assert.equal(restarted.api.$limitMode.get(),'left')
  restarted.api.toggleLimitMode()
  assert.equal(load(saved).api.$limitMode.get(),'used')
})

test('each context display mode survives a fresh module without changing the usage choice',()=>{
  const saved=new Map([['limitMode','left']])
  let current=load(saved)
  assert.equal(current.api.$ctxMode.get(),'both')
  for(const mode of ['bar','numbers','both']){
    current.api.cycleCtxMode()
    assert.equal(saved.get('contextMode'),mode)
    current=load(saved)
    assert.equal(current.api.$ctxMode.get(),mode)
    assert.equal(current.api.$limitMode.get(),'left')
    assert.equal(current.writes.length,0)
  }
})

test('invalid saved modes use defaults without rewriting or removing preferences',()=>{
  for(const invalid of [null,false,0,'',{},[],['left'],'LEFT','invalid']){
    const saved=new Map([['limitMode',invalid],['contextMode',invalid]])
    const x=load(saved)
    assert.equal(x.api.$limitMode.get(),'used')
    assert.equal(x.api.$ctxMode.get(),'both')
    assert.equal(x.writes.length,0)
    assert.equal(x.removed.length,0)
  }
})

test('old used/left preference is preserved while obsolete data alone is cleaned up',()=>{
  const saved=new Map([['limitMode','left'],['visible',false],['sessionAvg',42],['other','keep']])
  const x=load(saved)
  assert.equal(x.api.$limitMode.get(),'left')
  assert.equal(x.api.$visible.get(),true)
  assert.equal(x.removed.join(','),'visible,sessionAvg')
  assert.equal(saved.get('other'),'keep')
  assert.equal(x.writes.length,0)
})

test('only the two display choices are written and visibility remains session-only',()=>{
  const x=load()
  x.api.toggleLimitMode()
  x.api.cycleCtxMode()
  const toggle=x.contributions.find(c=>c.id==='toggle').data.run
  toggle()
  assert.equal(x.api.$visible.get(),false)
  assert.deepEqual(x.writes,[['limitMode','left'],['contextMode','bar']])
  assert.equal(load(x.saved).api.$visible.get(),true)
})

test('storage read failures do not prevent registration or changing display modes',()=>{
  const x=load(new Map(),{get:()=>{throw new Error('storage unavailable')},set:()=>{},remove:()=>{}})
  assert.equal(x.api.$limitMode.get(),'used')
  assert.equal(x.api.$ctxMode.get(),'both')
  x.api.toggleLimitMode()
  x.api.cycleCtxMode()
  assert.equal(x.api.$limitMode.get(),'left')
  assert.equal(x.api.$ctxMode.get(),'bar')
})

test('storage write failures leave current-session controls functional',()=>{
  const x=load(new Map(),{get:(k,f)=>f,set:()=>{throw new Error('storage full')},remove:()=>{}})
  assert.doesNotThrow(()=>{x.api.toggleLimitMode();x.api.cycleCtxMode()})
  assert.equal(x.api.$limitMode.get(),'left')
  assert.equal(x.api.$ctxMode.get(),'bar')
})

test('missing storage still permits registration and display controls',()=>{
  const x=load(new Map(),{})
  x.api.toggleLimitMode()
  x.api.cycleCtxMode()
  assert.equal(x.api.$limitMode.get(),'left')
  assert.equal(x.api.$ctxMode.get(),'bar')
})
