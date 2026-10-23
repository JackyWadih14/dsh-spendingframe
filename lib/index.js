/**
 * dsh-spendingframe 宿主半：把「高峰/空闲 + 会话花费 + 今日花费」暴露成一个只读 HTTP 路由。
 *
 * 客户端半（client/client.js）只负责显示：它每 5 分钟拉一次
 * `GET /dsh-spendingframe/summary?session=<会话 id>`，因此金额只在宿主算一次，
 * 浏览器不需要接触会话日志，也不需要自己维护价目表。
 *
 * 路由注册在裸 webServer 上（exact 匹配优先于宿主自己的 `/api` 前缀），
 * 所以自己判断来源：只接受回环地址（或宿主声明的可信 authority）与同源页面，
 * 拒绝 DNS rebinding 页面与跨站请求。接口是只读的，不写入任何状态。
 */

import { buildSummary } from './summary.js'

export const name = 'dsh-spendingframe'

const ROUTE = '/dsh-spendingframe/summary'

export function apply(ctx) {
  // webServer 只在网页宿主里存在；没有它的组合（headless / acp 等）安静地不挂载。
  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(() => {
      const dispose = hostCtx.webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: (request, response) => { void handle(hostCtx, request, response) },
      })
      return () => { dispose() }
    }, 'dsh-spendingframe: /dsh-spendingframe/summary')
  })
}

async function handle(ctx, request, response) {
  if (refuseUntrusted(ctx, request, response)) return

  const method = request.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD') {
    sendJson(response, 405, { ok: false, error: '只支持 GET' })
    return
  }

  let sessionId = ''
  try {
    sessionId = new URL(request.url ?? '/', 'http://dsh.local').searchParams.get('session') ?? ''
  } catch {
    sessionId = ''
  }

  try {
    sendJson(response, 200, buildSummary({ sessionId }))
  } catch (error) {
    sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * 来源闸门。
 *
 * 首选宿主自己的登录门禁（Host Connection 的 `requestRejection`）：它同时做
 * Host/Origin 围栏与浏览器 cookie 校验，网页里的请求本来就带着它签发的 cookie
 * （宿主自己的 `/api` 也靠这一套），所以面板能读到数据，而本机其它未登录客户端
 * 会被 401 拒绝。
 *
 * 该服务在宿主启动早期可能还没就绪（dsh-market 就因为启动时取不到它而永久退化成
 * 无门禁），所以这里在**请求时**才查一次；确实没有这个服务时才退回到自己实现的
 * authority 围栏：只接受回环地址、宿主声明的可信 authority，以及同源页面。
 */
function refuseUntrusted(ctx, request, response) {
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
  const gate = connection?.requestRejection
  if (typeof gate === 'function') {
    let status
    try {
      status = gate.call(connection, request)
    } catch {
      status = 403 // 门禁抛错不等于放行
    }
    if (typeof status === 'number') {
      sendJson(response, status, {
        ok: false,
        error: status === 401 ? '需要先登录 DSH：请重新打开 dsh web 启动时打印的网址' : '请求来源不受信任，已拒绝',
      })
      return true
    }
    return false
  }
  return refuseByAuthority(ctx, request, response)
}

/**
 * 没有登录门禁时的兜底：回环地址 / 声明 authority / 同源页面。
 *
 * 要点是 `Host` 是页面无法伪造的头，所以 DNS rebinding（Origin 与 Host 都被换成
 * 攻击者的域名）会在这里被拒；桌面端转发代理会剥掉 host/origin，因此“头不存在”
 * 按放行处理——这与 dsh-market 的 sameOrigin 是同一套判断。
 */
function refuseByAuthority(ctx, request, response) {
  const host = request.headers.host
  if (request.headers['sec-fetch-site'] === 'cross-site') {
    sendJson(response, 403, { ok: false, error: '跨站请求已拒绝' })
    return true
  }
  if (typeof host === 'string' && host !== '' && !loopbackAuthority(host) && !trustedAuthority(host, trustedHosts(ctx))) {
    sendJson(response, 403, { ok: false, error: '请求来源不受信任，已拒绝' })
    return true
  }
  const origin = request.headers.origin
  if (origin !== undefined) {
    let sameHost = false
    try {
      sameHost = host === undefined || new URL(origin).host === host
    } catch {
      sameHost = false // 存在但无法解析（含 Origin: null）不算同源
    }
    if (!sameHost) {
      sendJson(response, 403, { ok: false, error: '跨站请求已拒绝' })
      return true
    }
  }
  return false
}

/** 宿主声明的额外 authority（`dsh web --trusted-host <name>`）；服务缺席时为空。 */
function trustedHosts(ctx) {
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
  const declared = connection?.trustedHosts
  return Array.isArray(declared) ? declared.filter((entry) => typeof entry === 'string') : []
}

/** `127.0.0.1` / `localhost` / `[::1]`（含端口）视为回环。 */
function loopbackAuthority(host) {
  const lower = host.toLowerCase()
  const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}

/** `host` 是否命中某条声明：带端口按完整 authority 比较，不带端口只比主机名。 */
function trustedAuthority(host, declared) {
  const actual = parseAuthority(host)
  if (actual === null) return false
  return declared.some((entry) => {
    const expected = parseAuthority(entry)
    if (expected === null) return false
    return expected.port === '' ? expected.hostname === actual.hostname : expected.host === actual.host
  })
}

/** 解析 `host[:port]`；必须原样往返，避免把 `evil.com/path` 当成合法声明。 */
function parseAuthority(value) {
  try {
    const url = new URL(`http://${value}`)
    const canonical = url.port === '' ? url.hostname : `${url.hostname}:${url.port}`
    return canonical === value.toLowerCase() ? url : null
  } catch {
    return null
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}
