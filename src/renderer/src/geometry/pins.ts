// Absolute pin geometry: turns a component's relative pin definitions into world
// coordinates and provides lookup/hit helpers used by wiring and rendering.

import { makePinId, parsePinId, type Component, type Netlist, type PinId } from '../model/types'
import { defOf, type PinRole } from '../model/partDefinitions'
import type { Point } from './coords'

export interface AbsolutePin {
  pinId: PinId
  componentId: string
  name: string
  role: PinRole
  x: number
  y: number
}

/** Which edge a pin sits on, derived from its offset within the part footprint. */
export function pinFacing(component: Component, pinName: string): 'left' | 'right' | 'up' | 'down' {
  const def = defOf(component)
  const pin = def.pins.find((p) => p.name === pinName)
  if (!pin) return 'left'
  if (pin.dx <= 0) return 'left'
  if (pin.dx >= def.width) return 'right'
  if (pin.dy <= 0) return 'up'
  return 'down'
}

export function getAbsolutePins(component: Component): AbsolutePin[] {
  const def = defOf(component)
  return def.pins.map((pin) => ({
    pinId: makePinId(component.id, pin.name),
    componentId: component.id,
    name: pin.name,
    role: pin.role,
    x: component.x + pin.dx,
    y: component.y + pin.dy
  }))
}

export function getAllPins(netlist: Netlist): AbsolutePin[] {
  return netlist.components.flatMap(getAbsolutePins)
}

export function getPinById(netlist: Netlist, pinId: PinId): AbsolutePin | null {
  const { componentId, pinName } = parsePinId(pinId)
  const component = netlist.components.find((c) => c.id === componentId)
  if (!component) return null
  const pins = getAbsolutePins(component)
  return pins.find((p) => p.name === pinName) ?? null
}

/** Finds the pin nearest to `worldPt` within `tolerance` world px, if any. */
export function findPinAt(netlist: Netlist, worldPt: Point, tolerance: number): AbsolutePin | null {
  let best: AbsolutePin | null = null
  let bestDist = tolerance
  for (const pin of getAllPins(netlist)) {
    const d = Math.hypot(pin.x - worldPt.x, pin.y - worldPt.y)
    if (d <= bestDist) {
      best = pin
      bestDist = d
    }
  }
  return best
}
