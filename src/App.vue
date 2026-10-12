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
const activeId = ref(null)
const focusNonce = ref(0)
const query = ref('')
const matches = ref([])
const matchIndex = ref(0)
const matchFocus = ref(0)

watch(comments, (value) => saveComments(docId.value, value), { deep: true })

function showDocument(nextSrc, nextId, nextName) {
  src.value = nextSrc
  docId.value = nextId
  fileName.value = nextName
  comments.value = loadComments(nextId)
  activeId.value = null
  focusNonce.value = 0
  query.value = ''
  matches.value = []
  matchIndex.value = 0
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
    prefix: draft.prefix,
    suffix: draft.suffix,
    body: draft.body,
    createdAt: new Date().toISOString(),
    anchors: draft.anchors,
  }
  comments.value = [...comments.value, comment]
  activeId.value = comment.id
}

function removeComment(id) {
  comments.value = comments.value.filter((comment) => comment.id !== id)
  if (activeId.value === id) activeId.value = null
}

function selectComment(id) {
  activeId.value = id
  focusNonce.value += 1
}

function setMatches(list) {
  matches.value = list
  if (matchIndex.value >= list.length) matchIndex.value = 0
  if (list.length) matchFocus.value += 1
}

function stepMatch(delta) {
  if (!matches.value.length) return
  matchIndex.value = (matchIndex.value + delta + matches.value.length) % matches.value.length
  matchFocus.value += 1
}

function chooseMatch(index) {
  matchIndex.value = index
  matchFocus.value += 1
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
    :focus-nonce="focusNonce"
    :query="query"
    :matches="matches"
    :match-index="matchIndex"
    :match-focus="matchFocus"
    @create="addComment"
    @open-file="openFile"
    @restore="restoreDefault"
    @select="selectComment"
    @matches="setMatches"
  />
  <CommentPanel
    :comments="comments"
    :active-id="activeId"
    :query="query"
    :matches="matches"
    :match-index="matchIndex"
    @search="query = $event"
    @step="stepMatch"
    @choose="chooseMatch"
    @select="selectComment"
    @remove="removeComment"
  />
</template>
