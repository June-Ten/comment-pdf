<script setup>
import { ref, watch } from 'vue'
import CommentPanel from './components/CommentPanel.vue'
import PdfView from './components/PdfView.vue'
import { loadComments, saveComments } from './lib/comments.js'

const defaultSrc = `${import.meta.env.BASE_URL}pdf格式测试文件.pdf`
const defaultName = 'pdf格式测试文件.pdf'

const src = ref(defaultSrc)
const docId = ref(defaultSrc)
const fileName = ref(defaultName)
const fileError = ref('')
const comments = ref(loadComments(docId.value))
const commentLocated = ref({})
const commentIndex = ref({})
const activeId = ref(null)
const focusNonce = ref(0)

watch(comments, (value) => saveComments(docId.value, value), { deep: true })

function showDocument(nextSrc, nextId, nextName) {
  src.value = nextSrc
  docId.value = nextId
  fileName.value = nextName
  comments.value = loadComments(nextId)
  commentLocated.value = {}
  commentIndex.value = {}
  activeId.value = null
  focusNonce.value = 0
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

function addComment(draft) {
  const comment = {
    id: crypto.randomUUID(),
    quote: draft.quote,
    prefix: draft.prefix || '',
    suffix: draft.suffix || '',
    body: draft.body,
    createdAt: new Date().toISOString(),
  }
  comments.value = [...comments.value, comment]
  activeId.value = comment.id
  focusNonce.value += 1
}

function addBatch(items) {
  if (!items.length) return
  const now = new Date().toISOString()
  const added = items.map((item) => ({
    id: crypto.randomUUID(),
    quote: item.quote,
    prefix: item.prefix || '',
    suffix: item.suffix || '',
    body: item.body || '违规语句',
    createdAt: now,
  }))
  comments.value = [...comments.value, ...added]
  activeId.value = added[0].id
  focusNonce.value += 1
}

function removeComment(id) {
  comments.value = comments.value.filter((comment) => comment.id !== id)
  const nextIndex = { ...commentIndex.value }
  delete nextIndex[id]
  commentIndex.value = nextIndex
  if (activeId.value === id) activeId.value = null
}

function selectComment(payload) {
  if (typeof payload === 'object' && payload !== null) {
    activeId.value = payload.id
    commentIndex.value = {
      ...commentIndex.value,
      [payload.id]: payload.matchIndex,
    }
  } else {
    activeId.value = payload
  }
  focusNonce.value += 1
}

function onLocated(summary) {
  commentLocated.value = summary
  const next = { ...commentIndex.value }
  for (const [id, info] of Object.entries(summary)) {
    const total = info.pages.length
    if (!total) {
      delete next[id]
    } else if (typeof next[id] !== 'number' || next[id] >= total) {
      next[id] = info.preferredIndex || 0
    }
  }
  commentIndex.value = next
}

function stepCommentMatch({ id, delta }) {
  const pages = commentLocated.value[id]?.pages || []
  if (pages.length <= 1) return
  const current = commentIndex.value[id] ?? commentLocated.value[id]?.preferredIndex ?? 0
  const nextIdx = (current + delta + pages.length) % pages.length
  commentIndex.value = {
    ...commentIndex.value,
    [id]: nextIdx,
  }
  activeId.value = id
  focusNonce.value += 1
}
</script>

<template>
  <PdfView
    :src="src"
    :file-name="fileName"
    :file-error="fileError"
    :can-restore="src !== defaultSrc"
    :comments="comments"
    :active-id="activeId"
    :comment-index="commentIndex"
    :focus-nonce="focusNonce"
    @create="addComment"
    @open-file="openFile"
    @restore="restoreDefault"
    @select="selectComment"
    @located="onLocated"
  />
  <CommentPanel
    :comments="comments"
    :comment-located="commentLocated"
    :comment-index="commentIndex"
    :active-id="activeId"
    @add-batch="addBatch"
    @step-match="stepCommentMatch"
    @select="selectComment"
    @remove="removeComment"
  />
</template>
