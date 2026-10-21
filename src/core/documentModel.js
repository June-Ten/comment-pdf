import { markRaw } from 'vue'
import { buildTextIndex } from './textIndex.js'

export const TEXT_CONTENT_PARAMS = { includeMarkedContent: false, disableNormalization: true }

function textItems(textContent) {
  return textContent.items.filter((item) => item.str !== undefined)
}

// 第一步只取每页尺寸，用来立刻排出占位页；不渲染任何画布。
export async function loadPages(pdf, isStale) {
  const pages = []
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const proxy = await pdf.getPage(number)
    if (isStale()) return null
    const base = proxy.getViewport({ scale: 1 })
    pages.push(markRaw({ number, proxy: markRaw(proxy), base: markRaw(base), width: base.width, height: base.height, textContent: null }))
  }
  return pages
}

// 第二步取全文文字建索引。TextLayer 之后直接复用同一份 textContent，下标才能一一对上。
export async function loadTextIndex(pages, isStale, onProgress) {
  const sources = []
  for (const page of pages) {
    const textContent = await page.proxy.getTextContent(TEXT_CONTENT_PARAMS)
    if (isStale()) return null
    page.textContent = markRaw(textContent)
    sources.push({
      number: page.number,
      view: page.proxy.view,
      items: textItems(textContent).map((item) => ({ str: item.str, hasEOL: item.hasEOL, y: item.transform[5] })),
    })
    onProgress?.(page.number, pages.length)
  }
  return markRaw(buildTextIndex(sources))
}

// 还没画出来的页拿不到 DOM 矩形，用文字项的基线粗估这处在页面里的高度，先滚过去。
export function estimateSpanTop(index, page, start) {
  const range = index.pageRanges.get(page.number)
  if (!range || !page.textContent) return 0
  const items = textItems(page.textContent)
  for (let i = Math.max(start, range.start); i < range.end; i += 1) {
    const item = items[index.itemOf[i]]
    if (!item) continue
    const [, y] = page.base.convertToViewportPoint(item.transform[4], item.transform[5])
    return Math.max(0, y - Math.hypot(item.transform[2], item.transform[3]))
  }
  return 0
}
