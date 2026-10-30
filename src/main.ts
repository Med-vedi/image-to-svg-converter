import { PRESETS, type PresetId, type Settings } from './core/settings'
import type { TraceRequest, TraceResponse } from './worker'

interface Item {
  id: number
  file: File
  element: HTMLLIElement
  originalUrl: string
  svgUrl?: string
  svg?: string
  state: 'queued' | 'running' | 'done' | 'failed'
}

const MAX_FILE_BYTES = 50 * 1024 * 1024
const TRACE_TIMEOUT_MS = 120_000
const RETRACE_DELAY_MS = 250

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const drop = byId<HTMLLabelElement>('drop')
const fileInput = byId<HTMLInputElement>('file')
const form = byId<HTMLFormElement>('settings')
const statusLine = byId<HTMLParagraphElement>('status')
const results = byId<HTMLUListElement>('results')
const template = byId<HTMLTemplateElement>('result-template')
const downloadAll = byId<HTMLButtonElement>('download-all')

const items: Item[] = []
let settings: Settings = { ...PRESETS.illustration, removeBackground: false, removeEnclosed: true, backgroundTolerance: 32 }
let nextId = 1
let worker: Worker | undefined
let active: { item: Item; timer: number } | undefined
let retraceTimer: number | undefined

const part = <T extends Element>(item: Item, selector: string) => item.element.querySelector(selector) as T

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const svgName = (file: File) => `${file.name.replace(/\.[^.]+$/, '') || 'image'}.svg`

function setStatus(message: string): void {
  statusLine.textContent = message
}

function refreshSummary(): void {
  const done = items.filter((item) => item.state === 'done').length
  const pending = items.filter((item) => item.state === 'queued' || item.state === 'running').length
  form.hidden = items.length === 0
  downloadAll.hidden = done < 2
  if (pending) setStatus(`Tracing ${done + 1} of ${done + pending}…`)
  else if (items.length) setStatus(`${done} of ${items.length} converted.`)
  else setStatus('')
}

function getWorker(): Worker {
  worker ??= new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = ({ data }: MessageEvent<TraceResponse>) => finish(data)
  worker.onerror = () => {
    if (active) finish({ id: active.item.id, ok: false, error: 'The image could not be traced.' })
  }
  return worker
}

/** Tracing can't be interrupted from inside, so abandoning a job means replacing the worker. */
function stopWorker(): void {
  worker?.terminate()
  worker = undefined
  if (active) clearTimeout(active.timer)
  active = undefined
}

function pump(): void {
  if (active) return
  const item = items.find((candidate) => candidate.state === 'queued')
  if (!item) return refreshSummary()
  item.state = 'running'
  const timer = window.setTimeout(() => {
    finish({ id: item.id, ok: false, error: 'Tracing took too long. Try the Logo type or fewer colors.' })
  }, TRACE_TIMEOUT_MS)
  active = { item, timer }
  const request: TraceRequest = { id: item.id, file: item.file, settings }
  getWorker().postMessage(request)
  refreshSummary()
}

function finish(response: TraceResponse): void {
  if (!active || active.item.id !== response.id) return
  const { item } = active
  clearTimeout(active.timer)
  active = undefined
  if (response.ok) {
    showResult(item, response.svg, response.ms, response.backgroundMissing)
  } else {
    // A panic leaves the WASM instance unusable, so failures always get a fresh worker.
    stopWorker()
    showFailure(item, response.error)
  }
  pump()
}

function showResult(item: Item, svg: string, ms: number, backgroundMissing: boolean): void {
  if (item.svgUrl) URL.revokeObjectURL(item.svgUrl)
  const blob = new Blob([svg], { type: 'image/svg+xml' })
  item.svg = svg
  item.svgUrl = URL.createObjectURL(blob)
  item.state = 'done'

  const vector = part<HTMLImageElement>(item, '.vector')
  vector.src = item.svgUrl
  vector.alt = `SVG result for ${item.file.name}`
  vector.hidden = false
  part(item, '.busy').setAttribute('hidden', '')

  const download = part<HTMLAnchorElement>(item, '.download')
  download.href = item.svgUrl
  download.download = svgName(item.file)
  download.removeAttribute('aria-disabled')
  part<HTMLButtonElement>(item, '.copy').disabled = false

  const stats = part<HTMLParagraphElement>(item, '.stats')
  stats.classList.remove('failed')
  const change = blob.size / item.file.size
  const comparison = change < 1 ? `${Math.round((1 - change) * 100)}% smaller` : `${change.toFixed(1)}× the original size`
  stats.textContent = `${formatBytes(item.file.size)} → ${formatBytes(blob.size)} (${comparison}) in ${(ms / 1000).toFixed(1)} s`
  if (backgroundMissing) stats.textContent += '. No single background color found, so nothing was removed.'
}

function showFailure(item: Item, message: string): void {
  item.state = 'failed'
  part<HTMLImageElement>(item, '.vector').hidden = true
  const busy = part(item, '.busy')
  busy.removeAttribute('hidden')
  busy.textContent = 'Failed'
  const stats = part(item, '.stats')
  stats.classList.add('failed')
  stats.textContent = message
  part<HTMLButtonElement>(item, '.copy').disabled = true
  part(item, '.download').setAttribute('aria-disabled', 'true')
}

function markBusy(item: Item): void {
  item.state = 'queued'
  const busy = part(item, '.busy')
  busy.textContent = 'Tracing…'
  busy.removeAttribute('hidden')
  part<HTMLImageElement>(item, '.vector').hidden = true
  part<HTMLButtonElement>(item, '.copy').disabled = true
  part(item, '.download').setAttribute('aria-disabled', 'true')
  part(item, '.stats').textContent = ''
}

function addFiles(files: Iterable<File>): void {
  const rejected: string[] = []
  for (const file of files) {
    if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') {
      rejected.push(`${file.name} is not a supported image`)
    } else if (file.size > MAX_FILE_BYTES) {
      rejected.push(`${file.name} is over the 50 MB limit`)
    } else {
      addItem(file)
    }
  }
  pump()
  refreshSummary()
  if (rejected.length) setStatus(`${rejected.join('. ')}.`)
}

function addItem(file: File): void {
  const element = (template.content.firstElementChild as HTMLLIElement).cloneNode(true) as HTMLLIElement
  const item: Item = {
    id: nextId++,
    file,
    element,
    originalUrl: URL.createObjectURL(file),
    state: 'queued',
  }
  part(item, '.name').textContent = file.name
  const original = part<HTMLImageElement>(item, '.original')
  original.src = item.originalUrl
  original.alt = `Original ${file.name}`
  part(item, '.remove').addEventListener('click', () => removeItem(item))
  part(item, '.copy').addEventListener('click', () => copySvg(item))
  items.push(item)
  results.append(element)
}

function removeItem(item: Item): void {
  if (active?.item === item) stopWorker()
  items.splice(items.indexOf(item), 1)
  item.element.remove()
  URL.revokeObjectURL(item.originalUrl)
  if (item.svgUrl) URL.revokeObjectURL(item.svgUrl)
  pump()
  refreshSummary()
}

async function copySvg(item: Item): Promise<void> {
  if (!item.svg) return
  try {
    await navigator.clipboard.writeText(item.svg)
    setStatus(`Copied ${svgName(item.file)} to the clipboard.`)
  } catch {
    setStatus('The browser blocked clipboard access. Use Download instead.')
  }
}

async function downloadZip(): Promise<void> {
  const { zipSync, strToU8 } = await import('fflate')
  const entries: Record<string, Uint8Array> = {}
  for (const item of items) {
    if (!item.svg) continue
    const base = svgName(item.file)
    let name = base
    for (let n = 2; name in entries; n++) name = base.replace(/\.svg$/, `-${n}.svg`)
    entries[name] = strToU8(item.svg)
  }
  const bytes = zipSync(entries, { level: 6 })
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/zip' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'svg-images.zip'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

function syncControls(): void {
  for (const key of ['colors', 'speckle', 'corners', 'backgroundTolerance'] as const) {
    byId<HTMLInputElement>(key).value = String(settings[key])
  }
  byId('colors-out').textContent = `${settings.colors} bit`
  byId('speckle-out').textContent = `${settings.speckle} px`
  byId('corners-out').textContent = `${settings.corners}°`
  byId('backgroundTolerance-out').textContent = String(settings.backgroundTolerance)
  byId<HTMLInputElement>('backgroundTolerance').disabled = !settings.removeBackground
  byId<HTMLInputElement>('remove-enclosed').disabled = !settings.removeBackground
  for (const item of items) {
    part(item, '.original').classList.toggle('pixelated', settings.preset === 'pixel')
  }
}

function retraceAll(): void {
  // Results go stale immediately, so they can't be downloaded while the delay runs.
  stopWorker()
  items.forEach(markBusy)
  refreshSummary()
  clearTimeout(retraceTimer)
  retraceTimer = window.setTimeout(pump, RETRACE_DELAY_MS)
}

form.addEventListener('input', (event) => {
  const target = event.target as HTMLInputElement
  if (target.name === 'preset') {
    settings = { ...settings, ...PRESETS[target.value as PresetId] }
  } else if (target.type === 'checkbox') {
    settings = { ...settings, [target.name]: target.checked }
  } else {
    settings = { ...settings, [target.name]: Number(target.value) }
  }
  syncControls()
  retraceAll()
})
form.addEventListener('submit', (event) => event.preventDefault())
downloadAll.addEventListener('click', downloadZip)

fileInput.addEventListener('change', () => {
  addFiles(fileInput.files ?? [])
  fileInput.value = ''
})

for (const name of ['dragenter', 'dragover'] as const) {
  window.addEventListener(name, (event) => {
    event.preventDefault()
    drop.classList.add('over')
  })
}
window.addEventListener('dragleave', (event) => {
  if (!event.relatedTarget) drop.classList.remove('over')
})
window.addEventListener('drop', (event) => {
  event.preventDefault()
  drop.classList.remove('over')
  addFiles(event.dataTransfer?.files ?? [])
})
window.addEventListener('paste', (event) => {
  const files = event.clipboardData?.files
  if (files?.length) addFiles(files)
})

syncControls()
