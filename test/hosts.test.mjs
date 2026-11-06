/**
 * Site-gate unit tests (lib/hosts.js).
 *
 * The gate is the single source of truth for "which pages get the ball"; the
 * injected controller and the client half mirror it, and the jsdom suite
 * asserts parity on the shared host table.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  XHS_ROOT_DOMAIN,
  hostFromUrl,
  isXhsHost,
  normalizeHostname,
  pageGate,
  pageHost,
} from '../lib/hosts.js'

test('normalizeHostname 处理大小写、端口、末尾点、userinfo 与完整 URL', () => {
  assert.equal(XHS_ROOT_DOMAIN, 'xiaohongshu.com')
  assert.equal(normalizeHostname('xiaohongshu.com'), 'xiaohongshu.com')
  assert.equal(normalizeHostname('WWW.XiaoHongShu.COM'), 'www.xiaohongshu.com')
  assert.equal(normalizeHostname('www.xiaohongshu.com.'), 'www.xiaohongshu.com')
  assert.equal(normalizeHostname('www.xiaohongshu.com:443'), 'www.xiaohongshu.com')
  assert.equal(normalizeHostname('www.xiaohongshu.com.:8080'), 'www.xiaohongshu.com')
  assert.equal(normalizeHostname('https://www.xiaohongshu.com/explore?x=1#top'), 'www.xiaohongshu.com')
  assert.equal(normalizeHostname('user:pw@creator.xiaohongshu.com:8443/publish'), 'creator.xiaohongshu.com')
  assert.equal(normalizeHostname('  Example.COM  '), 'example.com')
  assert.equal(normalizeHostname(''), '')
  assert.equal(normalizeHostname(null), '')
  assert.equal(normalizeHostname(undefined), '')
})

test('isXhsHost 放行 xiaohongshu.com 及其子域', () => {
  for (const host of [
    'xiaohongshu.com',
    'www.xiaohongshu.com',
    'creator.xiaohongshu.com',
    'WWW.XiaoHongShu.COM',
    'www.xiaohongshu.com.',
    'www.xiaohongshu.com:443',
    'https://www.xiaohongshu.com/explore',
    'https://creator.xiaohongshu.com/publish/publish',
  ]) {
    assert.equal(isXhsHost(host), true, host)
  }
})

test('isXhsHost 拦截伪装域、近邻域与非小红书站点', () => {
  for (const host of [
    'xiaohongshu.com.evil.com',
    'www.xiaohongshu.com.evil.com',
    'notxiaohongshu.com',
    'evil-xiaohongshu.com',
    'xiaohongshu.com.cn',
    'xiaohongshu.co',
    'xiaohongshu.com@evil.com',
    'example.com',
    'about:blank',
    '',
  ]) {
    assert.equal(isXhsHost(host), false, host)
  }
})

test('hostFromUrl 只解析 http(s) 页面，其它协议返回空串', () => {
  assert.equal(hostFromUrl('https://www.xiaohongshu.com/explore'), 'www.xiaohongshu.com')
  assert.equal(hostFromUrl('HTTP://CREATOR.XIAOHONGSHU.COM:80/publish'), 'creator.xiaohongshu.com')
  assert.equal(hostFromUrl('about:blank'), '')
  assert.equal(hostFromUrl('chrome://settings'), '')
  assert.equal(hostFromUrl('file:///C:/note.html'), '')
  assert.equal(hostFromUrl('data:text/html,hi'), '')
  assert.equal(hostFromUrl('www.xiaohongshu.com'), '')
  assert.equal(hostFromUrl(''), '')
})

test('pageHost 在 URL 不可读时回落到 host 注入的 URL', () => {
  assert.equal(pageHost({ url: 'https://www.xiaohongshu.com/explore' }), 'www.xiaohongshu.com')
  assert.equal(pageHost({ url: 'about:blank', fallbackUrl: 'https://creator.xiaohongshu.com/publish' }), 'creator.xiaohongshu.com')
  assert.equal(pageHost({ url: '', fallbackUrl: '' }), '')
})

test('pageGate：xhs 放行、外站拦截、URL 未知返回 unknown、allowAllHosts 全放行', () => {
  assert.deepEqual(pageGate({ url: 'https://www.xiaohongshu.com/explore' }), {
    allowed: true,
    reason: 'xhs',
    host: 'www.xiaohongshu.com',
  })
  assert.deepEqual(pageGate({ url: 'https://example.com/' }), {
    allowed: false,
    reason: 'foreign',
    host: 'example.com',
  })
  assert.deepEqual(pageGate({ url: 'about:blank' }), { allowed: false, reason: 'unknown', host: '' })
  assert.deepEqual(pageGate({ url: 'https://xiaohongshu.com.evil.com/' }), {
    allowed: false,
    reason: 'foreign',
    host: 'xiaohongshu.com.evil.com',
  })
  assert.deepEqual(pageGate({ url: 'https://example.com/', allowAllHosts: true }), {
    allowed: true,
    reason: 'allow-all',
    host: 'example.com',
  })
  // allowAllHosts still needs a real page: about:blank stays "unknown".
  assert.equal(pageGate({ url: 'about:blank', allowAllHosts: true }).allowed, false)
  // A host-injected URL decides when location is not readable.
  assert.equal(
    pageGate({ url: 'about:blank', fallbackUrl: 'https://www.xiaohongshu.com/explore' }).allowed,
    true,
  )
})
