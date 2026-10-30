import init, { to_svg } from 'vtracer-wasm'
import wasmUrl from 'vtracer-wasm/vtracer.wasm?url'
import { padTransparent, planAlpha } from './core/alpha'
import { removeBackground } from './core/background'
import { toTracerConfig, traceScale, type Settings } from './core/settings'
import { composeSvg } from './core/svg'

export interface TraceRequest {
  id: number
  file: Blob
  settings: Settings
}

export type TraceResponse =
  | { id: number; ok: true; svg: string; width: number; height: number; ms: number; backgroundMissing: boolean }
  | { id: number; ok: false; error: string }

const MAX_PIXELS = 100_000_000
const PAD = 2

const ready = init({ module_or_path: wasmUrl })

async function trace({ file, settings }: TraceRequest) {
  await ready
  const bitmap = await createImageBitmap(file, {
    imageOrientation: 'from-image',
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'default',
  }).catch(() => {
    throw new Error('This file could not be decoded as an image.')
  })
  const { width, height } = bitmap
  if (width * height > MAX_PIXELS) {
    bitmap.close()
    throw new Error('This image is larger than the 100 megapixel limit.')
  }

  const scale = traceScale(width, height, settings.preset)
  const viewWidth = Math.max(1, Math.round(width * scale))
  const viewHeight = Math.max(1, Math.round(height * scale))
  const canvas = new OffscreenCanvas(viewWidth, viewHeight)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Canvas is not available in this browser.')
  context.imageSmoothingEnabled = settings.preset !== 'pixel'
  context.imageSmoothingQuality = 'high'
  context.drawImage(bitmap, 0, 0, viewWidth, viewHeight)
  bitmap.close()
  const { data } = context.getImageData(0, 0, viewWidth, viewHeight, { colorSpace: 'srgb' })

  const edgeWidth = Math.max(3, Math.ceil(3 * scale))
  const backgroundMissing =
    settings.removeBackground &&
    !removeBackground(data, viewWidth, viewHeight, {
      tolerance: settings.backgroundTolerance,
      enclosed: settings.removeEnclosed,
      fringeWidth: edgeWidth,
      flatten: settings.preset === 'logo' || settings.preset === 'illustration',
    })

  const plan = planAlpha(data, viewWidth, viewHeight, edgeWidth)
  // Opaque images skip the border: there is nothing to key out, and tracing to
  // the canvas edge keeps their corners fully covered.
  const pad = plan.transparent ? PAD : 0
  const config = toTracerConfig(settings)
  const layers = plan.layers.map(({ pixels, opacity }) => {
    const input = pad ? padTransparent(pixels, viewWidth, viewHeight, pad) : new Uint8Array(pixels.buffer)
    return { svg: to_svg(input, viewWidth + pad * 2, viewHeight + pad * 2, config), opacity }
  })
  // Once enlarged, a whole traced unit is already finer than a source pixel.
  const precision = scale >= 2 ? 0 : 1
  const svg = composeSvg(layers, { width, height, viewWidth, viewHeight, pad, precision })
  return { svg, width, height, backgroundMissing }
}

self.onmessage = async ({ data }: MessageEvent<TraceRequest>) => {
  const started = performance.now()
  let response: TraceResponse
  try {
    response = { id: data.id, ok: true, ...(await trace(data)), ms: performance.now() - started }
  } catch (error) {
    response = { id: data.id, ok: false, error: error instanceof Error ? error.message : 'The image could not be traced.' }
  }
  self.postMessage(response)
}
