/**
 * Host-side LLM bridge for the note evaluator.
 *
 * The plugin never holds an API key and never talks to a provider directly: it
 * goes through the host `llm` service (`prepareCall` / `prepared.stream`), which
 * owns provider routing, credentials, retries and telemetry.
 *
 * Three behaviours are load-bearing:
 *
 *  - **Ensemble.** One model is an opinion; three are a spread. `resolveModels`
 *    builds up to three routes (explicit config first, then the host default
 *    model, topped up from the provider catalog) and `evaluateEnsemble` fans out
 *    with `Promise.allSettled`, so one dead model cannot sink the report.
 *  - **Cheap reasoning.** Evaluation is a bounded judgement call, not a reasoning
 *    task. We ask for `reasoningEffort: 'off'`; if the model does not advertise
 *    it we take its lowest advertised effort instead of falling back to the
 *    profile's expensive default (same two-step pattern as page-translator).
 *  - **One voice for 一键整改.** `revise` runs a single model at a higher
 *    temperature: two rewrites of the same note would only compete, and the user
 *    is about to publish one of them.
 */

import { normalizeModelReport, normalizeRevision } from './evaluate.js'
import { evaluatePrompt, revisePrompt } from './prompts.js'

/** Plugin config defaults, frozen by DESIGN.md. */
const DEFAULT_CONFIG = Object.freeze({
  provider: '',
  model: '',
  models: [],
  ensemble: 2,
  callTimeoutMs: 45_000,
  maxTokens: 1800,
  temperature: 0.3,
})

/** Hard cap on ensemble size, mirrored from lib/evaluate.js. */
const MAX_ROUTES = 3
/** Reasoning effort used for evaluation calls. */
const PREFERRED_EFFORT = 'off'
/** `llm.listModels` is a convenience for topping up routes, never worth waiting on. */
const MODEL_LIST_TIMEOUT_MS = 2500
/** 一键整改: more freedom than the evaluation pass, one model only. */
const REVISE_TEMPERATURE = 0.7
const REVISE_MAX_TOKENS = 1400
/** A bad rewrite gets exactly one more chance before we surface a failure. */
const REVISE_ATTEMPTS = 2

/**
 * Error carrying a stable machine code, surfaced to the page as a short message.
 * `lib/routes.js` maps `code` to an HTTP status (400 for input problems, 502 for
 * upstream model problems).
 */
export class XhsError extends Error {
  /**
   * @param {string} code - stable code (e.g. `llm-unavailable`, `llm-failed`).
   * @param {string} message - human readable, safe to show.
   * @param {object} [details] - extra JSON-safe facts.
   */
  constructor(code, message, details) {
    super(message)
    this.name = 'XhsError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

/**
 * Extract the first JSON object from a model reply, tolerating code fences,
 * leading prose and trailing commentary.
 * @param {string} raw
 * @returns {object | null}
 */
export function extractJsonObject(raw) {
  let text = String(raw ?? '').trim()
  if (text === '') return null
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fenced?.[1]) text = fenced[1].trim()
  const direct = tryParse(text)
  if (direct !== null) return direct
  const balanced = firstBalancedObject(text)
  if (balanced !== null) return tryParse(balanced)
  return null
}

/**
 * LLM-backed note evaluator.
 */
export class LlmEvaluator {
  /**
   * @param {object} options
   * @param {object} options.ctx - plugin context; must expose `llm`, optionally `agentDefaultModel`.
   * @param {Function|object} [options.logger] - `(message) => void` or an object with `warn`.
   * @param {object} [options.config] - plugin config (merged over `DEFAULT_CONFIG`).
   */
  constructor({ ctx, logger, config } = {}) {
    this.ctx = ctx ?? {}
    this.log = logger ?? null
    this.config = { ...DEFAULT_CONFIG, ...(config ?? {}) }
    if (!Array.isArray(this.config.models)) this.config.models = []
  }

  /**
   * @returns {object} the host `llm` service.
   * @throws {XhsError} `llm-unavailable`
   */
  service() {
    const ctx = this.ctx ?? {}
    const llm = typeof ctx.get === 'function' ? ctx.get('llm') : ctx.llm
    if (llm === undefined || llm === null) {
      throw new XhsError('llm-unavailable', 'DSH 宿主的 llm 服务不可用，无法评估')
    }
    return llm
  }

  /**
   * Explicit config wins; otherwise the host's current default model selection.
   * @returns {{provider: string, model: string}}
   * @throws {XhsError} `no-model-route`
   */
  defaultRoute() {
    const configuredProvider = String(this.config.provider ?? '').trim()
    const configuredModel = String(this.config.model ?? '').trim()
    if (configuredProvider !== '' && configuredModel !== '') {
      return { provider: configuredProvider, model: configuredModel }
    }
    let selection = null
    try {
      const ctx = this.ctx ?? {}
      const service = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : ctx.agentDefaultModel
      if (service !== undefined && service !== null && typeof service.currentSelection === 'function') {
        selection = service.currentSelection()
      }
    } catch (error) {
      this.warn(`读取 DSH 默认模型失败：${errorText(error)}`)
    }
    const provider = typeof selection?.provider === 'string' ? selection.provider.trim() : ''
    const model = typeof selection?.model === 'string' ? selection.model.trim() : ''
    if (provider === '' || model === '') {
      throw new XhsError(
        'no-model-route',
        '解析不出要用的模型：请在插件配置里设置 provider/model，或先在 DSH 里选择一个默认模型',
      )
    }
    return { provider, model }
  }

  /**
   * Resolve 1..3 routes to evaluate with.
   *
   * Order: explicit `config.models` → explicit `config.provider/model` →
   * `agentDefaultModel.currentSelection()`, then top up from
   * `llm.listModels(provider)`. Dedupe by `provider/model`.
   *
   * @param {number} [count] - desired model count (defaults to `config.ensemble`).
   * @returns {Promise<Array<{id: string, label: string, provider: string, model: string}>>}
   */
  async resolveModels(count) {
    const cap = clampModels(count ?? this.config.ensemble, this.config.ensemble)
    const llm = this.service()
    const routes = []
    const seen = new Set()

    const add = (provider, model, label) => {
      const cleanProvider = String(provider ?? '').trim()
      const cleanModel = String(model ?? '').trim()
      if (cleanProvider === '' || cleanModel === '') return false
      const id = `${cleanProvider}/${cleanModel}`
      if (seen.has(id)) return false
      seen.add(id)
      routes.push({ id, label: cleanLabel(label) || cleanModel, provider: cleanProvider, model: cleanModel })
      return true
    }

    let fallbackProvider = String(this.config.provider ?? '').trim()
    if (fallbackProvider === '') {
      try {
        fallbackProvider = this.defaultRoute().provider
      } catch {
        // No default model yet; explicit config.models may still name providers.
      }
    }

    // 1. Explicitly configured models.
    for (const entry of this.config.models) {
      if (routes.length >= cap) break
      const parsed = parseModelEntry(entry)
      if (parsed === null) continue
      add(parsed.provider !== '' ? parsed.provider : fallbackProvider, parsed.model, parsed.label)
    }

    // 2. Explicit provider/model pair.
    const configuredProvider = String(this.config.provider ?? '').trim()
    const configuredModel = String(this.config.model ?? '').trim()
    if (routes.length < cap && configuredProvider !== '' && configuredModel !== '') {
      add(configuredProvider, configuredModel, configuredModel)
    }

    // 3. Host default model selection.
    if (routes.length < cap) {
      try {
        const fallback = this.defaultRoute()
        add(fallback.provider, fallback.model, fallback.model)
      } catch (error) {
        if (!(error instanceof XhsError) || error.code !== 'no-model-route') {
          this.warn(`解析默认模型路由失败：${errorText(error)}`)
        }
      }
    }

    if (routes.length === 0) {
      throw new XhsError(
        'no-model-route',
        '没有可用的模型路由：请在插件配置里设置 provider/model，或先在 DSH 里选择一个默认模型',
      )
    }

    // 4. Top up from the provider catalog so an ensemble really gets N opinions.
    if (routes.length < cap) {
      const provider = routes[0].provider
      const catalog = await this.listModelsSafe(llm, provider)
      const names = new Map()
      for (const info of catalog) {
        const modelId = String(info?.id ?? '').trim()
        if (modelId === '') continue
        names.set(modelId, cleanLabel(info?.name))
      }
      // Prefer the catalog's display name for routes we already resolved.
      for (const route of routes) {
        const name = names.get(route.model)
        if (name !== '') route.label = name
      }
      for (const modelId of names.keys()) {
        if (routes.length >= cap) break
        add(provider, modelId, names.get(modelId))
      }
    }

    return routes.slice(0, cap)
  }

  /**
   * `llm.listModels` guarded by a short timeout: a slow catalog must not delay a
   * report that can already be produced from the resolved routes.
   * @param {object} llm
   * @param {string} provider
   * @returns {Promise<Array<{id?: string, name?: string}>>}
   */
  async listModelsSafe(llm, provider) {
    if (typeof llm.listModels !== 'function') return []
    try {
      const catalog = await withTimeout(Promise.resolve(llm.listModels(provider)), MODEL_LIST_TIMEOUT_MS)
      return Array.isArray(catalog) ? catalog : []
    } catch (error) {
      this.warn(`列出 ${provider} 的模型失败，只用已解析出的模型：${errorText(error)}`)
      return []
    }
  }

  /**
   * Evaluate the note with exactly one model route.
   * @param {object} options
   * @param {object} options.input - normalized input.
   * @param {{id?: string, label?: string, provider: string, model: string}} [options.route]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<{route: object, report: object, ms: number}>}
   */
  async evaluateOne({ input, route, signal } = {}) {
    const target = route ?? this.defaultRoute()
    const llm = this.service()
    const prompt = evaluatePrompt(input)
    const started = Date.now()
    const raw = await this.callModel({
      llm,
      route: target,
      system: prompt.system,
      user: prompt.user,
      signal,
    })
    const parsed = extractJsonObject(raw)
    if (parsed === null) {
      throw new XhsError('bad-response', `模型 ${target.label ?? target.model} 没有返回可解析的 JSON`, {
        route: toPublicRoute(target),
        preview: raw.slice(0, 120),
      })
    }
    return {
      route: target,
      report: normalizeModelReport(parsed),
      ms: Date.now() - started,
    }
  }

  /**
   * Evaluate with up to `count` models in parallel.
   *
   * A failed model is reported in `failures` and never interrupts the others; at
   * least one success is required, otherwise the whole call throws `llm-failed`.
   *
   * @param {object} options
   * @param {object} options.input - normalized input.
   * @param {number} [options.count]
   * @param {AbortSignal} [options.signal]
   * `routes` lists every attempted route (successes and failures, resolution
   * order) so the caller can render a per-model status; `reports` holds only the
   * successful `ModelReport`s.
   *
   * @returns {Promise<{reports: object[], routes: object[], failures: object[], attempts: object[]}>}
   */
  async evaluateEnsemble({ input, count, signal } = {}) {
    const resolved = await this.resolveModels(count)
    const settled = await Promise.allSettled(
      resolved.map((route) => this.evaluateOne({ input, route, signal })),
    )

    const reports = []
    const failures = []
    const attempts = []

    settled.forEach((result, index) => {
      const route = resolved[index]
      if (result.status === 'fulfilled') {
        reports.push(result.value.report)
        attempts.push({ label: route.label, ok: true, ms: result.value.ms })
        return
      }
      const error = toXhsError(result.reason)
      failures.push({
        label: route.label,
        route: toPublicRoute(route),
        error: { code: error.code, message: error.message },
      })
      attempts.push({ label: route.label, ok: false, ms: null, error: error.message })
    })

    if (reports.length === 0) {
      throw new XhsError(
        'llm-failed',
        `所有模型调用都失败了：${failures.map((failure) => failure.error.message).join('；')}`.slice(0, 300),
        { failures },
      )
    }

    return { reports, routes: resolved.map((route) => toPublicRoute(route)), failures, attempts }
  }

  /**
   * 一键整改: rewrite this draft into one publishable note.
   *
   * Exactly one model (the resolved default route) so the user gets a single
   * coherent voice, at a higher temperature and with a smaller budget than the
   * evaluation pass. The reply must parse as JSON; a bad reply gets exactly one
   * retry, after which the call fails with `XhsError('llm-failed')` instead of
   * handing the user a half-rewritten note.
   *
   * @param {object} options
   * @param {object} options.input - the evaluated draft (`normalizeInput` output).
   * @param {object | null} [options.report] - the `Report` the user is looking at.
   * @returns {Promise<{revision: object, route: object, ms: number}>}
   */
  async revise({ input, report } = {}) {
    const llm = this.service()
    const [route] = await this.resolveModels(1)
    if (route === undefined) {
      throw new XhsError('no-model-route', '没有可用的模型路由，无法整改')
    }
    const prompt = revisePrompt({ draft: input, report })
    const started = Date.now()
    let lastError = null

    for (let attempt = 0; attempt < REVISE_ATTEMPTS; attempt += 1) {
      try {
        const raw = await this.callModel({
          llm,
          route,
          system: prompt.system,
          user: prompt.user,
          temperature: REVISE_TEMPERATURE,
          maxTokens: REVISE_MAX_TOKENS,
        })
        const parsed = extractJsonObject(raw)
        if (parsed === null) {
          lastError = new XhsError('bad-response', `模型 ${route.label} 没有返回可解析的 JSON`)
          continue
        }
        return { revision: normalizeRevision(parsed, input), route, ms: Date.now() - started }
      } catch (error) {
        lastError = toXhsError(error)
      }
    }

    throw new XhsError(
      'llm-failed',
      `整改失败：${lastError === null ? '模型没有返回可用结果' : lastError.message}`.slice(0, 300),
      {
        route: toPublicRoute(route),
        attempts: REVISE_ATTEMPTS,
        lastCode: lastError?.code ?? 'llm-failed',
      },
    )
  }

  /**
   * One streaming model call, returning the joined visible text.
   * @param {object} options
   * @param {object} options.llm - host llm service.
   * @param {{provider: string, model: string}} options.route
   * @param {string} options.system
   * @param {string} options.user
   * @param {AbortSignal} [options.signal]
   * @param {number} [options.temperature] - per-call override (e.g. 0.7 for 整改).
   * @param {number} [options.maxTokens] - per-call override (e.g. 1400 for 整改).
   * @returns {Promise<string>}
   */
  async callModel({ llm, route, system, user, signal, temperature, maxTokens }) {
    const timeoutMs = Number.isFinite(this.config.callTimeoutMs)
      ? this.config.callTimeoutMs
      : DEFAULT_CONFIG.callTimeoutMs
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const combined = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal])

    const fallbackTemperature = Number.isFinite(this.config.temperature)
      ? this.config.temperature
      : DEFAULT_CONFIG.temperature
    const fallbackMaxTokens = Number.isFinite(this.config.maxTokens)
      ? this.config.maxTokens
      : DEFAULT_CONFIG.maxTokens
    const baseConfig = {
      provider: route.provider,
      model: route.model,
      reasoningEffort: PREFERRED_EFFORT,
      temperature: Number.isFinite(temperature) ? temperature : fallbackTemperature,
      maxTokens: Number.isFinite(maxTokens) ? maxTokens : fallbackMaxTokens,
    }

    let prepared
    try {
      prepared = await prepareCall(llm, baseConfig, combined)
    } catch (error) {
      if (isAbort(error)) throw timeoutError(timeoutMs)
      if (!isUnsupportedEffort(error)) throw normalizeCallError(error)
      // The model does not advertise `off`: take its lowest advertised effort
      // rather than dropping the field and inheriting the profile default.
      try {
        prepared = await prepareCall(llm, baseConfig, combined, lowestEffort)
      } catch (retryError) {
        if (isAbort(retryError)) throw timeoutError(timeoutMs)
        throw normalizeCallError(retryError)
      }
    }

    const messages = [{ role: 'user', content: [{ type: 'text', text: user }] }]
    const streamOptions = { ...prepared.config, system, messages, signal: combined }
    let text = ''
    let failure = null
    try {
      for await (const chunk of prepared.stream(streamOptions)) {
        if (chunk === null || typeof chunk !== 'object') continue
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        else if (chunk.type === 'finish' && chunk.reason !== null && typeof chunk.reason === 'object') {
          if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
            failure = chunk.reason.failure ?? chunk.reason
          }
        }
      }
    } catch (error) {
      if (isAbort(error)) throw timeoutError(timeoutMs)
      throw normalizeCallError(error)
    }

    const trimmed = text.trim()
    if (trimmed === '') {
      if (failure !== null) {
        throw new XhsError('llm-failed', `模型调用失败：${String(failure.message ?? '未知错误')}`)
      }
      throw new XhsError('empty-response', '模型没有返回内容')
    }
    return trimmed
  }

  /**
   * Best-effort diagnostic log; logging must never break an evaluation.
   * @param {string} message
   */
  warn(message) {
    const logger = this.log
    try {
      if (typeof logger === 'function') logger(message)
      else if (logger !== null && typeof logger.warn === 'function') logger.warn(message)
    } catch {
      // observers must not break evaluation
    }
  }
}

/* ------------------------------------------------------------------ *
 * host-signature adapters
 * ------------------------------------------------------------------ */

/**
 * Prepare a call, keeping the two- and three-argument host signatures compatible.
 * @param {object} llm
 * @param {object} config
 * @param {AbortSignal} signal
 * @param {Function} [configure] - host `ConfigureCall` callback (controls, model).
 * @returns {Promise<{config: object, stream: Function}>}
 */
async function prepareCall(llm, config, signal, configure) {
  if (typeof llm.prepareCall !== 'function') {
    throw new XhsError('llm-incompatible', '宿主 llm 服务版本过旧：缺少 prepareCall')
  }
  return configure === undefined ? llm.prepareCall(config, signal) : llm.prepareCall(config, signal, configure)
}

/**
 * `ConfigureCall` that selects the model's cheapest advertised reasoning effort.
 * @param {object} controls
 * @param {{reasoning?: {efforts?: Array<{id?: string}>}}} model
 * @returns {object}
 */
function lowestEffort(controls, model) {
  const efforts = model?.reasoning?.efforts
  const id = Array.isArray(efforts) && efforts.length > 0 ? efforts[0]?.id : undefined
  return typeof id === 'string' && id !== '' ? { ...controls, reasoningEffort: id } : controls
}

/**
 * Whether a failure means the requested reasoning effort is not supported.
 * @param {unknown} error
 * @returns {boolean}
 */
function isUnsupportedEffort(error) {
  const code = String(error?.code ?? '')
  const message = String(error?.message ?? '')
  return code === 'UNSUPPORTED_REASONING_EFFORT' || /reasoning effort/i.test(message)
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isAbort(error) {
  const name = String(error?.name ?? '')
  return name === 'AbortError' || name === 'TimeoutError'
}

/**
 * @param {number} timeoutMs
 * @returns {XhsError}
 */
function timeoutError(timeoutMs) {
  return new XhsError('timeout', '模型调用超时，请稍后再试', { timeoutMs })
}

/**
 * Map a host failure to a page-safe error.
 * @param {unknown} error
 * @returns {XhsError}
 */
function normalizeCallError(error) {
  if (error instanceof XhsError) return error
  const code = String(error?.code ?? 'llm-error')
  const message = String(error?.message ?? error)
  return new XhsError('llm-failed', `模型调用失败（${code}）：${message.slice(0, 300)}`)
}

/**
 * @param {unknown} error
 * @returns {XhsError}
 */
function toXhsError(error) {
  return error instanceof XhsError ? error : normalizeCallError(error)
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorText(error) {
  return String(error?.message ?? error)
}

/**
 * @param {number} value
 * @param {number} fallback
 * @returns {number} 1..3
 */
function clampModels(value, fallback) {
  const direct = Number(value)
  const base = Number.isFinite(direct) ? direct : Number(fallback)
  if (!Number.isFinite(base)) return DEFAULT_CONFIG.ensemble
  const rounded = Math.round(base)
  if (rounded < 1) return 1
  return Math.min(MAX_ROUTES, rounded)
}

/**
 * Parse one `config.models` entry: `"provider/model"`, `"model"`, or an object.
 * @param {unknown} entry
 * @returns {{provider: string, model: string, label: string} | null}
 */
function parseModelEntry(entry) {
  if (entry === null || entry === undefined) return null
  if (typeof entry === 'object') {
    const provider = String(entry.provider ?? '').trim()
    const label = String(entry.label ?? entry.name ?? '').trim()
    let model = String(entry.model ?? entry.id ?? '').trim()
    if (model === '') return null
    if (provider === '' && model.includes('/')) {
      const slash = model.indexOf('/')
      return { provider: model.slice(0, slash).trim(), model: model.slice(slash + 1).trim(), label }
    }
    return { provider, model, label }
  }
  const raw = String(entry).trim()
  if (raw === '') return null
  const slash = raw.indexOf('/')
  if (slash > 0) return { provider: raw.slice(0, slash).trim(), model: raw.slice(slash + 1).trim(), label: '' }
  return { provider: '', model: raw, label: '' }
}

/**
 * @param {unknown} label
 * @returns {string}
 */
function cleanLabel(label) {
  return String(label ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
}

/**
 * @param {{provider: string, model: string, id?: string, label?: string}} route
 * @returns {{id: string, label: string, provider: string, model: string}}
 */
function toPublicRoute(route) {
  const provider = String(route?.provider ?? '')
  const model = String(route?.model ?? '')
  return {
    id: String(route?.id ?? `${provider}/${model}`),
    label: String(route?.label ?? model),
    provider,
    model,
  }
}

/**
 * Reject after `ms` so a slow auxiliary query cannot stall the request.
 * @param {Promise<unknown>} promise
 * @param {number} ms
 * @returns {Promise<unknown>}
 */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new XhsError('llm-timeout', '模型列表查询超时')), ms)
    if (typeof timer.unref === 'function') timer.unref()
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

/**
 * @param {string} text
 * @returns {object | null}
 */
function tryParse(text) {
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Find the first balanced `{...}` block, skipping braces inside strings.
 * @param {string} text
 * @returns {string | null}
 */
function firstBalancedObject(text) {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let quote = ''
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) inString = false
      continue
    }
    if (char === '"' || char === "'") {
      inString = true
      quote = char
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return null
}
