import { describe, expect, it } from 'vitest'
import { hasSoftRegions, padTransparent, planAlpha } from './alpha'

function bitmap(width: number, height: number, alpha: (x: number, y: number) => number) {
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels.set([200, 10, 10, alpha(x, y)], (y * width + x) * 4)
    }
  }
  return pixels
}

describe('planAlpha', () => {
  it('passes opaque images through untouched', () => {
    const pixels = bitmap(8, 8, () => 255)
    const plan = planAlpha(pixels, 8, 8)
    expect(plan.transparent).toBe(false)
    expect(plan.layers).toEqual([{ pixels, opacity: 1 }])
  })

  it('produces no layers for a fully transparent image', () => {
    expect(planAlpha(bitmap(8, 8, () => 0), 8, 8)).toEqual({ transparent: true, layers: [] })
  })

  it('snaps an anti-aliased fringe to a single hard layer', () => {
    const pixels = bitmap(40, 40, (x) => (x < 20 ? 255 : x === 20 ? 200 : x === 21 ? 60 : 0))
    const plan = planAlpha(pixels, 40, 40)
    expect(plan.layers).toHaveLength(1)
    const out = plan.layers[0].pixels
    expect(out[(20 * 4) + 3]).toBe(255)
    expect(out[(21 * 4) + 3]).toBe(0)
  })

  it('layers soft regions so opacities accumulate to the source alpha', () => {
    const pixels = bitmap(64, 64, (x) => (x < 32 ? 128 : 255))
    expect(hasSoftRegions(pixels, 64, 64)).toBe(true)
    const { layers } = planAlpha(pixels, 64, 64)
    expect(layers).toHaveLength(4)
    const coverage = layers.reduce((covered, l) => covered + (1 - covered) * l.opacity, 0)
    expect(coverage).toBeCloseTo(1)
    const halfway = layers.slice(0, 2).reduce((covered, l) => covered + (1 - covered) * l.opacity, 0)
    expect(halfway).toBeCloseTo(0.5)
  })
})

describe('padTransparent', () => {
  it('centres the bitmap inside a clear border', () => {
    const out = padTransparent(bitmap(1, 1, () => 255), 1, 1, 1)
    expect(out).toHaveLength(36)
    expect(Array.from(out.subarray(16, 20))).toEqual([200, 10, 10, 255])
    expect(out[3]).toBe(0)
  })
})
