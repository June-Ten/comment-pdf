function elementOf(node) {
  return node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement
}

function pageAt(rect, root) {
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  for (const pageEl of root.querySelectorAll('[data-page]')) {
    const box = pageEl.getBoundingClientRect()
    if (cx >= box.left && cx <= box.right && cy >= box.top && cy <= box.bottom) {
      return pageEl
    }
  }
  return null
}

function clientRectToPdf(rect, pageEl, viewport) {
  const box = pageEl.getBoundingClientRect()
  const [x1, y1] = viewport.convertToPdfPoint(rect.left - box.left, rect.top - box.top)
  const [x2, y2] = viewport.convertToPdfPoint(rect.right - box.left, rect.bottom - box.top)
  const x = Math.min(x1, x2)
  const y = Math.min(y1, y2)
  return {
    x,
    y,
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  }
}

export function pdfRectToViewport(rect, viewport) {
  const [x1, y1] = viewport.convertToViewportPoint(rect.x, rect.y)
  const [x2, y2] = viewport.convertToViewportPoint(rect.x + rect.width, rect.y + rect.height)
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  }
}

function sameLine(a, b) {
  const overlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return overlap > Math.min(a.height, b.height) * 0.5
}

export function alignLineRects(rects) {
  const lines = []
  for (const rect of [...rects].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const line = lines.find((group) => group.some((other) => sameLine(rect, other)))
    if (line) line.push(rect)
    else lines.push([rect])
  }

  return lines.flatMap((line) => {
    const bottom = Math.min(...line.map((rect) => rect.y))
    const top = Math.max(...line.map((rect) => rect.y + rect.height))
    const height = top - bottom
    const merged = []
    for (const rect of [...line].sort((a, b) => a.x - b.x)) {
      const last = merged.at(-1)
      const gap = last ? rect.x - (last.x + last.width) : Infinity
      if (last && gap <= Math.max(1.5, height * 0.6)) {
        last.width = Math.max(last.x + last.width, rect.x + rect.width) - last.x
      } else {
        merged.push({ x: rect.x, y: bottom, width: rect.width, height })
      }
    }
    return merged
  })
}

function dedupeRects(rects) {
  const kept = []
  for (const rect of rects) {
    const area = rect.width * rect.height
    const nested = kept.some((other) => {
      const overlapX = Math.min(rect.x + rect.width, other.x + other.width) - Math.max(rect.x, other.x)
      const overlapY = Math.min(rect.y + rect.height, other.y + other.height) - Math.max(rect.y, other.y)
      if (overlapX <= 0 || overlapY <= 0) return false
      return (overlapX * overlapY) / area > 0.6
    })
    if (!nested) kept.push(rect)
  }
  return kept
}

function contextFromRange(range, textLayer) {
  if (!textLayer) return { prefix: '', suffix: '' }
  const spans = [...textLayer.querySelectorAll('span')].filter((span) => !span.querySelector('span'))
  const startSpan = elementOf(range.startContainer)?.closest('span')
  const endSpan = elementOf(range.endContainer)?.closest('span')
  const startIdx = spans.indexOf(startSpan)
  const endIdx = spans.indexOf(endSpan)
  if (startIdx < 0) return { prefix: '', suffix: '' }
  const before = spans.slice(Math.max(0, startIdx - 2), startIdx).map((span) => span.textContent).join('')
  const afterStart = endIdx >= 0 ? endIdx + 1 : startIdx + 1
  const after = spans.slice(afterStart, afterStart + 2).map((span) => span.textContent).join('')
  return {
    prefix: before.slice(-20),
    suffix: after.slice(0, 20),
  }
}

export function anchorsFromRange(range, root, viewportFor) {
  const groups = new Map()
  let lastRect = null
  for (const rect of range.getClientRects()) {
    if (rect.width < 2 || rect.height < 2) continue
    const pageEl = pageAt(rect, root)
    if (!pageEl) continue
    const box = pageEl.getBoundingClientRect()
    if (rect.height > box.height * 0.85 && rect.width > box.width * 0.85) continue
    const page = Number(pageEl.dataset.page)
    const viewport = viewportFor(page)
    if (!viewport) continue
    const pdfRect = clientRectToPdf(rect, pageEl, viewport)
    if (pdfRect.width < 0.5 || pdfRect.height < 0.5) continue
    if (!groups.has(page)) groups.set(page, [])
    groups.get(page).push(pdfRect)
    lastRect = rect
  }
  if (groups.size === 0) return { anchors: [], lastRect: null }
  const anchors = [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([page, rects]) => ({ page, rects: alignLineRects(dedupeRects(rects)) }))
  return { anchors, lastRect }
}

export function captureSelection(root, viewportFor) {
  const selection = document.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null

  const quote = selection.toString().replace(/\s+/g, ' ').trim()
  if (!quote) return null

  const range = selection.getRangeAt(0)
  const start = elementOf(range.startContainer)
  if (!start || !root.contains(start) || !start.closest('.textLayer')) return null

  const { anchors, lastRect } = anchorsFromRange(range, root, viewportFor)
  if (!anchors.length || !lastRect) return null
  const firstPage = root.querySelector(`[data-page="${anchors[0].page}"]`)
  const { prefix, suffix } = contextFromRange(range, firstPage?.querySelector('.textLayer'))

  return {
    quote,
    prefix,
    suffix,
    anchors,
    clientRect: {
      left: lastRect.left,
      top: lastRect.top,
      right: lastRect.right,
      bottom: lastRect.bottom,
    },
  }
}

export function commentAtPoint(clientX, clientY, root, viewportFor, comments) {
  const pageEl = pageAt(
    { left: clientX, top: clientY, width: 0, height: 0, right: clientX, bottom: clientY },
    root,
  )
  if (!pageEl) return null
  const page = Number(pageEl.dataset.page)
  const viewport = viewportFor(page)
  if (!viewport) return null
  const box = pageEl.getBoundingClientRect()
  const [x, y] = viewport.convertToPdfPoint(clientX - box.left, clientY - box.top)

  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const comment = comments[index]
    for (const anchor of comment.anchors) {
      if (anchor.page !== page) continue
      for (const rect of anchor.rects) {
        if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) {
          return comment.id
        }
      }
    }
  }
  return null
}
