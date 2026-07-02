// Net resolution. Groups pins and wires into electrically-connected nets using a
// union-find over coincident coordinates, then merges pins that share a label
// (virtual connections — connected with no drawn wire). The simulator (Phase 3)
// and the editor's net highlighting/junction dots both consume this.

import type { Netlist, PinId } from '../model/types'
import { getAllPins } from '../geometry/pins'
import { segmentsToPoints } from '../geometry/wireRouting'
import type { Point } from '../geometry/coords'

export interface Net {
  id: string
  pinIds: PinId[]
  wireIds: string[]
}

class DisjointSet {
  private parent = new Map<string, string>()

  find(x: string): string {
    if (this.parent.get(x) === undefined) {
      this.parent.set(x, x)
      return x
    }
    let node = x
    while (this.parent.get(node) !== node) {
      const parent = this.parent.get(node) as string
      const grandparent = this.parent.get(parent) as string
      this.parent.set(node, grandparent) // path halving
      node = parent
    }
    return node
  }

  union(a: string, b: string): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(ra, rb)
  }
}

/** Quantized coordinate key so coincident endpoints/pins land in the same bucket. */
function coordKey(p: Point): string {
  return `C:${Math.round(p.x)},${Math.round(p.y)}`
}

/** The effective label of a pin: its explicit pin label if set, else ''. */
function pinLabelFor(netlist: Netlist, pinId: PinId, pinName?: string): string {
  const componentId = pinId.slice(0, pinId.indexOf('#'))
  const component = netlist.components.find((c) => c.id === componentId)
  if (!component || !pinName) return ''
  return component.pinLabels[pinName] ?? ''
}

export function resolveNets(netlist: Netlist): Net[] {
  const dsu = new DisjointSet()
  const pins = getAllPins(netlist)

  // 1. Pins connect to whatever shares their coordinate.
  for (const pin of pins) {
    dsu.union(`P:${pin.pinId}`, coordKey(pin))
  }

  // 2. Each wire ties all of its own points together, and any pin/other wire at
  //    a shared coordinate joins via the coord key.
  for (const wire of netlist.wires) {
    const wireKey = `W:${wire.id}`
    for (const pt of segmentsToPoints(wire.segments)) {
      dsu.union(wireKey, coordKey(pt))
    }
  }

  // 3. Virtual connections: pins sharing the same non-empty label are merged.
  const byLabel = new Map<string, PinId[]>()
  for (const pin of pins) {
    const label = pinLabelFor(netlist, pin.pinId, pin.name)
    if (!label) continue
    const list = byLabel.get(label) ?? []
    list.push(pin.pinId)
    byLabel.set(label, list)
  }
  for (const group of byLabel.values()) {
    for (let i = 1; i < group.length; i++) {
      dsu.union(`P:${group[0]}`, `P:${group[i]}`)
    }
  }

  // Collect roots -> nets.
  const nets = new Map<string, Net>()
  const ensure = (root: string): Net => {
    let net = nets.get(root)
    if (!net) {
      net = { id: root, pinIds: [], wireIds: [] }
      nets.set(root, net)
    }
    return net
  }
  for (const pin of pins) {
    ensure(dsu.find(`P:${pin.pinId}`)).pinIds.push(pin.pinId)
  }
  for (const wire of netlist.wires) {
    ensure(dsu.find(`W:${wire.id}`)).wireIds.push(wire.id)
  }

  return [...nets.values()]
}

/**
 * Returns labels that appear on two or more OUTPUT pins. Sharing an output label
 * ties outputs together, which is almost always a mistake worth warning about.
 */
export function findDuplicateOutputLabels(netlist: Netlist): string[] {
  const counts = new Map<string, number>()
  for (const pin of getAllPins(netlist)) {
    if (pin.role !== 'output') continue
    const label = pinLabelFor(netlist, pin.pinId, pin.name)
    if (!label) continue
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([label]) => label)
}

export function findNetContaining(
  nets: Net[],
  ref: { wireId?: string; pinId?: PinId }
): Net | null {
  for (const net of nets) {
    if (ref.wireId && net.wireIds.includes(ref.wireId)) return net
    if (ref.pinId && net.pinIds.includes(ref.pinId)) return net
  }
  return null
}

/** Points where more than two wire endpoints/pins coincide (draw a junction dot). */
export function junctionPoints(netlist: Netlist): Point[] {
  const counts = new Map<string, { p: Point; n: number }>()
  const bump = (p: Point): void => {
    const key = `${Math.round(p.x)},${Math.round(p.y)}`
    const entry = counts.get(key)
    if (entry) entry.n += 1
    else counts.set(key, { p, n: 1 })
  }
  for (const wire of netlist.wires) {
    const pts = segmentsToPoints(wire.segments)
    // Count every endpoint of every segment (interior points counted twice — once
    // per adjoining segment — which is expected for a straight pass-through).
    for (let i = 0; i < pts.length; i++) {
      // endpoints of this polyline contribute once; interior contribute twice
      bump(pts[i])
      if (i > 0 && i < pts.length - 1) bump(pts[i])
    }
  }
  const result: Point[] = []
  for (const { p, n } of counts.values()) {
    if (n > 2) result.push(p)
  }
  return result
}
