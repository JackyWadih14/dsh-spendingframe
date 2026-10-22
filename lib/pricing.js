/**
 * DeepSeek API 分时定价与人民币费用计算。
 *
 * 高峰时段：北京时间周一至周五（不含中国法定节假日）09:00–12:00、14:00–18:00。
 * 其余时段（含周末与中国法定节假日全天）为空闲时段。
 *
 * 这里全是纯函数，不依赖 DSH 运行时，便于单独测试。
 */

/** 北京时间相对 UTC 的固定偏移（中国不使用夏令时）。 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/** 高峰时段区间，单位：北京时间当天第几分钟。 */
const PEAK_WINDOWS = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
]

/**
 * 中国法定节假日（国务院办公厅通知）。
 *
 * 只列放假日期：调休上班的周末按规则仍属空闲时段，无需单独处理。
 * 未知年份只按“工作日 + 时段”判定，不会把普通工作日误判成节假日。
 *
 * 数据来源：
 * 2024 — 国办发明电〔2023〕7 号
 * 2025 — 国办发明电〔2024〕12 号
 * 2026 — 国办发明电〔2025〕7 号
 */
const HOLIDAY_RANGES = [
  // 2024
  ['2024-01-01', '2024-01-01'], // 元旦
  ['2024-02-10', '2024-02-17'], // 春节
  ['2024-04-04', '2024-04-06'], // 清明节
  ['2024-05-01', '2024-05-05'], // 劳动节
  ['2024-06-08', '2024-06-10'], // 端午节
  ['2024-09-15', '2024-09-17'], // 中秋节
  ['2024-10-01', '2024-10-07'], // 国庆节
  // 2025
  ['2025-01-01', '2025-01-01'], // 元旦
  ['2025-01-28', '2025-02-04'], // 春节
  ['2025-04-04', '2025-04-06'], // 清明节
  ['2025-05-01', '2025-05-05'], // 劳动节
  ['2025-05-31', '2025-06-02'], // 端午节
  ['2025-10-01', '2025-10-08'], // 国庆节、中秋节
  // 2026
  ['2026-01-01', '2026-01-03'], // 元旦
  ['2026-02-15', '2026-02-23'], // 春节
  ['2026-04-04', '2026-04-06'], // 清明节
  ['2026-05-01', '2026-05-05'], // 劳动节
  ['2026-06-19', '2026-06-21'], // 端午节
  ['2026-09-25', '2026-09-27'], // 中秋节
  ['2026-10-01', '2026-10-07'], // 国庆节
]

/** 展开成 `YYYY-MM-DD` 集合，按北京时间的日期字符串直接查表。 */
function expandHolidays(ranges) {
  const days = new Set()
  for (const [from, to] of ranges) {
    const cursor = new Date(`${from}T00:00:00Z`)
    const end = new Date(`${to}T00:00:00Z`)
    while (cursor.getTime() <= end.getTime()) {
      days.add(cursor.toISOString().slice(0, 10))
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
  }
  return days
}

const HOLIDAYS = expandHolidays(HOLIDAY_RANGES)

/**
 * 把时间戳拆成北京时间字段。
 *
 * 用固定 +8 偏移后再读 UTC 字段：不依赖宿主机的本地时区设置，
 * 结果在任何机器上都一致。
 */
export function beijingParts(timeMs) {
  const shifted = new Date((Number.isFinite(timeMs) ? timeMs : Date.now()) + BEIJING_OFFSET_MS)
  return {
    ymd: shifted.toISOString().slice(0, 10),
    weekday: shifted.getUTCDay(), // 0 = 周日
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  }
}

/** 该日期是否为（北京时间的）中国法定节假日。 */
export function isHoliday(ymd) {
  return HOLIDAYS.has(ymd)
}

/** 某个时刻是否处于高峰时段。 */
export function isPeak(timeMs) {
  const { ymd, weekday, minutes } = beijingParts(timeMs)
  if (weekday === 0 || weekday === 6) return false
  if (HOLIDAYS.has(ymd)) return false
  return PEAK_WINDOWS.some(([from, to]) => minutes >= from && minutes < to)
}

/** 距离下一次高峰/空闲切换的毫秒数（用于提示，不参与计费）。 */
export function msUntilNextChange(timeMs) {
  const now = Number.isFinite(timeMs) ? timeMs : Date.now()
  const current = isPeak(now)
  // 北京时间的整点候选：每天的 00:00、09:00、12:00、14:00、18:00。
  for (let day = 0; day <= 9; day++) {
    const dayStart = beijingDayStart(now) + day * 24 * 60 * 60 * 1000
    for (const minutes of [0, 9 * 60, 12 * 60, 14 * 60, 18 * 60]) {
      const candidate = dayStart + minutes * 60 * 1000
      if (candidate <= now) continue
      if (isPeak(candidate) !== current) return candidate - now
    }
  }
  return null
}

/** 北京时间当天 00:00 的时间戳。 */
export function beijingDayStart(timeMs) {
  const now = Number.isFinite(timeMs) ? timeMs : Date.now()
  const shifted = new Date(now + BEIJING_OFFSET_MS)
  const midnight = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate())
  return midnight - BEIJING_OFFSET_MS
}

/**
 * 官方单价，单位：元 / 百万 tokens。
 *
 * 每个模型给出缓存命中输入、缓存未命中输入与输出三档；
 * 每档再分空闲（offPeak）与高峰（peak）。
 */
export const PRICES = {
  'deepseek-flash': {
    hit: { offPeak: 0.02, peak: 0.04 },
    miss: { offPeak: 1, peak: 2 },
    out: { offPeak: 4, peak: 8 },
  },
  'deepseek-v4-pro': {
    hit: { offPeak: 0.15, peak: 0.3 },
    miss: { offPeak: 4.5, peak: 9 },
    out: { offPeak: 13.5, peak: 27 },
  },
}

/**
 * 选择模型价目表。
 *
 * 精确命中优先；名称里带 `pro` / `flash` 的变体按对应档位计价；
 * 其余未知模型退回 flash 价目，并由调用方在响应里说明，避免静默出错。
 */
export function priceTableFor(modelId) {
  const id = String(modelId ?? '').trim().toLowerCase()
  if (Object.hasOwn(PRICES, id)) return { table: PRICES[id], assumed: false }
  if (id.includes('pro')) return { table: PRICES['deepseek-v4-pro'], assumed: true }
  if (id.includes('flash')) return { table: PRICES['deepseek-flash'], assumed: true }
  return { table: PRICES['deepseek-flash'], assumed: true }
}

/**
 * 一次调用的费用（元）。
 *
 * @param usage - `inputTokens` 为缓存未命中的输入 tokens，`cacheReadTokens` 为命中，
 *   这是 DSH 会话日志里 `assistant/message.data.usage` 的实际含义。
 * @param table - {@link priceTableFor} 选出的价目表。
 * @param peak - 这次调用发生的时刻是否处于高峰时段。
 */
export function costOfUsage(usage, table, peak) {
  if (usage === null || typeof usage !== 'object') return 0
  const tier = peak ? 'peak' : 'offPeak'
  const hit = numberOrZero(usage.cacheReadTokens)
  const miss = numberOrZero(usage.inputTokens)
  const out = numberOrZero(usage.outputTokens)
  return (hit * table.hit[tier] + miss * table.miss[tier] + out * table.out[tier]) / 1e6
}

/** 仅接受有限非负数，日志里的脏字段按 0 计。 */
function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** 当前时段的中文名，用于提示文案。 */
export function windowLabel(peak) {
  return peak ? '高峰时段' : '空闲时段'
}

export { PEAK_WINDOWS, HOLIDAYS }
