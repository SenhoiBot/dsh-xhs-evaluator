/**
 * Site gate for the Xiaohongshu note evaluator.
 *
 * The floating ball belongs on Xiaohongshu only: `xiaohongshu.com` and any of
 * its subdomains (`www.xiaohongshu.com`, `creator.xiaohongshu.com`, ...). Every
 * other page must stay untouched — in particular lookalike hosts such as
 * `xiaohongshu.com.evil.com` or `notxiaohongshu.com` are NOT allowed.
 *
 * This module is the single source of truth for that decision. The injected
 * controller (`lib/page-script.js`) and the client half (`client.js`) cannot
 * import it (both are evaluated as standalone scripts inside other realms), so
 * they carry a byte-for-byte mirror of `normalizeHostname` / `isXhsHost`; the
 * jsdom suite asserts the three implementations agree on a host table.
 *
 * Config override: `allowAllHosts: true` disables the gate and restores the old
 * "any page shows the ball" behaviour. Default is `false`.
 */

/** Root domain the ball is allowed on. */
export const XHS_ROOT_DOMAIN = 'xiaohongshu.com'

/**
 * Reduce a hostname, an `host:port` authority or a full URL to a bare
 * lower-case hostname without port, userinfo or trailing dots.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeHostname(value) {
  let text = String(value === undefined || value === null ? '' : value).trim().toLowerCase()
  if (text === '') return ''
  // Full URL: drop the scheme, keep the authority.
  const scheme = text.indexOf('://')
  if (scheme >= 0) text = text.slice(scheme + 3)
  // Authority ends at the first path/query/fragment separator.
  const cut = text.search(/[/?#]/)
  if (cut >= 0) text = text.slice(0, cut)
  // Drop userinfo (`user:pass@host`).
  const at = text.lastIndexOf('@')
  if (at >= 0) text = text.slice(at + 1)
  // Keep an IPv6 literal intact (`[::1]:8080` -> `[::1]`); never an XHS host.
  if (text.charAt(0) === '[') {
    const close = text.indexOf(']')
    if (close >= 0) return text.slice(0, close + 1)
    return text
  }
  // Drop the port.
  const port = text.search(/:\d+$/)
  if (port >= 0) text = text.slice(0, port)
  // A trailing dot is an FQDN root marker: `www.xiaohongshu.com.` is valid.
  text = text.replace(/\.+$/, '')
  return text
}

/**
 * Parse the hostname out of an http(s) URL. Anything else (about:blank,
 * chrome://, data:, a bare hostname) yields '' so callers can tell "not a web
 * page yet" apart from "a web page on another site".
 * @param {unknown} url
 * @returns {string}
 */
export function hostFromUrl(url) {
  const text = String(url === undefined || url === null ? '' : url).trim()
  if (text === '') return ''
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text)
  if (scheme === null) return ''
  const protocol = scheme[1].toLowerCase()
  if (protocol !== 'http' && protocol !== 'https') return ''
  return normalizeHostname(text)
}

/**
 * True for `xiaohongshu.com` and any of its subdomains.
 * Case-insensitive; tolerates a trailing dot, a port and a full URL.
 * @param {unknown} hostname
 * @returns {boolean}
 */
export function isXhsHost(hostname) {
  const host = normalizeHostname(hostname)
  if (host === '') return false
  if (host === XHS_ROOT_DOMAIN) return true
  return host.length > XHS_ROOT_DOMAIN.length + 1 && host.endsWith('.' + XHS_ROOT_DOMAIN)
}

/**
 * The page the ball is currently injected into: its URL, or the URL the host
 * said it was injecting (blank initial documents may not expose `location`).
 * @param {{url?: unknown, fallbackUrl?: unknown}} [page]
 * @returns {string}
 */
export function pageHost({ url, fallbackUrl } = {}) {
  return hostFromUrl(url) || hostFromUrl(fallbackUrl)
}

/**
 * Decide whether the ball may render on a page.
 *
 * `allowed: false` + `reason: 'unknown'` means "the page URL is not readable
 * yet" (about:blank / initial document) — callers should wait, not permanently
 * block. `reason: 'foreign'` is a definitive no.
 * @param {{url?: unknown, fallbackUrl?: unknown, allowAllHosts?: boolean}} [page]
 * @returns {{allowed: boolean, reason: 'allow-all'|'xhs'|'foreign'|'unknown', host: string}}
 */
export function pageGate({ url, fallbackUrl, allowAllHosts = false } = {}) {
  const host = pageHost({ url, fallbackUrl })
  if (host === '') return { allowed: false, reason: 'unknown', host: '' }
  if (allowAllHosts === true) return { allowed: true, reason: 'allow-all', host }
  if (isXhsHost(host)) return { allowed: true, reason: 'xhs', host }
  return { allowed: false, reason: 'foreign', host }
}
