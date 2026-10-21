<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { PixelsPerInch } from 'pdfjs-dist'
import PdfPage from './PdfPage.vue'
import { openPdf } from '../lib/pdf.js'
import { estimateSpanTop, loadPages, loadTextIndex } from '../core/documentModel.js'
import { createPageText, rectsForSpan, spanFromRange, toPageUnits } from '../core/geometry.js'
import { containsPoint } from '../core/rects.js'
import { resolveTarget, targetFromSpan, targetKey } from '../core/resolver.js'
import { useReviewStore } from '../core/store.js'
import { pagesInSpan } from '../core/textIndex.js'

const props = defineProps({
  src: { type: [String, Uint8Array], required: true },
  fileName: { type: String, required: true },
  fileError: { type: String, default: '' },
  canRestore: { type: Boolean, default: false },
})

const emit = defineEmits(['open-file', 'restore', 'document-ready'])

const NO_HIGHLIGHTS = []
const MIN_SCALE = 0.5
const MAX_SCALE = 3

const store = useReviewStore()

const fileInput = ref(null)
const scroller = ref(null)
const pagesRoot = ref(null)
const pages = shallowRef([])
const docGeneration = ref(0)
const textReady = ref(false)
const visiblePages = shallowRef(new Set())
const geometryVersion = ref(0)
const userScale = ref(1)
const scaleMode = ref('fit')
const status = ref('正在打开 PDF')
const draft = shallowRef(null)
const draftBody = ref('')
const draftInput = ref(null)

// 这些对象带 PDF.js 私有字段或体积很大，不放进响应式系统。
let pdf = null
let loadingTask = null
let loadToken = 0
let textIndex = null
const pageTexts = new Map()
const geometry = new Map()
const resolveCache = new Map()
let pendingPrecise = null
let observer = null
let resizeObserver = null
let resizeTimer = 0
let stopScroll = null

const viewportScale = computed(() => userScale.value * PixelsPerInch.PDF_TO_CSS_UNITS)
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

function clampScale(value) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))
}

function geoKey(page, span) {
  return `${page}:${span.start}:${span.end}`
}

function pageElement(number) {
  return pagesRoot.value?.querySelector(`[data-page="${number}"]`)
}

// ---- 解析：引用文字 → 字符区间。只依赖全文索引，与页面是否渲染无关。

function resolveAll() {
  if (!textIndex) return
  const map = new Map()
  const used = new Set()
  for (const annotation of store.state.annotations) {
    const key = targetKey(annotation.target)
    used.add(key)
    let info = resolveCache.get(key)
    if (!info) {
      info = resolveTarget(textIndex, annotation.target)
      resolveCache.set(key, info)
    }
    map.set(annotation.id, info)
  }
  for (const key of resolveCache.keys()) {
    if (!used.has(key)) resolveCache.delete(key)
  }
  store.setResolved(map)
  computeGeometry()
}

// ---- 几何：字符区间 → 页面单位矩形。只为文字层已就绪的页计算，结果与缩放无关，算一次就缓存。

function spansOnPage(number) {
  const spans = []
  for (const info of store.resolved.value.values()) {
    for (const match of info.matches) if (match.pages.includes(number)) spans.push(match)
  }
  for (const match of draft.value?.matches || []) if (match.pages.includes(number)) spans.push(match)
  return spans
}

function computeGeometry(numbers = [...pageTexts.keys()]) {
  if (!textIndex) return
  let changed = false
  for (const number of numbers) {
    const pageText = pageTexts.get(number)
    if (!pageText) continue
    for (const span of spansOnPage(number)) {
      const key = geoKey(number, span)
      if (geometry.has(key)) continue
      geometry.set(key, rectsForSpan(textIndex, pageText, span.start, span.end))
      changed = true
    }
  }
  if (changed) geometryVersion.value += 1
}

const highlightsByPage = computed(() => {
  void geometryVersion.value
  const byPage = new Map()
  const push = (match, source) => {
    for (const number of match.pages) {
      const rects = geometry.get(geoKey(number, match))
      if (!rects?.length) continue
      if (!byPage.has(number)) byPage.set(number, [])
      const list = byPage.get(number)
      rects.forEach((rect, idx) => list.push({ ...source, ...rect, key: `${source.key}-${number}-${idx}` }))
    }
  }

  const activeId = store.state.activeId
  const deferred = []
  for (const annotation of store.state.annotations) {
    const matches = store.resolved.value.get(annotation.id)?.matches
    if (!matches?.length) continue
    const selected = annotation.id === activeId ? store.currentMatchIndex(annotation.id) : -1
    matches.forEach((match, matchIndex) => {
      const source = {
        key: `c-${annotation.id}-${matchIndex}`,
        id: annotation.id,
        matchIndex,
        matchKey: `${annotation.id}:${matchIndex}`,
        active: matchIndex === selected,
        approximate: match.confidence === 'fuzzy',
      }
      if (source.active) deferred.push([match, source])
      else push(match, source)
    })
  }
  for (const [match, source] of deferred) push(match, source)
  for (const match of draft.value?.matches || []) {
    push(match, { key: 'draft', id: 'draft', matchIndex: 0, matchKey: 'draft:0', active: true, approximate: false })
  }
  return byPage
})

// ---- 页面生命周期

function onTextReady({ number, pageEl, textDivs }) {
  const page = pages.value[number - 1]
  if (!page) return
  pageTexts.set(number, createPageText(number, pageEl, textDivs, page))
  computeGeometry([number])
  if (pendingPrecise?.number === number) scrollToMatch(pendingPrecise.match)
}

function onTextReleased(number) {
  pageTexts.delete(number)
}

function onRenderError(number) {
  status.value = `第 ${number} 页渲染失败`
}

function observePages() {
  observer?.disconnect()
  observer = new IntersectionObserver((entries) => {
    const next = new Set(visiblePages.value)
    for (const entry of entries) {
      const number = Number(entry.target.dataset.page)
      if (entry.isIntersecting) next.add(number)
      else next.delete(number)
    }
    visiblePages.value = next
  }, { root: scroller.value, rootMargin: '100% 0px' })
  pagesRoot.value?.querySelectorAll('[data-page]').forEach((el) => observer.observe(el))
}

// ---- 滚动

function scrollWithinPage(number, y, height) {
  const page = pages.value[number - 1]
  const pageEl = pageElement(number)
  if (!page || !pageEl || !scroller.value) return
  const pageBox = pageEl.getBoundingClientRect()
  const scrollBox = scroller.value.getBoundingClientRect()
  const unit = pageBox.height / page.height
  const top = scroller.value.scrollTop + (pageBox.top - scrollBox.top) + (y + height / 2) * unit
  scroller.value.scrollTo({ top: Math.max(0, top - scroller.value.clientHeight / 2), behavior: 'smooth' })
}

function scrollToMatch(match) {
  const number = match.pages[0]
  const rect = geometry.get(geoKey(number, match))?.[0]
  if (rect) {
    pendingPrecise = null
    scrollWithinPage(number, rect.y, rect.height)
    return
  }
  pendingPrecise = { number, match }
  const page = pages.value[number - 1]
  if (page && textIndex) scrollWithinPage(number, estimateSpanTop(textIndex, page, match.start), 0)
}

// ---- 缩放

function applyFitScale() {
  const first = pages.value[0]
  if (scaleMode.value !== 'fit' || !first || !scroller.value) return
  const style = getComputedStyle(scroller.value)
  const gutter = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
  const available = Math.max(240, scroller.value.clientWidth - gutter)
  setScale(available / (first.width * PixelsPerInch.PDF_TO_CSS_UNITS))
}

async function setScale(value) {
  const next = clampScale(value)
  if (Math.abs(next - userScale.value) < 1e-4) return
  const el = scroller.value
  const keepCenter = el && el.scrollTop > 0
  const ratio = keepCenter ? (el.scrollTop + el.clientHeight / 2) / el.scrollHeight : 0
  cancelDraft()
  userScale.value = next
  await nextTick()
  if (keepCenter) el.scrollTop = ratio * el.scrollHeight - el.clientHeight / 2
}

function zoomBy(factor) {
  scaleMode.value = 'custom'
  setScale(userScale.value * factor)
}

function fitWidth() {
  scaleMode.value = 'fit'
  applyFitScale()
}

function onResize() {
  if (scaleMode.value !== 'fit') return
  window.clearTimeout(resizeTimer)
  resizeTimer = window.setTimeout(applyFitScale, 150)
}

// ---- 划词与点击

function elementOf(node) {
  return node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement
}

function captureDraft() {
  const selection = document.getSelection()
  if (!textIndex || !selection || selection.rangeCount === 0 || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  const start = elementOf(range.startContainer)
  if (!start || !pagesRoot.value?.contains(start) || !start.closest('.textLayer')) return null
  const span = spanFromRange(textIndex, range, pageTexts.values())
  if (!span) return null
  const target = targetFromSpan(textIndex, span.start, span.end)
  if (!target) return null
  const last = [...range.getClientRects()].filter((r) => r.width >= 1 && r.height >= 1).at(-1)
  if (!last) return null
  return {
    target,
    matches: [{ start: target.start, end: target.end, pages: pagesInSpan(textIndex, target.start, target.end) }],
    clientRect: { left: last.left, top: last.top, right: last.right, bottom: last.bottom },
  }
}

function hitTest(clientX, clientY, targetEl) {
  const pageEl = targetEl?.closest?.('[data-page]')
  if (!pageEl) return null
  const number = Number(pageEl.dataset.page)
  const page = pages.value[number - 1]
  if (!page) return null
  const { x, y } = toPageUnits({ pageEl, width: page.width, height: page.height }, clientX, clientY)
  const items = highlightsByPage.value.get(number) || NO_HIGHLIGHTS
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const box = items[i]
    if (box.id !== 'draft' && containsPoint(box, x, y)) return box
  }
  return null
}

function clearSelecting() {
  pagesRoot.value?.querySelectorAll('.textLayer.selecting').forEach((el) => el.classList.remove('selecting'))
}

function onPointerDown(event) {
  clearSelecting()
  event.target.closest?.('.textLayer')?.classList.add('selecting')
}

function onPointerUp(event) {
  clearSelecting()
  if (event.target.closest?.('.composer')) return
  const { clientX, clientY, target } = event
  requestAnimationFrame(() => {
    const captured = captureDraft()
    if (captured) {
      draft.value = captured
      draftBody.value = ''
      document.getSelection()?.removeAllRanges()
      computeGeometry(captured.matches[0].pages)
      return
    }
    if (document.activeElement?.closest('.composer')) return
    const hit = hitTest(clientX, clientY, target)
    draft.value = null
    if (hit) store.select(hit.id, hit.matchIndex)
  })
}

function submitDraft() {
  const body = draftBody.value.trim()
  if (!body || !draft.value) return
  store.add(draft.value.target, body)
  cancelDraft()
}

function cancelDraft() {
  draft.value = null
  draftBody.value = ''
  document.getSelection()?.removeAllRanges()
}

function onKeyDown(event) {
  if (event.key === 'Escape') cancelDraft()
}

function onScroll() {
  if (document.activeElement !== draftInput.value) draft.value = null
}

function onFileChange(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (file) emit('open-file', file)
}

// ---- 打开文档

function resetDocument() {
  cancelDraft()
  observer?.disconnect()
  docGeneration.value += 1
  pages.value = []
  visiblePages.value = new Set()
  textReady.value = false
  textIndex = null
  pageTexts.clear()
  geometry.clear()
  resolveCache.clear()
  pendingPrecise = null
  scaleMode.value = 'fit'
  status.value = '正在打开 PDF'
  if (scroller.value) scroller.value.scrollTop = 0
  const previous = pdf
  pdf = null
  try { previous?.destroy() } catch { /* 文档可能已经销毁 */ }
  try { loadingTask?.destroy() } catch { /* 打开任务可能已经结束 */ }
}

async function loadDocument() {
  const token = ++loadToken
  const isStale = () => token !== loadToken
  resetDocument()
  try {
    loadingTask = openPdf(props.src)
    const next = await loadingTask.promise
    if (isStale()) {
      next.destroy()
      return
    }
    pdf = next
    emit('document-ready', { fingerprint: pdf.fingerprints?.[0] || null })

    const loaded = await loadPages(pdf, isStale)
    if (!loaded) return
    pages.value = loaded
    applyFitScale()
    await nextTick()
    observePages()

    status.value = '正在建立文字索引'
    const index = await loadTextIndex(loaded, isStale, (done, total) => {
      status.value = `正在建立文字索引 ${done}/${total}`
    })
    if (!index) return
    textIndex = index
    textReady.value = true
    status.value = ''
    resolveAll()
  } catch (error) {
    if (!isStale()) status.value = error?.message || '无法打开 PDF'
  }
}

watch(() => store.state.annotations, resolveAll)
watch(() => props.src, loadDocument)

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
  scroller.value.addEventListener('scroll', onScroll, { passive: true })
  resizeObserver = new ResizeObserver(onResize)
  resizeObserver.observe(scroller.value)
  stopScroll = store.onScroll(({ match }) => scrollToMatch(match))
  watch(draft, (value) => {
    if (value) requestAnimationFrame(() => draftInput.value?.focus())
  })
  loadDocument()
})

onBeforeUnmount(() => {
  loadToken += 1
  stopScroll?.()
  observer?.disconnect()
  resizeObserver?.disconnect()
  window.removeEventListener('keydown', onKeyDown)
  window.clearTimeout(resizeTimer)
  loadingTask?.destroy()
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
      <span class="file-name" :title="fileName">{{ fileName }}</span>
      <span v-if="fileError" class="file-error">{{ fileError }}</span>
      <div class="file-actions">
        <input
          ref="fileInput"
          class="file-input"
          type="file"
          accept="application/pdf,.pdf"
          @change="onFileChange"
        >
        <button type="button" @click="fileInput?.click()">上传 PDF</button>
        <button type="button" :disabled="!canRestore" @click="emit('restore')">恢复默认</button>
      </div>
    </div>
    <div ref="scroller" class="scroller" @pointerdown="onPointerDown" @pointerup="onPointerUp">
      <p v-if="status" class="status">{{ status }}</p>
      <div ref="pagesRoot" class="pages" :style="{ '--scale-factor': viewportScale }">
        <PdfPage
          v-for="page in pages"
          :key="`${docGeneration}-${page.number}`"
          :page="page"
          :scale="viewportScale"
          :active="visiblePages.has(page.number)"
          :text-ready="textReady"
          :highlights="highlightsByPage.get(page.number) || NO_HIGHLIGHTS"
          @text-ready="onTextReady"
          @text-released="onTextReleased"
          @render-error="onRenderError"
        />
      </div>
    </div>
    <form v-if="draft && composerStyle" class="composer" :style="composerStyle" @submit.prevent="submitDraft">
      <p class="composer-quote">{{ draft.target.exact }}</p>
      <textarea ref="draftInput" v-model="draftBody" rows="3" maxlength="2000" placeholder="写下评论"></textarea>
      <div class="composer-actions">
        <button type="button" @click="cancelDraft">取消</button>
        <button type="submit" :disabled="!draftBody.trim()">发送</button>
      </div>
    </form>
  </section>
</template>
