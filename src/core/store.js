import { inject, reactive, shallowRef } from 'vue'
import { loadAnnotations, saveAnnotations } from './persistence.js'

export const REVIEW_STORE = Symbol('review-store')

export function useReviewStore() {
  const store = inject(REVIEW_STORE)
  if (!store) throw new Error('review store is not provided')
  return store
}

function wrap(index, total) {
  return ((index % total) + total) % total
}

export function createReviewStore({ storage, createId = () => crypto.randomUUID(), now = () => new Date() } = {}) {
  const state = reactive({
    docKey: null,
    annotations: [],
    activeId: null,
    matchIndex: {},
  })
  // id -> { matches: [{ start, end, pages, confidence }], preferredIndex }
  const resolved = shallowRef(new Map())
  const scrollHandlers = new Set()
  let pendingScroll = null

  function persist() {
    saveAnnotations(state.docKey, state.annotations, storage)
  }

  function matchesOf(id) {
    return resolved.value.get(id)?.matches || []
  }

  function currentMatchIndex(id) {
    const total = matchesOf(id).length
    if (!total) return 0
    const saved = state.matchIndex[id]
    return wrap(typeof saved === 'number' ? saved : resolved.value.get(id).preferredIndex, total)
  }

  function emitScroll(id) {
    const matches = matchesOf(id)
    if (!matches.length) {
      pendingScroll = id
      return
    }
    pendingScroll = null
    const matchIndex = currentMatchIndex(id)
    for (const handler of scrollHandlers) handler({ id, matchIndex, match: matches[matchIndex] })
  }

  function openDocument(docKey, legacyIds = []) {
    state.docKey = docKey
    state.annotations = docKey ? loadAnnotations(docKey, legacyIds, storage) : []
    state.activeId = null
    state.matchIndex = {}
    resolved.value = new Map()
    pendingScroll = null
  }

  function add(target, body) {
    const annotation = { id: createId(), body, createdAt: now().toISOString(), target }
    state.annotations = [...state.annotations, annotation]
    persist()
    select(annotation.id)
    return annotation
  }

  function addMany(items) {
    if (!items.length) return []
    const createdAt = now().toISOString()
    const added = items.map((item) => ({
      id: createId(),
      body: item.body,
      createdAt,
      target: { exact: item.exact },
    }))
    state.annotations = [...state.annotations, ...added]
    persist()
    select(added[0].id)
    return added
  }

  function remove(id) {
    state.annotations = state.annotations.filter((item) => item.id !== id)
    const { [id]: _, ...rest } = state.matchIndex
    state.matchIndex = rest
    if (state.activeId === id) state.activeId = null
    if (pendingScroll === id) pendingScroll = null
    persist()
  }

  function setResolved(map) {
    resolved.value = map
    const next = {}
    for (const [id, info] of map) {
      const saved = state.matchIndex[id]
      if (!info.matches.length) continue
      next[id] = typeof saved === 'number' && saved < info.matches.length ? saved : info.preferredIndex
    }
    state.matchIndex = next
    if (pendingScroll && matchesOf(pendingScroll).length) emitScroll(pendingScroll)
  }

  function select(id, matchIndex) {
    state.activeId = id
    if (typeof matchIndex === 'number') state.matchIndex = { ...state.matchIndex, [id]: matchIndex }
    emitScroll(id)
  }

  function step(id, delta) {
    const total = matchesOf(id).length
    if (total <= 1) return
    select(id, wrap(currentMatchIndex(id) + delta, total))
  }

  function onScroll(handler) {
    scrollHandlers.add(handler)
    return () => scrollHandlers.delete(handler)
  }

  return {
    state,
    resolved,
    openDocument,
    add,
    addMany,
    remove,
    setResolved,
    select,
    step,
    currentMatchIndex,
    matchesOf,
    onScroll,
  }
}
