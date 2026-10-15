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
const VERSION = '1.2.1'

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
  // Memory cap: only the most recently streaming chats are kept.
  if (bursts.size > MAX_TRACKED_CHATS) {
    const oldest = [...bursts.entries()].sort((a, b) => a[1].end - b[1].end)[0][0]
    bursts.delete(oldest)
    liveSamples.delete(oldest)
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

function useLiveRate(sid, active) {
  const busy = useValue(host.state.busy)
  const [state, setState] = useState({ rate: null, last: null })
  useEffect(() => {
    if (!active) return // hidden copies of the line do no work
    const tick = () => {
      const now = Date.now()
      setState({ rate: liveRate(sid, now), last: lastBurst(sid, now) })
    }
    tick()
    const t = setInterval(tick, busy ? 500 : 5000)
    return () => clearInterval(t)
  }, [sid, busy, active])
  return { ...state, busy }
}

// ── subagents ──────────────────────────────────────────────────────────────
// Running subagents come straight from Hermes (subagent.list, the chat's live
// children). Hermes reports a subagent's tokens only in its subagent.complete
// event (output_tokens; duration_seconds = whole run incl. tool time), so the
// last few finished runs are held in memory only — never saved — and forgotten
// when the app closes.
const SUBAGENT_LINGER_MS = 300_000
const MAX_TRACKED_CHATS = 20
const $subagentDone = atom({}) // parent sid → [{ goal, status, out, seconds, ended }] (≤5)
const $subagentTick = atom(0) // bumped by subagent events so the running list refetches at once

function subagentEvent(type, event, now = Date.now()) {
  const sid = event?.session_id
  if (!sid) return
  $subagentTick.set($subagentTick.get() + 1)
  if (type !== 'subagent.complete') return
  const p = event?.payload || {}
  const all = { ...$subagentDone.get() }
  all[sid] = [{
    goal: String(p.goal || p.summary || ''),
    status: String(p.status || ''),
    out: Number(p.output_tokens || 0),
    seconds: Number(p.duration_seconds || 0),
    ended: now
  }, ...(all[sid] || [])].slice(0, 5)
  // Memory cap: keep only the most recently active chats.
  const ids = Object.keys(all)
  if (ids.length > MAX_TRACKED_CHATS) {
    ids.sort((a, b) => all[a][0].ended - all[b][0].ended).slice(0, ids.length - MAX_TRACKED_CHATS).forEach(id => delete all[id])
  }
  $subagentDone.set(all)
}

function useSubagents(runtimeId, now) {
  const tick = useValue($subagentTick)
  const doneAll = useValue($subagentDone)
  const { data } = useQuery({
    queryKey: [ID, 'subagents', runtimeId, tick],
    queryFn: () => host.request('subagent.list', { session_id: runtimeId }),
    enabled: Boolean(runtimeId),
    staleTime: 15_000,
    // Poll only while something runs; start/complete events trigger a fresh read anyway.
    refetchInterval: q => ((q.state.data?.subagents ?? []).some(s => !s.status || s.status === 'running') ? 20_000 : false),
    refetchOnWindowFocus: false,
    retry: false
  })
  return subagentView(data?.subagents ?? [], (runtimeId && doneAll[runtimeId]) || [], now)
}

function subagentView(list, done, now) {
  const running = list.filter(s => !s.status || s.status === 'running')
  const recent = done.filter(d => now - d.ended < SUBAGENT_LINGER_MS)
  if (!running.length && !recent.length) return null
  return { running, done }
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
    // A model switch arrives as a session.info event (bumps tick → refetch);
    // the slow poll is only a safety net.
    staleTime: 300_000,
    refetchInterval: 300_000,
    refetchOnWindowFocus: false,
    retry: 1
  })
  const m = /^Model:\s*(.+?)\s*\(([^()]*)\)\s*$/m.exec(String(data?.output || ''))
  if (!m || /unknown/i.test(m[1])) return { model: '', provider: '' }
  return { model: m[1], provider: /unknown/i.test(m[2]) ? '' : m[2] }
}

// A chat's start time never changes: read once per chat. A brand-new chat may
// not be listed yet, so re-ask every 30 s — at most START_TIME_MAX_TRIES times,
// then give up (the duration item just stays hidden). include_hidden covers
// bot chats, which the normal session list leaves out.
const START_TIME_MAX_TRIES = 4

function startTimeRefetchInterval(state, found) {
  if (found) return false
  return Number(state?.dataUpdateCount || 0) < START_TIME_MAX_TRIES ? 30_000 : false
}

function useSessionStartedAt(storedId, profile) {
  const matches = s => s.id === storedId || s.resolved_id === storedId || s._lineage_root_id === storedId
  // Bot chats of other profiles live in that profile's store (opened read-only by Hermes).
  const params = { limit: 100, include_hidden: true, ...(profile ? { profile } : {}) }
  const { data } = useQuery({
    queryKey: [ID, 'session-start', storedId, profile || ''],
    queryFn: () => host.request('session.list', params),
    staleTime: Infinity,
    refetchInterval: q => startTimeRefetchInterval(q.state, (q.state.data?.sessions ?? []).some(matches)),
    refetchOnWindowFocus: false,
    retry: false,
    enabled: Boolean(storedId)
  })
  const row = (data?.sessions ?? []).find(matches)
  const started = Number(row?.started_at || 0)
  return { startedAt: started > 1e12 ? started / 1000 : started, title: cleanName(row?.title) }
}

// Account limits. model.options attaches cached usage windows to every signed-in
// provider row that can report them (Hermes's built-in fetchers — Anthropic
// OAuth, OpenAI Codex, OpenRouter key quota — plus any provider plugin with a
// usage hook), and asks Hermes for a background refresh that Hermes itself
// throttles per provider. Polling it never waits on a provider API.
// Every provider that reports windows is shown; these get short names.
const PROVIDER_LABELS = { anthropic: 'Claude', 'openai-codex': 'GPT', openrouter: 'OpenRouter', 'opencode-zen': 'Zen' }
const PROVIDER_ORDER = ['anthropic', 'openai-codex']
const LIMITS_POLL_MS = 300_000
const LIMITS_FIRST_RECHECK_MS = 20_000

function providerLabel(row) {
  const slug = String(row?.slug || '')
  return PROVIDER_LABELS[slug] || String(row?.name || slug || 'Provider').slice(0, 14)
}

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
    acctScoped.find(w => /session|5\s*h|five|hourly|\bhour/i.test(w.label)) || null
  const week = acctScoped.find(w => w !== short && /week|7\s*d|seven/i.test(w.label)) || null
  const extras = windows.filter(w => w !== short && w !== week)
  return { short, week, extras }
}

function useAccountLimits() {
  const { data } = useQuery({
    queryKey: [ID, 'model-options'],
    queryFn: () => host.request('model.options', {}),
    staleTime: LIMITS_POLL_MS,
    // Missing providers or cold usage caches must never create a fast loop:
    // a fixed 5-minute poll, plus ONE early re-check 20 s after an empty first
    // answer (the usage cache warms in the background after that first call).
    refetchInterval: limitsRefetchInterval,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1
  })
  return limitsFromRows(data?.providers ?? [])
}

function limitsFromRows(rows) {
  const rank = slug => {
    const i = PROVIDER_ORDER.indexOf(slug)
    return i === -1 ? PROVIDER_ORDER.length : i
  }
  return rows
    .filter(r => r && r.slug && r.authenticated !== false)
    .map(r => {
      const picked = pickWindows(r)
      return picked ? { slug: r.slug, label: providerLabel(r), name: String(r.name || providerLabel(r)), ...picked } : null
    })
    .filter(Boolean)
    .sort((a, b) => rank(a.slug) - rank(b.slug) || a.label.localeCompare(b.label))
}

function limitsRefetchInterval(query) {
  const state = query?.state ?? {}
  const anyReported = limitsFromRows(state.data?.providers ?? []).length > 0
  return state.dataUpdateCount === 1 && !anyReported ? LIMITS_FIRST_RECHECK_MS : LIMITS_POLL_MS
}

const $limitMode = atom('used') // 'used' | 'left'
function toggleLimitMode() {
  $limitMode.set($limitMode.get() === 'left' ? 'used' : 'left')
}

// Keys earlier versions saved; removed on load so the plugin leaves nothing behind.
const LEGACY_STORAGE_KEYS = ['visible', 'limitMode', 'sessionAvg']

// Hide anything in displayed text that looks like a credential: KEY=value,
// --token value / --password=value, "Authorization: Bearer x", URL user:pass@,
// and well-known key shapes (sk-…, ghp_…, gho_…, xoxb-…, AKIA…, JWTs).
const SECRET_NAME = '(?:[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|AUTH|CREDENTIALS?|COOKIE|SESSION)[A-Za-z0-9_]*)'
const SECRET_PATTERNS = [
  new RegExp(`\\b(${SECRET_NAME})(\\s*[=:]\\s*)(?!(?:Bearer|Basic)\\s)("[^"]*"|'[^']*'|\\S+)`, 'gi'),
  new RegExp(`(--?${SECRET_NAME})(\\s+|=)(?!(?:Bearer|Basic)\\s)("[^"]*"|'[^']*'|\\S+)`, 'gi'),
  /\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+/=-]{8,})/gi,
  /(\/\/[^\s/:@]+:)([^\s@/]+)(@)/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{12,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bA(?:KIA|SIA)[A-Z0-9]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
]

function redactSecrets(text) {
  let s = String(text ?? '')
  s = s.replace(SECRET_PATTERNS[2], (_, k, sep) => `${k}${sep}••••`)
  s = s.replace(SECRET_PATTERNS[0], (_, k, sep) => `${k}${sep}••••`)
  s = s.replace(SECRET_PATTERNS[1], (_, k, sep) => `${k}${sep}••••`)
  s = s.replace(SECRET_PATTERNS[3], (_, a, __, b) => `${a}••••${b}`)
  for (const re of SECRET_PATTERNS.slice(4)) s = s.replace(re, '••••')
  return s
}

// Background terminal processes owned by the focused chat (the same list the
// app's process stack shows). Local registry read, so a 15 s poll is cheap.
function useBackgroundProcesses(runtimeId, active) {
  const { data } = useQuery({
    queryKey: [ID, 'processes', runtimeId],
    queryFn: () => host.request('process.list', { session_id: runtimeId }),
    enabled: Boolean(runtimeId) && active,
    staleTime: 10_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    retry: false
  })
  return (data?.processes ?? []).filter(p => !p.status || p.status === 'running')
}

function useNow(intervalMs, active = true) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs, active])
  return now
}

// Split view: Hermes gives plugins numbers only for the FOCUSED chat, so the
// line shows only under the focused pane — never one chat's numbers under
// another chat. Each pane's root carries data-session-anchor: 'workspace' for
// the main pane, 'session-tile:<stored id>' for extra panes.
function surfaceIsFocused(anchor, focusedStoredId, tileIds) {
  if (!anchor) return true // not inside a known chat surface: behave as before
  if (anchor.startsWith('session-tile:')) return anchor.slice('session-tile:'.length) === focusedStoredId
  return !tileIds.includes(focusedStoredId) // main pane: focused unless an extra pane is
}

// The name on this pane's tab, as the user sees it (bot chats show the bot's
// name there, not the stored chat title). Read from the pane's own tab:
// [data-pane-host=<id>] ↔ [data-tree-tab=<id>]; screen-reader-only text,
// buttons and decorative parts are skipped. '' when it can't be found.
function paneTabName(surface) {
  const host = surface?.closest('[data-pane-host]')
  const paneId = host?.getAttribute('data-pane-host')
  const groupId = host?.getAttribute('data-tree-group')
  const tabs = [...document.querySelectorAll('[data-tree-tab]')]
  // This pane's own tab; else the selected tab of its group's strip.
  const tab = (paneId && tabs.find(el => el.getAttribute('data-tree-tab') === paneId)) ||
    (groupId && [...document.querySelectorAll('[data-zone-tabstrip]')]
      .find(el => el.getAttribute('data-zone-tabstrip') === groupId)
      ?.querySelector('[data-tree-tab][aria-selected="true"]'))
  if (!tab) return ''
  const copy = tab.cloneNode(true)
  copy.querySelectorAll('.sr-only, button, [aria-hidden="true"], svg, kbd').forEach(el => el.remove())
  return cleanName(copy.textContent)
}

function cleanName(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80)
}

// Several chats visible side by side. Background tabs stay in the page but are
// made inert and invisible, so they don't count.
function chatIsShown(el) {
  if (el.closest('[inert], [aria-hidden="true"]')) return false
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'
}

function countVisibleChats() {
  return [...document.querySelectorAll('[data-chat-surface]')].filter(chatIsShown).length
}

// Every open tab mounts its own copy of the line. Only the visible, focused
// copy does any work: the check runs AFTER a tab switch has painted (never in
// the switch itself), hidden tabs are recognised from attributes alone (no
// layout reads), and layout is only measured by the one focused copy.
function useFocusedSurface(ref, focusedStoredId) {
  const [state, setState] = useState({ focused: true, split: false, tabName: '' })
  useEffect(() => {
    let cancelled = false
    const check = () => {
      if (cancelled || !ref.current) return
      const el = ref.current
      let focused = false
      let split = false
      let tabName = ''
      if (!el.closest('[inert], [aria-hidden="true"]')) {
        const surface = el.closest('[data-session-anchor]')
        const anchor = surface?.getAttribute('data-session-anchor') || ''
        const tileIds = [...document.querySelectorAll('[data-session-anchor^="session-tile:"]')]
          .map(t => t.getAttribute('data-session-anchor').slice('session-tile:'.length))
        focused = surfaceIsFocused(anchor, focusedStoredId, tileIds)
        if (focused) {
          split = countVisibleChats() > 1
          tabName = split ? paneTabName(surface) : ''
        }
      }
      setState(prev => (prev.focused === focused && prev.split === split && prev.tabName === tabName ? prev : { focused, split, tabName }))
    }
    const first = setTimeout(check, 150)
    const t = setInterval(check, 5000)
    return () => { cancelled = true; clearTimeout(first); clearInterval(t) }
  }, [ref, focusedStoredId])
  return state
}

// ── context item: click cycles three views ─────────────────────────────────
// 1 'numbers'  202K/500K
// 2 'both'     202K/500K │ [████░░░░░░] 40%   (default — the terminal's layout)
// 3 'bar'      [████░░░░░░]
const CTX_MODES = ['both', 'bar', 'numbers'] // click order, starting from the default
const $ctxMode = atom('both')
function cycleCtxMode() {
  const i = CTX_MODES.indexOf($ctxMode.get())
  $ctxMode.set(CTX_MODES[(i + 1) % CTX_MODES.length])
}

// Parts for the merged context item. Medium width keeps the terminal's short
// form (percent only) for 'both'.
function contextParts(mode, wide, c) {
  const tone = pctTone(c.pct)
  const pctLabel = c.pct != null ? `${c.mark}${c.pct}%` : '--'
  const numbers = c.ctxMax ? `${c.mark}${tokensCompact(c.ctxUsed)}/${contextLength(c.ctxMax)}` : 'ctx --'
  if (mode === 'numbers') return [part('dim', numbers)]
  if (mode === 'bar') return [part(tone, contextBar(c.pct))]
  if (!wide) return [part(tone, pctLabel, true)]
  return [part('dim', numbers), part('dim', ' │ '), part(tone, contextBar(c.pct)), part('dim', ' '), part(tone, pctLabel, true)]
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
  const label = String(win.label || 'limit')
  if (/quota/i.test(label)) return 'quota'
  if (/month/i.test(label)) return 'mo'
  if (/day|daily/i.test(label)) return 'day'
  return label.slice(0, 12)
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
    note: `Your plan's rolling allowances. When one is fully used, requests are refused until it resets. Refreshed about every 5 min. Click to show ${mode === 'left' ? '% used' : '% left'}.`
  }
}

// ── the line ───────────────────────────────────────────────────────────────

function StatusLine() {
  const ref = useRef(null)
  const visible = useValue($visible)
  const defaultModel = useValue(host.state.model)
  const runtimeId = useValue(host.state.focusedSessionId)
  const live = useSessionModel(runtimeId)
  const model = live.model || defaultModel
  const provider = live.provider
  const usage = useValue(host.state.focusedUsage)
  const storedId = useValue(host.state.focusedStoredSessionId)
  const surface = useFocusedSurface(ref, storedId)
  const active = visible && surface.focused
  const liveTps = useLiveRate(runtimeId, active)
  const sessionProfile = useValue(host.state.focusedSessionProfile)
  const { startedAt, title: storedTitle } = useSessionStartedAt(storedId, sessionProfile)
  const limits = useAccountLimits()
  const limitMode = useValue($limitMode)
  const ctxMode = useValue($ctxMode)
  const procs = useBackgroundProcesses(runtimeId, active)
  const now = useNow(5_000, active)
  const subs = useSubagents(runtimeId, now)
  const cols = useColumns(ref, visible)

  if (!visible) return null
  // Unfocused split pane: keep an invisible marker so focus changes are seen.
  if (!surface.focused) return jsx('span', { ref, 'aria-hidden': true, style: { display: 'none' } })

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
  // Split view: name the chat the line belongs to (the name on its tab).
  if (surface.split) {
    const name = surface.tabName || storedTitle || 'This chat'
    const shortName = name.length > 24 ? `${name.slice(0, 23)}…` : name
    segs.push({
      parts: [part('dim', '▸ '), part('strong', shortName, true)],
      card: {
        title: 'Active chat',
        rows: [['Chat', name], storedTitle && storedTitle !== name ? ['Title', storedTitle] : null].filter(Boolean),
        note: 'Several chats are open side by side. The line shows the one you\'re focused on; click another chat to switch.'
      }
    })
  }
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
    const pctLabel = pct != null ? `${mark}${pct}%` : '--'
    const nextView = { both: 'meter only', bar: 'numbers only', numbers: 'numbers and meter' }[ctxMode]
    segs.push({
      parts: contextParts(ctxMode, wide, { pct, mark, ctxUsed, ctxMax }),
      onClick: cycleCtxMode,
      card: {
        title: 'Context window',
        rows: [
          ...(ctxMax
            ? [['Used', `${n(ctxUsed)} tokens (${pctLabel})`], ['Window', `${n(ctxMax)} tokens`], ['Free', `${n(Math.max(0, ctxMax - ctxUsed))} tokens`],
               ['Source', est ? 'local estimate (~)' : 'provider-reported']]
            : [['Used', 'not reported yet']]),
          ['Colour', 'green <50% · amber 50–80% · red >80% · bright red ≥95%']
        ],
        note: `How much of the model's working memory this chat fills: rules, tools, skills and the conversation so far. When it gets high, Hermes compresses older turns into a summary so the chat can keep going. Click to show ${nextView}.`
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
    if (wide && typeof u.avg_tps === 'number' && u.avg_tps > 0) {
      const covered = Math.min(Number(u.calls || 0), 10)
      segs.push({
        parts: [part('dim', `↑ ${Math.round(u.avg_tps)} t/s`)],
        card: {
          title: 'Average output speed',
          rows: [
            ['Speed', `${u.avg_tps.toFixed(1)} tokens/second`],
            ['Covers', `last ${covered} model ${covered === 1 ? 'call' : 'calls'}`],
            typeof u.avg_latency_s === 'number' ? ['Avg call time', `${u.avg_latency_s.toFixed(1)} s`] : null
          ].filter(Boolean),
          note: 'Output tokens divided by the time the model spent answering, over the last 10 model calls. Hermes keeps timing for only those 10 calls, and this plugin saves nothing, so it is a rolling average rather than a whole-session one.'
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
            redactSecrets(String(p.command || p.session_id || '')).replace(/\s+/g, ' ').slice(0, 60)
          ]),
          note: `Terminal commands this chat started in the background (servers, builds, watchers) that are still running${procs.length > 6 ? ` — showing 6 of ${procs.length}` : ''}. Anything that looks like a key, token or password is hidden as ••••. They use no AI tokens. Checked every 30 s.`
        }
      })
    }
    if (subs) {
      const speed = d => (d.seconds > 0 && d.out > 0 ? `${(d.out / d.seconds).toFixed(1)} t/s` : '—')
      const short = s => redactSecrets(s || 'subagent').replace(/\s+/g, ' ').slice(0, 40)
      segs.push({
        parts: [part(subs.running.length ? 'strong' : 'dim', `⛓ ${subs.running.length}`, Boolean(subs.running.length))],
        card: {
          title: 'Subagents',
          rows: [
            ...subs.running.map(r => [
              r.started_at ? `running ${durationCompact(Math.max(0, now / 1000 - Number(r.started_at)))}` : 'running',
              short(r.goal)
            ]),
            ...subs.done.map(d => [
              `${d.status === 'completed' || !d.status ? 'done' : d.status} · ${speed(d)}`,
              `${short(d.goal)} (${n(d.out)} tokens, ${durationCompact(d.seconds)})`
            ])
          ],
          note: 'Helpers this chat started, as Hermes lists them. Hermes reports a subagent\'s tokens only when it finishes, so speeds appear afterwards: its output tokens divided by its whole run time, which includes time spent running tools. Finished runs are kept in memory only and vanish when the app closes. Shown while any run, and for 5 minutes after.'
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
    style: { fontFamily: "var(--dt-font-mono, ui-monospace, monospace), 'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji'" },
    children
  })
}

export default {
  id: ID,
  name: 'CLI Status Line',
  version: VERSION,
  register(ctx) {
    // Nothing is saved: settings reset to defaults when the app starts. Remove
    // anything earlier versions of this plugin saved.
    for (const key of LEGACY_STORAGE_KEYS) ctx.storage.remove(key)
    $visible.set(true)
    $limitMode.set('used')
    $ctxMode.set('both')

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
          $visible.set(!$visible.get())
        }
      }
    })
  }
}
