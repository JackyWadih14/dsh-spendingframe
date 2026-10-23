/**
 * 读取 DSH 会话日志里的 token 用量。
 *
 * 会话日志位于 `<DSH_HOME>/sessions/<工作区>/<会话 id>/session.v4.jsonl.zstd`：
 * 追加写入的 zstd 多帧文件，每帧一到多行 JSON 记录。带用量的是
 * `assistant/message`，其 `data.usage` 为
 * `{ inputTokens(缓存未命中), cacheReadTokens(缓存命中), outputTokens, ... }`，
 * 模型在 `data.message.source.model`。
 *
 * 这里只做两件事：把文件读成用量记录，并缓存解析结果（按 mtime + size 失效），
 * 这样每分钟一次的轮询不会反复解压没变过的历史会话。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const LOG_SUFFIX = '.jsonl.zstd'
const LOG_PREFIX = 'session.v'

/** 解析 DSH home：显式配置 > `DSH_HOME` > `~/.dsh`。 */
export function resolveDshHome(configured, env = process.env) {
  const fromEnv = env?.DSH_HOME
  const selected = typeof configured === 'string' && configured.trim() !== ''
    ? configured.trim()
    : typeof fromEnv === 'string' && fromEnv.trim() !== ''
      ? fromEnv.trim()
      : join(homedir(), '.dsh')
  const expanded = selected === '~' ? homedir() : selected.startsWith('~/') || selected.startsWith('~\\') ? join(homedir(), selected.slice(2)) : selected
  return resolve(expanded)
}

/**
 * 列出全部会话日志文件。
 *
 * 目录层级由 DSH 决定，这里只认形状：任意两层目录下的 `session.v*.jsonl.zstd`。
 * 找不到（例如全新安装还没有会话）不是错误，返回空数组。
 */
export function listSessionLogs(home) {
  const root = join(home, 'sessions')
  const found = []
  let workspaces = []
  try {
    workspaces = readdirSync(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    const workspaceDir = join(root, workspace.name)
    let sessions = []
    try {
      sessions = readdirSync(workspaceDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const sessionDir = join(workspaceDir, session.name)
      let entries = []
      try {
        entries = readdirSync(sessionDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.startsWith(LOG_PREFIX) || !entry.name.endsWith(LOG_SUFFIX)) continue
        found.push({ path: join(sessionDir, entry.name), sessionId: session.name })
      }
    }
  }
  return found
}

/** 把追加写入的多帧 zstd 文件解成一整段文本；写坏的尾部帧直接放弃。 */
export function decodeLogFile(path) {
  const buffer = readFileSync(path)
  const offsets = []
  for (let i = 0; i + 4 <= buffer.length; i++) {
    if (buffer[i] === ZSTD_MAGIC[0] && buffer[i + 1] === ZSTD_MAGIC[1] && buffer[i + 2] === ZSTD_MAGIC[2] && buffer[i + 3] === ZSTD_MAGIC[3]) {
      offsets.push(i)
    }
  }
  const parts = []
  for (let i = 0; i < offsets.length; i++) {
    const end = i + 1 < offsets.length ? offsets[i + 1] : buffer.length
    try {
      parts.push(zstdDecompressSync(buffer.subarray(offsets[i], end)))
    } catch {
      // 最后一个帧可能正在被写入，或历史的坏帧：跳过而不是丢掉整个会话。
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

/**
 * 解析一个会话日志中的用量记录。
 *
 * 返回 `{ createdAt, parentSession, origin, delegationDepth, records }`：
 * 会话头（`type: "session"`）里的血缘字段用来把子智能体会话挂回父会话，
 * `createdAt` 用来排除可能的继承记录。
 *
 * 子智能体会话的头部长这样（本机实测）：
 *   {"type":"session","id":"150f49a5-…","parentSession":"session-79fa1914-…",
 *    "origin":"subagent","delegationDepth":1,"createdAt":…}
 * 普通会话没有 `parentSession`，`delegationDepth` 为 0；分支（fork）出来的会话
 * 同样是 0，因此只有 `origin === "subagent"` 或 `delegationDepth > 0` 才算子智能体。
 */
export function parseSessionLog(path) {
  const text = decodeLogFile(path)
  let header = null
  const records = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue // 追加写入时被截断的最后一行
    }
    if (record.type === 'session') {
      if (header === null) header = record
      continue
    }
    if (record.type !== 'assistant/message') continue
    const usage = record.data?.usage
    if (usage === null || typeof usage !== 'object') continue
    records.push({
      time: typeof record.time === 'number' ? record.time : null,
      model: typeof record.data?.message?.source?.model === 'string' ? record.data.message.source.model : '',
      usage,
    })
  }
  return {
    createdAt: typeof header?.createdAt === 'number' ? header.createdAt : null,
    parentSession: typeof header?.parentSession === 'string' && header.parentSession !== '' ? header.parentSession : null,
    origin: typeof header?.origin === 'string' ? header.origin : null,
    delegationDepth: typeof header?.delegationDepth === 'number' ? header.delegationDepth : 0,
    records,
  }
}

/** 已解析会话的缓存，键为文件路径。 */
const cache = new Map()
const MAX_CACHED_SESSIONS = 400

/** 读取（必要时重新解析）一个会话，命中缓存时不做任何解压。 */
export function readSessionLog(file) {
  const stat = statSync(file.path)
  const cached = cache.get(file.path)
  if (cached !== undefined && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.session
  }
  const parsed = parseSessionLog(file.path)
  const session = {
    sessionId: file.sessionId,
    path: file.path,
    createdAt: parsed.createdAt,
    parentSession: parsed.parentSession,
    origin: parsed.origin,
    delegationDepth: parsed.delegationDepth,
    records: parsed.records,
  }
  cache.set(file.path, { size: stat.size, mtimeMs: stat.mtimeMs, session })
  if (cache.size > MAX_CACHED_SESSIONS) {
    // Map 保持插入顺序：丢掉最早写入的条目，避免长期运行时无上限增长。
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  return session
}

/**
 * 读出所有会话的用量记录。
 *
 * 单个会话失败只记录在 `errors` 里，不影响其它会话与整体响应。
 */
export function collectSessions(home) {
  const files = listSessionLogs(home)
  const sessions = []
  const errors = []
  for (const file of files) {
    try {
      sessions.push(readSessionLog(file))
    } catch (error) {
      errors.push({ path: file.path, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { sessions, errors, fileCount: files.length }
}

/** 清空缓存（测试与诊断用）。 */
export function clearSessionCache() {
  cache.clear()
}
