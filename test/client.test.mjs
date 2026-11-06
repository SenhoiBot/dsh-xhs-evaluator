/**
 * Client-half tests: the webview URL decides whether the controller is injected.
 *
 * `client.js` is a DSH renderer plugin: it registers a factory with
 * `window.__ModuleLoader__` and only observes the document. We reproduce that
 * environment with jsdom, a fake `<webview>` (`getURL()` / `src` / fake
 * `executeJavaScript`) and a fetch stub for the `/xhs/*` bridge.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { isXhsHost } from '../lib/hosts.js'

const here = dirname(fileURLToPath(import.meta.url))
const clientSource = readFileSync(join(here, '..', 'client.js'), 'utf8')
const pageSource = readFileSync(join(here, '..', 'lib', 'page-script.js'), 'utf8')

const requireFromSuperagent = createRequire(join(here, '..', '..', '..', 'dsh-superagent', 'package.json'))
const { JSDOM } = requireFromSuperagent('jsdom')

const PAGE = `<!doctype html><html><body><webview data-sidebar-browser-frame="webview"></webview></body></html>`

/**
 * Start the client half in a jsdom document with one fake webview.
 * @param {{getUrl?: (() => string) | null, src?: string, allowAllHosts?: boolean}} options
 */
async function startClient({ getUrl = () => '', src = '', allowAllHosts = false } = {}) {
  const dom = new JSDOM(PAGE, { runScripts: 'outside-only', url: 'http://127.0.0.1:59744/' })
  const injected = []
  const calls = []
  const logs = []

  const webview = dom.window.document.querySelector('webview')
  if (src !== '') webview.setAttribute('src', src)
  if (getUrl !== null) {
    Object.defineProperty(webview, 'getURL', { configurable: true, value: () => getUrl() })
  }
  webview.executeJavaScript = async (code) => {
    injected.push(String(code))
    return 'installed'
  }

  dom.window.fetch = async (path, options = {}) => {
    const url = String(path)
    calls.push({ url, method: options.method ?? 'GET' })
    if (options.body !== undefined) {
      try {
        logs.push(JSON.parse(options.body))
      } catch {
        /* not a log body */
      }
    }
    const json = (value) => ({ ok: true, status: 200, json: async () => value, text: async () => JSON.stringify(value) })
    if (url === '/xhs/state') {
      return json({ ok: true, version: '0.2.0', allowAllHosts, routes: [], maxModels: 3, ball: { side: 'left', bottom: 18 }, build: 'test-build' })
    }
    if (url === '/xhs/hosted.js') {
      return { ok: true, status: 200, json: async () => null, text: async () => pageSource }
    }
    return json({ ok: true })
  }

  let factory = null
  dom.window.__ModuleLoader__ = {
    load(entry) {
      factory = entry.factory
    },
  }
  dom.window.eval(clientSource)
  assert.equal(typeof factory, 'function', 'client.js registers a factory')

  const plugin = factory()
  let cleanup = () => {}
  plugin.apply({
    effect(callback) {
      cleanup = callback() ?? (() => {})
    },
  })

  // Let the async attach/ensureHosted chain settle.
  await new Promise((resolve) => setTimeout(resolve, 40))

  return {
    dom,
    webview,
    injected,
    calls,
    logs,
    stop() {
      try {
        cleanup()
      } catch {
        /* ignore */
      }
      try {
        dom.window.close()
      } catch {
        /* ignore */
      }
    },
  }
}

test('外站 URL：不注入页面脚本，并记录 inject-skip', async () => {
  const client = await startClient({ getUrl: () => 'https://example.com/article' })
  try {
    assert.equal(client.injected.length, 0, '外站不执行 executeJavaScript')
    const skip = client.logs.find((entry) => entry.event === 'inject-skip')
    assert.ok(skip, '记录 inject-skip 诊断事件')
    assert.equal(skip.data.host, 'example.com')
    assert.equal(skip.data.allowAllHosts, false)
    assert.ok(client.calls.some((call) => call.url === '/xhs/state'), '先问 /xhs/state 再决定')
  } finally {
    client.stop()
  }
})

test('伪装域 xiaohongshu.com.evil.com：同样不注入', async () => {
  const client = await startClient({ getUrl: () => 'https://xiaohongshu.com.evil.com/note' })
  try {
    assert.equal(client.injected.length, 0, '伪装域不注入')
    assert.ok(client.logs.some((entry) => entry.event === 'inject-skip'))
  } finally {
    client.stop()
  }
})

test('小红书页面：注入控制器，并带上 host 侧 URL 供页面脚本门禁使用', async () => {
  const client = await startClient({ getUrl: () => 'https://www.xiaohongshu.com/explore' })
  try {
    assert.equal(client.injected.length, 1, '只注入一次')
    const code = client.injected[0]
    assert.match(code, /^window\.__DSH_XHS_INJECT_URL__ = "https:\/\/www\.xiaohongshu\.com\/explore";/)
    assert.ok(code.includes('__DSH_XHS_PAGE__'), '注入的是页面控制器源码')
    assert.ok(client.logs.some((entry) => entry.event === 'inject' && entry.data.url === 'https://www.xiaohongshu.com/explore'))
    assert.ok(!client.logs.some((entry) => entry.event === 'inject-skip'))
  } finally {
    client.stop()
  }
})

test('创作平台 creator.xiaohongshu.com 同样注入', async () => {
  const client = await startClient({ getUrl: () => 'https://creator.xiaohongshu.com/publish/publish' })
  try {
    assert.equal(client.injected.length, 1)
  } finally {
    client.stop()
  }
})

test('拿不到 getURL 时回落到 src 属性判断', async () => {
  const client = await startClient({ getUrl: null, src: 'https://www.xiaohongshu.com/explore' })
  try {
    assert.equal(client.injected.length, 1, 'src 是小红书：注入')
  } finally {
    client.stop()
  }

  const foreign = await startClient({ getUrl: null, src: 'https://example.com/' })
  try {
    assert.equal(foreign.injected.length, 0, 'src 是外站：不注入')
  } finally {
    foreign.stop()
  }
})

test('URL 完全拿不到：仍注入，由页面脚本门禁决定（不误挡正常小红书页面）', async () => {
  const client = await startClient({ getUrl: () => '' })
  try {
    assert.equal(client.injected.length, 1, 'URL 未知时不预判，交给页面脚本')
    assert.match(client.injected[0], /^window\.__DSH_XHS_INJECT_URL__ = "";/)
  } finally {
    client.stop()
  }
})

test('allowAllHosts=true（宿主配置）：恢复任意页面注入', async () => {
  const client = await startClient({ getUrl: () => 'https://example.com/article', allowAllHosts: true })
  try {
    assert.equal(client.injected.length, 1, '配置开关打开后外站也注入')
    assert.ok(!client.logs.some((entry) => entry.event === 'inject-skip'))
  } finally {
    client.stop()
  }
})

test('客户端的白名单判定与 lib/hosts.js 一致（大小写/端口/末尾点/伪装域）', async () => {
  const table = [
    ['https://www.xiaohongshu.com/explore', true],
    ['https://WWW.XiaoHongShu.COM/explore', true],
    ['https://www.xiaohongshu.com./explore', true],
    ['https://www.xiaohongshu.com:443/explore', true],
    ['https://creator.xiaohongshu.com/publish', true],
    ['https://xiaohongshu.com.evil.com/note', false],
    ['https://evil-xiaohongshu.com/', false],
    ['https://example.com/', false],
  ]
  for (const [url, expected] of table) {
    assert.equal(isXhsHost(url), expected, `lib/hosts: ${url}`)
    const client = await startClient({ getUrl: () => url })
    try {
      assert.equal(client.injected.length, expected ? 1 : 0, `client 注入判定：${url}`)
    } finally {
      client.stop()
    }
  }
})
