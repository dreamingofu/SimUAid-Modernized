// Full-scene repaint. A pure function of (netlist, viewport, selection,
// interaction, …); the Canvas calls it on every change via requestAnimationFrame.
// Drawing is done in world coordinates after applying the viewport + DPR
// transform; line widths are divided by scale so strokes stay ~1 CSS px.

import { LogicValue, type Component, type Netlist, type PinValueResolver } from '../model/types'
import { defOf } from '../model/partDefinitions'
import { busWidthOfWire, getAbsolutePins, pinFacing } from '../geometry/pins'
import { segmentsToPoints, routeOrthogonal } from '../geometry/wireRouting'
import { junctionPoints } from '../netlist/nets'
import { drawComponentSymbol } from './symbols'
import {
  screenToWorld,
  snapToGrid,
  GRID,
  PAGE_WIDTH,
  PAGE_HEIGHT,
  type Point,
  type Viewport
} from '../geometry/coords'
import { DEVICE_LABEL_OFFSET } from '../geometry/hitTest'
import { COLORS, FONTS } from './colors'

export interface RenderParams {
  ctx: CanvasRenderingContext2D
  cssWidth: number
  cssHeight: number
  dpr: number
  netlist: Netlist
  viewport: Viewport
  selectedComponentIds: Set<string>
  selectedWireIds: Set<string>
  labelOnlyComponentId: string | null
  highlightWireIds: Set<string>
  showIoValues: boolean
  gridEnabled: boolean
  resolvePinValue: PinValueResolver
  busPinValues: Record<string, string>
  wireDraftPoints: Point[] | null
  cursor: Point | null
}

export function renderCircuit(params: RenderParams): void {
  const { ctx, cssWidth, cssHeight, dpr, netlist, viewport: vp } = params
  const lw = 1 / vp.scale

  // Clear in device space.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = COLORS.background
  ctx.fillRect(0, 0, cssWidth, cssHeight)

  // World transform (viewport composed with DPR).
  ctx.setTransform(dpr * vp.scale, 0, 0, dpr * vp.scale, dpr * vp.offsetX, dpr * vp.offsetY)
  ctx.lineWidth = lw
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  const topLeft = screenToWorld({ x: 0, y: 0 }, vp)
  const bottomRight = screenToWorld({ x: cssWidth, y: cssHeight }, vp)

  drawPageBoundaries(ctx, topLeft, bottomRight, lw)
  if (params.gridEnabled && vp.scale >= 0.5) drawGrid(ctx, topLeft, bottomRight, vp.scale)

  drawWires(ctx, params, lw)
  drawJunctions(ctx, netlist, lw)
  for (const component of netlist.components) drawComponent(ctx, component, params, lw)
  drawWireDraft(ctx, params, lw)
}

function drawPageBoundaries(ctx: CanvasRenderingContext2D, tl: Point, br: Point, lw: number): void {
  ctx.save()
  ctx.strokeStyle = COLORS.page
  ctx.lineWidth = lw
  ctx.setLineDash([4 * lw, 4 * lw])
  ctx.beginPath()
  for (let x = Math.max(0, Math.floor(tl.x / PAGE_WIDTH) * PAGE_WIDTH); x <= br.x; x += PAGE_WIDTH) {
    ctx.moveTo(x, Math.max(0, tl.y))
    ctx.lineTo(x, br.y)
  }
  for (let y = Math.max(0, Math.floor(tl.y / PAGE_HEIGHT) * PAGE_HEIGHT); y <= br.y; y += PAGE_HEIGHT) {
    ctx.moveTo(Math.max(0, tl.x), y)
    ctx.lineTo(br.x, y)
  }
  ctx.stroke()
  ctx.restore()
}

function drawGrid(ctx: CanvasRenderingContext2D, tl: Point, br: Point, scale: number): void {
  ctx.save()
  ctx.fillStyle = COLORS.grid
  const r = 1 / scale
  for (let x = snapToGrid(tl.x); x <= br.x; x += GRID) {
    for (let y = snapToGrid(tl.y); y <= br.y; y += GRID) {
      ctx.fillRect(x - r / 2, y - r / 2, r, r)
    }
  }
  ctx.restore()
}

function drawWires(ctx: CanvasRenderingContext2D, params: RenderParams, lw: number): void {
  const { netlist } = params
  for (const wire of netlist.wires) {
    const pts = segmentsToPoints(wire.segments)
    if (pts.length < 2) continue
    const highlighted = params.highlightWireIds.has(wire.id)
    const selected = params.selectedWireIds.has(wire.id)
    const bus = busWidthOfWire(netlist, wire) > 1
    ctx.save()
    if (highlighted) {
      ctx.strokeStyle = COLORS.highlight
      ctx.lineWidth = 2 * lw
      ctx.setLineDash([6 * lw, 4 * lw])
    } else if (selected) {
      ctx.strokeStyle = COLORS.selection
      ctx.lineWidth = 2 * lw
    } else {
      ctx.strokeStyle = COLORS.wire
      ctx.lineWidth = bus ? 3 * lw : lw
    }
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
    ctx.stroke()
    ctx.restore()
  }
}

function drawJunctions(ctx: CanvasRenderingContext2D, netlist: Netlist, lw: number): void {
  ctx.fillStyle = COLORS.junction
  for (const p of junctionPoints(netlist)) {
    ctx.beginPath()
    ctx.arc(p.x, p.y, 2.5 * lw, 0, Math.PI * 2)
    ctx.fill()
  }
}

function drawComponent(
  ctx: CanvasRenderingContext2D,
  component: Component,
  params: RenderParams,
  lw: number
): void {
  drawComponentSymbol(ctx, component, params.resolvePinValue, (pinId) => params.busPinValues[pinId])

  const def = defOf(component)
  const pins = getAbsolutePins(component)

  // Pin connection dots.
  ctx.fillStyle = COLORS.pinDot
  for (const pin of pins) {
    ctx.beginPath()
    ctx.arc(pin.x, pin.y, 2 * lw, 0, Math.PI * 2)
    ctx.fill()
  }

  // Pin labels (black, beside the pin).
  ctx.font = FONTS.pinName
  ctx.fillStyle = COLORS.pinLabel
  for (const pin of pins) {
    const label = component.pinLabels[pin.name]
    if (!label) continue
    placePinText(ctx, label, pin.x, pin.y, pinFacing(component, pin.name))
  }

  // I/O values above each pin; bus pins show their hex value.
  if (params.showIoValues) {
    ctx.font = FONTS.value
    ctx.fillStyle = COLORS.value
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    for (const pin of pins) {
      const text = params.busPinValues[pin.pinId] ?? params.resolvePinValue(pin.pinId) ?? LogicValue.Z
      ctx.fillText(text, pin.x, pin.y - 4 * lw - 2)
    }
  }

  // Device label (red, centered above).
  if (component.label) {
    ctx.font = FONTS.deviceLabel
    ctx.fillStyle = COLORS.deviceLabel
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillText(component.label, component.x + def.width / 2, component.y - DEVICE_LABEL_OFFSET)
  }

  // Selection outline.
  const selected = params.selectedComponentIds.has(component.id)
  const labelOnly = params.labelOnlyComponentId === component.id
  if (selected) {
    ctx.save()
    ctx.strokeStyle = COLORS.selection
    ctx.lineWidth = 1.5 * lw
    ctx.setLineDash([4 * lw, 3 * lw])
    ctx.strokeRect(component.x - 3 * lw, component.y - 3 * lw, def.width + 6 * lw, def.height + 6 * lw)
    ctx.restore()
  }
  if (labelOnly && component.label) {
    ctx.save()
    ctx.strokeStyle = COLORS.selection
    ctx.lineWidth = 1 * lw
    const w = Math.max(20, component.label.length * 7)
    ctx.strokeRect(component.x + def.width / 2 - w / 2, component.y - DEVICE_LABEL_OFFSET - 14, w, 14)
    ctx.restore()
  }

  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
}

function placePinText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  facing: 'left' | 'right' | 'up' | 'down'
): void {
  switch (facing) {
    case 'left':
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, x - 4, y)
      break
    case 'right':
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, x + 4, y)
      break
    case 'up':
      ctx.textAlign = 'center'
      ctx.textBaseline = 'bottom'
      ctx.fillText(text, x, y - 4)
      break
    case 'down':
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.fillText(text, x, y + 4)
      break
  }
}

function drawWireDraft(ctx: CanvasRenderingContext2D, params: RenderParams, lw: number): void {
  const pts = params.wireDraftPoints
  if (!pts || pts.length === 0) return
  ctx.save()
  ctx.strokeStyle = COLORS.selection
  ctx.lineWidth = 1.5 * lw
  ctx.setLineDash([5 * lw, 3 * lw])
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
  // Preview leg to the cursor.
  if (params.cursor) {
    const last = pts[pts.length - 1]
    const dx = Math.abs(params.cursor.x - last.x)
    const dy = Math.abs(params.cursor.y - last.y)
    const route = routeOrthogonal(last, params.cursor, dx >= dy)
    for (let i = 1; i < route.length; i++) ctx.lineTo(route[i].x, route[i].y)
  }
  ctx.stroke()
  ctx.restore()
}
