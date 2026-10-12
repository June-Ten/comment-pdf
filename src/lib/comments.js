const STORAGE_VERSION = 1

function storageKey(docId) {
  return `comment-pdf:${docId}`
}

export function loadComments(docId) {
  try {
    const raw = localStorage.getItem(storageKey(docId))
    if (!raw) return []
    const data = JSON.parse(raw)
    if (data?.version !== STORAGE_VERSION || data.docId !== docId) return []
    return Array.isArray(data.comments) ? data.comments : []
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
      docVersion: 1,
      comments,
    }),
  )
}
