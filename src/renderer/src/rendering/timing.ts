// Timing-diagram drawing shared by the on-screen panel and the printed page.
// Layout math is pure so the scale/fit rules and canvas bounds are testable.

import { LogicValue } from '../model/types'
import type { WaveformTrace } from '../sim/engine'
import { COLORS } from './colors'

export const TIMING_ROW_H = 30
export const TIMING_AXIS_H = 22
export const DIVISION_PX = 50
/** ns/div choices offered in the panel. */
export const TIMING_SCALES = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]
/** Widest waveform canvas (CSS px) the panel will allocate. */
export const MAX_TIMING_WIDTH = 16000
/** Device-pixel budget for one timing canvas (about 64 MB of RGBA). */
const MAX_CANVAS_PIXELS = 16_000_000
const MAX_CANVAS_SIDE = 32_000

/**
 * Backing-store size for a canvas shown at `cssWidth`×`cssHeight`: the requested
 * device-pixel ratio, reduced (without any floor) until both sides stay within
 * MAX_CANVAS_SIDE and the area within MAX_CANVAS_PIXELS.
 */
export function boundedCanvasSize(
  cssWidth: number,
  cssHeight: number,
  dpr: number
): { ratio: number; width: number; height: number } {
  const w = Math.max(1, cssWidth)
  const h = Math.max(1, cssHeight)
  const ratio = Math.min(dpr, MAX_CANVAS_SIDE / w, MAX_CANVAS_SIDE / h, Math.sqrt(MAX_CANVAS_PIXELS / (w * h)))
  // Flooring keeps the rounded size inside the bounds.
  return { ratio, width: Math.max(1, Math.floor(w * ratio)), height: Math.max(1, Math.floor(h * ratio)) }
}

/**
 * What a timing diagram spans: the axis runs to the configured simulation time
 * (or further if the run went past it), while traces and the end marker stop at
 * the time actually simulated.
 */
export function timingExtent(
  simLimitNs: number,
  simTimeNs: number,
  traces: WaveformTrace[]
): { horizonNs: number; simulatedNs: number } {
  const latest = traces.reduce(
    (m, t) => Math.max(m, t.samples.length ? t.samples[t.samples.length - 1].t : 0),
    0
  )
  const simulatedNs = Math.max(simTimeNs, latest)
  return { horizonNs: Math.max(simLimitNs, simulatedNs), simulatedNs }
}
/** Room after the last tick so the endpoint label is not clipped. */
const END_PAD = 40
const MIN_FIT_DIVISION_PX = 40

export interface TimingLayout {
  pxPerNs: number
  divNs: number
  axisMaxNs: number
  /** Plot width in CSS px, including the end padding. */
  width: number
}

/** Smallest 1-2-5 step whose division is at least `minPx` wide. */
function niceDivision(pxPerNs: number, minPx: number): number {
  for (let decade = 1; decade < 1e9; decade *= 10) {
    for (const m of [1, 2, 5]) {
      if (m * decade * pxPerNs >= minPx) return m * decade
    }
  }
  return 1e9
}

/** Whether a fixed ns/div scale fits within the canvas bound for this run length. */
export function scaleFits(divNs: number, axisMaxNs: number): boolean {
  return axisMaxNs * (DIVISION_PX / divNs) + END_PAD <= MAX_TIMING_WIDTH
}

/**
 * Resolves a requested scale into concrete geometry. `fit` stretches the whole
 * run across `fitWidth`; a fixed scale that would exceed MAX_TIMING_WIDTH falls
 * back to the finest offered scale that fits.
 */
export function timingLayout(scale: number | 'fit', endNs: number, fitWidth: number): TimingLayout & { limited: boolean } {
  if (scale === 'fit') {
    const axisMaxNs = Math.max(endNs, 1)
    const plot = Math.max(120, fitWidth - END_PAD)
    const pxPerNs = plot / axisMaxNs
    return { pxPerNs, divNs: niceDivision(pxPerNs, MIN_FIT_DIVISION_PX), axisMaxNs, width: plot + END_PAD, limited: false }
  }
  let divNs = scale
  const axisFor = (d: number): number => Math.max(endNs, d * 4)
  let limited = false
  if (!scaleFits(divNs, axisFor(divNs))) {
    divNs = TIMING_SCALES.find((d) => d > scale && scaleFits(d, axisFor(d))) ??
      niceDivision((MAX_TIMING_WIDTH - END_PAD) / Math.max(endNs, 1), DIVISION_PX)
    limited = true
  }
  const pxPerNs = DIVISION_PX / divNs
  const axisMaxNs = axisFor(divNs)
  return { pxPerNs, divNs, axisMaxNs, width: Math.round(axisMaxNs * pxPerNs) + END_PAD, limited }
}

export interface LabeledTrace {
  label: string
  trace: WaveformTrace
}

export interface DrawTimingParams {
  ctx: CanvasRenderingContext2D
  traces: LabeledTrace[]
  layout: TimingLayout
  /** Width reserved on the left for signal names (0 when the DOM shows them). */
  labelWidth: number
  /** End of simulated time: traces stop here and it is marked on the axis (0 = not run). */
  endNs: number
  cursorNs: number | null
  /** Shows "ns" units beside the first tick (the panel header states units otherwise). */
  unitLabels: boolean
}

function levelY(value: LogicValue, top: number): number {
  if (value === LogicValue.ONE) return top + 6
  if (value === LogicValue.ZERO) return top + TIMING_ROW_H - 6
  return top + TIMING_ROW_H / 2
}

export function timingHeight(rows: number): number {
  return TIMING_AXIS_H + Math.max(rows, 1) * TIMING_ROW_H
}

export function drawTimingDiagram(p: DrawTimingParams): void {
  const { ctx, traces, layout, labelWidth, endNs } = p
  const { pxPerNs, divNs, axisMaxNs } = layout
  const width = labelWidth + layout.width
  const height = timingHeight(traces.length)
  const xOf = (t: number): number => labelWidth + t * pxPerNs

  ctx.fillStyle = COLORS.background
  ctx.fillRect(0, 0, width, height)
  ctx.font = '10px "Segoe UI", system-ui, sans-serif'
  ctx.textBaseline = 'top'
  ctx.lineWidth = 1

  // Grid, tick labels and the endpoint.
  ctx.strokeStyle = COLORS.grid
  ctx.fillStyle = COLORS.value
  const ticks = Math.floor(axisMaxNs / divNs + 1e-9)
  for (let k = 0; k <= ticks; k++) {
    const t = k * divNs
    const x = Math.round(xOf(t)) + 0.5
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, height)
    ctx.stroke()
    ctx.fillText(k === 0 && p.unitLabels ? '0 ns' : String(t), x + 2, 2)
  }
  if (endNs > 0) {
    const x = Math.round(xOf(endNs)) + 0.5
    ctx.strokeStyle = COLORS.value
    ctx.setLineDash([2, 2])
    ctx.beginPath()
    ctx.moveTo(x, TIMING_AXIS_H - 6)
    ctx.lineTo(x, height)
    ctx.stroke()
    ctx.setLineDash([])
    const text = `end ${endNs} ns`
    const w = ctx.measureText(text).width
    // Left of the marker when it fits; otherwise (an early end on a long axis)
    // to its right, so the label never runs past the plot's left edge.
    let left = x - 2 - w
    if (left < labelWidth + 2) left = Math.min(x + 2, width - w - 2)
    left = Math.max(labelWidth + 2, left)
    ctx.fillStyle = COLORS.background
    ctx.fillRect(left - 2, 11, w + 4, 11)
    ctx.fillStyle = COLORS.value
    ctx.textAlign = 'left'
    ctx.fillText(text, left, 11)
  }

  traces.forEach(({ label, trace }, i) => {
    const top = TIMING_AXIS_H + i * TIMING_ROW_H
    ctx.strokeStyle = '#e0e0e0'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, top + TIMING_ROW_H + 0.5)
    ctx.lineTo(width, top + TIMING_ROW_H + 0.5)
    ctx.stroke()
    if (labelWidth > 0) {
      ctx.fillStyle = COLORS.pinLabel
      ctx.font = '12px "Segoe UI", system-ui, sans-serif'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, 6, top + TIMING_ROW_H / 2, labelWidth - 10)
      ctx.font = '10px "Segoe UI", system-ui, sans-serif'
      ctx.textBaseline = 'top'
    }

    const samples = trace.samples.length ? trace.samples : [{ t: 0, v: LogicValue.Z }]
    const lastNs = Math.max(endNs, samples[samples.length - 1].t)
    for (let s = 0; s < samples.length; s++) {
      const cur = samples[s]
      const xStart = xOf(cur.t)
      const xEnd = xOf(s + 1 < samples.length ? samples[s + 1].t : lastNs)
      if (trace.bus) {
        drawBusSegment(ctx, cur.hex ?? '?', xStart, xEnd, top, s > 0)
      } else {
        drawSegment(ctx, cur.v, xStart, xEnd, top)
        if (s + 1 < samples.length) {
          ctx.strokeStyle = COLORS.gate
          ctx.lineWidth = 1.5
          ctx.beginPath()
          ctx.moveTo(xEnd, levelY(cur.v, top))
          ctx.lineTo(xEnd, levelY(samples[s + 1].v, top))
          ctx.stroke()
        }
      }
    }
  })

  if (labelWidth > 0) {
    ctx.strokeStyle = COLORS.grid
    ctx.beginPath()
    ctx.moveTo(labelWidth - 0.5, 0)
    ctx.lineTo(labelWidth - 0.5, height)
    ctx.stroke()
  }

  if (p.cursorNs !== null) {
    const x = Math.round(xOf(p.cursorNs)) + 0.5
    ctx.strokeStyle = COLORS.highlight
    ctx.setLineDash([4, 3])
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, height)
    ctx.stroke()
    ctx.setLineDash([])
  }
}

/** Bus trace segment: parallel rails with an X-crossing at transitions + hex text. */
function drawBusSegment(
  ctx: CanvasRenderingContext2D,
  hex: string,
  xStart: number,
  xEnd: number,
  top: number,
  transition: boolean
): void {
  const yTop = top + 7
  const yBot = top + TIMING_ROW_H - 7
  const slant = transition ? 4 : 0
  ctx.strokeStyle = COLORS.gate
  ctx.lineWidth = 1.25
  ctx.beginPath()
  ctx.moveTo(xStart + slant, yTop)
  ctx.lineTo(xEnd, yTop)
  ctx.moveTo(xStart + slant, yBot)
  ctx.lineTo(xEnd, yBot)
  if (transition) {
    ctx.moveTo(xStart - 4, yTop)
    ctx.lineTo(xStart + slant, yBot)
    ctx.moveTo(xStart - 4, yBot)
    ctx.lineTo(xStart + slant, yTop)
  }
  ctx.stroke()
  if (xEnd - xStart > 18) {
    ctx.fillStyle = COLORS.gate
    ctx.font = '10px "Segoe UI", system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(hex, (xStart + xEnd) / 2, (yTop + yBot) / 2)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
  }
}

function drawSegment(
  ctx: CanvasRenderingContext2D,
  value: LogicValue,
  xStart: number,
  xEnd: number,
  top: number
): void {
  if (value === LogicValue.X) {
    ctx.fillStyle = 'rgba(209, 43, 43, 0.18)'
    ctx.fillRect(xStart, top + 6, Math.max(0, xEnd - xStart), TIMING_ROW_H - 12)
    return
  }
  ctx.strokeStyle = COLORS.gate
  ctx.lineWidth = 1.5
  if (value === LogicValue.Z) ctx.setLineDash([4, 3])
  const y = levelY(value, top)
  ctx.beginPath()
  ctx.moveTo(xStart, y)
  ctx.lineTo(xEnd, y)
  ctx.stroke()
  ctx.setLineDash([])
}
