import {
  getDocument,
  GlobalWorkerOptions,
} from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

const assetBase = import.meta.env.BASE_URL

export function openPdf(url) {
  return getDocument({
    url,
    cMapUrl: `${assetBase}pdfjs/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assetBase}pdfjs/standard_fonts/`,
    wasmUrl: `${assetBase}pdfjs/wasm/`,
    iccUrl: `${assetBase}pdfjs/iccs/`,
  }).promise
}
