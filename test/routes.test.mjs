/** Bridge route tests: request parsing, success payloads and error mapping. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRoutes } from '../lib/routes.js'
import { XhsError } from '../lib/llm.js'

/**
 * Invoke one route handler with a fake Node request/response pair.
 * @param {Function} handler
 * @param {object} [options]
 * @returns {Promise<{status: number, headers: object, body: any, text: string}>}
 */
function callHandler(handler, options = {}) {
  const { json, raw } = options
  const payload = raw !== undefined ? String(raw) : json === undefined ? '' : JSON.stringify(json)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('handler did not respond')), 5_000)
    const request = (async function* iterate() {
      if (payload !== '') yield Buffer.from(payload, 'utf8')
    })()
    request.method = 'POST'
    request.url = '/'
    const response = {
      statusCode: 0,
      headers: {},
      writeHead(status, headers) {
        this.statusCode = status
        this.headers = headers ?? {}
      },
      end(text) {
        clearTimeout(timer)
        const body = String(text ?? '')
        let parsed = null
        try {
          parsed = JSON.parse(body)
        } catch {
          parsed = null
        }
        resolve({ status: this.statusCode, headers: this.headers, body: parsed, text: body })
      },
    }
    handler(request, response)
  })
}

/** @returns {{path: string, handler: Function}[]} */
function routesFor(evaluator) {
  return createRoutes({ evaluator, config: {}, logger: { warn() {}, info() {} } })
}

/** @param {Array<{path: string, handler: Function}>} routes @param {string} path */
function route(routes, path) {
  const found = routes.find((candidate) => candidate.path === path)
  assert.ok(found, `route ${path} is registered`)
  return found.handler
}

test('registers the five bridge routes', () => {
  const routes = routesFor({ state: async () => ({ ok: true }), evaluate: async () => ({ report: {}, models: [] }), revise: async () => ({ revision: {} }) })
  assert.deepEqual(
    routes.map((candidate) => candidate.path).sort(),
    ['/xhs/evaluate', '/xhs/hosted.js', '/xhs/log', '/xhs/revise', '/xhs/state'],
  )
})

test('/xhs/state returns the evaluator state', async () => {
  const state = { ok: true, version: '0.2.0', ensemble: 2, routes: [{ id: 'a/b', label: 'a/b' }], allowAllHosts: false }
  const result = await callHandler(route(routesFor({ state: async () => state, evaluate: async () => ({}) }), '/xhs/state'))
  assert.equal(result.status, 200)
  assert.equal(result.headers['content-type'], 'application/json; charset=utf-8')
  assert.deepEqual(result.body, state)
})

test('/xhs/evaluate returns the aggregated report', async () => {
  const report = { version: 1, verdict: 'average', modelCount: 2 }
  const seen = []
  const evaluator = {
    state: async () => ({ ok: true }),
    evaluate: async (body) => {
      seen.push(body)
      return { report, ms: 12, models: [{ label: 'a', ok: true }] }
    },
  }
  const result = await callHandler(route(routesFor(evaluator), '/xhs/evaluate'), {
    json: { title: '标题', body: '正文内容', tags: ['a'], niche: '美妆护肤', fans: '1k-1w', models: 3 },
  })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.report, report)
  assert.equal(result.body.ms, 12)
  assert.deepEqual(result.body.models, [{ label: 'a', ok: true }])
  assert.equal(seen.length, 1)
  assert.equal(seen[0].models, 3)
})

test('invalid JSON maps to 400 bad-json', async () => {
  const result = await callHandler(route(routesFor({ state: async () => ({}), evaluate: async () => ({}) }), '/xhs/evaluate'), {
    raw: '{not json',
  })
  assert.equal(result.status, 400)
  assert.equal(result.body.ok, false)
  assert.equal(result.body.error, 'bad-json')
})

test('input errors map to 400, model failures to 502', async () => {
  const evaluator = {
    state: async () => ({}),
    evaluate: async () => {
      throw new XhsError('empty-body', '正文还是空的')
    },
  }
  const inputError = await callHandler(route(routesFor(evaluator), '/xhs/evaluate'), { json: { body: '' } })
  assert.equal(inputError.status, 400)
  assert.equal(inputError.body.error, 'empty-body')

  const failing = {
    state: async () => ({}),
    evaluate: async () => {
      throw new XhsError('llm-failed', '模型调用失败')
    },
  }
  const modelError = await callHandler(route(routesFor(failing), '/xhs/evaluate'), { json: { body: '正文' } })
  assert.equal(modelError.status, 502)
  assert.equal(modelError.body.error, 'llm-failed')
  assert.match(modelError.body.message, /模型调用失败/)
})

test('/xhs/hosted.js serves the injected controller as JavaScript', async () => {
  const routes = routesFor({ state: async () => ({}), evaluate: async () => ({}) })
  const result = await callHandler(route(routes, '/xhs/hosted.js'))
  assert.equal(result.status, 200)
  assert.match(String(result.headers['content-type']), /^text\/javascript/)
  assert.match(result.text, /__DSH_XHS_PAGE__/)
  assert.equal(result.headers['cache-control'], 'no-store')
  // The build placeholder is stamped with a content hash so the client can tell
  // a stale injected copy from the current one.
  assert.ok(!result.text.includes('__DSH_XHS_BUILD__'), 'placeholder is replaced')
  assert.match(result.text, /var BUILD = '[0-9a-f]{12}'/)
})

test('/xhs/revise returns the revision built from draft + report', async () => {
  const revision = { title: 'T', body: 'B', tags: ['a'], cover: 'C', images: 'I', summary: 'S' }
  const seen = []
  const evaluator = {
    state: async () => ({}),
    evaluate: async () => ({}),
    revise: async (draft, report) => {
      seen.push({ draft, report })
      return { revision, ms: 7, model: { label: 'm1' } }
    },
  }
  const result = await callHandler(route(routesFor(evaluator), '/xhs/revise'), {
    json: { draft: { title: 't', body: 'b' }, report: { verdict: 'poor', guide: { sections: [] } } },
  })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.revision, revision)
  assert.equal(result.body.ms, 7)
  assert.deepEqual(result.body.model, { label: 'm1' })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].draft.body, 'b')
  assert.equal(seen[0].report.verdict, 'poor')
})

test('/xhs/revise maps an empty draft to 400 and a model failure to 502', async () => {
  const empty = {
    state: async () => ({}),
    evaluate: async () => ({}),
    revise: async () => {
      throw new XhsError('empty-body', '正文还是空的')
    },
  }
  const emptyResult = await callHandler(route(routesFor(empty), '/xhs/revise'), { json: { draft: {} } })
  assert.equal(emptyResult.status, 400)
  assert.equal(emptyResult.body.error, 'empty-body')

  const failing = {
    state: async () => ({}),
    evaluate: async () => ({}),
    revise: async () => {
      throw new XhsError('llm-failed', '模型调用失败')
    },
  }
  const failedResult = await callHandler(route(routesFor(failing), '/xhs/revise'), { json: { draft: { body: '正文' } } })
  assert.equal(failedResult.status, 502)
  assert.equal(failedResult.body.error, 'llm-failed')
})

test('/xhs/log always answers ok so diagnostics never break the panel', async () => {
  const routes = routesFor({ state: async () => ({}), evaluate: async () => ({}) })
  const result = await callHandler(route(routes, '/xhs/log'), { json: { event: 'test', data: { a: 1 } } })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
})
