import test from 'node:test'
import assert from 'node:assert/strict'

import { LlmEvaluator, XhsError, extractJsonObject } from '../lib/llm.js'
import { revisePrompt } from '../lib/prompts.js'

/** Normalized input fixture handed to the evaluator. */
const NOTE = {
  title: '通勤包里永远有的三样东西',
  body: '第一样是充电宝。\n第二样是折叠伞。\n第三样是薄荷糖。',
  tags: ['通勤', '好物'],
  niche: '好物',
  fans: '1k-1w',
  models: 1,
}

/** A complete, contract-shaped reply. */
const GOOD_REPLY = JSON.stringify({
  reads: { low: 1200, high: 5200 },
  likes: { low: 40, high: 190 },
  collects: { low: 25, high: 130 },
  comments: { low: 3, high: 20 },
  engagementRate: 0.043,
  quality: 74,
  confidence: 0.7,
  summary: '标题钩子够强，正文留白不足。',
  signals: [{ label: '标题钩子', level: 'good', note: '痛点明确' }],
  directions: [{ title: '正文留白', why: '整段太密', action: '每段压到三行以内' }],
})

/** Same evaluation plus a 修改指引 payload, as the new prompt asks for. */
const GUIDE_REPLY = JSON.stringify({
  ...JSON.parse(GOOD_REPLY),
  guide: {
    intro: '先把标题里的场景说具体',
    sections: [
      {
        key: 'title',
        name: '标题',
        advice: '把人群与场景写进前 8 个字，避免形容词开场',
        example: '通勤包里永远有的三样',
      },
      { key: 'cover', name: '封面', advice: '封面只放一个结果和一个数字，大字不超过 12 字', example: '3 样东西解决通勤' },
      { key: 'tags', name: '标签', advice: '核心词、场景词、人群词各取一个', example: '通勤 收纳 打工人' },
    ],
  },
})

/** A finished 整改稿 reply for the revise tests (title ≤20, body keeps breaks). */
const REVISION_REPLY = JSON.stringify({
  title: '通勤包里永远有的三样东西（打工人版）',
  body: '第一样是充电宝。\n\n第二样是折叠伞。\n\n第三样是薄荷糖。',
  tags: ['#通勤', '通勤', '好物', '收纳'],
  cover: '通勤包三件套',
  images: '三样物品平铺一张，再加一张放进包里的场景',
  summary: '把标题写具体，正文补了分段',
})

/** The Report the panel would hand to 一键整改. */
const REPORT = {
  version: 1,
  verdict: 'weak',
  verdictLabel: '偏弱',
  summary: '标题太泛，正文没有分段。',
  confidence: 0.55,
  predicted: {
    reads: { low: 200, mid: 500, high: 900 },
    likes: { low: 5, mid: 12, high: 30 },
    collects: { low: 3, mid: 8, high: 20 },
    comments: { low: 0, mid: 1, high: 3 },
    engagementRate: 0.04,
  },
  signals: [{ label: '标题钩子', level: 'bad', note: '信息太泛' }],
  directions: [{ title: '标题具体化', why: '没有场景', action: '把人群和场景前移' }],
  guide: {
    intro: '先改标题',
    sections: [{ key: 'title', name: '标题', advice: '写清人群和场景', example: '通勤包三件套' }],
  },
  modelCount: 1,
  spread: 0,
  ts: 1,
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Fake host `llm` service: one `prepareCall` and one streaming generator, with
 * knobs for the failure modes the bridge must survive.
 *
 * @param {object} [options]
 * @param {string[]} [options.models] - catalog advertised by `listModels`.
 * @param {boolean} [options.catalog] - when false, `listModels` throws.
 * @param {boolean} [options.rejectOff] - reject `reasoningEffort: 'off'`.
 * @param {Record<string, string|Error|Array<string|Error>>} [options.replies] - reply per model id;
 *   an array is consumed call-by-call, so a test can script "bad reply, then good reply".
 * @param {number} [options.delayMs] - delay before the first delta.
 * @returns {{llm: object, state: object}}
 */
function makeLlm(options = {}) {
  const { models = ['m1', 'm2', 'm3'], catalog = true, rejectOff = false, replies = {}, delayMs = 0 } = options
  const state = { prepareCalls: [], preparedConfigs: [], listModelsCalls: 0, streamed: [] }
  /** Per-model call counter; only advanced once a call is actually prepared. */
  const replyCounts = new Map()
  const nextReply = (model) => {
    const entry = replies[model]
    const index = replyCounts.get(model) ?? 0
    replyCounts.set(model, index + 1)
    if (!Array.isArray(entry)) return entry
    return entry[Math.min(index, entry.length - 1)]
  }

  const llm = {
    async listModels(provider) {
      state.listModelsCalls += 1
      if (!catalog) throw new Error('catalog unavailable')
      return models.map((id) => ({ provider, id, name: id.toUpperCase() }))
    },

    async prepareCall(config, signal, configure) {
      state.prepareCalls.push({ ...config })
      const modelInfo = {
        provider: config.provider,
        id: config.model,
        name: config.model,
        // Deliberately does not advertise `off`: a rejected `off` must fall back
        // to the lowest advertised effort, which is `low`.
        reasoning: { efforts: [{ id: 'low', name: 'low' }, { id: 'high', name: 'high' }] },
      }
      const controls = typeof configure === 'function' ? configure(config, modelInfo) : config
      if (rejectOff && controls.reasoningEffort === 'off') {
        const error = new Error('reasoning effort "off" is not supported by this model')
        error.code = 'UNSUPPORTED_REASONING_EFFORT'
        throw error
      }
      const preparedConfig = { ...config, ...controls }
      state.preparedConfigs.push(preparedConfig)
      // Chosen at prepare time so a scripted reply sequence advances once per call.
      const reply = nextReply(config.model)
      return {
        config: preparedConfig,
        stream(streamOptions) {
          state.streamed.push({ model: config.model, signal: streamOptions?.signal })
          return streamChunks({ text: reply, delayMs, signal: streamOptions?.signal })
        },
      }
    },
  }

  return { llm, state }
}

/**
 * @param {object} options
 * @param {string|Error|undefined} options.text
 * @param {number} options.delayMs
 * @param {AbortSignal|undefined} options.signal
 * @returns {AsyncGenerator<object>}
 */
function streamChunks({ text, delayMs, signal }) {
  return (async function* generate() {
    if (delayMs > 0) await sleep(delayMs)
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    if (text instanceof Error) throw text
    const reply = typeof text === 'string' ? text : GOOD_REPLY
    const half = Math.ceil(reply.length / 2)
    for (const part of [reply.slice(0, half), reply.slice(half)]) {
      if (part === '') continue
      yield { type: 'text-delta', index: 0, text: part }
    }
    yield { type: 'finish', index: 0, reason: { kind: 'stop' } }
  })()
}

/**
 * @param {object} options
 * @param {object} options.llm
 * @param {{provider: string, model: string}} [options.selection]
 * @returns {{get: (name: string) => unknown}}
 */
function makeContext({ llm, selection = { provider: 'p', model: 'm1' } }) {
  return {
    get(name) {
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel') return { currentSelection: () => selection }
      return undefined
    },
  }
}

/* ------------------------------------------------------------------ *
 * extractJsonObject / XhsError
 * ------------------------------------------------------------------ */

test('extractJsonObject tolerates fences, prose and nested braces', () => {
  assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(extractJsonObject('好的，结果如下：{"a":{"b":[1,2]}} 以上。'), { a: { b: [1, 2] } })
  assert.deepEqual(extractJsonObject('{"s":"a}b"}'), { s: 'a}b' })
  assert.equal(extractJsonObject('这里没有任何 JSON'), null)
  assert.equal(extractJsonObject(''), null)
  assert.equal(extractJsonObject(null), null)
})

test('XhsError carries a stable code and details', () => {
  const error = new XhsError('llm-failed', '模型挂了', { failures: [] })
  assert.ok(error instanceof Error)
  assert.equal(error.name, 'XhsError')
  assert.equal(error.code, 'llm-failed')
  assert.equal(error.message, '模型挂了')
  assert.deepEqual(error.details, { failures: [] })
  assert.equal('details' in new XhsError('x', 'y'), false)
})

/* ------------------------------------------------------------------ *
 * route resolution
 * ------------------------------------------------------------------ */

test('resolveModels uses the host default model for a single-model run', async () => {
  const { llm, state } = makeLlm()
  const evaluator = new LlmEvaluator({ ctx: makeContext({ llm }), config: { ensemble: 1 } })

  const routes = await evaluator.resolveModels(1)

  assert.deepEqual(routes, [{ id: 'p/m1', label: 'm1', provider: 'p', model: 'm1' }])
  assert.equal(state.listModelsCalls, 0, 'no catalog lookup is needed when the cap is already met')
})

test('resolveModels prefers explicit config and tops up from the provider catalog', async () => {
  const { llm, state } = makeLlm({ models: ['m1', 'm2', 'm3', 'm4'] })
  const evaluator = new LlmEvaluator({
    ctx: makeContext({ llm }),
    config: { models: ['p/m1'], ensemble: 3 },
  })

  const routes = await evaluator.resolveModels(3)

  assert.deepEqual(
    routes.map((route) => route.id),
    ['p/m1', 'p/m2', 'p/m3'],
  )
  assert.equal(state.listModelsCalls, 1)
  assert.deepEqual(
    routes.map((route) => route.label),
    ['M1', 'M2', 'M3'],
  )
})

test('resolveModels dedupes by provider/model and caps the list', async () => {
  const { llm } = makeLlm()
  const evaluator = new LlmEvaluator({
    ctx: makeContext({ llm }),
    config: { models: ['p/m1', 'p/m1', { provider: 'q', model: 'x1', label: 'X One' }], ensemble: 2 },
  })

  const routes = await evaluator.resolveModels(2)

  assert.deepEqual(
    routes.map((route) => route.id),
    ['p/m1', 'q/x1'],
  )
  assert.equal(routes[1].label, 'X One')
})

test('resolveModels survives a failing model catalog', async () => {
  const { llm } = makeLlm({ catalog: false })
  const evaluator = new LlmEvaluator({ ctx: makeContext({ llm }), config: { ensemble: 3 } })

  const routes = await evaluator.resolveModels(3)

  assert.deepEqual(
    routes.map((route) => route.id),
    ['p/m1'],
    'the default route still works when the catalog lookup throws',
  )
})

test('config provider/model wins over the host default selection', async () => {
  const { llm } = makeLlm()
  const evaluator = new LlmEvaluator({
    ctx: makeContext({ llm, selection: { provider: 'dsh', model: 'default-m' } }),
    config: { provider: 'cfg', model: 'cfg-m', ensemble: 1 },
  })

  assert.deepEqual(evaluator.defaultRoute(), { provider: 'cfg', model: 'cfg-m' })
  const routes = await evaluator.resolveModels(1)
  assert.equal(routes[0].id, 'cfg/cfg-m')
})

test('a missing llm service throws llm-unavailable', async () => {
  const evaluator = new LlmEvaluator({ ctx: { get: () => undefined } })
  await assert.rejects(
    () => evaluator.evaluateEnsemble({ input: NOTE, count: 1 }),
    (error) => {
      assert.ok(error instanceof XhsError)
      assert.equal(error.code, 'llm-unavailable')
      return true
    },
  )
})

test('no resolvable route throws no-model-route', async () => {
  const { llm } = makeLlm()
  const evaluator = new LlmEvaluator({
    ctx: makeContext({ llm, selection: { provider: '', model: '' } }),
  })
  await assert.rejects(
    () => evaluator.resolveModels(1),
    (error) => {
      assert.equal(error.code, 'no-model-route')
      return true
    },
  )
})

/* ------------------------------------------------------------------ *
 * single call
 * ------------------------------------------------------------------ */

test('evaluateOne normalizes the model reply into a ModelReport', async () => {
  const { llm, state } = makeLlm()
  const evaluator = new LlmEvaluator({ ctx: makeContext({ llm }), config: { ensemble: 1 } })

  const result = await evaluator.evaluateOne({
    input: NOTE,
    route: { id: 'p/m1', label: 'm1', provider: 'p', model: 'm1' },
  })

  assert.equal(result.route.id, 'p/m1')
  assert.ok(result.ms >= 0)
  assert.deepEqual(result.report.reads, { low: 1200, high: 5200 })
  assert.equal(result.report.quality, 74)
  assert.equal(result.report.directions.length, 1)
  assert.equal(state.prepareCalls[0].reasoningEffort, 'off')
  assert.equal(state.prepareCalls[0].maxTokens, 1800)
  assert.equal(state.prepareCalls[0].temperature, 0.3)
})

test('evaluateOne preserves a normalized guide from the model reply', async () => {
  const { llm } = makeLlm({ replies: { m1: GUIDE_REPLY } })
  const evaluator = new LlmEvaluator({ ctx: makeContext({ llm }), config: { ensemble: 1 } })

  const result = await evaluator.evaluateOne({
    input: NOTE,
    route: { id: 'p/m1', label: 'm1', provider: 'p', model: 'm1' },
  })

  assert.ok(result.report.guide !== null, 'guide must survive the bridge')
  assert.equal(result.report.guide.intro, '先把标题里的场景说具体')
  assert.deepEqual(
    result.report.guide.sections.map((section) => section.key),
    ['title', 'cover', 'tags'],
  )
  assert.equal(result.report.guide.sections[0].advice, '把人群与场景写进前 8 个字，避免形容词开场')
  assert.equal(result.report.guide.sections[1].example, '3 样东西解决通勤')
  assert.equal(result.report.quality, 74, 'the rest of the report is unchanged')
})

test('a rejected reasoning effort retries with the lowest advertised effort', async () => {
  const { llm, state } = makeLlm({ rejectOff: true })
  const evaluator = new LlmEvaluator({ ctx: makeContext({ llm }), config: { ensemble: 1 } })

  const result = await evaluator.evaluateEnsemble({ input: NOTE, count: 1 })

  assert.equal(result.reports.length, 1)
  assert.equal(state.prepareCalls.length, 2)
  assert.equal(state.prepareCalls[0].reasoningEffort, 'off')
  assert.equal(state.prepareCalls[1].reasoningEffort, 'off')
  assert.equal(state.preparedConfigs.length, 1)
  assert.equal(state.preparedConfigs[0].reasoningEffort, 'low')
})

test('a host without prepareCall throws llm-incompatible', async () => {
  const evaluator = new LlmEvaluator({
    ctx: makeContext({ llm: { listModels: async () => [] } }),
    config: { ensemble: 1 },
  })

  await assert.rejects(
    () =>
      evaluator.evaluateOne({
        input: NOTE,
        route: { id: 'p/m1', label: 'm1', provider: 'p', model: 'm1' },
      }),
    (error) => {
      assert.ok(error instanceof XhsError)
      assert.equal(error.code, 'llm-incompatible')
      return true
    },
  )
})

test('callTimeoutMs aborts a slow call with code timeout', async () => {
  const { llm } = makeLlm({ delayMs: 200 })
  const evaluator = new LlmEvaluator({
    ctx: makeContext({ llm }),
    config: { ensemble: 1, callTimeoutMs: 25 },
  })

  await assert.rejects(
    () =>
      evaluator.evaluateOne({
        input: NOTE,
        route: { id: 'p/m1', label: 'm1', provider: 'p', model: 'm1' },
      }),
    (error) => {
      assert.ok(error instanceof XhsError)
      assert.equal(error.code, 'timeout')
      return true
    },
  )
})

/* ------------------------------------------------------------------ *
 * ensemble
 * ------------------------------------------------------------------ */

test('evaluateEnsemble merges a single model', async () => {
  const { llm } = makeLlm()
  const evaluator = new LlmEvaluator({ ctx: makeContext({ llm }), config: { ensemble: 1 } })

  const result = await evaluator.evaluateEnsemble({ input: NOTE, count: 1 })

  assert.equal(result.reports.length, 1)
  assert.equal(result.routes.length, 1)
  assert.equal(result.failures.length, 0)
  assert.deepEqual(
    result.attempts.map((attempt) => attempt.ok),
    [true],
  )
  assert.equal(result.reports[0].engagementRate, 0.043)
})

test('evaluateEnsemble keeps going when one model fails', async () => {
  const { llm } = makeLlm({ replies: { m2: '抱歉，我无法给出这个评估。' } })
  const evaluator = new LlmEvaluator({ ctx: makeContext({ llm }), config: { ensemble: 2 } })

  const result = await evaluator.evaluateEnsemble({ input: NOTE, count: 2 })

  assert.equal(result.reports.length, 1)
  // every attempted route is listed so the caller can render per-model status
  assert.deepEqual(
    result.routes.map((route) => route.id),
    ['p/m1', 'p/m2'],
  )
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].label, 'M2')
  assert.equal(result.failures[0].error.code, 'bad-response')
  assert.equal(result.attempts.length, 2)
  assert.equal(
    result.attempts.filter((attempt) => attempt.ok === false)[0].label,
    'M2',
  )
})

test('the ensemble result maps to a per-model status list (service.js contract)', async () => {
  const { llm } = makeLlm({ replies: { m2: new Error('boom') } })
  const evaluator = new LlmEvaluator({ ctx: makeContext({ llm }), config: { ensemble: 2 } })

  const { reports, routes, failures } = await evaluator.evaluateEnsemble({ input: NOTE, count: 2 })
  const failedLabels = new Map(failures.map((failure) => [failure.label, failure.error]))
  const models = routes.map((route) => ({
    label: route.label,
    ok: !failedLabels.has(route.label),
    error: failedLabels.get(route.label),
  }))

  assert.equal(reports.length, 1)
  assert.deepEqual(
    models.map((model) => model.ok),
    [true, false],
  )
  assert.equal(models[1].error.code, 'llm-failed')
})

test('evaluateEnsemble treats a non-JSON reply as a model failure', async () => {
  const { llm } = makeLlm({ replies: { m1: '我觉得这条笔记还行，但没有 JSON。' } })
  const evaluator = new LlmEvaluator({ ctx: makeContext({ llm }), config: { ensemble: 1 } })

  await assert.rejects(
    () => evaluator.evaluateEnsemble({ input: NOTE, count: 1 }),
    (error) => {
      assert.ok(error instanceof XhsError)
      assert.equal(error.code, 'llm-failed')
      assert.equal(error.details.failures.length, 1)
      assert.equal(error.details.failures[0].error.code, 'bad-response')
      return true
    },
  )
})

test('evaluateEnsemble throws llm-failed when every model fails', async () => {
  const { llm } = makeLlm({ replies: { m1: new Error('boom'), m2: new Error('boom') } })
  const evaluator = new LlmEvaluator({ ctx: makeContext({ llm }), config: { ensemble: 2 } })

  await assert.rejects(
    () => evaluator.evaluateEnsemble({ input: NOTE, count: 2 }),
    (error) => {
      assert.ok(error instanceof XhsError)
      assert.equal(error.code, 'llm-failed')
      assert.equal(error.details.failures.length, 2)
      return true
    },
  )
})

test('evaluateEnsemble runs the resolved routes in parallel', async () => {
  const { llm, state } = makeLlm({ replies: { m1: GOOD_REPLY, m2: GOOD_REPLY } })
  const evaluator = new LlmEvaluator({ ctx: makeContext({ llm }), config: { ensemble: 2 } })

  const result = await evaluator.evaluateEnsemble({ input: NOTE, count: 2 })

  assert.equal(result.reports.length, 2)
  assert.equal(result.failures.length, 0)
  assert.deepEqual(
    result.routes.map((route) => route.id),
    ['p/m1', 'p/m2'],
  )
  assert.equal(state.streamed.length, 2)
  assert.ok(
    state.streamed.every((entry) => entry.signal !== undefined),
    'each stream call receives a cancellation signal',
  )
})

/* ------------------------------------------------------------------ *
 * 一键整改 (revise)
 * ------------------------------------------------------------------ */

test('revise rewrites the draft with one model at the revision sampling settings', async () => {
  // The config asks for an ensemble, but 整改 must always use exactly one voice.
  const { llm, state } = makeLlm({ replies: { m1: REVISION_REPLY } })
  const evaluator = new LlmEvaluator({ ctx: makeContext({ llm }), config: { ensemble: 3 } })

  const result = await evaluator.revise({ input: NOTE, report: REPORT })

  assert.equal(result.route.id, 'p/m1')
  assert.ok(result.ms >= 0)
  assert.equal(result.revision.title, '通勤包里永远有的三样东西（打工人版）')
  assert.deepEqual(result.revision.tags, ['通勤', '好物', '收纳'])
  assert.ok(result.revision.body.includes('\n\n'), 'paragraph breaks survive the bridge')
  assert.equal(result.revision.cover, '通勤包三件套')
  assert.equal(result.revision.summary, '把标题写具体，正文补了分段')

  assert.equal(state.prepareCalls.length, 1, 'one model call only')
  assert.deepEqual(
    state.streamed.map((entry) => entry.model),
    ['m1'],
  )
  assert.equal(state.prepareCalls[0].reasoningEffort, 'off')
  assert.equal(state.prepareCalls[0].temperature, 0.7)
  assert.equal(state.prepareCalls[0].maxTokens, 1400)
})

test('revise retries once when the reply is not JSON', async () => {
  const { llm, state } = makeLlm({ replies: { m1: ['这不是 JSON，只是闲聊。', REVISION_REPLY] } })
  const evaluator = new LlmEvaluator({ ctx: makeContext({ llm }), config: { ensemble: 1 } })

  const result = await evaluator.revise({ input: NOTE, report: REPORT })

  assert.equal(result.revision.cover, '通勤包三件套')
  assert.equal(state.prepareCalls.length, 2, 'the bad reply is retried exactly once')
})

test('revise throws llm-failed after two unusable replies', async () => {
  const { llm, state } = makeLlm({ replies: { m1: ['没有 JSON。', '还是没有 JSON。'] } })
  const evaluator = new LlmEvaluator({ ctx: makeContext({ llm }), config: { ensemble: 1 } })

  await assert.rejects(
    () => evaluator.revise({ input: NOTE, report: REPORT }),
    (error) => {
      assert.ok(error instanceof XhsError)
      assert.equal(error.code, 'llm-failed')
      assert.equal(error.details.attempts, 2)
      assert.equal(error.details.lastCode, 'bad-response')
      return true
    },
  )
  assert.equal(state.prepareCalls.length, 2)
})

test('revise falls back to the draft when the model omits fields', async () => {
  const { llm } = makeLlm({ replies: { m1: JSON.stringify({ cover: '只给了封面' }) } })
  const evaluator = new LlmEvaluator({ ctx: makeContext({ llm }), config: { ensemble: 1 } })

  const result = await evaluator.revise({ input: NOTE, report: REPORT })

  assert.equal(result.revision.title, NOTE.title)
  assert.equal(result.revision.body, NOTE.body)
  assert.deepEqual(result.revision.tags, NOTE.tags)
  assert.equal(result.revision.cover, '只给了封面')
})

test('revisePrompt hands the model the draft and the evaluation conclusions', () => {
  const prompt = revisePrompt({ draft: NOTE, report: REPORT })

  assert.match(prompt.system, /成稿/)
  assert.match(prompt.system, /不得编造/)
  assert.match(prompt.user, /通勤包里永远有的三样东西/)
  assert.match(prompt.user, /偏弱/)
  assert.match(prompt.user, /修改指引/)
  assert.match(prompt.user, /"cover"/)
  assert.match(prompt.user, /"images"/)
  assert.match(prompt.user, /"summary"/)

  const bare = revisePrompt({ draft: NOTE, report: null })
  assert.match(bare.user, /没有可用的评估结论/)
})
