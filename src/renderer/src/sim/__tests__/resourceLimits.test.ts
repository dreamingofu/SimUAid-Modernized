import { describe, expect, it } from 'vitest'
import { ComponentType, LogicValue } from '../../model/types'
import { SimulationLimitError } from '../engine'
import { CircuitBuilder } from './harness'

describe('simulation stimulus resource limits', () => {
  it('rejects oversized clock runs without changing time, signals, waveforms or the pending queue', () => {
    const c = new CircuitBuilder()
      .add('clock', ComponentType.CLOCK)
      .probe('probe')
      .wire('clock#out', 'probe#in')
      .setSimulation({ simTimeNs: 1e12, clockPeriodNs: 2 })
      .build()
    const before = structuredClone(c.sim.getWaveforms())
    const pins = c.sim.getPinValues()
    expect(() => c.sim.go()).toThrow(SimulationLimitError)
    expect(c.sim.time).toBe(0)
    expect(c.sim.getWaveforms()).toEqual(before)
    expect(c.sim.getPinValues()).toEqual(pins)
    expect(c.sim.changeStep()).toBe(false)
    // A bounded step still works: a rejected Go must not advance scheduledUpTo.
    c.sim.step()
    expect(c.sim.time).toBe(1)
    expect(c.sim.getWaveforms()[0].samples.at(-1)?.v).toBe(LogicValue.ZERO)
  })

  it.each(['go', 'step'] as const)('rejects oversized repeating input %s before committing any events', (method) => {
    const c = new CircuitBuilder()
      .add('input', ComponentType.INPUT_SIGNAL, { signal: [
        { timeNs: 0, value: LogicValue.ZERO },
        { timeNs: 1, value: LogicValue.ONE },
        { timeNs: 2, value: 'R' }
      ] })
      .probe('probe')
      .wire('input#out', 'probe#in')
      .setSimulation({ simTimeNs: 1e12 })
      .build()
    const before = structuredClone(c.sim.getWaveforms())
    expect(() => c.sim[method]()).toThrow(SimulationLimitError)
    expect(c.sim.time).toBe(0)
    expect(c.sim.getWaveforms()).toEqual(before)
    expect(c.sim.changeStep()).toBe(false)
  })

  it('rejects unsafe time arithmetic even without timed sources', () => {
    const c = new CircuitBuilder().setSimulation({ simTimeNs: Number.MAX_VALUE }).build()
    expect(() => c.sim.go()).toThrow('supported numeric range')
    expect(c.sim.time).toBe(0)
  })

  it('rejects waveform repeat counts that cannot be incremented safely', () => {
    const c = new CircuitBuilder()
      .add('input', ComponentType.INPUT_SIGNAL, { signal: [
        { timeNs: 0, value: LogicValue.ZERO },
        { timeNs: 1e-20, value: 'R' }
      ] })
      .setSimulation({ simTimeNs: 100 })
      .build()
    expect(() => c.sim.go()).toThrow('repeat count exceeds the supported numeric range')
    expect(c.sim.time).toBe(0)
  })
})
