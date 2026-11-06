# dsh-xhs-evaluator — frozen design contract

小红书图文笔记评估：DSH 侧边栏内置浏览器里的「悬浮球」插件。
点击悬浮球 → 填入想发布的图文 → 调用 N 个 DSH 宿主模型 → 预测阅读量/点赞/收藏/评论
→ 数据差时给出「调整方向」（只给方向，绝不代写内容）。

Package: `@local/dsh-xhs-evaluator` · row id: `dsh-xhs-evaluator` · version `0.2.1`.

## Runtime path (do not change)

```
Electron <webview>  (DSH 右侧内置浏览器, Desktop)
  │ client.js：扫描 webview[data-sidebar-browser-frame="webview"]
  │            site gate：URL 非 xiaohongshu.com 白名单则不注入（URL 不可读时交给页面脚本）
  │            executeJavaScript 注入 lib/page-script.js（悬浮球 + 面板）
  │            每 400ms 轮询 window.__DSH_XHS_PAGE__.poll()
  ▼
DSH renderer：client.js fetch 同源 /xhs/*（不经过被访问页面，页面永不持有 token）
  ▼
Host：index.js → lib/service.js → lib/routes.js (ctx.webServer)
      → lib/llm.js (ctx.llm: prepareCall/stream, reasoning off) → N 个模型并行
      → lib/evaluate.js (纯函数：归一化 + 汇总 + 判定)
```

`page-script.js` **不做任何网络请求**；模型调用全部在 Host。

## Host wiring (v0.2.1)

`index.js` declares `inject = ['llm', 'webServer']`. The web-server dependency is a
hard injection, not a best-effort `ctx.get('webServer')`: profile bundle rows mount
before the web-server service is constructed, so a synchronous route registration
inside `apply` observes `undefined` and silently skips every `/xhs/*` route (the
page translator avoids the race only because it registers its routes after an
`await`). With the injection in place Cordis calls `apply` once the service exists,
so the bridge always mounts; `test/index.test.mjs` locks the contract in.

## Site gate (v0.2.0)

The ball is Xiaohongshu-only by default. The allowlist is a pure hostname check
(`lib/hosts.js`, `isXhsHost`): `xiaohongshu.com` and `*.xiaohongshu.com` (so
`www.` and `creator.`), case-insensitive, tolerating a port and a trailing dot.
Lookalikes (`xiaohongshu.com.evil.com`, `notxiaohongshu.com`, `xiaohongshu.com.cn`)
are **not** allowed. SPA route changes (`pushState`) keep the origin, so they
never flip the decision; a full cross-site navigation unloads the controller.
No extra network request, no site storage/cookie access is added.

Two enforcement layers, both required:

1. `client.js` — reads `webview.getURL()` (fallback `webview.src`); a readable
   non-http(s) URL is skipped, a readable foreign host is skipped and logged as
   `inject-skip`. When no URL is readable yet, injection proceeds and layer 2
   decides (never block a real XHS page because the URL was momentarily blank).
2. `page-script.js` — `ensureUI()` is gated first: outside the allowlist it
   returns `null`, so no Shadow DOM host and no node is ever created. The
   decision uses `location`, falling back to the URL the client handed over at
   injection time (`window.__DSH_XHS_INJECT_URL__`) or through
   `configure({ url })`. When neither is readable (`about:blank`) the gate is
   "defer" (one-shot retry on `DOMContentLoaded`/`load`/`pageshow`, plus
   `configure()`), not a permanent block.

Config override: `allowAllHosts: true` restores the old "any page shows the
ball" behaviour. `normalizeConfig` only accepts the boolean `true`; the value is
published by `/xhs/state` and delivered to the page through the existing
`configure()` channel (no new protocol).

### Injected-script updates

The host stamps the served source with a content hash (`var BUILD = '<sha1[0..12]>'`, replacing the
`__DSH_XHS_BUILD__` placeholder) and publishes the same hash as `/xhs/state.build`. The client half
compares it with `window.__DSH_XHS_PAGE__.build` on every poll and, on a mismatch, destroys the stale
controller (`destroy()` must also delete the `window.__DSH_XHS_PAGE__` / `__DSH_XHS_TEST__` globals so
the fresh copy really boots) and re-injects — throttled to one swap per webview per 5s. Editing
`page-script.js` therefore reaches open browser pages without reloading the DSH page or restarting.

## Host HTTP routes (all registered with `kind: 'exact'`)

| method | path | body | response |
| --- | --- | --- | --- |
| GET | `/xhs/hosted.js` | – | page-script source with its content hash stamped in, `text/javascript`, no-store |
| GET | `/xhs/state` | – | `{ ok:true, version, ensemble, routes:[{id,label}], limits:{title:20,body:1000,tags:10}, ball:{side,bottom}, allowAllHosts, build }` |
| POST | `/xhs/evaluate` | `{title,body,tags:[],niche,fans,models?:1..3}` | `{ ok:true, report: Report, ms, models:[{label,ok,ms,error?}] }` |
| POST | `/xhs/revise` | `{ draft:{title,body,tags:[],niche,fans}, report:Report }` | `{ ok:true, revision: Revision, ms, model:{label,ms} }` |
| POST | `/xhs/log` | `{event,data}` | `{ ok:true }` (host appends `~/.dsh/xhs-evaluator.log`) |

Errors: HTTP 400 for bad input/JSON, 502 for model failure, body `{ ok:false, error, message }`.

Input limits: title ≤ 20 chars (截断), body 1–1000 chars (必填), tags ≤ 10, niche ≤ 40.
`fans` ∈ `新号(<1000) | 1k-1w | 1w-10w | 10w+ | 100w+` (自由字符串也可).

## Report JSON (host → page, sole presentation contract)

```json
{
  "version": 1,
  "verdict": "viral|strong|average|weak|poor",
  "verdictLabel": "有爆款相|中上|中规中矩|偏弱|很差",
  "summary": "一句话结论，30-60字",
  "confidence": 0.62,
  "predicted": {
    "reads":    { "low": 1200, "mid": 2600, "high": 5200 },
    "likes":    { "low": 40,  "mid": 90,  "high": 190 },
    "collects": { "low": 25,  "mid": 60,  "high": 130 },
    "comments": { "low": 3,   "mid": 8,   "high": 20 },
    "engagementRate": 0.043
  },
  "signals": [ { "label": "标题钩子", "level": "good|warn|bad", "note": "≤24字" } ],
  "directions": [ { "title": "≤10字", "why": "≤40字", "action": "≤60字，只给方向" } ],
  "guide": {
    "intro": "≤40字：这次最该先改的一件事",
    "sections": [
      { "key": "title",  "name": "标题",     "advice": "≤90字：标题怎么选", "example": "≤50字：具体标题样例" },
      { "key": "cover",  "name": "封面",     "advice": "…", "example": "…" },
      { "key": "images", "name": "内部图",   "advice": "…", "example": "…" },
      { "key": "text",   "name": "文字内容", "advice": "…", "example": "…" },
      { "key": "tags",   "name": "标签",     "advice": "…", "example": "…" }
    ]
  },
  "modelCount": 2,
  "spread": 0.18,
  "ts": 1699999999999
}
```

Rules: integers ≥ 0, `low <= mid <= high`; `engagementRate` 0..1; at most 6 signals; at most 5
directions; `directions` non-empty when verdict ∈ {weak,poor}; never contains copy-paste-ready
titles/openings/paragraphs (prompt-enforced + `sanitizeDirections` clamps every field).

### 修改指引（`guide`）— 允许举例，但示例必须带括号

This is the ONLY place where concrete copy is allowed, and only as a labelled example:

- Fixed keys and names: `title`/标题, `cover`/封面, `images`/内部图, `text`/文字内容, `tags`/标签.
- `sections` must be exactly these five, in that order, whenever `guide` is present.
- `advice` = 怎么选/怎么改（人群、场景、句式、信息层级、数量、避坑），**≤90 字**。
- `example` = 一条可照着改的**举例**，**≤50 字**，允许具体标题/封面文案/标签组合；`text` 的
  example 最多一句话，不得是整段成稿。前端统一渲染为全角括注 `（例：…）`，宿主不拼括号。
- 模型可省略某个 `example`；`advice` 不可为空。宿主对两个字段都做硬截断。
- 多模型时：取「质量最接近中位数」的模型那份 guide 为主，缺的 section 按 route 顺序从其它模型补齐；
  补齐后不足 3 个 section 视为没有 guide，报告里输出 `guide: null`（前端整块隐藏）。

`Report.guide` = `{ intro, sections:[{key,name,advice,example?}] } | null`。

`ModelReport` 相应增加 `guide` 字段（同结构，可为 null）：

```js
{ ..., guide: { intro, sections:[{key,name,advice,example}] } | null }
```

## Revision JSON（一键整改：host → page）

```json
{
  "title": "≤20字：整改后的标题",
  "body": "≤1000字：整改后的正文（保留分段换行）",
  "tags": ["≤10个：整改后的标签，不带 #"],
  "cover": "≤16字：封面大字文案",
  "images": "≤60字：内部图建议（拍什么/几张/顺序）",
  "summary": "≤60字：这次改了什么"
}
```

- 整改稿是**成稿**，它是产品里唯一由模型直接产出的可发布文本；UI 必须明确标注来源，并让用户先看一眼再决定是否填回表单。
- `normalizeRevision(parsed, draft)` 永不返回空：字段缺失时回落到原稿（title/body/tags），长度按上限硬截断，`body` 保留换行。
- 一键整改只调用**一个**模型（`resolveModels(1)` 的默认路由，`temperature 0.7`），避免多份改写稿互相打架；评估仍然多模型。

## Module ownership (write scopes are disjoint)

| file | owner | responsibility |
| --- | --- | --- |
| `lib/evaluate.js` | eval-core | `LIMITS`, `normalizeInput`, `normalizeModelReport`, `aggregateReport`, `verdictOf`, `spreadOf`, `formatCount` — pure, no imports |
| `lib/prompts.js` | eval-core | `SYSTEM_PROMPT`, `evaluatePrompt(input) -> {system,user}` (Chinese, strict JSON) |
| `lib/llm.js` | eval-core | `XhsError`, `extractJsonObject`, `LlmEvaluator` (route resolution incl. multi-model, one call per model, ensemble) |
| `test/evaluate.test.mjs`, `test/llm.test.mjs` | eval-core | unit tests with fake `ctx.llm` |
| `lib/page-script.js` | page-ui | 站点门禁 + 悬浮球 + 面板 + 结果渲染 + `window.__DSH_XHS_PAGE__` |
| `lib/hosts.js` | page-ui | 站点白名单纯函数：`normalizeHostname` / `hostFromUrl` / `isXhsHost` / `pageHost` / `pageGate` |
| `test/page-script.test.mjs` | page-ui | jsdom tests（含站点门禁） |
| `test/hosts.test.mjs` | page-ui | `lib/hosts.js` 单测 + 与页面脚本镜像判定的一致性 |
| `test/client.test.mjs` | lead | client.js 站点门禁（jsdom + fake webview：getURL/src 两种 URL 来源） |
| `index.js`, `lib/service.js`, `lib/routes.js`, `client.js`, `package.json`, `cordis.patch.yml`, `locale/*`, `icon.svg`, `README.md` | lead | wiring, install, verification |

## Exported API contracts

### `lib/evaluate.js`

```js
export const LIMITS = { title: 20, body: 1000, tags: 10, niche: 40 }
export function normalizeInput(raw) // -> { title, body, tags: string[], niche, fans, models: number }
export function normalizeModelReport(parsed) // -> ModelReport
export function aggregateReport(reports, options) // -> Report (shape above); options = { routes: [{label}] }
export function verdictOf(quality) // -> { id, label }  (>=82 viral, >=70 strong, >=55 average, >=40 weak, else poor)
export function spreadOf(reports) // -> 0..1
export function formatCount(n) // 1200 -> "1.2k"; 12000 -> "1.2万"
export const GUIDE_SECTIONS = [{ key, name }, ...] // 固定顺序：title/cover/images/text/tags
export function normalizeGuide(parsed) // -> { intro, sections:[{key,name,advice,example}] } | null
export function normalizeRevision(parsed, draft) // -> Revision（字段缺失回落原稿，长度硬截断）
```

`ModelReport` (per-model normalized):

```js
{ reads:{low,high}, likes:{low,high}, collects:{low,high}, comments:{low,high},
  engagementRate, quality, confidence, summary,
  signals:[{label,level,note}], directions:[{title,why,action}] }
```

`aggregateReport` must be total: empty/NaN/model noise → safe defaults, never throw.
Aggregation: median for `mid`, min(low)/max(high) across models, mean confidence scaled by
agreement, majority level per signal label, dedupe directions by title (keep most frequent, cap 5),
summary from the model nearest median quality, `spread` = normalized dispersion of reads high-end.

### `lib/llm.js`

```js
export class XhsError extends Error { constructor(code, message, details) }
export function extractJsonObject(raw) // tolerant: fences, prose, first balanced object
export class LlmEvaluator {
  constructor({ ctx, logger, config })
  service()                                  // ctx.get('llm') | ctx.llm, throws XhsError('llm-unavailable')
  defaultRoute()                             // config.provider/model > agentDefaultModel.currentSelection()
  async resolveModels(count)                 // -> Route[] {id,label,provider,model}, cap = count, dedupe
  async evaluateOne({ input, route, signal })// -> { route, report: ModelReport, ms }
  async evaluateEnsemble({ input, count, signal }) // -> { reports, routes, failures }
  async revise({ input, report })            // -> { revision: Revision, route, ms }  (one model, temp 0.7)
}
```

Config defaults: `{ provider:'', model:'', models:[], ensemble:2, callTimeoutMs:45000,
maxTokens:1800, temperature:0.3, ballSide:'left', ballBottom:18, allowAllHosts:false }`. The ball anchor defaults to
bottom-left because the sibling sidebar-browser translator pill owns the bottom-right corner
(`Config.ballSide` / `Config.ballBottom` override it; a drag wins for the page lifetime).
`resolveModels` order: explicit `config.models` →
explicit provider/model → `agentDefaultModel.currentSelection()`; then top up from
`llm.listModels(provider)` (try/catch, skip default id); dedupe by `provider/model`.
If only one route exists, ensemble runs once (`modelCount: 1`).
Reasoning effort: request `'off'`; if rejected, retry with the model's lowest advertised effort
(same two-step pattern as `dsh-page-translator/lib/llm.js`).
`evaluateEnsemble` uses `Promise.allSettled`; ≥1 success required else throw `XhsError('llm-failed', ...)`.

### `lib/page-script.js` → `window.__DSH_XHS_PAGE__`

```js
poll()              // -> { kind: 'evaluate' | 'revise', input } | null   (consumed once)
status(state, label, detail)  // 'busy' | 'done' | 'error' | 'idle'
result(report)      // render report, state 'done'
        revision(revised)   // render the 整改稿 view from the Revision JSON
error(message)      // render failure + retry, state 'error'
configure({ models: [{label}], maxModels, ball: { side, bottom }, allowAllHosts, url })
                    // host roster + preferred anchor: disables sizes this profile
                    // cannot run and moves the ball off the translator pill.
                    // `allowAllHosts` (default false) + `url` (fallback page URL)
                    // travel the same channel for the site gate; with the gate
                    // opened by these inputs a deferred mount is performed here.
state()             // { open, values, phase } diagnostics
ping()              // true
build               // content hash stamped by the host; the client hot-swaps a stale copy
toggle() / destroy()
```

- Result view: the title bar gains a「返回编辑」button (`panel[data-view="result"]`) and the footer is
  `[返回编辑] [复制报告] [一键整改]` (一键整改 is the primary action). There is **no** inline
  「← 返回编辑」inside the report. 返回编辑 returns to the form, keeps the typed values, resets the
  scroll position and focuses the body editor.
- 一键整改: the footer's primary button publishes `{ kind:'revise', input }` through `poll()` (input is
  the draft the user evaluated); the client calls `/xhs/revise` with the draft plus the last report it
  delivered, then calls `revision(revised)`. While waiting the panel shows「整改中…」.
- 整改稿 view (`panel[data-view="revise"]`): a「整改稿」tag + `summary`, then the revised 标题 / 正文 /
  标签, plus 封面大字 and 内部图建议, and a hint that it is model output to review. Footer is
  `[用这份稿子] [复制整改稿] [返回评估结果]`; 用这份稿子 fills the form (respecting the 20/1000/10 limits),
  returns to the form view and focuses the body — it does **not** re-evaluate automatically.
- 修改指引 block: rendered after the signals (and after the weak-verdict directions block), before
  the footnote. Section title「修改指引」+ tag「结合评估结果」; the intro line, then the five rows in
  the fixed order, each row = name pill + advice + a muted `（例：…）` suffix for its example.
  Rows carry `data-guide="<key>"`, the block carries `data-role="guide"`. A missing/partial guide
  renders only the sections it has; `guide: null` hides the block entirely. The copied report text
  includes the guide with the same parenthesised examples.
- IIFE, idempotent: if `window.__DSH_XHS_PAGE__` exists return `'ready'`, else boot and return
`'installed'`. Auto-boot unless `window.__DSH_XHS_DISABLE_BOOT__ === true`; tests then call
`window.__DSH_XHS_TEST__.boot()` which installs the UI and returns the same api object.
- Site gate: `boot()`/`status()`/`result()`/`revision()`/`error()` all mount through `ensureUI()`, which
returns `null` outside the allowlist — **no host, no node**. `window.__DSH_XHS_TEST__` additionally
exposes `isXhsHost`, `normalizeHostname`, `pageGate`, `currentPageUrl` for the parity tests.
No network, no `fetch`, no storage. Shadow DOM root, host `all: initial`, z-index 2147483000.
All listeners/timers removed by `destroy()`.
