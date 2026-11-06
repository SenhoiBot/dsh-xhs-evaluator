/**
 * Pure evaluation core for the Xiaohongshu (小红书) note evaluator.
 *
 * This module is deliberately dependency-free: no imports, no I/O, no clock
 * reads except an overridable `options.now`. Every exported function is total
 * over arbitrary JSON — a single noisy model reply must never break the report
 * pipeline, so bad shapes degrade to zeros instead of throwing.
 *
 * Two layers:
 *  1. `normalizeModelReport` — one model reply (whatever field names the model
 *     invented) becomes the frozen `ModelReport` shape.
 *  2. `aggregateReport` — N `ModelReport`s become the single `Report` the page
 *     renders: median quality/engagement, min-low/max-high ranges, majority
 *     signal levels, deduped directions, agreement-scaled confidence.
 *
 * The report is advisory: it predicts a range and suggests *directions*. Any
 * publish-ready copy the model smuggles into `directions` is stripped by
 * `sanitizeDirections` (see `COPYABLE_QUOTE_CHARS`). The single exception is
 * `guide`, whose `example` is a deliberately labelled, hard-truncated sample
 * (≤50 chars) the user may adapt — never a finished post.
 *
 * `normalizeRevision` is the other half of that promise: a finished draft is
 * only ever produced when the user explicitly asks for one (一键整改), and it
 * always falls back to the user's own draft rather than inventing content.
 */

/** Input limits shared by the host route and the in-page panel. */
export const LIMITS = Object.freeze({ title: 20, body: 1000, tags: 10, niche: 40 })

/** Schema version of the `Report` object. */
const REPORT_VERSION = 1
/** Default ensemble size when the caller does not ask for one. */
const DEFAULT_MODELS = 2
/** Hard cap on ensemble size (three independent opinions is plenty). */
const MAX_MODELS = 3
const MAX_SIGNALS = 6
const MAX_DIRECTIONS = 5
/** Direction field budgets, frozen by the presentation contract. */
const TITLE_CHARS = 10
const WHY_CHARS = 40
const ACTION_CHARS = 60
const SIGNAL_LABEL_CHARS = 20
const SIGNAL_NOTE_CHARS = 24
const MODEL_SUMMARY_CHARS = 120
const REPORT_SUMMARY_CHARS = 90
/**
 * A quoted span longer than this is a rewrite, not a direction. The prompt
 * forbids it; this is the enforcement half of that promise.
 */
const COPYABLE_QUOTE_CHARS = 40
/** Confidence penalty at maximum model disagreement (`spread === 1`). */
const SPREAD_CONFIDENCE_PENALTY = 0.55

const LEVELS = Object.freeze(['good', 'warn', 'bad'])
const LEVEL_PRIORITY = { warn: 2, bad: 1, good: 0 }

/** How many extra direction candidates we keep before sanitizing down to 5. */
const DIRECTION_CANDIDATES = MAX_DIRECTIONS * 2

/** Accepted field names per metric; models are wildly inconsistent here. */
const METRIC_ALIASES = Object.freeze({
  reads: ['reads', 'read', 'views', 'view', 'impressions', 'impression', '曝光', '阅读', '阅读量'],
  likes: ['likes', 'like', '点赞', '赞', '红心'],
  collects: ['collects', 'collect', 'saves', 'save', 'favorites', 'favourite', '收藏', '收藏量'],
  comments: ['comments', 'comment', 'replies', 'reply', '评论', '评论数'],
})

/**
 * The five 修改指引 sections: fixed keys, Chinese names and order (DESIGN.md).
 * `normalizeGuide` always emits this order and these names, whatever the model
 * called them, so the panel can render the rows without re-sorting.
 */
export const GUIDE_SECTIONS = Object.freeze([
  Object.freeze({ key: 'title', name: '标题' }),
  Object.freeze({ key: 'cover', name: '封面' }),
  Object.freeze({ key: 'images', name: '内部图' }),
  Object.freeze({ key: 'text', name: '文字内容' }),
  Object.freeze({ key: 'tags', name: '标签' }),
])

/** Field budgets for 修改指引; both are hard clamps, not suggestions. */
const GUIDE_INTRO_CHARS = 40
const GUIDE_ADVICE_CHARS = 90
const GUIDE_EXAMPLE_CHARS = 50
/** A merged guide with fewer sections than this counts as "no guide". */
const GUIDE_MIN_SECTIONS = 3

/** Accepted section identifiers per guide key. */
const GUIDE_KEY_ALIASES = Object.freeze({
  title: ['title', 'headline', 'topic', '标题', '标题钩子', '题目'],
  cover: ['cover', 'thumbnail', 'coverimage', '封面', '封面图', '首图'],
  images: [
    'images',
    'image',
    'pictures',
    'picture',
    'photos',
    'gallery',
    'innerimages',
    'bodyimages',
    '内部图',
    '内页图',
    '内图',
    '配图',
    '图片',
    '正文配图',
  ],
  text: ['text', 'body', 'content', 'copy', 'description', 'bodytext', '文字内容', '正文', '文字', '文案', '内容'],
  tags: ['tags', 'tag', 'hashtags', 'hashtag', 'topics', '标签', '话题', '话题标签'],
})

/** `[alias, key]` pairs, longest alias first so 正文配图 wins over 正文. */
const GUIDE_KEY_LOOKUP = Object.freeze(
  GUIDE_SECTIONS.flatMap((section) =>
    (GUIDE_KEY_ALIASES[section.key] ?? [section.key]).map((alias) => [alias, section.key]),
  ).sort((left, right) => right[0].length - left[0].length),
)

/** Keys that carry guide metadata rather than a section. */
const GUIDE_META_KEYS = Object.freeze([
  'intro',
  'summary',
  'overview',
  'sections',
  'section',
  'items',
  'rows',
  'list',
  'parts',
  '总述',
  '一句话',
  '先说',
  '说明',
])

/** Quality fallback when a model answers with a verdict label instead of a score. */
const QUALITY_BY_VERDICT = Object.freeze({
  viral: 88,
  strong: 76,
  average: 62,
  weak: 47,
  poor: 25,
  有爆款相: 88,
  中上: 76,
  中规中矩: 62,
  偏弱: 47,
  很差: 25,
})

/** Direction-only advice used when a weak/poor verdict arrives with no usable direction. */
const DIRECTION_BY_LEVEL = Object.freeze({
  bad: '先定位该维度的具体问题再决定取舍，不要照搬现成文案',
  warn: '把该维度对齐目标人群的常见预期，先做取舍再动笔',
})

/** Quote pairs that can wrap a pasted rewrite. */
const QUOTE_PAIRS = Object.freeze([
  ['“', '”'],
  ['「', '」'],
  ['『', '』'],
  ['"', '"'],
  ["'", "'"],
  ['《', '》'],
])

/* ------------------------------------------------------------------ *
 * small total helpers
 * ------------------------------------------------------------------ */

/**
 * Coerce a JSON scalar to text. Objects/arrays become `''` on purpose: a nested
 * structure where a sentence belongs is noise, not content.
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return ''
}

/**
 * Single-line clamp used for every short field.
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function clampText(value, max) {
  const clean = text(value).replace(/\s+/g, ' ').trim()
  if (clean === '') return ''
  return clean.length > max ? clean.slice(0, max).trim() : clean
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Parse a loose numeric field (`"4.3%"`, `"1.2万"`, `"3.5k"`, `1200`).
 * @param {unknown} value
 * @returns {{ value: number, percent: boolean } | null}
 */
function parseNumeric(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return { value, percent: false }
  const raw = text(value).trim()
  if (raw === '') return null
  const percent = /[%％]/.test(raw)
  const cleaned = raw.replace(/[,，_\s]/g, '')
  const match = /-?\d+(?:\.\d+)?/.exec(cleaned)
  if (match === null) return null
  let parsed = Number(match[0])
  if (!Number.isFinite(parsed)) return null
  let scale = 1
  if (/万/.test(cleaned)) scale = 10_000
  else if (/[kK]/.test(cleaned)) scale = 1_000
  else if (/亿/.test(cleaned)) scale = 100_000_000
  if (percent) scale = 1
  parsed *= scale
  return Number.isFinite(parsed) ? { value: parsed, percent } : null
}

/**
 * Non-negative integer or fallback.
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function intOr(value, fallback) {
  const parsed = parseNumeric(value)
  if (parsed === null) return fallback
  return Math.max(0, Math.round(parsed.value))
}

/**
 * A single estimate becomes a plausible interval instead of a bogus point.
 * @param {number} value
 * @returns {{low: number, high: number}}
 */
function widen(value) {
  const middle = Math.max(0, Math.round(value))
  if (middle === 0) return { low: 0, high: 0 }
  const low = Math.max(0, Math.round(middle * 0.6))
  const high = Math.max(low, Math.round(middle * 1.6))
  return { low, high }
}

/**
 * @param {number} a
 * @param {number} b
 * @returns {{low: number, high: number}}
 */
function orderRange(a, b) {
  const left = Math.max(0, Math.round(Number.isFinite(a) ? a : 0))
  const right = Math.max(0, Math.round(Number.isFinite(b) ? b : 0))
  return { low: Math.min(left, right), high: Math.max(left, right) }
}

/**
 * `{low,high}` from an object that may use low/min/from, high/max/to, or a mid.
 * @param {object} value
 * @returns {{low: number, high: number} | null}
 */
function rangeFromObject(value) {
  const hasLow = value.low !== undefined || value.min !== undefined || value.from !== undefined
  const hasHigh = value.high !== undefined || value.max !== undefined || value.to !== undefined
  const midSource =
    value.mid !== undefined
      ? value.mid
      : value.value !== undefined
        ? value.value
        : value.estimated !== undefined
          ? value.estimated
          : value.count
  const middle = midSource === undefined || midSource === null ? null : intOr(midSource, 0)
  let low = hasLow ? intOr(value.low ?? value.min ?? value.from, 0) : null
  let high = hasHigh ? intOr(value.high ?? value.max ?? value.to, 0) : null
  if (low === null && high === null) return middle === null ? null : widen(middle)
  if (low === null) low = high
  if (high === null) high = low
  if (middle !== null) {
    low = Math.min(low, middle)
    high = Math.max(high, middle)
  }
  return orderRange(low, high)
}

/**
 * Normalize any metric value the model might emit into `{low,high}`.
 * @param {unknown} value
 * @returns {{low: number, high: number}}
 */
function normalizeRangeValue(value) {
  if (value === undefined || value === null) return { low: 0, high: 0 }
  if (Array.isArray(value)) return orderRange(intOr(value[0], 0), intOr(value[1], intOr(value[0], 0)))
  if (isRecord(value)) return rangeFromObject(value) ?? { low: 0, high: 0 }
  if (typeof value === 'string') {
    const raw = value.trim()
    const numbers = raw.replace(/[,，_]/g, '').match(/\d+(?:\.\d+)?/g)
    if (numbers === null) return { low: 0, high: 0 }
    if (numbers.length >= 2) return orderRange(Number(numbers[0]), Number(numbers[1]))
    const parsed = parseNumeric(raw)
    return parsed === null ? { low: 0, high: 0 } : widen(parsed.value)
  }
  const parsed = parseNumeric(value)
  return parsed === null ? { low: 0, high: 0 } : widen(parsed.value)
}

/**
 * Search the report body, then its `predicted`/`metrics` sub-objects.
 * @param {object} primary
 * @param {object[]} extras
 * @param {string[]} aliases
 * @returns {unknown}
 */
function pickAliases(primary, extras, aliases) {
  for (const alias of aliases) {
    for (const holder of [primary, ...extras]) {
      if (!isRecord(holder)) continue
      const value = holder[alias]
      if (value !== undefined && value !== null) return value
    }
  }
  return undefined
}

/**
 * @param {unknown} value
 * @returns {number} 0..1
 */
function normalizeRate(value) {
  const parsed = parseNumeric(value)
  if (parsed === null) return 0
  let rate = parsed.value
  if (parsed.percent) rate /= 100
  else if (rate > 1) rate /= 100
  if (!Number.isFinite(rate)) return 0
  return Math.round(Math.min(1, Math.max(0, rate)) * 10000) / 10000
}

/**
 * @param {unknown} value
 * @returns {number | null} 0..100
 */
function normalizeQuality(value) {
  const parsed = parseNumeric(value)
  if (parsed === null) return null
  let quality = parsed.value
  if (!parsed.percent && quality > 0 && quality <= 1) quality *= 100
  if (!Number.isFinite(quality)) return null
  return Math.round(Math.min(100, Math.max(0, quality)))
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number} 0..1
 */
function normalizeConfidence(value, fallback) {
  const parsed = parseNumeric(value)
  if (parsed === null) return fallback
  let confidence = parsed.value
  if (parsed.percent) confidence /= 100
  else if (confidence > 1) confidence /= 100
  if (!Number.isFinite(confidence)) return fallback
  return Math.round(Math.min(1, Math.max(0, confidence)) * 100) / 100
}

/**
 * Map whatever the model called a level onto the three allowed values.
 * @param {unknown} value
 * @returns {'good'|'warn'|'bad'}
 */
function normalizeLevel(value) {
  const raw = clampText(value, 24).toLowerCase()
  if (raw === '') return 'warn'
  if (LEVELS.includes(raw)) return raw
  if (/good|positive|great|excellent|strong|ok\b|正常|好|优秀|强|加分|优势|亮点/.test(raw)) return 'good'
  if (/bad|poor|negative|weak|risk|差|弱|不足|扣分|劣势|问题|槽点/.test(raw)) return 'bad'
  return 'warn'
}

/* ------------------------------------------------------------------ *
 * direction sanitizing — "只给方向，绝不代写"
 * ------------------------------------------------------------------ */

/**
 * @param {string} raw
 * @returns {string}
 */
function escapeRegex(raw) {
  return String(raw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Remove quoted spans long enough to be a pasted rewrite.
 * @param {string} value
 * @returns {string}
 */
function removeLongQuotedSpans(value) {
  let out = String(value ?? '')
  for (const [open, close] of QUOTE_PAIRS) {
    const pattern = new RegExp(
      `${escapeRegex(open)}[^${escapeRegex(close)}]{${COPYABLE_QUOTE_CHARS + 1},}${escapeRegex(close)}`,
      'g',
    )
    out = out.replace(pattern, ' ')
  }
  return out
}

/**
 * Whether a string contains material that reads as publish-ready copy. Only used
 * to decide whether an emptied `action` should drop the whole direction.
 * @param {string} value
 * @returns {boolean}
 */
function isGhostwritten(value) {
  const raw = text(value)
  if (raw === '') return false
  const longQuote = new RegExp(`[“「『"'《][^”」』"'》]{${COPYABLE_QUOTE_CHARS + 1},}`).test(raw)
  if (longQuote) return true
  return /(?:可以直接用|直接发布|直接发|照抄|复制即可|标题如下|开头如下|文案如下|改写为|建议标题|建议开头)[：:]/.test(
    raw,
  )
}

/**
 * Strip copy-paste material while leaving the directional sentence intact.
 * @param {string} raw
 * @returns {string}
 */
function cleanDirectionAction(raw) {
  let value = text(raw).replace(/\s+/g, ' ').trim()
  if (value === '') return ''
  value = removeLongQuotedSpans(value)
  value = value.replace(
    /(?:可以直接用|直接发布|直接发|照抄|复制即可|标题如下|开头如下|文案如下|改写为|建议标题|建议开头)[：:]\s*[^。；;!?！？]{6,}/g,
    ' ',
  )
  value = value.replace(/[“”「」『』]/g, ' ')
  value = value.replace(/\s+/g, ' ').trim()
  value = value.replace(/^[\s：:，,。.、；;·\-—]+/, '').replace(/[\s：:，,、；;·\-—]+$/, '')
  return value.trim()
}

/**
 * Clamp every direction field and drop entries that are pure ghostwriting.
 *
 * A model that ignores the prompt tends to put a ready-to-publish title or
 * opening inside `action`. We remove the quoted rewrite; if nothing directional
 * is left the entry is dropped rather than shown to the user as advice.
 *
 * @param {unknown} list
 * @returns {Array<{title: string, why: string, action: string}>}
 */
export function sanitizeDirections(list) {
  const out = []
  const source = Array.isArray(list) ? list : []
  for (const entry of source) {
    if (out.length >= MAX_DIRECTIONS) break
    if (!isRecord(entry)) continue
    const rawAction = text(entry.action)
    const why = clampText(entry.why, WHY_CHARS)
    const action = clampText(cleanDirectionAction(rawAction), ACTION_CHARS)
    let title = clampText(entry.title, TITLE_CHARS)
    if (title === '') title = clampText(why !== '' ? why : action, TITLE_CHARS)
    if (title === '') continue
    // Nothing directional survived and the original was a rewrite: drop it.
    if (isGhostwritten(rawAction) && action.length < 6) continue
    if (action === '') continue
    out.push({ title, why, action })
  }
  return out
}

/* ------------------------------------------------------------------ *
 * signals / directions normalization
 * ------------------------------------------------------------------ */

/**
 * @param {unknown} value
 * @returns {Array<{label: string, level: 'good'|'warn'|'bad', note: string}>}
 */
function normalizeSignals(value) {
  const out = []
  const push = (label, level, note) => {
    if (out.length >= MAX_SIGNALS) return
    const cleanLabel = clampText(label, SIGNAL_LABEL_CHARS)
    if (cleanLabel === '') return
    out.push({ label: cleanLabel, level: normalizeLevel(level), note: clampText(note, SIGNAL_NOTE_CHARS) })
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (out.length >= MAX_SIGNALS) break
      if (isRecord(entry)) {
        push(
          entry.label ?? entry.name ?? entry.title ?? entry.dimension ?? entry.key ?? entry.field,
          entry.level ?? entry.status ?? entry.tone ?? entry.verdict ?? entry.value,
          entry.note ?? entry.detail ?? entry.description ?? entry.desc ?? entry.comment ?? entry.reason,
        )
      } else if (typeof entry === 'string' && entry.trim() !== '') {
        push(entry, 'warn', '')
      }
    }
    return out
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (out.length >= MAX_SIGNALS) break
      if (typeof entry === 'string') {
        const direct = LEVELS.includes(entry.trim().toLowerCase())
        push(key, direct ? entry : 'warn', direct ? '' : entry)
      } else if (isRecord(entry)) {
        push(key, entry.level ?? entry.status ?? entry.tone ?? entry.value, entry.note ?? entry.detail ?? '')
      }
    }
  }
  return out
}

/**
 * @param {unknown} value
 * @returns {Array<{title: string, why: string, action: string}>}
 */
function normalizeDirections(value) {
  const candidates = []
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (candidates.length >= DIRECTION_CANDIDATES) break
      if (!isRecord(entry)) continue
      candidates.push({
        title: entry.title ?? entry.name ?? entry.heading ?? entry.dimension ?? entry.label ?? '',
        why:
          entry.why ??
          entry.reason ??
          entry.rationale ??
          entry.problem ??
          entry.issue ??
          entry.detail ??
          '',
        action:
          entry.action ??
          entry.fix ??
          entry.advice ??
          entry.suggestion ??
          entry.how ??
          entry.direction ??
          entry.tip ??
          '',
      })
    }
  }
  return sanitizeDirections(candidates)
}

/* ------------------------------------------------------------------ *
 * 修改指引 (guide) — the one place a concrete example is allowed
 * ------------------------------------------------------------------ */

/**
 * Resolve any section identifier (English key, Chinese name, alias) to one of
 * the five frozen keys.
 * @param {unknown} value
 * @returns {string} a guide key, or `''` when it is not a guide section.
 */
function guideKeyOf(value) {
  const raw = clampText(value, 30).toLowerCase()
  if (raw === '') return ''
  for (const section of GUIDE_SECTIONS) {
    if (raw === section.key) return section.key
    if (raw === section.name.toLowerCase()) return section.key
  }
  for (const [alias, key] of GUIDE_KEY_LOOKUP) {
    if (raw === alias) return key
  }
  // Chinese labels are often verbose ("封面首图应该怎么选"): fall back to the
  // longest alias contained in the label. Latin aliases must match exactly.
  for (const [alias, key] of GUIDE_KEY_LOOKUP) {
    if (/[\u4e00-\u9fff]/.test(alias) && raw.includes(alias)) return key
  }
  return ''
}

/**
 * @param {string} key
 * @returns {string}
 */
function guideSectionName(key) {
  const section = GUIDE_SECTIONS.find((entry) => entry.key === key)
  return section === undefined ? '' : section.name
}

/**
 * Merge one section candidate into the accumulator. The first usable advice
 * wins; a later model may still supply the missing example.
 * @param {Map<string, {key: string, name: string, advice: string, example?: string}>} found
 * @param {unknown} keyHint - the outer key when sections arrived as an object map.
 * @param {unknown} entry
 */
function addGuideSection(found, keyHint, entry) {
  if (entry === null || entry === undefined) return
  let key = guideKeyOf(keyHint)
  let adviceSource = ''
  let exampleSource = ''
  if (typeof entry === 'string') {
    adviceSource = entry
  } else if (isRecord(entry)) {
    if (key === '') {
      key = guideKeyOf(
        entry.key ??
          entry.id ??
          entry.section ??
          entry.type ??
          entry.slot ??
          entry.target ??
          entry.name ??
          entry.label ??
          entry.title ??
          entry['维度'] ??
          entry['名称'],
      )
    }
    adviceSource =
      entry.advice ??
      entry.suggestion ??
      entry.how ??
      entry.tip ??
      entry.description ??
      entry.detail ??
      entry.text ??
      entry.content ??
      entry['建议'] ??
      entry['怎么选'] ??
      entry['怎么做'] ??
      ''
    exampleSource =
      entry.example ??
      entry.sample ??
      entry.eg ??
      entry.exampleText ??
      entry['例子'] ??
      entry['示例'] ??
      entry['举例'] ??
      entry['样例'] ??
      ''
  } else {
    return
  }
  if (key === '') return
  const advice = clampText(adviceSource, GUIDE_ADVICE_CHARS)
  if (advice === '') return
  const example = clampText(exampleSource, GUIDE_EXAMPLE_CHARS)
  const existing = found.get(key)
  if (existing !== undefined) {
    if (existing.example === undefined && example !== '') existing.example = example
    return
  }
  const section = { key, name: guideSectionName(key), advice }
  if (example !== '') section.example = example
  found.set(key, section)
}

/**
 * Pull the sections out of whatever container the model used: an array, a
 * `sections` array, a `sections` object map, or the five keys sitting directly
 * on the guide object (English keys or Chinese names).
 * @param {unknown} source
 * @returns {Array<{key: string, name: string, advice: string, example?: string}>} fixed order.
 */
function collectGuideSections(source) {
  const found = new Map()
  if (Array.isArray(source)) {
    for (const entry of source) addGuideSection(found, '', entry)
  } else if (isRecord(source)) {
    const listKey = ['sections', 'section', 'items', 'rows', 'list', 'parts', '部分', '条目'].find(
      (key) => source[key] !== undefined && source[key] !== null,
    )
    const list = listKey === undefined ? undefined : source[listKey]
    if (Array.isArray(list)) {
      for (const entry of list) addGuideSection(found, '', entry)
    } else if (isRecord(list)) {
      for (const [hint, entry] of Object.entries(list)) addGuideSection(found, hint, entry)
    }
    // Some models skip the wrapper and put the five keys at the top level.
    if (found.size === 0) {
      for (const [hint, entry] of Object.entries(source)) {
        if (GUIDE_META_KEYS.includes(String(hint).toLowerCase())) continue
        addGuideSection(found, hint, entry)
      }
    }
  }
  return GUIDE_SECTIONS.map((section) => found.get(section.key)).filter((section) => section !== undefined)
}

/**
 * Find the guide payload inside a model reply.
 * @param {unknown} parsed
 * @returns {unknown}
 */
function unwrapGuide(parsed) {
  if (parsed === null || parsed === undefined) return null
  if (typeof parsed === 'string' || Array.isArray(parsed)) return parsed
  if (!isRecord(parsed)) return null
  const containerKeys = [
    'guide',
    'guidance',
    'modificationGuide',
    'modification_guide',
    'revisionGuide',
    'howto',
    'how_to',
    '修改指引',
    '调整指引',
    '修改建议',
  ]
  for (const key of containerKeys) {
    const value = parsed[key]
    if (value !== undefined && value !== null) return value
  }
  return parsed
}

/**
 * Normalize a model's 修改指引 into the frozen shape.
 *
 * This is the only place where concrete copy is allowed: `example` is a single
 * short sample the user may adapt, rendered by the panel as `（例：…）` — the host
 * never adds the parentheses itself. Every field is hard-clamped, sections are
 * deduped and emitted in the fixed order, and a guide with no usable section
 * becomes `null` (the panel then hides the block).
 *
 * @param {unknown} parsed
 * @returns {{intro: string, sections: Array<{key: string, name: string, advice: string, example?: string}>} | null}
 */
export function normalizeGuide(parsed) {
  const source = unwrapGuide(parsed)
  if (source === null || source === undefined) return null
  let intro = ''
  let sections = []
  if (typeof source === 'string') {
    intro = clampText(source, GUIDE_INTRO_CHARS)
  } else if (Array.isArray(source)) {
    sections = collectGuideSections(source)
  } else if (isRecord(source)) {
    intro = clampText(
      source.intro ??
        source.summary ??
        source.overview ??
        source['一句话'] ??
        source['总述'] ??
        source['先说'] ??
        '',
      GUIDE_INTRO_CHARS,
    )
    sections = collectGuideSections(source)
  } else {
    return null
  }
  if (sections.length === 0) return null
  return { intro, sections }
}

/* ------------------------------------------------------------------ *
 * public: input normalization
 * ------------------------------------------------------------------ */

/**
 * Clamp the requested ensemble size to 1..3.
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function clampModels(value, fallback) {
  const direct = Number(value)
  const base = Number.isFinite(direct) ? direct : Number(fallback)
  if (!Number.isFinite(base)) return DEFAULT_MODELS
  const rounded = Math.round(base)
  if (rounded < 1) return 1
  return Math.min(MAX_MODELS, rounded)
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeBody(value) {
  const raw = text(value).replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim()
  if (raw === '') return ''
  return raw.length > LIMITS.body ? raw.slice(0, LIMITS.body).trim() : raw
}

/**
 * Accept `['#护肤', '通勤']` or `'#护肤, 通勤 穿搭'`.
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeTags(value) {
  const out = []
  const seen = new Set()
  const push = (entry) => {
    if (out.length >= LIMITS.tags) return
    const cleaned = text(entry)
      .replace(/\s+/g, ' ')
      .replace(/^[#,，、\s]+/, '')
      .replace(/[#,，、\s]+$/, '')
      .trim()
      .slice(0, 30)
    if (cleaned === '') return
    const key = cleaned.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push(cleaned)
  }
  if (Array.isArray(value)) {
    for (const entry of value) push(entry)
  } else if (typeof value === 'string') {
    for (const entry of value.split(/[,，、;；#\s]+/)) push(entry)
  }
  return out
}

/**
 * Normalize untrusted HTTP input into the shape prompts and the route expect.
 *
 * Never throws. An empty `body` is returned as `''` so the caller can answer 400
 * — everything else is clamped rather than rejected (the panel mirrors these
 * limits, so a clamp should never surprise a real user).
 *
 * @param {unknown} raw
 * @param {number} [fallbackModels] - ensemble size when the payload omits one.
 * @returns {{title: string, body: string, tags: string[], niche: string, fans: string, models: number}}
 */
export function normalizeInput(raw, fallbackModels = DEFAULT_MODELS) {
  const source = isRecord(raw) ? raw : {}
  return {
    title: clampText(source.title ?? source.subject ?? source.headline ?? '', LIMITS.title),
    body: normalizeBody(source.body ?? source.content ?? source.text ?? source.desc ?? ''),
    tags: normalizeTags(source.tags ?? source.topics ?? source.hashtags ?? source['话题'] ?? source['标签']),
    niche: clampText(source.niche ?? source.category ?? source.track ?? source['赛道'] ?? '', LIMITS.niche),
    fans: clampText(source.fans ?? source.followers ?? source.audience ?? source['粉丝量级'] ?? '', 32),
    models: clampModels(source.models ?? source.modelCount ?? source.count, fallbackModels),
  }
}

/* ------------------------------------------------------------------ *
 * public: one model reply -> ModelReport
 * ------------------------------------------------------------------ */

/**
 * Peel off `{report: {...}}` / `{data: {...}}` wrappers when the outer object
 * carries no recognizable report fields.
 * @param {unknown} parsed
 * @returns {object}
 */
function unwrapReport(parsed) {
  if (!isRecord(parsed)) return Array.isArray(parsed) ? unwrapReport(parsed[0]) : {}
  const looksLikeReport = (candidate) => {
    if (!isRecord(candidate)) return false
    if (candidate.predicted !== undefined || candidate.metrics !== undefined) return true
    if (candidate.quality !== undefined || candidate.score !== undefined) return true
    if (candidate.summary !== undefined || candidate.conclusion !== undefined) return true
    for (const aliases of Object.values(METRIC_ALIASES)) {
      for (const alias of aliases) if (candidate[alias] !== undefined) return true
    }
    return false
  }
  if (looksLikeReport(parsed)) return parsed
  for (const key of ['report', 'result', 'data', 'evaluation', 'analysis', 'output']) {
    if (looksLikeReport(parsed[key])) return parsed[key]
  }
  return parsed
}

/**
 * @param {object} source
 * @returns {number | null}
 */
function qualityFromVerdict(source) {
  const raw = clampText(source.verdict ?? source.level ?? source.ratingLabel ?? source['评级'] ?? '', 16).toLowerCase()
  if (raw === '') return null
  for (const [key, value] of Object.entries(QUALITY_BY_VERDICT)) {
    if (raw === key.toLowerCase() || raw.includes(key.toLowerCase())) return value
  }
  return null
}

/**
 * Normalize one model reply into the frozen `ModelReport` shape.
 *
 * Models routinely rename fields, put a percent sign on a rate, or answer with a
 * single number instead of a range; every case degrades gracefully.
 *
 * @param {unknown} parsed - parsed JSON (or anything, really).
 * @returns {{reads: {low: number, high: number}, likes: {low: number, high: number},
 *   collects: {low: number, high: number}, comments: {low: number, high: number},
 *   engagementRate: number, quality: number, confidence: number, summary: string,
 *   signals: Array<{label: string, level: string, note: string}>,
 *   directions: Array<{title: string, why: string, action: string}>,
 *   guide: {intro: string, sections: Array<{key: string, name: string, advice: string, example?: string}>} | null}}
 */
export function normalizeModelReport(parsed) {
  const source = unwrapReport(parsed)
  const predicted = isRecord(source.predicted) ? source.predicted : {}
  const metrics = isRecord(source.metrics) ? source.metrics : {}
  const extras = [predicted, metrics]

  const qualityRaw = pickAliases(source, extras, [
    'quality',
    'qualityScore',
    'score',
    'rating',
    '综合评分',
    '评分',
    '得分',
  ])
  const quality = normalizeQuality(qualityRaw) ?? qualityFromVerdict(source) ?? 50

  const summarySource = pickAliases(source, extras, [
    'summary',
    'conclusion',
    'verdictSummary',
    'comment',
    '总结',
    '结论',
    '一句话结论',
  ])

  return {
    reads: normalizeRangeValue(pickAliases(source, extras, METRIC_ALIASES.reads)),
    likes: normalizeRangeValue(pickAliases(source, extras, METRIC_ALIASES.likes)),
    collects: normalizeRangeValue(pickAliases(source, extras, METRIC_ALIASES.collects)),
    comments: normalizeRangeValue(pickAliases(source, extras, METRIC_ALIASES.comments)),
    engagementRate: normalizeRate(
      pickAliases(source, extras, ['engagementRate', 'engagement_rate', 'engagement', 'interactionRate', '互动率']),
    ),
    quality,
    confidence: normalizeConfidence(
      pickAliases(source, extras, ['confidence', 'certainty', '置信度', '可信度']),
      0.5,
    ),
    summary: clampText(summarySource, MODEL_SUMMARY_CHARS),
    signals: normalizeSignals(
      source.signals ?? source.dimensions ?? source.checks ?? source.diagnostics ?? source['信号'],
    ),
    directions: normalizeDirections(
      source.directions ?? source.suggestions ?? source.advice ?? source.improvements ?? source['调整方向'] ?? source.tips,
    ),
    guide: normalizeGuide(
      source.guide ??
        source.modificationGuide ??
        source.modification_guide ??
        source.revisionGuide ??
        source.guidance ??
        source.howto ??
        source['修改指引'] ??
        source['调整指引'],
    ),
  }
}

/* ------------------------------------------------------------------ *
 * public: verdict / spread / formatting
 * ------------------------------------------------------------------ */

/**
 * Map a 0..100 quality score to the frozen verdict vocabulary.
 * @param {number} quality
 * @returns {{id: string, label: string}}
 */
export function verdictOf(quality) {
  const score = typeof quality === 'number' && Number.isFinite(quality) ? quality : 0
  if (score >= 82) return { id: 'viral', label: '有爆款相' }
  if (score >= 70) return { id: 'strong', label: '中上' }
  if (score >= 55) return { id: 'average', label: '中规中矩' }
  if (score >= 40) return { id: 'weak', label: '偏弱' }
  return { id: 'poor', label: '很差' }
}

/**
 * Normalized dispersion of the predicted reads high-end across models.
 * `(max - min) / max` is already bounded by 0..1 and needs no extra scaling.
 * @param {Array<object>} reports
 * @returns {number} 0..1
 */
export function spreadOf(reports) {
  const list = Array.isArray(reports) ? reports : []
  const highs = []
  for (const report of list) {
    const high = report?.reads?.high
    if (typeof high === 'number' && Number.isFinite(high) && high > 0) highs.push(high)
  }
  if (highs.length < 2) return 0
  const max = Math.max(...highs)
  if (max <= 0) return 0
  const spread = (max - Math.min(...highs)) / max
  return Math.round(Math.min(1, Math.max(0, spread)) * 1000) / 1000
}

/**
 * Compact Chinese count used in summaries and the panel: 1200 -> `1.2k`,
 * 12000 -> `1.2万`, below 1000 unchanged.
 * @param {number} n
 * @returns {string}
 */
export function formatCount(n) {
  const value = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(value)) return '0'
  const magnitude = Math.abs(value)
  if (magnitude < 1000) return String(Math.round(value))
  const trim = (scaled) => (Math.round(scaled * 10) / 10).toFixed(1).replace(/\.0$/, '')
  if (magnitude < 10_000) return `${trim(value / 1000)}k`
  if (magnitude < 100_000_000) return `${trim(value / 10_000)}万`
  return `${trim(value / 100_000_000)}亿`
}

/* ------------------------------------------------------------------ *
 * public: aggregation
 * ------------------------------------------------------------------ */

/**
 * @param {number[]} values
 * @returns {number}
 */
function median(values) {
  const list = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right)
  if (list.length === 0) return 0
  const middle = Math.floor(list.length / 2)
  return list.length % 2 === 0 ? (list[middle - 1] + list[middle]) / 2 : list[middle]
}

/**
 * @param {number[]} values
 * @returns {number}
 */
function mean(values) {
  const list = values.filter((value) => Number.isFinite(value))
  if (list.length === 0) return 0
  return list.reduce((total, value) => total + value, 0) / list.length
}

/**
 * min(low) / median(mid) / max(high) across models.
 * @param {Array<object>} reports
 * @param {'reads'|'likes'|'collects'|'comments'} key
 * @returns {{low: number, mid: number, high: number}}
 */
function aggregateRange(reports, key) {
  const lows = []
  const highs = []
  const mids = []
  for (const report of reports) {
    const range = report?.[key]
    const low = Number.isFinite(range?.low) ? Math.max(0, Math.round(range.low)) : 0
    const high = Number.isFinite(range?.high) ? Math.max(low, Math.round(range.high)) : low
    lows.push(low)
    highs.push(high)
    mids.push(Math.round((low + high) / 2))
  }
  const low = Math.min(...lows)
  const high = Math.max(...highs)
  const mid = Math.min(high, Math.max(low, Math.round(median(mids))))
  return { low, mid, high }
}

/**
 * Majority level per signal label, keeping first-seen label order. Ties prefer
 * `warn`, then `bad`, then `good`, so a split signal never reads as a strength.
 * @param {Array<object>} reports
 * @returns {Array<{label: string, level: string, note: string}>}
 */
function aggregateSignals(reports) {
  const groups = new Map()
  let order = 0
  for (const report of reports) {
    for (const signal of report.signals) {
      let group = groups.get(signal.label)
      if (group === undefined) {
        group = { label: signal.label, levels: new Map(), notes: new Map(), order: order++ }
        groups.set(signal.label, group)
      }
      group.levels.set(signal.level, (group.levels.get(signal.level) ?? 0) + 1)
      if (signal.note !== '') group.notes.set(signal.note, (group.notes.get(signal.note) ?? 0) + 1)
    }
  }
  const rows = [...groups.values()].sort((left, right) => left.order - right.order).slice(0, MAX_SIGNALS)
  return rows.map((group) => {
    let level = 'warn'
    let bestCount = -1
    for (const [candidate, count] of group.levels) {
      if (count > bestCount || (count === bestCount && LEVEL_PRIORITY[candidate] > LEVEL_PRIORITY[level])) {
        level = candidate
        bestCount = count
      }
    }
    const note = [...group.notes.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? ''
    return { label: group.label, level, note }
  })
}

/**
 * Dedupe directions by title (most frequent wins), cap 5.
 * @param {Array<object>} reports
 * @returns {Array<{title: string, why: string, action: string}>}
 */
function aggregateDirections(reports) {
  const groups = new Map()
  let order = 0
  for (const report of reports) {
    for (const direction of report.directions) {
      const existing = groups.get(direction.title)
      if (existing === undefined) {
        groups.set(direction.title, { direction: { ...direction }, count: 1, order: order++ })
        continue
      }
      existing.count += 1
      // Keep the most explanatory variant so the merged direction stays useful.
      if (direction.why.length > existing.direction.why.length) existing.direction.why = direction.why
      if (direction.action.length > existing.direction.action.length) existing.direction.action = direction.action
    }
  }
  return [...groups.values()]
    .sort((left, right) => right.count - left.count || left.order - right.order)
    .slice(0, MAX_DIRECTIONS)
    .map((group) => group.direction)
}

/**
 * Guarantee the contract "directions non-empty when verdict ∈ {weak,poor}" even
 * when every model answered with signal-only text.
 * @param {Array<{label: string, level: string, note: string}>} signals
 * @returns {Array<{title: string, why: string, action: string}>}
 */
function fallbackDirections(signals) {
  const rows = signals
    .filter((signal) => signal.level === 'bad' || signal.level === 'warn')
    .slice(0, MAX_DIRECTIONS)
    .map((signal) => ({
      title: clampText(signal.label, TITLE_CHARS),
      why: clampText(
        signal.note !== '' ? signal.note : `该维度被评为${signal.level === 'bad' ? '明显不足' : '需要留意'}`,
        WHY_CHARS,
      ),
      action: clampText(DIRECTION_BY_LEVEL[signal.level], ACTION_CHARS),
    }))
    .filter((direction) => direction.title !== '')
  if (rows.length > 0) return rows
  return [
    {
      title: '整体结构',
      why: '各维度信号都不明确',
      action: '先补强标题钩子与封面信息量，再决定是否发布',
    },
  ]
}

/**
 * Merge the per-model 修改指引.
 *
 * The primary guide comes from the model whose quality is closest to the
 * aggregate median (among the models that actually answered with a guide, so a
 * silent model cannot erase the block). Missing sections are filled from the
 * other models in route order; fewer than three merged sections means the report
 * has no guide and the panel hides the block.
 *
 * @param {Array<object>} reports
 * @param {number} quality - aggregated median quality.
 * @returns {{intro: string, sections: Array<{key: string, name: string, advice: string, example?: string}>} | null}
 */
function aggregateGuide(reports, quality) {
  const candidates = reports.filter(
    (report) => isRecord(report.guide) && Array.isArray(report.guide.sections) && report.guide.sections.length > 0,
  )
  if (candidates.length === 0) return null

  let primary = candidates[0]
  let bestDistance = Math.abs(primary.quality - quality)
  for (const report of candidates) {
    const distance = Math.abs(report.quality - quality)
    if (distance < bestDistance) {
      bestDistance = distance
      primary = report
    }
  }

  const merged = new Map()
  for (const section of primary.guide.sections) merged.set(section.key, section)
  if (merged.size < GUIDE_SECTIONS.length) {
    for (const report of reports) {
      if (report === primary) continue
      if (!isRecord(report.guide) || !Array.isArray(report.guide.sections)) continue
      for (const section of report.guide.sections) {
        if (!merged.has(section.key)) merged.set(section.key, section)
      }
      if (merged.size >= GUIDE_SECTIONS.length) break
    }
  }
  if (merged.size < GUIDE_MIN_SECTIONS) return null

  const sections = GUIDE_SECTIONS.map((entry) => merged.get(entry.key))
    .filter((section) => section !== undefined)
    .map((section) => {
      const clean = {
        key: section.key,
        name: guideSectionName(section.key),
        advice: clampText(section.advice, GUIDE_ADVICE_CHARS),
      }
      const example = clampText(section.example, GUIDE_EXAMPLE_CHARS)
      if (example !== '') clean.example = example
      return clean
    })

  return { intro: clampText(primary.guide.intro, GUIDE_INTRO_CHARS), sections }
}

/**
 * The summary comes from the model closest to the median quality, so it matches
 * the aggregated verdict instead of one outlier.
 * @param {Array<object>} reports
 * @param {number} quality
 * @param {{id: string, label: string}} verdict
 * @param {{mid: number}} reads
 * @param {{mid: number}} likes
 * @returns {string}
 */
function summaryFor(reports, quality, verdict, reads, likes) {
  let best = null
  let bestDistance = Infinity
  for (const report of reports) {
    const distance = Math.abs(report.quality - quality)
    if (distance < bestDistance) {
      bestDistance = distance
      best = report
    }
  }
  const summary = clampText(best?.summary ?? '', REPORT_SUMMARY_CHARS)
  if (summary !== '') return summary
  return `综合判断${verdict.label}，预计阅读约${formatCount(reads.mid)}、点赞约${formatCount(likes.mid)}。`
}

/**
 * Safe report for "no usable model opinion".
 * @param {object} options
 * @returns {object}
 */
function emptyReport(options) {
  const zero = { low: 0, mid: 0, high: 0 }
  return {
    version: REPORT_VERSION,
    verdict: 'average',
    verdictLabel: '中规中矩',
    summary: '可用模型不足，暂时无法给出可靠预测，请稍后重试。',
    confidence: 0,
    predicted: { reads: { ...zero }, likes: { ...zero }, collects: { ...zero }, comments: { ...zero }, engagementRate: 0 },
    signals: [],
    directions: [],
    guide: null,
    modelCount: 0,
    spread: 0,
    ts: Number.isFinite(options?.now) ? options.now : Date.now(),
  }
}

/**
 * Merge N model opinions into the single `Report` the page renders.
 *
 * Rules (frozen by DESIGN.md): median for `mid`, min(low)/max(high) across
 * models, mean confidence scaled by agreement, majority level per signal label,
 * directions deduped by title and capped at 5, summary from the model nearest
 * the median quality, `spread` from the reads high-end dispersion, and `guide`
 * merged from the nearest-quality model plus route-order backfill.
 *
 * Total: an empty or garbage input yields a safe `average` report.
 *
 * @param {unknown} reports - `ModelReport[]`
 * @param {{routes?: Array<{label: string}>, now?: number}} [options]
 * @returns {object} `Report`
 */
export function aggregateReport(reports, options = {}) {
  const list = (Array.isArray(reports) ? reports : [])
    .filter((report) => isRecord(report))
    .map((report) => normalizeModelReport(report))
  if (list.length === 0) return emptyReport(options)

  const reads = aggregateRange(list, 'reads')
  const likes = aggregateRange(list, 'likes')
  const collects = aggregateRange(list, 'collects')
  const comments = aggregateRange(list, 'comments')
  const engagementRate = Math.round(median(list.map((report) => report.engagementRate)) * 10000) / 10000
  const quality = median(list.map((report) => report.quality))
  const verdict = verdictOf(quality)
  const spread = spreadOf(list)
  const agreement = Math.max(0, 1 - SPREAD_CONFIDENCE_PENALTY * spread)
  const confidence = Math.round(mean(list.map((report) => report.confidence)) * agreement * 100) / 100

  const signals = aggregateSignals(list)
  let directions = aggregateDirections(list)
  if ((verdict.id === 'weak' || verdict.id === 'poor') && directions.length === 0) {
    directions = fallbackDirections(signals)
  }

  return {
    version: REPORT_VERSION,
    verdict: verdict.id,
    verdictLabel: verdict.label,
    summary: summaryFor(list, quality, verdict, reads, likes),
    confidence: Math.min(1, Math.max(0, confidence)),
    predicted: { reads, likes, collects, comments, engagementRate },
    signals,
    directions,
    guide: aggregateGuide(list, quality),
    modelCount: list.length,
    spread,
    ts: Number.isFinite(options?.now) ? options.now : Date.now(),
  }
}

/* ------------------------------------------------------------------ *
 * public: 一键整改 (revision) — the one model-written finished draft
 * ------------------------------------------------------------------ */

/** Revision field budgets (DESIGN.md). */
const REVISION_COVER_CHARS = 16
const REVISION_IMAGES_CHARS = 60
const REVISION_SUMMARY_CHARS = 60

/**
 * One-line revision field. Arrays of strings are joined so a model that answers
 * with a list still produces usable copy.
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function revisionLine(value, max) {
  if (Array.isArray(value)) {
    const joined = value.filter((entry) => typeof entry === 'string' && entry.trim() !== '').join('；')
    return clampText(joined, max)
  }
  return clampText(value, max)
}

/**
 * Revision body keeps its paragraph breaks — structure is part of the deliverable
 * — so only line endings, trailing spaces and the outer whitespace are touched.
 * @param {unknown} value
 * @returns {string}
 */
function revisionBody(value) {
  const raw = text(value)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
  return raw.length > LIMITS.body ? raw.slice(0, LIMITS.body).trim() : raw
}

/**
 * Find the revision payload inside a model reply.
 * @param {unknown} parsed
 * @returns {object}
 */
function unwrapRevision(parsed) {
  if (Array.isArray(parsed)) return isRecord(parsed[0]) ? parsed[0] : {}
  if (!isRecord(parsed)) return {}
  const looksLikeRevision = (value) =>
    isRecord(value) &&
    ['title', 'body', 'tags', 'cover', 'images', 'summary', '标题', '正文', '标签'].some(
      (key) => value[key] !== undefined,
    )
  if (looksLikeRevision(parsed)) return parsed
  for (const key of ['revision', 'revised', 'result', 'data', 'draft', 'output', '整改稿']) {
    if (looksLikeRevision(parsed[key])) return parsed[key]
  }
  return parsed
}

/**
 * Normalize the model's 整改稿 into the frozen Revision shape.
 *
 * This is the only place in the product where a model writes publishable copy,
 * so the contract is deliberately forgiving: a missing or empty `title`, `body`
 * or `tags` falls back to the draft the user supplied, and every field is
 * hard-clamped (title 20, body 1000 with paragraph breaks preserved, tags 10,
 * cover 16, images 60, summary 60). It never returns null.
 *
 * @param {unknown} parsed - parsed JSON reply (or anything, really).
 * @param {object} [draft] - the draft that was evaluated (`normalizeInput` output).
 * @returns {{title: string, body: string, tags: string[], cover: string, images: string, summary: string}}
 */
export function normalizeRevision(parsed, draft) {
  const source = unwrapRevision(parsed)
  const fallback = isRecord(draft) ? draft : {}

  let title = clampText(source.title ?? source.headline ?? source['标题'], LIMITS.title)
  if (title === '') title = clampText(fallback.title ?? fallback['标题'], LIMITS.title)

  let body = revisionBody(source.body ?? source.content ?? source.text ?? source['正文'])
  if (body === '') body = revisionBody(fallback.body ?? fallback['正文'])

  let tags = normalizeTags(source.tags ?? source.hashtags ?? source.topics ?? source['标签'] ?? source['话题'])
  if (tags.length === 0) tags = normalizeTags(fallback.tags ?? fallback['标签'])

  return {
    title,
    body,
    tags,
    cover: revisionLine(
      source.cover ?? source.coverText ?? source.cover_copy ?? source['封面'] ?? source['封面文案'],
      REVISION_COVER_CHARS,
    ),
    images: revisionLine(
      source.images ?? source.imageTips ?? source.imageAdvice ?? source['内部图'] ?? source['图片'] ?? source['配图'],
      REVISION_IMAGES_CHARS,
    ),
    summary: revisionLine(
      source.summary ?? source.changes ?? source.note ?? source['说明'] ?? source['总结'] ?? source['改动'],
      REVISION_SUMMARY_CHARS,
    ),
  }
}
