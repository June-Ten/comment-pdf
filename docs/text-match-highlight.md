# 按文字匹配定位并高亮（无坐标模式）

原方案见 [selection-highlight.md](selection-highlight.md)，那份方案在松手时把选区换成 PDF 坐标存下来。

这份文档说明改造后的做法：**后端或 AI 只返回违规原句，给不出坐标；前端只存文字，每次在文字层渲染完成后反查这些句子在页面里的位置，再算出矩形并画高亮。**

先读「原理」和「关键点」，后面的「细分」对应到具体函数。

## 原理

AI 审阅一份 PDF 后，只能给出“哪句话违规、为什么违规”，不知道这句话印在第几页的哪个坐标上。手动划词写下的评论如果也只存文字，两套来源就能走同一条路。

整条链路的顺序因此反过来了：

```
原方案：  划词 → 算 PDF 坐标 → 存坐标 → 渲染时把坐标画回屏幕
现方案：  得到句子（AI 或划词） → 只存句子 → 渲染出文字层 → 在文字层里找句子 → 造出 Range → 算坐标并画回屏幕
```

PDF.js 渲染每一页时，还是生成那三层：最下面是 `canvas`，中间是画下划线的 `svg`，最上面是透明的 `.textLayer`。透明文字层里的 `span` 既有文本，又有浏览器排好版的位置。

只要在 `.textLayer` 里找到那句话对应的首尾字符，用浏览器的 `document.createRange()` 把这段字包起来，剩下的事就和“用户刚刚亲手拖选了这段字”完全一样：从 `Range.getClientRects()` 拿到每一行的窗口矩形，换成 PDF 坐标，做去重和行对齐，再画进这一页的 SVG。

一句话在正文里可能出现不止一次。无论是 AI 给的违规句，还是用户手动划出来的短句，前端都把**每一处匹配**算出来，挂在这条评论下面。同一条评论的所有匹配处都画成金色下划线；当前正在看的那一处（`‹ 1 / N ›`）再铺一层黄色底色，并支持左右切换滚动过去。

## 关键点

1. **评论只存文字，不存坐标。** `localStorage` 里每条记录只有 `id`、`quote`、`prefix`、`suffix`、`body`、`createdAt`。旧版本带 `anchors` 的记录在读取时会自动剥掉坐标。
2. **定位发生在文字层渲染之后。** 只有 `pageMetrics` 有了值（代表这一轮所有页的 `TextLayer` 都已塞进 DOM），才调用 `locateComments` 去找字。缩放或换文档重绘文字层后，位置会重新算一遍。
3. **全文档拼接 + 忽略空白查找，天然支持跨页。** PDF 里的换行、字距、换页常常让一句话断成多段或跨到下一页。`documentText` 把所有页的叶子 `span` 按顺序拼成一张全文档字符表，并在去掉空白的 `compactText` 上查找，最后通过 `compact` 下标映射表还原回原本的文本节点偏移。同一句里既有连着的、又有跨行或跨页断开的，一次就能全部找齐。
4. **跨页匹配按页拆成多个 `Range` 再转矩形。** 每个字符记录自己来自哪一页（`chars[i] = { page, node, offset }`）。如果一次匹配横跨第 1 页末尾和第 2 页开头，直接对跨页 `Range` 调 `getClientRects()` 会把两页之间的空白缝隙也算进去。因此 `anchorsForHit` 先按 `page` 把这次匹配拆成每页一段，每页各自造一个 `Range` 调 `anchorsFromRange`，最后合并成 `[{ page: 1, rects }, { page: 2, rects }]`。
5. **一次匹配就是一组 `anchors`。** 造出 `Range` 之后，直接交给原有的 `anchorsFromRange`。去碎框、去重叠、同一行合并成一条下划线，全都复用，没有写第二套几何代码。
6. **AI 句子和手动划词走同一套多处匹配。** 每条评论定位后得到 `{ matches, preferredIndex }`。`matches` 是全文找到的每一处。AI 导入没有前后文，默认停在第 1 处（`preferredIndex = 0`）；手动划词带 `prefix` / `suffix`，先给每一处按前后文打分，默认停在分数最高的那一处，但其余处仍然保留，可以用 `‹ ›` 切过去看。
7. **当前是第几处，由 `commentIndex[评论id]` 记着。** 同一条评论的所有匹配处都画下划线；只有“这条评论被选中，且是当前第 k 处”的那一组矩形才加上 `active`（铺黄色底色），滚动也滚向 `[data-comment-match="评论id:k"]`。
8. **点正文里的下划线，会反推点中了第几处。** `commentAtPoint` 把点击坐标换成 PDF 点后，同时遍历评论和它的 `matches`，返回 `{ id, matchIndex }`。点中第 2 处，右侧卡片就会自动切到 `2 / N`。

下面按这 8 点展开。

## 细分

### 1. 存储结构与旧数据兼容

`src/lib/comments.js` 把 `STORAGE_VERSION` 升到了 `2`。写入和读取都会经过 `cleanComment`：

```js
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
```

读取时同时接受 `version === 1` 和 `version === 2`。老数据里就算存了 `anchors`，经过 `cleanComment` 也会被丢掉，改由当前页面的文字层重新匹配。

评论有两个来源：

- **右侧批量粘贴（AI 违规句）**：`CommentPanel.vue` 的 `submitStatements` 按行拆分。一行可以直接是一句原文，也可以写成 `原文 | 违规原因`（支持半角 `|` 和全角 `｜`）。生成的记录没有 `prefix` 和 `suffix`。
- **正文手动划词**：`PdfView.vue` 的 `onPointerUp` 用 `captureSelection` 拿到选区。草稿阶段仍然保留 `draft.anchors`，这样松手瞬间不用等全文搜索就能看到下划线和评论框；点“发送”时只把 `quote`、`prefix`、`suffix`、`body` 发给 `App.vue`，坐标就此丢弃。

### 2. 全文档文字怎么建索引

在 `src/lib/search.js` 里，`documentText(root)` 按页顺序把整份文档 `.textLayer` 里的叶子 `span` 扫一遍，建出两份数组和两条字符串：

| 字段 | 含义 |
| --- | --- |
| `chars` | 长度等于 `text.length`。`chars[i]` 是第 `i` 个字符所在的 `{ page, node, offset }` |
| `text` | 整份文档所有叶子 `span` 原样拼起来的字符串 |
| `compact` | 长度等于 `compactText.length`。`compact[k]` 记着“第 `k` 个非空白字符在 `chars` 里的下标” |
| `compactText` | 去掉所有空白字符（空格、换行、制表符）之后的全文档字符串 |

例子。假设第 1 页末尾的 `span` 是 `"禁止"`，第 2 页开头的 `span` 是 `" 转包"`（前面有个空格）：

- `text` 是 `"禁止 转包"`（长 5）
- `compactText` 是 `"禁止转包"`（长 4）
- `compact` 是 `[0, 1, 3, 4]`（跳过了下标 2 的空格）
- `chars[0..1].page` 是 `1`，`chars[2..4].page` 是 `2`

AI 返回 `"禁止转包"` 时，在 `compactText` 里找到下标 `0..3`，通过 `compact[0]` 和 `compact[3]` 查回 `chars` 的下标 `0` 和 `4`。

### 3. 查找与跨页拆段

`findSpansInDocument(doc, needle)` 把目标句子的空白全部去掉得到 `target`，在 `doc.compactText` 里循环 `indexOf`，再用 `doc.compact` 换回 `chars` 的 `{ start, end }`。统一在 `compactText` 上找，是因为精确匹配本来就是忽略空白匹配的子集；如果一句话在文中出现两处，第 1 处在同一行连着、第 2 处被换行或换页拆开，只找一次就能把两处都拿到。

拿到 `{ start, end }` 后，`anchorsForHit(doc, hit, root, viewportFor)` 负责把它变成 PDF 矩形：

1. 遍历 `start..end`，按 `doc.chars[i].page` 把连续相同页码的字符归成一段（单页匹配只有 1 段，跨两页就有 2 段）。
2. 对每一段单独调用 `document.createRange()`，起点是该段第一个字符的 `{ node, offset }`，终点是该段最后一个字符的 `offset + 1`。按页拆开造 `Range`，是为了避免跨页 `Range.getClientRects()` 把两页中间的空白缝隙算成一个跨页大框。
3. 每个单页 `Range` 交给 `selection.js` 的 `anchorsFromRange(range, root, viewportFor)`：
   - `range.getClientRects()` 取出每一行的窗口矩形
   - 滤掉宽高小于 2px 的碎框、中心不在页面里的框、宽高都超过页面 85% 的整页误框
   - 用该页的 `PageViewport.convertToPdfPoint` 换成 PDF 坐标
   - `dedupeRects` 去掉重叠面积超过自身 60% 的框
   - `alignLineRects` 把同一行的碎框拉齐底边和行高，并把间隙小于 `max(1.5, 行高 × 0.6)` 点的段合并成一条下划线
4. 把各页算出来的 `anchors` 合在一起，跨页匹配就会得到 `[{ page: 1, rects: [...] }, { page: 2, rects: [...] }]`，两页各自画上自己的下划线，右侧页码显示为 `第 1–2 页`。

### 4. 多处匹配与前后文打分

`locateComments(root, viewportFor, comments)` 在所有页都渲染完之后运行。它对每条评论收集全文所有的匹配处：

```js
matches.push({
  page: anchors[0].page,
  anchors,
  score: contextScore(page, hit, comment.prefix, comment.suffix),
})
```

为什么手动划词要算 `score`？因为用户可能在一篇合同里划了“违约责任”四个字，这四个字在全文出现了 5 次。用户当时划的是第 3 次，松手时 `captureSelection` 顺便记下了那一处前后的 20 个字（`prefix` / `suffix`）。

`contextScore` 把命中位置前后的 40 个字取出来，去掉空白后比对：

- 前文紧挨着以 `prefix` 结尾：+2 分；只包含 `prefix`：+1 分
- 后文紧挨着以 `suffix` 开头：+2 分；只包含 `suffix`：+1 分

当一条评论匹配到多处、且本身带有 `prefix` 或 `suffix` 时，`locateComments` 会选出得分最高的那一处作为 `preferredIndex`。其余 4 处不会扔掉，仍然留在 `matches` 里。

AI 导入的违规句没有 `prefix` / `suffix`，`preferredIndex` 固定是 `0`（第一处）。

最终 `locateComments` 返回一张表：

```js
{
  [commentId]: {
    matches: [
      { page: 1, anchors: [ /* PDF 矩形 */ ], score: 0 },
      { page: 3, anchors: [ /* PDF 矩形 */ ], score: 4 },
    ],
    preferredIndex: 1
  }
}
```

`PdfView.vue` 把完整的表留在自己的 `commentLocated` 里用来画 SVG，同时把轻量摘要 `{ pages: [1, 3], preferredIndex: 1 }` 通过 `located` 事件发给 `App.vue`，供右侧面板显示页码和总数。

### 5. 高亮怎么画、怎么区分“当前第几处”

`App.vue` 用 `commentIndex`（形如 `{ [commentId]: 当前序号 }`）记录每条评论当前看的是第几处。收到 `located` 事件时，如果某条评论还没有序号，或者原来的序号越界了，就初始化成 `preferredIndex`。

`PdfView.vue` 的 `highlightRects(pageNumber)` 画这一页的 SVG：

```js
  for (const comment of props.comments) {
    const info = commentLocated.value[comment.id]
    const matches = info?.matches || []
    const selectedIdx = currentMatchIndex(comment.id, matches.length, info?.preferredIndex)
    matches.forEach((match, matchIdx) => {
      for (const anchor of match.anchors) {
        if (anchor.page !== pageNumber) continue
        appendHighlight(items, {
          key: `comment-${comment.id}-${matchIdx}`,
          page: pageNumber,
          rects: anchor.rects,
          id: comment.id,
          matchKey: `${comment.id}:${matchIdx}`,
          active: comment.id === props.activeId && matchIdx === selectedIdx,
        })
      }
    })
  }
```

这里有两个细节：

- **所有匹配处都会画出来。** 只要某处匹配落在这一页，就会生成 `<g class="comment">`，画出金色下划线 `#e6a100`。
- **只有当前选中的那一处才铺底色。** `active` 的条件是 `comment.id === activeId && matchIdx === selectedIdx`。也就是说，如果一条违规句在文中出现了 3 次，选中这条评论时，3 处都有下划线，但只有当前正在看的那 1 处会铺上黄色半透明底色 `rgb(255 214 0 / 45%)`。

每个 `<g>` 上同时挂两个属性：

- `data-comment="评论id"`：兜底定位
- `data-comment-match="评论id:匹配序号"`：精确到第几处

### 6. 左右切换与点击反查

右侧卡片（`CommentPanel.vue`）从 `commentLocated[comment.id].pages` 拿到每一处所在的页码数组：

- 数组为空：显示“未匹配到正文”（例如 AI 改写了原句，导致原文里找不到）
- 只有 1 处：只显示 `第 P 页`
- 多于 1 处：显示当前处的页码 `第 P 页`，旁边出现 `‹ k / N ›`

点 `‹` 或 `›` 时发出 `step-match`。`App.vue` 的 `stepCommentMatch` 把该评论在 `commentIndex` 里的序号加一或减一（首尾循环），同时把 `activeId` 设为这条评论，并让 `focusNonce` 加 1。

`PdfView.vue` 监听 `focusNonce`，直接去找对应的那一处滚过去：

```js
const target =
  pagesRoot.value?.querySelector(`[data-comment-match="${props.activeId}:${idx}"]`) ||
  pagesRoot.value?.querySelector(`[data-comment="${props.activeId}"]`)
target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
```

反过来，如果用户在 PDF 正文里直接点某一条下划线，`commentAtPoint` 会从后往前遍历评论，再遍历该评论的 `matches`。命中某个矩形时返回 `{ id: comment.id, matchIndex }`。`App.vue` 的 `selectComment` 收到对象后，同时更新 `activeId` 和 `commentIndex[id]`，右侧卡片上的 `k / N` 和页码就会跟着跳到被点的那一处。

## 局限与边界

1. **跨页中间如果有页眉页脚文字，会打断连续子串。** 跨页匹配是把上一页末尾的 `span` 和下一页开头的 `span` 顺着拼起来。如果 PDF 在第 1 页底端或第 2 页顶端嵌了真实的文字型页码/页眉（例如“第 1 页”），它就会夹在两半句话中间，导致连贯的原句被隔开。
2. **AI 不能改写原文。** 忽略空白能扛住换行、换页和多余空格，但扛不住 AI 把原文概括了、改了标点或漏了字。给 AI 的提示词应当要求“原样摘录原文子串”。
3. **扫描件仍然不能用。** 没有文字层就没有 `span`，`documentText` 抽出来是空字符串，所有评论都会显示“未匹配到正文”。

## 文件与函数对照

| 想看或想改的地方 | 位置 |
| --- | --- |
| 全文档索引、跨页拆段、忽略空白匹配、前后文打分 | `src/lib/search.js` 的 `documentText`、`anchorsForHit`、`findSpansInDocument`、`contextScore`、`locateComments` |
| `Range` 转 PDF 矩形、去重、同行合并、点击反查第几处 | `src/lib/selection.js` 的 `anchorsFromRange`、`commentAtPoint` |
| 渲染后触发定位、按处画高亮、滚到指定处 | `src/components/PdfView.vue` 的 `highlightRects`、`watch([comments, pageMetrics])`、`watch(focusNonce)` |
| 每条评论当前停在第几处、左右切换 | `src/App.vue` 的 `commentLocated`、`commentIndex`、`stepCommentMatch` |
| 批量粘贴违规句、`‹ k / N ›` 按钮 | `src/components/CommentPanel.vue` 的 `submitStatements`、`.occurrence-nav` |
| 只存文字、剥掉旧坐标 | `src/lib/comments.js` 的 `cleanComment` |
