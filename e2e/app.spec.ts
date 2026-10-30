import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

type Shape = 'badge' | 'notch' | 'opaque' | 'shadow' | 'onWhite' | 'busy' | 'blurryLogo'

/** Draws a test image in the page and returns it as PNG bytes. */
async function makePng(page: Page, shape: Shape): Promise<Buffer> {
  const base64 = await page.evaluate((kind) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = kind === 'blurryLogo' ? 150 : 400
    const c = canvas.getContext('2d')!
    if (kind === 'blurryLogo') {
      // A small, soft JPEG on off-white: letter counters and wide blurred edges.
      c.fillStyle = '#f4f6fa'
      c.fillRect(0, 0, 150, 150)
      c.filter = 'blur(1.5px)'
      c.strokeStyle = '#38829f'
      c.lineWidth = 18
      c.beginPath(); c.arc(75, 60, 35, 0, 7); c.stroke()
      c.fillStyle = '#38829f'
      c.font = 'bold 26px sans-serif'
      c.fillText('2008', 45, 130)
      return canvas.toDataURL('image/jpeg', 0.7).split(',')[1]
    }
    if (kind === 'badge') {
      c.fillStyle = '#d02020'
      c.beginPath(); c.arc(200, 200, 150, 0, 7); c.fill()
      c.fillStyle = '#ffffff'
      c.fillRect(120, 180, 160, 40)
    } else if (kind === 'notch') {
      c.fillStyle = '#2060e0'
      c.fillRect(0, 0, 400, 400)
      c.clearRect(180, 180, 40, 40)
    } else if (kind === 'onWhite') {
      c.fillStyle = '#ffffff'
      c.fillRect(0, 0, 400, 400)
      c.fillStyle = '#d02020'
      c.beginPath(); c.arc(200, 200, 150, 0, 7); c.fill()
      c.fillStyle = '#ffffff'
      c.fillRect(120, 180, 160, 40)
    } else if (kind === 'busy') {
      for (let x = 0; x < 400; x += 20) {
        c.fillStyle = `hsl(${x}, 80%, 50%)`
        c.fillRect(x, 0, 20, 400)
      }
    } else if (kind === 'opaque') {
      c.fillStyle = '#208040'
      c.fillRect(0, 0, 400, 400)
    } else {
      const glow = c.createRadialGradient(200, 200, 40, 200, 200, 180)
      glow.addColorStop(0, 'rgba(0,0,0,0.9)')
      glow.addColorStop(1, 'rgba(0,0,0,0)')
      c.fillStyle = glow
      c.fillRect(0, 0, 400, 400)
      c.fillStyle = '#e0a000'
      c.fillRect(150, 150, 100, 100)
    }
    return canvas.toDataURL('image/png').split(',')[1]
  }, shape)
  return Buffer.from(base64, 'base64')
}

/** Rasterises the produced SVG and samples RGBA at the given points. */
async function sample(page: Page, svg: string, points: [number, number][]) {
  return page.evaluate(
    async ({ svg, points }) => {
      const image = new Image()
      image.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 400
      const c = canvas.getContext('2d', { willReadFrequently: true })!
      c.drawImage(image, 0, 0, 400, 400)
      return points.map(([x, y]) => Array.from(c.getImageData(x, y, 1, 1).data))
    },
    { svg, points },
  )
}

async function convert(page: Page, shape: Shape): Promise<string> {
  await page.goto('/')
  const buffer = await makePng(page, shape)
  await page.locator('#file').setInputFiles({ name: `${shape}.png`, mimeType: 'image/png', buffer })
  const link = page.locator('.result a.download:not([aria-disabled])')
  await expect(link).toBeVisible()
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()])
  return readFile(await download.path(), 'utf8')
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw error
  })
})

test('keeps a transparent background without adding a backdrop', async ({ page }) => {
  const svg = await convert(page, 'badge')
  expect(svg).not.toContain('<rect')
  const [corner, red, white] = await sample(page, svg, [[5, 5], [200, 100], [200, 200]])
  expect(corner[3]).toBe(0)
  expect(red[3]).toBe(255)
  expect(red[0]).toBeGreaterThan(190)
  // Resampling before tracing can shift a flat colour by a level or two.
  for (const channel of white.slice(0, 3)) expect(channel).toBeGreaterThan(250)
})

test('keeps a small interior hole that VTracer would otherwise fill', async ({ page }) => {
  const svg = await convert(page, 'notch')
  const [hole, body] = await sample(page, svg, [[200, 200], [50, 50]])
  expect(hole[3]).toBe(0)
  expect(body[3]).toBe(255)
})

test('leaves opaque images fully covered to the corners', async ({ page }) => {
  const svg = await convert(page, 'opaque')
  for (const pixel of await sample(page, svg, [[0, 0], [399, 0], [0, 399], [399, 399]])) {
    expect(pixel[3]).toBe(255)
  }
})

test('reproduces soft shadows as graded transparency', async ({ page }) => {
  const svg = await convert(page, 'shadow')
  expect(svg).toContain('<g opacity=')
  const [core, near, far, outside] = await sample(page, svg, [[200, 200], [200, 120], [200, 60], [3, 3]])
  expect(core[3]).toBe(255)
  expect(near[3]).toBeGreaterThan(far[3])
  expect(far[3]).toBeGreaterThan(0)
  expect(outside[3]).toBe(0)
})

test('reports a corrupt file and keeps working', async ({ page }) => {
  await page.goto('/')
  await page.locator('#file').setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('nope') })
  await expect(page.locator('.stats.failed')).toContainText('could not be decoded')
  const buffer = await makePng(page, 'badge')
  await page.locator('#file').setInputFiles({ name: 'good.png', mimeType: 'image/png', buffer })
  await expect(page.locator('.result a.download:not([aria-disabled])')).toBeVisible()
})

test('re-traces when the preset changes and runs under the CSP', async ({ page }) => {
  const violations: string[] = []
  page.on('console', (message) => {
    if (/Content Security Policy/i.test(message.text())) violations.push(message.text())
  })
  await convert(page, 'badge')
  await page.getByText('Pixel art', { exact: true }).click()
  await expect(page.locator('.stats')).toContainText('→', { timeout: 30_000 })
  expect(violations).toEqual([])
})

test('downloads several results as a zip, keeping duplicate names apart', async ({ page }) => {
  await page.goto('/')
  const buffer = await makePng(page, 'badge')
  const file = { name: 'same.png', mimeType: 'image/png', buffer }
  await page.locator('#file').setInputFiles([file, file])
  await expect(page.locator('a.download:not([aria-disabled])')).toHaveCount(2)
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download-all').click()])
  const zip = await readFile(await download.path())
  expect(zip.subarray(0, 2).toString()).toBe('PK')
  expect(zip.includes('same.svg')).toBe(true)
  expect(zip.includes('same-2.svg')).toBe(true)
})

async function convertWithoutBackground(page: Page, shape: Shape): Promise<string> {
  await page.goto('/')
  const buffer = await makePng(page, shape)
  await page.locator('#file').setInputFiles({ name: `${shape}.png`, mimeType: 'image/png', buffer })
  await page.getByLabel('Remove background').check()
  const link = page.locator('.result a.download:not([aria-disabled])')
  await expect(link).toBeVisible()
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()])
  return readFile(await download.path(), 'utf8')
}

test('keeps the background unless asked to remove it', async ({ page }) => {
  const svg = await convert(page, 'onWhite')
  const [corner] = await sample(page, svg, [[5, 5]])
  expect(corner[3]).toBe(255)
})

test('removes the background without a halo, keeping enclosed white on request', async ({ page }) => {
  await convertWithoutBackground(page, 'onWhite')
  await page.getByLabel('Also inside shapes').uncheck()
  const link = page.locator('.result a.download:not([aria-disabled])')
  await expect(link).toBeVisible()
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()])
  const svg = await readFile(await download.path(), 'utf8')
  const [corner, red, bar] = await sample(page, svg, [[5, 5], [200, 100], [200, 200]])
  expect(corner[3]).toBe(0)
  expect(red[3]).toBe(255)
  expect(bar[3]).toBe(255)
  expect(bar[1]).toBeGreaterThan(250)
  // Any opaque pixel around the rim must be the shape's red, not a pink fringe.
  const rim: [number, number][] = []
  for (let degrees = 0; degrees < 360; degrees += 5) {
    const angle = (degrees * Math.PI) / 180
    for (const radius of [146, 148, 150, 152]) {
      rim.push([Math.round(200 + radius * Math.cos(angle)), Math.round(200 + radius * Math.sin(angle))])
    }
  }
  for (const pixel of await sample(page, svg, rim)) {
    if (pixel[3] === 255) expect(pixel[1]).toBeLessThan(90)
  }
})

test('says so when there is no background to remove', async ({ page }) => {
  const svg = await convertWithoutBackground(page, 'busy')
  await expect(page.locator('.stats')).toContainText('nothing was removed')
  const [corner] = await sample(page, svg, [[0, 0]])
  expect(corner[3]).toBe(255)
})

test('keeps the option when the preset changes', async ({ page }) => {
  await convertWithoutBackground(page, 'onWhite')
  await page.getByText('Logo', { exact: true }).click()
  await expect(page.getByLabel('Remove background')).toBeChecked()
})

test('does not mistake an enlarged anti-aliased edge for a soft shadow', async ({ page }) => {
  await page.goto('/')
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 100
    const c = canvas.getContext('2d')!
    c.fillStyle = '#d02020'
    c.beginPath(); c.arc(50, 50, 40, 0, 7); c.fill()
    return canvas.toDataURL('image/png').split(',')[1]
  })
  await page.locator('#file').setInputFiles({ name: 'small.png', mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') })
  const link = page.locator('.result a.download:not([aria-disabled])')
  await expect(link).toBeVisible()
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()])
  expect(await readFile(await download.path(), 'utf8')).not.toContain('<g opacity')
})

test('clears letter counters and soft edges from a blurry JPEG logo', async ({ page }) => {
  const svg = await convertWithoutBackground(page, 'blurryLogo')
  const [counter, stroke] = await sample(page, svg, [[200, 160], [200, 67]])
  expect(counter[3]).toBe(0)
  expect(stroke[3]).toBe(255)

  const grid: [number, number][] = []
  for (let y = 0; y < 400; y += 2) for (let x = 0; x < 400; x += 2) grid.push([x, y])
  const opaque = (await sample(page, svg, grid)).filter((pixel) => pixel[3] === 255)
  // Red is the channel furthest apart in these two colours, so it shows any pale leftovers.
  const pale = opaque.filter((pixel) => pixel[0] > 150)
  expect(opaque.length).toBeGreaterThan(1000)
  expect(pale.length / opaque.length).toBeLessThan(0.01)

  // The thin digits must come out in the same solid colour as the thick ring.
  const [ringColor] = await sample(page, svg, [[200, 67]])
  const digits = (await sample(page, svg, grid.filter(([, y]) => y >= 290))).filter((pixel) => pixel[3] === 255)
  expect(digits.length).toBeGreaterThan(100)
  const off = digits.filter((pixel) => Math.hypot(pixel[0] - ringColor[0], pixel[1] - ringColor[1], pixel[2] - ringColor[2]) > 24)
  expect(off.length / digits.length).toBeLessThan(0.02)
})
