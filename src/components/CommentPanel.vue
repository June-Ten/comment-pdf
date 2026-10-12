<script setup>
const props = defineProps({
  comments: { type: Array, required: true },
  activeId: { type: String, default: null },
})

const emit = defineEmits(['select', 'remove'])

function pageLabel(comment) {
  const pages = [...new Set(comment.anchors.map((anchor) => anchor.page))].sort((a, b) => a - b)
  if (pages.length === 1) return `第 ${pages[0]} 页`
  return `第 ${pages[0]}–${pages.at(-1)} 页`
}
</script>

<template>
  <aside class="comment-panel">
    <header>
      <h1>评论</h1>
      <span>{{ comments.length }}</span>
    </header>
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
  </aside>
</template>
