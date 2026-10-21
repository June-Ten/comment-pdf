import { normalizeText, pagesInSpan } from './textIndex.js'

const CONTEXT_CHARS = 32
const FUZZY_MIN_LENGTH = 4
const FUZZY_MAX_LENGTH = 400
const FUZZY_ERROR_RATIO = 0.25

function findAll(view, needle) {
  if (!needle) return []
  const hits = []
  let from = 0
  while (from <= view.text.length - needle.length) {
    const at = view.text.indexOf(needle, from)
    if (at < 0) break
    hits.push({ start: view.from[at], end: view.to[at + needle.length - 1] })
    from = at + needle.length
  }
  return hits
}

// Sellers 算法：在 text 任意位置找与 pattern 编辑距离最小的一段，同时记下这段的起点。
export function approximateSearch(text, pattern, maxErrors) {
  const m = pattern.length
  let prevCost = new Int32Array(m + 1)
  let prevStart = new Int32Array(m + 1)
  let curCost = new Int32Array(m + 1)
  let curStart = new Int32Array(m + 1)
  for (let j = 0; j <= m; j += 1) prevCost[j] = j

  let best = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    curCost[0] = 0
    curStart[0] = i + 1
    for (let j = 1; j <= m; j += 1) {
      let cost = prevCost[j - 1] + (pattern[j - 1] === ch ? 0 : 1)
      let start = prevStart[j - 1]
      if (prevCost[j] + 1 < cost) {
        cost = prevCost[j] + 1
        start = prevStart[j]
      }
      if (curCost[j - 1] + 1 < cost) {
        cost = curCost[j - 1] + 1
        start = curStart[j - 1]
      }
      curCost[j] = cost
      curStart[j] = start
    }
    const cost = curCost[m]
    if (cost <= maxErrors && (!best || cost < best.cost)) {
      best = { cost, start: curStart[m], end: i + 1 }
    }
    ;[prevCost, curCost] = [curCost, prevCost]
    ;[prevStart, curStart] = [curStart, prevStart]
  }
  return best
}

function fuzzyHits(view, needle) {
  if (needle.length < FUZZY_MIN_LENGTH || needle.length > FUZZY_MAX_LENGTH) return []
  const maxErrors = Math.max(1, Math.floor(needle.length * FUZZY_ERROR_RATIO))
  const best = approximateSearch(view.text, needle, maxErrors)
  if (!best || best.end <= best.start) return []
  return [{ start: view.from[best.start], end: view.to[best.end - 1], distance: best.cost }]
}

function contextScore(index, hit, prefix, suffix) {
  let score = 0
  const cleanPrefix = normalizeText(prefix)
  const cleanSuffix = normalizeText(suffix)
  if (cleanPrefix) {
    const before = normalizeText(index.text.slice(Math.max(0, hit.start - CONTEXT_CHARS * 3), hit.start))
    if (before.endsWith(cleanPrefix)) score += 2
    else if (before.includes(cleanPrefix.slice(-8))) score += 1
  }
  if (cleanSuffix) {
    const after = normalizeText(index.text.slice(hit.end, hit.end + CONTEXT_CHARS * 3))
    if (after.startsWith(cleanSuffix)) score += 2
    else if (after.includes(cleanSuffix.slice(0, 8))) score += 1
  }
  return score
}

function positionScore(hit, target) {
  if (typeof target.start !== 'number') return 0
  if (hit.start === target.start && hit.end === target.end) return 10
  return 0
}

/**
 * target: { exact, prefix?, suffix?, start?, end?, page? }
 * 返回 { matches: [{ start, end, pages, confidence }], preferredIndex }
 * confidence: 'exact' 只差空白；'loose' 还忽略了标点和大小写；'fuzzy' 是近似匹配。
 */
export function resolveTarget(index, target) {
  const strictNeedle = normalizeText(target.exact)
  const looseNeedle = normalizeText(target.exact, true)
  let confidence = 'exact'
  let hits = findAll(index.strict, strictNeedle)
  if (!hits.length) {
    confidence = 'loose'
    hits = findAll(index.loose, looseNeedle)
  }
  if (!hits.length) {
    confidence = 'fuzzy'
    hits = fuzzyHits(index.loose, looseNeedle)
  }

  const matches = []
  const scores = []
  for (const hit of hits) {
    const pages = pagesInSpan(index, hit.start, hit.end)
    if (!pages.length) continue
    matches.push({ start: hit.start, end: hit.end, pages, confidence })
    let score = contextScore(index, hit, target.prefix, target.suffix) + positionScore(hit, target)
    if (target.page && pages.includes(target.page)) score += 0.5
    scores.push(score)
  }

  let preferredIndex = 0
  scores.forEach((score, idx) => {
    if (score > scores[preferredIndex]) preferredIndex = idx
  })
  return { matches, preferredIndex }
}

function collapse(text) {
  return text.replace(/\s+/g, ' ')
}

export function targetFromSpan(index, start, end) {
  while (start < end && /\s/.test(index.text[start])) start += 1
  while (end > start && /\s/.test(index.text[end - 1])) end -= 1
  if (start >= end) return null
  return {
    exact: collapse(index.text.slice(start, end)),
    prefix: collapse(index.text.slice(Math.max(0, start - CONTEXT_CHARS * 2), start)).slice(-CONTEXT_CHARS),
    suffix: collapse(index.text.slice(end, end + CONTEXT_CHARS * 2)).slice(0, CONTEXT_CHARS),
    start,
    end,
    page: index.pageOf[start],
  }
}

export function targetKey(target) {
  return [target.exact, target.prefix || '', target.suffix || '', target.start ?? '', target.end ?? ''].join('\u0000')
}
