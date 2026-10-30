import { describe, expect, it } from 'vitest'
import { compactPath, compactPaths, composeSvg, shortenHex } from './svg'

const doc = (...paths: string[]) => `<?xml version="1.0"?><svg>${paths.join('\n')}</svg>`

describe('compactPath', () => {
  it('bakes the translation and writes relative commands', () => {
    expect(compactPath('M0 0 L10 0 L10 10 Z ', 5, 5)).toBe('M5 5l10 0 0 10z')
  })

  it('does not accumulate rounding error', () => {
    // Rounding each delta on its own would give .1 five times and end at .5, not .7.
    expect(compactPath('M0 0 L0.14 0 L0.28 0 L0.42 0 L0.56 0 L0.7 0', 0, 0)).toBe('M0 0l.1 0 .2 0 .1 0 .2 0 .1 0')
  })

  it('turns straight cubics into lines', () => {
    expect(compactPath('M0 0 C132 0 264 0 400 0 Z', 2, 2)).toBe('M2 2l400 0z')
  })

  it('writes curves with minimal separators', () => {
    expect(compactPath('M0 0 C0.5 -0.5 1 1 2 0 Z', 0, 0)).toBe('M0 0c.5-.5 1 1 2 0z')
  })

  it('restarts relative tracking after closing a subpath', () => {
    expect(compactPath('M1 1 L2 1 Z M3 3 L4 3 Z', 0, 0)).toBe('M1 1l1 0zM3 3l1 0z')
  })
})

describe('shortenHex', () => {
  it('uses the three digit form when lossless', () => {
    expect(shortenHex('#FF0000')).toBe('#f00')
    expect(shortenHex('#FF0001')).toBe('#ff0001')
  })
})

describe('compactPaths', () => {
  it('merges adjacent paths with the same fill only', () => {
    const svg = doc(
      '<path d="M0 0 L1 0 Z " fill="#FF0000" transform="translate(0,0)"/>',
      '<path d="M0 0 L1 0 Z " fill="#ff0000" transform="translate(2,2)"/>',
      '<path d="M0 0 L1 0 Z " fill="#00FF00" transform="translate(0,0)"/>',
    )
    expect(compactPaths(svg)).toBe('<path fill="#f00" d="M0 0l1 0zM2 2l1 0z"/><path fill="#0f0" d="M0 0l1 0z"/>')
  })
})

describe('composeSvg', () => {
  const svg = doc('<path d="M0 0 L1 0 Z " fill="#000000" transform="translate(0,0)"/>')
  const size = { width: 10, height: 20, viewWidth: 40, viewHeight: 80, pad: 2 }

  it('hides the padding with the viewBox and adds no background', () => {
    const out = composeSvg([{ svg, opacity: 1 }], size)
    expect(out).toContain('width="10" height="20" viewBox="2 2 40 80"')
    expect(out).not.toContain('<rect')
    expect(out).not.toContain('<?xml')
  })

  it('groups semi-transparent layers', () => {
    expect(composeSvg([{ svg, opacity: 1 / 3 }], size)).toContain('<g opacity=".333">')
  })
})
