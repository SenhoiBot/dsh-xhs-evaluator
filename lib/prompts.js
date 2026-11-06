/**
 * Prompt layer for the 小红书 note evaluator.
 *
 * Two prompts, both "one call, one JSON object":
 *  - `evaluatePrompt` — the advisory pass. The whole product promise
 *    ("只给方向，绝不代写") lives here as much as in `sanitizeDirections`: the
 *    model is a strategist, not a ghostwriter.
 *  - `revisePrompt` — 一键整改, the one place where a *finished draft* is asked
 *    for, because the user explicitly requested it. It must stay inside the
 *    facts of the original note.
 *
 * No imports: this module only formats strings.
 */

/** Field budgets mirrored from lib/evaluate.js LIMITS. */
const LIMITS = Object.freeze({ title: 20, body: 1000, tags: 10, niche: 40 })

/** How many fans-tier rows the model is given as calibration anchors. */
const FANS_TIERS = Object.freeze([
  ['新号 / <1000 粉', '阅读 150-3000，点赞 5-120，收藏 3-90，评论 0-15'],
  ['1k-1w 粉', '阅读 400-8000，点赞 15-400，收藏 10-300，评论 1-40'],
  ['1w-10w 粉', '阅读 2000-40000，点赞 60-2000，收藏 40-1500，评论 5-200'],
  ['10w-100w 粉', '阅读 6000-150000，点赞 150-6000，收藏 100-4000，评论 20-600'],
  ['100w+ 粉', '阅读 20000-500000，点赞 500-20000，收藏 300-12000，评论 60-2000'],
])

export const SYSTEM_PROMPT = [
  '你是一位资深的小红书内容策略分析师，长期研究图文笔记的流量分发机制、爆款结构与人群心理。你不写笔记，也不替作者写笔记：你的价值在于判断与方向。',
  '',
  '任务：评估作者准备发布的一条小红书图文笔记，预测它发布后的数据区间，并指出真正值得改的地方。',
  '',
  '评估维度（逐项过一遍，不要遗漏）：',
  '1. 标题钩子：标题在前 8-10 个字内是否给出明确利益点、痛点或反差；是否过于抽象、书面、自嗨。',
  '2. 封面信息量：从正文推断封面能承载什么信息（大字标题、对比、成果前后、人物/场景），是否一眼能看懂主题。',
  '3. 正文结构与留白：开头是否承接标题、是否分段、是否给视觉留白、是否把结论与细节的顺序排对。',
  '4. 收藏价值：有没有可复用的清单、步骤、参数、避坑点；信息密度是否撑得起「先收藏再说」。',
  '5. 情绪与共鸣：是否有具体的人称、场景、情绪落点，而不是通篇说明文。',
  '6. 人群与场景锚点：是否能让目标人群一眼认出「这是说给我听的」，场景是否具体到可想象。',
  '7. 赛道竞争度：这个话题在该赛道是否已经被写烂，是否只有同质化表达。',
  '8. 标签覆盖：话题标签是否覆盖核心词 + 长尾场景词，是否堆砌无关热词。',
  '',
  '硬性规则：',
  '1. 只输出一个 JSON 对象。不要 markdown 围栏，不要解释，不要开场白或结尾寒暄。',
  '2. 绝不代写。你的输出是「问题 + 调整方向」，不是改写后的文案。',
  '3. 禁止输出可以直接复制发布的标题、开头句、段落或整句文案；禁止引用超过 40 字的成稿片段。需要说明时用方向描述，例如「把核心痛点前移到前 8 个字」，而不是给出具体句子。',
  '4. 唯一例外是 guide.sections[].example：它是一条「举例」，用于说明「按这个方向改会长什么样」。每条最多一句、≤50 字，不能是整段成稿；前端会把它渲染成全角括注「（例：…）」。',
  '5. 数值必须符合小红书真实生态：阅读量远大于点赞，互动率是个位数到十几个百分点，新号不要给出几十万阅读。',
  '6. 不确定就压低 confidence，不要为了显得专业而编造数据或承诺爆款。',
  '7. 修改指引（guide）要说清「标题 / 封面 / 内部图 / 文字内容 / 标签」各自该怎么选：给标准、给取舍、给避坑，而不是替作者写完。',
  '8. 所有文本用简体中文。',
].join('\n')

/**
 * Clamp a value to one trimmed line of at most `max` characters.
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function line(value, max) {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  const clean = String(value).replace(/\s+/g, ' ').trim()
  return clean.length > max ? clean.slice(0, max) : clean
}

/**
 * Body text keeps its paragraph structure — structure is one of the dimensions
 * being judged — so only line endings and outer whitespace are normalized.
 * @param {unknown} value
 * @returns {string}
 */
function body(value) {
  if (typeof value !== 'string') return ''
  const clean = value.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim()
  return clean.length > LIMITS.body ? clean.slice(0, LIMITS.body).trim() : clean
}

/** The exact JSON contract, repeated to the model verbatim. */
const OUTPUT_SCHEMA = [
  '{',
  '  "reads":    {"low": 整数, "high": 整数},',
  '  "likes":    {"low": 整数, "high": 整数},',
  '  "collects": {"low": 整数, "high": 整数},',
  '  "comments": {"low": 整数, "high": 整数},',
  '  "engagementRate": 0到1之间的小数,',
  '  "quality": 0到100的整数,',
  '  "confidence": 0到1之间的小数,',
  '  "summary": "30-60字的一句话结论",',
  '  "signals": [{"label": "维度名，≤8字", "level": "good|warn|bad", "note": "≤24字"}],',
  '  "directions": [{"title": "≤10字", "why": "问题，≤40字", "action": "调整方向，≤60字"}],',
  '  "guide": {',
  '    "intro": "≤40字：这次最该先改的一件事",',
  '    "sections": [',
  '      {"key": "title",  "name": "标题",     "advice": "≤90字：标题怎么选", "example": "≤50字：一条可照改的标题举例"},',
  '      {"key": "cover",  "name": "封面",     "advice": "≤90字：封面怎么选", "example": "≤50字：封面大字/画面举例"},',
  '      {"key": "images", "name": "内部图",   "advice": "≤90字：内部图怎么选", "example": "≤50字：构图/张数举例"},',
  '      {"key": "text",   "name": "文字内容", "advice": "≤90字：正文怎么改", "example": "≤50字：一句话举例，不得是整段"},',
  '      {"key": "tags",   "name": "标签",     "advice": "≤90字：标签怎么选", "example": "≤50字：标签组合举例"}',
  '    ]',
  '  }',
  '}',
].join('\n')

/**
 * Build the evaluation request for one note.
 *
 * @param {object} input - normalized input (`normalizeInput` output).
 * @param {string} [input.title]
 * @param {string} [input.body]
 * @param {string[]} [input.tags]
 * @param {string} [input.niche] - 赛道/category.
 * @param {string} [input.fans] - 粉丝量级, free text.
 * @returns {{system: string, user: string}}
 */
export function evaluatePrompt(input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const title = line(source.title, LIMITS.title)
  const noteBody = body(source.body)
  const tags = (Array.isArray(source.tags) ? source.tags : [])
    .map((tag) => line(tag, 30).replace(/^#+/, ''))
    .filter((tag) => tag !== '')
    .slice(0, LIMITS.tags)
  const niche = line(source.niche, LIMITS.niche)
  const fans = line(source.fans, 32) || '未提供（请按 1k-1w 粉保守估计）'

  const tierLines = FANS_TIERS.map(([tier, range]) => `- ${tier}：${range}`)

  const user = [
    '请评估下面这条待发布的小红书图文笔记，并预测它的发布数据。',
    '',
    '【笔记内容】',
    `目标平台：小红书图文笔记（标题 + 封面 + 正文 + 话题标签）`,
    `标题（${title.length} 字）：${title !== '' ? title : '（未填写）'}`,
    `正文（${noteBody.length} 字）：`,
    noteBody !== '' ? noteBody : '（未填写）',
    `话题标签：${tags.length > 0 ? tags.map((tag) => `#${tag}`).join(' ') : '（未提供）'}`,
    `赛道/领域：${niche !== '' ? niche : '（未提供）'}`,
    `粉丝量级：${fans}`,
    '',
    '【输出格式】只输出一个 JSON 对象，键名与类型必须完全如下，不要增减键、不要嵌套额外结构：',
    OUTPUT_SCHEMA,
    '',
    '【字段口径】',
    '1. reads / likes / collects / comments 用整数，且 low <= high；这是一个预测区间，不是精确值。',
    '2. engagementRate =（点赞 + 收藏 + 评论）/ 阅读，取 0-1 之间的小数（例如 0.05）。',
    '3. quality 是 0-100 的整数，代表内容综合质量：≥82 有爆款相；70-81 中上；55-69 中规中矩；40-54 偏弱；<40 很差。',
    '4. confidence 是 0-1 的小数，表示你对本次判断的把握。信息不足时要压低。',
    '5. summary 30-60 字，一句话说清最关键的问题或亮点，不要复述笔记内容。',
    '6. signals 最多 6 条，覆盖你看过的主要维度；label ≤8 字（如 标题钩子 / 封面信息量 / 收藏价值），level 只能是 good、warn、bad，note ≤24 字。',
    '7. directions 最多 5 条：title ≤10 字；why 说明问题是什么（≤40 字）；action 说明往哪个方向调整（≤60 字）。当 quality < 55（偏弱/很差）时至少给 1 条。',
    '8. guide 是「修改指引」：sections 固定五个，key 与 name 必须照抄上面给出的顺序与文字，不可增减、不可换序；advice 不可为空。',
    '9. guide 的 advice 必须结合本次评估结论（呼应 verdict 与主要 signals），讲清「怎么选/怎么改」：人群、场景、句式、信息层级、数量、避坑，≤90 字。',
    '10. guide 的 example 是一条可照着改的举例，≤50 字，可以省略某条 example，但给了就只能给一条，不要罗列多条。',
    '',
    '【修改指引（guide）——全文唯一允许出现具体文案的地方】',
    '它只作为「举例」存在，不是代写：',
    '- 五个 section 固定为 title 标题 / cover 封面 / images 内部图 / text 文字内容 / tags 标签。',
    '- 每条 advice 针对这条笔记的实际情况写，不要泛泛而谈；先说问题，再说下一次按什么标准选。',
    '- example 给一句话样例：标题样例、封面大字样例、内页图构图样例、正文开头一句样例、标签组合样例。',
    '- 前端会把 example 统一渲染成全角括注「（例：…）」，所以你直接给裸示例即可，不要自己加括号、不要加「例：」前缀。',
    '- text（文字内容）的 example 最多一句话，绝不允许整段成稿；其余 section 的 example 同样只能是一条。',
    '- 除 example 之外的所有字段仍然只给方向、不代写，不要输出可直接发布的整段文案。',
    '',
    '【数值量级必须符合小红书真实生态】',
    '按粉丝量级校准阅读区间（这是常见区间，不是硬上限）：',
    ...tierLines,
    '- 补充常识：阅读量通常远大于点赞；点赞率（点赞/阅读）常见 1%-8%，收藏率 0.5%-6%，评论率 0.1%-2%；互动率常见 3%-12%。',
    '- 新号（<1000 粉）除非选题与标题都极强，不要给出几十万阅读；粉丝量级越高，区间越宽。',
    '- 若粉丝量级无法识别，按 1k-1w 粉保守估计，并相应压低 confidence。',
    '',
    '【红线：只给方向，绝不代写（guide.example 是唯一例外）】',
    '1. directions 是「问题 + 调整方向」，不是改写文案。',
    '2. 除 guide.sections[].example 这一处「举例」外，禁止输出可以直接发布的标题、开头句、段落或整句文案，禁止给出任何可复制粘贴的成稿片段。',
    '3. 不要用引号包裹超过 40 字的改写内容；需要说明时描述方向（如「把痛点前移到前 8 个字」「正文按三段拆开」），不要给出具体句子。',
    '4. 不要编造与这条笔记无关的数据，也不要承诺一定会爆。',
  ].join('\n')

  return { system: SYSTEM_PROMPT, user }
}

/* ------------------------------------------------------------------ *
 * 一键整改 (revision) — the one prompt that asks for finished copy
 * ------------------------------------------------------------------ */

/** Revision budgets, mirrored from lib/evaluate.js / DESIGN.md. */
const REVISION_TITLE_CHARS = LIMITS.title
const REVISION_BODY_CHARS = LIMITS.body
const REVISION_TAG_COUNT = LIMITS.tags
const REVISION_COVER_CHARS = 16
const REVISION_IMAGES_CHARS = 60
const REVISION_SUMMARY_CHARS = 60
/** How much of the evaluation we forward into the revision prompt. */
const REVISION_SIGNALS = 6
const REVISION_DIRECTIONS = 5
const REVISION_GUIDE_SECTIONS = 5

/** Human labels for the predicted ranges. */
const PREDICTED_LABELS = Object.freeze({
  reads: '阅读',
  likes: '点赞',
  collects: '收藏',
  comments: '评论',
})

const REVISE_SYSTEM_PROMPT = [
  '你是资深的小红书图文作者兼内容策略分析师。作者已经拿到一份评估报告，现在请你按报告的结论与修改指引，把原稿改成一版可以直接发布的成稿。',
  '',
  '硬性要求：',
  '1. 只输出一个 JSON 对象。不要 markdown 围栏，不要解释，不要开场白或结尾寒暄。',
  '2. 这是成稿：标题、正文、标签都必须能直接发布。不要出现「建议」「可以试试」「修改方向」这类评估语气，整篇就是作者要发布的作品。',
  '3. 必须延续原稿的主题、事实、人称与作者身份。不得编造型号、价格、参数、数据、使用时长或亲身经历；原稿没有的具体信息一律不要新增，需要时改用更通用的表述。',
  '4. 保留原稿已经写对的信息与语气；只按评估指出的问题调整钩子、结构、场景锚点、信息层级与标签。',
  '5. 正文保留分段换行（JSON 字符串里用 \\n），3-6 段为宜，每段不超过三行，给视觉留白。',
  '6. 标签不带 #，只给词；核心词 + 场景词 + 人群词，最多 10 个，不要堆无关热词。',
  '7. cover 是封面大字文案（≤16 字），images 是内部图建议（拍什么/几张/顺序，≤60 字），summary 说明这次改了什么（≤60 字）。',
  '8. 所有文本用简体中文。',
].join('\n')

/**
 * Render the evaluation into compact lines the revision can follow.
 * @param {unknown} report - `Report` (or anything).
 * @returns {string[]}
 */
function describeReport(report) {
  if (report === null || typeof report !== 'object') {
    return ['（没有可用的评估结论，请只按通用的小红书标准整改）']
  }
  const lines = []
  const verdictLabel = line(report.verdictLabel, 24)
  const verdict = line(report.verdict, 24)
  const confidence = Number(report.confidence)
  let head = `结论：${verdictLabel !== '' ? verdictLabel : verdict !== '' ? verdict : '未提供'}`
  if (verdictLabel !== '' && verdict !== '') head += `（${verdict}）`
  if (Number.isFinite(confidence)) head += `，置信度 ${confidence}`
  lines.push(head)

  const summary = line(report.summary, 200)
  if (summary !== '') lines.push(`一句话结论：${summary}`)

  const predicted = report.predicted
  if (predicted !== null && typeof predicted === 'object') {
    const ranges = Object.entries(PREDICTED_LABELS)
      .map(([key, label]) => {
        const range = predicted[key]
        if (range === null || typeof range !== 'object') return ''
        const low = Number(range.low)
        const high = Number(range.high)
        if (!Number.isFinite(low) || !Number.isFinite(high)) return ''
        return `${label} ${low}-${high}`
      })
      .filter((range) => range !== '')
    if (ranges.length > 0) lines.push(`预测：${ranges.join('、')}`)
  }

  const signals = Array.isArray(report.signals) ? report.signals.slice(0, REVISION_SIGNALS) : []
  const signalLines = signals
    .map((signal) => {
      const label = line(signal?.label, 20)
      if (label === '') return ''
      const level = line(signal?.level, 8)
      const note = line(signal?.note, 60)
      return `- ${label}${level !== '' ? ` [${level}]` : ''}${note !== '' ? `：${note}` : ''}`
    })
    .filter((entry) => entry !== '')
  if (signalLines.length > 0) lines.push('主要信号：', ...signalLines)

  const directions = Array.isArray(report.directions) ? report.directions.slice(0, REVISION_DIRECTIONS) : []
  const directionLines = directions
    .map((direction) => {
      const title = line(direction?.title, 10)
      if (title === '') return ''
      const why = line(direction?.why, 60)
      const action = line(direction?.action, 90)
      const tail = [why, action].filter((part) => part !== '').join(' → ')
      return `- ${title}${tail !== '' ? `：${tail}` : ''}`
    })
    .filter((entry) => entry !== '')
  if (directionLines.length > 0) lines.push('调整方向：', ...directionLines)

  const guide = report.guide
  if (guide !== null && typeof guide === 'object') {
    const intro = line(guide.intro, 80)
    if (intro !== '') lines.push(`修改指引总述：${intro}`)
    const sections = Array.isArray(guide.sections) ? guide.sections.slice(0, REVISION_GUIDE_SECTIONS) : []
    const sectionLines = sections
      .map((section) => {
        const name = line(section?.name, 16)
        const advice = line(section?.advice, 120)
        if (name === '' || advice === '') return ''
        const example = line(section?.example, 60)
        return `- ${name}：${advice}${example !== '' ? `（例：${example}）` : ''}`
      })
      .filter((entry) => entry !== '')
    if (sectionLines.length > 0) lines.push('修改指引：', ...sectionLines)
  }

  return lines.length > 0 ? lines : ['（评估结论为空，请只按通用的小红书标准整改）']
}

/**
 * Build the 一键整改 request: rewrite this draft into a publishable note, using
 * the conclusions and 修改指引 from the evaluation.
 *
 * Unlike `evaluatePrompt`, this one asks for finished copy — that is the whole
 * point of the button — but the system prompt keeps the model inside the facts
 * of the original note so it cannot invent a product, a price or an experience.
 *
 * @param {object} options
 * @param {object} options.draft - the evaluated draft (`normalizeInput` output).
 * @param {object | null} options.report - the `Report` the user is looking at.
 * @returns {{system: string, user: string}}
 */
export function revisePrompt({ draft, report } = {}) {
  const source = draft !== null && typeof draft === 'object' ? draft : {}
  const title = line(source.title, REVISION_TITLE_CHARS)
  const noteBody = body(source.body)
  const tags = (Array.isArray(source.tags) ? source.tags : [])
    .map((tag) => line(tag, 30).replace(/^#+/, ''))
    .filter((tag) => tag !== '')
    .slice(0, REVISION_TAG_COUNT)
  const niche = line(source.niche, LIMITS.niche)
  const fans = line(source.fans, 32) || '未提供'

  const user = [
    '【原稿】',
    `标题（${title.length} 字）：${title !== '' ? title : '（未填写）'}`,
    `正文（${noteBody.length} 字）：`,
    noteBody !== '' ? noteBody : '（未填写）',
    `标签：${tags.length > 0 ? tags.map((tag) => `#${tag}`).join(' ') : '（未提供）'}`,
    `赛道/领域：${niche !== '' ? niche : '（未提供）'}`,
    `粉丝量级：${fans}`,
    '',
    '【本次评估结论】',
    ...describeReport(report),
    '',
    '【任务】按上面的结论与修改指引，把原稿改成一版可直接发布的小红书图文笔记成稿。只输出一个 JSON 对象，键与类型如下，不要增减键：',
    '{',
    `  "title": "≤${REVISION_TITLE_CHARS}字：整改后的标题",`,
    `  "body": "≤${REVISION_BODY_CHARS}字：整改后的正文，保留分段换行（\\n）",`,
    `  "tags": ["≤${REVISION_TAG_COUNT}个：整改后的标签，不带 #"],`,
    `  "cover": "≤${REVISION_COVER_CHARS}字：封面大字文案",`,
    `  "images": "≤${REVISION_IMAGES_CHARS}字：内部图建议（拍什么/几张/顺序）",`,
    `  "summary": "≤${REVISION_SUMMARY_CHARS}字：这次改了什么"`,
    '}',
    '',
    '提醒：正文的每个事实都能在原稿里找到出处，不要为了「更好」而添加原稿没有的信息。',
  ].join('\n')

  return { system: REVISE_SYSTEM_PROMPT, user }
}
