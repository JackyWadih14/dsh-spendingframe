// Functional harness for the dsh-spendingframe client half.
//
// It loads the hand-written __ModuleLoader__ bundle with a fake loader, a fake
// react (stateful useState/useRef, effects that actually run), a fake
// react-dom (createPortal), a fake document/window and a stub fetch, then
// drives the three interactions the plugin promises:
//
//   1. hover  -> a small bubble with exactly 本会话消耗 / 子智能体消耗 / 统计更新时间
//   2. click  -> the full information panel (portal, dialog semantics, breakdown)
//   3. dismiss -> Escape and outside pointerdown both close the panel
//
// Usage: node tests/client-harness-test.mjs [path/to/client.js]
import { fileURLToPath, pathToFileURL } from 'node:url'

const clientPath = process.argv[2] ?? fileURLToPath(new URL('../client/client.js', import.meta.url))

const failures = []
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} = ${JSON.stringify(actual)}`)
}
function contains(label, haystack, needle) {
  const ok = typeof haystack === 'string' && haystack.includes(needle)
  if (!ok) failures.push(`${label}: expected to contain ${JSON.stringify(needle)}, got ${JSON.stringify(haystack)}`)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
}
function near(label, actual, expected, tolerance = 0.01) {
  const ok = typeof actual === 'number' && Math.abs(actual - expected) <= tolerance
  if (!ok) failures.push(`${label}: expected ~${expected}, got ${actual}`)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} = ${actual}`)
}

// --- fake timers / globals ------------------------------------------------
// setTimeout fires immediately: the hover bubble has a 200ms delay (native
// Tooltip delayMs) and the harness should not have to wait for it. The delay
// passed in is recorded so an assertion can pin it to the native value.
// setInterval must never really tick, otherwise node would keep the process
// alive after the checks finish.
const intervals = []
const timeouts = []
const timeoutDelays = []
globalThis.setTimeout = (fn, delay) => { timeouts.push(fn); timeoutDelays.push(delay); fn(); return { timeout: true } }
globalThis.clearTimeout = () => {}
globalThis.setInterval = (fn) => { intervals.push(fn); return intervals.length }
globalThis.clearInterval = () => {}
let fetchImpl = () => new Promise(() => {})
globalThis.fetch = (...args) => fetchImpl(...args)

const documentListeners = new Map()
globalThis.document = {
  baseURI: 'http://127.0.0.1:19387/',
  body: { tag: 'body' },
  documentElement: { clientWidth: 1200, clientHeight: 800 },
  addEventListener: (type, fn) => { documentListeners.set(type, [...(documentListeners.get(type) ?? []), fn]) },
  removeEventListener: (type, fn) => { documentListeners.set(type, (documentListeners.get(type) ?? []).filter((item) => item !== fn)) },
}
function latestListener(type) {
  const list = documentListeners.get(type) ?? []
  return list[list.length - 1]
}

const windowListeners = new Map()
globalThis.window = {
  __ModuleLoader__: { load: (def) => { definition = def } },
  addEventListener: (type, fn) => { windowListeners.set(type, [...(windowListeners.get(type) ?? []), fn]) },
  removeEventListener: (type, fn) => { windowListeners.set(type, (windowListeners.get(type) ?? []).filter((item) => item !== fn)) },
}
let definition = null

// --- fake react -----------------------------------------------------------
// Rects are looked up per element so that the anchoring code can be exercised.
let rects = {}
function rectFor(element) {
  if (element.props?.role === 'dialog') return rects.panel
  if (element.props?.role === 'tooltip') return rects.bubble
  return rects.anchor
}
function walk(node, out = []) {
  if (node === null || node === undefined) return out
  out.push(node)
  for (const child of node.children ?? []) walk(child, out)
  return out
}
function createElement(type, props, ...children) {
  const element = { type, props: props ?? {}, children: children.flat(Infinity) }
  element.getBoundingClientRect = () => rectFor(element)
  element.contains = (target) => walk(element).includes(target)
  if (element.props.ref && typeof element.props.ref === 'object') element.props.ref.current = element
  return element
}

let states = []
let refs = []
let stateCursor = 0
let refCursor = 0
let effectCursor = 0
let effects = []
let pendingEffects = []

const React = {
  createElement,
  memo: (component) => component,
  useState: (initial) => {
    const index = stateCursor++
    if (!(index in states)) states[index] = initial
    const set = (value) => { states[index] = typeof value === 'function' ? value(states[index]) : value }
    return [states[index], set]
  },
  useRef: (initial) => {
    const index = refCursor++
    if (!(index in refs)) refs[index] = { current: initial }
    return refs[index]
  },
  useEffect: (fn, deps) => {
    const index = effectCursor++
    const previous = effects[index]
    const changed = previous === undefined
      || deps === undefined
      || previous.deps === null
      || deps.length !== previous.deps.length
      || deps.some((value, i) => !Object.is(value, previous.deps[i]))
    if (!changed) return
    if (previous?.cleanup) previous.cleanup()
    effects[index] = { deps: deps === undefined ? null : deps.slice(), fn, cleanup: undefined }
    pendingEffects.push(index)
  },
}
const reactDom = { createPortal: (node, container) => Object.assign(node, { portalContainer: container }) }

function flushEffects() {
  const queue = pendingEffects
  pendingEffects = []
  for (const index of queue) effects[index].cleanup = effects[index].fn() ?? undefined
}
async function settle() {
  await new Promise((resolve) => setImmediate(resolve))
}
function resetHooks(payload, open = false, hovered = false, stale = false) {
  for (const effect of effects) if (effect?.cleanup) effect.cleanup()
  states = [payload, stale, hovered, open, null]
  refs = []
  effects = []
  pendingEffects = []
}

// --- fake loader ----------------------------------------------------------
await import(pathToFileURL(clientPath).href)
check('loader received a definition', definition !== null, true)
check('bundle id', definition.id, 'dsh-spendingframe')

const requireShim = (id) => {
  if (id === 'react') return React
  if (id === 'react-dom') return reactDom
  throw new Error(`unexpected require(${id})`)
}
const mod = definition.factory(requireShim)
check('exports.name', mod.name, 'dsh-spendingframe')
check('exports.inject', mod.inject, ['slots'])
check('apply is a function', typeof mod.apply, 'function')

// --- fake slots context ---------------------------------------------------
const registrations = []
const ctx = {
  slots: {
    inject: (slot, register) => { check('injected slot name', slot, 'conversation.composer.dock'); register() },
    register: (meta, component) => { registrations.push({ meta, component }); return () => {} },
  },
}
mod.apply(ctx)
check('registration count', registrations.length, 1)
const { meta, component } = registrations[0]
check('slot meta', { name: meta.name, id: meta.id, order: meta.order }, { name: 'conversation.composer.dock', id: 'balance', order: 1 })

// --- render helpers -------------------------------------------------------
/** useState order: [data, stale, hovered, open, position]. */
function render(payload, sessionId = 'session-abc', reset = true) {
  if (reset) resetHooks(payload)
  stateCursor = 0
  refCursor = 0
  effectCursor = 0
  pendingEffects = []
  const tree = component({ sessionId })
  flushEffects()
  if (tree === null) return { tree: null }
  const children = tree.children.filter((child) => child !== null && child !== undefined && child !== false)
  const button = children[0]
  return {
    tree,
    button,
    texts: button.children.map((child) => child.children[0]),
    label: button.props['aria-label'],
    expanded: button.props['aria-expanded'],
    triggerStyle: button.props.style,
    rootStyle: tree.props.style,
    bubble: children.find((child) => child.props?.role === 'tooltip') ?? null,
    panel: children.find((child) => child.props?.role === 'dialog') ?? null,
  }
}
// Measuring the anchor happens in an effect (that is what the real hook does),
// so the render that flips visibility still carries the previous position.
// Two renders: the first computes the position, the second shows it.
function renderSettled(payload, sessionId = 'session-abc') {
  render(payload, sessionId, false)
  return render(payload, sessionId, false)
}
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  return (node.children ?? []).map(textOf).join('')
}

// --- canned payloads ------------------------------------------------------
const peakPayload = {
  ok: true, at: Date.parse('2026-10-12T02:00:00Z'), peak: true, window: '高峰时段', version: '0.2.4',
  session: {
    cost: 0.434705, calls: 60,
    own: { cost: 0.3, calls: 57, tokens: { hit: 120000, miss: 4000, out: 900 } },
    subagents: { cost: 0.134705, calls: 3, sessions: 2, tokens: { hit: 20000, miss: 900, out: 120 } },
  },
  today: { cost: 1.2084, calls: 91, sessions: 2 },
  models: [{ id: 'deepseek-flash', cost: 0.434705, calls: 60 }],
  assumedPricing: [],
}
rects = {
  anchor: { left: 600, top: 400, width: 40, height: 20, right: 640, bottom: 420 },
  bubble: { width: 200, height: 60 },
  panel: { width: 300, height: 200 },
}

// --- 1. base rendering ----------------------------------------------------
const base = render(peakPayload)
check('peak mark', base.texts[0], '峰')
check('session cost includes subagents', base.texts[1], '¥0.435')
check('today cost', base.texts[2], '¥1.21')
check('aria label mentions subagent scope', base.label, '高峰时段，会话消耗 ¥0.435，含 2 个子智能体会话，今日消耗 ¥1.21。点击查看明细')
check('trigger is a real button', base.button.type, 'button')
check('trigger declares the dialog', base.button.props['aria-haspopup'], 'dialog')
check('collapsed by default', base.expanded, false)
check('no bubble before hovering', base.bubble, null)
check('no panel before clicking', base.panel, null)
check('uses tertiary label token', base.triggerStyle.color, 'var(--dsw-alias-label-tertiary)')
check('base background is transparent', base.triggerStyle.background, 'transparent')
check('rounded rect like the native pill', base.triggerStyle.borderRadius, 'var(--dsw-radius-sm)')
check('follows app secondary font size', base.triggerStyle.fontSize, 'var(--dsh-content-font-size-secondary, 13px)')
check('tabular numerals', base.triggerStyle.fontVariantNumeric, 'tabular-nums')
check('no native title attribute (we own the bubble)', base.button.props.title, undefined)
check('sits after the context meter (flex order)', base.rootStyle.order, 1)
check('root is an inline-flex pill', [base.rootStyle.display, base.rootStyle.flex], ['inline-flex', 'none'])

// --- 2. hover: only the two costs plus the refresh time -------------------
timeoutDelays.length = 0
base.button.props.onMouseEnter()
check('hover waits the native Tooltip delay', timeoutDelays[timeoutDelays.length - 1], 200)
const hovered = renderSettled(peakPayload)
check('hover background uses the native token', hovered.triggerStyle.background, 'var(--dsw-alias-interactive-bg-hover)')
check('hover text uses the secondary token', hovered.triggerStyle.color, 'var(--dsw-alias-label-secondary)')
check('hover shows the bubble', hovered.bubble !== null, true)
check('bubble is a tooltip', hovered.bubble.props.role, 'tooltip')
check('bubble does not swallow the pointer', hovered.bubble.props.style.pointerEvents, 'none')
check('bubble keeps the newlines', hovered.bubble.props.style.whiteSpace, 'pre-line')
const bubbleText = textOf(hovered.bubble)
console.log('hover bubble:\n' + bubbleText.split('\n').map((line) => '    ' + line).join('\n'))
check('bubble has exactly three lines', bubbleText.split('\n').length, 3)
contains('line 1: own cost', bubbleText, '本会话消耗 ¥0.300')
contains('line 2: subagent cost + session count', bubbleText, '子智能体消耗 ¥0.135（2 个会话）')
contains('line 3: refresh time (Beijing)', bubbleText, '统计更新时间 2026-10-12 10:00')
check('bubble shows no full breakdown', bubbleText.includes('今日消耗'), false)
check('still no panel while hovering', hovered.panel, null)
// anchored above the pill: left = 600 + 40/2 - 200/2, top = 400 - 6 - 60
check('bubble anchored above the pill', [hovered.bubble.props.style.left, hovered.bubble.props.style.top], [520, 334])

hovered.button.props.onMouseLeave()
const unhovered = render(peakPayload, 'session-abc', false)
check('leaving restores the base appearance', [unhovered.triggerStyle.background, unhovered.triggerStyle.color], ['transparent', 'var(--dsw-alias-label-tertiary)'])
check('leaving removes the bubble', unhovered.bubble, null)

// --- 3. click: the full information panel ---------------------------------
hovered.button.props.onClick()
const opened = renderSettled(peakPayload)
check('aria-expanded flips to true', opened.expanded, true)
check('click opens the dialog', opened.panel?.props.role, 'dialog')
check('panel is portalled to the body', opened.panel.portalContainer, globalThis.document.body)
check('panel labelled by its headline', opened.panel.props['aria-label'], '高峰时段消耗明细')
check('panel uses the menu background', opened.panel.props.style.background, 'var(--dsw-specific-menu)')
check('panel uses the large radius', opened.panel.props.style.borderRadius, 'var(--dsw-radius-lg)')
// left = 600 + 40/2 - 300/2, top = 400 - 8 - 200
check('panel anchored above the pill', [opened.panel.props.style.left, opened.panel.props.style.top], [470, 192])
const panelText = textOf(opened.panel)
const [header, bar, rows, footer] = opened.panel.children
check('header headline + mark', [textOf(header.children[0]), textOf(header.children[1])], ['高峰时段', '峰'])
check('header figures', textOf(header.children[2]), '会话合计 ¥0.435')
const segments = bar.children
check('bar has one segment per source', segments.length, 2)
check('bar tints match the native meter', segments.map((segment) => segment.props.style.background), ['var(--dsw-static-neutral-bluish-400)', '#a78bfa'])
near('bar segments add up to 100%', segments.reduce((sum, segment) => sum + Number.parseFloat(segment.props.style.width), 0), 100)
const rowMap = Object.fromEntries(rows.children.map((row) => [textOf(row.children[0]), textOf(row.children[1])]))
check('panel rows', Object.keys(rowMap), ['本会话消耗', '子智能体消耗', '今日消耗', '本会话 Token', '子智能体 Token', '模型', '计费时段', '统计更新时间'])
check('own row', rowMap['本会话消耗'], '¥0.300（57 次调用）')
check('subagent row', rowMap['子智能体消耗'], '¥0.135（2 个会话 / 3 次调用）')
check('today row', rowMap['今日消耗'], '¥1.21（2 个会话 / 91 次调用）')
check('own token row', rowMap['本会话 Token'], '命中 120K / 未命中 4K / 输出 900')
check('model row', rowMap['模型'], 'deepseek-flash ¥0.435（60 次）')
contains('panel footer carries the version', textOf(footer), 'dsh-spendingframe v0.2.4')
check('panel carries the full breakdown, not just the hover lines', [panelText.includes('今日消耗'), panelText.includes('计费时段'), panelText.includes('统计更新时间')], [true, true, true])

// --- 4. dismissal ---------------------------------------------------------
latestListener('keydown')({ key: 'Escape' })
const closed = render(peakPayload, 'session-abc', false)
check('escape closes the panel', [closed.expanded, closed.panel], [false, null])
check('escape keeps the bubble away too', closed.bubble, null)

closed.button.props.onClick()
const reopened = render(peakPayload, 'session-abc', false)
check('panel reopens', reopened.panel?.props.role, 'dialog')
latestListener('pointerdown')({ target: { tag: 'outside' } })
const dismissed = render(peakPayload, 'session-abc', false)
check('outside pointerdown closes the panel', dismissed.panel, null)

dismissed.button.props.onClick()
const inside = render(peakPayload, 'session-abc', false)
latestListener('pointerdown')({ target: inside.button })
check('pointerdown inside the pill keeps the panel open', render(peakPayload, 'session-abc', false).panel?.props.role, 'dialog')

// --- 5. off-peak / formatting / degradation -------------------------------
const offPeak = render({ ok: true, at: Date.now(), peak: false, session: { cost: 0, calls: 0, own: { cost: 0 }, subagents: { cost: 0, sessions: 0 } }, today: { cost: 1234.56, calls: 3, sessions: 1 } })
check('off-peak mark', offPeak.texts[0], '谷')
check('zero cost', offPeak.texts[1], '¥0.000')
check('large cost rounds', offPeak.texts[2], '¥1235')
check('no subagent scope without subagents', offPeak.label, '空闲时段，会话消耗 ¥0.000，今日消耗 ¥1235。点击查看明细')
offPeak.button.props.onClick()
const offPanel = render({ ok: true, at: Date.now(), peak: false, session: { cost: 0, calls: 0, own: { cost: 0 }, subagents: { cost: 0, sessions: 0 } }, today: { cost: 1234.56, calls: 3, sessions: 1 } }, 'session-abc', false)
check('empty split falls back to one neutral segment', offPanel.panel.children[1].children.map((segment) => segment.props.style.background), ['var(--dsw-alias-label-tertiary)'])

const mid = render({ ok: true, at: Date.now(), peak: false, session: { cost: 123.456, own: { cost: 123.456 } }, today: { cost: 250.5 } })
check('cost >= 100 uses 1 decimal', [mid.texts[1], mid.texts[2]], ['¥123.5', '¥250.5'])
const small = render({ ok: true, at: Date.now(), peak: false, session: { cost: 1.5, own: { cost: 1.5 } }, today: { cost: 2.5 } })
check('cost >= 1 uses 2 decimals', [small.texts[1], small.texts[2]], ['¥1.50', '¥2.50'])

// stale flag from a failed refresh shows up in the bubble
resetHooks(peakPayload, false, true, true)
const staleRender = render(peakPayload, 'session-abc', false)
contains('stale refresh is called out in the bubble', textOf(staleRender.bubble), '（刷新失败，显示上次结果）')

// no data yet -> renders nothing (never a placeholder flash)
resetHooks(null)
check('renders nothing without data', component({ sessionId: 'x' }), null)

// the fetch path: no seeded data, the host answers, the pill appears
resetHooks(null)
fetchImpl = async () => ({ ok: true, status: 200, json: async () => peakPayload })
const loading = render(null, 'session-abc', false)
check('still nothing while the first fetch is in flight', loading.tree, null)
await settle()
const loaded = render(peakPayload, 'session-abc', false)
check('fetched payload renders', [loaded.texts[0], loaded.texts[1]], ['峰', '¥0.435'])
check('a refresh timer is armed', intervals.length > 0, true)

// --- 6. pure helpers ------------------------------------------------------
const t = mod.__test
check('money tiers', [t.money(0), t.money(0.4), t.money(3.25), t.money(123.456), t.money(1234.56)], ['¥0.000', '¥0.400', '¥3.25', '¥123.5', '¥1235'])
check('compact tokens', [t.compactTokens(0), t.compactTokens(900), t.compactTokens(4000), t.compactTokens(120000), t.compactTokens(2400000)], ['0', '900', '4K', '120K', '2.4M'])
check('beijing clock', t.beijingClock(Date.parse('2026-10-12T02:00:00Z')), '10:00')
check('beijing stamp', t.beijingStamp(Date.parse('2026-10-12T02:00:00Z')), '2026-10-12 10:00')
const viewport = { width: 1200, height: 800 }
check('placement centres above the anchor', t.placement({ left: 600, top: 400, width: 40, height: 20, bottom: 420 }, { width: 300, height: 200 }, viewport), { left: 470, top: 192, width: 300 })
check('placement flips below when there is no room above', t.placement({ left: 600, top: 10, width: 40, height: 20, bottom: 30 }, { width: 300, height: 200 }, viewport), { left: 470, top: 38, width: 300 })
check('placement clamps to the left margin', t.placement({ left: 0, top: 400, width: 20, height: 20, bottom: 420 }, { width: 300, height: 200 }, viewport), { left: 12, top: 192, width: 300 })
check('placement clamps to the right margin', t.placement({ left: 1190, top: 400, width: 20, height: 20, bottom: 420 }, { width: 300, height: 200 }, viewport), { left: 888, top: 192, width: 300 })
check('placement shrinks a panel wider than the viewport', t.placement({ left: 600, top: 400, width: 40, height: 20, bottom: 420 }, { width: 2000, height: 200 }, viewport).width, 1176)
check('hover label without subagents', t.hoverLabel({ at: Date.parse('2026-10-12T02:00:00Z'), session: { own: { cost: 1 }, subagents: { cost: 0, sessions: 0 } } }).split('\n')[1], '子智能体消耗 ¥0.000')
check('panel rows skip the model line when there is none', t.panelRows({ session: { own: {}, subagents: {} }, today: {} }).map((row) => row.label), ['本会话消耗', '子智能体消耗', '今日消耗', '本会话 Token', '子智能体 Token', '计费时段', '统计更新时间'])
check('assumed pricing is flagged', t.panelRows({ session: { own: {}, subagents: {} }, today: {}, assumedPricing: ['unknown-model'] }).at(-1).label, '按 flash 价目估算')
// the two cost rows carry the bar colours as an 8px swatch (native .swatch)
check('cost rows carry the bar tints', t.panelRows({ session: { own: {}, subagents: {} }, today: {} }).slice(0, 3).map((row) => row.tint ?? null), ['var(--dsw-static-neutral-bluish-400)', '#a78bfa', null])

console.log(failures.length === 0 ? '\nALL CLIENT CHECKS PASSED' : `\n${failures.length} CLIENT CHECK(S) FAILED:\n- ${failures.join('\n- ')}`)
process.exitCode = failures.length === 0 ? 0 : 1
