# PDF 划词评论

Vue 3 页面用 PDF.js 渲染画布和文字层。选中文字后写评论，高亮按 PDF 页面坐标保存，刷新后仍会显示。文件在浏览器本地打开，评论保存在本机。

```bash
npm install
npm run dev
```

打开页面后会预览 `public/pdf格式测试文件.pdf`。划词高亮的实现见 [docs/selection-highlight.md](docs/selection-highlight.md)。

推送到 `main` 后，GitHub Actions 会把页面发布到 <https://june-ten.github.io/comment-pdf/>。
