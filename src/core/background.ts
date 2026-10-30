/** Below this alpha a pixel already counts as background. */
const CLEAR_ALPHA = 16
/** Share of the border that must match for a colour to count as the background. */
const MIN_BORDER_SHARE = 0.4
/** Edge pixels at least this close to the subject's colour stay fully opaque. */
const SOLID_COVERAGE = 0.95
/** Colours at least this share of the furthest distance from the background count as the subject. */
const SUBJECT_SHARE = 0.9
/** How far a colour may sit from a background-to-subject line and still count as a blend of the two. */
const BLEND_RESIDUAL = 32
/** Blends weaker than this are left alone: they are closer to deliberate pale detail than to the subject. */
const MIN_BLEND = 0.25
/** Allows for noise pushing a colour slightly past the subject it belongs to. */
const MAX_BLEND = 1.15
/** Share of the visible pixels a colour needs to count as one of the subject's own. */
const MIN_COLOR_SHARE = 0.005

const distance = (p: Uint8ClampedArray, i: number, bg: number[]) =>
  Math.hypot(p[i] - bg[0], p[i + 1] - bg[1], p[i + 2] - bg[2])

function borderOffsets(width: number, height: number): number[] {
  const offsets: number[] = []
  for (let x = 0; x < width; x++) {
    offsets.push(x)
    if (height > 1) offsets.push((height - 1) * width + x)
  }
  for (let y = 1; y < height - 1; y++) {
    offsets.push(y * width)
    if (width > 1) offsets.push(y * width + width - 1)
  }
  return offsets
}

/** Per-channel median of the visible border, or undefined when the border has no dominant colour. */
export function detectBackground(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  tolerance: number,
): number[] | undefined {
  const border = borderOffsets(width, height)
  const visible = border.filter((offset) => pixels[offset * 4 + 3] >= CLEAR_ALPHA)
  if (visible.length < border.length * MIN_BORDER_SHARE) return undefined
  const median = [0, 1, 2].map((channel) => {
    const values = visible.map((offset) => pixels[offset * 4 + channel]).sort((a, b) => a - b)
    return values[values.length >> 1]
  })
  const matching = visible.filter((offset) => distance(pixels, offset * 4, median) <= tolerance).length
  return matching >= visible.length * MIN_BORDER_SHARE ? median : undefined
}

/**
 * The colour this edge pixel blends into: the average of the colours within
 * `radius` furthest from the background. Averaging keeps compression noise out of the result.
 */
function nearbySubjectColor(
  pixels: Uint8ClampedArray,
  offset: number,
  width: number,
  height: number,
  background: number[],
  radius: number,
): number[] {
  const cx = offset % width
  const cy = (offset - cx) / width
  const top = Math.max(0, cy - radius)
  const bottom = Math.min(height - 1, cy + radius)
  const left = Math.max(0, cx - radius)
  const right = Math.min(width - 1, cx + radius)
  // Wide windows are sampled sparsely: nearby pixels hold almost the same colour.
  const step = Math.max(1, radius >> 2)
  let furthest = 0
  for (let y = top; y <= bottom; y += step) {
    for (let x = left; x <= right; x += step) {
      const i = (y * width + x) * 4
      if (pixels[i + 3] >= CLEAR_ALPHA) furthest = Math.max(furthest, distance(pixels, i, background))
    }
  }
  const sum = [0, 0, 0]
  let count = 0
  for (let y = top; y <= bottom; y += step) {
    for (let x = left; x <= right; x += step) {
      const i = (y * width + x) * 4
      if (pixels[i + 3] >= CLEAR_ALPHA && distance(pixels, i, background) >= furthest * SUBJECT_SHARE) {
        for (let c = 0; c < 3; c++) sum[c] += pixels[i + c]
        count++
      }
    }
  }
  if (!count) return [pixels[offset * 4], pixels[offset * 4 + 1], pixels[offset * 4 + 2]]
  return sum.map((value) => Math.round(value / count))
}

/** How far a pixel sits along the line from background (0) to subject (1). */
function coverageBetween(pixels: Uint8ClampedArray, i: number, background: number[], subject: number[]): number {
  let along = 0
  let lengthSquared = 0
  for (let c = 0; c < 3; c++) {
    const span = subject[c] - background[c]
    along += (pixels[i + c] - background[c]) * span
    lengthSquared += span * span
  }
  return lengthSquared ? Math.min(1, Math.max(0, along / lengthSquared)) : 1
}

/** Where a colour falls on the line from background (0) to subject (1), and how far off that line it is. */
function blendPosition(r: number, g: number, b: number, background: number[], subject: number[]) {
  const span = [subject[0] - background[0], subject[1] - background[1], subject[2] - background[2]]
  const offset = [r - background[0], g - background[1], b - background[2]]
  const lengthSquared = span[0] ** 2 + span[1] ** 2 + span[2] ** 2
  if (!lengthSquared) return { position: 0, residual: Infinity }
  const position = (offset[0] * span[0] + offset[1] * span[1] + offset[2] * span[2]) / lengthSquared
  const residual = Math.hypot(
    offset[0] - position * span[0],
    offset[1] - position * span[1],
    offset[2] - position * span[2],
  )
  return { position, residual }
}

/** The subject's own colours: common ones that aren't just a blend of the background and a stronger colour. */
function subjectPalette(pixels: Uint8ClampedArray, background: number[], tolerance: number): number[][] {
  const bins = new Map<number, number[]>()
  let total = 0
  for (let i = 0; i < pixels.length; i += 4) {
    if (!pixels[i + 3]) continue
    const key = ((pixels[i] >> 4) << 8) | ((pixels[i + 1] >> 4) << 4) | (pixels[i + 2] >> 4)
    let bin = bins.get(key)
    if (!bin) bins.set(key, (bin = [0, 0, 0, 0]))
    bin[0] += pixels[i]
    bin[1] += pixels[i + 1]
    bin[2] += pixels[i + 2]
    bin[3]++
    total++
  }
  const candidates = [...bins.values()]
    .filter((bin) => bin[3] >= total * MIN_COLOR_SHARE)
    .map(([r, g, b, n]) => [r / n, g / n, b / n])
    .map((color) => ({ color, strength: Math.hypot(color[0] - background[0], color[1] - background[1], color[2] - background[2]) }))
    .filter(({ strength }) => strength > tolerance)
    .sort((a, b) => b.strength - a.strength)
  const palette: number[][] = []
  for (const { color } of candidates) {
    const isBlend = palette.some((subject) => {
      const { position, residual } = blendPosition(color[0], color[1], color[2], background, subject)
      return residual <= BLEND_RESIDUAL && position <= MAX_BLEND
    })
    if (!isBlend) palette.push(color)
  }
  return palette
}

/**
 * Resolves blends of background and subject colour. Thin strokes in a soft image
 * never reach their true colour, and tracing would otherwise turn each shade into
 * its own shape. Past the halfway point, where a blurred edge really lies, a blend
 * becomes the pure subject colour. Below it, the blend is background: clearing it
 * keeps the small holes in text open. With `clearWeak` off it is left as it is.
 */
function flattenBlends(
  pixels: Uint8ClampedArray,
  background: number[],
  tolerance: number,
  clearWeak: boolean,
): void {
  const palette = subjectPalette(pixels, background, tolerance)
  for (let i = 0; i < pixels.length; i += 4) {
    if (!pixels[i + 3]) continue
    let closest: number[] | undefined
    let closestPosition = 0
    let lowest = BLEND_RESIDUAL
    for (const subject of palette) {
      const { position, residual } = blendPosition(pixels[i], pixels[i + 1], pixels[i + 2], background, subject)
      if (position >= MIN_BLEND && position <= MAX_BLEND && residual <= lowest) {
        lowest = residual
        closest = subject
        closestPosition = position
      }
    }
    if (!closest) continue
    if (closestPosition >= 0.5) pixels.set(closest, i)
    else if (clearWeak) pixels[i + 3] = 0
  }
}

export interface RemovalOptions {
  tolerance: number
  /** Also clear matching colour enclosed by the subject, such as the inside of an "O". */
  enclosed: boolean
  /** Widest soft edge to clean up, in pixels. */
  fringeWidth?: number
  /** Snap blends to solid subject colours. Suits flat artwork, not continuous tone. */
  flatten?: boolean
}

/** Clears the background, in place. Returns whether a background was found. */
export function removeBackground(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  { tolerance, enclosed, fringeWidth = 2, flatten = false }: RemovalOptions,
): boolean {
  const background = detectBackground(pixels, width, height, tolerance)
  if (!background) return false

  const isBackground = (offset: number) =>
    pixels[offset * 4 + 3] < CLEAR_ALPHA || distance(pixels, offset * 4, background) <= tolerance
  const removed = new Uint8Array(width * height)
  const stack: number[] = []
  const visit = (offset: number) => {
    if (!removed[offset] && isBackground(offset)) {
      removed[offset] = 1
      stack.push(offset)
    }
  }
  const forNeighbours = (offset: number, callback: (neighbour: number) => void) => {
    const x = offset % width
    if (x > 0) callback(offset - 1)
    if (x < width - 1) callback(offset + 1)
    if (offset >= width) callback(offset - width)
    if (offset < width * (height - 1)) callback(offset + width)
  }

  if (enclosed) for (let offset = 0; offset < removed.length; offset++) visit(offset)
  else borderOffsets(width, height).forEach(visit)
  while (stack.length) forNeighbours(stack.pop()!, visit)

  // Soft edge pixels still contain background colour. Each one becomes either
  // pure subject colour or clear, otherwise the shape keeps a halo of the old background.
  const reach = fringeWidth * 2
  const source = pixels.slice()
  const seen = removed.slice()
  let ring: number[] = []
  for (let offset = 0; offset < removed.length; offset++) if (removed[offset]) ring.push(offset)
  for (let pass = 0; pass < reach; pass++) {
    const next: number[] = []
    for (const offset of ring) {
      forNeighbours(offset, (neighbour) => {
        if (seen[neighbour]) return
        seen[neighbour] = 1
        const i = neighbour * 4
        const subject = nearbySubjectColor(source, neighbour, width, height, background, reach)
        const coverage = coverageBetween(source, i, background, subject)
        if (coverage >= SOLID_COVERAGE) return
        pixels.set(subject, i)
        pixels[i + 3] = coverage >= 0.5 ? source[i + 3] : 0
        next.push(neighbour)
      })
    }
    ring = next
  }

  for (let offset = 0; offset < removed.length; offset++) if (removed[offset]) pixels[offset * 4 + 3] = 0
  if (flatten) flattenBlends(pixels, background, tolerance, enclosed)
  return true
}
