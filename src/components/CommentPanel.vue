<script setup>
import { ref } from 'vue'
import { useReviewStore } from '../core/store.js'

const store = useReviewStore()

const rawStatements = ref('')
const noteBody = ref('')

function matchesOf(annotation) {
  return store.resolved.value.get(annotation.id)?.matches || []
}

function currentMatch(annotation) {
  return matchesOf(annotation)[store.currentMatchIndex(annotation.id)]
}

function pageLabel(annotation) {
  const match = currentMatch(annotation)
  if (!match) return '未匹配到正文'
  const { pages } = match
  return pages.length <= 1 ? `第 ${pages[0]} 页` : `第 ${pages[0]}–${pages.at(-1)} 页`
}

function confidenceLabel(annotation) {
  const confidence = currentMatch(annotation)?.confidence
  if (confidence === 'loose') return '忽略标点'
  if (confidence === 'fuzzy') return '近似匹配'
  return ''
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
    if (!sep) return { exact: line, body: defaultBody }
    const [exact, ...rest] = line.split(sep)
    return {
      exact: exact.trim(),
      body: rest.join(sep).trim() || defaultBody,
    }
  }).filter((item) => item.exact)
  if (!items.length) return
  store.addMany(items)
  rawStatements.value = ''
  noteBody.value = ''
}
</script>

<template>
  <aside class="comment-panel">
    <header>
      <h1>评论与违规项</h1>
      <span>{{ store.state.annotations.length }}</span>
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
      <p v-if="store.state.annotations.length === 0" class="empty">粘贴违规语句或直接划选正文。评论按原句文字定位，PDF 改动后仍会尽量找回位置。</p>
      <ol v-else class="comment-list">
        <li
          v-for="annotation in store.state.annotations"
          :key="annotation.id"
          class="comment-card"
          :class="{ active: annotation.id === store.state.activeId, unmatched: matchesOf(annotation).length === 0 }"
        >
          <div class="comment-top">
            <span class="meta-badge" :class="{ warn: matchesOf(annotation).length === 0 }">
              {{ pageLabel(annotation) }}
            </span>
            <span v-if="confidenceLabel(annotation)" class="meta-badge approx">{{ confidenceLabel(annotation) }}</span>
            <div v-if="matchesOf(annotation).length > 1" class="occurrence-nav">
              <button type="button" aria-label="上一处" @click="store.step(annotation.id, -1)">‹</button>
              <span>{{ store.currentMatchIndex(annotation.id) + 1 }} / {{ matchesOf(annotation).length }}</span>
              <button type="button" aria-label="下一处" @click="store.step(annotation.id, 1)">›</button>
            </div>
            <button type="button" class="remove" @click="store.remove(annotation.id)">删除</button>
          </div>
          <button type="button" class="comment-main" @click="store.select(annotation.id)">
            <div class="field-row quote-row">
              <span class="field-tag quote-tag">原文</span>
              <span class="quote">{{ annotation.target.exact }}</span>
            </div>
            <div class="field-row body-row">
              <span class="field-tag body-tag">批注</span>
              <span class="body">{{ annotation.body }}</span>
            </div>
          </button>
        </li>
      </ol>
    </div>
  </aside>
</template>
