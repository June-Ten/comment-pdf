import wasmUrl from '../../node_modules/mupdf/dist/mupdf-wasm.wasm?url'

globalThis.$libmupdf_wasm_Module = {
  locateFile() {
    return wasmUrl
  },
}

let loading

export function loadMupdf() {
  loading ??= import('mupdf').then((mod) => mod.default)
  return loading
}

export async function openMupdfDocument(source) {
  const mupdf = await loadMupdf()
  let data = source
  if (typeof source === 'string') {
    const response = await fetch(source)
    if (!response.ok) throw new Error('无法打开 PDF')
    data = new Uint8Array(await response.arrayBuffer())
  }
  return mupdf.Document.openDocument(data, 'application/pdf')
}

function concatMatrix(one, two) {
  return [
    one[0] * two[0] + one[2] * two[1],
    one[1] * two[0] + one[3] * two[1],
    one[0] * two[2] + one[2] * two[3],
    one[1] * two[2] + one[3] * two[3],
    one[0] * two[4] + one[2] * two[5] + one[4],
    one[1] * two[4] + one[3] * two[5] + one[5],
  ]
}

function posKey(x, y) {
  return `${x.toFixed(2)},${y.toFixed(2)}`
}

function isSheared(ctm, trm) {
  const matrix = concatMatrix(ctm, trm)
  const scale = Math.max(Math.abs(matrix[0]), Math.abs(matrix[3]), 0.01)
  return Math.abs(matrix[2]) > scale * 0.15 && Math.abs(matrix[1]) < scale * 0.2
}

function italicOrigins(page, mupdf) {
  const keys = new Set()
  const note = (text, ctm) => {
    text.walk({
      showGlyph(_font, trm, _glyph, _unicode) {
        if (!isSheared(ctm, trm)) return
        const matrix = concatMatrix(ctm, trm)
        keys.add(posKey(matrix[4], matrix[5]))
      },
    })
  }
  const device = new mupdf.Device({
    fillText: note,
    strokeText(text, _stroke, ctm) {
      note(text, ctm)
    },
  })
  try {
    page.run(device, mupdf.Matrix.identity)
  } finally {
    device.destroy()
  }
  return keys
}

function cssColor(color) {
  const channels = color.length === 1 ? [color[0], color[0], color[0]] : color
  return `#${channels.slice(0, 3).map((value) => Math.round(value * 255).toString(16).padStart(2, '0')).join('')}`
}

function fontFamily(name) {
  if (/dengxian/i.test(name)) return 'DengXian,sans-serif'
  if (/simsun|songti/i.test(name)) return 'SimSun,serif'
  if (/simhei/i.test(name)) return 'SimHei,sans-serif'
  if (/kaiti/i.test(name)) return 'KaiTi,serif'
  if (/fangsong/i.test(name)) return 'FangSong,serif'
  return 'sans-serif'
}

function escapeHtml(text) {
  return text.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char])
}

function sameStyle(run, style) {
  return run.italic === style.italic
    && run.bold === style.bold
    && run.color === style.color
    && run.family === style.family
    && Math.abs(run.size - style.size) < 0.1
}

function bytesToDataUrl(bytes, mime) {
  let binary = ''
  const step = 0x8000
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step))
  }
  return `data:${mime};base64,${btoa(binary)}`
}

export async function renderPageHtml(page, index) {
  const mupdf = await loadMupdf()
  const [x0, y0, x1, y1] = page.getBounds()
  const italic = italicOrigins(page, mupdf)
  const stext = page.toStructuredText('preserve-whitespace,preserve-images,vectors')
  const vectors = []
  const images = []
  const lines = []
  let line = null
  try {
    stext.walk({
      onVector(bbox, _flags, color) {
        vectors.push({ bbox, color: cssColor(color) })
      },
      onImageBlock(bbox, _matrix, image) {
        const pixmap = image.toPixmap()
        try {
          images.push({ bbox, src: bytesToDataUrl(pixmap.asPNG(), 'image/png') })
        } finally {
          pixmap.destroy()
        }
      },
      beginLine(bbox) {
        line = { bbox, runs: [] }
      },
      onChar(char, origin, font, size, _quad, color) {
        if (!line) return
        const style = {
          italic: italic.has(posKey(origin[0], origin[1])) || font.isItalic(),
          bold: font.isBold(),
          size,
          color: cssColor(color),
          family: fontFamily(font.getName()),
        }
        const last = line.runs.at(-1)
        if (last && sameStyle(last, style)) last.text += char
        else line.runs.push({ ...style, text: char })
      },
      endLine() {
        if (line?.runs.some((run) => run.text)) lines.push(line)
        line = null
      },
    })
  } finally {
    stext.destroy()
  }

  const parts = [`<div id="page${index}" style="width:${x1 - x0}pt;height:${y1 - y0}pt">`]
  for (const image of images) {
    const [left, top, right, bottom] = image.bbox
    parts.push(`<img alt="" style="left:${left - x0}pt;top:${top - y0}pt;width:${right - left}pt;height:${bottom - top}pt" src="${image.src}">`)
  }
  for (const vector of vectors) {
    const [left, top, right, bottom] = vector.bbox
    parts.push(`<div class="mupdf-vector" style="left:${left - x0}pt;top:${top - y0}pt;width:${Math.max(0.4, right - left)}pt;height:${Math.max(0.4, bottom - top)}pt;background:${vector.color}"></div>`)
  }
  for (const item of lines) {
    const [left, top] = item.bbox
    const size = Math.max(...item.runs.map((run) => run.size))
    const spans = item.runs.map((run) => {
      const weight = run.bold ? 'font-weight:700;' : ''
      const base = `font-family:${run.family};font-size:${run.size}pt;color:${run.color};${weight}`
      const slant = run.italic ? 'font-style:oblique 18deg;' : ''
      return `<span style="${base}${slant}">${escapeHtml(run.text)}</span>`
    }).join('')
    parts.push(`<p style="top:${top - y0}pt;left:${left - x0}pt;line-height:${size}pt">${spans}</p>`)
  }
  parts.push('</div>')
  return parts.join('')
}
