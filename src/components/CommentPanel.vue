<script setup>
import { ref } from 'vue'

const props = defineProps({
  comments: { type: Array, required: true },
  commentLocated: { type: Object, default: () => ({}) },
  commentIndex: { type: Object, default: () => ({}) },
  activeId: { type: String, default: null },
})

const emit = defineEmits(['select', 'remove', 'add-batch', 'step-match'])

const rawStatements = ref('')
const noteBody = ref('')

function matchPages(comment) {
  return props.commentLocated[comment.id]?.pages || []
}

function currentIndex(comment) {
  const pages = matchPages(comment)
  if (!pages.length) return 0
  const raw = props.commentIndex[comment.id] ?? props.commentLocated[comment.id]?.preferredIndex ?? 0
  return ((raw % pages.length) + pages.length) % pages.length
}

function pageLabel(comment) {
  const matches = matchPages(comment)
  if (matches.length === 0) return '未匹配到正文'
  const idx = currentIndex(comment)
  const item = matches[idx]
  const list = Array.isArray(item) ? item : [item]
  if (list.length <= 1) return `第 ${list[0]} 页`
  return `第 ${list[0]}–${list.at(-1)} 页`
}

function submitStatements() {
  const lines = rawStatements.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (!lines.length) return
  const defaultBody = noteBody.value.trim() || 'AI 检出违规语句'
  const items = lines.map((line) => {
    const sep = line.indexOf('｜') >= 0 ? '｜' : line.indexOf('|') >= 0 ? '|' : ''
    if (!sep) return { quote: line, body: defaultBody }
    const [quote, ...rest] = line.split(sep)
    return {
      quote: quote.trim(),
      body: rest.join(sep).trim() || defaultBody,
    }
  }).filter((item) => item.quote)
  if (!items.length) return
  emit('add-batch', items)
  rawStatements.value = ''
  noteBody.value = ''
}
</script>

<template>
  <aside class="comment-panel">
    <header>
      <h1>评论与违规项</h1>
      <span>{{ comments.length }}</span>
    </header>
    <form class="ai-importer" @submit.prevent="submitStatements">
      <textarea
        v-model="rawStatements"
        rows="3"
        placeholder="粘贴 AI 返回的违规语句，一行一条（可用「原文 | 原因」附带说明）"
      ></textarea>
      <div class="ai-importer-row">
        <input
          v-model="noteBody"
          type="text"
          placeholder="默认批注（可选）"
        >
        <button type="submit" :disabled="!rawStatements.trim()">定位并高亮</button>
      </div>
    </form>
    <div class="panel-body">
      <p v-if="comments.length === 0" class="empty">粘贴违规语句或直接划选正文。仅保存原句文字，每次按文字在页面中匹配位置并高亮。</p>
      <ol v-else class="comment-list">
        <li
          v-for="comment in comments"
          :key="comment.id"
          class="comment-card"
          :class="{ active: comment.id === activeId, unmatched: matchPages(comment).length === 0 }"
        >
          <div class="comment-top">
            <span class="meta-badge" :class="{ warn: matchPages(comment).length === 0 }">
              {{ pageLabel(comment) }}
            </span>
            <div v-if="matchPages(comment).length > 1" class="occurrence-nav">
              <button
                type="button"
                aria-label="上一处"
                @click="emit('step-match', { id: comment.id, delta: -1 })"
              >‹</button>
              <span>{{ currentIndex(comment) + 1 }} / {{ matchPages(comment).length }}</span>
              <button
                type="button"
                aria-label="下一处"
                @click="emit('step-match', { id: comment.id, delta: 1 })"
              >›</button>
            </div>
            <button type="button" class="remove" @click="emit('remove', comment.id)">删除</button>
          </div>
          <button type="button" class="comment-main" @click="emit('select', comment.id)">
            <div class="field-row quote-row">
              <span class="field-tag quote-tag">原文</span>
              <span class="quote">{{ comment.quote }}</span>
            </div>
            <div class="field-row body-row">
              <span class="field-tag body-tag">批注</span>
              <span class="body">{{ comment.body }}</span>
            </div>
          </button>
        </li>
      </ol>
    </div>
  </aside>
</template>
