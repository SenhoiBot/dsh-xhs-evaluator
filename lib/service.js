/**
 * Host service lifecycle for the Xiaohongshu note evaluator.
 *
 * Owns:
 *  - the LLM ensemble (N host models through `ctx.llm`, no provider key),
 *  - the `/xhs/*` bridge routes on the DSH web server that the injected
 *    sidebar-browser client half calls with same-origin fetches,
 *  - config normalization and the small state payload the panel can show.
 *
 * Nothing here touches the visited page: the guest page only renders.
 */

import { LIMITS, normalizeInput, aggregateReport } from './evaluate.js'
import { LlmEvaluator, XhsError } from './llm.js'
import { createRoutes } from './routes.js'
import { loadPageScript } from './page-script-source.js'

/** Package version, echoed by `/xhs/state`. */
export const VERSION = '0.2.0'

/** Hard cap on the ensemble size regardless of what a client asks for. */
const MAX_MODELS = 3

/**
 * Normalize raw config from the profile patch.
 * @param {object} [raw]
 * @returns {object}
 */
export function normalizeConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  const ensemble = Number(config.ensemble)
  const callTimeoutMs = Number(config.callTimeoutMs)
  const maxTokens = Number(config.maxTokens)
  const temperature = Number(config.temperature)
  // The ball shares the page with the sidebar-browser translator pill, which owns
  // the bottom-right corner; bottom-left is the collision-free default.
  const ballBottom = Number(config.ballBottom)
  /** @type {Array<{provider: string, model: string, label?: string}>} */
  const models = []
  if (Array.isArray(config.models)) {
    for (const entry of config.models) {
      if (entry === null || typeof entry !== 'object') continue
      const provider = typeof entry.provider === 'string' ? entry.provider.trim() : ''
      const model = typeof entry.model === 'string' ? entry.model.trim() : ''
      if (provider === '' || model === '') continue
      const label = typeof entry.label === 'string' && entry.label.trim() !== '' ? entry.label.trim() : `${provider}/${model}`
      models.push({ provider, model, label })
    }
  }
  return {
    provider: typeof config.provider === 'string' ? config.provider.trim() : '',
    model: typeof config.model === 'string' ? config.model.trim() : '',
    models,
    ensemble: Number.isFinite(ensemble) ? Math.min(MAX_MODELS, Math.max(1, Math.round(ensemble))) : 2,
    callTimeoutMs: Number.isFinite(callTimeoutMs) && callTimeoutMs > 0 ? callTimeoutMs : 45_000,
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 1800,
    temperature: Number.isFinite(temperature) ? temperature : 0.3,
    ballSide: config.ballSide === 'right' ? 'right' : 'left',
    ballBottom: Number.isFinite(ballBottom) ? Math.min(240, Math.max(0, Math.round(ballBottom))) : 18,
    // Site gate: XHS-only by default. `allowAllHosts: true` restores the old
    // "any http(s) page shows the ball" behaviour.
    allowAllHosts: config.allowAllHosts === true,
  }
}

/**
 * Evaluator service: one instance per plugin load.
 */
export class XhsEvaluator {
  /**
   * @param {object} options
   * @param {object} options.ctx - plugin context.
   * @param {object} [options.config] - raw patch config.
   * @param {object} [options.logger] - logger (info/warn/error).
   */
  constructor({ ctx, config, logger }) {
    this.ctx = ctx
    this.log = logger ?? console
    this.config = normalizeConfig(config)
    this.engine = new LlmEvaluator({ ctx, logger: this.log, config: this.config })
    this.startedAt = Date.now()
    /** @type {Array<() => void>} */
    this.disposers = []
    /** @type {string[]} */
    this.paths = []
    /** @type {{at: number, routes: Array<{id: string, label: string}>} | null} */
    this.routeCache = null
  }

  /** @returns {object | undefined} the host web server, when this profile has one. */
  webServer() {
    try {
      return typeof this.ctx.get === 'function' ? this.ctx.get('webServer') : this.ctx.webServer
    } catch {
      return undefined
    }
  }

  /**
   * Register the `/xhs/*` routes. Best effort: a headless profile without a web
   * server simply skips them (there is no sidebar browser there either).
   * @returns {void}
   */
  registerRoutes() {
    const webServer = this.webServer()
    if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
      this.log.info?.('xhs evaluator: no webServer service; bridge routes skipped')
      return
    }
    let routes
    try {
      routes = createRoutes({ evaluator: this, config: this.config, logger: this.log })
    } catch (error) {
      this.log.warn?.('xhs evaluator: could not build routes: %s', String(error))
      return
    }
    for (const route of routes) {
      try {
        const dispose = webServer.register({ path: route.path, kind: 'exact', handler: route.handler })
        if (typeof dispose === 'function') this.disposers.push(dispose)
        this.paths.push(route.path)
      } catch (error) {
        this.log.warn?.('xhs evaluator: route %s registration failed: %s', route.path, String(error))
      }
    }
    this.log.info?.('xhs evaluator: bridge routes registered (%s)', this.paths.join(', '))
  }

  /**
   * Best-effort model roster for the panel: `config.models`, then the resolved
   * default route, then same-provider catalog neighbours when the adapter
   * advertises them quickly. Never throws, never waits longer than 2.5s.
   * @returns {Promise<Array<{id: string, label: string}>>}
   */
  async models() {
    const now = Date.now()
    if (this.routeCache !== null && now - this.routeCache.at < 60_000) return this.routeCache.routes
    let routes = []
    try {
      const resolved = await withTimeout(this.engine.resolveModels(this.config.ensemble), 2_500)
      routes = resolved.map((route) => ({ id: route.id, label: route.label }))
    } catch {
      routes = this.config.models.map((entry) => ({ id: `${entry.provider}/${entry.model}`, label: entry.label ?? `${entry.provider}/${entry.model}` }))
    }
    this.routeCache = { at: now, routes }
    return routes
  }

  /**
   * Content hash of the injected controller, so the client half can hot-swap a
   * stale copy running inside an already-open browser page.
   * @returns {Promise<string | null>}
   */
  async scriptBuild() {
    try {
      return (await loadPageScript()).build
    } catch {
      return null
    }
  }

  /**
   * `GET /xhs/state` payload.
   * @returns {Promise<object>}
   */
  async state() {
    return {
      ok: true,
      version: VERSION,
      ensemble: this.config.ensemble,
      maxModels: MAX_MODELS,
      routes: await this.models(),
      limits: { title: LIMITS.title, body: LIMITS.body, tags: LIMITS.tags },
      ball: { side: this.config.ballSide, bottom: this.config.ballBottom },
      allowAllHosts: this.config.allowAllHosts,
      build: await this.scriptBuild(),
      uptimeMs: Date.now() - this.startedAt,
    }
  }

  /**
   * Evaluate one draft with the model ensemble and aggregate the replies.
   * @param {object} input - raw request body from the panel.
   * @returns {Promise<{report: object, ms: number, models: Array<object>}>}
   */
  async evaluate(input) {
    const clean = normalizeInput(input, this.config.ensemble)
    if (clean.body === '') {
      throw new XhsError('empty-body', '正文还是空的：先把你打算发的正文粘进来')
    }
    if (clean.title === '' && clean.body.length < 8) {
      throw new XhsError('too-short', '内容太短了：至少给一个标题，或者多写几句正文')
    }
    const requested = Number.isFinite(clean.models) ? Math.round(clean.models) : this.config.ensemble
    const count = Math.min(MAX_MODELS, Math.max(1, requested))
    const started = Date.now()
    const { reports, routes, failures, attempts } = await this.engine.evaluateEnsemble({ input: clean, count })
    const report = aggregateReport(reports, { routes })
    const failedLabels = new Map(failures.map((failure) => [failure.label, failure.error]))
    // `attempts` (when the engine reports it) carries the per-model duration; fall
    // back to the route/failure join so older engines still produce a status list.
    const statuses =
      Array.isArray(attempts) && attempts.length > 0
        ? attempts
        : routes.map((route) => ({
            label: route.label,
            ok: !failedLabels.has(route.label),
            error: failedLabels.get(route.label),
          }))
    return {
      report,
      ms: Date.now() - started,
      models: statuses.map((status) => {
        const route = routes.find((candidate) => candidate.label === status.label)
        return {
          label: status.label,
          provider: route?.provider ?? '',
          model: route?.model ?? '',
          ok: status.ok === true,
          ms: Number.isFinite(status.ms) ? status.ms : undefined,
          error: describeFailure(status.error),
        }
      }),
    }
  }

  /**
   * 一键整改：rewrite the draft into a publishable revision guided by the report.
   * @param {object} draft - the draft the user evaluated.
   * @param {object} report - the Report the panel is showing (may be empty).
   * @returns {Promise<{revision: object, ms: number, model: object}>}
   */
  async revise(draft, report) {
    const clean = normalizeInput(draft, this.config.ensemble)
    if (clean.body === '') {
      throw new XhsError('empty-body', '正文还是空的，没法整改：先填一版原稿再评估')
    }
    const started = Date.now()
    const { revision, route } = await this.engine.revise({
      input: clean,
      report: report !== null && typeof report === 'object' ? report : {},
    })
    return {
      revision,
      ms: Date.now() - started,
      model: {
        label: route?.label ?? '',
        provider: route?.provider ?? '',
        model: route?.model ?? '',
      },
    }
  }

  /** Dispose route registrations. @returns {void} */
  stop() {
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // disposal is best effort
      }
    }
    this.paths = []
  }
}

/**
 * Turn the various failure payloads an engine may report into one short,
 * display-safe sentence (or `undefined` when the model succeeded).
 * @param {unknown} error
 * @returns {string | undefined}
 */
function describeFailure(error) {
  if (error === undefined || error === null) return undefined
  if (typeof error === 'string') return error.slice(0, 200)
  if (typeof error === 'object') {
    const message = typeof error.message === 'string' ? error.message : String(error)
    return message.slice(0, 200)
  }
  return String(error).slice(0, 200)
}

/**
 * Bound one promise so a slow provider catalog cannot stall `/xhs/state`.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
