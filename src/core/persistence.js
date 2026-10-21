const VERSION = 3
const KEY_PREFIX = `comment-pdf:v${VERSION}:`
const LEGACY_PREFIX = 'comment-pdf:'

function defaultStorage() {
  return typeof localStorage === 'undefined' ? null : localStorage
}

function cleanTarget(target = {}) {
  const out = { exact: String(target.exact || '') }
  if (target.prefix) out.prefix = String(target.prefix)
  if (target.suffix) out.suffix = String(target.suffix)
  if (Number.isInteger(target.start) && Number.isInteger(target.end)) {
    out.start = target.start
    out.end = target.end
  }
  if (Number.isInteger(target.page)) out.page = target.page
  return out
}

export function cleanAnnotation(item) {
  return {
    id: String(item.id),
    body: String(item.body || ''),
    createdAt: item.createdAt || new Date(0).toISOString(),
    target: cleanTarget(item.target),
  }
}

// v1/v2 存的是 { quote, prefix, suffix }，没有字符位置。
export function fromLegacy(item) {
  return cleanAnnotation({
    id: item.id,
    body: item.body,
    createdAt: item.createdAt,
    target: { exact: item.quote, prefix: item.prefix, suffix: item.suffix },
  })
}

function readJson(storage, key) {
  try {
    const raw = storage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function readLegacy(storage, legacyId) {
  const data = readJson(storage, LEGACY_PREFIX + legacyId)
  if (data?.docId !== legacyId || (data.version !== 1 && data.version !== 2)) return null
  if (!Array.isArray(data.comments)) return null
  return data.comments.filter((item) => item?.id && item.quote).map(fromLegacy)
}

export function loadAnnotations(docKey, legacyIds = [], storage = defaultStorage()) {
  if (!storage || !docKey) return []
  const data = readJson(storage, KEY_PREFIX + docKey)
  if (data?.version === VERSION && data.docKey === docKey && Array.isArray(data.annotations)) {
    return data.annotations.filter((item) => item?.id && item.target?.exact).map(cleanAnnotation)
  }
  for (const legacyId of legacyIds) {
    const migrated = legacyId && readLegacy(storage, legacyId)
    if (migrated?.length) {
      saveAnnotations(docKey, migrated, storage)
      return migrated
    }
  }
  return []
}

export function saveAnnotations(docKey, annotations, storage = defaultStorage()) {
  if (!storage || !docKey) return
  storage.setItem(
    KEY_PREFIX + docKey,
    JSON.stringify({ version: VERSION, docKey, annotations: annotations.map(cleanAnnotation) }),
  )
}
