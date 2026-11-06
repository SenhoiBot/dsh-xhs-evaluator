/**
 * Host entry of the Xiaohongshu note evaluator.
 *
 * Loads as a bundle row. It needs the host `llm` service (all model calls go
 * through it, so the plugin never holds a provider key) and, when present, the
 * web server that carries the `/xhs/*` bridge the sidebar-browser client half
 * talks to. Everything user-visible is injected into the built-in browser page
 * by `client.js`.
 */
import { XhsEvaluator } from './lib/service.js'

export const name = 'dsh-xhs-evaluator'
export const inject = ['llm']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} [config] - patch row config (`ensemble`, `provider`, `model`, ...).
 * @returns {void}
 */
export function apply(ctx, config) {
  const logger = resolveLogger(ctx)
  const evaluator = new XhsEvaluator({ ctx, config, logger })

  ctx.effect(() => {
    evaluator.registerRoutes()
    return () => evaluator.stop()
  }, 'xhs evaluator: bridge routes')
}

/**
 * Resolve a logger that works with both the Cordis logger factory and a plain
 * logger object (tests inject the latter).
 * @param {object} ctx
 * @returns {object}
 */
function resolveLogger(ctx) {
  try {
    if (typeof ctx?.logger === 'function') return ctx.logger('xhs-evaluator')
    if (ctx?.logger !== undefined && ctx.logger !== null) return ctx.logger
    if (typeof ctx?.get === 'function') {
      const service = ctx.get('logger')
      if (service !== undefined && service !== null) return service
    }
  } catch {
    // fall through to console
  }
  return console
}
