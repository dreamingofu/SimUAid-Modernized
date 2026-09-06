// Integration: the STATE_MACHINE and the CHECKER as a *system*.
//
// Everything here composes several parts and asserts the behavior the SimUaid
// manual requires of the whole assembly:
//   - the user guide's multiplier control machine (Table 1, lines 738-800) walked
//     through complete multiply sequences by hand and under the CLOCK part, and
//     then wired to a real data path (a counter it clears and enables);
//   - sequence detectors written as a state table vs. the same machine built from
//     D flip-flops and gates, both fed by one INPUT_SIGNAL under one CLOCK;
//   - a Moore machine (identical outputs on every row of a state) contrasted with
//     a Mealy one;
//   - state-table row semantics driven by real X/Z sources (tristates, contention,
//     unconnected pins) and by a table with a syntax error in one row;
//   - reset() and the checker's 'R' soft reset returning a running machine to its
//     initial state;
//   - the checker against flip-flop delay lines, X slots, an 'R' mid-stream and
//     the shipped samples/inverter-test.chk.
//
// Timing follows implementation decision 8: checker slot k occupies [k*P,(k+1)*P),
// its value is driven at k*P + quarter (slot 0 from t=0) and the circuit output is
// sampled at (k+1)*P - quarter. With P = 20 that is drive at 5, 25, 45, ... and
// sample at 15, 35, 55, ...

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  ComponentType,
  LogicValue,
  type Component,
  type SignalRow,
  type SmRow
} from '../../model/types'
import { compileTable } from '../stateMachine'
import { parseChk, type ParsedChk } from '../checker'
import type { WaveformSample } from '../engine'
import { Circuit, CircuitBuilder, p } from './harness'

const { ZERO, ONE, X, Z } = LogicValue

// ---------------------------------------------------------------------------
// Local helpers (the harness has no waveform / state-machine / checker readers).
// ---------------------------------------------------------------------------

const bit = (b: number): LogicValue => (b ? ONE : ZERO)
const sig = (timeNs: number, value: LogicValue): SignalRow => ({ timeNs, value })

function trace(c: Circuit, probeId: string): WaveformSample[] {
  const w = c.sim.getWaveforms().find((t) => t.probeId === probeId)
  if (!w) throw new Error(`no probe ${probeId}`)
  return w.samples
}

function pairs(c: Circuit, probeId: string): [number, LogicValue][] {
  return trace(c, probeId).map((s) => [s.t, s.v])
}

/** Value a probe holds at time t (last recorded sample at or before t). */
function valueAt(c: Circuit, probeId: string, t: number): LogicValue {
  let v: LogicValue = Z
  for (const s of trace(c, probeId)) {
    if (s.t <= t) v = s.v
    else break
  }
  return v
}

/** The state number a state machine displays. */
function smState(c: Circuit, smId: string): string {
  return c.sim.getSmDisplays()[p(smId, 'state')]
}

/** Index (into the raw table) of the active row, or null when none matches. */
function activeRow(c: Circuit, smId: string): number | null {
  return c.sim.getSmActive()[smId]
}

/** out1..outN of a state machine as a string, in pin order. */
function outs(c: Circuit, smId: string, n: number): string {
  let s = ''
  for (let i = 1; i <= n; i++) s += c.pin(p(smId, `out${i}`))
  return s
}

/** The checker's verdict display (READY / n/total / PASS / FAIL). */
function verdict(c: Circuit, chkId = 'chk'): string {
  return c.sim.getSmDisplays()[p(chkId, 'result')]
}

function chkOf(input: string, output: string): { input: string; output: string } {
  return { input, output }
}

const SAMPLES_DIR = new URL('../../../../../samples/', import.meta.url)
const INVERTER_CHK = parseChk(readFileSync(new URL('inverter-test.chk', SAMPLES_DIR), 'utf8')) as ParsedChk

/** Finds a placed component so its raw table can be compiled directly. */
function componentOf(b: CircuitBuilder, id: string): Component {
  const comp = b.netlist.components.find((c) => c.id === id)
  if (!comp) throw new Error(`no component ${id}`)
  return comp
}

// ===========================================================================
// 1. The user guide's multiplier control machine (Table 1)
// ===========================================================================

/**
 * Table 1 of the user guide (control state graph for a multiplier):
 *   S0 St   Load S1      S1 K M' Sh  S3      S2 K'  Sh   S1
 *   S0 St'  0    S0      S1 K'M' Sh  S1      S2 K   Sh   S3
 *                        S1 M    Ad  S2      S3 -   Done S0
 */
const MULTIPLIER_TABLE: SmRow[] = [
  { present: '0', input: 'St', output: 'Load', next: '1' },
  { present: '0', input: "St'", output: '0', next: '0' },
  { present: '1', input: "K M'", output: 'Sh', next: '3' },
  { present: '1', input: "K'M'", output: 'Sh', next: '1' },
  { present: '1', input: 'M', output: 'Ad', next: '2' },
  { present: '2', input: "K'", output: 'Sh', next: '1' },
  { present: '2', input: 'K', output: 'Sh', next: '3' },
  { present: '3', input: '-', output: 'Done', next: '0' }
]

/** Labels of Figure 14: inputs St, K, M and outputs Load, Sh, Ad, Done. */
const MULTIPLIER_SM = {
  smInputs: 3,
  smOutputs: 4,
  pinLabels: { in1: 'St', in2: 'K', in3: 'M', out1: 'Load', out2: 'Sh', out3: 'Ad', out4: 'Done' },
  smTable: MULTIPLIER_TABLE
}

/** The machine with switches on St/K/M and a switch used as the manual clock. */
function switchMultiplier(): Circuit {
  return new CircuitBuilder()
    .switch('St', ZERO)
    .switch('K', ZERO)
    .switch('M', ZERO)
    .switch('clk', ZERO)
    .add('sm', ComponentType.STATE_MACHINE, MULTIPLIER_SM)
    .probe('pLoad')
    .probe('pSh')
    .probe('pAd')
    .probe('pDone')
    .wire(p('St', 'out'), p('sm', 'in1'))
    .wire(p('K', 'out'), p('sm', 'in2'))
    .wire(p('M', 'out'), p('sm', 'in3'))
    .wire(p('clk', 'out'), p('sm', 'CLK'))
    .wire(p('sm', 'out1'), p('pLoad', 'in'))
    .wire(p('sm', 'out2'), p('pSh', 'in'))
    .wire(p('sm', 'out3'), p('pAd', 'in'))
    .wire(p('sm', 'out4'), p('pDone', 'in'))
    .build()
}

/** What the probes on Load, Sh, Ad and Done read, in that order. */
function probedOuts(c: Circuit): string {
  return (
    c.pin(p('pLoad', 'in')) + c.pin(p('pSh', 'in')) + c.pin(p('pAd', 'in')) + c.pin(p('pDone', 'in'))
  )
}

interface MulStep {
  /** Input switch positions held while the clock rises. */
  st: number
  k: number
  m: number
  /** State displayed before the edge, and the row those inputs make active. */
  state: number
  row: number
  /** Load Sh Ad Done before the edge. */
  out: string
  /** State displayed after the rising edge. */
  next: number
}

function walkTo(steps: MulStep[], upto: number): Circuit {
  const c = switchMultiplier()
  for (let i = 0; i < upto; i++) {
    const s = steps[i]
    c.setMany({ St: bit(s.st), K: bit(s.k), M: bit(s.m) })
    c.pulse('clk')
  }
  return c
}

/** Multiplier bits 1,1: Load, Ad, Sh, Ad, Sh, Done, idle. */
const MUL_SEQUENCE_11: MulStep[] = [
  { st: 1, k: 0, m: 0, state: 0, row: 0, out: '1000', next: 1 },
  { st: 0, k: 0, m: 1, state: 1, row: 4, out: '0010', next: 2 },
  { st: 0, k: 0, m: 1, state: 2, row: 5, out: '0100', next: 1 },
  { st: 0, k: 0, m: 1, state: 1, row: 4, out: '0010', next: 2 },
  { st: 0, k: 1, m: 1, state: 2, row: 6, out: '0100', next: 3 },
  { st: 0, k: 1, m: 1, state: 3, row: 7, out: '0001', next: 0 },
  { st: 0, k: 0, m: 0, state: 0, row: 1, out: '0000', next: 0 }
]

/** Multiplier bits 0 then 1: Load, Sh, Ad, Sh, Done. */
const MUL_SEQUENCE_10: MulStep[] = [
  { st: 1, k: 0, m: 0, state: 0, row: 0, out: '1000', next: 1 },
  { st: 0, k: 0, m: 0, state: 1, row: 3, out: '0100', next: 1 },
  { st: 0, k: 0, m: 1, state: 1, row: 4, out: '0010', next: 2 },
  { st: 0, k: 1, m: 1, state: 2, row: 6, out: '0100', next: 3 },
  { st: 0, k: 1, m: 0, state: 3, row: 7, out: '0001', next: 0 }
]

/** Multiplier bits 0,0: shift only, then Done and an immediate restart. */
const MUL_SEQUENCE_00: MulStep[] = [
  { st: 1, k: 0, m: 0, state: 0, row: 0, out: '1000', next: 1 },
  { st: 0, k: 0, m: 0, state: 1, row: 3, out: '0100', next: 1 },
  { st: 0, k: 1, m: 0, state: 1, row: 2, out: '0100', next: 3 },
  { st: 0, k: 1, m: 0, state: 3, row: 7, out: '0001', next: 0 },
  { st: 1, k: 0, m: 0, state: 0, row: 0, out: '1000', next: 1 }
]

describe('multiplier control machine (user guide Table 1): table', () => {
  it('compiles with no syntax errors and keeps all eight rows in order', () => {
    const b = new CircuitBuilder().add('sm', ComponentType.STATE_MACHINE, MULTIPLIER_SM)
    const { rows, errors } = compileTable(componentOf(b, 'sm'))
    expect(errors).toEqual([])
    expect(rows.map((r) => [r.index, r.present, r.next])).toEqual([
      [0, 0, 1],
      [1, 0, 0],
      [2, 1, 3],
      [3, 1, 1],
      [4, 1, 2],
      [5, 2, 1],
      [6, 2, 3],
      [7, 3, 0]
    ])
  })

  it('starts in S0 (the first row’s present state) with every output 0 while St = 0', () => {
    const c = switchMultiplier()
    expect(smState(c, 'sm')).toBe('0')
    expect(activeRow(c, 'sm')).toBe(1)
    expect(outs(c, 'sm', 4)).toBe('0000')
    expect(probedOuts(c)).toBe('0000')
    expect(c.time).toBe(0)
  })
})

describe.each([
  ['multiplier bits 1,1', MUL_SEQUENCE_11],
  ['multiplier bits 0,1', MUL_SEQUENCE_10],
  ['multiplier bits 0,0 (shift only)', MUL_SEQUENCE_00]
])('multiplier control machine walked with a manual clock: %s', (_name, steps) => {
  steps.forEach((s, i) => {
    it(`step ${i}: S${s.state} with St=${s.st} K=${s.k} M=${s.m} activates row ${s.row}, outputs ${s.out}, and clocks to S${s.next}`, () => {
      const c = walkTo(steps, i)
      c.setMany({ St: bit(s.st), K: bit(s.k), M: bit(s.m) })

      expect(smState(c, 'sm')).toBe(String(s.state))
      expect(activeRow(c, 'sm')).toBe(s.row)
      expect(outs(c, 'sm', 4)).toBe(s.out)
      expect(probedOuts(c)).toBe(s.out)

      c.rise('clk')
      expect(smState(c, 'sm')).toBe(String(s.next))
      c.fall('clk')
      expect(smState(c, 'sm')).toBe(String(s.next))
    })
  })

  it('the whole sequence ends in the documented final state', () => {
    const c = walkTo(steps, steps.length)
    expect(smState(c, 'sm')).toBe(String(steps[steps.length - 1].next))
  })

  it('holding the clock high while the inputs change never advances the state', () => {
    const c = walkTo(steps, steps.length - 1)
    const s = steps[steps.length - 1]
    c.setMany({ St: bit(s.st), K: bit(s.k), M: bit(s.m) })
    c.rise('clk')
    const after = smState(c, 'sm')
    c.setMany({ St: ONE, K: ONE, M: ONE })
    expect(smState(c, 'sm')).toBe(after)
    c.setMany({ St: ZERO, K: ZERO, M: ZERO })
    expect(smState(c, 'sm')).toBe(after)
  })
})

// ---------------------------------------------------------------------------
// 1b. The same machine under the CLOCK part, with the inputs on INPUT_SIGNALs.
// ---------------------------------------------------------------------------

/**
 * Period 20, rising-edge clock: edges at 20, 40, 60, ... St drops after the first
 * edge, M drops during S2 and K rises during the second visit to S1, so the
 * machine walks S0 -> S1 -> S2 -> S1 -> S3 -> S0.
 */
function clockedMultiplier(): Circuit {
  return new CircuitBuilder()
    .add('clk', ComponentType.CLOCK)
    .add('stSig', ComponentType.INPUT_SIGNAL, { signal: [sig(0, ONE), sig(25, ZERO)] })
    .add('kSig', ComponentType.INPUT_SIGNAL, { signal: [sig(0, ZERO), sig(65, ONE)] })
    .add('mSig', ComponentType.INPUT_SIGNAL, { signal: [sig(0, ONE), sig(45, ZERO)] })
    .add('sm', ComponentType.STATE_MACHINE, MULTIPLIER_SM)
    .probe('pLoad')
    .probe('pSh')
    .probe('pAd')
    .probe('pDone')
    .wire(p('clk', 'out'), p('sm', 'CLK'))
    .wire(p('stSig', 'out'), p('sm', 'in1'))
    .wire(p('kSig', 'out'), p('sm', 'in2'))
    .wire(p('mSig', 'out'), p('sm', 'in3'))
    .wire(p('sm', 'out1'), p('pLoad', 'in'))
    .wire(p('sm', 'out2'), p('pSh', 'in'))
    .wire(p('sm', 'out3'), p('pAd', 'in'))
    .wire(p('sm', 'out4'), p('pDone', 'in'))
    .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 200 })
    .build()
}

function steppedMultiplier(n: number): Circuit {
  const c = clockedMultiplier()
  for (let i = 0; i < n; i++) c.step()
  return c
}

describe('multiplier control machine under the CLOCK part', () => {
  const expected = [
    { step: 1, time: 15, state: '0', row: 0, out: '1000' },
    { step: 2, time: 35, state: '1', row: 4, out: '0010' },
    { step: 3, time: 55, state: '2', row: 5, out: '0100' },
    { step: 4, time: 75, state: '1', row: 2, out: '0100' },
    { step: 5, time: 95, state: '3', row: 7, out: '0001' },
    { step: 6, time: 115, state: '0', row: 1, out: '0000' },
    { step: 7, time: 135, state: '0', row: 1, out: '0000' }
  ]

  expected.forEach((e) => {
    it(`step ${e.step} ends at ${e.time} ns in S${e.state} on row ${e.row} with outputs ${e.out}`, () => {
      const c = steppedMultiplier(e.step)
      expect(c.time).toBe(e.time)
      expect(smState(c, 'sm')).toBe(e.state)
      expect(activeRow(c, 'sm')).toBe(e.row)
      expect(outs(c, 'sm', 4)).toBe(e.out)
    })
  })

  it('Load is high only while S0 sees St = 1 (one part delay after the edge at 20)', () => {
    expect(pairs(steppedMultiplier(7), 'pLoad')).toEqual([
      [0, ONE],
      [21, ZERO]
    ])
  })

  it('Ad is high during the first visit to S1 and drops when S2 is entered', () => {
    expect(pairs(steppedMultiplier(7), 'pAd')).toEqual([
      [0, ZERO],
      [21, ONE],
      [41, ZERO]
    ])
  })

  it('Sh stays high across S2 -> S1 (both rows drive Sh) and drops when S3 is entered', () => {
    expect(pairs(steppedMultiplier(7), 'pSh')).toEqual([
      [0, ZERO],
      [41, ONE],
      [81, ZERO]
    ])
  })

  it('Done is high for exactly the one clock period the machine spends in S3', () => {
    expect(pairs(steppedMultiplier(7), 'pDone')).toEqual([
      [0, ZERO],
      [81, ONE],
      [101, ZERO]
    ])
  })

  it('K rising at 65 ns re-selects row 2 in S1 without changing any output', () => {
    const c = steppedMultiplier(4)
    // At 55 ns (S1 entered at the edge at 60? no: S1 is entered at 60) - check the
    // row before and after K rises inside the S1 slot [60, 80).
    expect(valueAt(c, 'pSh', 64)).toBe(ONE)
    expect(valueAt(c, 'pSh', 70)).toBe(ONE)
    expect(activeRow(c, 'sm')).toBe(2)
  })

  it('never oscillates and ends the run back in S0', () => {
    const c = steppedMultiplier(7)
    expect(c.oscillated).toBe(false)
    expect(smState(c, 'sm')).toBe('0')
  })

  it('go() covers the same sequence and stops a quarter period before the edge at 200', () => {
    const c = clockedMultiplier()
    c.go()
    expect(c.time).toBe(195)
    expect(smState(c, 'sm')).toBe('0')
    expect(pairs(c, 'pDone')).toEqual([
      [0, ZERO],
      [81, ONE],
      [101, ZERO]
    ])
  })
})

// ===========================================================================
// 2. The control machine wired to a real data path
// ===========================================================================

/**
 * The control machine drives a 2-bit counter that counts the shift/add steps:
 *   Load -> NOT -> CLR (the counter's CLR is active low, so Load = 1 clears it)
 *   Sh + Ad -> OR -> En (the counter advances on every shift or add step)
 *   counter K (all bits 1) -> the machine's K input (the "count done" flag)
 * Everything shares one manual clock. Because the machine's outputs only change a
 * delay after the edge, the counter always acts on the outputs of the state it
 * was in *before* the edge, exactly like real Mealy control logic.
 */
function multiplierDataPath(): Circuit {
  return new CircuitBuilder()
    .switch('St', ONE)
    .switch('M', ONE)
    .switch('clk', ZERO)
    .add('sm', ComponentType.STATE_MACHINE, MULTIPLIER_SM)
    .add('inv', ComponentType.NOT)
    .add('or', ComponentType.OR2)
    .add('ctr', ComponentType.N_COUNTER, { bits: 2 })
    .wire(p('St', 'out'), p('sm', 'in1'))
    .wire(p('M', 'out'), p('sm', 'in3'))
    .wire(p('clk', 'out'), p('sm', 'CLK'))
    .wire(p('clk', 'out'), p('ctr', 'CLK'))
    .wire(p('sm', 'out1'), p('inv', 'in1'))
    .wire(p('inv', 'out'), p('ctr', 'CLR'))
    .wire(p('sm', 'out2'), p('or', 'in1'))
    .wire(p('sm', 'out3'), p('or', 'in2'))
    .wire(p('or', 'out'), p('ctr', 'En'))
    .wire(p('ctr', 'K'), p('sm', 'in2'))
    .build()
}

interface PathStep {
  /** State, row, outputs and counter contents after `edges` rising edges. */
  edges: number
  state: string
  row: number
  out: string
  count: string
  k: LogicValue
}

const DATA_PATH_STEPS: PathStep[] = [
  // Before any clock: the counter is undefined, but S0 only looks at St.
  { edges: 0, state: '0', row: 0, out: '1000', count: 'XX', k: X },
  { edges: 1, state: '1', row: 4, out: '0010', count: '00', k: ZERO },
  { edges: 2, state: '2', row: 5, out: '0100', count: '01', k: ZERO },
  { edges: 3, state: '1', row: 4, out: '0010', count: '10', k: ZERO },
  // The counter reaches 11 at the same edge that enters S2, so K arrives one
  // delay later and re-selects row 6 without changing Sh.
  { edges: 4, state: '2', row: 6, out: '0100', count: '11', k: ONE },
  { edges: 5, state: '3', row: 7, out: '0001', count: '00', k: ZERO },
  // Done leaves En = 0, so the counter holds while the machine returns to S0.
  { edges: 6, state: '0', row: 0, out: '1000', count: '00', k: ZERO },
  { edges: 7, state: '1', row: 4, out: '0010', count: '00', k: ZERO }
]

describe('multiplier control machine driving a 2-bit counter data path', () => {
  DATA_PATH_STEPS.forEach((s) => {
    it(`after ${s.edges} clock(s): S${s.state} row ${s.row} outputs ${s.out}, counter ${s.count} (K = ${s.k})`, () => {
      const c = multiplierDataPath()
      for (let i = 0; i < s.edges; i++) c.pulse('clk')
      expect(smState(c, 'sm')).toBe(s.state)
      expect(activeRow(c, 'sm')).toBe(s.row)
      expect(outs(c, 'sm', 4)).toBe(s.out)
      expect(c.vec('ctr', 'Q', 2)).toBe(s.count)
      expect(c.pin(p('ctr', 'K'))).toBe(s.k)
    })
  })

  it('the Load pulse clears the counter through the inverter (CLR is active low)', () => {
    const c = multiplierDataPath()
    expect(c.pin(p('sm', 'out1'))).toBe(ONE)
    expect(c.pin(p('ctr', 'CLR'))).toBe(ZERO)
    c.pulse('clk')
    expect(c.vec('ctr', 'Q', 2)).toBe('00')
    expect(c.pin(p('ctr', 'CLR'))).toBe(ONE) // Load dropped when S1 was entered
  })

  it('En is the OR of Sh and Ad and is 0 only in S0 and S3', () => {
    const c = multiplierDataPath()
    const en = (): LogicValue => c.pin(p('ctr', 'En'))
    expect(en()).toBe(ZERO) // S0: Load
    c.pulse('clk')
    expect(en()).toBe(ONE) // S1: Ad
    c.pulse('clk')
    expect(en()).toBe(ONE) // S2: Sh
    c.pulse('clk')
    c.pulse('clk')
    c.pulse('clk')
    expect(smState(c, 'sm')).toBe('3')
    expect(en()).toBe(ZERO) // S3: Done
  })

  it('with St = 0 the machine parks in S0 and the counter stays cleared', () => {
    const c = multiplierDataPath()
    c.set('St', ZERO)
    for (let i = 0; i < 6; i++) {
      c.pulse('clk')
      expect(smState(c, 'sm')).toBe('0')
      expect(outs(c, 'sm', 4)).toBe('0000')
    }
    // CLR is high (Load = 0) and En is low, so the counter simply holds.
    expect(c.pin(p('ctr', 'CLR'))).toBe(ONE)
    expect(c.pin(p('ctr', 'En'))).toBe(ZERO)
  })

  it('a second multiply after Done repeats the whole cycle', () => {
    const c = multiplierDataPath()
    for (let i = 0; i < 6; i++) c.pulse('clk') // back in S0 with St still 1
    expect(smState(c, 'sm')).toBe('0')
    const seen: string[] = []
    for (let i = 0; i < 5; i++) {
      c.pulse('clk')
      seen.push(smState(c, 'sm'))
    }
    expect(seen).toEqual(['1', '2', '1', '2', '3'])
  })

  it('M = 0 makes every step a shift, so the counter still reaches 11 and ends the multiply', () => {
    const c = multiplierDataPath()
    c.set('M', ZERO)
    const states: string[] = []
    const counts: string[] = []
    for (let i = 0; i < 5; i++) {
      c.pulse('clk')
      states.push(smState(c, 'sm'))
      counts.push(c.vec('ctr', 'Q', 2))
    }
    // S1 self-loops on K'M' while the counter counts 00, 01, 10, 11; K then takes
    // row 2 (K M') straight to S3.
    expect(states).toEqual(['1', '1', '1', '1', '3'])
    expect(counts).toEqual(['00', '01', '10', '11', '00'])
    expect(outs(c, 'sm', 4)).toBe('0001')
  })
})

// ---------------------------------------------------------------------------
// 2b. The same data path under the CLOCK part, with probed waveforms.
// ---------------------------------------------------------------------------

/** St from an INPUT_SIGNAL (one slot long), M tied high, K from the counter. */
function clockedDataPath(): Circuit {
  return new CircuitBuilder()
    .add('clk', ComponentType.CLOCK)
    .add('stSig', ComponentType.INPUT_SIGNAL, { signal: [sig(0, ONE), sig(25, ZERO)] })
    .add('vcc', ComponentType.VCC)
    .add('sm', ComponentType.STATE_MACHINE, MULTIPLIER_SM)
    .add('inv', ComponentType.NOT)
    .add('or', ComponentType.OR2)
    .add('ctr', ComponentType.N_COUNTER, { bits: 2 })
    .probe('pDone')
    .probe('pQ0')
    .probe('pQ1')
    .probe('pK')
    .wire(p('clk', 'out'), p('sm', 'CLK'))
    .wire(p('clk', 'out'), p('ctr', 'CLK'))
    .wire(p('stSig', 'out'), p('sm', 'in1'))
    .wire(p('vcc', 'out'), p('sm', 'in3'))
    .wire(p('sm', 'out1'), p('inv', 'in1'))
    .wire(p('inv', 'out'), p('ctr', 'CLR'))
    .wire(p('sm', 'out2'), p('or', 'in1'))
    .wire(p('sm', 'out3'), p('or', 'in2'))
    .wire(p('or', 'out'), p('ctr', 'En'))
    .wire(p('ctr', 'K'), p('sm', 'in2'))
    .wire(p('sm', 'out4'), p('pDone', 'in'))
    .wire(p('ctr', 'Q0'), p('pQ0', 'in'))
    .wire(p('ctr', 'Q1'), p('pQ1', 'in'))
    .wire(p('ctr', 'K'), p('pK', 'in'))
    .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 160 })
    .build()
}

describe('multiplier control + counter data path under the CLOCK part', () => {
  const stateAtStep = ['0', '1', '2', '1', '2', '3', '0', '0']

  stateAtStep.forEach((state, i) => {
    it(`step ${i + 1} (t = ${20 * i + 15} ns) leaves the machine in S${state}`, () => {
      const c = clockedDataPath()
      for (let k = 0; k <= i; k++) c.step()
      expect(c.time).toBe(20 * i + 15)
      expect(smState(c, 'sm')).toBe(state)
    })
  })

  it('Done is high for exactly one clock period, starting one delay after the edge at 100', () => {
    const c = clockedDataPath()
    c.go()
    expect(pairs(c, 'pDone')).toEqual([
      [0, ZERO],
      [101, ONE],
      [121, ZERO]
    ])
  })

  it('the counter starts undefined, is cleared by Load and then counts 00, 01, 10, 11, 00', () => {
    const c = clockedDataPath()
    c.go()
    expect(pairs(c, 'pQ0')).toEqual([
      [0, X],
      [21, ZERO],
      [41, ONE],
      [61, ZERO],
      [81, ONE],
      [101, ZERO]
    ])
    expect(pairs(c, 'pQ1')).toEqual([
      [0, X],
      [21, ZERO],
      [61, ONE],
      [101, ZERO]
    ])
  })

  it('the counter’s K flag is high for exactly the period the count is 11', () => {
    const c = clockedDataPath()
    c.go()
    expect(pairs(c, 'pK')).toEqual([
      [0, X],
      [21, ZERO],
      [81, ONE],
      [101, ZERO]
    ])
  })

  it('the counter stops when Done drops En, so it holds 00 for the rest of the run', () => {
    const c = clockedDataPath()
    c.go()
    expect(c.time).toBe(155)
    expect(c.vec('ctr', 'Q', 2)).toBe('00')
    expect(c.pin(p('ctr', 'En'))).toBe(ZERO)
    expect(smState(c, 'sm')).toBe('0')
  })
})

// ---------------------------------------------------------------------------
// 2c. The whole control system under a checker.
// ---------------------------------------------------------------------------

/** The checker drives St and watches Done: a complete "multiply" test bench. */
function checkedDataPath(chk: { input: string; output: string }): Circuit {
  return new CircuitBuilder()
    .add('clk', ComponentType.CLOCK)
    .add('chk', ComponentType.CHECKER, { chk })
    .add('vcc', ComponentType.VCC)
    .add('sm', ComponentType.STATE_MACHINE, MULTIPLIER_SM)
    .add('inv', ComponentType.NOT)
    .add('or', ComponentType.OR2)
    .add('ctr', ComponentType.N_COUNTER, { bits: 2 })
    .wire(p('clk', 'out'), p('sm', 'CLK'))
    .wire(p('clk', 'out'), p('ctr', 'CLK'))
    .wire(p('chk', 'out'), p('sm', 'in1'))
    .wire(p('vcc', 'out'), p('sm', 'in3'))
    .wire(p('sm', 'out1'), p('inv', 'in1'))
    .wire(p('inv', 'out'), p('ctr', 'CLR'))
    .wire(p('sm', 'out2'), p('or', 'in1'))
    .wire(p('sm', 'out3'), p('or', 'in2'))
    .wire(p('or', 'out'), p('ctr', 'En'))
    .wire(p('ctr', 'K'), p('sm', 'in2'))
    .wire(p('sm', 'out4'), p('chk', 'in'))
    .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 400 })
    .build()
}

describe('the whole control system tested by a checker (St in, Done out)', () => {
  it('a single start pulse produces Done exactly five clock periods later', () => {
    const c = checkedDataPath(chkOf('1000000000', '0000010000'))
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 10, sampled: 10, failures: 0 })
    expect(verdict(c)).toBe('PASS')
  })

  it('expecting Done one slot early fails in exactly two slots', () => {
    const c = checkedDataPath(chkOf('1000000000', '0000100000'))
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 10, sampled: 10, failures: 2 })
    expect(verdict(c)).toBe('FAIL')
  })

  it('holding St high restarts the multiply immediately, so Done repeats every six periods', () => {
    const c = checkedDataPath(chkOf('11111111111111', '00000100000100'))
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 14, sampled: 14, failures: 0 })
    expect(verdict(c)).toBe('PASS')
  })

  it('the same run fails if Done is expected every five periods instead of six', () => {
    const c = checkedDataPath(chkOf('11111111111111', '00000100001000'))
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 14, sampled: 14, failures: 2 })
    expect(verdict(c)).toBe('FAIL')
  })

  it('never starting (St = 0 throughout) keeps Done low in every slot', () => {
    const c = checkedDataPath(chkOf('0000000000', '0000000000'))
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 10, sampled: 10, failures: 0 })
    expect(verdict(c)).toBe('PASS')
  })
})

// ===========================================================================
// 3. Sequence detectors: state table vs. flip-flops and gates
// ===========================================================================

/** '101' Mealy detector, overlapping: S2 + A returns to S1, not S0. */
const DETECT_101: SmRow[] = [
  { present: '0', input: 'A', output: '0', next: '1' },
  { present: '0', input: "A'", output: '0', next: '0' },
  { present: '1', input: "A'", output: '0', next: '2' },
  { present: '1', input: 'A', output: '0', next: '1' },
  { present: '2', input: 'A', output: 'Det', next: '1' },
  { present: '2', input: "A'", output: '0', next: '0' }
]

/** Reference Mealy simulation of the '101' detector over a bit stream. */
function model101(bits: number[]): { outputs: number[]; states: number[] } {
  const outputs: number[] = []
  const states: number[] = []
  let s = 0
  for (const b of bits) {
    states.push(s)
    if (s === 0) {
      outputs.push(0)
      s = b ? 1 : 0
    } else if (s === 1) {
      outputs.push(0)
      s = b ? 1 : 2
    } else {
      outputs.push(b ? 1 : 0)
      s = b ? 1 : 0
    }
  }
  return { outputs, states }
}

const BITS_101 = [1, 0, 1, 0, 1, 1, 0, 1, 0, 1]

/**
 * One INPUT_SIGNAL feeds both a STATE_MACHINE running DETECT_101 and the same
 * machine built from two D flip-flops (state 0 = 00, 1 = 01, 2 = 10) with
 * D0 = A, D1 = Q0 A', Det = Q1 A. A second INPUT_SIGNAL clears the flip-flops at
 * t = 0 so both start in state 0.
 */
function detector101(bits: number[]): Circuit {
  const rows = [sig(0, bit(bits[0]))]
  for (let k = 1; k < bits.length; k++) rows.push(sig(20 * k + 5, bit(bits[k])))

  return new CircuitBuilder()
    .add('clk', ComponentType.CLOCK)
    .add('a', ComponentType.INPUT_SIGNAL, { signal: rows })
    .add('rst', ComponentType.INPUT_SIGNAL, { signal: [sig(0, ZERO), sig(1, ONE)] })
    .add('vcc', ComponentType.VCC)
    .add('sm', ComponentType.STATE_MACHINE, {
      smInputs: 1,
      smOutputs: 1,
      pinLabels: { in1: 'A', out1: 'Det' },
      smTable: DETECT_101
    })
    .add('ff0', ComponentType.D_FLIPFLOP)
    .add('ff1', ComponentType.D_FLIPFLOP)
    .add('nota', ComponentType.NOT)
    .add('d1', ComponentType.AND2)
    .add('det', ComponentType.AND2)
    .probe('smDet')
    .probe('ffDet')
    .wire(p('clk', 'out'), p('sm', 'CLK'))
    .wire(p('clk', 'out'), p('ff0', 'CLK'))
    .wire(p('clk', 'out'), p('ff1', 'CLK'))
    .wire(p('a', 'out'), p('sm', 'in1'))
    .wire(p('a', 'out'), p('ff0', 'D'))
    .wire(p('a', 'out'), p('nota', 'in1'))
    .wire(p('a', 'out'), p('det', 'in2'))
    .wire(p('vcc', 'out'), p('ff0', 'S'))
    .wire(p('vcc', 'out'), p('ff1', 'S'))
    .wire(p('rst', 'out'), p('ff0', 'R'))
    .wire(p('rst', 'out'), p('ff1', 'R'))
    .wire(p('ff0', 'Q'), p('d1', 'in1'))
    .wire(p('nota', 'out'), p('d1', 'in2'))
    .wire(p('d1', 'out'), p('ff1', 'D'))
    .wire(p('ff1', 'Q'), p('det', 'in1'))
    .wire(p('sm', 'out1'), p('smDet', 'in'))
    .wire(p('det', 'out'), p('ffDet', 'in'))
    .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 400 })
    .build()
}

/** Flip-flop state (Q1, Q0) decoded back to the state-machine's state number. */
function ffState101(c: Circuit): number | null {
  const q1 = c.pin(p('ff1', 'Q'))
  const q0 = c.pin(p('ff0', 'Q'))
  if (q1 === ZERO && q0 === ZERO) return 0
  if (q1 === ZERO && q0 === ONE) return 1
  if (q1 === ONE && q0 === ZERO) return 2
  return null
}

describe("'101' overlapping detector: STATE_MACHINE vs D flip-flops and gates", () => {
  const { outputs, states } = model101(BITS_101)

  BITS_101.forEach((b, k) => {
    it(`slot ${k} (input ${b}): both implementations are in state ${states[k]} with Det = ${outputs[k]}`, () => {
      const c = detector101(BITS_101)
      for (let i = 0; i <= k; i++) c.step()
      expect(c.time).toBe(20 * k + 15)
      expect(smState(c, 'sm')).toBe(String(states[k]))
      expect(ffState101(c)).toBe(states[k])
      expect(c.pin(p('sm', 'out1'))).toBe(bit(outputs[k]))
      expect(c.pin(p('det', 'out'))).toBe(bit(outputs[k]))
    })
  })

  it('both Det waveforms agree at every slot sample point (3/4 into the slot)', () => {
    const c = detector101(BITS_101)
    for (let i = 0; i < BITS_101.length; i++) c.step()
    for (let k = 0; k < BITS_101.length; k++) {
      const t = 20 * k + 15
      expect(valueAt(c, 'smDet', t)).toBe(bit(outputs[k]))
      expect(valueAt(c, 'ffDet', t)).toBe(bit(outputs[k]))
    }
  })

  it('both Det waveforms contain the same number of detections', () => {
    const c = detector101(BITS_101)
    for (let i = 0; i < BITS_101.length; i++) c.step()
    const risesTo1 = (id: string): number =>
      trace(c, id).filter((s, i, all) => s.v === ONE && (i === 0 || all[i - 1].v !== ONE)).length
    expect(risesTo1('smDet')).toBe(outputs.filter((o) => o === 1).length)
    expect(risesTo1('ffDet')).toBe(outputs.filter((o) => o === 1).length)
  })

  it('both Det outputs rise at the same instant when the input causes the detection', () => {
    const c = detector101(BITS_101)
    for (let i = 0; i < BITS_101.length; i++) c.step()
    // A rises at 45 while both implementations are already in state 2: the table
    // output and the AND both settle one delay later.
    expect(valueAt(c, 'smDet', 45)).toBe(ZERO)
    expect(valueAt(c, 'smDet', 46)).toBe(ONE)
    expect(valueAt(c, 'ffDet', 45)).toBe(ZERO)
    expect(valueAt(c, 'ffDet', 46)).toBe(ONE)
  })

  it('the gate-built Det falls one extra gate delay after the clock edge that ends the detection', () => {
    const c = detector101(BITS_101)
    for (let i = 0; i < BITS_101.length; i++) c.step()
    // The edge at 60 leaves state 2: the table drives Det low at 61, while the
    // gate version waits for the flip-flop (61) and then the AND (62).
    expect(valueAt(c, 'smDet', 61)).toBe(ZERO)
    expect(valueAt(c, 'ffDet', 61)).toBe(ONE)
    expect(valueAt(c, 'ffDet', 62)).toBe(ZERO)
  })

  it('an all-zero stream never detects and parks both implementations in state 0', () => {
    const zeros = [0, 0, 0, 0, 0, 0]
    const c = detector101(zeros)
    for (let i = 0; i < zeros.length; i++) c.step()
    expect(smState(c, 'sm')).toBe('0')
    expect(ffState101(c)).toBe(0)
    expect(pairs(c, 'smDet')).toEqual([[0, ZERO]])
    expect(pairs(c, 'ffDet')).toEqual([[0, ZERO]])
  })

  it('an all-one stream parks both implementations in state 1 with no detection', () => {
    const ones = [1, 1, 1, 1, 1, 1]
    const c = detector101(ones)
    for (let i = 0; i < ones.length; i++) c.step()
    expect(smState(c, 'sm')).toBe('1')
    expect(ffState101(c)).toBe(1)
    expect(pairs(c, 'smDet')).toEqual([[0, ZERO]])
    expect(pairs(c, 'ffDet')).toEqual([[0, ZERO]])
  })

  it('back-to-back 10101 detects twice because the detector overlaps', () => {
    const bits = [1, 0, 1, 0, 1]
    const c = detector101(bits)
    for (let i = 0; i < bits.length; i++) c.step()
    expect(model101(bits).outputs).toEqual([0, 0, 1, 0, 1])
    expect(valueAt(c, 'smDet', 55)).toBe(ONE)
    expect(valueAt(c, 'smDet', 95)).toBe(ONE)
    expect(valueAt(c, 'ffDet', 55)).toBe(ONE)
    expect(valueAt(c, 'ffDet', 95)).toBe(ONE)
  })
})

// ---------------------------------------------------------------------------
// 3b. '1101' non-overlapping detector
// ---------------------------------------------------------------------------

/** '1101' Mealy detector, non-overlapping: the detecting row restarts at S0. */
const DETECT_1101: SmRow[] = [
  { present: '0', input: 'A', output: '0', next: '1' },
  { present: '0', input: "A'", output: '0', next: '0' },
  { present: '1', input: 'A', output: '0', next: '2' },
  { present: '1', input: "A'", output: '0', next: '0' },
  { present: '2', input: 'A', output: '0', next: '2' },
  { present: '2', input: "A'", output: '0', next: '3' },
  { present: '3', input: 'A', output: 'Det', next: '0' },
  { present: '3', input: "A'", output: '0', next: '0' }
]

function model1101(bits: number[], overlapping: boolean): { outputs: number[]; states: number[] } {
  const outputs: number[] = []
  const states: number[] = []
  let s = 0
  for (const b of bits) {
    states.push(s)
    if (s === 0) {
      outputs.push(0)
      s = b ? 1 : 0
    } else if (s === 1) {
      outputs.push(0)
      s = b ? 2 : 0
    } else if (s === 2) {
      outputs.push(0)
      s = b ? 2 : 3
    } else {
      outputs.push(b ? 1 : 0)
      s = b ? (overlapping ? 1 : 0) : 0
    }
  }
  return { outputs, states }
}

const BITS_1101 = [1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1]

/**
 * The same '1101' machine as a table and as two D flip-flops with
 * (S0,S1,S2,S3) = (00, 01, 11, 10):
 *   D1 = Q0 (Q1 + A),  D0 = A (Q1' + Q0),  Det = Q1 Q0' A.
 */
function detector1101(bits: number[], table: SmRow[] = DETECT_1101): Circuit {
  const rows = [sig(0, bit(bits[0]))]
  for (let k = 1; k < bits.length; k++) rows.push(sig(20 * k + 5, bit(bits[k])))

  return new CircuitBuilder()
    .add('clk', ComponentType.CLOCK)
    .add('a', ComponentType.INPUT_SIGNAL, { signal: rows })
    .add('rst', ComponentType.INPUT_SIGNAL, { signal: [sig(0, ZERO), sig(1, ONE)] })
    .add('vcc', ComponentType.VCC)
    .add('sm', ComponentType.STATE_MACHINE, {
      smInputs: 1,
      smOutputs: 1,
      pinLabels: { in1: 'A', out1: 'Det' },
      smTable: table
    })
    .add('ff0', ComponentType.D_FLIPFLOP)
    .add('ff1', ComponentType.D_FLIPFLOP)
    .add('or1', ComponentType.OR2) // Q1 + A
    .add('and1', ComponentType.AND2) // Q0 (Q1 + A)
    .add('or0', ComponentType.OR2) // Q1' + Q0
    .add('and0', ComponentType.AND2) // A (Q1' + Q0)
    .add('det', ComponentType.AND3) // Q1 Q0' A
    .probe('smDet')
    .probe('ffDet')
    .wire(p('clk', 'out'), p('sm', 'CLK'))
    .wire(p('clk', 'out'), p('ff0', 'CLK'))
    .wire(p('clk', 'out'), p('ff1', 'CLK'))
    .wire(p('vcc', 'out'), p('ff0', 'S'))
    .wire(p('vcc', 'out'), p('ff1', 'S'))
    .wire(p('rst', 'out'), p('ff0', 'R'))
    .wire(p('rst', 'out'), p('ff1', 'R'))
    .wire(p('a', 'out'), p('sm', 'in1'))
    .wire(p('a', 'out'), p('or1', 'in2'))
    .wire(p('a', 'out'), p('and0', 'in1'))
    .wire(p('a', 'out'), p('det', 'in3'))
    .wire(p('ff1', 'Q'), p('or1', 'in1'))
    .wire(p('ff0', 'Q'), p('and1', 'in1'))
    .wire(p('or1', 'out'), p('and1', 'in2'))
    .wire(p('and1', 'out'), p('ff1', 'D'))
    .wire(p('ff1', "Q'"), p('or0', 'in1'))
    .wire(p('ff0', 'Q'), p('or0', 'in2'))
    .wire(p('or0', 'out'), p('and0', 'in2'))
    .wire(p('and0', 'out'), p('ff0', 'D'))
    .wire(p('ff1', 'Q'), p('det', 'in1'))
    .wire(p('ff0', "Q'"), p('det', 'in2'))
    .wire(p('sm', 'out1'), p('smDet', 'in'))
    .wire(p('det', 'out'), p('ffDet', 'in'))
    .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 400 })
    .build()
}

function ffState1101(c: Circuit): number | null {
  const q1 = c.pin(p('ff1', 'Q'))
  const q0 = c.pin(p('ff0', 'Q'))
  if (q1 === ZERO && q0 === ZERO) return 0
  if (q1 === ZERO && q0 === ONE) return 1
  if (q1 === ONE && q0 === ONE) return 2
  if (q1 === ONE && q0 === ZERO) return 3
  return null
}

describe("'1101' non-overlapping detector: STATE_MACHINE vs D flip-flops and gates", () => {
  const { outputs, states } = model1101(BITS_1101, false)

  BITS_1101.forEach((b, k) => {
    it(`slot ${k} (input ${b}): both implementations are in state ${states[k]} with Det = ${outputs[k]}`, () => {
      const c = detector1101(BITS_1101)
      for (let i = 0; i <= k; i++) c.step()
      expect(smState(c, 'sm')).toBe(String(states[k]))
      expect(ffState1101(c)).toBe(states[k])
      expect(c.pin(p('sm', 'out1'))).toBe(bit(outputs[k]))
      expect(c.pin(p('det', 'out'))).toBe(bit(outputs[k]))
    })
  })

  it('detects exactly twice on 1101 1010 1101 (slots 3 and 11)', () => {
    expect(outputs).toEqual([0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1])
    const c = detector1101(BITS_1101)
    for (let i = 0; i < BITS_1101.length; i++) c.step()
    expect(valueAt(c, 'smDet', 75)).toBe(ONE)
    expect(valueAt(c, 'ffDet', 75)).toBe(ONE)
    expect(valueAt(c, 'smDet', 135)).toBe(ZERO)
    expect(valueAt(c, 'ffDet', 135)).toBe(ZERO)
    expect(valueAt(c, 'smDet', 235)).toBe(ONE)
    expect(valueAt(c, 'ffDet', 235)).toBe(ONE)
  })

  it('both Det waveforms agree at every slot sample point', () => {
    const c = detector1101(BITS_1101)
    for (let i = 0; i < BITS_1101.length; i++) c.step()
    for (let k = 0; k < BITS_1101.length; k++) {
      expect(valueAt(c, 'smDet', 20 * k + 15)).toBe(bit(outputs[k]))
      expect(valueAt(c, 'ffDet', 20 * k + 15)).toBe(bit(outputs[k]))
    }
  })

  it('the overlapping variant of the same table detects three times on the same stream', () => {
    // Only the detecting row changes: S3 + A -> S1 instead of S0.
    const overlapping = DETECT_1101.map((r, i) => (i === 6 ? { ...r, next: '1' } : r))
    const expected = model1101(BITS_1101, true).outputs
    expect(expected).toEqual([0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1])
    const c = detector1101(BITS_1101, overlapping)
    for (let i = 0; i < BITS_1101.length; i++) c.step()
    for (let k = 0; k < BITS_1101.length; k++) {
      expect(valueAt(c, 'smDet', 20 * k + 15)).toBe(bit(expected[k]))
    }
  })

  it('a stream ending mid-pattern leaves both implementations in the partial state', () => {
    const bits = [1, 1, 0]
    const c = detector1101(bits)
    for (let i = 0; i < bits.length; i++) c.step()
    expect(smState(c, 'sm')).toBe('2') // S2 during slot 2; S3 only after the edge
    expect(ffState1101(c)).toBe(2)
    c.step() // one more clock period with the input held at 0
    expect(smState(c, 'sm')).toBe('3')
    expect(ffState1101(c)).toBe(3)
    expect(c.pin(p('sm', 'out1'))).toBe(ZERO)
    expect(c.pin(p('det', 'out'))).toBe(ZERO)
  })
})

// ===========================================================================
// 4. Moore vs Mealy
// ===========================================================================

/**
 * Three-state ring counter. In the Moore version the output is listed on BOTH
 * rows of state 2, so it depends on the state alone; in the Mealy version only
 * the En row of state 2 drives it. The two machines live in one circuit, so they
 * use different pin labels (pins sharing a label are virtually connected).
 */
function ringTable(inLabel: string, outLabel: string, moore: boolean): SmRow[] {
  return [
    { present: '0', input: inLabel, output: '0', next: '1' },
    { present: '0', input: `${inLabel}'`, output: '0', next: '0' },
    { present: '1', input: inLabel, output: '0', next: '2' },
    { present: '1', input: `${inLabel}'`, output: '0', next: '1' },
    { present: '2', input: inLabel, output: outLabel, next: '0' },
    { present: '2', input: `${inLabel}'`, output: moore ? outLabel : '0', next: '2' }
  ]
}

const MOORE_SM = {
  smInputs: 1,
  smOutputs: 1,
  pinLabels: { in1: 'E', out1: 'Y' },
  smTable: ringTable('E', 'Y', true)
}

const MEALY_SM = {
  smInputs: 1,
  smOutputs: 1,
  pinLabels: { in1: 'F', out1: 'Z' },
  smTable: ringTable('F', 'Z', false)
}

function mooreVsMealySwitches(): Circuit {
  return new CircuitBuilder()
    .switch('En', ONE)
    .switch('clk', ZERO)
    .add('moore', ComponentType.STATE_MACHINE, MOORE_SM)
    .add('mealy', ComponentType.STATE_MACHINE, MEALY_SM)
    .wire(p('En', 'out'), p('moore', 'in1'))
    .wire(p('En', 'out'), p('mealy', 'in1'))
    .wire(p('clk', 'out'), p('moore', 'CLK'))
    .wire(p('clk', 'out'), p('mealy', 'CLK'))
    .build()
}

describe('Moore vs Mealy outputs on the same state graph', () => {
  it('both machines follow the same state sequence 0 -> 1 -> 2 -> 0', () => {
    const c = mooreVsMealySwitches()
    const seen: string[] = []
    for (let i = 0; i < 6; i++) {
      c.pulse('clk')
      seen.push(`${smState(c, 'moore')}${smState(c, 'mealy')}`)
    }
    expect(seen).toEqual(['11', '22', '00', '11', '22', '00'])
  })

  it('outputs are 0 in states 0 and 1 for both machines whatever En does', () => {
    const c = mooreVsMealySwitches()
    for (const state of [0, 1]) {
      expect(smState(c, 'moore')).toBe(String(state))
      for (const en of [ONE, ZERO, ONE]) {
        c.set('En', en)
        expect(c.pin(p('moore', 'out1'))).toBe(ZERO)
        expect(c.pin(p('mealy', 'out1'))).toBe(ZERO)
      }
      c.pulse('clk')
    }
  })

  it('in state 2 the Mealy output follows En with no clock edge while the Moore output holds', () => {
    const c = mooreVsMealySwitches()
    c.pulse('clk')
    c.pulse('clk')
    expect(smState(c, 'moore')).toBe('2')
    expect(smState(c, 'mealy')).toBe('2')
    expect(c.pin(p('moore', 'out1'))).toBe(ONE)
    expect(c.pin(p('mealy', 'out1'))).toBe(ONE)

    const before = c.time
    c.set('En', ZERO) // no clock edge: only the input moved
    expect(c.time).toBeGreaterThan(before)
    expect(smState(c, 'moore')).toBe('2')
    expect(smState(c, 'mealy')).toBe('2')
    expect(c.pin(p('moore', 'out1'))).toBe(ONE)
    expect(c.pin(p('mealy', 'out1'))).toBe(ZERO)

    c.set('En', ONE)
    expect(c.pin(p('moore', 'out1'))).toBe(ONE)
    expect(c.pin(p('mealy', 'out1'))).toBe(ONE)
  })

  it('the active row changes with En in state 2 even though the state does not', () => {
    const c = mooreVsMealySwitches()
    c.pulse('clk')
    c.pulse('clk')
    expect(activeRow(c, 'moore')).toBe(4)
    expect(activeRow(c, 'mealy')).toBe(4)
    c.set('En', ZERO)
    expect(activeRow(c, 'moore')).toBe(5)
    expect(activeRow(c, 'mealy')).toBe(5)
    expect(smState(c, 'moore')).toBe('2')
    expect(smState(c, 'mealy')).toBe('2')
  })

  it('clocking with En = 0 holds state 2: the Moore output stays 1 across the edge', () => {
    const c = mooreVsMealySwitches()
    c.pulse('clk')
    c.pulse('clk')
    c.set('En', ZERO)
    for (let i = 0; i < 3; i++) {
      c.pulse('clk')
      expect(smState(c, 'moore')).toBe('2')
      expect(c.pin(p('moore', 'out1'))).toBe(ONE)
      expect(c.pin(p('mealy', 'out1'))).toBe(ZERO)
    }
  })

  it('toggling En 10 times never changes either state display', () => {
    const c = mooreVsMealySwitches()
    c.pulse('clk')
    for (let i = 0; i < 10; i++) {
      c.toggle('En')
      expect(smState(c, 'moore')).toBe('1')
      expect(smState(c, 'mealy')).toBe('1')
    }
  })
})

describe('Moore vs Mealy under the CLOCK part: output waveforms', () => {
  function clocked(): Circuit {
    return new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .add('en', ComponentType.INPUT_SIGNAL, { signal: [sig(0, ONE), sig(45, ZERO), sig(85, ONE)] })
      .add('moore', ComponentType.STATE_MACHINE, MOORE_SM)
      .add('mealy', ComponentType.STATE_MACHINE, MEALY_SM)
      .probe('pY')
      .probe('pZ')
      .wire(p('clk', 'out'), p('moore', 'CLK'))
      .wire(p('clk', 'out'), p('mealy', 'CLK'))
      .wire(p('en', 'out'), p('moore', 'in1'))
      .wire(p('en', 'out'), p('mealy', 'in1'))
      .wire(p('moore', 'out1'), p('pY', 'in'))
      .wire(p('mealy', 'out1'), p('pZ', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 200 })
      .build()
  }

  it('the Moore output only ever changes one delay after a clock edge', () => {
    const c = clocked()
    c.go()
    expect(pairs(c, 'pY')).toEqual([
      [0, ZERO],
      [41, ONE],
      [101, ZERO],
      [141, ONE],
      [161, ZERO]
    ])
  })

  it('the Mealy output also changes between edges, following En at 45 and 85 ns', () => {
    const c = clocked()
    c.go()
    expect(pairs(c, 'pZ')).toEqual([
      [0, ZERO],
      [41, ONE],
      [46, ZERO],
      [86, ONE],
      [101, ZERO],
      [141, ONE],
      [161, ZERO]
    ])
  })

  it('both machines display the same state at every step end', () => {
    const c = clocked()
    const seen: string[] = []
    for (let i = 0; i < 10; i++) {
      c.step()
      expect(smState(c, 'moore')).toBe(smState(c, 'mealy'))
      seen.push(smState(c, 'moore'))
    }
    expect(seen).toEqual(['0', '1', '2', '2', '2', '0', '1', '2', '0', '1'])
  })
})

// ===========================================================================
// 5. Row semantics inside a composed circuit
// ===========================================================================

describe('state-table row semantics driven by real sources', () => {
  const PRIORITY_TABLE: SmRow[] = [
    { present: '0', input: 'A', output: 'P', next: '1' },
    { present: '0', input: 'B', output: 'Q', next: '2' },
    { present: '0', input: '-', output: '0', next: '0' },
    { present: '1', input: '-', output: 'P Q', next: '0' }
  ]

  function priorityCircuit(): Circuit {
    return new CircuitBuilder()
      .switch('A', ZERO)
      .switch('B', ZERO)
      .switch('clk', ZERO)
      .add('sm', ComponentType.STATE_MACHINE, {
        smInputs: 2,
        smOutputs: 2,
        pinLabels: { in1: 'A', in2: 'B', out1: 'P', out2: 'Q' },
        smTable: PRIORITY_TABLE
      })
      .add('inv', ComponentType.NOT)
      .probe('pP')
      .wire(p('A', 'out'), p('sm', 'in1'))
      .wire(p('B', 'out'), p('sm', 'in2'))
      .wire(p('clk', 'out'), p('sm', 'CLK'))
      .wire(p('sm', 'out1'), p('inv', 'in1'))
      .wire(p('sm', 'out1'), p('pP', 'in'))
      .build()
  }

  it('A = B = 1: the earlier row wins and decides both the outputs and the next state', () => {
    const c = priorityCircuit()
    c.setMany({ A: ONE, B: ONE })
    expect(activeRow(c, 'sm')).toBe(0)
    expect(outs(c, 'sm', 2)).toBe('10')
    c.pulse('clk')
    expect(smState(c, 'sm')).toBe('1')
  })

  it('A = 0, B = 1: the first row fails and the second one wins', () => {
    const c = priorityCircuit()
    c.setMany({ A: ZERO, B: ONE })
    expect(activeRow(c, 'sm')).toBe(1)
    expect(outs(c, 'sm', 2)).toBe('01')
    c.pulse('clk')
    expect(smState(c, 'sm')).toBe('2')
  })

  it('A = B = 0: only the don’t-care row matches, so every output is 0', () => {
    const c = priorityCircuit()
    c.setMany({ A: ZERO, B: ZERO })
    expect(activeRow(c, 'sm')).toBe(2)
    expect(outs(c, 'sm', 2)).toBe('00')
    c.pulse('clk')
    expect(smState(c, 'sm')).toBe('0')
  })

  it('a state with no rows at all leaves the outputs X and the downstream gate X', () => {
    const c = priorityCircuit()
    c.setMany({ A: ZERO, B: ONE })
    c.pulse('clk') // -> state 2, which has no rows
    expect(smState(c, 'sm')).toBe('2')
    expect(activeRow(c, 'sm')).toBeNull()
    expect(outs(c, 'sm', 2)).toBe('XX')
    expect(c.pin(p('inv', 'out'))).toBe(X)
    expect(c.pin(p('pP', 'in'))).toBe(X)
  })

  it('a machine stuck in a state with no rows never leaves it, whatever the inputs do', () => {
    const c = priorityCircuit()
    c.setMany({ A: ZERO, B: ONE })
    c.pulse('clk')
    for (const combo of [
      { A: ONE, B: ONE },
      { A: ONE, B: ZERO },
      { A: ZERO, B: ZERO }
    ]) {
      c.setMany(combo)
      c.pulse('clk')
      expect(smState(c, 'sm')).toBe('2')
      expect(outs(c, 'sm', 2)).toBe('XX')
    }
  })

  it('the don’t-care row of state 1 drives both outputs high after one clock', () => {
    const c = priorityCircuit()
    c.setMany({ A: ONE, B: ONE })
    c.pulse('clk')
    expect(activeRow(c, 'sm')).toBe(3)
    expect(outs(c, 'sm', 2)).toBe('11')
  })

  // --- inputs that are not 0/1 -------------------------------------------

  /** Every row of state 0 tests A, so an undetermined A leaves the machine blind. */
  const NEEDS_A: SmRow[] = [
    { present: '0', input: 'A', output: 'Y', next: '1' },
    { present: '0', input: "A'", output: '0', next: '0' },
    { present: '1', input: '-', output: '0', next: '0' }
  ]

  function tristateDrivenSm(): Circuit {
    return new CircuitBuilder()
      .switch('data', ONE)
      .switch('en', ZERO)
      .switch('clk', ZERO)
      .add('ts', ComponentType.TRISTATE_RIGHT)
      .add('sm', ComponentType.STATE_MACHINE, {
        smInputs: 1,
        smOutputs: 1,
        pinLabels: { in1: 'A', out1: 'Y' },
        smTable: NEEDS_A
      })
      .probe('pA')
      .wire(p('data', 'out'), p('ts', 'in'))
      .wire(p('en', 'out'), p('ts', 'ctl'))
      .wire(p('ts', 'out'), p('sm', 'in1'))
      .wire(p('ts', 'out'), p('pA', 'in'))
      .wire(p('clk', 'out'), p('sm', 'CLK'))
      .build()
  }

  it('a released tristate leaves the input at Z: no row of the state resolves, so the output is X', () => {
    const c = tristateDrivenSm()
    expect(c.pin(p('sm', 'in1'))).toBe(Z)
    expect(activeRow(c, 'sm')).toBeNull()
    expect(outs(c, 'sm', 1)).toBe('X')
  })

  it('a rising edge with the input at Z does not change the state', () => {
    const c = tristateDrivenSm()
    c.pulse('clk')
    expect(smState(c, 'sm')).toBe('0')
    expect(outs(c, 'sm', 1)).toBe('X')
  })

  it('enabling the tristate resolves the row again and the machine clocks normally', () => {
    const c = tristateDrivenSm()
    c.set('en', ONE)
    expect(c.pin(p('sm', 'in1'))).toBe(ONE)
    expect(activeRow(c, 'sm')).toBe(0)
    expect(outs(c, 'sm', 1)).toBe('1')
    c.pulse('clk')
    expect(smState(c, 'sm')).toBe('1')
  })

  it('two switches fighting over the input net make it X, which blinds the machine', () => {
    const c = new CircuitBuilder()
      .switch('a1', ONE)
      .switch('a2', ZERO)
      .switch('clk', ZERO)
      .add('sm', ComponentType.STATE_MACHINE, {
        smInputs: 1,
        smOutputs: 1,
        pinLabels: { in1: 'A', out1: 'Y' },
        smTable: NEEDS_A
      })
      .wire(p('a1', 'out'), p('sm', 'in1'))
      .wire(p('a2', 'out'), p('sm', 'in1'))
      .wire(p('clk', 'out'), p('sm', 'CLK'))
      .build()
    expect(c.pin(p('sm', 'in1'))).toBe(X)
    expect(activeRow(c, 'sm')).toBeNull()
    expect(outs(c, 'sm', 1)).toBe('X')
    c.pulse('clk')
    expect(smState(c, 'sm')).toBe('0')

    c.set('a2', ONE) // the drivers agree again
    expect(c.pin(p('sm', 'in1'))).toBe(ONE)
    expect(activeRow(c, 'sm')).toBe(0)
    c.pulse('clk')
    expect(smState(c, 'sm')).toBe('1')
  })

  const NEEDS_BOTH: SmRow[] = [
    { present: '0', input: 'A B', output: 'Y', next: '1' },
    { present: '0', input: "A'", output: '0', next: '0' },
    { present: '1', input: '-', output: '0', next: '1' }
  ]

  function unconnectedInputSm(): Circuit {
    return new CircuitBuilder()
      .switch('A', ZERO)
      .switch('clk', ZERO)
      .add('sm', ComponentType.STATE_MACHINE, {
        smInputs: 2,
        smOutputs: 1,
        pinLabels: { in1: 'A', in2: 'B', out1: 'Y' },
        smTable: NEEDS_BOTH
      })
      .wire(p('A', 'out'), p('sm', 'in1'))
      .wire(p('clk', 'out'), p('sm', 'CLK'))
      .build()
  }

  it('an unconnected input pin reads Z, but a row that fails before reaching it still decides', () => {
    const c = unconnectedInputSm()
    expect(c.pin(p('sm', 'in2'))).toBe(Z)
    expect(activeRow(c, 'sm')).toBe(1) // A = 0 fails row 0 at its first literal
    expect(outs(c, 'sm', 1)).toBe('0')
  })

  it('raising A makes the only remaining row depend on the unconnected pin: the output is X', () => {
    const c = unconnectedInputSm()
    c.set('A', ONE)
    expect(activeRow(c, 'sm')).toBeNull()
    expect(outs(c, 'sm', 1)).toBe('X')
    c.pulse('clk')
    expect(smState(c, 'sm')).toBe('0')
  })

  // --- a table with one bad row -----------------------------------------

  const BAD_ROW_TABLE: SmRow[] = [
    { present: '0', input: 'A', output: 'Y', next: '1' },
    { present: '0', input: '', output: '0', next: '0' }, // partially empty: syntax error
    { present: '1', input: '-', output: '0', next: '0' }
  ]

  function badRowCircuit(): { b: CircuitBuilder; c: Circuit } {
    const b = new CircuitBuilder()
      .switch('A', ZERO)
      .switch('clk', ZERO)
      .add('sm', ComponentType.STATE_MACHINE, {
        smInputs: 1,
        smOutputs: 1,
        pinLabels: { in1: 'A', out1: 'Y' },
        smTable: BAD_ROW_TABLE
      })
      .wire(p('A', 'out'), p('sm', 'in1'))
      .wire(p('clk', 'out'), p('sm', 'CLK'))
    return { b, c: b.build() }
  }

  it('compileTable reports the empty input cell of the partially filled row', () => {
    const { b } = badRowCircuit()
    const { rows, errors } = compileTable(componentOf(b, 'sm'))
    expect(errors).toEqual([
      { row: 1, column: 'input', message: expect.stringContaining('Input is empty') }
    ])
    expect(rows.map((r) => r.index)).toEqual([0, 2])
  })

  it('the machine still runs on the valid rows: A = 1 takes row 0 to state 1', () => {
    const { c } = badRowCircuit()
    c.set('A', ONE)
    expect(activeRow(c, 'sm')).toBe(0)
    expect(outs(c, 'sm', 1)).toBe('1')
    c.pulse('clk')
    expect(smState(c, 'sm')).toBe('1')
    expect(activeRow(c, 'sm')).toBe(2) // the raw table index, not the compiled one
    expect(outs(c, 'sm', 1)).toBe('0')
  })

  it('the dropped row leaves a hole: A = 0 in state 0 matches nothing, so the output is X', () => {
    const { c } = badRowCircuit()
    expect(c.pin(p('sm', 'in1'))).toBe(ZERO)
    expect(activeRow(c, 'sm')).toBeNull()
    expect(outs(c, 'sm', 1)).toBe('X')
    c.pulse('clk')
    expect(smState(c, 'sm')).toBe('0')
  })

  it('a bad state number is reported and its row is dropped, the rest of the table still runs', () => {
    const table: SmRow[] = [
      { present: 'S0', input: 'A', output: 'Y', next: '1' }, // "S0" is not a number
      { present: '0', input: 'A', output: 'Y', next: '1' },
      { present: '1', input: '-', output: '0', next: '0' }
    ]
    const b = new CircuitBuilder()
      .switch('A', ONE)
      .switch('clk', ZERO)
      .add('sm', ComponentType.STATE_MACHINE, {
        smInputs: 1,
        smOutputs: 1,
        pinLabels: { in1: 'A', out1: 'Y' },
        smTable: table
      })
      .wire(p('A', 'out'), p('sm', 'in1'))
      .wire(p('clk', 'out'), p('sm', 'CLK'))
    const { rows, errors } = compileTable(componentOf(b, 'sm'))
    expect(errors.map((e) => [e.row, e.column])).toEqual([[0, 'present']])
    expect(rows.map((r) => r.index)).toEqual([1, 2])

    const c = b.build()
    expect(smState(c, 'sm')).toBe('0') // the first VALID row sets the initial state
    expect(activeRow(c, 'sm')).toBe(1)
    c.pulse('clk')
    expect(smState(c, 'sm')).toBe('1')
  })
})

// ===========================================================================
// 6. reset() and the checker's 'R' soft reset
// ===========================================================================

/** The '101' detector wired to a checker: the checker drives A and reads Det. */
function checkedDetector(chk: { input: string; output: string }): Circuit {
  return new CircuitBuilder()
    .add('clk', ComponentType.CLOCK)
    .add('chk', ComponentType.CHECKER, { chk })
    .add('sm', ComponentType.STATE_MACHINE, {
      smInputs: 1,
      smOutputs: 1,
      pinLabels: { in1: 'A', out1: 'Det' },
      smTable: DETECT_101
    })
    .probe('pDet')
    .wire(p('clk', 'out'), p('sm', 'CLK'))
    .wire(p('chk', 'out'), p('sm', 'in1'))
    .wire(p('sm', 'out1'), p('chk', 'in'))
    .wire(p('sm', 'out1'), p('pDet', 'in'))
    .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 400 })
    .build()
}

describe('returning a running machine to its initial state', () => {
  it('reset() mid-run restores state 0, time 0 and a one-sample trace', () => {
    const c = detector101(BITS_101)
    c.step()
    c.step()
    c.step()
    expect(c.time).toBe(55)
    expect(smState(c, 'sm')).toBe('2')

    c.reset()
    expect(c.time).toBe(0)
    expect(smState(c, 'sm')).toBe('0')
    expect(pairs(c, 'smDet')).toEqual([[0, ZERO]])
    expect(c.sim.getCheckerResult()).toBeNull()
  })

  it('after reset() the same run replays identically', () => {
    const first = detector101(BITS_101)
    for (let i = 0; i < 6; i++) first.step()
    const expected = pairs(first, 'smDet')

    const c = detector101(BITS_101)
    for (let i = 0; i < 3; i++) c.step()
    c.reset()
    for (let i = 0; i < 6; i++) c.step()
    expect(pairs(c, 'smDet')).toEqual(expected)
    expect(smState(c, 'sm')).toBe(smState(first, 'sm'))
  })

  it('reset() also clears the checker back to READY and re-drives slot 0', () => {
    const c = checkedDetector(chkOf('101', '001'))
    c.step()
    c.step()
    expect(c.sim.getCheckerResult()).toEqual({ total: 3, sampled: 2, failures: 0 })
    c.reset()
    expect(c.time).toBe(0)
    expect(verdict(c)).toBe('READY')
    expect(c.sim.getCheckerResult()).toEqual({ total: 3, sampled: 0, failures: 0 })
    expect(c.pin(p('chk', 'out'))).toBe(ONE)
    expect(smState(c, 'sm')).toBe('0')
  })

  it("an 'R' slot returns the detector to state 0 in the middle of the stream", () => {
    const c = checkedDetector(chkOf('101R101', '001X001'))
    c.step()
    c.step()
    c.step()
    expect(c.time).toBe(55)
    expect(smState(c, 'sm')).toBe('2') // 1, 0 seen: the machine is one bit from a hit

    c.step() // the R slot: drive X at 65, soft reset, sample at 75
    expect(c.time).toBe(75)
    expect(smState(c, 'sm')).toBe('0')
    expect(outs(c, 'sm', 1)).toBe('X') // A is X, so no row of state 0 resolves

    c.step() // slot 4 drives 1 at 85
    expect(smState(c, 'sm')).toBe('0') // the edge at 80 saw A = X: no transition
    expect(outs(c, 'sm', 1)).toBe('0')
    c.step()
    expect(smState(c, 'sm')).toBe('1')
  })

  it("the whole 'R' stream passes because the expected sequence restarts after the reset", () => {
    const c = checkedDetector(chkOf('101R101', '001X001'))
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 6, sampled: 6, failures: 0 })
    expect(verdict(c)).toBe('PASS')
  })

  it('the same expected line fails when the stream has no R (the machine keeps its state)', () => {
    const c = checkedDetector(chkOf('1010101', '001X001'))
    c.go()
    // Without the reset the detector is in state 2 during slot 4 and detects.
    expect(c.sim.getCheckerResult()).toEqual({ total: 6, sampled: 6, failures: 1 })
    expect(verdict(c)).toBe('FAIL')
  })

  it("'R' does not disturb time or the recorded Det waveform", () => {
    const c = checkedDetector(chkOf('101R101', '001X001'))
    c.go()
    expect(c.time).toBe(395)
    const samples = trace(c, 'pDet')
    // Non-decreasing in time, one sample per instant at most.
    for (let i = 1; i < samples.length; i++) expect(samples[i].t).toBeGreaterThan(samples[i - 1].t)
    expect(samples[0]).toEqual({ t: 0, v: ZERO })
  })
})

// ===========================================================================
// 7. The checker against flip-flop delay lines
// ===========================================================================

/** A chain of `n` D flip-flops from the checker's out pin back to its in pin. */
function delayLine(
  chk: { input: string; output: string },
  n: number,
  period = 20,
  simTimeNs = 400
): Circuit {
  const b = new CircuitBuilder()
    .add('clk', ComponentType.CLOCK)
    .add('chk', ComponentType.CHECKER, { chk })
    .add('vcc', ComponentType.VCC)
    .setSimulation({ clockPeriodNs: period, clockInitialValue: ONE, simTimeNs })
  for (let i = 0; i < n; i++) {
    b.add(`ff${i}`, ComponentType.D_FLIPFLOP)
      .wire(p('vcc', 'out'), p(`ff${i}`, 'S'))
      .wire(p('vcc', 'out'), p(`ff${i}`, 'R'))
      .wire(p('clk', 'out'), p(`ff${i}`, 'CLK'))
      .wire(i === 0 ? p('chk', 'out') : p(`ff${i - 1}`, 'Q'), p(`ff${i}`, 'D'))
  }
  b.wire(p(`ff${n - 1}`, 'Q'), p('chk', 'in'))
  return b.build()
}

const STREAM = '01101001'
/** `shift` clocks of delay: the first `shift` slots are don't-care. */
const shifted = (shift: number): string => 'X'.repeat(shift) + STREAM.slice(0, STREAM.length - shift)

describe('checker vs a D flip-flop delay line', () => {
  it('one flip-flop matches a one-clock delayed expectation (PASS)', () => {
    const c = delayLine(chkOf(STREAM, shifted(1)), 1)
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 7, sampled: 7, failures: 0 })
    expect(verdict(c)).toBe('PASS')
  })

  it('two flip-flops match a two-clock delayed expectation (PASS)', () => {
    const c = delayLine(chkOf(STREAM, shifted(2)), 2)
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 6, sampled: 6, failures: 0 })
    expect(verdict(c)).toBe('PASS')
  })

  it('three flip-flops match a three-clock delayed expectation (PASS)', () => {
    const c = delayLine(chkOf(STREAM, shifted(3)), 3)
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 5, sampled: 5, failures: 0 })
    expect(verdict(c)).toBe('PASS')
  })

  it('one flip-flop against a two-clock expectation fails in exactly four slots', () => {
    const c = delayLine(chkOf(STREAM, shifted(2)), 1)
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 6, sampled: 6, failures: 4 })
    expect(verdict(c)).toBe('FAIL')
  })

  it('two flip-flops against a one-clock expectation fail in exactly five slots', () => {
    const c = delayLine(chkOf(STREAM, shifted(1)), 2)
    c.go()
    // Slot 1 samples the still-empty second stage (X) and four later slots disagree.
    expect(c.sim.getCheckerResult()).toEqual({ total: 7, sampled: 7, failures: 5 })
    expect(verdict(c)).toBe('FAIL')
  })

  it('one flip-flop against an undelayed expectation fails in six slots', () => {
    const c = delayLine(chkOf(STREAM, STREAM), 1)
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 8, sampled: 8, failures: 6 })
    expect(verdict(c)).toBe('FAIL')
  })

  it('the delay line holds the previous slot’s value at every step end', () => {
    const c = delayLine(chkOf(STREAM, shifted(1)), 1)
    for (let k = 0; k < STREAM.length; k++) {
      c.step()
      // Slot 0 samples the flip-flop before any edge has loaded it.
      expect(c.pin(p('ff0', 'Q'))).toBe(k === 0 ? X : bit(Number(STREAM[k - 1])))
    }
  })

  it('the second stage of a two-flip-flop chain lags the first by one more slot', () => {
    const c = delayLine(chkOf(STREAM, shifted(2)), 2)
    for (let k = 0; k < STREAM.length; k++) {
      c.step()
      expect(c.pin(p('ff0', 'Q'))).toBe(k === 0 ? X : bit(Number(STREAM[k - 1])))
      expect(c.pin(p('ff1', 'Q'))).toBe(k <= 1 ? X : bit(Number(STREAM[k - 2])))
    }
  })
})

describe("checker don't-care slots", () => {
  it('X slots in the expected line are neither sampled nor counted', () => {
    const c = delayLine(chkOf(STREAM, 'X01X010X'), 1)
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 5, sampled: 5, failures: 0 })
    expect(verdict(c)).toBe('PASS')
  })

  it('the same run fails once when a don’t-care slot is replaced by the wrong value', () => {
    // Slot 3 actually carries STREAM[2] = 1; expecting 0 there is one failure.
    const c = delayLine(chkOf(STREAM, 'X010010X'), 1)
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 6, sampled: 6, failures: 1 })
    expect(verdict(c)).toBe('FAIL')
  })

  it('an all-X expected line samples nothing at all and never reports FAIL', () => {
    const c = delayLine(chkOf(STREAM, 'XXXXXXXX'), 1)
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 0, sampled: 0, failures: 0 })
    expect(verdict(c)).not.toBe('FAIL')
  })

  it('an all-X expected line still drives the whole input stream at the slot times', () => {
    const b = new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .add('chk', ComponentType.CHECKER, { chk: chkOf(STREAM, 'XXXXXXXX') })
      .probe('pOut')
      .wire(p('chk', 'out'), p('pOut', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 400 })
    const c = b.build()
    c.go()
    for (let k = 0; k < STREAM.length; k++) {
      expect(valueAt(c, 'pOut', 20 * k + 15)).toBe(bit(Number(STREAM[k])))
    }
  })

  it('an X in the INPUT line drives X into the circuit and the following slot may be a don’t care', () => {
    // Slot 2 drives X, so the flip-flop captures X at the edge at 60 and slot 3
    // reads X; every other slot still shows the previous slot's value.
    const c = delayLine(chkOf('01X1001', 'X01X100'), 1)
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 5, sampled: 5, failures: 0 })
    expect(verdict(c)).toBe('PASS')
  })

  it('an X captured by the delay line fails a slot that expects 0 or 1', () => {
    const c = delayLine(chkOf('01X1001', 'X011100'), 1)
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 6, sampled: 6, failures: 1 })
    expect(verdict(c)).toBe('FAIL')
  })
})

// ===========================================================================
// 8. 'R' resetting a JK toggle flip-flop mid-stream
// ===========================================================================

/**
 * A JK flip-flop wired as a toggle (J = K = 1) divides the clock by two on the
 * falling edges at 10, 30, 50, ... Its asynchronous clear is driven by an
 * INPUT_SIGNAL that pulses low at t = 0 and again just after the checker's 'R'
 * drive time, so the circuit under test really restarts when the checker resets
 * it. `withRestart = false` leaves the soft reset's X in place.
 */
function toggleUnderChecker(chk: { input: string; output: string }, withRestart: boolean): Circuit {
  const rows = [sig(0, ZERO), sig(1, ONE)]
  if (withRestart) rows.push(sig(66, ZERO), sig(67, ONE))
  return new CircuitBuilder()
    .add('clk', ComponentType.CLOCK)
    .add('chk', ComponentType.CHECKER, { chk })
    .add('vcc', ComponentType.VCC)
    .add('rst', ComponentType.INPUT_SIGNAL, { signal: rows })
    .add('jk', ComponentType.JK_FLIPFLOP)
    .probe('pQ')
    .probe('pOut')
    .wire(p('clk', 'out'), p('jk', 'CLK'))
    .wire(p('vcc', 'out'), p('jk', 'J'))
    .wire(p('vcc', 'out'), p('jk', 'K'))
    .wire(p('vcc', 'out'), p('jk', 'S'))
    .wire(p('rst', 'out'), p('jk', 'R'))
    .wire(p('jk', 'Q'), p('chk', 'in'))
    .wire(p('jk', 'Q'), p('pQ', 'in'))
    .wire(p('chk', 'out'), p('pOut', 'in'))
    .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 400 })
    .build()
}

describe("checker 'R' against a JK toggle flip-flop", () => {
  const TOGGLE_CHK = chkOf('000R0000', '10110101')

  it('the toggle divides the clock by two and passes the restarted expectation', () => {
    const c = toggleUnderChecker(TOGGLE_CHK, true)
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 8, sampled: 8, failures: 0 })
    expect(verdict(c)).toBe('PASS')
  })

  it("the 'R' slot drives Q to X at 66 ns and the restart pulse clears it at 67 ns", () => {
    const c = toggleUnderChecker(TOGGLE_CHK, true)
    for (let i = 0; i < 8; i++) c.step() // exactly the eight checker slots
    expect(c.time).toBe(155)
    expect(pairs(c, 'pQ')).toEqual([
      [0, ZERO],
      [11, ONE],
      [31, ZERO],
      [51, ONE],
      [66, X], // the checker's soft reset put the flip-flop back in its default state
      [67, ZERO], // the circuit's own clear pulse
      [71, ONE],
      [91, ZERO],
      [111, ONE],
      [131, ZERO],
      [151, ONE]
    ])
  })

  it("the checker drives X on its out pin during the 'R' slot", () => {
    const c = toggleUnderChecker(TOGGLE_CHK, true)
    c.go()
    expect(valueAt(c, 'pOut', 60)).toBe(ZERO)
    expect(valueAt(c, 'pOut', 65)).toBe(X)
    expect(valueAt(c, 'pOut', 85)).toBe(ZERO)
  })

  it('the toggle sequence after the reset repeats the one before it', () => {
    const c = toggleUnderChecker(TOGGLE_CHK, true)
    c.go()
    for (let k = 0; k < 3; k++) {
      expect(valueAt(c, 'pQ', 20 * k + 15)).toBe(valueAt(c, 'pQ', 20 * (k + 3) + 15))
    }
  })

  it('without a clear pulse the soft reset leaves a J = K = 1 toggle at X for the rest of the run', () => {
    const c = toggleUnderChecker(TOGGLE_CHK, false)
    c.go()
    // Slots 0..2 still pass; every slot from the reset on samples X and fails.
    expect(c.sim.getCheckerResult()).toEqual({ total: 8, sampled: 8, failures: 5 })
    expect(verdict(c)).toBe('FAIL')
    expect(valueAt(c, 'pQ', 155)).toBe(X)
  })

  it("an expected line that marks the reset slots don't-care passes without the clear pulse", () => {
    const c = toggleUnderChecker(chkOf('000R0000', '101XXXXX'), false)
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 3, sampled: 3, failures: 0 })
    expect(verdict(c)).toBe('PASS')
  })
})

// ===========================================================================
// 9. The checker's display progression
// ===========================================================================

describe('checker display progression during a run', () => {
  const PASSING = chkOf('10101', '00101')
  const FAILING = chkOf('10101', '01101')

  it('shows READY before the first step and after each sampled slot the count', () => {
    const c = checkedDetector(PASSING)
    expect(verdict(c)).toBe('READY')
    const seen: string[] = []
    for (let i = 0; i < 5; i++) {
      c.step()
      seen.push(verdict(c))
    }
    expect(seen).toEqual(['1/5', '2/5', '3/5', '4/5', 'PASS'])
  })

  it('keeps counting (never FAIL) while slots remain, even after an early mismatch', () => {
    const c = checkedDetector(FAILING)
    const seen: string[] = []
    for (let i = 0; i < 5; i++) {
      c.step()
      seen.push(verdict(c))
    }
    expect(seen).toEqual(['1/5', '2/5', '3/5', '4/5', 'FAIL'])
    expect(c.sim.getCheckerResult()).toEqual({ total: 5, sampled: 5, failures: 1 })
  })

  it('go() jumps straight to the final verdict', () => {
    const pass = checkedDetector(PASSING)
    pass.go()
    expect(verdict(pass)).toBe('PASS')
    const fail = checkedDetector(FAILING)
    fail.go()
    expect(verdict(fail)).toBe('FAIL')
  })

  it('a run stopped half way reports the partial count and keeps it until more slots are sampled', () => {
    const c = checkedDetector(PASSING)
    c.step()
    c.step()
    expect(verdict(c)).toBe('2/5')
    expect(c.sim.getCheckerResult()).toEqual({ total: 5, sampled: 2, failures: 0 })
    c.go() // Go is relative: it runs on from here
    expect(verdict(c)).toBe('PASS')
  })

  it('the verdict is published under the checker’s own key alongside the state display', () => {
    const c = checkedDetector(PASSING)
    c.go()
    const displays = c.sim.getSmDisplays()
    expect(displays[p('chk', 'result')]).toBe('PASS')
    expect(displays[p('sm', 'state')]).toBe(smState(c, 'sm'))
  })
})

// ===========================================================================
// 10. The shipped samples/inverter-test.chk
// ===========================================================================

/** samples/inverter-test.chk driving one gate between the checker's out and in. */
function inverterSample(type: ComponentType | null, delay = 1): Circuit {
  const b = new CircuitBuilder()
    .add('clk', ComponentType.CLOCK)
    .add('chk', ComponentType.CHECKER, { chk: INVERTER_CHK })
    .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 400 })
  if (type === null) {
    b.wire(p('chk', 'out'), p('chk', 'in'))
  } else {
    b.add('g', type, { delay })
      .wire(p('chk', 'out'), p('g', 'in1'))
      .wire(p('g', 'out'), p('chk', 'in'))
  }
  return b.build()
}

describe('samples/inverter-test.chk', () => {
  it('is an eight-slot file whose expected line is the complement of its input line', () => {
    expect(INVERTER_CHK).toEqual({ input: '10101100', output: '01010011' })
    for (let k = 0; k < 8; k++) {
      expect(INVERTER_CHK.output[k]).toBe(INVERTER_CHK.input[k] === '1' ? '0' : '1')
    }
  })

  it('passes through a NOT gate', () => {
    const c = inverterSample(ComponentType.NOT)
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 8, sampled: 8, failures: 0 })
    expect(verdict(c)).toBe('PASS')
  })

  it('fails through a direct wire, and every slot is a failure', () => {
    const c = inverterSample(null)
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 8, sampled: 8, failures: 8 })
    expect(verdict(c)).toBe('FAIL')
  })

  it('passes step by step, with the count rising once per clock period', () => {
    const c = inverterSample(ComponentType.NOT)
    const seen: string[] = []
    for (let i = 0; i < 8; i++) {
      c.step()
      seen.push(verdict(c))
    }
    expect(seen).toEqual(['1/8', '2/8', '3/8', '4/8', '5/8', '6/8', '7/8', 'PASS'])
  })

  it('a NOT gate slower than one slot (delay 20) fails in five slots', () => {
    const c = inverterSample(ComponentType.NOT, 20)
    c.go()
    // The gate now presents the PREVIOUS slot's complement at every sample point;
    // slots 0, 5 and 7 happen to agree anyway.
    expect(c.sim.getCheckerResult()).toEqual({ total: 8, sampled: 8, failures: 5 })
    expect(verdict(c)).toBe('FAIL')
  })

  it('a NOT gate with delay 9 (settling just before the sample point) still passes', () => {
    const c = inverterSample(ComponentType.NOT, 9)
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 8, sampled: 8, failures: 0 })
    expect(verdict(c)).toBe('PASS')
  })

  it('an AND gate fed from one source (a buffer) fails like the direct wire', () => {
    const b = new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .add('chk', ComponentType.CHECKER, { chk: INVERTER_CHK })
      .add('g', ComponentType.AND2)
      .wire(p('chk', 'out'), p('g', 'in1'))
      .wire(p('chk', 'out'), p('g', 'in2'))
      .wire(p('g', 'out'), p('chk', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 400 })
    const c = b.build()
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 8, sampled: 8, failures: 8 })
  })
})

// ===========================================================================
// 11. The system at other clock periods and with a falling-edge clock
// ===========================================================================

describe('checker slot arithmetic at other clock periods', () => {
  it('period 8 (quarter 2): a one-flip-flop delay line still passes a one-slot expectation', () => {
    const c = delayLine(chkOf(STREAM, shifted(1)), 1, 8, 100)
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 7, sampled: 7, failures: 0 })
    expect(verdict(c)).toBe('PASS')
  })

  it('period 8: an undelayed expectation still fails', () => {
    const c = delayLine(chkOf(STREAM, STREAM), 1, 8, 100)
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 8, sampled: 8, failures: 6 })
  })

  it('odd period 25 (quarter 6): drive at 25k + 6, sample at 25k + 19, one-slot delay passes', () => {
    const c = delayLine(chkOf(STREAM, shifted(1)), 1, 25, 250)
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 7, sampled: 7, failures: 0 })
    expect(verdict(c)).toBe('PASS')
  })

  it('odd period 25: a two-flip-flop chain needs a two-slot expectation', () => {
    const early = delayLine(chkOf(STREAM, shifted(1)), 2, 25, 250)
    early.go()
    expect(early.sim.getCheckerResult()).toEqual({ total: 7, sampled: 7, failures: 5 })
    const right = delayLine(chkOf(STREAM, shifted(2)), 2, 25, 250)
    right.go()
    expect(right.sim.getCheckerResult()).toEqual({ total: 6, sampled: 6, failures: 0 })
  })

  it('period 8: the sample point is 6 ns into each slot, so a 7 ns gate delay is too slow', () => {
    const b = new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .add('chk', ComponentType.CHECKER, { chk: INVERTER_CHK })
      .add('g', ComponentType.NOT, { delay: 7 })
      .wire(p('chk', 'out'), p('g', 'in1'))
      .wire(p('g', 'out'), p('chk', 'in'))
      .setSimulation({ clockPeriodNs: 8, clockInitialValue: ONE, simTimeNs: 100 })
    const slow = b.build()
    slow.go()
    expect(slow.sim.getCheckerResult()?.failures).toBeGreaterThan(0)

    const fast = new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .add('chk', ComponentType.CHECKER, { chk: INVERTER_CHK })
      .add('g', ComponentType.NOT, { delay: 3 })
      .wire(p('chk', 'out'), p('g', 'in1'))
      .wire(p('g', 'out'), p('chk', 'in'))
      .setSimulation({ clockPeriodNs: 8, clockInitialValue: ONE, simTimeNs: 100 })
      .build()
    fast.go()
    expect(fast.sim.getCheckerResult()).toEqual({ total: 8, sampled: 8, failures: 0 })
  })
})

describe("'101' detector with a falling-edge clock (initial value 0)", () => {
  // Toggle k happens at floor(k * 20 / 2) = 10k, so with initial value 0 the
  // RISING edges (which are what a state machine acts on) are at 10, 30, 50, ...
  // while Step still ends a quarter period before the falling edges at 20, 40, ...
  function fallingEdgeDetector(bits: number[]): Circuit {
    const rows = [sig(0, bit(bits[0]))]
    for (let k = 1; k < bits.length; k++) rows.push(sig(20 * k - 8, bit(bits[k])))
    return new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .add('a', ComponentType.INPUT_SIGNAL, { signal: rows })
      .add('sm', ComponentType.STATE_MACHINE, {
        smInputs: 1,
        smOutputs: 1,
        pinLabels: { in1: 'A', out1: 'Det' },
        smTable: DETECT_101
      })
      .probe('smDet')
      .wire(p('clk', 'out'), p('sm', 'CLK'))
      .wire(p('a', 'out'), p('sm', 'in1'))
      .wire(p('sm', 'out1'), p('smDet', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ZERO, simTimeNs: 400 })
      .build()
  }

  const { outputs, states } = model101(BITS_101)

  it('the very first Step already contains the rising edge at 10 ns', () => {
    const c = fallingEdgeDetector(BITS_101)
    c.step()
    expect(c.time).toBe(15)
    expect(smState(c, 'sm')).toBe(String(states[1]))
    expect(c.pin(p('sm', 'out1'))).toBe(bit(outputs[1]))
  })

  for (let n = 1; n <= 5; n++) {
    it(`after ${n} step(s) the machine has consumed ${n} bits and shows state ${states[n]}`, () => {
      const c = fallingEdgeDetector(BITS_101)
      for (let i = 0; i < n; i++) c.step()
      expect(smState(c, 'sm')).toBe(String(states[n]))
      expect(c.pin(p('sm', 'out1'))).toBe(bit(outputs[n]))
    })
  }

  it('the clock still ends every Step in its inactive (high) state', () => {
    const c = fallingEdgeDetector(BITS_101)
    for (let i = 0; i < 4; i++) {
      c.step()
      expect(c.pin(p('sm', 'CLK'))).toBe(ONE)
    }
  })
})

// ===========================================================================
// 12. The checker's soft reset across a whole system
// ===========================================================================

/**
 * A ring-counter state machine and a 2-bit counter share one clock. The checker
 * only supplies the reset: 'R' must return BOTH sequential parts to their
 * power-up state without disturbing time.
 */
function systemUnderSoftReset(input: string): Circuit {
  return new CircuitBuilder()
    .add('clk', ComponentType.CLOCK)
    .add('chk', ComponentType.CHECKER, { chk: chkOf(input, 'X'.repeat(input.length)) })
    .add('vcc', ComponentType.VCC)
    .add('clrSig', ComponentType.INPUT_SIGNAL, { signal: [sig(0, ZERO), sig(25, ONE)] })
    .add('sm', ComponentType.STATE_MACHINE, MOORE_SM)
    .add('ctr', ComponentType.N_COUNTER, { bits: 2 })
    .probe('pY')
    .wire(p('clk', 'out'), p('sm', 'CLK'))
    .wire(p('clk', 'out'), p('ctr', 'CLK'))
    .wire(p('vcc', 'out'), p('sm', 'in1'))
    .wire(p('vcc', 'out'), p('ctr', 'En'))
    .wire(p('clrSig', 'out'), p('ctr', 'CLR'))
    .wire(p('sm', 'out1'), p('pY', 'in'))
    .wire(p('sm', 'out1'), p('chk', 'in'))
    .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 400 })
    .build()
}

describe("the checker's 'R' resets every sequential part of a system", () => {
  it('without an R the ring counter and the counter advance together', () => {
    const c = systemUnderSoftReset('00000000')
    c.step() // 15
    expect(smState(c, 'sm')).toBe('0')
    expect(c.vec('ctr', 'Q', 2)).toBe('XX')
    c.step() // 35: edge at 20 cleared the counter and advanced the ring
    expect(smState(c, 'sm')).toBe('1')
    expect(c.vec('ctr', 'Q', 2)).toBe('00')
    c.step() // 55
    expect(smState(c, 'sm')).toBe('2')
    expect(c.vec('ctr', 'Q', 2)).toBe('01')
    c.step() // 75
    expect(smState(c, 'sm')).toBe('0')
    expect(c.vec('ctr', 'Q', 2)).toBe('10')
  })

  it("an 'R' in slot 2 sends the state machine back to state 0 and the counter back to X", () => {
    const c = systemUnderSoftReset('00R00000')
    c.step()
    c.step()
    c.step() // the R is applied at 45, inside this step
    expect(c.time).toBe(55)
    expect(smState(c, 'sm')).toBe('0') // would have been 2
    expect(c.vec('ctr', 'Q', 2)).toBe('XX') // would have been 01
    expect(c.pin(p('sm', 'out1'))).toBe(ZERO) // state 0 with En = 1: row 0
  })

  it('after the reset the ring counter starts over while the counter stays X (nothing clears it again)', () => {
    const c = systemUnderSoftReset('00R00000')
    for (let i = 0; i < 6; i++) c.step()
    expect(c.time).toBe(115)
    // Edges at 60, 80, 100 after the reset: state 0 -> 1 -> 2 -> 0.
    expect(smState(c, 'sm')).toBe('0')
    expect(c.vec('ctr', 'Q', 2)).toBe('XX')
  })

  it("the Moore output's waveform shows the reset as an extra fall at the R time", () => {
    const c = systemUnderSoftReset('00R00000')
    for (let i = 0; i < 8; i++) c.step()
    // Y is high only in state 2: reached at the edge at 40 (so 41) and cut short
    // by the reset at 45 (so 46). The ring then restarts from state 0 at the
    // edges 60 and 80, so Y is high again from 81 until the edge at 100.
    expect(pairs(c, 'pY')).toEqual([
      [0, ZERO],
      [41, ONE],
      [46, ZERO],
      [81, ONE],
      [101, ZERO],
      [141, ONE]
    ])
  })
})

// ===========================================================================
// 13. Extra combinational delay between the machine and the checker
// ===========================================================================

describe('a gate between the state machine and the checker', () => {
  /** The detector's output is inverted before it reaches the checker. */
  function invertedDetector(chk: { input: string; output: string }, delay: number): Circuit {
    return new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .add('chk', ComponentType.CHECKER, { chk })
      .add('sm', ComponentType.STATE_MACHINE, {
        smInputs: 1,
        smOutputs: 1,
        pinLabels: { in1: 'A', out1: 'Det' },
        smTable: DETECT_101
      })
      .add('inv', ComponentType.NOT, { delay })
      .wire(p('clk', 'out'), p('sm', 'CLK'))
      .wire(p('chk', 'out'), p('sm', 'in1'))
      .wire(p('sm', 'out1'), p('inv', 'in1'))
      .wire(p('inv', 'out'), p('chk', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 400 })
      .build()
  }

  it('the inverted detector matches the complemented expected line', () => {
    const c = invertedDetector(chkOf('10101', '11010'), 1)
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 5, sampled: 5, failures: 0 })
    expect(verdict(c)).toBe('PASS')
  })

  it('the same circuit fails the un-complemented expected line in every slot', () => {
    const c = invertedDetector(chkOf('10101', '00101'), 1)
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 5, sampled: 5, failures: 5 })
    expect(verdict(c)).toBe('FAIL')
  })

  it('a gate delay that reaches past the sample point breaks the two detecting slots', () => {
    // The machine drives Det at 46 and 86; with a 30 ns inverter the checker sees
    // the previous value at the 55 ns and 95 ns sample points.
    const c = invertedDetector(chkOf('10101', '11010'), 30)
    c.go()
    expect(c.sim.getCheckerResult()?.failures).toBe(2)
    expect(verdict(c)).toBe('FAIL')
  })
})

// ===========================================================================
// 14. Same-instant races inside a composed system
// ===========================================================================

/**
 * A flip-flop's Q (the machine's K input) and the machine's own clock can be made
 * to arrive at the very same instant by buffering the clock: the flip-flop has
 * delay 2 and the buffer is two 1 ns inverters. Implementation decision 1 says the
 * edge then samples the NEW value, exactly like a VHDL process seeing every
 * signal updated in the same delta; without the buffer the machine's edge is 2 ns
 * ahead of Q and sees the old one.
 */
function releasedRaceCircuit(bufferedClock: boolean): Circuit {
  return new CircuitBuilder()
    .switch('clk', ZERO)
    .switch('d', ONE)
    .switch('clr', ZERO) // active-low clear: starts asserted
    .add('vcc', ComponentType.VCC)
    .add('ff', ComponentType.D_FLIPFLOP, { delay: 2 })
    .add('n1', ComponentType.NOT)
    .add('n2', ComponentType.NOT)
    .add('sm', ComponentType.STATE_MACHINE, {
      smInputs: 1,
      smOutputs: 1,
      pinLabels: { in1: 'K', out1: 'Y' },
      smTable: [
        { present: '0', input: 'K', output: 'Y', next: '1' },
        { present: '0', input: "K'", output: '0', next: '0' },
        { present: '1', input: '-', output: '0', next: '1' }
      ]
    })
    .wire(p('clk', 'out'), p('ff', 'CLK'))
    .wire(p('d', 'out'), p('ff', 'D'))
    .wire(p('vcc', 'out'), p('ff', 'S'))
    .wire(p('clr', 'out'), p('ff', 'R'))
    .wire(p('ff', 'Q'), p('sm', 'in1'))
    .wire(p('clk', 'out'), p('n1', 'in1'))
    .wire(p('n1', 'out'), p('n2', 'in1'))
    .wire(bufferedClock ? p('n2', 'out') : p('clk', 'out'), p('sm', 'CLK'))
    .build()
}

describe('a released flip-flop racing the machine’s clock', () => {
  it('unbuffered: the machine’s edge is 2 ns ahead of Q, so it samples K = 0 and holds', () => {
    const c = releasedRaceCircuit(false)
    c.set('clr', ONE) // release the clear; Q is still 0
    expect(c.pin(p('sm', 'in1'))).toBe(ZERO)
    c.rise('clk')
    expect(c.pin(p('ff', 'Q'))).toBe(ONE) // the flip-flop did capture D = 1
    expect(smState(c, 'sm')).toBe('0') // but the machine saw the old K
    expect(outs(c, 'sm', 1)).toBe('1') // and now the Mealy output follows K = 1
    expect(activeRow(c, 'sm')).toBe(0)
  })

  it('buffered: Q and the clock edge land together, so the edge samples K = 1', () => {
    const c = releasedRaceCircuit(true)
    c.set('clr', ONE)
    expect(c.pin(p('sm', 'in1'))).toBe(ZERO)
    c.rise('clk')
    expect(c.pin(p('ff', 'Q'))).toBe(ONE)
    expect(smState(c, 'sm')).toBe('1') // decision 1: the new value is sampled
    expect(outs(c, 'sm', 1)).toBe('0')
  })
})

// ===========================================================================
// 15. X reaching the checker through the machine
// ===========================================================================

describe('an X slot in the checker input propagating through the machine', () => {
  it('the Mealy output is X for that slot, which fails an expected 0', () => {
    const c = checkedDetector(chkOf('1X101', '00001'))
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 5, sampled: 5, failures: 1 })
    expect(verdict(c)).toBe('FAIL')
  })

  it('marking that slot don’t-care makes the same run pass', () => {
    const c = checkedDetector(chkOf('1X101', '0X001'))
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 4, sampled: 4, failures: 0 })
    expect(verdict(c)).toBe('PASS')
  })

  it('the X slot also freezes the state: the edge inside it changes nothing', () => {
    const c = checkedDetector(chkOf('1X101', '0X001'))
    c.step() // 15: state 0, A = 1
    expect(smState(c, 'sm')).toBe('0')
    c.step() // 35: the edge at 20 moved to state 1, then A went X at 25
    expect(smState(c, 'sm')).toBe('1')
    expect(outs(c, 'sm', 1)).toBe('X')
    c.step() // 55: the edge at 40 saw A = X, so the state is unchanged
    expect(smState(c, 'sm')).toBe('1')
    expect(outs(c, 'sm', 1)).toBe('0') // A = 1 again since 45
  })
})

// ===========================================================================
// 16. A repeating INPUT_SIGNAL driving the machine
// ===========================================================================

describe("a repeating ('R') input signal driving the '101' detector", () => {
  /** Rows at 5, 25, 45 with R at 60: the pattern 1, 0, 1 repeats every 60 ns. */
  function repeatingDetector(): Circuit {
    return new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .add('a', ComponentType.INPUT_SIGNAL, {
        signal: [
          { timeNs: 5, value: ONE },
          { timeNs: 25, value: ZERO },
          { timeNs: 45, value: ONE },
          { timeNs: 60, value: 'R' }
        ]
      })
      .add('sm', ComponentType.STATE_MACHINE, {
        smInputs: 1,
        smOutputs: 1,
        pinLabels: { in1: 'A', out1: 'Det' },
        smTable: DETECT_101
      })
      .probe('smDet')
      .wire(p('clk', 'out'), p('sm', 'CLK'))
      .wire(p('a', 'out'), p('sm', 'in1'))
      .wire(p('sm', 'out1'), p('smDet', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 400 })
      .build()
  }

  it('starts undetermined: no row of state 0 resolves while the signal is still Z', () => {
    const c = repeatingDetector()
    expect(c.pin(p('sm', 'in1'))).toBe(Z)
    expect(outs(c, 'sm', 1)).toBe('X')
    expect(activeRow(c, 'sm')).toBeNull()
  })

  it('detects once per repetition, but each cycle start briefly returns the input to Z', () => {
    const c = repeatingDetector()
    for (let i = 0; i < 7; i++) c.step()
    expect(c.time).toBe(135)
    expect(pairs(c, 'smDet')).toEqual([
      [0, X], // no row of state 0 resolves while A is Z
      [6, ZERO], // A = 1 at 5: row 0 is active
      [46, ONE], // state 2 (edges at 20 and 40) with A = 1 at 45
      [61, X], // the cycle restarts at 60: A returns to Z
      [66, ONE], // A = 1 again at 65 (5 ns into the new cycle)
      [81, ZERO], // the edge at 80 leaves state 2
      [106, ONE], // second detection
      [121, X], // second cycle restart
      [126, ONE]
    ])
  })

  it('the clock edge that lands exactly on a cycle restart sees Z and does not advance the state', () => {
    const c = repeatingDetector()
    c.step()
    c.step()
    c.step() // 55: state 2 with A = 1
    expect(smState(c, 'sm')).toBe('2')
    c.step() // 75: the edge at 60 coincided with the restart to Z
    expect(smState(c, 'sm')).toBe('2')
    expect(outs(c, 'sm', 1)).toBe('1') // A = 1 again at 65, still in state 2
  })
})

// ===========================================================================
// 17. Go is relative: finishing a long checker run in two Gos
// ===========================================================================

describe('a checker stream longer than one simulation time limit', () => {
  function longRun(): Circuit {
    const b = new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .add('chk', ComponentType.CHECKER, { chk: chkOf('0110100101', 'X011010010') })
      .add('vcc', ComponentType.VCC)
      .add('ff', ComponentType.D_FLIPFLOP)
      .wire(p('vcc', 'out'), p('ff', 'S'))
      .wire(p('vcc', 'out'), p('ff', 'R'))
      .wire(p('clk', 'out'), p('ff', 'CLK'))
      .wire(p('chk', 'out'), p('ff', 'D'))
      .wire(p('ff', 'Q'), p('chk', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 100 })
    return b.build()
  }

  it('the first Go samples only the slots inside its window', () => {
    const c = longRun()
    c.go()
    expect(c.time).toBe(95)
    expect(c.sim.getCheckerResult()).toEqual({ total: 9, sampled: 4, failures: 0 })
    expect(verdict(c)).toBe('4/9')
  })

  it('a second Go continues from there and finishes the stream', () => {
    const c = longRun()
    c.go()
    c.go()
    expect(c.time).toBe(195)
    expect(c.sim.getCheckerResult()).toEqual({ total: 9, sampled: 9, failures: 0 })
    expect(verdict(c)).toBe('PASS')
  })

  it('mixing Step and Go reaches the same verdict', () => {
    const c = longRun()
    c.step()
    c.step()
    c.go()
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 9, sampled: 9, failures: 0 })
    expect(verdict(c)).toBe('PASS')
  })
})

// ===========================================================================
// 18. Sampling exactly at the instant the circuit output changes
// ===========================================================================

describe('the checker samples the value driven at that very instant', () => {
  /** The '101' detector with a chosen part delay between input and output. */
  function detectorWithDelay(delay: number, chk: { input: string; output: string }): Circuit {
    return new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .add('chk', ComponentType.CHECKER, { chk })
      .add('sm', ComponentType.STATE_MACHINE, {
        smInputs: 1,
        smOutputs: 1,
        pinLabels: { in1: 'A', out1: 'Det' },
        smTable: DETECT_101,
        delay
      })
      .wire(p('clk', 'out'), p('sm', 'CLK'))
      .wire(p('chk', 'out'), p('sm', 'in1'))
      .wire(p('sm', 'out1'), p('chk', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 400 })
      .build()
  }

  it('a machine whose output lands exactly on the sample point is read with its NEW value', () => {
    // Inputs arrive at 20k + 5; with delay 10 the Mealy output settles at 20k + 15,
    // which is the sample instant itself (decision 12).
    const c = detectorWithDelay(10, chkOf('10101', '00101'))
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 5, sampled: 5, failures: 0 })
    expect(verdict(c)).toBe('PASS')
  })

  it('one nanosecond later (delay 11) the checker still sees the old value and both detections are missed', () => {
    const c = detectorWithDelay(11, chkOf('10101', '00101'))
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 5, sampled: 5, failures: 2 })
    expect(verdict(c)).toBe('FAIL')
  })

  it('delay 9 (one nanosecond early) passes as well', () => {
    const c = detectorWithDelay(9, chkOf('10101', '00101'))
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 5, sampled: 5, failures: 0 })
  })

  it('period 2 (drive and sample fall on the same instants) still measures a one-slot delay line', () => {
    // quarter = max(1, round(2/4)) = 1, so slot k is driven at 2k + 1 and slot k-1
    // is sampled at the same instant; the flip-flop's Q also changes there.
    const c = delayLine(chkOf(STREAM, shifted(1)), 1, 2, 20)
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 7, sampled: 7, failures: 0 })
    expect(verdict(c)).toBe('PASS')
  })
})

// ===========================================================================
// 19. 'R' in the very first slot
// ===========================================================================

describe("an 'R' in slot 0", () => {
  it('leaves the circuit in the power-up state the reset already put it in', () => {
    const c = toggleUnderChecker(chkOf('R0000000', 'X0101010'), false)
    // Slot 0 drives X from t = 0; the toggle is cleared by its own reset pulse at
    // t = 0 and then divides the clock exactly as it would without the R.
    for (let i = 0; i < 8; i++) c.step()
    expect(c.sim.getCheckerResult()).toEqual({ total: 7, sampled: 7, failures: 0 })
    expect(verdict(c)).toBe('PASS')
  })

  it('drives X on the checker output during slot 0', () => {
    const c = toggleUnderChecker(chkOf('R0000000', 'XXXXXXXX'), false)
    expect(c.pin(p('chk', 'out'))).toBe(X)
    c.step()
    expect(valueAt(c, 'pOut', 15)).toBe(X)
  })

  it('a state machine is in its initial state at t = 0 either way', () => {
    const withR = checkedDetector(chkOf('R101', 'XXXX'))
    const without = checkedDetector(chkOf('X101', 'XXXX'))
    expect(smState(withR, 'sm')).toBe(smState(without, 'sm'))
    withR.go()
    without.go()
    expect(smState(withR, 'sm')).toBe(smState(without, 'sm'))
  })
})

// ===========================================================================
// 20. All three stimulus sources at once: CLOCK + INPUT_SIGNAL + CHECKER
// ===========================================================================

/**
 * The checker drives the detector's data input while an INPUT_SIGNAL gates the
 * clock through an AND gate: the machine only advances while En is high, so the
 * state freezes for three slots in the middle of the stream.
 */
function gatedDetector(chk: { input: string; output: string }): Circuit {
  return new CircuitBuilder()
    .add('clk', ComponentType.CLOCK)
    .add('en', ComponentType.INPUT_SIGNAL, { signal: [sig(0, ONE), sig(65, ZERO), sig(135, ONE)] })
    .add('gate', ComponentType.AND2)
    .add('chk', ComponentType.CHECKER, { chk })
    .add('sm', ComponentType.STATE_MACHINE, {
      smInputs: 1,
      smOutputs: 1,
      pinLabels: { in1: 'A', out1: 'Det' },
      smTable: DETECT_101
    })
    .probe('pClk')
    .wire(p('clk', 'out'), p('gate', 'in1'))
    .wire(p('en', 'out'), p('gate', 'in2'))
    .wire(p('gate', 'out'), p('sm', 'CLK'))
    .wire(p('gate', 'out'), p('pClk', 'in'))
    .wire(p('chk', 'out'), p('sm', 'in1'))
    .wire(p('sm', 'out1'), p('chk', 'in'))
    .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 200 })
    .build()
}

describe('a gated clock between the CLOCK part and the machine', () => {
  it('the gated clock only pulses while En is high', () => {
    const c = gatedDetector(chkOf('10101101', 'XXXXXXXX'))
    c.go()
    expect(pairs(c, 'pClk')).toEqual([
      [0, ONE],
      [11, ZERO],
      [21, ONE],
      [31, ZERO],
      [41, ONE],
      [51, ZERO],
      [61, ONE],
      [66, ZERO], // En drops mid-period
      [141, ONE], // En is back before the edge at 140
      [151, ZERO],
      [161, ONE],
      [171, ZERO],
      [181, ONE],
      [191, ZERO]
    ])
  })

  it('the machine freezes while the clock is gated off and passes the matching expectation', () => {
    const c = gatedDetector(chkOf('10101101', '00100001'))
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 8, sampled: 8, failures: 0 })
    expect(verdict(c)).toBe('PASS')
  })

  it('the expectation for an ungated clock fails in exactly the slot the freeze removes', () => {
    const c = gatedDetector(chkOf('10101101', '00101001'))
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 8, sampled: 8, failures: 1 })
    expect(verdict(c)).toBe('FAIL')
  })

  it('the state display holds still through the three gated-off slots', () => {
    const c = gatedDetector(chkOf('10101101', 'XXXXXXXX'))
    const seen: string[] = []
    for (let i = 0; i < 8; i++) {
      c.step()
      seen.push(smState(c, 'sm'))
    }
    // Edges at 21, 41 and 61 advance the machine; then nothing until 141.
    expect(seen).toEqual(['0', '1', '2', '1', '1', '1', '1', '2'])
  })
})

// ===========================================================================
// 21. A checker over a sequential circuit that has no CLOCK part
// ===========================================================================

describe('the checker without a CLOCK part in the circuit', () => {
  it('an unclocked Mealy machine never leaves state 0, so it never detects', () => {
    const c = new CircuitBuilder()
      .add('chk', ComponentType.CHECKER, { chk: chkOf('10101', '00000') })
      .add('sm', ComponentType.STATE_MACHINE, {
        smInputs: 1,
        smOutputs: 1,
        pinLabels: { in1: 'A', out1: 'Det' },
        smTable: DETECT_101
      })
      .wire(p('chk', 'out'), p('sm', 'in1'))
      .wire(p('sm', 'out1'), p('chk', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 200 })
      .build()
    expect(c.pin(p('sm', 'CLK'))).toBe(Z)
    c.go()
    expect(c.time).toBe(200) // no clock: Go simply runs the whole time limit
    expect(smState(c, 'sm')).toBe('0')
    expect(c.sim.getCheckerResult()).toEqual({ total: 5, sampled: 5, failures: 0 })
    expect(verdict(c)).toBe('PASS')
  })

  it('a machine clocked by an INPUT_SIGNAL on the same grid gives the same verdict as the CLOCK part', () => {
    const rows: SignalRow[] = [sig(0, ZERO)]
    for (let k = 1; k <= 5; k++) rows.push(sig(20 * k, ONE), sig(20 * k + 10, ZERO))
    const c = new CircuitBuilder()
      .add('chk', ComponentType.CHECKER, { chk: chkOf('10101', '00101') })
      .add('sigClk', ComponentType.INPUT_SIGNAL, { signal: rows })
      .add('sm', ComponentType.STATE_MACHINE, {
        smInputs: 1,
        smOutputs: 1,
        pinLabels: { in1: 'A', out1: 'Det' },
        smTable: DETECT_101
      })
      .wire(p('sigClk', 'out'), p('sm', 'CLK'))
      .wire(p('chk', 'out'), p('sm', 'in1'))
      .wire(p('sm', 'out1'), p('chk', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 200 })
      .build()
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 5, sampled: 5, failures: 0 })
    expect(verdict(c)).toBe('PASS')
    expect(smState(c, 'sm')).toBe('1')

    // The same stream under the CLOCK part reaches the same verdict and state.
    const clocked = checkedDetector(chkOf('10101', '00101'))
    clocked.go()
    expect(clocked.sim.getCheckerResult()).toEqual({ total: 5, sampled: 5, failures: 0 })
    expect(smState(clocked, 'sm')).toBe('1')
  })
})
