const WHITESPACE = /\s/u
const PUNCTUATION = /[\p{P}\p{S}]/u

export const NO_ITEM = -1

function furnitureKey(str) {
  return str.normalize('NFKC').replace(/\s+/g, '').replace(/\d+/g, '#')
}

// 大多数页的顶部或底部都重复出现的文字视为页眉页脚。匹配时跳过它们，跨页的句子才不会被页码打断。
export function detectFurniture(pages, { band = 0.08, minRatio = 0.6, minPages = 3 } = {}) {
  if (pages.length < minPages) return pages.map(() => new Set())
  const pagesByKey = new Map()
  const candidates = pages.map((page, pageIdx) => {
    const [, y0, , y1] = page.view
    const height = y1 - y0 || 1
    const list = []
    page.items.forEach((item, itemIdx) => {
      if (!item.str.trim()) return
      const fraction = (item.y - y0) / height
      if (fraction > band && fraction < 1 - band) return
      const key = `${fraction <= band ? 'bottom' : 'top'}:${furnitureKey(item.str)}`
      list.push([itemIdx, key])
      if (!pagesByKey.has(key)) pagesByKey.set(key, new Set())
      pagesByKey.get(key).add(pageIdx)
    })
    return list
  })
  const threshold = Math.max(minPages, Math.ceil(pages.length * minRatio))
  return candidates.map(
    (list) => new Set(list.filter(([, key]) => pagesByKey.get(key).size >= threshold).map(([idx]) => idx)),
  )
}

function eachCodePoint(text, visit) {
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i)
    const len = cp > 0xffff ? 2 : 1
    visit(String.fromCodePoint(cp), i, len)
    i += len
  }
}

function foldChar(ch, loose) {
  let out = ch.normalize('NFKC')
  if (loose) out = out.toLowerCase()
  let kept = ''
  for (const c of out) {
    if (WHITESPACE.test(c)) continue
    if (loose && PUNCTUATION.test(c)) continue
    kept += c
  }
  return kept
}

export function normalizeText(text, loose = false) {
  let out = ''
  eachCodePoint(text || '', (ch) => {
    out += foldChar(ch, loose)
  })
  return out
}

function buildView(text, skip, loose) {
  const parts = []
  const from = []
  const to = []
  eachCodePoint(text, (ch, at, len) => {
    if (skip[at]) return
    const folded = foldChar(ch, loose)
    for (let k = 0; k < folded.length; k += 1) {
      from.push(at)
      to.push(at + len)
    }
    parts.push(folded)
  })
  return { text: parts.join(''), from: Int32Array.from(from), to: Int32Array.from(to) }
}

// pages: [{ number, view: [x0, y0, x1, y1], items: [{ str, hasEOL, y }] }]
// items 的顺序必须和 TextLayer 的 textDivs 一致，字符才能换回 DOM 节点。
export function buildTextIndex(pages, options = {}) {
  const furniture = options.furniture ?? detectFurniture(pages, options)
  const parts = []
  const pageOf = []
  const itemOf = []
  const offsetOf = []
  const skip = []
  const pageRanges = new Map()
  const itemStarts = new Map()
  let length = 0

  const pushVirtual = (page) => {
    parts.push('\n')
    pageOf.push(page)
    itemOf.push(NO_ITEM)
    offsetOf.push(0)
    skip.push(0)
    length += 1
  }

  pages.forEach((page, pageIdx) => {
    if (pageIdx > 0) pushVirtual(pages[pageIdx - 1].number)
    const start = length
    const starts = new Int32Array(page.items.length)
    page.items.forEach((item, itemIdx) => {
      starts[itemIdx] = length
      const isFurniture = furniture[pageIdx]?.has(itemIdx) ? 1 : 0
      for (let offset = 0; offset < item.str.length; offset += 1) {
        pageOf.push(page.number)
        itemOf.push(itemIdx)
        offsetOf.push(offset)
        skip.push(isFurniture)
      }
      parts.push(item.str)
      length += item.str.length
      if (item.hasEOL) pushVirtual(page.number)
    })
    pageRanges.set(page.number, { start, end: length })
    itemStarts.set(page.number, starts)
  })

  const text = parts.join('')
  return {
    text,
    pageOf: Int32Array.from(pageOf),
    itemOf: Int32Array.from(itemOf),
    offsetOf: Int32Array.from(offsetOf),
    furniture: Uint8Array.from(skip),
    pageRanges,
    itemStarts,
    strict: buildView(text, skip, false),
    loose: buildView(text, skip, true),
  }
}

export function pagesInSpan(index, start, end) {
  const pages = []
  for (let i = start; i < end; i += 1) {
    if (index.itemOf[i] === NO_ITEM) continue
    const page = index.pageOf[i]
    if (pages.at(-1) !== page) pages.push(page)
  }
  return pages
}

export function rawPosition(index, page, item, offset) {
  const starts = index.itemStarts.get(page)
  if (!starts || item < 0 || item >= starts.length) return -1
  return starts[item] + offset
}
