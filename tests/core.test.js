import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadAnnotations, saveAnnotations } from '../src/core/persistence.js'
import { alignLineRects, dedupeRects } from '../src/core/rects.js'
import { approximateSearch, resolveTarget, targetFromSpan } from '../src/core/resolver.js'
import { createReviewStore } from '../src/core/store.js'
import { buildTextIndex, detectFurniture, normalizeText, pagesInSpan, rawPosition } from '../src/core/textIndex.js'

const VIEW = [0, 0, 600, 800]

function page(number, lines, { header, footer } = {}) {
  const items = []
  if (header) items.push({ str: header, hasEOL: true, y: 780 })
  lines.forEach((str, idx) => items.push({ str, hasEOL: true, y: 700 - idx * 20 }))
  if (footer) items.push({ str: footer, hasEOL: false, y: 20 })
  return { number, view: VIEW, items }
}

function memoryStorage() {
  const data = new Map()
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    data,
  }
}

test('normalizeText folds width, whitespace and (loosely) punctuation', () => {
  assert.equal(normalizeText('ＡＢ c\n１'), 'ABc1')
  assert.equal(normalizeText('甲方，应当 Pay!', true), '甲方应当pay')
})

test('raw positions map back to page, item and offset', () => {
  const index = buildTextIndex([page(1, ['第一行文字', '第二行']), page(2, ['第三行'])])
  const at = index.text.indexOf('第二行')
  assert.equal(rawPosition(index, 1, 1, 0), at)
  assert.equal(index.pageOf[at], 1)
  assert.equal(index.itemOf[at], 1)
  assert.deepEqual(pagesInSpan(index, 0, index.text.length), [1, 2])
})

test('exact match ignores line breaks and spaces', () => {
  const index = buildTextIndex([page(1, ['乙方不得将本工程', '转 包给第三方。'])])
  const { matches } = resolveTarget(index, { exact: '本工程转包给第三方' })
  assert.equal(matches.length, 1)
  assert.equal(matches[0].confidence, 'exact')
  assert.equal(index.text.slice(matches[0].start, matches[0].end).replace(/\s/g, ''), '本工程转包给第三方')
})

test('repeated headers and footers do not break a sentence across pages', () => {
  const pages = [
    page(1, ['正文一', '乙方不得将本工程'], { header: '某某合同', footer: '第 1 页' }),
    page(2, ['转包给第三方。', '正文二'], { header: '某某合同', footer: '第 2 页' }),
    page(3, ['正文三'], { header: '某某合同', footer: '第 3 页' }),
  ]
  const furniture = detectFurniture(pages)
  assert.ok(furniture[0].has(0), 'header is furniture')
  assert.ok(furniture[0].has(3), 'page number is furniture')
  assert.ok(!furniture[0].has(1), 'body is not furniture')

  const index = buildTextIndex(pages)
  const { matches } = resolveTarget(index, { exact: '乙方不得将本工程转包给第三方' })
  assert.equal(matches.length, 1)
  assert.deepEqual(matches[0].pages, [1, 2])
})

test('punctuation differences fall back to a loose match', () => {
  const index = buildTextIndex([page(1, ['甲方应当，在三日内付款。'])])
  const { matches } = resolveTarget(index, { exact: '甲方应当在三日内付款' })
  assert.equal(matches[0].confidence, 'loose')
})

test('a reworded quote still resolves approximately', () => {
  const index = buildTextIndex([page(1, ['前文无关内容', '承包人应在收到通知后七日内完成整改', '后文'])])
  const { matches } = resolveTarget(index, { exact: '承包人应在收到通知后7日内完成整改' })
  assert.equal(matches.length, 1)
  assert.equal(matches[0].confidence, 'fuzzy')
  assert.match(index.text.slice(matches[0].start, matches[0].end), /承包人.*整改/)
})

test('approximateSearch reports start, end and distance', () => {
  assert.deepEqual(approximateSearch('xxabcdxx', 'abed', 1), { cost: 1, start: 2, end: 6 })
  assert.equal(approximateSearch('xxxx', 'abcd', 1), null)
})

test('prefix/suffix and position pick the right occurrence', () => {
  const index = buildTextIndex([page(1, ['第一条 违约责任 由甲方承担', '第二条 违约责任 由乙方承担'])])
  const second = index.text.lastIndexOf('违约责任')
  const target = targetFromSpan(index, second, second + 4)
  assert.equal(target.exact, '违约责任')
  const byContext = resolveTarget(index, { exact: '违约责任', suffix: target.suffix })
  assert.equal(byContext.matches.length, 2)
  assert.equal(byContext.preferredIndex, 1)
  assert.equal(resolveTarget(index, target).preferredIndex, 1)
  assert.equal(resolveTarget(index, { exact: '违约责任' }).preferredIndex, 0)
})

test('targetFromSpan trims surrounding whitespace', () => {
  const index = buildTextIndex([page(1, ['  空白包围  '])])
  const target = targetFromSpan(index, 0, index.text.length)
  assert.equal(target.exact, '空白包围')
  assert.equal(index.text.slice(target.start, target.end), '空白包围')
})

test('rects on one line merge into a single underline', () => {
  const merged = alignLineRects(dedupeRects([
    { x: 10, y: 100, width: 40, height: 12 },
    { x: 52, y: 101, width: 30, height: 11 },
    { x: 12, y: 100, width: 30, height: 12 },
  ]))
  assert.deepEqual(merged, [{ x: 10, y: 100, width: 72, height: 12 }])
})

test('legacy comments migrate to the fingerprint key', () => {
  const storage = memoryStorage()
  storage.setItem('comment-pdf:/doc.pdf', JSON.stringify({
    version: 2,
    docId: '/doc.pdf',
    comments: [{ id: 'a', quote: '原句', prefix: '前', suffix: '后', body: '批注', createdAt: 't' }],
  }))
  const loaded = loadAnnotations('fp-1', ['/doc.pdf'], storage)
  assert.deepEqual(loaded, [{ id: 'a', body: '批注', createdAt: 't', target: { exact: '原句', prefix: '前', suffix: '后' } }])
  assert.ok(storage.data.has('comment-pdf:v3:fp-1'))

  saveAnnotations('fp-1', [], storage)
  assert.deepEqual(loadAnnotations('fp-1', ['/doc.pdf'], storage), [], 'deleted comments do not come back from legacy')
})

test('store keeps match index in range and defers scroll until resolved', () => {
  let n = 0
  const store = createReviewStore({ storage: memoryStorage(), createId: () => `id${++n}` })
  const scrolls = []
  store.onScroll((event) => scrolls.push(event))
  store.openDocument('doc')
  const { id } = store.add({ exact: '句子' }, '批注')
  assert.equal(scrolls.length, 0)

  const match = (start) => ({ start, end: start + 2, pages: [1], confidence: 'exact' })
  store.setResolved(new Map([[id, { matches: [match(0), match(5), match(9)], preferredIndex: 1 }]]))
  assert.equal(scrolls.length, 1)
  assert.equal(scrolls[0].matchIndex, 1)

  store.step(id, 1)
  store.step(id, 1)
  assert.equal(store.currentMatchIndex(id), 0, 'wraps around')
  store.step(id, -1)
  assert.equal(store.currentMatchIndex(id), 2)

  store.setResolved(new Map([[id, { matches: [match(0), match(5)], preferredIndex: 1 }]]))
  assert.equal(store.currentMatchIndex(id), 1, 'out-of-range index resets to preferred')
})
