export interface TracedLayer {
  /** Raw VTracer document. */
  svg: string
  opacity: number
}

export interface ComposeOptions {
  /** Intrinsic size written to the output. */
  width: number
  height: number
  /** Coordinate system of the traced paths. */
  viewWidth: number
  viewHeight: number
  /** Transparent border added before tracing, hidden again through the viewBox. */
  pad: number
  /** Decimal places kept in path data. */
  precision?: number
}

const PATH = /<path d="([^"]*)" fill="([^"]*)" transform="translate\(([^,]+),([^)]+)\)"\s*\/>/g
const TOKEN = /[MLCZ]|-?\d*\.?\d+(?:e-?\d+)?/g

/** Deviation from a straight line, in traced pixels, that is too small to see. */
const STRAIGHT_TOLERANCE = 0.25

const number = (n: number) => String(n).replace(/^(-?)0\./, '$1.')

/** Joins numbers with the fewest separators SVG allows. */
function joinNumbers(values: number[]): string {
  let out = ''
  for (const value of values) {
    const text = number(value)
    out += out && !text.startsWith('-') ? ' ' + text : text
  }
  return out
}

/** True when a cubic's control points sit on its chord, within `tolerance`, so a line draws the same thing. */
function isStraight(c: number[], x: number, y: number, tolerance: number): boolean {
  const chordX = c[4] - x
  const chordY = c[5] - y
  const lengthSquared = chordX * chordX + chordY * chordY
  if (!lengthSquared) return false
  for (let i = 0; i < 4; i += 2) {
    const px = c[i] - x
    const py = c[i + 1] - y
    const along = px * chordX + py * chordY
    if (along < 0 || along > lengthSquared) return false
    if (Math.abs(px * chordY - py * chordX) > tolerance * Math.sqrt(lengthSquared)) return false
  }
  return true
}

/** Bakes a translation into the path and rewrites it with rounded relative coordinates. */
export function compactPath(d: string, dx: number, dy: number, precision = 1): string {
  const scale = 10 ** precision
  const tokens = d.match(TOKEN) ?? []
  // Coordinates are tracked as rounded integers so rounding errors can't accumulate.
  const snap = (index: number, offset: number) => Math.round((Number(tokens[index]) + offset) * scale)
  let out = ''
  let x = 0
  let y = 0
  let startX = 0
  let startY = 0
  let previous = ''
  let i = 0
  while (i < tokens.length) {
    const command = tokens[i++]
    if (command === 'Z') {
      out += 'z'
      x = startX
      y = startY
      previous = 'z'
    } else if (command === 'M') {
      x = startX = snap(i, dx)
      y = startY = snap(i + 1, dy)
      i += 2
      out += 'M' + joinNumbers([x / scale, y / scale])
      previous = 'M'
    } else if (command === 'L' || command === 'C') {
      const pairs = command === 'L' ? 1 : 3
      const points: number[] = []
      for (let p = 0; p < pairs; p++, i += 2) points.push(snap(i, dx), snap(i + 1, dy))
      const straight = pairs === 3 && isStraight(points, x, y, STRAIGHT_TOLERANCE * scale)
      const used = straight ? points.slice(4) : points
      const values = used.map((value, index) => (value - (index % 2 ? y : x)) / scale)
      x = points[points.length - 2]
      y = points[points.length - 1]
      const letter = pairs === 1 || straight ? 'l' : 'c'
      const body = joinNumbers(values)
      // A repeated command letter is implied. Not after `M`: that would imply an absolute `L`.
      out += previous === letter ? (body.startsWith('-') ? body : ' ' + body) : letter + body
      previous = letter
    } else {
      throw new Error(`Unexpected path token: ${command}`)
    }
  }
  return out
}

export function shortenHex(color: string): string {
  const hex = color.toLowerCase()
  return /^#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3$/.test(hex) ? `#${hex[1]}${hex[3]}${hex[5]}` : hex
}

/** Converts a VTracer document to minimal path markup, merging neighbours that share a fill. */
export function compactPaths(svg: string, precision = 1): string {
  let out = ''
  let currentFill = ''
  let currentD = ''
  const flush = () => {
    if (currentD) out += `<path fill="${currentFill}" d="${currentD}"/>`
  }
  for (const [, d, fill, dx, dy] of svg.matchAll(PATH)) {
    const color = shortenHex(fill)
    const path = compactPath(d, Number(dx), Number(dy), precision)
    if (color === currentFill) {
      currentD += path
    } else {
      flush()
      currentFill = color
      currentD = path
    }
  }
  flush()
  return out
}

export function composeSvg(layers: TracedLayer[], options: ComposeOptions): string {
  const { width, height, viewWidth, viewHeight, pad, precision = 1 } = options
  const body = layers
    .map(({ svg, opacity }) => {
      const paths = compactPaths(svg, precision)
      return opacity >= 1 ? paths : `<g opacity="${number(Number(opacity.toFixed(3)))}">${paths}</g>`
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${pad} ${pad} ${viewWidth} ${viewHeight}">${body}</svg>`
}
