import { anchorsFromRange } from './selection.js'

function textNode(span) {
  const node = span.firstChild
  return node?.nodeType === Node.TEXT_NODE ? node : null
}

function pageText(pageEl) {
  const chars = []
  let text = ''
  const spans = [...pageEl.querySelectorAll('.textLayer span')].filter((span) => !span.querySelector('span'))
  for (const span of spans) {
    const node = textNode(span)
    const value = node ? node.data : ''
    for (let offset = 0; offset < value.length; offset += 1) {
      chars.push({ node, offset })
      text += value[offset]
    }
  }
  return { chars, text }
}

function rangeForMatch(chars, start, end) {
  const first = chars[start]
  const last = chars[end]
  if (!first || !last) return null
  const range = document.createRange()
  range.setStart(first.node, first.offset)
  range.setEnd(last.node, last.offset + 1)
  return range
}

export function findMatches(root, viewportFor, query) {
  const needle = query.trim()
  if (!needle || !root) return []
  const matches = []
  for (const pageEl of root.querySelectorAll('[data-page]')) {
    const page = Number(pageEl.dataset.page)
    const { chars, text } = pageText(pageEl)
    let from = 0
    while (from <= text.length - needle.length) {
      const at = text.indexOf(needle, from)
      if (at < 0) break
      const range = rangeForMatch(chars, at, at + needle.length - 1)
      const anchors = range ? anchorsFromRange(range, root, viewportFor).anchors : []
      if (anchors.length) {
        matches.push({
          id: String(matches.length),
          page,
          quote: needle,
          anchors,
        })
      }
      from = at + needle.length
    }
  }
  return matches
}
