// Unit verification of the D and J-K flip-flops against the SimUaid manual
// (User's Guide §2.2, Reference Manual Appendix A/B):
//   - D flip-flop changes state on the RISING edge of CLK (Q <= D).
//   - J-K flip-flop changes state on the FALLING edge of CLK (hold/set/reset/toggle).
//   - S (preset) and R (clear) are ACTIVE LOW, asynchronous, and override the clock.
//   - Every flip-flop input must be driven; Z/X on S or R (or on the sampled data
//     input at the active edge) yields X. S=R=0 is illegal (X here).
//   - Q' is always the complement of Q (X when Q is X).
// Tested both through the pure `nextFlipFlopQ` and through the Simulator with
// switches on every input and probes on Q and Q'.

import { describe, expect, it } from 'vitest'
import { ComponentType, LogicValue } from '../../model/types'
import { nextFlipFlopQ, type FlipFlopKind } from '../logic'
import { Circuit, CircuitBuilder, p } from './harness'

const { ZERO, ONE, X, Z } = LogicValue
const ALL: LogicValue[] = [ZERO, ONE, X, Z]
const CLEAN: LogicValue[] = [ZERO, ONE]
const QS: LogicValue[] = [ZERO, ONE, X]
const CLK_TRANSITIONS: [LogicValue, LogicValue][] = [
  [ZERO, ZERO],
  [ZERO, ONE],
  [ONE, ZERO],
  [ONE, ONE]
]

function not(v: LogicValue): LogicValue {
  return v === ZERO ? ONE : v === ONE ? ZERO : X
}

const isClean = (v: LogicValue): boolean => v === ZERO || v === ONE

/** Spec result of the asynchronous S/R pair, or null when both are inactive (1,1). */
function srExpected(s: LogicValue, r: LogicValue): LogicValue | null {
  if (!isClean(s) || !isClean(r)) return X
  if (s === ZERO && r === ZERO) return X
  if (s === ZERO) return ONE
  if (r === ZERO) return ZERO
  return null
}

const SR_INACTIVE = { s: ONE, r: ONE }

// ---------------------------------------------------------------------------
// Pure function: nextFlipFlopQ
// ---------------------------------------------------------------------------

describe('nextFlipFlopQ: D flip-flop (pure)', () => {
  describe('rising edge (0 -> 1) captures D', () => {
    const cases: [LogicValue, LogicValue][] = []
    for (const d of CLEAN) for (const q of QS) cases.push([d, q])
    it.each(cases)('D=%s prevQ=%s -> Q=D', (d, q) => {
      expect(nextFlipFlopQ('d', { ...SR_INACTIVE, clk: ONE, d }, q, ZERO)).toBe(d)
    })
  })

  describe('any clock transition other than 0 -> 1 leaves Q unchanged', () => {
    const cases: [LogicValue, LogicValue, LogicValue][] = []
    for (const prev of ALL) {
      for (const clk of ALL) {
        if (prev === ZERO && clk === ONE) continue
        for (const q of QS) cases.push([prev, clk, q])
      }
    }
    it.each(cases)('CLK %s -> %s with prevQ=%s holds', (prev, clk, q) => {
      // D differs from Q so that a spurious capture would be visible.
      const d = q === ONE ? ZERO : ONE
      expect(nextFlipFlopQ('d', { ...SR_INACTIVE, clk, d }, q, prev)).toBe(q)
    })
  })

  describe('D at X/Z on the rising edge yields X', () => {
    const cases: [LogicValue, LogicValue][] = []
    for (const d of [X, Z]) for (const q of QS) cases.push([d, q])
    it.each(cases)('D=%s prevQ=%s -> X', (d, q) => {
      expect(nextFlipFlopQ('d', { ...SR_INACTIVE, clk: ONE, d }, q, ZERO)).toBe(X)
    })
    it('D undefined (unconnected) on the rising edge -> X', () => {
      expect(nextFlipFlopQ('d', { ...SR_INACTIVE, clk: ONE }, ZERO, ZERO)).toBe(X)
    })
    it('D at X with no edge does not disturb Q', () => {
      expect(nextFlipFlopQ('d', { ...SR_INACTIVE, clk: ONE, d: X }, ONE, ONE)).toBe(ONE)
      expect(nextFlipFlopQ('d', { ...SR_INACTIVE, clk: ZERO, d: Z }, ZERO, ONE)).toBe(ZERO)
    })
  })

  describe('asynchronous active-low S/R override the clock', () => {
    const cases: [LogicValue, LogicValue, LogicValue, LogicValue, LogicValue, LogicValue][] = []
    for (const s of ALL) {
      for (const r of ALL) {
        const exp = srExpected(s, r)
        if (exp === null) continue
        for (const [prev, clk] of CLK_TRANSITIONS) {
          for (const q of QS) cases.push([s, r, prev, clk, q, exp])
        }
      }
    }
    it.each(cases)('S=%s R=%s CLK %s -> %s prevQ=%s -> %s', (s, r, prev, clk, q, exp) => {
      // D is the opposite of the S/R outcome, so a clocked capture would show.
      const d = exp === ONE ? ZERO : ONE
      expect(nextFlipFlopQ('d', { s, r, clk, d }, q, prev)).toBe(exp)
    })

    it('S=1 R=1 is inactive: Q is governed by the clock', () => {
      expect(nextFlipFlopQ('d', { s: ONE, r: ONE, clk: ONE, d: ONE }, ZERO, ZERO)).toBe(ONE)
      expect(nextFlipFlopQ('d', { s: ONE, r: ONE, clk: ONE, d: ONE }, ZERO, ONE)).toBe(ZERO)
    })

    it.each<[LogicValue, LogicValue, LogicValue]>([
      [ZERO, ONE, ONE],
      [ONE, ZERO, ZERO]
    ])('S=%s R=%s override even when CLK is X/Z or moving through X/Z', (s, r, exp) => {
      for (const prev of ALL) {
        for (const clk of ALL) {
          expect(nextFlipFlopQ('d', { s, r, clk, d: not(exp) }, X, prev)).toBe(exp)
          expect(nextFlipFlopQ('jk', { s, r, clk, j: ONE, k: ONE }, X, prev)).toBe(exp)
        }
      }
    })
  })

  it('a D flip-flop ignores J/K inputs and a J-K ignores D', () => {
    // D FF: J=K=1 would toggle, but D=0 rules.
    expect(nextFlipFlopQ('d', { ...SR_INACTIVE, clk: ONE, d: ZERO, j: ONE, k: ONE }, ZERO, ZERO)).toBe(ZERO)
    // J-K: D=1 is not consulted; J=K=0 holds.
    expect(nextFlipFlopQ('jk', { ...SR_INACTIVE, clk: ZERO, d: ONE, j: ZERO, k: ZERO }, ZERO, ONE)).toBe(ZERO)
  })
})

describe('nextFlipFlopQ: J-K flip-flop (pure)', () => {
  describe('falling edge (1 -> 0) applies the J/K mode', () => {
    it.each<[LogicValue, LogicValue, LogicValue, LogicValue]>([
      [ZERO, ZERO, ZERO, ZERO],
      [ZERO, ZERO, ONE, ONE],
      [ZERO, ZERO, X, X],
      [ONE, ZERO, ZERO, ONE],
      [ONE, ZERO, ONE, ONE],
      [ONE, ZERO, X, ONE],
      [ZERO, ONE, ZERO, ZERO],
      [ZERO, ONE, ONE, ZERO],
      [ZERO, ONE, X, ZERO],
      [ONE, ONE, ZERO, ONE],
      [ONE, ONE, ONE, ZERO],
      [ONE, ONE, X, X]
    ])('J=%s K=%s prevQ=%s -> %s', (j, k, q, exp) => {
      expect(nextFlipFlopQ('jk', { ...SR_INACTIVE, clk: ZERO, j, k }, q, ONE)).toBe(exp)
    })
  })

  describe('any clock transition other than 1 -> 0 leaves Q unchanged (J=K=1)', () => {
    const cases: [LogicValue, LogicValue, LogicValue][] = []
    for (const prev of ALL) {
      for (const clk of ALL) {
        if (prev === ONE && clk === ZERO) continue
        for (const q of QS) cases.push([prev, clk, q])
      }
    }
    it.each(cases)('CLK %s -> %s with prevQ=%s holds', (prev, clk, q) => {
      expect(nextFlipFlopQ('jk', { ...SR_INACTIVE, clk, j: ONE, k: ONE }, q, prev)).toBe(q)
    })
  })

  describe('rising edge never applies set/reset either', () => {
    it.each<[LogicValue, LogicValue, LogicValue]>([
      [ONE, ZERO, ZERO],
      [ZERO, ONE, ONE]
    ])('J=%s K=%s prevQ=%s holds on 0 -> 1', (j, k, q) => {
      expect(nextFlipFlopQ('jk', { ...SR_INACTIVE, clk: ONE, j, k }, q, ZERO)).toBe(q)
    })
  })

  describe('J or K at X/Z on the falling edge yields X', () => {
    const cases: [LogicValue, LogicValue, LogicValue][] = []
    for (const j of ALL) {
      for (const k of ALL) {
        if (isClean(j) && isClean(k)) continue
        for (const q of QS) cases.push([j, k, q])
      }
    }
    it.each(cases)('J=%s K=%s prevQ=%s -> X', (j, k, q) => {
      expect(nextFlipFlopQ('jk', { ...SR_INACTIVE, clk: ZERO, j, k }, q, ONE)).toBe(X)
    })
    it('J/K undefined (unconnected) on the falling edge -> X', () => {
      expect(nextFlipFlopQ('jk', { ...SR_INACTIVE, clk: ZERO }, ZERO, ONE)).toBe(X)
    })
    it('J/K at X with no edge does not disturb Q', () => {
      expect(nextFlipFlopQ('jk', { ...SR_INACTIVE, clk: ONE, j: X, k: Z }, ONE, ONE)).toBe(ONE)
      expect(nextFlipFlopQ('jk', { ...SR_INACTIVE, clk: ONE, j: X, k: X }, ZERO, ZERO)).toBe(ZERO)
    })
  })

  describe('asynchronous active-low S/R override the clock', () => {
    const cases: [LogicValue, LogicValue, LogicValue, LogicValue, LogicValue, LogicValue][] = []
    for (const s of ALL) {
      for (const r of ALL) {
        const exp = srExpected(s, r)
        if (exp === null) continue
        for (const [prev, clk] of CLK_TRANSITIONS) {
          for (const q of QS) cases.push([s, r, prev, clk, q, exp])
        }
      }
    }
    it.each(cases)('S=%s R=%s CLK %s -> %s prevQ=%s -> %s', (s, r, prev, clk, q, exp) => {
      // J=K=1 (toggle) so that a clocked change would show.
      expect(nextFlipFlopQ('jk', { s, r, clk, j: ONE, k: ONE }, q, prev)).toBe(exp)
    })
  })
})

// ---------------------------------------------------------------------------
// Simulator helpers (local to this file)
// ---------------------------------------------------------------------------

type Init = Partial<Record<'d' | 'j' | 'k' | 'clk' | 's' | 'r', LogicValue>>

/**
 * One flip-flop `ff` with a switch on every input (switch id = lower-cased pin
 * name: d/j/k/clk/s/r) and probes `q` / `qn` on Q / Q'. Pins listed in `omit`
 * are left unconnected (no switch is created for them). S and R default to 1
 * (inactive); everything else defaults to 0.
 */
function ffBuilder(kind: FlipFlopKind, init: Init = {}, omit: string[] = []): CircuitBuilder {
  const type = kind === 'd' ? ComponentType.D_FLIPFLOP : ComponentType.JK_FLIPFLOP
  const dataPins = kind === 'd' ? ['D'] : ['J', 'K']
  const b = new CircuitBuilder()
    .add('ff', type)
    .probe('q')
    .probe('qn')
    .wire(p('ff', 'Q'), p('q', 'in'))
    .wire(p('ff', "Q'"), p('qn', 'in'))
  for (const pin of [...dataPins, 'CLK', 'S', 'R']) {
    if (omit.includes(pin)) continue
    const sw = pin.toLowerCase() as keyof Init
    const dflt = pin === 'S' || pin === 'R' ? ONE : ZERO
    b.switch(sw, init[sw] ?? dflt).wire(p(sw, 'out'), p('ff', pin))
  }
  return b
}

const dff = (init: Init = {}, omit: string[] = []): Circuit => ffBuilder('d', init, omit).build()
const jkff = (init: Init = {}, omit: string[] = []): Circuit => ffBuilder('jk', init, omit).build()

const q = (c: Circuit): LogicValue => c.pin(p('q', 'in'))
const qn = (c: Circuit): LogicValue => c.pin(p('qn', 'in'))

/** Asserts Q (via probe and via the pin) and that Q' is its complement. */
function expectQ(c: Circuit, v: LogicValue): void {
  expect(q(c)).toBe(v)
  expect(c.pin(p('ff', 'Q'))).toBe(v)
  expect(qn(c)).toBe(not(v))
  expect(c.pin(p('ff', "Q'"))).toBe(not(v))
}

/** Pulses R low then back high: Q <= 0. */
function clear(c: Circuit): Circuit {
  c.set('r', ZERO)
  c.set('r', ONE)
  return c
}

/** Pulses S low then back high: Q <= 1. */
function preset(c: Circuit): Circuit {
  c.set('s', ZERO)
  c.set('s', ONE)
  return c
}

/**
 * Adds a 2-input gate `id` with `in2` left unconnected (Z) and `in1` driven by a
 * new switch `${id}_en`. An OR2 outputs 1 when en=1 and X when en=0; an AND2
 * outputs 0 when en=0 and X when en=1. Used to drive flip-flop pins to X.
 */
function addXSource(b: CircuitBuilder, id: string, family: 'or' | 'and', en: LogicValue): CircuitBuilder {
  return b
    .switch(`${id}_en`, en)
    .add(id, family === 'or' ? ComponentType.OR2 : ComponentType.AND2)
    .wire(p(`${id}_en`, 'out'), p(id, 'in1'))
}

/** Waveform samples of a probe as [t, v] pairs from time `fromT` onward. */
function samplesOf(c: Circuit, probeId: string, fromT = 0): [number, LogicValue][] {
  const trace = c.sim.getWaveforms().find((w) => w.probeId === probeId)
  if (!trace) throw new Error(`no probe ${probeId}`)
  return trace.samples.filter((s) => s.t >= fromT).map((s) => [s.t, s.v])
}

// ---------------------------------------------------------------------------
// Simulator: D flip-flop
// ---------------------------------------------------------------------------

describe('Simulator: D flip-flop', () => {
  describe('initial state', () => {
    it("Q and Q' are X after reset with S=R=1 and the clock idle", () => {
      expectQ(dff(), X)
      expectQ(dff({ clk: ONE }), X)
    })

    it('Q stays X while the clock is static and D changes', () => {
      const c = dff()
      c.set('d', ONE)
      expectQ(c, X)
      c.set('d', ZERO)
      expectQ(c, X)
    })

    it('a rising edge resolves the initial X to D', () => {
      const c = dff({ d: ONE })
      c.rise('clk')
      expectQ(c, ONE)
      const c2 = dff({ d: ZERO })
      c2.rise('clk')
      expectQ(c2, ZERO)
    })

    it('R pulse resolves the initial X to 0; S pulse resolves it to 1', () => {
      expectQ(clear(dff()), ZERO)
      expectQ(preset(dff()), ONE)
    })

    it('R=0 already at reset gives Q=0 immediately', () => {
      expectQ(dff({ r: ZERO }), ZERO)
      expectQ(dff({ s: ZERO }), ONE)
    })

    it('reset() returns Q to X', () => {
      const c = clear(dff())
      expectQ(c, ZERO)
      c.reset()
      expectQ(c, X)
    })

    it('no spurious edge at reset when CLK is driven through an inverter (CLK settles to 1)', () => {
      // CLK = NOT(clk switch). At reset the inverter output goes (undriven) -> 1;
      // that must not be taken as a rising edge.
      const c = ffBuilder('d', { d: ONE }, ['CLK'])
        .switch('clk', ZERO)
        .add('inv', ComponentType.NOT)
        .wire(p('clk', 'out'), p('inv', 'in1'))
        .wire(p('inv', 'out'), p('ff', 'CLK'))
        .build()
      expect(c.pin(p('ff', 'CLK'))).toBe(ONE)
      expectQ(c, X)
      c.set('clk', ONE) // CLK 1 -> 0: no edge for a D FF
      expectQ(c, X)
      c.set('clk', ZERO) // CLK 0 -> 1: rising edge
      expectQ(c, ONE)
    })
  })

  describe('edge polarity', () => {
    it.each(CLEAN)('captures D=%s on the rising edge from Q=0', (d) => {
      const c = clear(dff())
      c.set('d', d)
      c.rise('clk')
      expectQ(c, d)
    })

    it.each(CLEAN)('captures D=%s on the rising edge from Q=1', (d) => {
      const c = preset(dff())
      c.set('d', d)
      c.rise('clk')
      expectQ(c, d)
    })

    it('the falling edge does not change Q', () => {
      const c = clear(dff({ clk: ONE, d: ONE }))
      c.fall('clk')
      expectQ(c, ZERO)
      const c2 = preset(dff({ clk: ONE, d: ZERO }))
      c2.fall('clk')
      expectQ(c2, ONE)
    })

    it('D changes while CLK is static high do not change Q', () => {
      const c = clear(dff({ clk: ONE }))
      c.set('d', ONE)
      expectQ(c, ZERO)
      c.set('d', ZERO)
      c.set('d', ONE)
      expectQ(c, ZERO)
    })

    it('D changes while CLK is static low do not change Q', () => {
      const c = preset(dff({ clk: ZERO }))
      c.set('d', ZERO)
      expectQ(c, ONE)
      c.set('d', ONE)
      c.set('d', ZERO)
      expectQ(c, ONE)
    })

    it('Q changes only on the 0 -> 1 transition of a full pulse sequence', () => {
      const c = clear(dff({ d: ONE }))
      c.rise('clk')
      expectQ(c, ONE)
      c.set('d', ZERO)
      c.fall('clk')
      expectQ(c, ONE) // falling edge ignored
      c.rise('clk')
      expectQ(c, ZERO)
    })

    it('follows an alternating D across 8 clock cycles', () => {
      const c = clear(dff())
      for (let i = 0; i < 8; i++) {
        const d = i % 2 === 0 ? ONE : ZERO
        c.set('d', d)
        c.pulse('clk')
        expectQ(c, d)
      }
    })

    it('holds Q across many pulses when D is constant', () => {
      const c = clear(dff({ d: ONE }))
      c.pulse('clk')
      for (let i = 0; i < 10; i++) {
        c.pulse('clk')
        expectQ(c, ONE)
      }
    })
  })

  describe('asynchronous S/R (active low)', () => {
    it('S=0 sets Q=1 immediately with the clock idle', () => {
      const c = clear(dff())
      c.set('s', ZERO)
      expectQ(c, ONE)
      c.set('s', ONE)
      expectQ(c, ONE)
    })

    it('R=0 clears Q=0 immediately with the clock idle', () => {
      const c = preset(dff())
      c.set('r', ZERO)
      expectQ(c, ZERO)
      c.set('r', ONE)
      expectQ(c, ZERO)
    })

    it('S=0 overrides rising edges with D=0', () => {
      const c = clear(dff({ d: ZERO }))
      c.set('s', ZERO)
      expectQ(c, ONE)
      for (let i = 0; i < 3; i++) {
        c.pulse('clk')
        expectQ(c, ONE)
      }
      c.set('s', ONE)
      expectQ(c, ONE)
      c.pulse('clk') // now the clock rules again
      expectQ(c, ZERO)
    })

    it('R=0 overrides rising edges with D=1', () => {
      const c = preset(dff({ d: ONE }))
      c.set('r', ZERO)
      expectQ(c, ZERO)
      for (let i = 0; i < 3; i++) {
        c.pulse('clk')
        expectQ(c, ZERO)
      }
      c.set('r', ONE)
      expectQ(c, ZERO)
      c.pulse('clk')
      expectQ(c, ONE)
    })

    it('S asserted while CLK is high takes effect at once', () => {
      const c = clear(dff({ clk: ONE }))
      c.set('s', ZERO)
      expectQ(c, ONE)
    })

    it('releasing S while CLK sits high does not act as a rising edge', () => {
      // The clock rose while S was active (edge ignored). When S is released the
      // clock has not moved, so D=0 must NOT be captured.
      const c = clear(dff({ d: ZERO }))
      c.set('s', ZERO)
      expectQ(c, ONE)
      c.rise('clk')
      expectQ(c, ONE)
      c.set('s', ONE)
      expectQ(c, ONE)
      c.fall('clk')
      expectQ(c, ONE)
      c.rise('clk') // a genuine edge now captures D
      expectQ(c, ZERO)
    })

    it('releasing R while CLK sits high does not act as a rising edge', () => {
      const c = preset(dff({ d: ONE }))
      c.set('r', ZERO)
      c.rise('clk')
      expectQ(c, ZERO)
      c.set('r', ONE)
      expectQ(c, ZERO)
      c.fall('clk')
      c.rise('clk')
      expectQ(c, ONE)
    })

    it('S=R=0 is illegal and yields X', () => {
      const c = clear(dff({ d: ONE }))
      c.set('s', ZERO)
      c.set('r', ZERO)
      expectQ(c, X)
      c.pulse('clk')
      expectQ(c, X)
    })

    it('leaving S=R=0 by raising S first gives Q=0, then raising R holds 0 (manual §2.2c)', () => {
      const c = dff({ d: ONE, s: ZERO, r: ZERO })
      expectQ(c, X)
      c.set('s', ONE)
      expectQ(c, ZERO)
      c.set('r', ONE)
      expectQ(c, ZERO)
      c.rise('clk')
      expectQ(c, ONE)
    })

    it('leaving S=R=0 by raising R first gives Q=1, then raising S holds 1', () => {
      const c = dff({ d: ZERO, s: ZERO, r: ZERO })
      c.set('r', ONE)
      expectQ(c, ONE)
      c.set('s', ONE)
      expectQ(c, ONE)
    })

    it('releasing S and R at the same instant from S=R=0 leaves Q at X until an edge resolves it', () => {
      const c = dff({ d: ONE, s: ZERO, r: ZERO })
      expectQ(c, X)
      c.setMany({ s: ONE, r: ONE })
      expectQ(c, X)
      c.rise('clk')
      expectQ(c, ONE)
    })

    it('S unconnected (Z) yields X even with R=1 and clock edges', () => {
      const c = dff({ d: ONE }, ['S'])
      expect(c.pin(p('ff', 'S'))).toBe(Z)
      expectQ(c, X)
      c.pulse('clk')
      expectQ(c, X)
    })

    it('R unconnected (Z) yields X even with S=1 and clock edges', () => {
      const c = dff({ d: ONE }, ['R'])
      expect(c.pin(p('ff', 'R'))).toBe(Z)
      expectQ(c, X)
      c.pulse('clk')
      expectQ(c, X)
    })

    it('S unconnected (Z) yields X even when R=0 is asserted', () => {
      const c = dff({ r: ZERO }, ['S'])
      expectQ(c, X)
    })

    it('R unconnected (Z) yields X even when S=0 is asserted', () => {
      const c = dff({ s: ZERO }, ['R'])
      expectQ(c, X)
    })

    it('S at X yields X; when S returns to 1, Q stays X until resolved', () => {
      // S = OR2(en, Z): 1 when en=1, X when en=0.
      const c = addXSource(ffBuilder('d', { d: ONE }, ['S']), 'xs', 'or', ONE)
        .wire(p('xs', 'out'), p('ff', 'S'))
        .build()
      expect(c.pin(p('ff', 'S'))).toBe(ONE)
      clear(c)
      expectQ(c, ZERO)
      c.set('xs_en', ZERO)
      expect(c.pin(p('ff', 'S'))).toBe(X)
      expectQ(c, X)
      c.set('xs_en', ONE)
      expectQ(c, X)
      c.rise('clk')
      expectQ(c, ONE)
    })

    it('R at X yields X even during clock edges', () => {
      const c = addXSource(ffBuilder('d', { d: ONE }, ['R']), 'xr', 'or', ONE)
        .wire(p('xr', 'out'), p('ff', 'R'))
        .build()
      preset(c)
      expectQ(c, ONE)
      c.set('xr_en', ZERO)
      expect(c.pin(p('ff', 'R'))).toBe(X)
      expectQ(c, X)
      c.pulse('clk')
      expectQ(c, X)
    })

    it('S from an AND2 with a floating input: 0 sets Q, X yields X', () => {
      const c = addXSource(ffBuilder('d', { d: ZERO }, ['S']), 'xs', 'and', ZERO)
        .wire(p('xs', 'out'), p('ff', 'S'))
        .build()
      expect(c.pin(p('ff', 'S'))).toBe(ZERO)
      expectQ(c, ONE)
      c.set('xs_en', ONE)
      expect(c.pin(p('ff', 'S'))).toBe(X)
      expectQ(c, X)
    })
  })

  describe('D at X/Z', () => {
    it('D unconnected (Z) on the rising edge yields X', () => {
      const c = clear(dff({}, ['D']))
      expect(c.pin(p('ff', 'D'))).toBe(Z)
      expectQ(c, ZERO)
      c.rise('clk')
      expectQ(c, X)
    })

    it('D at X on the rising edge yields X', () => {
      const c = addXSource(ffBuilder('d', {}, ['D']), 'xd', 'or', ONE)
        .wire(p('xd', 'out'), p('ff', 'D'))
        .build()
      clear(c)
      c.set('xd_en', ZERO)
      expect(c.pin(p('ff', 'D'))).toBe(X)
      expectQ(c, ZERO) // no edge yet: Q untouched
      c.rise('clk')
      expectQ(c, X)
      c.fall('clk')
      c.set('xd_en', ONE) // D = 1 again
      c.rise('clk')
      expectQ(c, ONE) // a clean edge recovers from X
    })

    it('D at X while the clock is static does not disturb Q', () => {
      const c = addXSource(ffBuilder('d', {}, ['D']), 'xd', 'or', ONE)
        .wire(p('xd', 'out'), p('ff', 'D'))
        .build()
      clear(c)
      c.rise('clk')
      expectQ(c, ONE)
      c.set('xd_en', ZERO)
      expectQ(c, ONE)
      c.fall('clk')
      expectQ(c, ONE)
    })

    it('D driven Z by a disabled tristate (a driver, not an open pin) yields X on the edge', () => {
      const c = ffBuilder('d', {}, ['D'])
        .switch('din', ONE)
        .switch('en', ZERO)
        .add('ts', ComponentType.TRISTATE_RIGHT)
        .wire(p('din', 'out'), p('ts', 'in'))
        .wire(p('en', 'out'), p('ts', 'ctl'))
        .wire(p('ts', 'out'), p('ff', 'D'))
        .build()
      clear(c)
      expect(c.pin(p('ff', 'D'))).toBe(Z)
      c.rise('clk')
      expectQ(c, X)
      c.fall('clk')
      c.set('en', ONE)
      expect(c.pin(p('ff', 'D'))).toBe(ONE)
      c.rise('clk')
      expectQ(c, ONE)
    })
  })

  describe('CLK at X/Z', () => {
    /** CLK = MUX_2(A=sel; in0=clk switch, in1 unconnected): X when sel=1. */
    const withMuxClock = (init: Init = {}): Circuit =>
      ffBuilder('d', init, ['CLK'])
        .switch('clk', ZERO)
        .switch('sel', ZERO)
        .add('mux', ComponentType.MUX_2)
        .wire(p('clk', 'out'), p('mux', 'in0'))
        .wire(p('sel', 'out'), p('mux', 'A'))
        .wire(p('mux', 'Z'), p('ff', 'CLK'))
        .build()

    /** CLK = tristate(in=clk switch, ctl=en): Z when en=0. */
    const withTristateClock = (init: Init = {}): Circuit =>
      ffBuilder('d', init, ['CLK'])
        .switch('clk', ZERO)
        .switch('en', ONE)
        .add('ts', ComponentType.TRISTATE_RIGHT)
        .wire(p('clk', 'out'), p('ts', 'in'))
        .wire(p('en', 'out'), p('ts', 'ctl'))
        .wire(p('ts', 'out'), p('ff', 'CLK'))
        .build()

    it('CLK 0 -> X -> 1 produces no edge; a later clean 0 -> 1 does', () => {
      const c = clear(withMuxClock({ d: ONE }))
      expect(c.pin(p('ff', 'CLK'))).toBe(ZERO)
      c.set('sel', ONE)
      expect(c.pin(p('ff', 'CLK'))).toBe(X)
      expectQ(c, ZERO)
      c.set('clk', ONE) // CLK still X
      expect(c.pin(p('ff', 'CLK'))).toBe(X)
      expectQ(c, ZERO)
      c.set('sel', ZERO) // CLK X -> 1
      expect(c.pin(p('ff', 'CLK'))).toBe(ONE)
      expectQ(c, ZERO)
      c.set('clk', ZERO)
      c.set('clk', ONE) // clean rising edge
      expectQ(c, ONE)
    })

    it('CLK 1 -> X -> 0 -> 1: the X excursion is ignored and the clean rise captures D', () => {
      const c = clear(withMuxClock({ d: ONE }))
      c.set('clk', ONE) // rising edge: Q <= 1
      expectQ(c, ONE)
      c.set('d', ZERO)
      c.set('sel', ONE) // CLK 1 -> X
      expectQ(c, ONE)
      c.set('clk', ZERO)
      c.set('sel', ZERO) // CLK X -> 0
      expectQ(c, ONE)
      c.set('clk', ONE) // CLK 0 -> 1
      expectQ(c, ZERO)
    })

    it('CLK 0 -> Z -> 1 produces no edge; a later clean 0 -> 1 does', () => {
      const c = clear(withTristateClock({ d: ONE }))
      c.set('en', ZERO)
      expect(c.pin(p('ff', 'CLK'))).toBe(Z)
      expectQ(c, ZERO)
      c.set('clk', ONE)
      expectQ(c, ZERO)
      c.set('en', ONE) // CLK Z -> 1
      expect(c.pin(p('ff', 'CLK'))).toBe(ONE)
      expectQ(c, ZERO)
      c.set('clk', ZERO)
      c.set('clk', ONE)
      expectQ(c, ONE)
    })

    it('CLK unconnected: Q never leaves X through clocking, but S/R still work', () => {
      const c = dff({ d: ONE }, ['CLK'])
      expect(c.pin(p('ff', 'CLK'))).toBe(Z)
      expectQ(c, X)
      c.set('d', ZERO)
      c.set('d', ONE)
      expectQ(c, X)
      clear(c)
      expectQ(c, ZERO)
      preset(c)
      expectQ(c, ONE)
    })
  })

  it('follows the manual §2.2 exercise (steps c-e)', () => {
    // c. all inputs 0, then D=1, then a rising edge: S=R=0 is illegal so Q does not follow D.
    const c = dff({ d: ZERO, clk: ZERO, s: ZERO, r: ZERO })
    c.set('d', ONE)
    c.rise('clk')
    expectQ(c, X)
    // Correct it: S=1 then R=1 -> Q=0 because R was active last.
    c.set('s', ONE)
    expectQ(c, ZERO)
    c.set('r', ONE)
    expectQ(c, ZERO)
    // Another rising edge -> Q=1.
    c.fall('clk')
    expectQ(c, ZERO)
    c.rise('clk')
    expectQ(c, ONE)
    // d. verify R then S.
    c.set('r', ZERO)
    expectQ(c, ZERO)
    c.set('r', ONE)
    expectQ(c, ZERO)
    c.set('s', ZERO)
    expectQ(c, ONE)
    c.set('s', ONE)
    expectQ(c, ONE)
    // e. Q=0, D=0, CLOCK=1: clock 0 then 1 -> Q stays 0.
    c.set('r', ZERO)
    c.set('r', ONE)
    c.set('d', ZERO)
    expect(c.pin(p('ff', 'CLK'))).toBe(ONE)
    c.fall('clk')
    c.rise('clk')
    expectQ(c, ZERO)
    // D=1, clock 0 then 1 -> Q=1, changing just after the 0 -> 1 transition.
    c.set('d', ONE)
    c.fall('clk')
    expectQ(c, ZERO)
    c.rise('clk')
    expectQ(c, ONE)
    // D=0 and toggle again: Q changes on the rising edge only.
    c.set('d', ZERO)
    c.fall('clk')
    expectQ(c, ONE)
    c.rise('clk')
    expectQ(c, ZERO)
  })
})

// ---------------------------------------------------------------------------
// Simulator: J-K flip-flop
// ---------------------------------------------------------------------------

describe('Simulator: J-K flip-flop', () => {
  describe('initial state', () => {
    it("Q and Q' are X after reset with S=R=1 and the clock idle", () => {
      expectQ(jkff(), X)
      expectQ(jkff({ clk: ONE }), X)
    })

    it('R pulse resolves X to 0; S pulse resolves X to 1', () => {
      expectQ(clear(jkff()), ZERO)
      expectQ(preset(jkff()), ONE)
    })

    it('a falling edge with J=1 K=0 resolves X to 1; with J=0 K=1 to 0', () => {
      const c = jkff({ clk: ONE, j: ONE, k: ZERO })
      c.fall('clk')
      expectQ(c, ONE)
      const c2 = jkff({ clk: ONE, j: ZERO, k: ONE })
      c2.fall('clk')
      expectQ(c2, ZERO)
    })

    it('toggling an unknown Q leaves it unknown', () => {
      const c = jkff({ clk: ONE, j: ONE, k: ONE })
      c.fall('clk')
      expectQ(c, X)
      c.pulse('clk')
      expectQ(c, X)
    })

    it('holding an unknown Q leaves it unknown', () => {
      const c = jkff({ clk: ONE })
      c.fall('clk')
      expectQ(c, X)
    })
  })

  describe('edge polarity', () => {
    it('the rising edge does not change Q (J=K=1)', () => {
      const c = clear(jkff({ j: ONE, k: ONE }))
      c.rise('clk')
      expectQ(c, ZERO)
      c.fall('clk')
      expectQ(c, ONE)
    })

    it('the rising edge does not apply set or reset', () => {
      const c = clear(jkff({ j: ONE, k: ZERO }))
      c.rise('clk')
      expectQ(c, ZERO)
      const c2 = preset(jkff({ j: ZERO, k: ONE }))
      c2.rise('clk')
      expectQ(c2, ONE)
    })

    it('J/K changes while CLK is static high do not change Q', () => {
      const c = clear(jkff({ clk: ONE }))
      c.set('j', ONE)
      expectQ(c, ZERO)
      c.set('k', ONE)
      expectQ(c, ZERO)
      c.set('j', ZERO)
      expectQ(c, ZERO)
    })

    it('J/K changes while CLK is static low do not change Q', () => {
      const c = preset(jkff({ clk: ZERO }))
      c.set('k', ONE)
      expectQ(c, ONE)
      c.set('j', ONE)
      expectQ(c, ONE)
      c.set('k', ZERO)
      expectQ(c, ONE)
    })
  })

  describe('the four modes on the falling edge', () => {
    it('hold (J=0 K=0) keeps Q=0 across many pulses', () => {
      const c = clear(jkff())
      for (let i = 0; i < 5; i++) {
        c.pulse('clk')
        expectQ(c, ZERO)
      }
    })

    it('hold (J=0 K=0) keeps Q=1 across many pulses', () => {
      const c = preset(jkff())
      for (let i = 0; i < 5; i++) {
        c.pulse('clk')
        expectQ(c, ONE)
      }
    })

    it('set (J=1 K=0) makes Q=1 on the falling edge and keeps it', () => {
      const c = clear(jkff({ j: ONE, k: ZERO }))
      c.rise('clk')
      expectQ(c, ZERO)
      c.fall('clk')
      expectQ(c, ONE)
      c.pulse('clk')
      expectQ(c, ONE)
    })

    it('reset (J=0 K=1) makes Q=0 on the falling edge and keeps it', () => {
      const c = preset(jkff({ j: ZERO, k: ONE }))
      c.rise('clk')
      expectQ(c, ONE)
      c.fall('clk')
      expectQ(c, ZERO)
      c.pulse('clk')
      expectQ(c, ZERO)
    })

    it('toggle (J=1 K=1) flips Q on every falling edge across 16 cycles', () => {
      const c = clear(jkff({ j: ONE, k: ONE }))
      let expected = ZERO
      for (let i = 0; i < 16; i++) {
        c.rise('clk')
        expectQ(c, expected)
        c.fall('clk')
        expected = not(expected)
        expectQ(c, expected)
      }
    })

    it('mode changes between edges are applied at the next falling edge', () => {
      const c = clear(jkff())
      c.setMany({ j: ONE, k: ZERO })
      c.pulse('clk')
      expectQ(c, ONE)
      c.setMany({ j: ZERO, k: ONE })
      c.pulse('clk')
      expectQ(c, ZERO)
      c.setMany({ j: ONE, k: ONE })
      c.pulse('clk')
      expectQ(c, ONE)
      c.pulse('clk')
      expectQ(c, ZERO)
      c.setMany({ j: ZERO, k: ZERO })
      c.pulse('clk')
      expectQ(c, ZERO)
    })
  })

  describe('asynchronous S/R (active low)', () => {
    it('S=0 sets Q=1 immediately, R=0 clears immediately, with the clock idle', () => {
      const c = jkff()
      c.set('s', ZERO)
      expectQ(c, ONE)
      c.set('s', ONE)
      expectQ(c, ONE)
      c.set('r', ZERO)
      expectQ(c, ZERO)
      c.set('r', ONE)
      expectQ(c, ZERO)
    })

    it('S=0 overrides falling edges in reset mode (J=0 K=1)', () => {
      const c = clear(jkff({ j: ZERO, k: ONE }))
      c.set('s', ZERO)
      expectQ(c, ONE)
      for (let i = 0; i < 3; i++) {
        c.pulse('clk')
        expectQ(c, ONE)
      }
      c.set('s', ONE)
      expectQ(c, ONE)
      c.pulse('clk')
      expectQ(c, ZERO)
    })

    it('R=0 overrides falling edges in set mode (J=1 K=0)', () => {
      const c = preset(jkff({ j: ONE, k: ZERO }))
      c.set('r', ZERO)
      expectQ(c, ZERO)
      for (let i = 0; i < 3; i++) {
        c.pulse('clk')
        expectQ(c, ZERO)
      }
      c.set('r', ONE)
      expectQ(c, ZERO)
      c.pulse('clk')
      expectQ(c, ONE)
    })

    it('R=0 overrides toggle mode', () => {
      const c = jkff({ j: ONE, k: ONE, r: ZERO })
      expectQ(c, ZERO)
      c.pulse('clk')
      c.pulse('clk')
      expectQ(c, ZERO)
      c.set('r', ONE)
      c.pulse('clk')
      expectQ(c, ONE)
    })

    it('releasing R after the clock fell under override does not act as a falling edge', () => {
      const c = preset(jkff({ clk: ONE, j: ONE, k: ZERO }))
      c.set('r', ZERO)
      expectQ(c, ZERO)
      c.fall('clk') // falling edge while R is active: ignored
      expectQ(c, ZERO)
      c.set('r', ONE) // CLK is still low: no edge, J=1 must not set
      expectQ(c, ZERO)
      c.rise('clk')
      expectQ(c, ZERO)
      c.fall('clk') // a genuine falling edge sets
      expectQ(c, ONE)
    })

    it('releasing S after the clock fell under override does not act as a falling edge', () => {
      const c = clear(jkff({ clk: ONE, j: ZERO, k: ONE }))
      c.set('s', ZERO)
      c.fall('clk')
      expectQ(c, ONE)
      c.set('s', ONE)
      expectQ(c, ONE)
      c.pulse('clk')
      expectQ(c, ZERO)
    })

    it('S=R=0 yields X, even while clocking', () => {
      const c = clear(jkff({ j: ONE, k: ZERO }))
      c.set('s', ZERO)
      c.set('r', ZERO)
      expectQ(c, X)
      c.pulse('clk')
      expectQ(c, X)
    })

    it('leaving S=R=0 by raising S first gives 0; raising R first gives 1', () => {
      const c = jkff({ s: ZERO, r: ZERO })
      c.set('s', ONE)
      expectQ(c, ZERO)
      c.set('r', ONE)
      expectQ(c, ZERO)
      const c2 = jkff({ s: ZERO, r: ZERO })
      c2.set('r', ONE)
      expectQ(c2, ONE)
      c2.set('s', ONE)
      expectQ(c2, ONE)
    })

    it('S unconnected (Z) yields X even with R=1 and clock edges', () => {
      const c = jkff({ j: ONE, k: ZERO }, ['S'])
      expect(c.pin(p('ff', 'S'))).toBe(Z)
      expectQ(c, X)
      c.pulse('clk')
      expectQ(c, X)
    })

    it('R unconnected (Z) yields X even with S=1 and clock edges', () => {
      const c = jkff({ j: ONE, k: ZERO }, ['R'])
      expect(c.pin(p('ff', 'R'))).toBe(Z)
      expectQ(c, X)
      c.pulse('clk')
      expectQ(c, X)
    })

    it('S at X yields X even during clock edges', () => {
      const c = addXSource(ffBuilder('jk', { j: ONE, k: ZERO }, ['S']), 'xs', 'or', ONE)
        .wire(p('xs', 'out'), p('ff', 'S'))
        .build()
      clear(c)
      expectQ(c, ZERO)
      c.set('xs_en', ZERO)
      expect(c.pin(p('ff', 'S'))).toBe(X)
      expectQ(c, X)
      c.pulse('clk')
      expectQ(c, X)
    })

    it('R at X yields X even during clock edges', () => {
      const c = addXSource(ffBuilder('jk', { j: ZERO, k: ONE }, ['R']), 'xr', 'or', ONE)
        .wire(p('xr', 'out'), p('ff', 'R'))
        .build()
      preset(c)
      expectQ(c, ONE)
      c.set('xr_en', ZERO)
      expect(c.pin(p('ff', 'R'))).toBe(X)
      expectQ(c, X)
      c.pulse('clk')
      expectQ(c, X)
    })
  })

  describe('J/K at X/Z', () => {
    it('J unconnected (Z) on the falling edge yields X', () => {
      const c = clear(jkff({ k: ZERO }, ['J']))
      expect(c.pin(p('ff', 'J'))).toBe(Z)
      c.pulse('clk')
      expectQ(c, X)
    })

    it('K unconnected (Z) on the falling edge yields X', () => {
      const c = preset(jkff({ j: ZERO }, ['K']))
      expect(c.pin(p('ff', 'K'))).toBe(Z)
      c.pulse('clk')
      expectQ(c, X)
    })

    it('J at X on the falling edge yields X; a clean edge afterwards recovers', () => {
      const c = addXSource(ffBuilder('jk', { k: ZERO }, ['J']), 'xj', 'or', ONE)
        .wire(p('xj', 'out'), p('ff', 'J'))
        .build()
      clear(c)
      c.set('xj_en', ZERO)
      expect(c.pin(p('ff', 'J'))).toBe(X)
      expectQ(c, ZERO)
      c.pulse('clk')
      expectQ(c, X)
      c.set('xj_en', ONE) // J=1, K=0: set
      c.pulse('clk')
      expectQ(c, ONE)
    })

    it('K at X while the clock is static does not disturb Q', () => {
      const c = addXSource(ffBuilder('jk', { j: ZERO }, ['K']), 'xk', 'or', ONE)
        .wire(p('xk', 'out'), p('ff', 'K'))
        .build()
      preset(c)
      c.set('xk_en', ZERO)
      expect(c.pin(p('ff', 'K'))).toBe(X)
      expectQ(c, ONE)
      c.rise('clk')
      expectQ(c, ONE)
    })
  })

  describe('CLK at X/Z', () => {
    const withMuxClock = (init: Init = {}): Circuit =>
      ffBuilder('jk', init, ['CLK'])
        .switch('clk', ONE)
        .switch('sel', ZERO)
        .add('mux', ComponentType.MUX_2)
        .wire(p('clk', 'out'), p('mux', 'in0'))
        .wire(p('sel', 'out'), p('mux', 'A'))
        .wire(p('mux', 'Z'), p('ff', 'CLK'))
        .build()

    const withTristateClock = (init: Init = {}): Circuit =>
      ffBuilder('jk', init, ['CLK'])
        .switch('clk', ONE)
        .switch('en', ONE)
        .add('ts', ComponentType.TRISTATE_RIGHT)
        .wire(p('clk', 'out'), p('ts', 'in'))
        .wire(p('en', 'out'), p('ts', 'ctl'))
        .wire(p('ts', 'out'), p('ff', 'CLK'))
        .build()

    it('CLK 1 -> X -> 0 produces no falling edge; a later clean 1 -> 0 toggles', () => {
      const c = clear(withMuxClock({ j: ONE, k: ONE }))
      expect(c.pin(p('ff', 'CLK'))).toBe(ONE)
      c.set('sel', ONE)
      expect(c.pin(p('ff', 'CLK'))).toBe(X)
      expectQ(c, ZERO)
      c.set('clk', ZERO) // CLK still X
      expectQ(c, ZERO)
      c.set('sel', ZERO) // CLK X -> 0
      expect(c.pin(p('ff', 'CLK'))).toBe(ZERO)
      expectQ(c, ZERO)
      c.set('clk', ONE)
      c.set('clk', ZERO) // clean falling edge
      expectQ(c, ONE)
    })

    it('CLK 0 -> X -> 1 produces no edge for the J-K either', () => {
      const c = clear(withMuxClock({ j: ONE, k: ONE }))
      c.set('clk', ZERO) // clean falling edge: Q <= 1
      expectQ(c, ONE)
      c.set('sel', ONE) // CLK 0 -> X
      c.set('clk', ONE)
      c.set('sel', ZERO) // CLK X -> 1
      expectQ(c, ONE)
      c.set('clk', ZERO) // clean falling edge
      expectQ(c, ZERO)
    })

    it('CLK 1 -> Z -> 0 produces no falling edge; a later clean 1 -> 0 toggles', () => {
      const c = clear(withTristateClock({ j: ONE, k: ONE }))
      c.set('en', ZERO)
      expect(c.pin(p('ff', 'CLK'))).toBe(Z)
      expectQ(c, ZERO)
      c.set('clk', ZERO)
      expectQ(c, ZERO)
      c.set('en', ONE) // CLK Z -> 0
      expect(c.pin(p('ff', 'CLK'))).toBe(ZERO)
      expectQ(c, ZERO)
      c.set('clk', ONE)
      c.set('clk', ZERO)
      expectQ(c, ONE)
    })

    it('CLK unconnected: Q never leaves X through clocking, but S/R still work', () => {
      const c = jkff({ j: ONE, k: ZERO }, ['CLK'])
      expect(c.pin(p('ff', 'CLK'))).toBe(Z)
      expectQ(c, X)
      c.set('j', ZERO)
      c.set('j', ONE)
      expectQ(c, X)
      preset(c)
      expectQ(c, ONE)
      clear(c)
      expectQ(c, ZERO)
    })
  })
})

// ---------------------------------------------------------------------------
// CLOCK part: step() and go()
// ---------------------------------------------------------------------------

describe('CLOCK part driving a flip-flop', () => {
  /** D FF: D from switch (1), S/R switches, CLK from the CLOCK part. */
  function clockedD(clockInitialValue: LogicValue): Circuit {
    return new CircuitBuilder()
      .setSimulation({ clockInitialValue, clockPeriodNs: 20, simTimeNs: 100 })
      .add('clock', ComponentType.CLOCK)
      .switch('d', ONE)
      .switch('s', ONE)
      .switch('r', ONE)
      .add('ff', ComponentType.D_FLIPFLOP)
      .probe('q')
      .probe('qn')
      .wire(p('clock', 'out'), p('ff', 'CLK'))
      .wire(p('d', 'out'), p('ff', 'D'))
      .wire(p('s', 'out'), p('ff', 'S'))
      .wire(p('r', 'out'), p('ff', 'R'))
      .wire(p('ff', 'Q'), p('q', 'in'))
      .wire(p('ff', "Q'"), p('qn', 'in'))
      .build()
  }

  /** J-K T flip-flop: J=K=S=1 from VCC, R from a switch, CLK from the CLOCK part. */
  function clockedT(clockInitialValue: LogicValue): Circuit {
    return new CircuitBuilder()
      .setSimulation({ clockInitialValue, clockPeriodNs: 20, simTimeNs: 100 })
      .add('clock', ComponentType.CLOCK)
      .add('vcc', ComponentType.VCC)
      .switch('r', ONE)
      .add('ff', ComponentType.JK_FLIPFLOP)
      .probe('q')
      .probe('qn')
      .wire(p('clock', 'out'), p('ff', 'CLK'))
      .connect(p('vcc', 'out'), p('ff', 'J'), p('ff', 'K'), p('ff', 'S'))
      .wire(p('r', 'out'), p('ff', 'R'))
      .wire(p('ff', 'Q'), p('q', 'in'))
      .wire(p('ff', "Q'"), p('qn', 'in'))
      .build()
  }

  describe('rising-edge mode (clock initial value 1, period 20)', () => {
    it('clock output starts at 1', () => {
      expect(clockedD(ONE).pin(p('ff', 'CLK'))).toBe(ONE)
    })

    it('D FF: step 1 ends at 15 ns before any rising edge; step 2 (edge at 20 ns) captures D at 21 ns', () => {
      const c = clear(clockedD(ONE))
      expectQ(c, ZERO)
      c.step()
      expect(c.time).toBe(15)
      expect(c.pin(p('ff', 'CLK'))).toBe(ZERO) // fell at 10 ns
      expectQ(c, ZERO)
      c.step()
      expect(c.time).toBe(35)
      expectQ(c, ONE)
      expect(samplesOf(c, 'q', 10)).toEqual([[21, ONE]])
      c.set('d', ZERO)
      expectQ(c, ONE)
      c.step()
      expect(c.time).toBe(55)
      expectQ(c, ZERO)
      expect(samplesOf(c, 'q', 10)).toEqual([
        [21, ONE],
        [41, ZERO]
      ])
    })

    it('J-K T FF: toggles at the falling edges 10, 30, 50 ns, i.e. once inside every step', () => {
      const c = clear(clockedT(ONE))
      expectQ(c, ZERO)
      c.step()
      expect(c.time).toBe(15)
      expectQ(c, ONE)
      c.step()
      expect(c.time).toBe(35)
      expectQ(c, ZERO)
      c.step()
      expect(c.time).toBe(55)
      expectQ(c, ONE)
      expect(samplesOf(c, 'q', 10)).toEqual([
        [11, ONE],
        [31, ZERO],
        [51, ONE]
      ])
    })

    it('J-K T FF divide-by-2 with go(): runs to 95 ns, toggling at 11/31/51/71/91 ns', () => {
      const c = clear(clockedT(ONE))
      c.go()
      expect(c.time).toBe(95)
      expectQ(c, ONE)
      const s = samplesOf(c, 'q', 10)
      expect(s).toEqual([
        [11, ONE],
        [31, ZERO],
        [51, ONE],
        [71, ZERO],
        [91, ONE]
      ])
      // Divide by two: consecutive same-direction transitions are 2 clock periods apart.
      for (let i = 2; i < s.length; i++) expect(s[i][0] - s[i - 2][0]).toBe(40)
      expect(samplesOf(c, 'qn', 10)).toEqual(s.map(([t, v]) => [t, not(v)]))
    })

    it("D FF with D fed from Q' toggles once per rising edge (20/40/60/80 ns) with go()", () => {
      const c = new CircuitBuilder()
        .setSimulation({ clockInitialValue: ONE, clockPeriodNs: 20, simTimeNs: 100 })
        .add('clock', ComponentType.CLOCK)
        .add('vcc', ComponentType.VCC)
        .switch('r', ONE)
        .add('ff', ComponentType.D_FLIPFLOP)
        .probe('q')
        .wire(p('clock', 'out'), p('ff', 'CLK'))
        .wire(p('vcc', 'out'), p('ff', 'S'))
        .wire(p('r', 'out'), p('ff', 'R'))
        .wire(p('ff', "Q'"), p('ff', 'D'))
        .wire(p('ff', 'Q'), p('q', 'in'))
        .build()
      clear(c)
      expect(c.pin(p('ff', 'D'))).toBe(ONE)
      c.go()
      expect(c.time).toBe(95)
      expect(samplesOf(c, 'q', 10)).toEqual([
        [21, ONE],
        [41, ZERO],
        [61, ONE],
        [81, ZERO]
      ])
    })
  })

  describe('falling-edge mode (clock initial value 0, period 20)', () => {
    it('clock output starts at 0', () => {
      expect(clockedD(ZERO).pin(p('ff', 'CLK'))).toBe(ZERO)
    })

    it('D FF: the rising edge at 10 ns falls inside step 1, so Q=D at 11 ns', () => {
      const c = clear(clockedD(ZERO))
      c.step()
      expect(c.time).toBe(15)
      expect(c.pin(p('ff', 'CLK'))).toBe(ONE)
      expectQ(c, ONE)
      expect(samplesOf(c, 'q', 10)).toEqual([[11, ONE]])
      c.set('d', ZERO)
      c.step()
      expect(c.time).toBe(35)
      expectQ(c, ZERO) // rising edge at 30 ns
      expect(samplesOf(c, 'q', 10)).toEqual([
        [11, ONE],
        [31, ZERO]
      ])
    })

    it('J-K T FF: step 1 ends at 15 ns before the first falling edge; step 2 (edge at 20 ns) toggles at 21 ns', () => {
      const c = clear(clockedT(ZERO))
      c.step()
      expect(c.time).toBe(15)
      expectQ(c, ZERO)
      c.step()
      expect(c.time).toBe(35)
      expectQ(c, ONE)
      c.step()
      expect(c.time).toBe(55)
      expectQ(c, ZERO)
      expect(samplesOf(c, 'q', 10)).toEqual([
        [21, ONE],
        [41, ZERO]
      ])
    })

    it('J-K T FF divide-by-2 with go(): toggles at 21/41/61/81 ns and ends at 95 ns', () => {
      const c = clear(clockedT(ZERO))
      c.go()
      expect(c.time).toBe(95)
      expectQ(c, ZERO)
      expect(samplesOf(c, 'q', 10)).toEqual([
        [21, ONE],
        [41, ZERO],
        [61, ONE],
        [81, ZERO]
      ])
    })
  })
})

// ---------------------------------------------------------------------------
// Composition: race-through and ripple counters
// ---------------------------------------------------------------------------

describe('two D flip-flops in series (shift register) move data one stage per edge', () => {
  function shiftRegister(delay1: number, delay2: number): Circuit {
    return new CircuitBuilder()
      .switch('d', ZERO)
      .switch('clk', ZERO)
      .switch('r', ONE)
      .add('vcc', ComponentType.VCC)
      .add('ff1', ComponentType.D_FLIPFLOP, { delay: delay1 })
      .add('ff2', ComponentType.D_FLIPFLOP, { delay: delay2 })
      .probe('q1')
      .probe('q2')
      .wire(p('d', 'out'), p('ff1', 'D'))
      .wire(p('ff1', 'Q'), p('ff2', 'D'))
      .connect(p('clk', 'out'), p('ff1', 'CLK'), p('ff2', 'CLK'))
      .connect(p('vcc', 'out'), p('ff1', 'S'), p('ff2', 'S'))
      .connect(p('r', 'out'), p('ff1', 'R'), p('ff2', 'R'))
      .wire(p('ff1', 'Q'), p('q1', 'in'))
      .wire(p('ff2', 'Q'), p('q2', 'in'))
      .build()
  }

  const stages = (c: Circuit): string => `${c.pin(p('q1', 'in'))}${c.pin(p('q2', 'in'))}`

  it.each([
    [1, 1],
    [1, 3],
    [3, 1],
    [3, 3]
  ])('FF1 delay %i ns / FF2 delay %i ns', (d1, d2) => {
    const c = shiftRegister(d1, d2)
    expect(stages(c)).toBe('XX')
    clear(c)
    expect(stages(c)).toBe('00')
    c.set('d', ONE)
    c.pulse('clk')
    expect(stages(c)).toBe('10')
    c.pulse('clk')
    expect(stages(c)).toBe('11')
    c.set('d', ZERO)
    c.pulse('clk')
    expect(stages(c)).toBe('01')
    c.pulse('clk')
    expect(stages(c)).toBe('00')
    // A single 1 travels through both stages, one per edge.
    c.set('d', ONE)
    c.pulse('clk')
    c.set('d', ZERO)
    expect(stages(c)).toBe('10')
    c.pulse('clk')
    expect(stages(c)).toBe('01')
    c.pulse('clk')
    expect(stages(c)).toBe('00')
  })

  it('rising edges only: the falling edge never shifts', () => {
    const c = clear(shiftRegister(1, 1))
    c.set('d', ONE)
    c.rise('clk')
    expect(stages(c)).toBe('10')
    c.fall('clk')
    expect(stages(c)).toBe('10')
    c.rise('clk')
    expect(stages(c)).toBe('11')
  })

  it('with the CLOCK part (FF1 delay 3 / FF2 delay 1) the data still moves one stage per period', () => {
    const c = new CircuitBuilder()
      .setSimulation({ clockInitialValue: ONE, clockPeriodNs: 20, simTimeNs: 100 })
      .add('clock', ComponentType.CLOCK)
      .switch('d', ONE)
      .switch('r', ONE)
      .add('vcc', ComponentType.VCC)
      .add('ff1', ComponentType.D_FLIPFLOP, { delay: 3 })
      .add('ff2', ComponentType.D_FLIPFLOP, { delay: 1 })
      .probe('q1')
      .probe('q2')
      .wire(p('d', 'out'), p('ff1', 'D'))
      .wire(p('ff1', 'Q'), p('ff2', 'D'))
      .connect(p('clock', 'out'), p('ff1', 'CLK'), p('ff2', 'CLK'))
      .connect(p('vcc', 'out'), p('ff1', 'S'), p('ff2', 'S'))
      .connect(p('r', 'out'), p('ff1', 'R'), p('ff2', 'R'))
      .wire(p('ff1', 'Q'), p('q1', 'in'))
      .wire(p('ff2', 'Q'), p('q2', 'in'))
      .build()
    clear(c)
    c.step() // 15 ns, no rising edge yet
    expect(stages(c)).toBe('00')
    c.step() // rising edge at 20 ns
    expect(stages(c)).toBe('10')
    expect(samplesOf(c, 'q1', 10)).toEqual([[23, ONE]])
    c.step() // rising edge at 40 ns
    expect(stages(c)).toBe('11')
    expect(samplesOf(c, 'q2', 10)).toEqual([[41, ONE]])
  })
})

describe('3-stage J-K ripple counter (J=K=1, each CLK fed by the previous stage)', () => {
  function ripple(feed: 'Q' | "Q'"): Circuit {
    return new CircuitBuilder()
      .switch('clk', ZERO)
      .switch('r', ONE)
      .add('vcc', ComponentType.VCC)
      .add('ff0', ComponentType.JK_FLIPFLOP)
      .add('ff1', ComponentType.JK_FLIPFLOP)
      .add('ff2', ComponentType.JK_FLIPFLOP)
      .probe('q0')
      .probe('q1')
      .probe('q2')
      .wire(p('clk', 'out'), p('ff0', 'CLK'))
      .wire(p('ff0', feed), p('ff1', 'CLK'))
      .wire(p('ff1', feed), p('ff2', 'CLK'))
      .connect(
        p('vcc', 'out'),
        p('ff0', 'J'),
        p('ff0', 'K'),
        p('ff0', 'S'),
        p('ff1', 'J'),
        p('ff1', 'K'),
        p('ff1', 'S'),
        p('ff2', 'J'),
        p('ff2', 'K'),
        p('ff2', 'S')
      )
      .connect(p('r', 'out'), p('ff0', 'R'), p('ff1', 'R'), p('ff2', 'R'))
      .wire(p('ff0', 'Q'), p('q0', 'in'))
      .wire(p('ff1', 'Q'), p('q1', 'in'))
      .wire(p('ff2', 'Q'), p('q2', 'in'))
      .build()
  }

  function count(c: Circuit): number | null {
    let n = 0
    for (let i = 2; i >= 0; i--) {
      const v = c.pin(p(`q${i}`, 'in'))
      if (!isClean(v)) return null
      n = n * 2 + (v === ONE ? 1 : 0)
    }
    return n
  }

  it('is X before a clear and 0 after it', () => {
    const c = ripple('Q')
    expect(count(c)).toBeNull()
    clear(c)
    expect(count(c)).toBe(0)
  })

  it('clocked from Q it counts UP 0..7 and wraps, one count per falling edge of the input', () => {
    const c = clear(ripple('Q'))
    for (let i = 1; i <= 16; i++) {
      c.rise('clk')
      expect(count(c)).toBe((i - 1) % 8) // rising edge: no count
      c.fall('clk')
      expect(count(c)).toBe(i % 8)
    }
  })

  it("clocked from Q' it counts DOWN 7..0 and wraps", () => {
    const c = clear(ripple("Q'"))
    for (let i = 1; i <= 16; i++) {
      c.pulse('clk')
      expect(count(c)).toBe((8 - (i % 8)) % 8)
    }
  })

  it('R=0 clears all stages asynchronously mid-count and counting resumes from 0', () => {
    const c = clear(ripple('Q'))
    for (let i = 0; i < 5; i++) c.pulse('clk')
    expect(count(c)).toBe(5)
    c.set('r', ZERO)
    expect(count(c)).toBe(0)
    c.pulse('clk')
    expect(count(c)).toBe(0)
    c.set('r', ONE)
    c.pulse('clk')
    expect(count(c)).toBe(1)
  })

  it('driven by the CLOCK part (initial 1, period 20) with go(): 5 falling edges by 95 ns give count 5, rippling 1 ns per stage', () => {
    const c = new CircuitBuilder()
      .setSimulation({ clockInitialValue: ONE, clockPeriodNs: 20, simTimeNs: 100 })
      .add('clock', ComponentType.CLOCK)
      .switch('r', ONE)
      .add('vcc', ComponentType.VCC)
      .add('ff0', ComponentType.JK_FLIPFLOP)
      .add('ff1', ComponentType.JK_FLIPFLOP)
      .add('ff2', ComponentType.JK_FLIPFLOP)
      .probe('q0')
      .probe('q1')
      .probe('q2')
      .wire(p('clock', 'out'), p('ff0', 'CLK'))
      .wire(p('ff0', 'Q'), p('ff1', 'CLK'))
      .wire(p('ff1', 'Q'), p('ff2', 'CLK'))
      .connect(
        p('vcc', 'out'),
        p('ff0', 'J'),
        p('ff0', 'K'),
        p('ff0', 'S'),
        p('ff1', 'J'),
        p('ff1', 'K'),
        p('ff1', 'S'),
        p('ff2', 'J'),
        p('ff2', 'K'),
        p('ff2', 'S')
      )
      .connect(p('r', 'out'), p('ff0', 'R'), p('ff1', 'R'), p('ff2', 'R'))
      .wire(p('ff0', 'Q'), p('q0', 'in'))
      .wire(p('ff1', 'Q'), p('q1', 'in'))
      .wire(p('ff2', 'Q'), p('q2', 'in'))
      .build()
    clear(c)
    c.go()
    expect(c.time).toBe(95)
    expect(count(c)).toBe(5)
    // Clock falls at 10/30/50/70/90; Q0 toggles 1 ns later, Q1 on Q0's falls, Q2 on Q1's.
    expect(samplesOf(c, 'q0', 10)).toEqual([
      [11, ONE],
      [31, ZERO],
      [51, ONE],
      [71, ZERO],
      [91, ONE]
    ])
    expect(samplesOf(c, 'q1', 10)).toEqual([
      [32, ONE],
      [72, ZERO]
    ])
    expect(samplesOf(c, 'q2', 10)).toEqual([[73, ONE]])
  })
})

// ---------------------------------------------------------------------------
// Implementation decision 1: all changes queued for one instant are applied to
// their nets before any part is evaluated, so a clocked part whose data and
// clock change at the same instant samples the NEW data.
// ---------------------------------------------------------------------------

describe('same-instant data and clock changes sample the new data (decision 1)', () => {
  it('D FF: D 0 -> 1 together with CLK 0 -> 1 captures 1', () => {
    const c = clear(dff({ d: ZERO }))
    c.setMany({ d: ONE, clk: ONE })
    expectQ(c, ONE)
  })

  it('D FF: D 1 -> 0 together with CLK 0 -> 1 captures 0', () => {
    const c = preset(dff({ d: ONE }))
    c.setMany({ d: ZERO, clk: ONE })
    expectQ(c, ZERO)
  })

  it('D FF: D changing together with the FALLING edge changes nothing', () => {
    const c = clear(dff({ d: ZERO, clk: ONE }))
    c.setMany({ d: ONE, clk: ZERO })
    expectQ(c, ZERO)
  })

  it('J-K: J 0 -> 1 together with CLK 1 -> 0 sets', () => {
    const c = clear(jkff({ clk: ONE }))
    c.setMany({ j: ONE, clk: ZERO })
    expectQ(c, ONE)
  })

  it('J-K: K 0 -> 1 together with CLK 1 -> 0 resets', () => {
    const c = preset(jkff({ clk: ONE }))
    c.setMany({ k: ONE, clk: ZERO })
    expectQ(c, ZERO)
  })

  it('J-K: J and K 0 -> 1 together with CLK 1 -> 0 toggles', () => {
    const c = clear(jkff({ clk: ONE }))
    c.setMany({ j: ONE, k: ONE, clk: ZERO })
    expectQ(c, ONE)
    c.rise('clk')
    c.setMany({ j: ZERO, k: ZERO, clk: ZERO }) // J/K drop to hold at the edge: hold
    expectQ(c, ONE)
  })

  it('S asserted together with a rising edge overrides the captured D', () => {
    const c = clear(dff({ d: ZERO }))
    c.setMany({ s: ZERO, clk: ONE })
    expectQ(c, ONE)
  })

  it('R asserted together with a falling edge overrides J=1', () => {
    const c = preset(jkff({ clk: ONE, j: ONE }))
    c.setMany({ r: ZERO, clk: ZERO })
    expectQ(c, ZERO)
  })

  it('with the CLOCK part: a D change arriving exactly at the rising edge is captured by that edge', () => {
    // D = AND2(d switch, VCC) with delay 4. Toggling d at t=15 moves the switch
    // output at 16 and D at 20 -- the very instant of the rising edge.
    const c = new CircuitBuilder()
      .setSimulation({ clockInitialValue: ONE, clockPeriodNs: 20, simTimeNs: 100 })
      .add('clock', ComponentType.CLOCK)
      .switch('d', ZERO)
      .switch('r', ONE)
      .add('vcc', ComponentType.VCC)
      .add('buf', ComponentType.AND2, { delay: 4 })
      .add('ff', ComponentType.D_FLIPFLOP)
      .probe('q')
      .probe('dd')
      .wire(p('clock', 'out'), p('ff', 'CLK'))
      .wire(p('d', 'out'), p('buf', 'in1'))
      .wire(p('vcc', 'out'), p('buf', 'in2'))
      .wire(p('buf', 'out'), p('ff', 'D'))
      .wire(p('buf', 'out'), p('dd', 'in'))
      .wire(p('vcc', 'out'), p('ff', 'S'))
      .wire(p('r', 'out'), p('ff', 'R'))
      .wire(p('ff', 'Q'), p('q', 'in'))
      .build()
    clear(c)
    c.step()
    expect(c.time).toBe(15)
    c.sim.toggle('d', false)
    c.step()
    expect(c.time).toBe(35)
    expect(samplesOf(c, 'dd', 1)).toEqual([[20, ONE]])
    expect(samplesOf(c, 'q', 10)).toEqual([[21, ONE]])
    expect(c.pin(p('q', 'in'))).toBe(ONE)
  })
})

describe('buffered clock race between two D flip-flops (decision 1)', () => {
  /**
   * FF1.Q -> FF2.D. FF1 is clocked by the switch directly; FF2's clock goes
   * through an AND2 buffer (delay 1), so FF2's edge arrives 1 ns after FF1's.
   */
  function raced(delay1: number): Circuit {
    return new CircuitBuilder()
      .switch('d', ZERO)
      .switch('clk', ZERO)
      .switch('r', ONE)
      .add('vcc', ComponentType.VCC)
      .add('buf', ComponentType.AND2)
      .add('ff1', ComponentType.D_FLIPFLOP, { delay: delay1 })
      .add('ff2', ComponentType.D_FLIPFLOP)
      .probe('q1')
      .probe('q2')
      .wire(p('d', 'out'), p('ff1', 'D'))
      .wire(p('ff1', 'Q'), p('ff2', 'D'))
      .wire(p('clk', 'out'), p('ff1', 'CLK'))
      .wire(p('clk', 'out'), p('buf', 'in1'))
      .wire(p('vcc', 'out'), p('buf', 'in2'))
      .wire(p('buf', 'out'), p('ff2', 'CLK'))
      .connect(p('vcc', 'out'), p('ff1', 'S'), p('ff2', 'S'))
      .connect(p('r', 'out'), p('ff1', 'R'), p('ff2', 'R'))
      .wire(p('ff1', 'Q'), p('q1', 'in'))
      .wire(p('ff2', 'Q'), p('q2', 'in'))
      .build()
  }

  const stages = (c: Circuit): string => `${c.pin(p('q1', 'in'))}${c.pin(p('q2', 'in'))}`

  it('FF1 delay 1: Q1 reaches FF2.D at the same instant as the buffered edge, so FF2 takes the NEW value (race-through)', () => {
    const c = clear(raced(1))
    c.set('d', ONE)
    c.rise('clk')
    expect(stages(c)).toBe('11')
    c.fall('clk')
    c.set('d', ZERO)
    c.rise('clk')
    expect(stages(c)).toBe('00')
  })

  it('FF1 delay 2: Q1 changes 1 ns after the buffered edge, so FF2 takes the OLD value (proper shift)', () => {
    const c = clear(raced(2))
    c.set('d', ONE)
    c.rise('clk')
    expect(stages(c)).toBe('10')
    c.fall('clk')
    c.rise('clk')
    expect(stages(c)).toBe('11')
    c.fall('clk')
    c.set('d', ZERO)
    c.pulse('clk')
    expect(stages(c)).toBe('01')
    c.pulse('clk')
    expect(stages(c)).toBe('00')
  })
})

// ---------------------------------------------------------------------------
// Time, traces and output delay (decisions 2 and 4)
// ---------------------------------------------------------------------------

describe('time, traces and output delay', () => {
  it('time is 0 right after build() and again after reset()', () => {
    const c = dff()
    expect(c.time).toBe(0)
    clear(c)
    expect(c.time).toBeGreaterThan(0)
    c.reset()
    expect(c.time).toBe(0)
  })

  it("probe traces start with a single t=0 sample: X on both Q and Q'", () => {
    const c = dff()
    expect(samplesOf(c, 'q')).toEqual([[0, X]])
    expect(samplesOf(c, 'qn')).toEqual([[0, X]])
    const j = jkff({ r: ZERO })
    expect(samplesOf(j, 'q')).toEqual([[0, ZERO]])
    expect(samplesOf(j, 'qn')).toEqual([[0, ONE]])
  })

  it("Q and Q' change together, 1 ns after the switch-driven edge (default delay 1)", () => {
    const c = clear(dff({ d: ONE }))
    const t0 = c.time
    c.rise('clk') // switch output at t0+1, Q at t0+2
    expect(samplesOf(c, 'q', t0 + 1)).toEqual([[t0 + 2, ONE]])
    expect(samplesOf(c, 'qn', t0 + 1)).toEqual([[t0 + 2, ZERO]])
  })

  /** D FF with the given delay: D=1, S from VCC, R and CLK from switches. */
  function delayedD(delay: number): Circuit {
    return new CircuitBuilder()
      .switch('clk', ZERO)
      .switch('r', ONE)
      .switch('d', ONE)
      .add('vcc', ComponentType.VCC)
      .add('ff', ComponentType.D_FLIPFLOP, { delay })
      .probe('q')
      .probe('qn')
      .wire(p('clk', 'out'), p('ff', 'CLK'))
      .wire(p('d', 'out'), p('ff', 'D'))
      .wire(p('vcc', 'out'), p('ff', 'S'))
      .wire(p('r', 'out'), p('ff', 'R'))
      .wire(p('ff', 'Q'), p('q', 'in'))
      .wire(p('ff', "Q'"), p('qn', 'in'))
      .build()
  }

  it('a D FF with delay 3 changes Q 3 ns after the edge, and an async clear also takes 3 ns', () => {
    const c = clear(delayedD(3))
    const t0 = c.time
    c.rise('clk')
    expect(samplesOf(c, 'q', t0 + 1)).toEqual([[t0 + 4, ONE]])
    expect(samplesOf(c, 'qn', t0 + 1)).toEqual([[t0 + 4, ZERO]])
    const t1 = c.time
    c.set('r', ZERO)
    expect(samplesOf(c, 'q', t1 + 1)).toEqual([[t1 + 4, ZERO]])
  })

  it('inertial delay: an async clear 1 ns after the edge cancels the pending Q=1 of a delay-3 FF (no glitch)', () => {
    const c = clear(delayedD(3))
    const t0 = c.time
    c.sim.toggle('clk', false) // switch output -> 1 at t0+1
    expect(c.sim.changeStep()).toBe(true) // rising edge at t0+1; Q=1 pending for t0+4
    expect(c.time).toBe(t0 + 1)
    c.sim.toggle('r', false) // R -> 0 at t0+2, before the pending Q change lands
    c.sim.drain()
    expect(c.pin(p('q', 'in'))).toBe(ZERO)
    expect(c.pin(p('qn', 'in'))).toBe(ONE)
    expect(samplesOf(c, 'q', t0 + 1)).toEqual([])
    expect(samplesOf(c, 'qn', t0 + 1)).toEqual([])
  })

  it('a Q pulse as long as the delay does appear: delay-1 FF cleared 1 ns after the edge shows a 1 ns high', () => {
    const c = clear(delayedD(1))
    const t0 = c.time
    c.sim.toggle('clk', false)
    expect(c.sim.changeStep()).toBe(true) // t0+1: edge, Q=1 due at t0+2
    c.sim.toggle('r', false) // R=0 lands at t0+2 too: Q=0 due at t0+3
    c.sim.drain()
    expect(samplesOf(c, 'q', t0 + 1)).toEqual([
      [t0 + 2, ONE],
      [t0 + 3, ZERO]
    ])
  })

  it('short clock period (4 ns) after live-mode switch toggles: time never runs backwards and traces stay ordered', () => {
    // clear() advances live time by a few ns before the first step(). The clock
    // schedule must not replay edges that lie in the past.
    const c = new CircuitBuilder()
      .setSimulation({ clockInitialValue: ONE, clockPeriodNs: 4, simTimeNs: 100 })
      .add('clock', ComponentType.CLOCK)
      .switch('d', ONE)
      .switch('r', ONE)
      .add('vcc', ComponentType.VCC)
      .add('ff', ComponentType.D_FLIPFLOP)
      .probe('q')
      .probe('ck')
      .wire(p('clock', 'out'), p('ff', 'CLK'))
      .wire(p('clock', 'out'), p('ck', 'in'))
      .wire(p('d', 'out'), p('ff', 'D'))
      .wire(p('vcc', 'out'), p('ff', 'S'))
      .wire(p('r', 'out'), p('ff', 'R'))
      .wire(p('ff', 'Q'), p('q', 'in'))
      .build()
    clear(c)
    const t0 = c.time
    expect(t0).toBeGreaterThan(0)
    let prev = t0
    for (let i = 0; i < 4; i++) {
      c.step()
      expect(c.time).toBeGreaterThan(prev)
      prev = c.time
    }
    for (const id of ['ck', 'q']) {
      const times = samplesOf(c, id).map(([t]) => t)
      for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThanOrEqual(times[i - 1])
    }
    // The clock at the probe alternates and each rising edge captures D=1.
    const ck = samplesOf(c, 'ck', 1)
    for (let i = 1; i < ck.length; i++) expect(ck[i][1]).toBe(not(ck[i - 1][1]))
    expect(c.pin(p('q', 'in'))).toBe(ONE)
  })

  it('default period (20 ns): clock toggles already in the past when Step is first pressed are not replayed; traces stay ordered', () => {
    // Falling-edge mode: the clock's first toggle (0 -> 1) is at 10 ns. Enough
    // live-mode switch toggles push time past 13 ns, with the last Q sample at
    // 12 ns. The first step() must not apply that 10 ns edge "now" (which would
    // set time backwards and append a Q sample at 11 ns after the one at 12 ns).
    const c = new CircuitBuilder()
      .setSimulation({ clockInitialValue: ZERO, clockPeriodNs: 20, simTimeNs: 100 })
      .add('clock', ComponentType.CLOCK)
      .switch('d', ONE)
      .switch('s', ONE)
      .switch('r', ONE)
      .add('ff', ComponentType.D_FLIPFLOP)
      .probe('q')
      .probe('ck')
      .wire(p('clock', 'out'), p('ff', 'CLK'))
      .wire(p('clock', 'out'), p('ck', 'in'))
      .wire(p('d', 'out'), p('ff', 'D'))
      .wire(p('s', 'out'), p('ff', 'S'))
      .wire(p('r', 'out'), p('ff', 'R'))
      .wire(p('ff', 'Q'), p('q', 'in'))
      .build()
    clear(c)
    preset(c)
    c.set('d', ZERO)
    c.set('d', ONE)
    c.set('d', ZERO)
    c.set('d', ONE)
    clear(c)
    const before = c.time
    expect(before).toBeGreaterThan(10)
    const qBefore = samplesOf(c, 'q')
    expect(qBefore[qBefore.length - 1][0]).toBeGreaterThan(10)
    expect(c.pin(p('q', 'in'))).toBe(ZERO)

    c.step()
    expect(c.time).toBeGreaterThan(before)
    const qTimes = samplesOf(c, 'q').map(([t]) => t)
    for (let i = 1; i < qTimes.length; i++) expect(qTimes[i]).toBeGreaterThanOrEqual(qTimes[i - 1])
    // No clock change may be applied at an instant earlier than the time already reached.
    for (const [t] of samplesOf(c, 'ck', 1)) expect(t).toBeGreaterThanOrEqual(before)
  })
})

// ---------------------------------------------------------------------------
// Additional coverage: Z drivers on S/R, same-instant S/R release on the J-K,
// live-mode divide-by-two, delayed ripple counter, reset re-arming the edge
// detector, clock pulses shorter than the part delay, and relative Go.
// ---------------------------------------------------------------------------

describe('S/R driven Z by a disabled tristate (a driver, not an open pin)', () => {
  /** `pin` of the flip-flop comes from a tristate(in=1, ctl=`en` switch). */
  function withTristateOn(kind: FlipFlopKind, pin: 'S' | 'R', init: Init = {}): Circuit {
    return ffBuilder(kind, init, [pin])
      .add('vcc', ComponentType.VCC)
      .switch('en', ONE)
      .add('ts', ComponentType.TRISTATE_RIGHT)
      .wire(p('vcc', 'out'), p('ts', 'in'))
      .wire(p('en', 'out'), p('ts', 'ctl'))
      .wire(p('ts', 'out'), p('ff', pin))
      .build()
  }

  it('D FF: S floating to Z yields X, and re-driving 1 leaves X until an edge', () => {
    const c = withTristateOn('d', 'S', { d: ONE })
    clear(c)
    expectQ(c, ZERO)
    c.set('en', ZERO)
    expect(c.pin(p('ff', 'S'))).toBe(Z)
    expectQ(c, X)
    c.pulse('clk')
    expectQ(c, X)
    c.set('en', ONE)
    expectQ(c, X)
    c.rise('clk')
    expectQ(c, ONE)
  })

  it('D FF: R floating to Z yields X even with S=0 asserted', () => {
    const c = withTristateOn('d', 'R', { d: ONE })
    preset(c)
    expectQ(c, ONE)
    c.set('en', ZERO)
    expect(c.pin(p('ff', 'R'))).toBe(Z)
    expectQ(c, X)
    c.set('s', ZERO)
    expectQ(c, X)
  })

  it('J-K: S floating to Z yields X even during falling edges in set mode', () => {
    const c = withTristateOn('jk', 'S', { j: ONE, k: ZERO })
    clear(c)
    c.set('en', ZERO)
    expectQ(c, X)
    c.pulse('clk')
    expectQ(c, X)
    c.set('en', ONE)
    c.pulse('clk')
    expectQ(c, ONE)
  })

  it('J-K: R floating to Z yields X', () => {
    const c = withTristateOn('jk', 'R', { j: ZERO, k: ONE })
    preset(c)
    c.set('en', ZERO)
    expect(c.pin(p('ff', 'R'))).toBe(Z)
    expectQ(c, X)
  })
})

describe('J-K: same-instant S/R release (decision 1)', () => {
  it('releasing S and R together from S=R=0 leaves Q at X until a falling edge resolves it', () => {
    const c = jkff({ clk: ONE, j: ONE, k: ZERO, s: ZERO, r: ZERO })
    expectQ(c, X)
    c.setMany({ s: ONE, r: ONE })
    expectQ(c, X)
    c.fall('clk')
    expectQ(c, ONE)
  })

  it('toggling an X after a simultaneous release keeps X', () => {
    const c = jkff({ clk: ONE, j: ONE, k: ONE, s: ZERO, r: ZERO })
    c.setMany({ s: ONE, r: ONE })
    c.fall('clk')
    expectQ(c, X)
  })
})

describe('S/R released at the same instant as the active edge (decision 1)', () => {
  it('D FF: S 0 -> 1 together with CLK 0 -> 1 captures D', () => {
    const c = clear(dff({ d: ZERO }))
    c.set('s', ZERO)
    expectQ(c, ONE)
    c.setMany({ s: ONE, clk: ONE })
    expectQ(c, ZERO)
  })

  it('D FF: R 0 -> 1 together with CLK 0 -> 1 captures D', () => {
    const c = dff({ d: ONE, r: ZERO })
    expectQ(c, ZERO)
    c.setMany({ r: ONE, clk: ONE })
    expectQ(c, ONE)
  })

  it('J-K: R 0 -> 1 together with CLK 1 -> 0 applies J=1 (set)', () => {
    const c = jkff({ clk: ONE, j: ONE, k: ZERO, r: ZERO })
    expectQ(c, ZERO)
    c.setMany({ r: ONE, clk: ZERO })
    expectQ(c, ONE)
  })

  it('J-K: S 0 -> 1 together with CLK 0 -> 1 (inactive edge) holds', () => {
    const c = jkff({ clk: ZERO, j: ZERO, k: ONE, s: ZERO })
    expectQ(c, ONE)
    c.setMany({ s: ONE, clk: ONE })
    expectQ(c, ONE)
  })
})

describe("live-mode divide-by-two: D FF with D fed from its own Q'", () => {
  function divider(delay = 1): Circuit {
    return new CircuitBuilder()
      .switch('clk', ZERO)
      .switch('r', ONE)
      .add('vcc', ComponentType.VCC)
      .add('ff', ComponentType.D_FLIPFLOP, { delay })
      .probe('q')
      .probe('qn')
      .wire(p('clk', 'out'), p('ff', 'CLK'))
      .wire(p('vcc', 'out'), p('ff', 'S'))
      .wire(p('r', 'out'), p('ff', 'R'))
      .wire(p('ff', "Q'"), p('ff', 'D'))
      .wire(p('ff', 'Q'), p('q', 'in'))
      .wire(p('ff', "Q'"), p('qn', 'in'))
      .build()
  }

  it.each([1, 3])('delay %i: Q toggles on every rising edge only, across 10 cycles', (delay) => {
    const c = divider(delay)
    expectQ(c, X)
    clear(c)
    expectQ(c, ZERO)
    expect(c.pin(p('ff', 'D'))).toBe(ONE)
    let expected = ZERO
    for (let i = 0; i < 10; i++) {
      c.rise('clk')
      expected = not(expected)
      expectQ(c, expected)
      expect(c.pin(p('ff', 'D'))).toBe(not(expected))
      c.fall('clk')
      expectQ(c, expected)
    }
    expect(c.oscillated).toBe(false)
  })

  it('before any clear, the X feedback keeps Q at X through clock edges', () => {
    const c = divider()
    c.pulse('clk')
    c.pulse('clk')
    expectQ(c, X)
  })
})

describe('3-stage J-K ripple counter with 3 ns flip-flops still counts up', () => {
  function ripple3(): Circuit {
    const b = new CircuitBuilder()
      .switch('clk', ZERO)
      .switch('r', ONE)
      .add('vcc', ComponentType.VCC)
      .add('ff0', ComponentType.JK_FLIPFLOP, { delay: 3 })
      .add('ff1', ComponentType.JK_FLIPFLOP, { delay: 3 })
      .add('ff2', ComponentType.JK_FLIPFLOP, { delay: 3 })
      .probe('q0')
      .probe('q1')
      .probe('q2')
      .wire(p('clk', 'out'), p('ff0', 'CLK'))
      .wire(p('ff0', 'Q'), p('ff1', 'CLK'))
      .wire(p('ff1', 'Q'), p('ff2', 'CLK'))
      .connect(p('r', 'out'), p('ff0', 'R'), p('ff1', 'R'), p('ff2', 'R'))
    for (const id of ['ff0', 'ff1', 'ff2']) {
      b.connect(p('vcc', 'out'), p(id, 'J'), p(id, 'K'), p(id, 'S'))
      b.wire(p(id, 'Q'), p(`q${id.slice(2)}`, 'in'))
    }
    return b.build()
  }

  function count(c: Circuit): number | null {
    let n = 0
    for (let i = 2; i >= 0; i--) {
      const v = c.pin(p(`q${i}`, 'in'))
      if (!isClean(v)) return null
      n = n * 2 + (v === ONE ? 1 : 0)
    }
    return n
  }

  it('counts 0..7 and wraps, one count per falling input edge', () => {
    const c = clear(ripple3())
    expect(count(c)).toBe(0)
    for (let i = 1; i <= 10; i++) {
      c.pulse('clk')
      expect(count(c)).toBe(i % 8)
    }
  })

  it('stage k changes 3 ns after stage k-1 (ripple)', () => {
    const c = clear(ripple3())
    for (let i = 0; i < 3; i++) c.pulse('clk')
    expect(count(c)).toBe(3)
    const t0 = c.time
    c.pulse('clk') // 3 -> 4: all three stages flip, 3 ns apart
    expect(count(c)).toBe(4)
    // The switch output falls at t0+1 (rise) ... the falling edge is the second toggle.
    const q0 = samplesOf(c, 'q0', t0 + 1)
    const q1 = samplesOf(c, 'q1', t0 + 1)
    const q2 = samplesOf(c, 'q2', t0 + 1)
    expect(q0.length).toBe(1)
    expect(q1.length).toBe(1)
    expect(q2.length).toBe(1)
    expect(q0[0][1]).toBe(ZERO)
    expect(q1[0][1]).toBe(ZERO)
    expect(q2[0][1]).toBe(ONE)
    expect(q1[0][0] - q0[0][0]).toBe(3)
    expect(q2[0][0] - q1[0][0]).toBe(3)
  })
})

describe('two D flip-flops in series with the CLOCK part (step)', () => {
  function clockedShift(delay1: number, delay2: number): Circuit {
    return new CircuitBuilder()
      .setSimulation({ clockInitialValue: ONE, clockPeriodNs: 20, simTimeNs: 100 })
      .add('clock', ComponentType.CLOCK)
      .switch('d', ONE)
      .switch('r', ONE)
      .add('vcc', ComponentType.VCC)
      .add('ff1', ComponentType.D_FLIPFLOP, { delay: delay1 })
      .add('ff2', ComponentType.D_FLIPFLOP, { delay: delay2 })
      .probe('q1')
      .probe('q2')
      .wire(p('d', 'out'), p('ff1', 'D'))
      .wire(p('ff1', 'Q'), p('ff2', 'D'))
      .connect(p('clock', 'out'), p('ff1', 'CLK'), p('ff2', 'CLK'))
      .connect(p('vcc', 'out'), p('ff1', 'S'), p('ff2', 'S'))
      .connect(p('r', 'out'), p('ff1', 'R'), p('ff2', 'R'))
      .wire(p('ff1', 'Q'), p('q1', 'in'))
      .wire(p('ff2', 'Q'), p('q2', 'in'))
      .build()
  }

  const stages = (c: Circuit): string => `${c.pin(p('q1', 'in'))}${c.pin(p('q2', 'in'))}`

  it.each([
    [1, 1],
    [1, 3]
  ])('FF1 delay %i / FF2 delay %i: one stage per rising edge (20, 40, 60 ns)', (d1, d2) => {
    const c = clockedShift(d1, d2)
    clear(c)
    c.step()
    expect(c.time).toBe(15)
    expect(stages(c)).toBe('00')
    c.step()
    expect(c.time).toBe(35)
    expect(stages(c)).toBe('10')
    expect(samplesOf(c, 'q1', 10)).toEqual([[20 + d1, ONE]])
    expect(samplesOf(c, 'q2', 10)).toEqual([])
    c.set('d', ZERO)
    c.step()
    expect(c.time).toBe(55)
    expect(stages(c)).toBe('01')
    expect(samplesOf(c, 'q1', 10)).toEqual([
      [20 + d1, ONE],
      [40 + d1, ZERO]
    ])
    expect(samplesOf(c, 'q2', 10)).toEqual([[40 + d2, ONE]])
    c.step()
    expect(c.time).toBe(75)
    expect(stages(c)).toBe('00')
    expect(samplesOf(c, 'q2', 10)).toEqual([
      [40 + d2, ONE],
      [60 + d2, ZERO]
    ])
  })
})

describe('reset() re-arms the edge detector from the current clock level', () => {
  it('D FF: after reset with CLK high, the next fall/rise is a genuine edge', () => {
    const c = clear(dff({ d: ONE }))
    c.rise('clk')
    expectQ(c, ONE)
    c.reset()
    expect(c.time).toBe(0)
    expect(c.pin(p('ff', 'CLK'))).toBe(ONE)
    expectQ(c, X)
    c.fall('clk')
    expectQ(c, X)
    c.rise('clk')
    expectQ(c, ONE)
  })

  it('J-K: after reset with CLK high, the first fall is a falling edge (set mode)', () => {
    const c = jkff({ j: ONE, k: ZERO })
    c.rise('clk')
    c.reset()
    expect(c.pin(p('ff', 'CLK'))).toBe(ONE)
    expectQ(c, X)
    c.fall('clk')
    expectQ(c, ONE)
  })

  it('J-K: after reset with CLK low, raising it is not a falling edge', () => {
    const c = clear(jkff({ j: ONE, k: ZERO }))
    c.reset()
    expect(c.pin(p('ff', 'CLK'))).toBe(ZERO)
    c.rise('clk')
    expectQ(c, X)
    c.fall('clk')
    expectQ(c, ONE)
  })
})

describe('a clock pulse shorter than the flip-flop delay still clocks (delay is on the output only)', () => {
  function delayedT(delay: number): Circuit {
    return new CircuitBuilder()
      .switch('clk', ONE)
      .switch('r', ONE)
      .add('vcc', ComponentType.VCC)
      .add('ff', ComponentType.JK_FLIPFLOP, { delay })
      .probe('q')
      .wire(p('clk', 'out'), p('ff', 'CLK'))
      .connect(p('vcc', 'out'), p('ff', 'J'), p('ff', 'K'), p('ff', 'S'))
      .wire(p('r', 'out'), p('ff', 'R'))
      .wire(p('ff', 'Q'), p('q', 'in'))
      .build()
  }

  it('J-K delay 5: a 1 ns low pulse on CLK toggles Q, 5 ns after the falling edge', () => {
    const c = clear(delayedT(5))
    expect(c.pin(p('q', 'in'))).toBe(ZERO)
    const t0 = c.time
    c.sim.toggle('clk', false)
    expect(c.sim.changeStep()).toBe(true) // CLK 1 -> 0 at t0+1: falling edge
    expect(c.time).toBe(t0 + 1)
    c.sim.toggle('clk', false) // CLK 0 -> 1 at t0+2
    c.sim.drain()
    expect(c.pin(p('q', 'in'))).toBe(ONE)
    expect(samplesOf(c, 'q', t0 + 1)).toEqual([[t0 + 6, ONE]])
  })

  it('D FF delay 4: a 1 ns high pulse on CLK captures D, 4 ns after the rising edge', () => {
    const c = clear(delayedD4())
    const t0 = c.time
    c.sim.toggle('clk', false)
    expect(c.sim.changeStep()).toBe(true) // CLK 0 -> 1 at t0+1
    c.sim.toggle('clk', false) // CLK 1 -> 0 at t0+2
    c.sim.drain()
    expect(c.pin(p('q', 'in'))).toBe(ONE)
    expect(samplesOf(c, 'q', t0 + 1)).toEqual([[t0 + 5, ONE]])
  })

  function delayedD4(): Circuit {
    return new CircuitBuilder()
      .switch('clk', ZERO)
      .switch('r', ONE)
      .switch('d', ONE)
      .add('vcc', ComponentType.VCC)
      .add('ff', ComponentType.D_FLIPFLOP, { delay: 4 })
      .probe('q')
      .wire(p('clk', 'out'), p('ff', 'CLK'))
      .wire(p('d', 'out'), p('ff', 'D'))
      .wire(p('vcc', 'out'), p('ff', 'S'))
      .wire(p('r', 'out'), p('ff', 'R'))
      .wire(p('ff', 'Q'), p('q', 'in'))
      .build()
  }
})

describe('relative Go (decision 5) with a J-K T flip-flop', () => {
  it('a second go() runs from 95 to 195 ns and keeps toggling at every falling edge', () => {
    const c = new CircuitBuilder()
      .setSimulation({ clockInitialValue: ONE, clockPeriodNs: 20, simTimeNs: 100 })
      .add('clock', ComponentType.CLOCK)
      .add('vcc', ComponentType.VCC)
      .switch('r', ONE)
      .add('ff', ComponentType.JK_FLIPFLOP)
      .probe('q')
      .wire(p('clock', 'out'), p('ff', 'CLK'))
      .connect(p('vcc', 'out'), p('ff', 'J'), p('ff', 'K'), p('ff', 'S'))
      .wire(p('r', 'out'), p('ff', 'R'))
      .wire(p('ff', 'Q'), p('q', 'in'))
      .build()
    clear(c)
    c.go()
    expect(c.time).toBe(95)
    c.go()
    expect(c.time).toBe(195)
    const s = samplesOf(c, 'q', 10)
    expect(s.map(([t]) => t)).toEqual([11, 31, 51, 71, 91, 111, 131, 151, 171, 191])
    for (let i = 1; i < s.length; i++) expect(s[i][1]).toBe(not(s[i - 1][1]))
    expect(s[0][1]).toBe(ONE)
  })
})
