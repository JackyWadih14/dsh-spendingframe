/**
 * 汇总一次请求需要的全部数字：当前高峰/空闲状态、当前会话花费、今日花费。
 *
 * “今日”按北京时间自然日切分；每一笔调用用它自己发生时刻的时段计价，
 * 而不是用此刻的时段——跨过 9:00 / 12:00 / 14:00 / 18:00 边界时这才准确。
 *
 * 会话花费自 v0.2.0 起**包含子智能体**：DSH 把每个子智能体跑在独立会话里，
 * 只统计本会话会把子智能体的开销藏起来（要点开子会话才看得见）。这里按会话头
 * 的 `parentSession` / `origin` 递归汇总所有派生会话，并同时给出拆分值。
 */

import { beijingDayStart, costOfUsage, isPeak, msUntilNextChange, priceTableFor, windowLabel } from './pricing.js'
import { collectSessions, resolveDshHome } from './session-logs.js'

function emptyTokens() {
  return { hit: 0, miss: 0, out: 0 }
}

function addTokens(target, usage) {
  target.hit += safeToken(usage?.cacheReadTokens)
  target.miss += safeToken(usage?.inputTokens)
  target.out += safeToken(usage?.outputTokens)
}

function safeToken(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** 保留 6 位小数，抹掉浮点噪声后再进 JSON。 */
function round(value) {
  return Math.round(value * 1e6) / 1e6
}

function emptyBucket(id) {
  return { id, cost: 0, calls: 0, tokens: emptyTokens(), lastAt: null }
}

function absorb(bucket, cost, usage, time) {
  bucket.cost += cost
  bucket.calls += 1
  addTokens(bucket.tokens, usage)
  if (time !== null && (bucket.lastAt === null || time > bucket.lastAt)) bucket.lastAt = time
}

/**
 * 判断一个会话是不是“子智能体会话”。
 *
 * DSH 写入会话头的标记（本机实测）：子智能体是 `origin: "subagent"` 且
 * `delegationDepth >= 1`；普通会话与 fork 出来的分支都是 depth 0 且没有 origin，
 * 因此分支不会被算进父会话——它是一条独立的对话，不是父会话的一部分。
 */
function isSubagentSession(session) {
  return session.origin === 'subagent' || (typeof session.delegationDepth === 'number' && session.delegationDepth > 0)
}

/** 父会话 id → 直接子智能体会话 id 列表。 */
export function subagentChildren(sessions) {
  const children = new Map()
  for (const session of sessions) {
    if (session.parentSession === null || session.parentSession === undefined) continue
    if (!isSubagentSession(session)) continue
    const list = children.get(session.parentSession) ?? []
    list.push(session.sessionId)
    children.set(session.parentSession, list)
  }
  return children
}

/** 广度优先收集全部派生会话 id（子、孙……）。 */
function descendantIds(rootId, children) {
  const found = []
  const seen = new Set([rootId])
  const queue = [...(children.get(rootId) ?? [])]
  while (queue.length > 0) {
    const id = queue.shift()
    if (seen.has(id)) continue // 血缘数据异常时不要死循环
    seen.add(id)
    found.push(id)
    queue.push(...(children.get(id) ?? []))
  }
  return found
}

/**
 * 纯汇总：给定会话列表与目标会话，算出全部数字。
 *
 * 与文件系统无关，测试可以直接喂合成会话。
 *
 * @param sessions - `{ sessionId, createdAt, parentSession, origin, delegationDepth, records }` 列表。
 * @param options.sessionId - 目标会话 id；空串表示只统计今日。
 * @param options.now - 注入的“现在”，便于测试。
 */
export function summarize(sessions, options = {}) {
  const now = typeof options.now === 'number' ? options.now : Date.now()
  const sessionId = typeof options.sessionId === 'string' ? options.sessionId.trim() : ''
  const todayStart = beijingDayStart(now)
  const children = subagentChildren(sessions)
  // 目标会话 + 它的全部派生会话：会话消耗的统计范围。
  const scope = new Set(sessionId === '' ? [] : [sessionId, ...descendantIds(sessionId, children)])

  const own = emptyBucket(sessionId)
  const derived = emptyBucket('')
  const todayAgg = { cost: 0, calls: 0, tokens: emptyTokens(), sessions: new Set() }
  const models = new Map()
  const assumedPricing = new Set()
  let matched = false
  let derivedSessions = 0

  for (const session of sessions) {
    const isTarget = sessionId !== '' && session.sessionId === sessionId
    if (isTarget) matched = true
    const isDerived = scope.has(session.sessionId) && !isTarget
    if (isDerived) derivedSessions += 1
    for (const record of session.records) {
      // 会话头之前的记录不属于本会话（fork/继承），一律不计。
      if (record.time !== null && session.createdAt !== null && record.time < session.createdAt) continue
      const { table, assumed } = priceTableFor(record.model)
      if (assumed && record.model !== '') assumedPricing.add(record.model)
      const peak = record.time === null ? isPeak(now) : isPeak(record.time)
      const cost = costOfUsage(record.usage, table, peak)

      if (isTarget) absorb(own, cost, record.usage, record.time)
      else if (isDerived) absorb(derived, cost, record.usage, record.time)

      if (scope.has(session.sessionId)) {
        const modelKey = record.model === '' ? '(未记录模型)' : record.model
        const modelAgg = models.get(modelKey) ?? { id: modelKey, calls: 0, cost: 0 }
        modelAgg.calls += 1
        modelAgg.cost += cost
        models.set(modelKey, modelAgg)
      }

      if (record.time !== null && record.time >= todayStart) {
        todayAgg.cost += cost
        todayAgg.calls += 1
        addTokens(todayAgg.tokens, record.usage)
        todayAgg.sessions.add(session.sessionId)
      }
    }
  }

  const peak = isPeak(now)
  const totalTokens = {
    hit: own.tokens.hit + derived.tokens.hit,
    miss: own.tokens.miss + derived.tokens.miss,
    out: own.tokens.out + derived.tokens.out,
  }
  const totalCalls = own.calls + derived.calls
  const lastAt = own.lastAt === null ? derived.lastAt : derived.lastAt === null ? own.lastAt : Math.max(own.lastAt, derived.lastAt)

  return {
    ok: true,
    at: now,
    peak,
    window: windowLabel(peak),
    nextChangeInMs: msUntilNextChange(now),
    session: {
      id: sessionId,
      found: matched,
      // 含子智能体的总消耗：面板上显示的就是这个数。
      cost: round(own.cost + derived.cost),
      calls: totalCalls,
      tokens: totalTokens,
      lastAt,
      // 拆分：本会话自身 / 全部派生会话（子、孙……）。
      own: { cost: round(own.cost), calls: own.calls, tokens: own.tokens },
      subagents: {
        cost: round(derived.cost),
        calls: derived.calls,
        sessions: derivedSessions,
        tokens: derived.tokens,
      },
    },
    today: {
      cost: round(todayAgg.cost),
      calls: todayAgg.calls,
      sessions: todayAgg.sessions.size,
      tokens: todayAgg.tokens,
    },
    models: [...models.values()].map((model) => ({ ...model, cost: round(model.cost) })),
    // 退回 flash 价目计价的模型：数字仍是估算，明确列出来而不是藏起来。
    assumedPricing: [...assumedPricing],
  }
}

/**
 * 构造 `/dsh-spendingframe/summary` 的响应体：读盘 + {@link summarize}。
 *
 * @param options.sessionId - 需要单独统计的会话；空串表示只统计今日。
 * @param options.now - 注入的“现在”，便于测试。
 * @param options.home - DSH home；默认按 `DSH_HOME` / `~/.dsh` 解析。
 */
export function buildSummary(options = {}) {
  const home = typeof options.home === 'string' && options.home !== '' ? options.home : resolveDshHome()
  const collected = options.sessions !== undefined
    ? { sessions: options.sessions, errors: [], fileCount: options.sessions.length }
    : collectSessions(home)
  const summary = summarize(collected.sessions, options)
  return {
    ...summary,
    version: VERSION,
    home,
    scan: { files: collected.fileCount, errors: collected.errors.length },
    errors: collected.errors.slice(0, 3),
  }
}

/** 与 package.json 保持一致的插件版本，随响应返回便于排查。 */
export const VERSION = '0.2.3'
