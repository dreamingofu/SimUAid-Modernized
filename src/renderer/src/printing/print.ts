// Renders the circuit to a bitmap for printing/preview. Page boundaries are
// visible on the editing canvas; the print image itself is the fitted circuit.

import { LogicValue, type Netlist, type PinId } from '../model/types'
import { componentsBounds } from '../geometry/hitTest'
import { renderCircuit } from '../rendering/renderCircuit'
import { boundedCanvasSize, drawTimingDiagram, timingHeight, timingLayout, type LabeledTrace } from '../rendering/timing'

const MARGIN = 40
const MAX_DIM = 4000

export function renderCircuitImage(
  netlist: Netlist,
  pinValues: Record<PinId, LogicValue>,
  busPinValues: Record<PinId, string>
): string | null {
  const bounds = componentsBounds(netlist)
  if (!bounds) return null
  const w = Math.min(MAX_DIM, Math.ceil(bounds.maxX - bounds.minX) + 2 * MARGIN)
  const h = Math.min(MAX_DIM, Math.ceil(bounds.maxY - bounds.minY) + 2 * MARGIN)

  const canvas = document.createElement('canvas')
  canvas.width = w * 2 // 2x for print sharpness
  canvas.height = h * 2
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  renderCircuit({
    ctx,
    cssWidth: w,
    cssHeight: h,
    dpr: 2,
    netlist,
    viewport: { scale: 1, offsetX: MARGIN - bounds.minX, offsetY: MARGIN - bounds.minY },
    selectedComponentIds: new Set(),
    selectedWireIds: new Set(),
    labelOnlyComponentId: null,
    highlightWireIds: new Set(),
    showIoValues: false,
    gridEnabled: false,
    resolvePinValue: (pinId) => pinValues[pinId] ?? LogicValue.Z,
    busPinValues,
    wireDraftPoints: null,
    cursor: null
  })
  return canvas.toDataURL('image/png')
}

const TIMING_PRINT_WIDTH = 960
const TIMING_LABEL_WIDTH = 64

/**
 * Renders the whole run (0 to `endNs`) at a page-width scale with signal names
 * drawn beside each trace and the time axis in ns, independent of the panel's
 * current zoom.
 */
export function renderTimingImage(
  traces: LabeledTrace[],
  endNs: number
): { url: string; endNs: number; divNs: number } | null {
  if (traces.length === 0) return null
  const end = Math.max(1, Math.round(endNs))
  const layout = timingLayout('fit', end, TIMING_PRINT_WIDTH - TIMING_LABEL_WIDTH)
  const width = TIMING_LABEL_WIDTH + layout.width
  const height = timingHeight(traces.length)
  // 2x for print sharpness, reduced when many probes would exceed canvas limits.
  const size = boundedCanvasSize(width, height, 2)
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.setTransform(size.ratio, 0, 0, size.ratio, 0, 0)
  drawTimingDiagram({
    ctx,
    traces,
    layout,
    labelWidth: TIMING_LABEL_WIDTH,
    endNs: end,
    cursorNs: null,
    unitLabels: true
  })
  return { url: canvas.toDataURL('image/png'), endNs: end, divNs: layout.divNs }
}
