<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  PixelsPerInch,
  RenderingCancelledException,
  setLayerDimensions,
  TextLayer,
} from 'pdfjs-dist'
import { openPdf } from '../lib/pdf.js'
import { captureSelection, commentAtPoint, pdfRectToViewport } from '../lib/selection.js'

const props = defineProps({
  src: { type: String, required: true },
  comments: { type: Array, required: true },
  activeId: { type: String, default: null },
  focusNonce: { type: Number, default: 0 },
})

const emit = defineEmits(['create', 'select'])

const scroller = ref(null)
const pagesRoot = ref(null)
const pageNumbers = ref([])
const pageMetrics = ref({})
const userScale = ref(1)
const scaleMode = ref('fit')
const status = ref('正在打开 PDF')
const draft = ref(null)
const draftBody = ref('')
const draftInput = ref(null)

const viewportMap = new Map()
let pdf = null
let renderJob = 0
let renderChain = Promise.resolve()
let resizeObserver = null
let resizeTimer = 0
let renderedOnce = false

const percentLabel = computed(() => `${Math.round(userScale.value * 100)}%`)

const composerStyle = computed(() => {
  const rect = draft.value?.clientRect
  if (!rect) return null
  const width = 280
  let left = rect.left
  let top = rect.bottom + 8
  if (left + width > window.innerWidth - 16) left = window.innerWidth - width - 16
  if (left < 8) left = 8
  if (top + 168 > window.innerHeight) top = Math.max(8, rect.top - 168)
  return { left: `${left}px`, top: `${top}px` }
})

function viewportFor(pageNumber) {
  return viewportMap.get(pageNumber)
}

function highlightRects(pageNumber) {
  const viewport = viewportMap.get(pageNumber)
  if (!viewport || !pageMetrics.value[pageNumber]) return []
  const items = []
  for (const comment of props.comments) {
    for (const anchor of comment.anchors) {
      if (anchor.page !== pageNumber) continue
      anchor.rects.forEach((rect, index) => {
        items.push({
          key: `${comment.id}-${index}`,
          id: comment.id,
          active: comment.id === props.activeId,
          ...pdfRectToViewport(rect, viewport),
        })
      })
    }
  }
  return items
}

function viewBox(pageNumber) {
  const metric = pageMetrics.value[pageNumber]
  if (!metric) return '0 0 0 0'
  return `0 0 ${metric.width} ${metric.height}`
}

function isCancelled(error) {
  return error?.name === 'RenderingCancelledException' || error instanceof RenderingCancelledException
}

function renderPages() {
  const job = ++renderJob
  renderChain = renderChain.catch(() => {}).then(() => renderPagesNow(job))
  return renderChain
}

async function renderPagesNow(job) {
  if (!pdf || !pagesRoot.value || !scroller.value || job !== renderJob) return

  const firstPage = await pdf.getPage(1)
  if (job !== renderJob) return
  if (scaleMode.value === 'fit') {
    const base = firstPage.getViewport({ scale: PixelsPerInch.PDF_TO_CSS_UNITS })
    const style = getComputedStyle(scroller.value)
    const gutter = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
    const available = Math.max(240, scroller.value.clientWidth - gutter)
    userScale.value = Math.min(3, Math.max(0.5, available / base.width))
  }

  const metrics = {}
  for (const number of pageNumbers.value) {
    if (job !== renderJob) return
    const page = number === 1 ? firstPage : await pdf.getPage(number)
    if (job !== renderJob) return
    const pageEl = pagesRoot.value.querySelector(`[data-page="${number}"]`)
    const viewport = page.getViewport({
      scale: userScale.value * PixelsPerInch.PDF_TO_CSS_UNITS,
    })
    pagesRoot.value.style.setProperty('--scale-factor', String(viewport.scale))
    setLayerDimensions(pageEl, viewport, true, false)
    viewportMap.set(number, viewport)
    metrics[number] = { width: viewport.width, height: viewport.height }

    const canvas = pageEl.querySelector('canvas')
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.floor(viewport.width * ratio)
    canvas.height = Math.floor(viewport.height * ratio)
    const task = page.render({
      canvas,
      viewport,
      transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
    })
    try {
      await task.promise
    } catch (error) {
      if (isCancelled(error)) return
      if (job === renderJob) status.value = '页面渲染失败'
      return
    }
    if (job !== renderJob) return

    const textEl = pageEl.querySelector('.textLayer')
    textEl.replaceChildren()
    const textLayer = new TextLayer({
      textContentSource: page.streamTextContent({
        includeMarkedContent: true,
        disableNormalization: true,
      }),
      container: textEl,
      viewport,
    })
    await textLayer.render()
    if (job !== renderJob) return
    const endOfContent = document.createElement('div')
    endOfContent.className = 'endOfContent'
    textEl.append(endOfContent)
  }

  pageMetrics.value = metrics
  renderedOnce = true
  status.value = ''
}

function zoomBy(factor) {
  scaleMode.value = 'custom'
  userScale.value = Math.min(3, Math.max(0.5, userScale.value * factor))
  renderPages()
}

function fitWidth() {
  scaleMode.value = 'fit'
  renderPages()
}

function clearSelecting() {
  pagesRoot.value?.querySelectorAll('.textLayer.selecting').forEach((el) => {
    el.classList.remove('selecting')
  })
}

function onPointerDown(event) {
  clearSelecting()
  event.target.closest?.('.textLayer')?.classList.add('selecting')
}

function onPointerUp(event) {
  clearSelecting()
  if (event.target.closest?.('.composer')) return
  const point = { x: event.clientX, y: event.clientY }
  requestAnimationFrame(() => {
    if (!pagesRoot.value) return
    const captured = captureSelection(pagesRoot.value, viewportFor)
    if (captured) {
      draft.value = captured
      draftBody.value = ''
      return
    }
    if (document.activeElement?.closest('.composer')) return
    const hit = commentAtPoint(point.x, point.y, pagesRoot.value, viewportFor, props.comments)
    draft.value = null
    if (hit) emit('select', hit)
  })
}

function submitDraft() {
  const body = draftBody.value.trim()
  if (!body || !draft.value) return
  emit('create', {
    quote: draft.value.quote,
    prefix: draft.value.prefix,
    suffix: draft.value.suffix,
    anchors: draft.value.anchors,
    body,
  })
  draft.value = null
  draftBody.value = ''
  document.getSelection()?.removeAllRanges()
}

function cancelDraft() {
  draft.value = null
  draftBody.value = ''
  document.getSelection()?.removeAllRanges()
}

function onKeyDown(event) {
  if (event.key === 'Escape') cancelDraft()
}

function onResize() {
  if (!renderedOnce || scaleMode.value !== 'fit') return
  window.clearTimeout(resizeTimer)
  resizeTimer = window.setTimeout(() => renderPages(), 150)
}

watch(
  () => props.focusNonce,
  () => {
    if (!props.activeId) return
    const target = pagesRoot.value?.querySelector(`[data-comment="${props.activeId}"]`)
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  },
)

watch(draft, (value) => {
  if (!value) return
  requestAnimationFrame(() => draftInput.value?.focus())
})

onMounted(async () => {
  window.addEventListener('keydown', onKeyDown)
  try {
    pdf = await openPdf(props.src)
    pageNumbers.value = Array.from({ length: pdf.numPages }, (_, index) => index + 1)
    status.value = '正在渲染'
    await new Promise((resolve) => requestAnimationFrame(resolve))
    await renderPages()
    scroller.value?.addEventListener('scroll', () => {
      if (document.activeElement !== draftInput.value) draft.value = null
    }, { passive: true })
    resizeObserver = new ResizeObserver(onResize)
    resizeObserver.observe(scroller.value)
  } catch (error) {
    status.value = error?.message || '无法打开 PDF'
  }
})

onBeforeUnmount(() => {
  renderJob += 1
  resizeObserver?.disconnect()
  window.removeEventListener('keydown', onKeyDown)
  window.clearTimeout(resizeTimer)
  pdf?.destroy()
})
</script>

<template>
  <section class="viewer-column">
    <div class="zoom-bar">
      <button type="button" @click="zoomBy(1 / 1.1)">缩小</button>
      <span>{{ percentLabel }}</span>
      <button type="button" @click="zoomBy(1.1)">放大</button>
      <button type="button" @click="fitWidth">适应宽度</button>
    </div>
    <div ref="scroller" class="scroller" @pointerdown="onPointerDown" @pointerup="onPointerUp">
      <p v-if="status" class="status">{{ status }}</p>
      <div ref="pagesRoot" class="pages">
        <article v-for="number in pageNumbers" :key="number" class="pdf-page" :data-page="number">
          <div class="canvas-wrap"><canvas></canvas></div>
          <svg class="highlights" :viewBox="viewBox(number)">
            <rect
              v-for="box in highlightRects(number)"
              :key="box.key"
              :data-comment="box.id"
              :class="{ active: box.active }"
              :x="box.x"
              :y="box.y"
              :width="box.width"
              :height="box.height"
            />
          </svg>
          <div class="textLayer"></div>
        </article>
      </div>
    </div>
    <form v-if="draft && composerStyle" class="composer" :style="composerStyle" @submit.prevent="submitDraft">
      <p class="composer-quote">{{ draft.quote }}</p>
      <textarea ref="draftInput" v-model="draftBody" rows="3" maxlength="2000" placeholder="写下评论"></textarea>
      <div class="composer-actions">
        <button type="button" @click="cancelDraft">取消</button>
        <button type="submit" :disabled="!draftBody.trim()">发送</button>
      </div>
    </form>
  </section>
</template>
