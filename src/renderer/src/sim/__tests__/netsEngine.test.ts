// Net resolution and the engine core.
//
// Covers netlist/nets.ts (union-find over coincident coordinates, virtual pin
// labels, junction dots), sim/graph.ts (nets -> SimGraph: drivers, readers,
// width, bits, delay clamp), sim/eventHeap.ts (ordering by (time, seq)) and
// sim/engine.ts (same-instant batching, inertial delay, oscillation halt, reset,
// CHANGE mode, readout partitioning).
//
// Local helpers only (the shared harness has no raw-netlist builder): `rawNetlist`
// /`wireOf` build netlists with hand-placed coordinates so wires can be drawn to
// points the harness would never produce, `conductorsAt` is an independent
// re-implementation of the manual's junction rule, and `wiredResolve` is an
// independent reference for std_logic net resolution.

import { describe, expect, it } from 'vitest'
import {
  ComponentType,
  LogicValue,
  makePinId,
  type Component,
  type Netlist,
  type PinId,
  type Wire
} from '../../model/types'
import { createEmptyNetlist } from '../../serialization/ckt'
import { defOf, effectiveBits, type PinRole } from '../../model/partDefinitions'
import { getAbsolutePins, getAllPins } from '../../geometry/pins'
import { segmentsToPoints } from '../../geometry/wireRouting'
import { findDuplicateOutputLabels, junctionPoints, resolveNets, type Net } from '../../netlist/nets'
import { buildSimGraph } from '../graph'
import { EventHeap, type SimEvent } from '../eventHeap'
import { MAX_EVENTS_PER_RUN, Simulator } from '../engine'
import { useCircuitStore } from '../../store/circuitStore'
import { Circuit, CircuitBuilder, p } from './harness'

const { ZERO, ONE, X, Z } = LogicValue

// ---------------------------------------------------------------- helpers

/** A component at an exact position (the harness places on its own grid). */
function comp(id: string, type: ComponentType, x: number, y: number, extra: Partial<Component> = {}): Component {
  return { id, type, x, y, rotation: 0, label: '', pinLabels: {}, delay: 1, ...extra }
}

/** A wire through the given polyline; endpoint pin ids are metadata only. */
function wireOf(
  id: string,
  pts: [number, number][],
  fromPinId: PinId | null = null,
  toPinId: PinId | null = null
): Wire {
  const segments = []
  for (let i = 0; i + 1 < pts.length; i++) {
    segments.push({ x1: pts[i][0], y1: pts[i][1], x2: pts[i + 1][0], y2: pts[i + 1][1] })
  }
  return { id, segments, fromPinId, toPinId, netId: '' }
}

function rawNetlist(components: Component[], wires: Wire[] = []): Netlist {
  const netlist = createEmptyNetlist('raw')
  netlist.components.push(...components)
  netlist.wires.push(...wires)
  return netlist
}

function pinXY(component: Component, name: string): { x: number; y: number } {
  const pin = getAbsolutePins(component).find((q) => q.name === name)
  if (!pin) throw new Error(`no pin ${name} on ${component.id}`)
  return { x: pin.x, y: pin.y }
}

function netOfPin(nets: Net[], pinId: PinId): Net {
  const net = nets.find((n) => n.pinIds.includes(pinId))
  if (!net) throw new Error(`pin ${pinId} is on no net`)
  return net
}

function sameNet(nets: Net[], a: PinId, b: PinId): boolean {
  return netOfPin(nets, a) === netOfPin(nets, b)
}

function netOfWire(nets: Net[], wireId: string): Net {
  const net = nets.find((n) => n.wireIds.includes(wireId))
  if (!net) throw new Error(`wire ${wireId} is on no net`)
  return net
}

/**
 * Independent count of the conductors meeting at a point, per the manual
 * (§1.2.4): "a dot is drawn at intersections of more than two segments or pins".
 * A polyline's interior point joins two segments, so it counts twice.
 */
function conductorsAt(netlist: Netlist, x: number, y: number): number {
  let n = 0
  for (const pin of getAllPins(netlist)) {
    if (Math.round(pin.x) === x && Math.round(pin.y) === y) n++
  }
  for (const wire of netlist.wires) {
    const pts = segmentsToPoints(wire.segments)
    for (let i = 0; i < pts.length; i++) {
      if (Math.round(pts[i].x) !== x || Math.round(pts[i].y) !== y) continue
      n += i > 0 && i < pts.length - 1 ? 2 : 1
    }
  }
  return n
}

function hasDotAt(netlist: Netlist, x: number, y: number): boolean {
  return junctionPoints(netlist).some((q) => Math.round(q.x) === x && Math.round(q.y) === y)
}

/** Independent reference for wired-net resolution (spec decision 3). */
function wiredResolve(drivers: LogicValue[]): LogicValue {
  let v: LogicValue = Z
  for (const d of drivers) {
    if (d === Z) continue
    if (v === Z) v = d
    else if (v !== d) v = X
  }
  return v
}

const trace = (c: Circuit, probeId: string): [number, LogicValue][] =>
  c.sim
    .getWaveforms()
    .find((w) => w.probeId === probeId)!
    .samples.map((s) => [s.t, s.v])

const hexTrace = (c: Circuit, probeId: string): [number, string][] =>
  c.sim
    .getWaveforms()
    .find((w) => w.probeId === probeId)!
    .samples.map((s) => [s.t, s.hex ?? ''])

/** Deterministic LCG so property-test failures are reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

const ALL_TYPES = Object.values(ComponentType)

const SINK_ROLES: PinRole[] = ['input', 'clock', 'preset', 'clear']

// ================================================================ nets.ts

describe('resolveNets: wires drawn between pins', () => {
  const sw = comp('sw', ComponentType.SWITCH, 0, 0) // out at (40,20)
  const not = comp('n', ComponentType.NOT, 200, 0) // in1 at (200,20), out at (260,20)

  it('a single wire unions the two pins it was drawn between', () => {
    const netlist = rawNetlist(
      [sw, not],
      [wireOf('w0', [[40, 20], [200, 20]], p('sw', 'out'), p('n', 'in1'))]
    )
    const nets = resolveNets(netlist)
    expect(sameNet(nets, p('sw', 'out'), p('n', 'in1'))).toBe(true)
    expect(netOfWire(nets, 'w0')).toBe(netOfPin(nets, p('sw', 'out')))
  })

  it('the unwired pins of the same components stay on their own nets', () => {
    const netlist = rawNetlist(
      [sw, not],
      [wireOf('w0', [[40, 20], [200, 20]], p('sw', 'out'), p('n', 'in1'))]
    )
    const nets = resolveNets(netlist)
    expect(nets).toHaveLength(2)
    expect(netOfPin(nets, p('n', 'out')).pinIds).toEqual([p('n', 'out')])
  })

  it('connectivity comes from geometry, not from fromPinId/toPinId', () => {
    // Same wire, both endpoint references null: still connects.
    const netlist = rawNetlist([sw, not], [wireOf('w0', [[40, 20], [200, 20]])])
    const nets = resolveNets(netlist)
    expect(sameNet(nets, p('sw', 'out'), p('n', 'in1'))).toBe(true)
  })

  it('a wire whose endpoint references are wrong still follows its geometry', () => {
    // Claims to run to n#out but is drawn to n#in1.
    const netlist = rawNetlist(
      [sw, not],
      [wireOf('w0', [[40, 20], [200, 20]], p('sw', 'out'), p('n', 'out'))]
    )
    const nets = resolveNets(netlist)
    expect(sameNet(nets, p('sw', 'out'), p('n', 'in1'))).toBe(true)
    expect(sameNet(nets, p('sw', 'out'), p('n', 'out'))).toBe(false)
  })

  it('a dangling wire touching nothing forms a net of its own', () => {
    const netlist = rawNetlist([sw], [wireOf('w0', [[500, 500], [600, 500]])])
    const nets = resolveNets(netlist)
    expect(nets).toHaveLength(2)
    expect(netOfWire(nets, 'w0').pinIds).toEqual([])
  })

  it('two wires sharing an endpoint chain their pins into one net', () => {
    const netlist = rawNetlist(
      [sw, not],
      [
        wireOf('w0', [[40, 20], [120, 20]], p('sw', 'out'), null),
        wireOf('w1', [[120, 20], [200, 20]], null, p('n', 'in1'))
      ]
    )
    const nets = resolveNets(netlist)
    expect(sameNet(nets, p('sw', 'out'), p('n', 'in1'))).toBe(true)
    expect(netOfPin(nets, p('sw', 'out')).wireIds.sort()).toEqual(['w0', 'w1'])
  })

  it('a chain of five wires unions both ends', () => {
    const wires = [
      wireOf('w0', [[40, 20], [100, 20]]),
      wireOf('w1', [[100, 20], [100, 80]]),
      wireOf('w2', [[100, 80], [160, 80]]),
      wireOf('w3', [[160, 80], [160, 20]]),
      wireOf('w4', [[160, 20], [200, 20]])
    ]
    const nets = resolveNets(rawNetlist([sw, not], wires))
    expect(sameNet(nets, p('sw', 'out'), p('n', 'in1'))).toBe(true)
    expect(netOfPin(nets, p('sw', 'out')).wireIds).toHaveLength(5)
  })

  it('a broken chain (a 1 px gap) leaves the two halves on separate nets', () => {
    const wires = [
      wireOf('w0', [[40, 20], [120, 20]]),
      wireOf('w1', [[121, 20], [200, 20]])
    ]
    const nets = resolveNets(rawNetlist([sw, not], wires))
    expect(sameNet(nets, p('sw', 'out'), p('n', 'in1'))).toBe(false)
  })

  it('coordinates are rounded, so sub-pixel differences still union', () => {
    const wires = [
      wireOf('w0', [[40, 20], [120.4, 20]]),
      wireOf('w1', [[119.8, 20], [200, 20]])
    ]
    const nets = resolveNets(rawNetlist([sw, not], wires))
    expect(sameNet(nets, p('sw', 'out'), p('n', 'in1'))).toBe(true)
  })

  it('one wire touching three pins puts all three on one net', () => {
    // Probe pin sits exactly on the wire's corner.
    const pr = comp('pr', ComponentType.PROBE, 120, 60) // in at (120,80)
    const target = comp('n2', ComponentType.NOT, 200, 60) // in1 at (200,80)
    const netlist = rawNetlist(
      [sw, pr, target],
      [wireOf('w0', [[40, 20], [120, 20], [120, 80], [200, 80]], p('sw', 'out'), p('n2', 'in1'))]
    )
    const nets = resolveNets(netlist)
    expect(sameNet(nets, p('sw', 'out'), p('pr', 'in'))).toBe(true)
    expect(sameNet(nets, p('sw', 'out'), p('n2', 'in1'))).toBe(true)
  })

  it('a wire only passing over a pin (no polyline point there) does not connect it', () => {
    const pr = comp('pr', ComponentType.PROBE, 100, 0) // in at (100,20), mid-segment
    const netlist = rawNetlist(
      [sw, not, pr],
      [wireOf('w0', [[40, 20], [200, 20]], p('sw', 'out'), p('n', 'in1'))]
    )
    const nets = resolveNets(netlist)
    expect(sameNet(nets, p('sw', 'out'), p('n', 'in1'))).toBe(true)
    expect(sameNet(nets, p('sw', 'out'), p('pr', 'in'))).toBe(false)
    expect(netOfPin(nets, p('pr', 'in')).pinIds).toEqual([p('pr', 'in')])
  })

  it('two pins at the same coordinate are shorted with no wire at all', () => {
    // NOT at x=0 has out at (60,20); NOT at x=60 has in1 at (60,20).
    const a = comp('a', ComponentType.NOT, 0, 0)
    const b = comp('b', ComponentType.NOT, 60, 0)
    expect(pinXY(a, 'out')).toEqual(pinXY(b, 'in1'))
    const nets = resolveNets(rawNetlist([a, b]))
    expect(sameNet(nets, p('a', 'out'), p('b', 'in1'))).toBe(true)
  })

  it('two shorted pins simulate as one net', () => {
    const c = new CircuitBuilder()
      .switch('sw', ONE, { x: 0, y: 0 }) // out at (40,20)
      .add('n', ComponentType.NOT, { x: 40, y: 0 }) // in1 at (40,20)
      .probe('pr', { x: 100, y: 0 }) // in at (100,20) = NOT out
      .build()
    expect(c.pin(p('n', 'in1'))).toBe(ONE)
    expect(c.pin(p('pr', 'in'))).toBe(ZERO)
    c.set('sw', ZERO)
    expect(c.pin(p('pr', 'in'))).toBe(ONE)
  })

  it('three pins at the same coordinate are all shorted together', () => {
    const a = comp('a', ComponentType.NOT, 0, 0) // out (60,20)
    const b = comp('b', ComponentType.NOT, 60, 0) // in1 (60,20)
    const c = comp('c', ComponentType.PROBE, 60, 0) // in (60,20)
    const nets = resolveNets(rawNetlist([a, b, c]))
    expect(netOfPin(nets, p('a', 'out')).pinIds.sort()).toEqual(
      [p('a', 'out'), p('b', 'in1'), p('c', 'in')].sort()
    )
  })

  it('every pin of every component appears on exactly one net', () => {
    const components = ALL_TYPES.map((type, i) => comp(`c${i}`, type, i * 1000, 0, { bits: 4 }))
    const netlist = rawNetlist(components)
    const nets = resolveNets(netlist)
    const seen = new Map<PinId, number>()
    for (const net of nets) for (const pinId of net.pinIds) seen.set(pinId, (seen.get(pinId) ?? 0) + 1)
    for (const pin of getAllPins(netlist)) expect(seen.get(pin.pinId)).toBe(1)
    expect([...seen.keys()]).toHaveLength(getAllPins(netlist).length)
  })

  it('unconnected pins each get their own singleton net', () => {
    const netlist = rawNetlist([comp('ff', ComponentType.D_FLIPFLOP, 0, 0)])
    const nets = resolveNets(netlist)
    expect(nets).toHaveLength(6)
    for (const net of nets) expect(net.pinIds).toHaveLength(1)
  })
})

describe('resolveNets: T-junctions and crossings', () => {
  it('a wire ending in the middle of another wire segment is NOT connected and gets no dot', () => {
    const netlist = rawNetlist(
      [],
      [wireOf('w0', [[0, 0], [200, 0]]), wireOf('w1', [[100, 0], [100, 100]])]
    )
    const nets = resolveNets(netlist)
    expect(netOfWire(nets, 'w0')).not.toBe(netOfWire(nets, 'w1'))
    // w0 has no vertex there, so only w1's endpoint meets the point.
    expect(conductorsAt(netlist, 100, 0)).toBe(1)
    expect(hasDotAt(netlist, 100, 0)).toBe(false)
  })

  it('a wire ending on another wire\'s CORNER is connected and does get a dot', () => {
    const netlist = rawNetlist(
      [],
      [wireOf('w0', [[0, 0], [100, 0], [100, -50]]), wireOf('w1', [[100, 0], [100, 100]])]
    )
    const nets = resolveNets(netlist)
    expect(netOfWire(nets, 'w0')).toBe(netOfWire(nets, 'w1'))
    expect(conductorsAt(netlist, 100, 0)).toBe(3)
    expect(hasDotAt(netlist, 100, 0)).toBe(true)
  })

  it('two wires crossing without a shared point are neither connected nor dotted', () => {
    const netlist = rawNetlist(
      [],
      [wireOf('w0', [[0, 0], [200, 0]]), wireOf('w1', [[100, -50], [100, 50]])]
    )
    const nets = resolveNets(netlist)
    expect(netOfWire(nets, 'w0')).not.toBe(netOfWire(nets, 'w1'))
    expect(junctionPoints(netlist)).toEqual([])
  })

  it('two wires meeting end to end are connected but need no dot', () => {
    const netlist = rawNetlist([], [wireOf('w0', [[0, 0], [100, 0]]), wireOf('w1', [[100, 0], [200, 0]])])
    const nets = resolveNets(netlist)
    expect(netOfWire(nets, 'w0')).toBe(netOfWire(nets, 'w1'))
    expect(conductorsAt(netlist, 100, 0)).toBe(2)
    expect(hasDotAt(netlist, 100, 0)).toBe(false)
  })

  it('three wire endpoints at one point are connected and dotted', () => {
    const netlist = rawNetlist(
      [],
      [
        wireOf('w0', [[0, 0], [100, 0]]),
        wireOf('w1', [[100, 0], [200, 0]]),
        wireOf('w2', [[100, 0], [100, 100]])
      ]
    )
    const nets = resolveNets(netlist)
    expect(nets).toHaveLength(1)
    expect(conductorsAt(netlist, 100, 0)).toBe(3)
    expect(hasDotAt(netlist, 100, 0)).toBe(true)
  })

  it('four wire endpoints at one point produce exactly one junction point', () => {
    const netlist = rawNetlist(
      [],
      [
        wireOf('w0', [[0, 0], [100, 0]]),
        wireOf('w1', [[100, 0], [200, 0]]),
        wireOf('w2', [[100, 0], [100, 100]]),
        wireOf('w3', [[100, 0], [100, -100]])
      ]
    )
    expect(junctionPoints(netlist)).toHaveLength(1)
    expect(hasDotAt(netlist, 100, 0)).toBe(true)
  })

  it('a straight pass-through corner of a single wire is not a junction', () => {
    const netlist = rawNetlist([], [wireOf('w0', [[0, 0], [100, 0], [100, 100]])])
    expect(junctionPoints(netlist)).toEqual([])
  })

  it('a wire that doubles back on its own point is not reported twice', () => {
    const netlist = rawNetlist([], [wireOf('w0', [[0, 0], [100, 0], [100, 100], [100, 0]])])
    // The point (100,0) carries an interior point (2) plus an endpoint (1).
    expect(conductorsAt(netlist, 100, 0)).toBe(3)
    expect(junctionPoints(netlist).filter((q) => q.x === 100 && q.y === 0)).toHaveLength(1)
  })

  it.each([
    ['isolated pin', 0],
    ['pin plus one wire end', 1]
  ])('%s never gets a junction dot', (_label, wireCount) => {
    const pr = comp('pr', ComponentType.PROBE, 0, 0) // in at (0,20)
    const wires = wireCount === 1 ? [wireOf('w0', [[0, 20], [100, 20]])] : []
    const netlist = rawNetlist([pr], wires)
    expect(conductorsAt(netlist, 0, 20)).toBe(1 + wireCount)
    expect(hasDotAt(netlist, 0, 20)).toBe(false)
  })

  // Manual §1.2.4: "A dark filled circle (a dot) is drawn at intersections of
  // more than two segments or pins to indicate a connection."
  it('a pin where two wires end is a connection of three conductors and needs a dot', () => {
    const pr = comp('pr', ComponentType.PROBE, 0, 0) // in at (0,20)
    const netlist = rawNetlist(
      [pr],
      [wireOf('w0', [[0, 20], [100, 20]]), wireOf('w1', [[0, 20], [0, 120]])]
    )
    const nets = resolveNets(netlist)
    expect(conductorsAt(netlist, 0, 20)).toBe(3)
    expect(netOfWire(nets, 'w0')).toBe(netOfWire(nets, 'w1'))
    expect(hasDotAt(netlist, 0, 20)).toBe(true)
  })

  it('a wire corner that silently shorts a pin needs a dot', () => {
    // The clock-divider class of bug: the corner lands on a pin and shorts it.
    const pr = comp('pr', ComponentType.PROBE, 100, 0) // in at (100,20)
    const netlist = rawNetlist([pr], [wireOf('w0', [[0, 20], [100, 20], [100, 120]])])
    expect(conductorsAt(netlist, 100, 20)).toBe(3)
    expect(netOfPin(resolveNets(netlist), p('pr', 'in')).wireIds).toEqual(['w0'])
    expect(hasDotAt(netlist, 100, 20)).toBe(true)
  })

  it('junction dots and connectivity agree for every point of a mixed netlist', () => {
    const pr = comp('pr', ComponentType.PROBE, 300, 0)
    const netlist = rawNetlist(
      [pr],
      [
        wireOf('w0', [[0, 0], [200, 0]]),
        wireOf('w1', [[100, 0], [100, 100]]), // mid-segment T: not connected
        wireOf('w2', [[0, 0], [0, 100]]), // shares an endpoint with w0
        wireOf('w3', [[0, 0], [-100, 0]]) // third wire at that endpoint
      ]
    )
    // Only points where more than two conductors coincide are dots.
    const points = [
      [0, 0],
      [100, 0],
      [200, 0],
      [100, 100],
      [300, 20]
    ]
    for (const [x, y] of points) {
      expect([x, y, hasDotAt(netlist, x, y)]).toEqual([x, y, conductorsAt(netlist, x, y) > 2])
    }
  })
})

describe('resolveNets: degenerate inputs', () => {
  it('an empty netlist has no nets and no junctions', () => {
    const netlist = rawNetlist([])
    expect(resolveNets(netlist)).toEqual([])
    expect(junctionPoints(netlist)).toEqual([])
    expect(findDuplicateOutputLabels(netlist)).toEqual([])
  })

  it('a wire with no segments joins nothing', () => {
    const netlist = rawNetlist([comp('sw', ComponentType.SWITCH, 0, 0)], [wireOf('w0', [])])
    const nets = resolveNets(netlist)
    expect(netOfWire(nets, 'w0').pinIds).toEqual([])
    expect(nets).toHaveLength(2)
  })

  it('a wire whose two ends are the same pin is a single-pin net', () => {
    const netlist = rawNetlist(
      [comp('sw', ComponentType.SWITCH, 0, 0)],
      [wireOf('w0', [[40, 20], [40, 20]], p('sw', 'out'), p('sw', 'out'))]
    )
    const nets = resolveNets(netlist)
    expect(nets).toHaveLength(1)
    expect(nets[0].pinIds).toEqual([p('sw', 'out')])
  })

  it('a pin label naming a pin the part does not have is ignored', () => {
    const netlist = rawNetlist([
      comp('a', ComponentType.NOT, 0, 0, { pinLabels: { nosuch: 'L', out: 'L' } }),
      comp('b', ComponentType.NOT, 0, 500, { pinLabels: { in1: 'L' } })
    ])
    const nets = resolveNets(netlist)
    expect(sameNet(nets, p('a', 'out'), p('b', 'in1'))).toBe(true)
    expect(nets.flatMap((n) => n.pinIds)).toHaveLength(4)
  })

  it('resolveNets is deterministic: the same netlist gives the same partition twice', () => {
    const netlist = rawNetlist(
      [comp('sw', ComponentType.SWITCH, 0, 0), comp('n', ComponentType.NOT, 200, 0)],
      [wireOf('w0', [[40, 20], [200, 20]], p('sw', 'out'), p('n', 'in1'))]
    )
    const shape = (nets: Net[]): string[] =>
      nets.map((n) => [...n.pinIds].sort().join('|') + '/' + [...n.wireIds].sort().join('|')).sort()
    expect(shape(resolveNets(netlist))).toEqual(shape(resolveNets(netlist)))
  })
})

describe('resolveNets: pin labels as virtual connections', () => {
  function twoNots(labelA?: string, labelB?: string): Netlist {
    return rawNetlist([
      comp('a', ComponentType.NOT, 0, 0, { pinLabels: labelA ? { out: labelA } : {} }),
      comp('b', ComponentType.NOT, 0, 500, { pinLabels: labelB ? { in1: labelB } : {} })
    ])
  }

  it('two pins with the same label are on one net', () => {
    const nets = resolveNets(twoNots('sig', 'sig'))
    expect(sameNet(nets, p('a', 'out'), p('b', 'in1'))).toBe(true)
  })

  it('two pins with different labels stay separate', () => {
    const nets = resolveNets(twoNots('sig', 'other'))
    expect(sameNet(nets, p('a', 'out'), p('b', 'in1'))).toBe(false)
  })

  it('labels are case sensitive', () => {
    const nets = resolveNets(twoNots('Sig', 'sig'))
    expect(sameNet(nets, p('a', 'out'), p('b', 'in1'))).toBe(false)
  })

  it('an empty label never connects anything', () => {
    const nets = resolveNets(twoNots('', ''))
    expect(sameNet(nets, p('a', 'out'), p('b', 'in1'))).toBe(false)
    expect(nets).toHaveLength(4)
  })

  it('unlabeled pins (no pinLabels entry) never connect', () => {
    const nets = resolveNets(twoNots())
    expect(nets).toHaveLength(4)
  })

  it('a label shared by three pins makes one net of three', () => {
    const netlist = rawNetlist([
      comp('a', ComponentType.NOT, 0, 0, { pinLabels: { out: 'bus' } }),
      comp('b', ComponentType.NOT, 0, 500, { pinLabels: { in1: 'bus' } }),
      comp('c', ComponentType.PROBE, 0, 1000, { pinLabels: { in: 'bus' } })
    ])
    const nets = resolveNets(netlist)
    expect(netOfPin(nets, p('a', 'out')).pinIds.sort()).toEqual(
      [p('a', 'out'), p('b', 'in1'), p('c', 'in')].sort()
    )
  })

  it('a label shared by five pins makes one net of five', () => {
    const components = [0, 1, 2, 3, 4].map((i) =>
      comp(`c${i}`, ComponentType.PROBE, 0, i * 500, { pinLabels: { in: 'L' } })
    )
    const nets = resolveNets(rawNetlist(components))
    expect(nets).toHaveLength(1)
    expect(nets[0].pinIds).toHaveLength(5)
  })

  it('two pins of the SAME component sharing a label are connected', () => {
    const netlist = rawNetlist([comp('n', ComponentType.NOT, 0, 0, { pinLabels: { in1: 'loop', out: 'loop' } })])
    const nets = resolveNets(netlist)
    expect(nets).toHaveLength(1)
    expect(sameNet(nets, p('n', 'in1'), p('n', 'out'))).toBe(true)
  })

  it('a label merges two nets that were already wired separately', () => {
    const netlist = rawNetlist(
      [
        comp('sw', ComponentType.SWITCH, 0, 0, { pinLabels: { out: 'S' } }),
        comp('n', ComponentType.NOT, 200, 0),
        comp('pr', ComponentType.PROBE, 0, 500, { pinLabels: { in: 'S' } }),
        comp('pr2', ComponentType.PROBE, 200, 500)
      ],
      [
        wireOf('w0', [[40, 20], [200, 20]], p('sw', 'out'), p('n', 'in1')),
        wireOf('w1', [[0, 520], [200, 520]], p('pr', 'in'), p('pr2', 'in'))
      ]
    )
    const nets = resolveNets(netlist)
    const net = netOfPin(nets, p('sw', 'out'))
    expect(net.pinIds.sort()).toEqual([p('sw', 'out'), p('n', 'in1'), p('pr', 'in'), p('pr2', 'in')].sort())
    expect(net.wireIds.sort()).toEqual(['w0', 'w1'])
  })

  it('labels connect across different component types', () => {
    const netlist = rawNetlist([
      comp('sw', ComponentType.SWITCH, 0, 0, { pinLabels: { out: 'clk' } }),
      comp('ff', ComponentType.D_FLIPFLOP, 0, 500, { pinLabels: { CLK: 'clk' } }),
      comp('reg', ComponentType.N_REGISTER, 0, 1000, { bits: 4, pinLabels: { CLK: 'clk' } })
    ])
    const nets = resolveNets(netlist)
    expect(sameNet(nets, p('sw', 'out'), p('ff', 'CLK'))).toBe(true)
    expect(sameNet(nets, p('sw', 'out'), p('reg', 'CLK'))).toBe(true)
  })

  it('a label on a pin that is also wired keeps the wire in the net', () => {
    const netlist = rawNetlist(
      [
        comp('sw', ComponentType.SWITCH, 0, 0, { pinLabels: { out: 'A' } }),
        comp('n', ComponentType.NOT, 200, 0),
        comp('pr', ComponentType.PROBE, 0, 500, { pinLabels: { in: 'A' } })
      ],
      [wireOf('w0', [[40, 20], [200, 20]], p('sw', 'out'), p('n', 'in1'))]
    )
    const net = netOfPin(resolveNets(netlist), p('pr', 'in'))
    expect(net.wireIds).toEqual(['w0'])
    expect(net.pinIds).toHaveLength(3)
  })

  it('simulates through a three-way label connection', () => {
    const c = new CircuitBuilder()
      .switch('a', ONE)
      .add('n', ComponentType.NOT)
      .probe('pr')
      .label(p('a', 'out'), 'sig')
      .label(p('n', 'in1'), 'sig')
      .label(p('pr', 'in'), 'sig')
      .build()
    expect(c.pin(p('pr', 'in'))).toBe(ONE)
    expect(c.pin(p('n', 'out'))).toBe(ZERO)
    c.set('a', ZERO)
    expect(c.pin(p('pr', 'in'))).toBe(ZERO)
    expect(c.pin(p('n', 'out'))).toBe(ONE)
  })
})

describe('findDuplicateOutputLabels', () => {
  const labeled = (id: string, type: ComponentType, pinLabels: Record<string, string>, y: number): Component =>
    comp(id, type, 0, y, { pinLabels })

  it('reports a label used on two output pins', () => {
    const netlist = rawNetlist([
      labeled('a', ComponentType.NOT, { out: 'Q' }, 0),
      labeled('b', ComponentType.NOT, { out: 'Q' }, 500)
    ])
    expect(findDuplicateOutputLabels(netlist)).toEqual(['Q'])
  })

  it('reports a label used on three output pins exactly once', () => {
    const netlist = rawNetlist([
      labeled('a', ComponentType.NOT, { out: 'Q' }, 0),
      labeled('b', ComponentType.NOT, { out: 'Q' }, 500),
      labeled('c', ComponentType.SWITCH, { out: 'Q' }, 1000)
    ])
    expect(findDuplicateOutputLabels(netlist)).toEqual(['Q'])
  })

  it('does not report a label shared by an output and an input', () => {
    const netlist = rawNetlist([
      labeled('a', ComponentType.NOT, { out: 'Q' }, 0),
      labeled('b', ComponentType.NOT, { in1: 'Q' }, 500)
    ])
    expect(findDuplicateOutputLabels(netlist)).toEqual([])
  })

  it('does not report a label shared by two inputs', () => {
    const netlist = rawNetlist([
      labeled('a', ComponentType.NOT, { in1: 'D' }, 0),
      labeled('b', ComponentType.NOT, { in1: 'D' }, 500)
    ])
    expect(findDuplicateOutputLabels(netlist)).toEqual([])
  })

  it('does not report clock, preset or clear pins as outputs', () => {
    const netlist = rawNetlist([
      labeled('a', ComponentType.D_FLIPFLOP, { CLK: 'C', S: 'P', R: 'R' }, 0),
      labeled('b', ComponentType.D_FLIPFLOP, { CLK: 'C', S: 'P', R: 'R' }, 500)
    ])
    expect(findDuplicateOutputLabels(netlist)).toEqual([])
  })

  it('ignores empty labels', () => {
    const netlist = rawNetlist([
      labeled('a', ComponentType.NOT, { out: '' }, 0),
      labeled('b', ComponentType.NOT, { out: '' }, 500)
    ])
    expect(findDuplicateOutputLabels(netlist)).toEqual([])
  })

  it('reports both labels when two are duplicated', () => {
    const netlist = rawNetlist([
      labeled('a', ComponentType.NOT, { out: 'Q' }, 0),
      labeled('b', ComponentType.NOT, { out: 'Q' }, 500),
      labeled('c', ComponentType.NOT, { out: 'R' }, 1000),
      labeled('d', ComponentType.NOT, { out: 'R' }, 1500)
    ])
    expect(findDuplicateOutputLabels(netlist).sort()).toEqual(['Q', 'R'])
  })

  it('reports a duplicate on the two outputs of one flip-flop', () => {
    const netlist = rawNetlist([labeled('ff', ComponentType.D_FLIPFLOP, { Q: 'S', "Q'": 'S' }, 0)])
    expect(findDuplicateOutputLabels(netlist)).toEqual(['S'])
  })

  it('returns [] for a netlist with no labels at all', () => {
    expect(findDuplicateOutputLabels(rawNetlist([comp('a', ComponentType.AND2, 0, 0)]))).toEqual([])
  })
})

// ================================================================ drivers per net

describe('net resolution by driver count', () => {
  /** Builds a net driven by `drivers` tristate buffers, read by a probe. */
  function driverCircuit(drivers: ('0' | '1' | 'Z' | 'X')[]): Circuit {
    const b = new CircuitBuilder().probe('pr')
    drivers.forEach((d, i) => {
      b.add(`t${i}`, ComponentType.TRISTATE_RIGHT)
        .switch(`in${i}`, d === '1' ? ONE : ZERO)
        .wire(p(`in${i}`, 'out'), p(`t${i}`, 'in'))
        .wire(p(`t${i}`, 'out'), p('pr', 'in'))
      // 'X' leaves ctl unconnected (Z) so the buffer drives X forever.
      if (d !== 'X') b.switch(`en${i}`, d === 'Z' ? ZERO : ONE).wire(p(`en${i}`, 'out'), p(`t${i}`, 'ctl'))
    })
    return b.build()
  }

  const asValue = (d: '0' | '1' | 'Z' | 'X'): LogicValue =>
    d === '0' ? ZERO : d === '1' ? ONE : d === 'Z' ? Z : X

  it('a net with no driver at all is Z', () => {
    const c = new CircuitBuilder().add('g', ComponentType.AND2).probe('pr').wire(p('g', 'in1'), p('pr', 'in')).build()
    expect(c.pin(p('pr', 'in'))).toBe(Z)
    expect(c.pin(p('g', 'in1'))).toBe(Z)
  })

  it('a net whose only driver is a switch carries the switch position', () => {
    const c = driverCircuit(['1'])
    expect(c.pin(p('pr', 'in'))).toBe(ONE)
    c.set('in0', ZERO)
    expect(c.pin(p('pr', 'in'))).toBe(ZERO)
  })

  const singles: ('0' | '1' | 'Z' | 'X')[] = ['0', '1', 'Z', 'X']
  it.each(singles)('one driver of %s resolves to itself', (d) => {
    expect(driverCircuit([d]).pin(p('pr', 'in'))).toBe(asValue(d))
  })

  const pairs: ('0' | '1' | 'Z' | 'X')[][] = []
  for (const a of singles) for (const b of singles) pairs.push([a, b])
  it.each(pairs)('two drivers %s and %s resolve std_logic style', (a, b) => {
    const expected = wiredResolve([asValue(a), asValue(b)])
    expect(driverCircuit([a, b]).pin(p('pr', 'in'))).toBe(expected)
  })

  const triples: ('0' | '1' | 'Z')[][] = []
  for (const a of ['0', '1', 'Z'] as const)
    for (const b of ['0', '1', 'Z'] as const) for (const d of ['0', '1', 'Z'] as const) triples.push([a, b, d])
  it.each(triples)('three drivers %s %s %s resolve std_logic style', (a, b, d) => {
    const expected = wiredResolve([asValue(a), asValue(b), asValue(d)])
    expect(driverCircuit([a, b, d]).pin(p('pr', 'in'))).toBe(expected)
  })

  it('a single X driver poisons a net that three others agree on', () => {
    expect(driverCircuit(['1', '1', '1', 'X']).pin(p('pr', 'in'))).toBe(X)
  })

  it('an always-on gate output plus a tristate: off, agreeing, then conflicting', () => {
    const c = new CircuitBuilder()
      .switch('a', ONE)
      .switch('t', ONE)
      .switch('en', ZERO)
      .add('buf', ComponentType.AND2)
      .add('ts', ComponentType.TRISTATE_RIGHT)
      .probe('pr')
      .wire(p('a', 'out'), p('buf', 'in1'))
      .wire(p('a', 'out'), p('buf', 'in2'))
      .wire(p('buf', 'out'), p('pr', 'in'))
      .wire(p('t', 'out'), p('ts', 'in'))
      .wire(p('en', 'out'), p('ts', 'ctl'))
      .wire(p('ts', 'out'), p('pr', 'in'))
      .build()
    expect(c.pin(p('pr', 'in'))).toBe(ONE) // tristate off
    c.set('en', ONE)
    expect(c.pin(p('pr', 'in'))).toBe(ONE) // both drive 1
    c.set('t', ZERO)
    expect(c.pin(p('pr', 'in'))).toBe(X) // conflict
    c.set('a', ZERO)
    expect(c.pin(p('pr', 'in'))).toBe(ZERO) // agree again
  })

  it('a net with three drivers reports every driver pin in the graph', () => {
    const c = driverCircuit(['1', '0', 'Z'])
    const graph = buildSimGraph(c.sim.sourceNetlist)
    const netId = graph.pinToNet.get(p('pr', 'in'))!
    expect(graph.nets.get(netId)!.driverPinIds.sort()).toEqual(
      [p('t0', 'out'), p('t1', 'out'), p('t2', 'out')].sort()
    )
  })
})

// ================================================================ graph.ts

describe('buildSimGraph: nets, drivers and readers', () => {
  it('gives every pin a net, including unconnected ones', () => {
    const netlist = rawNetlist([comp('ff', ComponentType.D_FLIPFLOP, 0, 0), comp('g', ComponentType.AND3, 500, 0)])
    const graph = buildSimGraph(netlist)
    for (const pin of getAllPins(netlist)) expect(graph.pinToNet.get(pin.pinId)).toBeDefined()
    expect(graph.nets.size).toBe(getAllPins(netlist).length)
  })

  it('a singleton input net has no drivers and a singleton output net has one', () => {
    const netlist = rawNetlist([comp('g', ComponentType.AND2, 0, 0)])
    const graph = buildSimGraph(netlist)
    const netOf = (name: string): string => graph.pinToNet.get(p('g', name))!
    expect(graph.nets.get(netOf('in1'))!.driverPinIds).toEqual([])
    expect(graph.nets.get(netOf('out'))!.driverPinIds).toEqual([p('g', 'out')])
  })

  it('registers readers only for sink pins, never for output pins', () => {
    const c = new CircuitBuilder()
      .switch('sw', ZERO)
      .add('vcc', ComponentType.VCC)
      .add('ff', ComponentType.D_FLIPFLOP)
      .probe('pr')
      .wire(p('sw', 'out'), p('ff', 'D'))
      .wire(p('sw', 'out'), p('ff', 'CLK'))
      .wire(p('vcc', 'out'), p('ff', 'S'))
      .wire(p('vcc', 'out'), p('ff', 'R'))
      .wire(p('ff', 'Q'), p('pr', 'in'))
      .build()
    const graph = buildSimGraph(c.sim.sourceNetlist)
    const readersOf = (pinId: PinId): string[] => (graph.readers.get(graph.pinToNet.get(pinId)!) ?? []).sort()
    expect(readersOf(p('sw', 'out'))).toEqual(['ff'])
    expect(readersOf(p('vcc', 'out'))).toEqual(['ff'])
    expect(readersOf(p('ff', 'Q'))).toEqual(['pr'])
    expect(readersOf(p('ff', "Q'"))).toEqual([])
  })

  it('a net driven by two outputs and read by nobody has no readers', () => {
    const c = new CircuitBuilder()
      .add('a', ComponentType.NOT)
      .add('b', ComponentType.NOT)
      .wire(p('a', 'out'), p('b', 'out'))
      .build()
    const graph = buildSimGraph(c.sim.sourceNetlist)
    const netId = graph.pinToNet.get(p('a', 'out'))!
    expect(graph.readers.get(netId)).toBeUndefined()
    expect(graph.nets.get(netId)!.driverPinIds.sort()).toEqual([p('a', 'out'), p('b', 'out')].sort())
  })

  it('a component that both drives and reads a net is its own reader', () => {
    const c = new CircuitBuilder().add('n', ComponentType.NOT).wire(p('n', 'out'), p('n', 'in1')).build()
    const graph = buildSimGraph(c.sim.sourceNetlist)
    const netId = graph.pinToNet.get(p('n', 'out'))!
    expect(graph.readers.get(netId)).toEqual(['n'])
    expect(graph.nets.get(netId)!.driverPinIds).toEqual([p('n', 'out')])
  })

  it('a component appears once in readers even with several sink pins on the net', () => {
    const c = new CircuitBuilder()
      .switch('sw', ZERO)
      .add('g', ComponentType.AND4)
      .wire(p('sw', 'out'), p('g', 'in1'))
      .wire(p('sw', 'out'), p('g', 'in2'))
      .wire(p('sw', 'out'), p('g', 'in3'))
      .wire(p('sw', 'out'), p('g', 'in4'))
      .build()
    const graph = buildSimGraph(c.sim.sourceNetlist)
    expect(graph.readers.get(graph.pinToNet.get(p('sw', 'out'))!)).toEqual(['g'])
  })

  it('readers and drivers agree with the pin roles over a large mixed netlist', () => {
    const components = ALL_TYPES.map((type, i) => comp(`c${i}`, type, i * 1000, 0, { bits: 4 }))
    const netlist = rawNetlist(components)
    const graph = buildSimGraph(netlist)
    // Forward: every sink pin makes its component a reader of its net.
    for (const component of components) {
      for (const pin of defOf(component).pins) {
        const netId = graph.pinToNet.get(makePinId(component.id, pin.name))!
        if (SINK_ROLES.includes(pin.role)) {
          expect(graph.readers.get(netId)).toContain(component.id)
        } else {
          expect(graph.nets.get(netId)!.driverPinIds).toContain(makePinId(component.id, pin.name))
        }
      }
    }
    // Backward: nobody is a reader without a sink pin on that net.
    for (const [netId, readerIds] of graph.readers) {
      for (const readerId of readerIds) {
        const component = components.find((x) => x.id === readerId)!
        const sinks = defOf(component)
          .pins.filter((pin) => SINK_ROLES.includes(pin.role))
          .filter((pin) => graph.pinToNet.get(makePinId(readerId, pin.name)) === netId)
        expect(sinks.length).toBeGreaterThan(0)
      }
    }
  })

  it('lists input and output pin names in part-definition order', () => {
    const netlist = rawNetlist([comp('g', ComponentType.AND5, 0, 0), comp('ff', ComponentType.JK_FLIPFLOP, 500, 0)])
    const graph = buildSimGraph(netlist)
    expect(graph.components.get('g')!.inputPinNames).toEqual(['in1', 'in2', 'in3', 'in4', 'in5'])
    expect(graph.components.get('g')!.outputPinNames).toEqual(['out'])
    expect(graph.components.get('ff')!.inputPinNames).toEqual(['J', 'CLK', 'K', 'S', 'R'])
    expect(graph.components.get('ff')!.outputPinNames).toEqual(['Q', "Q'"])
  })
})

describe('buildSimGraph: net width', () => {
  it('a net of single-bit pins has width 1', () => {
    const c = new CircuitBuilder().switch('sw', ZERO).probe('pr').wire(p('sw', 'out'), p('pr', 'in')).build()
    const graph = buildSimGraph(c.sim.sourceNetlist)
    expect(graph.nets.get(graph.pinToNet.get(p('sw', 'out'))!)!.width).toBe(1)
  })

  it('a bus pin gives its net the pin width even when unconnected', () => {
    const netlist = rawNetlist([comp('bi', ComponentType.BUS_INPUT, 0, 0, { bits: 12, label: 'ABC' })])
    const graph = buildSimGraph(netlist)
    expect(graph.nets.get(graph.pinToNet.get(p('bi', 'out'))!)!.width).toBe(12)
  })

  it('a net takes the widest member pin (4-bit driver, 8-bit probe)', () => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 4, label: 'F' })
      .add('bp', ComponentType.BUS_PROBE, { bits: 8 })
      .wire(p('bi', 'out'), p('bp', 'in'))
      .build()
    const graph = buildSimGraph(c.sim.sourceNetlist)
    expect(graph.nets.get(graph.pinToNet.get(p('bi', 'out'))!)!.width).toBe(8)
    // The narrow driver leaves the missing high bits X (spec decision 3).
    expect(c.bus(p('bp', 'in'))).toBe('XX')
  })

  it('the widest pin wins regardless of the order pins appear on the net', () => {
    const c = new CircuitBuilder()
      .add('bp', ComponentType.BUS_PROBE, { bits: 16 })
      .add('bi', ComponentType.BUS_INPUT, { bits: 2, label: '3' })
      .wire(p('bp', 'in'), p('bi', 'out'))
      .build()
    const graph = buildSimGraph(c.sim.sourceNetlist)
    expect(graph.nets.get(graph.pinToNet.get(p('bi', 'out'))!)!.width).toBe(16)
  })

  it('a single-bit pin dragged onto a bus net takes the bus width', () => {
    const c = new CircuitBuilder()
      .switch('sw', ONE)
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
      .wire(p('sw', 'out'), p('bp', 'in'))
      .build()
    const graph = buildSimGraph(c.sim.sourceNetlist)
    expect(graph.nets.get(graph.pinToNet.get(p('sw', 'out'))!)!.width).toBe(4)
  })

  it('a 1-bit BUS_TAP output is an ordinary single-bit net', () => {
    const netlist = rawNetlist([comp('tap', ComponentType.BUS_TAP, 0, 0, { bits: 1, tapStart: 2 })])
    const graph = buildSimGraph(netlist)
    expect(graph.nets.get(graph.pinToNet.get(p('tap', 'out'))!)!.width).toBe(1)
  })

  it('pinNet covers every pin named by the part definition', () => {
    const components = ALL_TYPES.map((type, i) => comp(`c${i}`, type, i * 1000, 0, { bits: 4 }))
    const graph = buildSimGraph(rawNetlist(components))
    for (const component of components) {
      const sim = graph.components.get(component.id)!
      const names = defOf(component).pins.map((pin) => pin.name)
      expect(Object.keys(sim.pinNet).sort()).toEqual([...names].sort())
      for (const name of names) {
        expect(sim.pinNet[name]).toBe(graph.pinToNet.get(makePinId(component.id, name)))
      }
    }
  })

  it('tapStart is carried through and defaults to 0', () => {
    const netlist = rawNetlist([
      comp('t1', ComponentType.BUS_TAP, 0, 0, { bits: 2, tapStart: 5 }),
      comp('t2', ComponentType.BUS_TAP, 500, 0, { bits: 2 })
    ])
    const graph = buildSimGraph(netlist)
    expect(graph.components.get('t1')!.tapStart).toBe(5)
    expect(graph.components.get('t2')!.tapStart).toBe(0)
  })

  it('keeps the component type and id on every SimComponent', () => {
    const components = ALL_TYPES.map((type, i) => comp(`c${i}`, type, i * 1000, 0))
    const graph = buildSimGraph(rawNetlist(components))
    expect(graph.components.size).toBe(components.length)
    for (const component of components) {
      expect(graph.components.get(component.id)!.type).toBe(component.type)
      expect(graph.components.get(component.id)!.id).toBe(component.id)
    }
  })
})

describe('buildSimGraph: bits and delay', () => {
  const BITS_CASES = [undefined, -4, 0, 1, 2, 3, 4, 5, 8, 16, 17, 32, 33, 64]

  it.each(ALL_TYPES)('%s reports bits === effectiveBits for every stored width', (type) => {
    for (const bits of BITS_CASES) {
      const netlist = rawNetlist([comp('c', type, 0, 0, { bits })])
      const graph = buildSimGraph(netlist)
      expect([type, bits, graph.components.get('c')!.bits]).toEqual([type, bits, effectiveBits(type, bits)])
    }
  })

  it('bits stays within the type limits for n-bit and bus parts', () => {
    for (const type of ALL_TYPES) {
      for (const bits of BITS_CASES) {
        const value = effectiveBits(type, bits)
        expect(Number.isInteger(value)).toBe(true)
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThanOrEqual(32)
      }
    }
  })

  it('the simulated width matches the drawn width: 20 data pins are clamped to 16', () => {
    const netlist = rawNetlist([comp('reg', ComponentType.N_REGISTER, 0, 0, { bits: 20 })])
    const graph = buildSimGraph(netlist)
    expect(graph.components.get('reg')!.bits).toBe(16)
    expect(defOf(netlist.components[0]).pins.filter((pin) => pin.name.startsWith('Q'))).toHaveLength(16)
  })

  const DELAY_CASES: [number, number][] = [
    [0, 1],
    [-1, 1],
    [-999, 1],
    [-0.4, 1],
    [0.2, 1],
    [0.5, 1],
    [1, 1],
    [1.4, 1],
    [1.5, 2],
    [2, 2],
    [2.5, 3],
    [2.4, 2],
    [7.9, 8],
    [999, 999],
    [1000.7, 1001],
    [Number.NaN, 1]
  ]

  it.each(DELAY_CASES)('a stored delay of %p is clamped to %i', (stored, expected) => {
    const netlist = rawNetlist([comp('n', ComponentType.NOT, 0, 0, { delay: stored })])
    expect(buildSimGraph(netlist).components.get('n')!.delay).toBe(expected)
  })

  it('every clamped delay is an integer >= 1 so output changes are strictly in the future', () => {
    for (const [stored] of DELAY_CASES) {
      const netlist = rawNetlist([comp('n', ComponentType.NOT, 0, 0, { delay: stored })])
      const delay = buildSimGraph(netlist).components.get('n')!.delay
      expect(Number.isInteger(delay)).toBe(true)
      expect(delay).toBeGreaterThanOrEqual(1)
    }
  })

  it('a part loaded with delay 0 propagates in 1 ns, not instantly', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .add('n', ComponentType.NOT, { delay: 0 })
      .probe('pr')
      .wire(p('a', 'out'), p('n', 'in1'))
      .wire(p('n', 'out'), p('pr', 'in'))
      .build()
    expect(c.pin(p('pr', 'in'))).toBe(ONE)
    c.set('a', ONE)
    expect(c.pin(p('pr', 'in'))).toBe(ZERO)
    expect(c.time).toBe(2) // switch 1 ns + clamped NOT 1 ns
    expect(trace(c, 'pr')).toEqual([
      [0, ONE],
      [2, ZERO]
    ])
  })

  it('a ring of zero-delay parts still terminates (the clamp guarantees progress)', () => {
    const c = new CircuitBuilder()
      .switch('en', ZERO)
      .add('nand', ComponentType.NAND2, { delay: 0 })
      .add('n1', ComponentType.NOT, { delay: -3 })
      .add('n2', ComponentType.NOT, { delay: 0.4 })
      .wire(p('en', 'out'), p('nand', 'in1'))
      .wire(p('n2', 'out'), p('nand', 'in2'))
      .wire(p('nand', 'out'), p('n1', 'in1'))
      .wire(p('n1', 'out'), p('n2', 'in1'))
      .build()
    expect(c.pin(p('nand', 'out'))).toBe(ONE)
    c.set('en', ONE)
    expect(c.oscillated).toBe(true)
    expect(Number.isFinite(c.time)).toBe(true)
  })

  it('the SWITCH honors its own delay', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO, { delay: 5 })
      .probe('pr')
      .wire(p('a', 'out'), p('pr', 'in'))
      .build()
    c.set('a', ONE)
    expect(c.time).toBe(5)
    expect(trace(c, 'pr')).toEqual([
      [0, ZERO],
      [5, ONE]
    ])
  })
})

describe('part definitions never short two pins together', () => {
  it.each(ALL_TYPES)('%s keeps all pins on distinct coordinates', (type) => {
    const widths = [1, 2, 3, 4, 5, 8, 16, 32]
    const smCounts = [1, 2, 4, 8]
    const variants: Component[] =
      type === ComponentType.STATE_MACHINE
        ? smCounts.flatMap((nIn) =>
            smCounts.map((nOut) => comp('c', type, 0, 0, { smInputs: nIn, smOutputs: nOut }))
          )
        : widths.map((bits) => comp('c', type, 0, 0, { bits }))
    for (const component of variants) {
      const seen = new Map<string, string>()
      for (const pin of defOf(component).pins) {
        const key = `${pin.dx},${pin.dy}`
        expect([type, key, seen.get(key)]).toEqual([type, key, undefined])
        seen.set(key, pin.name)
      }
    }
  })

  it('the bidirectional shift register keeps Lin and CLK apart (spec decision 9)', () => {
    const component = comp('sr', ComponentType.N_SHIFT_BIDIR, 0, 0, { bits: 4 })
    const pins = defOf(component).pins
    const at = (name: string): string => {
      const pin = pins.find((q) => q.name === name)!
      return `${pin.dx},${pin.dy}`
    }
    expect(at('Ld')).toBe('0,20')
    expect(at('CLR')).toBe('0,40')
    expect(at('LS')).toBe('0,60')
    expect(at('Lin')).toBe('0,80')
    expect(at('CLK')).toBe('0,100')
  })

  it('the right shift register puts Lin at (0,60) (spec decision 9)', () => {
    const pins = defOf(comp('sr', ComponentType.N_SHIFT_RIGHT, 0, 0, { bits: 4 })).pins
    const lin = pins.find((q) => q.name === 'Lin')!
    expect([lin.dx, lin.dy]).toEqual([0, 60])
  })
})

// ================================================================ eventHeap.ts

describe('EventHeap', () => {
  const ev = (time: number, seq: number): SimEvent => ({
    time,
    seq,
    kind: 'drive',
    pinId: `c${seq}#out`,
    value: ZERO
  })

  it('starts empty', () => {
    const heap = new EventHeap()
    expect(heap.size).toBe(0)
    expect(heap.peek()).toBeUndefined()
    expect(heap.values()).toEqual([])
  })

  it('pop on an empty heap returns undefined', () => {
    expect(new EventHeap().pop()).toBeUndefined()
  })

  it('holds a single event and gives it back', () => {
    const heap = new EventHeap()
    const e = ev(4, 0)
    heap.push(e)
    expect(heap.size).toBe(1)
    expect(heap.peek()).toBe(e)
    expect(heap.pop()).toBe(e)
    expect(heap.size).toBe(0)
    expect(heap.peek()).toBeUndefined()
    expect(heap.pop()).toBeUndefined()
  })

  it('peek does not remove', () => {
    const heap = new EventHeap()
    heap.push(ev(2, 0))
    expect(heap.peek()).toBe(heap.peek())
    expect(heap.size).toBe(1)
  })

  it('pops in time order regardless of push order', () => {
    const heap = new EventHeap()
    const times = [9, 3, 7, 1, 8, 2, 5, 4, 6, 0]
    times.forEach((t, i) => heap.push(ev(t, i)))
    const popped: number[] = []
    while (heap.size > 0) popped.push(heap.pop()!.time)
    expect(popped).toEqual([...times].sort((a, b) => a - b))
  })

  it('keeps same-time events in push (FIFO) order', () => {
    const heap = new EventHeap()
    for (let i = 0; i < 50; i++) heap.push(ev(5, i))
    const seqs: number[] = []
    while (heap.size > 0) seqs.push(heap.pop()!.seq)
    expect(seqs).toEqual([...Array(50).keys()])
  })

  it('orders by time first and seq second across several instants', () => {
    const heap = new EventHeap()
    const items = [ev(2, 10), ev(1, 11), ev(2, 3), ev(1, 4), ev(3, 0), ev(1, 20)]
    for (const e of items) heap.push(e)
    const order = []
    while (heap.size > 0) {
      const e = heap.pop()!
      order.push([e.time, e.seq])
    }
    expect(order).toEqual([
      [1, 4],
      [1, 11],
      [1, 20],
      [2, 3],
      [2, 10],
      [3, 0]
    ])
  })

  it('handles fractional and negative times', () => {
    const heap = new EventHeap()
    for (const t of [1.5, -2, 0, 0.25, -0.5]) heap.push(ev(t, 0))
    const popped: number[] = []
    while (heap.size > 0) popped.push(heap.pop()!.time)
    expect(popped).toEqual([-2, -0.5, 0, 0.25, 1.5])
  })

  it('keeps ordering when pushes are interleaved with pops', () => {
    const heap = new EventHeap()
    heap.push(ev(10, 0))
    heap.push(ev(20, 1))
    expect(heap.pop()!.time).toBe(10)
    heap.push(ev(5, 2)) // earlier than what is left
    heap.push(ev(15, 3))
    expect(heap.pop()!.time).toBe(5)
    expect(heap.pop()!.time).toBe(15)
    heap.push(ev(1, 4))
    expect(heap.pop()!.time).toBe(1)
    expect(heap.pop()!.time).toBe(20)
    expect(heap.size).toBe(0)
  })

  it('size and values track pushes and pops', () => {
    const heap = new EventHeap()
    for (let i = 0; i < 8; i++) heap.push(ev(i, i))
    expect(heap.size).toBe(8)
    expect(heap.values()).toHaveLength(8)
    expect([...heap.values()].map((e) => e.seq).sort((a, b) => a - b)).toEqual([...Array(8).keys()])
    heap.pop()
    expect(heap.size).toBe(7)
    expect(heap.values()).toHaveLength(7)
  })

  it('clear empties the heap', () => {
    const heap = new EventHeap()
    for (let i = 0; i < 5; i++) heap.push(ev(i, i))
    heap.clear()
    expect(heap.size).toBe(0)
    expect(heap.peek()).toBeUndefined()
    expect(heap.values()).toEqual([])
    heap.push(ev(3, 99))
    expect(heap.pop()!.seq).toBe(99)
  })

  it('carries every event kind through unchanged', () => {
    const heap = new EventHeap()
    const busdrive: SimEvent = { time: 1, seq: 0, kind: 'busdrive', pinId: 'b#out', value: [ONE, ZERO] }
    const softreset: SimEvent = { time: 1, seq: 1, kind: 'softreset' }
    const sample: SimEvent = { time: 1, seq: 2, kind: 'sample', slot: 3 }
    const drive: SimEvent = { time: 0, seq: 3, kind: 'drive', pinId: 'a#out', value: X, version: 7 }
    for (const e of [busdrive, softreset, sample, drive]) heap.push(e)
    expect([heap.pop(), heap.pop(), heap.pop(), heap.pop()]).toEqual([drive, busdrive, softreset, sample])
  })

  it('matches a reference sort for 2000 random events (seeded)', () => {
    const rnd = lcg(0xc0ffee)
    const heap = new EventHeap()
    const reference: SimEvent[] = []
    for (let i = 0; i < 2000; i++) {
      const e = ev(Math.floor(rnd() * 60), i)
      heap.push(e)
      reference.push(e)
    }
    reference.sort((a, b) => (a.time !== b.time ? a.time - b.time : a.seq - b.seq))
    const popped: SimEvent[] = []
    while (heap.size > 0) popped.push(heap.pop()!)
    expect(popped).toEqual(reference)
  })

  it('matches a reference queue under 4000 interleaved random operations (seeded)', () => {
    const rnd = lcg(12345)
    const heap = new EventHeap()
    const reference: SimEvent[] = []
    let seq = 0
    for (let i = 0; i < 4000; i++) {
      if (reference.length === 0 || rnd() < 0.55) {
        const e = ev(Math.floor(rnd() * 100) - 20, seq++)
        heap.push(e)
        reference.push(e)
        reference.sort((a, b) => (a.time !== b.time ? a.time - b.time : a.seq - b.seq))
      } else {
        const expected = reference.shift()
        expect(heap.pop()).toEqual(expected)
      }
      expect(heap.size).toBe(reference.length)
      expect(heap.peek()).toEqual(reference[0])
    }
  })

  it('never pops out of order for a randomized burst (seeded)', () => {
    const rnd = lcg(99)
    const heap = new EventHeap()
    for (let i = 0; i < 500; i++) heap.push(ev(Math.floor(rnd() * 10), i))
    let last: SimEvent | undefined
    while (heap.size > 0) {
      const e = heap.pop()!
      if (last) expect(last.time < e.time || (last.time === e.time && last.seq < e.seq)).toBe(true)
      last = e
    }
  })
})

// ================================================================ engine core

describe('engine: time and settling at reset', () => {
  it('time is 0 right after build', () => {
    const c = new CircuitBuilder().switch('a', ZERO).probe('pr').wire(p('a', 'out'), p('pr', 'in')).build()
    expect(c.time).toBe(0)
    expect(trace(c, 'pr')).toEqual([[0, ZERO]])
  })

  it('reset settles constants and X/Z before presenting time 0', () => {
    const c = new CircuitBuilder()
      .add('vcc', ComponentType.VCC)
      .add('gnd', ComponentType.GROUND)
      .add('g', ComponentType.AND2)
      .add('open', ComponentType.NOT)
      .probe('pg')
      .probe('po')
      .wire(p('vcc', 'out'), p('g', 'in1'))
      .wire(p('gnd', 'out'), p('g', 'in2'))
      .wire(p('g', 'out'), p('pg', 'in'))
      .wire(p('open', 'out'), p('po', 'in'))
      .build()
    expect(c.time).toBe(0)
    expect(trace(c, 'pg')).toEqual([[0, ZERO]])
    expect(trace(c, 'po')).toEqual([[0, X]]) // NOT of an unconnected input
  })

  it('probe traces start with exactly one sample per probe', () => {
    const c = new CircuitBuilder()
      .switch('a', ONE)
      .probe('p1')
      .probe('p2')
      .wire(p('a', 'out'), p('p1', 'in'))
      .wire(p('a', 'out'), p('p2', 'in'))
      .build()
    for (const wave of c.sim.getWaveforms()) expect(wave.samples).toHaveLength(1)
  })

  it('reset restores time 0, sequential state and the settled values, keeping switch positions', () => {
    const c = new CircuitBuilder()
      .switch('d', ZERO)
      .switch('clk', ZERO)
      .add('vcc', ComponentType.VCC)
      .add('ff', ComponentType.D_FLIPFLOP)
      .probe('pr')
      .wire(p('d', 'out'), p('ff', 'D'))
      .wire(p('clk', 'out'), p('ff', 'CLK'))
      .wire(p('vcc', 'out'), p('ff', 'S'))
      .wire(p('vcc', 'out'), p('ff', 'R'))
      .wire(p('ff', 'Q'), p('pr', 'in'))
      .build()
    expect(c.pin(p('ff', 'Q'))).toBe(X)
    c.set('d', ONE)
    c.pulse('clk')
    expect(c.pin(p('ff', 'Q'))).toBe(ONE)
    expect(c.time).toBeGreaterThan(0)

    c.reset()
    expect(c.time).toBe(0)
    expect(c.pin(p('ff', 'Q'))).toBe(X) // sequential state cleared
    expect(c.pin(p('d', 'out'))).toBe(ONE) // switch position kept
    expect(trace(c, 'pr')).toEqual([[0, X]])
  })

  it('reset twice is idempotent', () => {
    const c = new CircuitBuilder()
      .switch('a', ONE)
      .add('n', ComponentType.NOT)
      .probe('pr')
      .wire(p('a', 'out'), p('n', 'in1'))
      .wire(p('n', 'out'), p('pr', 'in'))
      .build()
    c.set('a', ZERO)
    c.reset()
    const first = c.sim.getPinValues()
    c.reset()
    expect(c.sim.getPinValues()).toEqual(first)
    expect(c.time).toBe(0)
    expect(trace(c, 'pr')).toEqual([[0, ONE]]) // NOT of the kept switch position 0
  })

  it('reset clears a pending CHANGE-mode event', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .add('n', ComponentType.NOT)
      .probe('pr')
      .wire(p('a', 'out'), p('n', 'in1'))
      .wire(p('n', 'out'), p('pr', 'in'))
      .build()
    c.sim.toggle('a', false)
    c.reset()
    expect(c.sim.changeStep()).toBe(false)
    expect(c.time).toBe(0)
    expect(c.pin(p('n', 'out'))).toBe(ZERO) // reset re-settles with a = 1
  })
})

describe('engine: same-instant events are applied before evaluation (decision 1)', () => {
  it('two switches into one AND2 are seen together', () => {
    const c = new CircuitBuilder()
      .switch('a', ONE)
      .switch('b', ZERO)
      .add('g', ComponentType.AND2)
      .probe('pr')
      .wire(p('a', 'out'), p('g', 'in1'))
      .wire(p('b', 'out'), p('g', 'in2'))
      .wire(p('g', 'out'), p('pr', 'in'))
      .build()
    c.setMany({ a: ZERO, b: ONE })
    expect(c.pin(p('g', 'out'))).toBe(ZERO)
    expect(trace(c, 'pr')).toEqual([[0, ZERO]]) // never glitched to 1
  })

  it('three switches into one AND3 flip together without a glitch', () => {
    const b = new CircuitBuilder().add('g', ComponentType.AND3).probe('pr').wire(p('g', 'out'), p('pr', 'in'))
    for (let i = 1; i <= 3; i++) b.switch(`s${i}`, ONE).wire(p(`s${i}`, 'out'), p('g', `in${i}`))
    const c = b.build()
    expect(c.pin(p('g', 'out'))).toBe(ONE)
    c.setMany({ s1: ZERO, s2: ZERO, s3: ZERO })
    expect(c.pin(p('g', 'out'))).toBe(ZERO)
    expect(trace(c, 'pr')).toEqual([
      [0, ONE],
      [2, ZERO]
    ])
    c.setMany({ s1: ONE, s2: ONE, s3: ONE })
    expect(trace(c, 'pr')).toEqual([
      [0, ONE],
      [2, ZERO],
      [4, ONE]
    ])
  })

  it('an OR3 whose inputs swap roles at one instant never dips to 0', () => {
    const b = new CircuitBuilder().add('g', ComponentType.OR3).probe('pr').wire(p('g', 'out'), p('pr', 'in'))
    b.switch('s1', ONE).switch('s2', ZERO).switch('s3', ZERO)
    for (let i = 1; i <= 3; i++) b.wire(p(`s${i}`, 'out'), p('g', `in${i}`))
    const c = b.build()
    c.setMany({ s1: ZERO, s2: ONE })
    expect(c.pin(p('g', 'out'))).toBe(ONE)
    expect(trace(c, 'pr')).toEqual([[0, ONE]])
  })

  it('a D flip-flop whose D and CLK change at the same instant samples the NEW D', () => {
    const c = new CircuitBuilder()
      .switch('d', ZERO)
      .switch('clk', ZERO)
      .add('vcc', ComponentType.VCC)
      .add('ff', ComponentType.D_FLIPFLOP)
      .wire(p('d', 'out'), p('ff', 'D'))
      .wire(p('clk', 'out'), p('ff', 'CLK'))
      .wire(p('vcc', 'out'), p('ff', 'S'))
      .wire(p('vcc', 'out'), p('ff', 'R'))
      .build()
    c.setMany({ d: ONE, clk: ONE })
    expect(c.pin(p('ff', 'Q'))).toBe(ONE)
    c.set('clk', ZERO)
    c.setMany({ d: ZERO, clk: ONE })
    expect(c.pin(p('ff', 'Q'))).toBe(ZERO)
  })

  it('a register whose data and clock change at the same instant loads the NEW data', () => {
    const b = new CircuitBuilder()
      .switch('clk', ZERO)
      .add('vcc', ComponentType.VCC)
      .add('gnd', ComponentType.GROUND)
      .add('reg', ComponentType.N_REGISTER, { bits: 4 })
      .wire(p('clk', 'out'), p('reg', 'CLK'))
      .wire(p('vcc', 'out'), p('reg', 'Ld'))
      .wire(p('gnd', 'out'), p('reg', 'CLR'))
    for (let i = 0; i < 4; i++) b.switch(`d${i}`, ZERO).wire(p(`d${i}`, 'out'), p('reg', `D${i}`))
    const c = b.build()
    c.setMany({ clk: ONE, d0: ONE, d2: ONE })
    expect(c.vec('reg', 'Q', 4)).toBe('0101')
    c.set('clk', ZERO)
    c.setMany({ clk: ONE, d0: ZERO, d3: ONE })
    expect(c.vec('reg', 'Q', 4)).toBe('1100')
  })

  it('a driver change and a clock edge at the same instant reach the part together', () => {
    // One switch drives both the data path (through a NOT) and the clock, so the
    // two changes are queued at the same instant by construction.
    const c = new CircuitBuilder()
      .switch('clk', ZERO)
      .switch('sel', ZERO)
      .add('vcc', ComponentType.VCC)
      .add('ff', ComponentType.D_FLIPFLOP)
      .wire(p('sel', 'out'), p('ff', 'D'))
      .wire(p('clk', 'out'), p('ff', 'CLK'))
      .wire(p('vcc', 'out'), p('ff', 'S'))
      .wire(p('vcc', 'out'), p('ff', 'R'))
      .build()
    c.setMany({ sel: ONE, clk: ONE }) // D rises exactly at the edge
    expect(c.pin(p('ff', 'Q'))).toBe(ONE)
  })

  it('one net is resolved once per instant: a tristate handover of the same value leaves no sample', () => {
    const c = new CircuitBuilder()
      .switch('ia', ONE)
      .switch('ib', ONE)
      .switch('ea', ONE)
      .switch('eb', ZERO)
      .add('ta', ComponentType.TRISTATE_RIGHT)
      .add('tb', ComponentType.TRISTATE_RIGHT)
      .probe('pr')
      .wire(p('ia', 'out'), p('ta', 'in'))
      .wire(p('ea', 'out'), p('ta', 'ctl'))
      .wire(p('ib', 'out'), p('tb', 'in'))
      .wire(p('eb', 'out'), p('tb', 'ctl'))
      .wire(p('ta', 'out'), p('pr', 'in'))
      .wire(p('tb', 'out'), p('pr', 'in'))
      .build()
    expect(trace(c, 'pr')).toEqual([[0, ONE]])
    c.setMany({ ea: ZERO, eb: ONE })
    expect(c.pin(p('pr', 'in'))).toBe(ONE)
    expect(trace(c, 'pr')).toEqual([[0, ONE]]) // no Z or X blip
  })

  it('a tristate handover to a different value records exactly one sample', () => {
    const c = new CircuitBuilder()
      .switch('ia', ONE)
      .switch('ib', ZERO)
      .switch('ea', ONE)
      .switch('eb', ZERO)
      .add('ta', ComponentType.TRISTATE_RIGHT)
      .add('tb', ComponentType.TRISTATE_RIGHT)
      .probe('pr')
      .wire(p('ia', 'out'), p('ta', 'in'))
      .wire(p('ea', 'out'), p('ta', 'ctl'))
      .wire(p('ib', 'out'), p('tb', 'in'))
      .wire(p('eb', 'out'), p('tb', 'ctl'))
      .wire(p('ta', 'out'), p('pr', 'in'))
      .wire(p('tb', 'out'), p('pr', 'in'))
      .build()
    c.setMany({ ea: ZERO, eb: ONE })
    expect(trace(c, 'pr')).toEqual([
      [0, ONE],
      [2, ZERO]
    ])
  })

  it('two probes on the same net record identical traces', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .probe('p1')
      .probe('p2')
      .wire(p('a', 'out'), p('p1', 'in'))
      .wire(p('a', 'out'), p('p2', 'in'))
      .build()
    c.set('a', ONE)
    c.set('a', ZERO)
    expect(trace(c, 'p1')).toEqual(trace(c, 'p2'))
    expect(trace(c, 'p1')).toEqual([
      [0, ZERO],
      [1, ONE],
      [2, ZERO]
    ])
  })
})

describe('engine: delays accumulate', () => {
  it('five NOT gates with delays 1..5 settle at the sum of the delays', () => {
    const b = new CircuitBuilder().switch('a', ZERO).probe('p0').wire(p('a', 'out'), p('p0', 'in'))
    for (let i = 1; i <= 5; i++) {
      b.add(`n${i}`, ComponentType.NOT, { delay: i })
        .probe(`p${i}`)
        .wire(i === 1 ? p('a', 'out') : p(`n${i - 1}`, 'out'), p(`n${i}`, 'in1'))
        .wire(p(`n${i}`, 'out'), p(`p${i}`, 'in'))
    }
    const c = b.build()
    expect(c.pin(p('n5', 'out'))).toBe(ONE)
    c.set('a', ONE)
    expect(c.pin(p('n5', 'out'))).toBe(ZERO)
    expect(c.time).toBe(16) // 1 (switch) + 1 + 2 + 3 + 4 + 5
    expect(trace(c, 'p0')).toEqual([
      [0, ZERO],
      [1, ONE]
    ])
    expect(trace(c, 'p1')).toEqual([
      [0, ONE],
      [2, ZERO]
    ])
    expect(trace(c, 'p2')).toEqual([
      [0, ZERO],
      [4, ONE]
    ])
    expect(trace(c, 'p3')).toEqual([
      [0, ONE],
      [7, ZERO]
    ])
    expect(trace(c, 'p4')).toEqual([
      [0, ZERO],
      [11, ONE]
    ])
    expect(trace(c, 'p5')).toEqual([
      [0, ONE],
      [16, ZERO]
    ])
  })

  it('the time after a LIVE toggle is the last event time', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .add('n1', ComponentType.NOT, { delay: 3 })
      .add('n2', ComponentType.NOT, { delay: 7 })
      .wire(p('a', 'out'), p('n1', 'in1'))
      .wire(p('n1', 'out'), p('n2', 'in1'))
      .build()
    c.set('a', ONE)
    expect(c.time).toBe(11)
    c.set('a', ZERO)
    expect(c.time).toBe(22)
  })

  it('a fan-out of unequal delays ends at the slowest path', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .add('fast', ComponentType.NOT, { delay: 2 })
      .add('slow', ComponentType.NOT, { delay: 9 })
      .wire(p('a', 'out'), p('fast', 'in1'))
      .wire(p('a', 'out'), p('slow', 'in1'))
      .build()
    c.set('a', ONE)
    expect(c.time).toBe(10)
  })

  it('a toggle that changes nothing still advances time to the queued event', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .switch('b', ZERO)
      .add('g', ComponentType.AND2)
      .wire(p('a', 'out'), p('g', 'in1'))
      .wire(p('b', 'out'), p('g', 'in2'))
      .build()
    c.set('a', ONE) // AND stays 0, but the switch output did change at t = 1
    expect(c.time).toBe(1)
    expect(c.pin(p('g', 'out'))).toBe(ZERO)
  })
})

describe('engine: inertial output delay (decision 2)', () => {
  /** a -> NOT(k) -> AND(d) with a also feeding the AND: a rising makes a k ns glitch. */
  function glitch(k: number, d: number): Circuit {
    return new CircuitBuilder()
      .switch('a', ZERO)
      .add('n', ComponentType.NOT, { delay: k })
      .add('g', ComponentType.AND2, { delay: d })
      .probe('pr')
      .wire(p('a', 'out'), p('n', 'in1'))
      .wire(p('a', 'out'), p('g', 'in1'))
      .wire(p('n', 'out'), p('g', 'in2'))
      .wire(p('g', 'out'), p('pr', 'in'))
      .build()
  }

  const cases: [number, number][] = []
  for (let k = 1; k <= 4; k++) for (let d = 1; d <= 4; d++) cases.push([k, d])

  it.each(cases)('NOT delay %i, AND delay %i: the pulse survives only when the delay fits', (k, d) => {
    const c = glitch(k, d)
    expect(c.pin(p('g', 'out'))).toBe(ZERO)
    c.set('a', ONE)
    expect(c.pin(p('g', 'out'))).toBe(ZERO) // steady state is always 0
    if (d <= k) {
      expect(trace(c, 'pr')).toEqual([
        [0, ZERO],
        [1 + d, ONE],
        [1 + k + d, ZERO]
      ])
      expect(c.time).toBe(1 + k + d)
    } else {
      expect(trace(c, 'pr')).toEqual([[0, ZERO]])
      expect(c.time).toBe(1 + d)
    }
  })

  it('a glitch exactly as wide as the gate delay survives', () => {
    const c = glitch(3, 3)
    c.set('a', ONE)
    const samples = trace(c, 'pr')
    expect(samples).toHaveLength(3)
    expect(samples[2][0] - samples[1][0]).toBe(3)
  })

  it('a glitch one nanosecond narrower than the gate delay is swallowed', () => {
    const c = glitch(2, 3)
    c.set('a', ONE)
    expect(trace(c, 'pr')).toEqual([[0, ZERO]])
  })

  it('a switch toggled twice before propagation settles at the final value', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .add('n', ComponentType.NOT)
      .probe('pr')
      .wire(p('a', 'out'), p('n', 'in1'))
      .wire(p('n', 'out'), p('pr', 'in'))
      .build()
    c.sim.toggle('a', false) // -> 1
    c.sim.toggle('a', false) // -> 0 again, before anything propagated
    c.sim.drain()
    expect(c.pin(p('a', 'out'))).toBe(ZERO)
    expect(c.pin(p('n', 'out'))).toBe(ONE)
    expect(trace(c, 'pr')).toEqual([[0, ONE]]) // the cancelled pulse never appeared
  })

  it('a switch toggled three times before propagation ends at the odd value', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .add('n', ComponentType.NOT)
      .probe('pr')
      .wire(p('a', 'out'), p('n', 'in1'))
      .wire(p('n', 'out'), p('pr', 'in'))
      .build()
    c.sim.toggle('a', false)
    c.sim.toggle('a', false)
    c.sim.toggle('a', false)
    c.sim.drain()
    expect(c.pin(p('a', 'out'))).toBe(ONE)
    expect(c.pin(p('n', 'out'))).toBe(ZERO)
    expect(trace(c, 'pr')).toEqual([
      [0, ONE],
      [2, ZERO]
    ])
  })

  it('a slow part reversed mid-flight never shows the intermediate value', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .add('n', ComponentType.NOT, { delay: 10 })
      .probe('pr')
      .wire(p('a', 'out'), p('n', 'in1'))
      .wire(p('n', 'out'), p('pr', 'in'))
      .build()
    c.sim.toggle('a', false)
    c.sim.drain() // a = 1 at t = 1; NOT would fall at t = 11
    expect(c.time).toBe(11)
    expect(c.pin(p('n', 'out'))).toBe(ZERO)
    c.sim.toggle('a', false)
    c.sim.drain()
    expect(c.pin(p('n', 'out'))).toBe(ONE)
  })
})

describe('engine: oscillation', () => {
  /** Enable-gated ring: NAND(en, n2) -> n1 -> n2. Oscillates while en = 1. */
  function ring(): Circuit {
    return new CircuitBuilder()
      .switch('en', ZERO)
      .add('nand', ComponentType.NAND2)
      .add('n1', ComponentType.NOT)
      .add('n2', ComponentType.NOT)
      .switch('x', ZERO)
      .switch('y', ZERO)
      .add('far', ComponentType.AND2)
      .probe('pf')
      .wire(p('en', 'out'), p('nand', 'in1'))
      .wire(p('n2', 'out'), p('nand', 'in2'))
      .wire(p('nand', 'out'), p('n1', 'in1'))
      .wire(p('n1', 'out'), p('n2', 'in1'))
      .wire(p('x', 'out'), p('far', 'in1'))
      .wire(p('y', 'out'), p('far', 'in2'))
      .wire(p('far', 'out'), p('pf', 'in'))
      .build()
  }

  it('the disabled ring is stable', () => {
    const c = ring()
    expect(c.oscillated).toBe(false)
    expect(c.pin(p('nand', 'out'))).toBe(ONE)
    expect(c.pin(p('n1', 'out'))).toBe(ZERO)
    expect(c.pin(p('n2', 'out'))).toBe(ONE)
  })

  it('enabling the ring halts the run and flags oscillation', () => {
    const c = ring()
    c.set('en', ONE)
    expect(c.oscillated).toBe(true)
    expect(Number.isFinite(c.time)).toBe(true)
    expect(c.time).toBeGreaterThan(0)
  })

  it('every net of the halted ring is marked undetermined', () => {
    const c = ring()
    c.set('en', ONE)
    // Every signal in the loop is still toggling when the run is abandoned, so
    // none of them may be reported as a settled 0 or 1.
    expect([c.pin(p('nand', 'out')), c.pin(p('n1', 'out')), c.pin(p('n2', 'out'))]).toEqual([X, X, X])
  })

  it('an unrelated gate keeps its value across the halt and still responds afterwards', () => {
    const c = ring()
    c.setMany({ x: ONE, y: ONE })
    expect(c.pin(p('far', 'out'))).toBe(ONE)
    c.set('en', ONE)
    expect(c.pin(p('far', 'out'))).toBe(ONE)
    c.set('y', ZERO)
    expect(c.pin(p('far', 'out'))).toBe(ZERO)
    c.set('y', ONE)
    expect(c.pin(p('far', 'out'))).toBe(ONE)
  })

  it('the halt is deterministic across two identical runs', () => {
    const a = ring()
    const b = ring()
    a.set('en', ONE)
    b.set('en', ONE)
    expect(a.time).toBe(b.time)
    expect(a.oscillated).toBe(b.oscillated)
    expect(a.sim.getPinValues()).toEqual(b.sim.getPinValues())
  })

  it('MAX_EVENTS_PER_RUN is an exported positive integer that bounds the halt', () => {
    expect(Number.isInteger(MAX_EVENTS_PER_RUN)).toBe(true)
    expect(MAX_EVENTS_PER_RUN).toBeGreaterThan(0)
    const c = ring()
    c.set('en', ONE)
    expect(c.time).toBeLessThanOrEqual(MAX_EVENTS_PER_RUN + 10)
  })

  it('reset after an oscillation clears the flag and returns to time 0', () => {
    const c = ring()
    c.set('en', ONE)
    c.reset()
    expect(c.oscillated).toBe(false)
    expect(c.time).toBe(0)
    expect(c.pin(p('n1', 'out'))).toBe(X) // all-X is the ring's stable start
  })

  it('a ring of two inverters is stable at X', () => {
    const c = new CircuitBuilder()
      .add('n1', ComponentType.NOT)
      .add('n2', ComponentType.NOT)
      .wire(p('n1', 'out'), p('n2', 'in1'))
      .wire(p('n2', 'out'), p('n1', 'in1'))
      .build()
    expect(c.oscillated).toBe(false)
    expect(c.pin(p('n1', 'out'))).toBe(X)
    expect(c.pin(p('n2', 'out'))).toBe(X)
    expect(c.time).toBe(0)
  })

  it('a single inverter fed by its own output is stable at X', () => {
    const c = new CircuitBuilder().add('n', ComponentType.NOT).wire(p('n', 'out'), p('n', 'in1')).build()
    expect(c.oscillated).toBe(false)
    expect(c.pin(p('n', 'out'))).toBe(X)
  })

  it('the halt empties the event queue', () => {
    const c = ring()
    c.set('en', ONE)
    expect(c.sim.changeStep()).toBe(false)
  })

  it('draining after the halt does not restart the ring', () => {
    const c = ring()
    c.set('en', ONE)
    const time = c.time
    const values = c.sim.getPinValues()
    c.sim.drain()
    expect(c.time).toBe(time)
    expect(c.sim.getPinValues()).toEqual(values)
  })

  it('a settled circuit never reports oscillation', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .add('n', ComponentType.NOT)
      .wire(p('a', 'out'), p('n', 'in1'))
      .build()
    c.set('a', ONE)
    expect(c.oscillated).toBe(false)
  })
})

describe('engine: CHANGE mode', () => {
  function chain(): Circuit {
    return new CircuitBuilder()
      .switch('a', ZERO)
      .add('n1', ComponentType.NOT)
      .add('n2', ComponentType.NOT)
      .probe('pr')
      .wire(p('a', 'out'), p('n1', 'in1'))
      .wire(p('n1', 'out'), p('n2', 'in1'))
      .wire(p('n2', 'out'), p('pr', 'in'))
      .build()
  }

  it('changeStep returns false on an idle circuit and leaves time alone', () => {
    const c = chain()
    expect(c.sim.changeStep()).toBe(false)
    expect(c.time).toBe(0)
  })

  it('a toggle with autoProcess = false queues the change without applying it', () => {
    const c = chain()
    expect(c.sim.toggle('a', false)).toBe(ONE)
    expect(c.pin(p('a', 'out'))).toBe(ZERO)
    expect(c.time).toBe(0)
  })

  it('each changeStep applies exactly one queued output change', () => {
    const c = chain()
    c.sim.toggle('a', false)

    expect(c.sim.changeStep()).toBe(true)
    expect(c.time).toBe(1)
    expect(c.pin(p('a', 'out'))).toBe(ONE)
    expect(c.pin(p('n1', 'out'))).toBe(ONE) // not yet
    expect(c.pin(p('n2', 'out'))).toBe(ZERO)

    expect(c.sim.changeStep()).toBe(true)
    expect(c.time).toBe(2)
    expect(c.pin(p('n1', 'out'))).toBe(ZERO)
    expect(c.pin(p('n2', 'out'))).toBe(ZERO) // not yet

    expect(c.sim.changeStep()).toBe(true)
    expect(c.time).toBe(3)
    expect(c.pin(p('n2', 'out'))).toBe(ONE)

    expect(c.sim.changeStep()).toBe(false)
    expect(c.time).toBe(3)
  })

  it('the probe records one sample per applied change', () => {
    const c = chain()
    c.sim.toggle('a', false)
    while (c.sim.changeStep()) {
      /* drain one change at a time */
    }
    expect(trace(c, 'pr')).toEqual([
      [0, ZERO],
      [3, ONE]
    ])
  })

  it('two switches queued at the same instant are applied one changeStep at a time', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .switch('b', ZERO)
      .add('g', ComponentType.AND2)
      .probe('pr')
      .wire(p('a', 'out'), p('g', 'in1'))
      .wire(p('b', 'out'), p('g', 'in2'))
      .wire(p('g', 'out'), p('pr', 'in'))
      .build()
    c.sim.toggle('a', false)
    c.sim.toggle('b', false)

    expect(c.sim.changeStep()).toBe(true)
    expect(c.time).toBe(1)
    expect([c.pin(p('a', 'out')), c.pin(p('b', 'out'))]).toEqual([ONE, ZERO])
    expect(c.pin(p('g', 'out'))).toBe(ZERO)

    expect(c.sim.changeStep()).toBe(true)
    expect(c.time).toBe(1)
    expect(c.pin(p('b', 'out'))).toBe(ONE)
    expect(c.pin(p('g', 'out'))).toBe(ZERO) // the AND change is queued for t = 2

    expect(c.sim.changeStep()).toBe(true)
    expect(c.time).toBe(2)
    expect(c.pin(p('g', 'out'))).toBe(ONE)
    expect(c.sim.changeStep()).toBe(false)
  })

  it('two parts changing at one instant are still one output change per changeStep', () => {
    // Applying the switch change re-evaluates both inverters at t = 1, but each
    // inverter output is its own pending change at t = 2 (manual, CHANGE mode).
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .add('g1', ComponentType.NOT)
      .add('g2', ComponentType.NOT)
      .wire(p('a', 'out'), p('g1', 'in1'))
      .wire(p('a', 'out'), p('g2', 'in1'))
      .build()
    c.sim.toggle('a', false)
    expect(c.sim.changeStep()).toBe(true)
    expect(c.time).toBe(1)
    expect([c.pin(p('g1', 'out')), c.pin(p('g2', 'out'))]).toEqual([ONE, ONE])

    expect(c.sim.changeStep()).toBe(true)
    expect(c.time).toBe(2)
    const half = [c.pin(p('g1', 'out')), c.pin(p('g2', 'out'))]
    expect(half.filter((v) => v === ZERO)).toHaveLength(1) // exactly one applied

    expect(c.sim.changeStep()).toBe(true)
    expect(c.time).toBe(2)
    expect([c.pin(p('g1', 'out')), c.pin(p('g2', 'out'))]).toEqual([ZERO, ZERO])
    expect(c.sim.changeStep()).toBe(false)
  })

  it('drain finishes a partially stepped run', () => {
    const c = chain()
    c.sim.toggle('a', false)
    c.sim.changeStep()
    c.sim.drain()
    expect(c.pin(p('n2', 'out'))).toBe(ONE)
    expect(c.time).toBe(3)
    expect(c.sim.changeStep()).toBe(false)
  })

  it('drain on an idle circuit changes nothing', () => {
    const c = chain()
    const before = c.sim.getPinValues()
    c.sim.drain()
    expect(c.sim.getPinValues()).toEqual(before)
    expect(c.time).toBe(0)
  })
})

describe('engine: stopping at a limit and resuming', () => {
  function clocked(): Circuit {
    return new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .probe('pr')
      .wire(p('clk', 'out'), p('pr', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 100 })
      .build()
  }

  it('Go stops a quarter period before the next active edge (decision 5)', () => {
    const c = clocked()
    c.go()
    expect(c.time).toBe(95)
  })

  it('a second Go is relative to the current time and resumes the queued edge', () => {
    const c = clocked()
    c.go()
    expect(trace(c, 'pr').some(([t]) => t === 100)).toBe(false)
    c.go()
    expect(c.time).toBe(195)
    expect(trace(c, 'pr')).toContainEqual([100, ONE])
  })

  it('the clock toggles land on the absolute grid across both runs', () => {
    const c = clocked()
    c.go()
    c.go()
    const times = trace(c, 'pr').map(([t]) => t)
    expect(times).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190])
  })

  it('Step runs to a quarter period before the next edge and keeps later events queued', () => {
    const c = clocked()
    c.step()
    expect(c.time).toBe(15)
    expect(trace(c, 'pr')).toEqual([
      [0, ONE],
      [10, ZERO]
    ])
    c.step()
    expect(c.time).toBe(35)
    expect(trace(c, 'pr')).toContainEqual([20, ONE])
  })

  it('a Step after switch toggles never replays past clock edges (decision 13)', () => {
    const c = new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .switch('a', ZERO)
      .probe('pr')
      .probe('ps')
      .wire(p('clk', 'out'), p('pr', 'in'))
      .wire(p('a', 'out'), p('ps', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 100 })
      .build()
    for (let i = 0; i < 12; i++) c.toggle('a') // advances time to 12
    expect(c.time).toBe(12)
    c.step() // to 15: the toggle at 10 is in the past and is never queued
    expect(c.time).toBe(15)
    expect(trace(c, 'pr')).toEqual([[0, ONE]])
    c.step()
    expect(c.time).toBe(35)
    const times = trace(c, 'pr').map(([t]) => t)
    expect(times.every((t, i) => i === 0 || t > times[i - 1])).toBe(true)
    expect(times).not.toContain(10)
    // Resumes on the absolute grid: the drive at 20 restates the value the clock
    // already has (its 10 ns toggle was skipped), so only 30 records a change.
    expect(times).toEqual([0, 30])
  })
})

describe('engine: readout', () => {
  function mixed(): Circuit {
    return new CircuitBuilder()
      .switch('a', ONE)
      .add('bi', ComponentType.BUS_INPUT, { bits: 8, label: 'A5' })
      .add('sp', ComponentType.SPLITTER, { bits: 8 })
      .add('mg', ComponentType.MERGER, { bits: 8 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 8 })
      .add('tap', ComponentType.BUS_TAP, { bits: 1, tapStart: 2 })
      .add('g', ComponentType.AND2)
      .probe('pr')
      .wire(p('bi', 'out'), p('sp', 'in'))
      .wire(p('bi', 'out'), p('tap', 'in'))
      .wire(p('mg', 'out'), p('bp', 'in'))
      .wire(p('tap', 'out'), p('g', 'in1'))
      .wire(p('a', 'out'), p('g', 'in2'))
      .wire(p('g', 'out'), p('pr', 'in'))
      .build()
  }

  it('getPinValues and getBusPinValues partition every pin in the circuit', () => {
    const c = mixed()
    const single = Object.keys(c.sim.getPinValues())
    const bus = Object.keys(c.sim.getBusPinValues())
    expect(single.filter((k) => bus.includes(k))).toEqual([])
    const all = getAllPins(c.sim.sourceNetlist).map((pin) => pin.pinId)
    expect([...single, ...bus].sort()).toEqual([...all].sort())
  })

  it('bus pins are absent from getPinValues and single-bit pins from getBusPinValues', () => {
    const c = mixed()
    expect(c.sim.getPinValues()[p('bi', 'out')]).toBeUndefined()
    expect(c.sim.getBusPinValues()[p('bi', 'out')]).toBe('A5')
    expect(c.sim.getBusPinValues()[p('g', 'out')]).toBeUndefined()
    expect(c.sim.getPinValues()[p('g', 'out')]).toBe(ONE) // bit 2 of A5 (1010 0101) is 1
  })

  it('the partition still holds for a netlist containing every part type', () => {
    const components = ALL_TYPES.map((type, i) => comp(`c${i}`, type, i * 1000, 0, { bits: 4 }))
    const netlist = rawNetlist(components)
    const sim = new Simulator(netlist, netlist.metadata.simulation, {})
    const single = Object.keys(sim.getPinValues())
    const bus = Object.keys(sim.getBusPinValues())
    expect(single.filter((k) => bus.includes(k))).toEqual([])
    expect([...single, ...bus].sort()).toEqual(getAllPins(netlist).map((pin) => pin.pinId).sort())
  })

  it('a bus probe trace carries hex samples', () => {
    const c = mixed()
    expect(hexTrace(c, 'bp')).toEqual([[0, 'ZZ']]) // merger inputs are unconnected
  })

  it('getWaveforms lists probes in placement order and flags the bus ones', () => {
    const c = new CircuitBuilder()
      .probe('first')
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
      .probe('last')
      .build()
    expect(c.sim.getWaveforms().map((w) => [w.probeId, w.bus])).toEqual([
      ['first', false],
      ['bp', true],
      ['last', false]
    ])
  })

  it('a probe on an unconnected net records a single Z sample', () => {
    const c = new CircuitBuilder().probe('pr').build()
    expect(trace(c, 'pr')).toEqual([[0, Z]])
    c.sim.drain()
    expect(trace(c, 'pr')).toEqual([[0, Z]])
  })

  it('reset replaces the recorded samples instead of appending to them', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .probe('pr')
      .wire(p('a', 'out'), p('pr', 'in'))
      .build()
    c.set('a', ONE)
    c.set('a', ZERO)
    expect(trace(c, 'pr')).toHaveLength(3)
    c.reset()
    expect(trace(c, 'pr')).toEqual([[0, ZERO]])
  })

  it('getCheckerResult is null when the circuit has no checker', () => {
    const c = new CircuitBuilder().switch('a', ZERO).build()
    expect(c.sim.getCheckerResult()).toBeNull()
    expect(c.sim.getSmDisplays()).toEqual({})
    expect(c.sim.getSmActive()).toEqual({})
  })
})

describe('engine: hasXZ', () => {
  it('is false for a fully driven single-bit circuit', () => {
    const c = new CircuitBuilder()
      .switch('a', ONE)
      .switch('b', ZERO)
      .add('g', ComponentType.AND2)
      .probe('pr')
      .wire(p('a', 'out'), p('g', 'in1'))
      .wire(p('b', 'out'), p('g', 'in2'))
      .wire(p('g', 'out'), p('pr', 'in'))
      .build()
    expect(c.sim.hasXZ()).toBe(false)
    c.set('b', ONE)
    expect(c.sim.hasXZ()).toBe(false)
  })

  it('is true when any pin is unconnected', () => {
    const c = new CircuitBuilder()
      .switch('a', ONE)
      .add('g', ComponentType.AND2)
      .probe('pr')
      .wire(p('a', 'out'), p('g', 'in1'))
      .wire(p('g', 'out'), p('pr', 'in'))
      .build()
    expect(c.pin(p('g', 'in2'))).toBe(Z)
    expect(c.sim.hasXZ()).toBe(true)
  })

  it('is true while a flip-flop is unresolved and false once it is preset', () => {
    const c = new CircuitBuilder()
      .switch('s', ONE)
      .switch('clk', ZERO)
      .switch('d', ZERO)
      .add('vcc', ComponentType.VCC)
      .add('ff', ComponentType.D_FLIPFLOP)
      .probe('q')
      .probe('qn')
      .wire(p('d', 'out'), p('ff', 'D'))
      .wire(p('clk', 'out'), p('ff', 'CLK'))
      .wire(p('s', 'out'), p('ff', 'S'))
      .wire(p('vcc', 'out'), p('ff', 'R'))
      .wire(p('ff', 'Q'), p('q', 'in'))
      .wire(p('ff', "Q'"), p('qn', 'in'))
      .build()
    expect(c.sim.hasXZ()).toBe(true)
    c.set('s', ZERO) // asynchronous preset resolves Q
    expect(c.pin(p('ff', 'Q'))).toBe(ONE)
    expect(c.sim.hasXZ()).toBe(false)
  })

  it('is true for a bus net left floating and false once driven', () => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 4, label: 'C' })
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
      .add('idle', ComponentType.BUS_PROBE, { bits: 4 })
      .wire(p('bi', 'out'), p('bp', 'in'))
      .build()
    expect(c.bus(p('idle', 'in'))).toBe('Z')
    expect(c.sim.hasXZ()).toBe(true)

    const driven = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 4, label: 'C' })
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
      .wire(p('bi', 'out'), p('bp', 'in'))
      .build()
    expect(driven.sim.hasXZ()).toBe(false)
  })

  it('is true when a bus label does not parse (spec decision 10)', () => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 4, label: 'FF' })
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
      .wire(p('bi', 'out'), p('bp', 'in'))
      .build()
    expect(c.bus(p('bp', 'in'))).toBe('X')
    expect(c.sim.hasXZ()).toBe(true)
  })

  it('is true for a net with two conflicting drivers', () => {
    const c = new CircuitBuilder()
      .add('vcc', ComponentType.VCC)
      .add('gnd', ComponentType.GROUND)
      .probe('pr')
      .wire(p('vcc', 'out'), p('pr', 'in'))
      .wire(p('gnd', 'out'), p('pr', 'in'))
      .build()
    expect(c.pin(p('pr', 'in'))).toBe(X)
    expect(c.sim.hasXZ()).toBe(true)
  })
})

describe('engine: net changes drive exactly the components that read them', () => {
  it('a probe on a driver net does not make the driver re-evaluate', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .add('n', ComponentType.NOT, { delay: 4 })
      .probe('pr')
      .wire(p('a', 'out'), p('n', 'in1'))
      .wire(p('n', 'out'), p('pr', 'in'))
      .build()
    c.set('a', ONE)
    expect(c.time).toBe(5) // switch 1 + NOT 4, with no extra round trip
    expect(trace(c, 'pr')).toEqual([
      [0, ONE],
      [5, ZERO]
    ])
  })

  it('a fan-out of eight readers all update in the same instant', () => {
    const b = new CircuitBuilder().switch('a', ZERO)
    for (let i = 0; i < 8; i++) {
      b.add(`n${i}`, ComponentType.NOT)
        .probe(`p${i}`)
        .wire(p('a', 'out'), p(`n${i}`, 'in1'))
        .wire(p(`n${i}`, 'out'), p(`p${i}`, 'in'))
    }
    const c = b.build()
    c.set('a', ONE)
    expect(c.time).toBe(2)
    for (let i = 0; i < 8; i++) {
      expect(trace(c, `p${i}`)).toEqual([
        [0, ONE],
        [2, ZERO]
      ])
    }
  })

  it('an unread net still resolves and is visible on its pins', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .add('n', ComponentType.NOT)
      .wire(p('a', 'out'), p('n', 'in1'))
      .build()
    expect(c.pin(p('n', 'out'))).toBe(ONE)
    c.set('a', ONE)
    expect(c.pin(p('n', 'out'))).toBe(ZERO)
  })

  it('a twenty-inverter chain settles at one nanosecond per stage', () => {
    const b = new CircuitBuilder().switch('a', ZERO).probe('pr')
    for (let i = 0; i < 20; i++) {
      b.add(`n${i}`, ComponentType.NOT).wire(i === 0 ? p('a', 'out') : p(`n${i - 1}`, 'out'), p(`n${i}`, 'in1'))
    }
    const c = b.wire(p('n19', 'out'), p('pr', 'in')).build()
    expect(c.pin(p('n19', 'out'))).toBe(ZERO)
    c.set('a', ONE)
    expect(c.pin(p('n19', 'out'))).toBe(ONE)
    expect(c.time).toBe(21)
    expect(trace(c, 'pr')).toEqual([
      [0, ZERO],
      [21, ONE]
    ])
  })

  it('a wide fan-out of 200 gates settles without tripping the event limit', () => {
    const b = new CircuitBuilder().switch('a', ZERO)
    for (let i = 0; i < 200; i++) {
      b.add(`n${i}`, ComponentType.NOT).wire(p('a', 'out'), p(`n${i}`, 'in1'))
    }
    const c = b.build()
    c.set('a', ONE)
    expect(c.oscillated).toBe(false)
    expect(c.time).toBe(2)
    for (let i = 0; i < 200; i++) expect(c.pin(p(`n${i}`, 'out'))).toBe(ZERO)
  })

  it('probe traces never step backwards in time across toggles and clock runs', () => {
    const c = new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .switch('a', ZERO)
      .add('g', ComponentType.XOR2)
      .probe('pr')
      .wire(p('clk', 'out'), p('g', 'in1'))
      .wire(p('a', 'out'), p('g', 'in2'))
      .wire(p('g', 'out'), p('pr', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 60 })
      .build()
    c.toggle('a')
    c.step()
    c.toggle('a')
    c.go()
    c.step()
    const times = trace(c, 'pr').map(([t]) => t)
    expect(times.length).toBeGreaterThan(2)
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1])
  })

  it('simulated time never goes backwards across mixed control calls', () => {
    const c = new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .switch('a', ZERO)
      .add('g', ComponentType.AND2)
      .wire(p('clk', 'out'), p('g', 'in1'))
      .wire(p('a', 'out'), p('g', 'in2'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 40 })
      .build()
    const seen: number[] = [c.time]
    c.step()
    seen.push(c.time)
    c.toggle('a')
    seen.push(c.time)
    c.go()
    seen.push(c.time)
    c.step()
    seen.push(c.time)
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1])
    c.reset()
    expect(c.time).toBe(0)
  })

  it('an event landing exactly on the run limit is applied', () => {
    const c = new CircuitBuilder()
      .add('sig', ComponentType.INPUT_SIGNAL, {
        signal: [
          { timeNs: 0, value: ZERO },
          { timeNs: 20, value: ONE }
        ]
      })
      .probe('pr')
      .wire(p('sig', 'out'), p('pr', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 20 })
      .build()
    c.go() // horizon is exactly 20
    expect(c.time).toBe(20)
    expect(c.pin(p('sig', 'out'))).toBe(ONE)
    expect(trace(c, 'pr')).toEqual([
      [0, ZERO],
      [20, ONE]
    ])
  })
})

describe('engine: bus nets', () => {
  /** Splits `net` into single-bit outputs so per-bit resolution is observable. */
  function splitBits(c: Circuit, n: number): string {
    let s = ''
    for (let i = n - 1; i >= 0; i--) s += c.pin(p('sp', `out${i}`))
    return s
  }

  it('two bus drivers with the same value keep it', () => {
    const c = new CircuitBuilder()
      .add('b1', ComponentType.BUS_INPUT, { bits: 4, label: '5' })
      .add('b2', ComponentType.BUS_INPUT, { bits: 4, label: '5' })
      .add('sp', ComponentType.SPLITTER, { bits: 4 })
      .wire(p('b1', 'out'), p('sp', 'in'))
      .wire(p('b2', 'out'), p('sp', 'in'))
      .build()
    expect(splitBits(c, 4)).toBe('0101')
  })

  it('two disagreeing bus drivers resolve bit by bit', () => {
    const c = new CircuitBuilder()
      .add('b1', ComponentType.BUS_INPUT, { bits: 4, label: '5' }) // 0101
      .add('b2', ComponentType.BUS_INPUT, { bits: 4, label: '3' }) // 0011
      .add('sp', ComponentType.SPLITTER, { bits: 4 })
      .wire(p('b1', 'out'), p('sp', 'in'))
      .wire(p('b2', 'out'), p('sp', 'in'))
      .build()
    expect(splitBits(c, 4)).toBe('0XX1')
  })

  it('a narrow driver on a wide bus leaves the missing high bits X', () => {
    const c = new CircuitBuilder()
      .add('b1', ComponentType.BUS_INPUT, { bits: 4, label: 'A' }) // 1010
      .add('sp', ComponentType.SPLITTER, { bits: 8 })
      .wire(p('b1', 'out'), p('sp', 'in'))
      .build()
    expect(splitBits(c, 8)).toBe('XXXX1010')
  })

  it('an undriven bus net is Z on every bit', () => {
    const c = new CircuitBuilder().add('sp', ComponentType.SPLITTER, { bits: 4 }).build()
    expect(splitBits(c, 4)).toBe('ZZZZ')
    expect(c.bus(p('sp', 'in'))).toBe('Z')
  })

  it('bus outputs use the same inertial delay as single-bit outputs', () => {
    const rows = [
      { timeNs: 0, value: ZERO },
      { timeNs: 3, value: ONE },
      { timeNs: 4, value: ZERO }
    ]
    const build = (delay: number): Circuit =>
      new CircuitBuilder()
        .add('sig', ComponentType.INPUT_SIGNAL, { signal: rows })
        .add('gnd', ComponentType.GROUND)
        .add('mg', ComponentType.MERGER, { bits: 2, delay })
        .add('bp', ComponentType.BUS_PROBE, { bits: 2 })
        .wire(p('sig', 'out'), p('mg', 'in0'))
        .wire(p('gnd', 'out'), p('mg', 'in1'))
        .wire(p('mg', 'out'), p('bp', 'in'))
        .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 20 })
        .build()

    const fast = build(1)
    fast.go()
    expect(hexTrace(fast, 'bp')).toEqual([
      [0, '0'],
      [4, '1'],
      [5, '0']
    ])

    const slow = build(3)
    slow.go()
    expect(hexTrace(slow, 'bp')).toEqual([[0, '0']]) // pulse narrower than the delay
  })

  it('a bus probe records one sample per instant', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .switch('b', ZERO)
      .add('mg', ComponentType.MERGER, { bits: 2 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 2 })
      .wire(p('a', 'out'), p('mg', 'in0'))
      .wire(p('b', 'out'), p('mg', 'in1'))
      .wire(p('mg', 'out'), p('bp', 'in'))
      .build()
    expect(hexTrace(c, 'bp')).toEqual([[0, '0']])
    c.setMany({ a: ONE, b: ONE }) // both bits change at one instant
    expect(hexTrace(c, 'bp')).toEqual([
      [0, '0'],
      [2, '3']
    ])
  })
})

describe('wires the editor produces', () => {
  // The wire tool only ends a wire on a pin (findPinAt) or on a double-clicked
  // point, so it can never create the "ends mid-segment" wire that would look
  // connected but is not. These drive the same store actions the tool calls.
  function fresh(components: Component[]): void {
    useCircuitStore.getState().newCircuit()
    useCircuitStore.getState().loadNetlist(rawNetlist(components), null)
  }
  const store = (): ReturnType<typeof useCircuitStore.getState> => useCircuitStore.getState()

  const sw = comp('sw', ComponentType.SWITCH, 0, 0) // out at (40,20)
  const not = comp('n', ComponentType.NOT, 200, 60) // in1 at (200,80)

  it('finishing on a pin records that pin and lands exactly on its coordinate', () => {
    fresh([sw, not])
    store().beginWire(p('sw', 'out'), { x: 40, y: 20 })
    expect(store().finishWire({ x: 200, y: 80 }, p('n', 'in1'), true)).toBe(true)
    const wire = store().netlist.wires[0]
    expect(wire.fromPinId).toBe(p('sw', 'out'))
    expect(wire.toPinId).toBe(p('n', 'in1'))
    const pts = segmentsToPoints(wire.segments)
    expect(pts[0]).toEqual({ x: 40, y: 20 })
    expect(pts[pts.length - 1]).toEqual({ x: 200, y: 80 })
    expect(sameNet(resolveNets(store().netlist), p('sw', 'out'), p('n', 'in1'))).toBe(true)
  })

  it('every segment of a routed wire stays horizontal or vertical', () => {
    fresh([sw, not])
    store().beginWire(p('sw', 'out'), { x: 40, y: 20 })
    store().addWirePoint({ x: 120, y: 200 }, true)
    store().addWirePoint({ x: 160, y: 40 }, false)
    store().finishWire({ x: 200, y: 80 }, p('n', 'in1'), true)
    for (const seg of store().netlist.wires[0].segments) {
      expect(seg.x1 === seg.x2 || seg.y1 === seg.y2).toBe(true)
    }
    expect(sameNet(resolveNets(store().netlist), p('sw', 'out'), p('n', 'in1'))).toBe(true)
  })

  it('a double-click finish leaves the wire dangling with no pin reference', () => {
    fresh([sw, not])
    store().beginWire(p('sw', 'out'), { x: 40, y: 20 })
    expect(store().finishWire({ x: 120, y: 20 }, null, true)).toBe(true)
    const wire = store().netlist.wires[0]
    expect(wire.toPinId).toBeNull()
    expect(segmentsToPoints(wire.segments).at(-1)).toEqual({ x: 120, y: 20 })
  })

  it('a double-click on another wire\'s segment neither connects nor draws a dot', () => {
    fresh([sw, not])
    store().beginWire(p('sw', 'out'), { x: 40, y: 20 })
    store().finishWire({ x: 200, y: 20 }, null, true) // horizontal wire y = 20
    store().beginWire(null, { x: 120, y: 100 })
    store().finishWire({ x: 120, y: 20 }, null, false) // ends on the middle of it
    const netlist = store().netlist
    const nets = resolveNets(netlist)
    const [w0, w1] = netlist.wires
    expect(netOfWire(nets, w0.id)).not.toBe(netOfWire(nets, w1.id))
    expect(hasDotAt(netlist, 120, 20)).toBe(false)
  })

  it('a wire finished on the pin it started from changes no connectivity', () => {
    fresh([sw, not])
    store().beginWire(p('sw', 'out'), { x: 40, y: 20 })
    store().finishWire({ x: 40, y: 20 }, p('sw', 'out'), true)
    const nets = resolveNets(store().netlist)
    expect(netOfPin(nets, p('sw', 'out')).pinIds).toEqual([p('sw', 'out')])
    expect(sameNet(nets, p('sw', 'out'), p('n', 'in1'))).toBe(false)
  })

  it('cancelling a draft leaves no wire behind', () => {
    fresh([sw, not])
    store().beginWire(p('sw', 'out'), { x: 40, y: 20 })
    store().addWirePoint({ x: 120, y: 20 }, true)
    store().cancelWire()
    expect(store().netlist.wires).toHaveLength(0)
    expect(store().interaction.wireDraft).toBeNull()
  })

  it('two wires finished on the same pin share a net', () => {
    const pr = comp('pr', ComponentType.PROBE, 200, 200) // in at (200,220)
    fresh([sw, not, pr])
    store().beginWire(p('sw', 'out'), { x: 40, y: 20 })
    store().finishWire({ x: 200, y: 80 }, p('n', 'in1'), true)
    store().beginWire(p('pr', 'in'), { x: 200, y: 220 })
    store().finishWire({ x: 200, y: 80 }, p('n', 'in1'), false)
    const nets = resolveNets(store().netlist)
    expect(netOfPin(nets, p('sw', 'out')).pinIds.sort()).toEqual(
      [p('sw', 'out'), p('n', 'in1'), p('pr', 'in')].sort()
    )
  })
})
