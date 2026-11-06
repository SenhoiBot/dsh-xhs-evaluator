/**
 * jsdom tests for the injected sidebar-browser controller.
 *
 * The production path is `webview.executeJavaScript(pageScriptSource)` inside an
 * Electron webview; here we reproduce it with `dom.window.eval(source)`.
 * `__DSH_XHS_DISABLE_BOOT__` keeps a test from mounting the UI twice and
 * `window.__DSH_XHS_TEST__.boot()` mounts it on demand.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { isXhsHost, normalizeHostname } from '../lib/hosts.js'

const here = dirname(fileURLToPath(import.meta.url))
const scriptSource = readFileSync(join(here, '..', 'lib', 'page-script.js'), 'utf8')

// jsdom ships with the dsh-superagent dev dependencies in this workspace.
const requireFromSuperagent = createRequire(join(here, '..', '..', '..', 'dsh-superagent', 'package.json'))
const { JSDOM } = requireFromSuperagent('jsdom')

const PAGE = `<!doctype html><html lang="zh-CN"><head><title>小红书 - 你的生活指南</title></head><body>
<div id="app">页面原有内容</div>
</body></html>`

/** Values created inside the jsdom realm have a different prototype chain. */
const plain = (value) => JSON.parse(JSON.stringify(value))

function createDom(url = 'https://www.xiaohongshu.com/explore') {
  return new JSDOM(PAGE, { runScripts: 'outside-only', url })
}

/** A jsdom document with no readable page URL (about:blank). */
function createBlankDom() {
  return new JSDOM(PAGE, { runScripts: 'outside-only' })
}

/** Boot the controller in a fresh document and return its hooks. */
function setup(t) {
  const dom = createDom()
  dom.window.__DSH_XHS_DISABLE_BOOT__ = true
  dom.window.eval(scriptSource)
  const api = dom.window.__DSH_XHS_TEST__.boot()
  const host = dom.window.document.getElementById('dsh-xhs-host')
  assert.ok(host, 'shadow host 已挂载')
  const shadow = host.shadowRoot
  assert.ok(shadow, '宿主使用 Shadow DOM')

  const q = (role) => shadow.querySelector(`[data-role="${role}"]`)
  const fill = (role, value, type = 'input') => {
    const field = q(role)
    assert.ok(field, `字段 ${role} 存在`)
    field.value = value
    field.dispatchEvent(new dom.window.Event(type, { bubbles: true }))
    return field
  }
  const click = (role) => {
    const target = q(role)
    assert.ok(target, `按钮 ${role} 存在`)
    target.click()
    return target
  }

  t.after(() => {
    try {
      api.destroy()
    } catch (error) {
      /* already destroyed */
    }
    try {
      dom.window.close()
    } catch (error) {
      /* ignore */
    }
  })

  return { dom, window: dom.window, document: dom.window.document, api, host, shadow, q, fill, click }
}

const REPORT_POOR = {
  version: 1,
  verdict: 'poor',
  verdictLabel: '很差',
  summary: '标题过于平铺直叙，封面信息密度不足，读者很难在信息流里停下来。',
  confidence: 0.62,
  predicted: {
    reads: { low: 1200, mid: 2600, high: 5200 },
    likes: { low: 40, mid: 90, high: 190 },
    collects: { low: 25, mid: 60, high: 130 },
    comments: { low: 3, mid: 8, high: 20 },
    engagementRate: 0.043,
  },
  signals: [
    { label: '标题钩子', level: 'bad', note: '缺少具体利益点' },
    { label: '封面信息', level: 'warn', note: '卖点不突出' },
    { label: '正文结构', level: 'good', note: '分段清晰' },
  ],
  directions: [
    { title: '补足具体利益点', why: '读者无法在 1 秒内判断价值', action: '把标题里的抽象形容换成可感知的结果或数字' },
    { title: '提高封面信息密度', why: '首图没有传达内容主题', action: '优先突出使用场景，而不是只放氛围图' },
  ],
  modelCount: 2,
  spread: 0.18,
  ts: 1699999999999,
}

/* ------------------------------------------------------------------ tests */

test('脚本幂等：首次注入返回 installed，再次注入返回 ready，页面只挂一个球', (t) => {
  const dom = createDom()
  t.after(() => {
    try {
      dom.window.__DSH_XHS_PAGE__.destroy()
    } catch (error) {
      /* ignore */
    }
    try {
      dom.window.close()
    } catch (error) {
      /* ignore */
    }
  })

  const first = dom.window.eval(scriptSource)
  assert.equal(first, 'installed', '首次注入安装 UI')

  const document = dom.window.document
  const host = document.getElementById('dsh-xhs-host')
  assert.ok(host, 'document 里出现 shadow host')
  assert.ok(host.shadowRoot, 'host 挂载了 shadow root')
  assert.ok(host.shadowRoot.querySelector('[data-role="ball"]'), '球在 shadow root 里')
  assert.equal(host.style.getPropertyValue('position'), 'fixed')
  assert.equal(host.style.getPropertyValue('z-index'), '2147483000')
  assert.equal(document.querySelectorAll('#dsh-xhs-host').length, 1)
  // The page itself is untouched apart from the single shadow host.
  assert.equal(document.getElementById('app').textContent, '页面原有内容')

  const ballStyle = host.shadowRoot.querySelector('[data-role="ball"]').style
  assert.equal(ballStyle.position, 'fixed')
  assert.equal(ballStyle.width, '56px')
  assert.equal(ballStyle.height, '56px')
  assert.equal(ballStyle.getPropertyValue('border-radius'), '50%')

  const second = dom.window.eval(scriptSource)
  assert.equal(second, 'ready', '重复注入直接被幂等守卫挡住')
  assert.equal(document.querySelectorAll('#dsh-xhs-host').length, 1, '不会重复挂载 UI')
  assert.equal(dom.window.__DSH_XHS_PAGE__.ping(), true)
})

test('表单校验：正文为空时点击不发起请求；填写后 poll() 返回完整 input', (t) => {
  const { api, q, fill, click } = setup(t)

  const submit = q('submit')
  assert.equal(submit.disabled, true, '正文为空时按钮禁用')
  submit.click()
  assert.equal(api.poll(), null, '空正文不会产生 poll 请求')
  assert.equal(api.state().values.body, '')

  fill('body', '  秋日露营第一次体验，帐篷和天幕都很好用  ')
  assert.equal(submit.disabled, false, '正文有内容后按钮可用')
  fill('title', '秋日露营第一次体验')
  fill('tags', '露营 秋日,帐篷 #天幕')
  fill('niche', '旅行', 'change')
  fill('fans', '1w-10w', 'change')

  assert.equal(api.state().values.models, 2, '默认评估 2 个模型')
  click('model-3')
  assert.equal(api.state().values.models, 3)

  submit.click()
  const pending = api.poll()
  assert.ok(pending && pending.input, 'poll 返回待评估请求')
  assert.equal(pending.kind, 'evaluate', '普通提交带 kind=evaluate')
  assert.deepEqual(plain(pending.input), {
    title: '秋日露营第一次体验',
    body: '秋日露营第一次体验，帐篷和天幕都很好用',
    tags: ['露营', '秋日', '帐篷', '天幕'],
    niche: '旅行',
    fans: '1w-10w',
    models: 3,
  })
  assert.equal(api.poll(), null, '请求只被取走一次')
  assert.equal(api.state().phase, 'busy')
})

test('result(report) 渲染判定、区间、置信度与置顶的调整方向（poor）', (t) => {
  const { api, q, document } = setup(t)
  api.result(REPORT_POOR)

  const result = q('result')
  const text = result.textContent
  assert.match(text, /很差/, 'renders verdictLabel')
  assert.match(text, /置信度 62%/)
  assert.match(text, /1\.2k/, 'renders range low via formatCount')
  assert.match(text, /2\.6k/, 'renders formatted mid')
  assert.match(text, /5\.2k/, 'renders range high via formatCount')
  assert.match(text, /4\.3%/, 'renders engagement rate')
  assert.match(text, /2 个/, 'renders model count')
  assert.match(text, /补足具体利益点/, 'renders direction title')
  assert.match(text, /调整方向/, 'poor verdict promotes the direction block')
  assert.match(text, /只给方向/, 'direction block says it is not ghostwriting')
  assert.doesNotMatch(text, /可选优化/, 'weak/poor does not use the collapsed block')

  const band = result.querySelector('.verdict')
  assert.ok(band, 'verdict colour band exists')
  assert.equal(band.getAttribute('data-tone'), 'bad', 'poor maps to the red band')

  assert.equal(q('form').style.display, 'none', 'switched to the result view')
  assert.notEqual(result.style.display, 'none')
  assert.equal(q('panel').style.display, 'flex', 'panel opened for the result')
  assert.equal(api.state().phase, 'done')
  assert.equal(document.getElementById('dsh-xhs-host').shadowRoot.querySelectorAll('[data-metric]').length, 4)
})

test('verdict 非 weak/poor 时方向收进「可选优化」折叠区', (t) => {
  const { api, q } = setup(t)
  api.result({ ...REPORT_POOR, verdict: 'average', verdictLabel: '中规中矩' })

  const result = q('result')
  const text = result.textContent
  assert.match(text, /中规中矩/)
  assert.match(text, /可选优化/)
  assert.doesNotMatch(text, /调整方向/)
  assert.ok(result.querySelector('details.optional'), 'non-weak verdict folds directions')
  assert.equal(result.querySelector('.verdict').getAttribute('data-tone'), 'info', 'average maps to blue')
})

test('error() 展示失败信息与重试按钮，重试重新投递上一次输入', (t) => {
  const { api, q, fill } = setup(t)
  fill('body', '测试失败重试的正文')
  q('submit').click()
  const first = api.poll()
  assert.ok(first && first.input)

  api.error('模型调用失败：所有模型都没有返回有效结果')
  assert.equal(api.state().phase, 'error')
  const banner = q('banner')
  assert.ok(banner.classList.contains('on'), 'error banner visible')
  assert.match(banner.textContent, /模型调用失败/)
  assert.ok(q('retry'), 'retry button rendered')

  q('retry').click()
  const again = api.poll()
  assert.ok(again && again.input, 'retry re-queues the last input')
  assert.deepEqual(again.input, first.input)
  assert.equal(api.state().phase, 'busy')
  assert.ok(!banner.classList.contains('on'), 'banner cleared on retry')
})

test('destroy() 移除 host、清理监听，之后的 API 调用不抛错', (t) => {
  const { api, document, window } = setup(t)
  api.destroy()

  assert.equal(document.getElementById('dsh-xhs-host'), null, 'host removed')
  assert.doesNotThrow(() => api.poll())
  assert.equal(api.poll(), null)
  assert.equal(api.ping(), true)
  assert.doesNotThrow(() => api.status('busy', '评估中 1/2', ''))
  assert.doesNotThrow(() => api.result(REPORT_POOR))
  assert.doesNotThrow(() => api.error('x'))
  assert.doesNotThrow(() => api.toggle())
  assert.doesNotThrow(() => api.state())
  assert.equal(window.document.getElementById('dsh-xhs-host'), null, 'destroy 后不会重新挂载')
})

test("status('busy') 让按钮进入评估态，悬浮球显示进度百分比", (t) => {
  const { api, q } = setup(t)
  api.status('busy', '评估中 1/2', '正在等待模型返回')

  const submit = q('submit')
  assert.equal(submit.disabled, true, 'busy 时按钮禁用')
  assert.match(submit.textContent, /评估中/)
  assert.equal(api.state().phase, 'busy')

  const busyLine = q('busy')
  assert.ok(busyLine.classList.contains('on'))
  assert.match(busyLine.textContent, /1\/2/)
  assert.match(busyLine.textContent, /正在等待模型返回/)

  const badge = q('ball-badge')
  assert.ok(badge.classList.contains('on'))
  assert.equal(badge.textContent, '50%')
  assert.ok(q('ball-spinner').classList.contains('on'))

  api.status('done', '已完成')
  assert.equal(api.state().phase, 'done')
  assert.equal(submit.textContent, '开始评估')
  assert.ok(!q('busy').classList.contains('on'))
  assert.ok(!q('ball-badge').classList.contains('on'))
})

test('formatCount 遵循 DESIGN.md 的计数规则', (t) => {
  const { window } = setup(t)
  const format = window.__DSH_XHS_TEST__.formatCount
  assert.equal(format(999), '999')
  assert.equal(format(1200), '1.2k')
  assert.equal(format(1000), '1k')
  assert.equal(format(2600), '2.6k')
  assert.equal(format(12000), '1.2万')
  assert.equal(format(100000), '10万')
  assert.equal(format(0), '0')
})

test('parseTags 拆分空格/逗号、去 # 去重、最多 10 个', (t) => {
  const { window } = setup(t)
  const parse = window.__DSH_XHS_TEST__.parseTags
  assert.deepEqual(plain(parse('露营 秋日,帐篷，#天幕')), ['露营', '秋日', '帐篷', '天幕'])
  assert.deepEqual(plain(parse('a a  a')), ['a'])
  assert.equal(parse('t1 t2 t3 t4 t5 t6 t7 t8 t9 t10 t11 t12').length, 10)
})

test('configure() 用宿主真实模型名录收窄选择器，不承诺跑不了的模型数', (t) => {
  const { api, q, fill, click } = setup(t)

  api.configure({ models: [{ label: 'DeepSeek-V4.1-Flash' }, { label: 'DeepSeek-V4-Pro' }], maxModels: 3 })

  const note = q('models-note')
  assert.match(note.textContent, /DeepSeek-V4\.1-Flash/)
  assert.match(note.textContent, /DeepSeek-V4-Pro/)
  assert.equal(q('model-3').disabled, true, '第三个模型档位被禁用')
  assert.equal(q('model-2').disabled, false)
  assert.equal(api.state().values.models, 2)

  click('model-3')
  assert.equal(api.state().values.models, 2, '禁用档位点击无效')

  fill('body', '秋日露营第一次体验，帐篷和天幕都很好用')
  click('submit')
  const pending = api.poll()
  assert.equal(pending.input.models, 2, '提交的模型数不超过可用模型数')
})

test('configure() 只有一个宿主模型时收窄到 1 并说明原因', (t) => {
  const { api, q, fill, click } = setup(t)

  api.configure({ models: [{ label: 'DeepSeek-V4.1-Flash' }] })
  assert.equal(api.state().values.models, 1, '选择器收窄到 1')
  assert.equal(q('model-2').disabled, true)
  assert.equal(q('model-3').disabled, true)
  assert.match(q('models-note').textContent, /仅 1 个宿主模型可用/)

  fill('body', '秋日露营第一次体验，帐篷和天幕都很好用')
  click('submit')
  assert.equal(api.poll().input.models, 1)
})

test('configure(null) 解除收窄，1/2/3 档位重新可选', (t) => {
  const { api, q } = setup(t)
  api.configure({ models: [{ label: 'A' }] })
  assert.equal(q('model-2').disabled, true)
  api.configure(null)
  assert.equal(q('model-2').disabled, false)
  assert.equal(q('model-3').disabled, false)
  assert.match(q('models-note').textContent, /调用 1 个 DSH 宿主模型/)
  q('model-3').click()
  assert.equal(api.state().values.models, 3, '收窄解除后可以重新选 3 个')
})

test('默认把球放左下（避开右下角的翻译控件），configure 可改边与高度', (t) => {
  const { api, q } = setup(t)
  const ball = q('ball')
  assert.equal(ball.style.left, '18px', '默认贴左边')
  assert.equal(ball.style.right, 'auto')
  assert.equal(ball.style.bottom, '18px')

  api.configure({ models: [{ label: 'A' }], ball: { side: 'right', bottom: 96 } })
  assert.equal(ball.style.right, '18px', '可以改回右侧')
  assert.equal(ball.style.left, 'auto')
  assert.equal(ball.style.bottom, '96px', '可以调整距底高度')
})

test('结果页的「返回编辑」入口（标题栏 + 底部）能回到表单并保留输入，且没有内嵌入口', (t) => {
  const { api, q, shadow, fill, click } = setup(t)

  fill('body', '这是一段要评估的正文，改稿前先看结果。')
  fill('title', '一个标题')
  click('submit')
  api.poll()
  api.result(REPORT_POOR)

  assert.equal(q('panel').getAttribute('data-view'), 'result')
  assert.equal(q('foot').style.display, 'flex', '底部按钮区可见')
  assert.ok(q('edit-top'), '标题栏有返回编辑按钮')
  assert.equal(q('edit-inline'), null, '判定下方不再有内嵌的返回编辑入口')
  assert.deepEqual(
    [...q('foot').children].map((button) => button.textContent),
    ['返回编辑', '复制报告', '一键整改'],
    '底部按钮顺序',
  )
  assert.ok(q('revise').classList.contains('btn-primary'), '一键整改是主按钮')
  assert.equal(q('re-eval').textContent, '返回编辑', '原「重新评估」改名为「返回编辑」')

  // Title-bar entry: always in reach without scrolling the report.
  q('edit-top').click()
  assert.equal(q('panel').getAttribute('data-view'), 'form')
  assert.equal(q('form').style.display, 'block')
  assert.equal(q('result').style.display, 'none')
  assert.equal(q('body').value, '这是一段要评估的正文，改稿前先看结果。', '输入被保留')
  assert.equal(api.state().phase, 'idle')

  // Footer entry behaves the same (and focuses the body).
  click('submit')
  api.poll()
  api.result(REPORT_POOR)
  q('re-eval').click()
  assert.equal(q('form').style.display, 'block')
  assert.equal(q('result').style.display, 'none')
  assert.equal(shadow.activeElement, q('body'), '回到表单后焦点落在正文，直接可改')
})

test('page script 不含网络请求、存储读写与 document.title 修改', () => {
  assert.ok(!/\bfetch\s*\(/.test(scriptSource), 'no fetch')
  assert.ok(!/XMLHttpRequest/.test(scriptSource), 'no XHR')
  assert.ok(!/localStorage|sessionStorage/.test(scriptSource), 'no storage')
  assert.ok(!/document\.title\s*=/.test(scriptSource), 'never touches document.title')
})

/* ---------------------------------------------------------- 修改指引 guide */

const GUIDE_FULL = {
  intro: '先补标题的信息量，再换一张信息更密的封面。',
  sections: [
    { key: 'title', name: '标题', advice: '把结果和人群前置，避免只写心情。', example: '10㎡ 出租屋｜这样布置多出 2㎡ 收纳' },
    { key: 'cover', name: '封面', advice: '封面放使用前后对比，主体占画面 2/3。', example: '左右对比图 + 大字「多出 2㎡」' },
    { key: 'images', name: '内部图', advice: '每张图只讲一个点，按空间顺序排列。', example: '玄关→书桌→床下，3 张图讲完 3 个收纳点' },
    { key: 'text', name: '文字内容', advice: '开头一句话说清收益，正文用短段落列清单。', example: '「3 个不占地方的收纳点，小卧室也能很能装」' },
    { key: 'tags', name: '标签', advice: '选 5-8 个精准标签，别堆泛流量词。', example: '#小卧室改造 #租房收纳 #10㎡改造' },
  ],
}

const REPORT_WITH_GUIDE = {
  ...REPORT_POOR,
  verdict: 'average',
  verdictLabel: '中规中矩',
  guide: GUIDE_FULL,
}

test('guide：完整五块按固定顺序渲染，示例用全角括注，位置在信号之后', (t) => {
  const { api, q } = setup(t)
  api.result(REPORT_WITH_GUIDE)

  const result = q('result')
  const block = q('guide')
  assert.ok(block, '修改指引区块存在')
  assert.equal(block.getAttribute('data-role'), 'guide')

  const heading = block.querySelector('.section-title')
  assert.match(heading.textContent, /修改指引/)
  assert.match(heading.textContent, /结合评估结果/)
  assert.match(block.textContent, /先补标题的信息量/)

  const rows = [...block.querySelectorAll('[data-guide]')]
  assert.deepEqual(rows.map((row) => row.getAttribute('data-guide')), ['title', 'cover', 'images', 'text', 'tags'])
  assert.deepEqual(rows.map((row) => row.querySelector('.guide-name').textContent), ['标题', '封面', '内部图', '文字内容', '标签'])

  const first = rows[0]
  assert.equal(first.querySelector('.guide-advice').textContent, GUIDE_FULL.sections[0].advice)
  assert.equal(first.querySelector('.guide-example').textContent, `（例：${GUIDE_FULL.sections[0].example}）`)
  for (const row of rows) {
    assert.match(row.textContent, /（例：/)
    assert.match(row.textContent, /）$/, '括注示例收在行尾')
  }

  // 信号区之后、非 weak 的「可选优化」之前、footnote 之前。
  const children = [...result.children]
  const signalsIndex = children.findIndex((node) => node.classList.contains('signals'))
  const guideIndex = children.indexOf(block)
  const optionalIndex = children.findIndex((node) => node.classList.contains('optional'))
  const footnoteIndex = children.findIndex((node) => node.classList.contains('footnote'))
  assert.ok(signalsIndex !== -1 && signalsIndex < guideIndex, 'guide 在信号区之后')
  assert.ok(optionalIndex !== -1 && guideIndex < optionalIndex, 'guide 在可选优化之前')
  assert.ok(footnoteIndex !== -1 && guideIndex < footnoteIndex, 'guide 在脚注之前')
})

test('guide：只有部分 section 时只渲染存在的行，且仍按固定顺序', (t) => {
  const { api, q } = setup(t)
  api.result({
    ...REPORT_POOR,
    guide: {
      intro: '先改标题。',
      sections: [
        { key: 'tags', name: '标签', advice: '标签别超过 8 个。' },
        { key: 'title', name: '标题', advice: '标题先给结果。', example: '示例标题' },
      ],
    },
  })

  const block = q('guide')
  assert.ok(block)
  const rows = [...block.querySelectorAll('[data-guide]')]
  assert.deepEqual(rows.map((row) => row.getAttribute('data-guide')), ['title', 'tags'])
  assert.equal(rows[0].querySelector('.guide-example').textContent, '（例：示例标题）')
  assert.equal(rows[1].querySelector('.guide-example'), null, 'example 缺失时只显示 advice')
  assert.doesNotMatch(block.textContent, /封面|内部图|文字内容/)
})

test('guide 为 null、缺失或没有可用 section 时整块完全不渲染', (t) => {
  const { api, q } = setup(t)

  api.result({ ...REPORT_POOR, guide: null })
  assert.equal(q('guide'), null, 'guide:null 隐藏整块')

  api.result({ ...REPORT_POOR })
  assert.equal(q('guide'), null, '缺少 guide 字段隐藏整块')

  api.result({ ...REPORT_POOR, guide: { intro: '只有 intro', sections: [] } })
  assert.equal(q('guide'), null, '空 sections 隐藏整块')

  assert.match(q('result').textContent, /很差/, '其它结果区块照常渲染')
})

test('guide 容错：中文键对象、裸数组、缺 key 的 name 都能渲染', (t) => {
  const { api, q } = setup(t)

  api.result({
    ...REPORT_POOR,
    guide: {
      intro: '中文键也能用。',
      sections: { 标题: { advice: '中文键标题建议。', example: '中文键举例' }, 标签: { advice: '中文键标签建议。' } },
    },
  })
  let rows = [...q('guide').querySelectorAll('[data-guide]')]
  assert.deepEqual(rows.map((row) => row.getAttribute('data-guide')), ['title', 'tags'])
  assert.equal(rows[0].querySelector('.guide-example').textContent, '（例：中文键举例）')

  api.result({ ...REPORT_POOR, guide: [{ name: '封面', advice: '裸数组给封面。', example: '对比图' }] })
  rows = [...q('guide').querySelectorAll('[data-guide]')]
  assert.deepEqual(rows.map((row) => row.getAttribute('data-guide')), ['cover'])
  assert.equal(rows[0].querySelector('.guide-name').textContent, '封面')

  api.result({ ...REPORT_POOR, guide: { title: { advice: '对象 keyed 也能兜。' }, 标签: '字符串建议' } })
  rows = [...q('guide').querySelectorAll('[data-guide]')]
  assert.deepEqual(rows.map((row) => row.getAttribute('data-guide')), ['title', 'tags'])
  assert.match(rows[1].querySelector('.guide-advice').textContent, /字符串建议/)
})

test('复制报告文本带上修改指引与相同的括注示例', (t) => {
  const { api, window } = setup(t)
  api.result(REPORT_WITH_GUIDE)
  const text = window.__DSH_XHS_TEST__.reportText()
  assert.match(text, /修改指引（结合评估结果）/)
  assert.match(text, /先补标题的信息量/)
  assert.match(text, /- 标题：把结果和人群前置/)
  assert.ok(text.includes('（例：10㎡ 出租屋｜这样布置多出 2㎡ 收纳）'), 'copy 带括注示例')
  assert.ok(text.includes('（例：#小卧室改造 #租房收纳 #10㎡改造）'))

  api.result({ ...REPORT_POOR, guide: { sections: [{ key: 'cover', advice: '封面建议。' }] } })
  const partial = window.__DSH_XHS_TEST__.reportText()
  assert.match(partial, /- 封面：封面建议。/)
  assert.doesNotMatch(partial, /（例：/, 'example 缺失时复制文本也不带括注')
})

test('normalizeGuide 对无效输入返回 null，并归一化 name/中文键', (t) => {
  const { window } = setup(t)
  const normalize = window.__DSH_XHS_TEST__.normalizeGuide
  assert.equal(normalize(null), null)
  assert.equal(normalize(undefined), null)
  assert.equal(normalize('nope'), null)
  assert.equal(normalize({ sections: [] }), null)
  assert.equal(normalize({ sections: [{ key: 'unknown', advice: 'x' }] }), null)

  const normalized = normalize({ sections: [{ name: '内部图', advice: '配图建议' }] })
  assert.deepEqual(plain(normalized.sections.map((section) => section.key)), ['images'])
  assert.equal(normalized.sections[0].name, '内部图')
  assert.equal(normalized.sections[0].advice, '配图建议')
})

/* ------------------------------------------------------- 一键整改 revision */

const REVISION = {
  title: '10㎡ 出租屋改造｜多出 2㎡ 收纳',
  body: '搬进来半年，最满意的就是这三个收纳点。\n\n1. 床下抽屉：把换季被子都塞进去。\n2. 书桌侧墙：洞洞板挂常用小物。\n3. 玄关顶柜：行李箱和杂物都藏起来。',
  tags: ['小卧室改造', '租房收纳', '10㎡改造', '出租屋改造'],
  cover: '多出 2㎡ 收纳',
  images: '玄关→书桌→床下，3 张图讲完 3 个收纳点',
  summary: '把标题和开头都改成“结果前置”，并补上可复用的收纳清单。',
}

test('一键整改：主按钮发布 kind=revise 与上次原稿，按钮进入整改中', (t) => {
  const { api, q, fill, click } = setup(t)
  fill('body', '原始正文，评估后整改。')
  fill('title', '原始标题')
  fill('tags', '露营 秋日')
  click('submit')
  const evaluated = api.poll()
  assert.equal(evaluated.kind, 'evaluate')
  api.result(REPORT_POOR)

  q('revise').click()
  const reviseRequest = api.poll()
  assert.ok(reviseRequest, '一键整改产生 poll 请求')
  assert.equal(reviseRequest.kind, 'revise')
  assert.deepEqual(plain(reviseRequest.input), plain(evaluated.input), '整改复用上次提交的原稿')
  assert.equal(api.state().phase, 'busy')
  assert.equal(q('revise').disabled, true, '整改中按钮禁用')
  assert.equal(q('revise').textContent, '整改中…')
  assert.ok(q('ball-spinner').classList.contains('on'), '球显示忙碌态')

  // The client would call revision() next; the button recovers.
  api.revision(REVISION)
  assert.equal(q('revise').disabled, false)
  assert.equal(q('revise').textContent, '一键整改')
})

test('revision() 渲染整改稿视图：标题/正文换行/标签/封面/内部图/提示', (t) => {
  const { api, q } = setup(t)
  api.result(REPORT_POOR)
  api.revision(REVISION)

  assert.equal(q('panel').getAttribute('data-view'), 'revise')
  assert.equal(q('form').style.display, 'none')
  assert.equal(q('result').style.display, 'none')
  assert.equal(q('revise-view').style.display, 'block')
  assert.equal(q('foot').style.display, 'none')
  assert.equal(q('foot-revise').style.display, 'flex')
  assert.ok(q('edit-top'), '整改稿视图仍有标题栏返回编辑')

  const view = q('revise-view')
  assert.match(view.textContent, /整改稿/)
  assert.match(view.textContent, /把标题和开头都改成/)
  assert.equal(q('revise-title').textContent, REVISION.title)
  assert.equal(q('revise-body').textContent, REVISION.body, '正文完整保留换行')
  assert.ok(q('revise-body').textContent.includes('\n\n1. 床下抽屉'), '段落换行保留')
  assert.match(q('revise-tags').textContent, /#小卧室改造/)
  assert.match(q('revise-tags').textContent, /#出租屋改造/)
  assert.equal(q('revise-cover').textContent, REVISION.cover)
  assert.equal(q('revise-images').textContent, REVISION.images)
  assert.match(view.textContent, /整改稿由模型生成，请按需修改后再评估/)
  assert.deepEqual(
    [...q('foot-revise').children].map((button) => button.textContent),
    ['用这份稿子', '复制整改稿', '返回评估结果'],
    '整改稿 footer 顺序',
  )
  assert.ok(q('use-draft').classList.contains('btn-primary'), '用这份稿子是主按钮')
})

test('用这份稿子：填回表单、按 20/1000/10 截断、不自动提交', (t) => {
  const { api, q } = setup(t)
  api.result(REPORT_POOR)
  api.revision(REVISION)
  q('use-draft').click()

  assert.equal(q('panel').getAttribute('data-view'), 'form')
  assert.equal(q('form').style.display, 'block')
  assert.equal(q('title').value, REVISION.title)
  assert.equal(q('body').value, REVISION.body)
  assert.equal(q('tags').value, REVISION.tags.join(' '))
  assert.equal(q('title-count').textContent, `${REVISION.title.length}/20`)
  assert.equal(q('body-count').textContent, `${REVISION.body.length}/1000`)
  assert.equal(api.poll(), null, '填回表单后不自动发起评估')
  assert.equal(api.state().phase, 'idle')

  // Overlong fields are clamped to the input limits.
  api.revision({
    title: '标'.repeat(30),
    body: '文'.repeat(1200),
    tags: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10', 't11', 't12'],
  })
  q('use-draft').click()
  assert.equal(q('title').value.length, 20)
  assert.equal(q('body').value.length, 1000)
  assert.equal(api.state().values.tags.length, 10)
})

test('复制整改稿：写入包含标题/正文/标签/封面/内部图的完整文本', async (t) => {
  const { api, q, window } = setup(t)
  let copied = ''
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (value) => {
        copied = value
        return Promise.resolve()
      },
    },
  })
  api.result(REPORT_POOR)
  api.revision(REVISION)
  q('copy-revision').click()
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.match(copied, /整改稿（模型生成，请按需修改）/)
  assert.match(copied, /标题：10㎡ 出租屋改造｜多出 2㎡ 收纳/)
  assert.ok(copied.includes(REVISION.body), '正文含换行写入剪贴板')
  assert.match(copied, /标签：#小卧室改造 #租房收纳 #10㎡改造 #出租屋改造/)
  assert.match(copied, /封面大字：多出 2㎡ 收纳/)
  assert.match(copied, /内部图建议：玄关→书桌→床下，3 张图讲完 3 个收纳点/)
})

test('返回评估结果：回到 result 视图且报告仍在内存', (t) => {
  const { api, q } = setup(t)
  api.result(REPORT_POOR)
  api.revision(REVISION)
  q('back-result').click()

  assert.equal(q('panel').getAttribute('data-view'), 'result')
  assert.equal(q('result').style.display, 'block')
  assert.equal(q('revise-view').style.display, 'none')
  assert.equal(q('foot').style.display, 'flex')
  assert.equal(q('foot-revise').style.display, 'none')
  assert.match(q('result').textContent, /很差/, '报告仍然渲染')
  assert.equal(api.state().phase, 'done')
})

test('整改失败后重试仍按 revise 重新投递', (t) => {
  const { api, q, fill, click } = setup(t)
  fill('body', '等待整改的正文。')
  click('submit')
  api.poll()
  api.result(REPORT_POOR)

  q('revise').click()
  api.poll()
  api.error('整改失败：模型没有返回有效内容')
  assert.ok(q('banner').classList.contains('on'))
  q('retry').click()
  const retried = api.poll()
  assert.equal(retried.kind, 'revise', '重试保持 revise 意图')
  assert.equal(q('revise').disabled, true)
})

test('整改稿视图下标题栏「返回编辑」仍回到表单并保留用户原输入', (t) => {
  const { api, q, fill, click } = setup(t)
  fill('body', '原稿正文，先不改。')
  click('submit')
  api.poll()
  api.result(REPORT_POOR)
  api.revision(REVISION)

  q('edit-top').click()
  assert.equal(q('panel').getAttribute('data-view'), 'form')
  assert.equal(q('body').value, '原稿正文，先不改。', '未使用整改稿时保留用户原输入')
})

/* ---------------------------------------------------------------- site gate */

/** Register teardown for a raw jsdom document. */
function closeDom(t, dom) {
  t.after(() => {
    try {
      dom.window.__DSH_XHS_PAGE__?.destroy?.()
    } catch (error) {
      /* already destroyed */
    }
    try {
      dom.window.close()
    } catch (error) {
      /* ignore */
    }
  })
}

/** [host, expected isXhsHost] — whitelist, port/trailing-dot tolerance, lookalikes. */
const HOST_TABLE = [
  ['xiaohongshu.com', true],
  ['www.xiaohongshu.com', true],
  ['creator.xiaohongshu.com', true],
  ['WWW.XiaoHongShu.COM', true],
  ['www.xiaohongshu.com.', true],
  ['www.xiaohongshu.com:443', true],
  ['https://www.xiaohongshu.com/explore?x=1', true],
  ['https://creator.xiaohongshu.com/publish/publish', true],
  ['xiaohongshu.com.evil.com', false],
  ['www.xiaohongshu.com.evil.com', false],
  ['notxiaohongshu.com', false],
  ['evil-xiaohongshu.com', false],
  ['xiaohongshu.com.cn', false],
  ['xiaohongshu.co', false],
  ['example.com', false],
  ['', false],
]

test('白名单判定：子域放行、伪装域拦截，页面脚本与 lib/hosts.js 完全一致', (t) => {
  const dom = createDom('https://example.com/')
  closeDom(t, dom)
  dom.window.__DSH_XHS_DISABLE_BOOT__ = true
  dom.window.eval(scriptSource)
  const hooks = dom.window.__DSH_XHS_TEST__

  for (const [host, expected] of HOST_TABLE) {
    assert.equal(hooks.isXhsHost(host), expected, `page-script isXhsHost(${JSON.stringify(host)})`)
    assert.equal(isXhsHost(host), expected, `lib/hosts isXhsHost(${JSON.stringify(host)})`)
  }
  assert.equal(hooks.normalizeHostname('WWW.XiaoHongShu.COM.:443'), normalizeHostname('WWW.XiaoHongShu.COM.:443'))
})

test('非小红书页面：完全不创建 Shadow DOM 宿主，任何 API 调用也不渲染节点', (t) => {
  const dom = createDom('https://example.com/article')
  closeDom(t, dom)
  dom.window.__DSH_XHS_DISABLE_BOOT__ = true
  dom.window.eval(scriptSource)
  const hooks = dom.window.__DSH_XHS_TEST__
  const document = dom.window.document
  const api = hooks.boot()

  assert.equal(hooks.pageGate(), 'block', '外站判定为 block')
  assert.equal(document.querySelectorAll('#dsh-xhs-host').length, 0, '没有 shadow host')
  assert.equal(document.querySelectorAll('[data-role]').length, 0, '没有任何 UI 节点')
  assert.equal(document.body.children.length, 1, '没有往页面里加节点')

  api.status('busy', '评估中…', '')
  api.result(REPORT_POOR)
  api.error('失败')
  assert.equal(document.querySelectorAll('#dsh-xhs-host').length, 0, 'status/result/error 也不能把 UI 拉起来')
  assert.equal(document.body.children.length, 1)
  assert.equal(api.poll(), null)
})

test('伪装域与其他站点的真实注入路径：返回 installed，但不挂载任何节点', (t) => {
  for (const url of ['https://xiaohongshu.com.evil.com/note', 'https://notxiaohongshu.com/', 'https://example.com/']) {
    const dom = createDom(url)
    closeDom(t, dom)
    const result = dom.window.eval(scriptSource)
    assert.equal(result, 'installed', `注入返回值不变（${url}）`)
    assert.equal(dom.window.document.querySelectorAll('#dsh-xhs-host').length, 0, `不挂载：${url}`)
  }
})

test('小红书创作平台 creator.xiaohongshu.com：照常挂载悬浮球与面板', (t) => {
  const dom = createDom('https://creator.xiaohongshu.com/publish/publish')
  closeDom(t, dom)
  dom.window.eval(scriptSource)

  const host = dom.window.document.getElementById('dsh-xhs-host')
  assert.ok(host, '创作平台允许挂载')
  assert.ok(host.shadowRoot.querySelector('[data-role="ball"]'), '悬浮球在 Shadow DOM 里')
  assert.equal(dom.window.__DSH_XHS_TEST__.pageGate(), 'allow')
})

test('configure({allowAllHosts:true}) 恢复任意页面显示；默认 false 时不挂载', (t) => {
  const dom = createDom('https://example.com/article')
  closeDom(t, dom)
  dom.window.__DSH_XHS_DISABLE_BOOT__ = true
  dom.window.eval(scriptSource)
  const api = dom.window.__DSH_XHS_TEST__.boot()
  const document = dom.window.document

  assert.equal(document.getElementById('dsh-xhs-host'), null, '默认（false）外站不挂载')
  api.configure({ allowAllHosts: true })

  const host = document.getElementById('dsh-xhs-host')
  assert.ok(host, 'allowAllHosts 打开后恢复挂载')
  assert.ok(host.shadowRoot.querySelector('[data-role="ball"]'))
  api.configure({ allowAllHosts: true })
  assert.equal(document.querySelectorAll('#dsh-xhs-host').length, 1, '重复 configure 不会重复挂载')
})

test('位置未知（about:blank）但 host 注入 URL 为小红书：照常挂载，不误挡', (t) => {
  const dom = createBlankDom()
  closeDom(t, dom)
  dom.window.__DSH_XHS_INJECT_URL__ = 'https://www.xiaohongshu.com/explore'
  dom.window.__DSH_XHS_DISABLE_BOOT__ = true
  dom.window.eval(scriptSource)
  const hooks = dom.window.__DSH_XHS_TEST__

  assert.equal(hooks.pageGate(), 'allow')
  hooks.boot()
  assert.ok(dom.window.document.getElementById('dsh-xhs-host'), '按 host 提供的 URL 正常挂载')
})

test('位置未知：等待（defer）不误挂；configure 收到 URL 后再按白名单决定', (t) => {
  const dom = createBlankDom()
  closeDom(t, dom)
  dom.window.__DSH_XHS_DISABLE_BOOT__ = true
  dom.window.eval(scriptSource)
  const hooks = dom.window.__DSH_XHS_TEST__
  const api = hooks.boot()
  const document = dom.window.document

  assert.equal(hooks.pageGate(), 'defer', 'about:blank 是“等一等”，不是永久拦截')
  assert.equal(document.querySelectorAll('#dsh-xhs-host').length, 0, '位置未知时不挂载')

  api.configure({ url: 'https://example.com/' })
  assert.equal(document.querySelectorAll('#dsh-xhs-host').length, 0, '非白名单 URL 仍不挂载')

  api.configure({ url: 'https://creator.xiaohongshu.com/publish' })
  assert.ok(document.getElementById('dsh-xhs-host'), '白名单 URL 到达后挂载')
})


