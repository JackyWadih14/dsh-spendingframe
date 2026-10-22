/**
 * DSHBalance 客户端半（包名 dshbalance，手写的 __ModuleLoader__ 工厂包，无需构建步骤）。
 *
 * 作用：在会话输入框下沿的 `conversation.composer.dock`（“上下文占用”那一行）
 * 追加一个条目，排在上下文占用右侧，从左到右显示：
 *
 *     峰 / 谷   +   会话消耗(¥)   +   今日消耗(¥)
 *
 * 交互完全照抄同排的「上下文使用情况」(ContextMeter)：
 *
 *   · 悬停：延迟 200ms 后在正上方浮出一个小气泡（同款 tooltip 底色/圆角/字号，
 *     `white-space: pre-line`），里面只有三项——本会话消耗、子智能体消耗、统计更新时间；
 *   · 点击：浮出完整信息框（同款 menu 底色、--dsw-radius-lg 圆角、elevation 阴影、
 *     12px/20px 文字），带本会话/子智能体占比条与逐项明细；再点一次、按 Esc、
 *     或点击别处都会收起。
 *
 * 金额、峰谷判定与子智能体汇总都在宿主算，浏览器只负责显示。外观全部取用应用
 * 自己的 token，因此跟随主题与字体设置。
 */
window.__ModuleLoader__.load({
  id: 'dshbalance',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    // react-dom 只用来把弹层挂到 body（原生 ContextMeter 也是这么做的）。
    // 取不到时退化为就地渲染，插件仍然能用。
    let reactDom = null
    try {
      reactDom = require('react-dom')
    } catch {
      reactDom = null
    }

    /** 客户端插件名（与 cordis 的 name 一致）。 */
    const name = 'dshbalance'
    /** 只依赖插槽服务。 */
    const inject = ['slots']
    /** 刷新间隔：5 分钟。 */
    const REFRESH_MS = 5 * 60 * 1000
    /** 宿主路由。 */
    const ROUTE = '/dshbalance/summary'
    /** 悬停多久后浮出小气泡（原生 ContextMeter 的 Tooltip 用的是 delayMs: 200）。 */
    const HOVER_DELAY_MS = 200
    /** 距锚点 8px、距视口边缘 12px（原生 useAnchoredPosition 同值）。 */
    const GAP = 8
    const MARGIN = 12

    /**
     * 相对页面挂载点解析接口路径（与 dsh-market 同样的理由：反向代理把 dsh
     * 挂在子路径下时，根绝对路径会打偏）。
     */
    function api(path) {
      const relative = String(path).replace(/^\/+/, '')
      if (typeof document === 'undefined') return `/${relative}`
      return new URL(relative, document.baseURI).pathname
    }

    /**
     * 人民币金额：按数量级选择小数位，小额花费也看得见，大额不啰嗦。
     * 小于 1 元保留 3 位（DeepSeek 单次调用常在分级），1 元以上 2 位。
     */
    function money(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '¥0.000'
      if (value >= 1000) return `¥${Math.round(value)}`
      if (value >= 100) return `¥${value.toFixed(1)}`
      if (value >= 1) return `¥${value.toFixed(2)}`
      return `¥${value.toFixed(3)}`
    }

    /** 北京时间 HH:MM。 */
    function beijingClock(timeMs) {
      if (typeof timeMs !== 'number' || !Number.isFinite(timeMs)) return ''
      const shifted = new Date(timeMs + 8 * 60 * 60 * 1000)
      return shifted.toISOString().slice(11, 16)
    }

    /** 北京时间 YYYY-MM-DD HH:MM（悬停气泡里的“统计更新时间”）。 */
    function beijingStamp(timeMs) {
      if (typeof timeMs !== 'number' || !Number.isFinite(timeMs)) return '未知'
      const shifted = new Date(timeMs + 8 * 60 * 60 * 1000)
      const iso = shifted.toISOString()
      return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`
    }

    /** 紧凑 token 计数（照原生 ContextMeter 的 formatTokens：K / M，二位有效）。 */
    function compactTokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '0'
      const scaled = (candidate) => (candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10))
      if (value < 1e3) return String(value)
      if (value < 1e6) return `${scaled(value / 1e3)}K`
      return `${scaled(value / 1e6)}M`
    }

    /** `命中 / 未命中 / 输出` 一行的 token 摘要。 */
    function tokenLine(tokens) {
      if (tokens === undefined || tokens === null) return '—'
      return `命中 ${compactTokens(tokens.hit)} / 未命中 ${compactTokens(tokens.miss)} / 输出 ${compactTokens(tokens.out)}`
    }

    /** 子智能体数量（0 表示这个会话没有派生会话）。 */
    function subagentCount(data) {
      const count = data?.session?.subagents?.sessions
      return typeof count === 'number' && count > 0 ? count : 0
    }

    /**
     * 悬停气泡：要的就是三项，不多不少——两个消耗加统计时间。
     * 用 `\n` 换行，气泡本身是 `white-space: pre-line`（与原生 Tooltip 一致）。
     */
    function hoverLabel(data, stale) {
      const count = subagentCount(data)
      const suffix = count > 0 ? `（${count} 个会话）` : ''
      return [
        `本会话消耗 ${money(data.session?.own?.cost)}`,
        `子智能体消耗 ${money(data.session?.subagents?.cost)}${suffix}`,
        `统计更新时间 ${beijingStamp(data.at)}${stale === true ? '（刷新失败，显示上次结果）' : ''}`,
      ].join('\n')
    }

    /** 完整信息框的标题行：当前时段 + 标记 + 会话合计。 */
    function panelHeader(data) {
      const peak = data.peak === true
      return {
        title: peak ? '高峰时段' : '空闲时段',
        mark: peak ? '峰' : '谷',
        figures: `会话合计 ${money(data.session?.cost)}`,
      }
    }

    /**
     * 完整信息框的逐项明细（`dt`/`dd` 成对，顺序即显示顺序）。
     * 前两项带 `tint`：与占比条同色的 8px 小方块（原生 ContextMeter 的 .swatch）。
     */
    function panelRows(data) {
      const session = data.session ?? {}
      const own = session.own ?? {}
      const derived = session.subagents ?? {}
      const today = data.today ?? {}
      const rows = [
        { label: '本会话消耗', value: `${money(own.cost)}（${own.calls ?? 0} 次调用）`, tint: 'var(--dsw-static-neutral-bluish-400)' },
        { label: '子智能体消耗', value: `${money(derived.cost)}（${derived.sessions ?? 0} 个会话 / ${derived.calls ?? 0} 次调用）`, tint: '#a78bfa' },
        { label: '今日消耗', value: `${money(today.cost)}（${today.sessions ?? 0} 个会话 / ${today.calls ?? 0} 次调用）` },
        { label: '本会话 Token', value: tokenLine(own.tokens) },
        { label: '子智能体 Token', value: tokenLine(derived.tokens) },
      ]
      if (Array.isArray(data.models) && data.models.length > 0) {
        rows.push({
          label: '模型',
          value: data.models.map((model) => `${model.id} ${money(model.cost)}（${model.calls} 次）`).join('、'),
        })
      }
      rows.push({ label: '计费时段', value: '工作日 9:00–12:00、14:00–18:00（法定节假日除外）' })
      rows.push({ label: '统计更新时间', value: beijingStamp(data.at) })
      if (Array.isArray(data.assumedPricing) && data.assumedPricing.length > 0) {
        rows.push({ label: '按 flash 价目估算', value: data.assumedPricing.join('、') })
      }
      return rows
    }

    /** 占比条的分段：本会话 vs 子智能体（都为零时给一段中性色）。 */
    function panelSegments(data) {
      const own = data.session?.own?.cost ?? 0
      const derived = data.session?.subagents?.cost ?? 0
      const total = own + derived
      if (!(total > 0)) return [{ key: 'total', width: 100, tint: 'var(--dsw-alias-label-tertiary)' }]
      return [
        { key: 'own', width: (own / total) * 100, tint: 'var(--dsw-static-neutral-bluish-400)' },
        { key: 'subagents', width: (derived / total) * 100, tint: '#a78bfa' },
      ].filter((part) => part.width > 0)
    }

    /**
     * 弹层定位（纯函数，便于断言）：默认贴锚点上方居中，顶部放不下就翻到下方，
     * 左右夹在视口里 —— 与原生 useAnchoredPosition({ side: 'top', gap: 8, margin: 12 }) 同规则。
     */
    function placement(anchor, panel, viewport, options) {
      const gap = options?.gap ?? GAP
      const margin = options?.margin ?? MARGIN
      const width = Math.min(panel.width, Math.max(0, viewport.width - margin * 2))
      const furthest = Math.max(margin, viewport.width - width - margin)
      const left = Math.min(Math.max(anchor.left + anchor.width / 2 - width / 2, margin), furthest)
      let top = anchor.top - gap - panel.height
      if (top < margin) top = Math.min(anchor.bottom + gap, Math.max(margin, viewport.height - panel.height - margin))
      return { left: Math.round(left), top: Math.round(top), width: Math.round(width) }
    }

    /**
     * 把弹层贴到锚点上方。首次渲染先隐藏（visibility: hidden），量到尺寸后才定位；
     * 之后跟着窗口尺寸与滚动重新定位 —— 原生 useAnchoredPosition 的做法。
     */
    function useAbovePosition(visible, mode, anchorRef, panelRef) {
      const [position, setPosition] = React.useState(null)
      React.useEffect(() => {
        if (visible !== true || typeof document === 'undefined' || typeof window === 'undefined') return undefined
        const place = () => {
          const anchor = anchorRef.current
          const panel = panelRef.current
          if (anchor === null || anchor === undefined || panel === null || panel === undefined) return
          if (typeof anchor.getBoundingClientRect !== 'function' || typeof panel.getBoundingClientRect !== 'function') return
          setPosition(placement(
            anchor.getBoundingClientRect(),
            panel.getBoundingClientRect(),
            { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
            // 小气泡贴得更近一点，与原生 Tooltip 的观感一致。
            { gap: mode === 'panel' ? GAP : 6, margin: MARGIN },
          ))
        }
        place()
        window.addEventListener('resize', place)
        window.addEventListener('scroll', place, true)
        return () => {
          window.removeEventListener('resize', place)
          window.removeEventListener('scroll', place, true)
        }
      }, [visible, mode])
      return visible === true ? position : null
    }

    /** 无障碍名称与悬停提示同一口径。 */
    function ariaLabel(data) {
      const count = subagentCount(data)
      const scope = count > 0 ? `，含 ${count} 个子智能体会话` : ''
      return `${data.peak === true ? '高峰' : '空闲'}时段，会话消耗 ${money(data.session?.cost)}${scope}，今日消耗 ${money(data.today?.cost)}。点击查看明细`
    }

    // --- 样式：逐条对应原生 ContextMeter / Tooltip / 面板的 token -------------

    const triggerStyle = (highlighted) => ({
      borderRadius: 'var(--dsw-radius-sm)',
      color: highlighted ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-tertiary)',
      fontFamily: 'inherit',
      fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
      fontVariantNumeric: 'tabular-nums',
      lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
      whiteSpace: 'nowrap',
      cursor: 'pointer',
      background: highlighted ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
      border: 'none',
      flex: 'none',
      alignItems: 'center',
      gap: '6px',
      padding: '1px 8px',
      display: 'inline-flex',
    })

    const rootStyle = {
      // order:1 是「放到上下文占用右边」的唯一办法：这一行的结构是
      //   <div class="dock">{renderSlot("conversation.composer.dock")}<ContextMeter/></div>
      // 槽位永远渲染在 ContextMeter 之前；但槽位出口是 display:contents
      // （见 dsh-client-ui-renderer 的 SlotOutlet），我们的根元素因此是 .dock
      // 这个 flex 容器的直接 flex item，用 order 就能排到 order:0 的上下文占用之后。
      order: 1,
      flex: 'none',
      display: 'inline-flex',
    }

    // 悬停小气泡：原生 Tooltip 的 .bubble
    const bubbleStyle = (position) => ({
      display: 'inline-flex',
      alignItems: 'center',
      gap: '8px',
      position: 'fixed',
      zIndex: 1100,
      width: 'max-content',
      maxWidth: '50vw',
      padding: '3px 7px',
      borderRadius: 'var(--dsw-radius-sm)',
      background: 'var(--dsw-alias-tooltip-bg)',
      color: 'var(--dsw-static-neutral-bluish-00)',
      fontSize: '13px',
      lineHeight: '20px',
      whiteSpace: 'pre-line',
      overflowWrap: 'break-word',
      pointerEvents: 'none',
      ...(position ?? { visibility: 'hidden', left: 0, top: 0 }),
    })

    // 完整信息框：原生 ContextMeter 的 .panel
    const panelStyle = (position) => ({
      zIndex: 1100,
      boxSizing: 'border-box',
      borderRadius: 'var(--dsw-radius-lg)',
      background: 'var(--dsw-specific-menu)',
      width: 'min(300px, 100vw - 24px)',
      backdropFilter: 'var(--dsw-menu-backdrop-filter)',
      boxShadow: 'var(--dsw-elevation-prominent)',
      color: 'var(--dsw-alias-label-secondary)',
      cursor: 'default',
      border: 0,
      padding: '12px',
      fontSize: '12px',
      lineHeight: '20px',
      position: 'fixed',
      ...(position ?? { visibility: 'hidden', left: 0, top: 0 }),
    })

    const panelHeaderStyle = { display: 'flex', alignItems: 'center', gap: '6px' }
    const panelHeadlineStyle = { color: 'var(--dsw-alias-label-tertiary)' }
    const panelPercentStyle = { color: 'var(--dsw-alias-label-primary)', fontWeight: 500 }
    const panelFiguresStyle = { fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-primary)', marginLeft: 'auto', fontWeight: 500 }
    const panelBarStyle = {
      background: 'var(--dsw-alias-interactive-bg-hover)',
      borderRadius: '999px',
      gap: '1px',
      height: '4px',
      margin: '10px 0 12px',
      display: 'flex',
      overflow: 'hidden',
    }
    const panelRowsStyle = { margin: '6px 0 0' }
    const panelRowStyle = { justifyContent: 'space-between', alignItems: 'center', gap: '12px', padding: '2px 0', display: 'flex' }
    const panelDtStyle = { color: 'var(--dsw-alias-label-secondary)' }
    /** 明细行前的 8px 色块（原生 ContextMeter 的 .swatch，颜色由行数据给）。 */
    const panelSwatchStyle = { verticalAlign: 'baseline', borderRadius: '2px', width: '8px', height: '8px', marginRight: '6px', display: 'inline-block' }
    const panelDdStyle = { fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-primary)', margin: 0, textAlign: 'right' }
    const panelFooterStyle = { color: 'var(--dsw-alias-label-tertiary)', marginTop: '8px', textAlign: 'right' }

    /** 那一行里的一个条目；没有数据时什么都不渲染，避免闪烁或占位。 */
    function BalanceEntry(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : ''
      // useState 顺序：[data, stale, hovered, open, position(在 useAbovePosition 里)]
      const [data, setData] = React.useState(null)
      const [stale, setStale] = React.useState(false)
      const [hovered, setHovered] = React.useState(false)
      const [open, setOpen] = React.useState(false)
      const rootRef = React.useRef(null)
      const bubbleRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const hoverTimer = React.useRef(null)

      React.useEffect(() => {
        let alive = true
        const load = () => {
          const query = sessionId === '' ? '' : `?session=${encodeURIComponent(sessionId)}`
          fetch(api(ROUTE) + query, { cache: 'no-store' })
            .then((response) => {
              if (!response.ok) throw new Error(`HTTP ${response.status}`)
              return response.json()
            })
            .then((payload) => {
              if (!alive) return
              if (payload && payload.ok === true) {
                setData(payload)
                setStale(false)
              } else {
                setStale(true)
              }
            })
            .catch((error) => {
              if (!alive) return
              setStale(true)
              console.warn('[DSHBalance] 读取失败：', error)
            })
        }
        load()
        const timer = setInterval(load, REFRESH_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [sessionId])

      // 点击后：Esc 或点击别处收起（原生 useDismissOnOutsidePointer 同样的判断）。
      React.useEffect(() => {
        if (open !== true || typeof document === 'undefined') return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        const onPointerDown = (event) => {
          const root = rootRef.current
          const panel = panelRef.current
          if (root !== null && root !== undefined && typeof root.contains === 'function' && root.contains(event.target)) return
          if (panel !== null && panel !== undefined && typeof panel.contains === 'function' && panel.contains(event.target)) return
          setOpen(false)
        }
        document.addEventListener('keydown', onKeyDown)
        document.addEventListener('pointerdown', onPointerDown, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown)
          document.removeEventListener('pointerdown', onPointerDown, true)
        }
      }, [open])

      // 卸载时清掉悬停计时器，避免在已消失的组件上 setState。
      React.useEffect(() => () => {
        if (hoverTimer.current !== null) clearTimeout(hoverTimer.current)
      }, [])

      const visible = open === true || hovered === true
      const mode = open === true ? 'panel' : 'hover'
      const position = useAbovePosition(visible, mode, rootRef, open === true ? panelRef : bubbleRef)

      if (data === null) return null

      const mark = data.peak === true ? '峰' : '谷'

      const trigger = React.createElement(
        'button',
        {
          type: 'button',
          'aria-label': ariaLabel(data),
          'aria-haspopup': 'dialog',
          'aria-expanded': open === true,
          onClick: () => {
            setHovered(false)
            setOpen(!open)
          },
          onMouseEnter: () => {
            if (open === true) return
            if (hoverTimer.current !== null) clearTimeout(hoverTimer.current)
            hoverTimer.current = setTimeout(() => {
              hoverTimer.current = null
              setHovered(true)
            }, HOVER_DELAY_MS)
          },
          onMouseLeave: () => {
            if (hoverTimer.current !== null) {
              clearTimeout(hoverTimer.current)
              hoverTimer.current = null
            }
            setHovered(false)
          },
          style: triggerStyle(visible),
        },
        React.createElement('span', null, mark),
        React.createElement('span', null, money(data.session?.cost)),
        React.createElement('span', null, money(data.today?.cost)),
      )

      const hoverBubble = open !== true && hovered === true
        ? React.createElement(
          'div',
          { ref: bubbleRef, role: 'tooltip', style: bubbleStyle(position) },
          React.createElement('span', { style: { minWidth: 0 } }, hoverLabel(data, stale)),
        )
        : null

      const header = panelHeader(data)
      const panel = open === true
        ? portal(React.createElement(
          'div',
          {
            ref: panelRef,
            role: 'dialog',
            'aria-label': `${header.title}消耗明细`,
            style: panelStyle(position),
          },
          React.createElement(
            'div',
            { style: panelHeaderStyle },
            React.createElement('span', { style: panelHeadlineStyle }, header.title),
            React.createElement('span', { style: panelPercentStyle }, header.mark),
            React.createElement('span', { style: panelFiguresStyle }, header.figures),
          ),
          React.createElement(
            'div',
            { style: panelBarStyle },
            panelSegments(data).map((segment) => React.createElement('div', {
              key: segment.key,
              style: { background: segment.tint, borderRadius: '1px', flex: 'none', minWidth: '2px', height: '100%', width: `${segment.width}%` },
            })),
          ),
          React.createElement(
            'dl',
            { style: panelRowsStyle },
            panelRows(data).map((row) => React.createElement(
              'div',
              { key: row.label, style: panelRowStyle },
              React.createElement(
                'dt',
                { style: panelDtStyle },
                row.tint === undefined
                  ? null
                  : React.createElement('span', { 'aria-hidden': true, style: { ...panelSwatchStyle, background: row.tint } }),
                row.label,
              ),
              React.createElement('dd', { style: panelDdStyle }, row.value),
            )),
          ),
          typeof data.version === 'string' && data.version !== ''
            ? React.createElement('div', { style: panelFooterStyle }, `DSHBalance v${data.version}`)
            : null,
        ))
        : null

      return React.createElement(
        'span',
        { ref: rootRef, style: rootStyle },
        trigger,
        hoverBubble,
        panel,
      )
    }

    /** 有 body 且能 require 到 react-dom 时，弹层挂到 body（原生同款做法）。 */
    function portal(node) {
      if (reactDom !== null && typeof reactDom.createPortal === 'function' && typeof document !== 'undefined' && document.body) {
        return reactDom.createPortal(node, document.body)
      }
      return node
    }

    function apply(ctx) {
      // 插槽可能比本插件晚出现：inject 会等到它存在再注册。
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'balance',
        // 这一行 = [槽位里的条目（官方 stats 是 order 0）, 槽位之后渲染的 ContextMeter]，
        // 两边的 order 都是 0；我们取 1，于是排在「会话统计」和「上下文使用情况」右侧。
        order: 1,
      }, BalanceEntry))
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    // 给 tools/client-harness-test.mjs 的纯函数断言留个口子（不参与运行时逻辑）。
    exports.__test = { money, beijingClock, beijingStamp, compactTokens, tokenLine, hoverLabel, panelRows, panelHeader, panelSegments, placement, ariaLabel }
    return module.exports
  },
})
