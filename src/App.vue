<script setup>
import { ref, watch } from 'vue'
import CommentPanel from './components/CommentPanel.vue'
import PdfView from './components/PdfView.vue'
import { loadComments, saveComments } from './lib/comments.js'

const docId = `${import.meta.env.BASE_URL}pdf格式测试文件.pdf`
const comments = ref(loadComments(docId))
const activeId = ref(null)
const focusNonce = ref(0)

watch(comments, (value) => saveComments(docId, value), { deep: true })

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
</script>

<template>
  <PdfView
    :src="docId"
    :comments="comments"
    :active-id="activeId"
    :focus-nonce="focusNonce"
    @create="addComment"
    @select="selectComment"
  />
  <CommentPanel
    :comments="comments"
    :active-id="activeId"
    @select="selectComment"
    @remove="removeComment"
  />
</template>
