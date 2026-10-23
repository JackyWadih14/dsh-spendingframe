// Validation probe for the dsh-spendingframe host half: peak/off-peak rules, the
// official price table and the subagent lineage arithmetic.
//
// The default run is hermetic — synthetic data only, so it works on any machine
// and in CI. Pass --real to also read this machine's DSH session logs and assert
// against live numbers.
//
// Usage: node tests/balance-probe.mjs [--real]
import { readFileSync } from 'node:fs'
import { costOfUsage, isPeak, msUntilNextChange, priceTableFor, beijingDayStart } from '../lib/pricing.js'
import { VERSION, buildSummary, subagentChildren, summarize } from '../lib/summary.js'
import { collectSessions, resolveDshHome } from '../lib/session-logs.js'

/** 默认只跑合成用例；--real 才读本机会话日志。 */
const REAL = process.argv.includes('--real')

const failures = []
function check(label, actual, expected) {
  // 基本类型比 ===，数组等结构比 JSON（断言里会出现子会话 id 列表）。
  const ok = actual === expected || JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} = ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`)
}

// --- peak / off-peak windows (Beijing time) -------------------------------
const bj = (iso) => Date.parse(iso) // e.g. 2026-10-12T10:00:00+08:00
check('周一 09:00 高峰', isPeak(bj('2026-10-12T09:00:00+08:00')), true)
check('周一 11:59 高峰', isPeak(bj('2026-10-12T11:59:00+08:00')), true)
check('周一 12:00 空闲', isPeak(bj('2026-10-12T12:00:00+08:00')), false)
check('周一 13:59 空闲', isPeak(bj('2026-10-12T13:59:00+08:00')), false)
check('周一 14:00 高峰', isPeak(bj('2026-10-12T14:00:00+08:00')), true)
check('周一 17:59 高峰', isPeak(bj('2026-10-12T17:59:00+08:00')), true)
check('周一 18:00 空闲', isPeak(bj('2026-10-12T18:00:00+08:00')), false)
check('周一 08:59 空闲', isPeak(bj('2026-10-12T08:59:00+08:00')), false)
check('周六 10:00 空闲（周末）', isPeak(bj('2026-10-10T10:00:00+08:00')), false)
check('周日 10:00 空闲（周末）', isPeak(bj('2026-10-11T10:00:00+08:00')), false)
check('国庆 10-01 周四 10:00 空闲（节假日）', isPeak(bj('2026-10-01T10:00:00+08:00')), false)
check('国庆 10-07 周三 10:00 空闲（节假日）', isPeak(bj('2026-10-07T10:00:00+08:00')), false)
check('10-08 周四 10:00 高峰（假期结束）', isPeak(bj('2026-10-08T10:00:00+08:00')), true)
check('春节 02-16 周一 10:00 空闲（节假日）', isPeak(bj('2026-02-16T10:00:00+08:00')), false)
check('02-24 周二 10:00 高峰（春节后）', isPeak(bj('2026-02-24T10:00:00+08:00')), true)
check('元旦 01-01 周四 10:00 空闲（节假日）', isPeak(bj('2026-01-01T10:00:00+08:00')), false)
check('2025 国庆 10-06 周一 10:00 空闲（节假日）', isPeak(bj('2025-10-06T10:00:00+08:00')), false)
check('2025 端午 06-02 周一 10:00 空闲（节假日）', isPeak(bj('2025-06-02T10:00:00+08:00')), false)
check('2025 05-06 周二 10:00 高峰（端午后）', isPeak(bj('2025-05-06T10:00:00+08:00')), true)

// --- price table (RMB per 1M tokens) --------------------------------------
const flash = priceTableFor('deepseek-flash')
const pro = priceTableFor('deepseek-v4-pro')
console.log('priceTableFor(deepseek-flash).assumed =', flash.assumed, '| pro.assumed =', pro.assumed)
const million = { inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 }
check('flash 高峰 1M+1M+1M = 2 + 0.04 + 8', Number(costOfUsage(million, flash.table, true).toFixed(6)), 10.04)
check('flash 空闲 1M+1M+1M = 1 + 0.02 + 4', Number(costOfUsage(million, flash.table, false).toFixed(6)), 5.02)
check('pro 高峰 1M+1M+1M = 9 + 0.30 + 27', Number(costOfUsage(million, pro.table, true).toFixed(6)), 36.3)
check('pro 空闲 1M+1M+1M = 4.5 + 0.15 + 13.5', Number(costOfUsage(million, pro.table, false).toFixed(6)), 18.15)

// --- day boundary ---------------------------------------------------------
check('北京时间当天 00:00', new Date(beijingDayStart(bj('2026-10-12T10:00:00+08:00'))).toISOString(), '2026-10-11T16:00:00.000Z')
const until = msUntilNextChange(bj('2026-10-12T11:30:00+08:00'))
check('周一 11:30 距下一次切换 = 30 分钟', until, 30 * 60 * 1000)
console.log('周一 17:00 距下一次切换 =', msUntilNextChange(bj('2026-10-12T17:00:00+08:00')) / 60000, '分钟')

// --- 版本号与 package.json 一致 -------------------------------------------
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
check('VERSION 与 package.json 一致', VERSION, pkg.version)
check('package.json 已是 v0.2.4', pkg.version, '0.2.4')

// --- 本机真实数据（--real 才跑）-------------------------------------------
const now = Date.now()
if (REAL) {
  const summary = buildSummary({ now })
  console.log('\n=== 当前 =', new Date(now).toISOString(), '(北京时间', new Date(now + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '), ')')
  console.log('时段:', summary.window, '| peak =', summary.peak, '| 距切换', summary.nextChangeInMs, 'ms')
  console.log('今日:', JSON.stringify(summary.today))
  console.log('扫描:', JSON.stringify(summary.scan), '| 模型:', JSON.stringify(summary.models), '| 估价回退:', JSON.stringify(summary.assumedPricing))
  check('响应里的版本号与 package.json 一致', summary.version, pkg.version)
} else {
  console.log('\n（跳过本机真实数据段：加 --real 启用）')
}

// --- 子智能体血缘（合成数据：R 有子 A，A 又有子 A1，另有 R 的 fork F）------
const at = Date.parse('2026-10-11T10:00:00+08:00') // 周日 → 空闲时段
const sample = { inputTokens: 1e6, cacheReadTokens: 0, outputTokens: 0 }
const oneCall = [{ time: at, model: 'deepseek-flash', usage: sample }]
check('合成样本单价 = 1 元（空闲 1 元/百万 未命中输入）', Number(costOfUsage(sample, priceTableFor('deepseek-flash').table, isPeak(at)).toFixed(6)), 1)
const synthetic = [
  { sessionId: 'R', createdAt: at, parentSession: null, origin: null, delegationDepth: 0, records: oneCall },
  { sessionId: 'A', createdAt: at, parentSession: 'R', origin: 'subagent', delegationDepth: 1, records: oneCall },
  { sessionId: 'A1', createdAt: at, parentSession: 'A', origin: 'subagent', delegationDepth: 2, records: oneCall },
  { sessionId: 'F', createdAt: at, parentSession: 'R', origin: null, delegationDepth: 0, records: oneCall },
]
check('血缘：R 的直接子会话', subagentChildren(synthetic).get('R'), ['A'])
const rootView = summarize(synthetic, { now: at, sessionId: 'R' })
check('会话消耗 = 本会话 + 全部派生会话（孙会话也在内）', rootView.session.cost, 3)
check('拆分：本会话', rootView.session.own.cost, 1)
check('拆分：子智能体', [rootView.session.subagents.cost, rootView.session.subagents.sessions], [2, 2])
check('fork 不并入父会话', summarize(synthetic, { now: at, sessionId: 'F' }).session.cost, 1)
check('今日仍统计全部会话', summarize(synthetic, { now: at }).today.cost, 4)
check('子会话自己看时只算自己的派生', summarize(synthetic, { now: at, sessionId: 'A' }).session.cost, 2)

// --- 真实数据里的子智能体会话（--real 才跑）--------------------------------
if (REAL) {
  const real = collectSessions(resolveDshHome())
  const realChildren = subagentChildren(real.sessions)
  console.log('\n=== 真实血缘 ===')
  for (const [parent, kids] of realChildren) console.log(`  ${parent} → ${kids.join(', ')}`)
  const parentIds = [...realChildren.keys()]
  if (parentIds.length > 0) {
    const parentId = parentIds[0]
    const view = summarize(real.sessions, { now, sessionId: parentId })
    const seen = new Set()
    const stack = [...realChildren.get(parentId)]
    while (stack.length > 0) {
      const id = stack.pop()
      if (seen.has(id)) continue
      seen.add(id)
      stack.push(...(realChildren.get(id) ?? []))
    }
    check('真实父会话：总量 = 本会话 + 子智能体', Number(view.session.cost.toFixed(6)), Number((view.session.own.cost + view.session.subagents.cost).toFixed(6)))
    check('真实父会话：子智能体消耗 > 0', view.session.subagents.cost > 0, true)
    check('真实父会话：派生的会话数正确', view.session.subagents.sessions, seen.size)
    console.log(`  父会话 ${parentId.slice(-6)}：总 ${view.session.cost} = 本会话 ${view.session.own.cost} + 子智能体 ${view.session.subagents.cost}（${view.session.subagents.sessions} 个会话）`)
    const kid = realChildren.get(parentId)[0]
    const kidView = summarize(real.sessions, { now, sessionId: kid })
    console.log(`  子会话 ${kid.slice(-6)}：总 ${kidView.session.cost}（其下派生 ${kidView.session.subagents.sessions} 个）`)
  } else {
    console.log('  （本机当前没有子智能体会话，跳过真实血缘断言）')
  }
}

console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} CHECK(S) FAILED:\n- ${failures.join('\n- ')}`)
process.exitCode = failures.length === 0 ? 0 : 1
