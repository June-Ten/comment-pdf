<script setup>
import { provide, ref } from 'vue'
import CommentPanel from './components/CommentPanel.vue'
import PdfViewer from './components/PdfViewer.vue'
import { createReviewStore, REVIEW_STORE } from './core/store.js'

const defaultSrc = `${import.meta.env.BASE_URL}pdf格式测试文件.pdf`
const defaultName = 'pdf格式测试文件.pdf'

const store = createReviewStore()
provide(REVIEW_STORE, store)

const src = ref(defaultSrc)
const fileName = ref(defaultName)
const fileError = ref('')
// 旧版本按地址或「文件名:大小:修改时间」存评论，打开时迁移到按指纹存储。
const legacyId = ref(defaultSrc)

function showDocument(nextSrc, nextLegacyId, nextName) {
  store.openDocument(null)
  src.value = nextSrc
  legacyId.value = nextLegacyId
  fileName.value = nextName
}

function onDocumentReady({ fingerprint }) {
  store.openDocument(fingerprint || legacyId.value, [legacyId.value])
}

async function openFile(file) {
  const looksPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
  if (!looksPdf) {
    fileError.value = '请选择 PDF 文件'
    return
  }
  fileError.value = ''
  const data = new Uint8Array(await file.arrayBuffer())
  showDocument(data, `file:${file.name}:${file.size}:${file.lastModified}`, file.name)
}

function restoreDefault() {
  if (src.value === defaultSrc) return
  fileError.value = ''
  showDocument(defaultSrc, defaultSrc, defaultName)
}
</script>

<template>
  <PdfViewer
    :src="src"
    :file-name="fileName"
    :file-error="fileError"
    :can-restore="src !== defaultSrc"
    @open-file="openFile"
    @restore="restoreDefault"
    @document-ready="onDocumentReady"
  />
  <CommentPanel />
</template>
