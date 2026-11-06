/**
 * Host-side bridge for the sidebar-browser panel.
 *
 * The client plugin injects `page-script.js` into the Electron `<webview>` that
 * renders the built-in browser page. The injected controller performs no
 * network I/O; it publishes a pending request that the client half reads and
 * relays here through same-origin fetches on the DSH web server:
 *
 *   GET  /xhs/hosted.js   the injected controller source (re-read on each call)
 *   GET  /xhs/state       version, ensemble size and the model roster
 *   POST /xhs/evaluate    one draft -> predicted metrics + adjustment directions
 *   POST /xhs/log         diagnostics -> ~/.dsh/xhs-evaluator.log
 *
 * Keeping the network in the DSH renderer/host means the visited site never
 * receives a token and never needs CORS.
 */

import { appendFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { XhsError } from './llm.js'
import { loadPageScript } from './page-script-source.js'

/** Diagnostic log written when the client reports attach/evaluate events. */
const DIAGNOSTIC_LOG = join(homedir(), '.dsh', 'xhs-evaluator.log')
/** Rotate the diagnostic log once it grows past this size. */
const DIAGNOSTIC_LOG_LIMIT = 256 * 1024
const MAX_BODY_BYTES = 64 * 1024
const MAX_LOG_BODY_BYTES = 32 * 1024

/**
 * Create the web-server routes for the panel bridge.
 * @param {object} options
 * @param {import('./service.js').XhsEvaluator} options.evaluator
 * @param {object} [options.config]
 * @param {object} [options.logger]
 * @returns {Array<{path: string, handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void}>}
 */
export function createRoutes({ evaluator, config, logger }) {
  const log = logger ?? console

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {number} [limit]
   * @returns {Promise<any>}
   */
  async function readJson(request, limit = MAX_BODY_BYTES) {
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > limit) throw new XhsError('body-too-large', '请求体过大')
      chunks.push(chunk)
    }
    if (chunks.length === 0) return {}
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw new XhsError('bad-json', '请求体不是合法 JSON')
    }
  }

  /**
   * @param {import('node:http').ServerResponse} response
   * @param {number} status
   * @param {object} payload
   */
  function sendJson(response, status, payload) {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(JSON.stringify(payload))
  }

  /**
   * @param {import('node:http').ServerResponse} response
   * @param {unknown} error
   */
  function sendError(response, error) {
    const code = error instanceof XhsError ? error.code : 'internal'
    const status = code === 'bad-json' || code === 'body-too-large' || code === 'empty-body' || code === 'too-short' ? 400 : 502
    sendJson(response, status, {
      ok: false,
      error: code,
      message: error instanceof Error ? error.message : String(error),
    })
  }

  return [
    {
      path: '/xhs/log',
      handler: (request, response) => {
        readJson(request, MAX_LOG_BODY_BYTES)
          .then(async (body) => {
            const record = {
              at: new Date().toISOString(),
              event: typeof body?.event === 'string' ? body.event.slice(0, 60) : 'unknown',
              data: body !== null && typeof body === 'object' ? body.data ?? null : null,
            }
            try {
              await mkdir(dirname(DIAGNOSTIC_LOG), { recursive: true })
              const info = await stat(DIAGNOSTIC_LOG).catch(() => null)
              const line = JSON.stringify(record) + '\n'
              if (info !== null && info.size > DIAGNOSTIC_LOG_LIMIT) await writeFile(DIAGNOSTIC_LOG, line, 'utf8')
              else await appendFile(DIAGNOSTIC_LOG, line, 'utf8')
            } catch (error) {
              log.warn?.('xhs evaluator: diagnostic log failed: %s', String(error))
            }
            sendJson(response, 200, { ok: true })
          })
          .catch(() => {
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            response.end('{"ok":true}')
          })
      },
    },
    {
      path: '/xhs/hosted.js',
      handler: (request, response) => {
        loadPageScript()
          .then(({ source }) => {
            response.writeHead(200, {
              'content-type': 'text/javascript; charset=utf-8',
              'cache-control': 'no-store',
            })
            response.end(source)
          })
          .catch((error) => sendError(response, error))
      },
    },
    {
      path: '/xhs/state',
      handler: (request, response) => {
        evaluator
          .state()
          .then((state) => sendJson(response, 200, state))
          .catch((error) => {
            log.warn?.('xhs evaluator: state route failed: %s', String(error))
            sendError(response, error)
          })
      },
    },
    {
      path: '/xhs/evaluate',
      handler: (request, response) => {
        readJson(request)
          .then(async (body) => {
            const started = Date.now()
            const result = await evaluator.evaluate(body)
            sendJson(response, 200, {
              ok: true,
              report: result.report,
              ms: result.ms ?? Date.now() - started,
              models: result.models ?? [],
            })
          })
          .catch((error) => {
            log.warn?.('xhs evaluator: evaluate route failed: %s', String(error))
            sendError(response, error)
          })
      },
    },
    {
      path: '/xhs/revise',
      handler: (request, response) => {
        readJson(request)
          .then(async (body) => {
            const started = Date.now()
            const draft = body?.draft !== null && typeof body?.draft === 'object' ? body.draft : {}
            const report = body?.report !== null && typeof body?.report === 'object' ? body.report : {}
            const result = await evaluator.revise(draft, report)
            sendJson(response, 200, {
              ok: true,
              revision: result.revision,
              ms: result.ms ?? Date.now() - started,
              model: result.model ?? null,
            })
          })
          .catch((error) => {
            log.warn?.('xhs evaluator: revise route failed: %s', String(error))
            sendError(response, error)
          })
      },
    },
  ]
}
