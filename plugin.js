/**
 * CLI Status Line — the terminal's status bar, mirrored under the composer.
 *
 *   ☤ claude-opus-5-5 │ 138K/1M │ [█░░░░░░░░░] 13% │ ◎ 98.0% │ ↑ 72 t/s │ 21m │ Σ5.47M │ Claude 5h 8% wk 60% │ GPT 5h 35% wk 35%
 *
 * Same segments, order, formatting and colour thresholds as the CLI
 * (hermes_cli/cli_status_bar_mixin.py), plus subscription-limit segments for
 * Claude (anthropic OAuth) and ChatGPT (openai-codex). Every segment has its own
 * hover card with the exact numbers and what they mean. Width tiers follow the
 * CLI's column thresholds (<52 narrow, <76 medium, else wide), measured on the
 * strip itself. Follows the focused chat tile.
 *
 * Toggle: Ctrl+K → "Toggle CLI status line" (the desktop twin of /statusbar).
 */

import { atom, COMPOSER_AREAS, host, PALETTE_AREA, Tip, useQuery, useValue } from '@hermes/plugin-sdk'
import { useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'cli-status-line'

// ── formatters (ported 1:1 from the CLI) ───────────────────────────────────

// agent/usage_pricing.py::format_token_count_compact
function tokensCompact(value) {
  const n = Math.trunc(Number(value) || 0)
  const abs = Math.abs(n)
  if (abs < 1000) return String(n)
  const [div, sfx] = abs >= 1e9 ? [1e9, 'B'] : abs >= 1e6 ? [1e6, 'M'] : [1e3, 'K']
  const scaled = abs / div
  let text = scaled < 10 ? scaled.toFixed(2) : scaled < 100 ? scaled.toFixed(1) : scaled.toFixed(0)
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '')
  return `${n < 0 ? '-' : ''}${text}${sfx}`
}

// hermes_cli/banner.py::_format_context_length
function contextLength(tokens) {
  for (const [unit, div] of [['M', 1e6], ['K', 1e3]]) {
    if (tokens >= div) {
      const val = tokens / div
      const rounded = Math.round(val)
      return Math.abs(val - rounded) < 0.05 ? `${rounded}${unit}` : `${val.toFixed(1)}${unit}`
    }
  }
  return String(tokens)
}

// agent/usage_pricing.py::format_duration_compact
function durationCompact(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = seconds / 60
  if (minutes < 60) return `${Math.round(minutes)}m`
  const hours = minutes / 60
  if (hours < 24) {
    const rem = Math.trunc(minutes % 60)
    return rem ? `${Math.trunc(hours)}h ${rem}m` : `${Math.trunc(hours)}h`
  }
  return `${(hours / 24).toFixed(1)}d`
}

// _build_context_bar
function contextBar(pct) {
  const safe = Math.max(0, Math.min(100, pct || 0))
  const filled = Math.round((safe / 100) * 10)
  return `[${'█'.repeat(filled)}${'░'.repeat(Math.max(0, 10 - filled))}]`
}

// Model display: drop provider prefix, CLI truncation (>26 → 23 + "...").
function modelShort(model) {
  let m = String(model || 'Hermes')
  if (m.includes('/')) m = m.split('/').pop()
  if (m.includes(':') && !m.startsWith('custom')) m = m.split(':').pop()
  m = m.replace(/\.gguf$/, '')
  return m.length > 26 ? `${m.slice(0, 23)}...` : m
}

const n = v => Number(v || 0).toLocaleString()
const clock = d => d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })

function untilLabel(iso, now) {
  if (!iso) return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const secs = Math.max(0, (at.getTime() - now) / 1000)
  return `resets in ${durationCompact(secs)} (${clock(at)})`
}

// Theme-aware stand-ins for the skin's status_good / warn / bad / critical.
const TONE = {
  dim: 'var(--ui-text-tertiary)',
  strong: 'var(--ui-text-primary)',
  good: 'var(--ui-success)',
  accent: 'var(--ui-accent)',
  // No theme token for amber; a fixed amber blended toward the theme's text keeps it readable on light and dark.
  warn: 'color-mix(in srgb, #f59e0b 85%, var(--ui-text-primary))',
  bad: 'color-mix(in srgb, var(--dt-destructive) 80%, var(--ui-text-primary))',
  critical: 'var(--dt-destructive)'
}

// _status_bar_context_style: ≥95 critical, >80 bad, ≥50 warn, else good.
function pctTone(pct) {
  if (pct == null) return 'dim'
  if (pct >= 95) return 'critical'
  if (pct > 80) return 'bad'
  if (pct >= 50) return 'warn'
  return 'good'
}

function cacheTone(pct) {
  if (pct >= 70) return 'good'
  if (pct >= 30) return 'warn'
  return 'bad'
}

function compressionTone(count) {
  if (count >= 4) return 'bad'
  if (count >= 2) return 'warn'
  return 'strong'
}

const part = (tone, text, bold = false) => ({ tone, text, bold })

// ── state ──────────────────────────────────────────────────────────────────

const $visible = atom(true)
// Bumped by session.info events (model switches) so the per-chat model refetches.
const $infoTick = atom(0)

// Live output rate. Streamed text (answer + visible reasoning) arrives as
// message.delta / reasoning.delta events; tokens are estimated at 4 chars each
// (the same rough ratio Hermes uses), over a sliding window. A "stretch" is a
// run of deltas with no gap over BURST_GAP_MS; the last finished stretch's rate
// is shown (dimmed) once streaming stops.
const LIVE_WINDOW_MS = 5000
const BURST_GAP_MS = 2000
const liveSamples = new Map() // runtime session id → [{ t, chars }]
const bursts = new Map() // runtime session id → { start, end, chars }

function recordDeltaAt(sid, chars, now) {
  const list = liveSamples.get(sid) || []
  list.push({ t: now, chars })
  while (list.length && now - list[0].t > LIVE_WINDOW_MS) list.shift()
  liveSamples.set(sid, list)
  const b = bursts.get(sid)
  if (b && now - b.end <= BURST_GAP_MS) {
    b.end = now
    b.chars += chars
  } else {
    bursts.set(sid, { start: now, end: now, chars })
  }
}

function recordDelta(event) {
  const sid = event?.session_id
  const text = event?.payload?.text
  if (!sid || typeof text !== 'string' || !text) return
  recordDeltaAt(sid, text.length, Date.now())
}

// null = nothing streamed in the window (idle / waiting on a tool or the model).
function liveRate(sid, now) {
  const list = (sid && liveSamples.get(sid)) || []
  const recent = list.filter(s => now - s.t <= LIVE_WINDOW_MS)
  if (!recent.length) return null
  const chars = recent.reduce((a, s) => a + s.chars, 0)
  const span = Math.max(1000, now - recent[0].t)
  return chars / 4 / (span / 1000)
}

// The most recent stretch of streamed text: rate, size, age. Null if none.
function lastBurst(sid, now) {
  const b = sid && bursts.get(sid)
  if (!b) return null
  const span = Math.max(1000, b.end - b.start)
  return { rate: b.chars / 4 / (span / 1000), tokens: Math.round(b.chars / 4), seconds: span / 1000, ago: (now - b.end) / 1000 }
}

function useLiveRate(sid) {
  const busy = useValue(host.state.busy)
  const [state, setState] = useState({ rate: null, last: null })
  useEffect(() => {
    const tick = () => {
      const now = Date.now()
      setState({ rate: liveRate(sid, now), last: lastBurst(sid, now) })
    }
    tick()
    const t = setInterval(tick, busy ? 500 : 5000)
    return () => clearInterval(t)
  }, [sid, busy])
  return { ...state, busy }
}

// ── session average speed ──────────────────────────────────────────────────
// Hermes only exposes avg_tps / avg_latency_s over its last ≤10 model calls
// (agent._api_latency_history, deque maxlen 10). Every time 10 NEW calls have
// passed, that window holds only calls not yet counted, so it is saved as a
// closed block; the session average combines the closed blocks (plus the live
// window while it does not overlap them). Blocks persist per stored session.

function windowOf(u) {
  const calls = Number(u?.calls || 0)
  const tps = Number(u?.avg_tps)
  const lat = Number(u?.avg_latency_s)
  if (!calls || !(tps > 0) || !(lat > 0)) return null
  const n = Math.min(calls, 10)
  const seconds = lat * n
  return { calls, n, start: calls - n + 1, seconds, out: tps * seconds }
}

// state: { blocks: [{ n, out, seconds }], closedEnd, base } ; base offsets a counter reset.
function sessionAvgStep(state, u) {
  const w = windowOf(u)
  if (!w) return state
  let s = state ? { ...state, blocks: [...state.blocks] } : null
  if (!s) {
    // First sighting: earlier calls (before this window) are unknown.
    s = { blocks: [], closedEnd: w.start - 1, base: 0 }
  } else if (w.calls < s.closedEnd) {
    // Counter went backwards (agent rebuilt on resume): start a new segment.
    s.closedEnd = w.start - 1
  }
  if (w.calls - s.closedEnd >= 10) {
    s.blocks.push({ n: w.n, out: w.out, seconds: w.seconds })
    s.closedEnd = w.calls
    if (s.blocks.length > 500) s.blocks.splice(0, s.blocks.length - 500)
  }
  return s
}

function sessionAvgValue(state, u) {
  const w = windowOf(u)
  let out = 0, seconds = 0, calls = 0
  for (const b of state?.blocks || []) { out += b.out; seconds += b.seconds; calls += b.n }
  // The live window counts too while it covers only calls not in a block.
  if (w && state && w.start > state.closedEnd && w.calls > state.closedEnd) {
    out += w.out; seconds += w.seconds; calls += w.n
  }
  if (!(seconds > 0)) return null
  return { tps: out / seconds, calls, total: w ? w.calls : calls, seconds }
}

const $sessionAvg = atom({}) // stored session id → state
let saveSessionAvg = () => {}

function useSessionAvg(storedId, usage) {
  const all = useValue($sessionAvg)
  useEffect(() => {
    if (!storedId || !usage) return
    const cur = $sessionAvg.get()
    const next = sessionAvgStep(cur[storedId], usage)
    if (next !== cur[storedId]) {
      const map = { ...cur, [storedId]: { ...next, t: Date.now() } }
      const ids = Object.keys(map)
      if (ids.length > 50) {
        ids.sort((a, b) => (map[a].t || 0) - (map[b].t || 0)).slice(0, ids.length - 50).forEach(id => delete map[id])
      }
      $sessionAvg.set(map)
      saveSessionAvg(map)
    }
  }, [storedId, usage])
  return storedId ? sessionAvgValue(all[storedId], usage) : null
}

// ── subagents ──────────────────────────────────────────────────────────────
// subagent.start / subagent.complete arrive on the PARENT chat's session id.
// Hermes reports a subagent's tokens only when it finishes (output_tokens,
// duration_seconds = whole run incl. tool time), and does not relay its text.
const SUBAGENT_STALE_MS = 3600_000
const SUBAGENT_LINGER_MS = 300_000
const $subagents = atom({}) // parent sid → { running: { key: {...} }, done: [...] }

function subagentKey(p) {
  return String(p.subagent_id || p.child_session_id || `${p.delegation_id || ''}#${p.task_index ?? ''}`)
}

function subagentEvent(type, event, now = Date.now()) {
  const sid = event?.session_id
  const p = event?.payload || {}
  if (!sid) return
  const all = { ...$subagents.get() }
  const cur = all[sid] || { running: {}, done: [] }
  const entry = { running: { ...cur.running }, done: [...cur.done] }
  const key = subagentKey(p)
  if (type === 'subagent.start') {
    entry.running[key] = { goal: String(p.goal || p.text || ''), model: String(p.model || ''), started: now }
  } else if (type === 'subagent.complete') {
    const r = entry.running[key]
    delete entry.running[key]
    entry.done.unshift({
      goal: String(p.goal || r?.goal || p.summary || ''),
      model: String(p.model || r?.model || ''),
      status: String(p.status || ''),
      out: Number(p.output_tokens || 0),
      seconds: Number(p.duration_seconds || (r ? (now - r.started) / 1000 : 0)),
      calls: Number(p.api_calls || 0),
      ended: now
    })
    entry.done = entry.done.slice(0, 5)
  } else {
    return
  }
  all[sid] = entry
  $subagents.set(all)
}

function subagentView(sid, now) {
  const e = sid && $subagents.get()[sid]
  if (!e) return null
  const running = Object.values(e.running).filter(r => now - r.started < SUBAGENT_STALE_MS)
  const recent = e.done.filter(d => now - d.ended < SUBAGENT_LINGER_MS)
  if (!running.length && !recent.length) return null
  return { running, done: e.done }
}

// The focused chat's real model/provider. host.state.model is only the app-wide
// default, so ask the gateway for this session's status (same "Model: x (provider)"
// line /status prints).
function useSessionModel(runtimeId) {
  const tick = useValue($infoTick)
  const { data } = useQuery({
    queryKey: [ID, 'session-status', runtimeId, tick],
    queryFn: () => host.request('session.status', { session_id: runtimeId }),
    enabled: Boolean(runtimeId),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 1
  })
  const m = /^Model:\s*(.+?)\s*\(([^()]*)\)\s*$/m.exec(String(data?.output || ''))
  if (!m || /unknown/i.test(m[1])) return { model: '', provider: '' }
  return { model: m[1], provider: /unknown/i.test(m[2]) ? '' : m[2] }
}

function useSessionStartedAt(storedId) {
  const { data } = useQuery({
    queryKey: [ID, 'session-list'],
    queryFn: () => host.request('session.list', { limit: 100 }),
    staleTime: 60_000,
    refetchInterval: 60_000,
    enabled: Boolean(storedId)
  })
  const row = (data?.sessions ?? []).find(
    s => s.id === storedId || s.resolved_id === storedId || s._lineage_root_id === storedId
  )
  const started = Number(row?.started_at || 0)
  return started > 1e12 ? started / 1000 : started
}

// Subscription windows. model.options attaches cached usage per provider row
// (agent/account_usage_cache) and kicks a background refresh, so polling it
// never blocks on the usage APIs; the numbers trail by at most one poll.
const LIMIT_PROVIDERS = [
  { slug: 'anthropic', label: 'Claude' },
  { slug: 'openai-codex', label: 'GPT' }
]

function pickWindows(row) {
  const usage = row?.usage
  if (!usage) return null
  let windows = usage.windows
  if (!windows && Array.isArray(usage.accounts)) {
    const acct = usage.accounts.find(a => Array.isArray(a.windows) && a.windows.length)
    windows = acct?.windows
  }
  if (!Array.isArray(windows) || !windows.length) return null
  const acctScoped = windows.filter(w => !w.scope || w.scope === 'account')
  const short =
    acctScoped.find(w => /session|5\s*h|five|hour/i.test(w.label)) || null
  const week = acctScoped.find(w => w !== short && /week|7\s*d|seven/i.test(w.label)) || null
  const extras = windows.filter(w => w !== short && w !== week)
  return { short, week, extras }
}

function useAccountLimits() {
  const { data } = useQuery({
    queryKey: [ID, 'model-options'],
    queryFn: () => host.request('model.options', {}),
    staleTime: 120_000,
    // Missing providers or cold usage caches must never create a fast loop:
    // a fixed 2-minute poll, plus ONE early re-check 20 s after an empty first
    // answer (the usage cache warms in the background after that first call).
    refetchInterval: limitsRefetchInterval,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1
  })
  const rows = data?.providers ?? []
  return LIMIT_PROVIDERS.map(p => {
    const row = rows.find(r => r.slug === p.slug)
    const picked = pickWindows(row)
    return picked ? { ...p, ...picked, name: row?.name || p.label } : null
  }).filter(Boolean)
}

function limitsRefetchInterval(query) {
  const state = query?.state ?? {}
  const rows = state.data?.providers ?? []
  const anyReported = LIMIT_PROVIDERS.some(p => pickWindows(rows.find(r => r.slug === p.slug)))
  return state.dataUpdateCount === 1 && !anyReported ? 20_000 : 120_000
}

const $limitMode = atom('used') // 'used' | 'left'
let saveLimitMode = () => {}
function toggleLimitMode() {
  const next = $limitMode.get() === 'left' ? 'used' : 'left'
  $limitMode.set(next)
  saveLimitMode(next)
}

// Background terminal processes owned by the focused chat (the same list the
// app's process stack shows). Local registry read, so a 15 s poll is cheap.
function useBackgroundProcesses(runtimeId, active) {
  const { data } = useQuery({
    queryKey: [ID, 'processes', runtimeId],
    queryFn: () => host.request('process.list', { session_id: runtimeId }),
    enabled: Boolean(runtimeId) && active,
    staleTime: 10_000,
    refetchInterval: 15_000,
    refetchOnWindowFocus: false,
    retry: false
  })
  return (data?.processes ?? []).filter(p => !p.status || p.status === 'running')
}

function useNow(intervalMs) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

// Available width in terminal columns (monospace cell ≈ 0.6em).
function useColumns(ref, active) {
  const [cols, setCols] = useState(200)
  useEffect(() => {
    const el = ref.current?.parentElement
    if (!el) return
    const measure = () => {
      const fontPx = parseFloat(getComputedStyle(ref.current || el).fontSize) || 11
      setCols(Math.floor(el.clientWidth / (fontPx * 0.6)))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref, active])
  return cols
}

// ── hover cards ────────────────────────────────────────────────────────────

function Card({ title, rows, note }) {
  return jsxs('div', {
    style: { display: 'grid', gap: 4, maxWidth: 320, fontSize: '0.75rem', lineHeight: 1.35 },
    children: [
      jsx('div', { style: { fontWeight: 600 }, children: title }),
      rows?.length
        ? jsx('div', {
            style: { display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 10, rowGap: 2 },
            children: rows.flatMap(([k, v], i) => [
              jsx('span', { style: { opacity: 0.7 }, children: k }, `k${i}`),
              jsx('span', { style: { fontVariantNumeric: 'tabular-nums' }, children: v }, `v${i}`)
            ])
          })
        : null,
      note ? jsx('div', { style: { opacity: 0.7 }, children: note }) : null
    ]
  })
}

function Segment({ parts, card, onClick }) {
  const inner = parts.map((p, j) =>
    jsx('span', { style: { color: TONE[p.tone], fontWeight: p.bold ? 600 : 400 }, children: p.text }, j)
  )
  const span = onClick
    ? jsx('span', {
        role: 'button',
        tabIndex: 0,
        onClick,
        onKeyDown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } },
        style: { cursor: 'pointer' },
        children: inner
      })
    : jsx('span', { style: { cursor: card ? 'help' : 'default' }, children: inner })
  return card ? jsx(Tip, { label: jsx(Card, card), children: span }) : span
}

// Subscription limits can be read as % used (default) or % left; a click on
// either provider flips both. Each view has its own colour scheme.
const clamp100 = v => Math.max(0, Math.min(100, v))

// % left: theme accent while plenty remains, amber below 50% left, red below 20%,
// bright red at 5% or less (mirrors the used scale's 50 / 80 / 95 thresholds).
function leftTone(left) {
  if (left == null) return 'dim'
  if (left <= 5) return 'critical'
  if (left < 20) return 'bad'
  if (left < 50) return 'warn'
  return 'accent'
}

// Windows that go ON the line: the 5-hour and weekly windows; if a provider
// reports neither, its account-wide windows under their own names. Model-only
// windows (Claude's Opus / Sonnet weeks) stay in the hover card.
function lineWindows(l) {
  const main = [l.short, l.week].filter(Boolean)
  if (main.length) return main
  return (l.extras || []).filter(w => !w.scope || w.scope === 'account')
}

function windowLabel(l, win) {
  if (win === l.short) return '5h'
  if (win === l.week) return 'wk'
  return String(win.label || 'limit')
}

function limitParts(l, compact, mode = 'used') {
  const out = [part('dim', `${l.label} `)]
  lineWindows(l).forEach((win, i) => {
    if (i) out.push(part('dim', compact ? ' / ' : ' '))
    const used = clamp100(Number(win.used_percent))
    const value = mode === 'left'
      ? part(leftTone(100 - used), `${Math.round(100 - used)}% left`, true)
      : part(pctTone(used), `${Math.round(used)}%`, true)
    out.push(part('dim', `${windowLabel(l, win)} `), value)
  })
  return out
}

function limitCard(l, now, mode = 'used') {
  const row = (name, win) => {
    if (!win) return null
    const used = clamp100(Number(win.used_percent))
    return [name, `${used.toFixed(0)}% used · ${(100 - used).toFixed(0)}% left · ${untilLabel(win.resets_at, now) || 'reset time unknown'}`]
  }
  return {
    title: `${l.name} subscription limits`,
    rows: [
      row('5-hour', l.short),
      row('Weekly', l.week),
      ...l.extras.map(e => row(e.label, e))
    ].filter(Boolean),
    note: `Your plan's rolling allowances. When one is fully used, requests are refused until it resets. Refreshed every ~2 min. Click to show ${mode === 'left' ? '% used' : '% left'}.`
  }
}

// ── the line ───────────────────────────────────────────────────────────────

function StatusLine() {
  const ref = useRef(null)
  const visible = useValue($visible)
  const defaultModel = useValue(host.state.model)
  const runtimeId = useValue(host.state.focusedSessionId)
  const live = useSessionModel(runtimeId)
  const liveTps = useLiveRate(runtimeId)
  const model = live.model || defaultModel
  const provider = live.provider
  const usage = useValue(host.state.focusedUsage)
  const storedId = useValue(host.state.focusedStoredSessionId)
  const startedAt = useSessionStartedAt(storedId)
  const limits = useAccountLimits()
  const limitMode = useValue($limitMode)
  const procs = useBackgroundProcesses(runtimeId, visible)
  const sessionAvg = useSessionAvg(storedId, usage)
  useValue($subagents)
  const now = useNow(5_000)
  const cols = useColumns(ref, visible)

  if (!visible) return null

  const narrow = cols < 52
  const wide = cols >= 76
  const sep = wide ? ' │ ' : ' · '

  const u = usage || {}
  const ctxMax = Number(u.context_max || 0)
  const ctxUsed = Number(u.context_used || 0)
  const pct = ctxMax ? Math.round(Number(u.context_percent ?? (ctxUsed / ctxMax) * 100)) : null
  const est = Boolean(u.context_estimated)
  const mark = est ? '~' : ''
  const elapsed = startedAt ? Math.max(0, now / 1000 - startedAt) : null
  const duration = elapsed != null ? durationCompact(elapsed) : ''

  const segs = []
  segs.push({
    parts: [part('dim', '☤ '), part('strong', modelShort(model), true)],
    card: {
      title: 'Model',
      rows: [['Model', model || '—'], provider ? ['Provider', provider] : null].filter(Boolean),
      note: 'The model answering in this chat. Change it from the model picker in the composer.'
    }
  })

  const durationSeg = duration
    ? {
        parts: [part('dim', duration)],
        card: {
          title: 'Session duration',
          rows: [['Started', clock(new Date(startedAt * 1000))], ['Elapsed', duration]],
          note: 'Time since this chat session began.'
        }
      }
    : null

  if (narrow) {
    if (durationSeg) segs.push(durationSeg)
  } else {
    if (wide) {
      segs.push({
        parts: [part('dim', ctxMax ? `${mark}${tokensCompact(ctxUsed)}/${contextLength(ctxMax)}` : 'ctx --')],
        card: {
          title: 'Context window',
          rows: ctxMax
            ? [['Used', `${n(ctxUsed)} tokens`], ['Window', `${n(ctxMax)} tokens`], ['Free', `${n(Math.max(0, ctxMax - ctxUsed))} tokens`],
               ['Source', est ? 'local estimate (~)' : 'provider-reported']]
            : [],
          note: 'How much of the model\'s working memory this conversation fills right now: rules, tools, skills and the chat so far.'
        }
      })
    }
    const tone = pctTone(pct)
    const pctLabel = pct != null ? `${mark}${pct}%` : '--'
    segs.push({
      parts: wide ? [part(tone, contextBar(pct)), part('dim', ' '), part(tone, pctLabel, true)] : [part(tone, pctLabel, true)],
      card: {
        title: 'Context fullness',
        rows: [['Full', pctLabel], ['Colour', 'green <50% · amber 50–80% · red >80% · bright red ≥95%']],
        note: 'When it gets high Hermes compresses older turns into a summary so the chat can keep going; very full contexts are slower and costlier.'
      }
    })
    if (typeof u.cache_hit_pct === 'number' && Number.isFinite(u.cache_hit_pct)) {
      segs.push({
        parts: [part(cacheTone(u.cache_hit_pct), `◎ ${u.cache_hit_pct.toFixed(wide ? 1 : 0)}%`, true)],
        card: {
          title: 'Prompt cache hit rate',
          rows: [['Hit rate', `${u.cache_hit_pct.toFixed(1)}%`]],
          note: 'Share of input the provider served from its cache instead of re-reading. Higher is faster and uses less of your limits. Resets on model switch or compression.'
        }
      })
    }
    if (wide && sessionAvg) {
      const missing = Math.max(0, sessionAvg.total - sessionAvg.calls)
      const last10 = typeof u.avg_tps === 'number' && u.avg_tps > 0 ? `${u.avg_tps.toFixed(1)} tokens/second` : '—'
      segs.push({
        parts: [part('dim', `↑ ${Math.round(sessionAvg.tps)} t/s`)],
        card: {
          title: 'Average output speed (session)',
          rows: [
            ['Session', `${sessionAvg.tps.toFixed(1)} tokens/second`],
            ['Covers', `${n(sessionAvg.calls)} of ${n(sessionAvg.total)} model calls`],
            ['Last 10 calls', last10]
          ],
          note: `Output tokens divided by the time the model spent answering, across this session. Hermes only keeps timing for its last 10 calls, so the plugin saves it in blocks of 10 and updates every 10 calls.${missing ? ` ${n(missing)} earlier calls happened before the plugin could record them and aren't included.` : ''}`
        }
      })
    }
    if (wide) {
      const r = liveTps.rate
      const last = liveTps.last
      let parts
      let rows
      if (r != null) {
        parts = [part('dim', '⚡ '), part('strong', `~${Math.round(r)}`, true), part('dim', ' t/s')]
        rows = [['Now', `~${r.toFixed(1)} tokens/second`], ['Window', 'last 5 seconds']]
      } else if (last) {
        parts = [part('dim', `⚡ ~${Math.round(last.rate)} t/s last`)]
        rows = [
          ['Last stretch', `~${last.rate.toFixed(1)} tokens/second`],
          ['Size', `~${n(last.tokens)} tokens over ${last.seconds.toFixed(1)} s`],
          ['Ended', `${durationCompact(last.ago)} ago`]
        ]
      } else {
        parts = [part('dim', '⚡ – t/s')]
        rows = [['Now', liveTps.busy ? 'not streaming text at this moment' : 'idle']]
      }
      segs.push({
        parts,
        card: {
          title: 'Output speed right now',
          rows,
          note: 'Rate of text streaming into this chat (answer plus visible reasoning), estimated at ~4 characters per token. When streaming stops, the last stretch stays shown, dimmed. Tool calls and reading files or images aren\'t streamed, so they don\'t move this number.'
        }
      })
    }
    if (u.compressions) {
      segs.push({
        parts: [part(compressionTone(u.compressions), `🗜️ ${u.compressions}`, true)],
        card: {
          title: 'Compressions',
          rows: [['Count', String(u.compressions)]],
          note: 'Times Hermes summarised older turns to free context this session. Details from early in the chat may be summarised rather than verbatim.'
        }
      })
    }
    if (procs.length) {
      segs.push({
        parts: [part('strong', `⚙ ${procs.length}`, true)],
        card: {
          title: `Background ${procs.length === 1 ? 'process' : 'processes'}`,
          rows: procs.slice(0, 6).map(p => [
            p.uptime_seconds != null ? durationCompact(Number(p.uptime_seconds)) : '·',
            String(p.command || p.session_id || '').replace(/\s+/g, ' ').slice(0, 60)
          ]),
          note: `Terminal commands this chat started in the background (servers, builds, watchers) that are still running${procs.length > 6 ? ` — showing 6 of ${procs.length}` : ''}. They use no AI tokens. Checked every 15 s.`
        }
      })
    }
    const subs = subagentView(runtimeId, now)
    if (subs) {
      const speed = d => (d.seconds > 0 && d.out > 0 ? `${(d.out / d.seconds).toFixed(1)} t/s` : '—')
      const short = s => (s || 'subagent').replace(/\s+/g, ' ').slice(0, 40)
      segs.push({
        parts: [part(subs.running.length ? 'strong' : 'dim', `⛓ ${subs.running.length}`, Boolean(subs.running.length))],
        card: {
          title: 'Subagents',
          rows: [
            ...subs.running.map(r => [`running ${durationCompact((now - r.started) / 1000)}`, short(r.goal)]),
            ...subs.done.map(d => [
              `${d.status === 'completed' || !d.status ? 'done' : d.status} · ${speed(d)}`,
              `${short(d.goal)} (${n(d.out)} tokens, ${durationCompact(d.seconds)})`
            ])
          ],
          note: 'Helpers this chat started. Hermes reports a subagent\'s tokens only when it finishes, so speeds appear afterwards: its output tokens divided by its whole run time, which includes time spent running tools. Shown while any run, and for 5 minutes after.'
        }
      })
    }
    if (durationSeg) segs.push(durationSeg)
    if (wide && u.total) {
      segs.push({
        parts: [part('dim', `Σ${tokensCompact(u.total)}`)],
        card: {
          title: 'Session tokens',
          rows: [['Input', n(u.input)], ['Output', n(u.output)], ['Total', n(u.total)], ['Model calls', n(u.calls)]],
          note: 'Everything sent to and received from the model in this session, summed across calls (cached input included).'
        }
      })
    }
  }

  if (!narrow) {
    for (const l of limits) {
      segs.push({ parts: limitParts(l, !wide, limitMode), card: limitCard(l, now, limitMode), onClick: toggleLimitMode })
    }
  }

  const children = []
  segs.forEach((s, i) => {
    if (i) children.push(jsx('span', { style: { color: TONE.dim }, children: sep }, `s${i}`))
    children.push(jsx(Segment, s, `g${i}`))
  })

  return jsx('div', {
    ref,
    className: 'flex w-full min-w-0 items-center overflow-hidden px-2 text-[0.6875rem] leading-5 whitespace-pre select-none',
    style: { fontFamily: 'var(--dt-font-mono, ui-monospace, monospace)' },
    children
  })
}

export default {
  id: ID,
  name: 'CLI Status Line',
  register(ctx) {
    $visible.set(ctx.storage.get('visible', true))
    $limitMode.set(ctx.storage.get('limitMode', 'used') === 'left' ? 'left' : 'used')
    saveLimitMode = mode => ctx.storage.set('limitMode', mode)
    const savedAvg = ctx.storage.get('sessionAvg', {})
    $sessionAvg.set(savedAvg && typeof savedAvg === 'object' ? savedAvg : {})
    saveSessionAvg = map => ctx.storage.set('sessionAvg', map)

    ctx.register({
      id: 'line',
      area: COMPOSER_AREAS.underside,
      order: 0,
      render: () => jsx(StatusLine, {})
    })

    ctx.onEvent('session.info', event => {
      if (event?.payload?.model) $infoTick.set($infoTick.get() + 1)
    })

    for (const type of ['message.delta', 'reasoning.delta']) ctx.onEvent(type, recordDelta)
    for (const type of ['subagent.start', 'subagent.complete']) ctx.onEvent(type, e => subagentEvent(type, e))

    ctx.register({
      id: 'toggle',
      area: PALETTE_AREA,
      data: {
        id: `${ID}.toggle`,
        label: 'Toggle CLI status line',
        keywords: ['statusbar', 'status bar', 'tokens', 'limits', 'context', 'usage', 'sb'],
        detail: () => ($visible.get() ? 'on' : 'off'),
        detailVariant: 'state',
        run: () => {
          const next = !$visible.get()
          $visible.set(next)
          ctx.storage.set('visible', next)
        }
      }
    })
  }
}
