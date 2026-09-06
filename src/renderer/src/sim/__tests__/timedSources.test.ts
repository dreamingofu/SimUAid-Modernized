// Unit verification of the timed sources: CLOCK, INPUT_SIGNAL, CHECKER (and the
// .chk parser) plus the .ckt loader on the shipped sample circuits. Every
// assertion states the behavior the SimUaid manual requires (Appendix B for the
// clock/step/go timing, §1.2.7 for the input signal, §1.4.4 for the checker).

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  ComponentType,
  LogicValue,
  type Netlist,
  type SignalRow,
  type SignalValue
} from '../../model/types'
import { deserializeNetlist, serializeNetlist } from '../../serialization/ckt'
import { resolveNets } from '../../netlist/nets'
import { parseChk, type ParsedChk } from '../checker'
import type { WaveformSample } from '../engine'
import { Circuit, CircuitBuilder, p } from './harness'

const { ZERO, ONE, X, Z } = LogicValue

// ---------------------------------------------------------------------------
// Local helpers (the harness has no waveform or file-loading helpers).
// ---------------------------------------------------------------------------

const SAMPLES_DIR = new URL('../../../../../samples/', import.meta.url)

function readSample(name: string): string {
  return readFileSync(new URL(name, SAMPLES_DIR), 'utf8')
}

function loadCkt(name: string): { netlist: Netlist; c: Circuit } {
  const netlist = deserializeNetlist(readSample(name))
  return { netlist, c: new Circuit(netlist, netlist.metadata.switchValues ?? {}) }
}

/** Waveform samples recorded for a probe. */
function trace(c: Circuit, probeId: string): WaveformSample[] {
  const w = c.sim.getWaveforms().find((t) => t.probeId === probeId)
  if (!w) throw new Error(`no probe ${probeId}`)
  return w.samples
}

/** Value a waveform holds at time t (last sample at or before t; Z if none). */
function valueAt(samples: WaveformSample[], t: number): LogicValue {
  let v: LogicValue = Z
  for (const s of samples) {
    if (s.t <= t) v = s.v
    else break
  }
  return v
}

function pairs(samples: WaveformSample[]): [number, LogicValue][] {
  return samples.map((s) => [s.t, s.v])
}

/** Times at which the waveform changes to `to` (the t=0 sample never counts). */
function edgesTo(samples: WaveformSample[], to: LogicValue): number[] {
  const out: number[] = []
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].v === to && samples[i - 1].v !== to) out.push(samples[i].t)
  }
  return out
}

/** Expected samples of a free-running clock: `initial` at 0, toggling every `half` ns. */
function expectedClock(initial: LogicValue, half: number, until: number): [number, LogicValue][] {
  const out: [number, LogicValue][] = []
  let v = initial
  for (let t = 0; t <= until; t += half) {
    out.push([t, v])
    v = v === ONE ? ZERO : ONE
  }
  return out
}

const row = (timeNs: number, value: SignalValue): SignalRow => ({ timeNs, value })

function chkOf(input: string, output: string): { input: string; output: string } {
  return { input, output }
}

function parsedOrThrow(text: string): ParsedChk {
  const r = parseChk(text)
  if (typeof r === 'string') throw new Error(r)
  return r
}

/** The checker's display text: READY, n/total, PASS or FAIL. */
function display(c: Circuit, checkerId = 'chk'): string | undefined {
  return c.sim.getSmDisplays()[p(checkerId, 'result')]
}

// ---------------------------------------------------------------------------
// Circuit factories
// ---------------------------------------------------------------------------

function clockCircuit(period: number, initial: LogicValue, simTimeNs = 100): Circuit {
  return new CircuitBuilder()
    .add('clk', ComponentType.CLOCK)
    .probe('pc')
    .wire(p('clk', 'out'), p('pc', 'in'))
    .setSimulation({ clockPeriodNs: period, clockInitialValue: initial, simTimeNs })
    .build()
}

function signalCircuit(rows: SignalRow[], simTimeNs = 100): Circuit {
  return new CircuitBuilder()
    .add('sig', ComponentType.INPUT_SIGNAL, { signal: rows })
    .probe('ps')
    .wire(p('sig', 'out'), p('ps', 'in'))
    .setSimulation({ simTimeNs })
    .build()
}

interface ChkOpts {
  clock?: boolean
  period?: number
  initial?: LogicValue
  simTimeNs?: number
}

/** A checker (plus, by default, a clock) with the given sequences. */
function checkerBuilder(chk: { input: string; output: string }, opts: ChkOpts = {}): CircuitBuilder {
  const b = new CircuitBuilder().add('chk', ComponentType.CHECKER, { chk })
  if (opts.clock !== false) b.add('clk', ComponentType.CLOCK)
  b.setSimulation({
    clockPeriodNs: opts.period ?? 20,
    clockInitialValue: opts.initial ?? ONE,
    simTimeNs: opts.simTimeNs ?? 200
  })
  return b
}

/** Checker out -> NOT -> checker in. */
function inverterUnderTest(chk: { input: string; output: string }, opts: ChkOpts = {}): Circuit {
  return checkerBuilder(chk, opts)
    .add('n', ComponentType.NOT)
    .wire(p('chk', 'out'), p('n', 'in1'))
    .wire(p('n', 'out'), p('chk', 'in'))
    .build()
}

/** Checker out wired straight back into checker in. */
function directUnderTest(chk: { input: string; output: string }, opts: ChkOpts = {}): Circuit {
  return checkerBuilder(chk, opts).wire(p('chk', 'out'), p('chk', 'in')).build()
}

/**
 * A D flip-flop (S=R=1 from switches) clocked by the clock, D from VCC or the checker,
 * Q wired to the checker's in pin (and to probe pq; the clock to probe pc).
 */
function dffUnderChecker(
  chk: { input: string; output: string },
  dSource: 'vcc' | 'chk',
  opts: ChkOpts = {}
): Circuit {
  const b = checkerBuilder(chk, opts)
    .switch('s', ONE)
    .switch('r', ONE)
    .add('ff', ComponentType.D_FLIPFLOP)
    .probe('pq')
    .probe('pc')
    .wire(p('s', 'out'), p('ff', 'S'))
    .wire(p('r', 'out'), p('ff', 'R'))
    .connect(p('clk', 'out'), p('ff', 'CLK'), p('pc', 'in'))
    .connect(p('ff', 'Q'), p('pq', 'in'), p('chk', 'in'))
  if (dSource === 'vcc') b.add('vcc', ComponentType.VCC).wire(p('vcc', 'out'), p('ff', 'D'))
  else b.wire(p('chk', 'out'), p('ff', 'D'))
  return b.build()
}

const INVERTER_CHK = parsedOrThrow(readSample('inverter-test.chk'))

// ===========================================================================
// CLOCK
// ===========================================================================

describe('CLOCK', () => {
  it.each([
    ['rising-edge mode', ONE],
    ['falling-edge mode', ZERO]
  ])('starts at its configured initial value at t=0 (%s)', (_name, initial) => {
    const c = clockCircuit(20, initial)
    expect(c.time).toBe(0)
    expect(c.pin(p('clk', 'out'))).toBe(initial)
    expect(c.pin(p('pc', 'in'))).toBe(initial)
    expect(pairs(trace(c, 'pc'))).toEqual([[0, initial]])
  })

  it('period 20, limit 100: go() ends 95 ns (a quarter period before the rising edge at 100)', () => {
    const c = clockCircuit(20, ONE)
    c.go()
    expect(c.time).toBe(95)
  })

  it('period 20, limit 100: go() also ends at 95 ns in falling-edge mode', () => {
    const c = clockCircuit(20, ZERO)
    c.go()
    expect(c.time).toBe(95)
  })

  it('period 20, rising-edge mode: the probed waveform toggles every 10 ns starting from 1', () => {
    const c = clockCircuit(20, ONE)
    c.go()
    expect(pairs(trace(c, 'pc'))).toEqual(expectedClock(ONE, 10, 90))
  })

  it('period 20, falling-edge mode: the probed waveform toggles every 10 ns starting from 0', () => {
    const c = clockCircuit(20, ZERO)
    c.go()
    expect(pairs(trace(c, 'pc'))).toEqual(expectedClock(ZERO, 10, 90))
  })

  it.each([
    ['rising-edge mode', ONE],
    ['falling-edge mode', ZERO]
  ])('period 20: step() ends at 15, 35, 55, 75, 95 ns (%s)', (_name, initial) => {
    const c = clockCircuit(20, initial)
    const ends: number[] = []
    for (let i = 0; i < 5; i++) {
      c.step()
      ends.push(c.time)
    }
    expect(ends).toEqual([15, 35, 55, 75, 95])
  })

  it('step() is not capped by the simulation time limit: it keeps ending a quarter period before each edge (115, 135, 155)', () => {
    // Implementation decision 5: Step runs to a quarter period before the next active edge
    // with NO cap at simTimeNs.
    const c = clockCircuit(20, ONE)
    const ends: number[] = []
    for (let i = 0; i < 8; i++) {
      c.step()
      ends.push(c.time)
    }
    expect(ends).toEqual([15, 35, 55, 75, 95, 115, 135, 155])
    expect(pairs(trace(c, 'pc'))).toEqual(expectedClock(ONE, 10, 150))
  })

  it('a second go() runs simTimeNs further and ends at 195 ns (Go is relative to the current time)', () => {
    const c = clockCircuit(20, ONE)
    c.go()
    expect(c.time).toBe(95)
    c.go()
    expect(c.time).toBe(195)
    expect(pairs(trace(c, 'pc'))).toEqual(expectedClock(ONE, 10, 190))
    c.go()
    expect(c.time).toBe(295)
  })

  it('go() after a step() runs simTimeNs from the current time, stopping a quarter period before an edge', () => {
    const c = clockCircuit(20, ONE)
    c.step()
    expect(c.time).toBe(15)
    c.go() // horizon 115 is itself a quarter period before the edge at 120
    expect(c.time).toBe(115)
    c.step()
    expect(c.time).toBe(135)
  })

  it('go() with a horizon that is not aligned stops at the last quarter-before-edge point before it', () => {
    // simTimeNs 50 from 0: the horizon 50 lies between 35 and 55 -> stop at 35.
    const c = clockCircuit(20, ONE, 50)
    c.go()
    expect(c.time).toBe(35)
    c.go() // 35 + 50 = 85 -> stop at 75
    expect(c.time).toBe(75)
  })

  it('rising-edge mode: the clock is low (inactive) at every step end, i.e. just before a rising edge', () => {
    const c = clockCircuit(20, ONE)
    for (let i = 0; i < 5; i++) {
      c.step()
      expect(c.pin(p('clk', 'out'))).toBe(ZERO)
      expect(valueAt(trace(c, 'pc'), c.time)).toBe(ZERO)
    }
  })

  it('falling-edge mode: the clock is high (inactive) at every step end, i.e. just before a falling edge', () => {
    const c = clockCircuit(20, ZERO)
    for (let i = 0; i < 5; i++) {
      c.step()
      expect(c.pin(p('clk', 'out'))).toBe(ONE)
    }
  })

  it('the waveform recorded during step() calls matches the one recorded during go()', () => {
    const stepped = clockCircuit(20, ONE)
    for (let i = 0; i < 5; i++) stepped.step()
    const gone = clockCircuit(20, ONE)
    gone.go()
    expect(pairs(trace(stepped, 'pc'))).toEqual(pairs(trace(gone, 'pc')))
  })

  it('a NOT gate fed by the clock produces the inverted waveform one delay later', () => {
    const c = new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .add('n', ComponentType.NOT)
      .probe('pn')
      .wire(p('clk', 'out'), p('n', 'in1'))
      .wire(p('n', 'out'), p('pn', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 100 })
      .build()
    c.go()
    const s = trace(c, 'pn')
    for (let k = 0; k < 10; k++) {
      // clock is 1 on [0,10), 0 on [10,20), ... ; the inverter follows 1 ns later
      expect(valueAt(s, 10 * k + 1)).toBe(k % 2 === 0 ? ZERO : ONE)
      expect(valueAt(s, 10 * k + 9)).toBe(k % 2 === 0 ? ZERO : ONE)
    }
  })

  it.each([
    ['rising-edge mode (initial 1): first falling edge at 10 -> Q set at 11', ONE, 11],
    ['falling-edge mode (initial 0): first falling edge at 20 -> Q set at 21', ZERO, 21]
  ])('a JK flip-flop (J=1, K=0) sees the falling edges implied by the clock mode: %s', (_n, initial, at) => {
    const c = new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .switch('s', ONE)
      .switch('r', ONE)
      .add('vcc', ComponentType.VCC)
      .add('gnd', ComponentType.GROUND)
      .add('ff', ComponentType.JK_FLIPFLOP)
      .probe('pq')
      .wire(p('s', 'out'), p('ff', 'S'))
      .wire(p('r', 'out'), p('ff', 'R'))
      .wire(p('vcc', 'out'), p('ff', 'J'))
      .wire(p('gnd', 'out'), p('ff', 'K'))
      .wire(p('clk', 'out'), p('ff', 'CLK'))
      .wire(p('ff', 'Q'), p('pq', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: initial, simTimeNs: 100 })
      .build()
    expect(c.pin(p('ff', 'Q'))).toBe(X)
    c.step()
    expect(c.time).toBe(15)
    expect(pairs(trace(c, 'pq'))).toEqual(at <= 15 ? [[0, X], [at, ONE]] : [[0, X]])
    c.step()
    expect(pairs(trace(c, 'pq'))).toEqual([
      [0, X],
      [at, ONE]
    ])
  })

  it('reset() returns to t=0 with the initial value and clears the waveform', () => {
    const c = clockCircuit(20, ONE)
    c.go()
    c.reset()
    expect(c.time).toBe(0)
    expect(c.pin(p('clk', 'out'))).toBe(ONE)
    expect(pairs(trace(c, 'pc'))).toEqual([[0, ONE]])
    c.step()
    expect(c.time).toBe(15)
    expect(pairs(trace(c, 'pc'))).toEqual([
      [0, ONE],
      [10, ZERO]
    ])
  })

  describe('period 8 (quarter period = 2 ns)', () => {
    it('toggles every 4 ns', () => {
      const c = clockCircuit(8, ONE)
      c.go()
      expect(pairs(trace(c, 'pc'))).toEqual(expectedClock(ONE, 4, 92))
    })

    it('step() ends at 6, 14, 22, 30 ns', () => {
      const c = clockCircuit(8, ONE)
      const ends: number[] = []
      for (let i = 0; i < 4; i++) {
        c.step()
        ends.push(c.time)
      }
      expect(ends).toEqual([6, 14, 22, 30])
    })

    it('go() with limit 100 ends at 94 ns (a quarter period before the rising edge at 96)', () => {
      const c = clockCircuit(8, ONE)
      c.go()
      expect(c.time).toBe(94)
    })
  })

  describe('period 30 (quarter period = 7.5 ns)', () => {
    it('toggles every 15 ns', () => {
      const c = clockCircuit(30, ONE)
      c.go()
      expect(pairs(trace(c, 'pc'))).toEqual(expectedClock(ONE, 15, 75))
    })

    it('step() ends at 22, 52, 82 ns (quarter = round(7.5) = 8 before the rising edges at 30, 60, 90)', () => {
      // Implementation decision 6: quarter period = max(1, round(period / 4)).
      const c = clockCircuit(30, ONE)
      const ends: number[] = []
      for (let i = 0; i < 3; i++) {
        c.step()
        ends.push(c.time)
        expect(c.pin(p('clk', 'out'))).toBe(ZERO)
      }
      expect(ends).toEqual([22, 52, 82])
    })

    it('go() with limit 100 ends at 82 ns (8 ns before the rising edge at 90)', () => {
      const c = clockCircuit(30, ONE)
      c.go()
      expect(c.time).toBe(82)
    })
  })

  describe('odd period 25', () => {
    it('rising edges occur at exact multiples of the configured period', () => {
      const c = clockCircuit(25, ONE, 200)
      c.go()
      const rising = edgesTo(trace(c, 'pc'), ONE)
      expect(rising.slice(0, 4)).toEqual([25, 50, 75, 100])
    })

    it('toggle k happens at floor(k * 25 / 2): 12, 25, 37, 50, 62, 75, 87, 100', () => {
      // Implementation decision 6: half periods alternate 12/13 so active edges stay on multiples of 25.
      const c = clockCircuit(25, ONE, 200)
      c.go()
      expect(pairs(trace(c, 'pc')).slice(0, 9)).toEqual([
        [0, ONE],
        [12, ZERO],
        [25, ONE],
        [37, ZERO],
        [50, ONE],
        [62, ZERO],
        [75, ONE],
        [87, ZERO],
        [100, ONE]
      ])
    })

    it('falling-edge mode: the same toggle times starting from 0, so active (falling) edges are at 25, 50, 75', () => {
      const c = clockCircuit(25, ZERO, 200)
      c.go()
      expect(edgesTo(trace(c, 'pc'), ZERO)).toEqual(expect.arrayContaining([25, 50, 75, 100]))
      expect(pairs(trace(c, 'pc')).slice(0, 5)).toEqual([
        [0, ZERO],
        [12, ONE],
        [25, ZERO],
        [37, ONE],
        [50, ZERO]
      ])
    })

    it('step() ends at 19, 44, 69, 94 ns (quarter = round(6.25) = 6)', () => {
      const c = clockCircuit(25, ONE, 1000)
      const ends: number[] = []
      for (let i = 0; i < 4; i++) {
        c.step()
        ends.push(c.time)
      }
      expect(ends).toEqual([19, 44, 69, 94])
    })

    it('go() with limit 100 ends at 94 ns (6 ns before the rising edge at 100)', () => {
      const c = clockCircuit(25, ONE, 100)
      c.go()
      expect(c.time).toBe(94)
    })

    it('every step() still ends just before a rising edge, with the clock low', () => {
      const c = clockCircuit(25, ONE, 1000)
      const violations: number[] = []
      for (let i = 0; i < 20; i++) {
        c.step()
        if (c.pin(p('clk', 'out')) !== ZERO) violations.push(c.time)
      }
      expect(violations).toEqual([])
    })
  })
})

// ===========================================================================
// INPUT_SIGNAL
// ===========================================================================

describe('INPUT_SIGNAL', () => {
  it.each([ZERO, ONE, X, Z])('a row at t=0 with value %s sets the initial output', (v) => {
    const c = signalCircuit([row(0, v), row(50, ONE)])
    expect(c.pin(p('sig', 'out'))).toBe(v)
    expect(pairs(trace(c, 'ps'))).toEqual([[0, v]])
  })

  it('without a row at t=0 the output is Z until the first row', () => {
    const c = signalCircuit([row(10, ONE)])
    expect(c.pin(p('sig', 'out'))).toBe(Z)
    c.go()
    const s = trace(c, 'ps')
    expect(valueAt(s, 0)).toBe(Z)
    expect(valueAt(s, 9)).toBe(Z)
    expect(valueAt(s, 10)).toBe(ONE)
    expect(valueAt(s, 99)).toBe(ONE)
  })

  it('with no rows at all the output stays Z', () => {
    const c = signalCircuit([])
    c.go()
    expect(c.pin(p('sig', 'out'))).toBe(Z)
    expect(pairs(trace(c, 'ps'))).toEqual([[0, Z]])
  })

  it('each row holds its value until the next row', () => {
    const c = signalCircuit([row(0, ZERO), row(10, ONE), row(25, ZERO), row(40, ONE)])
    c.go()
    const s = trace(c, 'ps')
    expect(pairs(s)).toEqual([
      [0, ZERO],
      [10, ONE],
      [25, ZERO],
      [40, ONE]
    ])
    expect(valueAt(s, 9)).toBe(ZERO)
    expect(valueAt(s, 10)).toBe(ONE)
    expect(valueAt(s, 24)).toBe(ONE)
    expect(valueAt(s, 25)).toBe(ZERO)
    expect(valueAt(s, 39)).toBe(ZERO)
    expect(valueAt(s, 40)).toBe(ONE)
    expect(valueAt(s, 99)).toBe(ONE)
  })

  it('rows given out of order produce the same waveform as sorted rows', () => {
    const sorted = signalCircuit([row(0, ZERO), row(10, ONE), row(20, ZERO), row(30, ONE)])
    const shuffled = signalCircuit([row(30, ONE), row(10, ONE), row(0, ZERO), row(20, ZERO)])
    expect(shuffled.pin(p('sig', 'out'))).toBe(ZERO)
    sorted.go()
    shuffled.go()
    expect(pairs(trace(shuffled, 'ps'))).toEqual(pairs(trace(sorted, 'ps')))
    expect(pairs(trace(shuffled, 'ps'))).toEqual([
      [0, ZERO],
      [10, ONE],
      [20, ZERO],
      [30, ONE]
    ])
  })

  it('drives all four values 0, 1, X and Z', () => {
    const c = signalCircuit([row(0, ONE), row(10, X), row(20, Z), row(30, ZERO)])
    c.go()
    expect(pairs(trace(c, 'ps'))).toEqual([
      [0, ONE],
      [10, X],
      [20, Z],
      [30, ZERO]
    ])
  })

  it('X and Z rows feed a gate as undetermined inputs (NOT -> X)', () => {
    const c = new CircuitBuilder()
      .add('sig', ComponentType.INPUT_SIGNAL, {
        signal: [row(0, ONE), row(10, X), row(20, Z), row(30, ZERO)]
      })
      .add('n', ComponentType.NOT)
      .probe('pn')
      .wire(p('sig', 'out'), p('n', 'in1'))
      .wire(p('n', 'out'), p('pn', 'in'))
      .setSimulation({ simTimeNs: 100 })
      .build()
    c.go()
    const s = trace(c, 'pn')
    expect(valueAt(s, 5)).toBe(ZERO)
    expect(valueAt(s, 15)).toBe(X)
    expect(valueAt(s, 25)).toBe(X)
    expect(valueAt(s, 35)).toBe(ONE)
  })

  it("'R' at time T repeats the waveform from 0 with period T (checked over 10 periods)", () => {
    const c = signalCircuit([row(0, ONE), row(5, ZERO), row(10, 'R')])
    c.go()
    const s = trace(c, 'ps')
    for (let k = 0; k < 10; k++) {
      expect(valueAt(s, 10 * k)).toBe(ONE)
      expect(valueAt(s, 10 * k + 2)).toBe(ONE)
      expect(valueAt(s, 10 * k + 5)).toBe(ZERO)
      expect(valueAt(s, 10 * k + 9)).toBe(ZERO)
    }
    // go() with no clock runs to now + simTimeNs = 100 inclusive, so the cycle start at 100 is recorded.
    expect(c.time).toBe(100)
    expect(edgesTo(s, ONE)).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
    expect(edgesTo(s, ZERO)).toEqual([5, 15, 25, 35, 45, 55, 65, 75, 85, 95])
  })

  it("a row exactly at the 'R' time is dropped (the cycle restarts with the t=0 value instead)", () => {
    // Implementation decision 7: rows at or after T are dropped.
    const c = signalCircuit([row(0, ZERO), row(5, ONE), row(10, ZERO), row(10, 'R')])
    c.go()
    const s = trace(c, 'ps')
    expect(pairs(s).slice(0, 5)).toEqual([
      [0, ZERO],
      [5, ONE],
      [10, ZERO],
      [15, ONE],
      [20, ZERO]
    ])
    // The waveform is identical to one without the dropped row.
    const without = signalCircuit([row(0, ZERO), row(5, ONE), row(10, 'R')])
    without.go()
    expect(pairs(s)).toEqual(pairs(trace(without, 'ps')))
  })

  it("with several 'R' rows the earliest one (T > 0) sets the period and the later ones are dropped", () => {
    const c = signalCircuit([row(0, ONE), row(5, ZERO), row(10, 'R'), row(20, 'R'), row(30, 'R')])
    c.go()
    expect(edgesTo(trace(c, 'ps'), ONE)).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
  })

  it("an 'R' row at time 0 cannot define a period and is ignored; the rest of the waveform plays once", () => {
    // Decision 7 defines 'R' only for T > 0. With no row giving a value at 0 the output starts at Z.
    const c = signalCircuit([row(0, 'R'), row(10, ONE), row(20, ZERO)])
    expect(c.pin(p('sig', 'out'))).toBe(Z)
    c.go()
    expect(pairs(trace(c, 'ps'))).toEqual([
      [0, Z],
      [10, ONE],
      [20, ZERO]
    ])
  })

  it("a repeat whose t=0 row has the same value as the last row produces no extra edge at the cycle start", () => {
    // 1 on [0,5), 0 on [5,10), repeat: the value at 10 is 1 (from the t=0 row) -> a genuine edge;
    // but with rows 0:0, 5:1, 8:0, R@10 the cycle restart at 10 keeps 0 -> no sample recorded at 10.
    const c = signalCircuit([row(0, ZERO), row(5, ONE), row(8, ZERO), row(10, 'R')])
    c.go()
    const s = trace(c, 'ps')
    expect(pairs(s).slice(0, 5)).toEqual([
      [0, ZERO],
      [5, ONE],
      [8, ZERO],
      [15, ONE],
      [18, ZERO]
    ])
  })

  it("'R' repeat with a 4-row pattern (0/10/20/30, R at 40) yields a 40 ns period", () => {
    const c = signalCircuit([row(0, ZERO), row(10, ONE), row(20, ZERO), row(30, ONE), row(40, 'R')])
    c.go()
    const s = trace(c, 'ps')
    for (let cycle = 0; cycle < 2; cycle++) {
      const base = 40 * cycle
      expect(valueAt(s, base + 5)).toBe(ZERO)
      expect(valueAt(s, base + 15)).toBe(ONE)
      expect(valueAt(s, base + 25)).toBe(ZERO)
      expect(valueAt(s, base + 35)).toBe(ONE)
    }
    expect(valueAt(s, 85)).toBe(ZERO)
    expect(valueAt(s, 95)).toBe(ONE)
  })

  it("'R' with the first row after t=0 returns to Z at the start of every cycle", () => {
    // Waveform from time 0 is: Z on [0,5), 1 on [5,10); repeating it means Z again on [10,15).
    const c = signalCircuit([row(5, ONE), row(10, 'R')])
    c.go()
    const s = trace(c, 'ps')
    expect(valueAt(s, 2)).toBe(Z)
    expect(valueAt(s, 7)).toBe(ONE)
    expect(valueAt(s, 12)).toBe(Z)
    expect(valueAt(s, 17)).toBe(ONE)
    expect(valueAt(s, 22)).toBe(Z)
  })

  it("rows at or after the 'R' time are not part of the repeated waveform", () => {
    const c = signalCircuit([row(0, ZERO), row(10, 'R'), row(15, ONE)])
    c.go()
    const s = trace(c, 'ps')
    for (let t = 0; t < 100; t += 5) expect(valueAt(s, t)).toBe(ZERO)
  })

  it('the waveform is complete after go() and go() ends at the time limit when no clock is present', () => {
    const c = signalCircuit([row(0, ZERO), row(10, ONE), row(20, ZERO), row(30, ONE)])
    c.go()
    expect(c.time).toBe(100)
    expect(pairs(trace(c, 'ps'))).toEqual([
      [0, ZERO],
      [10, ONE],
      [20, ZERO],
      [30, ONE]
    ])
  })

  it('step() with only an INPUT_SIGNAL advances to the next row', () => {
    const c = signalCircuit([row(0, ZERO), row(10, ONE), row(20, ZERO), row(30, ONE)])
    c.step()
    expect(c.time).toBe(10)
    expect(c.pin(p('sig', 'out'))).toBe(ONE)
    c.step()
    expect(c.time).toBe(20)
    expect(c.pin(p('sig', 'out'))).toBe(ZERO)
    c.step()
    expect(c.time).toBe(30)
    expect(c.pin(p('sig', 'out'))).toBe(ONE)
    expect(pairs(trace(c, 'ps'))).toEqual([
      [0, ZERO],
      [10, ONE],
      [20, ZERO],
      [30, ONE]
    ])
  })

  it('step() with an INPUT_SIGNAL driving a gate visits every pending event in order', () => {
    const c = new CircuitBuilder()
      .add('sig', ComponentType.INPUT_SIGNAL, { signal: [row(0, ZERO), row(10, ONE), row(20, ZERO)] })
      .add('n', ComponentType.NOT)
      .probe('pn')
      .wire(p('sig', 'out'), p('n', 'in1'))
      .wire(p('n', 'out'), p('pn', 'in'))
      .setSimulation({ simTimeNs: 100 })
      .build()
    const visited: number[] = []
    for (let i = 0; i < 4; i++) {
      c.step()
      visited.push(c.time)
    }
    expect(visited).toEqual([10, 11, 20, 21])
    expect(valueAt(trace(c, 'pn'), 11)).toBe(ZERO)
    expect(valueAt(trace(c, 'pn'), 21)).toBe(ONE)
  })

  it('step() with no further queued change runs to now + simTimeNs (no absolute cap at the time limit)', () => {
    // Implementation decision 5: with only INPUT_SIGNALs, Step runs to the next queued change
    // within now + simTimeNs, else to now + simTimeNs.
    const c = signalCircuit([row(0, ZERO), row(10, ONE)])
    c.step()
    expect(c.time).toBe(10)
    c.step()
    expect(c.time).toBe(110)
    c.step()
    expect(c.time).toBe(210)
    expect(pairs(trace(c, 'ps'))).toEqual([
      [0, ZERO],
      [10, ONE]
    ])
  })

  it('step() stops at now + simTimeNs when the next row lies beyond that horizon, then reaches the row', () => {
    const c = signalCircuit([row(0, ZERO), row(150, ONE)])
    c.step()
    expect(c.time).toBe(100)
    expect(c.pin(p('sig', 'out'))).toBe(ZERO)
    c.step()
    expect(c.time).toBe(150)
    expect(c.pin(p('sig', 'out'))).toBe(ONE)
  })

  it('step() with a repeating signal visits every row and every cycle restart', () => {
    // Z on [0,5), 1 on [5,10), repeat every 10: changes at 5, 10 (back to Z), 15, 20, ...
    const c = signalCircuit([row(5, ONE), row(10, 'R')])
    const visited: number[] = []
    const values: LogicValue[] = []
    for (let i = 0; i < 6; i++) {
      c.step()
      visited.push(c.time)
      values.push(c.pin(p('sig', 'out')))
    }
    expect(visited).toEqual([5, 10, 15, 20, 25, 30])
    expect(values).toEqual([ONE, Z, ONE, Z, ONE, Z])
  })

  it('a repeating signal is continuous across mixed step()/go() calls (Go is relative to the current time)', () => {
    const rows = [row(0, ONE), row(5, ZERO), row(10, 'R' as const)]
    const mixed = signalCircuit(rows)
    mixed.step()
    mixed.step()
    mixed.step()
    expect(mixed.time).toBe(15)
    mixed.go()
    expect(mixed.time).toBe(115)
    const straight = signalCircuit(rows)
    straight.go()
    expect(straight.time).toBe(100)
    const upTo100 = (c: Circuit) => pairs(trace(c, 'ps')).filter(([t]) => t <= 100)
    expect(upTo100(mixed)).toEqual(upTo100(straight))
    // and the mixed run continued the pattern past 100
    expect(pairs(trace(mixed, 'ps')).filter(([t]) => t > 100)).toEqual([
      [105, ZERO],
      [110, ONE],
      [115, ZERO]
    ])
  })

  it('samples/input-signal.ckt: 0/10/20/30 pattern repeating every 40 ns', () => {
    const { c } = loadCkt('input-signal.ckt')
    c.go()
    const s = trace(c, 'p')
    expect(valueAt(s, 5)).toBe(ZERO)
    expect(valueAt(s, 15)).toBe(ONE)
    expect(valueAt(s, 25)).toBe(ZERO)
    expect(valueAt(s, 35)).toBe(ONE)
    expect(valueAt(s, 45)).toBe(ZERO)
    expect(valueAt(s, 55)).toBe(ONE)
    expect(valueAt(s, 65)).toBe(ZERO)
    expect(valueAt(s, 75)).toBe(ONE)
    expect(valueAt(s, 85)).toBe(ZERO)
    expect(valueAt(s, 95)).toBe(ONE)
    expect(edgesTo(s, ONE)).toEqual([10, 30, 50, 70, 90])
  })

  it('a D flip-flop clocked exactly at a row boundary captures the NEW row value (same-instant events are applied first)', () => {
    // Implementation decision 1 (VHDL semantics): an INPUT_SIGNAL row exactly at a clock edge is
    // captured by that edge. Rising edges at 20, 40, 60; the signal changes at exactly those times.
    const c = new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .add('sig', ComponentType.INPUT_SIGNAL, {
        signal: [row(0, ONE), row(20, ZERO), row(40, ONE), row(60, ONE)]
      })
      .switch('s', ONE)
      .switch('r', ONE)
      .add('ff', ComponentType.D_FLIPFLOP)
      .wire(p('clk', 'out'), p('ff', 'CLK'))
      .wire(p('sig', 'out'), p('ff', 'D'))
      .wire(p('s', 'out'), p('ff', 'S'))
      .wire(p('r', 'out'), p('ff', 'R'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 100 })
      .build()
    c.step()
    expect(c.time).toBe(15)
    expect(c.pin(p('ff', 'D'))).toBe(ONE)
    c.step()
    expect(c.time).toBe(35)
    expect(c.pin(p('ff', 'Q'))).toBe(ZERO) // the row at 20 (D=0) lands with the edge at 20 and is captured
    c.step()
    expect(c.time).toBe(55)
    expect(c.pin(p('ff', 'Q'))).toBe(ONE) // the row at 40 (D=1) is captured by the edge at 40
    c.step()
    expect(c.time).toBe(75)
    expect(c.pin(p('ff', 'Q'))).toBe(ONE) // row at 60 keeps D=1
  })

  it('a D flip-flop clocked one ns after a row boundary captures the new value; one ns before, the old one', () => {
    const build = (rows: SignalRow[]): Circuit =>
      new CircuitBuilder()
        .add('clk', ComponentType.CLOCK)
        .add('sig', ComponentType.INPUT_SIGNAL, { signal: rows })
        .switch('s', ONE)
        .switch('r', ONE)
        .add('ff', ComponentType.D_FLIPFLOP)
        .wire(p('clk', 'out'), p('ff', 'CLK'))
        .wire(p('sig', 'out'), p('ff', 'D'))
        .wire(p('s', 'out'), p('ff', 'S'))
        .wire(p('r', 'out'), p('ff', 'R'))
        .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 100 })
        .build()
    const before = build([row(0, ONE), row(19, ZERO)]) // D=0 already present at the edge at 20
    before.step()
    before.step()
    expect(before.time).toBe(35)
    expect(before.pin(p('ff', 'Q'))).toBe(ZERO)
    const after = build([row(0, ONE), row(21, ZERO)]) // D=1 at the edge at 20; 0 arrives too late
    after.step()
    after.step()
    expect(after.time).toBe(35)
    expect(after.pin(p('ff', 'Q'))).toBe(ONE)
  })

  it('with a clock present go() stops a quarter period before an edge even though the signal changes later', () => {
    const c = new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .add('sig', ComponentType.INPUT_SIGNAL, { signal: [row(0, ZERO), row(97, ONE)] })
      .probe('ps')
      .wire(p('sig', 'out'), p('ps', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 100 })
      .build()
    c.go()
    expect(c.time).toBe(95)
    expect(c.pin(p('sig', 'out'))).toBe(ZERO)
    c.step()
    expect(c.time).toBe(115)
    expect(c.pin(p('sig', 'out'))).toBe(ONE)
    expect(pairs(trace(c, 'ps'))).toEqual([
      [0, ZERO],
      [97, ONE]
    ])
  })
})

// ===========================================================================
// CHECKER: .chk parsing
// ===========================================================================

describe('parseChk', () => {
  it('parses two equal-length sequences', () => {
    expect(parseChk('1010\n0101')).toEqual({ input: '1010', output: '0101' })
  })

  it('ignores spaces inside the sequences', () => {
    expect(parseChk('1 0 1 0\n0 1 0 1')).toEqual({ input: '1010', output: '0101' })
  })

  it('parses the shipped inverter-test.chk', () => {
    expect(INVERTER_CHK).toEqual({ input: '10101100', output: '01010011' })
  })

  it('accepts lower-case x and r and normalizes them to upper case', () => {
    expect(parseChk('1 x r 0\n0 x 1 x')).toEqual({ input: '1XR0', output: '0X1X' })
  })

  it('accepts upper-case X and R', () => {
    expect(parseChk('1XR0\n0X1X')).toEqual({ input: '1XR0', output: '0X1X' })
  })

  it('accepts CRLF line endings and a trailing newline', () => {
    expect(parseChk('1 0\r\n0 1\r\n')).toEqual({ input: '10', output: '01' })
    expect(parseChk('1 0\n0 1\n')).toEqual({ input: '10', output: '01' })
  })

  it('rejects a file with only one sequence', () => {
    expect(typeof parseChk('1 0 1 0')).toBe('string')
    expect(typeof parseChk('1 0 1 0\n')).toBe('string')
  })

  it('rejects a file with three sequences', () => {
    expect(typeof parseChk('1 0\n0 1\n1 1')).toBe('string')
  })

  it('rejects an empty file', () => {
    expect(typeof parseChk('')).toBe('string')
    expect(typeof parseChk('\n\n')).toBe('string')
  })

  it('rejects sequences of different lengths', () => {
    expect(typeof parseChk('1 0 1\n0 1')).toBe('string')
    expect(typeof parseChk('1 0\n0 1 0')).toBe('string')
  })

  it.each(['2', 'Z', 'z', '-', 'A', '.', '1,0'])('rejects the character %s in the input sequence', (ch) => {
    expect(typeof parseChk(`1 ${ch}\n0 1`)).toBe('string')
  })

  it.each(['2', 'Z', 'z', '-', 'A', '.'])('rejects the character %s in the output sequence', (ch) => {
    expect(typeof parseChk(`1 0\n0 ${ch}`)).toBe('string')
  })

  it("allows 'R' only in the input sequence, not in the expected output sequence", () => {
    // §1.4.4.1: <output sequence> is any combination of 1, 0, X and space.
    expect(typeof parseChk('1 R\n0 R')).toBe('string')
    expect(typeof parseChk('1 0\nr 1')).toBe('string')
  })
})

// ===========================================================================
// CHECKER: simulation
// ===========================================================================

describe('CHECKER in the simulator', () => {
  it('getCheckerResult() is null when the circuit has no checker', () => {
    const c = new CircuitBuilder().add('g', ComponentType.AND2).build()
    expect(c.sim.getCheckerResult()).toBeNull()
    expect(c.sim.getSmDisplays()).toEqual({})
  })

  it('shows READY and has sampled nothing before the simulation runs', () => {
    const c = inverterUnderTest(INVERTER_CHK)
    expect(display(c)).toBe('READY')
    expect(c.sim.getCheckerResult()).toEqual({ total: 8, sampled: 0, failures: 0 })
  })

  it('drives input[0] on its out pin at t=0', () => {
    expect(inverterUnderTest(chkOf('1010', '0101')).pin(p('chk', 'out'))).toBe(ONE)
    expect(inverterUnderTest(chkOf('0101', '1010')).pin(p('chk', 'out'))).toBe(ZERO)
  })

  it('drives input[slot] during slot k (stable a quarter period into the slot and at the sample point)', () => {
    const c = checkerBuilder(INVERTER_CHK)
      .probe('po')
      .wire(p('chk', 'out'), p('po', 'in'))
      .build()
    c.go()
    const s = trace(c, 'po')
    const expected = INVERTER_CHK.input.split('').map((ch) => (ch === '1' ? ONE : ZERO))
    for (let k = 0; k < 8; k++) {
      expect(valueAt(s, 20 * k + 5)).toBe(expected[k])
      expect(valueAt(s, 20 * k + 15)).toBe(expected[k])
    }
  })

  it('slot k >= 1 is driven at exactly k*P + quarter: the out pin still holds the previous value at 24 ns and the new one at 25 ns', () => {
    // Implementation decision 8: slot 0 from t=0, slot k >= 1 at k*P + quarter (period 20 -> 25, 45, 65, ...).
    const c = checkerBuilder(chkOf('10110', 'XXXXX'))
      .probe('po')
      .wire(p('chk', 'out'), p('po', 'in'))
      .build()
    c.go()
    expect(pairs(trace(c, 'po'))).toEqual([
      [0, ONE],
      [25, ZERO],
      [45, ONE],
      // slot 3 is also 1: no change recorded at 65
      [85, ZERO]
    ])
  })

  it('step() ends with the NEXT slot value already visible on the out pin (drive at 25 precedes the step end at 35)', () => {
    const c = checkerBuilder(chkOf('1010', 'XXXX')).build()
    expect(c.pin(p('chk', 'out'))).toBe(ONE)
    c.step() // 15: still slot 0
    expect(c.pin(p('chk', 'out'))).toBe(ONE)
    c.step() // 35: slot 1 driven at 25
    expect(c.pin(p('chk', 'out'))).toBe(ZERO)
    c.step() // 55: slot 2 driven at 45
    expect(c.pin(p('chk', 'out'))).toBe(ONE)
    c.step() // 75: slot 3 driven at 65
    expect(c.pin(p('chk', 'out'))).toBe(ZERO)
  })

  it('with an odd period 25 (quarter 6) slot k is driven at 25k + 6 and sampled at 25k + 19', () => {
    const c = checkerBuilder(chkOf('101', 'XXX'), { period: 25 })
      .probe('po')
      .wire(p('chk', 'out'), p('po', 'in'))
      .build()
    c.go()
    expect(pairs(trace(c, 'po'))).toEqual([
      [0, ONE],
      [31, ZERO],
      [56, ONE]
    ])

    // Sampling window: a 1 visible only at exactly 19 ns is seen ...
    const seen = checkerBuilder(chkOf('0', '1'), { period: 25 })
      .add('sig', ComponentType.INPUT_SIGNAL, { signal: [row(0, ZERO), row(19, ONE), row(20, ZERO)] })
      .wire(p('sig', 'out'), p('chk', 'in'))
      .build()
    seen.step()
    expect(seen.time).toBe(19)
    expect(display(seen)).toBe('PASS')
    // ... a 1 that ends at 19 ns is missed.
    const missed = checkerBuilder(chkOf('0', '1'), { period: 25 })
      .add('sig', ComponentType.INPUT_SIGNAL, { signal: [row(0, ONE), row(19, ZERO)] })
      .wire(p('sig', 'out'), p('chk', 'in'))
      .build()
    missed.step()
    expect(display(missed)).toBe('FAIL')
  })

  it('a circuit output that changes exactly at the sample instant is what the checker samples (same-instant events apply first)', () => {
    // Implementation decision 1: all queued changes at one instant are applied before anything
    // observes them. At the step end (t=15) the user sees the AND output = 1, so the checker
    // sampling at 15 must see 1 too. The AND (delay 10) is fed by an INPUT_SIGNAL rising at 5.
    const c = checkerBuilder(chkOf('0', '1'))
      .add('sig', ComponentType.INPUT_SIGNAL, { signal: [row(0, ZERO), row(5, ONE)] })
      .add('g', ComponentType.AND2, { delay: 10 })
      .probe('pg')
      .connect(p('sig', 'out'), p('g', 'in1'), p('g', 'in2'))
      .connect(p('g', 'out'), p('chk', 'in'), p('pg', 'in'))
      .build()
    c.step()
    expect(c.time).toBe(15)
    expect(pairs(trace(c, 'pg'))).toEqual([
      [0, ZERO],
      [15, ONE]
    ])
    expect(c.pin(p('chk', 'in'))).toBe(ONE)
    expect(display(c)).toBe('PASS')
  })

  it('an INPUT_SIGNAL row exactly at the sample instant is what the checker samples', () => {
    const c = checkerBuilder(chkOf('0', '1'))
      .add('sig', ComponentType.INPUT_SIGNAL, { signal: [row(0, ZERO), row(15, ONE)] })
      .wire(p('sig', 'out'), p('chk', 'in'))
      .build()
    c.step()
    expect(c.time).toBe(15)
    expect(display(c)).toBe('PASS')
  })

  it('samples its in pin three quarters into each slot (window 14..16 ns is seen, period 20)', () => {
    const seen = checkerBuilder(chkOf('0', '1'))
      .add('sig', ComponentType.INPUT_SIGNAL, { signal: [row(0, ZERO), row(14, ONE), row(16, ZERO)] })
      .wire(p('sig', 'out'), p('chk', 'in'))
      .build()
    seen.step()
    expect(seen.time).toBe(15)
    expect(display(seen)).toBe('PASS')
    expect(seen.sim.getCheckerResult()).toEqual({ total: 1, sampled: 1, failures: 0 })
  })

  it('does not sample before 0.75 period (a 1 that ends at 14 ns is missed)', () => {
    const c = checkerBuilder(chkOf('0', '1'))
      .add('sig', ComponentType.INPUT_SIGNAL, { signal: [row(0, ONE), row(14, ZERO)] })
      .wire(p('sig', 'out'), p('chk', 'in'))
      .build()
    c.step()
    expect(display(c)).toBe('FAIL')
    expect(c.sim.getCheckerResult()).toEqual({ total: 1, sampled: 1, failures: 1 })
  })

  it('does not sample after 0.75 period (a 1 that starts at 16 ns is missed)', () => {
    const c = checkerBuilder(chkOf('0', '1'))
      .add('sig', ComponentType.INPUT_SIGNAL, { signal: [row(0, ZERO), row(16, ONE)] })
      .wire(p('sig', 'out'), p('chk', 'in'))
      .build()
    c.step()
    expect(display(c)).toBe('FAIL')
  })

  it('the slot length follows clockPeriodNs (period 8: sample at 6 ns, then 14 ns)', () => {
    const c = checkerBuilder(chkOf('0', '1'), { period: 8 })
      .add('sig', ComponentType.INPUT_SIGNAL, { signal: [row(0, ZERO), row(5, ONE), row(7, ZERO)] })
      .wire(p('sig', 'out'), p('chk', 'in'))
      .build()
    c.step()
    expect(c.time).toBe(6)
    expect(display(c)).toBe('PASS')

    const inv = inverterUnderTest(chkOf('10', '01'), { period: 8 })
    inv.step()
    expect(inv.time).toBe(6)
    expect(display(inv)).toBe('1/2')
    inv.step()
    expect(inv.time).toBe(14)
    expect(display(inv)).toBe('PASS')
  })

  it('inverter-test.chk through a NOT gate passes', () => {
    const c = inverterUnderTest(INVERTER_CHK)
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 8, sampled: 8, failures: 0 })
    expect(display(c)).toBe('PASS')
  })

  it('inverter-test.chk through a NOT gate passes in falling-edge clock mode', () => {
    const c = inverterUnderTest(INVERTER_CHK, { initial: ZERO })
    c.go()
    expect(display(c)).toBe('PASS')
  })

  it('inverter-test.chk through a NOT gate passes with go() even when the circuit has no clock part', () => {
    const c = inverterUnderTest(INVERTER_CHK, { clock: false })
    c.go()
    expect(c.time).toBe(200)
    expect(display(c)).toBe('PASS')
  })

  it('inverter-test.chk through a direct wire fails on every slot', () => {
    const c = directUnderTest(INVERTER_CHK)
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 8, sampled: 8, failures: 8 })
    expect(display(c)).toBe('FAIL')
  })

  it('reports progress as n/total after each step() and PASS once every slot is sampled', () => {
    const c = inverterUnderTest(INVERTER_CHK)
    for (let k = 1; k <= 7; k++) {
      c.step()
      expect(c.time).toBe(20 * k - 5)
      expect(display(c)).toBe(`${k}/8`)
      expect(c.sim.getCheckerResult()?.sampled).toBe(k)
    }
    c.step()
    expect(display(c)).toBe('PASS')
  })

  it('publishes its display under the "<checker>#result" key of getSmDisplays()', () => {
    const c = inverterUnderTest(INVERTER_CHK)
    expect(Object.keys(c.sim.getSmDisplays())).toEqual([p('chk', 'result')])
  })

  it('keeps reporting n/total (not FAIL) while slots remain, even after an early mismatch', () => {
    // Direct wire: every slot mismatches. The verdict is only given once every slot is sampled.
    const c = directUnderTest(chkOf('1010', '0101'))
    c.step()
    expect(c.sim.getCheckerResult()).toEqual({ total: 4, sampled: 1, failures: 1 })
    expect(display(c)).toBe('1/4')
    c.step()
    c.step()
    expect(display(c)).toBe('3/4')
    c.step()
    expect(display(c)).toBe('FAIL')
  })

  it('a first slot that fails still yields FAIL after later slots pass', () => {
    // NOT of 1,0,1 is 0,1,0; the expected first value is wrong, the rest are right.
    const c = inverterUnderTest(chkOf('101', '110'))
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 3, sampled: 3, failures: 1 })
    expect(display(c)).toBe('FAIL')
  })

  it('a single mismatch anywhere in the sequence yields FAIL', () => {
    // NOT of 1,0,1,1 is 0,1,0,0 — the last expected value is wrong.
    const c = inverterUnderTest(chkOf('1011', '0101'))
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 4, sampled: 4, failures: 1 })
    expect(display(c)).toBe('FAIL')
  })

  it("X in the expected sequence is don't-care: not sampled and not counted", () => {
    const c = inverterUnderTest(chkOf('101', 'X1X'))
    expect(c.sim.getCheckerResult()).toEqual({ total: 1, sampled: 0, failures: 0 })
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 1, sampled: 1, failures: 0 })
    expect(display(c)).toBe('PASS')
  })

  it("a don't-care slot passes even when the circuit output would mismatch", () => {
    // Direct wire: actual is 1,0,1 — slots 0 and 2 would fail against 0, but they are X.
    const c = directUnderTest(chkOf('101', 'X0X'))
    c.go()
    expect(display(c)).toBe('PASS')
  })

  it("a don't-care slot passes even when the circuit output is X or Z", () => {
    const c = checkerBuilder(chkOf('11', 'XX')).build() // in pin unconnected -> Z
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 0, sampled: 0, failures: 0 })
  })

  it('X in the input sequence drives X on the out pin', () => {
    const c = inverterUnderTest(chkOf('X1', 'XX'))
    expect(c.pin(p('chk', 'out'))).toBe(X)
    c.step()
    c.step()
    expect(c.time).toBe(35)
    expect(c.pin(p('chk', 'out'))).toBe(ONE)
  })

  it("'R' in the input sequence drives X on the out pin during its slot", () => {
    const c = inverterUnderTest(chkOf('1R1', 'XXX'))
    c.step()
    expect(c.pin(p('chk', 'out'))).toBe(ONE)
    c.step()
    expect(c.time).toBe(35)
    expect(c.pin(p('chk', 'out'))).toBe(X)
    c.step()
    expect(c.pin(p('chk', 'out'))).toBe(ONE)
  })

  it('an unconnected (Z) in pin fails against an expected 0 or 1', () => {
    const zero = checkerBuilder(chkOf('1', '0')).build()
    zero.step()
    expect(display(zero)).toBe('FAIL')
    const one = checkerBuilder(chkOf('1', '1')).build()
    one.step()
    expect(display(one)).toBe('FAIL')
  })

  it('an X on the in pin fails against an expected 0 or 1', () => {
    const c = checkerBuilder(chkOf('1', '0'))
      .add('n', ComponentType.NOT) // input unconnected -> output X
      .wire(p('n', 'out'), p('chk', 'in'))
      .build()
    c.step()
    expect(c.pin(p('chk', 'in'))).toBe(X)
    expect(display(c)).toBe('FAIL')
  })

  it("'R' does not interrupt the checker's own sampling", () => {
    const c = inverterUnderTest(chkOf('1R0', '0X1'))
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 2, sampled: 2, failures: 0 })
    expect(display(c)).toBe('PASS')
  })

  it('reset() returns to READY, clears failures, drives input[0] again and the run can be repeated', () => {
    const c = directUnderTest(INVERTER_CHK)
    c.go()
    expect(display(c)).toBe('FAIL')
    c.reset()
    expect(c.time).toBe(0)
    expect(display(c)).toBe('READY')
    expect(c.sim.getCheckerResult()).toEqual({ total: 8, sampled: 0, failures: 0 })
    expect(c.pin(p('chk', 'out'))).toBe(ONE)
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 8, sampled: 8, failures: 8 })
  })

  describe("'R' soft reset of the circuit under test", () => {
    it('resets a D flip-flop to X without touching time or the recorded waveforms', () => {
      const c = dffUnderChecker(chkOf('11R1', 'XXXX'), 'vcc')
      c.step()
      expect(c.time).toBe(15)
      expect(c.pin(p('ff', 'Q'))).toBe(X) // no clock edge yet
      c.step()
      expect(c.time).toBe(35)
      expect(c.pin(p('ff', 'Q'))).toBe(ONE) // edge at 20 loaded D=1
      c.step() // slot 2 (t=40..60) is the R slot
      expect(c.time).toBe(55)
      expect(c.pin(p('ff', 'Q'))).toBe(X)
      expect(c.pin(p('ff', "Q'"))).toBe(X)
      // history is kept: Q's earlier samples and the clock waveform are intact
      expect(pairs(trace(c, 'pq'))).toEqual(expect.arrayContaining([[21, ONE]]))
      expect(pairs(trace(c, 'pc'))).toEqual(expectedClock(ONE, 10, 50))
      c.step()
      expect(c.time).toBe(75)
      expect(c.pin(p('ff', 'Q'))).toBe(ONE) // edge at 60 reloads D=1
    })

    it('resets a JK flip-flop to X (visible on Q one part delay after the drive time) and it is set again by the next falling edge', () => {
      // Rising-edge clock: 1 on [0,10), 0 on [10,20) -> falling edges at 10, 30, 50, 70. J=1, K=0 sets Q.
      const c = checkerBuilder(chkOf('11R1', 'XXXX'))
        .switch('s', ONE)
        .switch('r', ONE)
        .add('vcc', ComponentType.VCC)
        .add('gnd', ComponentType.GROUND)
        .add('ff', ComponentType.JK_FLIPFLOP)
        .probe('pq')
        .wire(p('s', 'out'), p('ff', 'S'))
        .wire(p('r', 'out'), p('ff', 'R'))
        .wire(p('vcc', 'out'), p('ff', 'J'))
        .wire(p('gnd', 'out'), p('ff', 'K'))
        .wire(p('clk', 'out'), p('ff', 'CLK'))
        .wire(p('ff', 'Q'), p('pq', 'in'))
        .build()
      c.step()
      expect(c.time).toBe(15)
      expect(c.pin(p('ff', 'Q'))).toBe(ONE) // falling edge at 10 set it
      c.step()
      c.step() // R slot: drive/soft reset at 45, falling edge at 50 sets it again
      expect(c.time).toBe(55)
      expect(c.pin(p('ff', 'Q'))).toBe(ONE)
      // The soft reset at 45 reaches Q through the flip-flop's own 1 ns delay.
      expect(pairs(trace(c, 'pq'))).toEqual([
        [0, X],
        [11, ONE],
        [46, X],
        [51, ONE]
      ])
    })

    it('resets an N-bit register to all X', () => {
      const c = checkerBuilder(chkOf('11R1', 'XXXX'))
        .add('reg', ComponentType.N_REGISTER, { bits: 2 })
        .add('vcc', ComponentType.VCC)
        .add('gnd', ComponentType.GROUND)
        .connect(p('vcc', 'out'), p('reg', 'D0'), p('reg', 'D1'), p('reg', 'Ld'))
        .wire(p('gnd', 'out'), p('reg', 'CLR'))
        .wire(p('clk', 'out'), p('reg', 'CLK'))
        .build()
      c.step()
      c.step()
      expect(c.time).toBe(35)
      expect(c.vec('reg', 'Q', 2)).toBe('11')
      c.step()
      expect(c.time).toBe(55)
      expect(c.vec('reg', 'Q', 2)).toBe('XX')
      c.step()
      expect(c.vec('reg', 'Q', 2)).toBe('11')
    })

    it('resets a state machine to its initial state', () => {
      const c = checkerBuilder(chkOf('11R1', 'XXXX'))
        .add('sm', ComponentType.STATE_MACHINE, {
          smInputs: 1,
          smOutputs: 1,
          smTable: [
            { present: '0', input: '-', output: '0', next: '1' },
            { present: '1', input: '-', output: '0', next: '2' },
            { present: '2', input: '-', output: '0', next: '0' }
          ]
        })
        .wire(p('clk', 'out'), p('sm', 'CLK'))
        .build()
      const state = (): string | undefined => c.sim.getSmDisplays()[p('sm', 'state')]
      expect(state()).toBe('0')
      c.step()
      expect(state()).toBe('0')
      c.step()
      expect(c.time).toBe(35)
      expect(state()).toBe('1')
      c.step() // R slot
      expect(c.time).toBe(55)
      expect(state()).toBe('0')
      c.step()
      expect(state()).toBe('1')
    })
  })

  it('a D flip-flop between out and in delays the checker stream by exactly one slot: expected = X + input shifted', () => {
    // Slot k's value is driven at k*P + quarter, the edge at (k+1)*P loads it into Q, and the
    // checker samples Q at (k+2)*P - quarter, i.e. during slot k+1.
    const input = '10110010'
    const pass = dffUnderChecker(chkOf(input, 'X' + input.slice(0, -1)), 'chk')
    pass.go()
    expect(pass.sim.getCheckerResult()).toEqual({ total: 7, sampled: 7, failures: 0 })
    expect(display(pass)).toBe('PASS')

    // The unshifted sequence fails wherever consecutive inputs differ.
    const fail = dffUnderChecker(chkOf(input, 'X' + input.slice(1)), 'chk')
    fail.go()
    let differing = 0
    for (let k = 1; k < input.length; k++) if (input[k] !== input[k - 1]) differing++
    expect(fail.sim.getCheckerResult()).toEqual({ total: 7, sampled: 7, failures: differing })
    expect(display(fail)).toBe('FAIL')
  })

  it("a two-flip-flop chain delays the checker stream by two slots ('XX' + input shifted by two)", () => {
    const input = '1011001'
    const c = checkerBuilder(chkOf(input, 'XX' + input.slice(0, -2)))
      .switch('s', ONE)
      .switch('r', ONE)
      .add('f1', ComponentType.D_FLIPFLOP)
      .add('f2', ComponentType.D_FLIPFLOP)
      .connect(p('s', 'out'), p('f1', 'S'), p('f2', 'S'))
      .connect(p('r', 'out'), p('f1', 'R'), p('f2', 'R'))
      .connect(p('clk', 'out'), p('f1', 'CLK'), p('f2', 'CLK'))
      .wire(p('chk', 'out'), p('f1', 'D'))
      .wire(p('f1', 'Q'), p('f2', 'D'))
      .wire(p('f2', 'Q'), p('chk', 'in'))
      .build()
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 5, sampled: 5, failures: 0 })
    expect(display(c)).toBe('PASS')
  })

  it('a D flip-flop clocked at the slot boundary captures the checker value set up during the previous slot', () => {
    // Step ends a quarter period before the edge so the user can inspect the inputs the
    // edge will capture (Appendix B). At t=15 D shows input[0]; the edge at 20 must load it.
    const chk = chkOf('1011', 'XXXX')
    const c = dffUnderChecker(chk, 'chk')
    c.step()
    expect(c.time).toBe(15)
    expect(c.pin(p('ff', 'D'))).toBe(ONE)
    expect(c.pin(p('ff', 'Q'))).toBe(X)
    c.step()
    expect(c.time).toBe(35)
    expect(c.pin(p('ff', 'Q'))).toBe(ONE) // input[0]
    c.step()
    expect(c.time).toBe(55)
    expect(c.pin(p('ff', 'Q'))).toBe(ZERO) // input[1]
    c.step()
    expect(c.time).toBe(75)
    expect(c.pin(p('ff', 'Q'))).toBe(ONE) // input[2]
  })
})

// ===========================================================================
// .ckt loader and the shipped sample circuits
// ===========================================================================

describe('.ckt loader', () => {
  it('rejects text that is not JSON', () => {
    expect(() => deserializeNetlist('not json')).toThrow(/JSON/)
  })

  it('rejects JSON that is not a SimUaid circuit envelope', () => {
    expect(() => deserializeNetlist('{"format":"other","version":1,"netlist":{}}')).toThrow()
    expect(() => deserializeNetlist('[]')).toThrow()
    expect(() => deserializeNetlist('null')).toThrow()
  })

  it('rejects an unsupported version', () => {
    expect(() =>
      deserializeNetlist('{"format":"simuaid-ckt","version":2,"netlist":{"components":[],"wires":[],"metadata":{}}}')
    ).toThrow(/version/)
  })

  it('rejects a file missing components, wires or metadata', () => {
    expect(() => deserializeNetlist('{"format":"simuaid-ckt","version":1,"netlist":{}}')).toThrow()
    expect(() =>
      deserializeNetlist('{"format":"simuaid-ckt","version":1,"netlist":{"components":[],"wires":[]}}')
    ).toThrow()
  })

  it('round-trips a netlist through serialize/deserialize', () => {
    const netlist = deserializeNetlist(readSample('and-gate.ckt'))
    expect(deserializeNetlist(serializeNetlist(netlist))).toEqual(netlist)
  })

  describe('samples/and-gate.ckt', () => {
    it('loads with the saved simulation options and switch positions', () => {
      const { netlist } = loadCkt('and-gate.ckt')
      expect(netlist.metadata.simulation).toEqual({ simTimeNs: 100, clockPeriodNs: 20, clockInitialValue: ONE })
      expect(netlist.metadata.switchValues).toEqual({ swA: ONE, swB: ONE })
    })

    it('wires resolve into three two-pin nets', () => {
      const { netlist } = loadCkt('and-gate.ckt')
      const nets = resolveNets(netlist)
        .map((n) => [...n.pinIds].sort())
        .sort()
      expect(nets).toEqual([
        ['g#in1', 'swA#out'],
        ['g#in2', 'swB#out'],
        ['g#out', 'p#in']
      ])
    })

    it('the probe shows the AND of the saved switch values (1 AND 1 = 1)', () => {
      const { c } = loadCkt('and-gate.ckt')
      expect(c.pin(p('p', 'in'))).toBe(ONE)
      expect(c.pin(p('g', 'out'))).toBe(ONE)
    })

    it('follows the full AND truth table when the switches are toggled', () => {
      const { c } = loadCkt('and-gate.ckt')
      c.setMany({ swA: ZERO, swB: ZERO })
      expect(c.pin(p('p', 'in'))).toBe(ZERO)
      c.setMany({ swA: ZERO, swB: ONE })
      expect(c.pin(p('p', 'in'))).toBe(ZERO)
      c.setMany({ swA: ONE, swB: ZERO })
      expect(c.pin(p('p', 'in'))).toBe(ZERO)
      c.setMany({ swA: ONE, swB: ONE })
      expect(c.pin(p('p', 'in'))).toBe(ONE)
    })

    it('go() records the AND output on the probe waveform', () => {
      const { c } = loadCkt('and-gate.ckt')
      c.go()
      expect(valueAt(trace(c, 'p'), c.time)).toBe(ONE)
    })
  })

  describe('samples/clock-divider.ckt', () => {
    it('the shipped sample behaves as its name promises: Q toggles at half the clock rate', () => {
      // The file is a clock divider (Q' -> D, S = R = 1). Q starts X (no clear), so it is cleared
      // through swR first; the clear reaches Q at t=2 (switch delay + flip-flop delay).
      const { c } = loadCkt('clock-divider.ckt')
      expect(c.pin(p('ff', 'CLK'))).toBe(ONE) // the clock alone drives CLK
      c.set('swR', ZERO) // clear so Q is a known 0 ...
      c.set('swR', ONE) // ... then release
      expect(c.pin(p('ff', 'Q'))).toBe(ZERO)
      c.go()
      const s = trace(c, 'pq')
      expect(edgesTo(s, ONE)).toEqual([21, 61])
      expect(edgesTo(s, ZERO)).toEqual([2, 41, 81])
    })

    it("a correctly wired Q'->D flip-flop (after an initial clear) halves the clock", () => {
      const c = new CircuitBuilder()
        .add('clk', ComponentType.CLOCK)
        .switch('swS', ONE)
        .switch('swR', ZERO) // start cleared so Q is a known 0
        .add('ff', ComponentType.D_FLIPFLOP)
        .probe('pq')
        .wire(p('clk', 'out'), p('ff', 'CLK'))
        .wire(p('swS', 'out'), p('ff', 'S'))
        .wire(p('swR', 'out'), p('ff', 'R'))
        .wire(p('ff', "Q'"), p('ff', 'D'))
        .wire(p('ff', 'Q'), p('pq', 'in'))
        .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 100 })
        .build()
      expect(c.pin(p('ff', 'Q'))).toBe(ZERO)
      c.set('swR', ONE)
      c.go()
      const s = trace(c, 'pq')
      // Q toggles one delay after every rising edge (20, 40, 60, 80): period 40 = 2 x clock period
      expect(edgesTo(s, ONE)).toEqual([21, 61])
      expect(edgesTo(s, ZERO)).toEqual([41, 81])
      expect(valueAt(s, 30)).toBe(ONE)
      expect(valueAt(s, 50)).toBe(ZERO)
      expect(valueAt(s, 70)).toBe(ONE)
      expect(valueAt(s, 90)).toBe(ZERO)
    })
  })
})
