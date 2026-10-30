import { describe, expect, it } from 'vitest'
import { detectBackground, removeBackground } from './background'

type Rgba = [number, number, number, number]

function bitmap(width: number, height: number, color: (x: number, y: number) => Rgba) {
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) pixels.set(color(x, y), (y * width + x) * 4)
  }
  return pixels
}

const WHITE: Rgba = [255, 255, 255, 255]
const RED: Rgba = [200, 0, 0, 255]
const alphaAt = (pixels: Uint8ClampedArray, width: number, x: number, y: number) => pixels[(y * width + x) * 4 + 3]

describe('removeBackground', () => {
  // A white image holding a red ring with a white centre.
  const ring = () =>
    bitmap(20, 20, (x, y) => {
      const edge = Math.max(Math.abs(x - 10), Math.abs(y - 10))
      return edge >= 4 && edge <= 7 ? RED : WHITE
    })

  it('clears enclosed background too when asked', () => {
    const pixels = ring()
    expect(removeBackground(pixels, 20, 20, { tolerance: 32, enclosed: true })).toBe(true)
    expect(alphaAt(pixels, 20, 0, 0)).toBe(0)
    expect(alphaAt(pixels, 20, 5, 10)).toBe(255)
    expect(alphaAt(pixels, 20, 10, 10)).toBe(0)
  })

  it('can keep matching colour enclosed by the subject', () => {
    const pixels = ring()
    expect(removeBackground(pixels, 20, 20, { tolerance: 32, enclosed: false })).toBe(true)
    expect(alphaAt(pixels, 20, 0, 0)).toBe(0)
    expect(alphaAt(pixels, 20, 10, 10)).toBe(255)
  })

  it('resolves soft edges to pure subject colour or clear', () => {
    const faint: Rgba = [241, 191, 191, 255]
    const strong: Rgba = [214, 64, 64, 255]
    const pixels = bitmap(20, 3, (x) => (x < 13 ? WHITE : x === 13 ? faint : x === 14 ? strong : RED))
    removeBackground(pixels, 20, 3, { tolerance: 32, enclosed: true })
    expect(alphaAt(pixels, 20, 13, 1)).toBe(0)
    expect(alphaAt(pixels, 20, 14, 1)).toBe(255)
    const i = (1 * 20 + 14) * 4
    expect(Array.from(pixels.subarray(i, i + 3))).toEqual([200, 0, 0])
  })

  describe('flatten', () => {
    const TEAL: Rgba = [56, 130, 159, 255]
    const PALE_TEAL: Rgba = [130, 180, 200, 255]
    const FAINT_TEAL: Rgba = [190, 215, 225, 255]
    const ORANGE: Rgba = [232, 84, 47, 255]
    const colorAt = (pixels: Uint8ClampedArray, x: number, y: number) =>
      Array.from(pixels.subarray((y * 40 + x) * 4, (y * 40 + x) * 4 + 3))

    // Columns of pale and solid teal, then orange, on a white image with a wide margin.
    const stripes = () =>
      bitmap(40, 40, (x, y) => {
        if (y < 8 || y >= 32 || x < 4 || x >= 36) return WHITE
        if (x < 14) return TEAL
        if (x >= 16 && x < 20) return PALE_TEAL
        if (x >= 23 && x < 25) return FAINT_TEAL
        if (x >= 26) return ORANGE
        return WHITE
      })

    it('snaps blends to the subject colour and keeps distinct colours', () => {
      const pixels = stripes()
      removeBackground(pixels, 40, 40, { tolerance: 32, enclosed: true, fringeWidth: 1, flatten: true })
      expect(colorAt(pixels, 18, 20)).toEqual(colorAt(pixels, 8, 20))
      expect(colorAt(pixels, 8, 20)).toEqual([56, 130, 159])
      expect(colorAt(pixels, 30, 20)).toEqual([232, 84, 47])
    })

    it('clears weak blends, which keeps small holes in text open', () => {
      const pixels = stripes()
      removeBackground(pixels, 40, 40, { tolerance: 32, enclosed: true, fringeWidth: 1, flatten: true })
      expect(alphaAt(pixels, 40, 23, 20)).toBe(0)
    })

    it('keeps weak blends when enclosed colour is being kept', () => {
      const pixels = stripes()
      removeBackground(pixels, 40, 40, { tolerance: 32, enclosed: false, fringeWidth: 1, flatten: true })
      expect(alphaAt(pixels, 40, 23, 20)).toBe(255)
    })

    it('leaves shades alone unless asked', () => {
      const pixels = stripes()
      removeBackground(pixels, 40, 40, { tolerance: 32, enclosed: true, fringeWidth: 1 })
      expect(colorAt(pixels, 18, 20)).toEqual([130, 180, 200])
    })
  })

  it('leaves the image alone when the border has no dominant colour', () => {
    const pixels = bitmap(20, 20, (x) => [x * 12, 255 - x * 12, x * 6, 255])
    const before = pixels.slice()
    expect(removeBackground(pixels, 20, 20, { tolerance: 8, enclosed: true })).toBe(false)
    expect(pixels).toEqual(before)
  })

  it('finds nothing to remove when the border is already transparent', () => {
    expect(detectBackground(bitmap(8, 8, () => [0, 0, 0, 0]), 8, 8, 32)).toBeUndefined()
  })
})
