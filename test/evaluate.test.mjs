import test from 'node:test'
import assert from 'node:assert/strict'

import {
  GUIDE_SECTIONS,
  LIMITS,
  aggregateReport,
  formatCount,
  normalizeGuide,
  normalizeInput,
  normalizeModelReport,
  normalizeRevision,
  sanitizeDirections,
  spreadOf,
  verdictOf,
} from '../lib/evaluate.js'

/**
 * A complete, well-formed model reply used as the baseline fixture.
 * @param {object} [overrides]
 * @returns {object}
 */
function modelReport(overrides = {}) {
  return {
    reads: { low: 1000, high: 3000 },
    likes: { low: 30, high: 90 },
    collects: { low: 20, high: 60 },
    comments: { low: 2, high: 8 },
    engagementRate: 0.05,
    quality: 75,
    confidence: 0.8,
    summary: '标题钩子明确，正文留白不足。',
    signals: [
      { label: '标题钩子', level: 'good', note: '痛点明确' },
      { label: '正文留白', level: 'warn', note: '整段太密' },
    ],
    directions: [{ title: '正文留白', why: '整段太密', action: '每段压到三行以内' }],
    ...overrides,
  }
}

/* ------------------------------------------------------------------ *
 * LIMITS / normalizeInput
 * ------------------------------------------------------------------ */

test('LIMITS matches the frozen contract', () => {
  assert.deepEqual({ ...LIMITS }, { title: 20, body: 1000, tags: 10, niche: 40 })
})

test('normalizeInput clamps title/niche, keeps body lines and fills defaults', () => {
  const input = normalizeInput({
    title: '  这篇笔记的标题显然超过了二十个字的上限需要被截断  ',
    body: '  正文第一行\r\n第二行  ',
    tags: ['#护肤', '护肤', ' 通勤 ', '', 'a'.repeat(40)],
    niche: 'x'.repeat(60),
    fans: '1k-1w',
    models: 9,
  })

  assert.equal(input.title.length, LIMITS.title)
  assert.ok(input.title.startsWith('这篇笔记的标题显然超过'))
  assert.equal(input.body, '正文第一行\n第二行')
  assert.deepEqual(input.tags, ['护肤', '通勤', 'a'.repeat(30)])
  assert.equal(input.niche.length, LIMITS.niche)
  assert.equal(input.fans, '1k-1w')
  assert.equal(input.models, 3)
})

test('normalizeInput accepts a comma/space separated tag string', () => {
  const input = normalizeInput({ body: '正文', tags: '#护肤, 通勤 穿搭 护肤' })
  assert.deepEqual(input.tags, ['护肤', '通勤', '穿搭'])
})

test('normalizeInput leaves an empty body empty so the route can reject it', () => {
  assert.equal(normalizeInput({ title: 't', body: '   ' }).body, '')
  assert.equal(normalizeInput(null).body, '')
  assert.deepEqual(normalizeInput(undefined).tags, [])
  assert.equal(normalizeInput('not an object').models, 2)
})

test('normalizeInput clamps models to 1..3 with a default of 2', () => {
  assert.equal(normalizeInput({ body: 'b' }).models, 2)
  assert.equal(normalizeInput({ body: 'b', models: 0 }).models, 1)
  assert.equal(normalizeInput({ body: 'b', models: 1 }).models, 1)
  assert.equal(normalizeInput({ body: 'b', models: '2' }).models, 2)
  assert.equal(normalizeInput({ body: 'b', models: 2.6 }).models, 3)
  assert.equal(normalizeInput({ body: 'b' }, 3).models, 3)
})

test('normalizeInput truncates the body at the limit', () => {
  const input = normalizeInput({ body: '正'.repeat(1400) })
  assert.equal(input.body.length, LIMITS.body)
})

/* ------------------------------------------------------------------ *
 * normalizeModelReport tolerance
 * ------------------------------------------------------------------ */

test('normalizeModelReport tolerates alternate names, strings, ranges and percents', () => {
  const report = normalizeModelReport({
    data: {
      predicted: {
        reads: '1200-5200',
        likes: { min: 40, max: 190 },
        collects: [25, 130],
        comments: 8,
      },
      engagement_rate: '4.3%',
      score: 0.72,
      certainty: 0.8,
      conclusion: '  标题钩子够强，收藏价值一般。 ',
      signals: [
        { name: '标题钩子', status: 'positive', detail: '痛点明确' },
        { name: '收藏价值', status: 'bad', detail: '信息密度低' },
        { dimension: '人群场景', level: 'so-so', note: '场景偏泛' },
      ],
      suggestions: [
        { name: '标题钩子', reason: '痛点不够靠前', fix: '把核心痛点前移到前八个字' },
        { heading: '收藏价值', reason: '信息密度低', action: '补一个可复用的清单结构' },
      ],
    },
  })

  assert.deepEqual(report.reads, { low: 1200, high: 5200 })
  assert.deepEqual(report.likes, { low: 40, high: 190 })
  assert.deepEqual(report.collects, { low: 25, high: 130 })
  assert.deepEqual(report.comments, { low: 5, high: 13 })
  assert.equal(report.engagementRate, 0.043)
  assert.equal(report.quality, 72)
  assert.equal(report.confidence, 0.8)
  assert.equal(report.summary, '标题钩子够强，收藏价值一般。')
  assert.deepEqual(
    report.signals.map((signal) => signal.level),
    ['good', 'bad', 'warn'],
  )
  assert.equal(report.directions.length, 2)
  assert.equal(report.directions[0].action, '把核心痛点前移到前八个字')
})

test('normalizeModelReport clamps field budgets and counts', () => {
  const report = normalizeModelReport({
    quality: 130,
    confidence: 0.99,
    engagementRate: 0.5,
    summary: 's'.repeat(200),
    signals: Array.from({ length: 9 }, (_, index) => ({
      label: `信号${index}`,
      level: 'good',
      note: 'n'.repeat(40),
    })),
    directions: Array.from({ length: 8 }, (_, index) => ({
      title: `方向标题${index}${'x'.repeat(20)}`,
      why: 'w'.repeat(80),
      action: `动作${'a'.repeat(100)}`,
    })),
  })

  assert.equal(report.quality, 100)
  assert.equal(report.confidence, 0.99)
  assert.equal(report.summary.length, 120)
  assert.equal(report.signals.length, 6)
  assert.equal(report.signals[0].note.length, 24)
  assert.equal(report.directions.length, 5)
  assert.equal(report.directions[0].title.length, 10)
  assert.equal(report.directions[0].why.length, 40)
  assert.equal(report.directions[0].action.length, 60)
})

test('normalizeModelReport is total over arbitrary JSON', () => {
  for (const input of [null, undefined, 'nope', 42, [], {}, { reads: 'nope' }, { quality: 'bad' }, { guide: 42 }]) {
    assert.doesNotThrow(() => normalizeModelReport(input))
    const report = normalizeModelReport(input)
    assert.ok(Number.isInteger(report.quality), 'quality must stay an integer')
    assert.ok(Array.isArray(report.signals) && Array.isArray(report.directions))
    assert.ok(report.guide === null || typeof report.guide === 'object')
  }
})

/* ------------------------------------------------------------------ *
 * 修改指引 guide — 允许举例，但示例要短且可辨识
 * ------------------------------------------------------------------ */

test('GUIDE_SECTIONS keeps the frozen order and Chinese names', () => {
  assert.deepEqual(
    GUIDE_SECTIONS.map((section) => [section.key, section.name]),
    [
      ['title', '标题'],
      ['cover', '封面'],
      ['images', '内部图'],
      ['text', '文字内容'],
      ['tags', '标签'],
    ],
  )
  assert.ok(Object.isFrozen(GUIDE_SECTIONS))
})

test('normalizeGuide normalizes an English-keyed sections array', () => {
  const guide = normalizeGuide({
    intro: '先把标题的场景补具体',
    sections: [
      { key: 'title', name: '标题', advice: '把人群 + 场景写进前 8 个字，避免抽象形容词', example: '通勤党必看：包里这三样' },
      { key: 'cover', advice: '封面用大字标题，字数控制在 12 字内' },
      { key: 'images', advice: '内部图按步骤排列，首图直接给结果' },
      { key: 'text', advice: '正文前两句承接标题，每段不超过三行' },
      { key: 'tags', advice: '核心词加两个长尾场景词，不堆无关热词' },
    ],
  })

  assert.equal(guide.intro, '先把标题的场景补具体')
  assert.deepEqual(
    guide.sections.map((section) => section.key),
    ['title', 'cover', 'images', 'text', 'tags'],
  )
  assert.deepEqual(
    guide.sections.map((section) => section.name),
    ['标题', '封面', '内部图', '文字内容', '标签'],
  )
  assert.equal(guide.sections[0].example, '通勤党必看：包里这三样')
  assert.equal('example' in guide.sections[1], false, 'a missing example is omitted, not empty')
})

test('normalizeGuide tolerates Chinese keys, object maps and the 修改指引 wrapper', () => {
  const guide = normalizeGuide({
    修改指引: {
      intro: '先把封面信息量提上来',
      标题: '标题前 8 字给利益点，别用形容词开场',
      封面: { 建议: '一张图说明结果，大字不超过 12 字', 示例: '三步收纳法' },
      内部图: '按步骤拆开，每步一张图',
      文字内容: { advice: '正文每段不超过三行', example: '我试了 7 天，结果是这样' },
      标签: '核心词 + 长尾词 + 人群词',
    },
  })

  assert.equal(guide.intro, '先把封面信息量提上来')
  assert.deepEqual(
    guide.sections.map((section) => section.key),
    ['title', 'cover', 'images', 'text', 'tags'],
  )
  assert.equal(guide.sections[1].advice, '一张图说明结果，大字不超过 12 字')
  assert.equal(guide.sections[1].example, '三步收纳法')
  assert.equal(guide.sections[3].example, '我试了 7 天，结果是这样')
})

test('normalizeGuide hard-clamps intro/advice/example and drops unusable sections', () => {
  const guide = normalizeGuide({
    intro: 'i'.repeat(80),
    sections: [
      { key: '标题', advice: 'a'.repeat(140), example: 'e'.repeat(80) },
      { key: 'cover', advice: 'b'.repeat(100) },
      { key: '文字内容', advice: '正文段落建议', example: '一句示例' },
      { key: 'unknown-section', advice: '这条应该被丢弃' },
      { key: 'tags', advice: '   ' },
    ],
  })

  assert.equal(guide.intro.length, 40)
  assert.deepEqual(
    guide.sections.map((section) => section.key),
    ['title', 'cover', 'text'],
  )
  assert.equal(guide.sections[0].advice.length, 90)
  assert.equal(guide.sections[0].example.length, 50)
})

test('normalizeGuide returns null when there is nothing usable', () => {
  for (const input of [null, undefined, '', '只有一句总述', {}, { intro: '只有总述没有分节' }, { sections: [] }]) {
    assert.equal(normalizeGuide(input), null)
  }
  assert.equal(normalizeGuide({ sections: [{ key: 'unknown', advice: 'x' }] }), null)
  assert.equal(normalizeGuide({ sections: [{ key: 'title', advice: '   ' }] }), null)

  // A partial guide survives on the ModelReport; aggregateReport decides whether
  // the merged result has enough sections.
  const partial = normalizeGuide({
    sections: [
      { key: 'title', advice: '把场景写具体' },
      { key: 'cover', advice: '封面给结果' },
    ],
  })
  assert.equal(partial.sections.length, 2)
})

test('normalizeModelReport carries guide and defaults to null', () => {
  assert.equal(normalizeModelReport(modelReport()).guide, null)

  const withGuide = normalizeModelReport({
    ...modelReport(),
    guide: {
      intro: '先改标题',
      sections: [{ key: 'title', advice: '把痛点前移', example: '通勤包三件套' }],
    },
  })
  assert.equal(withGuide.guide.intro, '先改标题')
  assert.deepEqual(
    withGuide.guide.sections.map((section) => section.key),
    ['title'],
  )
})

/* ------------------------------------------------------------------ *
 * aggregateReport — guide 合并
 * ------------------------------------------------------------------ */

test('aggregateReport passes a single model guide through in the fixed order', () => {
  const merged = aggregateReport(
    [
      normalizeModelReport(
        modelReport({
          guide: {
            intro: '先把标题的场景补具体',
            sections: [
              { key: 'tags', advice: '标签给核心词 + 长尾词', example: '通勤 收纳' },
              { key: 'title', advice: '标题写清人群和场景', example: '通勤党必备三样' },
              { key: 'cover', advice: '封面只放结果和数字' },
              { key: 'images', advice: '内部图按步骤排' },
              { key: 'text', advice: '正文每段三行内' },
            ],
          },
        }),
      ),
    ],
    { now: 1 },
  )

  assert.equal(merged.guide.intro, '先把标题的场景补具体')
  assert.deepEqual(
    merged.guide.sections.map((section) => section.key),
    ['title', 'cover', 'images', 'text', 'tags'],
    'model order must not leak into the report',
  )
  assert.equal(merged.guide.sections[3].advice, '正文每段三行内')
})

test('aggregateReport picks the guide nearest the median quality as primary', () => {
  const merged = aggregateReport(
    [
      normalizeModelReport(modelReport({ quality: 90, guide: guideWith('高分') })),
      normalizeModelReport(modelReport({ quality: 60, guide: guideWith('中位') })),
      normalizeModelReport(modelReport({ quality: 20, guide: guideWith('低分') })),
    ],
    { now: 1 },
  )

  assert.equal(merged.verdict, 'average')
  assert.equal(merged.guide.intro, '中位先改标题')
  assert.equal(merged.guide.sections[0].advice, '中位标题写清人群')
})

test('aggregateReport backfills missing sections from other models in route order', () => {
  const merged = aggregateReport(
    [
      normalizeModelReport(
        modelReport({
          quality: 90,
          guide: { intro: '高分', sections: [{ key: 'tags', advice: '高分标签建议' }] },
        }),
      ),
      normalizeModelReport(
        modelReport({
          quality: 60,
          guide: {
            intro: '中位',
            sections: [
              { key: 'title', advice: '主标题建议' },
              { key: 'cover', advice: '主封面建议' },
            ],
          },
        }),
      ),
      normalizeModelReport(
        modelReport({
          quality: 20,
          guide: {
            intro: '低分',
            sections: [
              { key: 'images', advice: '低分内部图建议' },
              { key: 'text', advice: '低分正文建议' },
              { key: 'tags', advice: '低分标签建议' },
            ],
          },
        }),
      ),
    ],
    { now: 1 },
  )

  assert.deepEqual(
    merged.guide.sections.map((section) => section.key),
    ['title', 'cover', 'images', 'text', 'tags'],
  )
  // Route order: the quality-90 model comes before the quality-20 one.
  assert.equal(merged.guide.sections[4].advice, '高分标签建议')
  assert.equal(merged.guide.sections[2].advice, '低分内部图建议')
})

test('aggregateReport hides the guide when fewer than three sections survive', () => {
  const merged = aggregateReport(
    [
      normalizeModelReport(
        modelReport({
          guide: {
            intro: '只有两节',
            sections: [
              { key: 'title', advice: '标题建议' },
              { key: 'cover', advice: '封面建议' },
            ],
          },
        }),
      ),
    ],
    { now: 1 },
  )
  assert.equal(merged.guide, null)
})

test('aggregateReport hard-clamps merged guide fields', () => {
  const merged = aggregateReport(
    [
      normalizeModelReport(
        modelReport({
          guide: {
            intro: 'i'.repeat(60),
            sections: [
              { key: 'title', advice: 'a'.repeat(120), example: 'e'.repeat(70) },
              { key: 'cover', advice: '封面建议' },
              { key: 'text', advice: '正文建议' },
            ],
          },
        }),
      ),
    ],
    { now: 1 },
  )

  assert.equal(merged.guide.intro.length, 40)
  assert.equal(merged.guide.sections[0].advice.length, 90)
  assert.equal(merged.guide.sections[0].example.length, 50)
})

/**
 * A complete five-section guide, prefixed so tests can tell models apart.
 * @param {string} [prefix]
 * @returns {object}
 */
function guideWith(prefix = '') {
  return {
    intro: `${prefix}先改标题`,
    sections: [
      { key: 'title', advice: `${prefix}标题写清人群`, example: `${prefix}通勤包三件套` },
      { key: 'cover', advice: `${prefix}封面给结果` },
      { key: 'images', advice: `${prefix}内部图按步骤` },
      { key: 'text', advice: `${prefix}正文每段三行` },
      { key: 'tags', advice: `${prefix}核心词加长尾词` },
    ],
  }
}

/* ------------------------------------------------------------------ *
 * directions sanitizing — 只给方向，绝不代写
 * ------------------------------------------------------------------ */

test('sanitizeDirections drops an action made only of a pasted rewrite', () => {
  const longCopy = '一'.repeat(50)
  const directions = sanitizeDirections([
    { title: '标题钩子', why: '痛点太靠后', action: `建议改成：“${longCopy}”` },
  ])
  assert.deepEqual(directions, [])
})

test('sanitizeDirections strips the rewrite but keeps the directional sentence', () => {
  const longCopy = '一'.repeat(50)
  const directions = sanitizeDirections([
    { title: '标题钩子', why: '痛点太靠后', action: `把痛点前移，不要用“${longCopy}”这种整句` },
  ])
  assert.equal(directions.length, 1)
  assert.ok(directions[0].action.includes('把痛点前移'))
  assert.ok(!directions[0].action.includes('一一一一一一一一一一一一一一一一一一一一'))
})

test('sanitizeDirections keeps plain directions and caps the list at five', () => {
  const kept = sanitizeDirections([{ title: '标题钩子', why: '痛点太靠后', action: '把核心痛点前移到前八个字' }])
  assert.equal(kept.length, 1)

  const many = Array.from({ length: 8 }, (_, index) => ({
    title: `方向${index}`,
    why: `问题${index}`,
    action: `保持信息量并调整方向${index}`,
  }))
  assert.equal(sanitizeDirections(many).length, 5)
  assert.equal(sanitizeDirections('not an array').length, 0)
})

test('normalizeModelReport filters ghostwritten directions out of the report', () => {
  const report = normalizeModelReport({
    quality: 40,
    directions: [
      { title: '标题钩子', why: '痛点太靠后', action: `直接发布：“${'一'.repeat(50)}”` },
      { title: '正文结构', why: '段落太密', action: '每段压到三行以内' },
    ],
  })
  assert.equal(report.directions.length, 1)
  assert.equal(report.directions[0].title, '正文结构')
})

/* ------------------------------------------------------------------ *
 * verdictOf / spreadOf / formatCount
 * ------------------------------------------------------------------ */

test('verdictOf uses the frozen thresholds', () => {
  assert.equal(verdictOf(82).id, 'viral')
  assert.equal(verdictOf(81.9).id, 'strong')
  assert.equal(verdictOf(70).id, 'strong')
  assert.equal(verdictOf(69).id, 'average')
  assert.equal(verdictOf(55).id, 'average')
  assert.equal(verdictOf(54).id, 'weak')
  assert.equal(verdictOf(40).id, 'weak')
  assert.equal(verdictOf(39).id, 'poor')
  assert.equal(verdictOf(Number.NaN).id, 'poor')
  assert.equal(verdictOf(90).label, '有爆款相')
  assert.equal(verdictOf(75).label, '中上')
  assert.equal(verdictOf(60).label, '中规中矩')
  assert.equal(verdictOf(45).label, '偏弱')
  assert.equal(verdictOf(10).label, '很差')
})

test('spreadOf normalizes the reads high-end dispersion', () => {
  assert.equal(spreadOf([]), 0)
  assert.equal(spreadOf([{ reads: { high: 5000 } }]), 0)
  assert.equal(spreadOf([{ reads: { high: 1000 } }, { reads: { high: 2000 } }]), 0.5)
  assert.equal(spreadOf([{ reads: { high: 0 } }, { reads: { high: 0 } }]), 0)
  assert.equal(spreadOf(null), 0)
})

test('formatCount renders 千/万/亿 compactly', () => {
  assert.equal(formatCount(0), '0')
  assert.equal(formatCount(999), '999')
  assert.equal(formatCount(1000), '1k')
  assert.equal(formatCount(1200), '1.2k')
  assert.equal(formatCount(9500), '9.5k')
  assert.equal(formatCount(10000), '1万')
  assert.equal(formatCount(12000), '1.2万')
  assert.equal(formatCount(120000), '12万')
  assert.equal(formatCount(150000000), '1.5亿')
  assert.equal(formatCount(Number.NaN), '0')
  assert.equal(formatCount(null), '0')
})

/* ------------------------------------------------------------------ *
 * aggregateReport
 * ------------------------------------------------------------------ */

test('aggregateReport returns a safe report for no models', () => {
  for (const input of [[], null, undefined, 'nope', [null, 'x', 42]]) {
    const report = aggregateReport(input, { now: 123 })
    assert.equal(report.version, 1)
    assert.equal(report.verdict, 'average')
    assert.equal(report.verdictLabel, '中规中矩')
    assert.equal(report.modelCount, 0)
    assert.equal(report.confidence, 0)
    assert.equal(report.spread, 0)
    assert.equal(report.ts, 123)
    assert.deepEqual(report.predicted.reads, { low: 0, mid: 0, high: 0 })
    assert.deepEqual(report.directions, [])
    assert.deepEqual(report.signals, [])
    assert.equal(report.guide, null)
  }
})

test('aggregateReport merges a single model faithfully', () => {
  const report = aggregateReport([normalizeModelReport(modelReport())], { now: 1 })

  assert.equal(report.version, 1)
  assert.equal(report.modelCount, 1)
  assert.equal(report.verdict, 'strong')
  assert.equal(report.verdictLabel, '中上')
  assert.equal(report.confidence, 0.8)
  assert.equal(report.spread, 0)
  assert.equal(report.ts, 1)
  assert.deepEqual(report.predicted.reads, { low: 1000, mid: 2000, high: 3000 })
  assert.deepEqual(report.predicted.likes, { low: 30, mid: 60, high: 90 })
  assert.equal(report.predicted.engagementRate, 0.05)
  assert.equal(report.summary, '标题钩子明确，正文留白不足。')
  assert.equal(report.signals.length, 2)
  assert.equal(report.directions.length, 1)
})

test('aggregateReport handles models that disagree', () => {
  const optimistic = normalizeModelReport(
    modelReport({
      reads: { low: 1000, high: 2000 },
      quality: 80,
      confidence: 0.9,
      summary: '偏乐观的模型总结。',
      signals: [
        { label: '标题钩子', level: 'good', note: '强' },
        { label: '收藏价值', level: 'bad', note: '弱' },
      ],
      directions: [{ title: '标题钩子', why: '痛点靠后', action: '把痛点前移' }],
    }),
  )
  const pessimistic = normalizeModelReport(
    modelReport({
      reads: { low: 4000, high: 8000 },
      quality: 50,
      confidence: 0.7,
      summary: '偏悲观的模型总结。',
      signals: [
        { label: '标题钩子', level: 'bad', note: '弱' },
        { label: '收藏价值', level: 'bad', note: '弱' },
      ],
      directions: [{ title: '标题钩子', why: '痛点靠后', action: '把痛点前移' }],
    }),
  )

  const report = aggregateReport([optimistic, pessimistic], { now: 42 })

  assert.equal(report.modelCount, 2)
  assert.equal(report.verdict, 'average')
  assert.equal(report.verdictLabel, '中规中矩')
  // min(low) / median(mid) / max(high)
  assert.deepEqual(report.predicted.reads, { low: 1000, mid: 3750, high: 8000 })
  // dispersion of the reads high-end (2000 vs 8000)
  assert.equal(report.spread, 0.75)
  // mean confidence (0.8) scaled by agreement: 0.8 * (1 - 0.55 * 0.75)
  assert.equal(report.confidence, 0.47)
  // majority per label; a good/bad tie never reads as a strength
  assert.equal(report.signals.length, 2)
  assert.equal(report.signals[0].level, 'bad')
  assert.equal(report.signals[1].level, 'bad')
  // directions deduped by title
  assert.equal(report.directions.length, 1)
  assert.equal(report.directions[0].title, '标题钩子')
})

test('aggregateReport synthesizes directions when a weak verdict has none', () => {
  const report = aggregateReport(
    [
      normalizeModelReport({
        reads: { low: 100, high: 300 },
        likes: { low: 2, high: 8 },
        collects: { low: 1, high: 4 },
        comments: { low: 0, high: 1 },
        engagementRate: 0.02,
        quality: 30,
        confidence: 0.6,
        summary: '',
        signals: [
          { label: '标题钩子', level: 'bad', note: '太抽象' },
          { label: '收藏价值', level: 'warn', note: '信息密度低' },
        ],
        directions: [],
      }),
    ],
    { now: 7 },
  )

  assert.equal(report.verdict, 'poor')
  assert.equal(report.verdictLabel, '很差')
  assert.ok(report.directions.length >= 1)
  assert.equal(report.directions[0].title, '标题钩子')
  assert.ok(report.directions[0].action.length > 0)
  assert.ok(report.summary.startsWith('综合判断很差'))
})

test('aggregateReport never throws on hostile input', () => {
  for (const input of [
    [{}],
    [{ reads: 'nope', signals: 'x', directions: 3 }],
    [{ quality: null }],
    [{ guide: 'nope' }],
    [{ guide: { sections: 'nope' } }],
    [{ guide: { sections: [{ key: 'title', advice: { nope: true } }] } }],
    [null, {}, 7],
  ]) {
    assert.doesNotThrow(() => aggregateReport(input))
    const report = aggregateReport(input)
    assert.equal(typeof report.verdict, 'string')
    assert.equal(typeof report.summary, 'string')
    assert.ok(Array.isArray(report.signals))
    assert.ok(Array.isArray(report.directions))
    assert.ok(report.guide === null || typeof report.guide === 'object')
  }
})

/* ------------------------------------------------------------------ *
 * normalizeRevision — 一键整改稿
 * ------------------------------------------------------------------ */

test('normalizeRevision clamps every field to the revision contract', () => {
  const revision = normalizeRevision(
    {
      title: '整改后的标题'.repeat(6),
      body: '改'.repeat(1200),
      tags: ['#通勤', '通勤', '收纳', '', '#好物', ...Array.from({ length: 12 }, (_, index) => `tag${index}`)],
      cover: '封面大字文案'.repeat(5),
      images: '内部图建议'.repeat(20),
      summary: '这次改了什么'.repeat(20),
    },
    { title: '原标题', body: '原正文', tags: ['原标签'] },
  )

  assert.equal(revision.title.length, 20)
  assert.equal(revision.body.length, LIMITS.body)
  assert.equal(revision.tags.length, 10)
  assert.deepEqual(revision.tags.slice(0, 3), ['通勤', '收纳', '好物'])
  assert.equal(revision.cover.length, 16)
  assert.equal(revision.images.length, 60)
  assert.equal(revision.summary.length, 60)
})

test('normalizeRevision preserves paragraph breaks and only trims the edges', () => {
  const revision = normalizeRevision({ body: '  第一段\r\n\r\n 第二段  \n第三段  ' }, {})
  assert.equal(revision.body, '第一段\n\n 第二段\n第三段')
  assert.ok(!revision.body.includes('\r'))
})

test('normalizeRevision falls back to the draft for missing title/body/tags', () => {
  const draft = { title: '原标题', body: '原正文\n第二段', tags: ['原标签'] }

  const missing = normalizeRevision({ cover: '封面大字' }, draft)
  assert.equal(missing.title, '原标题')
  assert.equal(missing.body, '原正文\n第二段')
  assert.deepEqual(missing.tags, ['原标签'])
  assert.equal(missing.cover, '封面大字')
  assert.equal(missing.images, '')
  assert.equal(missing.summary, '')

  const empty = normalizeRevision({ title: '   ', body: '', tags: [] }, draft)
  assert.equal(empty.title, '原标题')
  assert.equal(empty.body, '原正文\n第二段')
  assert.deepEqual(empty.tags, ['原标签'])
})

test('normalizeRevision is total and tolerates wrappers, Chinese keys and arrays', () => {
  const draft = { title: 'D', body: 'B', tags: ['t1'] }
  for (const input of [null, undefined, 'nope', 42, []]) {
    const revision = normalizeRevision(input, draft)
    assert.equal(revision.title, 'D')
    assert.equal(revision.body, 'B')
    assert.deepEqual(revision.tags, ['t1'])
    assert.equal(typeof revision.cover, 'string')
    assert.equal(typeof revision.summary, 'string')
  }

  const wrapped = normalizeRevision(
    {
      revision: {
        标题: '中文标题',
        正文: '中文正文\n二段',
        标签: '#a #b',
        封面: '封面',
        内部图: ['图1', '图2'],
        说明: '改了标题',
      },
    },
    draft,
  )
  assert.equal(wrapped.title, '中文标题')
  assert.equal(wrapped.body, '中文正文\n二段')
  assert.deepEqual(wrapped.tags, ['a', 'b'])
  assert.equal(wrapped.cover, '封面')
  assert.equal(wrapped.images, '图1；图2')
  assert.equal(wrapped.summary, '改了标题')
})

test('normalizeRevision never returns null or a partial object', () => {
  const blank = { title: '', body: '', tags: [], cover: '', images: '', summary: '' }
  assert.deepEqual(normalizeRevision({}, undefined), blank)
  assert.deepEqual(normalizeRevision(null, null), blank)
  assert.deepEqual(normalizeRevision('nope'), blank)
})
