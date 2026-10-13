# PDF 划词评论与高亮

这份文档按当前代码说明整条链路：PDF 如何画出来、划词如何变成可保存的坐标、高亮如何在缩放和刷新之后画回原处、查找和点击如何复用同一套矩形。读者不需要先读过 PDF.js 查看器。需要的前置知识只有：浏览器的 `Selection` / `Range`、CSS 绝对定位，以及 PDF 页面坐标的原点在左下角、y 轴向上。

文中的文件名、函数名、字段名都和仓库里的实现一致。改行为时，可以直接按最后一节的索引找到函数。

## 1. 这个页面解决什么问题

用户打开一份 PDF，在正文上拖出一段文字，松手后在选区旁边写评论。评论和这段文字的位置一起留在这台浏览器里。刷新、放大、缩小、适应宽度之后，高亮仍然盖在同一段字上。右侧列表可以点回这段高亮。右侧还可以按正文查找，匹配到的字另画一套高亮。

页面不使用 PDF.js 自带的查看器工具栏，也不把查看器放进 iframe。PDF.js 只做两件事：

- 把每一页的画面画进 `canvas`
- 生成一层透明文字，让浏览器能够划选

选区、评论框、高亮、查找、上传文件和右侧列表都是本仓库自己的代码。

高亮不跟着浏览器选区走。松手的那一刻，选区被换成 PDF 页面坐标存下来，浏览器自己的蓝色选区马上清掉。此后屏幕上的下划线都是用这些坐标现算的。缩放和刷新走同一条路，不另写一套“记住屏幕位置”的逻辑。

## 2. 代码怎么分工

| 文件 | 负责的事 |
| --- | --- |
| `src/main.js` | 把 `App.vue` 挂到 `#app` |
| `src/App.vue` | 当前打开哪一份 PDF、评论数组、当前选中的评论、查找关键字和匹配项 |
| `src/components/PdfView.vue` | 渲染页面、缩放、划词、评论框、把矩形画成 SVG |
| `src/components/CommentPanel.vue` | 右侧评论列表、查找框、上一项 / 下一项 |
| `src/lib/pdf.js` | 调用 `getDocument`，指定 worker、cmap、标准字体、wasm、icc |
| `src/lib/selection.js` | 窗口矩形换成 PDF 矩形、去重、按行对齐、从点击点找评论 |
| `src/lib/search.js` | 在文字层里做字符串查找，几何部分交给 `anchorsFromRange` |
| `src/lib/comments.js` | 按文档把评论写入 `localStorage` |
| `src/style.css` | 三层叠放、文字层能否被选中、下划线颜色 |
| `vite.config.js` | 开发服务器和打包时提供 `pdfjs/` 下的静态资源 |

左右两栏不互相调用。状态放在 `App.vue`，用 props 传下去，用事件传上来。

```
App.vue
  ├─ PdfView          画 PDF、产生草稿、报告查找结果、报告点中了哪条评论
  └─ CommentPanel     展示评论和查找结果，发出选中、删除、搜索、上一项、下一项
```

`PdfView` 发出的事件：

| 事件 | 何时 | 载荷 |
| --- | --- | --- |
| `create` | 评论框点发送 | `{ quote, prefix, suffix, anchors, body }` |
| `select` | 点中一段已有高亮 | 评论 `id` |
| `open-file` | 选择了本地文件 | 浏览器的 `File` |
| `restore` | 点“恢复默认” | 无 |
| `matches` | 关键字或页面渲染变化后重算完查找 | 匹配数组，没有匹配时是 `[]` |

`CommentPanel` 发出的事件：`select(id)`、`remove(id)`、`search(字符串)`、`step(1 或 -1)`、`choose(结果下标)`。

## 3. 运行时的数据各自活在哪

理解后面的流程前，先分清六份数据。它们的寿命不同，不能混着存。

| 数据 | 放在哪 | 什么时候写 | 什么时候没了 |
| --- | --- | --- | --- |
| 评论数组 | `App.vue` 的 `comments`，并镜像到 `localStorage` | 发送、删除 | 换 `docId` 时换成那一份文档自己的评论；清站点数据后消失 |
| 未发送的草稿 `draft` | `PdfView` 内部 | 松手且划到了字 | 发送、取消、Escape、滚动（焦点不在输入框时）、换文档、点了空白处 |
| 每一页的 `PageViewport` | 普通 `Map`，变量名 `viewportMap` | 每一页渲染时 | 换文档时 `clear()`。缩放时被新的 viewport 覆盖 |
| 每一页的 CSS 宽高 | `pageMetrics`，形状是 `{ [页码]: { width, height } }` | 一整轮渲染全部成功之后一次性替换 | 换文档时先变成 `{}` |
| 浏览器选区 | `window.getSelection()` | 用户在文字层里拖动时由浏览器维护 | 划词成功、发送、取消、换文档时主动 `removeAllRanges()` |
| 查找结果 | `App.vue` 的 `matches` | `PdfView` 算完后通过 `matches` 事件交上来 | 关键字清空、换文档。不写入 `localStorage` |

`pageMetrics` 是 Vue 的 `ref`。高亮函数读它，所以渲染结束时替换这个对象，下划线会重算。`viewportMap` 故意不是响应式的，原因见第 5 节。高亮函数真正换算坐标时，按页码从这个 `Map` 里取 viewport。

工具栏上的百分比来自 `userScale`，不是 viewport 自带的 `scale`。`scaleMode` 只有两个值：`fit`（适应宽度）和 `custom`（用户点过放大或缩小）。

## 4. 一条评论里有什么

`App.vue` 的 `addComment` 在草稿之外补上 `id` 和 `createdAt`：

```js
{
  id: "由 crypto.randomUUID() 生成",
  quote: "选中的文字",
  prefix: "选区前面最多 20 个字",
  suffix: "选区后面最多 20 个字",
  body: "用户写下的评论",
  createdAt: "2026-01-01T00:00:00.000Z",
  anchors: [
    {
      page: 1,
      rects: [
        { x: 120, y: 96, width: 160, height: 24 }
      ]
    }
  ]
}
```

| 字段 | 含义 |
| --- | --- |
| `id` | 列表的 key、SVG 上的 `data-comment`、滚动定位都用它 |
| `quote` | 选区文字。连续空白（空格、换行、制表符）先压成一个空格，再去掉首尾空白。空字符串不会形成草稿 |
| `prefix` / `suffix` | 选区前后的上下文。只保存，不参与定位，界面也不显示 |
| `body` | 评论正文。输入框 `maxlength` 是 2000，发送前 `trim`，空白不能发送 |
| `createdAt` | 发送瞬间的 ISO 时间。界面上还没有用到 |
| `anchors` | 这段字落在哪些页，以及每一页上的矩形。定位只靠它 |

`anchors` 按页分组，页码从小到大。同一页的多行放在该页的 `rects` 里，不是多个 SVG，也不是一个包住整段的大矩形。跨页选区才有多项：

```js
anchors: [
  { page: 1, rects: [ /* 第 1 页上对齐后的每一行 */ ] },
  { page: 2, rects: [ /* 选区继续到第 2 页时 */ ] }
]
```

每个矩形是 PDF 用户空间里的轴对齐盒子：

- 原点在该页左下角
- x 向右，y 向上
- 单位是点（point）。1 点 = 1/72 英寸
- `x`、`y` 是左下角，`width` 和 `height` 为正

查找结果不是评论。它不进 `localStorage`，形状是：

```js
{
  id: "0",          // 当前结果列表中的下标，字符串
  page: 3,          // 这一处匹配所在的页
  quote: "关键字",   // 就是用户输入的查找词，不是匹配处周围的句子
  anchors: [ /* 与评论相同的形状 */ ]
}
```

`id` 在每次重算时按 0、1、2… 重新编号。它不是稳定主键。

## 5. 为什么存 PDF 坐标，以及怎么换算

### 5.1 两套坐标不能混用

浏览器给的是窗口坐标：

- 原点在浏览器视口左上角
- y 向下
- 单位是 CSS 像素
- 来源是 `getClientRects()` 和 `clientX` / `clientY`

这组数字描述的是“此刻这段字在窗口里的哪一块”。滚动、缩放、改窗口宽度、换一台显示器，数字都会变。把它们写进 `localStorage`，刷新后对不上字。

PDF 页面坐标描述的是“这段字在这一页版心上的哪一块”。同一份 PDF 再次打开，只要页面内容没有移动，矩形仍指向同一段字。画回屏幕时，再用当时的缩放把 PDF 坐标变成像素。

因此存储里只有 PDF 矩形。SVG 上的 `<rect>` 和 `<line>` 每次现算，不进 `localStorage`。

### 5.2 换算交给 viewport，不自己乘比例

每一页渲染时，`page.getViewport({ scale })` 返回一个 `PageViewport`。正向是 `convertToViewportPoint(pdfX, pdfY)`，反向是 `convertToPdfPoint(cssX, cssY)`。

这两个方法使用 viewport 的变换矩阵和它的逆矩阵。矩阵里已经包含：

- 调用 `getViewport` 时传入的缩放
- 该页在 PDF 里声明的旋转（0°、90°、180°、270°）
- 从“左下角、y 向上”翻到“左上角、y 向下”

因为 y 轴会翻转，两个角转换之后谁的 y 更大不能事先假定。代码一律取较小的 x、较小的 y，宽高取绝对值。这样矩形和两个角的书写顺序无关，并且始终轴对齐。旋转过的文字不会得到一条斜的平行四边形，只会得到包住它的横平竖直外接矩形。

从窗口矩形到 PDF 矩形是 `clientRectToPdf`：

1. `pageEl.getBoundingClientRect()` 得到这一页 DOM 在窗口里的左上角。
2. 选区矩形的 `left/top/right/bottom` 减去这个左上角，得到相对该页左上角的像素。滚动已经含在 `getBoundingClientRect()` 里，所以不需要再加 `scrollTop`。
3. 左上角和右下角分别调用 `convertToPdfPoint`。
4. `x = min(x1, x2)`，`y = min(y1, y2)`，宽高取绝对差。

从 PDF 矩形画回这一页的像素是 `pdfRectToViewport`，步骤相反：用左下角 `(x, y)` 和右上角 `(x + width, y + height)` 调用 `convertToViewportPoint`，再取 min 和绝对宽高。得到的数是相对该页左上角的 CSS 像素，坐标系和 SVG 的 `viewBox` 一致。

### 5.3 一个完整的数字例子

下面把“1 个 PDF 点 = 1 个 CSS 像素、页面高 200”作为简化，只说明方向。真实渲染还会乘上 `96 / 72`，第 7 节单独说明。简化不影响矩形最后存在 PDF 空间里这一结论。

窗口中这一页的左上角在 `(80, 40)`。用户划中一行，`getClientRects()` 给出：

- 左上角 `(200, 120)`
- 宽 160，高 24
- 因此右下角是 `(360, 144)`

减去页面原点，相对该页左上角：

- 左上角 `(120, 80)`
- 右下角 `(280, 104)`

翻到 PDF 坐标，页面高 200：

- 左边缘 x 仍是 120，右边缘 x 是 280，宽度 160
- 上边缘的页内 y = 80，对应 PDF y = 200 − 80 = 120
- 下边缘的页内 y = 104，对应 PDF y = 200 − 104 = 96

存下来的是左下角：`{ x: 120, y: 96, width: 160, height: 24 }`。

之后用户把页面放大两倍。这个对象不变。画回去时 viewport 把每个点变成 2 个 CSS 像素，SVG 里的矩形变成宽 320、高 48，仍然盖住同一行字。

### 5.4 viewport 为什么不能放进 Vue 的 ref

`PageViewport` 带有私有字段。放进 `ref` 或 `reactive` 后会被代理，私有字段访问会失败，`convertToPdfPoint` 无法使用。

所以 viewport 只放在普通的 `viewportMap` 里，键是页码。Vue 用来触发重绘的是 `pageMetrics`：只含每页的 `{ width, height }`，值等于当时 `viewport.width` 和 `viewport.height`。高亮函数同时读这两个地方：没有 metrics 就先不画；有 metrics 时再按页码去 `Map` 里取 viewport 做矩阵变换。

## 6. 一页的 DOM：三层叠在一起

页码从 1 开始。`pageNumbers` 是 `[1, 2, …, numPages]`。每一页模板的结构是：

```html
<article class="pdf-page" data-page="1">
  <div class="canvas-wrap"><canvas></canvas></div>
  <svg class="highlights" viewBox="0 0 页宽 页高">
    <g class="comment active" data-comment="评论 id">
      <rect />
      <line />
    </g>
  </svg>
  <div class="textLayer"></div>
</article>
```

`.pdf-page` 是 `position: relative`。三层都是 `position: absolute; inset: 0`，铺满页盒子。叠放顺序：

| 从下到上 | 元素 | z-index | 鼠标 |
| --- | --- | --- | --- |
| 画面 | `.canvas-wrap > canvas` | 0 | 到不了。上面两层盖住了它 |
| 高亮 | `svg.highlights` | 1 | `pointer-events: none`，点击穿过 |
| 文字 | `.textLayer` | 2 | 划选和点击都落在这里 |

人看见的字来自画布。鼠标选中的是文字层里透明的 `span`。高亮夹在中间，看得见，但不挡划字，自己也不接收点击。点在高亮上，事件会落到文字层，再由第 12 节的命中函数用坐标判断点中了哪条评论。

页盒子上有这些 CSS 变量，文字层的字号依赖它们，不能删：

```css
.pdf-page {
  --user-unit: 1;
  --total-scale-factor: calc(var(--scale-factor) * var(--user-unit));
  --scale-round-x: 1px;
  --scale-round-y: 1px;
}
```

`--scale-factor` 在渲染时写到 `.pages` 上，值是当前 viewport 的 `scale`。文字层内部还有：

```css
--min-font-size: 1;
--text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
--min-font-size-inv: calc(1 / var(--min-font-size));
```

`--min-font-size` 会由 PDF.js 的 `TextLayer` 在构造时再写一次。字号公式是 `font-size: calc(var(--text-scale-factor) * var(--font-height))`，再叠加 `rotate`、`scaleX` 和 `scale(var(--min-font-size-inv))`。这些变量和 PDF.js 查看器的文字层一致。少掉任意一个，透明字就会和画布错位，划出来的矩形就偏了。

`span` 的文字颜色是 `transparent`，`user-select: text`，`white-space: pre`。`::selection` 是半透明蓝 `rgb(0 90 255 / 35%)`。这层蓝色只存在于拖动过程中。松手后代码会清掉浏览器选区，蓝色消失，留下自己画的下划线。

### 6.1 PDF.js 怎样把一个字块放成 span

`TextLayer` 读取 `page.streamTextContent(...)` 的结果。每个文字项变成一个 `span`：

- `textContent` 是该项的字符串，通常是一行里的一小段，不一定是整行，也不一定是单个字
- `left` / `top` 写成相对页面宽高的百分比，所以缩放后仍贴在页盒子上
- `--font-height` 是这段字的字号
- 多字或宽高比差得较多时，测量实际文字宽度，把 `--scale-x` 设成“PDF 里的宽度 / 浏览器测到的宽度”，把字距拉到和画布一致
- 有旋转时设置 `--rotate`
- 文字项带换行标记时，后面再跟一个 `br`

本页创建文字层时的参数是：

```js
page.streamTextContent({
  includeMarkedContent: false,
  disableNormalization: true,
})
```

`includeMarkedContent: false`：不要为 PDF 的标记内容结构再包一层 `span.markedContent`。若设为 `true`，同一段字会同时出现在父子 span 里，`getClientRects()` 会给出两套几乎重合的框。样式表里仍保留了 `.markedContent { display: contents }`，和 PDF.js 查看器一致；以当前参数，这些节点不会生成。

`disableNormalization: true`：不要让 PDF.js 改写 Unicode（兼容字符、某些合成形式）。引用文字和查找都直接读 span 里的文本，需要和用户划到的字一致。

扫描件和纯图片 PDF 没有文字项。`TextLayer` 不会变出字，页面上无法划选。本项目没有 OCR。

渲染结束后，代码在文字层末尾追加一个 `<div class="endOfContent">`。这不是高亮，是为了让选区能拖过行尾。平时它的位置是 `inset: 100% 0 0`，也就是整块被推到文字层底边之下，不参与命中。按下鼠标时，若事件来自某个 `.textLayer`，该层加上类名 `selecting`。CSS 把 `.endOfContent` 的 `top` 改成 0，它盖住整页。浏览器的选区算法会把这块区域当成“这一行后面还有可选取的位置”，拖过最后一个 span 时不会停住。松手时去掉 `selecting`，该元素回到页外。

`TextLayer` 构造时也会对自己的容器调用 `setLayerDimensions`。页盒子在此之前已经按同一个 viewport 设过尺寸。文字层同时有 `inset: 0`，因此铺满页盒子。三层共用这一次 viewport，是高亮和文字对齐的前提。

## 7. 打开文档，再把每一页画出来

### 7.1 文档身份

默认文件是 `` `${import.meta.env.BASE_URL}pdf格式测试文件.pdf` ``，对应 `public` 里的测试 PDF。本地开发时 `BASE_URL` 是 `/`；GitHub Pages 构建时 `VITE_BASE` 是 `/comment-pdf/`。默认文档的 `docId` 就是这个地址，评论按它分开存储。

用户上传文件时，`App.vue` 的 `openFile`：

1. 接受 `file.type === 'application/pdf'`，或文件名以 `.pdf` 结尾（大小写不敏感）。否则设置 `fileError` 为“请选择 PDF 文件”，不更换当前文档。
2. 读成 `Uint8Array`。
3. `docId` 用 `` `file:${文件名}:${字节数}:${lastModified}` ``。没有稳定 URL 可用，这三个值用来区分“同名的另一份文件”。文件被修改后，大小或修改时间变了，就会换成另一组评论。
4. 把字节数组交给 `PdfView` 的 `src`。`openPdf` 看到的是 `Uint8Array` 时走 `getDocument({ data })`，字符串则走 `{ url }`。

文件输入框在 `change` 之后会把 `value` 清掉，因此连续两次选同一个文件仍会触发 `change`。

“恢复默认”仅当当前不是默认文档时可用（`canRestore`）。它切回默认 URL 和默认 `docId`，并加载那一份自己的评论。上传得到的字节数组不保留。

换文档时重置选中项、查找关键字、匹配列表和焦点计数，不删除其他 `docId` 已经写在 `localStorage` 里的评论。

### 7.2 PDF.js 还需要哪些静态文件

`src/lib/pdf.js` 在 `getDocument` 上附带：

| 选项 | 目录 | 用途 |
| --- | --- | --- |
| `cMapUrl` + `cMapPacked: true` | `pdfjs/cmaps/` | 中文等字符集的映射 |
| `standardFontDataUrl` | `pdfjs/standard_fonts/` | PDF 标准 14 种字体 |
| `wasmUrl` | `pdfjs/wasm/` | 部分图像解码 |
| `iccUrl` | `pdfjs/iccs/` | 色彩配置 |

这些目录不在仓库里，来自 `node_modules/pdfjs-dist`。`vite.config.js` 的插件在开发时按 `/pdfjs/...` 直接读文件，打包时复制到 `dist/pdfjs/`。Worker 使用 `pdfjs-dist/build/pdf.worker.min.mjs` 的 URL，赋给 `GlobalWorkerOptions.workerSrc`。

### 7.3 loadDocument 的顺序

`src` 变化时，以及组件挂载时，都会调用 `loadDocument`。挂载时的那一次来自 `onMounted`；`watch(src)` 没有 `immediate`，不会在挂载时再打一次。之后每次 `src` 变化打一次。

每次调用先把 `loadToken` 加一。异步返回后如果 token 对不上，说明已经又换了一份文档，这次结果作废。顺序是：

1. `renderJob` 加一，让正在跑的渲染在下一次检查时退出。
2. 清草稿、清输入、清浏览器选区。
3. 状态文案设为“正在打开 PDF”。页码数组、`pageMetrics` 清空，`viewportMap.clear()`，缩放模式回到 `fit`，`renderedOnce` 设为 false。
4. 滚动容器的 `scrollTop` 设为 0。
5. 销毁上一份 `pdf` 和上一个 `loadingTask`。销毁失败被忽略，因为它们可能已经销毁。PDF.js 要求旧文档先销毁，否则 worker 里会留下文档。
6. `openPdf(src)`，等待 `promise`。若 token 已变，销毁刚打开的文档并返回。
7. 用 `pdf.numPages` 生成页码。Vue 据此创建每一页的空 DOM：canvas、空 SVG、空文字层。
8. 状态文案改为“正在渲染”，`requestAnimationFrame` 等一帧，让这些 DOM 先提交。token 再检查一次。
9. 调用 `renderPages`。

打开失败且 token 仍有效时，状态文案是异常的 `message`，没有则是“无法打开 PDF”。

组件卸载时同样增加 `loadToken` 和 `renderJob`，销毁打开任务、断开 `ResizeObserver`、去掉键盘监听、清掉适应宽度的定时器、销毁文档。

### 7.4 渲染为什么要排队

快速连点放大时，不能让两轮渲染同时改同一块 canvas 和文字层。`renderPages` 做两件事：

1. `renderJob` 加一，得到本次编号 `job`。
2. 把 `renderPagesNow(job)` 接到 `renderChain` 后面。接之前有 `.catch(() => {})`，上一轮抛错不会把整条链弄断。

`renderPagesNow` 在开头、取到第一页之后、每一页开始之前、画布完成之后、文字层完成之后，都检查 `job === renderJob`。对不上就返回。因此后一次渲染开始后，前一次会在最近的检查点停下来。

代码没有调用画布任务的 `cancel()`。旧的 `page.render` 仍可能把位图画完，但画完后的文字层更新会被 job 检查拦住。若 PDF.js 抛出 `RenderingCancelledException`，这一轮直接结束，不把状态写成失败。其他渲染异常会把状态写成“页面渲染失败”，并且 `return`，后面的页不再画，`pageMetrics` 也不会被这次的结果替换。

失败发生在缩放重绘的中途时，`viewportMap` 里可能已经写了前几页的新 viewport，而 `pageMetrics` 仍是上一轮成功的尺寸。高亮同时依赖两者，这时下划线可能短暂和页盒子不一致，直到下一次完整成功的渲染。打开文档时 `pageMetrics` 会先被清空，所以首屏失败不会拿旧文档的尺寸去画。

### 7.5 每一页实际做了什么

循环开始前先取第 1 页。若 `scaleMode === 'fit'`，用这一页计算 `userScale`（公式在 7.6）。然后对每个页码：

1. `pdf.getPage`。第 1 页复用已经取到的对象。
2. `page.getViewport({ scale: userScale * PixelsPerInch.PDF_TO_CSS_UNITS })`。
3. 把 `viewport.scale` 写到 `.pages` 的 `--scale-factor`。所有页传入的 scale 相同，这个变量每页写一次，结果一样。
4. `setLayerDimensions(pageEl, viewport, true, false)` 设置页盒子的宽高。第三个参数 `true`：旋转 90° 或 270° 时宽高对调。第四个参数 `false`：不在 DOM 上写 `data-main-rotation`，旋转已经在 viewport 矩阵里。宽高用 CSS `round(down, var(--total-scale-factor) * 页面点数 px, 1px)`，和文字层的取整方式一致。
5. `viewportMap.set(页码, viewport)`。同时在局部对象 `metrics` 里记下宽高，先不赋给 `pageMetrics`。
6. 画布位图尺寸是 viewport 的 CSS 尺寸乘以 `ratio = min(devicePixelRatio, 2)`。CSS 上画布仍是页盒子的 100%。`ratio !== 1` 时，`page.render` 额外传入变换 `[ratio, 0, 0, ratio, 0, 0]`，把画面画进更密的位图。上限 2 是为了避免高分屏上画布过大。
7. 等 `task.promise`。
8. 清空 `.textLayer`，创建 `TextLayer` 并 `render()`。然后追加 `.endOfContent`。

全部页成功后，一次性执行 `pageMetrics.value = metrics`，`renderedOnce = true`，清掉状态文案。查找的 watch 看到 `pageMetrics` 变化，会按新的文字层重算匹配。高亮函数看到 `pageMetrics` 变化，会按新的 viewport 重画。

### 7.6 缩放

`PixelsPerInch.PDF_TO_CSS_UNITS` 是 `96 / 72`，约等于 1.333。PDF 规定 72 点为 1 英寸，CSS 规定 96 像素为 1 英寸。`userScale === 1` 时，页面大约按实际尺寸显示。

工具栏百分比是 `Math.round(userScale * 100)`，显示成 `100%` 这种形式。它不是 viewport.scale。viewport.scale 还乘了 `96 / 72`，那个系数只给 PDF.js 对齐 CSS 像素。

两种模式：

- `fit`，适应宽度，也是每次打开文档的初始模式。基准宽度是第一页在 scale = `96/72` 时的 viewport 宽度。可用宽度是滚动容器的 `clientWidth` 减去左右 padding，并且至少按 240 像素算。`userScale = 可用宽度 / 基准宽度`，再夹到 `[0.5, 3]`。
- `custom`。点“放大”乘 1.1，点“缩小”除以 1.1，同样夹到 `[0.5, 3]`，然后立刻重新渲染。进入 `custom` 之后，窗口变宽不会再改比例，直到点“适应宽度”。

`ResizeObserver` 观察滚动容器。回调里只有“已经成功渲染过，并且仍是 `fit`”才起作用：清掉上一个定时器，150 毫秒后再 `renderPages`。拖动窗口时不会每一帧重画所有页。首次打开不靠这个观察器，由 `loadDocument` 直接渲染。观察器在首次成功之前就挂上了，但 `renderedOnce` 仍是 false，那些早期回调被丢掉。

整份文档共用一个 `userScale`，按第一页算。后面的页更宽时，会超出容器并出现横向滚动，不会每页单独缩小。

点缩放或适应宽度都会整轮重画 canvas 和文字层。PDF 矩形不动。

## 8. 从按下鼠标到评论框

监听绑在滚动容器 `.scroller` 上，不是绑在每一页上。评论框在滚动容器外面，用 `position: fixed`。

### 8.1 按下

`onPointerDown` 先去掉所有文字层上的 `selecting`，再给事件目标所在的那个 `.textLayer` 加上 `selecting`。点在画布区域以外（例如页与页之间的灰边）时，`closest('.textLayer')` 是空，没有任何一层进入 `selecting`。这一步不读选区，也不打开评论框。

### 8.2 松手

`onPointerUp` 立刻去掉 `selecting`。然后按下面的顺序分支，命中一条就停：

| 顺序 | 条件 | 结果 |
| --- | --- | --- |
| 1 | 事件目标在 `.composer` 内 | 直接返回。点发送、取消、输入框不会被当成一次新的划词 |
| 2 | 下一帧 `captureSelection` 返回了草稿 | 记下草稿，清空输入框，`removeAllRanges()`。不去做点击命中 |
| 3 | 没有划到字，但焦点已经在 `.composer` 里 | 返回。避免正在输入时，一次点在文字上的点击把未发送的评论关掉 |
| 4 | 没有划到字，`commentAtPoint` 返回某条评论 id | 关掉草稿，发出 `select` |
| 5 | 没有划到字，也没有点中高亮 | 关掉草稿，不发出 `select`。右侧当前选中项保持不变 |

第 2 步放在 `requestAnimationFrame` 里。松手的同一时刻，部分浏览器还没有把 `Selection` 更新完，等一帧再读才稳定。点击坐标在进动画帧之前就记下，因为帧回调里的事件对象不应再使用；命中检测用的是这一份提前记下的 `{ x: clientX, y: clientY }`。

草稿出现后，另一个 watch 在下一帧把焦点放进评论输入框。

### 8.3 评论框放在哪

定位用的是草稿上的 `clientRect`，即这一次选区里最后一个被留下的窗口矩形，不是所有行的并集。框宽 280 像素：

- 默认 `left = 矩形.left`，`top = 矩形.bottom + 8`
- `left + 280` 超过视口右边缘减 16 时，改到右边留 16 像素
- `left` 小于 8 时，改成 8
- `top + 168` 超过视口高度时，改到选区上方：`max(8, 矩形.top - 168)`。168 是框高度的估计，不是测量出来的真实高度

框是 `position: fixed`，不在滚动容器里，所以页面滚动时它不会跟着字走。滚动监听因此在“焦点不是评论输入框”时把 `draft` 设为 `null`。焦点正在输入框里时允许滚动去看上下文，框留在原地，直到发送、取消或按 Escape。

这个判断看的是 `document.activeElement !== draftInput`，不是“焦点在不在整个评论框里”。焦点若在“发送”或“取消”按钮上，滚动会关掉草稿。按钮点击本身不会引起这次滚动。

Escape 由 window 上的 `keydown` 处理，无论焦点在哪都取消草稿并清掉浏览器选区。

### 8.4 发送

`submitDraft` 要求 `draft` 存在且正文 `trim` 后非空。发出 `create`，载荷只有 `quote`、`prefix`、`suffix`、`anchors`、`body`。`clientRect` 不发出去，因为它是窗口坐标，刷新后无效。

`App.vue` 补上 uuid 和 `createdAt`，把新评论追加到数组末尾，并把 `activeId` 设为这条。`watch(comments, …, { deep: true })` 立刻调用 `saveComments`。草稿和浏览器选区在发出事件后清掉。高亮不会消失：草稿矩形换成了这条新评论的矩形，并且因为它是 `activeId`，会画成选中样式。

取消按钮和 Escape 只清草稿和选区，不写存储。

## 9. 选区怎样变成 anchors

`captureSelection` 是入口。它先拒绝这些情况，返回 `null`：

- 没有 `Selection`，或 `rangeCount === 0`
- `isCollapsed` 为真。这是单击，没有拖出范围
- `toString()` 把连续空白压成一个空格再 `trim` 之后是空的
- 选区起点不是元素节点时，先取它的父元素。起点不在 `.pages` 里面，或不在某个 `.textLayer` 里。从工具栏或右侧列表拖出来的选区在这里被丢掉

只检查起点，不检查终点。起点在文字层里、终点拖到了页外时，仍然继续。页外的那部分矩形会在下一步因为中心不在任何页里而被丢掉。

通过检查后，只使用 `getRangeAt(0)`。然后调用 `anchorsFromRange`。一个矩形都没留下来时，整次划词作废。

### 9.1 每个窗口矩形要过五道过滤

`Range.getClientRects()` 按视觉行返回多个矩形，不是一个包住整段选区的大框。三行字就是至少三个矩形。对每一个：

1. 宽或高小于 2 CSS 像素：丢掉。光标缝和空行残留经常是这种碎框。
2. 用矩形中心找页。中心的 x 是 `left + width / 2`，y 是 `top + height / 2`。遍历 `[data-page]`，中心落在该页 `getBoundingClientRect()` 内（含边界）就属于那一页。中心在页与页的缝里、或在视口里但已经滚出页面盒子，则丢掉。
3. 宽和高都大于该页盒子的 85%：丢掉。拖选时浏览器有时会多给一个几乎盖住整页的矩形，那不是文字。只宽或只高超过 85% 的长条会保留，因为一行很长的正文可以接近页宽。
4. 这一页还没有 viewport：丢掉。正常渲染完成前不会走到划词。
5. 换成 PDF 矩形后，宽或高小于 0.5 点：丢掉。窗口里刚好超过 2 像素，换算后仍可能薄到没有意义。

留下来的矩形按页码推进一个 `Map`。同时记住最后一个留下来的窗口矩形，当作评论框的 `clientRect`。分组完成后按页码升序，每一页的矩形先 `dedupeRects`，再 `alignLineRects`。

### 9.2 去掉重叠框

`dedupeRects` 按原有顺序看每个矩形，维护一个“已保留”列表。对当前矩形算它和某个已保留矩形的重叠面积。重叠宽度或重叠高度小于等于 0，视为不相交。若重叠面积除以当前矩形自己的面积大于 0.6，丢掉当前矩形。先出现的留下，后出现且大部分落在已有框里的丢掉。

阈值比的是“后来者自己的面积”，不是两个框并集的面积。一个大框只被小框盖住一角时，小框不会因此被删。一个小框几乎完全落在已保留框里时会被删。

例子。已保留 A：`x = 10, y = 100, width = 100, height = 12`。后一个 B：`x = 12, y = 101, width = 90, height = 10`。

- B 的面积 = 900
- 重叠宽 = min(110, 102) − max(10, 12) = 90
- 重叠高 = min(112, 111) − max(100, 101) = 10
- 重叠面积 = 900，占 B 的 100%，大于 0.6，B 被丢掉

`includeMarkedContent` 现在是 false，正常路径上父子 span 不会再制造这种重复框。这一步仍保留，因为 `getClientRects()` 本身仍可能对同一段字返回重叠矩形。去重只发生在生成 anchor 时。绘制阶段不会再去重。

### 9.3 收成一行一条下划线

去重之后，一行里往往还有左右分开的几块：一个词一块，或者字距被拆开。各画各的，下划线会断成许多短线，高低也可能差一两点。

`alignLineRects` 把它们收成每一视觉行一条，或同一行上少数几段。

第一步，复制数组后排序：PDF 的 `y` 从小到大，y 相同再按 `x`。y 向上，所以页面上更靠下的行先进入分组。然后依次放入行组。两个矩形算同一行的条件是 `sameLine`：它们在 y 方向的重叠长度，大于较矮那个高度的一半。只比中心或只比底边，上下标容易被拆错行；用重叠比例稳一些。

第二步，对每一行：

- 底 = 组内最小的 `y`
- 顶 = 组内最大的 `y + height`
- 行高 = 顶 − 底
- 组里每个矩形都改用这个统一的底和行高，下划线因此在同一条水平线上

第三步，组内再按 `x` 从左到右。后一个和前一个的间隙是 `后一个.x - (前一个.x + 前一个.width)`。间隙小于等于 `max(1.5, 行高 * 0.6)` 点时，并进前一个：左边缘不动，右边缘取两者右边缘的较大值。间隙更大则保留为同一行上的另一段。一行里只选了左右两个词、中间没选时，就会留下两段。

1.5 点大约 0.5 毫米，用来粘合字距造成的小缝。`行高 * 0.6` 让字号大时允许更宽的缝，避免标题被拆碎。

例子。同一行两块：

- A：`{ x: 10, y: 100, width: 40, height: 12 }`，右边缘 50，顶 112
- B：`{ x: 52, y: 101, width: 30, height: 11 }`，右边缘 82，顶 112

重叠高度 = min(112, 112) − max(100, 101) = 11。较矮高度是 11，一半是 5.5。11 > 5.5，同一行。统一之后底是 100，行高是 12。间隙 = 52 − 50 = 2。阈值 = max(1.5, 7.2) = 7.2。2 ≤ 7.2，合并成 `{ x: 10, y: 100, width: 72, height: 12 }`。

若 B 的 x 是 80，间隙是 30，大于 7.2，则保留两段，两段的 y 都是 100、高度都是 12。

对齐发生在两个时机：

- 写入 anchor 时：`alignLineRects(dedupeRects(rects))`，存进评论的就是对齐后的矩形
- 画每一笔高亮时：`appendHighlight` 对传入的 `rects` 再调用一次 `alignLineRects`

已经由这个函数产出的矩形再跑一次，行组和间隙判断不变，结果相同。绘制时再跑一次，是为了画出来的下划线始终按行对齐，即使某条旧数据里的矩形还没有对齐过。存储里的旧 JSON 不会在读取时被改写。

查找调用的也是 `anchorsFromRange`，所以查找高亮和划词高亮使用同一套过滤、去重和行对齐。

## 10. 前后文怎么取

`contextFromRange` 只看选区第一页（`anchors[0].page`）的文字层。它先收集叶子 span：元素内部不再包含 `span` 的那一层。外层容器的 `textContent` 不会再被拼一遍。

用选区起点所在 span、终点所在 span，在这个列表里的下标：

- 起点的下标找不到：`prefix` 和 `suffix` 都是空字符串。选区本身仍然有效
- `prefix`：起点之前最多 2 个 span 的 `textContent` 拼起来，再取末尾 20 个字符
- `suffix`：终点的下一个 span 起，最多再取 2 个 span，拼起来后取开头 20 个字符。终点下标找不到时，从起点的下一个 span 开始取

按 span 而不是按字符往回扫，是因为一个 span 通常已经是 PDF 里的一个文字块。大多数正文里，2 个块够放下 20 个字，又不需要把整页再读一遍。

前后文和引用一起保存。当前没有任何定位、查找或展示代码读取它们。PDF 改版后，旧坐标可能指到别的字上，程序不会用前后文重新搜索。这是预留字段。

## 11. 高亮怎么画回屏幕

每一页只有一个 `<svg class="highlights">`。`viewBox` 来自 `viewBox(页码)`：有 metrics 时是 `` `0 0 ${width} ${height}` ``，宽高是该页 viewport 的 CSS 像素；还没有 metrics 时是 `0 0 0 0`。SVG 用 CSS 拉成页盒子的 100% 宽高。矩形先经过 `pdfRectToViewport`，进入同一套像素，因此和文字层、画布对齐。

`highlightRects(页码)` 在这一页没有 viewport 或没有 metrics 时返回空数组，避免用半初始化的坐标去画。否则按下面的顺序追加：

1. 每条评论。只取 `anchor.page` 等于这一页的项。`active` 为真当且仅当评论 id 等于 `activeId`。
2. 草稿。id 固定写成字符串 `"draft"`，`active` 恒为真。草稿还没进评论数组，所以要单独画，否则松手后要等发送才看得到下划线。
3. 查找结果。`forEach` 的下标转成字符串作为 id。`active` 为真当且仅当这个下标等于 `matchIndex`。

每一项在 `appendHighlight` 里先做行对齐，再逐个变成绘制对象：

```js
{
  key: "comment-评论id-0",  // 或 match-0-0、comment-draft-0
  id: "评论 id 或结果下标或 draft",
  kind: "comment 或 match",
  active: true 或 false,
  x, y, width, height       // 已经是 viewBox 像素
}
```

`key` 用种类、id 和行下标拼出来，供 Vue 的列表复用。同一条评论在同一页上的第 0 行、第 1 行是两个元素。

模板把每个对象包进一组。评论和草稿带 `data-comment`，不带 `data-match`。查找结果相反。类名是种类，再加上可选的 `active`。组里有一个铺满矩形的 `<rect>`，以及一条贴在矩形底边的 `<line>`：

- 线的两个端点是 `(x, y + height)` 和 `(x + width, y + height)`
- 在 SVG 坐标系里 y 向下，所以 `y + height` 是这块区域的下边，也就是下划线

颜色全在 CSS 里，不写进坐标：

| 状态 | 类 | 样子 |
| --- | --- | --- |
| 普通评论 | `.comment` | `<rect>` 无填充。下划线 `#e6a100`，线宽 2 |
| 选中的评论，以及草稿 | `.comment.active` | 底色 `rgb(255 214 0 / 45%)`，下划线 `#d86b00` |
| 普通查找结果 | `.match` | 下划线 `#2f6fed`，无底色 |
| 当前查找结果 | `.match.active` | 底色 `rgb(47 111 237 / 28%)`，下划线 `#1d4ed8` |

SVG 在文字层下面，并且 `pointer-events: none`。后追加的组画在上面。同一块字既有评论又被查找命中时，查找的线和底色盖住评论的线和底色。点击判断不看谁画在上面，只看第 12 节的 PDF 矩形检测，并且只检测评论，不检测查找和草稿。

`comments`、`activeId`、`matches`、`matchIndex`、`draft`、`pageMetrics` 任一变化，相关页的 `highlightRects` 会重算。存在评论里的 PDF 矩形不用改。

## 12. 点击高亮，以及列表如何滚回原文

SVG 不接收点击。命中只发生在第 8 节的第 4 步：这一次松手没有形成选区。

`commentAtPoint(clientX, clientY, root, viewportFor, comments)`：

1. 把点击当成宽高为 0 的矩形，中心就是这个点，用 `pageAt` 找页。点不在任何页盒子里，返回 `null`。
2. 该页没有 viewport，返回 `null`。
3. 减去页盒子左上角，`convertToPdfPoint` 得到 PDF 上的一个点。
4. 从评论数组最后一项走到第一项。跳过 `anchor.page` 不是这一页的项。点的 x 落在 `[rect.x, rect.x + width]`、y 落在 `[rect.y, rect.y + height]`（都含边界）时，返回该评论的 `id`。
5. 没有任何矩形包含这个点，返回 `null`。

从末尾往前，是因为新评论追加在数组后面。两段高亮重叠时，后写的那条算命中。草稿矩形和查找矩形不在这个循环里。

返回 id 时，`PdfView` 发出 `select`。`App.vue` 的 `selectComment`：

- 把 `activeId` 设为这个 id。高亮函数因此给对应矩形加上 `active`，右侧列表项也加上 `active`（背景 `#fff6d8`）
- 把 `focusNonce` 加 1

`PdfView` 监视 `focusNonce`。只要 `activeId` 非空，就在 `.pages` 里找第一个 `[data-comment="这个 id"]`，调用 `scrollIntoView({ block: 'center', behavior: 'smooth' })`。跨页评论的每一页都有这个属性，`querySelector` 找到文档顺序中的第一个，也就是页码较小的那一页上的第一笔。

用一个只增的数字，是因为连续点同一条时 `activeId` 不会变，Vue 不会因为“选中项没变”而重新滚动。`focusNonce` 每次点都变，滚动会再执行。

右侧列表点某一条走同一个 `selectComment`。点空白处返回 `null` 时不发出 `select`，所以当前项保持原样，只有草稿被关掉。

删除走 `removeComment`：从数组过滤掉该 id。若删的是当前项，`activeId` 变成 `null`。数组变化触发保存，高亮随数组重画而消失。

列表上的页码文案由 `pageLabel` 生成：取出这条评论 anchors 里的页码，去重并排序。只有一页时是“第 n 页”，多页时是“第 起始–结束 页”。中间若有没选到的页，文案仍显示成一个区间，不会列出每一页。

## 13. 正文查找

查找框在右侧面板顶部，是一个 `type="search"` 的输入框。每次 `input` 都把当前值通过 `search` 事件写到 `App.vue` 的 `query`，不需要按回车。

`PdfView` 监视 `query` 和 `pageMetrics`。关键字变了要重查；文字层重画之后也要重查，因为查找依赖 DOM 里的文本节点，而文本节点在每次渲染时都会被 `replaceChildren()` 清掉重建。

`findMatches(root, viewportFor, query)`：

1. `trim` 后为空，返回 `[]`。不按空白字符做模糊匹配，只去掉首尾空白。
2. 按 `[data-page]` 的文档顺序逐页处理，不把多页拼成一个字符串，因此匹配不能跨页。
3. 每一页只取叶子 span。每个 span 只读取第一个子节点，并且该节点必须是文本节点；否则这段贡献空字符串。以当前的 `TextLayer` 实现，文字就放在 span 的文本节点里，这个条件成立。
4. 把这些字接成一个字符串，同时记录每个字符所在的文本节点和节点内偏移。
5. 用 `indexOf` 做精确查找，区分大小写，不使用正则。找到一处后，下一次从匹配结束的位置继续，相邻结果不重叠。例如关键字是 `aa`，正文是 `aaaa`，结果是位置 0 和位置 2 两处。
6. 用首字符和末字符构造 `Range`：起点是首字符的节点和偏移，终点是末字符的节点、偏移加 1（`setEnd` 的偏移是“结束位置之后”）。
7. 把这个 `Range` 交给 `anchorsFromRange`。矩形全部被过滤掉时，这一处不进入结果。
8. 进入结果的项使用当时结果数组的长度作为字符串 id，所以 id 等于它在数组里的下标。

结果经 `matches` 事件交给 `setMatches`：

- 替换 `matches`
- 若 `matchIndex` 已经大于等于新长度，回到 0
- 只要新结果非空，就把 `matchFocus` 加 1

`PdfView` 监视 `matchFocus`。有结果时先 `nextTick`，等 SVG 上的 `data-match` 画出来，再找 `[data-match="当前下标"]` 并滚到视口中间。`data-match` 的值是 `highlightRects` 里写入的下标字符串，和查找结果的 id 一致。

切换当前项的方式：

- 面板上的 ↑ / ↓
- 点击结果列表的某一项（`choose`）
- 键盘 ↑ / ↓

键盘监听在 `CommentPanel` 里，挂在 window 上。目标在 `textarea` 里时直接返回，让评论框用方向键移动光标。查找框是 `input`，不在这个例外里，所以焦点在查找框时方向键也会切换结果。没有关键字或没有结果时不处理。处理时 `preventDefault`，避免页面跟着滚动。方向键每次让 `matchIndex` 加 1 或减 1，并用结果长度取模，因此到头之后回到另一端。然后 `matchFocus` 加 1，触发滚动。

关键字非空时，面板上方是匹配列表：每一项显示“第 n 项 · 第 p 页”和关键字本身。没有匹配时显示“没有匹配的文字”。匹配列表下面仍然是评论列表；没有评论时仍显示那句空状态说明。清空关键字后匹配列表消失，蓝色下划线也消失，因为 `findMatches` 返回空数组。

换文档时 `showDocument` 把 `query`、`matches`、`matchIndex` 和 `matchFocus` 清零。

## 14. localStorage 里的形状

键是 `comment-pdf:` 加上 `docId`。值是：

```js
{
  version: 1,
  docId: "与键中相同的文档 id",
  docVersion: 1,
  comments: []
}
```

`loadComments` 在这些情况返回空数组，不抛给界面：

- 键不存在
- JSON 无法解析
- `version` 不是 1
- `docId` 和要读取的不一致
- `comments` 不是数组

`docVersion` 固定写成 1，读取时不检查。它目前没有让旧评论失效的作用。

没有后端，也没有跨浏览器同步。清站点数据、换浏览器、换 `docId`，都读不到原来的评论。高亮没有写进 PDF 文件。把原文件拷到另一台机器打开，看不到这些下划线。

保存由评论数组的深度 watch 触发。发送和删除都会换数组或改到数组内容，因此都会保存。仅仅切换 `activeId` 或查找，不会写存储。

## 15. 一次划词的时间顺序

把前面的步骤按用户动作串起来：

1. 用户在透明文字上按下。该页文字层加上 `selecting`，`.endOfContent` 盖住整页。
2. 拖动时看见的是浏览器的 `::selection` 蓝色。这时还没有 PDF 坐标，也没有草稿。
3. 松手。去掉 `selecting`。若松在评论框上，到此结束。
4. 下一帧读取选区。折叠、空白、起点不在文字层，都视为没有划词，转去点击命中。
5. 否则取出每一行的窗口矩形，按中心归页，丢掉过小的、几乎整页的、换算后过薄的，换成 PDF 矩形，去重，再按行对齐并合并小缝。
6. 从第一页的叶子 span 取前后各最多 20 个字。最后一个窗口矩形用来摆评论框。
7. 清掉浏览器选区。草稿进入高亮函数，对应页的 SVG 出现金色下划线和黄色底。焦点进入输入框。
8. 用户输入并发送。评论追加到数组末尾并写入 `localStorage`。草稿消失。这条评论成为 `activeId`，下划线保持选中样式。
9. 下次打开同一个 `docId`：先读出 anchors，等该页 viewport 算完并写入 `pageMetrics`，再用 `convertToViewportPoint` 画回 SVG。

单击已有下划线时走另一条：第 4 步没有选区，点击点被换成 PDF 坐标，从最新的评论往前做点在矩形内的测试，命中则右侧选中并滚到该高亮。

## 16. 现在没有做的事

坐标能对上，是因为再次打开的是同一份 PDF，页面内容没有移动。下面这些没有做：

- 没有账号和服务器。评论只在这台浏览器的 `localStorage`。
- 扫描件和纯图片 PDF 没有文字层，不能划词，也没有 OCR。
- PDF 重新导出、增删页面之后，旧页码和坐标可能指到别的内容。`prefix` 和 `suffix` 不会用来重新定位。
- 高亮是轴对齐矩形。旋转的字按外接矩形铺底色，下划线沿矩形底边，不沿字的基线方向。
- 查找是单页内的精确子串，区分大小写，不支持正则、忽略空白或跨页。
- 评论框不跟着滚动浮在选区旁边。焦点不在输入框里时，一滚动就关掉未发送的草稿。
- 高亮不写回 PDF。下载原文件或换机器打开，看不到评论。
- `docVersion` 写进了存储但没有参与校验。若以后要让旧坐标失效，需要提高 `version` 或开始检查 `docVersion`，并接受对不上的评论被当成空列表。
- 适应宽度只看第一页。更宽的后续页会出现横向滚动。
- 渲染失败时不会逐页跳过。第一处非取消异常会停掉这一轮剩余的页。

## 17. 改某种行为时看哪个函数

| 想改的行为 | 位置 |
| --- | --- |
| 什么样的选区算数、跨页怎么分、碎框和整页框的阈值 | `anchorsFromRange` |
| 重叠框的 60% 阈值 | `dedupeRects` |
| 怎样算同一行、间隙小于多少就合成一条下划线 | `sameLine`、`alignLineRects`。注意绘制时还会再跑一次 `alignLineRects` |
| 点下去算哪条评论、重叠时谁优先 | `commentAtPoint`。优先顺序就是评论数组从后往前 |
| 下划线颜色、选中底色、文字能否被选中、行尾能否继续拖 | `src/style.css` 的 `.highlights`、`.textLayer`、`.endOfContent` |
| 评论框的位置和翻转规则 | `PdfView.vue` 的 `composerStyle` |
| 松手后打开草稿还是改为点击命中 | `onPointerUp` |
| 滚动时要不要关掉未发送的评论 | `onMounted` 里滚动容器的 `scroll` 监听 |
| 缩放上下限、适应宽度以哪一页为准、高分屏画布上限 | `renderPagesNow` 里的 `userScale` 和 `ratio`，以及 `zoomBy` |
| 打开失败、换文档时如何丢掉过期任务 | `loadDocument` 的 `loadToken`，`renderPages` 的 `renderJob` |
| 存哪些字段、什么情况下旧评论被忽略 | `comments.js`。换文档时的 id 规则在 `App.vue` 的 `openFile` 和 `showDocument` |
| 查找是否忽略大小写、是否跨页 | `search.js` 的 `findMatches`。得到 `Range` 之后继续用 `anchorsFromRange`，不要另写一套矩形转换 |
| 高亮和文字错位 | 先确认三层仍共用同一次 viewport：`setLayerDimensions`、`--scale-factor`、SVG 的 `viewBox`、`pdfRectToViewport`。不要把 `getBoundingClientRect()` 的结果写进评论 |
