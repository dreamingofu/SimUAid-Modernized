// Memory elements assembled out of gates: NOR / NAND SR latches, gated D and
// gated SR latches, master-slave flip-flops, T and J-K flip-flops built from
// other parts, level- versus edge-sensitivity, and inverter rings.
//
// Everything here is judged against textbook gate-level behavior driven by the
// manual's logic-value rules (§1.9: a gate with an X/Z input that is not
// controlled by another input outputs X) plus the recorded decisions on
// same-instant events (1), inertial output delay (2) and wired-net resolution
// (3). Where an equivalent built-in part exists the composite is compared with
// it over long pseudo-random sequences.
//
// Local helpers (not in harness.ts): `addValueSource` builds a net that can be
// driven 0 / 1 / X / Z from two conflicting tristates, `settleNor` / `settleNand`
// are fixed-point latch models written on top of the pure evalGate, and `lcg`
// is a seeded generator so the long sequences are reproducible.

import { describe, expect, it } from 'vitest'
import { ComponentType, LogicValue, type PinId } from '../../model/types'
import { evalGate } from '../logic'
import { CircuitBuilder, Circuit, p } from './harness'

const { ZERO, ONE, X, Z } = LogicValue

const bit = (n: number): LogicValue => (n & 1 ? ONE : ZERO)
const inv = (v: LogicValue): LogicValue => (v === ONE ? ZERO : v === ZERO ? ONE : X)

/** Deterministic 31-bit LCG (same shape as the one used elsewhere in the suite). */
function lcg(seed: number): () => number {
  let s = seed
  return (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return (s >> 8) & 0x7fffff
  }
}

const trace = (c: Circuit, probeId: string): [number, LogicValue][] =>
  c.sim.getWaveforms().find((w) => w.probeId === probeId)!.samples.map((s) => [s.t, s.v])

// --------------------------------------------------------------- builders

/**
 * A net that can present any of the four logic values: two tristates, one tied
 * to ground and one to +V, whose outputs share a net. Both off -> Z (no driver),
 * one on -> that level, both on -> X (conflicting drivers, decision 3).
 */
function addValueSource(b: CircuitBuilder, id: string): PinId {
  b.add(`${id}V`, ComponentType.VCC)
    .add(`${id}G`, ComponentType.GROUND)
    .switch(`${id}en0`, ZERO)
    .switch(`${id}en1`, ZERO)
    .add(`${id}t0`, ComponentType.TRISTATE_RIGHT)
    .add(`${id}t1`, ComponentType.TRISTATE_RIGHT)
    .wire(p(`${id}G`, 'out'), p(`${id}t0`, 'in'))
    .wire(p(`${id}en0`, 'out'), p(`${id}t0`, 'ctl'))
    .wire(p(`${id}V`, 'out'), p(`${id}t1`, 'in'))
    .wire(p(`${id}en1`, 'out'), p(`${id}t1`, 'ctl'))
    .wire(p(`${id}t0`, 'out'), p(`${id}t1`, 'out'))
  return p(`${id}t0`, 'out')
}

function setSource(c: Circuit, id: string, v: LogicValue): void {
  c.setMany({
    [`${id}en0`]: v === ZERO || v === X ? ONE : ZERO,
    [`${id}en1`]: v === ONE || v === X ? ONE : ZERO
  })
}

interface LatchDelays {
  qDelay?: number
  qnDelay?: number
}

const Q = p('q', 'out')
const QN = p('qn', 'out')

/** Q = NOR(R, Q'), Q' = NOR(S, Q); active-high S and R on switches. */
function norLatchBuilder(s: LogicValue, r: LogicValue, d: LatchDelays = {}): CircuitBuilder {
  return new CircuitBuilder()
    .switch('s', s)
    .switch('r', r)
    .add('q', ComponentType.NOR2, { delay: d.qDelay ?? 1 })
    .add('qn', ComponentType.NOR2, { delay: d.qnDelay ?? 1 })
    .wire(p('r', 'out'), p('q', 'in1'))
    .wire(p('qn', 'out'), p('q', 'in2'))
    .wire(p('s', 'out'), p('qn', 'in1'))
    .wire(p('q', 'out'), p('qn', 'in2'))
}

const norLatch = (s: LogicValue = ZERO, r: LogicValue = ZERO, d: LatchDelays = {}): Circuit =>
  norLatchBuilder(s, r, d).build()

/** Q = NAND(S', Q'), Q' = NAND(R', Q); active-low S' and R' on switches. */
function nandLatchBuilder(sn: LogicValue, rn: LogicValue, d: LatchDelays = {}): CircuitBuilder {
  return new CircuitBuilder()
    .switch('s', sn)
    .switch('r', rn)
    .add('q', ComponentType.NAND2, { delay: d.qDelay ?? 1 })
    .add('qn', ComponentType.NAND2, { delay: d.qnDelay ?? 1 })
    .wire(p('s', 'out'), p('q', 'in1'))
    .wire(p('qn', 'out'), p('q', 'in2'))
    .wire(p('r', 'out'), p('qn', 'in1'))
    .wire(p('q', 'out'), p('qn', 'in2'))
}

const nandLatch = (sn: LogicValue = ONE, rn: LogicValue = ONE, d: LatchDelays = {}): Circuit =>
  nandLatchBuilder(sn, rn, d).build()

/** Classic 4-NAND gated D latch: a=NAND(D,E), b=NAND(a,E), Q=NAND(a,Q'), Q'=NAND(b,Q). */
function addGatedDLatch(b: CircuitBuilder, id: string, d: PinId, e: PinId, delay = 1): void {
  b.add(`${id}a`, ComponentType.NAND2, { delay })
    .add(`${id}b`, ComponentType.NAND2, { delay })
    .add(`${id}q`, ComponentType.NAND2, { delay })
    .add(`${id}n`, ComponentType.NAND2, { delay })
    .wire(d, p(`${id}a`, 'in1'))
    .wire(e, p(`${id}a`, 'in2'))
    .wire(p(`${id}a`, 'out'), p(`${id}b`, 'in1'))
    .wire(e, p(`${id}b`, 'in2'))
    .wire(p(`${id}a`, 'out'), p(`${id}q`, 'in1'))
    .wire(p(`${id}n`, 'out'), p(`${id}q`, 'in2'))
    .wire(p(`${id}b`, 'out'), p(`${id}n`, 'in1'))
    .wire(p(`${id}q`, 'out'), p(`${id}n`, 'in2'))
}

/** Gated SR latch: a=NAND(S,E), b=NAND(R,E), Q=NAND(a,Q'), Q'=NAND(b,Q). */
function addGatedSrLatch(
  b: CircuitBuilder,
  id: string,
  s: PinId,
  r: PinId,
  e: PinId,
  d: LatchDelays = {}
): void {
  b.add(`${id}a`, ComponentType.NAND2)
    .add(`${id}b`, ComponentType.NAND2)
    .add(`${id}q`, ComponentType.NAND2, { delay: d.qDelay ?? 1 })
    .add(`${id}n`, ComponentType.NAND2, { delay: d.qnDelay ?? 1 })
    .wire(s, p(`${id}a`, 'in1'))
    .wire(e, p(`${id}a`, 'in2'))
    .wire(r, p(`${id}b`, 'in1'))
    .wire(e, p(`${id}b`, 'in2'))
    .wire(p(`${id}a`, 'out'), p(`${id}q`, 'in1'))
    .wire(p(`${id}n`, 'out'), p(`${id}q`, 'in2'))
    .wire(p(`${id}b`, 'out'), p(`${id}n`, 'in1'))
    .wire(p(`${id}q`, 'out'), p(`${id}n`, 'in2'))
}

/** A D flip-flop with S and R held inactive (high) by a shared +V part. */
function addDff(b: CircuitBuilder, id: string, vcc = 'vcc'): void {
  b.add(id, ComponentType.D_FLIPFLOP)
    .wire(p(vcc, 'out'), p(id, 'S'))
    .wire(p(vcc, 'out'), p(id, 'R'))
}

// --------------------------------------------------------------- pure models

/**
 * Fixed point of the two NOR equations, evaluated with the pure gate function.
 * Both outputs update simultaneously, which is exactly what the engine does when
 * a driver change makes both gates re-evaluate at the same instant.
 */
function settleNor(q: LogicValue, qn: LogicValue, s: LogicValue, r: LogicValue): [LogicValue, LogicValue] {
  for (let i = 0; i < 64; i++) {
    const nq = evalGate('nor', [r, qn])
    const nqn = evalGate('nor', [s, q])
    if (nq === q && nqn === qn) return [q, qn]
    q = nq
    qn = nqn
  }
  throw new Error('NOR latch model never settled (symmetric race)')
}

function settleNand(q: LogicValue, qn: LogicValue, sn: LogicValue, rn: LogicValue): [LogicValue, LogicValue] {
  for (let i = 0; i < 64; i++) {
    const nq = evalGate('nand', [sn, qn])
    const nqn = evalGate('nand', [rn, q])
    if (nq === q && nqn === qn) return [q, qn]
    q = nq
    qn = nqn
  }
  throw new Error('NAND latch model never settled (symmetric race)')
}

// =========================================================== NOR SR latch

describe('NOR SR latch (Q = NOR(R, Q\'), Q\' = NOR(S, Q))', () => {
  it('powers up undetermined on both outputs and does not oscillate', () => {
    const c = norLatch()
    expect(c.pin(Q)).toBe(X)
    expect(c.pin(QN)).toBe(X)
    expect(c.oscillated).toBe(false)
    expect(c.time).toBe(0)
  })

  it('a NOR latch whose S and R pins are left unconnected reads X on both outputs', () => {
    const c = new CircuitBuilder()
      .add('q', ComponentType.NOR2)
      .add('qn', ComponentType.NOR2)
      .wire(p('qn', 'out'), p('q', 'in2'))
      .wire(p('q', 'out'), p('qn', 'in2'))
      .build()
    expect(c.pin(p('q', 'in1'))).toBe(Z)
    expect(c.pin(p('qn', 'in1'))).toBe(Z)
    expect(c.pin(Q)).toBe(X)
    expect(c.pin(QN)).toBe(X)
    expect(c.oscillated).toBe(false)
  })

  const fromSet = (): Circuit => {
    const c = norLatch()
    c.set('s', ONE)
    c.set('s', ZERO)
    return c
  }
  const fromReset = (): Circuit => {
    const c = norLatch()
    c.set('r', ONE)
    c.set('r', ZERO)
    return c
  }

  it('S = 1 sets the latch and the state survives S returning to 0', () => {
    const c = fromSet()
    expect(c.pin(Q)).toBe(ONE)
    expect(c.pin(QN)).toBe(ZERO)
  })

  it('R = 1 resets the latch and the state survives R returning to 0', () => {
    const c = fromReset()
    expect(c.pin(Q)).toBe(ZERO)
    expect(c.pin(QN)).toBe(ONE)
  })

  // prior state, S, R, expected Q, expected Q'
  const matrix: Array<[string, LogicValue, LogicValue, LogicValue, LogicValue]> = [
    ['set', ZERO, ZERO, ONE, ZERO],
    ['set', ONE, ZERO, ONE, ZERO],
    ['set', ZERO, ONE, ZERO, ONE],
    ['set', ONE, ONE, ZERO, ZERO],
    ['reset', ZERO, ZERO, ZERO, ONE],
    ['reset', ONE, ZERO, ONE, ZERO],
    ['reset', ZERO, ONE, ZERO, ONE],
    ['reset', ONE, ONE, ZERO, ZERO]
  ]

  it.each(matrix)('from the %s state, S=%s R=%s gives Q=%s and Q\'=%s', (prior, s, r, eq, eqn) => {
    const c = prior === 'set' ? fromSet() : fromReset()
    c.setMany({ s, r })
    expect(c.pin(Q)).toBe(eq)
    expect(c.pin(QN)).toBe(eqn)
    expect(c.oscillated).toBe(false)
  })

  it.each(matrix.filter(([, s, r]) => !(s === ONE && r === ONE)))(
    'from the %s state, S=%s R=%s keeps Q and Q\' complementary',
    (prior, s, r) => {
      const c = prior === 'set' ? fromSet() : fromReset()
      c.setMany({ s, r })
      expect(c.pin(QN)).toBe(inv(c.pin(Q)))
    }
  )

  it('S = R = 1 drives both outputs low, so Q and Q\' are NOT complementary', () => {
    const c = norLatch()
    c.setMany({ s: ONE, r: ONE })
    expect(c.pin(Q)).toBe(ZERO)
    expect(c.pin(QN)).toBe(ZERO)
  })

  it('outputs change exactly one gate delay after the input that caused them', () => {
    const b = norLatchBuilder(ZERO, ZERO)
    b.probe('pq').probe('pqn').wire(p('q', 'out'), p('pq', 'in')).wire(p('qn', 'out'), p('pqn', 'in'))
    const c = b.build()
    // S feeds the Q' gate, so Q' moves first and Q follows one gate later.
    c.set('s', ONE) // switch at 1, Q' at 2, Q at 3
    expect(c.time).toBe(3)
    c.set('s', ZERO) // switch at 4, nothing else changes
    expect(c.time).toBe(4)
    c.set('r', ONE) // switch at 5, Q at 6, Q' at 7
    expect(c.time).toBe(7)
    expect(trace(c, 'pq')).toEqual([
      [0, X],
      [3, ONE],
      [6, ZERO]
    ])
    expect(trace(c, 'pqn')).toEqual([
      [0, X],
      [2, ZERO],
      [7, ONE]
    ])
  })

  it('a set pulse shorter than the loop delay still latches (the loop holds it)', () => {
    const c = norLatch()
    c.setMany({ s: ONE }) // one instant of S = 1 is enough to flip Q
    c.setMany({ s: ZERO })
    expect(c.pin(Q)).toBe(ONE)
    expect(c.pin(QN)).toBe(ZERO)
  })
})

const SR_PAIRS: Array<[LogicValue, LogicValue]> = [
  [ZERO, ZERO],
  [ZERO, ONE],
  [ONE, ZERO],
  [ONE, ONE]
]

/** All input sequences of `steps` (S, R) pairs, minus the ones that release the forbidden state symmetrically. */
function inputSequences(
  steps: number,
  forbidden: [LogicValue, LogicValue],
  released: [LogicValue, LogicValue],
  label: string
): Array<[string, Array<[LogicValue, LogicValue]>]> {
  const out: Array<[string, Array<[LogicValue, LogicValue]>]> = []
  const walk = (seq: Array<[LogicValue, LogicValue]>): void => {
    if (seq.length === steps) {
      // A simultaneous release of the forbidden state is a symmetric race with
      // no fixed point; it is covered on its own below.
      const racy = seq.some(
        (v, i) =>
          i > 0 &&
          seq[i - 1][0] === forbidden[0] &&
          seq[i - 1][1] === forbidden[1] &&
          v[0] === released[0] &&
          v[1] === released[1]
      )
      if (!racy) out.push([seq.map(([s, r]) => `${label}=${s}${r}`).join(' -> '), [...seq]])
      return
    }
    for (const pair of SR_PAIRS) walk([...seq, pair])
  }
  walk([])
  return out
}

describe('NOR SR latch: exhaustive four-step input sequences match the gate-level model', () => {
  const seqs = inputSequences(4, [ONE, ONE], [ZERO, ZERO], 'SR')

  it.each(seqs)('%s', (_name, seq) => {
    const c = norLatch()
    let q: LogicValue = X
    let qn: LogicValue = X
    for (const [s, r] of seq) {
      c.setMany({ s, r })
      ;[q, qn] = settleNor(q, qn, s, r)
      expect(c.oscillated).toBe(false)
      expect(c.pin(Q)).toBe(q)
      expect(c.pin(QN)).toBe(qn)
    }
  })
})

describe('NOR SR latch with X and Z on its inputs', () => {
  function latch(): Circuit {
    const b = new CircuitBuilder().add('q', ComponentType.NOR2).add('qn', ComponentType.NOR2)
    const s = addValueSource(b, 's')
    const r = addValueSource(b, 'r')
    b.wire(r, p('q', 'in1')).wire(p('qn', 'out'), p('q', 'in2')).wire(s, p('qn', 'in1')).wire(p('q', 'out'), p('qn', 'in2'))
    return b.build()
  }

  const set = (c: Circuit): void => {
    setSource(c, 's', ONE)
    setSource(c, 'r', ZERO)
    setSource(c, 's', ZERO)
  }
  const reset = (c: Circuit): void => {
    setSource(c, 'r', ONE)
    setSource(c, 's', ZERO)
    setSource(c, 'r', ZERO)
  }

  it('both inputs floating at power-up leaves both outputs X', () => {
    const c = latch()
    expect(c.pin(p('q', 'in1'))).toBe(Z)
    expect(c.pin(Q)).toBe(X)
    expect(c.pin(QN)).toBe(X)
  })

  it.each([[X], [Z]])('R = %s while the latch is reset is masked by the 1 on Q\'', (bad) => {
    const c = latch()
    reset(c)
    setSource(c, 'r', bad)
    expect(c.pin(Q)).toBe(ZERO)
    expect(c.pin(QN)).toBe(ONE)
  })

  it.each([[X], [Z]])('R = %s while the latch is set makes both outputs X', (bad) => {
    const c = latch()
    set(c)
    setSource(c, 'r', bad)
    expect(c.pin(Q)).toBe(X)
    expect(c.pin(QN)).toBe(X)
  })

  it.each([[X], [Z]])('S = %s while the latch is set is masked by the 1 on Q', (bad) => {
    const c = latch()
    set(c)
    setSource(c, 's', bad)
    expect(c.pin(Q)).toBe(ONE)
    expect(c.pin(QN)).toBe(ZERO)
  })

  it.each([[X], [Z]])('S = %s while the latch is reset makes both outputs X', (bad) => {
    const c = latch()
    reset(c)
    setSource(c, 's', bad)
    expect(c.pin(Q)).toBe(X)
    expect(c.pin(QN)).toBe(X)
  })

  it.each([[X], [Z]])('S = 1 with R = %s forces Q\' low but leaves Q undetermined', (bad) => {
    const c = latch()
    reset(c)
    setSource(c, 'r', bad)
    setSource(c, 's', ONE)
    expect(c.pin(QN)).toBe(ZERO)
    expect(c.pin(Q)).toBe(X)
  })

  it.each([[X], [Z]])('R = 1 with S = %s forces Q low but leaves Q\' undetermined', (bad) => {
    const c = latch()
    set(c)
    setSource(c, 's', bad)
    setSource(c, 'r', ONE)
    expect(c.pin(Q)).toBe(ZERO)
    expect(c.pin(QN)).toBe(X)
  })

  it.each([[X], [Z]])('both inputs %s from a set state makes both outputs X', (bad) => {
    const c = latch()
    set(c)
    setSource(c, 's', bad)
    setSource(c, 'r', bad)
    expect(c.pin(Q)).toBe(X)
    expect(c.pin(QN)).toBe(X)
  })

  it('an X on R clears once R is driven 0 again and the latch is re-set', () => {
    const c = latch()
    set(c)
    setSource(c, 'r', X)
    expect(c.pin(Q)).toBe(X)
    setSource(c, 'r', ZERO)
    expect(c.pin(Q)).toBe(X) // X is latched: the loop has no way back on its own
    setSource(c, 's', ONE)
    expect(c.pin(Q)).toBe(ONE)
    setSource(c, 's', ZERO)
    expect(c.pin(Q)).toBe(ONE)
    expect(c.pin(QN)).toBe(ZERO)
  })
})

// =========================================================== NAND SR latch

describe("NAND SR latch (active-low inputs, Q = NAND(S', Q'), Q' = NAND(R', Q))", () => {
  it('powers up undetermined with both inputs inactive', () => {
    const c = nandLatch()
    expect(c.pin(Q)).toBe(X)
    expect(c.pin(QN)).toBe(X)
    expect(c.oscillated).toBe(false)
  })

  const fromSet = (): Circuit => {
    const c = nandLatch()
    c.set('s', ZERO)
    c.set('s', ONE)
    return c
  }
  const fromReset = (): Circuit => {
    const c = nandLatch()
    c.set('r', ZERO)
    c.set('r', ONE)
    return c
  }

  const matrix: Array<[string, LogicValue, LogicValue, LogicValue, LogicValue]> = [
    ['set', ONE, ONE, ONE, ZERO],
    ['set', ZERO, ONE, ONE, ZERO],
    ['set', ONE, ZERO, ZERO, ONE],
    ['set', ZERO, ZERO, ONE, ONE],
    ['reset', ONE, ONE, ZERO, ONE],
    ['reset', ZERO, ONE, ONE, ZERO],
    ['reset', ONE, ZERO, ZERO, ONE],
    ['reset', ZERO, ZERO, ONE, ONE]
  ]

  it.each(matrix)("from the %s state, S'=%s R'=%s gives Q=%s and Q'=%s", (prior, sn, rn, eq, eqn) => {
    const c = prior === 'set' ? fromSet() : fromReset()
    c.setMany({ s: sn, r: rn })
    expect(c.pin(Q)).toBe(eq)
    expect(c.pin(QN)).toBe(eqn)
    expect(c.oscillated).toBe(false)
  })

  it("S' = R' = 0 drives both outputs high (the forbidden state)", () => {
    const c = nandLatch()
    c.setMany({ s: ZERO, r: ZERO })
    expect(c.pin(Q)).toBe(ONE)
    expect(c.pin(QN)).toBe(ONE)
  })

  it('a single-instant active-low set pulse latches', () => {
    const c = nandLatch()
    c.setMany({ s: ZERO })
    c.setMany({ s: ONE })
    expect(c.pin(Q)).toBe(ONE)
    expect(c.pin(QN)).toBe(ZERO)
  })

  it("an X on S' while the latch is set is masked by the 0 on Q'", () => {
    const b = new CircuitBuilder().switch('r', ONE).add('q', ComponentType.NAND2).add('qn', ComponentType.NAND2)
    const s = addValueSource(b, 's')
    b.wire(s, p('q', 'in1'))
      .wire(p('qn', 'out'), p('q', 'in2'))
      .wire(p('r', 'out'), p('qn', 'in1'))
      .wire(p('q', 'out'), p('qn', 'in2'))
    const c = b.build()
    setSource(c, 's', ZERO) // set
    setSource(c, 's', ONE)
    expect(c.pin(Q)).toBe(ONE)
    setSource(c, 's', X)
    expect(c.pin(Q)).toBe(ONE)
    expect(c.pin(QN)).toBe(ZERO)
  })

  it("an X on S' while the latch is reset makes both outputs X", () => {
    const b = new CircuitBuilder().switch('r', ONE).add('q', ComponentType.NAND2).add('qn', ComponentType.NAND2)
    const s = addValueSource(b, 's')
    b.wire(s, p('q', 'in1'))
      .wire(p('qn', 'out'), p('q', 'in2'))
      .wire(p('r', 'out'), p('qn', 'in1'))
      .wire(p('q', 'out'), p('qn', 'in2'))
    const c = b.build()
    setSource(c, 's', ONE)
    c.set('r', ZERO) // reset
    c.set('r', ONE)
    expect(c.pin(Q)).toBe(ZERO)
    setSource(c, 's', X)
    expect(c.pin(Q)).toBe(X)
    expect(c.pin(QN)).toBe(X)
  })
})

describe('NAND SR latch: exhaustive four-step input sequences match the gate-level model', () => {
  const seqs = inputSequences(4, [ZERO, ZERO], [ONE, ONE], "S'R'")

  it.each(seqs)('%s', (_name, seq) => {
    const c = nandLatch()
    let q: LogicValue = X
    let qn: LogicValue = X
    for (const [sn, rn] of seq) {
      c.setMany({ s: sn, r: rn })
      ;[q, qn] = settleNand(q, qn, sn, rn)
      expect(c.oscillated).toBe(false)
      expect(c.pin(Q)).toBe(q)
      expect(c.pin(QN)).toBe(qn)
    }
  })
})

// ================================================= releasing the forbidden state

describe('releasing the forbidden state of an SR latch', () => {
  it('NOR latch: releasing S and R at the same instant with equal delays never settles', () => {
    const c = norLatch()
    c.setMany({ s: ONE, r: ONE })
    expect(c.pin(Q)).toBe(ZERO)
    expect(c.pin(QN)).toBe(ZERO)
    c.setMany({ s: ZERO, r: ZERO })
    // A perfectly symmetric race: both NORs see (0, 0), both go high, both go
    // low again, forever. The engine must stop and report the loop as
    // undetermined rather than hang. This is the gate-level analogue of
    // decision 1 (a flip-flop part with S and R released together leaves Q = X).
    expect(c.oscillated).toBe(true)
    expect(c.pin(Q)).toBe(X)
    expect(c.pin(QN)).toBe(X)
  })

  it('NOR latch: releasing R first (S still 1) leaves the latch set', () => {
    const c = norLatch()
    c.setMany({ s: ONE, r: ONE })
    c.set('r', ZERO)
    expect(c.pin(Q)).toBe(ONE)
    expect(c.pin(QN)).toBe(ZERO)
    c.set('s', ZERO)
    expect(c.pin(Q)).toBe(ONE)
    expect(c.pin(QN)).toBe(ZERO)
    expect(c.oscillated).toBe(false)
  })

  it('NOR latch: releasing S first (R still 1) leaves the latch reset', () => {
    const c = norLatch()
    c.setMany({ s: ONE, r: ONE })
    c.set('s', ZERO)
    expect(c.pin(Q)).toBe(ZERO)
    expect(c.pin(QN)).toBe(ONE)
    c.set('r', ZERO)
    expect(c.pin(Q)).toBe(ZERO)
    expect(c.pin(QN)).toBe(ONE)
    expect(c.oscillated).toBe(false)
  })

  it('NOR latch: a simultaneous release resolves deterministically when the Q gate is faster', () => {
    const c = norLatch(ZERO, ZERO, { qDelay: 1, qnDelay: 2 })
    c.setMany({ s: ONE, r: ONE })
    expect(c.pin(Q)).toBe(ZERO)
    expect(c.pin(QN)).toBe(ZERO)
    c.setMany({ s: ZERO, r: ZERO })
    // The faster gate reaches 1 first and its output cancels the slower gate's
    // still-pending change (decision 2, inertial delay).
    expect(c.oscillated).toBe(false)
    expect(c.pin(Q)).toBe(ONE)
    expect(c.pin(QN)).toBe(ZERO)
  })

  it("NOR latch: a simultaneous release resolves the other way when the Q' gate is faster", () => {
    const c = norLatch(ZERO, ZERO, { qDelay: 3, qnDelay: 1 })
    c.setMany({ s: ONE, r: ONE })
    c.setMany({ s: ZERO, r: ZERO })
    expect(c.oscillated).toBe(false)
    expect(c.pin(Q)).toBe(ZERO)
    expect(c.pin(QN)).toBe(ONE)
  })

  it('NAND latch: releasing both active-low inputs at once never settles', () => {
    const c = nandLatch()
    c.setMany({ s: ZERO, r: ZERO })
    expect(c.pin(Q)).toBe(ONE)
    expect(c.pin(QN)).toBe(ONE)
    c.setMany({ s: ONE, r: ONE })
    expect(c.oscillated).toBe(true)
    expect(c.pin(Q)).toBe(X)
    expect(c.pin(QN)).toBe(X)
  })

  it("NAND latch: releasing R' first (S' still 0) leaves the latch set", () => {
    const c = nandLatch()
    c.setMany({ s: ZERO, r: ZERO })
    c.set('r', ONE)
    expect(c.pin(Q)).toBe(ONE)
    expect(c.pin(QN)).toBe(ZERO)
    c.set('s', ONE)
    expect(c.pin(Q)).toBe(ONE)
    expect(c.pin(QN)).toBe(ZERO)
  })

  it("NAND latch: releasing S' first (R' still 0) leaves the latch reset", () => {
    const c = nandLatch()
    c.setMany({ s: ZERO, r: ZERO })
    c.set('s', ONE)
    expect(c.pin(Q)).toBe(ZERO)
    expect(c.pin(QN)).toBe(ONE)
    c.set('r', ONE)
    expect(c.pin(Q)).toBe(ZERO)
    expect(c.pin(QN)).toBe(ONE)
  })

  it('NAND latch: unequal gate delays make a simultaneous release deterministic', () => {
    const c = nandLatch(ONE, ONE, { qDelay: 1, qnDelay: 2 })
    c.setMany({ s: ZERO, r: ZERO })
    c.setMany({ s: ONE, r: ONE })
    expect(c.oscillated).toBe(false)
    expect(c.pin(Q)).toBe(ZERO)
    expect(c.pin(QN)).toBe(ONE)
  })
})

// =========================================================== gated D latch

describe('gated D latch built from four NANDs', () => {
  function latch(d: LogicValue = ZERO, e: LogicValue = ZERO, delay = 1): Circuit {
    const b = new CircuitBuilder().switch('d', d).switch('e', e)
    addGatedDLatch(b, 'l', p('d', 'out'), p('e', 'out'), delay)
    return b.build()
  }
  const LQ = p('lq', 'out')
  const LQN = p('ln', 'out')

  it('powers up undetermined while the enable is low', () => {
    const c = latch()
    expect(c.pin(LQ)).toBe(X)
    expect(c.pin(LQN)).toBe(X)
  })

  it.each([
    [ZERO, ZERO],
    [ZERO, ONE],
    [ONE, ZERO],
    [ONE, ONE]
  ])('is transparent while E = 1: from stored %s, D = %s appears on Q', (stored, d) => {
    const c = latch(stored, ONE)
    expect(c.pin(LQ)).toBe(stored) // enabled at power-up, so Q already follows D
    c.set('d', d)
    expect(c.pin(LQ)).toBe(d)
    expect(c.pin(LQN)).toBe(inv(d))
  })

  it.each([
    [ZERO, ZERO],
    [ZERO, ONE],
    [ONE, ZERO],
    [ONE, ONE]
  ])('holds while E = 0: stored %s survives D = %s', (stored, d) => {
    const c = latch(stored, ONE)
    c.set('e', ZERO)
    c.set('d', d)
    expect(c.pin(LQ)).toBe(stored)
    expect(c.pin(LQN)).toBe(inv(stored))
  })

  it('holds through many D changes while E = 0 and re-opens on E = 1', () => {
    const c = latch(ONE, ONE)
    expect(c.pin(LQ)).toBe(ONE)
    c.set('e', ZERO)
    for (let i = 0; i < 8; i++) {
      c.set('d', bit(i))
      expect(c.pin(LQ)).toBe(ONE)
      expect(c.pin(LQN)).toBe(ZERO)
    }
    c.set('e', ONE)
    expect(c.pin(LQ)).toBe(c.pin(p('d', 'out')))
  })

  it.each([
    [ZERO, ONE],
    [ONE, ZERO]
  ])('D changing at the same instant E falls stores the OLD D (stored %s, D -> %s)', (stored, next) => {
    const c = latch(stored, ONE)
    expect(c.pin(LQ)).toBe(stored)
    c.setMany({ e: ZERO, d: next })
    expect(c.pin(LQ)).toBe(stored)
    expect(c.pin(LQN)).toBe(inv(stored))
  })

  it.each([
    [ZERO, ONE],
    [ONE, ZERO]
  ])('D changing at the same instant E rises stores the NEW D (stored %s, D -> %s)', (stored, next) => {
    const c = latch(stored, ONE)
    c.set('e', ZERO)
    c.setMany({ e: ONE, d: next })
    expect(c.pin(LQ)).toBe(next)
    expect(c.pin(LQN)).toBe(inv(next))
  })

  it('a D pulse narrower than the latch loop while E = 1 still ends on the final D', () => {
    const c = latch(ZERO, ONE)
    c.setMany({ d: ONE })
    c.setMany({ d: ZERO })
    expect(c.pin(LQ)).toBe(ZERO)
    expect(c.pin(LQN)).toBe(ONE)
  })

  it.each([[1], [2], [3], [7]])('stores and holds correctly with %i ns gates', (delay) => {
    const c = latch(ZERO, ONE, delay)
    expect(c.pin(LQ)).toBe(ZERO)
    c.set('d', ONE)
    expect(c.pin(LQ)).toBe(ONE)
    expect(c.pin(LQN)).toBe(ZERO)
    c.set('e', ZERO)
    c.set('d', ZERO)
    expect(c.pin(LQ)).toBe(ONE)
    c.set('e', ONE)
    expect(c.pin(LQ)).toBe(ZERO)
    expect(c.pin(LQN)).toBe(ONE)
  })

  it('two latches sharing one enable are transparent end to end (why two phases are needed)', () => {
    const b = new CircuitBuilder().switch('d', ZERO).switch('e', ONE)
    addGatedDLatch(b, 'l', p('d', 'out'), p('e', 'out'))
    addGatedDLatch(b, 'm', p('lq', 'out'), p('e', 'out'))
    const c = b.build()
    expect(c.pin(p('mq', 'out'))).toBe(ZERO)
    c.set('d', ONE)
    expect(c.pin(LQ)).toBe(ONE)
    expect(c.pin(p('mq', 'out'))).toBe(ONE) // the data ran straight through both
    c.set('e', ZERO)
    c.set('d', ZERO)
    expect(c.pin(p('mq', 'out'))).toBe(ONE)
  })

  it('Q settles four gate delays after the enable switch flips', () => {
    const c = latch(ONE, ZERO)
    const t0 = c.time
    c.set('e', ONE) // switch 1, a/b 2, Q 3, Q' 4
    expect(c.time - t0).toBe(4)
    expect(c.pin(LQ)).toBe(ONE)
    expect(c.pin(LQN)).toBe(ZERO)
  })

  describe('an undetermined enable', () => {
    function xLatch(stored: LogicValue, d: LogicValue): Circuit {
      const b = new CircuitBuilder().switch('d', stored)
      const e = addValueSource(b, 'e')
      addGatedDLatch(b, 'l', p('d', 'out'), e)
      const c = b.build()
      setSource(c, 'e', ONE)
      expect(c.pin(LQ)).toBe(stored)
      setSource(c, 'e', ZERO)
      c.set('d', d)
      return c
    }

    it.each([[X], [Z]])('E = %s with D = 0 does not disturb a latch storing 0', (bad) => {
      const c = xLatch(ZERO, ZERO)
      setSource(c, 'e', bad)
      expect(c.pin(LQ)).toBe(ZERO)
      expect(c.pin(LQN)).toBe(ONE)
    })

    it.each([[X], [Z]])('E = %s with D = 1 corrupts a latch storing 0', (bad) => {
      const c = xLatch(ZERO, ONE)
      setSource(c, 'e', bad)
      expect(c.pin(LQ)).toBe(X)
      expect(c.pin(LQN)).toBe(X)
    })

    it.each([[X], [Z]])('E = %s with D = 0 corrupts a latch storing 1', (bad) => {
      const c = xLatch(ONE, ZERO)
      setSource(c, 'e', bad)
      expect(c.pin(LQ)).toBe(X)
      expect(c.pin(LQN)).toBe(X)
    })

    it.each([[X], [Z]])('E = %s with D = 1 corrupts a latch storing 1', (bad) => {
      const c = xLatch(ONE, ONE)
      setSource(c, 'e', bad)
      expect(c.pin(LQ)).toBe(X)
      expect(c.pin(LQN)).toBe(X)
    })
  })

  describe('an undetermined D', () => {
    function dLatch(stored: LogicValue): Circuit {
      const b = new CircuitBuilder().switch('e', ONE)
      const d = addValueSource(b, 'd')
      addGatedDLatch(b, 'l', d, p('e', 'out'))
      const c = b.build()
      setSource(c, 'd', stored)
      expect(c.pin(LQ)).toBe(stored)
      return c
    }

    it.each([[X], [Z]])('D = %s while E = 1 makes both outputs X', (bad) => {
      const c = dLatch(ZERO)
      setSource(c, 'd', bad)
      expect(c.pin(LQ)).toBe(X)
      expect(c.pin(LQN)).toBe(X)
    })

    it.each([[X], [Z]])('a latch corrupted by D = %s recovers when D is driven again', (bad) => {
      const c = dLatch(ZERO)
      setSource(c, 'd', bad)
      expect(c.pin(LQ)).toBe(X)
      setSource(c, 'd', ONE)
      expect(c.pin(LQ)).toBe(ONE)
      expect(c.pin(LQN)).toBe(ZERO)
      setSource(c, 'd', ZERO)
      expect(c.pin(LQ)).toBe(ZERO)
      expect(c.pin(LQN)).toBe(ONE)
    })

    it.each([[X], [Z]])('D = %s while E = 0 leaves the stored value alone', (bad) => {
      const c = dLatch(ONE)
      c.set('e', ZERO)
      setSource(c, 'd', bad)
      expect(c.pin(LQ)).toBe(ONE)
      expect(c.pin(LQN)).toBe(ZERO)
    })
  })

  it('an unconnected D pin behaves exactly like a D driven X', () => {
    const b = new CircuitBuilder().switch('e', ONE)
    addGatedDLatch(b, 'l', p('la', 'in1'), p('e', 'out')) // "wire" D to itself: leaves it open
    const c = b.build()
    expect(c.pin(p('la', 'in1'))).toBe(Z)
    expect(c.pin(LQ)).toBe(X)
    expect(c.pin(LQN)).toBe(X)
  })
})

// ================================================= master-slave D flip-flop

describe('master-slave D flip-flop from two gated D latches', () => {
  function build(masterDelay: number, slaveDelay: number, invDelay: number): Circuit {
    const b = new CircuitBuilder()
      .switch('d', ZERO)
      .switch('clk', ZERO)
      .add('vcc', ComponentType.VCC)
      .add('inv', ComponentType.NOT, { delay: invDelay })
      .wire(p('clk', 'out'), p('inv', 'in1'))
    addGatedDLatch(b, 'm', p('d', 'out'), p('inv', 'out'), masterDelay) // open while CLK = 0
    addGatedDLatch(b, 's', p('mq', 'out'), p('clk', 'out'), slaveDelay) // open while CLK = 1
    addDff(b, 'ff')
    b.wire(p('d', 'out'), p('ff', 'D')).wire(p('clk', 'out'), p('ff', 'CLK'))
    return b.build()
  }

  const SQ = p('sq', 'out')
  const SQN = p('sn', 'out')

  it('both the composite and the D_FLIPFLOP part start undetermined', () => {
    const c = build(1, 1, 1)
    expect(c.pin(SQ)).toBe(X)
    expect(c.pin(SQN)).toBe(X)
    expect(c.pin(p('ff', 'Q'))).toBe(X)
    expect(c.pin(p('ff', "Q'"))).toBe(X)
  })

  it('the master follows D while CLK is low and the slave does not', () => {
    const c = build(1, 1, 1)
    c.rise('clk')
    c.fall('clk') // slave now holds 0 (D was 0)
    expect(c.pin(SQ)).toBe(ZERO)
    c.set('d', ONE)
    expect(c.pin(p('mq', 'out'))).toBe(ONE)
    expect(c.pin(SQ)).toBe(ZERO)
    c.rise('clk')
    expect(c.pin(SQ)).toBe(ONE)
  })

  it.each([
    ['equal delays', 1, 1, 1],
    ['slow master', 3, 1, 1],
    ['slow slave', 1, 3, 1],
    ['slow inverter', 1, 1, 4],
    ['mixed delays', 3, 2, 4]
  ])(
    'tracks the D_FLIPFLOP part over 140 random D/CLK steps (%s)',
    (_name, masterDelay, slaveDelay, invDelay) => {
      const c = build(masterDelay, slaveDelay, invDelay)
      const rnd = lcg(20260906)
      let clk: LogicValue = ZERO
      let d: LogicValue = ZERO
      let model: LogicValue = X
      for (let step = 0; step < 140; step++) {
        const r = rnd()
        if (r % 3 === 0) {
          d = bit(r >> 3)
          c.set('d', d)
        } else {
          const next: LogicValue = clk === ONE ? ZERO : ONE
          if (next === ONE) model = d // rising edge captures D
          clk = next
          c.set('clk', clk)
        }
        expect(c.oscillated).toBe(false)
        expect(c.pin(p('ff', 'Q'))).toBe(model)
        expect(c.pin(SQ)).toBe(model)
        expect(c.pin(SQN)).toBe(inv(model))
        expect(c.pin(p('ff', "Q'"))).toBe(inv(model))
      }
    }
  )

  it('holds its value through repeated D changes while the clock stays high', () => {
    const c = build(1, 1, 1)
    c.set('d', ONE)
    c.rise('clk')
    expect(c.pin(SQ)).toBe(ONE)
    for (let i = 0; i < 6; i++) {
      c.set('d', bit(i))
      expect(c.pin(SQ)).toBe(ONE)
      expect(c.pin(p('ff', 'Q'))).toBe(ONE)
    }
  })

  it('D driven X at the rising edge leaves both the composite and the part undetermined', () => {
    const b = new CircuitBuilder().switch('clk', ZERO).add('vcc', ComponentType.VCC).add('inv', ComponentType.NOT)
    const d = addValueSource(b, 'd')
    b.wire(p('clk', 'out'), p('inv', 'in1'))
    addGatedDLatch(b, 'm', d, p('inv', 'out'))
    addGatedDLatch(b, 's', p('mq', 'out'), p('clk', 'out'))
    addDff(b, 'ff')
    b.wire(d, p('ff', 'D')).wire(p('clk', 'out'), p('ff', 'CLK'))
    const c = b.build()
    setSource(c, 'd', ONE)
    c.rise('clk')
    expect(c.pin(SQ)).toBe(ONE)
    expect(c.pin(p('ff', 'Q'))).toBe(ONE)
    c.fall('clk')
    setSource(c, 'd', X)
    c.rise('clk')
    expect(c.pin(SQ)).toBe(X)
    expect(c.pin(p('ff', 'Q'))).toBe(X)
    c.fall('clk')
    setSource(c, 'd', ZERO)
    c.rise('clk')
    expect(c.pin(SQ)).toBe(ZERO)
    expect(c.pin(p('ff', 'Q'))).toBe(ZERO)
    expect(c.pin(SQN)).toBe(ONE)
  })

  it('swapping the two enables makes a falling-edge flip-flop that tracks a D_FLIPFLOP on an inverted clock', () => {
    const b = new CircuitBuilder()
      .switch('d', ZERO)
      .switch('clk', ZERO)
      .add('vcc', ComponentType.VCC)
      .add('inv', ComponentType.NOT)
      .wire(p('clk', 'out'), p('inv', 'in1'))
    addGatedDLatch(b, 'm', p('d', 'out'), p('clk', 'out')) // master open while CLK = 1
    addGatedDLatch(b, 's', p('mq', 'out'), p('inv', 'out')) // slave open while CLK = 0
    addDff(b, 'ff')
    b.wire(p('d', 'out'), p('ff', 'D')).wire(p('inv', 'out'), p('ff', 'CLK'))
    const c = b.build()
    const rnd = lcg(31337)
    let clk: LogicValue = ZERO
    let d: LogicValue = ZERO
    let model: LogicValue = X
    for (let step = 0; step < 90; step++) {
      const r = rnd()
      if (r % 3 === 0) {
        d = bit(r >> 3)
        c.set('d', d)
      } else {
        const next: LogicValue = clk === ONE ? ZERO : ONE
        if (next === ZERO) model = d // captured on the falling edge of clk
        clk = next
        c.set('clk', clk)
      }
      expect(c.oscillated).toBe(false)
      expect(c.pin(p('ff', 'Q'))).toBe(model)
      expect(c.pin(SQ)).toBe(model)
    }
  })

  it('a D change at the same instant as the rising edge is a setup violation: the gate version goes metastable', () => {
    const c = build(1, 1, 1)
    c.rise('clk')
    c.fall('clk')
    expect(c.pin(SQ)).toBe(ZERO)
    c.setMany({ clk: ONE, d: ONE })
    // The idealised part samples the new data (decision 1) ...
    expect(c.pin(p('ff', 'Q'))).toBe(ONE)
    expect(c.pin(p('ff', "Q'"))).toBe(ZERO)
    // ... while the gate-level master latch gets a one-delay-wide pulse on its
    // set path and its perfectly symmetric cross-coupled pair never settles.
    expect(c.oscillated).toBe(true)
    expect(c.pin(SQ)).toBe(X)
  })

  it('the same setup violation resolves to a definite state when the master gates differ in speed', () => {
    const b = new CircuitBuilder()
      .switch('d', ZERO)
      .switch('clk', ZERO)
      .add('vcc', ComponentType.VCC)
      .add('inv', ComponentType.NOT)
      .wire(p('clk', 'out'), p('inv', 'in1'))
    // Asymmetric cross-coupled pair inside the master: no symmetric race.
    b.add('ma', ComponentType.NAND2)
      .add('mb', ComponentType.NAND2)
      .add('mq', ComponentType.NAND2, { delay: 1 })
      .add('mn', ComponentType.NAND2, { delay: 2 })
      .wire(p('d', 'out'), p('ma', 'in1'))
      .wire(p('inv', 'out'), p('ma', 'in2'))
      .wire(p('ma', 'out'), p('mb', 'in1'))
      .wire(p('inv', 'out'), p('mb', 'in2'))
      .wire(p('ma', 'out'), p('mq', 'in1'))
      .wire(p('mn', 'out'), p('mq', 'in2'))
      .wire(p('mb', 'out'), p('mn', 'in1'))
      .wire(p('mq', 'out'), p('mn', 'in2'))
    addGatedDLatch(b, 's', p('mq', 'out'), p('clk', 'out'))
    const c = b.build()
    c.rise('clk')
    c.fall('clk')
    c.setMany({ clk: ONE, d: ONE })
    expect(c.oscillated).toBe(false)
    const q = c.pin(SQ)
    expect(q === ZERO || q === ONE).toBe(true)
    expect(c.pin(SQN)).toBe(inv(q))
  })
})

// =========================================================== T flip-flops

describe('T flip-flop: from a J-K with J = K = 1 versus from a D with Q\' fed back', () => {
  function build(): Circuit {
    const b = new CircuitBuilder()
      .switch('clk', ZERO)
      .switch('rst', ONE) // active-low clear on both flip-flops
      .add('vcc', ComponentType.VCC)
      .add('jk', ComponentType.JK_FLIPFLOP)
      .wire(p('vcc', 'out'), p('jk', 'J'))
      .wire(p('vcc', 'out'), p('jk', 'K'))
      .wire(p('vcc', 'out'), p('jk', 'S'))
      .wire(p('rst', 'out'), p('jk', 'R'))
      .wire(p('clk', 'out'), p('jk', 'CLK'))
      .add('dff', ComponentType.D_FLIPFLOP)
      .wire(p('vcc', 'out'), p('dff', 'S'))
      .wire(p('rst', 'out'), p('dff', 'R'))
      .wire(p('clk', 'out'), p('dff', 'CLK'))
      .wire(p('dff', "Q'"), p('dff', 'D'))
    return b.build()
  }

  const clear = (c: Circuit): void => {
    c.set('rst', ZERO)
    c.set('rst', ONE)
  }

  it('both stay undetermined forever while they have never been cleared', () => {
    const c = build()
    for (let i = 0; i < 5; i++) {
      c.pulse('clk')
      expect(c.pin(p('jk', 'Q'))).toBe(X)
      expect(c.pin(p('dff', 'Q'))).toBe(X)
    }
  })

  it('an asynchronous clear puts both at 0', () => {
    const c = build()
    clear(c)
    expect(c.pin(p('jk', 'Q'))).toBe(ZERO)
    expect(c.pin(p('jk', "Q'"))).toBe(ONE)
    expect(c.pin(p('dff', 'Q'))).toBe(ZERO)
    expect(c.pin(p('dff', "Q'"))).toBe(ONE)
  })

  it('both toggle exactly once per complete clock pulse over 50 pulses', () => {
    const c = build()
    clear(c)
    for (let k = 1; k <= 50; k++) {
      c.pulse('clk')
      const expected = bit(k)
      expect(c.pin(p('jk', 'Q'))).toBe(expected)
      expect(c.pin(p('dff', 'Q'))).toBe(expected)
      expect(c.pin(p('jk', "Q'"))).toBe(inv(expected))
      expect(c.pin(p('dff', "Q'"))).toBe(inv(expected))
    }
  })

  it('they toggle on opposite clock edges: the D version on the rise, the J-K on the fall', () => {
    const c = build()
    clear(c)
    for (let k = 1; k <= 8; k++) {
      c.rise('clk')
      expect(c.pin(p('dff', 'Q'))).toBe(bit(k)) // already toggled
      expect(c.pin(p('jk', 'Q'))).toBe(bit(k - 1)) // not yet
      c.fall('clk')
      expect(c.pin(p('dff', 'Q'))).toBe(bit(k))
      expect(c.pin(p('jk', 'Q'))).toBe(bit(k))
    }
  })

  it('a J-K T flip-flop clocked by the D version\'s Q divides by four', () => {
    const c = new CircuitBuilder()
      .switch('clk', ZERO)
      .switch('rst', ONE)
      .add('vcc', ComponentType.VCC)
      .add('dff', ComponentType.D_FLIPFLOP)
      .wire(p('vcc', 'out'), p('dff', 'S'))
      .wire(p('rst', 'out'), p('dff', 'R'))
      .wire(p('clk', 'out'), p('dff', 'CLK'))
      .wire(p('dff', "Q'"), p('dff', 'D'))
      .add('jk', ComponentType.JK_FLIPFLOP)
      .wire(p('vcc', 'out'), p('jk', 'J'))
      .wire(p('vcc', 'out'), p('jk', 'K'))
      .wire(p('vcc', 'out'), p('jk', 'S'))
      .wire(p('rst', 'out'), p('jk', 'R'))
      .wire(p('dff', 'Q'), p('jk', 'CLK'))
      .build()
    c.set('rst', ZERO)
    c.set('rst', ONE)
    // The D stage toggles on each rising edge; the J-K stage toggles when that
    // Q falls, i.e. once every two input pulses.
    const expected = [
      [ONE, ZERO],
      [ZERO, ONE],
      [ONE, ONE],
      [ZERO, ZERO],
      [ONE, ZERO],
      [ZERO, ONE],
      [ONE, ONE],
      [ZERO, ZERO]
    ]
    for (const [q0, q1] of expected) {
      c.pulse('clk')
      expect(c.pin(p('dff', 'Q'))).toBe(q0)
      expect(c.pin(p('jk', 'Q'))).toBe(q1)
    }
  })
})

// =========================================================== J-K from a D

describe("J-K flip-flop built from a D flip-flop (D = J.Q' + K'.Q)", () => {
  function build(): Circuit {
    return new CircuitBuilder()
      .switch('clk', ZERO)
      .switch('rst', ONE)
      .switch('j', ZERO)
      .switch('k', ZERO)
      .add('vcc', ComponentType.VCC)
      .add('nk', ComponentType.NOT)
      .add('a1', ComponentType.AND2)
      .add('a2', ComponentType.AND2)
      .add('or', ComponentType.OR2)
      .add('dff', ComponentType.D_FLIPFLOP)
      .wire(p('k', 'out'), p('nk', 'in1'))
      .wire(p('j', 'out'), p('a1', 'in1'))
      .wire(p('dff', "Q'"), p('a1', 'in2'))
      .wire(p('nk', 'out'), p('a2', 'in1'))
      .wire(p('dff', 'Q'), p('a2', 'in2'))
      .wire(p('a1', 'out'), p('or', 'in1'))
      .wire(p('a2', 'out'), p('or', 'in2'))
      .wire(p('or', 'out'), p('dff', 'D'))
      .wire(p('vcc', 'out'), p('dff', 'S'))
      .wire(p('rst', 'out'), p('dff', 'R'))
      .wire(p('clk', 'out'), p('dff', 'CLK'))
      // The J-K part triggers on the FALLING edge, so it is clocked by the
      // inverse: both flip-flops then act on the same rising edge of `clk`.
      .add('ic', ComponentType.NOT)
      .wire(p('clk', 'out'), p('ic', 'in1'))
      .add('jk', ComponentType.JK_FLIPFLOP)
      .wire(p('j', 'out'), p('jk', 'J'))
      .wire(p('k', 'out'), p('jk', 'K'))
      .wire(p('vcc', 'out'), p('jk', 'S'))
      .wire(p('rst', 'out'), p('jk', 'R'))
      .wire(p('ic', 'out'), p('jk', 'CLK'))
      .build()
  }

  const clear = (c: Circuit): void => {
    c.set('rst', ZERO)
    c.set('rst', ONE)
  }
  const model = (q: LogicValue, j: LogicValue, k: LogicValue): LogicValue =>
    j === ONE && k === ONE ? inv(q) : j === ONE ? ONE : k === ONE ? ZERO : q

  it.each([
    ['hold', ZERO, ZERO],
    ['set', ONE, ZERO],
    ['reset', ZERO, ONE],
    ['toggle', ONE, ONE]
  ])('mode %s (J=%s, K=%s) over 12 clocks matches the J-K part', (_name, j, k) => {
    const c = build()
    clear(c)
    c.setMany({ j, k })
    let q: LogicValue = ZERO
    for (let i = 0; i < 12; i++) {
      c.pulse('clk')
      q = model(q, j, k)
      expect(c.pin(p('dff', 'Q'))).toBe(q)
      expect(c.pin(p('jk', 'Q'))).toBe(q)
      expect(c.pin(p('dff', "Q'"))).toBe(inv(q))
      expect(c.pin(p('jk', "Q'"))).toBe(inv(q))
    }
  })

  it.each([
    ['set then hold', [ONE, ZERO] as const, [ZERO, ZERO] as const],
    ['reset then hold', [ZERO, ONE] as const, [ZERO, ZERO] as const],
    ['toggle then reset', [ONE, ONE] as const, [ZERO, ONE] as const],
    ['toggle then set', [ONE, ONE] as const, [ONE, ZERO] as const]
  ])('%s keeps both flip-flops in step', (_name, first, second) => {
    const c = build()
    clear(c)
    let q: LogicValue = ZERO
    for (const [j, k] of [first, second]) {
      c.setMany({ j, k })
      for (let i = 0; i < 4; i++) {
        c.pulse('clk')
        q = model(q, j, k)
        expect(c.pin(p('dff', 'Q'))).toBe(q)
        expect(c.pin(p('jk', 'Q'))).toBe(q)
      }
    }
  })

  it('agrees with the J-K part over 80 random J/K settings', () => {
    const c = build()
    clear(c)
    const rnd = lcg(4242)
    let q: LogicValue = ZERO
    for (let i = 0; i < 80; i++) {
      const r = rnd()
      const j = bit(r)
      const k = bit(r >> 1)
      c.setMany({ j, k })
      c.pulse('clk')
      q = model(q, j, k)
      expect(c.pin(p('dff', 'Q'))).toBe(q)
      expect(c.pin(p('jk', 'Q'))).toBe(q)
      expect(c.oscillated).toBe(false)
    }
  })

  it('neither version changes while the clock stays low', () => {
    const c = build()
    clear(c)
    c.setMany({ j: ONE, k: ZERO })
    expect(c.pin(p('dff', 'Q'))).toBe(ZERO)
    expect(c.pin(p('jk', 'Q'))).toBe(ZERO)
    c.setMany({ j: ZERO, k: ONE })
    expect(c.pin(p('dff', 'Q'))).toBe(ZERO)
    expect(c.pin(p('jk', 'Q'))).toBe(ZERO)
  })

  it('an asynchronous clear overrides the J/K mode on both versions', () => {
    const c = build()
    clear(c)
    c.setMany({ j: ONE, k: ZERO })
    c.pulse('clk')
    expect(c.pin(p('dff', 'Q'))).toBe(ONE)
    expect(c.pin(p('jk', 'Q'))).toBe(ONE)
    c.set('rst', ZERO)
    expect(c.pin(p('dff', 'Q'))).toBe(ZERO)
    expect(c.pin(p('jk', 'Q'))).toBe(ZERO)
    c.pulse('clk') // clear still asserted
    expect(c.pin(p('dff', 'Q'))).toBe(ZERO)
    expect(c.pin(p('jk', 'Q'))).toBe(ZERO)
    c.set('rst', ONE)
    c.pulse('clk')
    expect(c.pin(p('dff', 'Q'))).toBe(ONE)
    expect(c.pin(p('jk', 'Q'))).toBe(ONE)
  })
})

// ============================================ level- versus edge-sensitivity

describe('a gated D latch next to a D flip-flop on the same D and clock', () => {
  function build(): Circuit {
    const b = new CircuitBuilder().switch('d', ZERO).switch('clk', ZERO).add('vcc', ComponentType.VCC)
    addGatedDLatch(b, 'l', p('d', 'out'), p('clk', 'out'))
    addDff(b, 'ff')
    b.wire(p('d', 'out'), p('ff', 'D')).wire(p('clk', 'out'), p('ff', 'CLK'))
    return b.build()
  }
  const LQ = p('lq', 'out')
  const FQ = p('ff', 'Q')

  it('both are undetermined before the first clock', () => {
    const c = build()
    expect(c.pin(LQ)).toBe(X)
    expect(c.pin(FQ)).toBe(X)
  })

  it('the latch follows D while the clock is high, the flip-flop does not', () => {
    const c = build()
    c.rise('clk')
    expect(c.pin(LQ)).toBe(ZERO)
    expect(c.pin(FQ)).toBe(ZERO)
    c.set('d', ONE)
    expect(c.pin(LQ)).toBe(ONE) // level sensitive
    expect(c.pin(FQ)).toBe(ZERO) // edge sensitive
    c.set('d', ZERO)
    expect(c.pin(LQ)).toBe(ZERO)
    expect(c.pin(FQ)).toBe(ZERO)
    c.set('d', ONE)
    expect(c.pin(LQ)).toBe(ONE)
    expect(c.pin(FQ)).toBe(ZERO)
  })

  it('the latch keeps the last value seen before the clock fell', () => {
    const c = build()
    c.rise('clk')
    c.set('d', ONE)
    c.fall('clk')
    expect(c.pin(LQ)).toBe(ONE)
    expect(c.pin(FQ)).toBe(ZERO)
    c.set('d', ZERO)
    expect(c.pin(LQ)).toBe(ONE)
    expect(c.pin(FQ)).toBe(ZERO)
    c.rise('clk')
    expect(c.pin(LQ)).toBe(ZERO)
    expect(c.pin(FQ)).toBe(ZERO)
  })

  it('they agree at every rising edge and only differ while the clock is high', () => {
    const c = build()
    const rnd = lcg(99)
    let clk: LogicValue = ZERO
    let d: LogicValue = ZERO
    let ff: LogicValue = X
    let latch: LogicValue = X
    for (let i = 0; i < 120; i++) {
      const r = rnd()
      if (r % 2 === 0) {
        d = bit(r >> 4)
        c.set('d', d)
        if (clk === ONE) latch = d
      } else {
        const next: LogicValue = clk === ONE ? ZERO : ONE
        clk = next
        c.set('clk', clk)
        if (clk === ONE) {
          ff = d
          latch = d
        }
      }
      expect(c.pin(FQ)).toBe(ff)
      expect(c.pin(LQ)).toBe(latch)
    }
  })
})

// =========================================================== rings

describe('inverter rings', () => {
  /**
   * `stages` inverting stages in a loop: one NAND2 (its other input is the
   * enable) followed by `stages - 1` NOT gates. With the enable low the NAND
   * output is forced high and the ring is a stable chain; with the enable high
   * the NAND becomes an inverter and an odd ring can never settle.
   */
  function ring(stages: number, extra?: (b: CircuitBuilder) => void): Circuit {
    const b = new CircuitBuilder().switch('en', ZERO).add('g0', ComponentType.NAND2)
    b.wire(p('en', 'out'), p('g0', 'in1'))
    let prev = p('g0', 'out')
    for (let i = 1; i < stages; i++) {
      b.add(`n${i}`, ComponentType.NOT).wire(prev, p(`n${i}`, 'in1'))
      prev = p(`n${i}`, 'out')
    }
    b.wire(prev, p('g0', 'in2'))
    extra?.(b)
    return b.build()
  }
  const ringNodes = (stages: number): PinId[] => {
    const ids = [p('g0', 'out')]
    for (let i = 1; i < stages; i++) ids.push(p(`n${i}`, 'out'))
    return ids
  }

  it.each([[2], [3], [4], [5]])('a %i-stage ring held disabled settles to alternating levels', (stages) => {
    const c = ring(stages)
    expect(c.oscillated).toBe(false)
    const nodes = ringNodes(stages)
    nodes.forEach((pin, i) => expect(c.pin(pin)).toBe(bit(i + 1))) // g0 = 1, then 0, 1, ...
  })

  it.each([[3], [5]])('a %i-stage (odd) ring oscillates once enabled and the run is flagged', (stages) => {
    const c = ring(stages)
    c.set('en', ONE)
    expect(c.oscillated).toBe(true)
  })

  it.each([[3], [5]])('every node of an oscillating %i-stage ring reads X after the halt', (stages) => {
    const c = ring(stages)
    c.set('en', ONE)
    for (const pin of ringNodes(stages)) expect(c.pin(pin)).toBe(X)
  })

  it.each([[2], [4]])('a %i-stage (even) ring is stable when enabled and holds its levels', (stages) => {
    const c = ring(stages)
    c.set('en', ONE)
    expect(c.oscillated).toBe(false)
    const nodes = ringNodes(stages)
    nodes.forEach((pin, i) => expect(c.pin(pin)).toBe(bit(i + 1)))
  })

  it('a ring of three plain NOT gates stays X at power-up (X inverts to X) and never oscillates', () => {
    const c = new CircuitBuilder()
      .add('n1', ComponentType.NOT)
      .add('n2', ComponentType.NOT)
      .add('n3', ComponentType.NOT)
      .wire(p('n1', 'out'), p('n2', 'in1'))
      .wire(p('n2', 'out'), p('n3', 'in1'))
      .wire(p('n3', 'out'), p('n1', 'in1'))
      .build()
    expect(c.oscillated).toBe(false)
    expect(c.pin(p('n1', 'out'))).toBe(X)
    expect(c.pin(p('n2', 'out'))).toBe(X)
    expect(c.pin(p('n3', 'out'))).toBe(X)
  })

  it('a ring of five plain NOT gates likewise stays X', () => {
    const b = new CircuitBuilder()
    for (let i = 1; i <= 5; i++) b.add(`n${i}`, ComponentType.NOT)
    for (let i = 1; i <= 5; i++) b.wire(p(`n${i}`, 'out'), p(`n${(i % 5) + 1}`, 'in1'))
    const c = b.build()
    expect(c.oscillated).toBe(false)
    for (let i = 1; i <= 5; i++) expect(c.pin(p(`n${i}`, 'out'))).toBe(X)
  })

  it('a NAND with its output tied to one input: a 0 on the free input holds it high', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .add('g', ComponentType.NAND2)
      .wire(p('a', 'out'), p('g', 'in1'))
      .wire(p('g', 'out'), p('g', 'in2'))
      .build()
    expect(c.pin(p('g', 'out'))).toBe(ONE)
    expect(c.pin(p('g', 'in2'))).toBe(ONE)
    expect(c.oscillated).toBe(false)
  })

  it('a NAND with its output tied to one input oscillates when the free input is 1', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .add('g', ComponentType.NAND2)
      .wire(p('a', 'out'), p('g', 'in1'))
      .wire(p('g', 'out'), p('g', 'in2'))
      .build()
    c.set('a', ONE)
    expect(c.oscillated).toBe(true)
    expect(c.pin(p('g', 'out'))).toBe(X)
  })

  it('halting an oscillation leaves an unrelated subcircuit untouched and still usable', () => {
    const c = ring(3, (b) => {
      b.switch('x', ONE)
        .switch('y', ONE)
        .add('and', ComponentType.AND2)
        .probe('pa')
        .wire(p('x', 'out'), p('and', 'in1'))
        .wire(p('y', 'out'), p('and', 'in2'))
        .wire(p('and', 'out'), p('pa', 'in'))
    })
    expect(c.pin(p('and', 'out'))).toBe(ONE)
    c.set('en', ONE)
    expect(c.oscillated).toBe(true)
    expect(c.pin(p('and', 'out'))).toBe(ONE) // untouched by the halt
    c.set('y', ZERO)
    expect(c.oscillated).toBe(false) // the halted ring is not re-triggered
    expect(c.pin(p('and', 'out'))).toBe(ZERO)
    c.set('y', ONE)
    expect(c.pin(p('and', 'out'))).toBe(ONE)
    expect(trace(c, 'pa').map(([, v]) => v)).toEqual([ONE, ZERO, ONE])
  })

  it('a reset after an oscillation restores time 0 and the disabled ring settles again', () => {
    const c = ring(3)
    c.set('en', ONE)
    expect(c.oscillated).toBe(true)
    c.reset()
    expect(c.time).toBe(0)
    expect(c.oscillated).toBe(false)
    // The switch is still at 1 after reset, so the ring is still oscillating,
    // but reset() itself must not leave the flag from the previous run set
    // before it re-settles: it re-runs the circuit from scratch.
    expect(c.pin(p('g0', 'out'))).toBe(X)
  })
})

// =========================================================== gated SR latch

describe('gated SR latch built from four NANDs', () => {
  function build(d: LatchDelays = {}): Circuit {
    const b = new CircuitBuilder().switch('s', ZERO).switch('r', ZERO).switch('e', ZERO)
    addGatedSrLatch(b, 'l', p('s', 'out'), p('r', 'out'), p('e', 'out'), d)
    return b.build()
  }
  const LQ = p('lq', 'out')
  const LQN = p('ln', 'out')

  const store = (c: Circuit, v: LogicValue): void => {
    c.setMany({ s: v, r: inv(v), e: ONE })
    c.setMany({ e: ZERO })
    c.setMany({ s: ZERO, r: ZERO })
  }

  it('powers up undetermined', () => {
    const c = build()
    expect(c.pin(LQ)).toBe(X)
    expect(c.pin(LQN)).toBe(X)
  })

  it.each([
    [ZERO, ZERO],
    [ZERO, ONE],
    [ONE, ZERO],
    [ONE, ONE]
  ])('with E = 0, S=%s R=%s changes nothing', (s, r) => {
    const c = build()
    store(c, ONE)
    c.setMany({ s, r, e: ZERO })
    expect(c.pin(LQ)).toBe(ONE)
    expect(c.pin(LQN)).toBe(ZERO)
  })

  it.each([
    ['hold', ZERO, ZERO, ZERO, ZERO, ONE],
    ['hold', ZERO, ZERO, ONE, ONE, ZERO],
    ['set', ONE, ZERO, ZERO, ONE, ZERO],
    ['set', ONE, ZERO, ONE, ONE, ZERO],
    ['reset', ZERO, ONE, ZERO, ZERO, ONE],
    ['reset', ZERO, ONE, ONE, ZERO, ONE]
  ])('with E = 1, %s (S=%s R=%s) from stored %s gives Q=%s Q\'=%s', (_name, s, r, stored, eq, eqn) => {
    const c = build()
    store(c, stored)
    c.setMany({ s, r, e: ONE })
    expect(c.pin(LQ)).toBe(eq)
    expect(c.pin(LQN)).toBe(eqn)
  })

  it('with E = 1 and S = R = 1 both outputs go high', () => {
    const c = build()
    store(c, ZERO)
    c.setMany({ s: ONE, r: ONE, e: ONE })
    expect(c.pin(LQ)).toBe(ONE)
    expect(c.pin(LQN)).toBe(ONE)
  })

  it('dropping E from the forbidden state is a symmetric race that never settles', () => {
    const c = build()
    store(c, ZERO)
    c.setMany({ s: ONE, r: ONE, e: ONE })
    c.setMany({ e: ZERO })
    expect(c.oscillated).toBe(true)
    expect(c.pin(LQ)).toBe(X)
    expect(c.pin(LQN)).toBe(X)
  })

  it('the same release settles when the two cross-coupled gates differ in speed', () => {
    const c = build({ qDelay: 1, qnDelay: 2 })
    store(c, ZERO)
    c.setMany({ s: ONE, r: ONE, e: ONE })
    c.setMany({ e: ZERO })
    expect(c.oscillated).toBe(false)
    const q = c.pin(LQ)
    expect(q === ZERO || q === ONE).toBe(true)
    expect(c.pin(LQN)).toBe(inv(q))
  })

  it('dropping S and R before E leaves the stored value alone', () => {
    const c = build()
    store(c, ZERO)
    c.setMany({ s: ONE, r: ONE, e: ONE })
    c.setMany({ s: ZERO, r: ONE }) // resolve the forbidden state first
    expect(c.pin(LQ)).toBe(ZERO)
    expect(c.pin(LQN)).toBe(ONE)
    c.setMany({ r: ZERO })
    c.setMany({ e: ZERO })
    expect(c.pin(LQ)).toBe(ZERO)
    expect(c.pin(LQN)).toBe(ONE)
  })

  it('is transparent to S/R changes for as long as E stays high', () => {
    const c = build()
    store(c, ZERO)
    c.set('e', ONE)
    for (const v of [ONE, ZERO, ONE, ONE, ZERO]) {
      c.setMany({ s: v, r: inv(v) })
      expect(c.pin(LQ)).toBe(v)
      expect(c.pin(LQN)).toBe(inv(v))
    }
  })
})

// =========================================================== 2-bit cell

describe('a 2-bit register cell made of two cross-coupled NOR pairs', () => {
  /**
   * Per bit: S = WE.D, R = WE.D'. WE = 1 writes D into the cross-coupled pair,
   * WE = 0 releases both inputs so the pair holds.
   */
  function build(): Circuit {
    const b = new CircuitBuilder().switch('we', ZERO).switch('d0', ZERO).switch('d1', ZERO)
    for (const i of [0, 1]) {
      b.add(`nd${i}`, ComponentType.NOT)
        .add(`s${i}`, ComponentType.AND2)
        .add(`r${i}`, ComponentType.AND2)
        .add(`q${i}`, ComponentType.NOR2)
        .add(`n${i}`, ComponentType.NOR2)
        .wire(p(`d${i}`, 'out'), p(`nd${i}`, 'in1'))
        .wire(p('we', 'out'), p(`s${i}`, 'in1'))
        .wire(p(`d${i}`, 'out'), p(`s${i}`, 'in2'))
        .wire(p('we', 'out'), p(`r${i}`, 'in1'))
        .wire(p(`nd${i}`, 'out'), p(`r${i}`, 'in2'))
        .wire(p(`r${i}`, 'out'), p(`q${i}`, 'in1'))
        .wire(p(`n${i}`, 'out'), p(`q${i}`, 'in2'))
        .wire(p(`s${i}`, 'out'), p(`n${i}`, 'in1'))
        .wire(p(`q${i}`, 'out'), p(`n${i}`, 'in2'))
    }
    return b.build()
  }
  const cell = (c: Circuit): string => c.pin(p('q1', 'out')) + c.pin(p('q0', 'out'))
  const cellN = (c: Circuit): string => c.pin(p('n1', 'out')) + c.pin(p('n0', 'out'))

  it('holds X on both bits until the first write', () => {
    const c = build()
    expect(cell(c)).toBe('XX')
    c.setMany({ d0: ONE, d1: ONE }) // no write enable: nothing happens
    expect(cell(c)).toBe('XX')
  })

  it.each([
    [ZERO, ZERO, '00'],
    [ZERO, ONE, '01'],
    [ONE, ZERO, '10'],
    [ONE, ONE, '11']
  ])('writes %s%s and reads back %s', (d1, d0, expected) => {
    const c = build()
    c.setMany({ d1, d0 })
    c.set('we', ONE)
    expect(cell(c)).toBe(expected)
    expect(cellN(c)).toBe(expected.split('').map((ch) => inv(ch as LogicValue)).join(''))
    c.set('we', ZERO)
    expect(cell(c)).toBe(expected)
  })

  it('holds through every data change once the write enable is low', () => {
    const c = build()
    c.setMany({ d1: ONE, d0: ZERO })
    c.set('we', ONE)
    c.set('we', ZERO)
    for (const [d1, d0] of [
      [ZERO, ZERO],
      [ZERO, ONE],
      [ONE, ONE],
      [ONE, ZERO],
      [ZERO, ONE]
    ]) {
      c.setMany({ d1, d0 })
      expect(cell(c)).toBe('10')
      expect(cellN(c)).toBe('01')
    }
  })

  it('follows the data while the write enable stays high (the cell is a latch, not a register)', () => {
    const c = build()
    c.set('we', ONE)
    for (const [d1, d0, expected] of [
      [ZERO, ONE, '01'],
      [ONE, ONE, '11'],
      [ONE, ZERO, '10'],
      [ZERO, ZERO, '00'],
      [ONE, ONE, '11']
    ] as Array<[LogicValue, LogicValue, string]>) {
      c.setMany({ d1, d0 })
      expect(cell(c)).toBe(expected)
      expect(c.oscillated).toBe(false)
    }
  })

  it('a full write / hold / rewrite cycle over all four values', () => {
    const c = build()
    for (const [d1, d0, expected] of [
      [ZERO, ZERO, '00'],
      [ZERO, ONE, '01'],
      [ONE, ZERO, '10'],
      [ONE, ONE, '11'],
      [ZERO, ONE, '01']
    ] as Array<[LogicValue, LogicValue, string]>) {
      c.setMany({ d1, d0 })
      c.set('we', ONE)
      expect(cell(c)).toBe(expected)
      c.set('we', ZERO)
      c.setMany({ d1: inv(d1), d0: inv(d0) }) // scramble the inputs
      expect(cell(c)).toBe(expected)
      expect(cellN(c)).toBe(expected.split('').map((ch) => inv(ch as LogicValue)).join(''))
    }
  })

  it('writing bit 1 only leaves bit 0 untouched', () => {
    const c = build()
    c.setMany({ d1: ZERO, d0: ONE })
    c.set('we', ONE)
    c.set('we', ZERO)
    expect(cell(c)).toBe('01')
    c.set('d1', ONE)
    c.set('we', ONE)
    c.set('we', ZERO)
    expect(cell(c)).toBe('11')
  })

  it('the transient both-inputs-high state while D changes under WE = 1 resolves correctly', () => {
    // S and R are skewed by the inverter delay, so the pair briefly sees S = R = 1.
    const c = build()
    c.set('we', ONE)
    c.set('d0', ONE)
    expect(c.pin(p('q0', 'out'))).toBe(ONE)
    expect(c.pin(p('n0', 'out'))).toBe(ZERO)
    c.set('d0', ZERO)
    expect(c.pin(p('q0', 'out'))).toBe(ZERO)
    expect(c.pin(p('n0', 'out'))).toBe(ONE)
    expect(c.oscillated).toBe(false)
  })
})
