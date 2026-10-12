<script setup>
import { onBeforeUnmount, onMounted } from 'vue'

const props = defineProps({
  comments: { type: Array, required: true },
  activeId: { type: String, default: null },
  query: { type: String, default: '' },
  matches: { type: Array, default: () => [] },
  matchIndex: { type: Number, default: 0 },
})

const emit = defineEmits(['select', 'remove', 'search', 'step', 'choose'])

function pageLabel(comment) {
  const pages = [...new Set(comment.anchors.map((anchor) => anchor.page))].sort((a, b) => a - b)
  if (pages.length === 1) return `第 ${pages[0]} 页`
  return `第 ${pages[0]}–${pages.at(-1)} 页`
}

function onKeyDown(event) {
  if (event.target.closest('textarea')) return
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
  if (!props.query.trim() || !props.matches.length) return
  event.preventDefault()
  emit('step', event.key === 'ArrowDown' ? 1 : -1)
}

onMounted(() => window.addEventListener('keydown', onKeyDown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeyDown))
</script>

<template>
  <aside class="comment-panel">
    <header>
      <h1>评论</h1>
      <span>{{ comments.length }}</span>
    </header>
    <form class="finder" @submit.prevent>
      <input
        :value="query"
        type="search"
        placeholder="查找正文，根据文字高亮所有匹配项"
        @input="emit('search', $event.target.value)"
      >
      <div v-if="query.trim()" class="match-nav">
        <button type="button" aria-label="上一项" :disabled="!matches.length" @click="emit('step', -1)">↑</button>
        <span>{{ matches.length ? `第 ${matchIndex + 1} / ${matches.length} 项` : '无匹配' }}</span>
        <button type="button" aria-label="下一项" :disabled="!matches.length" @click="emit('step', 1)">↓</button>
      </div>
    </form>
    <div class="panel-body">
      <ol v-if="query.trim()" class="match-list">
        <li
          v-for="(match, index) in matches"
          :key="match.id"
          :class="{ active: index === matchIndex }"
        >
          <button type="button" class="comment-main" @click="emit('choose', index)">
            <span class="meta">第 {{ index + 1 }} 项 · 第 {{ match.page }} 页</span>
            <span class="quote">{{ match.quote }}</span>
          </button>
        </li>
        <li v-if="matches.length === 0" class="empty-item">没有匹配的文字</li>
      </ol>
      <p v-if="comments.length === 0" class="empty">选中正文后写下评论。评论和高亮保存在这台浏览器里，刷新后仍会显示。</p>
      <ol v-else>
        <li
          v-for="comment in comments"
          :key="comment.id"
          :class="{ active: comment.id === activeId }"
        >
          <button type="button" class="comment-main" @click="emit('select', comment.id)">
            <span class="meta">{{ pageLabel(comment) }}</span>
            <span class="quote">{{ comment.quote }}</span>
            <span class="body">{{ comment.body }}</span>
          </button>
          <button type="button" class="remove" @click="emit('remove', comment.id)">删除</button>
        </li>
      </ol>
    </div>
  </aside>
</template>
