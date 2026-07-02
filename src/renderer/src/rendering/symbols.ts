// Logic-symbol drawing in WORLD coordinates (viewport + DPR already applied).
// A component's (x,y) is its top-left corner; geometry comes from defOf().

import { ComponentType, LogicValue, makePinId, type Component, type PinValueResolver } from '../model/types'
import { defOf, type PartDefinition } from '../model/partDefinitions'
import { COLORS, FONTS } from './colors'

type ShapeFamily =
  | 'and'
  | 'or'
  | 'nand'
  | 'nor'
  | 'xor'
  | 'xnor'
  | 'not'
  | 'switch'
  | 'probe'
  | 'clock'
  | 'input'
  | 'tristate'
  | 'vcc'
  | 'ground'
  | 'sevenSegment'
  | 'busEnd'
  | 'busBar'
  | 'stateMachine'
  | 'checker'
  | 'box'

const BUBBLE_R = 4

function familyOf(type: ComponentType): ShapeFamily {
  switch (type) {
    case ComponentType.AND2:
    case ComponentType.AND3:
    case ComponentType.AND4:
    case ComponentType.AND5:
      return 'and'
    case ComponentType.OR2:
    case ComponentType.OR3:
    case ComponentType.OR4:
    case ComponentType.OR5:
      return 'or'
    case ComponentType.NAND2:
    case ComponentType.NAND3:
    case ComponentType.NAND4:
    case ComponentType.NAND5:
      return 'nand'
    case ComponentType.NOR2:
    case ComponentType.NOR3:
    case ComponentType.NOR4:
    case ComponentType.NOR5:
      return 'nor'
    case ComponentType.XOR2:
      return 'xor'
    case ComponentType.XNOR2:
      return 'xnor'
    case ComponentType.NOT:
      return 'not'
    case ComponentType.SWITCH:
      return 'switch'
    case ComponentType.PROBE:
      return 'probe'
    case ComponentType.CLOCK:
      return 'clock'
    case ComponentType.INPUT_SIGNAL:
      return 'input'
    case ComponentType.TRISTATE_RIGHT:
    case ComponentType.TRISTATE_LEFT:
    case ComponentType.TRISTATE_UP:
    case ComponentType.TRISTATE_DOWN:
      return 'tristate'
    case ComponentType.VCC:
      return 'vcc'
    case ComponentType.GROUND:
      return 'ground'
    case ComponentType.SEVEN_SEGMENT:
      return 'sevenSegment'
    case ComponentType.BUS_INPUT:
    case ComponentType.BUS_PROBE:
      return 'busEnd'
    case ComponentType.SPLITTER:
    case ComponentType.MERGER:
      return 'busBar'
    case ComponentType.STATE_MACHINE:
      return 'stateMachine'
    case ComponentType.CHECKER:
      return 'checker'
    default:
      return 'box'
  }
}

function bubble(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  ctx.beginPath()
  ctx.arc(cx, cy, BUBBLE_R, 0, Math.PI * 2)
  ctx.stroke()
}

function drawAnd(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, negate: boolean): void {
  const noseW = negate ? w - 8 : w
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(x + noseW * 0.5, y)
  ctx.ellipse(x + noseW * 0.5, y + h / 2, noseW * 0.5, h / 2, 0, -Math.PI / 2, Math.PI / 2)
  ctx.lineTo(x, y + h)
  ctx.closePath()
  ctx.stroke()
  if (negate) bubble(ctx, x + noseW + BUBBLE_R, y + h / 2)
}

function drawOr(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  negate: boolean,
  extraArc: boolean
): void {
  const noseW = negate ? w - 8 : w
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.quadraticCurveTo(x + noseW * 0.55, y, x + noseW, y + h / 2)
  ctx.quadraticCurveTo(x + noseW * 0.55, y + h, x, y + h)
  ctx.quadraticCurveTo(x + noseW * 0.2, y + h / 2, x, y)
  ctx.closePath()
  ctx.stroke()
  if (negate) bubble(ctx, x + noseW + BUBBLE_R, y + h / 2)
  if (extraArc) {
    ctx.beginPath()
    ctx.moveTo(x - 6, y)
    ctx.quadraticCurveTo(x - 6 + noseW * 0.2, y + h / 2, x - 6, y + h)
    ctx.stroke()
  }
}

function drawNot(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const noseW = w - 8
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(x, y + h)
  ctx.lineTo(x + noseW, y + h / 2)
  ctx.closePath()
  ctx.stroke()
  bubble(ctx, x + noseW + BUBBLE_R, y + h / 2)
}

function drawInputStubs(ctx: CanvasRenderingContext2D, c: Component, def: PartDefinition, inset: number): void {
  if (inset <= 0) return
  for (const pin of def.pins) {
    if (pin.role === 'input' && pin.dx === 0) {
      ctx.beginPath()
      ctx.moveTo(c.x, c.y + pin.dy)
      ctx.lineTo(c.x + inset, c.y + pin.dy)
      ctx.stroke()
    }
  }
}

/** Rectangle symbol with a centered title and pin names drawn inside each edge. */
function drawLabeledBox(ctx: CanvasRenderingContext2D, c: Component, def: PartDefinition): void {
  const { x, y } = c
  const { width: w, height: h } = def
  ctx.strokeRect(x, y, w, h)

  if (def.title) {
    ctx.fillStyle = COLORS.gate
    ctx.font = FONTS.deviceLabel
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(def.title, x + w / 2, y + h / 2)
  }

  ctx.fillStyle = COLORS.gate
  ctx.font = FONTS.ffPin
  for (const pin of def.pins) {
    const px = x + pin.dx
    const py = y + pin.dy
    if (pin.dx <= 0) {
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(pin.name, px + 5, py)
    } else if (pin.dx >= w) {
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'
      ctx.fillText(pin.name, px - 5, py)
    } else if (pin.dy <= 0) {
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.fillText(pin.name, px, py + 4)
    } else {
      ctx.textAlign = 'center'
      ctx.textBaseline = 'bottom'
      ctx.fillText(pin.name, px, py - 4)
    }
    if (pin.role === 'preset') bubble(ctx, px, py - BUBBLE_R)
    if (pin.role === 'clear') bubble(ctx, px, py + BUBBLE_R)
    if (pin.role === 'clock') {
      const dir = pin.dx <= 0 ? 1 : -1
      ctx.beginPath()
      ctx.moveTo(px, py - 5)
      ctx.lineTo(px + 7 * dir, py)
      ctx.lineTo(px, py + 5)
      ctx.stroke()
    }
  }
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
}

function drawSwitch(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, on: boolean): void {
  const cy = y + h / 2
  ctx.beginPath()
  ctx.arc(x + 8, cy, 3, 0, Math.PI * 2)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(x + 8, cy)
  ctx.lineTo(x + w - 6, on ? cy : cy - 8)
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(x + w - 4, cy, 3, 0, Math.PI * 2)
  ctx.stroke()
}

function drawProbe(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const cx = x + w / 2
  const cy = y + h / 2
  const r = Math.min(w, h) * 0.38
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(cx - r, cy)
  ctx.lineTo(cx + r, cy)
  ctx.moveTo(cx, cy - r)
  ctx.lineTo(cx, cy + r)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(x, cy)
  ctx.lineTo(cx - r, cy)
  ctx.stroke()
}

function drawWaveBox(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, repeating: boolean): void {
  ctx.strokeRect(x, y, w - 6, h)
  const top = y + h * 0.3
  const bot = y + h * 0.7
  const left = x + 5
  const right = x + w - 11
  const mid = (left + right) / 2
  ctx.beginPath()
  ctx.moveTo(left, bot)
  ctx.lineTo(left, top)
  ctx.lineTo(mid, top)
  ctx.lineTo(mid, bot)
  ctx.lineTo(right, bot)
  if (repeating) ctx.lineTo(right, top)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(x + w - 6, y + h / 2)
  ctx.lineTo(x + w, y + h / 2)
  ctx.stroke()
}

function drawTristate(ctx: CanvasRenderingContext2D, c: Component): void {
  const { x, y } = c
  const cx = x + 20
  const cy = y + 20
  const s = 12
  ctx.beginPath()
  switch (c.type) {
    case ComponentType.TRISTATE_LEFT:
      ctx.moveTo(cx + s, cy - s)
      ctx.lineTo(cx + s, cy + s)
      ctx.lineTo(cx - s, cy)
      break
    case ComponentType.TRISTATE_UP:
      ctx.moveTo(cx - s, cy + s)
      ctx.lineTo(cx + s, cy + s)
      ctx.lineTo(cx, cy - s)
      break
    case ComponentType.TRISTATE_DOWN:
      ctx.moveTo(cx - s, cy - s)
      ctx.lineTo(cx + s, cy - s)
      ctx.lineTo(cx, cy + s)
      break
    default:
      ctx.moveTo(cx - s, cy - s)
      ctx.lineTo(cx - s, cy + s)
      ctx.lineTo(cx + s, cy)
  }
  ctx.closePath()
  ctx.stroke()
  // control stub from the ctl pin toward the triangle
  const def = defOf(c)
  const ctl = def.pins.find((p) => p.name === 'ctl')
  if (ctl) {
    ctx.beginPath()
    ctx.moveTo(x + ctl.dx, y + ctl.dy)
    ctx.lineTo(cx, cy - (ctl.dy === 0 ? s : 0))
    ctx.stroke()
  }
}

function drawVcc(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.beginPath()
  ctx.moveTo(x + 10, y + 8)
  ctx.lineTo(x + 30, y + 8)
  ctx.moveTo(x + 20, y + 8)
  ctx.lineTo(x + 20, y + 20)
  ctx.lineTo(x + 40, y + 20)
  ctx.stroke()
  ctx.font = FONTS.ffPin
  ctx.fillStyle = COLORS.gate
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillText('+V', x + 20, y + 24)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
}

function drawGround(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.beginPath()
  ctx.moveTo(x + 20, y + 8)
  ctx.lineTo(x + 20, y + 20)
  ctx.lineTo(x + 40, y + 20)
  ctx.moveTo(x + 10, y + 26)
  ctx.lineTo(x + 30, y + 26)
  ctx.moveTo(x + 14, y + 31)
  ctx.lineTo(x + 26, y + 31)
  ctx.moveTo(x + 18, y + 36)
  ctx.lineTo(x + 22, y + 36)
  ctx.stroke()
}

// Segment order per the manual: 1 top, 2 upper-right, 3 lower-right, 4 bottom,
// 5 lower-left, 6 upper-left, 7 middle.
const SEGMENTS: [number, number, number, number][] = [
  [20, 30, 60, 30],
  [60, 30, 60, 75],
  [60, 75, 60, 120],
  [20, 120, 60, 120],
  [20, 75, 20, 120],
  [20, 30, 20, 75],
  [20, 75, 60, 75]
]

function drawSevenSegment(
  ctx: CanvasRenderingContext2D,
  c: Component,
  resolve: PinValueResolver | undefined
): void {
  const def = defOf(c)
  ctx.strokeRect(c.x, c.y, def.width, def.height)
  for (let i = 0; i < 7; i++) {
    const lit = resolve?.(makePinId(c.id, String(i + 1))) === LogicValue.ONE
    const [x1, y1, x2, y2] = SEGMENTS[i]
    ctx.save()
    ctx.strokeStyle = lit ? '#d12b2b' : '#e3e3e3'
    ctx.lineWidth = 5
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(c.x + x1, c.y + y1)
    ctx.lineTo(c.x + x2, c.y + y2)
    ctx.stroke()
    ctx.restore()
  }
  // input stubs with segment numbers
  ctx.fillStyle = COLORS.gate
  ctx.font = FONTS.ffPin
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  for (const pin of def.pins) {
    ctx.fillText(pin.name, c.x + 4, c.y + pin.dy)
  }
  ctx.textBaseline = 'alphabetic'
}

/** Bus Input / Bus Probe: rounded box showing the hex value (label or live). */
function drawBusEnd(
  ctx: CanvasRenderingContext2D,
  c: Component,
  busResolve: ((pinId: string) => string | undefined) | undefined
): void {
  const def = defOf(c)
  const { x, y } = c
  const w = def.width
  const h = def.height
  ctx.beginPath()
  ctx.roundRect(x + 4, y + 4, w - 8, h - 8, 8)
  ctx.stroke()
  const isInput = c.type === ComponentType.BUS_INPUT
  const pin = def.pins[0]
  const text = isInput ? c.label || '?' : (busResolve?.(makePinId(c.id, pin.name)) ?? 'Z')
  ctx.fillStyle = COLORS.gate
  ctx.font = FONTS.deviceLabel
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x + w / 2, y + h / 2)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  // lead to the bus pin
  ctx.beginPath()
  ctx.moveTo(isInput ? x + w - 4 : x, y + h / 2)
  ctx.lineTo(isInput ? x + w : x + 4, y + h / 2)
  ctx.stroke()
}

/** Splitter / Merger: heavy horizontal bar with per-bit stubs. */
function drawBusBar(ctx: CanvasRenderingContext2D, c: Component): void {
  const def = defOf(c)
  const barY = c.type === ComponentType.SPLITTER ? c.y + 14 : c.y + 6
  ctx.save()
  ctx.lineWidth = 4
  ctx.beginPath()
  ctx.moveTo(c.x + 10, barY)
  ctx.lineTo(c.x + def.width - 10, barY)
  ctx.stroke()
  ctx.restore()
  for (const pin of def.pins) {
    ctx.beginPath()
    ctx.moveTo(c.x + pin.dx, c.y + pin.dy)
    ctx.lineTo(c.x + pin.dx, barY)
    ctx.stroke()
  }
}

export function drawComponentSymbol(
  ctx: CanvasRenderingContext2D,
  component: Component,
  resolve?: PinValueResolver,
  busResolve?: (pinId: string) => string | undefined
): void {
  const def = defOf(component)
  const { x, y } = component
  const { width: w, height: h } = def

  ctx.strokeStyle = COLORS.gate
  ctx.fillStyle = COLORS.gate

  switch (familyOf(component.type)) {
    case 'and':
      drawAnd(ctx, x, y, w, h, false)
      break
    case 'nand':
      drawAnd(ctx, x, y, w, h, true)
      break
    case 'or':
      drawOr(ctx, x, y, w, h, false, false)
      drawInputStubs(ctx, component, def, w * 0.18)
      break
    case 'nor':
      drawOr(ctx, x, y, w, h, true, false)
      drawInputStubs(ctx, component, def, w * 0.18)
      break
    case 'xor':
      drawOr(ctx, x, y, w, h, false, true)
      drawInputStubs(ctx, component, def, w * 0.18)
      break
    case 'xnor':
      drawOr(ctx, x, y, w, h, true, true)
      drawInputStubs(ctx, component, def, w * 0.18)
      break
    case 'not':
      drawNot(ctx, x, y, w, h)
      break
    case 'switch': {
      const on = resolve?.(makePinId(component.id, 'out')) === LogicValue.ONE
      drawSwitch(ctx, x, y, w, h, on)
      break
    }
    case 'probe':
      drawProbe(ctx, x, y, w, h)
      break
    case 'clock':
      drawWaveBox(ctx, x, y, w, h, true)
      break
    case 'input':
      drawWaveBox(ctx, x, y, w, h, false)
      break
    case 'tristate':
      drawTristate(ctx, component)
      break
    case 'vcc':
      drawVcc(ctx, x, y)
      break
    case 'ground':
      drawGround(ctx, x, y)
      break
    case 'sevenSegment':
      drawSevenSegment(ctx, component, resolve)
      break
    case 'busEnd':
      drawBusEnd(ctx, component, busResolve)
      break
    case 'busBar':
      drawBusBar(ctx, component)
      break
    case 'stateMachine': {
      drawLabeledBox(ctx, component, def)
      // Current state readout box on the right side.
      const state = busResolve?.(makePinId(component.id, 'state')) ?? '?'
      const bx = x + w - 34
      const by = y + 10
      ctx.strokeRect(bx, by, 24, 20)
      ctx.fillStyle = COLORS.gate
      ctx.font = FONTS.deviceLabel
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(state, bx + 12, by + 10)
      ctx.textAlign = 'left'
      ctx.textBaseline = 'alphabetic'
      break
    }
    case 'checker': {
      drawLabeledBox(ctx, component, def)
      const result = busResolve?.(makePinId(component.id, 'result')) ?? ''
      if (result) {
        ctx.fillStyle = result === 'PASS' ? '#1a7f37' : result === 'FAIL' ? '#d12b2b' : COLORS.gate
        ctx.font = FONTS.value
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillText(result, x + w / 2, y + h / 2 + 6)
        ctx.textAlign = 'left'
        ctx.textBaseline = 'alphabetic'
      }
      break
    }
    case 'box':
      drawLabeledBox(ctx, component, def)
      break
  }
}
