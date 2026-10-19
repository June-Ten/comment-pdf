import { anchorsFromRange } from './selection.js'

function textNode(span) {
  const node = span.firstChild
  return node?.nodeType === Node.TEXT_NODE ? node : null
}

function documentText(root) {
  const chars = []
  const compact = []
  let text = ''
  let compactText = ''

  for (const pageEl of root.querySelectorAll('[data-page]')) {
    const page = Number(pageEl.dataset.page)
    const spans = [...pageEl.querySelectorAll('.textLayer span')].filter((span) => !span.querySelector('span'))
    for (const span of spans) {
      const node = textNode(span)
      const value = node ? node.data : ''
      for (let offset = 0; offset < value.length; offset += 1) {
        const ch = value[offset]
        const index = chars.length
        chars.push({ page, node, offset })
        text += ch
        if (!/\s/.test(ch)) {
          compact.push(index)
          compactText += ch
        }
      }
    }
  }
  return { chars, text, compact, compactText }
}

function anchorsForHit(doc, hit, root, viewportFor) {
  const segments = []
  for (let index = hit.start; index <= hit.end; index += 1) {
    const entry = doc.chars[index]
    if (!entry) continue
    const last = segments.at(-1)
    if (!last || last.page !== entry.page) {
      segments.push({ page: entry.page, start: index, end: index })
    } else {
      last.end = index
    }
  }

  const byPage = new Map()
  for (const seg of segments) {
    const first = doc.chars[seg.start]
    const last = doc.chars[seg.end]
    if (!first || !last) continue
    const range = document.createRange()
    range.setStart(first.node, first.offset)
    range.setEnd(last.node, last.offset + 1)
    const { anchors } = anchorsFromRange(range, root, viewportFor)
    for (const anchor of anchors) {
      if (!byPage.has(anchor.page)) byPage.set(anchor.page, [])
      byPage.get(anchor.page).push(...anchor.rects)
    }
  }

  return [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([page, rects]) => ({ page, rects }))
}

function findSpansInDocument(doc, needle) {
  const target = needle.replace(/\s+/g, '')
  if (!target) return []

  const hits = []
  let from = 0
  while (from <= doc.compactText.length - target.length) {
    const at = doc.compactText.indexOf(target, from)
    if (at < 0) break
    hits.push({
      start: doc.compact[at],
      end: doc.compact[at + target.length - 1],
    })
    from = at + target.length
  }
  return hits
}

function contextScore(doc, hit, prefix, suffix) {
  let score = 0
  const cleanPrefix = (prefix || '').replace(/\s+/g, '')
  const cleanSuffix = (suffix || '').replace(/\s+/g, '')
  if (cleanPrefix) {
    const before = doc.text.slice(Math.max(0, hit.start - 40), hit.start).replace(/\s+/g, '')
    if (before.endsWith(cleanPrefix)) score += 2
    else if (before.includes(cleanPrefix)) score += 1
  }
  if (cleanSuffix) {
    const after = doc.text.slice(hit.end + 1, hit.end + 41).replace(/\s+/g, '')
    if (after.startsWith(cleanSuffix)) score += 2
    else if (after.includes(cleanSuffix)) score += 1
  }
  return score
}

export function locateComments(root, viewportFor, comments) {
  if (!root || !comments.length) return {}
  const doc = documentText(root)

  const result = {}
  for (const comment of comments) {
    const matches = []
    for (const hit of findSpansInDocument(doc, comment.quote || '')) {
      const anchors = anchorsForHit(doc, hit, root, viewportFor)
      if (!anchors.length) continue
      const pages = anchors.map((item) => item.page)
      matches.push({
        page: pages[0],
        pages,
        anchors,
        score: contextScore(doc, hit, comment.prefix, comment.suffix),
      })
    }
    let preferredIndex = 0
    if (matches.length > 1 && ((comment.prefix || '').trim() || (comment.suffix || '').trim())) {
      let bestScore = -1
      matches.forEach((item, index) => {
        if (item.score > bestScore) {
          bestScore = item.score
          preferredIndex = index
        }
      })
    }
    result[comment.id] = { matches, preferredIndex }
  }
  return result
}
