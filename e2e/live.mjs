/**
 * Live end-to-end check against a RUNNING DeepSeek Harness instance.
 *
 *   node e2e/live.mjs --host http://127.0.0.1:24487
 *   node e2e/live.mjs --host http://127.0.0.1:24487 --draft weak|strong
 *
 * Exercises the exact routes the injected sidebar-browser panel calls, with the
 * real host `llm` service and the profile's real credentials (small token cost:
 * one ensemble per draft). Prints the report summary and a PASS/FAIL per check.
 */

const HOST = readOption('host') || 'http://127.0.0.1:24487'
const DRAFT = readOption('draft') || 'weak'
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', accept: 'application/json' }

const DRAFTS = {
  weak: {
    title: '第一次拍胶片，感觉还不错',
    body: '周末天气很好，就拿着相机出去拍了点照片。用的是柯达的胶卷，冲洗出来以后感觉颜色挺好看的，就是有几张曝光不太对。下次继续努力吧。',
    tags: ['胶片摄影', '日常记录'],
    niche: '其他',
    fans: '新号(<1000)',
    models: 2,
  },
  strong: {
    title: '胶片新手别买错：这3卷最耐折腾',
    body:
      '入坑胶片3个月，踩了7卷的坑，总结出新手最值得囤的3卷。\n\n' +
      '1️⃣ 柯达 ColorPlus 200：宽容度高，曝光差1档也能救，50块左右，练手首选。\n' +
      '2️⃣ 富士 C200：青色偏冷，拍街拍和天空很出片，缺点是阴天发灰。\n' +
      '3️⃣ 柯达 Portra 400：贵（120+），但人像肤色真的没对手，建议留给人像约拍。\n\n' +
      '避坑：别买过期卷、别把胶卷放在暴晒的车里、冲洗一定选有冲洗机的店（手工罐容易划伤）。\n\n' +
      '新手先囤 ColorPlus，找到感觉再升 Portra。有问题评论区问我。',
    tags: ['胶片摄影', '胶卷推荐', '胶片新手', '扫街', '柯达'],
    niche: '其他',
    fans: '新号(<1000)',
    models: 3,
  },
}

/** @param {string} name @returns {string | null} */
function readOption(name) {
  const index = process.argv.indexOf('--' + name)
  return index >= 0 && process.argv[index + 1] !== undefined ? String(process.argv[index + 1]) : null
}

/** @param {string} path @param {object} [body] @returns {Promise<any>} */
async function call(path, body) {
  const response = await fetch(HOST + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: JSON_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(240_000),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}: ${data?.message ?? 'no body'}`)
  return data
}

const checks = []
/** @param {string} name @param {boolean} ok @param {string} [detail] */
function check(name, ok, detail = '') {
  checks.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : '  ' + detail}`)
}

const state = await call('/xhs/state')
check('state.ok', state.ok === true)
check('state.version', typeof state.version === 'string', state.version)
check('state.routes', Array.isArray(state.routes) && state.routes.length > 0, JSON.stringify(state.routes.map((route) => route.label)))
check('state.limits', state.limits && state.limits.title === 20 && state.limits.body === 1000)

const hosted = await fetch(HOST + '/xhs/hosted.js').then((response) => response.text())
check('hosted.js serves the controller', /__DSH_XHS_PAGE__/.test(hosted) && /configure: configure/.test(hosted), `${hosted.length} bytes`)

const input = DRAFTS[DRAFT] ?? DRAFTS.weak
const started = Date.now()
const result = await call('/xhs/evaluate', input)
const report = result.report ?? {}
const seconds = ((Date.now() - started) / 1000).toFixed(1)

console.log('\nverdict:', report.verdictLabel, '| quality band:', report.verdict, '| confidence:', report.confidence)
console.log('reads:', report.predicted?.reads, '\nlikes:', report.predicted?.likes, '\ncollects:', report.predicted?.collects, '\ncomments:', report.predicted?.comments)
console.log('summary:', report.summary)
console.log('directions:')
for (const direction of report.directions ?? []) console.log(`  - ${direction.title} | ${direction.why}`)
const guide = report.guide ?? null
console.log('revision guide:')
if (guide === null) {
  console.log('  (none)')
} else {
  if (guide.intro) console.log('  ' + guide.intro)
  for (const section of guide.sections ?? []) {
    const example = section.example ? `（例：${section.example}）` : ''
    console.log(`  - ${section.name}：${section.advice}${example}`)
  }
}
console.log('models:', result.models?.map((model) => `${model.label}${model.ok ? '' : '(failed)'} ${model.ms}ms`).join(', '), `\nwall: ${seconds}s\n`)

const predicted = report.predicted ?? {}
const ranges = ['reads', 'likes', 'collects', 'comments'].map((key) => predicted[key] ?? {})
check('report.verdict', typeof report.verdict === 'string' && report.verdictLabel.length > 0)
check('report.predicted ranges', ranges.every((range) => Number.isFinite(range.low) && Number.isFinite(range.mid) && Number.isFinite(range.high)))
check('report.predicted ordering', ranges.every((range) => range.low <= range.mid && range.mid <= range.high))
check('report.confidence', Number.isFinite(report.confidence) && report.confidence > 0 && report.confidence <= 1, String(report.confidence))
check('report.modelCount >= 1', Number.isFinite(report.modelCount) && report.modelCount >= 1, String(report.modelCount))
check('report.signals', Array.isArray(report.signals) && report.signals.length > 0, `${report.signals?.length ?? 0} signals`)
check('report.directions present for a weak draft', report.verdict === 'viral' || report.verdict === 'strong' || (report.directions?.length ?? 0) > 0)
check('directions are directions, not finished copy', (report.directions ?? []).every((direction) => {
  const action = String(direction.action ?? '')
  return !/^(标题|开头|正文|文案)[:：]/.test(action) && action.length <= 60
}), 'no field rewrites a publishable title/opening')

const guideSections = Array.isArray(guide?.sections) ? guide.sections : []
const guideKeys = guideSections.map((section) => String(section.key ?? ''))
const GUIDE_ORDER = ['title', 'cover', 'images', 'text', 'tags']
check('report.guide present (title/cover/images/text/tags)', guide !== null && guideKeys.length === 5, JSON.stringify(guideKeys))
check('guide sections keep the fixed order', JSON.stringify(guideKeys) === JSON.stringify(GUIDE_ORDER))
check('guide advice is actionable prose', guideSections.every((section) => typeof section.name === 'string' && String(section.advice ?? '').trim().length >= 8))
check('guide examples are marked, short examples', guideSections.filter((section) => section.example).length >= 3 && guideSections.every((section) => {
  if (!section.example) return true
  const example = String(section.example)
  return example.length <= 50 && !/\n/.test(example)
}), 'at least 3 examples, each <= 50 chars on one line')
check('per-model status', Array.isArray(result.models) && result.models.length >= 1 && result.models.some((model) => model.ok))

if (process.argv.includes('--revise')) {
  const reviseStarted = Date.now()
  const revised = await call('/xhs/revise', { draft: input, report })
  const revision = revised.revision ?? {}
  const reviseSeconds = ((Date.now() - reviseStarted) / 1000).toFixed(1)
  console.log('revision (一键整改):')
  console.log('  标题：' + String(revision.title ?? ''))
  console.log('  正文：' + String(revision.body ?? '').replace(/\n/g, '\n        '))
  console.log('  标签：' + (Array.isArray(revision.tags) ? revision.tags.join(' ') : String(revision.tags ?? '')))
  if (revision.cover) console.log('  封面大字：' + revision.cover)
  if (revision.images) console.log('  内部图建议：' + revision.images)
  if (revision.summary) console.log('  改动说明：' + revision.summary)
  console.log('  model:', revised.model?.label ?? '?', `${reviseSeconds}s\n`)

  check('revise.title', typeof revision.title === 'string' && revision.title.length > 0 && revision.title.length <= 20, String(revision.title?.length))
  check('revise.body', typeof revision.body === 'string' && revision.body.length >= 8 && revision.body.length <= 1000, String(revision.body?.length))
  check('revise.tags', Array.isArray(revision.tags) && revision.tags.length >= 1 && revision.tags.length <= 10 && revision.tags.every((tag) => typeof tag === 'string' && !tag.startsWith('#')))
  check('revise.visual hints', (typeof revision.cover === 'string' && revision.cover.length <= 16) && (typeof revision.images === 'string' && revision.images.length <= 60), `cover ${revision.cover?.length ?? 0} / images ${revision.images?.length ?? 0}`)
  check('revise.summary', typeof revision.summary === 'string' && revision.summary.length > 0 && revision.summary.length <= 60)
  check('revise is not the original body', String(revision.body ?? '') !== String(input.body ?? ''), 'model actually rewrote it')
}

const failed = checks.filter((entry) => !entry.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
