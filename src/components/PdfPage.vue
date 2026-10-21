<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RenderingCancelledException, setLayerDimensions, TextLayer } from 'pdfjs-dist'

const props = defineProps({
  page: { type: Object, required: true },
  scale: { type: Number, required: true },
  active: { type: Boolean, default: false },
  textReady: { type: Boolean, default: false },
  highlights: { type: Array, required: true },
})

const emit = defineEmits(['text-ready', 'text-released', 'render-error'])

const root = ref(null)
const canvasWrap = ref(null)
const textEl = ref(null)

let generation = 0
let renderTask = null
let textLayer = null
let textScale = 0

function isCancelled(error) {
  return error?.name === 'RenderingCancelledException' || error instanceof RenderingCancelledException
}

function release() {
  generation += 1
  renderTask?.cancel()
  renderTask = null
  canvasWrap.value?.replaceChildren()
  if (textLayer) {
    textLayer.cancel()
    textLayer = null
    textEl.value?.replaceChildren()
    emit('text-released', props.page.number)
  }
}

async function paintCanvas(viewport, gen) {
  const canvas = document.createElement('canvas')
  const ratio = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.floor(viewport.width * ratio)
  canvas.height = Math.floor(viewport.height * ratio)
  renderTask?.cancel()
  renderTask = props.page.proxy.render({
    canvas,
    viewport,
    transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
  })
  try {
    await renderTask.promise
  } catch (error) {
    if (!isCancelled(error) && gen === generation) emit('render-error', props.page.number)
    return
  }
  if (gen !== generation) return
  renderTask = null
  canvasWrap.value.replaceChildren(canvas)
}

async function buildText(viewport) {
  if (!props.textReady || !props.page.textContent) return
  if (textLayer) {
    if (textScale && textScale !== viewport.scale) {
      textLayer.update({ viewport })
      textScale = viewport.scale
    }
    return
  }
  textEl.value.replaceChildren()
  textScale = 0
  const layer = new TextLayer({ textContentSource: props.page.textContent, container: textEl.value, viewport })
  textLayer = layer
  try {
    await layer.render()
  } catch {
    return
  }
  if (textLayer !== layer) return
  const current = props.page.proxy.getViewport({ scale: props.scale })
  if (current.scale !== viewport.scale) layer.update({ viewport: current })
  textScale = current.scale
  const endOfContent = document.createElement('div')
  endOfContent.className = 'endOfContent'
  textEl.value.append(endOfContent)
  emit('text-ready', { number: props.page.number, pageEl: root.value, textDivs: layer.textDivs })
}

function update() {
  if (!props.active) {
    release()
    return
  }
  const gen = ++generation
  const viewport = props.page.proxy.getViewport({ scale: props.scale })
  paintCanvas(viewport, gen)
  buildText(viewport)
}

onMounted(() => {
  setLayerDimensions(root.value, props.page.base, true, false)
  watch(() => [props.active, props.scale, props.textReady], update, { immediate: true })
})

onBeforeUnmount(release)
</script>

<template>
  <article ref="root" class="pdf-page" :data-page="page.number">
    <div ref="canvasWrap" class="canvas-wrap"></div>
    <svg
      class="highlights"
      :viewBox="`0 0 ${page.width} ${page.height}`"
      preserveAspectRatio="none"
    >
      <g
        v-for="box in highlights"
        :key="box.key"
        :data-comment="box.id"
        :data-comment-match="box.matchKey"
        :class="['comment', { active: box.active, approximate: box.approximate }]"
      >
        <rect :x="box.x" :y="box.y" :width="box.width" :height="box.height" />
        <line :x1="box.x" :x2="box.x + box.width" :y1="box.y + box.height" :y2="box.y + box.height" />
      </g>
    </svg>
    <div ref="textEl" class="textLayer"></div>
  </article>
</template>
