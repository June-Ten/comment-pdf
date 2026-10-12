# 选择文本并高亮

页面不用 PDF.js 自带工具栏，也不把查看器放进 iframe。PDF.js 只负责画出每一页的画布和文字层。选区、评论框、高亮和右侧列表都由本页面处理。

高亮不跟着浏览器选区走。松手时把选区换成 PDF 页面坐标存下来，之后每次重绘都用这些坐标再画回屏幕。缩放、刷新都走同一条路。

## 一页上叠了三层

每一页是一个 `.pdf-page`，里面从下到上是：

| 层 | 元素 | 作用 |
| --- | --- | --- |
| 画布 | `canvas` | 看见的页面，不接收鼠标 |
| 高亮 | 每页一个 `svg.highlights` | 黄色矩形，`pointer-events: none`，不挡选字 |
| 文字层 | `.textLayer` | 透明文字，浏览器在这里产生选区 |

文字层在最上面，所以拖选发生在文字上。高亮在文字下面，点击会穿过 SVG，落到文字层，再由页面自己判断点中了哪条评论。

文字层由 PDF.js 的 `TextLayer` 生成。渲染时用当前页的 viewport，把每个文字块放成绝对定位的透明 `span`。人看见的是画布，鼠标选中的是这些 span。样式沿用 PDF.js 查看器的文字层规则：文字颜色透明、`::selection` 给出选中底色，以及末尾的 `.endOfContent`。按下鼠标时给文字层加上 `selecting`，`.endOfContent` 会盖住整页，这样选区可以拖过一行的末尾，不会停在最后一个 span 上。

```137:151:src/components/PdfView.vue
    const textEl = pageEl.querySelector('.textLayer')
    textEl.replaceChildren()
    const textLayer = new TextLayer({
      textContentSource: page.streamTextContent({
        includeMarkedContent: true,
        disableNormalization: true,
      }),
      container: textEl,
      viewport,
    })
    await textLayer.render()
```

`includeMarkedContent: true` 会多出一层标记内容节点。同一段字有时会出现在父子 span 里，后面用叶子 span 和矩形去重处理。

## 从松手到评论框

滚动区域监听 `pointerup`。松手后等一帧，让浏览器先把选区稳定下来，再读 `window.getSelection()`。

有选区时打开评论框，位置用选区最后一个矩形，固定在视口上。没有选区（点了一下）时，用同一个点击坐标去做高亮命中检测。点在评论框上则什么都不做。

```181:197:src/components/PdfView.vue
function onPointerUp(event) {
  clearSelecting()
  if (event.target.closest?.('.composer')) return
  const point = { x: event.clientX, y: event.clientY }
  requestAnimationFrame(() => {
    if (!pagesRoot.value) return
    const captured = captureSelection(pagesRoot.value, viewportFor)
    if (captured) {
      draft.value = captured
      draftBody.value = ''
      return
    }
    // ... 没有选区时做点击命中
  })
}
```

`captureSelection` 会丢掉这些情况：没有选区、选区已折叠、选中文字去掉空白后是空的、选区起点不在本页面的 `.textLayer` 里。

## 选区怎么变成 PDF 坐标

浏览器给的是窗口坐标：原点在视口左上角，y 向下，单位是 CSS 像素。PDF 页面坐标原点在页面左下角，y 向上，单位是点（point）。缩放之后两者差得更多，所以不能把 `getBoundingClientRect()` 的数字直接存下来。

转换分三步。

**1. 选区拆成若干矩形，并归到某一页。**

`range.getClientRects()` 按行给出矩形。多行就是多个矩形，不是一个大框。每个矩形用中心点去对 `[data-page]` 的页面盒子，中心落在哪一页，这个矩形就属于那一页。跨页选区会按页分成多组。

过小的矩形（宽或高小于 2px）丢掉。几乎盖住整页的矩形也丢掉，那是拖选时浏览器偶发的整页框，不是文字本身。

**2. 减去页面原点，再交给 viewport。**

页面左上角来自 `pageEl.getBoundingClientRect()`。矩形的 `left/top/right/bottom` 减去这个原点，得到相对该页左上角的坐标。然后用这一页渲染时保存的 `PageViewport.convertToPdfPoint` 转换两个角。

```17:28:src/lib/selection.js
function clientRectToPdf(rect, pageEl, viewport) {
  const box = pageEl.getBoundingClientRect()
  const [x1, y1] = viewport.convertToPdfPoint(rect.left - box.left, rect.top - box.top)
  const [x2, y2] = viewport.convertToPdfPoint(rect.right - box.left, rect.bottom - box.top)
  const x = Math.min(x1, x2)
  const y = Math.min(y1, y2)
  return {
    x,
    y,
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  }
}
```

`convertToPdfPoint` 是 PDF.js `PageViewport` 的方法，不是自己写的比例换算。它使用这一页 viewport 的变换矩阵的逆变换，里面已经包含当前缩放，以及从“左上角、y 向下”到“左下角、y 向上”的翻转。两个角谁大谁小取决于 y 轴方向，所以存储时取较小的 x、y，宽高取绝对值。这样矩形始终是轴对齐的，和角的顺序无关。

viewport 在渲染时放进一个普通 `Map`，不放进 Vue 的响应式对象。`PageViewport` 有私有字段，被响应式代理后会坏掉。

**3. 一个数字例子。**

下面按缩放为 1、页面视口 400×200 来说明方向，不是某一页的真实尺寸。

窗口里页面左上角在 `(80, 40)`。选中一条文字，窗口矩形是 `(200, 120)`，宽 160、高 24。

减去页面原点后，相对页面左上角是 `(120, 80)`，右下角是 `(280, 104)`。

翻到 PDF 坐标（原点在左下，页面高 200）：

- 左边缘 x 仍是 120
- 上边缘的窗口 y=80，对应 PDF y = 200 − 80 = 120
- 下边缘的窗口 y=104，对应 PDF y = 200 − 104 = 96

存下来的是左下角和尺寸：`{ x: 120, y: 96, width: 160, height: 24 }`。放大或缩小之后，这个矩形不变，变的是画回屏幕时用的 viewport。

## 一行一个矩形，一页一个 SVG

多行选中不会生成多个 SVG。`getClientRects()` 的每个矩形各自转成 PDF 矩形，按页放进同一个 anchor：

```js
anchors: [
  { page: 1, rects: [ /* 这一页上的每一行 */ ] },
  { page: 2, rects: [ /* 选区跨到下一页时 */ ] },
]
```

绘制时每一页只有一个 `<svg class="highlights">`。这一页上所有评论的所有行，都是这个 SVG 里的 `<rect>`。`viewBox` 用当前 viewport 的宽高，矩形先用 `convertToViewportPoint` 转回页面像素，所以 SVG 和文字层用的是同一套缩放。

```283:296:src/components/PdfView.vue
        <article v-for="number in pageNumbers" :key="number" class="pdf-page" :data-page="number">
          <div class="canvas-wrap"><canvas></canvas></div>
          <svg class="highlights" :viewBox="viewBox(number)">
            <rect
              v-for="box in highlightRects(number)"
              :key="box.key"
              :data-comment="box.id"
              :class="{ active: box.active }"
              :x="box.x"
              :y="box.y"
              :width="box.width"
              :height="box.height"
            />
          </svg>
          <div class="textLayer"></div>
        </article>
```

画回去是存储的逆操作：对矩形两个角调用 `convertToViewportPoint`，再取较小坐标和绝对宽高。

## 重叠矩形和前后文

标记内容会让同一行文字出现两层 span，`getClientRects()` 就会给出两个几乎重合的框。`dedupeRects` 按顺序保留矩形；若后一个与已保留矩形的重叠面积超过自身面积的 60%，就丢掉后一个。

评论还存了选区前后各最多 20 个字，取自文字层里的叶子 span（内部不再包含 span 的那一层），避免把外层标记节点的整段文字再算一遍。前后文目前只是和引用一起保存，定位仍然只靠坐标。

## 保存之后如何再画出来

评论框提交后，`App.vue` 写入一条评论：引用文字、前后文、正文、时间，以及上面的 `anchors`。`localStorage` 的键是 `comment-pdf:` 加上文档地址，整包带 `version` 和 `docId`。版本或文档对不上就当作没有评论。

高亮不把屏幕坐标存进 localStorage。列表里的 `anchors` 一变，`highlightRects` 用当前 viewport 重算每个 `<rect>` 的 x、y、宽、高。缩放、适应宽度都会重新 `getViewport` 并渲染文字层，渲染结束时更新 `pageMetrics`，高亮跟着重画。存在 PDF 坐标里的矩形不用改。

当前评论的矩形带 `active` class，填充更深并加描边。点击右侧列表会增加 `focusNonce`，页面把带有对应 `data-comment` 的矩形滚到中间。

## 点击高亮时右侧为什么会选中

SVG 没有点击事件，也不能被点到。命中发生在文字层的 `pointerup` 上，而且只在没有文字选区时进行。

`commentAtPoint` 用同一次点击的窗口坐标：先按中心点找到页，再 `convertToPdfPoint`，得到 PDF 上的一个点。然后从最新的评论往前，看这个点是否落在该页某个已存矩形里。落在里面就 `emit('select', id)`，右侧对应项加上 `active`。后写的评论盖住先写的评论，因为循环从数组末尾开始。

```125:148:src/lib/selection.js
export function commentAtPoint(clientX, clientY, root, viewportFor, comments) {
  const pageEl = pageAt(
    { left: clientX, top: clientY, width: 0, height: 0, right: clientX, bottom: clientY },
    root,
  )
  // ...
  const [x, y] = viewport.convertToPdfPoint(clientX - box.left, clientY - box.top)

  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const comment = comments[index]
    for (const anchor of comment.anchors) {
      if (anchor.page !== page) continue
      for (const rect of anchor.rects) {
        if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) {
          return comment.id
        }
      }
    }
  }
  return null
}
```

点在两段高亮之间的空白处，函数返回 `null`，只是关掉评论框，不改变当前选中项。

## 数据各自放在哪里

| 数据 | 存放位置 | 什么时候变 |
| --- | --- | --- |
| 引用、评论正文、页码、PDF 矩形 | `localStorage` 里的评论 | 发送或删除评论 |
| 每一页的 viewport | 渲染时写入的 `viewportMap` | 打开、缩放、适应宽度、容器尺寸变化 |
| 屏幕上的高亮矩形 | 由 PDF 矩形和 viewport 现算 | 评论或 viewport 变化 |
| 浏览器选区 | `window.getSelection()` | 只存在到发送、取消或滚动关掉评论框 |

滚动时如果焦点不在评论输入框里，未发送的选区会被关掉，避免评论框停在已经滚走的位置上。

## 现在不做的事

坐标对得上，是因为打开的是同一份 PDF，页面内容没有移动。下面这些没有做：

- 没有后端，评论只在这台浏览器的 `localStorage` 里。
- 扫描件没有文字层，不能划词。没有 OCR。
- PDF 改版后，原来的坐标可能对到别的字上。没有按前后文重新定位。
- 高亮是轴对齐矩形。旋转文字会按外接矩形上色。
