// ECE 3441 Lab 3 acceptance: the saved sample circuit for the assigned function
// F = BCD + ABCD' + C'D + AB'D, loaded through the .ckt serializer and run on the
// real simulation engine. Expected values are an independent hand-derived truth
// table, not the parser's output.
//
// Regenerate the sample with: UPDATE_LAB3_SAMPLE=1 npx vitest run lab3Acceptance

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LogicValue, type Netlist } from '../model/types'
import { deserializeNetlist, serializeNetlist } from '../serialization/ckt'
import { Simulator, type WaveformTrace } from '../sim/engine'
import { analyzeExpression } from './expression'
import { buildSopCircuit } from './sopCircuit'

const SAMPLE = new URL('../../../../samples/lab3-assigned.ckt', import.meta.url)
const EXPRESSION = "BCD + ABCD' + C'D + AB'D"
const SAMPLE_TIMESTAMP = '2026-09-30T00:00:00.000Z'

// Minterms 1, 5, 7, 9, 11, 13, 14, 15 (by K-map, independently of the code).
const EXPECTED_F = '0100010101010111'

function buildSample(): Netlist {
  return buildSopCircuit(analyzeExpression(EXPRESSION, 'A B C D'), {
    name: 'lab3-assigned',
    timestamp: SAMPLE_TIMESTAMP
  })
}

if (process.env.UPDATE_LAB3_SAMPLE) writeFileSync(SAMPLE, serializeNetlist(buildSample()) + '\n')

function valueAt(trace: WaveformTrace, t: number): LogicValue {
  let v = trace.samples[0].v
  for (const s of trace.samples) if (s.t <= t) v = s.v
  return v
}

describe('Lab 3 sample circuit (samples/lab3-assigned.ckt)', () => {
  expect(existsSync(SAMPLE)).toBe(true)
  const netlist = deserializeNetlist(readFileSync(SAMPLE, 'utf8'))
  const sim = new Simulator(netlist, netlist.metadata.simulation, netlist.metadata.switchValues ?? {})
  sim.go()
  const labels = new Map(netlist.components.map((c) => [c.id, c.label]))
  const traces = new Map(sim.getWaveforms().map((t) => [labels.get(t.probeId)!, t]))

  it('is the production builder output for the assigned expression', () => {
    const built = buildSample()
    expect(netlist.components).toEqual(built.components)
    expect(netlist.wires).toEqual(built.wires)
    expect(netlist.metadata.simulation).toEqual(built.metadata.simulation)
    expect(analyzeExpression(EXPRESSION, 'A B C D').minimumSop).toBe("AD + BD + C'D + ABC")
  })

  it('runs 0–1600 ns with probes A, B, C, D, F', () => {
    expect(netlist.metadata.simulation.simTimeNs).toBe(1600)
    expect(sim.time).toBe(1600)
    expect(sim.oscillated).toBe(false)
    expect([...traces.keys()]).toEqual(['A', 'B', 'C', 'D', 'F'])
  })

  it.each(Array.from({ length: 16 }, (_, row) => row))('row %i matches the truth table mid-interval', (row) => {
    const t = row * 100 + 50
    const abcd = row.toString(2).padStart(4, '0')
    const seen = ['A', 'B', 'C', 'D', 'F'].map((name) => valueAt(traces.get(name)!, t)).join('')
    expect(seen).toBe(abcd + EXPECTED_F[row])
  })

  it('holds ABCD = 1111, F = 1 at the 1600 ns endpoint', () => {
    expect(['A', 'B', 'C', 'D', 'F'].map((name) => valueAt(traces.get(name)!, 1600)).join('')).toBe('11111')
  })

  it('settles every output change within the 3 ns NOT→AND→OR path delay', () => {
    const f = traces.get('F')!
    for (const s of f.samples.slice(1)) expect(s.t % 100, `F changed at ${s.t} ns`).toBeLessThanOrEqual(3)
    for (const name of ['A', 'B', 'C', 'D']) {
      for (const s of traces.get(name)!.samples) expect(s.t % 100, `${name} changed at ${s.t} ns`).toBe(0)
    }
  })

  it('survives a save and reopen unchanged', () => {
    expect(deserializeNetlist(serializeNetlist(netlist))).toEqual(netlist)
  })
})
