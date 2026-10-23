# dsh-spendingframe

[![npm](https://img.shields.io/npm/v/dsh-spendingframe?label=npm)](https://www.npmjs.com/package/dsh-spendingframe)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)](package.json)

**DeepSeek API 峰谷时段 · 会话消耗 · 今日花费，常驻在 DSH 输入框下方的一个小条目里。**

A small DSH plugin that shows the current DeepSeek API price window (peak / off-peak),
the cost of the current session (subagent sessions included), and today's spend —
right next to DSH's context usage pill.

```
峰   ¥0.435   ¥1.208
↑     ↑        ↑
|     |        └── 今日花费（北京时间自然日，全部会话合计）
|     └─────────── 本会话花费（本会话 + 它派生的全部子智能体会话）
└───────────────── 当前计价时段：峰 / 谷
```

数字来自**本机会话日志**：不需要 API Key，不访问外网，不上传任何数据。

## 功能

- **峰 / 谷**：按 DeepSeek 官方分时价目判断当前处于高峰还是空闲时段，并自动跳过周末与中国法定节假日。
- **会话消耗**：本会话**加上它派生的所有子智能体（subagent）会话**的总花费 —— 子会话在父会话里本来是看不见的。
- **今日花费**：北京时间自然日内的全部会话合计。
- **跟随宿主**：颜色、字号、字体全部取用 DSH 自己的设计 token，跟随主题与字号设置。
- **原生手感**：与同排的「上下文使用情况」同一套交互 —— 悬停出小气泡，点击出完整明细。
- **零配置**：装好即用，每分钟自动刷新，也随页面重新加载立即刷新。

## 交互

与 DSH 原生「上下文使用情况」(`ContextMeter`) 一致：真 `<button>` 触发器、`aria-haspopup="dialog"`、
`aria-expanded` 随状态翻转、读屏可用。

**悬停** 200ms 后浮出小气泡，只有三项：

```
本会话消耗 ¥0.796
子智能体消耗 ¥0.815（3 个会话）
统计更新时间 2026-10-12 10:00
```

**点击**弹出完整信息框（`role="dialog"`，挂到 `document.body`）：

| 区块 | 内容 |
| --- | --- |
| 标题行 | 时段名（高峰时段 / 空闲时段）+ `峰`/`谷` + 会话合计 |
| 占比条 | 本会话 / 子智能体各一段，颜色与下方明细的色块对应 |
| 明细 | 本会话消耗、子智能体消耗、今日消耗、各自的 Token（命中 / 未命中 / 输出）、模型与花费、计费时段规则、统计更新时间 |
| 页脚 | 插件版本 |

再点一次、按 <kbd>Esc</kbd>、或点击别处收起。弹层贴在条目正上方居中，上方放不下时翻到下方，
并夹在视口内。

## 安装

插件没有构建步骤：`lib/` 是宿主半（ESM），`client/client.js` 是手写的客户端半（`__ModuleLoader__` 工厂包）。

### 方式一：从 npm 安装（推荐）

在 DSH 的插件管理里安装 `dsh-spendingframe`（版本 `^0.2.3`）；或者手工编辑当前 profile
（`<DSH_HOME>/profiles/<profile>/package.json`）：

```jsonc
{
  "dependencies": { "dsh-spendingframe": "^0.2.3" },
  "dsh": { "profile": { "bundles": [/* …已有的 bundle… */, "dsh-spendingframe"] } }
}
```

然后在 profile 目录里 `pnpm install`。

### 方式二：从源码目录安装（要改代码时用）

1. 克隆仓库到任意目录（目录名随意，下文用 `<插件目录>` 指代）：

   ```sh
   git clone https://github.com/JackyWadih14/dsh-spendingframe.git dsh-spendingframe
   ```
2. 在 DSH 的插件管理里以**本地目录**安装它；或者把上面那段 `dependencies` 改成
   `{ "dsh-spendingframe": "file:<本目录的绝对路径>" }` 再 `pnpm install`。

### 装完之后

重启 DSH：宿主半要注册路由，必须重启一次才会出现条目。之后只改客户端半的话，刷新页面即可。

> `file:` 目录依赖会被 pnpm 缓存：升级本插件时要**先移除再安装**，否则装上的还是旧副本。

卸载：从 `dsh.profile.bundles` 与依赖里去掉 `dsh-spendingframe`，再 `pnpm install`。插件不写配置、不留状态。

## 峰 / 谷怎么判定

北京时间 **周一至周五（不含中国法定节假日）09:00–12:00、14:00–18:00** 为高峰（`峰`），
其余时间 —— 工作日其余时段、周末、法定节假日全天 —— 为空闲（`谷`）。
区间取左闭右开：9:00 整算高峰，12:00 整算空闲。

调休上班的周末仍按空闲处理（规则以「周一至周五」为准）。
节假日表取自国务院办公厅通知：2024 年国办发明电〔2023〕7 号、2025 年国办发明电〔2024〕12 号、
2026 年国办发明电〔2025〕7 号。未收录的年份只按「工作日 + 时段」判定，不会报错。

## 花费怎么算

按官方分时价目（元 / 百万 tokens），**每一笔调用用它自己发生时刻的时段计价**，
所以跨过 9:00 / 12:00 / 14:00 / 18:00 时，历史金额不会因为现在的时段而漂移：

| 模型 | 输入·缓存命中 | 输入·缓存未命中 | 输出 |
| --- | --- | --- | --- |
| `deepseek-flash` | 空闲 0.02 / 高峰 0.04 | 空闲 1 / 高峰 2 | 空闲 4 / 高峰 8 |
| `deepseek-v4-pro` | 空闲 0.15 / 高峰 0.30 | 空闲 4.5 / 高峰 9 | 空闲 13.5 / 高峰 27 |

数据来自会话日志 `<DSH_HOME>/sessions/<工作区>/<会话>/session.v4.jsonl.zstd`
（`<DSH_HOME>` 默认 `~/.dsh`，可被环境变量覆盖）。日志是追加写入的多帧 zstd，插件按帧解压后读取
`assistant/message` 记录里的 `data.usage`：

| 字段 | 含义 |
| --- | --- |
| `inputTokens` | 缓存未命中的输入 tokens |
| `cacheReadTokens` | 缓存命中的输入 tokens |
| `outputTokens` | 输出 tokens |

模型 id 取自记录里的 `data.message.source.model`。未收录的模型退回 `deepseek-flash` 价目估算，
并在接口的 `assumedPricing` 里明确列出，界面上也会标注「按 flash 价目估算」。

## 子智能体的口径

会话日志第一条 `session` 记录带血缘信息：

| 字段 | 含义 |
| --- | --- |
| `origin: "subagent"` | 由子智能体（subagent / delegate）创建 |
| `delegationDepth` | 派生层数：顶层会话 0，子会话 1，孙会话 2…… |
| `parentSession` | 直接父会话 id，顶层会话没有该字段 |

`origin === "subagent"` **或** `delegationDepth > 0` 即视为子智能体会话。
父会话的消耗 = 自己的调用 + 全部后代会话（按 `parentSession` 广度优先遍历，带环保护）。

`fork` 出来的会话 `delegationDepth` 为 0 且没有 `origin`，**不会**并进原会话 ——
它是用户自己开的新会话，不是被隐藏的开销。今日花费本来就是全局口径，不受影响。

## 结构

| 部分 | 文件 | 作用 |
| --- | --- | --- |
| 插件入口（宿主） | `lib/index.js` | 注册只读路由 `GET /dsh-spendingframe/summary?session=<id>`，并做来源校验 |
| 计价规则 | `lib/pricing.js` | 峰谷判定、节假日表、价目表、金额与时段文案（纯函数） |
| 数据读取 | `lib/session-logs.js` | 多帧 zstd 日志解析、血缘提取、按 mtime 缓存 |
| 汇总 | `lib/summary.js` | 会话（含派生会话）与今日汇总，`summarize()` 是纯函数，便于测试 |
| 插件入口（浏览器） | `client/client.js` | 注册到 `conversation.composer.dock`，渲染条目、气泡与明细面板 |
| 插件声明 | `package.json` / `cordis.patch.yml` | 声明宿主半、客户端半与 DSH bundle 补丁 |

金额、峰谷与子智能体汇总**全部在宿主算**，浏览器只负责显示：页面不需要碰日志，也不需要维护价目表。

### 为什么条目能排在「上下文使用情况」右侧

这一行是 `<div class="dock">{槽位}<ContextMeter/></div>`，槽位永远渲染在上下文占用之前。
但槽位出口是 `display: contents`，本插件的根元素因此是 `.dock` 这个 flex 容器的直接 flex item，
用 CSS `order: 1`（槽位内其他条目与 ContextMeter 都是 0）就排到了它们右侧，且不占用、不遮挡原生条目。

### 安全

路由挂在裸 `webServer` 上（exact 匹配，优先于宿主自己的 `/api` 前缀围栏），所以插件自己判断来源：

1. 能拿到宿主 `connection` 服务时，直接复用它的 `requestRejection`（与浏览器同一套签名 cookie 门禁）；
2. 拿不到时退回内置围栏：只接受回环地址（`127.0.0.1` / `localhost` / `[::1]`）或宿主声明的可信 authority，
   拒绝 `Sec-Fetch-Site: cross-site` 与 `Origin` 不同源的请求。

接口只读，不写任何状态；插件不保存任何数据，也不向外发送任何数据。

## 接口

`GET /dsh-spendingframe/summary?session=<会话 id>`（省略 `session` 时只返回今日汇总）：

```json
{
  "ok": true, "at": 1791697077790, "peak": false, "window": "空闲时段",
  "nextChangeInMs": 69721543, "version": "0.2.4",
  "session": {
    "found": true, "id": "session-79fa1914-…", "cost": 1.611052, "calls": 112,
    "tokens": { "hit": 12345, "miss": 6789, "out": 4321 }, "lastAt": 1791697070000,
    "own":       { "cost": 0.796551, "calls": 85, "tokens": { "hit": 8000, "miss": 4000, "out": 3000 } },
    "subagents": { "cost": 0.814501, "calls": 27, "sessions": 3, "tokens": { "hit": 4345, "miss": 2789, "out": 1321 } }
  },
  "today":   { "cost": 2.601585, "calls": 125, "sessions": 5, "tokens": { "hit": 8215421, "miss": 618508, "out": 129494 } },
  "models": [{ "id": "deepseek-flash", "calls": 112, "cost": 1.611052 }],
  "assumedPricing": [], "scan": { "files": 7, "errors": 0 }
}
```

`session.cost` 是「本会话 + 全部派生会话」的总数，`own` 与 `subagents` 是它的两个组成部分
（`own.cost + subagents.cost === cost`）。

## 开发与测试

客户端半是手写的 `__ModuleLoader__` 工厂包（`window.__ModuleLoader__.load({ id, factory })`），
**没有构建步骤**：改完 `client/client.js` 刷新页面即生效（`dsh-client-hmr` 会轮询文件并自动发布新的
bundle rev）。宿主半是 ESM，被 Node 模块缓存，改 `lib/*.js` 后需要重启 DSH。

仓库自带两个校验脚本，只需要 Node 22+，不需要安装任何依赖：

```sh
npm test          # 35 项宿主断言 + 91 项客户端断言
npm run test:real # 额外读本机会话日志，断言真实血缘与金额（只在装了 DSH 的机器上有意义）
```

| 脚本 | 覆盖内容 |
| --- | --- |
| `tests/balance-probe.mjs` | 峰谷时段边界（含 9/12/14/18 点与节假日）、价目表、北京时间日界、会话血缘汇总（合成谱系 R→A→A1，fork 不并入） |
| `tests/client-harness-test.mjs` | 用假 `react`（真 `useState`/`useRef`/`useEffect`）、假 `react-dom`、假 `document`/`window` 驱动真实 bundle：悬停三行气泡、点击面板、`Esc` 与点击外部收起、弹层定位数学、金额与 Token 格式化 |

## 版本历史

| 版本 | 变化 |
| --- | --- |
| 0.1.0 | 首个版本：峰 / 谷、本会话消耗、今日花费，5 分钟刷新，跟随宿主字体与配色 |
| 0.2.0 | 子智能体会话的花费并入父会话；悬停高亮与原生条目一致 |
| 0.2.1 | 悬停只显示两项消耗与统计时间，完整明细改为点击弹出，对齐原生「上下文使用情况」；悬停延迟、明细色块等细节与原生一致 |
| 0.2.2 | 发布到 npm：包名改为 `dsh-spendingframe`（原 `dshbalance` 被 npm 判定与已有的 `dsh-balance` 过于相似），只读路由随之改为 `/dsh-spendingframe/summary` |
| 0.2.3 | 名字全仓统一为 `dsh-spendingframe`：源码目录、README 标题、面板页脚、日志前缀不再使用旧品牌名 |
| 0.2.4 | 刷新间隔由 5 分钟缩短到 1 分钟（数据源是本地会话日志，落盘即带用量，所以缩短间隔真的能更快看到变化） |

## 许可

[MIT](LICENSE)
