// Renders the circuit to a bitmap for printing/preview. Page boundaries are
// visible on the editing canvas; the print image itself is the fitted circuit.

import { LogicValue, type Netlist, type PinId } from '../model/types'
import { componentsBounds } from '../geometry/hitTest'
import { renderCircuit } from '../rendering/renderCircuit'

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
