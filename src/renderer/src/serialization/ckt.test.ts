import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ComponentType } from '../model/types'
import { createEmptyNetlist, deserializeNetlist, MAX_CKT_BYTES, serializeNetlist } from './ckt'

function sample(): Record<string, any> {
  return JSON.parse(readFileSync(new URL('../../../../samples/and-gate.ckt', import.meta.url), 'utf8'))
}

describe('circuit file validation', () => {
  it('round-trips all shipped circuits and blank documents', () => {
    for (const name of ['and-gate', 'clock-divider', 'input-signal']) {
      const text = readFileSync(new URL(`../../../../samples/${name}.ckt`, import.meta.url), 'utf8')
      expect(serializeNetlist(deserializeNetlist(text))).toBe(serializeNetlist(JSON.parse(text).netlist))
    }
    const empty = createEmptyNetlist()
    expect(deserializeNetlist(serializeNetlist(empty))).toEqual(empty)
  })

  it.each([
    ['null component', (n: any) => { n.components[0] = null }],
    ['unknown component', (n: any) => { n.components[0].type = 'UNSUPPORTED' }],
    ['prototype component type', (n: any) => { n.components[0].type = 'constructor' }],
    ['duplicate component id', (n: any) => { n.components[1].id = n.components[0].id }],
    ['unsafe component id', (n: any) => { n.components[0].id = '__proto__' }],
    ['invalid component coordinate', (n: any) => { n.components[0].x = '120' }],
    ['invalid pin labels', (n: any) => { n.components[0].pinLabels = null }],
    ['invalid label', (n: any) => { n.components[0].label = {} }],
    ['invalid delay', (n: any) => { n.components[0].delay = -1 }],
    ['fractional bus width', (n: any) => { n.components[0].bits = 2.5 }],
    ['unbounded bus width', (n: any) => { n.components[0].bits = 1e10 }],
    ['malformed waveform', (n: any) => { n.components[0].signal = [null] }],
    ['unknown waveform value', (n: any) => { n.components[0].signal = [{ timeNs: 1, value: '?' }] }],
    ['malformed state table', (n: any) => { n.components[0].smTable = [{ present: 0 }] }],
    ['invalid state machine size', (n: any) => { n.components[0].smInputs = 100 }],
    ['malformed checker', (n: any) => { n.components[0].chk = { input: '01', output: '0' } }],
    ['null wire', (n: any) => { n.wires[0] = null }],
    ['duplicate wire id', (n: any) => { n.wires[1].id = n.wires[0].id }],
    ['missing segments', (n: any) => { n.wires[0].segments = [] }],
    ['malformed segment', (n: any) => { n.wires[0].segments[0].x1 = null }],
    ['malformed endpoint', (n: any) => { n.wires[0].fromPinId = 42 }],
    ['malformed metadata', (n: any) => { n.metadata = [] }],
    ['missing simulation options', (n: any) => { delete n.metadata.simulation }],
    ['invalid simulation options', (n: any) => { n.metadata.simulation.clockPeriodNs = 0 }],
    ['invalid clock value', (n: any) => { n.metadata.simulation.clockInitialValue = '?' }],
    ['invalid scale', (n: any) => { n.metadata.scalingFactor = -1 }],
    ['invalid switch value', (n: any) => { n.metadata.switchValues.swA = '?' }]
  ])('rejects %s before loading document', (_name, mutate) => {
    const file = sample()
    mutate(file.netlist)
    expect(() => deserializeNetlist(JSON.stringify(file))).toThrow('Invalid circuit data:')
  })

  it('rejects non-finite JSON numbers before simulation', () => {
    const text = JSON.stringify(sample()).replace('"simTimeNs":100', '"simTimeNs":1e999')
    expect(() => deserializeNetlist(text)).toThrow('simulation time')
  })

  it('rejects oversized input before parsing', () => {
    expect(() => deserializeNetlist(' '.repeat(MAX_CKT_BYTES + 1))).toThrow('10 MiB')
    expect(() => deserializeNetlist('é'.repeat(MAX_CKT_BYTES / 2 + 1))).toThrow('10 MiB')
  })

  it('bounds component processing before resolving connectivity', () => {
    const file = sample()
    file.netlist.components = Array(5001).fill(file.netlist.components[0])
    expect(() => deserializeNetlist(JSON.stringify(file))).toThrow('5,000 components')
  })

  it('preserves dangling wires saved by earlier releases', () => {
    const file = sample()
    file.netlist.components.shift()
    expect(deserializeNetlist(JSON.stringify(file)).wires[0].fromPinId).toBe('swA#out')
  })

  it('supports optional parameters and editable unfinished state tables', () => {
    const file = sample()
    Object.assign(file.netlist.components[0], {
      type: ComponentType.STATE_MACHINE, smInputs: 8, smOutputs: 1,
      smTable: [{ present: '', input: '', output: '', next: '' }]
    })
    expect(() => deserializeNetlist(JSON.stringify(file))).not.toThrow()
  })
})
