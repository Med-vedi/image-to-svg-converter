export type PresetId = 'logo' | 'illustration' | 'photo' | 'pixel'

export interface TraceSettings {
  preset: PresetId
  /** Colour bits per channel, 1-8. */
  colors: number
  /** Discards shapes smaller than this many pixels. */
  speckle: number
  /** Angle in degrees above which a turn stays a sharp corner. */
  corners: number
}

export interface Settings extends TraceSettings {
  removeBackground: boolean
  /** Also remove background colour enclosed by the subject. */
  removeEnclosed: boolean
  /** How far a colour may be from the detected background and still be removed. */
  backgroundTolerance: number
}

export const PRESETS: Record<PresetId, TraceSettings> = {
  logo: { preset: 'logo', colors: 6, speckle: 4, corners: 60 },
  illustration: { preset: 'illustration', colors: 7, speckle: 4, corners: 60 },
  photo: { preset: 'photo', colors: 8, speckle: 10, corners: 120 },
  pixel: { preset: 'pixel', colors: 8, speckle: 0, corners: 60 },
}

const LAYER_DIFFERENCE: Record<PresetId, number> = { logo: 16, illustration: 8, photo: 4, pixel: 0 }

const radians = (degrees: number) => (degrees * Math.PI) / 180

/** Maps settings to the configuration `vtracer-wasm` expects. Unlike the VTracer CLI, it takes angles in radians and colour precision as bits to discard. */
export function toTracerConfig(settings: TraceSettings) {
  return {
    binary: false,
    mode: settings.preset === 'pixel' ? 'pixel' : 'spline',
    hierarchical: 'stacked',
    cornerThreshold: radians(settings.corners),
    lengthThreshold: 4,
    maxIterations: 10,
    spliceThreshold: radians(45),
    filterSpeckle: settings.speckle,
    colorPrecision: 8 - settings.colors,
    layerDifference: LAYER_DIFFERENCE[settings.preset],
    pathPrecision: 2,
  }
}

/** Long edge traced by default. Small images are enlarged because curve fitting needs pixels to work with. */
const MAX_TRACE_EDGE = 2048
const MIN_TRACE_EDGE = 1024
const MAX_UPSCALE = 4

export function traceScale(width: number, height: number, preset: PresetId): number {
  const edge = Math.max(width, height)
  if (edge > MAX_TRACE_EDGE) return MAX_TRACE_EDGE / edge
  if (preset === 'pixel' || edge >= MIN_TRACE_EDGE) return 1
  return Math.min(MAX_UPSCALE, MIN_TRACE_EDGE / edge)
}
