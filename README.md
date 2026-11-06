# dsh-xhs-evaluator · 小红书笔记评估悬浮球

在 **DSH 右侧内置浏览器**里打开小红书（`www.xiaohongshu.com`）或小红书创作平台
（`creator.xiaohongshu.com`）时，左下角会出现一个红色悬浮球；**其他网页不会出现**。
点它，填入你打算发的图文，插件会调用 **N 个 DSH 宿主模型**并行评估：

- 预测这篇笔记的**潜在阅读量、点赞、收藏、评论**（区间 + 中位）；
- 给出**判定**（有爆款相 / 中上 / 中规中矩 / 偏弱 / 很差）与**置信度**；
- 数据差的时候给出**调整方向**（标题钩子、封面、正文结构、收藏价值、标签、情绪落点……）；
- 再加一段**修改指引**：结合这次的评估结论，分别说明**标题 / 封面 / 内部图 / 文字内容 / 标签**
  应该怎么选。这里允许模型直接给例子，但例子一定以 `（例：…）` 的括注形式出现，方便你照着改、
  又不至于被整篇成稿带着走；
- 最后还有 **一键整改**：按这份评估把内容改成一版可发布的稿子（标题 / 正文 / 标签 + 封面大字文案 +
  内部图建议），先给你过目，觉得可以就一键填回表单再评一次。

模型调用全部走 DSH 宿主的 `llm` 服务，插件不持有任何 API key；被访问的网页不做任何网络请求，
也看不到任何凭据。

## 用起来是什么样

1. 在 DSH 右侧边栏打开「Browser」，进入**小红书**页面（`xiaohongshu.com` 及其子域，含
   `www.xiaohongshu.com` 与创作平台 `creator.xiaohongshu.com`）；打开其他站点时插件保持静默，
   不会注入任何 DOM。
2. 页面**左下角**出现悬浮球（可拖动，位置只在本次页面内记住；默认避开右下角的翻译「译」控件）。
3. 点球 → 面板展开：
   - **标题**（0/20 计数）
   - **正文**（0/1000 计数，必填；空着按钮是灰的）
   - **话题标签**（空格或逗号分隔，最多 10 个）
   - **账号赛道**、**粉丝量级**（决定预测基线：新号不会给你几十万阅读）
   - **评估模型数** 1 / 2 / 3：面板会显示「将用 A / B」，profile 里凑不齐的档位会置灰
4. 点「开始评估」→ 球变成脉冲 + 百分比，面板显示「N 个宿主模型正在打分」。
5. 结果页：判定色带 + 置信度 → 2×2 指标卡（中位数加粗、区间在后）→ 互动率 / 模型数 →
   一句话总结 → 信号清单 → **调整方向**（偏弱/很差时置顶）→ **修改指引**（标题 / 封面 / 内部图 /
   文字内容 / 标签五个模块，每块一句"怎么选"，需要举例时以 `（例：…）` 括注）。
   底部按钮：**返回编辑**（回表单、保留输入、光标放回正文）、**复制报告**、**一键整改**。
6. 点「一键整改」→ 面板显示「整改中…」→ 切到 **整改稿** 视图：整改后的标题 / 正文 / 标签，
   加上「封面大字」文案与「内部图建议」，顶部一行改动说明。这份稿子是模型生成的成稿，先看一眼。
   底部换成 **用这份稿子**（填回表单、不自动重评，你可以再改）、**复制整改稿**、**返回评估结果**。

`Esc` 或右上角 `×` 收起面板；评估完把面板关掉时，球右上角会有红点提示结果已就绪。

## 「调用多少宿主模型」是怎么决定的

默认 **2 个**，面板可临时选 1–3 个，**上限 3 个**。具体用哪几个由宿主解析：

1. 插件配置里的 `models`（显式指定，优先级最高）；
2. 配置里的 `provider` / `model`；
3. 否则用 DSH 当前的默认模型；
4. 需要更多模型时，向同一 provider 的模型目录补齐（2.5s 超时保护，补不到就少跑几个并如实告知）。

当前 profile 实测可解析出两个路由：`DeepSeek-V4.1-Flash` 与 `DeepSeek-V4-Pro`。
所以面板会显示「将用 DeepSeek-V4.1-Flash / DeepSeek-V4-Pro（共 2 个可用）」，第三个档位置灰——
不会出现"选 3 个只跑 2 个却不说"的情况。

多个模型的输出会被汇总：区间取各模型的 min/max、中位取中位数，置信度按模型间分歧度打折，
信号按多数票合并，调整方向去重后按共识排序——这也是为什么结果会带一个 `spread`（分歧度）。

## 安装

方式一（GitHub，推荐）：

```bash
dsh plugin --profile <profile> add github:SenhoiBot/dsh-xhs-evaluator
```

方式二（本机克隆 / 本地目录，`link:` 依赖 + bundle row）：

```bash
dsh plugin --profile <profile> add "link:<本插件绝对路径>"
```

- 改 `client.js` / `lib/page-script.js`：刷新 DSH 页面（`page-script.js` 由宿主每次请求重新读取，
  重新注入即生效）。
- 改 Host 代码（`index.js`、`lib/*.js`、`lib/prompts.js`）：在 Plugin Manager 里把本插件
  **禁用再启用**即可重载模块（已实测 `/xhs/state` 立即反映新代码），不必重启 DSH；
  只有在模块替换失败时才需要重启。

## 配置

在 profile patch 里按插件行 id 覆盖（全部可省略）：

```yaml
- id: dsh-xhs-evaluator
  config:
    ensemble: 2                  # 面板未选时默认调用几个模型（1–3）
    provider: deepseek-account   # 可省略：默认用 DSH 当前默认模型
    model: deepseek-flash
    models:                      # 额外/指定评估路由（可选，最多 3 个生效）
      - provider: deepseek-account
        model: deepseek-v4-pro
        label: V4-Pro
    callTimeoutMs: 45000         # 单次模型调用超时
    maxTokens: 1800              # 单次输出预算（严格 JSON）
    temperature: 0.3
    ballSide: left               # 悬浮球默认贴哪条边（left/right）；默认 left
    ballBottom: 18               # 距底高度 px（0–240）；默认 18
    allowAllHosts: false         # 默认 false：仅小红书域名显示；true 恢复“任意网页都显示”
```

> **站点门禁**：默认只允许 `xiaohongshu.com` 与 `*.xiaohongshu.com`（大小写、端口、末尾点都容忍；
> `xiaohongshu.com.evil.com` 这类伪装域不算）。判定在两层各做一次：`client.js` 先看 webview 的
> `getURL()`（退化到 `src`），外站直接不注入；`lib/page-script.js` 再按 `location`（或 host 注入时带的
> URL）自查，不匹配时**连 Shadow DOM 宿主都不创建**。SPA 内导航不改变 origin，不会误判；整页跳到外站后
> 控制器随页面卸载消失，跳回小红书会重新注入。
> 如果确实想让它在任意网页显示，把 `allowAllHosts` 设为 `true`（沿用原有 configure 通道下发，不新增协议）。
> 宿主侧改动需在 Plugin Manager 里禁用再启用插件才生效。
>
> **为什么默认在左下**：DSH 的内置浏览器里还住着「网页翻译」的悬浮控件，它占着右下角（`right:18px; bottom:18px`
> 的「译」按钮和回复输入框）。这个球默认贴左下，两者不打架；球本身可以拖动，拖过之后本次页面内保持位置。

## 架构

```
Electron <webview>（DSH 右侧内置浏览器，Desktop）
  │ client.js：扫描 webview[data-sidebar-browser-frame="webview"]
  │            先做站点门禁：URL 不在 xiaohongshu.com 白名单就不注入（URL 未知时交给页面脚本）
  │            executeJavaScript 注入 lib/page-script.js（悬浮球 + 面板）
  │            每 400ms 轮询 window.__DSH_XHS_PAGE__.poll()
  │            /xhs/state 拿到模型名录 + allowAllHosts → configure() 收窄 1/2/3 档位 / 站点开关
  ▼
DSH renderer：client.js 同源 fetch /xhs/*（不经过被访问页面）
  ▼
Host：index.js → lib/service.js → lib/routes.js（ctx.webServer 上的 /xhs/evaluate、/xhs/revise 等路由）
      → lib/llm.js（ctx.llm：prepareCall/stream，reasoning off；评估 N 个模型并行，整改单模型 temp 0.7）
      → lib/evaluate.js（纯函数：归一化 + 汇总 + 判定 + 修改指引合并 + 整改稿归一化）
```

- 页面脚本**零网络、零 storage、不改页面 DOM**：只在小红书页面挂一个 Shadow DOM 宿主（`all: initial`
  隔离站点 CSS），其他站点连宿主都不创建。
- 站点门禁是纯字符串判定（`lib/hosts.js` + 页面脚本/客户端两份镜像），不发额外网络请求、不读站点
  storage/cookie，SPA 内导航（pushState）不改变 origin，所以不会误判。
- 模型输出被强制成严格 JSON；`sanitizeDirections` 会丢掉"看起来像成稿"的段落，方向性文字保留。
- **修改指引**是唯一允许"具体文案"的地方：模型把示例写在 `guide.sections[].example`（宿主动态截断到 50 字），
  前端一律渲染成 `（例：…）` 括注；`advice` 仍然是"怎么选"，不是成稿。多模型时取质量最接近中位数的那份为主，
  其余模型补齐缺失的模块（不足 3 块就当没有指引）。
- **宿主接线（v0.2.1 修复）**：`index.js` 用 `inject = ['llm', 'webServer']` 把 web-server 声明成硬依赖。
  profile bundle 行比 web-server 服务更早挂载，早先 best-effort 地 `ctx.get('webServer')` 会在 `apply` 时拿到
  `undefined`，于是 `/xhs/*` 路由被静默跳过（翻译插件是在 `await` 之后注册才躲过这个竞态）。改成注入后 Cordis
  会等服务就绪再调用 `apply`；`test/index.test.mjs` 锁住这条约定。

## 验收证据

| 检查 | 结果 |
| --- | --- |
| 单元/集成测试 `node --test --test-isolation=none test/*.test.mjs` | **135 个全过**（evaluate 37 / llm 25 / page-script 35 / routes 9 / service 13 / hosts 6 / client 8 / index 2） |
| 宿主路由注册（v0.2.1 修复后实测） | 重启后在干净的 DSH 实例上 `GET /xhs/state` → `200 {"ok":true,"version":"0.2.1",…,"allowAllHosts":false,"build":"…"}`，`GET /xhs/hosted.js` → 200（约 95 KB）；修复前两路由均为 404 |
| 站点门禁 | 白名单/伪装域用例（`xiaohongshu.com.evil.com` 等）、非小红书页面不挂载用例、about:blank 由 host 注入 URL 的用例、`allowAllHosts` 开关用例全部通过；页面脚本与 `lib/hosts.js` 判定逐条一致 |
| 真机注入（desktop profile，`~/.dsh/xhs-evaluator.log`） | `webviews:{count:1}` → `inject:installed` → `configure:{models:[…]}`：球确实画在了右侧内置浏览器的页面上（用户已看到） |
| 真实宿主路由 `e2e/live.mjs`（真模型，偏弱稿 + `--revise`） | **24/24 checks passed**：判定、预测区间、方向、修改指引五节，再跑一键整改 |
| 一键整改（同一次真实调用） | 标题「新手第一次拍胶片，翻车比想象中多」(16 字)、正文 125 字保留分段、7 个标签不带 #、封面大字 10 字、内部图建议 42 字、改动说明齐全；单模型 2.4s |
| 修改指引（同一次真实调用） | `guide.sections` 固定五块 `title/cover/images/text/tags`，每块 advice 成句、≥3 块带 `（例：…）` 括注示例，示例均 ≤50 字、单行 |
| 注入脚本热更新 | 日志实测 `reload-script` → `inject: installed` → `configure.build`；之后 `build` 与 `/xhs/state.build` 一致、不再触发替换（无死循环） |
| 空正文 | `HTTP 400 {"error":"empty-body"}` |
| `/xhs/state` | 返回 version / ensemble / 真实模型名录 / limits / ball 锚点 / `allowAllHosts` |
| `/xhs/hosted.js` | 约 95 KB 注入脚本，`text/javascript`，`no-store` |
| 面板契约 | `poll/status/result/error/configure/state/ping/toggle/destroy`，jsdom 覆盖幂等、表单、结果渲染、错误重试、destroy |
| 侧边栏注入机制 | 同架构的 `dsh-page-translator` 在本机日志里留有 `webviews:1` + `inject:ready` 的真实记录（`~/.dsh/page-translator.log`）；本插件装好后客户端已加载（`~/.dsh/xhs-evaluator.log` 里的 `bridge-installed`） |

复跑：

```bash
node --test --test-isolation=none test/*.test.mjs
node e2e/live.mjs --host http://127.0.0.1:24487 --draft weak --revise
node e2e/live.mjs --host http://127.0.0.1:24487 --draft strong
```

## 诊断

`~/.dsh/xhs-evaluator.log`（JSONL，256 KB 轮转）：

- `bridge-installed` / `webviews`：客户端是否加载、当前找到几个内置浏览器页面（`0` = 还没打开 Browser 标签）
- `configure`：面板拿到的模型名录 + 注入脚本构建号 + `allowAllHosts`
- `inject` / `inject-skip` / `inject-unexpected`：注入是否成功；`inject-skip` 表示当前 webview 的 URL
  不在小红书白名单（`data.host` 是判定出来的域名），客户端主动没注入
- `reload-script`：注入脚本版本过期时自动热替换（换一次就停，`inject: installed` 表示新版已接管）
- `request` / `evaluated` / `evaluate-error`：评估请求（`kind` = evaluate/revise）、耗时、参与的模型、失败原因
- `revised` / `revise-error`：一键整改的模型与耗时 / 失败原因

## 更新注入脚本（不用手动刷新）

宿主每次请求 `/xhs/hosted.js` 时把文件内容哈希写进脚本（`var BUILD = '<hash>'`），`/xhs/state.build`
发布同一个哈希；客户端每 400ms 轮询时会比对页内运行版本，**发现过期就 `destroy()` 旧面板并注入新版**
（限流 5s 一次，日志里是一条 `reload-script` → `inject: installed`）。所以改 `lib/page-script.js`
只要宿主已在跑（客户端模块无需重载），页面里的球会在几秒内自动换成新版——热替换会重建面板，
正在输入的内容会清空，这是唯一的代价。

## 已知限制

- **只有 Desktop 版生效**：Web 版 DSH 的内置浏览器是跨域 iframe，插件读不到它的 DOM，悬浮球不会出现
  （与 `dsh-page-translator` 相同的限制）。
- **只在小红书域名出现**：`xiaohongshu.com` 与 `*.xiaohongshu.com`（含创作平台）；其他站点不注入、
  不挂载任何节点。确实想全局显示时把 `allowAllHosts` 设为 `true`（需要重载插件）。
- 需要先在内置浏览器里打开一个 **http(s) 页面**；`about:blank`、浏览器内部页、PDF 阅读器不保证可用。
  若注入时 `location` 还是 blank，页面脚本会等 host 下发的 URL 或 `DOMContentLoaded`，不会误挡正常小红书页面。
- 最多 3 个模型，且受当前 profile 实际可解析的路由数限制；只有一个可用模型时面板会明说。
- 预测是**模型基于公开生态规律的推测**，不是平台后台数据；它的价值在于"发之前改一版"，不是精准预报。
- 悬浮球默认在左下：右下角是内置浏览器里「网页翻译」插件的控件位置。改 `ballSide` / `ballBottom` 属于
  Host 配置改动，需要重载插件（重启 DSH）才生效；默认位置改完后只需**刷新一下内置浏览器里的页面**。
- **一键整改**产出的是**成稿**：prompt 要求延续原稿主题与事实、不编造型号/价格/经历，但模型仍可能写错细节，
  发之前请自己核对一遍；它只调用一个模型（默认路由，temperature 0.7），不吃多模型 ensemble 的额度。
- 调整方向仍是方向；具体文案只出现在**修改指引的括注示例**与**一键整改的成稿**里，
  这是刻意的产品边界。
- 面板属于被访问页面（Shadow DOM），不继承 DSH 主题令牌；它不受 DSH 亮/暗主题影响，
  也绝不会破坏站点样式。

## 目录

```
index.js                 宿主入口（bundle row）
client.js                客户端半：站点门禁 + 发现 webview、注入控制器、轮询请求、转发评估、下发模型名录
lib/hosts.js             站点白名单：normalizeHostname / isXhsHost / hostFromUrl / pageGate（纯函数）
lib/service.js           生命周期 + 配置归一 + 评估编排（ensemble → 汇总）
lib/routes.js            /xhs/* 路由（hosted.js / state / evaluate / log）
lib/page-script-source.js 注入脚本读取 + 内容哈希构建号（供客户端判断/热替换版本）
lib/llm.js               宿主 LLM 桥：多模型路由、并行调用、reasoning off、JSON 提取
lib/prompts.js           中文评估提示词（8 维 / 严格 JSON / 调整方向 + 修改指引与举例）
lib/evaluate.js          纯函数：输入归一、模型结果归一、汇总、判定、修改指引合并、计数格式化
lib/page-script.js       页面内控制器：站点门禁 + 悬浮球 + 面板 + 结果渲染
locale/{zh,en}.json      插件管理器的显示元数据
icon.svg                 插件图标
test/                    单元 / 集成测试（hosts / client 站点门禁用例在 hosts.test.mjs、client.test.mjs）
e2e/live.mjs             对真实宿主 + 真实模型的可复跑验收脚本
DESIGN.md                冻结的接口契约（路由、Report JSON、模块边界）
```

## License

MIT
