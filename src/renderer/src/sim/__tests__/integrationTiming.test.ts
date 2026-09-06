// Timing and waveform semantics of whole circuits: what a probe records and when,
// which glitches survive the inertial-delay model and which are swallowed, how the
// clock grid drives Step/Go and the parts hanging off it, and how a net that
// several drivers change in one instant is resolved.
//
// Asserts the audit decisions 1 (same-instant events), 2 (inertial delay),
// 4 (time 0 after Reset), 5 (relative Go / uncapped Step), 6 (clock edge times),
// 12 (one net resolution per instant) and 13 (stimulus never replays the past),
// plus Appendix B of the manual for the Step/Go stopping rule.

import { describe, expect, it } from 'vitest'
import { ComponentType, LogicValue, type SignalRow, type SignalValue } from '../../model/types'
import type { WaveformSample, WaveformTrace } from '../engine'
import { Circuit, CircuitBuilder, p } from './harness'

const { ZERO, ONE, X, Z } = LogicValue

// ---------------------------------------------------------------------------
// Local helpers (the harness exposes no waveform helpers).
// ---------------------------------------------------------------------------

type Pair = [number, LogicValue]
type HexPair = [number, string]

function samplesOf(c: Circuit, probeId: string): WaveformSample[] {
  const w = c.sim.getWaveforms().find((t) => t.probeId === probeId)
  if (!w) throw new Error(`no probe ${probeId}`)
  return w.samples
}

/** (time, value) pairs recorded by a single-bit probe. */
const trace = (c: Circuit, probeId: string): Pair[] => samplesOf(c, probeId).map((s) => [s.t, s.v])

/** (time, hex) pairs recorded by a bus probe. */
const hexTrace = (c: Circuit, probeId: string): HexPair[] =>
  samplesOf(c, probeId).map((s) => [s.t, s.hex ?? '?'])

const flip = (v: LogicValue): LogicValue => (v === ONE ? ZERO : ONE)

const row = (timeNs: number, value: SignalValue): SignalRow => ({ timeNs, value })

/** Deep copy of every recorded trace, for replay comparisons. */
const snapshot = (c: Circuit): WaveformTrace[] => JSON.parse(JSON.stringify(c.sim.getWaveforms()))

/** True when a trace never steps backwards in time. */
function nonDecreasing(samples: WaveformSample[]): boolean {
  for (let i = 1; i < samples.length; i++) if (samples[i].t < samples[i - 1].t) return false
  return true
}

const allNonDecreasing = (c: Circuit): boolean =>
  c.sim.getWaveforms().every((w) => nonDecreasing(w.samples))

/** Free-running clock samples: `initial` at 0 then toggle k at floor(k*period/2). */
function expectedClockTrace(period: number, initial: LogicValue, until: number): Pair[] {
  const out: Pair[] = [[0, initial]]
  for (let k = 1; Math.floor((k * period) / 2) <= until; k++) {
    out.push([Math.floor((k * period) / 2), k % 2 === 1 ? flip(initial) : initial])
  }
  return out
}

// ---------------------------------------------------------------------------
// Circuit factories
// ---------------------------------------------------------------------------

/** switch -> NOT(d1) -> NOT(d2) -> NOT(d3), with a probe on every node. */
function delayChain(d1: number, d2: number, d3: number): Circuit {
  return new CircuitBuilder()
    .switch('a', ZERO)
    .add('n1', ComponentType.NOT, { delay: d1 })
    .add('n2', ComponentType.NOT, { delay: d2 })
    .add('n3', ComponentType.NOT, { delay: d3 })
    .probe('pa')
    .probe('p1')
    .probe('p2')
    .probe('p3')
    .connect(p('a', 'out'), p('n1', 'in1'), p('pa', 'in'))
    .connect(p('n1', 'out'), p('n2', 'in1'), p('p1', 'in'))
    .connect(p('n2', 'out'), p('n3', 'in1'), p('p2', 'in'))
    .wire(p('n3', 'out'), p('p3', 'in'))
    .build()
}

/**
 * The classic static hazard: AND(A, NOT A) (or OR(A, NOT A)), whose steady value
 * is constant but which glitches for the inverter's delay when the gate is fast
 * enough to pass it.
 */
function glitchCircuit(kind: 'and' | 'or', invDelay: number, gateDelay: number): Circuit {
  const initial = kind === 'and' ? ZERO : ONE
  return new CircuitBuilder()
    .switch('a', initial)
    .add('n', ComponentType.NOT, { delay: invDelay })
    .add('g', kind === 'and' ? ComponentType.AND2 : ComponentType.OR2, { delay: gateDelay })
    .probe('y')
    .wire(p('a', 'out'), p('n', 'in1'))
    .wire(p('a', 'out'), p('g', 'in1'))
    .wire(p('n', 'out'), p('g', 'in2'))
    .wire(p('g', 'out'), p('y', 'in'))
    .build()
}

/** AND(A, NOT NOT NOT A): the same hazard with a three-inverter reconvergent path. */
function reconvergentAnd(gateDelay: number): Circuit {
  return new CircuitBuilder()
    .switch('a', ZERO)
    .add('n1', ComponentType.NOT)
    .add('n2', ComponentType.NOT)
    .add('n3', ComponentType.NOT)
    .add('g', ComponentType.AND2, { delay: gateDelay })
    .probe('y')
    .wire(p('a', 'out'), p('n1', 'in1'))
    .wire(p('n1', 'out'), p('n2', 'in1'))
    .wire(p('n2', 'out'), p('n3', 'in1'))
    .wire(p('a', 'out'), p('g', 'in1'))
    .wire(p('n3', 'out'), p('g', 'in2'))
    .wire(p('g', 'out'), p('y', 'in'))
    .build()
}

/** XOR(A, A delayed by 5 ns through two inverters): steady 0 with a 5 ns hazard. */
function reconvergentXor(gateDelay: number): Circuit {
  return new CircuitBuilder()
    .switch('a', ZERO)
    .add('n1', ComponentType.NOT, { delay: 2 })
    .add('n2', ComponentType.NOT, { delay: 3 })
    .add('g', ComponentType.XOR2, { delay: gateDelay })
    .probe('y')
    .wire(p('a', 'out'), p('n1', 'in1'))
    .wire(p('n1', 'out'), p('n2', 'in1'))
    .wire(p('a', 'out'), p('g', 'in1'))
    .wire(p('n2', 'out'), p('g', 'in2'))
    .wire(p('g', 'out'), p('y', 'in'))
    .build()
}

/** The AND(A, NOT A) hazard wired to a D flip-flop's clock (D tied high). */
function glitchClockedFlipFlop(invDelay: number, gateDelay: number): Circuit {
  return new CircuitBuilder()
    .switch('a', ZERO)
    .add('vcc', ComponentType.VCC)
    .add('n', ComponentType.NOT, { delay: invDelay })
    .add('g', ComponentType.AND2, { delay: gateDelay })
    .add('ff', ComponentType.D_FLIPFLOP)
    .probe('pclk')
    .probe('pq')
    .wire(p('a', 'out'), p('n', 'in1'))
    .wire(p('a', 'out'), p('g', 'in1'))
    .wire(p('n', 'out'), p('g', 'in2'))
    .connect(p('g', 'out'), p('ff', 'CLK'), p('pclk', 'in'))
    .wire(p('vcc', 'out'), p('ff', 'D'))
    .wire(p('vcc', 'out'), p('ff', 'S'))
    .wire(p('vcc', 'out'), p('ff', 'R'))
    .wire(p('ff', 'Q'), p('pq', 'in'))
    .build()
}

function clockProbe(period: number, initial: LogicValue, simTimeNs = 100): Circuit {
  return new CircuitBuilder()
    .add('clk', ComponentType.CLOCK)
    .probe('pc')
    .wire(p('clk', 'out'), p('pc', 'in'))
    .setSimulation({ clockPeriodNs: period, clockInitialValue: initial, simTimeNs })
    .build()
}

/** CLOCK + INPUT_SIGNAL into a D flip-flop; probes on D and Q. */
function clockedSampler(rows: SignalRow[], period: number, initial: LogicValue, simTimeNs = 200): Circuit {
  return new CircuitBuilder()
    .add('clk', ComponentType.CLOCK)
    .add('sig', ComponentType.INPUT_SIGNAL, { signal: rows })
    .add('vcc', ComponentType.VCC)
    .add('ff', ComponentType.D_FLIPFLOP)
    .probe('pd')
    .probe('pq')
    .wire(p('clk', 'out'), p('ff', 'CLK'))
    .connect(p('sig', 'out'), p('ff', 'D'), p('pd', 'in'))
    .wire(p('vcc', 'out'), p('ff', 'S'))
    .wire(p('vcc', 'out'), p('ff', 'R'))
    .wire(p('ff', 'Q'), p('pq', 'in'))
    .setSimulation({ clockPeriodNs: period, clockInitialValue: initial, simTimeNs })
    .build()
}

/** A toggling JK flip-flop (J=K=1) cleared by an INPUT_SIGNAL during the first 5 ns. */
function toggleJk(period: number, initial: LogicValue, simTimeNs = 100): Circuit {
  return new CircuitBuilder()
    .add('clk', ComponentType.CLOCK)
    .add('vcc', ComponentType.VCC)
    .add('clr', ComponentType.INPUT_SIGNAL, { signal: [row(0, ZERO), row(5, ONE)] })
    .add('jk', ComponentType.JK_FLIPFLOP)
    .probe('pq')
    .probe('pc')
    .connect(p('clk', 'out'), p('jk', 'CLK'), p('pc', 'in'))
    .wire(p('vcc', 'out'), p('jk', 'J'))
    .wire(p('vcc', 'out'), p('jk', 'K'))
    .wire(p('vcc', 'out'), p('jk', 'S'))
    .wire(p('clr', 'out'), p('jk', 'R'))
    .wire(p('jk', 'Q'), p('pq', 'in'))
    .setSimulation({ clockPeriodNs: period, clockInitialValue: initial, simTimeNs })
    .build()
}

/** INPUT_SIGNAL -> probe (and optionally through a NOT gate to a second probe). */
function signalProbe(rows: SignalRow[], simTimeNs = 100): Circuit {
  return new CircuitBuilder()
    .add('sig', ComponentType.INPUT_SIGNAL, { signal: rows })
    .add('n', ComponentType.NOT)
    .probe('ps')
    .probe('pn')
    .connect(p('sig', 'out'), p('n', 'in1'), p('ps', 'in'))
    .wire(p('n', 'out'), p('pn', 'in'))
    .setSimulation({ simTimeNs })
    .build()
}

/**
 * Two single-bit tristates on one net whose controls change one after the other,
 * with delays chosen so that BOTH outputs change at the same instant (t = 3).
 * `aOn`/`bOn` pick which buffer is enabled at t=0 through the switch's start value.
 */
function tristateHandover(aInput: 'vcc' | 'gnd', bInput: 'vcc' | 'gnd', start: LogicValue): Circuit {
  return new CircuitBuilder()
    .switch('e', start)
    .add('vcc', ComponentType.VCC)
    .add('gnd', ComponentType.GROUND)
    .add('n', ComponentType.NOT, { delay: 1 })
    .add('ta', ComponentType.TRISTATE_RIGHT, { delay: 2 })
    .add('tb', ComponentType.TRISTATE_RIGHT, { delay: 1 })
    .probe('pbus')
    .wire(p('e', 'out'), p('n', 'in1'))
    .wire(p('e', 'out'), p('ta', 'ctl'))
    .wire(p('n', 'out'), p('tb', 'ctl'))
    .wire(p(aInput === 'vcc' ? 'vcc' : 'gnd', 'out'), p('ta', 'in'))
    .wire(p(bInput === 'vcc' ? 'vcc' : 'gnd', 'out'), p('tb', 'in'))
    .connect(p('ta', 'out'), p('pbus', 'in'), p('tb', 'out'))
    .build()
}

/**
 * The bus version of the handover: two 4-bit tristate banks feed two mergers that
 * drive one bus net, with delays lined up so both mergers change at t = 4.
 */
function busHandover(bHex: number): Circuit {
  const b = new CircuitBuilder()
    .switch('e', ZERO)
    .add('vcc', ComponentType.VCC)
    .add('gnd', ComponentType.GROUND)
    .add('n', ComponentType.NOT, { delay: 1 })
    .add('nta', ComponentType.N_TRISTATE, { bits: 4, delay: 1 })
    .add('ntb', ComponentType.N_TRISTATE, { bits: 4, delay: 1 })
    .add('ma', ComponentType.MERGER, { bits: 4, delay: 2 })
    .add('mb', ComponentType.MERGER, { bits: 4, delay: 1 })
    .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
    .wire(p('e', 'out'), p('n', 'in1'))
    .wire(p('e', 'out'), p('nta', 'ctl'))
    .wire(p('n', 'out'), p('ntb', 'ctl'))
    .connect(p('ma', 'out'), p('bp', 'in'), p('mb', 'out'))
  for (let i = 0; i < 4; i++) {
    b.wire(p((5 >> i) & 1 ? 'vcc' : 'gnd', 'out'), p('nta', `in${i}`))
      .wire(p((bHex >> i) & 1 ? 'vcc' : 'gnd', 'out'), p('ntb', `in${i}`))
      .wire(p('nta', `out${i}`), p('ma', `in${i}`))
      .wire(p('ntb', `out${i}`), p('mb', `in${i}`))
  }
  return b.build()
}

/** A NAND ring oscillator gated by `en`, plus an unrelated AND gate with a probe. */
function ringOscillator(): Circuit {
  return new CircuitBuilder()
    .switch('en', ZERO)
    .switch('b', ZERO)
    .add('vcc', ComponentType.VCC)
    .add('g1', ComponentType.NAND2)
    .add('n2', ComponentType.NOT)
    .add('n3', ComponentType.NOT)
    .add('side', ComponentType.AND2)
    .probe('pside')
    .wire(p('en', 'out'), p('g1', 'in1'))
    .wire(p('n3', 'out'), p('g1', 'in2'))
    .wire(p('g1', 'out'), p('n2', 'in1'))
    .wire(p('n2', 'out'), p('n3', 'in1'))
    .wire(p('b', 'out'), p('side', 'in1'))
    .wire(p('vcc', 'out'), p('side', 'in2'))
    .wire(p('side', 'out'), p('pside', 'in'))
    .build()
}

// ===========================================================================
// 1. Probe traces
// ===========================================================================

describe('probe traces: the t=0 sample', () => {
  it('a probe on a switch records exactly one sample at t=0 and time is 0 after build()', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .probe('pa')
      .wire(p('a', 'out'), p('pa', 'in'))
      .build()
    expect(c.time).toBe(0)
    expect(trace(c, 'pa')).toEqual([[0, ZERO]])
  })

  it('the t=0 sample is the settled value, not the pre-propagation one', () => {
    // The NOT gate has a 7 ns delay, yet reset() settles it before presenting t=0.
    const c = new CircuitBuilder()
      .switch('a', ONE)
      .add('n', ComponentType.NOT, { delay: 7 })
      .probe('py')
      .wire(p('a', 'out'), p('n', 'in1'))
      .wire(p('n', 'out'), p('py', 'in'))
      .build()
    expect(c.time).toBe(0)
    expect(trace(c, 'py')).toEqual([[0, ZERO]])
  })

  it('a probe on an undriven net records Z at t=0', () => {
    const c = new CircuitBuilder().probe('pz').build()
    expect(trace(c, 'pz')).toEqual([[0, Z]])
  })

  it('a probe on a net driven X records X at t=0', () => {
    const c = new CircuitBuilder()
      .add('n', ComponentType.NOT) // unconnected input -> Z -> output X
      .probe('px')
      .wire(p('n', 'out'), p('px', 'in'))
      .build()
    expect(trace(c, 'px')).toEqual([[0, X]])
  })

  it('a bus probe on an undriven 8-bit bus records ZZ at t=0', () => {
    const c = new CircuitBuilder().add('bp', ComponentType.BUS_PROBE, { bits: 8 }).build()
    expect(hexTrace(c, 'bp')).toEqual([[0, 'ZZ']])
  })

  it('every probe starts with a sample at t=0, whatever it is connected to', () => {
    const c = new CircuitBuilder()
      .switch('a', ONE)
      .add('vcc', ComponentType.VCC)
      .add('gnd', ComponentType.GROUND)
      .probe('p1')
      .probe('p2')
      .probe('p3')
      .wire(p('a', 'out'), p('p1', 'in'))
      .wire(p('vcc', 'out'), p('p2', 'in'))
      .wire(p('gnd', 'out'), p('p3', 'in'))
      .build()
    for (const w of c.sim.getWaveforms()) {
      expect(w.samples.length).toBe(1)
      expect(w.samples[0].t).toBe(0)
    }
    expect(trace(c, 'p1')).toEqual([[0, ONE]])
    expect(trace(c, 'p2')).toEqual([[0, ONE]])
    expect(trace(c, 'p3')).toEqual([[0, ZERO]])
  })
})

describe('probe traces: one sample per change, none for a non-change', () => {
  it('a NOT gate probed through three switch toggles records one sample per toggle', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .add('n', ComponentType.NOT)
      .probe('pa')
      .probe('py')
      .connect(p('a', 'out'), p('n', 'in1'), p('pa', 'in'))
      .wire(p('n', 'out'), p('py', 'in'))
      .build()
    c.toggle('a')
    c.toggle('a')
    c.toggle('a')
    expect(trace(c, 'pa')).toEqual([
      [0, ZERO],
      [1, ONE],
      [3, ZERO],
      [5, ONE]
    ])
    expect(trace(c, 'py')).toEqual([
      [0, ONE],
      [2, ZERO],
      [4, ONE],
      [6, ZERO]
    ])
    expect(c.time).toBe(6)
  })

  it('an AND output that keeps its value records no sample while the input probe does', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .switch('b', ZERO)
      .add('g', ComponentType.AND2)
      .probe('pb')
      .probe('py')
      .connect(p('b', 'out'), p('g', 'in2'), p('pb', 'in'))
      .wire(p('a', 'out'), p('g', 'in1'))
      .wire(p('g', 'out'), p('py', 'in'))
      .build()
    c.set('b', ONE) // AND stays 0 because A = 0
    expect(trace(c, 'py')).toEqual([[0, ZERO]])
    expect(trace(c, 'pb')).toEqual([
      [0, ZERO],
      [1, ONE]
    ])
    c.set('b', ZERO)
    expect(trace(c, 'py')).toEqual([[0, ZERO]])
    c.set('a', ONE) // still 0 because B = 0
    expect(trace(c, 'py')).toEqual([[0, ZERO]])
    c.set('b', ONE) // now the AND finally changes, one delay later
    expect(trace(c, 'py')).toEqual([
      [0, ZERO],
      [5, ONE]
    ])
  })

  it('a switch toggled back and forth with no net change records nothing after t=0', () => {
    // OR gate held high by a VCC input: the switch cannot change the output.
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .add('vcc', ComponentType.VCC)
      .add('g', ComponentType.OR2)
      .probe('py')
      .wire(p('a', 'out'), p('g', 'in1'))
      .wire(p('vcc', 'out'), p('g', 'in2'))
      .wire(p('g', 'out'), p('py', 'in'))
      .build()
    for (let i = 0; i < 6; i++) c.toggle('a')
    expect(trace(c, 'py')).toEqual([[0, ONE]])
  })
})

describe('probe traces: exact timestamps through a chain with mixed delays', () => {
  it('a 2/3/5 ns inverter chain records 1, 3, 6 and 11 ns on the way up', () => {
    const c = delayChain(2, 3, 5)
    expect(trace(c, 'pa')).toEqual([[0, ZERO]])
    expect(trace(c, 'p1')).toEqual([[0, ONE]])
    expect(trace(c, 'p2')).toEqual([[0, ZERO]])
    expect(trace(c, 'p3')).toEqual([[0, ONE]])

    c.set('a', ONE)
    expect(c.time).toBe(11)
    expect(trace(c, 'pa')).toEqual([
      [0, ZERO],
      [1, ONE]
    ])
    expect(trace(c, 'p1')).toEqual([
      [0, ONE],
      [3, ZERO]
    ])
    expect(trace(c, 'p2')).toEqual([
      [0, ZERO],
      [6, ONE]
    ])
    expect(trace(c, 'p3')).toEqual([
      [0, ONE],
      [11, ZERO]
    ])
  })

  it('the same chain accumulates the same delays on the way back down', () => {
    const c = delayChain(2, 3, 5)
    c.set('a', ONE)
    c.set('a', ZERO)
    expect(c.time).toBe(22)
    expect(trace(c, 'pa')).toEqual([
      [0, ZERO],
      [1, ONE],
      [12, ZERO]
    ])
    expect(trace(c, 'p1')).toEqual([
      [0, ONE],
      [3, ZERO],
      [14, ONE]
    ])
    expect(trace(c, 'p2')).toEqual([
      [0, ZERO],
      [6, ONE],
      [17, ZERO]
    ])
    expect(trace(c, 'p3')).toEqual([
      [0, ONE],
      [11, ZERO],
      [22, ONE]
    ])
  })

  it.each([
    [1, 1, 1, [2, 3, 4]],
    [1, 2, 3, [2, 4, 7]],
    [9, 1, 1, [10, 11, 12]],
    [1, 9, 1, [2, 11, 12]],
    [1, 1, 9, [2, 3, 12]],
    [4, 4, 4, [5, 9, 13]]
  ] as [number, number, number, number[]][])(
    'delays %i/%i/%i put the stage changes at %j',
    (d1, d2, d3, times) => {
      const c = delayChain(d1, d2, d3)
      c.set('a', ONE)
      expect(trace(c, 'p1')[1][0]).toBe(times[0])
      expect(trace(c, 'p2')[1][0]).toBe(times[1])
      expect(trace(c, 'p3')[1][0]).toBe(times[2])
      expect(c.time).toBe(times[2])
    }
  )

  it('a fan-out into two chains of different delay records both arrival times', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .add('fast', ComponentType.NOT, { delay: 2 })
      .add('slow', ComponentType.NOT, { delay: 17 })
      .probe('pf')
      .probe('psl')
      .wire(p('a', 'out'), p('fast', 'in1'))
      .wire(p('a', 'out'), p('slow', 'in1'))
      .wire(p('fast', 'out'), p('pf', 'in'))
      .wire(p('slow', 'out'), p('psl', 'in'))
      .build()
    c.set('a', ONE)
    expect(trace(c, 'pf')).toEqual([
      [0, ONE],
      [3, ZERO]
    ])
    expect(trace(c, 'psl')).toEqual([
      [0, ONE],
      [18, ZERO]
    ])
    expect(c.time).toBe(18)
  })
})

describe('probe traces: a ripple-carry chain of full adders', () => {
  /** X = 0111 fixed, Y0 from a switch, four FULL_ADDERs of `delay` ns each. */
  function rippleAdder(delay: number): Circuit {
    const b = new CircuitBuilder()
      .switch('y0', ZERO)
      .add('vcc', ComponentType.VCC)
      .add('gnd', ComponentType.GROUND)
      .add('mg', ComponentType.MERGER, { bits: 4 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
      .wire(p('mg', 'out'), p('bp', 'in'))
    for (let i = 0; i < 4; i++) {
      b.add(`fa${i}`, ComponentType.FULL_ADDER, { delay })
        .probe(`ps${i}`)
        .wire(p(i < 3 ? 'vcc' : 'gnd', 'out'), p(`fa${i}`, 'X'))
        .wire(p(i === 0 ? 'y0' : 'gnd', 'out'), p(`fa${i}`, 'Y'))
        .wire(p(`fa${i}`, 'Sum'), p(`ps${i}`, 'in'))
        .wire(p(`fa${i}`, 'Sum'), p('mg', `in${i}`))
      if (i === 0) b.wire(p('gnd', 'out'), p('fa0', 'Cin'))
      else b.wire(p(`fa${i - 1}`, 'Cout'), p(`fa${i}`, 'Cin'))
    }
    return b.build()
  }

  it('the carry reaches stage i after (i+1) part delays (2 ns each)', () => {
    const c = rippleAdder(2)
    expect(c.bus(p('bp', 'in'))).toBe('7')
    c.set('y0', ONE) // 0111 + 0001 = 1000, with a full-length carry ripple
    expect(c.time).toBe(10)
    expect(trace(c, 'ps0')).toEqual([
      [0, ONE],
      [3, ZERO]
    ])
    expect(trace(c, 'ps1')).toEqual([
      [0, ONE],
      [5, ZERO]
    ])
    expect(trace(c, 'ps2')).toEqual([
      [0, ONE],
      [7, ZERO]
    ])
    expect(trace(c, 'ps3')).toEqual([
      [0, ZERO],
      [9, ONE]
    ])
    expect(c.bus(p('bp', 'in'))).toBe('8')
  })

  it('the bus probe shows every intermediate sum the ripple passes through', () => {
    const c = rippleAdder(2)
    c.set('y0', ONE)
    // 7 -> 6 -> 4 -> 0 -> 8, one merger delay behind each sum bit.
    expect(hexTrace(c, 'bp')).toEqual([
      [0, '7'],
      [4, '6'],
      [6, '4'],
      [8, '0'],
      [10, '8']
    ])
  })

  it.each([1, 3, 5] as number[])('with %i ns adders the carry front moves at that rate', (delay) => {
    const c = rippleAdder(delay)
    c.set('y0', ONE)
    for (let i = 0; i < 4; i++) {
      expect(trace(c, `ps${i}`)[1][0]).toBe(1 + (i + 1) * delay)
    }
    expect(c.time).toBe(1 + 4 * delay + 1) // + the merger's own delay
  })

  it('removing the carry again ripples back with the same timing', () => {
    const c = rippleAdder(2)
    c.set('y0', ONE)
    const at = c.time
    c.set('y0', ZERO)
    expect(trace(c, 'ps0')[2]).toEqual([at + 3, ONE])
    expect(trace(c, 'ps3')[2]).toEqual([at + 9, ZERO])
    expect(c.bus(p('bp', 'in'))).toBe('7')
  })
})

describe('probe traces: several probes on one net, and probe ordering', () => {
  it('three probes on one net record identical traces', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .add('n', ComponentType.NOT, { delay: 3 })
      .probe('p1')
      .probe('p2')
      .probe('p3')
      .wire(p('a', 'out'), p('n', 'in1'))
      .connect(p('n', 'out'), p('p1', 'in'), p('p2', 'in'), p('p3', 'in'))
      .build()
    c.set('a', ONE)
    c.set('a', ZERO)
    const expected: Pair[] = [
      [0, ONE],
      [4, ZERO],
      [8, ONE]
    ]
    expect(trace(c, 'p1')).toEqual(expected)
    expect(trace(c, 'p2')).toEqual(expected)
    expect(trace(c, 'p3')).toEqual(expected)
  })

  it('probes on the same net and on different nets all appear in getWaveforms()', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .probe('pa1')
      .add('n', ComponentType.NOT)
      .probe('pa2')
      .probe('py')
      .connect(p('a', 'out'), p('n', 'in1'), p('pa1', 'in'), p('pa2', 'in'))
      .wire(p('n', 'out'), p('py', 'in'))
      .build()
    expect(c.sim.getWaveforms().map((w) => w.probeId)).toEqual(['pa1', 'pa2', 'py'])
    c.set('a', ONE)
    expect(trace(c, 'pa1')).toEqual(trace(c, 'pa2'))
    expect(trace(c, 'py')).toEqual([
      [0, ONE],
      [2, ZERO]
    ])
  })

  it('getWaveforms() lists probes in placement order with the bus flag set per kind', () => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 4, label: '3' })
      .probe('first')
      .add('sp', ComponentType.SPLITTER, { bits: 4 })
      .add('bp1', ComponentType.BUS_PROBE, { bits: 4 })
      .switch('s', ONE)
      .probe('second')
      .add('bp2', ComponentType.BUS_PROBE, { bits: 4 })
      .probe('third')
      .connect(p('bi', 'out'), p('sp', 'in'), p('bp1', 'in'), p('bp2', 'in'))
      .wire(p('sp', 'out0'), p('first', 'in'))
      .wire(p('sp', 'out1'), p('second', 'in'))
      .wire(p('s', 'out'), p('third', 'in'))
      .build()
    expect(c.sim.getWaveforms().map((w) => w.probeId)).toEqual([
      'first',
      'bp1',
      'second',
      'bp2',
      'third'
    ])
    expect(c.sim.getWaveforms().map((w) => w.bus)).toEqual([false, true, false, true, false])
  })

  it('two bus probes on one bus record the same hex trace', () => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 8, label: 'A5' })
      .switch('en', ZERO)
      .add('cp', ComponentType.COMPLEMENTER, { bits: 8, delay: 3 })
      .add('bp1', ComponentType.BUS_PROBE, { bits: 8 })
      .add('bp2', ComponentType.BUS_PROBE, { bits: 8 })
      .wire(p('bi', 'out'), p('cp', 'in'))
      .wire(p('en', 'out'), p('cp', 'en'))
      .connect(p('cp', 'out'), p('bp1', 'in'), p('bp2', 'in'))
      .build()
    expect(hexTrace(c, 'bp1')).toEqual([[0, 'A5']])
    c.set('en', ONE)
    expect(c.time).toBe(4)
    expect(hexTrace(c, 'bp1')).toEqual([
      [0, 'A5'],
      [4, '5A']
    ])
    expect(hexTrace(c, 'bp2')).toEqual(hexTrace(c, 'bp1'))
  })

  it('a bus probe records one hex sample per bus change through a splitter/merger loop', () => {
    const b = new CircuitBuilder()
      .switch('en', ZERO)
      .add('bi', ComponentType.BUS_INPUT, { bits: 4, label: 'C' })
      .add('sp', ComponentType.SPLITTER, { bits: 4, delay: 2 })
      .add('mg', ComponentType.MERGER, { bits: 4, delay: 4 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
      .wire(p('bi', 'out'), p('sp', 'in'))
      .wire(p('mg', 'out'), p('bp', 'in'))
    for (let i = 0; i < 4; i++) {
      b.add(`x${i}`, ComponentType.XOR2, { delay: 3 })
        .wire(p('sp', `out${i}`), p(`x${i}`, 'in1'))
        .wire(p('en', 'out'), p(`x${i}`, 'in2'))
        .wire(p(`x${i}`, 'out'), p('mg', `in${i}`))
    }
    const c = b.build()
    expect(hexTrace(c, 'bp')).toEqual([[0, 'C']])
    c.set('en', ONE) // XOR with 1 inverts every bit: C -> 3
    // switch 1 + XOR 3 + merger 4 = 8 ns.
    expect(hexTrace(c, 'bp')).toEqual([
      [0, 'C'],
      [8, '3']
    ])
    expect(c.time).toBe(8)
  })
})

describe('probe traces: part delays are integers of at least 1 ns', () => {
  function notDelay(delay: number): Circuit {
    return new CircuitBuilder()
      .switch('a', ZERO)
      .add('n', ComponentType.NOT, { delay })
      .probe('py')
      .wire(p('a', 'out'), p('n', 'in1'))
      .wire(p('n', 'out'), p('py', 'in'))
      .build()
  }

  it.each([
    [0, 1],
    [-4, 1],
    [0.4, 1],
    [1, 1],
    [2.4, 2],
    [2.6, 3],
    [7, 7],
    [999, 999]
  ] as [number, number][])('a delay of %s behaves as %i ns', (delay, effective) => {
    const c = notDelay(delay)
    c.set('a', ONE)
    expect(trace(c, 'py')).toEqual([
      [0, ONE],
      [1 + effective, ZERO]
    ])
    expect(c.time).toBe(1 + effective)
  })

  it('a switch itself always costs 1 ns before the first gate sees the change', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .probe('pa')
      .wire(p('a', 'out'), p('pa', 'in'))
      .build()
    c.set('a', ONE)
    expect(trace(c, 'pa')).toEqual([
      [0, ZERO],
      [1, ONE]
    ])
    expect(c.time).toBe(1)
  })
})

// ===========================================================================
// 2. Glitches (decision 2: inertial output delay)
// ===========================================================================

const DELAY_PAIRS: [number, number][] = []
for (const inv of [1, 2, 3, 4]) for (const gate of [1, 2, 3, 4]) DELAY_PAIRS.push([inv, gate])
DELAY_PAIRS.push([9, 3], [3, 9], [5, 5], [6, 1], [1, 6])

describe('static hazard AND(A, NOT A) over a delay matrix', () => {
  it.each(DELAY_PAIRS)('inverter %i ns, AND %i ns', (inv, gate) => {
    const c = glitchCircuit('and', inv, gate)
    expect(trace(c, 'y')).toEqual([[0, ZERO]])
    c.set('a', ONE)
    // The pulse lasts as long as the inverter's delay and only survives when the
    // gate is at least as fast (a pulse shorter than the gate delay is swallowed).
    expect(trace(c, 'y')).toEqual(
      inv >= gate
        ? [
            [0, ZERO],
            [1 + gate, ONE],
            [1 + inv + gate, ZERO]
          ]
        : [[0, ZERO]]
    )
    expect(c.pin(p('g', 'out'))).toBe(ZERO) // steady state is always 0
  })

  it.each(DELAY_PAIRS)('inverter %i ns, AND %i ns: the falling edge of A glitches nothing', (inv, gate) => {
    const c = glitchCircuit('and', inv, gate)
    c.set('a', ONE)
    const before = trace(c, 'y')
    c.set('a', ZERO)
    expect(trace(c, 'y')).toEqual(before)
    expect(c.pin(p('g', 'out'))).toBe(ZERO)
  })
})

describe('static hazard OR(A, NOT A) over a delay matrix', () => {
  it.each(DELAY_PAIRS)('inverter %i ns, OR %i ns', (inv, gate) => {
    const c = glitchCircuit('or', inv, gate)
    expect(trace(c, 'y')).toEqual([[0, ONE]])
    c.set('a', ZERO)
    expect(trace(c, 'y')).toEqual(
      inv >= gate
        ? [
            [0, ONE],
            [1 + gate, ZERO],
            [1 + inv + gate, ONE]
          ]
        : [[0, ONE]]
    )
    expect(c.pin(p('g', 'out'))).toBe(ONE) // steady state is always 1
  })

  it.each(DELAY_PAIRS)('inverter %i ns, OR %i ns: the rising edge of A glitches nothing', (inv, gate) => {
    const c = glitchCircuit('or', inv, gate)
    c.set('a', ZERO)
    const before = trace(c, 'y')
    c.set('a', ONE)
    expect(trace(c, 'y')).toEqual(before)
    expect(c.pin(p('g', 'out'))).toBe(ONE)
  })
})

describe('static hazard through a longer reconvergent path', () => {
  it.each([1, 2, 3] as number[])(
    'AND(A, NOT NOT NOT A) with a %i ns gate passes the 3 ns pulse',
    (gate) => {
      const c = reconvergentAnd(gate)
      expect(trace(c, 'y')).toEqual([[0, ZERO]])
      c.set('a', ONE)
      expect(trace(c, 'y')).toEqual([
        [0, ZERO],
        [1 + gate, ONE],
        [4 + gate, ZERO]
      ])
    }
  )

  it.each([4, 5, 8] as number[])(
    'AND(A, NOT NOT NOT A) with a %i ns gate swallows the 3 ns pulse',
    (gate) => {
      const c = reconvergentAnd(gate)
      c.set('a', ONE)
      expect(trace(c, 'y')).toEqual([[0, ZERO]])
      expect(c.pin(p('g', 'out'))).toBe(ZERO)
    }
  )

  it.each([1, 2, 3, 4, 5] as number[])(
    'XOR(A, A delayed 5 ns) with a %i ns gate passes the 5 ns pulse',
    (gate) => {
      const c = reconvergentXor(gate)
      expect(trace(c, 'y')).toEqual([[0, ZERO]])
      c.set('a', ONE)
      expect(trace(c, 'y')).toEqual([
        [0, ZERO],
        [1 + gate, ONE],
        [6 + gate, ZERO]
      ])
    }
  )

  it.each([6, 7, 12] as number[])(
    'XOR(A, A delayed 5 ns) with a %i ns gate swallows the pulse',
    (gate) => {
      const c = reconvergentXor(gate)
      c.set('a', ONE)
      expect(trace(c, 'y')).toEqual([[0, ZERO]])
      expect(c.pin(p('g', 'out'))).toBe(ZERO)
    }
  )

  it('the reconvergent pulse reappears identically on the next rising edge of A', () => {
    const c = reconvergentAnd(1)
    c.set('a', ONE)
    expect(trace(c, 'y')).toEqual([
      [0, ZERO],
      [2, ONE],
      [5, ZERO]
    ])
    c.set('a', ZERO)
    // Falling A produces no hazard; the inverter chain still needs 1 + 3 ns to settle.
    expect(trace(c, 'y')).toEqual([
      [0, ZERO],
      [2, ONE],
      [5, ZERO]
    ])
    const settled = c.time
    expect(settled).toBe(9)
    c.set('a', ONE)
    expect(trace(c, 'y').slice(3)).toEqual([
      [settled + 2, ONE],
      [settled + 5, ZERO]
    ])
  })
})

describe('the same hazard driven by the CLOCK part over a whole go()', () => {
  const CLOCK_DELAYS: [number, number][] = [
    [1, 1],
    [2, 1],
    [2, 2],
    [3, 2],
    [4, 4],
    [1, 2],
    [1, 4],
    [3, 4],
    [9, 3],
    [3, 9]
  ]

  function clockHazard(kind: 'and' | 'or', invDelay: number, gateDelay: number): Circuit {
    return new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .add('n', ComponentType.NOT, { delay: invDelay })
      .add('g', kind === 'and' ? ComponentType.AND2 : ComponentType.OR2, { delay: gateDelay })
      .probe('y')
      .wire(p('clk', 'out'), p('n', 'in1'))
      .wire(p('clk', 'out'), p('g', 'in1'))
      .wire(p('n', 'out'), p('g', 'in2'))
      .wire(p('g', 'out'), p('y', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 100 })
      .build()
  }

  /** Pulse pairs at each listed edge, clipped to the end of the go window. */
  function pulses(edges: number[], inv: number, gate: number, level: LogicValue, until: number): Pair[] {
    const out: Pair[] = []
    if (inv < gate) return out
    for (const t of edges) {
      if (t + gate <= until) out.push([t + gate, level])
      if (t + inv + gate <= until) out.push([t + inv + gate, flip(level)])
    }
    return out
  }

  it.each(CLOCK_DELAYS)('AND(CLK, NOT CLK): inverter %i ns, AND %i ns', (inv, gate) => {
    const c = clockHazard('and', inv, gate)
    c.go()
    expect(c.time).toBe(95)
    expect(trace(c, 'y')).toEqual([[0, ZERO], ...pulses([20, 40, 60, 80], inv, gate, ONE, 95)])
  })

  it.each(CLOCK_DELAYS)('OR(CLK, NOT CLK): inverter %i ns, OR %i ns', (inv, gate) => {
    const c = clockHazard('or', inv, gate)
    c.go()
    expect(trace(c, 'y')).toEqual([[0, ONE], ...pulses([10, 30, 50, 70, 90], inv, gate, ZERO, 95)])
  })

  it('AND(CLK, NOT CLK) with equal delays glitches once per period, never at a falling edge', () => {
    const c = clockHazard('and', 1, 1)
    c.go()
    expect(trace(c, 'y')).toEqual([
      [0, ZERO],
      [21, ONE],
      [22, ZERO],
      [41, ONE],
      [42, ZERO],
      [61, ONE],
      [62, ZERO],
      [81, ONE],
      [82, ZERO]
    ])
  })

  it('a swallowed clock hazard leaves a completely flat trace over 100 ns', () => {
    const c = clockHazard('and', 1, 3)
    c.go()
    expect(trace(c, 'y')).toEqual([[0, ZERO]])
    expect(c.pin(p('g', 'out'))).toBe(ZERO)
  })
})

describe('a glitch at a flip-flop clock', () => {
  it('a 1 ns clock glitch (inverter 1, AND 1) does clock the flip-flop', () => {
    const c = glitchClockedFlipFlop(1, 1)
    expect(trace(c, 'pclk')).toEqual([[0, ZERO]])
    expect(trace(c, 'pq')).toEqual([[0, X]])
    c.set('a', ONE)
    expect(trace(c, 'pclk')).toEqual([
      [0, ZERO],
      [2, ONE],
      [3, ZERO]
    ])
    expect(trace(c, 'pq')).toEqual([
      [0, X],
      [3, ONE]
    ])
    expect(c.pin(p('ff', 'Q'))).toBe(ONE)
    expect(c.pin(p('ff', "Q'"))).toBe(ZERO)
  })

  it('a 4 ns clock glitch (inverter 4, AND 1) clocks the flip-flop exactly once', () => {
    const c = glitchClockedFlipFlop(4, 1)
    c.set('a', ONE)
    expect(trace(c, 'pclk')).toEqual([
      [0, ZERO],
      [2, ONE],
      [6, ZERO]
    ])
    expect(trace(c, 'pq')).toEqual([
      [0, X],
      [3, ONE]
    ])
  })

  it('a clock glitch swallowed by a slow AND (inverter 1, AND 2) never clocks the flip-flop', () => {
    const c = glitchClockedFlipFlop(1, 2)
    c.set('a', ONE)
    expect(trace(c, 'pclk')).toEqual([[0, ZERO]])
    expect(trace(c, 'pq')).toEqual([[0, X]])
    expect(c.pin(p('ff', 'Q'))).toBe(X)
  })

  it.each([
    [1, 2],
    [1, 3],
    [2, 3],
    [3, 9]
  ] as [number, number][])(
    'inverter %i / AND %i keeps the clock net flat and the flip-flop unknown',
    (inv, gate) => {
      const c = glitchClockedFlipFlop(inv, gate)
      c.set('a', ONE)
      expect(trace(c, 'pclk')).toEqual([[0, ZERO]])
      expect(c.pin(p('ff', 'Q'))).toBe(X)
    }
  )

  it('a clock-generated hazard feeding a flip-flop clock does clock it (delays 1/1)', () => {
    const c = new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .add('vcc', ComponentType.VCC)
      .add('n', ComponentType.NOT)
      .add('g', ComponentType.AND2)
      .add('ff', ComponentType.D_FLIPFLOP)
      .probe('pq')
      .wire(p('clk', 'out'), p('n', 'in1'))
      .wire(p('clk', 'out'), p('g', 'in1'))
      .wire(p('n', 'out'), p('g', 'in2'))
      .wire(p('g', 'out'), p('ff', 'CLK'))
      .wire(p('vcc', 'out'), p('ff', 'D'))
      .wire(p('vcc', 'out'), p('ff', 'S'))
      .wire(p('vcc', 'out'), p('ff', 'R'))
      .wire(p('ff', 'Q'), p('pq', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 100 })
      .build()
    c.go()
    // The 1 ns hazard at 21 is a real rising edge for the flip-flop.
    expect(trace(c, 'pq')).toEqual([
      [0, X],
      [22, ONE]
    ])
  })

  it('the same circuit with a slow AND never clocks the flip-flop over a whole run', () => {
    const c = new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .add('vcc', ComponentType.VCC)
      .add('n', ComponentType.NOT)
      .add('g', ComponentType.AND2, { delay: 2 })
      .add('ff', ComponentType.D_FLIPFLOP)
      .probe('pq')
      .wire(p('clk', 'out'), p('n', 'in1'))
      .wire(p('clk', 'out'), p('g', 'in1'))
      .wire(p('n', 'out'), p('g', 'in2'))
      .wire(p('g', 'out'), p('ff', 'CLK'))
      .wire(p('vcc', 'out'), p('ff', 'D'))
      .wire(p('vcc', 'out'), p('ff', 'S'))
      .wire(p('vcc', 'out'), p('ff', 'R'))
      .wire(p('ff', 'Q'), p('pq', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 100 })
      .build()
    c.go()
    expect(trace(c, 'pq')).toEqual([[0, X]])
    expect(c.pin(p('ff', 'Q'))).toBe(X)
  })

  it('the same glitch on D (not on the clock) is never captured', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .switch('clk', ZERO)
      .switch('r', ZERO) // active-low clear: starts the flip-flop at 0
      .add('vcc', ComponentType.VCC)
      .add('n', ComponentType.NOT)
      .add('g', ComponentType.AND2)
      .add('ff', ComponentType.D_FLIPFLOP)
      .probe('pq')
      .probe('pd')
      .wire(p('a', 'out'), p('n', 'in1'))
      .wire(p('a', 'out'), p('g', 'in1'))
      .wire(p('n', 'out'), p('g', 'in2'))
      .connect(p('g', 'out'), p('ff', 'D'), p('pd', 'in'))
      .wire(p('clk', 'out'), p('ff', 'CLK'))
      .wire(p('vcc', 'out'), p('ff', 'S'))
      .wire(p('r', 'out'), p('ff', 'R'))
      .wire(p('ff', 'Q'), p('pq', 'in'))
      .build()
    expect(trace(c, 'pq')).toEqual([[0, ZERO]])
    c.set('r', ONE)
    c.pulse('clk')
    c.set('a', ONE) // 1 ns glitch on D, between clock edges
    expect(trace(c, 'pd')[1][1]).toBe(ONE) // the glitch really did reach D
    expect(trace(c, 'pd').length).toBe(3)
    c.pulse('clk')
    expect(trace(c, 'pq')).toEqual([[0, ZERO]]) // Q never moved
    expect(c.pin(p('ff', 'Q'))).toBe(ZERO)
  })
})

// ===========================================================================
// 3. Clock timing (decisions 5 and 6)
// ===========================================================================

const CLOCK_MODES: [string, LogicValue][] = [
  ['rising-edge mode', ONE],
  ['falling-edge mode', ZERO]
]

describe('clock toggle times: floor(k * period / 2)', () => {
  it.each([
    [20, 95],
    [8, 94],
    [25, 94],
    [30, 82]
  ] as [number, number][])('period %i, rising-edge mode, go() ends at %i ns', (period, end) => {
    const c = clockProbe(period, ONE)
    c.go()
    expect(c.time).toBe(end)
    expect(trace(c, 'pc')).toEqual(expectedClockTrace(period, ONE, end))
  })

  it.each([
    [20, 95],
    [8, 94],
    [25, 94],
    [30, 82]
  ] as [number, number][])('period %i, falling-edge mode, go() ends at %i ns', (period, end) => {
    const c = clockProbe(period, ZERO)
    c.go()
    expect(c.time).toBe(end)
    expect(trace(c, 'pc')).toEqual(expectedClockTrace(period, ZERO, end))
  })

  it.each([20, 8, 25, 30] as number[])(
    'period %i: active edges land on exact multiples of the period',
    (period) => {
      const c = clockProbe(period, ONE)
      c.go()
      const rises = trace(c, 'pc')
        .slice(1)
        .filter(([, v]) => v === ONE)
        .map(([t]) => t)
      expect(rises).toEqual(rises.map((_t, i) => (i + 1) * period))
      expect(rises.every((t) => t % period === 0)).toBe(true)
    }
  )

  it('period 25 (odd): the toggles are 12, 25, 37, 50, 62, 75, 87', () => {
    const c = clockProbe(25, ONE)
    c.go()
    expect(trace(c, 'pc')).toEqual([
      [0, ONE],
      [12, ZERO],
      [25, ONE],
      [37, ZERO],
      [50, ONE],
      [62, ZERO],
      [75, ONE],
      [87, ZERO]
    ])
  })

  it('period 30: the toggles are 15, 30, 45, 60, 75 within the go window', () => {
    const c = clockProbe(30, ZERO)
    c.go()
    expect(trace(c, 'pc')).toEqual([
      [0, ZERO],
      [15, ONE],
      [30, ZERO],
      [45, ONE],
      [60, ZERO],
      [75, ONE]
    ])
  })
})

describe('step() stopping points (a quarter period before each active edge)', () => {
  const STEP_TIMES: [number, number[]][] = [
    [20, [15, 35, 55, 75, 95, 115]],
    [8, [6, 14, 22, 30, 38, 46, 54, 62, 70, 78, 86, 94, 102, 110]],
    [25, [19, 44, 69, 94, 119]],
    [30, [22, 52, 82, 112]]
  ]

  for (const [name, initial] of CLOCK_MODES) {
    it.each(STEP_TIMES)(`period %i, ${name}: step() ends at %j`, (period, times) => {
      const c = clockProbe(period, initial)
      const seen: number[] = []
      for (let i = 0; i < times.length; i++) {
        c.step()
        seen.push(c.time)
      }
      expect(seen).toEqual(times)
      // Uncapped: stepping runs past the 100 ns simulation time limit.
      expect(times[times.length - 1]).toBeGreaterThan(100)
    })
  }

  it.each(CLOCK_MODES)('%s: the clock is at its inactive level at every step end', (_name, initial) => {
    const c = clockProbe(20, initial)
    for (let i = 0; i < 6; i++) {
      c.step()
      expect(c.pin(p('clk', 'out'))).toBe(flip(initial))
      expect((c.time + 5) % 20).toBe(0) // exactly a quarter period before the edge
    }
  })

  it('step() with a clock ignores simTimeNs entirely (limit 10 ns, period 20)', () => {
    const c = clockProbe(20, ONE, 10)
    const seen: number[] = []
    for (let i = 0; i < 4; i++) {
      c.step()
      seen.push(c.time)
    }
    expect(seen).toEqual([15, 35, 55, 75])
  })
})

describe('go() is relative to the current time (decision 5)', () => {
  it.each([
    [20, 95, 195, 295],
    [8, 94, 190, 286],
    [25, 94, 194, 294],
    [30, 82, 172, 262]
  ] as [number, number, number, number][])(
    'period %i: three successive go() calls end at %i, %i and %i ns',
    (period, first, second, third) => {
      const c = clockProbe(period, ONE)
      c.go()
      expect(c.time).toBe(first)
      c.go()
      expect(c.time).toBe(second)
      c.go()
      expect(c.time).toBe(third)
    }
  )

  it.each([
    [20, 15, 115],
    [8, 6, 102],
    [25, 19, 119],
    [30, 22, 112]
  ] as [number, number, number][])(
    'period %i: go() after one step() runs simTimeNs from the step end (%i -> %i)',
    (period, afterStep, afterGo) => {
      const c = clockProbe(period, ONE)
      c.step()
      expect(c.time).toBe(afterStep)
      c.go()
      expect(c.time).toBe(afterGo)
    }
  )

  it('a second go() continues the same clock waveform without a gap or a repeat', () => {
    const c = clockProbe(20, ONE)
    c.go()
    c.go()
    expect(c.time).toBe(195)
    expect(trace(c, 'pc')).toEqual(expectedClockTrace(20, ONE, 195))
    expect(allNonDecreasing(c)).toBe(true)
  })

  it('mixing step() and go() keeps the clock on its absolute grid', () => {
    const c = clockProbe(20, ONE)
    c.step() // 15
    c.go() // 115
    c.step() // 135
    expect(c.time).toBe(135)
    expect(trace(c, 'pc')).toEqual(expectedClockTrace(20, ONE, 135))
  })
})

describe('a clocked counter stepped past the simulation time limit', () => {
  function counterCircuit(): Circuit {
    return new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .add('vcc', ComponentType.VCC)
      .switch('clr', ZERO) // active-low, synchronous
      .add('ctr', ComponentType.N_COUNTER, { bits: 3 })
      .probe('q0')
      .probe('q1')
      .probe('q2')
      .wire(p('clk', 'out'), p('ctr', 'CLK'))
      .wire(p('vcc', 'out'), p('ctr', 'En'))
      .wire(p('clr', 'out'), p('ctr', 'CLR'))
      .wire(p('ctr', 'Q0'), p('q0', 'in'))
      .wire(p('ctr', 'Q1'), p('q1', 'in'))
      .wire(p('ctr', 'Q2'), p('q2', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 100 })
      .build()
  }

  it('counts one per active edge, with Q settling one delay after each edge', () => {
    const c = counterCircuit()
    expect(c.vec('ctr', 'Q', 3)).toBe('XXX')
    c.step() // 15: no edge yet
    expect(c.time).toBe(15)
    expect(c.vec('ctr', 'Q', 3)).toBe('XXX')
    c.step() // 35: the edge at 20 clears
    expect(c.vec('ctr', 'Q', 3)).toBe('000')
    c.set('clr', ONE)
    const times: number[] = []
    const counts: string[] = []
    for (let k = 1; k <= 5; k++) {
      c.step()
      times.push(c.time)
      counts.push(c.vec('ctr', 'Q', 3))
    }
    expect(times).toEqual([55, 75, 95, 115, 135])
    expect(counts).toEqual(['001', '010', '011', '100', '101'])
    expect(trace(c, 'q0')).toEqual([
      [0, X],
      [21, ZERO],
      [41, ONE],
      [61, ZERO],
      [81, ONE],
      [101, ZERO],
      [121, ONE]
    ])
    expect(trace(c, 'q1')).toEqual([
      [0, X],
      [21, ZERO],
      [61, ONE],
      [101, ZERO]
    ])
    expect(trace(c, 'q2')).toEqual([
      [0, X],
      [21, ZERO],
      [101, ONE]
    ])
    expect(allNonDecreasing(c)).toBe(true)
  })

  it('the count is stable at every step end (a quarter period before the next edge)', () => {
    const c = counterCircuit()
    c.step()
    c.step()
    c.set('clr', ONE)
    for (let k = 1; k <= 4; k++) {
      c.step()
      const at = c.vec('ctr', 'Q', 3)
      expect(c.pin(p('clk', 'out'))).toBe(ZERO)
      expect(at).toBe((k % 8).toString(2).padStart(3, '0'))
    }
  })
})

describe('a divide-by-two flip-flop chain under the CLOCK part', () => {
  function divider(period: number): Circuit {
    const b = new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .add('vcc', ComponentType.VCC)
      .switch('r', ZERO)
      .probe('pq1')
      .probe('pq2')
    for (const id of ['f1', 'f2']) {
      b.add(id, ComponentType.D_FLIPFLOP)
        .wire(p('vcc', 'out'), p(id, 'S'))
        .wire(p('r', 'out'), p(id, 'R'))
        .wire(p(id, "Q'"), p(id, 'D'))
    }
    return b
      .wire(p('clk', 'out'), p('f1', 'CLK'))
      .connect(p('f1', 'Q'), p('f2', 'CLK'), p('pq1', 'in'))
      .wire(p('f2', 'Q'), p('pq2', 'in'))
      .setSimulation({ clockPeriodNs: period, clockInitialValue: ONE, simTimeNs: 100 })
      .build()
  }

  it('period 20: Q1 toggles at 21/41/61/81 and Q2 at 22/62', () => {
    const c = divider(20)
    expect(trace(c, 'pq1')).toEqual([[0, ZERO]])
    c.set('r', ONE)
    c.go()
    expect(c.time).toBe(95)
    expect(trace(c, 'pq1')).toEqual([
      [0, ZERO],
      [21, ONE],
      [41, ZERO],
      [61, ONE],
      [81, ZERO]
    ])
    expect(trace(c, 'pq2')).toEqual([
      [0, ZERO],
      [22, ONE],
      [62, ZERO]
    ])
  })

  it('period 25 (odd): the divided outputs follow the exact-multiple edges', () => {
    const c = divider(25)
    c.set('r', ONE)
    c.go()
    expect(c.time).toBe(94)
    expect(trace(c, 'pq1')).toEqual([
      [0, ZERO],
      [26, ONE],
      [51, ZERO],
      [76, ONE]
    ])
    expect(trace(c, 'pq2')).toEqual([
      [0, ZERO],
      [27, ONE],
      [77, ZERO]
    ])
  })

  it('period 8: the divided output has a 16 ns period', () => {
    const c = divider(8)
    c.set('r', ONE)
    c.go()
    expect(c.time).toBe(94)
    const q1 = trace(c, 'pq1')
    expect(q1[0]).toEqual([0, ZERO])
    expect(q1.slice(1).map(([t]) => t)).toEqual([9, 17, 25, 33, 41, 49, 57, 65, 73, 81, 89])
  })
})

// ===========================================================================
// 4. CLOCK plus INPUT_SIGNAL at a flip-flop (decision 1)
// ===========================================================================

describe('rows placed before, exactly at and after an active edge', () => {
  it('a row 1 ns before an edge is captured by that edge', () => {
    const c = clockedSampler([row(0, ZERO), row(19, ONE)], 20, ONE)
    c.go()
    expect(trace(c, 'pd')).toEqual([
      [0, ZERO],
      [19, ONE]
    ])
    expect(trace(c, 'pq')).toEqual([
      [0, X],
      [21, ONE]
    ])
  })

  it('a row exactly at an edge is captured by that edge (same-instant events)', () => {
    const c = clockedSampler([row(0, ZERO), row(40, ONE)], 20, ONE)
    c.go()
    // Edge 20 captures the initial 0 (X -> 0); edge 40 captures the value driven
    // at that very instant, i.e. the NEW 1, not the old 0.
    expect(trace(c, 'pq')).toEqual([
      [0, X],
      [21, ZERO],
      [41, ONE]
    ])
  })

  it('a row 1 ns after an edge waits for the next edge', () => {
    const c = clockedSampler([row(0, ZERO), row(41, ONE)], 20, ONE)
    c.go()
    expect(trace(c, 'pd')).toEqual([
      [0, ZERO],
      [41, ONE]
    ])
    expect(trace(c, 'pq')).toEqual([
      [0, X],
      [21, ZERO],
      [61, ONE]
    ])
  })

  it('a full waveform mixing before/at/after rows produces one exact Q trace', () => {
    const rows = [row(0, ZERO), row(19, ONE), row(40, ZERO), row(61, ONE), row(100, ZERO)]
    const c = clockedSampler(rows, 20, ONE)
    c.go()
    expect(c.time).toBe(195)
    expect(trace(c, 'pd')).toEqual([
      [0, ZERO],
      [19, ONE],
      [40, ZERO],
      [61, ONE],
      [100, ZERO]
    ])
    expect(trace(c, 'pq')).toEqual([
      [0, X],
      [21, ONE],
      [41, ZERO],
      [81, ONE],
      [101, ZERO]
    ])
    expect(allNonDecreasing(c)).toBe(true)
  })

  it('a value that only exists between two edges is never captured', () => {
    const rows = [
      row(0, ZERO),
      row(19, ONE),
      row(21, ZERO),
      row(39, ONE),
      row(41, ZERO),
      row(59, ONE),
      row(60, ZERO)
    ]
    const c = clockedSampler(rows, 20, ONE)
    c.go()
    expect(trace(c, 'pd')).toEqual([
      [0, ZERO],
      [19, ONE],
      [21, ZERO],
      [39, ONE],
      [41, ZERO],
      [59, ONE],
      [60, ZERO]
    ])
    // Edge 20 sees 1, edge 40 sees 1 (no change), edge 60 sees the value driven at
    // that very instant, i.e. 0.
    expect(trace(c, 'pq')).toEqual([
      [0, X],
      [21, ONE],
      [61, ZERO]
    ])
  })

  it('a row at an inactive (falling) edge waits for the next rising edge', () => {
    const c = clockedSampler([row(0, ZERO), row(30, ONE), row(55, ZERO)], 20, ONE)
    c.go()
    // The row at the falling edge 30 is only captured by the rising edge at 40.
    expect(trace(c, 'pq')).toEqual([
      [0, X],
      [21, ZERO],
      [41, ONE],
      [61, ZERO]
    ])
  })

  it('falling-edge clock mode moves the D flip-flop edges to 10, 30, 50 ...', () => {
    const c = clockedSampler([row(0, ONE), row(10, ZERO), row(29, ONE), row(50, ZERO)], 20, ZERO)
    c.go()
    expect(c.time).toBe(195) // simTimeNs is 200 here, so go() stops 5 ns before 200
    // A D flip-flop still triggers on 0 -> 1, which in falling-edge mode is at
    // 10, 30, 50, ...; each of those rows is applied in the same instant.
    expect(trace(c, 'pq')).toEqual([
      [0, X],
      [11, ZERO],
      [31, ONE],
      [51, ZERO]
    ])
  })

  it('X and Z rows are captured as X by the edge that sees them', () => {
    const c = clockedSampler([row(0, ONE), row(20, X), row(60, Z), row(80, ONE)], 20, ONE)
    c.go()
    expect(trace(c, 'pd')).toEqual([
      [0, ONE],
      [20, X],
      [60, Z],
      [80, ONE]
    ])
    // Q is already X after reset, so capturing X at edge 20 and Z (as X) at edge
    // 60 records nothing; only the 1 captured at edge 80 is a change.
    expect(trace(c, 'pq')).toEqual([
      [0, X],
      [81, ONE]
    ])
    expect(c.pin(p('ff', 'Q'))).toBe(ONE)
  })

  it('step() stops on the clock grid even when input-signal rows fall in between', () => {
    const c = clockedSampler([row(0, ZERO), row(19, ONE), row(21, ZERO), row(33, ONE)], 20, ONE)
    const times: number[] = []
    for (let i = 0; i < 4; i++) {
      c.step()
      times.push(c.time)
    }
    expect(times).toEqual([15, 35, 55, 75])
    // Step 2 crossed the edge at 20 (D was 1) and the rows at 21 and 33.
    expect(trace(c, 'pq')).toEqual([
      [0, X],
      [21, ONE]
    ])
    expect(trace(c, 'pd')).toEqual([
      [0, ZERO],
      [19, ONE],
      [21, ZERO],
      [33, ONE]
    ])
  })

  it('each step ends with the flip-flop settled and the next data value already set up', () => {
    const rows = [row(0, ZERO)]
    for (let k = 1; k <= 5; k++) rows.push(row(20 * k - 5, k % 2 === 1 ? ONE : ZERO))
    const c = clockedSampler(rows, 20, ONE)
    const captured: LogicValue[] = []
    for (let k = 0; k < 5; k++) {
      c.step()
      captured.push(c.pin(p('ff', 'Q')))
    }
    // Data changes 5 ns before every edge, so each step end shows the value the
    // PREVIOUS edge captured while the next one is already waiting on D.
    expect(captured).toEqual([X, ONE, ZERO, ONE, ZERO])
  })

  it('the clock period, not the row spacing, decides how many values are captured', () => {
    const rows = [row(0, ZERO)]
    for (let k = 1; k <= 20; k++) rows.push(row(5 * k, k % 2 === 1 ? ONE : ZERO))
    const c = clockedSampler(rows, 20, ONE)
    c.go()
    // Rows toggle every 5 ns; every edge (20, 40, 60, ...) sees an even multiple,
    // i.e. 0, so the flip-flop captures 0 once and never moves again.
    expect(trace(c, 'pq')).toEqual([
      [0, X],
      [21, ZERO]
    ])
    expect(c.pin(p('ff', 'Q'))).toBe(ZERO)
  })
})

// ===========================================================================
// 5. INPUT_SIGNAL repeat traces (decision 7)
// ===========================================================================

describe("INPUT_SIGNAL 'R' repeat traces over many periods", () => {
  it('a 20 ns repeat with a row at t=0 replays 0/1/0 five times', () => {
    const c = signalProbe([row(0, ZERO), row(5, ONE), row(12, ZERO), row(20, 'R')])
    c.go()
    expect(c.time).toBe(100)
    // The cycle-start value (0) equals the value already held, so no sample is
    // recorded at 20, 40, 60, 80 or 100.
    expect(trace(c, 'ps')).toEqual([
      [0, ZERO],
      [5, ONE],
      [12, ZERO],
      [25, ONE],
      [32, ZERO],
      [45, ONE],
      [52, ZERO],
      [65, ONE],
      [72, ZERO],
      [85, ONE],
      [92, ZERO]
    ])
  })

  it('a repeat whose waveform has no row at 0 restores Z at every cycle start', () => {
    const c = signalProbe([row(5, ONE), row(12, ZERO), row(20, 'R')])
    c.go()
    expect(trace(c, 'ps')).toEqual([
      [0, Z],
      [5, ONE],
      [12, ZERO],
      [20, Z],
      [25, ONE],
      [32, ZERO],
      [40, Z],
      [45, ONE],
      [52, ZERO],
      [60, Z],
      [65, ONE],
      [72, ZERO],
      [80, Z],
      [85, ONE],
      [92, ZERO],
      [100, Z]
    ])
  })

  it('the cycle start restores the t=0 row value when it differs from the last row', () => {
    const c = signalProbe([row(0, ZERO), row(5, ONE), row(20, 'R')])
    c.go()
    expect(trace(c, 'ps')).toEqual([
      [0, ZERO],
      [5, ONE],
      [20, ZERO],
      [25, ONE],
      [40, ZERO],
      [45, ONE],
      [60, ZERO],
      [65, ONE],
      [80, ZERO],
      [85, ONE],
      [100, ZERO]
    ])
  })

  it('a square-wave repeat drives a NOT gate one delay behind, over 5 periods', () => {
    const c = signalProbe([row(0, ZERO), row(10, ONE), row(20, 'R')])
    c.go()
    expect(trace(c, 'ps')).toEqual([
      [0, ZERO],
      [10, ONE],
      [20, ZERO],
      [30, ONE],
      [40, ZERO],
      [50, ONE],
      [60, ZERO],
      [70, ONE],
      [80, ZERO],
      [90, ONE],
      [100, ZERO]
    ])
    // The NOT gate's answer to the change at 100 falls outside the go window.
    expect(trace(c, 'pn')).toEqual([
      [0, ONE],
      [11, ZERO],
      [21, ONE],
      [31, ZERO],
      [41, ONE],
      [51, ZERO],
      [61, ONE],
      [71, ZERO],
      [81, ONE],
      [91, ZERO]
    ])
  })

  it('rows at or after the repeat time are dropped from every cycle', () => {
    const c = signalProbe([row(0, ZERO), row(5, ONE), row(20, X), row(25, ONE), row(20, 'R')])
    c.go()
    expect(trace(c, 'ps')).toEqual([
      [0, ZERO],
      [5, ONE],
      [20, ZERO],
      [25, ONE],
      [40, ZERO],
      [45, ONE],
      [60, ZERO],
      [65, ONE],
      [80, ZERO],
      [85, ONE],
      [100, ZERO]
    ])
  })

  it('a 30 ns repeating signal sampled by a 20 ns clock: exact D and Q traces', () => {
    const c = clockedSampler([row(0, ZERO), row(15, ONE), row(30, 'R')], 20, ONE)
    c.go()
    expect(c.time).toBe(195)
    expect(trace(c, 'pd')).toEqual([
      [0, ZERO],
      [15, ONE],
      [30, ZERO],
      [45, ONE],
      [60, ZERO],
      [75, ONE],
      [90, ZERO],
      [105, ONE],
      [120, ZERO],
      [135, ONE],
      [150, ZERO],
      [165, ONE],
      [180, ZERO],
      [195, ONE]
    ])
    // Edges at 20/40/60/80/100/120/140/160/180 see 1/0/0/1/0/0/1/0/0.
    expect(trace(c, 'pq')).toEqual([
      [0, X],
      [21, ONE],
      [41, ZERO],
      [81, ONE],
      [101, ZERO],
      [141, ONE],
      [161, ZERO]
    ])
  })

  it('a repeating signal keeps its phase across successive go() calls', () => {
    const c = signalProbe([row(0, ZERO), row(10, ONE), row(20, 'R')], 50)
    c.go()
    expect(c.time).toBe(50)
    c.go()
    expect(c.time).toBe(100)
    expect(trace(c, 'ps')).toEqual([
      [0, ZERO],
      [10, ONE],
      [20, ZERO],
      [30, ONE],
      [40, ZERO],
      [50, ONE],
      [60, ZERO],
      [70, ONE],
      [80, ZERO],
      [90, ONE],
      [100, ZERO]
    ])
    expect(allNonDecreasing(c)).toBe(true)
  })
})

// ===========================================================================
// 6. Falling-edge clock mode with JK flip-flops
// ===========================================================================

describe('JK flip-flops change state only on a 1 -> 0 clock transition', () => {
  it('falling-edge clock mode: the JK toggles at 21, 41, 61, 81 (one delay after 20/40/60/80)', () => {
    const c = toggleJk(20, ZERO)
    expect(trace(c, 'pq')).toEqual([[0, ZERO]])
    c.go()
    expect(c.time).toBe(95)
    expect(trace(c, 'pc')).toEqual(expectedClockTrace(20, ZERO, 95))
    expect(trace(c, 'pq')).toEqual([
      [0, ZERO],
      [21, ONE],
      [41, ZERO],
      [61, ONE],
      [81, ZERO]
    ])
  })

  it('rising-edge clock mode: the same JK toggles on the intermediate 1 -> 0 transitions', () => {
    const c = toggleJk(20, ONE)
    c.go()
    expect(trace(c, 'pq')).toEqual([
      [0, ZERO],
      [11, ONE],
      [31, ZERO],
      [51, ONE],
      [71, ZERO],
      [91, ONE]
    ])
  })

  it('the JK output changes exactly one delay after each falling clock transition', () => {
    const c = toggleJk(20, ZERO)
    c.go()
    const falls = trace(c, 'pc')
      .slice(1)
      .filter(([, v]) => v === ZERO)
      .map(([t]) => t)
    const qChanges = trace(c, 'pq')
      .slice(1)
      .map(([t]) => t)
    expect(qChanges).toEqual(falls.map((t) => t + 1))
  })

  it('period 25 falling-edge mode: toggles land one delay after 25, 50, 75', () => {
    const c = toggleJk(25, ZERO)
    c.go()
    expect(c.time).toBe(94)
    expect(trace(c, 'pq')).toEqual([
      [0, ZERO],
      [26, ONE],
      [51, ZERO],
      [76, ONE]
    ])
  })

  it('falling-edge mode: after step k the JK has seen k-1 active edges', () => {
    const c = toggleJk(20, ZERO)
    const seen: LogicValue[] = []
    const times: number[] = []
    for (let i = 0; i < 5; i++) {
      c.step()
      times.push(c.time)
      seen.push(c.pin(p('jk', 'Q')))
    }
    expect(times).toEqual([15, 35, 55, 75, 95])
    expect(seen).toEqual([ZERO, ONE, ZERO, ONE, ZERO])
  })

  it('rising-edge mode: the JK edge falls inside each step, so after step k it has toggled k times', () => {
    const c = toggleJk(20, ONE)
    const seen: LogicValue[] = []
    for (let i = 0; i < 5; i++) {
      c.step()
      seen.push(c.pin(p('jk', 'Q')))
    }
    expect(seen).toEqual([ONE, ZERO, ONE, ZERO, ONE])
  })

  it("Q' stays the complement of Q at every step", () => {
    const c = toggleJk(20, ZERO)
    for (let i = 0; i < 6; i++) {
      c.step()
      expect(c.pin(p('jk', "Q'"))).toBe(flip(c.pin(p('jk', 'Q'))))
    }
  })
})

// ===========================================================================
// 7. reset() mid-run and replay (decision 4)
// ===========================================================================

describe('reset() clears traces and time, and the run replays identically', () => {
  function replayCircuit(): Circuit {
    const b = new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .add('vcc', ComponentType.VCC)
      .add('clr', ComponentType.INPUT_SIGNAL, { signal: [row(0, ZERO), row(25, ONE)] })
      .add('ctr', ComponentType.N_COUNTER, { bits: 3 })
      .add('mg', ComponentType.MERGER, { bits: 3 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 3 })
      .probe('pc')
      .probe('pq0')
      .wire(p('clk', 'out'), p('ctr', 'CLK'))
      .wire(p('clk', 'out'), p('pc', 'in'))
      .wire(p('vcc', 'out'), p('ctr', 'En'))
      .wire(p('clr', 'out'), p('ctr', 'CLR'))
      .wire(p('mg', 'out'), p('bp', 'in'))
      .wire(p('ctr', 'Q0'), p('pq0', 'in'))
    for (let i = 0; i < 3; i++) b.wire(p('ctr', `Q${i}`), p('mg', `in${i}`))
    return b.setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 100 }).build()
  }

  it('records the expected traces on the first run', () => {
    const c = replayCircuit()
    c.go()
    expect(c.time).toBe(95)
    expect(trace(c, 'pq0')).toEqual([
      [0, X],
      [21, ZERO],
      [41, ONE],
      [61, ZERO],
      [81, ONE]
    ])
    expect(hexTrace(c, 'bp')).toEqual([
      [0, 'X'],
      [22, '0'],
      [42, '1'],
      [62, '2'],
      [82, '3']
    ])
  })

  it('reset() mid-run returns time to 0 and leaves exactly one sample per probe', () => {
    const c = replayCircuit()
    c.go()
    expect(c.sim.getWaveforms().every((w) => w.samples.length > 1)).toBe(true)
    c.reset()
    expect(c.time).toBe(0)
    for (const w of c.sim.getWaveforms()) {
      expect(w.samples.length).toBe(1)
      expect(w.samples[0].t).toBe(0)
    }
    expect(c.vec('ctr', 'Q', 3)).toBe('XXX')
    expect(c.pin(p('clk', 'out'))).toBe(ONE)
  })

  it('a replay after reset() produces byte-identical traces', () => {
    const c = replayCircuit()
    c.go()
    const first = snapshot(c)
    c.reset()
    c.go()
    expect(c.time).toBe(95)
    expect(c.sim.getWaveforms()).toEqual(first)
  })

  it('a replay driven by step() matches a fresh circuit stepped the same way', () => {
    const c = replayCircuit()
    for (let i = 0; i < 4; i++) c.step()
    const first = snapshot(c)
    const firstTime = c.time
    c.reset()
    for (let i = 0; i < 4; i++) c.step()
    expect(c.time).toBe(firstTime)
    expect(c.sim.getWaveforms()).toEqual(first)
  })

  it('reset() halfway through a step sequence restarts the clock grid from 0', () => {
    const c = replayCircuit()
    c.step()
    c.step()
    expect(c.time).toBe(35)
    c.reset()
    c.step()
    expect(c.time).toBe(15)
    expect(trace(c, 'pc')).toEqual([
      [0, ONE],
      [10, ZERO]
    ])
  })

  it('reset() keeps the switch positions the user set (they are circuit inputs, not state)', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .add('n', ComponentType.NOT)
      .probe('pa')
      .probe('py')
      .connect(p('a', 'out'), p('n', 'in1'), p('pa', 'in'))
      .wire(p('n', 'out'), p('py', 'in'))
      .build()
    c.set('a', ONE)
    c.reset()
    expect(c.time).toBe(0)
    expect(trace(c, 'pa')).toEqual([[0, ONE]])
    expect(trace(c, 'py')).toEqual([[0, ZERO]])
  })

  it('reset() after a mid-run switch toggle replays the stimulus from 0', () => {
    const c = new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .switch('a', ZERO)
      .add('g', ComponentType.AND2)
      .probe('py')
      .wire(p('clk', 'out'), p('g', 'in1'))
      .wire(p('a', 'out'), p('g', 'in2'))
      .wire(p('g', 'out'), p('py', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 100 })
      .build()
    c.set('a', ONE)
    c.go()
    const withSwitchOn = snapshot(c)
    c.reset()
    c.go()
    // The switch is still on, so the whole run repeats except for the 1 ns of
    // settling that the toggle itself caused before the first go().
    expect(trace(c, 'py')).toEqual([
      [0, ONE],
      [11, ZERO],
      [21, ONE],
      [31, ZERO],
      [41, ONE],
      [51, ZERO],
      [61, ONE],
      [71, ZERO],
      [81, ONE],
      [91, ZERO]
    ])
    expect(withSwitchOn[0].samples.length).toBeGreaterThan(1)
  })
})

// ===========================================================================
// 8. One net resolution per instant (decision 12)
// ===========================================================================

describe('two drivers changing on one net in the same instant', () => {
  it('a tristate handover to the same value records no sample at all', () => {
    const c = tristateHandover('vcc', 'vcc', ZERO)
    expect(trace(c, 'pbus')).toEqual([[0, ONE]])
    c.set('e', ONE)
    expect(c.time).toBe(3)
    expect(trace(c, 'pbus')).toEqual([[0, ONE]]) // no glitch through X or Z
    expect(c.pin(p('ta', 'out'))).toBe(ONE)
  })

  it('a tristate handover to a different value records exactly one sample', () => {
    const c = tristateHandover('vcc', 'gnd', ZERO)
    expect(trace(c, 'pbus')).toEqual([[0, ZERO]])
    c.set('e', ONE)
    expect(trace(c, 'pbus')).toEqual([
      [0, ZERO],
      [3, ONE]
    ])
    expect(samplesOf(c, 'pbus').filter((s) => s.t === 3).length).toBe(1)
  })

  it('handing the net back the other way is equally clean', () => {
    const c = tristateHandover('vcc', 'gnd', ZERO)
    c.set('e', ONE)
    expect(c.time).toBe(3)
    c.set('e', ZERO) // toggled at t = 3: the switch drives at 4, both tristates at 6
    expect(c.time).toBe(6)
    expect(trace(c, 'pbus')).toEqual([
      [0, ZERO],
      [3, ONE],
      [6, ZERO]
    ])
  })

  it('two tristates enabled in the same instant with different values resolve to one X sample', () => {
    // Both controls rise at t = 2, both outputs change at t = 3.
    const c = new CircuitBuilder()
      .switch('e', ZERO)
      .add('vcc', ComponentType.VCC)
      .add('gnd', ComponentType.GROUND)
      .add('buf', ComponentType.AND2, { delay: 1 })
      .add('ta', ComponentType.TRISTATE_RIGHT, { delay: 2 })
      .add('tb', ComponentType.TRISTATE_RIGHT, { delay: 1 })
      .probe('pbus')
      .wire(p('e', 'out'), p('ta', 'ctl'))
      .wire(p('e', 'out'), p('buf', 'in1'))
      .wire(p('e', 'out'), p('buf', 'in2'))
      .wire(p('buf', 'out'), p('tb', 'ctl'))
      .wire(p('vcc', 'out'), p('ta', 'in'))
      .wire(p('gnd', 'out'), p('tb', 'in'))
      .connect(p('ta', 'out'), p('pbus', 'in'), p('tb', 'out'))
      .build()
    expect(trace(c, 'pbus')).toEqual([[0, Z]])
    c.set('e', ONE)
    expect(trace(c, 'pbus')).toEqual([
      [0, Z],
      [3, X]
    ])
  })

  it('two tristates disabled in the same instant release the net with one Z sample', () => {
    const c = new CircuitBuilder()
      .switch('e', ONE)
      .add('vcc', ComponentType.VCC)
      .add('buf', ComponentType.AND2, { delay: 1 })
      .add('ta', ComponentType.TRISTATE_RIGHT, { delay: 2 })
      .add('tb', ComponentType.TRISTATE_RIGHT, { delay: 1 })
      .probe('pbus')
      .wire(p('e', 'out'), p('ta', 'ctl'))
      .wire(p('e', 'out'), p('buf', 'in1'))
      .wire(p('e', 'out'), p('buf', 'in2'))
      .wire(p('buf', 'out'), p('tb', 'ctl'))
      .wire(p('vcc', 'out'), p('ta', 'in'))
      .wire(p('vcc', 'out'), p('tb', 'in'))
      .connect(p('ta', 'out'), p('pbus', 'in'), p('tb', 'out'))
      .build()
    expect(trace(c, 'pbus')).toEqual([[0, ONE]])
    c.set('e', ZERO)
    expect(trace(c, 'pbus')).toEqual([
      [0, ONE],
      [3, Z]
    ])
  })

  it('two identical buffers on one net change it with a single sample', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .add('b1', ComponentType.AND2, { delay: 1 })
      .add('b2', ComponentType.AND2, { delay: 1 })
      .probe('pbus')
      .wire(p('a', 'out'), p('b1', 'in1'))
      .wire(p('a', 'out'), p('b1', 'in2'))
      .wire(p('a', 'out'), p('b2', 'in1'))
      .wire(p('a', 'out'), p('b2', 'in2'))
      .connect(p('b1', 'out'), p('pbus', 'in'), p('b2', 'out'))
      .build()
    expect(trace(c, 'pbus')).toEqual([[0, ZERO]])
    c.set('a', ONE)
    expect(trace(c, 'pbus')).toEqual([
      [0, ZERO],
      [2, ONE]
    ])
  })

  it('the same two buffers with different delays do show the intermediate contention', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .add('b1', ComponentType.AND2, { delay: 1 })
      .add('b2', ComponentType.AND2, { delay: 2 })
      .probe('pbus')
      .wire(p('a', 'out'), p('b1', 'in1'))
      .wire(p('a', 'out'), p('b1', 'in2'))
      .wire(p('a', 'out'), p('b2', 'in1'))
      .wire(p('a', 'out'), p('b2', 'in2'))
      .connect(p('b1', 'out'), p('pbus', 'in'), p('b2', 'out'))
      .build()
    c.set('a', ONE)
    expect(trace(c, 'pbus')).toEqual([
      [0, ZERO],
      [2, X],
      [3, ONE]
    ])
  })

  it('three drivers changing in one instant still record a single sample', () => {
    const b = new CircuitBuilder().switch('a', ZERO).probe('pbus')
    for (const id of ['b1', 'b2', 'b3']) {
      b.add(id, ComponentType.AND2, { delay: 1 })
        .wire(p('a', 'out'), p(id, 'in1'))
        .wire(p('a', 'out'), p(id, 'in2'))
        .wire(p(id, 'out'), p('pbus', 'in'))
    }
    const c = b.build()
    c.set('a', ONE)
    expect(trace(c, 'pbus')).toEqual([
      [0, ZERO],
      [2, ONE]
    ])
  })

  it('a bus handover to the same value leaves the hex trace untouched', () => {
    const c = busHandover(5)
    expect(hexTrace(c, 'bp')).toEqual([[0, '5']])
    c.set('e', ONE)
    expect(c.time).toBe(4)
    expect(hexTrace(c, 'bp')).toEqual([[0, '5']])
  })

  it('a bus handover to a different value records exactly one hex sample', () => {
    const c = busHandover(0xa)
    expect(hexTrace(c, 'bp')).toEqual([[0, 'A']])
    c.set('e', ONE)
    expect(hexTrace(c, 'bp')).toEqual([
      [0, 'A'],
      [4, '5']
    ])
    expect(samplesOf(c, 'bp').filter((s) => s.t === 4).length).toBe(1)
  })

  it('the bus handover never shows a contention value in between', () => {
    const c = busHandover(0xa)
    c.set('e', ONE)
    expect(hexTrace(c, 'bp').some(([, hex]) => hex === 'X' || hex === 'Z')).toBe(false)
  })
})

// ===========================================================================
// 9. Stimulus never replays the past (decision 13)
// ===========================================================================

describe('stimulus queued only for times after now', () => {
  function slowSwitchClock(): Circuit {
    return new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .switch('a', ZERO)
      .add('slow', ComponentType.NOT, { delay: 30 })
      .probe('pc')
      .probe('pslow')
      .wire(p('clk', 'out'), p('pc', 'in'))
      .wire(p('a', 'out'), p('slow', 'in1'))
      .wire(p('slow', 'out'), p('pslow', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 100 })
      .build()
  }

  it('a switch toggle in LIVE mode advances time without running the clock', () => {
    const c = slowSwitchClock()
    c.set('a', ONE)
    expect(c.time).toBe(31)
    expect(trace(c, 'pc')).toEqual([[0, ONE]])
    expect(trace(c, 'pslow')).toEqual([
      [0, ONE],
      [31, ZERO]
    ])
  })

  it('the first step() after that skips the clock toggles that are already in the past', () => {
    const c = slowSwitchClock()
    c.set('a', ONE) // time = 31
    c.step()
    expect(c.time).toBe(35)
    expect(trace(c, 'pc')).toEqual([[0, ONE]]) // 10, 20 and 30 are never replayed
  })

  it('the clock resumes on its absolute grid, keeping the phase of floor(k*period/2)', () => {
    const c = slowSwitchClock()
    c.set('a', ONE)
    c.step() // 35
    c.step() // 55
    expect(c.time).toBe(55)
    expect(trace(c, 'pc')).toEqual([
      [0, ONE],
      [50, ZERO]
    ])
    c.step() // 75
    expect(trace(c, 'pc')).toEqual([
      [0, ONE],
      [50, ZERO],
      [60, ONE],
      [70, ZERO]
    ])
    expect(allNonDecreasing(c)).toBe(true)
  })

  it('go() after the same toggle also starts from the next grid point', () => {
    const c = slowSwitchClock()
    c.set('a', ONE)
    c.go()
    expect(c.time).toBe(115)
    expect(trace(c, 'pc')).toEqual([
      [0, ONE],
      [50, ZERO],
      [60, ONE],
      [70, ZERO],
      [80, ONE],
      [90, ZERO],
      [100, ONE],
      [110, ZERO]
    ])
  })

  it('an INPUT_SIGNAL whose rows are all in the past never plays them', () => {
    const c = new CircuitBuilder()
      .add('sig', ComponentType.INPUT_SIGNAL, {
        signal: [row(0, ZERO), row(5, ONE), row(15, ZERO), row(25, ONE)]
      })
      .switch('a', ZERO)
      .add('slow', ComponentType.NOT, { delay: 30 })
      .probe('ps')
      .wire(p('sig', 'out'), p('ps', 'in'))
      .wire(p('a', 'out'), p('slow', 'in1'))
      .setSimulation({ simTimeNs: 100 })
      .build()
    c.set('a', ONE)
    expect(c.time).toBe(31)
    c.step()
    expect(trace(c, 'ps')).toEqual([[0, ZERO]])
    c.go()
    expect(trace(c, 'ps')).toEqual([[0, ZERO]])
    expect(allNonDecreasing(c)).toBe(true)
  })

  it('a repeating INPUT_SIGNAL resumes on its own absolute grid after a live toggle', () => {
    const c = new CircuitBuilder()
      .add('sig', ComponentType.INPUT_SIGNAL, { signal: [row(0, ZERO), row(5, ONE), row(10, 'R')] })
      .switch('a', ZERO)
      .add('slow', ComponentType.NOT, { delay: 30 })
      .probe('ps')
      .wire(p('sig', 'out'), p('ps', 'in'))
      .wire(p('a', 'out'), p('slow', 'in1'))
      .setSimulation({ simTimeNs: 100 })
      .build()
    c.set('a', ONE) // time = 31
    c.step()
    expect(c.time).toBe(35)
    expect(trace(c, 'ps')).toEqual([
      [0, ZERO],
      [35, ONE]
    ])
    c.step()
    expect(c.time).toBe(40)
    expect(trace(c, 'ps')).toEqual([
      [0, ZERO],
      [35, ONE],
      [40, ZERO]
    ])
  })

  it('every trace stays non-decreasing across mixed toggles, steps and gos', () => {
    const c = new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .add('sig', ComponentType.INPUT_SIGNAL, { signal: [row(0, ZERO), row(13, ONE), row(40, 'R')] })
      .switch('a', ZERO)
      .add('slow', ComponentType.NOT, { delay: 25 })
      .add('g', ComponentType.XOR2)
      .probe('pc')
      .probe('ps')
      .probe('py')
      .wire(p('clk', 'out'), p('pc', 'in'))
      .wire(p('sig', 'out'), p('ps', 'in'))
      .wire(p('a', 'out'), p('slow', 'in1'))
      .wire(p('slow', 'out'), p('g', 'in1'))
      .wire(p('sig', 'out'), p('g', 'in2'))
      .wire(p('g', 'out'), p('py', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 100 })
      .build()
    c.set('a', ONE)
    c.step()
    c.set('a', ZERO)
    c.go()
    c.step()
    c.set('a', ONE)
    c.go()
    expect(allNonDecreasing(c)).toBe(true)
    for (const w of c.sim.getWaveforms()) {
      expect(w.samples[0].t).toBe(0)
      expect(w.samples[w.samples.length - 1].t).toBeLessThanOrEqual(c.time)
    }
  })
})

// ===========================================================================
// 10. Oscillation inside a larger circuit
// ===========================================================================

describe('an oscillating ring inside a larger circuit', () => {
  it('settles normally while the ring is disabled', () => {
    const c = ringOscillator()
    expect(c.oscillated).toBe(false)
    expect(c.pin(p('g1', 'out'))).toBe(ONE)
    expect(c.pin(p('n2', 'out'))).toBe(ZERO)
    expect(c.pin(p('n3', 'out'))).toBe(ONE)
    expect(trace(c, 'pside')).toEqual([[0, ZERO]])
  })

  it('enabling the ring is detected as an oscillation', () => {
    const c = ringOscillator()
    c.set('en', ONE)
    expect(c.oscillated).toBe(true)
  })

  it('the oscillating ring reads X once the oscillation is detected', () => {
    const c = ringOscillator()
    c.set('en', ONE)
    // Every node of the ring is still switching when the run is abandoned, so
    // every one of them is undetermined; none may keep a stale 0/1.
    expect({
      g1: c.pin(p('g1', 'out')),
      n2: c.pin(p('n2', 'out')),
      n3: c.pin(p('n3', 'out'))
    }).toEqual({ g1: X, n2: X, n3: X })
  })

  it('the oscillating run stops no later than the simulation time limit (LIVE mode)', () => {
    // Appendix B: in LIVE mode a switch toggle propagates "until no further output
    // changes occur or the simulation time limit is reached" (100 ns here).
    const c = ringOscillator()
    c.set('en', ONE)
    expect(c.time).toBeLessThanOrEqual(100)
  })

  it('unrelated nets keep their values through the oscillation', () => {
    const c = ringOscillator()
    c.set('en', ONE)
    expect(c.pin(p('side', 'out'))).toBe(ZERO)
    expect(trace(c, 'pside')).toEqual([[0, ZERO]])
  })

  it('normal operation resumes after the ring is disabled again', () => {
    const c = ringOscillator()
    c.set('en', ONE)
    c.set('en', ZERO)
    expect(c.oscillated).toBe(false)
    expect(c.pin(p('g1', 'out'))).toBe(ONE)
    expect(c.pin(p('n2', 'out'))).toBe(ZERO)
    expect(c.pin(p('n3', 'out'))).toBe(ONE)
  })

  it('unrelated logic still works after the oscillation', () => {
    const c = ringOscillator()
    c.set('en', ONE)
    c.set('en', ZERO)
    c.set('b', ONE)
    expect(c.pin(p('side', 'out'))).toBe(ONE)
    expect(trace(c, 'pside')[1][1]).toBe(ONE)
    expect(allNonDecreasing(c)).toBe(true)
  })

  it('reset() clears the oscillation flag and returns the circuit to t=0', () => {
    const c = ringOscillator()
    c.set('en', ONE)
    c.reset()
    expect(c.oscillated).toBe(false)
    expect(c.time).toBe(0)
    for (const w of c.sim.getWaveforms()) expect(w.samples.length).toBe(1)
  })
})
