// Dependency-free lifecycle simulations of the real plugin hooks. This is not
// React or browser integration: the small runner models state/effect cleanup,
// pane attributes, query options and a deterministic frame/idle/timer queue.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const raw = fs.readFileSync(process.env.PLUGIN_SOURCE || __dirname + '/plugin.js', 'utf8')

function harness({ idle = true } = {}) {
  let clock = 0, seq = 0, cursor = 0, dirty = false, component, value
  const jobs = new Map(), slots = [], effects = [], observers = new Set(), queries = []
  const queue = (fn, delay, repeat = 0) => {
    const id = ++seq; jobs.set(id, { fn, at: clock + delay, repeat }); return id
  }
  const cancel = id => jobs.delete(id)
  const state = initial => {
    const i = cursor++
    if (!slots[i]) slots[i] = { value: typeof initial === 'function' ? initial() : initial }
    return [slots[i].value, next => {
      const v = typeof next === 'function' ? next(slots[i].value) : next
      if (!Object.is(v, slots[i].value)) { slots[i].value = v; dirty = true }
    }]
  }
  const effect = (fn, deps) => {
    const i = cursor++
    const old = slots[i]
    if (!old || deps.some((d, n) => !Object.is(d, old.deps[n]))) {
      effects.push(() => { old?.cleanup?.(); slots[i] = { deps, cleanup: fn() } })
    }
  }
  function render(fn = component) {
    component = fn
    let guard = 0
    do {
      dirty = false; cursor = 0; queries.length = 0; value = component()
      while (effects.length) effects.shift()()
      assert.ok(++guard < 30, 'render loop')
    } while (dirty)
    return value
  }
  function advance(ms) {
    const end = clock + ms
    for (let guard = 0; guard < 10000; guard++) {
      const due = [...jobs.entries()].filter(([, j]) => j.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!due) break
      const [id, j] = due; clock = j.at; jobs.delete(id)
      if (j.repeat) jobs.set(id, { ...j, at: clock + j.repeat })
      j.fn(); if (dirty && component) render()
    }
    clock = end
    return value
  }
  const atom = v => ({ get: () => v, set: next => { v = next } })
  const surface = { hidden: false, anchor: 'workspace', getAttribute: () => surface.anchor,
    closest: selector => selector === '[data-pane-hidden]' ? (surface.hidden ? surface : null) : null }
  const el = { parentElement: surface, closest: selector => selector === '[data-session-anchor]' ? surface : null }
  let surfaces = [surface], tiles = []
  const document = { body: {}, querySelectorAll: selector => selector === '[data-chat-surface]' ? surfaces : selector.startsWith('[data-session-anchor') ? tiles : [] }
  const invalidations = []
  const qc = { invalidateQueries: x => invalidations.push(x) }
  const context = {
    atom, useState: state, useEffect: effect, useLayoutEffect: effect, useValue: a => a.get(),
    useRef: initial => { const i = cursor++; if (!slots[i]) slots[i] = { current: initial === null ? el : initial }; return slots[i] },
    useQuery: opts => { queries.push(opts); return { data: undefined } }, useQueryClient: () => qc,
    host: { state: Object.fromEntries(Object.entries({ busy: false, model: 'default', focusedSessionId: 'A', focusedStoredSessionId: 'stored-A', focusedSessionProfile: 'default', focusedUsage: {} }).map(([k, v]) => [k, atom(v)])) }, document,
    getComputedStyle: () => ({ fontSize: '11' }),
    window: idle ? { requestIdleCallback: fn => queue(fn, 1), cancelIdleCallback: cancel } : {},
    requestAnimationFrame: fn => queue(fn, 16), cancelAnimationFrame: cancel,
    setTimeout: (fn, ms) => queue(fn, ms), clearTimeout: cancel,
    setInterval: (fn, ms) => queue(fn, ms, ms), clearInterval: cancel,
    MutationObserver: class {
      constructor(fn) { this.fn = fn }
      observe(root, options) { assert.equal(root, document.body); this.options = options; observers.add(this) }
      disconnect() { observers.delete(this) }
    },
    ResizeObserver: class { observe() {} disconnect() {} },
    COMPOSER_AREAS: { underside: 'underside' }, PALETTE_AREA: 'palette', jsx: () => null, jsxs: () => null,
    Date: { now: () => clock }
  }
  vm.createContext(context)
  const source = raw.replace(/^import .*$/gm, '').replace('export default {', 'const plugin = {')
  vm.runInContext(source + '\nthis.api={useFocusedSurface,useLoadStage,useSessionModel,useSessionStartedAt,useBackgroundProcesses,useSubagents,useAccountLimits,useNow,useLiveRate,useColumns,rememberModel,subagentEvent,StatusLine,$visible};', context)
  return { api: context.api, render, advance, surface, ref: { current: el }, queries, jobs, invalidations,
    split: () => { const tile = { getAttribute: () => 'session-tile:other', closest: () => null }; surfaces = [surface, tile]; tiles = [tile] },
    mutate: () => { for (const o of observers) o.fn([]) },
    unmount: () => { for (const slot of slots) slot?.cleanup?.(); component = undefined; dirty = false; slots.length = 0 },
    get observerCount() { return observers.size }
  }
}

test('line returns after a hidden tab becomes visible, even with the same chat id', () => {
  const h = harness(); h.surface.hidden = true
  const view = () => h.api.useFocusedSurface(h.ref, 'chat')
  assert.equal(h.render(view).focused, false)
  h.surface.hidden = false; h.mutate()
  assert.equal(h.advance(16).focused, true)
  h.surface.hidden = true; h.mutate()
  assert.equal(h.advance(16).focused, false)
  h.surface.hidden = false; h.mutate()
  assert.equal(h.advance(16).focused, true)
  h.unmount(); assert.equal(h.jobs.size, 0); assert.equal(h.observerCount, 0)
})

test('dialog aria-hidden/inert and the plugin hidden marker do not hide a visible tab', () => {
  const h = harness()
  const closest = h.surface.closest
  h.surface.closest = s => s === '[data-pane-hidden]' ? closest(s) : h.surface
  assert.equal(h.render(() => h.api.useFocusedSurface(h.ref, 'chat')).focused, true)
  h.mutate(); assert.equal(h.advance(16).focused, true)
  h.unmount()
})

test('split focus belongs only to the matching pane and reports multiple visible chats', () => {
  const h = harness(); h.split()
  let id = 'chat'
  const view = () => h.api.useFocusedSurface(h.ref, id)
  assert.equal(h.render(view).split, true)
  id = 'other'; assert.equal(h.render().focused, false)
  id = 'chat'; assert.equal(h.render().focused, true)
  h.unmount()
})

test('staged loading waits two frames and idle, then enables details 250ms apart', () => {
  const h = harness()
  assert.equal(h.render(() => h.api.useLoadStage('A', true)), 0)
  assert.equal(h.advance(32), 0)
  assert.equal(h.advance(1), 1)
  assert.equal(h.advance(249), 1)
  assert.equal(h.advance(1), 2)
  assert.equal(h.advance(250), 3)
  h.unmount(); assert.equal(h.jobs.size, 0)
})

test('rapid tab switch cannot reuse the previous chat readiness before effects reset', () => {
  const h = harness(); let key = 'A'; const renders = []
  h.render(() => { const stage = h.api.useLoadStage(key, true); renders.push([key, stage]); return stage })
  h.advance(600); assert.equal(renders.at(-1)[1], 3)
  key = 'B'; h.render()
  assert.equal(renders.find(x => x[0] === 'B')[1], 0)
  h.advance(16); key = 'C'; h.render(); h.advance(600)
  assert.equal(renders.some(x => x[0] === 'B' && x[1] > 0), false)
  assert.equal(renders.at(-1).join(':'), 'C:3')
  h.unmount(); assert.equal(h.jobs.size, 0)
})

test('off/on resets readiness and inactive hooks schedule no timers', () => {
  const h = harness(); let active = true
  h.render(() => h.api.useLoadStage('A', active)); h.advance(600)
  active = false; assert.equal(h.render(), 0); assert.equal(h.jobs.size, 0)
  active = true; assert.equal(h.render(), 0); assert.equal(h.advance(600), 3)
  h.unmount()
  h.render(() => { h.api.useNow(5000, false); h.api.useLiveRate('A', false); h.api.useColumns(h.ref, false) })
  assert.equal(h.jobs.size, 0); h.unmount()
})

test('unmount cancels first frame, second frame, idle callback and staged timers', () => {
  for (const elapsed of [0, 16, 32, 33, 283]) {
    const h = harness(); h.render(() => h.api.useLoadStage('A', true)); h.advance(elapsed)
    h.unmount(); assert.equal(h.jobs.size, 0, 'pending tasks at ' + elapsed)
    h.advance(5000); assert.equal(h.jobs.size, 0)
  }
})

test('idle fallback still waits and is cancelled on unmount', () => {
  const h = harness({ idle: false }); h.render(() => h.api.useLoadStage('A', true))
  assert.equal(h.advance(231), 0); assert.equal(h.advance(1), 1)
  h.unmount(); assert.equal(h.jobs.size, 0)
})

test('full line keeps all queries off while hidden/toggled off, then restores without a crash', () => {
  const h = harness(); h.surface.hidden = true
  h.render(h.api.StatusLine)
  assert.equal(h.queries.length, 5)
  assert.ok(h.queries.every(q => !q.enabled))
  h.surface.hidden = false; h.mutate(); h.advance(16)
  assert.ok(h.queries.every(q => !q.enabled))
  h.advance(33)
  assert.equal(h.queries.filter(q => q.enabled).map(q => q.queryKey[1]).join(','), 'session-status')
  h.advance(250)
  assert.equal(h.queries.filter(q => q.enabled).map(q => q.queryKey[1]).join(','), 'session-status,session-start')
  h.advance(250); assert.ok(h.queries.every(q => q.enabled))
  h.api.$visible.set(false); h.render(); assert.ok(h.queries.every(q => !q.enabled))
  h.api.$visible.set(true); h.render(); h.advance(600)
  assert.ok(h.queries.every(q => q.enabled))
  h.unmount(); assert.equal(h.jobs.size, 0); assert.equal(h.observerCount, 0)
})

test('session queries are disabled while hidden/off; jobs poll only every 30 seconds', () => {
  const h = harness()
  h.render(() => {
    h.api.useSessionModel('A', false); h.api.useSessionStartedAt('stored', 'profile', false)
    h.api.useBackgroundProcesses('A', false); h.api.useSubagents('A', 0, false)
  })
  assert.equal(h.queries.length, 4)
  assert.ok(h.queries.every(q => q.enabled === false))
  const jobs = h.queries.find(q => q.queryKey[1] === 'processes')
  assert.equal(jobs.refetchInterval, 30000)
  assert.ok(h.queries.every(q => q.refetchOnWindowFocus === false))
  h.unmount()
})

test('model events bypass status fallback and subagent events keep a stable query key', () => {
  const h = harness()
  h.api.rememberModel({ session_id: 'A', payload: { model: 'model-A', provider: 'p' } })
  assert.equal(h.render(() => h.api.useSessionModel('A', true)).model, 'model-A')
  assert.equal(h.queries[0].enabled, false); assert.equal(h.queries[0].staleTime, Infinity)
  h.unmount()
  h.render(() => h.api.useSubagents('A', 0, true))
  const key = h.queries[0].queryKey.join(':')
  h.api.subagentEvent('subagent.start', { session_id: 'B' }); h.render()
  assert.equal(h.invalidations.length, 0)
  h.api.subagentEvent('subagent.start', { session_id: 'A' }); h.render()
  assert.equal(h.invalidations.length, 1); assert.equal(h.queries[0].queryKey.join(':'), key)
  h.unmount()
})
