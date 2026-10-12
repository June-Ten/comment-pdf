import {
  getDocument,
  GlobalWorkerOptions,
} from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

const assetBase = import.meta.env.BASE_URL

export function openPdf(source) {
  return getDocument({
    ...(typeof source === 'string' ? { url: source } : { data: source }),
    cMapUrl: `${assetBase}pdfjs/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assetBase}pdfjs/standard_fonts/`,
    wasmUrl: `${assetBase}pdfjs/wasm/`,
    iccUrl: `${assetBase}pdfjs/iccs/`,
  })
}
