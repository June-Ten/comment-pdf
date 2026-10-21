// 矩形都在「页面单位」里：等于缩放为 1 时的 viewport 坐标（PDF 点，原点左上，y 向下）。
// 缩放不改变这些数，SVG 的 viewBox 用同一套单位。

export function dedupeRects(rects) {
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
    const top = Math.min(...line.map((rect) => rect.y))
    const bottom = Math.max(...line.map((rect) => rect.y + rect.height))
    const height = bottom - top
    const merged = []
    for (const rect of [...line].sort((a, b) => a.x - b.x)) {
      const last = merged.at(-1)
      const gap = last ? rect.x - (last.x + last.width) : Infinity
      if (last && gap <= Math.max(1.5, height * 0.6)) {
        last.width = Math.max(last.x + last.width, rect.x + rect.width) - last.x
      } else {
        merged.push({ x: rect.x, y: top, width: rect.width, height })
      }
    }
    return merged
  })
}

export function containsPoint(rect, x, y) {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height
}
