# 架构：按原句定位的 PDF 评论与高亮

先读「原理」和「关键点」，把整条链路在脑子里立起来。后面的「细分」把每个关键点拆开，对照到具体函数、数值和边界。要改某块行为，先看文末的「改某块行为时看哪里」。

旧方案的两份文档（[selection-highlight.md](selection-highlight.md)、[text-match-highlight.md](text-match-highlight.md)）描述的是重构前的实现，只作历史参考。

## 原理

评论有两个来源：用户在正文上划词，或者后端/AI 返回一句违规原文。AI 给不出坐标，只给得出句子；所以两种来源都只存**句子本身**，每次打开 PDF 时再去找这句话在哪。

找位置和画高亮被拆成三件互不依赖的事：

```
定位   原句 → 全文里的字符区间 [start, end)      只依赖全文索引，不碰 DOM
几何   字符区间 → 某一页上的矩形               只在这一页的文字层画出来以后才做
绘制   矩形 → SVG                              缩放时什么都不用重算
```

全文索引来自 PDF.js 的 `page.getTextContent()`，打开文档时就能建好，不需要把页面渲染出来。所以「第 80 页有 3 处匹配」在第 80 页画出来之前就已经知道，右侧面板能立刻显示页码和处数。

页面是虚拟化渲染的：只有视口附近的页才真的画 canvas 和透明文字层。某一页的文字层画好后，才用浏览器的 `Range.getClientRects()` 量出这一页上每处匹配的矩形，换成与缩放无关的「页面单位」缓存起来。之后缩放、滚走再滚回来，都直接复用。

每一页仍是三层：

```
看见的字     canvas          最下面
高亮         svg             中间，不接收鼠标
能划选的字   透明 textLayer   最上面
```

## 关键点

1. **评论只存文字和位置提示，不存坐标。** `target = { exact, prefix, suffix, start, end, page }`。`exact` 是定位依据，其余都是「多处匹配时挑哪处」的提示。AI 导入只有 `exact`。
2. **索引和文字层共用同一份 `textContent`。** 索引里「第 i 个文字项的第 k 个字」能直接对应到 `textLayer.textDivs[i]` 文本节点的第 k 个字符，不用在 DOM 里反推文字。
3. **匹配在规范化后的字符串上做，结果映射回原始位置。** 规范化会去掉空白（strict），或再去掉标点、转小写（loose）。每个规范化字符都记着它来自原始文本的哪一段。
4. **三级匹配，逐级放宽。** 精确（只忽略空白）→ 忽略标点 → 近似（允许约 25% 的字不同）。结果带 `confidence`，界面会提示后两种。
5. **页眉页脚在匹配时跳过。** 每页上下边缘都重复出现的文字（含页码）被识别出来，跨页的句子不会被「第 3 页」打断。
6. **矩形用页面单位存。** 页面单位等于缩放为 1 时的 viewport 坐标（PDF 点，原点左上，y 向下）。SVG 的 `viewBox` 用同一套单位，缩放只改 CSS 尺寸。
7. **几何按页懒计算并缓存。** 键是 `页码:start:end`。页面被释放后缓存仍然有效。
8. **只渲染视口附近的页。** `IntersectionObserver` 上下各留一屏余量，进入范围才画，离开就释放 canvas 和文字层。
9. **状态集中在一个 store。** 评论、解析结果、当前看第几处、滚动指令都在 `src/core/store.js`，组件通过 `provide/inject` 拿到同一个实例。
10. **评论按 PDF 指纹存。** 键是 `comment-pdf:v3:<fingerprint>`。同一份文件改名、换地址，评论还在；旧版本的数据第一次打开时自动迁移。

下面按这 10 点展开。

## 细分

### 1. 模块和依赖方向

```
App.vue ──provide──> store
  ├─ PdfViewer.vue ── documentModel ── textIndex
  │     │           ── resolver ────── textIndex
  │     │           ── geometry ────── rects, textIndex
  │     └─ PdfPage.vue（每页一个）
  └─ CommentPanel.vue ──inject──> store
store ── persistence
```

| 文件 | 做什么 | 碰 DOM |
| --- | --- | --- |
| `src/core/textIndex.js` | 建全文字符表、识别页眉页脚、生成 strict/loose 两个规范化视图 | 否 |
| `src/core/resolver.js` | 三级匹配、给多处匹配打分、从选区生成 `target` | 否 |
| `src/core/rects.js` | 矩形去重、同行合并、点是否落在矩形里 | 否 |
| `src/core/persistence.js` | 读写 `localStorage`、清洗字段、迁移旧版本 | 否 |
| `src/core/store.js` | 唯一的状态源和所有修改动作 | 否 |
| `src/core/documentModel.js` | 取每页尺寸和 `textContent`，建索引，粗估未渲染页里的位置 | 否 |
| `src/core/geometry.js` | 字符区间 → 页面单位矩形；浏览器选区 → 字符区间 | 是 |
| `src/components/PdfPage.vue` | 单页的 canvas、SVG、文字层；按需渲染和释放 | 是 |
| `src/components/PdfViewer.vue` | 打开文档、虚拟化、调度解析和几何、划词、点击、缩放、滚动 | 是 |
| `src/components/CommentPanel.vue` | 右侧列表、批量导入、`‹ k / N ›` 切换 | 是 |

依赖只从上往下走。`src/core/` 里除 `geometry.js` 外都是纯函数或纯状态，可以在 Node 里直接测试（`tests/core.test.js`），将来也可以整体搬进 Web Worker。

### 2. 评论的数据结构和存储

一条评论：

```js
{
  id: 'a1b2…',                 // crypto.randomUUID()
  body: '违规原因或批注',
  createdAt: '2026-10-20T08:10:31.000Z',
  target: {
    exact: '供应链管理和消费场景',   // 必有
    prefix: '…支持商贸企业对店面、运营、',   // 划词才有，最多 32 字
    suffix: '等实施 数字化升级。支持商贸…',  // 划词才有，最多 32 字
    start: 1392, end: 1402,     // 划词才有：当时在全文索引里的字符区间
    page: 3,                    // 划词才有：起点所在页
  },
}
```

存储格式：

```js
localStorage['comment-pdf:v3:10c4abf52874ea41ab3cde9219d91981'] = {
  version: 3,
  docKey: '10c4abf52874ea41ab3cde9219d91981',
  annotations: [ /* 上面的评论 */ ],
}
```

`docKey` 是 `pdf.fingerprints[0]`，由 PDF 文件本身决定。读不到指纹时（极少见）退回旧 id。

读写都经过 `cleanAnnotation` / `cleanTarget`：只保留上面列出的字段；`start/end` 必须同时是整数才保留；`prefix`、`suffix`、`page` 为空时不写。

**迁移规则**（`loadAnnotations`）：

1. 先读 `comment-pdf:v3:<docKey>`。版本、`docKey` 对得上且 `annotations` 是数组，就用它，**哪怕是空数组**。用户删光了评论，不能让旧数据又冒出来。
2. 没有 v3 记录时，依次尝试 `legacyIds` 对应的旧键 `comment-pdf:<legacyId>`。旧数据要求 `version` 是 1 或 2、`docId` 等于 `legacyId`、`comments` 是数组。
3. 旧记录 `{ quote, prefix, suffix }` 被转成 `target: { exact: quote, prefix, suffix }`（没有 `start/end`），写入 v3 键。旧键保留不删。

`legacyId` 由 `App.vue` 给出：默认文件是它的地址（含 `BASE_URL`），上传的文件是 `file:文件名:字节数:lastModified`，和旧版本的规则一致。

### 3. 打开一份文档的完整流程

`PdfViewer.loadDocument()`，状态栏文字依次变化：

| 步骤 | 状态栏 | 做了什么 |
| --- | --- | --- |
| 1 | 正在打开 PDF | `resetDocument()` 清空上一份文档的一切；`openPdf(src)` |
| 2 | — | 发出 `document-ready({ fingerprint })`；`App` 调 `store.openDocument(指纹, [legacyId])` 读出评论 |
| 3 | — | `loadPages`：逐页 `getPage` + `getViewport({ scale: 1 })`，得到每页尺寸 |
| 4 | — | 排出所有占位页，按适应宽度算缩放，开始观察哪些页在视口附近 |
| 5 | 正在建立文字索引 n/N | `loadTextIndex`：逐页 `getTextContent`，最后 `buildTextIndex` |
| 6 | （清空） | `textReady = true`，文字层开始生成；`resolveAll()` 解析所有评论 |

第 4 步之后视口附近的页已经开始画 canvas，用户能先看到页面；文字层要等第 6 步才有，因为它要复用第 5 步取到的 `textContent`。

每次打开都带一个递增的 `loadToken`。每个 `await` 之后检查 `isStale()`，新文档开始后，旧文档的异步结果直接丢弃。`PdfPage` 的 `key` 带上 `docGeneration`，换文档时所有页组件都会重建，不会把上一份文档的页对象留给新文档。

`getTextContent` 的参数固定为 `{ includeMarkedContent: false, disableNormalization: true }`：前者避免同一段字在父子 `span` 里出现两次，后者让索引里的字和文字层、用户看到的字完全一致。

### 4. 全文索引

`buildTextIndex(pages)` 的输入是每页的文字项，顺序必须和 `TextLayer` 生成 `textDivs` 的顺序一致：

```js
[{ number: 1, view: [0, 0, 595, 842], items: [{ str, hasEOL, y }, …] }, …]
```

输出字段：

| 字段 | 长度 | 含义 |
| --- | --- | --- |
| `text` | — | 所有文字项原样拼起来的全文 |
| `pageOf[i]` | `text.length` | 第 i 个字符所在页码 |
| `itemOf[i]` | 同上 | 所在文字项下标；虚拟换行是 `-1`（`NO_ITEM`） |
| `offsetOf[i]` | 同上 | 在文字项字符串里的偏移 |
| `furniture[i]` | 同上 | 1 表示属于页眉页脚 |
| `pageRanges` | 每页一项 | `页码 → { start, end }`，这一页在 `text` 里的区间 |
| `itemStarts` | 每页一项 | `页码 → Int32Array`，每个文字项在 `text` 里的起点 |
| `strict` / `loose` | — | 两个规范化视图：`{ text, from, to }` |

**虚拟换行**：文字项带 `hasEOL` 时，后面插一个 `'\n'`；页与页之间也插一个（记在前一页上）。它们让 `text` 读起来像正常段落，前后文更自然；`itemOf = -1` 表示它们在 DOM 里没有对应节点，画矩形时会跳过。

例子。第 1 页两个文字项 `"乙方不得"`（行尾）、`"转 包"`，第 2 页一个 `"第三方。"`：

```
下标    0 1 2 3  4   5 6 7  8   9 10 11 12
text    乙方不得 \n  转 ␣ 包 \n  第 三 方 。
pageOf  1 1 1 1  1   1 1 1  1   2 2  2  2
itemOf  0 0 0 0 -1   1 1 1 -1   0 0  0  0
```

- `rawPosition(index, 2, 0, 1)` = 第 2 页第 0 项起点 9 + 偏移 1 = 10，即「三」。划词时就用它把 DOM 位置换成全文下标。
- `pagesInSpan(index, 2, 12)` = `[1, 2]`：跳过 `itemOf = -1` 的虚拟字符，按出现顺序列出页码。

### 5. 规范化视图

两个视图都逐个码点处理原始文本，跳过页眉页脚字符：

| 视图 | 规则 | 上例得到 |
| --- | --- | --- |
| `strict` | NFKC，去掉所有空白 | `乙方不得转包第三方。` |
| `loose` | strict 之后再转小写，去掉标点和符号（Unicode `P`、`S` 类） | `乙方不得转包第三方` |

NFKC 会把全角字母数字转半角（`ＡＢ１` → `AB1`），把兼容字符拆开（`㎏` → `kg`）。一个原始字符可能变成 0 个、1 个或多个规范化字符。

每个规范化码元记两个数：`from` 是它来自的原始字符下标，`to` 是那个原始字符之后的下标。上例 strict 的 `from` 是 `[0,1,2,3,5,7,9,10,11,12]`。

在视图里第 `a` 到 `b` 个字符匹配上了，原始区间就是 `[from[a], to[b])`。所以无论中间隔了多少空白、换行、页眉页脚，结果都是从第一个字到最后一个字的一整段原文。

查找时，原句用同一个 `normalizeText(text, loose)` 规范化，保证两边规则一致。

### 6. 页眉页脚识别

`detectFurniture(pages)`：

1. 只看落在页面底部或顶部 8%（`band`）窄带里的非空文字项。位置用文字项基线 `transform[5]` 相对 `page.view` 的比例算，PDF 坐标 y 轴朝上。
2. 把内容规范成键：NFKC、去空白、**每串数字换成 `#`**，前面加 `top:` 或 `bottom:`。「第 1 页」「第 2 页」都是 `bottom:第#页`。
3. 统计每个键出现在几页上。达到 `max(3, ceil(总页数 × 0.6))` 页的，这些文字项都算页眉页脚。少于 3 页的文档不做识别。

| 总页数 | 至少出现在 |
| --- | --- |
| 3 | 3 页 |
| 4 | 3 页 |
| 10 | 6 页 |
| 100 | 60 页 |

被识别的字符：

- 不进入 strict / loose 视图，所以匹配会直接跨过它们。
- 仍留在 `text` 里，前后文、划词引用照常包含它们。
- 画矩形时从每页那一段的首尾裁掉（见第 9 节），不会给页码画下划线。

会误判的情况：奇偶页页眉不同（每种只占约 50%）、页眉离边缘超过 8%、同一页眉在不同页被切成不同的文字项、正文里每页底部都重复的表头或声明、页面旋转 90°。规整的合同和公文一般没问题；奇偶页不同时可以把 `minRatio` 调到 0.4 左右。

### 7. 匹配

`resolveTarget(index, target)` 返回：

```js
{
  matches: [{ start, end, pages: [3], confidence: 'exact' }, …],
  preferredIndex: 0,   // 默认停在第几处
}
```

**三级查找**，前一级找到任何结果就不再往下：

| 级别 | 在哪找 | 方法 | `confidence` | 面板提示 | 下划线 |
| --- | --- | --- | --- | --- | --- |
| 1 | `strict` | `indexOf` 循环，收集所有不重叠的出现处 | `exact` | 无 | 实线 |
| 2 | `loose` | 同上 | `loose` | 忽略标点 | 实线 |
| 3 | `loose` | 近似匹配，只取最好的一处 | `fuzzy` | 近似匹配 | 虚线 |

**近似匹配**（`approximateSearch`）用 Sellers 算法：在全文任意位置找一段与原句编辑距离最小的子串（编辑距离 = 增、删、改多少个字才能一致），同时记下这段的起点。

- 只在原句规范化后有 4–400 个字时启用。太短容易乱配，太长计算量大（复杂度是全文长度 × 原句长度）。
- 允许的编辑距离是 `max(1, floor(长度 × 0.25))`。16 个字的句子最多差 4 个字。
- 例：原句「收到通知后**7**日内完成整改」，正文「收到通知后**七**日内完成整改」，差 1 个字，能找到。

**多处匹配时挑默认那处**，每处按下表加分，取分数最高的；同分取靠前的：

| 条件 | 加分 |
| --- | --- |
| 这处前面 96 个原始字符（规范化后）以 `prefix` 结尾 | +2 |
| 否则只要包含 `prefix` 的最后 8 个字 | +1 |
| 这处后面 96 个原始字符以 `suffix` 开头 | +2 |
| 否则只要包含 `suffix` 的前 8 个字 | +1 |
| `start/end` 和 `target` 里记的完全一样 | +10 |
| 这处的页码包含 `target.page` | +0.5 |

划词的评论在 PDF 没变时总能拿到 +10，直接停在当时划的那处；PDF 改过、位置对不上时，靠前后文挑。AI 导入没有任何提示，停在第 1 处。

### 8. 解析的调度和缓存

`PdfViewer.resolveAll()` 在两种时候运行：

- 全文索引刚建好；
- `store.state.annotations` 被替换（新增、批量导入、删除、换文档）。

结果按 `targetKey(target)`（`exact`、`prefix`、`suffix`、`start`、`end` 拼起来）缓存在 `resolveCache` 里。新增一条评论时，旧评论全部命中缓存，只解析新的这一条；不再使用的键会被清掉。换文档时整个缓存清空。

解析完调用 `store.setResolved(map)`，再调用 `computeGeometry()` 为已就绪的页补算矩形。

### 9. 页面单位和几何

**页面单位**：缩放为 1 时 `page.getViewport({ scale: 1 })` 的坐标，单位是 PDF 点（1/72 英寸），原点在页面左上角，y 向下，已经包含页面自身的旋转。一张 A4 竖版是 595 × 842。

屏幕像素和页面单位的换算只用这一页 DOM 盒子的实际尺寸，不用 `viewport.scale`，避免 CSS 取整带来的误差：

```
页面 x = (屏幕 x − 页盒子.left) × 页宽 / 页盒子.width
页面 y = (屏幕 y − 页盒子.top)  × 页高 / 页盒子.height
```

例：页宽 595，页盒子宽 610 px，点在页盒子左边 120 px 处，页面 x = 120 × 595 / 610 ≈ 117。

**`rectsForSpan(index, pageText, start, end)`**，把一处匹配在某一页上的部分换成矩形：

1. 把 `[start, end)` 裁到这一页的 `pageRanges` 范围里。
2. 从两头往里缩，跳过虚拟换行、页眉页脚、空白字符，找到这一页上第一个和最后一个「能画的字」。
3. 用 `itemOf` / `offsetOf` 找到这两个字在 `textDivs` 里的文本节点和偏移，造一个 DOM `Range`。
4. `range.getClientRects()` 拿到每一行的屏幕矩形，丢掉：宽或高小于 1 px 的碎框；宽和高都超过页盒子 85% 的整页误框；中心不在页盒子里的框。
5. 换成页面单位。
6. **去重**：一个矩形和已保留的某个矩形重叠面积超过它自己面积的 60%，丢掉它（先出现的留下）。
7. **同行合并**：两个矩形 y 方向重叠超过较矮者高度的一半，算同一行；同一行统一成相同的上边和高度；从左到右，间隙不超过 `max(1.5, 行高 × 0.6)` 点就并成一条。

例：`{ x: 10, y: 100, w: 40, h: 12 }` 和 `{ x: 52, y: 101, w: 30, h: 11 }` 在同一行，间隙 2 点，小于阈值 7.2，合并成 `{ x: 10, y: 100, w: 72, h: 12 }`。

结果以 `页码:start:end` 为键存在 `geometry` 里。跨页的匹配在每页各有一条缓存。

**`computeGeometry(页码列表)`** 在以下时候运行：某页文字层就绪（只算这一页）、解析结果更新（算所有已就绪页）、生成划词草稿（算草稿涉及的页）。只为还没有缓存的区间计算；有新结果时 `geometryVersion` 加 1，触发高亮重绘。

几何缓存在整个文档打开期间都不清：页面单位与缩放无关，页面被虚拟化释放后再出现，矩形照旧可用。

### 10. 渲染和虚拟化

**哪些页是 active**：`IntersectionObserver` 以滚动容器为根、`rootMargin: '100% 0px'`，即视口上下各多算一屏。进入这个范围的页 active，离开就不是。

**页盒子尺寸**：每个 `PdfPage` 挂载时用 `setLayerDimensions(根元素, 缩放为 1 的 viewport, true, false)` 设一次尺寸。PDF.js 写进去的是 `round(down, var(--total-scale-factor) × 原始宽度 px, …)` 这类 CSS 表达式，所以之后改 `.pages` 上的 `--scale-factor`，所有页盒子会自动变大变小，不用逐页改尺寸。占位页（还没 active 的）也一样有正确尺寸，滚动条长度从一开始就是对的。

**`PdfPage` 的生命周期**（监听 `active`、`scale`、`textReady` 三个属性）：

| 情况 | 做什么 |
| --- | --- |
| 变成 active | 新建 canvas 画这一页；`textReady` 时用缓存的 `textContent` 建 `TextLayer`，完成后在末尾加 `.endOfContent`，发出 `text-ready` |
| active 时缩放变了 | 画一张新 canvas，**画好后才替换旧的**，避免闪白；文字层调用 `TextLayer.update({ viewport })` 原地重排，不重建 |
| 变成非 active | 取消正在进行的渲染，移除 canvas，取消并清空文字层，发出 `text-released` |
| 卸载 | 同上 |

canvas 位图尺寸是 viewport 尺寸 × `min(devicePixelRatio, 2)`，CSS 上铺满页盒子。

文字层正在生成时缩放又变了：生成完成后会发现比例对不上，立即再 `update` 一次，然后照常发出 `text-ready`。

`PdfViewer` 收到 `text-ready` 后，把 `{ 页码, 页元素, textDivs, 页宽, 页高 }` 存进 `pageTexts`；收到 `text-released` 就删掉。几何、划词只认 `pageTexts` 里的页。

**缩放**：

- 工具栏百分比是 `userScale × 100`，范围 50%–300%。真正传给 PDF.js 的是 `userScale × 96/72`（PDF 点换 CSS 像素）。
- 适应宽度（打开文档时的默认模式）：滚动容器可用宽度（至少按 240 px 算）除以第一页在 100% 时的宽度。窗口尺寸变化后停 150 ms 再重算。
- 放大、缩小每次乘或除 1.1，并切到自定义模式，之后窗口变化不再自动改比例。
- 缩放前如果已经滚动过，会记住视口中心在全文的相对位置，缩放后滚回去；还在顶部就留在顶部。
- 缩放会关掉未发送的草稿，因为评论框是按屏幕坐标摆放的。

### 11. 画高亮

`highlightsByPage` 是一个 `computed`，返回 `Map<页码, 高亮项[]>`。它依赖：评论列表、解析结果、`activeId`、`matchIndex`、草稿、`geometryVersion`。在评论框里打字不会触发它。

绘制顺序（后画的盖住先画的）：

1. 所有评论的所有匹配处，按评论在列表里的顺序；
2. 当前选中评论的当前那一处（从第 1 步里挪到这里）；
3. 未发送的草稿。

每个高亮项是一行矩形：

```html
<g class="comment active approximate" data-comment="评论 id" data-comment-match="评论 id:第几处">
  <rect />   <!-- 选中时铺底色 -->
  <line />   <!-- 矩形底边，即下划线 -->
</g>
```

SVG 设了 `viewBox="0 0 页宽 页高"`（页面单位）和 `preserveAspectRatio="none"`，铺满页盒子；线条用 `vector-effect: non-scaling-stroke`，任何缩放下都是 2 px 粗。

| 状态 | 样子 |
| --- | --- |
| 普通 | 金色下划线 `#e6a100`，无底色 |
| 当前选中的那一处、草稿 | 黄色半透明底 `rgb(255 214 0 / 45%)`，下划线 `#d86b00` |
| 近似匹配（`fuzzy`） | 下划线改成虚线 `4 3` |

还没算出矩形的匹配（所在页没渲染）不画；页面一就绪就补上。

### 12. 划词

监听在滚动容器上。按下时给所在文字层加 `selecting`，让 `.endOfContent` 盖住整页，选区才能拖过行尾。松手时去掉，并按下表分支（在下一帧执行，等浏览器把选区稳定下来）：

| 顺序 | 条件 | 结果 |
| --- | --- | --- |
| 1 | 松手落在评论框 `.composer` 上 | 什么都不做 |
| 2 | 读到有效选区 | 生成草稿，清掉浏览器选区，打开评论框 |
| 3 | 没有选区，但焦点在评论框里 | 不动正在写的草稿 |
| 4 | 没有选区，点中了某个高亮 | 关掉草稿，选中那条评论的那一处 |
| 5 | 都不是 | 只关掉草稿 |

**选区换成字符区间**（`spanFromRange`）：按页码顺序遍历 `pageTexts` 里每页的 `textDivs`，对每个文本节点问 `range.intersectsNode()`。第一个相交的节点给出起点（是 `startContainer` 就用 `startOffset`，否则从 0 开始），最后一个相交的节点给出终点，再用 `rawPosition` 换成全文下标。这样无论选区端点落在文本节点、`span` 还是 `.endOfContent` 上都能处理。

**生成 target**（`targetFromSpan`）：

1. 从两头裁掉空白，裁完为空就不算有效选区。
2. `exact` = 这段原文，连续空白（包括虚拟换行）压成一个空格。
3. `prefix` = 前面 64 个原始字符压缩空白后的最后 32 个字；`suffix` 同理取后面的前 32 个字。
4. 记下 `start`、`end` 和起点页码。

草稿自带一处「匹配」（就是它自己的区间），立即按第 9 节算矩形并画出来，不用等解析。点「发送」调用 `store.add(target, body)`；解析时这一处会拿到 +10 分，矩形直接命中几何缓存。

评论框 `position: fixed`，宽 280 px，默认放在选区最后一行下方 8 px，靠边时翻到视口内。滚动（且焦点不在输入框）、缩放、按 Escape 都会关掉草稿。

### 13. 点击命中

SVG 不接收鼠标，点击实际落在文字层上。`hitTest`：

1. 从事件目标往上找 `[data-page]`，得到页码和页元素。
2. 把点击位置换成页面单位。
3. 从这一页高亮列表的**末尾往前**找第一个包含该点的矩形（含边界），跳过草稿。

因为列表顺序就是绘制顺序，结果和眼睛看到的一致：当前选中的那一处优先，其次是列表里靠后的评论。命中后 `store.select(id, matchIndex)`，右侧卡片会跳到 `k / N`。

### 14. 选中、切换和滚动

| store 动作 | 谁调用 | 效果 |
| --- | --- | --- |
| `select(id, matchIndex?)` | 点卡片、点高亮、新增评论 | 设 `activeId`；给了 `matchIndex` 就记下；发出滚动指令 |
| `step(id, ±1)` | `‹` `›` | 在所有匹配处之间循环，再 `select` |
| `currentMatchIndex(id)` | 面板、高亮 | 记过的序号，否则 `preferredIndex`；越界时取模 |
| `setResolved(map)` | 解析完成 | 更新结果；记过的序号仍在范围内就保留，否则改成 `preferredIndex`；没有匹配的评论删掉序号 |

**滚动指令**：store 不知道页面长什么样，只通知订阅者 `{ id, matchIndex, match }`，`PdfViewer` 通过 `store.onScroll` 订阅。

- 评论还没有匹配结果（比如刚批量导入、索引还没建好）：指令挂起（`pendingScroll`），`setResolved` 之后补发。
- 目标页的矩形已经算好：平滑滚动，让第一行矩形落在视口竖直中间。
- 目标页还没渲染：先用 `estimateSpanTop` 粗估。它取这处第一个字所在文字项的基线，用缩放为 1 的 viewport 换成页面 y，再减去字号。先滚过去，记下 `pendingPrecise`；这一页 `text-ready`、矩形算好后再精确对齐一次。

### 15. 右侧面板

面板直接读 store：

| 显示 | 条件 |
| --- | --- |
| 未匹配到正文（红） | 没有任何匹配 |
| 第 P 页 / 第 a–b 页 | 当前那一处所在页；跨页时显示首尾页 |
| 忽略标点 / 近似匹配（橙） | 当前那一处的 `confidence` 是 `loose` / `fuzzy` |
| `‹ k / N ›` | 匹配超过 1 处 |

**批量导入**：按行拆分，一行一条。可以写成 `原文 | 原因`（半角 `|` 或全角 `｜`），没写原因时用「默认批注」，再没有就是「AI 检出违规语句」。导入后选中第一条。

### 16. 测试

`npm test` 运行 `node --test tests/`，不需要额外依赖。覆盖：规范化规则、原始位置映射、跨行精确匹配、页眉页脚识别与跨页匹配、忽略标点、近似匹配、前后文和位置挑选、`targetFromSpan` 裁空白、矩形合并、旧数据迁移、store 的序号与滚动挂起。

DOM 相关部分（`geometry.js`、两个页面组件）没有单元测试，改动后需要在浏览器里验证：跨页高亮、缩放后对齐、`‹ ›` 滚动、划词、点击、刷新后恢复。

## 局限

- **近似匹配可能落错位置**，所以单独标出来；目前不能手动把评论改绑到别处。近似匹配只取最好的一处。
- **索引和近似匹配在主线程跑**。几百页、每条都要走近似匹配时会卡顿；纯模块已经和 DOM 分开，可以搬进 Web Worker。
- **扫描件没有文字层**，所有评论都是「未匹配到正文」。没有 OCR。
- **页眉页脚识别是启发式的**，见第 6 节。
- **评论只存在这台浏览器的 `localStorage` 里**，没有后端，也不写进 PDF 文件。
- **旋转的文字**按外接矩形铺色，下划线沿矩形底边，不沿文字方向。
- **评论框不跟着页面滚动**，一滚动就关掉未发送的草稿。
- **适应宽度只看第一页**，更宽的页会出现横向滚动条。

## 改某块行为时看哪里

| 想改的 | 位置 |
| --- | --- |
| 什么算空白、标点，全角半角怎么处理 | `textIndex.js` 的 `foldChar`、`normalizeText` |
| 页眉页脚的窄带宽度、重复比例 | `textIndex.js` 的 `detectFurniture` 参数 `band`、`minRatio`、`minPages` |
| 近似匹配的长度范围、容错比例 | `resolver.js` 顶部的 `FUZZY_*` 常量 |
| 多处匹配时默认停在哪 | `resolver.js` 的 `contextScore`、`positionScore` |
| 前后文取多少字 | `resolver.js` 的 `CONTEXT_CHARS` 和 `targetFromSpan` |
| 碎框过滤、去重、同行合并的阈值 | `geometry.js` 的 `clientRectsToPage`，`rects.js` |
| 预渲染多远、何时释放 | `PdfViewer.vue` 的 `observePages`（`rootMargin`） |
| 缩放范围、步长、适应宽度 | `PdfViewer.vue` 的 `MIN_SCALE`、`MAX_SCALE`、`zoomBy`、`applyFitScale` |
| 高亮颜色、虚线、底色 | `src/style.css` 的 `.highlights` |
| 松手后的分支、评论框位置 | `PdfViewer.vue` 的 `onPointerUp`、`composerStyle` |
| 存哪些字段、存储键、迁移 | `persistence.js`，以及 `App.vue` 里的 `legacyId` |
| 选中、切换、滚动的规则 | `store.js` |
| 高亮和文字错位 | 先确认索引和 `TextLayer` 用的是同一份 `textContent`，再检查 `rectsForSpan` 用的页盒子尺寸 |
