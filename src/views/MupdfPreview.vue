<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { openMupdfDocument, renderPageHtml } from '../lib/mupdf.js'

const CSS_UNITS = 96 / 72
const defaultSrc = `${import.meta.env.BASE_URL}pdf格式测试文件.pdf`
const defaultName = 'pdf格式测试文件.pdf'

const src = ref(defaultSrc)
const fileName = ref(defaultName)
const fileError = ref('')
const fileInput = ref(null)
const scroller = ref(null)
const pages = ref([])
const userScale = ref(1)
const scaleMode = ref('fit')
const status = ref('正在打开 PDF')

const percentLabel = computed(() => `${Math.round(userScale.value * 100)}%`)

let doc = null
let loadToken = 0
let resizeObserver = null
let resizeTimer = 0
let renderedOnce = false

function onFileChange(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  const looksPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
  if (!looksPdf) {
    fileError.value = '请选择 PDF 文件'
    return
  }
  fileError.value = ''
  file.arrayBuffer().then((buffer) => {
    fileName.value = file.name
    src.value = new Uint8Array(buffer)
  })
}

function restoreDefault() {
  if (src.value === defaultSrc) return
  fileError.value = ''
  fileName.value = defaultName
  src.value = defaultSrc
}

function updateFitScale() {
  const first = pages.value[0]
  if (!first || !scroller.value || scaleMode.value !== 'fit') return
  const style = getComputedStyle(scroller.value)
  const gutter = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
  const available = Math.max(240, scroller.value.clientWidth - gutter)
  userScale.value = Math.min(3, Math.max(0.5, available / first.width))
}

function zoomBy(factor) {
  scaleMode.value = 'custom'
  userScale.value = Math.min(3, Math.max(0.5, userScale.value * factor))
}

function fitWidth() {
  scaleMode.value = 'fit'
  updateFitScale()
}

function onResize() {
  if (!renderedOnce || scaleMode.value !== 'fit') return
  window.clearTimeout(resizeTimer)
  resizeTimer = window.setTimeout(updateFitScale, 150)
}

async function loadDocument() {
  const token = ++loadToken
  status.value = '正在打开 PDF'
  pages.value = []
  scaleMode.value = 'fit'
  renderedOnce = false
  if (scroller.value) scroller.value.scrollTop = 0

  const previous = doc
  doc = null
  try { previous?.destroy() } catch { /* 文档可能已经销毁 */ }

  try {
    const next = await openMupdfDocument(src.value)
    if (token !== loadToken) {
      next.destroy()
      return
    }
    if (next.needsPassword()) {
      next.destroy()
      status.value = '这份 PDF 需要密码'
      return
    }
    doc = next
    status.value = '正在渲染'

    const count = doc.countPages()
    const built = []
    for (let index = 0; index < count; index += 1) {
      if (token !== loadToken) return
      const page = doc.loadPage(index)
      try {
        const [x0, y0, x1, y1] = page.getBounds()
        built.push({
          number: index + 1,
          html: await renderPageHtml(page, index),
          width: (x1 - x0) * CSS_UNITS,
          height: (y1 - y0) * CSS_UNITS,
        })
        pages.value = built.slice()
      } finally {
        page.destroy()
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    if (token !== loadToken) return
    renderedOnce = true
    status.value = ''
    updateFitScale()
  } catch (error) {
    if (token !== loadToken) return
    status.value = error?.message || '无法打开 PDF'
    console.error(error)
  }
}

watch(src, () => {
  loadDocument()
})

onMounted(() => {
  resizeObserver = new ResizeObserver(onResize)
  resizeObserver.observe(scroller.value)
  loadDocument()
})

onBeforeUnmount(() => {
  loadToken += 1
  resizeObserver?.disconnect()
  window.clearTimeout(resizeTimer)
  try { doc?.destroy() } catch { /* 文档可能已经销毁 */ }
  doc = null
})
</script>

<template>
  <section class="viewer-column mupdf-view">
    <div class="zoom-bar">
      <button type="button" @click="zoomBy(1 / 1.1)">缩小</button>
      <span>{{ percentLabel }}</span>
      <button type="button" @click="zoomBy(1.1)">放大</button>
      <button type="button" @click="fitWidth">适应宽度</button>
      <router-link to="/">评论预览</router-link>
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
        <button type="button" :disabled="src === defaultSrc" @click="restoreDefault">恢复默认</button>
      </div>
    </div>
    <div ref="scroller" class="scroller">
      <p v-if="status" class="status">{{ status }}</p>
      <div class="mupdf-pages">
        <article
          v-for="page in pages"
          :key="page.number"
          class="mupdf-page"
          :style="{ width: `${page.width * userScale}px`, height: `${page.height * userScale}px` }"
        >
          <div class="mupdf-html" :style="{ transform: `scale(${userScale})` }" v-html="page.html"></div>
        </article>
      </div>
    </div>
  </section>
</template>
