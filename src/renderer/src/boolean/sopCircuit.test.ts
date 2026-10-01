import { describe, expect, it } from 'vitest'
import { ComponentType, LogicValue, type Netlist } from '../model/types'
import { defOf } from '../model/partDefinitions'
import { getAllPins } from '../geometry/pins'
import { resolveNets } from '../netlist/nets'
import { deserializeNetlist, serializeNetlist } from '../serialization/ckt'
import { Simulator, type WaveformTrace } from '../sim/engine'
import { analyzeExpression, formatSop, minimumCover, type BooleanAnalysis } from './expression'
import { buildSopCircuit, stimulusRows, STIMULUS_INTERVAL_NS } from './sopCircuit'

function valueAt(trace: WaveformTrace, t: number): LogicValue {
  let v = trace.samples[0]?.v ?? LogicValue.Z
  for (const s of trace.samples) if (s.t <= t) v = s.v
  return v
}

function simulate(netlist: Netlist): { traces: Map<string, WaveformTrace>; time: number } {
  const sim = new Simulator(netlist, netlist.metadata.simulation, {})
  sim.go()
  const labels = new Map(netlist.components.map((c) => [c.id, c.label]))
  return { traces: new Map(sim.getWaveforms().map((t) => [labels.get(t.probeId)!, t])), time: sim.time }
}

/** Asserts every probe matches the stimulus and the truth table mid-interval. */
function expectMatchesTruthTable(a: BooleanAnalysis, netlist: Netlist): void {
  const { traces, time } = simulate(netlist)
  const n = a.variables.length
  expect(time).toBe((1 << n) * STIMULUS_INTERVAL_NS)
  expect([...traces.keys()]).toEqual([...a.variables, a.outputName])
  for (const row of a.rows) {
    const t = row.index * STIMULUS_INTERVAL_NS + STIMULUS_INTERVAL_NS / 2
    const seen = [...a.variables, a.outputName].map((name) => valueAt(traces.get(name)!, t)).join('')
    expect(seen, `${a.minimumSop} row ${row.index}`).toBe([...row.inputs, row.output].join(''))
  }
}

function boxesOverlap(netlist: Netlist): string[] {
  const boxes = netlist.components.map((c) => ({ id: c.id, x: c.x, y: c.y, ...defOf(c) }))
  const hits: string[] = []
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]
      const b = boxes[j]
      if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) {
        hits.push(`${a.id}/${b.id}`)
      }
    }
  }
  return hits
}

/** Wires that run through a part's body or over a pin without ending there. */
function visualCollisions(netlist: Netlist): string[] {
  const hits: string[] = []
  const pins = getAllPins(netlist)
  for (const w of netlist.wires) {
    for (const s of w.segments) {
      const [x1, x2] = [Math.min(s.x1, s.x2), Math.max(s.x1, s.x2)]
      const [y1, y2] = [Math.min(s.y1, s.y2), Math.max(s.y1, s.y2)]
      for (const c of netlist.components) {
        const d = defOf(c)
        if (x1 < c.x + d.width - 1 && x2 > c.x + 1 && y1 < c.y + d.height - 1 && y2 > c.y + 1) {
          hits.push(`${w.id} crosses ${c.id}`)
        }
      }
      for (const p of pins) {
        const inside = p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2
        const atEnd = (p.x === s.x1 && p.y === s.y1) || (p.x === s.x2 && p.y === s.y2)
        if (inside && !atEnd) hits.push(`${w.id} passes over ${p.pinId}`)
      }
    }
  }
  return hits
}

function fromOnSet(onSet: number, vars: string[]): BooleanAnalysis {
  const terms = minimumCover(onSet, vars.length)
  return analyzeExpression(formatSop(terms, vars), vars.join(' '))
}

describe('stimulus', () => {
  it('counts ABCD from 0000 at 0 ns to 1111 at 1500 ns', () => {
    expect(stimulusRows(0, 4)).toEqual([{ timeNs: 0, value: '0' }, { timeNs: 800, value: '1' }])
    expect(stimulusRows(3, 4)).toHaveLength(16)
    expect(stimulusRows(3, 4).at(-1)).toEqual({ timeNs: 1500, value: '1' })
    expect(stimulusRows(1, 4).map((r) => r.timeNs)).toEqual([0, 400, 800, 1200])
  })
})

describe('SOP circuit builder', () => {
  const lab = analyzeExpression("BCD + ABCD' + C'D + AB'D", 'A B C D')
  const netlist = buildSopCircuit(lab)

  it('builds labeled, wired parts for the minimum SOP', () => {
    const count = (type: ComponentType): number => netlist.components.filter((c) => c.type === type).length
    expect(count(ComponentType.INPUT_SIGNAL)).toBe(4)
    expect(count(ComponentType.NOT)).toBe(1)
    expect(count(ComponentType.AND2)).toBe(3)
    expect(count(ComponentType.AND3)).toBe(1)
    expect(count(ComponentType.OR4)).toBe(1)
    expect(netlist.components.filter((c) => c.type === ComponentType.PROBE).map((c) => c.label))
      .toEqual(['A', 'B', 'C', 'D', 'F'])
    expect(netlist.components.filter((c) => c.type === ComponentType.AND2 || c.type === ComponentType.AND3)
      .map((c) => c.label)).toEqual(['AD', 'BD', "C'D", 'ABC'])
    expect(netlist.metadata.simulation.simTimeNs).toBe(1600)
    // Pin labels are only on the input sources, so the logic depends on drawn wires.
    expect(netlist.components.filter((c) => Object.keys(c.pinLabels).length > 0).map((c) => c.id))
      .toEqual(['in-A', 'in-B', 'in-C', 'in-D'])
  })

  it('simulates to the truth table through the real engine', () => {
    expectMatchesTruthTable(lab, netlist)
  })

  it('fits on a laptop-width canvas without overlapping parts', () => {
    expect(boxesOverlap(netlist)).toEqual([])
    expect(visualCollisions(netlist)).toEqual([])
    const maxX = Math.max(...netlist.components.map((c) => c.x + defOf(c).width))
    const maxY = Math.max(...netlist.components.map((c) => c.y + defOf(c).height))
    expect(maxX).toBeLessThanOrEqual(800)
    expect(maxY).toBeLessThanOrEqual(800)
  })

  it('draws only orthogonal wires and leaves no pin unconnected', () => {
    for (const w of netlist.wires) {
      for (const s of w.segments) expect(s.x1 === s.x2 || s.y1 === s.y2, w.id).toBe(true)
    }
    const nets = resolveNets(netlist)
    for (const pin of getAllPins(netlist)) {
      const net = nets.find((n) => n.pinIds.includes(pin.pinId))!
      expect(net.wireIds.length, pin.pinId).toBeGreaterThan(0)
    }
  })

  it('round-trips through the .ckt serializer', () => {
    const reopened = deserializeNetlist(serializeNetlist(netlist))
    expect(reopened).toEqual(netlist)
    expectMatchesTruthTable(lab, reopened)
  })

  it('keeps all four inputs and stimuli when the minimum SOP drops one', () => {
    const a = analyzeExpression("AB + AB'C + ABC'", 'A B C D')
    expect(a.minimumSop).toBe('AB + AC')
    const built = buildSopCircuit(a)
    expect(built.components.filter((c) => c.type === ComponentType.INPUT_SIGNAL).map((c) => c.label))
      .toEqual(['A', 'B', 'C', 'D'])
    expectMatchesTruthTable(a, built)
  })

  it.each(['0', '1', 'A', "D'", "A + B'", "AB'C'D"])('handles the edge case F = %s', (expression) => {
    const a = analyzeExpression(expression, 'A B C D')
    const built = buildSopCircuit(a)
    expect(boxesOverlap(built)).toEqual([])
    expectMatchesTruthTable(a, built)
  })

  it('handles every function of three inputs', () => {
    for (let f = 0; f < 256; f++) {
      const a = fromOnSet(f, ['X', 'Y', 'Z'])
      const built = buildSopCircuit(a)
      expect(boxesOverlap(built), a.minimumSop).toEqual([])
      expect(visualCollisions(built), a.minimumSop).toEqual([])
      expectMatchesTruthTable(a, built)
    }
  })

  it('handles wide four-input functions, including an eight-term OR tree', () => {
    const fns = [0x6996, 0x9669, 0x7ffe, 0x1ff8, 0x5a5a, 0xffff, 0x0001]
    let seed = 11
    for (let i = 0; i < 60; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      fns.push(seed & 0xffff)
    }
    for (const f of fns) {
      const a = fromOnSet(f, ['A', 'B', 'C', 'D'])
      const built = buildSopCircuit(a)
      expect(boxesOverlap(built), a.minimumSop).toEqual([])
      expect(visualCollisions(built), a.minimumSop).toEqual([])
      expectMatchesTruthTable(a, built)
    }
  })
})
