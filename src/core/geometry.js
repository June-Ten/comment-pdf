import { alignLineRects, dedupeRects } from './rects.js'
import { NO_ITEM, rawPosition } from './textIndex.js'

// 一页文字层就绪后的句柄。textDivs[i] 对应索引里这一页的第 i 个文字项。
export function createPageText(number, pageEl, textDivs, size) {
  return { number, pageEl, textDivs, width: size.width, height: size.height }
}

export function toPageUnits(pageText, clientX, clientY) {
  const box = pageText.pageEl.getBoundingClientRect()
  return {
    x: ((clientX - box.left) * pageText.width) / box.width,
    y: ((clientY - box.top) * pageText.height) / box.height,
  }
}

function clientRectsToPage(clientRects, pageText) {
  const box = pageText.pageEl.getBoundingClientRect()
  const sx = pageText.width / box.width
  const sy = pageText.height / box.height
  const rects = []
  for (const r of clientRects) {
    if (r.width < 1 || r.height < 1) continue
    if (r.width > box.width * 0.85 && r.height > box.height * 0.85) continue
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    if (cx < box.left || cx > box.right || cy < box.top || cy > box.bottom) continue
    rects.push({
      x: (r.left - box.left) * sx,
      y: (r.top - box.top) * sy,
      width: r.width * sx,
      height: r.height * sy,
    })
  }
  return alignLineRects(dedupeRects(rects))
}

function textBoundary(index, pageText, raw, isEnd) {
  const div = pageText.textDivs[index.itemOf[raw]]
  const node = div?.firstChild
  if (!node || node.nodeType !== Node.TEXT_NODE || !div.isConnected) return null
  return { node, offset: index.offsetOf[raw] + (isEnd ? 1 : 0) }
}

// 字符区间 [start, end) 落在这一页的部分，换成页面单位的矩形。页眉页脚和空白不画。
export function rectsForSpan(index, pageText, start, end) {
  const range = index.pageRanges.get(pageText.number)
  if (!range) return []
  let s = Math.max(start, range.start)
  let e = Math.min(end, range.end)
  const drawable = (i) => index.itemOf[i] !== NO_ITEM && !index.furniture[i] && !/\s/.test(index.text[i])
  while (s < e && !drawable(s)) s += 1
  while (e > s && !drawable(e - 1)) e -= 1
  if (s >= e) return []

  const first = textBoundary(index, pageText, s, false)
  const last = textBoundary(index, pageText, e - 1, true)
  if (!first || !last) return []
  const dom = document.createRange()
  dom.setStart(first.node, first.offset)
  dom.setEnd(last.node, last.offset)
  return clientRectsToPage(dom.getClientRects(), pageText)
}

// 浏览器选区换成索引里的字符区间。只看已经就绪的页。
export function spanFromRange(index, domRange, pageTexts) {
  let start = -1
  let end = -1
  for (const pageText of [...pageTexts].sort((a, b) => a.number - b.number)) {
    pageText.textDivs.forEach((div, itemIdx) => {
      const node = div.firstChild
      if (!node || node.nodeType !== Node.TEXT_NODE || !div.isConnected) return
      if (!domRange.intersectsNode(node)) return
      const from = node === domRange.startContainer ? domRange.startOffset : 0
      const to = node === domRange.endContainer ? domRange.endOffset : node.length
      if (to <= from) return
      if (start < 0) start = rawPosition(index, pageText.number, itemIdx, from)
      end = rawPosition(index, pageText.number, itemIdx, to)
    })
  }
  return start >= 0 && end > start ? { start, end } : null
}
