/** A stack of RGBA bitmaps that, composited bottom-up, reproduce the source alpha. */
export interface AlphaLayer {
  pixels: Uint8ClampedArray
  /** Group opacity, chosen so the layers accumulate to the target alpha. */
  opacity: number
}

export interface AlphaPlan {
  /** Whether the output needs any transparency at all. */
  transparent: boolean
  layers: AlphaLayer[]
}

const HARD_THRESHOLD = 128
const PARTIAL_MIN = 16
const PARTIAL_MAX = 239

// Pixels at or above each threshold belong to that layer. `reach` is the alpha
// accumulated once the layer is painted.
const SOFT_BANDS = [
  { threshold: 32, reach: 0.25 },
  { threshold: 96, reach: 0.5 },
  { threshold: 160, reach: 0.75 },
  { threshold: 224, reach: 1 },
]

const isPartial = (a: number) => a >= PARTIAL_MIN && a <= PARTIAL_MAX

/**
 * True when partial alpha forms real regions (shadows, glows) rather than the
 * one or two pixel anti-aliased fringe every cut-out has.
 */
export function hasSoftRegions(pixels: Uint8ClampedArray, width: number, height: number, edgeWidth = 2): boolean {
  const alphaAt = (x: number, y: number) => pixels[(y * width + x) * 4 + 3]
  const limit = Math.max(32, width * height * 0.001)
  let count = 0
  const r = edgeWidth
  for (let y = r; y < height - r; y++) {
    for (let x = r; x < width - r; x++) {
      if (
        isPartial(alphaAt(x, y)) &&
        isPartial(alphaAt(x - r, y)) &&
        isPartial(alphaAt(x + r, y)) &&
        isPartial(alphaAt(x, y - r)) &&
        isPartial(alphaAt(x, y + r)) &&
        ++count > limit
      ) {
        return true
      }
    }
  }
  return false
}

/** Keeps pixels with alpha >= threshold at full alpha and clears the rest. */
function binarize(source: Uint8ClampedArray, threshold: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(source)
  for (let i = 3; i < out.length; i += 4) out[i] = out[i] >= threshold ? 255 : 0
  return out
}

/** Paints pixels the opaque top layer will cover with one colour, so they trace to a single cheap shape. */
function flattenHidden(layer: Uint8ClampedArray, source: Uint8ClampedArray, hideFrom: number): void {
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let i = 0; i < layer.length; i += 4) {
    if (layer[i + 3] && source[i + 3] < hideFrom) {
      r += layer[i]
      g += layer[i + 1]
      b += layer[i + 2]
      n++
    }
  }
  if (!n) return
  for (let i = 0; i < layer.length; i += 4) {
    if (source[i + 3] >= hideFrom) {
      layer[i] = r / n
      layer[i + 1] = g / n
      layer[i + 2] = b / n
    }
  }
}

const hasVisible = (pixels: Uint8ClampedArray) => {
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) return true
  return false
}

/** `edgeWidth` is how wide an anti-aliased edge can be at this resolution, which grows when an image is enlarged. */
export function planAlpha(source: Uint8ClampedArray, width: number, height: number, edgeWidth = 2): AlphaPlan {
  let transparent = false
  for (let i = 3; i < source.length && !transparent; i += 4) transparent = source[i] < 250
  if (!transparent) return { transparent, layers: [{ pixels: source, opacity: 1 }] }

  if (!hasSoftRegions(source, width, height, edgeWidth)) {
    const pixels = binarize(source, HARD_THRESHOLD)
    return { transparent, layers: hasVisible(pixels) ? [{ pixels, opacity: 1 }] : [] }
  }

  const top = SOFT_BANDS[SOFT_BANDS.length - 1]
  const layers: AlphaLayer[] = []
  let reached = 0
  for (const band of SOFT_BANDS) {
    const opacity = 1 - (1 - band.reach) / (1 - reached)
    reached = band.reach
    const pixels = binarize(source, band.threshold)
    if (!hasVisible(pixels)) continue
    if (band !== top) flattenHidden(pixels, source, top.threshold)
    layers.push({ pixels, opacity })
  }
  return { transparent, layers }
}

/**
 * Surrounds the bitmap with a transparent border. VTracer only keys out
 * transparency when whole scanlines are clear, so without this it paints over
 * transparent areas that don't reach far enough across the image.
 */
export function padTransparent(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  pad: number,
): Uint8Array {
  const paddedWidth = width + pad * 2
  const out = new Uint8Array(paddedWidth * (height + pad * 2) * 4)
  for (let y = 0; y < height; y++) {
    const start = y * width * 4
    out.set(pixels.subarray(start, start + width * 4), ((y + pad) * paddedWidth + pad) * 4)
  }
  return out
}
