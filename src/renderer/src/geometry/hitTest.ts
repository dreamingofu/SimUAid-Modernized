// Hit-testing in world coordinates: figure out what is under the pointer.

import type { Component, Netlist } from '../model/types'
import { defOf } from '../model/partDefinitions'
import { segmentsToPoints } from './wireRouting'
import type { Bounds, Point } from './coords'

/** Vertical gap (world px) between a component's top edge and its label. */
export const DEVICE_LABEL_OFFSET = 8
const LABEL_CHAR_WIDTH = 7
const LABEL_HEIGHT = 14

export function hitComponent(netlist: Netlist, p: Point): Component | null {
  // Iterate last-to-first so the most recently added (top-most) wins.
  for (let i = netlist.components.length - 1; i >= 0; i--) {
    const c = netlist.components[i]
    const def = defOf(c)
    if (p.x >= c.x && p.x <= c.x + def.width && p.y >= c.y && p.y <= c.y + def.height) {
      return c
    }
  }
  return null
}

export function hitDeviceLabel(netlist: Netlist, p: Point): Component | null {
  for (let i = netlist.components.length - 1; i >= 0; i--) {
    const c = netlist.components[i]
    if (!c.label) continue
    const def = defOf(c)
    const w = Math.max(20, c.label.length * LABEL_CHAR_WIDTH)
    const cx = c.x + def.width / 2
    const top = c.y - DEVICE_LABEL_OFFSET - LABEL_HEIGHT
    if (p.x >= cx - w / 2 && p.x <= cx + w / 2 && p.y >= top && p.y <= top + LABEL_HEIGHT) {
      return c
    }
  }
  return null
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

export interface WireHit {
  wireId: string
  segIndex: number
}

export function hitWire(netlist: Netlist, p: Point, tolerance: number): WireHit | null {
  for (let i = netlist.wires.length - 1; i >= 0; i--) {
    const wire = netlist.wires[i]
    const pts = segmentsToPoints(wire.segments)
    for (let s = 0; s < pts.length - 1; s++) {
      if (distToSegment(p, pts[s], pts[s + 1]) <= tolerance) {
        return { wireId: wire.id, segIndex: s }
      }
    }
  }
  return null
}

/** World-space bounding box of every component (incl. footprint) and wire point. */
export function componentsBounds(netlist: Netlist): Bounds | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let any = false

  for (const c of netlist.components) {
    const def = defOf(c)
    minX = Math.min(minX, c.x)
    minY = Math.min(minY, c.y)
    maxX = Math.max(maxX, c.x + def.width)
    maxY = Math.max(maxY, c.y + def.height)
    any = true
  }
  for (const w of netlist.wires) {
    for (const pt of segmentsToPoints(w.segments)) {
      minX = Math.min(minX, pt.x)
      minY = Math.min(minY, pt.y)
      maxX = Math.max(maxX, pt.x)
      maxY = Math.max(maxY, pt.y)
      any = true
    }
  }
  return any ? { minX, minY, maxX, maxY } : null
}
