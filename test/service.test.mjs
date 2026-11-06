/** Evaluator service tests: config clamping, route registration, input gates. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { XhsEvaluator, normalizeConfig, VERSION } from '../lib/service.js'

/** A minimal plausible per-model report the fake engine returns. */
function modelReport(reads) {
  return {
    reads: { low: reads, high: reads * 2 },
    likes: { low: 10, high: 40 },
    collects: { low: 5, high: 20 },
    comments: { low: 1, high: 6 },
    engagementRate: 0.04,
    quality: 58,
    confidence: 0.6,
    summary: '钩子一般，靠封面撑场。',
    signals: [{ label: '标题钩子', level: 'warn', note: '偏泛' }],
    directions: [{ title: '收紧人群', why: '没有人群锚点', action: '补上明确人群与场景' }],
  }
}

/** Build a plugin context with a fake web server and optional fake engine. */
function makeEvaluator({ engine, webServer } = {}) {
  const registered = []
  const server = webServer ?? {
    register(route) {
      registered.push(route.path)
      return () => {}
    },
  }
  const ctx = { get: (name) => (name === 'webServer' ? server : undefined) }
  const evaluator = new XhsEvaluator({ ctx, config: {}, logger: { info() {}, warn() {} } })
  if (engine !== undefined) evaluator.engine = engine
  evaluator.registeredPaths = registered
  return { evaluator, registered }
}

test('normalizeConfig applies defaults and clamps the ensemble', () => {
  const defaults = normalizeConfig(undefined)
  assert.equal(defaults.ensemble, 2)
  assert.equal(defaults.callTimeoutMs, 45_000)
  assert.equal(defaults.maxTokens, 1800)
  assert.equal(defaults.temperature, 0.3)
  assert.deepEqual(defaults.models, [])

  const clamped = normalizeConfig({ ensemble: 9, models: [{ provider: 'p', model: 'm' }, { provider: '', model: 'x' }, null, { provider: 'q', model: 'n', label: 'N' }] })
  assert.equal(clamped.ensemble, 3)
  assert.deepEqual(clamped.models, [
    { provider: 'p', model: 'm', label: 'p/m' },
    { provider: 'q', model: 'n', label: 'N' },
  ])
  assert.equal(normalizeConfig({ ensemble: -4 }).ensemble, 1)
})

test('registerRoutes registers the bridge on the host web server', () => {
  const { evaluator, registered } = makeEvaluator()
  evaluator.registerRoutes()
  assert.deepEqual(registered.sort(), ['/xhs/evaluate', '/xhs/hosted.js', '/xhs/log', '/xhs/revise', '/xhs/state'])
  assert.equal(evaluator.paths.length, 5)
  evaluator.stop()
  assert.deepEqual(evaluator.paths, [])
})

test('registerRoutes is a no-op without a web server', () => {
  const evaluator = new XhsEvaluator({ ctx: { get: () => undefined }, config: {}, logger: { info() {}, warn() {} } })
  evaluator.registerRoutes()
  assert.deepEqual(evaluator.paths, [])
})

test('evaluate rejects an empty body and a too-short draft', async () => {
  const { evaluator } = makeEvaluator({ engine: { resolveModels: async () => [] } })
  await assert.rejects(() => evaluator.evaluate({ title: '', body: '   ' }), (error) => error.code === 'empty-body')
  await assert.rejects(() => evaluator.evaluate({ title: '', body: '短' }), (error) => error.code === 'too-short')
})

test('evaluate runs the ensemble with the requested model count and aggregates', async () => {
  const calls = []
  const engine = {
    async evaluateEnsemble(request) {
      calls.push(request)
      return {
        reports: [modelReport(1200), modelReport(1800)],
        routes: [
          { id: 'p/m1', label: 'm1', provider: 'p', model: 'm1' },
          { id: 'p/m2', label: 'm2', provider: 'p', model: 'm2' },
        ],
        failures: [],
      }
    },
  }
  const { evaluator } = makeEvaluator({ engine })
  const result = await evaluator.evaluate({ title: '一个标题', body: '这是一段足够长的正文内容，用来评估。', tags: ['穿搭'], models: 9 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].count, 3, 'requested count is clamped to the hard cap')
  assert.equal(result.report.version, 1)
  assert.equal(result.report.modelCount, 2)
  assert.equal(result.report.predicted.reads.low, 1200)
  assert.equal(result.models.length, 2)
  assert.equal(result.models[0].ok, true)
  assert.ok(result.ms >= 0)
})

test('evaluate reports partial model failures per route', async () => {
  const engine = {
    async evaluateEnsemble() {
      return {
        reports: [modelReport(900)],
        routes: [
          { id: 'p/m1', label: 'm1', provider: 'p', model: 'm1' },
          { id: 'p/m2', label: 'm2', provider: 'p', model: 'm2' },
        ],
        failures: [{ label: 'm2', error: '超时' }],
      }
    },
  }
  const { evaluator } = makeEvaluator({ engine })
  const result = await evaluator.evaluate({ body: '这是一段足够长的正文内容，用来评估。' })
  assert.equal(result.models[0].ok, true)
  assert.equal(result.models[1].ok, false)
  assert.equal(result.models[1].error, '超时')
  assert.equal(result.report.modelCount, 1)
})

test('revise rejects an empty draft and delegates to the engine with the normalized draft', async () => {
  const calls = []
  const engine = {
    async revise(request) {
      calls.push(request)
      return {
        revision: { title: '整改后', body: '整改后的正文', tags: ['a'], cover: '', images: '', summary: '' },
        route: { id: 'p/m', label: 'm', provider: 'p', model: 'm' },
        ms: 42,
      }
    },
  }
  const { evaluator } = makeEvaluator({ engine })
  await assert.rejects(() => evaluator.revise({ title: '', body: '  ' }, {}), (error) => error.code === 'empty-body')

  const result = await evaluator.revise({ title: '原稿', body: '这是一段足够长的原稿正文。', tags: ['x'] }, { verdict: 'poor' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].input.body, '这是一段足够长的原稿正文。')
  assert.deepEqual(calls[0].report, { verdict: 'poor' })
  assert.equal(result.revision.title, '整改后')
  assert.deepEqual(result.model, { label: 'm', provider: 'p', model: 'm' })
  assert.ok(result.ms >= 0)
})

test('revise tolerates a missing report', async () => {
  const engine = { revise: async ({ report }) => ({ revision: { title: 't' }, route: null, ms: 1, report }) }
  const { evaluator } = makeEvaluator({ engine })
  const result = await evaluator.revise({ body: '这是一段足够长的原稿正文。' }, undefined)
  assert.equal(result.revision.title, 't')
  assert.deepEqual(result.model, { label: '', provider: '', model: '' })
})

test('state exposes version, ensemble and limits', async () => {
  const engine = { resolveModels: async () => [{ id: 'p/m', label: 'm', provider: 'p', model: 'm' }] }
  const { evaluator } = makeEvaluator({ engine })
  const state = await evaluator.state()
  assert.equal(state.ok, true)
  assert.equal(state.version, VERSION)
  assert.equal(state.maxModels, 3)
  assert.deepEqual(state.routes, [{ id: 'p/m', label: 'm' }])
  assert.deepEqual(state.limits, { title: 20, body: 1000, tags: 10 })
  assert.deepEqual(state.ball, { side: 'left', bottom: 18 }, '球默认放左下，避开右下的翻译控件')
  assert.match(String(state.build), /^[0-9a-f]{12}$/, 'state 带注入脚本的构建号，供客户端热替换')
})

test('normalizeConfig honours the ball anchor override', () => {
  const config = normalizeConfig({ ballSide: 'right', ballBottom: 96 })
  assert.deepEqual(config.ballSide, 'right')
  assert.equal(config.ballBottom, 96)
  assert.deepEqual(normalizeConfig({ ballSide: 'nope', ballBottom: -5 }), {
    ...normalizeConfig({}),
    ballSide: 'left',
    ballBottom: 0,
  })
})

test('normalizeConfig 的站点门禁：默认 allowAllHosts=false，仅布尔 true 打开', () => {
  assert.equal(normalizeConfig(undefined).allowAllHosts, false)
  assert.equal(normalizeConfig({}).allowAllHosts, false)
  assert.equal(normalizeConfig({ allowAllHosts: true }).allowAllHosts, true)
  assert.equal(normalizeConfig({ allowAllHosts: 'true' }).allowAllHosts, false, '字符串不当作开关')
  assert.equal(normalizeConfig({ allowAllHosts: 1 }).allowAllHosts, false)
})

test('state 下发 allowAllHosts，客户端据此决定是否注入外站', async () => {
  const engine = { resolveModels: async () => [] }
  const { evaluator } = makeEvaluator({ engine })
  assert.equal((await evaluator.state()).allowAllHosts, false)

  const ctx = { get: () => undefined }
  const open = new XhsEvaluator({ ctx, config: { allowAllHosts: true }, logger: { info() {}, warn() {} } })
  open.engine = engine
  assert.equal((await open.state()).allowAllHosts, true)
})

test('state falls back to configured models when route resolution fails', async () => {
  const engine = {
    resolveModels: async () => {
      throw new Error('no model')
    },
  }
  const ctx = { get: (name) => (name === 'webServer' ? { register: () => () => {} } : undefined) }
  const evaluator = new XhsEvaluator({
    ctx,
    config: { models: [{ provider: 'p', model: 'm', label: 'M' }] },
    logger: { info() {}, warn() {} },
  })
  evaluator.engine = engine
  const state = await evaluator.state()
  assert.deepEqual(state.routes, [{ id: 'p/m', label: 'M' }])
})
