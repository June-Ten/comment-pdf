const STORAGE_VERSION = 2

function storageKey(docId) {
  return `comment-pdf:${docId}`
}

function cleanComment(item) {
  return {
    id: item.id,
    quote: item.quote,
    prefix: item.prefix || '',
    suffix: item.suffix || '',
    body: item.body,
    createdAt: item.createdAt,
  }
}

export function loadComments(docId) {
  try {
    const raw = localStorage.getItem(storageKey(docId))
    if (!raw) return []
    const data = JSON.parse(raw)
    if (data?.docId !== docId) return []
    if (data?.version !== 1 && data?.version !== STORAGE_VERSION) return []
    return Array.isArray(data.comments) ? data.comments.map(cleanComment) : []
  } catch {
    return []
  }
}

export function saveComments(docId, comments) {
  localStorage.setItem(
    storageKey(docId),
    JSON.stringify({
      version: STORAGE_VERSION,
      docId,
      comments: comments.map(cleanComment),
    }),
  )
}
