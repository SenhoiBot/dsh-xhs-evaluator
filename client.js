/**
 * Browser half of the Xiaohongshu note evaluator — built-in sidebar browser only.
 *
 * The DSH desktop sidebar browser renders HTTP(S) pages in an Electron
 * `<webview>` that lives in this same renderer document. This module finds that
 * element, injects `lib/page-script.js` with `executeJavaScript`, and polls the
 * injected controller for a pending evaluation request. The request is relayed
 * to the host (`/xhs/evaluate`) where several models rate the draft; the report
 * is painted back into the panel.
 *
 * Site gate: the controller is injected only into Xiaohongshu pages
 * (`xiaohongshu.com` + subdomains) unless the host config sets
 * `allowAllHosts: true`. The webview URL comes from `getURL()` (falling back to
 * its `src` attribute); if neither is readable yet, injection proceeds and the
 * page script's own gate decides. The page script re-checks as well, so a
 * cross-origin/blank page never gets a ball.
 *
 * The guest page performs no network calls and never sees a token. In the Web
 * profile the built-in browser is a cross-origin iframe, whose DOM cannot be
 * reached — the panel then simply does not appear (see README).
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-xhs-evaluator',
  factory() {
    /**
     * The webview tag the built-in browser implementation mounts. The
     * implementation attributes its frame; a plain `webview` element is kept as
     * a fallback because only HTTP(S) guests are ever injected (see
     * `ensureHosted`), so a non-browser webview is skipped.
     */
    const WEBVIEW_SELECTOR = 'webview[data-sidebar-browser-frame="webview"], webview'
    /** Injected controller source route. */
    const HOSTED_ROUTE = '/xhs/hosted.js'
    /** Evaluation route. */
    const EVALUATE_ROUTE = '/xhs/evaluate'
    /** 一键整改 route. */
    const REVISE_ROUTE = '/xhs/revise'
    /** Model roster route (which host models this profile can actually run). */
    const STATE_ROUTE = '/xhs/state'
    /** Diagnostic event route (host appends to ~/.dsh/xhs-evaluator.log). */
    const LOG_ROUTE = '/xhs/log'
    /** How often the plugin asks an attached page whether the ball was clicked. */
    const POLL_MS = 400
    /** Safety rescan for webviews created outside MutationObserver coverage. */
    const RESCAN_MS = 4000
    /** An ensemble of three models can legitimately take a while. */
    const EVALUATE_TIMEOUT_MS = 120_000
    /** A single rewrite call. */
    const REVISE_TIMEOUT_MS = 90_000
    /** Host state (roster, anchor, script build) is polled every 400ms: cache it briefly. */
    const STATE_TTL_MS = 8_000
    /** Never fight a broken script: at most one hot-swap per webview per interval. */
    const SWAP_INTERVAL_MS = 5_000
    /** Root domain the ball may appear on (mirror of lib/hosts.js). */
    const XHS_ROOT_DOMAIN = 'xiaohongshu.com'

    /** @type {{at: number, value: any} | null} */
    let stateCache = null
    /** @type {WeakSet<Element>} */
    const attached = new WeakSet()
    /** @type {WeakSet<Element>} */
    const injected = new WeakSet()
    /** @type {WeakSet<Element>} */
    const configured = new WeakSet()
    /** @type {WeakSet<Element>} */
    const swapping = new WeakSet()
    /** @type {Map<Element, number>} */
    const lastSwap = new Map()
    /** @type {WeakSet<Element>} */
    const polling = new WeakSet()
    /** @type {Set<Element>} */
    const busy = new Set()
    /** @type {Map<Element, number>} */
    const loops = new Map()
    /** Last report handed to each page; 一键整改 rewrites against it. */
    /** @type {Map<Element, object>} */
    const lastReports = new Map()
    /** Live count of attached built-in-browser pages (diagnostics only). */
    const browserState = { count: 0 }
    /** Last inject-skip logged per webview, so a foreign page does not spam /xhs/log. */
    /** @type {WeakMap<Element, {url: string, at: number}>} */
    const lastSkip = new WeakMap()
    /** Minimum interval between two inject-skip logs for the same foreign URL. */
    const SKIP_LOG_INTERVAL_MS = 30_000

    /**
     * Fire-and-forget diagnostic event, appended by the host to
     * `~/.dsh/xhs-evaluator.log`. Never throws.
     * @param {string} event
     * @param {object} [data]
     */
    function logBridge(event, data) {
      try {
        void fetch(LOG_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ event, data: data ?? null }),
        }).catch(() => {})
      } catch {
        // diagnostics must never break evaluation
      }
    }

    /**
     * Run code inside the guest page.
     * @param {any} webview
     * @param {string} code
     * @param {number} [timeoutMs]
     * @returns {Promise<any>}
     */
    function execInGuest(webview, code, timeoutMs = 30_000) {
      let timer
      return Promise.race([
        Promise.resolve(webview.executeJavaScript(code)),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('guest evaluation timed out')), timeoutMs)
        }),
      ]).finally(() => {
        if (timer !== undefined) clearTimeout(timer)
      })
    }

    /**
     * Read the host state (model roster, ball anchor, current page-script build).
     * Cached briefly: the poll loop runs every 400ms.
     * @returns {Promise<any | null>}
     */
    async function readState() {
      const now = Date.now()
      if (stateCache !== null && now - stateCache.at < STATE_TTL_MS) return stateCache.value
      try {
        const response = await fetch(STATE_ROUTE, { headers: { accept: 'application/json' }, cache: 'no-store' })
        if (!response.ok) throw new Error('state HTTP ' + response.status)
        const value = await response.json()
        stateCache = { at: now, value }
        return value
      } catch {
        return stateCache !== null ? stateCache.value : null
      }
    }

    /**
     * Current injected-controller source. Deliberately NOT cached: a plugin
     * update must reach the next injection/refresh, not the next DSH restart.
     * @returns {Promise<string>}
     */
    async function loadHostedSource() {
      const response = await fetch(HOSTED_ROUTE, { headers: { accept: 'text/javascript' }, cache: 'no-store' })
      if (!response.ok) throw new Error('hosted script HTTP ' + response.status)
      return response.text()
    }

    /**
     * Replace a live but stale injected controller with the current script, so a
     * page-script update applies without the user reloading the browser tab.
     * Throttled per webview so a broken script cannot cause a swap loop.
     * @param {any} webview
     * @returns {Promise<void>}
     */
    async function swapGuest(webview) {
      if (swapping.has(webview)) return
      const now = Date.now()
      if (now - (lastSwap.get(webview) ?? 0) < SWAP_INTERVAL_MS) return
      swapping.add(webview)
      lastSwap.set(webview, now)
      try {
        try {
          // destroy() tears down the UI; clearing the globals too is what lets the
          // freshly injected copy boot instead of returning 'ready'.
          await execInGuest(
            webview,
            'if (window.__DSH_XHS_PAGE__) { try { window.__DSH_XHS_PAGE__.destroy() } catch (e) {} ' +
              'delete window.__DSH_XHS_PAGE__; delete window.__DSH_XHS_TEST__; }',
            8_000,
          )
        } catch {
          // the page may be navigating; injecting a fresh copy is still correct
        }
        injected.delete(webview)
        configured.delete(webview)
        lastReports.delete(webview)
        logBridge('reload-script', { url: String(webview.getURL?.() ?? '') })
        await ensureHosted(webview)
      } finally {
        swapping.delete(webview)
      }
    }

    /**
     * Same-origin POST against the host bridge.
     * @param {string} path
     * @param {object} body
     * @param {number} [timeoutMs]
     * @returns {Promise<any>}
     */
    async function postHost(path, body, timeoutMs = 60_000) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
      try {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
          signal: controller ? controller.signal : undefined,
        })
        const data = await response.json().catch(() => null)
        if (!response.ok || data === null || data.ok !== true) {
          throw new Error((data && data.message) || 'HTTP ' + response.status)
        }
        return data
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
    }

    /** JSON that is safe to embed in a JavaScript expression. */
    function embed(value) {
      return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
    }

    /* ------------------------------------------------------------ site gate */

    /**
     * Reduce a hostname, an `host:port` authority or a full URL to a bare
     * lower-case hostname without port, userinfo or trailing dots.
     * Mirrors `lib/hosts.js` (the client bundle cannot import host modules).
     * @param {unknown} value
     * @returns {string}
     */
    function normalizeHostname(value) {
      let text = String(value === undefined || value === null ? '' : value).trim().toLowerCase()
      if (text === '') return ''
      const scheme = text.indexOf('://')
      if (scheme >= 0) text = text.slice(scheme + 3)
      const cut = text.search(/[/?#]/)
      if (cut >= 0) text = text.slice(0, cut)
      const at = text.lastIndexOf('@')
      if (at >= 0) text = text.slice(at + 1)
      if (text.charAt(0) === '[') {
        const close = text.indexOf(']')
        return close >= 0 ? text.slice(0, close + 1) : text
      }
      const port = text.search(/:\d+$/)
      if (port >= 0) text = text.slice(0, port)
      return text.replace(/\.+$/, '')
    }

    /**
     * Parse the hostname out of an http(s) URL; '' for anything else
     * (about:blank, chrome://, a bare hostname).
     * @param {unknown} url
     * @returns {string}
     */
    function hostFromUrl(url) {
      const text = String(url === undefined || url === null ? '' : url).trim()
      if (text === '') return ''
      const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text)
      if (scheme === null) return ''
      const protocol = scheme[1].toLowerCase()
      if (protocol !== 'http' && protocol !== 'https') return ''
      return normalizeHostname(text)
    }

    /** True for xiaohongshu.com and any subdomain; never a lookalike domain. */
    function isXhsHost(hostname) {
      const host = normalizeHostname(hostname)
      if (host === '') return false
      if (host === XHS_ROOT_DOMAIN) return true
      return host.endsWith('.' + XHS_ROOT_DOMAIN)
    }

    /**
     * Best-effort URL of the page inside a webview. `getURL()` is the reliable
     * Electron API; the `src` attribute is the fallback for tests/odd builds.
     * @param {any} webview
     * @returns {string}
     */
    function currentUrl(webview) {
      try {
        if (typeof webview.getURL === 'function') {
          const value = String(webview.getURL() || '')
          if (value !== '') return value
        }
      } catch {
        // fall through to src
      }
      try {
        const src = typeof webview.getAttribute === 'function' ? webview.getAttribute('src') : webview?.src
        if (typeof src === 'string') return src
      } catch {
        // no readable src
      }
      return ''
    }

    /**
     * Whether this page may receive the controller. Unknown URL ("not readable
     * yet") returns true so the page-script gate can decide; a known foreign
     * host returns false unless the host config restored allowAllHosts.
     * @param {string} url
     * @param {any | null} state host state from `/xhs/state`.
     * @returns {boolean}
     */
    function siteAllowed(url, state) {
      if (hostFromUrl(url) === '') return true
      if (state !== null && state?.allowAllHosts === true) return true
      return isXhsHost(hostFromUrl(url))
    }

    /**
     * Make sure the injected controller (and its ball) exists in this page.
     * @param {any} webview
     * @returns {Promise<boolean>}
     */
    async function ensureHosted(webview) {
      if (injected.has(webview)) return true
      try {
        const url = currentUrl(webview)
        // A readable non-http(s) URL is never injectable. A blank URL means the
        // page is still settling: inject and let the page-script gate decide.
        if (url !== '' && !/^https?:/i.test(url)) return false
        const state = url !== '' ? await readState() : null
        if (!siteAllowed(url, state)) {
          const now = Date.now()
          const last = lastSkip.get(webview)
          if (last === undefined || last.url !== url || now - last.at >= SKIP_LOG_INTERVAL_MS) {
            lastSkip.set(webview, { url, at: now })
            logBridge('inject-skip', {
              url,
              host: hostFromUrl(url),
              allowAllHosts: state !== null && state.allowAllHosts === true,
            })
          }
          return false
        }
        lastSkip.delete(webview)
        const source = await loadHostedSource()
        // Hand the page its own URL: an initial blank document may not expose a
        // readable `location` yet, and the page-script gate must not misfire.
        const bootstrap = 'window.__DSH_XHS_INJECT_URL__ = ' + embed(url) + ';\n'
        const result = await execInGuest(webview, bootstrap + source, 15_000)
        if (result === 'installed' || result === 'ready') {
          injected.add(webview)
          logBridge('inject', { url, result: String(result) })
          return true
        }
        logBridge('inject-unexpected', { url, result: String(result).slice(0, 80) })
        return false
      } catch {
        return false
      }
    }
    /**
     * Report progress into the guest page's panel.
     * @param {any} webview
     * @param {string} state
     * @param {string} label
     * @param {string} [detail]
     */
    async function setGuestStatus(webview, state, label, detail) {
      try {
        await execInGuest(
          webview,
          `window.__DSH_XHS_PAGE__ && window.__DSH_XHS_PAGE__.status(${embed(state)}, ${embed(label)}, ${embed(detail ?? '')})`,
          8_000,
        )
      } catch {
        // the page may have navigated away; the next dom-ready re-installs
      }
    }

    /**
     * Tell the panel which models this profile can actually run and where the
     * ball should sit, so the 1/2/3 selector does not promise an ensemble the
     * host cannot deliver.
     * @param {any} webview
     * @param {any} [known] - already-fetched host state.
     */
    async function configureGuest(webview, known) {
      if (configured.has(webview)) return
      configured.add(webview)
      try {
        const state = known ?? (await readState())
        if (state === null) throw new Error('no host state')
        const labels = Array.isArray(state?.routes)
          ? state.routes.map((route) => (route && typeof route.label === 'string' ? route.label : '')).filter((label) => label !== '')
          : []
        const payload = {
          models: labels.map((label) => ({ label })),
          maxModels: Number(state?.maxModels) || 3,
          ball: {
            side: state?.ball?.side === 'right' ? 'right' : 'left',
            bottom: Number(state?.ball?.bottom) || 18,
          },
          // Site gate travels the existing configure channel, no new protocol.
          allowAllHosts: state?.allowAllHosts === true,
          url: currentUrl(webview),
        }
        await execInGuest(
          webview,
          `window.__DSH_XHS_PAGE__ && window.__DSH_XHS_PAGE__.configure(${embed(payload)})`,
          8_000,
        )
        logBridge('configure', {
          url: currentUrl(webview),
          models: labels,
          build: state?.build ?? null,
          allowAllHosts: state?.allowAllHosts === true,
        })
      } catch {
        // Not fatal: the panel falls back to its blind 1/2/3 promise.
        configured.delete(webview)
      }
    }

    /**
     * Run one evaluation for the request the panel published.
     * @param {any} webview
     * @param {{input?: object}} pending
     */
    async function evaluateInGuest(webview, pending) {
      const started = Date.now()
      const input = pending !== null && typeof pending === 'object' && pending.input !== null && typeof pending.input === 'object' ? pending.input : {}
      const count = Number.isFinite(input.models) ? Math.min(3, Math.max(1, Math.round(input.models))) : 2
      const url = String(webview.getURL?.() ?? '')
      try {
        await setGuestStatus(webview, 'busy', '评估中…', `${count} 个宿主模型正在打分`)
        const data = await postHost(EVALUATE_ROUTE, input, EVALUATE_TIMEOUT_MS)
        const report = data.report !== null && typeof data.report === 'object' ? data.report : null
        if (report === null) throw new Error('宿主没有返回评估结果')
        await execInGuest(webview, `window.__DSH_XHS_PAGE__.result(${embed(report)})`, 10_000)
        lastReports.set(webview, report)
        logBridge('evaluated', {
          url,
          chars: String(input.body ?? '').length,
          models: Array.isArray(data.models) ? data.models.map((model) => (model && model.label) || '?') : [],
          ms: data.ms ?? Date.now() - started,
        })
      } catch (error) {
        const message = String(error && error.message ? error.message : error).slice(0, 160)
        try {
          await execInGuest(webview, `window.__DSH_XHS_PAGE__.error(${embed(message)})`, 8_000)
        } catch {
          // page navigated away
        }
        logBridge('evaluate-error', { url, message })
      }
    }

    /**
     * 一键整改: rewrite the evaluated draft against the report the panel shows.
     * @param {any} webview
     * @param {object} input - the draft the user evaluated
     */
    async function reviseInGuest(webview, input) {
      const started = Date.now()
      const url = String(webview.getURL?.() ?? '')
      const report = lastReports.get(webview) ?? null
      try {
        await setGuestStatus(webview, 'busy', '整改中…', '模型正在按评估结论改写这篇笔记')
        const data = await postHost(REVISE_ROUTE, { draft: input, report }, REVISE_TIMEOUT_MS)
        const revision = data.revision !== null && typeof data.revision === 'object' ? data.revision : null
        if (revision === null) throw new Error('宿主没有返回整改稿')
        await execInGuest(webview, `window.__DSH_XHS_PAGE__.revision(${embed(revision)})`, 10_000)
        logBridge('revised', {
          url,
          model: data.model?.label ?? null,
          ms: data.ms ?? Date.now() - started,
        })
      } catch (error) {
        const message = String(error && error.message ? error.message : error).slice(0, 160)
        try {
          await execInGuest(webview, `window.__DSH_XHS_PAGE__.error(${embed(message)})`, 8_000)
        } catch {
          // page navigated away
        }
        logBridge('revise-error', { url, message })
      }
    }

    /**
     * Attach to one webview: install the controller, then relay its requests.
     * @param {any} webview
     */
    function attachWebview(webview) {
      if (webview === null || typeof webview !== 'object' || attached.has(webview)) return
      attached.add(webview)
      const onReady = () => {
        injected.delete(webview)
        configured.delete(webview)
        busy.delete(webview)
        lastReports.delete(webview)
        logBridge('dom-ready', { url: String(webview.getURL?.() ?? '') })
        void ensureHosted(webview)
      }
      const onDestroyed = () => {
        const timer = loops.get(webview)
        if (timer !== undefined) clearInterval(timer)
        loops.delete(webview)
        busy.delete(webview)
        configured.delete(webview)
        lastReports.delete(webview)
      }
      try {
        webview.addEventListener('dom-ready', onReady)
        webview.addEventListener('destroyed', onDestroyed)
      } catch {
        // tests may pass a fake element without event APIs
      }
      void ensureHosted(webview)
      const timer = setInterval(async () => {
        if (!webview.isConnected || busy.has(webview) || polling.has(webview)) return
        polling.add(webview)
        try {
          const state = await readState()
          if (!(await ensureHosted(webview))) return
          if (!configured.has(webview)) await configureGuest(webview, state)
          const snapshot = await execInGuest(
            webview,
            'window.__DSH_XHS_PAGE__ ? { build: window.__DSH_XHS_PAGE__.build, request: window.__DSH_XHS_PAGE__.poll() } : null',
            8_000,
          )
          if (snapshot === null || typeof snapshot !== 'object') return
          // A page-script update must reach an already-injected page: compare the
          // build the host serves with the one running in the guest and hot-swap.
          if (state !== null && typeof state.build === 'string' && snapshot.build !== state.build) {
            await swapGuest(webview)
            return
          }
          const request = snapshot.request
          if (request === null || typeof request !== 'object') return
          const input = request.input !== null && typeof request.input === 'object' ? request.input : null
          if (input === null) return
          const kind = request.kind === 'revise' ? 'revise' : 'evaluate'
          logBridge('request', { url: String(webview.getURL?.() ?? ''), kind, models: input.models ?? null })
          busy.add(webview)
          try {
            if (kind === 'revise') await reviseInGuest(webview, input)
            else await evaluateInGuest(webview, request)
          } finally {
            busy.delete(webview)
          }
        } catch {
          // transient: page loading, navigating or detached
        } finally {
          polling.delete(webview)
        }
      }, POLL_MS)
      loops.set(webview, timer)
    }

    /** Scan the document for webviews and attach to every one. */
    function scanWebviews() {
      const webviews = Array.from(document.querySelectorAll(WEBVIEW_SELECTOR))
      for (const webview of webviews) attachWebview(webview)
      const attachedCount = webviews.filter((webview) => attached.has(webview)).length
      if (browserState.count !== attachedCount) {
        browserState.count = attachedCount
        logBridge('webviews', {
          count: attachedCount,
          urls: webviews.map((webview) => String(webview.getURL?.() ?? '')).slice(0, 10),
        })
      }
    }

    /**
     * Start watching the document for the built-in browser's webviews.
     * @returns {() => void} cleanup
     */
    function installBuiltinBrowserBridge() {
      logBridge('bridge-installed', { webviews: document.querySelectorAll(WEBVIEW_SELECTOR).length })
      scanWebviews()
      let scheduled = false
      const schedule = () => {
        if (scheduled) return
        scheduled = true
        setTimeout(() => {
          scheduled = false
          scanWebviews()
        }, 300)
      }
      let observer = null
      if (typeof MutationObserver === 'function' && document.body !== null) {
        observer = new MutationObserver(schedule)
        observer.observe(document.body, { childList: true, subtree: true })
      }
      const rescan = setInterval(scanWebviews, RESCAN_MS)
      return () => {
        observer?.disconnect()
        clearInterval(rescan)
        for (const timer of loops.values()) clearInterval(timer)
        loops.clear()
        busy.clear()
        browserState.count = 0
      }
    }

    /** The plugin needs no other client service: it only observes the DOM. */
    const inject = []

    /**
     * @param {import('@deepseek-ai/cordis').Context} ctx - browser plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => installBuiltinBrowserBridge(), 'xhs evaluator: built-in browser bridge')
    }

    return { inject, apply }
  },
})
