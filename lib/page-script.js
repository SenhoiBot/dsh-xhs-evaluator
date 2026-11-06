/**
 * Guest-page controller for the XHS note evaluator (built-in sidebar browser).
 *
 * Injected into the page by the client plugin via `webview.executeJavaScript`.
 * It paints a floating ball + evaluation panel inside a Shadow DOM, collects the
 * user's draft, and hands it to the DSH renderer/host through
 * `window.__DSH_XHS_PAGE__`. All model calls happen outside the page: this
 * script never performs network requests, never touches storage and never
 * modifies the host page's DOM (it only appends its own shadow host).
 *
 * Site gate: the UI is XHS-only (`xiaohongshu.com` + subdomains, mirrored from
 * `lib/hosts.js`). On any other page `ensureUI()` returns null, so no Shadow
 * DOM host and no element is ever created. When the URL is not readable yet
 * (about:blank / an initial blank document) mounting is deferred until either
 * `location` becomes a real page or the client passes the URL it injected us
 * with (`window.__DSH_XHS_INJECT_URL__`, `configure({ url })`).
 * `configure({ allowAllHosts: true })` (config override, default false) restores
 * the old "any page" behaviour.
 *
 * Contract (`window.__DSH_XHS_PAGE__`):
 *   poll()                        -> { kind: 'evaluate'|'revise', input } | null (once)
 *   status(state, label, detail)  -> true              (idle|busy|done|error)
 *   result(report)                -> true              (renders a DESIGN.md Report)
 *   revision(revised)             -> true              (renders the 整改稿 view)
 *   error(message)                -> true              (renders a retryable failure)
 *   state()                       -> { open, phase, values }
 *   ping()                        -> true
 *   toggle()                      -> boolean
 *   build                         -> content hash (hot-swap marker)
 *   destroy()                     -> boolean           (removes UI + listeners + timers)
 *
 * The IIFE is idempotent: a second injection returns 'ready' and installs
 * nothing. Both the report shape and this API are frozen in DESIGN.md.
 */
(function () {
  'use strict'

  var KEY = '__DSH_XHS_PAGE__'
  /**
   * The host replaces this placeholder with a content hash when it serves this
   * file; the client half compares it with `/xhs/state`.build and hot-swaps a
   * stale injected copy, so a page-script update never needs a manual reload.
   */
  var BUILD = '__DSH_XHS_BUILD__'
  if (window[KEY] !== undefined) return 'ready'

  /* ---------------------------------------------------------------- constants */

  /** Input limits, mirrored from DESIGN.md (host re-clamps anyway). */
  var LIMITS = { title: 20, body: 1000, tags: 10 }
  var NICHES = [
    '美妆护肤', '穿搭', '美食', '旅行', '家居', '母婴',
    '健身运动', '数码', '学习成长', '职场', '情感', '其他',
  ]
  /** [wire value (DESIGN canonical), display label] */
  var FANS = [
    ['新号(<1000)', '新号（<1000）'],
    ['1k-1w', '1k–1w'],
    ['1w-10w', '1w–10w'],
    ['10w+', '10w+'],
    ['100w+', '100w+'],
  ]
  /** Verdict -> colour band tone. */
  var VERDICT_TONES = { viral: 'good', strong: 'good', average: 'info', weak: 'warn', poor: 'bad' }
  /** Fallback labels when the host omits `verdictLabel`. */
  var VERDICT_LABELS = { viral: '有爆款相', strong: '中上', average: '中规中矩', weak: '偏弱', poor: '很差' }
  /** Signal level -> colour dot tone. */
  var SIGNAL_TONES = { good: 'good', warn: 'warn', bad: 'bad' }
  /** Predicted metric cards, in display order. */
  var METRICS = [
    ['reads', '阅读量'],
    ['likes', '点赞'],
    ['collects', '收藏'],
    ['comments', '评论'],
  ]
  /** 修改指引: fixed section order + display names (DESIGN.md). */
  var GUIDE_ORDER = ['title', 'cover', 'images', 'text', 'tags']
  var GUIDE_NAMES = { title: '标题', cover: '封面', images: '内部图', text: '文字内容', tags: '标签' }
  /** Hosts/models occasionally hand over Chinese or synonym keys; normalise them. */
  var GUIDE_ALIASES = {
    title: 'title', 标题: 'title',
    cover: 'cover', 封面: 'cover', 头图: 'cover',
    images: 'images', image: 'images', 内部图: 'images', 配图: 'images',
    text: 'text', 文字内容: 'text', 正文: 'text',
    tags: 'tags', tag: 'tags', 标签: 'tags', 话题: 'tags',
  }
  var SVG_NS = 'http://www.w3.org/2000/svg'

  /** Floating-ball glyph: a white sparkle (star) + a small secondary spark. */
  var ICON_PATHS = [
    { d: 'M11.4 2.3l2.3 5.9 5.9 2.3-5.9 2.3-2.3 5.9-2.3-5.9-5.9-2.3 5.9-2.3 2.3-5.9z' },
    { d: 'M18.1 14.9l.9 2.2 2.2.9-2.2.9-.9 2.2-.9-2.2-2.2-.9 2.2-.9.9-2.2z', opacity: '0.82' },
  ]

  /**
   * Shadow-root stylesheet. The shell's critical layout (ball, panel) is also
   * pinned inline below so the UI stays usable even if a strict page CSP drops
   * this <style> element. Page CSS cannot leak in: the shadow subtree is
   * isolated and the host resets every inherited property via `all: initial`.
   */
  var CSS = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }

/* -------------------------------------------------------------------- ball */
.ball {
  position: fixed; left: 18px; right: auto; bottom: 18px; width: 56px; height: 56px;
  margin: 0; padding: 0; border: 0; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: linear-gradient(135deg, #ff5a6e 0%, #ff2442 52%, #e8112d 100%);
  color: #fff; cursor: grab; touch-action: none;
  box-shadow: 0 8px 22px rgba(255, 36, 66, .38), 0 2px 6px rgba(0, 0, 0, .16);
  transition: transform .18s cubic-bezier(.34, 1.56, .64, 1), box-shadow .18s ease;
  -webkit-user-select: none; user-select: none; -webkit-tap-highlight-color: transparent;
}
.ball:hover { transform: scale(1.06); box-shadow: 0 10px 26px rgba(255, 36, 66, .46), 0 3px 8px rgba(0, 0, 0, .18); }
.ball:active { cursor: grabbing; transform: scale(.97); }
.ball:focus-visible { outline: 3px solid rgba(255, 36, 66, .35); outline-offset: 3px; }
.ball .icon { width: 28px; height: 28px; display: block; transition: opacity .15s ease, transform .15s ease; }
.ball[data-phase="busy"] { animation: dsh-xhs-pulse 1.9s ease-in-out infinite; }
.ball[data-phase="busy"] .icon { opacity: 0; transform: scale(.55); }
.ball .spinner {
  position: absolute; width: 22px; height: 22px; border-radius: 50%;
  border: 2.5px solid rgba(255, 255, 255, .35); border-top-color: #fff;
  animation: dsh-xhs-spin .8s linear infinite; display: none;
}
.ball .spinner.on { display: block; }
.ball .badge {
  position: absolute; right: 64px; top: 50%; transform: translateY(-50%);
  padding: 4px 9px; border-radius: 999px; background: rgba(31, 35, 41, .92);
  color: #fff; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap;
  display: none; box-shadow: 0 4px 12px rgba(0, 0, 0, .18);
}
.ball .badge.on { display: block; }
.ball .dot {
  position: absolute; top: -1px; right: -1px; width: 14px; height: 14px;
  border-radius: 50%; background: #ff2442; border: 2px solid #fff;
  box-shadow: 0 2px 6px rgba(0, 0, 0, .22); display: none;
}
.ball .dot.on { display: block; }

/* ------------------------------------------------------------------- panel */
.panel {
  position: fixed; right: 18px; bottom: 86px;
  width: min(360px, calc(100vw - 24px));
  max-height: min(78vh, 640px);
  display: none; flex-direction: column; overflow: hidden;
  border-radius: 16px; background: #fff; color: #1f2329;
  border: 1px solid rgba(15, 23, 42, .06);
  box-shadow: 0 20px 50px rgba(15, 23, 42, .22), 0 2px 10px rgba(15, 23, 42, .08);
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 13px; line-height: 1.5; text-align: left;
}
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 14px 14px 10px 16px; flex: none; }
.panel-title { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 700; letter-spacing: .2px; color: #1f2329; }
.panel-title .mark { width: 4px; height: 16px; border-radius: 2px; background: linear-gradient(180deg, #ff5a6e, #ff2442); display: block; flex: none; }
.close {
  width: 28px; height: 28px; padding: 0; border: 0; border-radius: 50%;
  background: #f4f4f6; color: #6b7280; font-size: 16px; line-height: 1; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: background .15s ease, color .15s ease;
}
.close:hover { background: #ebebef; color: #1f2329; }
.head-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; }
.head-edit {
  display: none; height: 28px; padding: 0 10px; border: 0; border-radius: 14px;
  background: #fff1f3; color: #ff2442; font-family: inherit; font-size: 12px; font-weight: 700;
  line-height: 1; cursor: pointer; align-items: center; justify-content: center;
  transition: background .15s ease, color .15s ease;
}
.head-edit:hover { background: #ffe0e6; }
.panel[data-view="result"] .head-edit,
.panel[data-view="revise"] .head-edit { display: inline-flex; }

.progress { display: none; height: 3px; flex: none; background: #ffe9ec; overflow: hidden; }
.progress.on { display: block; }
.progress-fill { display: block; height: 100%; width: 0; background: linear-gradient(90deg, #ff8a99, #ff2442); transition: width .3s ease; }

/* ------------------------------------------------------------------ banner */
.banner { display: none; margin: 0 16px 8px; padding: 9px 11px; border-radius: 10px; background: #fff1f2; border: 1px solid #ffe0e4; color: #b91c1c; font-size: 12px; flex: none; }
.banner.on { display: block; }
.banner-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.banner-msg { flex: 1 1 auto; word-break: break-word; }
.banner-hint { margin-top: 5px; color: #9f1239; opacity: .72; font-size: 11px; }
.retry { flex: none; border: 0; border-radius: 8px; background: #ff2442; color: #fff; font-family: inherit; font-size: 12px; font-weight: 600; padding: 4px 10px; cursor: pointer; }
.retry:hover { background: #e8112d; }

/* ------------------------------------------------------------------ scroll */
.scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 0 16px 14px; }
.scroll::-webkit-scrollbar { width: 6px; }
.scroll::-webkit-scrollbar-thumb { background: rgba(15, 23, 42, .14); border-radius: 3px; }

/* -------------------------------------------------------------------- form */
.field { margin-top: 12px; }
.form > .field:first-child { margin-top: 2px; }
.label { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 6px; font-size: 12px; font-weight: 600; color: #4b5563; }
.label .req { color: #ff2442; margin-left: 3px; }
.count { font-weight: 400; color: #9ca3af; font-size: 11px; font-variant-numeric: tabular-nums; }
.input, .textarea, .select {
  width: 100%; border: 1px solid #e5e7eb; border-radius: 10px; background: #fff; color: #1f2329;
  font-family: inherit; font-size: 13px; line-height: 1.5; padding: 8px 11px; outline: none;
  transition: border-color .15s ease, box-shadow .15s ease;
}
.input:focus, .textarea:focus, .select:focus { border-color: #ff2442; box-shadow: 0 0 0 3px rgba(255, 36, 66, .12); }
.input::placeholder, .textarea::placeholder { color: #b3b8c2; }
.textarea { min-height: 104px; resize: none; padding-top: 9px; }
.select {
  appearance: none; -webkit-appearance: none; padding-right: 30px; cursor: pointer;
  background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 10px center;
}
.row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.hint { margin-top: 5px; font-size: 11px; color: #9ca3af; }
.models { display: flex; gap: 8px; }
.model {
  flex: 1 1 0; height: 34px; border: 1px solid #e5e7eb; border-radius: 10px; background: #fafafa;
  color: #4b5563; font-family: inherit; font-size: 13px; font-weight: 500; cursor: pointer;
  transition: background .15s ease, border-color .15s ease, color .15s ease;
}
.model:hover { border-color: #d9dbe1; }
.model:disabled { cursor: not-allowed; opacity: .42; }
.model:disabled:hover { border-color: #e5e7eb; }
.model.on { background: rgba(255, 36, 66, .08); border-color: rgba(255, 36, 66, .55); color: #ff2442; font-weight: 700; }
.models-note { margin-top: 6px; font-size: 11px; color: #9ca3af; }
.submit {
  width: 100%; height: 42px; margin-top: 14px; border: 0; border-radius: 12px;
  background: linear-gradient(135deg, #ff5a6e, #ff2442); color: #fff;
  font-family: inherit; font-size: 14px; font-weight: 700; letter-spacing: .5px; cursor: pointer;
  box-shadow: 0 8px 18px rgba(255, 36, 66, .26);
  transition: transform .15s ease, box-shadow .15s ease, opacity .15s ease;
}
.submit:hover { transform: translateY(-1px); box-shadow: 0 10px 22px rgba(255, 36, 66, .32); }
.submit:active { transform: translateY(0); }
.submit:disabled { cursor: not-allowed; opacity: .55; box-shadow: none; transform: none; }
.note { margin-top: 10px; text-align: center; font-size: 11px; color: #9ca3af; }
.busy { display: none; align-items: center; gap: 8px; margin-top: 10px; font-size: 12px; color: #ff2442; }
.busy.on { display: flex; }
.spin { width: 14px; height: 14px; flex: none; border-radius: 50%; border: 2px solid rgba(255, 36, 66, .22); border-top-color: #ff2442; animation: dsh-xhs-spin .8s linear infinite; }
.busy-detail { color: #9ca3af; font-size: 11px; }

/* ------------------------------------------------------------------ result */
.result { display: none; }
.verdict { margin-top: 2px; padding: 12px 14px; border-radius: 12px; color: #fff; background: linear-gradient(135deg, #64748b, #475569); box-shadow: 0 6px 16px rgba(15, 23, 42, .14); }
.verdict[data-tone="good"] { background: linear-gradient(135deg, #22c55e, #15803d); box-shadow: 0 6px 16px rgba(34, 197, 94, .28); }
.verdict[data-tone="info"] { background: linear-gradient(135deg, #3b82f6, #1d4ed8); box-shadow: 0 6px 16px rgba(59, 130, 246, .28); }
.verdict[data-tone="warn"] { background: linear-gradient(135deg, #f59e0b, #d97706); box-shadow: 0 6px 16px rgba(245, 158, 11, .3); }
.verdict[data-tone="bad"] { background: linear-gradient(135deg, #ef4444, #b91c1c); box-shadow: 0 6px 16px rgba(239, 68, 68, .3); }
.verdict-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.verdict-label { font-size: 17px; font-weight: 800; letter-spacing: .5px; }
.verdict-conf { font-size: 11px; opacity: .88; font-variant-numeric: tabular-nums; }
.section-title { display: flex; align-items: center; gap: 6px; margin: 16px 0 8px; font-size: 12px; font-weight: 700; color: #374151; }
.tag { margin-left: auto; padding: 2px 7px; border-radius: 999px; background: rgba(255, 36, 66, .08); color: #ff2442; font-size: 10px; font-weight: 500; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.metric { padding: 9px 11px; border: 1px solid #f0f0f3; border-radius: 12px; background: #fafafb; }
.metric-name { font-size: 11px; color: #6b7280; }
.metric-mid { margin-top: 2px; font-size: 17px; font-weight: 800; color: #1f2329; letter-spacing: -.2px; font-variant-numeric: tabular-nums; }
.metric-range { margin-top: 1px; font-size: 11.5px; color: #9ca3af; font-variant-numeric: tabular-nums; }
.meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.chip { padding: 3px 9px; border-radius: 999px; background: #f4f4f6; color: #4b5563; font-size: 11px; font-variant-numeric: tabular-nums; }
.chip b { color: #1f2329; font-weight: 700; }
.summary { margin-top: 12px; padding: 10px 12px; border-radius: 10px; background: #f8f9fb; border-left: 3px solid #ff2442; font-size: 12.5px; line-height: 1.6; color: #374151; }
.signals { display: flex; flex-direction: column; gap: 6px; }
.signal { display: flex; align-items: flex-start; gap: 8px; padding: 7px 10px; border-radius: 10px; background: #fafafb; }
.signal-dot { width: 8px; height: 8px; flex: none; margin-top: 5px; border-radius: 50%; background: #9ca3af; }
.signal[data-tone="good"] .signal-dot { background: #22c55e; }
.signal[data-tone="warn"] .signal-dot { background: #f59e0b; }
.signal[data-tone="bad"] .signal-dot { background: #ef4444; }
.signal-body { flex: 1 1 auto; }
.signal-label { font-size: 12px; font-weight: 600; color: #374151; }
.signal-note { margin-left: 6px; font-size: 11.5px; color: #6b7280; }
.directions { display: flex; flex-direction: column; gap: 8px; }
.direction { padding: 10px 12px; border: 1px solid #ffe4e8; border-radius: 12px; background: #fff7f8; }
.direction-title { display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 700; color: #be123c; }
.direction-title .arrow { color: #ff2442; font-size: 13px; }
.direction-why, .direction-action { margin-top: 5px; font-size: 11.5px; line-height: 1.55; color: #6b7280; }
.direction-action { color: #374151; }
.direction-key { display: inline-block; margin-right: 5px; padding: 0 5px; border-radius: 4px; background: rgba(255, 36, 66, .08); color: #ff2442; font-size: 10px; font-weight: 600; }
.optional { margin-top: 16px; border: 1px solid #f0f0f3; border-radius: 12px; overflow: hidden; }
.optional > summary { list-style: none; display: flex; align-items: center; justify-content: space-between; padding: 9px 12px; font-size: 12px; font-weight: 600; color: #4b5563; background: #fafafb; cursor: pointer; }
.optional > summary::-webkit-details-marker { display: none; }
.optional > summary .chev { color: #9ca3af; font-size: 11px; transition: transform .18s ease; }
.optional[open] > summary .chev { transform: rotate(90deg); }
.optional-inner { padding: 10px; }
/* 修改指引: tips that may include a labelled example (the only place copy is allowed). */
.guide { margin-top: 4px; }
.guide-intro { margin-bottom: 8px; font-size: 12px; line-height: 1.6; color: #6b7280; }
.guide-list { display: flex; flex-direction: column; gap: 6px; }
.guide-row { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border: 1px solid #f0f0f3; border-radius: 10px; background: #fafafb; }
.guide-name { flex: none; margin-top: 1px; padding: 0 8px; border-radius: 999px; background: rgba(255, 36, 66, .08); color: #ff2442; font-size: 11px; font-weight: 600; line-height: 18px; white-space: nowrap; }
.guide-body { flex: 1 1 auto; font-size: 12px; line-height: 1.6; color: #374151; }
.guide-example { margin-left: 2px; color: #9ca3af; }
.footnote { margin-top: 14px; padding-bottom: 2px; font-size: 10.5px; line-height: 1.6; color: #9ca3af; }

/* -------------------------------------------------------------- 整改稿 view */
.revise-view { display: none; }
.revise-head { display: flex; flex-direction: column; gap: 6px; margin-top: 2px; }
.revise-tag {
  align-self: flex-start; padding: 2px 10px; border-radius: 999px;
  background: linear-gradient(135deg, #ff5a6e, #ff2442); color: #fff;
  font-size: 11px; font-weight: 700; letter-spacing: .3px;
}
.revise-summary { margin: 0; font-size: 12.5px; line-height: 1.6; color: #374151; }
.revise-block { margin-top: 12px; padding: 10px 12px; border: 1px solid #f0f0f3; border-radius: 12px; background: #fafafb; }
.revise-label { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 5px; font-size: 11.5px; font-weight: 700; color: #4b5563; }
.revise-count { font-weight: 400; color: #9ca3af; font-size: 10.5px; font-variant-numeric: tabular-nums; }
.revise-value { font-size: 12.5px; line-height: 1.65; color: #1f2329; white-space: pre-wrap; word-break: break-word; }
.revise-body { max-height: 150px; overflow-y: auto; }
.revise-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.revise-tag-item { padding: 2px 8px; border-radius: 999px; background: rgba(255, 36, 66, .08); color: #ff2442; font-size: 11px; }
.revise-meta { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }
.revise-meta-row { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border-radius: 10px; background: #f8f9fb; font-size: 12px; line-height: 1.55; }
.revise-meta-key { flex: none; color: #6b7280; font-weight: 600; font-size: 11.5px; }
.revise-meta-value { flex: 1 1 auto; color: #374151; white-space: pre-wrap; word-break: break-word; }
.revise-hint { margin-top: 14px; padding: 8px 10px; border-radius: 10px; background: #fff7f8; color: #be123c; font-size: 11px; line-height: 1.55; }

/* --------------------------------------------------------------- footer */
.foot { display: none; flex: none; gap: 8px; padding: 10px 16px 14px; border-top: 1px solid #f3f4f6; background: #fff; }
.btn { flex: 1 1 0; height: 38px; border: 1px solid #e5e7eb; border-radius: 10px; background: #fff; color: #374151; font-family: inherit; font-size: 13px; font-weight: 600; cursor: pointer; transition: background .15s ease, border-color .15s ease; }
.btn:hover { background: #f9fafb; }
.btn-primary { border: 0; background: linear-gradient(135deg, #ff5a6e, #ff2442); color: #fff; box-shadow: 0 6px 14px rgba(255, 36, 66, .22); }
.btn-primary:hover { background: linear-gradient(135deg, #ff6b7c, #ff3352); }

@keyframes dsh-xhs-spin { to { transform: rotate(360deg); } }
@keyframes dsh-xhs-pulse {
  0%, 100% { box-shadow: 0 8px 22px rgba(255, 36, 66, .38), 0 2px 6px rgba(0, 0, 0, .16); }
  50% { box-shadow: 0 8px 26px rgba(255, 36, 66, .62), 0 0 0 6px rgba(255, 36, 66, .10); }
}
@media (prefers-reduced-motion: reduce) {
  .ball, .ball .icon, .progress-fill, .close, .model, .submit, .btn { transition: none; }
  .ball[data-phase="busy"], .ball .spinner, .spin { animation: none; }
}
`

  /* -------------------------------------------------------------------- state */

  var destroyed = false
  /** 'idle' | 'busy' | 'done' | 'error' */
  var phase = 'idle'
  var open = false
  /** Set when the user closes the panel themselves; suppresses auto-reopen. */
  var closedByUser = false
  /** Pending request for the client poller: `{ input } | null`. */
  var pending = null
  /** Last submitted input, used by 一键整改 and the retry button. */
  var lastInput = null
  /** Which request the retry button should re-publish: 'evaluate' | 'revise'. */
  var lastIntent = 'evaluate'
  /** Latest Report handed over by the host (DESIGN.md shape). */
  var report = null
  /** Latest Revision handed over by the host, normalised for the 整改稿 view. */
  var revisionDraft = null
  /** Progress label/detail supplied by status(). */
  var busy = { label: '', detail: '' }
  /** Selected ensemble size (1..3). */
  var selectedModels = 2
  /**
   * Model roster reported by the client half through `configure()`:
   * `{ labels: string[] }` after the host answered `/xhs/state`, else null.
   * Used to disable sizes the profile cannot actually run.
   */
  var roster = null
  /** Floating-ball position (left/top px) in memory only — never storage. */
  var pos = null
  /**
   * Default anchor before the user drags the ball. Bottom-left by default: the
   * sibling sidebar-browser translator pill owns the bottom-right corner.
   */
  var homePos = { side: 'left', bottom: 18 }
  /** Live DOM references; null before the first boot and after destroy(). */
  var el = null
  /** Registered event listeners, all removed by destroy(). */
  var listeners = []
  /** Registered timers, all cleared by destroy(). */
  var timers = []
  /** Active drag gesture (pointer events cover mouse + touch). */
  var drag = null
  /** Click events before this timestamp are pointer-up artefacts of a drag. */
  var suppressClickUntil = 0
  /** Root domain the ball may appear on (mirror of lib/hosts.js). */
  var XHS_ROOT_DOMAIN = 'xiaohongshu.com'
  /** Config override delivered through `configure()`: render on any page. */
  var allowAllHosts = false
  /** URL the client half injected us with; fallback while `location` is blank. */
  var injectedUrl = ''
  try {
    if (typeof window.__DSH_XHS_INJECT_URL__ === 'string') injectedUrl = window.__DSH_XHS_INJECT_URL__
  } catch (error) {
    /* A page may freeze globals; the location fallback still works. */
  }
  /** Armed once when the URL is not readable yet; removed by destroy(). */
  var gateWaitersArmed = false

  /* ---------------------------------------------------------------- utilities */

  function squash(value) {
    return String(value == null ? '' : value).trim()
  }

  function clamp(value, min, max) {
    if (!isFinite(value)) return min
    return Math.min(max, Math.max(min, value))
  }

  /** Integer >= 0, tolerating NaN/negative/undefined model output. */
  function safeInt(value) {
    var number = Math.round(Number(value))
    return isFinite(number) && number > 0 ? number : 0
  }

  /**
   * DESIGN.md count format: 1200 -> "1.2k", 12000 -> "1.2万".
   * @param {number} value
   * @returns {string}
   */
  function formatCount(value) {
    var number = Number(value)
    if (!isFinite(number) || number <= 0) return '0'
    if (number < 1000) return String(Math.round(number))
    var scaled = number < 10000 ? number / 1000 : number / 10000
    var unit = number < 10000 ? 'k' : '万'
    var text = scaled >= 100 ? String(Math.round(scaled)) : scaled.toFixed(1)
    return text.replace(/\.0$/, '') + unit
  }

  /**
   * Split the tag input on spaces/commas, strip leading '#' and dedupe.
   * @param {string} raw
   * @returns {string[]}
   */
  function parseTags(raw) {
    var seen = {}
    var tags = []
    var parts = String(raw == null ? '' : raw).split(/[\s,，、;；|]+/)
    for (var index = 0; index < parts.length; index += 1) {
      var tag = parts[index].replace(/^#+/, '').trim()
      if (tag === '' || Object.prototype.hasOwnProperty.call(seen, tag)) continue
      seen[tag] = true
      tags.push(tag)
      if (tags.length >= LIMITS.tags) break
    }
    return tags
  }

  /** Create an element with an optional class and text content. */
  function createNode(tag, className, textContent) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (textContent !== undefined && textContent !== null) node.textContent = String(textContent)
    return node
  }

  function createButton(className, label) {
    var button = document.createElement('button')
    button.type = 'button'
    if (className) button.className = className
    if (label !== undefined && label !== null) button.textContent = String(label)
    return button
  }

  /** Inline sparkle glyph for the floating ball (white, no external assets). */
  function createIcon() {
    var svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('width', '28')
    svg.setAttribute('height', '28')
    svg.setAttribute('fill', 'currentColor')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('class', 'icon')
    for (var index = 0; index < ICON_PATHS.length; index += 1) {
      var path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('d', ICON_PATHS[index].d)
      if (ICON_PATHS[index].opacity) path.setAttribute('opacity', ICON_PATHS[index].opacity)
      svg.appendChild(path)
    }
    return svg
  }

  /** camelCase -> kebab-case for CSSStyleDeclaration.setProperty. */
  function cssName(name) {
    return String(name).replace(/[A-Z]/g, function (letter) {
      return '-' + letter.toLowerCase()
    })
  }

  /** Pin critical inline styles with !important — beats page CSS even on CSP. */
  function pinStyles(element, styles) {
    if (!element || !element.style) return
    for (var name in styles) {
      if (!Object.prototype.hasOwnProperty.call(styles, name)) continue
      try {
        element.style.setProperty(cssName(name), String(styles[name]), 'important')
      } catch (error) {
        /* Ignore unsupported properties on unusual engines. */
      }
    }
  }

  /** addEventListener + bookkeeping so destroy() can remove everything. */
  function listen(target, type, handler, options) {
    if (!target || typeof target.addEventListener !== 'function') return
    target.addEventListener(type, handler, options)
    listeners.push({ target: target, type: type, handler: handler, options: options })
  }

  function clearListeners() {
    for (var index = 0; index < listeners.length; index += 1) {
      var entry = listeners[index]
      try {
        entry.target.removeEventListener(entry.type, entry.handler, entry.options)
      } catch (error) {
        /* Ignore detached targets. */
      }
    }
    listeners = []
  }

  /** Tracked setTimeout; callbacks never run after destroy(). */
  function later(callback, delay) {
    var id = window.setTimeout(function () {
      removeTimer(id)
      if (destroyed) return
      try {
        callback()
      } catch (error) {
        /* A cosmetic callback must never break the host page. */
      }
    }, delay)
    timers.push(id)
    return id
  }

  function removeTimer(id) {
    var index = timers.indexOf(id)
    if (index !== -1) timers.splice(index, 1)
  }

  function clearTimers() {
    for (var index = 0; index < timers.length; index += 1) {
      try {
        window.clearTimeout(timers[index])
      } catch (error) {
        /* Ignore. */
      }
    }
    timers = []
  }

  function clearChildren(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild)
  }

  function setImportant(element, property, value) {
    if (!element || !element.style) return
    try {
      element.style.setProperty(property, value, 'important')
    } catch (error) {
      /* Ignore. */
    }
  }

  function toggleClass(element, className, force) {
    if (!element || !element.classList) return
    if (force) element.classList.add(className)
    else element.classList.remove(className)
  }

  /* -------------------------------------------------------------- derived UI */

  /** Percentage parsed out of the current progress label, or null. */
  function busyPercent() {
    var label = String(busy.label || '')
    var fraction = /(\d+)\s*\/\s*(\d+)/.exec(label)
    if (fraction) {
      var done = Number(fraction[1])
      var total = Number(fraction[2])
      if (total > 0) return Math.round((clamp(done, 0, total) / total) * 100)
    }
    var percent = /(\d{1,3})\s*%/.exec(label)
    if (percent) return clamp(Number(percent[1]), 0, 100)
    return null
  }

  function confidenceText(confidence) {
    var value = Number(confidence)
    if (!isFinite(value) || value < 0) return ''
    var percent = value <= 1 ? value * 100 : value
    return Math.round(clamp(percent, 0, 100)) + '%'
  }

  function percentText(rate) {
    var value = Number(rate)
    if (!isFinite(value) || value < 0) return ''
    var percent = value <= 1 ? value * 100 : value
    return (Math.round(percent * 10) / 10).toFixed(1) + '%'
  }

  /** Current form contents, clamped to the same limits the host enforces. */
  function readValues() {
    if (!el) {
      return { title: '', body: '', tags: [], niche: NICHES[0], fans: FANS[0][0], models: selectedModels }
    }
    return {
      title: squash(el.title.value).slice(0, LIMITS.title),
      body: squash(el.body.value).slice(0, LIMITS.body),
      tags: parseTags(el.tags.value),
      niche: squash(el.niche.value) || NICHES[0],
      fans: squash(el.fans.value) || FANS[0][0],
      models: clamp(Math.round(Number(selectedModels) || 2), 1, 3),
    }
  }

  /* ------------------------------------------------------------------- paint */

  function updateCounters() {
    if (!el) return
    el.titleCount.textContent = String(el.title.value.length) + '/' + LIMITS.title
    el.bodyCount.textContent = String(el.body.value.length) + '/' + LIMITS.body
  }

  function updateSubmitState() {
    if (!el) return
    var canSubmit = phase !== 'busy' && squash(el.body.value) !== ''
    el.submit.disabled = !canSubmit
    el.submit.textContent = phase === 'busy' ? '评估中…' : '开始评估'
  }

  /** How many models this profile can actually run (1..3). */
  function modelCapacity() {
    return roster !== null && roster.labels.length > 0 ? roster.labels.length : 3
  }

  /**
   * Apply the roster to the model chips: sizes the profile cannot run are
   * disabled, so the panel never promises an ensemble it cannot deliver.
   */
  function applyRosterLimits() {
    if (!el) return
    var capacity = modelCapacity()
    for (var index = 0; index < el.modelButtons.length; index += 1) {
      var button = el.modelButtons[index]
      var value = Number(button.getAttribute('data-models'))
      var unavailable = value > capacity
      if (typeof button.disabled === 'boolean') button.disabled = unavailable
      if (unavailable) button.setAttribute('aria-disabled', 'true')
      else button.removeAttribute('aria-disabled')
    }
    if (selectedModels > capacity) selectedModels = capacity
  }

  function updateModelsNote() {
    if (!el) return
    if (roster !== null && roster.labels.length > 0) {
      var available = roster.labels.length
      var labels = roster.labels.slice(0, Math.max(1, selectedModels))
      var text
      if (available === 1) text = '仅 1 个宿主模型可用：' + roster.labels[0]
      else if (available < 3) text = '将用 ' + labels.join(' / ') + '（共 ' + available + ' 个可用）'
      else text = '将用 ' + labels.join(' / ')
      el.modelsNote.textContent = text
      return
    }
    el.modelsNote.textContent = '调用 ' + selectedModels + ' 个 DSH 宿主模型交叉评估'
  }

  /**
   * Client-side hook: report the model roster and the preferred anchor the host
   * resolved, so the panel shows the real ensemble instead of a blind 1/2/3
   * promise, and so the ball does not land on the translator pill.
   *
   * Also carries the site-gate inputs over the existing configure channel:
   * `allowAllHosts` (config override, default false) and `url` (the page URL the
   * client injected us with, used when `location` is still blank).
   * @param {{models?: Array<{label?: string}|string>, ball?: {side?: string, bottom?: number}, allowAllHosts?: boolean, url?: string}|null} input
   * @returns {boolean}
   */
  function configure(input) {
    if (destroyed) return false
    var options = input !== null && typeof input === 'object' ? input : null
    if (options !== null) {
      if (options.allowAllHosts === true) allowAllHosts = true
      if (typeof options.url === 'string' && options.url !== '') injectedUrl = options.url
    }
    var labels = []
    if (input !== null && typeof input === 'object' && Array.isArray(input.models)) {
      for (var index = 0; index < input.models.length; index += 1) {
        var entry = input.models[index]
        var label = typeof entry === 'string' ? entry : entry && typeof entry.label === 'string' ? entry.label : ''
        label = squash(label)
        if (label !== '' && labels.indexOf(label) < 0) labels.push(label)
        if (labels.length >= 3) break
      }
    }
    roster = labels.length > 0 ? { labels: labels } : null
    if (input !== null && typeof input === 'object' && input.ball !== null && typeof input.ball === 'object') {
      var side = input.ball.side === 'right' ? 'right' : 'left'
      var bottom = Number(input.ball.bottom)
      homePos = { side: side, bottom: isFinite(bottom) ? clamp(Math.round(bottom), 0, 240) : 18 }
    }
    if (!el) {
      // `allowAllHosts` / `url` above may have just unblocked a deferred gate.
      if (canMount()) boot()
      return true
    }
    applyRosterLimits()
    selectModels(selectedModels)
    updateSubmitState()
    if (!pos) {
      applyPos()
      positionPanel()
    }
    return true
  }

  function updateBall() {
    if (!el) return
    var running = phase === 'busy'
    el.ball.setAttribute('data-phase', phase)
    toggleClass(el.spinner, 'on', running)
    toggleClass(el.badge, 'on', running)
    if (running) {
      var percent = busyPercent()
      el.badge.textContent = percent === null ? '…' : percent + '%'
    } else {
      el.badge.textContent = ''
    }
    toggleClass(el.dot, 'on', (phase === 'done' || phase === 'error') && !open)
    var label = phase === 'busy'
      ? (busy.label || '评估中…')
      : phase === 'done'
        ? '查看评估结果'
        : phase === 'error'
          ? '评估失败，点击查看'
          : '打开小红书笔记评估'
    el.ball.setAttribute('aria-label', label)
    el.ball.setAttribute('title', label)
  }

  /**
   * Switch between the three panel views. Footers swap too: the result view keeps
   * [返回编辑] [复制报告] [一键整改], the revise view has its own tri-button bar.
   */
  function setView(view) {
    if (!el) return
    el.form.style.display = view === 'form' ? 'block' : 'none'
    el.result.style.display = view === 'result' ? 'block' : 'none'
    if (el.reviseView) el.reviseView.style.display = view === 'revise' ? 'block' : 'none'
    el.foot.style.display = view === 'result' ? 'flex' : 'none'
    if (el.footRevise) el.footRevise.style.display = view === 'revise' ? 'flex' : 'none'
    // Drives the "返回编辑" affordance in the title bar (result + revise views).
    el.panel.setAttribute('data-view', view)
    // Both views start at their top: a scrolled report must not leave the form
    // (or the verdict) out of sight after switching.
    el.scroll.scrollTop = 0
  }

  function hideBanner() {
    if (el) el.banner.classList.remove('on')
  }

  function renderBusy() {
    if (!el) return
    el.submit.disabled = true
    el.submit.textContent = '评估中…'
    el.busyLine.classList.add('on')
    el.busyLabel.textContent = busy.label || '评估中…'
    el.busyDetail.textContent = busy.detail || ''
    var percent = busyPercent()
    el.progress.classList.add('on')
    el.progressFill.style.width = (percent === null ? 8 : Math.max(4, percent)) + '%'
    updateReviseButton()
    updateBall()
  }

  /** Back to a calm, non-running button state (form stays as-is). */
  function settle() {
    if (!el) return
    el.busyLine.classList.remove('on')
    el.progress.classList.remove('on')
    el.progressFill.style.width = '0%'
    el.busyLabel.textContent = ''
    el.busyDetail.textContent = ''
    updateSubmitState()
    updateReviseButton()
    updateBall()
  }

  function selectModels(value) {
    selectedModels = clamp(Math.round(Number(value) || 2), 1, modelCapacity())
    if (!el) return
    for (var index = 0; index < el.modelButtons.length; index += 1) {
      var button = el.modelButtons[index]
      var active = Number(button.getAttribute('data-models')) === selectedModels
      toggleClass(button, 'on', active)
      button.setAttribute('aria-pressed', active ? 'true' : 'false')
    }
    updateModelsNote()
  }

  /* --------------------------------------------------------------- result UI */

  function sectionTitle(titleText, tagText) {
    var row = createNode('div', 'section-title')
    row.appendChild(createNode('span', '', titleText))
    if (tagText) row.appendChild(createNode('span', 'tag', tagText))
    return row
  }

  function buildMetrics(predicted) {
    var grid = createNode('div', 'grid')
    for (var index = 0; index < METRICS.length; index += 1) {
      var key = METRICS[index][0]
      var raw = predicted[key] && typeof predicted[key] === 'object' ? predicted[key] : {}
      var low = safeInt(raw.low)
      var mid = safeInt(raw.mid)
      var high = safeInt(raw.high)
      if (mid < low) mid = low
      if (high < mid) high = mid
      var cell = createNode('div', 'metric')
      cell.setAttribute('data-metric', key)
      cell.appendChild(createNode('div', 'metric-name', METRICS[index][1]))
      cell.appendChild(createNode('div', 'metric-mid', formatCount(mid)))
      cell.appendChild(createNode('div', 'metric-range', formatCount(low) + '–' + formatCount(high)))
      grid.appendChild(cell)
    }
    return grid
  }

  function buildMeta(predicted, currentReport) {
    var row = createNode('div', 'meta')
    var rate = percentText(predicted.engagementRate)
    if (rate) {
      var rateChip = createNode('span', 'chip')
      rateChip.appendChild(createNode('span', '', '互动率 '))
      rateChip.appendChild(createNode('b', '', rate))
      row.appendChild(rateChip)
    }
    var models = safeInt(currentReport.modelCount)
    if (models > 1) {
      var modelChip = createNode('span', 'chip')
      modelChip.appendChild(createNode('span', '', '模型 '))
      modelChip.appendChild(createNode('b', '', String(models)))
      modelChip.appendChild(createNode('span', '', ' 个交叉评估'))
      row.appendChild(modelChip)
    }
    return row
  }

  function buildSignals(signals) {
    var wrap = createNode('div', 'signals')
    for (var index = 0; index < signals.length && index < 6; index += 1) {
      var signal = signals[index] || {}
      var row = createNode('div', 'signal')
      row.setAttribute('data-tone', SIGNAL_TONES[String(signal.level || '')] || 'neutral')
      row.appendChild(createNode('span', 'signal-dot'))
      var body = createNode('div', 'signal-body')
      body.appendChild(createNode('span', 'signal-label', squash(signal.label) || '信号'))
      var note = squash(signal.note)
      if (note) body.appendChild(createNode('span', 'signal-note', note))
      row.appendChild(body)
      wrap.appendChild(row)
    }
    return wrap
  }

  function buildDirections(directions) {
    var wrap = createNode('div', 'directions')
    for (var index = 0; index < directions.length && index < 5; index += 1) {
      var item = directions[index] || {}
      var card = createNode('div', 'direction')
      var title = createNode('div', 'direction-title')
      title.appendChild(createNode('span', 'arrow', '↗'))
      title.appendChild(createNode('span', '', squash(item.title) || '优化方向 ' + (index + 1)))
      card.appendChild(title)
      var why = squash(item.why)
      if (why) {
        var whyRow = createNode('div', 'direction-why')
        whyRow.appendChild(createNode('span', 'direction-key', '为什么'))
        whyRow.appendChild(createNode('span', '', why))
        card.appendChild(whyRow)
      }
      var action = squash(item.action)
      if (action) {
        var actionRow = createNode('div', 'direction-action')
        actionRow.appendChild(createNode('span', 'direction-key', '方向'))
        actionRow.appendChild(createNode('span', '', action))
        card.appendChild(actionRow)
      }
      wrap.appendChild(card)
    }
    return wrap
  }

  /**
   * Directions block: promoted to the top (with an explicit "no ghostwriting"
   * tag) for weak/poor verdicts, otherwise folded into an optional panel.
   */
  function buildDirectionsSection(directions, primary) {
    if (primary) {
      var section = createNode('div', 'dir-section')
      section.appendChild(sectionTitle('调整方向', '只给方向 · 不代写'))
      section.appendChild(buildDirections(directions))
      return section
    }
    var details = createNode('details', 'optional')
    var summary = createNode('summary')
    summary.appendChild(createNode('span', '', '可选优化（' + directions.length + '）'))
    summary.appendChild(createNode('span', 'chev', '›'))
    details.appendChild(summary)
    var inner = createNode('div', 'optional-inner')
    inner.appendChild(buildDirections(directions))
    details.appendChild(inner)
    return details
  }

  /* -------------------------------------------------- 修改指引 (guide) block */

  /** Canonical section key from a key/name, tolerating Chinese synonyms. */
  function guideKeyOf(value) {
    var raw = squash(value)
    if (raw === '') return ''
    var lower = raw.toLowerCase()
    return GUIDE_ALIASES[lower] || GUIDE_ALIASES[raw] || ''
  }

  /** Fold one host/model section (object, or a bare advice string) into `byKey`. */
  function absorbGuideSection(entry, fallbackKey, byKey) {
    if (entry === null || entry === undefined) return
    if (typeof entry === 'string') {
      var stringKey = guideKeyOf(fallbackKey)
      var stringAdvice = squash(entry)
      if (stringKey === '' || stringAdvice === '' || byKey[stringKey]) return
      byKey[stringKey] = { key: stringKey, name: GUIDE_NAMES[stringKey], advice: stringAdvice, example: '' }
      return
    }
    if (typeof entry !== 'object') return
    var rawKey = entry.key
    if (rawKey === null || rawKey === undefined || rawKey === '') rawKey = entry.name
    if (rawKey === null || rawKey === undefined || rawKey === '') rawKey = fallbackKey
    var key = guideKeyOf(rawKey)
    if (key === '' || byKey[key]) return
    var advice = squash(entry.advice)
    if (advice === '') return
    byKey[key] = {
      key: key,
      name: GUIDE_NAMES[key],
      advice: advice,
      example: squash(entry.example),
    }
  }

  /**
   * Normalise every plausible host shape into the fixed five-row view model:
   * canonical `{intro, sections:[...]}`, a bare section array, or a keyed object
   * (JSON or Chinese keys). Returns null when nothing renderable is left, which
   * hides the block entirely.
   */
  function normalizeGuide(raw) {
    if (raw === null || raw === undefined || typeof raw !== 'object') return null
    var intro = ''
    var list = null
    if (Array.isArray(raw)) {
      list = raw
    } else {
      intro = squash(raw.intro)
      list = raw.sections
      if (list === null || list === undefined) {
        // Some hosts hand over `{标题:{...}, 封面:{...}}` without the wrapper.
        var keyed = {}
        var hasKeyed = false
        for (var name in raw) {
          if (!Object.prototype.hasOwnProperty.call(raw, name) || name === 'intro') continue
          if (guideKeyOf(name) === '') continue
          keyed[name] = raw[name]
          hasKeyed = true
        }
        list = hasKeyed ? keyed : null
      }
    }
    if (list === null || list === undefined) return null
    var byKey = {}
    if (Array.isArray(list)) {
      for (var index = 0; index < list.length; index += 1) {
        absorbGuideSection(list[index], '', byKey)
      }
    } else if (typeof list === 'object') {
      for (var sectionName in list) {
        if (!Object.prototype.hasOwnProperty.call(list, sectionName)) continue
        absorbGuideSection(list[sectionName], sectionName, byKey)
      }
    }
    var sections = []
    for (var order = 0; order < GUIDE_ORDER.length; order += 1) {
      var canonicalKey = GUIDE_ORDER[order]
      if (byKey[canonicalKey]) sections.push(byKey[canonicalKey])
    }
    if (sections.length === 0) return null
    return { intro: intro, sections: sections }
  }

  /** Render the 修改指引 block: intro + five fixed rows with optional examples. */
  function buildGuide(guide) {
    var block = createNode('div', 'guide')
    block.setAttribute('data-role', 'guide')
    block.appendChild(sectionTitle('修改指引', '结合评估结果'))
    if (guide.intro) block.appendChild(createNode('div', 'guide-intro', guide.intro))
    var list = createNode('div', 'guide-list')
    for (var index = 0; index < guide.sections.length; index += 1) {
      var section = guide.sections[index]
      var row = createNode('div', 'guide-row')
      row.setAttribute('data-guide', section.key)
      row.appendChild(createNode('span', 'guide-name', section.name))
      var body = createNode('span', 'guide-body')
      body.appendChild(createNode('span', 'guide-advice', section.advice))
      if (section.example) {
        body.appendChild(createNode('span', 'guide-example', '（例：' + section.example + '）'))
      }
      row.appendChild(body)
      list.appendChild(row)
    }
    block.appendChild(list)
    return block
  }

  /** Rebuild the whole result view from the frozen Report shape (total). */
  function renderResult() {
    if (!el) return
    clearChildren(el.result)
    var currentReport = report && typeof report === 'object' ? report : {}
    var predicted = currentReport.predicted && typeof currentReport.predicted === 'object'
      ? currentReport.predicted
      : {}
    var verdict = String(currentReport.verdict || '')
    var tone = VERDICT_TONES[verdict] || 'neutral'
    var label = squash(currentReport.verdictLabel) || VERDICT_LABELS[verdict] || '评估结果'
    var confidence = confidenceText(currentReport.confidence)

    var band = createNode('div', 'verdict')
    band.setAttribute('data-tone', tone)
    var bandTop = createNode('div', 'verdict-top')
    bandTop.appendChild(createNode('span', 'verdict-label', label))
    if (confidence) bandTop.appendChild(createNode('span', 'verdict-conf', '置信度 ' + confidence))
    band.appendChild(bandTop)
    el.result.appendChild(band)

    var directions = Array.isArray(currentReport.directions) ? currentReport.directions : []
    var weak = verdict === 'weak' || verdict === 'poor'
    if (weak && directions.length > 0) el.result.appendChild(buildDirectionsSection(directions, true))

    el.result.appendChild(sectionTitle('预测数据'))
    el.result.appendChild(buildMetrics(predicted))
    el.result.appendChild(buildMeta(predicted, currentReport))

    var summary = squash(currentReport.summary)
    if (summary) el.result.appendChild(createNode('div', 'summary', summary))

    var signals = Array.isArray(currentReport.signals) ? currentReport.signals : []
    if (signals.length > 0) {
      el.result.appendChild(sectionTitle('内容信号'))
      el.result.appendChild(buildSignals(signals))
    }

    // 修改指引: after the signals (and after the weak-verdict directions block),
    // before the optional-directions fold and the footnote.
    var guide = normalizeGuide(currentReport.guide)
    if (guide) el.result.appendChild(buildGuide(guide))

    if (!weak && directions.length > 0) el.result.appendChild(buildDirectionsSection(directions, false))

    el.result.appendChild(createNode(
      'div',
      'footnote',
      '预测为模型估算，仅供发布前参考；优化建议只给思路，不代写内容。',
    ))
  }

  /* ------------------------------------------------------------- panel layout */

  function applyPos() {
    if (!el) return
    if (pos) {
      setImportant(el.ball, 'left', pos.left + 'px')
      setImportant(el.ball, 'top', pos.top + 'px')
      setImportant(el.ball, 'right', 'auto')
      setImportant(el.ball, 'bottom', 'auto')
    } else {
      try {
        el.ball.style.removeProperty('left')
        el.ball.style.removeProperty('top')
      } catch (error) {
        /* Ignore. */
      }
      if (homePos.side === 'right') {
        setImportant(el.ball, 'left', 'auto')
        setImportant(el.ball, 'right', '18px')
      } else {
        setImportant(el.ball, 'right', 'auto')
        setImportant(el.ball, 'left', '18px')
      }
      setImportant(el.ball, 'top', 'auto')
      setImportant(el.ball, 'bottom', homePos.bottom + 'px')
    }
  }

  /** Anchor the panel above the ball, clamped into the viewport. */
  function positionPanel() {
    if (!el || !open) return
    var viewportWidth = window.innerWidth || 1024
    var viewportHeight = window.innerHeight || 768
    var rect = el.ball.getBoundingClientRect()
    var ballWidth = rect.width || 56
    var ballHeight = rect.height || 56
    var ballLeft = rect.width || rect.height ? rect.left : (pos ? pos.left : viewportWidth - 18 - 56)
    var ballTop = rect.width || rect.height ? rect.top : (pos ? pos.top : viewportHeight - 18 - 56)
    var panelWidth = Math.min(360, Math.max(240, viewportWidth - 24))
    var panelHeight = el.panel.offsetHeight || (el.panel.getBoundingClientRect ? el.panel.getBoundingClientRect().height : 0) || 0

    var left = clamp(ballLeft + ballWidth - panelWidth, 12, Math.max(12, viewportWidth - panelWidth - 12))
    var top = ballTop - panelHeight - 12
    if (top < 12 || ballTop < panelHeight + 24) top = ballTop + ballHeight + 12
    top = clamp(top, 12, Math.max(12, viewportHeight - 12 - panelHeight))

    setImportant(el.panel, 'right', 'auto')
    setImportant(el.panel, 'bottom', 'auto')
    setImportant(el.panel, 'left', left + 'px')
    setImportant(el.panel, 'top', top + 'px')
  }

  function openPanel() {
    if (!el || destroyed) return
    open = true
    closedByUser = false
    el.panel.style.display = 'flex'
    el.ball.setAttribute('aria-expanded', 'true')
    positionPanel()
    later(positionPanel, 0)
    updateBall()
  }

  function closePanel() {
    if (!el || destroyed) return
    open = false
    closedByUser = true
    el.panel.style.display = 'none'
    el.ball.setAttribute('aria-expanded', 'false')
    updateBall()
  }

  function togglePanel() {
    if (destroyed || !el) return false
    if (open) closePanel()
    else openPanel()
    return open
  }

  /* -------------------------------------------------------------- interactions */

  function onFieldInput() {
    updateCounters()
    updateSubmitState()
  }

  function submitDraft() {
    if (!el || destroyed || phase === 'busy') return
    var input = readValues()
    if (input.body === '') {
      try {
        el.body.focus()
      } catch (error) {
        /* Ignore. */
      }
      return
    }
    lastInput = input
    lastIntent = 'evaluate'
    pending = { kind: 'evaluate', input: input }
    hideBanner()
    phase = 'busy'
    busy = { label: '评估中…', detail: '' }
    renderBusy()
    armWatchdog()
  }

  var watchdog = { hint: null, timeout: null }

  function clearWatchdog() {
    if (watchdog.hint !== null) {
      try {
        window.clearTimeout(watchdog.hint)
      } catch (error) {
        /* Ignore. */
      }
      removeTimer(watchdog.hint)
      watchdog.hint = null
    }
    if (watchdog.timeout !== null) {
      try {
        window.clearTimeout(watchdog.timeout)
      } catch (error) {
        /* Ignore. */
      }
      removeTimer(watchdog.timeout)
      watchdog.timeout = null
    }
  }

  /** Friendly, non-blocking progress hints while the host works. */
  function armWatchdog() {
    clearWatchdog()
    watchdog.hint = later(function () {
      if (phase !== 'busy' || !el) return
      if (!el.busyDetail.textContent) el.busyDetail.textContent = '正在等待 DSH 宿主响应…'
    }, 9000)
    watchdog.timeout = later(function () {
      if (phase !== 'busy') return
      showError('评估超时：没有收到 DSH 宿主的响应。请确认插件已启用后重试。')
    }, 50000)
  }

  function retryEvaluation() {
    if (!el || destroyed) return
    hideBanner()
    clearWatchdog()
    if (lastInput) {
      var kind = lastIntent === 'revise' ? 'revise' : 'evaluate'
      pending = { kind: kind, input: lastInput }
      phase = 'busy'
      busy = { label: kind === 'revise' ? '整改中…' : '评估中…', detail: '' }
      // A failed evaluation retry belongs in the form; a failed revision retry
      // keeps the result view (the report is still in memory).
      if (kind === 'evaluate') setView('form')
      renderBusy()
      armWatchdog()
      return
    }
    phase = 'idle'
    setView('form')
    settle()
    try {
      el.body.focus()
    } catch (error) {
      /* Ignore. */
    }
  }

  function backToForm() {
    if (!el || destroyed) return
    hideBanner()
    clearWatchdog()
    phase = 'idle'
    busy = { label: '', detail: '' }
    setView('form')
    settle()
    try {
      el.scroll.scrollTop = 0
      el.body.focus()
    } catch (error) {
      /* Ignore detached or unfocusable editors. */
    }
    later(positionPanel, 0)
  }

  /* --------------------------------------------------------- 整改稿 (revision) */

  /** Trim + normalise hard line breaks, keeping the interior newlines of a body. */
  function multiline(value) {
    return String(value == null ? '' : value).replace(/\r\n?/g, '\n').replace(/^\s+|\s+$/g, '')
  }

  /** Total fallback for the Revision JSON: never empty, honours the input limits. */
  function normalizeRevision(raw) {
    var source = raw && typeof raw === 'object' ? raw : {}
    var draft = lastInput || readValues()
    var rawTags = Array.isArray(source.tags) ? source.tags : parseTags(source.tags)
    var tags = []
    for (var index = 0; index < rawTags.length && tags.length < LIMITS.tags; index += 1) {
      var tag = squash(rawTags[index]).replace(/^#+/, '')
      if (tag !== '' && tags.indexOf(tag) === -1) tags.push(tag)
    }
    var draftTags = Array.isArray(draft.tags) ? draft.tags : parseTags(draft.tags)
    var title = squash(source.title) || squash(draft.title)
    var body = multiline(source.body) || multiline(draft.body)
    return {
      title: title.slice(0, LIMITS.title),
      body: body.slice(0, LIMITS.body),
      tags: (tags.length > 0 ? tags : draftTags).slice(0, LIMITS.tags),
      cover: squash(source.cover),
      images: squash(source.images),
      summary: squash(source.summary),
    }
  }

  /** 一键整改 shows 整改中… and stays disabled while the host revises. */
  function updateReviseButton() {
    if (!el || !el.revise) return
    var revising = phase === 'busy' && lastIntent === 'revise'
    el.revise.disabled = revising
    el.revise.textContent = revising ? '整改中…' : '一键整改'
  }

  function buildRevisionMeta(key, label, value) {
    var row = createNode('div', 'revise-meta-row')
    row.setAttribute('data-revise', key)
    row.appendChild(createNode('span', 'revise-meta-key', label))
    var text = createNode('span', 'revise-meta-value', value)
    text.setAttribute('data-role', 'revise-' + key)
    row.appendChild(text)
    return row
  }

  /** Paint the read-only 整改稿 view from the normalised Revision. */
  function renderRevision() {
    if (!el || !el.reviseView || !revisionDraft) return
    clearChildren(el.reviseView)
    var draft = revisionDraft

    var head = createNode('div', 'revise-head')
    head.appendChild(createNode('span', 'revise-tag', '整改稿'))
    if (draft.summary) head.appendChild(createNode('p', 'revise-summary', draft.summary))
    el.reviseView.appendChild(head)

    var titleBlock = createNode('div', 'revise-block')
    var titleLabel = createNode('div', 'revise-label')
    titleLabel.appendChild(createNode('span', '', '标题'))
    titleLabel.appendChild(createNode('span', 'revise-count', draft.title.length + '/' + LIMITS.title))
    titleBlock.appendChild(titleLabel)
    var titleValue = createNode('div', 'revise-value')
    titleValue.setAttribute('data-role', 'revise-title')
    titleValue.textContent = draft.title
    titleBlock.appendChild(titleValue)
    el.reviseView.appendChild(titleBlock)

    var bodyBlock = createNode('div', 'revise-block')
    var bodyLabel = createNode('div', 'revise-label')
    bodyLabel.appendChild(createNode('span', '', '正文'))
    bodyLabel.appendChild(createNode('span', 'revise-count', draft.body.length + '/' + LIMITS.body))
    bodyBlock.appendChild(bodyLabel)
    var bodyValue = createNode('div', 'revise-value revise-body')
    bodyValue.setAttribute('data-role', 'revise-body')
    bodyValue.textContent = draft.body
    bodyBlock.appendChild(bodyValue)
    el.reviseView.appendChild(bodyBlock)

    var tagsBlock = createNode('div', 'revise-block')
    var tagsLabel = createNode('div', 'revise-label')
    tagsLabel.appendChild(createNode('span', '', '标签'))
    tagsBlock.appendChild(tagsLabel)
    var tagsValue = createNode('div', 'revise-tags')
    tagsValue.setAttribute('data-role', 'revise-tags')
    if (draft.tags.length > 0) {
      for (var tagIndex = 0; tagIndex < draft.tags.length; tagIndex += 1) {
        tagsValue.appendChild(createNode('span', 'revise-tag-item', '#' + draft.tags[tagIndex]))
      }
    } else {
      tagsValue.appendChild(createNode('span', 'revise-count', '—'))
    }
    tagsBlock.appendChild(tagsValue)
    el.reviseView.appendChild(tagsBlock)

    var meta = createNode('div', 'revise-meta')
    meta.appendChild(buildRevisionMeta('cover', '封面大字', draft.cover || '—'))
    meta.appendChild(buildRevisionMeta('images', '内部图建议', draft.images || '—'))
    el.reviseView.appendChild(meta)

    el.reviseView.appendChild(createNode(
      'div',
      'revise-hint',
      '整改稿由模型生成，请按需修改后再评估',
    ))
  }

  /** Plain-text revision used by 复制整改稿. */
  function buildRevisionText() {
    if (!revisionDraft) return ''
    var draft = revisionDraft
    var lines = ['整改稿（模型生成，请按需修改）']
    if (draft.summary) lines.push(draft.summary)
    lines.push('', '标题：' + draft.title, '', '正文：', draft.body, '')
    lines.push('标签：' + (draft.tags.length > 0
      ? draft.tags.map(function (tag) { return '#' + tag }).join(' ')
      : '—'))
    lines.push('封面大字：' + (draft.cover || '—'))
    lines.push('内部图建议：' + (draft.images || '—'))
    return lines.join('\n')
  }

  /**
   * 一键整改: publish a revise request for the evaluated draft. While the host
   * works the button reads 整改中… and the ball shows progress; the panel stays on
   * the result view until `revision()` lands.
   */
  function requestRevision() {
    if (!el || destroyed || phase === 'busy') return
    var draft = lastInput || readValues()
    if (squash(draft.body) === '') {
      setView('form')
      try {
        el.body.focus()
      } catch (error) {
        /* Ignore. */
      }
      return
    }
    lastInput = draft
    lastIntent = 'revise'
    pending = { kind: 'revise', input: draft }
    hideBanner()
    phase = 'busy'
    busy = { label: '整改中…', detail: '' }
    renderBusy()
    armWatchdog()
  }

  /** 用这份稿子: fill the form from the revision (limits enforced), no auto-run. */
  function useRevisionDraft() {
    if (!el || destroyed || !revisionDraft) return
    var draft = revisionDraft
    var fallback = lastInput || readValues()
    var fallbackTags = Array.isArray(fallback.tags) ? fallback.tags : parseTags(fallback.tags)
    el.title.value = squash(draft.title || fallback.title).slice(0, LIMITS.title)
    el.body.value = multiline(draft.body || fallback.body).slice(0, LIMITS.body)
    el.tags.value = (draft.tags.length > 0 ? draft.tags : fallbackTags).slice(0, LIMITS.tags).join(' ')
    hideBanner()
    clearWatchdog()
    phase = 'idle'
    busy = { label: '', detail: '' }
    setView('form')
    updateCounters()
    settle()
    try {
      el.scroll.scrollTop = 0
      el.body.focus()
    } catch (error) {
      /* Ignore detached or unfocusable editors. */
    }
    later(positionPanel, 0)
  }

  /** 返回评估结果: back to the report that is still in memory. */
  function backToResult() {
    if (!el || destroyed) return
    hideBanner()
    clearWatchdog()
    phase = report ? 'done' : 'idle'
    busy = { label: '', detail: '' }
    setView('result')
    settle()
    later(positionPanel, 0)
  }

  function buildReportText() {
    var currentReport = report && typeof report === 'object' ? report : null
    if (!currentReport) return ''
    var predicted = currentReport.predicted && typeof currentReport.predicted === 'object'
      ? currentReport.predicted
      : {}
    var label = squash(currentReport.verdictLabel) || VERDICT_LABELS[String(currentReport.verdict || '')] || '评估结果'
    var confidence = confidenceText(currentReport.confidence)
    var lines = ['小红书笔记评估', '判定：' + label + (confidence ? ' · 置信度 ' + confidence : '')]
    for (var index = 0; index < METRICS.length; index += 1) {
      var key = METRICS[index][0]
      var range = predicted[key] && typeof predicted[key] === 'object' ? predicted[key] : {}
      lines.push('预测' + METRICS[index][1] + '：' + formatCount(safeInt(range.low)) + '–' + formatCount(safeInt(range.high)) + '（中位 ' + formatCount(safeInt(range.mid)) + '）')
    }
    var rate = percentText(predicted.engagementRate)
    if (rate) lines.push('互动率：' + rate)
    var models = safeInt(currentReport.modelCount)
    if (models > 1) lines.push('模型：' + models + ' 个交叉评估')
    var summary = squash(currentReport.summary)
    if (summary) lines.push('结论：' + summary)
    var signals = Array.isArray(currentReport.signals) ? currentReport.signals : []
    if (signals.length > 0) {
      lines.push('', '内容信号：')
      for (var signalIndex = 0; signalIndex < signals.length && signalIndex < 6; signalIndex += 1) {
        var signal = signals[signalIndex] || {}
        lines.push('- ' + squash(signal.label) + '（' + (squash(signal.level) || '未知') + '）' + (squash(signal.note) ? '：' + squash(signal.note) : ''))
      }
    }
    var directions = Array.isArray(currentReport.directions) ? currentReport.directions : []
    if (directions.length > 0) {
      lines.push('', '优化方向（只给方向，不代写）：')
      for (var directionIndex = 0; directionIndex < directions.length && directionIndex < 5; directionIndex += 1) {
        var direction = directions[directionIndex] || {}
        lines.push((directionIndex + 1) + '. ' + squash(direction.title))
        if (squash(direction.why)) lines.push('   为什么：' + squash(direction.why))
        if (squash(direction.action)) lines.push('   方向：' + squash(direction.action))
      }
    }
    var guide = normalizeGuide(currentReport.guide)
    if (guide) {
      lines.push('', '修改指引（结合评估结果）：')
      if (guide.intro) lines.push(guide.intro)
      for (var guideIndex = 0; guideIndex < guide.sections.length; guideIndex += 1) {
        var guideSection = guide.sections[guideIndex]
        lines.push('- ' + guideSection.name + '：' + guideSection.advice + (guideSection.example ? '（例：' + guideSection.example + '）' : ''))
      }
    }
    lines.push('', '预测为模型估算，仅供参考；调整方向不代写内容。')
    return lines.join('\n')
  }

  /** Shared clipboard write: navigator.clipboard first, execCommand fallback. */
  function writeClipboard(value, finish) {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        var promise = navigator.clipboard.writeText(value)
        if (promise && typeof promise.then === 'function') {
          promise.then(function () { finish(true) }, function () { finish(fallbackCopy(value)) })
          return
        }
        finish(true)
        return
      }
    } catch (error) {
      /* Fall through to the execCommand path. */
    }
    finish(fallbackCopy(value))
  }

  /** Momentary 已复制 / 复制失败 label on a footer button. */
  function copyFeedback(button, baseText, ok) {
    if (!el || !button) return
    button.textContent = ok ? '已复制' : '复制失败'
    later(function () {
      if (el) button.textContent = baseText
    }, 1500)
  }

  function copyReport() {
    if (!el || destroyed) return
    var value = buildReportText()
    if (value === '') return
    writeClipboard(value, function (ok) {
      copyFeedback(el.copy, '复制报告', ok)
    })
  }

  function copyRevisionDraft() {
    if (!el || destroyed) return
    var value = buildRevisionText()
    if (value === '') return
    writeClipboard(value, function (ok) {
      copyFeedback(el.copyRevision, '复制整改稿', ok)
    })
  }

  function fallbackCopy(value) {
    var area = null
    try {
      area = document.createElement('textarea')
      area.value = value
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.left = '-9999px'
      area.style.top = '0'
      area.style.opacity = '0'
      // Keep the page DOM untouched: the scratch node lives in our shadow root.
      var scope = el && el.shadow ? el.shadow : document.body
      ;(scope || document.body || document.documentElement).appendChild(area)
      area.select()
      var copied = false
      try {
        copied = typeof document.execCommand === 'function' ? document.execCommand('copy') : false
      } catch (error) {
        copied = false
      }
      return copied
    } catch (error) {
      return false
    } finally {
      if (area && area.parentNode) {
        try {
          area.parentNode.removeChild(area)
        } catch (error) {
          /* Ignore. */
        }
      }
    }
  }

  /* ------------------------------------------------------------------ pointer */

  function onPointerDown(event) {
    if (destroyed || !el || drag) return
    if (typeof event.button === 'number' && event.button !== 0 && event.pointerType === 'mouse') return
    var rect = el.ball.getBoundingClientRect()
    var width = rect.width || 56
    var height = rect.height || 56
    var left
    var top
    if (pos) {
      left = pos.left
      top = pos.top
    } else if (rect.width || rect.height) {
      left = rect.left
      top = rect.top
    } else {
      left = (window.innerWidth || 1024) - 18 - width
      top = (window.innerHeight || 768) - 18 - height
    }
    drag = {
      startX: Number(event.clientX) || 0,
      startY: Number(event.clientY) || 0,
      originLeft: left,
      originTop: top,
      moved: false,
      width: width,
      height: height,
    }
    try {
      if (typeof el.ball.setPointerCapture === 'function' && event.pointerId !== undefined) {
        el.ball.setPointerCapture(event.pointerId)
      }
    } catch (error) {
      /* jsdom / older engines have no pointer capture. */
    }
  }

  function onPointerMove(event) {
    if (!drag || destroyed || !el) return
    var deltaX = (Number(event.clientX) || 0) - drag.startX
    var deltaY = (Number(event.clientY) || 0) - drag.startY
    if (!drag.moved && Math.abs(deltaX) + Math.abs(deltaY) < 4) return
    drag.moved = true
    var viewportWidth = window.innerWidth || 1024
    var viewportHeight = window.innerHeight || 768
    pos = {
      left: clamp(drag.originLeft + deltaX, 8, Math.max(8, viewportWidth - drag.width - 8)),
      top: clamp(drag.originTop + deltaY, 8, Math.max(8, viewportHeight - drag.height - 8)),
    }
    applyPos()
    if (open) positionPanel()
    if (event.cancelable) event.preventDefault()
  }

  function onPointerUp(event) {
    if (!drag) return
    var moved = drag.moved
    drag = null
    suppressClickUntil = Date.now() + 320
    try {
      if (el && typeof el.ball.releasePointerCapture === 'function' && event.pointerId !== undefined) {
        el.ball.releasePointerCapture(event.pointerId)
      }
    } catch (error) {
      /* Ignore. */
    }
    if (!moved && event.type !== 'pointercancel') togglePanel()
  }

  function onBallClick() {
    if (destroyed) return
    if (Date.now() < suppressClickUntil) return
    togglePanel()
  }

  function onDocumentKeyDown(event) {
    if (!open || destroyed) return
    if (event.key !== 'Escape' && event.key !== 'Esc' && event.keyCode !== 27) return
    if (event.cancelable) event.preventDefault()
    if (typeof event.stopPropagation === 'function') event.stopPropagation()
    closePanel()
  }

  function onWindowResize() {
    if (!el || !pos) return
    var viewportWidth = window.innerWidth || 1024
    var viewportHeight = window.innerHeight || 768
    pos.left = clamp(pos.left, 8, Math.max(8, viewportWidth - 56 - 8))
    pos.top = clamp(pos.top, 8, Math.max(8, viewportHeight - 56 - 8))
    applyPos()
    if (open) positionPanel()
  }

  /* ------------------------------------------------------------------ build UI */

  function buildBall() {
    var ball = createButton('ball')
    ball.id = 'dsh-xhs-ball'
    ball.setAttribute('data-role', 'ball')
    ball.setAttribute('data-phase', 'idle')
    ball.setAttribute('aria-label', '打开小红书笔记评估')
    ball.setAttribute('aria-expanded', 'false')
    pinStyles(ball, {
      position: 'fixed',
      right: '18px',
      bottom: '18px',
      width: '56px',
      height: '56px',
      margin: '0',
      padding: '0',
      border: '0',
      borderRadius: '50%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'linear-gradient(135deg, #ff5a6e 0%, #ff2442 52%, #e8112d 100%)',
      color: '#ffffff',
      boxShadow: '0 8px 22px rgba(255, 36, 66, .38), 0 2px 6px rgba(0, 0, 0, .16)',
      zIndex: '2147483000',
      cursor: 'pointer',
      touchAction: 'none',
      userSelect: 'none',
    })
    var icon = createIcon()
    var spinner = createNode('span', 'spinner')
    spinner.setAttribute('data-role', 'ball-spinner')
    var badge = createNode('span', 'badge')
    badge.setAttribute('data-role', 'ball-badge')
    var dot = createNode('span', 'dot')
    dot.setAttribute('data-role', 'ball-dot')
    ball.appendChild(icon)
    ball.appendChild(spinner)
    ball.appendChild(badge)
    ball.appendChild(dot)
    listen(ball, 'pointerdown', onPointerDown)
    listen(ball, 'click', onBallClick)
    return { ball: ball, icon: icon, spinner: spinner, badge: badge, dot: dot }
  }

  function buildField(labelText, control, counter, required) {
    var field = createNode('div', 'field')
    var label = createNode('div', 'label')
    var name = createNode('span', 'label-name', labelText)
    if (required) name.appendChild(createNode('span', 'req', '*'))
    label.appendChild(name)
    if (counter) label.appendChild(counter)
    field.appendChild(label)
    field.appendChild(control)
    return field
  }

  function buildFormView() {
    var form = createNode('div', 'form')
    form.setAttribute('data-role', 'form')

    var title = document.createElement('input')
    title.type = 'text'
    title.className = 'input'
    title.maxLength = LIMITS.title
    title.placeholder = '例如：租房改造｜10㎡ 小卧室也能很松弛'
    title.setAttribute('data-role', 'title')
    title.setAttribute('aria-label', '笔记标题')
    var titleCount = createNode('span', 'count', '0/' + LIMITS.title)
    titleCount.setAttribute('data-role', 'title-count')
    form.appendChild(buildField('标题', title, titleCount, false))

    var body = document.createElement('textarea')
    body.className = 'textarea'
    body.rows = 6
    body.maxLength = LIMITS.body
    body.placeholder = '把你想发布的正文贴进来…（必填）'
    body.setAttribute('data-role', 'body')
    body.setAttribute('aria-label', '笔记正文')
    var bodyCount = createNode('span', 'count', '0/' + LIMITS.body)
    bodyCount.setAttribute('data-role', 'body-count')
    form.appendChild(buildField('正文', body, bodyCount, true))

    var tags = document.createElement('input')
    tags.type = 'text'
    tags.className = 'input'
    tags.maxLength = 200
    tags.placeholder = '用空格或逗号分隔，最多 10 个'
    tags.setAttribute('data-role', 'tags')
    tags.setAttribute('aria-label', '话题标签')
    var tagsField = buildField('话题标签', tags, null, false)
    tagsField.appendChild(createNode('div', 'hint', '最多 10 个，开头的 # 会自动去掉'))
    form.appendChild(tagsField)

    var row = createNode('div', 'row2')
    var niche = document.createElement('select')
    niche.className = 'select'
    niche.setAttribute('data-role', 'niche')
    niche.setAttribute('aria-label', '账号赛道')
    for (var nicheIndex = 0; nicheIndex < NICHES.length; nicheIndex += 1) {
      var nicheOption = document.createElement('option')
      nicheOption.value = NICHES[nicheIndex]
      nicheOption.textContent = NICHES[nicheIndex]
      niche.appendChild(nicheOption)
    }
    row.appendChild(buildField('账号赛道', niche, null, false))

    var fans = document.createElement('select')
    fans.className = 'select'
    fans.setAttribute('data-role', 'fans')
    fans.setAttribute('aria-label', '粉丝量级')
    for (var fansIndex = 0; fansIndex < FANS.length; fansIndex += 1) {
      var fansOption = document.createElement('option')
      fansOption.value = FANS[fansIndex][0]
      fansOption.textContent = FANS[fansIndex][1]
      fans.appendChild(fansOption)
    }
    row.appendChild(buildField('粉丝量级', fans, null, false))
    form.appendChild(row)

    var modelsField = createNode('div', 'field')
    var modelsLabel = createNode('div', 'label')
    modelsLabel.appendChild(createNode('span', 'label-name', '评估模型数'))
    modelsField.appendChild(modelsLabel)
    var models = createNode('div', 'models')
    var modelButtons = []
    for (var modelIndex = 1; modelIndex <= 3; modelIndex += 1) {
      var modelButton = createButton('model', String(modelIndex))
      modelButton.setAttribute('data-role', 'model-' + modelIndex)
      modelButton.setAttribute('data-models', String(modelIndex))
      modelButton.setAttribute('aria-pressed', 'false')
      modelButtons.push(modelButton)
      models.appendChild(modelButton)
      ;(function (value) {
        listen(modelButton, 'click', function () { selectModels(value) })
      })(modelIndex)
    }
    modelsField.appendChild(models)
    var modelsNote = createNode('div', 'models-note', '')
    modelsNote.setAttribute('data-role', 'models-note')
    modelsField.appendChild(modelsNote)
    form.appendChild(modelsField)

    var submit = createButton('submit', '开始评估')
    submit.setAttribute('data-role', 'submit')
    form.appendChild(submit)
    form.appendChild(createNode('div', 'note', '只给调整方向，不代写内容'))

    var busyLine = createNode('div', 'busy')
    busyLine.setAttribute('data-role', 'busy')
    busyLine.appendChild(createNode('span', 'spin'))
    var busyLabel = createNode('span', 'busy-label', '')
    busyLabel.setAttribute('data-role', 'busy-label')
    var busyDetail = createNode('span', 'busy-detail', '')
    busyDetail.setAttribute('data-role', 'busy-detail')
    busyLine.appendChild(busyLabel)
    busyLine.appendChild(busyDetail)
    form.appendChild(busyLine)

    listen(title, 'input', onFieldInput)
    listen(body, 'input', onFieldInput)
    listen(tags, 'input', onFieldInput)
    listen(niche, 'change', onFieldInput)
    listen(fans, 'change', onFieldInput)
    listen(submit, 'click', submitDraft)

    return {
      form: form,
      title: title,
      body: body,
      tags: tags,
      niche: niche,
      fans: fans,
      titleCount: titleCount,
      bodyCount: bodyCount,
      modelsNote: modelsNote,
      modelButtons: modelButtons,
      submit: submit,
      busyLine: busyLine,
      busyLabel: busyLabel,
      busyDetail: busyDetail,
    }
  }

  function buildPanel() {
    var panel = createNode('div', 'panel')
    panel.id = 'dsh-xhs-panel'
    panel.setAttribute('data-role', 'panel')
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-label', '小红书笔记评估')
    pinStyles(panel, {
      position: 'fixed',
      right: '18px',
      bottom: '86px',
      width: 'min(360px, calc(100vw - 24px))',
      maxHeight: 'min(78vh, 640px)',
      flexDirection: 'column',
      overflow: 'hidden',
      borderRadius: '16px',
      background: '#ffffff',
      color: '#1f2329',
      border: '1px solid rgba(15, 23, 42, .06)',
      boxShadow: '0 20px 50px rgba(15, 23, 42, .22), 0 2px 10px rgba(15, 23, 42, .08)',
      zIndex: '2147483000',
      fontFamily: '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
      fontSize: '13px',
      lineHeight: '1.5',
      textAlign: 'left',
    })
    panel.style.display = 'none'

    var head = createNode('div', 'panel-head')
    var titleWrap = createNode('div', 'panel-title')
    titleWrap.appendChild(createNode('span', 'mark'))
    titleWrap.appendChild(createNode('span', '', '小红书笔记评估'))
    var close = createButton('close', '×')
    close.setAttribute('data-role', 'close')
    close.setAttribute('aria-label', '关闭评估面板')
    // In the result view the way back to editing is in the title bar, always in
    // reach — the footer sits below a long, scrollable report.
    var editTop = createButton('head-edit', '返回编辑')
    editTop.setAttribute('data-role', 'edit-top')
    editTop.setAttribute('aria-label', '返回编辑')
    editTop.setAttribute('title', '回到表单修改内容')
    var headActions = createNode('div', 'head-actions')
    headActions.appendChild(editTop)
    headActions.appendChild(close)
    head.appendChild(titleWrap)
    head.appendChild(headActions)
    panel.appendChild(head)

    var progress = createNode('div', 'progress')
    var progressFill = createNode('span', 'progress-fill')
    progress.appendChild(progressFill)
    panel.appendChild(progress)

    var banner = createNode('div', 'banner')
    banner.setAttribute('data-role', 'banner')
    var bannerRow = createNode('div', 'banner-row')
    var bannerMsg = createNode('span', 'banner-msg', '')
    bannerMsg.setAttribute('data-role', 'banner-msg')
    var retry = createButton('retry', '重试')
    retry.setAttribute('data-role', 'retry')
    bannerRow.appendChild(bannerMsg)
    bannerRow.appendChild(retry)
    banner.appendChild(bannerRow)
    banner.appendChild(createNode('div', 'banner-hint', '请确认 DSH 插件已启用；若持续失败，可稍后重试。'))
    panel.appendChild(banner)

    var scroll = createNode('div', 'scroll')
    pinStyles(scroll, { flex: '1 1 auto', minHeight: '0', overflowY: 'auto' })
    var formParts = buildFormView()
    scroll.appendChild(formParts.form)

    var result = createNode('div', 'result')
    result.setAttribute('data-role', 'result')
    result.style.display = 'none'
    scroll.appendChild(result)

    var reviseView = createNode('div', 'revise-view')
    reviseView.setAttribute('data-role', 'revise-view')
    reviseView.style.display = 'none'
    scroll.appendChild(reviseView)
    panel.appendChild(scroll)

    // Result footer: [返回编辑] [复制报告] [一键整改] — revise is the primary action.
    var foot = createNode('div', 'foot')
    foot.setAttribute('data-role', 'foot')
    var again = createButton('btn', '返回编辑')
    again.setAttribute('data-role', 're-eval')
    var copy = createButton('btn', '复制报告')
    copy.setAttribute('data-role', 'copy')
    var revise = createButton('btn btn-primary', '一键整改')
    revise.setAttribute('data-role', 'revise')
    revise.setAttribute('aria-label', '按本次评估结论一键整改内容')
    foot.appendChild(again)
    foot.appendChild(copy)
    foot.appendChild(revise)
    foot.style.display = 'none'
    panel.appendChild(foot)

    // Revision footer: [用这份稿子] [复制整改稿] [返回评估结果].
    var footRevise = createNode('div', 'foot foot-revise')
    footRevise.setAttribute('data-role', 'foot-revise')
    var useDraft = createButton('btn btn-primary', '用这份稿子')
    useDraft.setAttribute('data-role', 'use-draft')
    var copyRevision = createButton('btn', '复制整改稿')
    copyRevision.setAttribute('data-role', 'copy-revision')
    var backResult = createButton('btn', '返回评估结果')
    backResult.setAttribute('data-role', 'back-result')
    footRevise.appendChild(useDraft)
    footRevise.appendChild(copyRevision)
    footRevise.appendChild(backResult)
    footRevise.style.display = 'none'
    panel.appendChild(footRevise)

    listen(close, 'click', closePanel)
    listen(editTop, 'click', backToForm)
    listen(retry, 'click', retryEvaluation)
    listen(again, 'click', backToForm)
    listen(copy, 'click', copyReport)
    listen(revise, 'click', requestRevision)
    listen(useDraft, 'click', useRevisionDraft)
    listen(copyRevision, 'click', copyRevisionDraft)
    listen(backResult, 'click', backToResult)

    return {
      panel: panel,
      head: head,
      close: close,
      editTop: editTop,
      banner: banner,
      bannerMsg: bannerMsg,
      retry: retry,
      progress: progress,
      progressFill: progressFill,
      scroll: scroll,
      form: formParts.form,
      title: formParts.title,
      body: formParts.body,
      tags: formParts.tags,
      niche: formParts.niche,
      fans: formParts.fans,
      titleCount: formParts.titleCount,
      bodyCount: formParts.bodyCount,
      modelsNote: formParts.modelsNote,
      modelButtons: formParts.modelButtons,
      submit: formParts.submit,
      busyLine: formParts.busyLine,
      busyLabel: formParts.busyLabel,
      busyDetail: formParts.busyDetail,
      result: result,
      reviseView: reviseView,
      foot: foot,
      again: again,
      copy: copy,
      revise: revise,
      footRevise: footRevise,
      useDraft: useDraft,
      copyRevision: copyRevision,
      backResult: backResult,
    }
  }

  /* -------------------------------------------------------------- site gate */

  /**
   * Reduce a hostname, an `host:port` authority or a full URL to a bare
   * lower-case hostname without port, userinfo or trailing dots. Mirrors
   * `normalizeHostname` in lib/hosts.js (the jsdom suite asserts parity).
   * @param {unknown} value
   * @returns {string}
   */
  function normalizeHostname(value) {
    var text = String(value == null ? '' : value).trim().toLowerCase()
    if (text === '') return ''
    var scheme = text.indexOf('://')
    if (scheme >= 0) text = text.slice(scheme + 3)
    var cut = text.search(/[/?#]/)
    if (cut >= 0) text = text.slice(0, cut)
    var at = text.lastIndexOf('@')
    if (at >= 0) text = text.slice(at + 1)
    if (text.charAt(0) === '[') {
      var close = text.indexOf(']')
      return close >= 0 ? text.slice(0, close + 1) : text
    }
    var port = text.search(/:\d+$/)
    if (port >= 0) text = text.slice(0, port)
    return text.replace(/\.+$/, '')
  }

  /** Parse the hostname out of an http(s) URL; '' for anything else. */
  function urlHost(url) {
    var text = String(url == null ? '' : url).trim()
    if (text === '') return ''
    var scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text)
    if (scheme === null) return ''
    var protocol = scheme[1].toLowerCase()
    if (protocol !== 'http' && protocol !== 'https') return ''
    return normalizeHostname(text)
  }

  /** True for xiaohongshu.com and any subdomain; never a lookalike domain. */
  function isXhsHost(hostname) {
    var host = normalizeHostname(hostname)
    if (host === '') return false
    if (host === XHS_ROOT_DOMAIN) return true
    return host.length > XHS_ROOT_DOMAIN.length + 1 && host.slice(-(XHS_ROOT_DOMAIN.length + 1)) === '.' + XHS_ROOT_DOMAIN
  }

  /** The page URL, falling back to the URL the client injected us with. */
  function currentPageUrl() {
    var href = ''
    try {
      href = window.location && typeof window.location.href === 'string' ? window.location.href : ''
    } catch (error) {
      href = ''
    }
    if (urlHost(href) !== '') return href
    return injectedUrl
  }

  /**
   * 'allow' | 'block' | 'defer'. Defer means the document has no readable URL
   * yet (about:blank / initial blank page): wait for location or the injected
   * URL instead of permanently hiding the ball on a real XHS page.
   * @returns {string}
   */
  function pageGate() {
    var host = urlHost(currentPageUrl())
    if (host === '') return 'defer'
    if (allowAllHosts) return 'allow'
    return isXhsHost(host) ? 'allow' : 'block'
  }

  /** Re-check the deferred gate after the document gains a readable URL. */
  function retryMount() {
    if (destroyed || el) return
    if (pageGate() !== 'allow') return
    boot()
  }

  /** Wait for a readable URL once; the client's configure() also retries. */
  function armGateWaiters() {
    if (gateWaitersArmed || destroyed) return
    gateWaitersArmed = true
    listen(document, 'DOMContentLoaded', retryMount)
    listen(window, 'load', retryMount)
    listen(window, 'pageshow', retryMount)
    later(retryMount, 300)
    later(retryMount, 1200)
  }

  /**
   * The gate every mount path goes through. Returns true only when the current
   * page may render the ball; arms a one-shot retry when the URL is unknown.
   * @returns {boolean}
   */
  function canMount() {
    var decision = pageGate()
    if (decision === 'allow') return true
    if (decision === 'defer') armGateWaiters()
    return false
  }

  /** Mount the shadow host once; safe to call repeatedly. */
  function ensureUI() {
    if (destroyed) return null
    if (el) return el
    // Site gate first: a page outside the allowlist must never get a node.
    if (!canMount()) return null
    var parent = document.body || document.documentElement
    if (!parent) return null

    var host = document.createElement('div')
    host.id = 'dsh-xhs-host'
    host.setAttribute('data-dsh-xhs-host', '1')
    pinStyles(host, {
      all: 'initial',
      position: 'fixed',
      left: '0',
      top: '0',
      width: '0',
      height: '0',
      zIndex: '2147483000',
    })

    var shadow
    try {
      shadow = host.attachShadow({ mode: 'open' })
    } catch (error) {
      // Very old engines: fall back to a plain container (page CSS may leak in).
      shadow = host
    }
    var style = document.createElement('style')
    style.textContent = CSS
    shadow.appendChild(style)

    var ballParts = buildBall()
    var panelParts = buildPanel()
    shadow.appendChild(ballParts.ball)
    shadow.appendChild(panelParts.panel)

    el = {
      host: host,
      shadow: shadow,
      ball: ballParts.ball,
      icon: ballParts.icon,
      spinner: ballParts.spinner,
      badge: ballParts.badge,
      dot: ballParts.dot,
      panel: panelParts.panel,
      head: panelParts.head,
      close: panelParts.close,
      editTop: panelParts.editTop,
      banner: panelParts.banner,
      bannerMsg: panelParts.bannerMsg,
      retry: panelParts.retry,
      progress: panelParts.progress,
      progressFill: panelParts.progressFill,
      scroll: panelParts.scroll,
      form: panelParts.form,
      title: panelParts.title,
      body: panelParts.body,
      tags: panelParts.tags,
      niche: panelParts.niche,
      fans: panelParts.fans,
      titleCount: panelParts.titleCount,
      bodyCount: panelParts.bodyCount,
      modelsNote: panelParts.modelsNote,
      modelButtons: panelParts.modelButtons,
      submit: panelParts.submit,
      busyLine: panelParts.busyLine,
      busyLabel: panelParts.busyLabel,
      busyDetail: panelParts.busyDetail,
      result: panelParts.result,
      reviseView: panelParts.reviseView,
      foot: panelParts.foot,
      again: panelParts.again,
      copy: panelParts.copy,
      revise: panelParts.revise,
      footRevise: panelParts.footRevise,
      useDraft: panelParts.useDraft,
      copyRevision: panelParts.copyRevision,
      backResult: panelParts.backResult,
    }

    // Interaction basics: drag gestures are handled on the window so the ball
    // keeps following the pointer even when the cursor leaves it.
    listen(window, 'pointermove', onPointerMove, true)
    listen(window, 'pointerup', onPointerUp, true)
    listen(window, 'pointercancel', onPointerUp, true)
    listen(window, 'resize', onWindowResize)
    listen(document, 'keydown', onDocumentKeyDown, true)
    listen(document, 'visibilitychange', updateBall)

    // Keep page-level handlers from reacting to our UI, and ours from leaking.
    var swallow = function (event) { event.stopPropagation() }
    listen(shadow, 'click', swallow)
    listen(shadow, 'pointerdown', swallow)
    listen(shadow, 'pointerup', swallow)
    listen(shadow, 'wheel', swallow)
    listen(shadow, 'keydown', swallow)

    parent.appendChild(host)
    applyPos()
    setView('form')
    return el
  }

  /* -------------------------------------------------------------------- API */

  function poll() {
    var value = pending
    pending = null
    return value
  }

  function setStatus(next, label, detail) {
    if (destroyed) return true
    if (!el) {
      try {
        ensureUI()
      } catch (error) {
        /* The page must survive a mount failure. */
      }
    }
    var stateText = next === undefined || next === null ? '' : String(next)
    var labelText = label === undefined || label === null ? '' : String(label)
    var detailText = detail === undefined || detail === null ? '' : String(detail)
    if (stateText === 'busy') {
      phase = 'busy'
      busy = { label: labelText || '评估中…', detail: detailText }
      // Keep the watchdog armed from submit(): a silent host still surfaces a
      // friendly timeout instead of spinning forever.
      if (el) renderBusy()
      return true
    }
    if (stateText === 'done') {
      phase = 'done'
      busy = { label: labelText, detail: detailText }
      clearWatchdog()
      if (el) settle()
      updateBall()
      return true
    }
    if (stateText === 'error') {
      showError(labelText || detailText || '评估失败，请稍后重试')
      return true
    }
    phase = 'idle'
    busy = { label: '', detail: '' }
    clearWatchdog()
    if (el) {
      settle()
      hideBanner()
    }
    updateBall()
    return true
  }

  function showResult(value) {
    if (destroyed) return true
    if (!el) {
      try {
        ensureUI()
      } catch (error) {
        /* Ignore. */
      }
    }
    report = value && typeof value === 'object' ? value : {}
    phase = 'done'
    busy = { label: '', detail: '' }
    clearWatchdog()
    if (!el) return true
    hideBanner()
    renderResult()
    setView('result')
    settle()
    if (!closedByUser) openPanel()
    updateBall()
    later(positionPanel, 0)
    return true
  }

  /** Render the 整改稿 view from the Revision JSON; keeps the report in memory. */
  function showRevision(value) {
    if (destroyed) return true
    if (!el) {
      try {
        ensureUI()
      } catch (error) {
        /* Ignore. */
      }
    }
    revisionDraft = normalizeRevision(value)
    phase = 'done'
    busy = { label: '', detail: '' }
    clearWatchdog()
    if (!el) return true
    hideBanner()
    renderRevision()
    setView('revise')
    settle()
    if (!closedByUser) openPanel()
    updateBall()
    later(positionPanel, 0)
    return true
  }

  function showError(message) {
    if (destroyed) return true
    if (!el) {
      try {
        ensureUI()
      } catch (error) {
        /* Ignore. */
      }
    }
    var value = squash(message)
    if (value === '') value = '评估失败，请稍后重试'
    phase = 'error'
    busy = { label: '', detail: '' }
    clearWatchdog()
    if (!el) return true
    el.bannerMsg.textContent = value
    el.banner.classList.add('on')
    settle()
    openPanel()
    updateBall()
    return true
  }

  function state() {
    return { open: open, phase: phase, values: readValues() }
  }

  function destroy() {
    if (destroyed) return false
    destroyed = true
    clearWatchdog()
    clearTimers()
    clearListeners()
    if (el && el.host && el.host.parentNode) {
      try {
        el.host.parentNode.removeChild(el.host)
      } catch (error) {
        /* Ignore. */
      }
    }
    el = null
    open = false
    closedByUser = false
    phase = 'idle'
    busy = { label: '', detail: '' }
    pending = null
    lastInput = null
    lastIntent = 'evaluate'
    report = null
    revisionDraft = null
    drag = null
    // Drop the globals so a fresh injection (hot-swap after an update) boots a
    // new controller instead of returning 'ready' and leaving this dead one.
    try {
      if (window[KEY] === api) delete window[KEY]
      delete window.__DSH_XHS_TEST__
    } catch (error) {
      /* Ignore: a page may freeze property deletion. */
    }
    return true
  }

  function boot() {
    if (destroyed) return api
    try {
      var mounted = ensureUI()
      if (mounted) {
        updateCounters()
        updateSubmitState()
        applyRosterLimits()
        selectModels(selectedModels)
        applyPos()
        updateBall()
      }
    } catch (error) {
      /* Never break the host page because of the panel. */
    }
    return api
  }

  var api = {
    poll: poll,
    status: setStatus,
    result: showResult,
    revision: showRevision,
    error: showError,
    state: state,
    ping: function () { return true },
    toggle: togglePanel,
    configure: configure,
    build: BUILD,
    destroy: destroy,
  }

  // Expose the controller before any UI exists: the client polls it, tests boot
  // it explicitly. Re-injection is detected by the KEY guard at the top.
  window[KEY] = api
  window.__DSH_XHS_TEST__ = {
    boot: boot,
    api: api,
    formatCount: formatCount,
    parseTags: parseTags,
    normalizeGuide: normalizeGuide,
    reportText: buildReportText,
    // Site-gate helpers, asserted against lib/hosts.js in the jsdom suite.
    isXhsHost: isXhsHost,
    normalizeHostname: normalizeHostname,
    pageGate: pageGate,
    currentPageUrl: currentPageUrl,
  }

  if (window.__DSH_XHS_DISABLE_BOOT__ !== true) {
    if (document.body) {
      boot()
    } else if (document.readyState === 'loading') {
      listen(document, 'DOMContentLoaded', function onDomReady() {
        if (destroyed) return
        boot()
      })
    } else {
      later(boot, 0)
    }
  }

  return 'installed'
})()
