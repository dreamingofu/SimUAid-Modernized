// Integration: combinational blocks built out of gates versus the equivalent
// built-in parts, over the whole input space wherever it is feasible.
//
// Every network here is a textbook construction (two-level AND-OR, NAND-NAND,
// mux trees, decoder + OR, comparators, parity trees, a priority encoder, an ALU
// slice, tristate muxing, seven-segment decoding), so a mismatch with the part is
// a bug in one of the two. The X/Z sections then pin down exactly where the two
// are *required* to differ: the fixed parts implement the manual's "bad select ->
// all X" rule, while a gate network keeps its controlling values (an AND with a 0
// is 0 even when another input is X). Those differences are asserted explicitly,
// not papered over.
//
// Conventions used throughout: select input A is the MSB (manual Appendix A:
// "if AB = 01, Z = input 1"), vectors handed to the harness are LSB-first, and
// Circuit.vec() returns MSB-first text.

import { describe, expect, it } from 'vitest'
import { ComponentType, LogicValue, type PinId } from '../../model/types'
import { evalDecoder, evalMux, evalTristate } from '../parts'
import { CircuitBuilder, Circuit, allCombos, p } from './harness'

const { ZERO, ONE, X, Z } = LogicValue

const bit = (n: number): LogicValue => (n ? ONE : ZERO)
const num = (v: LogicValue): number => (v === ONE ? 1 : 0)
/** MSB-first binary text of `value` in `n` bits. */
const bin = (value: number, n: number): string => (value & ((1 << n) - 1)).toString(2).padStart(n, '0')

const AND_N: Record<number, ComponentType> = {
  2: ComponentType.AND2,
  3: ComponentType.AND3,
  4: ComponentType.AND4,
  5: ComponentType.AND5
}
const OR_N: Record<number, ComponentType> = {
  2: ComponentType.OR2,
  3: ComponentType.OR3,
  4: ComponentType.OR4,
  5: ComponentType.OR5
}

// ---------------------------------------------------------------------------
// Local builder helpers (the harness has no notion of "a literal and its
// complement" or of gate trees wider than 5 inputs, so they live here).
// ---------------------------------------------------------------------------

/** A switch plus its inverter: hi(id) is the true literal, lo(id) the complement. */
function addLiteral(b: CircuitBuilder, id: string, init: LogicValue = ZERO): void {
  b.switch(id, init)
    .add(`n_${id}`, ComponentType.NOT)
    .wire(p(id, 'out'), p(`n_${id}`, 'in1'))
}
const hi = (id: string): PinId => p(id, 'out')
const lo = (id: string): PinId => p(`n_${id}`, 'out')

/** NOT gate driven by `from`; returns its output pin. */
function invert(b: CircuitBuilder, id: string, from: PinId): PinId {
  b.add(id, ComponentType.NOT).wire(from, p(id, 'in1'))
  return p(id, 'out')
}

/** OR of any number of pins, from OR2..OR5 (balanced tree beyond 5 inputs). */
function orOf(b: CircuitBuilder, id: string, terms: PinId[]): PinId {
  if (terms.length === 1) {
    b.add(id, ComponentType.OR2).wire(terms[0], p(id, 'in1')).wire(terms[0], p(id, 'in2'))
    return p(id, 'out')
  }
  if (terms.length <= 5) {
    b.add(id, OR_N[terms.length])
    terms.forEach((t, i) => {
      b.wire(t, p(id, `in${i + 1}`))
    })
    return p(id, 'out')
  }
  const mid = Math.ceil(terms.length / 2)
  const left = orOf(b, `${id}_l`, terms.slice(0, mid))
  const right = orOf(b, `${id}_r`, terms.slice(mid))
  return orOf(b, `${id}_t`, [left, right])
}

/** AND of 1..5 pins (a single pin passes through an AND2 with both inputs tied). */
function andOf(b: CircuitBuilder, id: string, terms: PinId[]): PinId {
  if (terms.length === 1) {
    b.add(id, ComponentType.AND2).wire(terms[0], p(id, 'in1')).wire(terms[0], p(id, 'in2'))
    return p(id, 'out')
  }
  b.add(id, AND_N[terms.length])
  terms.forEach((t, i) => {
    b.wire(t, p(id, `in${i + 1}`))
  })
  return p(id, 'out')
}

/** Literal pins selecting minterm `index` over `vars`, listed MSB-first. */
function minterm(vars: string[], index: number): PinId[] {
  return vars.map((v, k) => ((index >> (vars.length - 1 - k)) & 1 ? hi(v) : lo(v)))
}

/** Switch assignments putting `value` on `${prefix}0..${prefix}{n-1}` (bit 0 = LSB). */
function word(prefix: string, value: number, n: number): Record<string, LogicValue> {
  const out: Record<string, LogicValue> = {}
  for (let i = 0; i < n; i++) out[`${prefix}${i}`] = bit((value >> i) & 1)
  return out
}

/** How an input net is driven in the X/Z benches. */
type Src = 'sw' | 'x' | 'z'

/**
 * A driver for one input net: a switch (id = `name`), a permanent X (a NOT with
 * an unconnected input, manual §1.9: NOT of Z is X) or a permanent Z (a tristate
 * held off by ground, so the net has a driver that releases it).
 */
function driverPin(b: CircuitBuilder, name: string, src: Src, gnd = 'gnd'): PinId {
  if (src === 'sw') {
    b.switch(name, ZERO)
    return p(name, 'out')
  }
  if (src === 'x') {
    b.add(`xd_${name}`, ComponentType.NOT)
    return p(`xd_${name}`, 'out')
  }
  b.add(`zd_${name}`, ComponentType.TRISTATE_RIGHT)
    .wire(p(gnd, 'out'), p(`zd_${name}`, 'ctl'))
    .wire(p(gnd, 'out'), p(`zd_${name}`, 'in'))
  return p(`zd_${name}`, 'out')
}

// ---------------------------------------------------------------------------
// 1. Multiplexers built from gates vs MUX_2 / MUX_4 / MUX_8
// ---------------------------------------------------------------------------

/** Z = in0·A' + in1·A next to a MUX_2 fed from the same three nets. */
function mux2Bench(): Circuit {
  const b = new CircuitBuilder()
  addLiteral(b, 's')
  b.switch('d0')
    .switch('d1')
    .add('mux', ComponentType.MUX_2)
    .wire(hi('s'), p('mux', 'A'))
    .wire(p('d0', 'out'), p('mux', 'in0'))
    .wire(p('d1', 'out'), p('mux', 'in1'))
    .add('t0', ComponentType.AND2)
    .wire(p('d0', 'out'), p('t0', 'in1'))
    .wire(lo('s'), p('t0', 'in2'))
    .add('t1', ComponentType.AND2)
    .wire(p('d1', 'out'), p('t1', 'in1'))
    .wire(hi('s'), p('t1', 'in2'))
    .add('sop', ComponentType.OR2)
    .wire(p('t0', 'out'), p('sop', 'in1'))
    .wire(p('t1', 'out'), p('sop', 'in2'))
  return b.build()
}

describe('2:1 mux: AND-OR network vs MUX_2 (exhaustive)', () => {
  const c = mux2Bench()

  for (const [s, d0, d1] of allCombos(3)) {
    const want = s === ONE ? d1 : d0
    it(`A=${s} in0=${d0} in1=${d1} -> ${want}`, () => {
      c.setMany({ s, d0, d1 })
      expect(c.pin(p('mux', 'Z')), 'MUX_2 part').toBe(want)
      expect(c.pin(p('sop', 'out')), 'AND-OR network').toBe(want)
      expect(evalMux([s], (i) => [d0, d1][i]), 'evalMux directly').toBe(want)
    })
  }

  it('A selects in1 (A is the only select and 1 means input 1)', () => {
    c.setMany({ s: ONE, d0: ZERO, d1: ONE })
    expect(c.pin(p('mux', 'Z'))).toBe(ONE)
    c.setMany({ s: ZERO, d0: ZERO, d1: ONE })
    expect(c.pin(p('mux', 'Z'))).toBe(ZERO)
  })

  it('never oscillates over the whole input space', () => {
    for (const [s, d0, d1] of allCombos(3)) {
      c.setMany({ s, d0, d1 })
      expect(c.oscillated).toBe(false)
    }
  })
})

/**
 * A MUX_4 next to three independent implementations of the same function, all
 * reading the same six nets: two-level AND-OR, NAND-NAND, and a tree of three
 * MUX_2 parts (B on the two lower muxes, A on the output mux).
 */
function mux4Bench(srcs: { a: Src; b: Src; d: Src[] }): { c: Circuit; sop: PinId } {
  const b = new CircuitBuilder().add('gnd', ComponentType.GROUND)
  const aPin = driverPin(b, 'a', srcs.a)
  const bPin = driverPin(b, 'b', srcs.b)
  const dPin = srcs.d.map((s, i) => driverPin(b, `d${i}`, s))
  const aLo = invert(b, 'na', aPin)
  const bLo = invert(b, 'nb', bPin)

  b.add('mux', ComponentType.MUX_4).wire(aPin, p('mux', 'A')).wire(bPin, p('mux', 'B'))
  dPin.forEach((pin, i) => {
    b.wire(pin, p('mux', `in${i}`))
  })

  const terms: PinId[] = []
  b.add('nn', ComponentType.NAND4)
  for (let i = 0; i < 4; i++) {
    b.add(`t${i}`, ComponentType.AND3)
      .wire(dPin[i], p(`t${i}`, 'in1'))
      .wire(i & 2 ? aPin : aLo, p(`t${i}`, 'in2'))
      .wire(i & 1 ? bPin : bLo, p(`t${i}`, 'in3'))
      .add(`nm${i}`, ComponentType.NAND3)
      .wire(dPin[i], p(`nm${i}`, 'in1'))
      .wire(i & 2 ? aPin : aLo, p(`nm${i}`, 'in2'))
      .wire(i & 1 ? bPin : bLo, p(`nm${i}`, 'in3'))
      .wire(p(`nm${i}`, 'out'), p('nn', `in${i + 1}`))
    terms.push(p(`t${i}`, 'out'))
  }
  const sop = orOf(b, 'sop', terms)

  b.add('tr0', ComponentType.MUX_2)
    .add('tr1', ComponentType.MUX_2)
    .add('trt', ComponentType.MUX_2)
    .wire(dPin[0], p('tr0', 'in0'))
    .wire(dPin[1], p('tr0', 'in1'))
    .wire(bPin, p('tr0', 'A'))
    .wire(dPin[2], p('tr1', 'in0'))
    .wire(dPin[3], p('tr1', 'in1'))
    .wire(bPin, p('tr1', 'A'))
    .wire(p('tr0', 'Z'), p('trt', 'in0'))
    .wire(p('tr1', 'Z'), p('trt', 'in1'))
    .wire(aPin, p('trt', 'A'))

  return { c: b.build(), sop }
}

describe('4:1 mux: AND-OR, NAND-NAND and a MUX_2 tree vs MUX_4 (exhaustive)', () => {
  const { c, sop } = mux4Bench({ a: 'sw', b: 'sw', d: ['sw', 'sw', 'sw', 'sw'] })

  for (const combo of allCombos(6)) {
    const [a, bs, d0, d1, d2, d3] = combo
    const index = 2 * num(a) + num(bs)
    const data = [d0, d1, d2, d3]
    const want = data[index]
    it(`AB=${a}${bs} data=${num(d3)}${num(d2)}${num(d1)}${num(d0)} -> in${index} = ${want}`, () => {
      c.setMany({ a, b: bs, d0, d1, d2, d3 })
      expect(c.pin(p('mux', 'Z')), 'MUX_4 part').toBe(want)
      expect(c.pin(sop), 'AND-OR network').toBe(want)
      expect(c.pin(p('nn', 'out')), 'NAND-NAND network').toBe(want)
      expect(c.pin(p('trt', 'Z')), 'MUX_2 tree').toBe(want)
      expect(evalMux([a, bs], (i) => data[i]), 'evalMux directly').toBe(want)
    })
  }
})

describe('4:1 mux select convention: A is the MSB', () => {
  /** Two MUX_4s on the same data, one with A/B swapped. */
  function swapBench(): Circuit {
    const b = new CircuitBuilder()
      .switch('a')
      .switch('b')
      .add('normal', ComponentType.MUX_4)
      .add('swapped', ComponentType.MUX_4)
      .wire(p('a', 'out'), p('normal', 'A'))
      .wire(p('b', 'out'), p('normal', 'B'))
      .wire(p('a', 'out'), p('swapped', 'B'))
      .wire(p('b', 'out'), p('swapped', 'A'))
    for (let i = 0; i < 4; i++) {
      b.switch(`d${i}`).connect(p(`d${i}`, 'out'), p('normal', `in${i}`), p('swapped', `in${i}`))
    }
    return b.build()
  }
  const c = swapBench()

  it('A=1 B=0 routes in2 (index 2A+B), not in1', () => {
    c.setMany({ a: ONE, b: ZERO, d0: ZERO, d1: ZERO, d2: ONE, d3: ZERO })
    expect(c.pin(p('normal', 'Z'))).toBe(ONE)
    expect(c.pin(p('swapped', 'Z'))).toBe(ZERO)
  })

  it('A=0 B=1 routes in1, and the swapped mux routes in2', () => {
    c.setMany({ a: ZERO, b: ONE, d0: ZERO, d1: ONE, d2: ZERO, d3: ZERO })
    expect(c.pin(p('normal', 'Z'))).toBe(ONE)
    expect(c.pin(p('swapped', 'Z'))).toBe(ZERO)
  })

  it('the two muxes agree exactly when A == B (one-hot data on every input)', () => {
    for (let onehot = 0; onehot < 4; onehot++) {
      for (const [a, bs] of allCombos(2)) {
        const sw: Record<string, LogicValue> = { a, b: bs }
        for (let i = 0; i < 4; i++) sw[`d${i}`] = bit(i === onehot ? 1 : 0)
        c.setMany(sw)
        const normalIndex = 2 * num(a) + num(bs)
        const swapIndex = 2 * num(bs) + num(a)
        expect(c.pin(p('normal', 'Z')), `onehot ${onehot} AB=${a}${bs}`).toBe(bit(normalIndex === onehot ? 1 : 0))
        expect(c.pin(p('swapped', 'Z')), `onehot ${onehot} AB=${a}${bs}`).toBe(bit(swapIndex === onehot ? 1 : 0))
      }
    }
  })
})

/** MUX_8 next to eight AND4 minterms ORed together (A/B/C are MSB..LSB). */
function mux8Bench(): { c: Circuit; sop: PinId } {
  const b = new CircuitBuilder()
  for (const s of ['sa', 'sb', 'sc']) addLiteral(b, s)
  b.add('mux', ComponentType.MUX_8)
    .wire(hi('sa'), p('mux', 'A'))
    .wire(hi('sb'), p('mux', 'B'))
    .wire(hi('sc'), p('mux', 'C'))
  const terms: PinId[] = []
  for (let i = 0; i < 8; i++) {
    b.switch(`d${i}`).wire(p(`d${i}`, 'out'), p('mux', `in${i}`))
    terms.push(andOf(b, `t${i}`, [p(`d${i}`, 'out'), ...minterm(['sa', 'sb', 'sc'], i)]))
  }
  const sop = orOf(b, 'sop', terms)
  return { c: b.build(), sop }
}

describe('8:1 mux: AND4/OR network vs MUX_8', () => {
  const { c, sop } = mux8Bench()
  const selects = (index: number): Record<string, LogicValue> => ({
    sa: bit((index >> 2) & 1),
    sb: bit((index >> 1) & 1),
    sc: bit(index & 1)
  })
  const dataOf = (pattern: string): Record<string, LogicValue> => {
    const sw: Record<string, LogicValue> = {}
    for (let i = 0; i < 8; i++) sw[`d${i}`] = bit(pattern[7 - i] === '1' ? 1 : 0)
    return sw
  }

  // One-hot data isolates the routed input: only select == i may show a 1.
  for (let index = 0; index < 8; index++) {
    for (let onehot = 0; onehot < 8; onehot++) {
      const want = bit(index === onehot ? 1 : 0)
      it(`ABC=${bin(index, 3)} with only in${onehot} high -> ${want}`, () => {
        c.setMany({ ...selects(index), ...dataOf(bin(1 << onehot, 8)) })
        expect(c.pin(p('mux', 'Z')), 'MUX_8 part').toBe(want)
        expect(c.pin(sop), 'AND-OR network').toBe(want)
      })
    }
  }

  const PATTERNS = ['00000000', '11111111', '10101010', '01010101', '11001100', '00110011', '11110000', '00001111']
  for (let index = 0; index < 8; index++) {
    it(`ABC=${bin(index, 3)} routes bit ${index} of every distinguishing pattern`, () => {
      for (const pattern of PATTERNS) {
        const want = bit(pattern[7 - index] === '1' ? 1 : 0)
        c.setMany({ ...selects(index), ...dataOf(pattern) })
        expect(c.pin(p('mux', 'Z')), `part, pattern ${pattern}`).toBe(want)
        expect(c.pin(sop), `gates, pattern ${pattern}`).toBe(want)
        const data = [...pattern].reverse().map((ch) => bit(ch === '1' ? 1 : 0))
        expect(evalMux([bit((index >> 2) & 1), bit((index >> 1) & 1), bit(index & 1)], (i) => data[i])).toBe(want)
      }
    })
  }

  it('A is the MSB and C the LSB: ABC=100 routes in4, ABC=001 routes in1', () => {
    c.setMany({ ...selects(4), ...dataOf('00010000') })
    expect(c.pin(p('mux', 'Z'))).toBe(ONE)
    expect(c.pin(sop)).toBe(ONE)
    c.setMany({ ...selects(1), ...dataOf('00000010') })
    expect(c.pin(p('mux', 'Z'))).toBe(ONE)
    expect(c.pin(sop)).toBe(ONE)
    c.setMany({ ...selects(1), ...dataOf('00010000') })
    expect(c.pin(p('mux', 'Z'))).toBe(ZERO)
    expect(c.pin(sop)).toBe(ZERO)
  })
})

// ---------------------------------------------------------------------------
// 2. Decoders
// ---------------------------------------------------------------------------

/** DECODER_2TO4 next to a NOR-gate decoder (out_i = NOR of the complemented minterm). */
function dec24Bench(srcs: { a: Src; b: Src }): Circuit {
  const b = new CircuitBuilder().add('gnd', ComponentType.GROUND)
  const aPin = driverPin(b, 'a', srcs.a)
  const bPin = driverPin(b, 'b', srcs.b)
  const aLo = invert(b, 'na', aPin)
  const bLo = invert(b, 'nb', bPin)
  b.add('dec', ComponentType.DECODER_2TO4).wire(aPin, p('dec', 'A')).wire(bPin, p('dec', 'B'))
  // out0 = A'B' = NOR(A,B); out1 = A'B = NOR(A,B'); out2 = AB' = NOR(A',B); out3 = AB = NOR(A',B')
  for (let i = 0; i < 4; i++) {
    b.add(`g${i}`, ComponentType.NOR2)
      .wire(i & 2 ? aLo : aPin, p(`g${i}`, 'in1'))
      .wire(i & 1 ? bLo : bPin, p(`g${i}`, 'in2'))
  }
  return b.build()
}

describe('2:4 decoder: NOR-gate network vs DECODER_2TO4 (exhaustive)', () => {
  const c = dec24Bench({ a: 'sw', b: 'sw' })

  for (const [a, bs] of allCombos(2)) {
    const index = 2 * num(a) + num(bs)
    it(`AB=${a}${bs} asserts out${index} only`, () => {
      c.setMany({ a, b: bs })
      for (let i = 0; i < 4; i++) {
        const want = bit(i === index ? 1 : 0)
        expect(c.pin(p('dec', `out${i}`)), `part out${i}`).toBe(want)
        expect(c.pin(p(`g${i}`, 'out')), `NOR network out${i}`).toBe(want)
      }
      expect(evalDecoder([a, bs]), 'evalDecoder directly').toEqual(
        [0, 1, 2, 3].map((i) => bit(i === index ? 1 : 0))
      )
    })
  }

  it('outputs are one-hot for every select (exactly one 1, three 0s, both networks)', () => {
    for (const [a, bs] of allCombos(2)) {
      c.setMany({ a, b: bs })
      const part = [0, 1, 2, 3].map((i) => c.pin(p('dec', `out${i}`)))
      const gates = [0, 1, 2, 3].map((i) => c.pin(p(`g${i}`, 'out')))
      expect(part.filter((v) => v === ONE).length, `part AB=${a}${bs}`).toBe(1)
      expect(part.filter((v) => v === ZERO).length, `part AB=${a}${bs}`).toBe(3)
      expect(gates.filter((v) => v === ONE).length, `gates AB=${a}${bs}`).toBe(1)
      expect(gates.filter((v) => v === ZERO).length, `gates AB=${a}${bs}`).toBe(3)
    }
  })

  it('A is the MSB: AB=10 asserts out2', () => {
    c.setMany({ a: ONE, b: ZERO })
    expect(c.pin(p('dec', 'out2'))).toBe(ONE)
    expect(c.pin(p('dec', 'out1'))).toBe(ZERO)
    expect(c.pin(p('g2', 'out'))).toBe(ONE)
    expect(c.pin(p('g1', 'out'))).toBe(ZERO)
  })
})

/** DECODER_3TO8 next to eight AND3 minterms and to a pair of 2:4 parts + enable ANDs. */
function dec38Bench(): Circuit {
  const b = new CircuitBuilder()
  for (const s of ['sa', 'sb', 'sc']) addLiteral(b, s)
  b.add('dec', ComponentType.DECODER_3TO8)
    .wire(hi('sa'), p('dec', 'A'))
    .wire(hi('sb'), p('dec', 'B'))
    .wire(hi('sc'), p('dec', 'C'))
  for (let i = 0; i < 8; i++) andOf(b, `g${i}`, minterm(['sa', 'sb', 'sc'], i))

  // Two 2:4 decoders on B,C; A (and A') enables the upper / lower half.
  b.add('dlo', ComponentType.DECODER_2TO4)
    .wire(hi('sb'), p('dlo', 'A'))
    .wire(hi('sc'), p('dlo', 'B'))
    .add('dhi', ComponentType.DECODER_2TO4)
    .wire(hi('sb'), p('dhi', 'A'))
    .wire(hi('sc'), p('dhi', 'B'))
  for (let i = 0; i < 4; i++) {
    b.add(`e${i}`, ComponentType.AND2)
      .wire(p('dlo', `out${i}`), p(`e${i}`, 'in1'))
      .wire(lo('sa'), p(`e${i}`, 'in2'))
      .add(`e${i + 4}`, ComponentType.AND2)
      .wire(p('dhi', `out${i}`), p(`e${i + 4}`, 'in1'))
      .wire(hi('sa'), p(`e${i + 4}`, 'in2'))
  }
  return b.build()
}

describe('3:8 decoder: AND3 network and two 2:4 parts + enable vs DECODER_3TO8 (exhaustive)', () => {
  const c = dec38Bench()

  for (let index = 0; index < 8; index++) {
    const sw = { sa: bit((index >> 2) & 1), sb: bit((index >> 1) & 1), sc: bit(index & 1) }
    it(`ABC=${bin(index, 3)} asserts out${index} only, in all three implementations`, () => {
      c.setMany(sw)
      for (let i = 0; i < 8; i++) {
        const want = bit(i === index ? 1 : 0)
        expect(c.pin(p('dec', `out${i}`)), `DECODER_3TO8 out${i}`).toBe(want)
        expect(c.pin(p(`g${i}`, 'out')), `AND3 network out${i}`).toBe(want)
        expect(c.pin(p(`e${i}`, 'out')), `two 2:4 parts out${i}`).toBe(want)
      }
    })
  }

  it('all three implementations are one-hot for every select', () => {
    for (let index = 0; index < 8; index++) {
      c.setMany({ sa: bit((index >> 2) & 1), sb: bit((index >> 1) & 1), sc: bit(index & 1) })
      for (const [name, read] of [
        ['part', (i: number) => c.pin(p('dec', `out${i}`))],
        ['AND3', (i: number) => c.pin(p(`g${i}`, 'out'))],
        ['2x2:4', (i: number) => c.pin(p(`e${i}`, 'out'))]
      ] as const) {
        const outs = [0, 1, 2, 3, 4, 5, 6, 7].map(read)
        expect(outs.filter((v) => v === ONE).length, `${name} ABC=${bin(index, 3)}`).toBe(1)
        expect(outs.indexOf(ONE), `${name} ABC=${bin(index, 3)}`).toBe(index)
      }
    }
  })

  it('the enable half-select really is A: ABC=011 hits out3 (lower half) and 111 hits out7', () => {
    c.setMany({ sa: ZERO, sb: ONE, sc: ONE })
    expect(c.pin(p('e3', 'out'))).toBe(ONE)
    expect(c.pin(p('e7', 'out'))).toBe(ZERO)
    c.setMany({ sa: ONE, sb: ONE, sc: ONE })
    expect(c.pin(p('e3', 'out'))).toBe(ZERO)
    expect(c.pin(p('e7', 'out'))).toBe(ONE)
  })
})

// ---------------------------------------------------------------------------
// 3. Arbitrary 3-input functions: decoder + OR vs sum of products
// ---------------------------------------------------------------------------

/**
 * f is given as a truth-table mask: bit i of `mask` is f(i) with i = 4A+2B+C.
 * Builds a DECODER_3TO8 whose selected minterm outputs are ORed, and an
 * independent AND3-per-minterm SOP network of the same function.
 */
function functionBench(mask: number): { c: Circuit; decOut: PinId; sopOut: PinId } {
  const minterms: number[] = []
  for (let i = 0; i < 8; i++) if ((mask >> i) & 1) minterms.push(i)
  const b = new CircuitBuilder()
  for (const s of ['sa', 'sb', 'sc']) addLiteral(b, s)
  b.add('dec', ComponentType.DECODER_3TO8)
    .wire(hi('sa'), p('dec', 'A'))
    .wire(hi('sb'), p('dec', 'B'))
    .wire(hi('sc'), p('dec', 'C'))
  const decOut = orOf(b, 'decor', minterms.map((i) => p('dec', `out${i}`)))
  const sopOut = orOf(b, 'sop', minterms.map((i) => andOf(b, `m${i}`, minterm(['sa', 'sb', 'sc'], i))))
  return { c: b.build(), decOut, sopOut }
}

const FUNCTIONS: [string, number][] = [
  ['minterm 0 only (A\'B\'C\')', 0x01],
  ['odd parity of A,B,C', 0x96],
  ['majority of A,B,C', 0xe8],
  ['{1,3,4,6}', 0x5a],
  ['NAND-like: everything but minterm 0', 0xfe],
  ['constant 1 (all eight minterms)', 0xff]
]

for (const [name, mask] of FUNCTIONS) {
  describe(`3-input function ${name}: DECODER_3TO8 + OR vs sum of products`, () => {
    const { c, decOut, sopOut } = functionBench(mask)
    for (let index = 0; index < 8; index++) {
      const want = bit((mask >> index) & 1)
      it(`ABC=${bin(index, 3)} -> ${want}`, () => {
        c.setMany({ sa: bit((index >> 2) & 1), sb: bit((index >> 1) & 1), sc: bit(index & 1) })
        expect(c.pin(decOut), 'decoder + OR').toBe(want)
        expect(c.pin(sopOut), 'sum of products').toBe(want)
      })
    }
  })
}

// ---------------------------------------------------------------------------
// 4. Comparators
// ---------------------------------------------------------------------------

describe('4-bit equality comparator: XNOR+AND4 and XOR+NOR4 (exhaustive, 256 pairs)', () => {
  function eqBench(): Circuit {
    const b = new CircuitBuilder().add('eqA', ComponentType.AND4).add('eqB', ComponentType.NOR4)
    for (let i = 0; i < 4; i++) {
      b.switch(`p${i}`)
        .switch(`q${i}`)
        .add(`xn${i}`, ComponentType.XNOR2)
        .wire(p(`p${i}`, 'out'), p(`xn${i}`, 'in1'))
        .wire(p(`q${i}`, 'out'), p(`xn${i}`, 'in2'))
        .wire(p(`xn${i}`, 'out'), p('eqA', `in${i + 1}`))
        .add(`xr${i}`, ComponentType.XOR2)
        .wire(p(`p${i}`, 'out'), p(`xr${i}`, 'in1'))
        .wire(p(`q${i}`, 'out'), p(`xr${i}`, 'in2'))
        .wire(p(`xr${i}`, 'out'), p('eqB', `in${i + 1}`))
    }
    return b.build()
  }
  const c = eqBench()

  for (let a = 0; a < 16; a++) {
    it(`A=${bin(a, 4)} compares equal to exactly one of the 16 B values`, () => {
      let matches = 0
      for (let bv = 0; bv < 16; bv++) {
        c.setMany({ ...word('p', a, 4), ...word('q', bv, 4) })
        const want = bit(a === bv ? 1 : 0)
        expect(c.pin(p('eqA', 'out')), `XNOR/AND ${bin(a, 4)} vs ${bin(bv, 4)}`).toBe(want)
        expect(c.pin(p('eqB', 'out')), `XOR/NOR ${bin(a, 4)} vs ${bin(bv, 4)}`).toBe(want)
        if (c.pin(p('eqA', 'out')) === ONE) matches++
      }
      expect(matches).toBe(1)
    })
  }
})

describe('2-bit magnitude comparator from gates, cross-checked with N_ADDER', () => {
  /**
   * gt = a1·b1' + (a1≡b1)·a0·b0';  lt = a1'·b1 + (a1≡b1)·a0'·b0;  eq = (a1≡b1)(a0≡b0).
   * The same operands also feed a 2-bit adder computing a + ~b + 1, whose Cout is
   * the "no borrow" flag (a >= b).
   */
  function cmpBench(): Circuit {
    const b = new CircuitBuilder().add('vcc', ComponentType.VCC)
    for (const id of ['a0', 'a1', 'b0', 'b1']) addLiteral(b, id)
    b.add('e1', ComponentType.XNOR2)
      .wire(hi('a1'), p('e1', 'in1'))
      .wire(hi('b1'), p('e1', 'in2'))
      .add('e0', ComponentType.XNOR2)
      .wire(hi('a0'), p('e0', 'in1'))
      .wire(hi('b0'), p('e0', 'in2'))
      .add('eq', ComponentType.AND2)
      .wire(p('e1', 'out'), p('eq', 'in1'))
      .wire(p('e0', 'out'), p('eq', 'in2'))
      .add('gtHi', ComponentType.AND2)
      .wire(hi('a1'), p('gtHi', 'in1'))
      .wire(lo('b1'), p('gtHi', 'in2'))
      .add('gtLo', ComponentType.AND3)
      .wire(p('e1', 'out'), p('gtLo', 'in1'))
      .wire(hi('a0'), p('gtLo', 'in2'))
      .wire(lo('b0'), p('gtLo', 'in3'))
      .add('gt', ComponentType.OR2)
      .wire(p('gtHi', 'out'), p('gt', 'in1'))
      .wire(p('gtLo', 'out'), p('gt', 'in2'))
      .add('ltHi', ComponentType.AND2)
      .wire(lo('a1'), p('ltHi', 'in1'))
      .wire(hi('b1'), p('ltHi', 'in2'))
      .add('ltLo', ComponentType.AND3)
      .wire(p('e1', 'out'), p('ltLo', 'in1'))
      .wire(lo('a0'), p('ltLo', 'in2'))
      .wire(hi('b0'), p('ltLo', 'in3'))
      .add('lt', ComponentType.OR2)
      .wire(p('ltHi', 'out'), p('lt', 'in1'))
      .wire(p('ltLo', 'out'), p('lt', 'in2'))
      // a + ~b + 1
      .add('sub', ComponentType.N_ADDER, { bits: 2 })
      .wire(hi('a0'), p('sub', 'X0'))
      .wire(hi('a1'), p('sub', 'X1'))
      .wire(lo('b0'), p('sub', 'Y0'))
      .wire(lo('b1'), p('sub', 'Y1'))
      .wire(p('vcc', 'out'), p('sub', 'Cin'))
    return b.build()
  }
  const c = cmpBench()

  for (let a = 0; a < 4; a++) {
    for (let bv = 0; bv < 4; bv++) {
      it(`${bin(a, 2)} vs ${bin(bv, 2)}: gt=${a > bv ? 1 : 0} eq=${a === bv ? 1 : 0} lt=${a < bv ? 1 : 0}`, () => {
        c.setMany({ ...word('a', a, 2), ...word('b', bv, 2) })
        expect(c.pin(p('gt', 'out')), 'gt').toBe(bit(a > bv ? 1 : 0))
        expect(c.pin(p('eq', 'out')), 'eq').toBe(bit(a === bv ? 1 : 0))
        expect(c.pin(p('lt', 'out')), 'lt').toBe(bit(a < bv ? 1 : 0))
        // exactly one of the three is asserted
        const ones = [p('gt', 'out'), p('eq', 'out'), p('lt', 'out')].filter((pin) => c.pin(pin) === ONE)
        expect(ones.length, 'exactly one of gt/eq/lt').toBe(1)
        // N_ADDER cross-check: Cout of a + ~b + 1 is the no-borrow flag
        expect(c.pin(p('sub', 'Cout')), 'a - b no-borrow').toBe(bit(a >= bv ? 1 : 0))
        expect(c.vec('sub', 'S', 2), 'a - b difference').toBe(bin((a - bv + 4) % 4, 2))
      })
    }
  }
})

// ---------------------------------------------------------------------------
// 5. Parity trees
// ---------------------------------------------------------------------------

describe('4-bit parity trees (exhaustive)', () => {
  /** odd = XOR tree; even = the same tree with an XNOR2 at the top. */
  function parity4(): Circuit {
    const b = new CircuitBuilder()
    for (let i = 0; i < 4; i++) b.switch(`w${i}`)
    b.add('l0', ComponentType.XOR2)
      .wire(p('w0', 'out'), p('l0', 'in1'))
      .wire(p('w1', 'out'), p('l0', 'in2'))
      .add('l1', ComponentType.XOR2)
      .wire(p('w2', 'out'), p('l1', 'in1'))
      .wire(p('w3', 'out'), p('l1', 'in2'))
      .add('odd', ComponentType.XOR2)
      .wire(p('l0', 'out'), p('odd', 'in1'))
      .wire(p('l1', 'out'), p('odd', 'in2'))
      .add('even', ComponentType.XNOR2)
      .wire(p('l0', 'out'), p('even', 'in1'))
      .wire(p('l1', 'out'), p('even', 'in2'))
    return b.build()
  }
  const c = parity4()

  for (const combo of allCombos(4)) {
    const ones = combo.filter((v) => v === ONE).length
    it(`bits ${combo.map(num).reverse().join('')} -> odd=${ones % 2} even=${1 - (ones % 2)}`, () => {
      c.setMany({ w0: combo[0], w1: combo[1], w2: combo[2], w3: combo[3] })
      expect(c.pin(p('odd', 'out')), 'odd parity').toBe(bit(ones % 2))
      expect(c.pin(p('even', 'out')), 'even parity').toBe(bit(1 - (ones % 2)))
    })
  }

  it('odd and even outputs are always complements of each other', () => {
    for (const combo of allCombos(4)) {
      c.setMany({ w0: combo[0], w1: combo[1], w2: combo[2], w3: combo[3] })
      expect(c.pin(p('odd', 'out'))).not.toBe(c.pin(p('even', 'out')))
    }
  })
})

describe('8-bit parity tree (all 256 patterns, grouped by high nibble)', () => {
  function parity8(): Circuit {
    const b = new CircuitBuilder()
    for (let i = 0; i < 8; i++) b.switch(`w${i}`)
    for (let i = 0; i < 4; i++) {
      b.add(`s${i}`, ComponentType.XOR2)
        .wire(p(`w${2 * i}`, 'out'), p(`s${i}`, 'in1'))
        .wire(p(`w${2 * i + 1}`, 'out'), p(`s${i}`, 'in2'))
    }
    b.add('h0', ComponentType.XOR2)
      .wire(p('s0', 'out'), p('h0', 'in1'))
      .wire(p('s1', 'out'), p('h0', 'in2'))
      .add('h1', ComponentType.XOR2)
      .wire(p('s2', 'out'), p('h1', 'in1'))
      .wire(p('s3', 'out'), p('h1', 'in2'))
      .add('odd', ComponentType.XOR2)
      .wire(p('h0', 'out'), p('odd', 'in1'))
      .wire(p('h1', 'out'), p('odd', 'in2'))
      .add('even', ComponentType.XNOR2)
      .wire(p('h0', 'out'), p('even', 'in1'))
      .wire(p('h1', 'out'), p('even', 'in2'))
    return b.build()
  }
  const c = parity8()
  const popcount = (v: number): number => [...bin(v, 8)].filter((ch) => ch === '1').length

  for (let high = 0; high < 16; high++) {
    it(`high nibble ${bin(high, 4)}: all 16 low nibbles give odd/even parity`, () => {
      for (let low = 0; low < 16; low++) {
        const value = (high << 4) | low
        c.setMany(word('w', value, 8))
        const odd = popcount(value) % 2
        expect(c.pin(p('odd', 'out')), `odd ${bin(value, 8)}`).toBe(bit(odd))
        expect(c.pin(p('even', 'out')), `even ${bin(value, 8)}`).toBe(bit(1 - odd))
      }
    })
  }

  it('a single bit flip always flips both parity outputs', () => {
    for (let i = 0; i < 8; i++) {
      c.setMany(word('w', 0, 8))
      const before = c.pin(p('odd', 'out'))
      c.setMany(word('w', 1 << i, 8))
      expect(c.pin(p('odd', 'out')), `bit ${i}`).not.toBe(before)
      expect(c.pin(p('even', 'out')), `bit ${i}`).toBe(before)
    }
  })
})

// ---------------------------------------------------------------------------
// 6. Priority encoder
// ---------------------------------------------------------------------------

describe('4:2 priority encoder from gates (all 16 input patterns)', () => {
  /** Y1 = I3 + I2; Y0 = I3 + I1·I2'; V = I3 + I2 + I1 + I0. */
  function encoder(): Circuit {
    const b = new CircuitBuilder()
    for (let i = 0; i < 4; i++) b.switch(`i${i}`)
    b.add('ni2', ComponentType.NOT)
      .wire(p('i2', 'out'), p('ni2', 'in1'))
      .add('y1', ComponentType.OR2)
      .wire(p('i3', 'out'), p('y1', 'in1'))
      .wire(p('i2', 'out'), p('y1', 'in2'))
      .add('t', ComponentType.AND2)
      .wire(p('i1', 'out'), p('t', 'in1'))
      .wire(p('ni2', 'out'), p('t', 'in2'))
      .add('y0', ComponentType.OR2)
      .wire(p('i3', 'out'), p('y0', 'in1'))
      .wire(p('t', 'out'), p('y0', 'in2'))
      .add('v', ComponentType.OR4)
    for (let i = 0; i < 4; i++) b.wire(p(`i${i}`, 'out'), p('v', `in${i + 1}`))
    return b.build()
  }
  const c = encoder()
  const highest = (mask: number): number => (mask === 0 ? 0 : 31 - Math.clz32(mask))

  for (let mask = 0; mask < 16; mask++) {
    const want = highest(mask)
    it(`inputs ${bin(mask, 4)} -> Y=${mask === 0 ? '00' : bin(want, 2)} V=${mask === 0 ? 0 : 1}`, () => {
      c.setMany(word('i', mask, 4))
      expect(c.pin(p('v', 'out')), 'valid').toBe(bit(mask === 0 ? 0 : 1))
      const y = `${c.pin(p('y1', 'out'))}${c.pin(p('y0', 'out'))}`
      expect(y, 'encoded index (MSB first)').toBe(mask === 0 ? '00' : bin(want, 2))
    })
  }

  it('adding lower-priority inputs never changes the encoded value', () => {
    for (let top = 0; top < 4; top++) {
      const lower = (1 << top) - 1
      for (let extra = 0; extra <= lower; extra++) {
        c.setMany(word('i', (1 << top) | extra, 4))
        expect(`${c.pin(p('y1', 'out'))}${c.pin(p('y0', 'out'))}`, `top ${top} extra ${extra}`).toBe(bin(top, 2))
        expect(c.pin(p('v', 'out'))).toBe(ONE)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 7. ALU blocks (AND / OR / XOR / ADD selected by a mux)
// ---------------------------------------------------------------------------

describe('1-bit ALU: MUX_4 picking AND/OR/XOR/FULL_ADDER sum (exhaustive)', () => {
  function alu1(): Circuit {
    const b = new CircuitBuilder()
      .switch('sa')
      .switch('sb')
      .switch('a')
      .switch('b')
      .switch('cin')
      .add('and', ComponentType.AND2)
      .wire(p('a', 'out'), p('and', 'in1'))
      .wire(p('b', 'out'), p('and', 'in2'))
      .add('or', ComponentType.OR2)
      .wire(p('a', 'out'), p('or', 'in1'))
      .wire(p('b', 'out'), p('or', 'in2'))
      .add('xor', ComponentType.XOR2)
      .wire(p('a', 'out'), p('xor', 'in1'))
      .wire(p('b', 'out'), p('xor', 'in2'))
      .add('fa', ComponentType.FULL_ADDER)
      .wire(p('a', 'out'), p('fa', 'X'))
      .wire(p('b', 'out'), p('fa', 'Y'))
      .wire(p('cin', 'out'), p('fa', 'Cin'))
      .add('mux', ComponentType.MUX_4)
      .wire(p('sa', 'out'), p('mux', 'A'))
      .wire(p('sb', 'out'), p('mux', 'B'))
      .wire(p('and', 'out'), p('mux', 'in0'))
      .wire(p('or', 'out'), p('mux', 'in1'))
      .wire(p('xor', 'out'), p('mux', 'in2'))
      .wire(p('fa', 'Sum'), p('mux', 'in3'))
    return b.build()
  }
  const c = alu1()
  const OPS = ['AND', 'OR', 'XOR', 'ADD']

  for (const combo of allCombos(5)) {
    const [sa, sb, a, bs, cin] = combo
    const op = 2 * num(sa) + num(sb)
    const av = num(a)
    const bv = num(bs)
    const cv = num(cin)
    const want = [av & bv, av | bv, av ^ bv, av ^ bv ^ cv][op]
    it(`op=${OPS[op]} a=${av} b=${bv} cin=${cv} -> ${want}`, () => {
      c.setMany({ sa, sb, a, b: bs, cin })
      expect(c.pin(p('mux', 'Z')), 'ALU result').toBe(bit(want))
      expect(c.pin(p('fa', 'Cout')), 'carry out').toBe(bit(av + bv + cv >= 2 ? 1 : 0))
    })
  }
})

describe('4-bit ALU: per-bit MUX_4 picking AND/OR/XOR/N_ADDER sum', () => {
  function alu4(): Circuit {
    const b = new CircuitBuilder()
      .add('gnd', ComponentType.GROUND)
      .switch('sa')
      .switch('sb')
      .add('add', ComponentType.N_ADDER, { bits: 4 })
      .wire(p('gnd', 'out'), p('add', 'Cin'))
    for (let i = 0; i < 4; i++) {
      b.switch(`a${i}`)
        .switch(`b${i}`)
        .wire(p(`a${i}`, 'out'), p('add', `X${i}`))
        .wire(p(`b${i}`, 'out'), p('add', `Y${i}`))
        .add(`and${i}`, ComponentType.AND2)
        .wire(p(`a${i}`, 'out'), p(`and${i}`, 'in1'))
        .wire(p(`b${i}`, 'out'), p(`and${i}`, 'in2'))
        .add(`or${i}`, ComponentType.OR2)
        .wire(p(`a${i}`, 'out'), p(`or${i}`, 'in1'))
        .wire(p(`b${i}`, 'out'), p(`or${i}`, 'in2'))
        .add(`xor${i}`, ComponentType.XOR2)
        .wire(p(`a${i}`, 'out'), p(`xor${i}`, 'in1'))
        .wire(p(`b${i}`, 'out'), p(`xor${i}`, 'in2'))
        .add(`mux${i}`, ComponentType.MUX_4)
        .wire(p('sa', 'out'), p(`mux${i}`, 'A'))
        .wire(p('sb', 'out'), p(`mux${i}`, 'B'))
        .wire(p(`and${i}`, 'out'), p(`mux${i}`, 'in0'))
        .wire(p(`or${i}`, 'out'), p(`mux${i}`, 'in1'))
        .wire(p(`xor${i}`, 'out'), p(`mux${i}`, 'in2'))
        .wire(p('add', `S${i}`), p(`mux${i}`, 'in3'))
    }
    return b.build()
  }
  const c = alu4()
  const result = (): string => [3, 2, 1, 0].map((i) => c.pin(p(`mux${i}`, 'Z'))).join('')
  const OPS: [string, (a: number, b: number) => number][] = [
    ['AND', (a, b) => a & b],
    ['OR', (a, b) => a | b],
    ['XOR', (a, b) => a ^ b],
    ['ADD', (a, b) => (a + b) & 15]
  ]

  for (let op = 0; op < 4; op++) {
    const [name, fn] = OPS[op]
    for (let a = 0; a < 16; a++) {
      it(`${name} ${bin(a, 4)} against all 16 operands`, () => {
        for (let bv = 0; bv < 16; bv++) {
          c.setMany({
            sa: bit((op >> 1) & 1),
            sb: bit(op & 1),
            ...word('a', a, 4),
            ...word('b', bv, 4)
          })
          expect(result(), `${name} ${bin(a, 4)} ${bin(bv, 4)}`).toBe(bin(fn(a, bv), 4))
          expect(c.pin(p('add', 'Cout')), `Cout ${bin(a, 4)}+${bin(bv, 4)}`).toBe(bit(a + bv > 15 ? 1 : 0))
        }
      })
    }
  }

  it('switching the op select re-routes the same operands without re-settling artifacts', () => {
    c.setMany({ ...word('a', 0b1010, 4), ...word('b', 0b0110, 4) })
    for (const [op, expected] of [
      [0, bin(0b1010 & 0b0110, 4)],
      [1, bin(0b1010 | 0b0110, 4)],
      [2, bin(0b1010 ^ 0b0110, 4)],
      [3, bin((0b1010 + 0b0110) & 15, 4)]
    ] as const) {
      c.setMany({ sa: bit((op >> 1) & 1), sb: bit(op & 1) })
      expect(result(), `op ${op}`).toBe(expected)
    }
    expect(c.oscillated).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 8. Tristate-based muxing on a shared net
// ---------------------------------------------------------------------------

describe('2:1 mux from two tristates on one net vs MUX_2 (exhaustive)', () => {
  function tsMux2(): Circuit {
    const b = new CircuitBuilder()
    addLiteral(b, 's')
    b.switch('d0')
      .switch('d1')
      .add('mux', ComponentType.MUX_2)
      .wire(hi('s'), p('mux', 'A'))
      .wire(p('d0', 'out'), p('mux', 'in0'))
      .wire(p('d1', 'out'), p('mux', 'in1'))
      .add('t0', ComponentType.TRISTATE_RIGHT)
      .wire(p('d0', 'out'), p('t0', 'in'))
      .wire(lo('s'), p('t0', 'ctl'))
      .add('t1', ComponentType.TRISTATE_RIGHT)
      .wire(p('d1', 'out'), p('t1', 'in'))
      .wire(hi('s'), p('t1', 'ctl'))
      .probe('bus')
      .wire(p('t0', 'out'), p('bus', 'in'))
      .wire(p('t1', 'out'), p('bus', 'in'))
    return b.build()
  }
  const c = tsMux2()

  for (const [s, d0, d1] of allCombos(3)) {
    const want = s === ONE ? d1 : d0
    it(`A=${s} in0=${d0} in1=${d1} -> shared net ${want}`, () => {
      c.setMany({ s, d0, d1 })
      expect(c.pin(p('bus', 'in')), 'tristate net').toBe(want)
      expect(c.pin(p('mux', 'Z')), 'MUX_2 part').toBe(want)
    })
  }
})

describe('4:1 mux from four tristates enabled by DECODER_2TO4 vs MUX_4 (exhaustive)', () => {
  function tsMux4(): Circuit {
    const b = new CircuitBuilder()
      .switch('a')
      .switch('b')
      .add('dec', ComponentType.DECODER_2TO4)
      .add('mux', ComponentType.MUX_4)
      .connect(p('a', 'out'), p('dec', 'A'), p('mux', 'A'))
      .connect(p('b', 'out'), p('dec', 'B'), p('mux', 'B'))
      .probe('bus')
    for (let i = 0; i < 4; i++) {
      b.switch(`d${i}`)
        .add(`ts${i}`, ComponentType.TRISTATE_RIGHT)
        .connect(p(`d${i}`, 'out'), p(`ts${i}`, 'in'), p('mux', `in${i}`))
        .wire(p('dec', `out${i}`), p(`ts${i}`, 'ctl'))
        .wire(p(`ts${i}`, 'out'), p('bus', 'in'))
    }
    return b.build()
  }
  const c = tsMux4()

  for (const combo of allCombos(6)) {
    const [a, bs, d0, d1, d2, d3] = combo
    const index = 2 * num(a) + num(bs)
    const want = [d0, d1, d2, d3][index]
    it(`AB=${a}${bs} data=${num(d3)}${num(d2)}${num(d1)}${num(d0)} -> ${want}`, () => {
      c.setMany({ a, b: bs, d0, d1, d2, d3 })
      expect(c.pin(p('bus', 'in')), 'tristate net').toBe(want)
      expect(c.pin(p('mux', 'Z')), 'MUX_4 part').toBe(want)
    })
  }
})

describe('tristate muxing corner cases the mux parts cannot reproduce', () => {
  /** Two tristates on one net with independent data and enable switches. */
  function pair(): Circuit {
    return new CircuitBuilder()
      .switch('d0')
      .switch('d1')
      .switch('e0')
      .switch('e1')
      .add('t0', ComponentType.TRISTATE_RIGHT)
      .wire(p('d0', 'out'), p('t0', 'in'))
      .wire(p('e0', 'out'), p('t0', 'ctl'))
      .add('t1', ComponentType.TRISTATE_RIGHT)
      .wire(p('d1', 'out'), p('t1', 'in'))
      .wire(p('e1', 'out'), p('t1', 'ctl'))
      .probe('bus')
      .wire(p('t0', 'out'), p('bus', 'in'))
      .wire(p('t1', 'out'), p('bus', 'in'))
      .build()
  }
  const c = pair()

  it('both enables low leaves the net floating at Z (no driver at all)', () => {
    c.setMany({ e0: ZERO, e1: ZERO, d0: ONE, d1: ONE })
    expect(c.pin(p('bus', 'in'))).toBe(Z)
    expect(c.pin(p('t0', 'out'))).toBe(Z)
    expect(c.pin(p('t1', 'out'))).toBe(Z)
  })

  it('conflicting enables with different data resolve to X (decision 3)', () => {
    c.setMany({ e0: ONE, e1: ONE, d0: ZERO, d1: ONE })
    expect(c.pin(p('bus', 'in'))).toBe(X)
  })

  it('conflicting enables with equal data keep that value (0/0 -> 0, 1/1 -> 1)', () => {
    c.setMany({ e0: ONE, e1: ONE, d0: ZERO, d1: ZERO })
    expect(c.pin(p('bus', 'in'))).toBe(ZERO)
    c.setMany({ d0: ONE, d1: ONE })
    expect(c.pin(p('bus', 'in'))).toBe(ONE)
  })

  it('exactly one enable high drives the net from that input, for all four data pairs', () => {
    for (const [d0, d1] of allCombos(2)) {
      c.setMany({ e0: ONE, e1: ZERO, d0, d1 })
      expect(c.pin(p('bus', 'in')), `t0 drives ${d0}`).toBe(d0)
      c.setMany({ e0: ZERO, e1: ONE, d0, d1 })
      expect(c.pin(p('bus', 'in')), `t1 drives ${d1}`).toBe(d1)
    }
  })

  it('evalTristate directly: ctl 1 passes, 0 releases, X/Z give X', () => {
    expect(evalTristate(ONE, [ONE])).toEqual([ONE])
    expect(evalTristate(ONE, [Z])).toEqual([X])
    expect(evalTristate(ZERO, [ONE])).toEqual([Z])
    expect(evalTristate(X, [ONE])).toEqual([X])
    expect(evalTristate(Z, [ONE])).toEqual([X])
  })
})

// ---------------------------------------------------------------------------
// 9. Seven-segment decoding driven by a DECODER_3TO8 + OR gates
// ---------------------------------------------------------------------------

/** Segment patterns for digits 0..7; character k is segment a..g (pins '1'..'7'). */
const SEVEN_SEG: string[] = [
  '1111110', // 0: abcdef
  '0110000', // 1: bc
  '1101101', // 2: abdeg
  '1111001', // 3: abcdg
  '0110011', // 4: bcfg
  '1011011', // 5: acdfg
  '1011111', // 6: acdefg
  '1110000' //  7: abc
]

describe('seven-segment display driven by DECODER_3TO8 + OR gates', () => {
  function segBench(): Circuit {
    const b = new CircuitBuilder()
    for (const s of ['sa', 'sb', 'sc']) addLiteral(b, s)
    b.add('dec', ComponentType.DECODER_3TO8)
      .wire(hi('sa'), p('dec', 'A'))
      .wire(hi('sb'), p('dec', 'B'))
      .wire(hi('sc'), p('dec', 'C'))
      .add('seg', ComponentType.SEVEN_SEGMENT)
    for (let s = 0; s < 7; s++) {
      const digits: PinId[] = []
      for (let d = 0; d < 8; d++) if (SEVEN_SEG[d][s] === '1') digits.push(p('dec', `out${d}`))
      const out = orOf(b, `seg${s}`, digits)
      b.wire(out, p('seg', String(s + 1)))
    }
    return b.build()
  }
  const c = segBench()
  const pattern = (): string => [1, 2, 3, 4, 5, 6, 7].map((i) => c.pin(p('seg', String(i)))).join('')

  for (let digit = 0; digit < 8; digit++) {
    it(`digit ${digit} lights segments ${SEVEN_SEG[digit]}`, () => {
      c.setMany({ sa: bit((digit >> 2) & 1), sb: bit((digit >> 1) & 1), sc: bit(digit & 1) })
      expect(c.pin(p('dec', `out${digit}`)), 'decoder line').toBe(ONE)
      expect(pattern(), 'segments a..g').toBe(SEVEN_SEG[digit])
    })
  }

  it('every digit lights a distinct segment pattern (the decoder really discriminates)', () => {
    const seen = new Set<string>()
    for (let digit = 0; digit < 8; digit++) {
      c.setMany({ sa: bit((digit >> 2) & 1), sb: bit((digit >> 1) & 1), sc: bit(digit & 1) })
      seen.add(pattern())
    }
    expect(seen.size).toBe(8)
  })
})

// ---------------------------------------------------------------------------
// 10. X and Z injection: where a gate network and a part must agree, and where
//     the part's documented all-X rule makes them differ on purpose.
// ---------------------------------------------------------------------------

describe('MUX_4 vs its gate networks with an undetermined select', () => {
  // A is permanently X (a NOT with an unconnected input); B and the data are switches.
  const { c, sop } = mux4Bench({ a: 'x', b: 'sw', d: ['sw', 'sw', 'sw', 'sw'] })

  it('the injected select really is X and its complement is X too', () => {
    expect(c.pin(p('mux', 'A'))).toBe(X)
    expect(c.pin(p('na', 'out'))).toBe(X)
  })

  it('part: an undetermined select gives X regardless of the data (manual: bad select -> X)', () => {
    for (const combo of allCombos(5)) {
      const [bs, d0, d1, d2, d3] = combo
      c.setMany({ b: bs, d0, d1, d2, d3 })
      expect(c.pin(p('mux', 'Z')), `B=${bs} data=${num(d3)}${num(d2)}${num(d1)}${num(d0)}`).toBe(X)
    }
  })

  it('MUX_2 tree: X on the top select also gives X (parts propagate the rule)', () => {
    for (const combo of allCombos(5)) {
      const [bs, d0, d1, d2, d3] = combo
      c.setMany({ b: bs, d0, d1, d2, d3 })
      expect(c.pin(p('trt', 'Z')), `B=${bs}`).toBe(X)
    }
  })

  it('gate networks stay at 0 when every reachable data input is 0 (documented divergence)', () => {
    // B = 0 makes terms 0 and 2 the only ones that are not killed by a controlling 0.
    c.setMany({ b: ZERO, d0: ZERO, d1: ONE, d2: ZERO, d3: ONE })
    expect(c.pin(sop), 'AND-OR').toBe(ZERO)
    expect(c.pin(p('nn', 'out')), 'NAND-NAND').toBe(ZERO)
    expect(c.pin(p('mux', 'Z')), 'MUX_4 part').toBe(X)
    c.setMany({ b: ONE, d0: ONE, d1: ZERO, d2: ONE, d3: ZERO })
    expect(c.pin(sop), 'AND-OR with B=1').toBe(ZERO)
    expect(c.pin(p('nn', 'out')), 'NAND-NAND with B=1').toBe(ZERO)
    expect(c.pin(p('mux', 'Z')), 'MUX_4 part with B=1').toBe(X)
  })

  it('gate networks give X as soon as a reachable data input is 1 (they then agree with the part)', () => {
    c.setMany({ b: ZERO, d0: ONE, d1: ZERO, d2: ZERO, d3: ZERO })
    expect(c.pin(sop), 'AND-OR').toBe(X)
    expect(c.pin(p('nn', 'out')), 'NAND-NAND').toBe(X)
    expect(c.pin(p('mux', 'Z')), 'MUX_4 part').toBe(X)
    c.setMany({ b: ZERO, d0: ZERO, d1: ZERO, d2: ONE, d3: ZERO })
    expect(c.pin(sop), 'AND-OR with the other reachable term').toBe(X)
    expect(c.pin(p('mux', 'Z'))).toBe(X)
  })

  it('an OR gate can never be forced to 1 by a term whose select literal is X', () => {
    for (const combo of allCombos(5)) {
      const [bs, d0, d1, d2, d3] = combo
      c.setMany({ b: bs, d0, d1, d2, d3 })
      expect(c.pin(sop), `B=${bs} data=${num(d3)}${num(d2)}${num(d1)}${num(d0)}`).not.toBe(ONE)
    }
  })
})

describe('MUX_4 vs its gate networks with X or Z on the data inputs', () => {
  it('an unselected X data input changes nothing in either implementation', () => {
    const { c, sop } = mux4Bench({ a: 'sw', b: 'sw', d: ['sw', 'sw', 'sw', 'x'] })
    for (const [a, bs, d0] of allCombos(3)) {
      if (a === ONE && bs === ONE) continue // that would select the X input
      c.setMany({ a, b: bs, d0, d1: d0, d2: d0 })
      expect(c.pin(p('mux', 'Z')), `part AB=${a}${bs}`).toBe(d0)
      expect(c.pin(sop), `AND-OR AB=${a}${bs}`).toBe(d0)
      expect(c.pin(p('nn', 'out')), `NAND-NAND AB=${a}${bs}`).toBe(d0)
      expect(c.pin(p('trt', 'Z')), `tree AB=${a}${bs}`).toBe(d0)
    }
  })

  it('selecting the X data input gives X everywhere', () => {
    const { c, sop } = mux4Bench({ a: 'sw', b: 'sw', d: ['sw', 'sw', 'sw', 'x'] })
    c.setMany({ a: ONE, b: ONE, d0: ZERO, d1: ZERO, d2: ZERO })
    expect(c.pin(p('mux', 'Z')), 'part').toBe(X)
    expect(c.pin(sop), 'AND-OR').toBe(X)
    expect(c.pin(p('nn', 'out')), 'NAND-NAND').toBe(X)
    expect(c.pin(p('trt', 'Z')), 'tree').toBe(X)
  })

  it('selecting a Z (released) data input gives X everywhere: a part input reads Z as undetermined', () => {
    const { c, sop } = mux4Bench({ a: 'sw', b: 'sw', d: ['z', 'sw', 'sw', 'sw'] })
    expect(c.pin(p('mux', 'in0')), 'the injected net floats').toBe(Z)
    c.setMany({ a: ZERO, b: ZERO, d1: ZERO, d2: ZERO, d3: ZERO })
    expect(c.pin(p('mux', 'Z')), 'part').toBe(X)
    expect(c.pin(sop), 'AND-OR').toBe(X)
    expect(c.pin(p('nn', 'out')), 'NAND-NAND').toBe(X)
    expect(c.pin(p('trt', 'Z')), 'tree').toBe(X)
  })

  it('an unselected Z data input changes nothing in either implementation', () => {
    const { c, sop } = mux4Bench({ a: 'sw', b: 'sw', d: ['z', 'sw', 'sw', 'sw'] })
    for (const [a, bs] of allCombos(2)) {
      if (a === ZERO && bs === ZERO) continue
      c.setMany({ a, b: bs, d1: ONE, d2: ONE, d3: ONE })
      expect(c.pin(p('mux', 'Z')), `part AB=${a}${bs}`).toBe(ONE)
      expect(c.pin(sop), `AND-OR AB=${a}${bs}`).toBe(ONE)
      expect(c.pin(p('nn', 'out')), `NAND-NAND AB=${a}${bs}`).toBe(ONE)
      expect(c.pin(p('trt', 'Z')), `tree AB=${a}${bs}`).toBe(ONE)
    }
  })
})

describe('DECODER_2TO4 vs the NOR network with an undetermined select', () => {
  it('A = X: the part gives four X, the NOR network keeps the two outputs a controlling 1 kills', () => {
    const c = dec24Bench({ a: 'x', b: 'sw' })
    c.setMany({ b: ZERO })
    // Part: bad select -> every output X.
    for (let i = 0; i < 4; i++) expect(c.pin(p('dec', `out${i}`)), `part out${i}`).toBe(X)
    // Gates: out1 = NOR(X, B'=1) = 0 and out3 = NOR(X, B'=1) = 0; the others stay X.
    expect(c.pin(p('g0', 'out')), 'NOR out0').toBe(X)
    expect(c.pin(p('g1', 'out')), 'NOR out1').toBe(ZERO)
    expect(c.pin(p('g2', 'out')), 'NOR out2').toBe(X)
    expect(c.pin(p('g3', 'out')), 'NOR out3').toBe(ZERO)
  })

  it('B = X: the part gives four X, the NOR network zeroes the outputs A controls', () => {
    const c = dec24Bench({ a: 'sw', b: 'x' })
    c.setMany({ a: ZERO })
    for (let i = 0; i < 4; i++) expect(c.pin(p('dec', `out${i}`)), `part out${i}`).toBe(X)
    // A = 0 -> out2 = NOR(A'=1, X) = 0 and out3 = NOR(A'=1, X) = 0.
    expect(c.pin(p('g0', 'out')), 'NOR out0').toBe(X)
    expect(c.pin(p('g1', 'out')), 'NOR out1').toBe(X)
    expect(c.pin(p('g2', 'out')), 'NOR out2').toBe(ZERO)
    expect(c.pin(p('g3', 'out')), 'NOR out3').toBe(ZERO)
    c.setMany({ a: ONE })
    expect(c.pin(p('g0', 'out')), 'NOR out0 with A=1').toBe(ZERO)
    expect(c.pin(p('g1', 'out')), 'NOR out1 with A=1').toBe(ZERO)
    expect(c.pin(p('g2', 'out')), 'NOR out2 with A=1').toBe(X)
    expect(c.pin(p('g3', 'out')), 'NOR out3 with A=1').toBe(X)
  })

  it('an unconnected (Z) select behaves exactly like an X select in both implementations', () => {
    const cz = dec24Bench({ a: 'z', b: 'sw' })
    const cx = dec24Bench({ a: 'x', b: 'sw' })
    for (const bs of [ZERO, ONE]) {
      cz.setMany({ b: bs })
      cx.setMany({ b: bs })
      for (let i = 0; i < 4; i++) {
        expect(cz.pin(p('dec', `out${i}`)), `part out${i} B=${bs}`).toBe(cx.pin(p('dec', `out${i}`)))
        expect(cz.pin(p(`g${i}`, 'out')), `gates out${i} B=${bs}`).toBe(cx.pin(p(`g${i}`, 'out')))
      }
    }
    expect(evalDecoder([X, ZERO])).toEqual([X, X, X, X])
    expect(evalDecoder([Z, ZERO])).toEqual([X, X, X, X])
  })

  it('no output of either implementation is ever 1 while the select is undetermined', () => {
    const c = dec24Bench({ a: 'x', b: 'sw' })
    for (const bs of [ZERO, ONE]) {
      c.setMany({ b: bs })
      for (let i = 0; i < 4; i++) {
        expect(c.pin(p('dec', `out${i}`)), `part out${i}`).not.toBe(ONE)
        expect(c.pin(p(`g${i}`, 'out')), `gates out${i}`).not.toBe(ONE)
      }
    }
  })
})

describe('tristate muxing with an undetermined select', () => {
  function tsMux2X(): Circuit {
    const b = new CircuitBuilder().add('gnd', ComponentType.GROUND)
    const sPin = driverPin(b, 's', 'x')
    const sLo = invert(b, 'ns', sPin)
    b.switch('d0')
      .switch('d1')
      .add('mux', ComponentType.MUX_2)
      .wire(sPin, p('mux', 'A'))
      .wire(p('d0', 'out'), p('mux', 'in0'))
      .wire(p('d1', 'out'), p('mux', 'in1'))
      .add('t0', ComponentType.TRISTATE_RIGHT)
      .wire(p('d0', 'out'), p('t0', 'in'))
      .wire(sLo, p('t0', 'ctl'))
      .add('t1', ComponentType.TRISTATE_RIGHT)
      .wire(p('d1', 'out'), p('t1', 'in'))
      .wire(sPin, p('t1', 'ctl'))
      .probe('bus')
      .wire(p('t0', 'out'), p('bus', 'in'))
      .wire(p('t1', 'out'), p('bus', 'in'))
    return b.build()
  }

  it('an X control turns both buffers into X drivers, so the net and MUX_2 both read X', () => {
    const c = tsMux2X()
    for (const [d0, d1] of allCombos(2)) {
      c.setMany({ d0, d1 })
      expect(c.pin(p('t0', 'out')), 'buffer 0').toBe(X)
      expect(c.pin(p('t1', 'out')), 'buffer 1').toBe(X)
      expect(c.pin(p('bus', 'in')), 'shared net').toBe(X)
      expect(c.pin(p('mux', 'Z')), 'MUX_2 part').toBe(X)
    }
  })

  it('a decoder-driven tristate mux with an X select also agrees with MUX_4 (both X)', () => {
    const b = new CircuitBuilder().add('gnd', ComponentType.GROUND)
    const aPin = driverPin(b, 'a', 'x')
    b.switch('b')
      .add('dec', ComponentType.DECODER_2TO4)
      .add('mux', ComponentType.MUX_4)
      .wire(aPin, p('dec', 'A'))
      .wire(aPin, p('mux', 'A'))
      .connect(p('b', 'out'), p('dec', 'B'), p('mux', 'B'))
      .probe('bus')
    for (let i = 0; i < 4; i++) {
      b.switch(`d${i}`)
        .add(`ts${i}`, ComponentType.TRISTATE_RIGHT)
        .connect(p(`d${i}`, 'out'), p(`ts${i}`, 'in'), p('mux', `in${i}`))
        .wire(p('dec', `out${i}`), p(`ts${i}`, 'ctl'))
        .wire(p(`ts${i}`, 'out'), p('bus', 'in'))
    }
    const c = b.build()
    c.setMany({ b: ZERO, d0: ONE, d1: ZERO, d2: ONE, d3: ZERO })
    expect(c.pin(p('bus', 'in')), 'shared net').toBe(X)
    expect(c.pin(p('mux', 'Z')), 'MUX_4 part').toBe(X)
  })
})

describe('parity and comparator networks with X or Z inputs', () => {
  it('one undetermined bit poisons the whole XOR parity tree (XOR has no controlling value)', () => {
    const b = new CircuitBuilder().add('gnd', ComponentType.GROUND)
    const xPin = driverPin(b, 'w3', 'x')
    for (let i = 0; i < 3; i++) b.switch(`w${i}`)
    b.add('l0', ComponentType.XOR2)
      .wire(p('w0', 'out'), p('l0', 'in1'))
      .wire(p('w1', 'out'), p('l0', 'in2'))
      .add('l1', ComponentType.XOR2)
      .wire(p('w2', 'out'), p('l1', 'in1'))
      .wire(xPin, p('l1', 'in2'))
      .add('odd', ComponentType.XOR2)
      .wire(p('l0', 'out'), p('odd', 'in1'))
      .wire(p('l1', 'out'), p('odd', 'in2'))
    const c = b.build()
    for (const combo of allCombos(3)) {
      c.setMany({ w0: combo[0], w1: combo[1], w2: combo[2] })
      expect(c.pin(p('l1', 'out')), 'second-level XOR').toBe(X)
      expect(c.pin(p('odd', 'out')), 'parity output').toBe(X)
    }
  })

  it('an unconnected (Z) comparator bit gives X on the XNOR but leaves AND-controlled results at 0', () => {
    const b = new CircuitBuilder().add('gnd', ComponentType.GROUND)
    const zPin = driverPin(b, 'q1', 'z')
    b.switch('p0')
      .switch('p1')
      .switch('q0')
      .add('x0', ComponentType.XNOR2)
      .wire(p('p0', 'out'), p('x0', 'in1'))
      .wire(p('q0', 'out'), p('x0', 'in2'))
      .add('x1', ComponentType.XNOR2)
      .wire(p('p1', 'out'), p('x1', 'in1'))
      .wire(zPin, p('x1', 'in2'))
      .add('eq', ComponentType.AND2)
      .wire(p('x0', 'out'), p('eq', 'in1'))
      .wire(p('x1', 'out'), p('eq', 'in2'))
    const c = b.build()
    c.setMany({ p0: ZERO, p1: ZERO, q0: ONE })
    expect(c.pin(p('x1', 'out')), 'XNOR with a floating input').toBe(X)
    expect(c.pin(p('x0', 'out')), 'the determined bit differs').toBe(ZERO)
    expect(c.pin(p('eq', 'out')), 'AND with a controlling 0').toBe(ZERO)
    c.setMany({ q0: ZERO })
    expect(c.pin(p('x0', 'out')), 'the determined bit matches').toBe(ONE)
    expect(c.pin(p('eq', 'out')), 'no controlling value left').toBe(X)
  })
})

// ---------------------------------------------------------------------------
// 11. Unconnected pins inside composed networks
// ---------------------------------------------------------------------------

describe('unconnected data input on a MUX_8 and on the matching minterm gate', () => {
  /** in5 is left unwired on the part, and so is the data input of minterm gate 5. */
  function bench(): { c: Circuit; sop: PinId } {
    const b = new CircuitBuilder()
    for (const s of ['sa', 'sb', 'sc']) addLiteral(b, s)
    b.add('mux', ComponentType.MUX_8)
      .wire(hi('sa'), p('mux', 'A'))
      .wire(hi('sb'), p('mux', 'B'))
      .wire(hi('sc'), p('mux', 'C'))
    const terms: PinId[] = []
    for (let i = 0; i < 8; i++) {
      if (i === 5) {
        b.add('t5', ComponentType.AND4)
        minterm(['sa', 'sb', 'sc'], 5).forEach((pin, k) => {
          b.wire(pin, p('t5', `in${k + 2}`)) // in1 (the data input) stays unwired
        })
        terms.push(p('t5', 'out'))
        continue
      }
      b.switch(`d${i}`, ONE).wire(p(`d${i}`, 'out'), p('mux', `in${i}`))
      terms.push(andOf(b, `t${i}`, [p(`d${i}`, 'out'), ...minterm(['sa', 'sb', 'sc'], i)]))
    }
    const sop = orOf(b, 'sop', terms)
    return { c: b.build(), sop }
  }
  const { c, sop } = bench()
  const select = (index: number): Record<string, LogicValue> => ({
    sa: bit((index >> 2) & 1),
    sb: bit((index >> 1) & 1),
    sc: bit(index & 1)
  })

  it('the unconnected pins read Z (manual §1.9: no connection means high impedance)', () => {
    expect(c.pin(p('mux', 'in5'))).toBe(Z)
    expect(c.pin(p('t5', 'in1'))).toBe(Z)
  })

  it('selecting the unconnected input gives X on the part and on the gate network', () => {
    c.setMany(select(5))
    expect(c.pin(p('mux', 'Z')), 'MUX_8 part').toBe(X)
    expect(c.pin(p('t5', 'out')), 'minterm gate 5').toBe(X)
    expect(c.pin(sop), 'AND-OR network').toBe(X)
  })

  it('every other select is unaffected: the dangling minterm is killed by a controlling 0', () => {
    for (let index = 0; index < 8; index++) {
      if (index === 5) continue
      c.setMany(select(index))
      expect(c.pin(p('mux', 'Z')), `part select ${bin(index, 3)}`).toBe(ONE)
      expect(c.pin(p('t5', 'out')), `minterm gate 5 at select ${bin(index, 3)}`).toBe(ZERO)
      expect(c.pin(sop), `AND-OR select ${bin(index, 3)}`).toBe(ONE)
    }
  })
})

describe('unconnected select on a DECODER_3TO8 and on the matching AND3 network', () => {
  /** C is driven by a released tristate (Z) on both the part and the gate literals. */
  function bench(): Circuit {
    const b = new CircuitBuilder().add('gnd', ComponentType.GROUND)
    addLiteral(b, 'sa')
    addLiteral(b, 'sb')
    const cPin = driverPin(b, 'sc', 'z')
    const cLo = invert(b, 'nsc', cPin)
    b.add('dec', ComponentType.DECODER_3TO8)
      .wire(hi('sa'), p('dec', 'A'))
      .wire(hi('sb'), p('dec', 'B'))
      .wire(cPin, p('dec', 'C'))
    for (let i = 0; i < 8; i++) {
      b.add(`g${i}`, ComponentType.AND3)
        .wire(i & 4 ? hi('sa') : lo('sa'), p(`g${i}`, 'in1'))
        .wire(i & 2 ? hi('sb') : lo('sb'), p(`g${i}`, 'in2'))
        .wire(i & 1 ? cPin : cLo, p(`g${i}`, 'in3'))
    }
    return b.build()
  }
  const c = bench()

  it('the part reports all eight outputs X for every value of the two good selects', () => {
    for (const [a, bs] of allCombos(2)) {
      c.setMany({ sa: a, sb: bs })
      for (let i = 0; i < 8; i++) expect(c.pin(p('dec', `out${i}`)), `AB=${a}${bs} out${i}`).toBe(X)
    }
  })

  it('the AND3 network keeps a 0 wherever A or B is a controlling 0, and is X on the other two', () => {
    for (const [a, bs] of allCombos(2)) {
      c.setMany({ sa: a, sb: bs })
      const reachable = 4 * num(a) + 2 * num(bs) // the two minterms C could still select
      for (let i = 0; i < 8; i++) {
        const want = i === reachable || i === reachable + 1 ? X : ZERO
        expect(c.pin(p(`g${i}`, 'out')), `AB=${a}${bs} g${i}`).toBe(want)
      }
    }
  })

  it('neither implementation ever asserts an output while a select is undetermined', () => {
    for (const [a, bs] of allCombos(2)) {
      c.setMany({ sa: a, sb: bs })
      for (let i = 0; i < 8; i++) {
        expect(c.pin(p('dec', `out${i}`)), `part out${i}`).not.toBe(ONE)
        expect(c.pin(p(`g${i}`, 'out')), `gates out${i}`).not.toBe(ONE)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 12. Timing inside composed combinational networks (decisions 2 and 12)
// ---------------------------------------------------------------------------

const trace = (c: Circuit, probeId: string): [number, LogicValue][] =>
  c.sim.getWaveforms().find((w) => w.probeId === probeId)!.samples.map((s) => [s.t, s.v])

describe('static-1 hazard in the AND-OR 2:1 mux (the MUX_2 part has none)', () => {
  /** in0 = in1 = 1, so the output should stay 1 while the select changes. */
  function bench(orDelay: number, initialSelect: LogicValue): Circuit {
    const b = new CircuitBuilder()
    addLiteral(b, 's', initialSelect)
    b.switch('d0', ONE)
      .switch('d1', ONE)
      .add('t0', ComponentType.AND2)
      .wire(p('d0', 'out'), p('t0', 'in1'))
      .wire(lo('s'), p('t0', 'in2'))
      .add('t1', ComponentType.AND2)
      .wire(p('d1', 'out'), p('t1', 'in1'))
      .wire(hi('s'), p('t1', 'in2'))
      .add('sop', ComponentType.OR2, { delay: orDelay })
      .wire(p('t0', 'out'), p('sop', 'in1'))
      .wire(p('t1', 'out'), p('sop', 'in2'))
      .add('mux', ComponentType.MUX_2)
      .wire(hi('s'), p('mux', 'A'))
      .wire(p('d0', 'out'), p('mux', 'in0'))
      .wire(p('d1', 'out'), p('mux', 'in1'))
      .probe('psop')
      .wire(p('sop', 'out'), p('psop', 'in'))
      .probe('pmux')
      .wire(p('mux', 'Z'), p('pmux', 'in'))
    return b.build()
  }

  it('1 -> 0 on the select: the inverter skew opens a 1 ns hole at the OR output', () => {
    const c = bench(1, ONE)
    expect(trace(c, 'psop')).toEqual([[0, ONE]])
    c.set('s', ZERO)
    // s falls at 1; t1 falls at 2 while t0 only rises at 3, so the OR dips for 1 ns.
    expect(trace(c, 'psop')).toEqual([
      [0, ONE],
      [3, ZERO],
      [4, ONE]
    ])
    expect(c.time).toBe(4)
    expect(c.pin(p('sop', 'out'))).toBe(ONE)
  })

  it('the MUX_2 part covering the same function never glitches', () => {
    const c = bench(1, ONE)
    c.set('s', ZERO)
    expect(trace(c, 'pmux')).toEqual([[0, ONE]])
    expect(c.pin(p('mux', 'Z'))).toBe(ONE)
  })

  it('0 -> 1 on the select: the AND that turns on leads, so there is no hazard', () => {
    const c = bench(1, ZERO)
    c.set('s', ONE)
    expect(trace(c, 'psop')).toEqual([[0, ONE]])
    expect(trace(c, 'pmux')).toEqual([[0, ONE]])
    expect(c.time).toBe(3)
  })

  it('an OR slower than the hole swallows the hazard entirely (inertial delay, decision 2)', () => {
    const c = bench(2, ONE)
    c.set('s', ZERO)
    expect(trace(c, 'psop')).toEqual([[0, ONE]])
    expect(c.pin(p('sop', 'out'))).toBe(ONE)
  })

  it('the hazard never changes the settled value, for either select direction', () => {
    for (const orDelay of [1, 2, 3]) {
      const c = bench(orDelay, ONE)
      c.set('s', ZERO)
      expect(c.pin(p('sop', 'out')), `delay ${orDelay} after 1->0`).toBe(ONE)
      c.set('s', ONE)
      expect(c.pin(p('sop', 'out')), `delay ${orDelay} after 0->1`).toBe(ONE)
      expect(c.pin(p('mux', 'Z')), `delay ${orDelay} part`).toBe(ONE)
    }
  })
})

describe('tristate mux handover: break-before-make vs a glitch-free decoder handover', () => {
  /** Two tristates steered by S and S' (the inverter delays one of the two enables). */
  function skewed(initialSelect: LogicValue): Circuit {
    const b = new CircuitBuilder()
    addLiteral(b, 's', initialSelect)
    b.switch('d0', ONE)
      .switch('d1', ONE)
      .add('t0', ComponentType.TRISTATE_RIGHT)
      .wire(p('d0', 'out'), p('t0', 'in'))
      .wire(lo('s'), p('t0', 'ctl'))
      .add('t1', ComponentType.TRISTATE_RIGHT)
      .wire(p('d1', 'out'), p('t1', 'in'))
      .wire(hi('s'), p('t1', 'ctl'))
      .probe('bus')
      .wire(p('t0', 'out'), p('bus', 'in'))
      .wire(p('t1', 'out'), p('bus', 'in'))
    return b.build()
  }

  it('turning the leading buffer off first floats the net for exactly one instant', () => {
    const c = skewed(ONE)
    expect(trace(c, 'bus')).toEqual([[0, ONE]])
    c.set('s', ZERO)
    expect(trace(c, 'bus')).toEqual([
      [0, ONE],
      [2, Z],
      [3, ONE]
    ])
  })

  it('turning the trailing buffer on first keeps the net driven the whole time', () => {
    const c = skewed(ZERO)
    c.set('s', ONE)
    // Both buffers drive 1 for one instant; agreeing drivers resolve to 1 (decision 3).
    expect(trace(c, 'bus')).toEqual([[0, ONE]])
    expect(c.pin(p('bus', 'in'))).toBe(ONE)
  })

  /** Four tristates whose enables come from one DECODER_2TO4, so they switch together. */
  function decoderSteered(data: number): Circuit {
    const b = new CircuitBuilder()
      .switch('a')
      .switch('b')
      .add('dec', ComponentType.DECODER_2TO4)
      .wire(p('a', 'out'), p('dec', 'A'))
      .wire(p('b', 'out'), p('dec', 'B'))
      .probe('bus')
    for (let i = 0; i < 4; i++) {
      b.switch(`d${i}`, bit((data >> i) & 1))
        .add(`ts${i}`, ComponentType.TRISTATE_RIGHT)
        .wire(p(`d${i}`, 'out'), p(`ts${i}`, 'in'))
        .wire(p('dec', `out${i}`), p(`ts${i}`, 'ctl'))
        .wire(p(`ts${i}`, 'out'), p('bus', 'in'))
    }
    return b.build()
  }

  it('handing over between two sources carrying the same value leaves no sample (decision 12)', () => {
    const c = decoderSteered(0b1111)
    expect(trace(c, 'bus')).toEqual([[0, ONE]])
    c.set('b', ONE) // AB 00 -> 01: ts0 releases and ts1 takes over in the same instant
    expect(trace(c, 'bus')).toEqual([[0, ONE]])
    expect(c.pin(p('bus', 'in'))).toBe(ONE)
  })

  it('handing over between different values records exactly one sample, with no Z or X between', () => {
    const c = decoderSteered(0b0001) // only in0 is 1
    expect(trace(c, 'bus')).toEqual([[0, ONE]])
    c.set('b', ONE)
    expect(trace(c, 'bus')).toEqual([
      [0, ONE],
      [3, ZERO]
    ])
  })

  it('walking the select through all four sources gives one clean sample per change', () => {
    const c = decoderSteered(0b1010) // in1 and in3 are 1
    c.setMany({ a: ZERO, b: ONE }) // -> in1 = 1
    c.setMany({ a: ONE, b: ZERO }) // -> in2 = 0
    c.setMany({ a: ONE, b: ONE }) // -> in3 = 1
    const samples = trace(c, 'bus')
    expect(samples.map(([, v]) => v)).toEqual([ZERO, ONE, ZERO, ONE])
    expect(samples.every(([, v]) => v === ZERO || v === ONE)).toBe(true)
  })
})

describe('mixed propagation delays do not change what a gate mux settles to', () => {
  /** The 8:1 AND-OR mux again, with a different delay on every part. */
  function bench(): { c: Circuit; sop: PinId } {
    const delays = [3, 1, 7, 2, 5, 4, 6, 1]
    const b = new CircuitBuilder()
    for (const [k, s] of ['sa', 'sb', 'sc'].entries()) {
      b.switch(s, ZERO, { delay: k + 1 }).add(`n_${s}`, ComponentType.NOT, { delay: 3 - k })
      b.wire(p(s, 'out'), p(`n_${s}`, 'in1'))
    }
    b.add('mux', ComponentType.MUX_8, { delay: 9 })
      .wire(hi('sa'), p('mux', 'A'))
      .wire(hi('sb'), p('mux', 'B'))
      .wire(hi('sc'), p('mux', 'C'))
    const terms: PinId[] = []
    for (let i = 0; i < 8; i++) {
      b.switch(`d${i}`, ZERO, { delay: 1 + (i % 3) }).wire(p(`d${i}`, 'out'), p('mux', `in${i}`))
      b.add(`t${i}`, ComponentType.AND4, { delay: delays[i] })
      const pins = [p(`d${i}`, 'out'), ...minterm(['sa', 'sb', 'sc'], i)]
      pins.forEach((pin, k) => {
        b.wire(pin, p(`t${i}`, `in${k + 1}`))
      })
      terms.push(p(`t${i}`, 'out'))
    }
    b.add('sop_l', ComponentType.OR4, { delay: 4 })
    b.add('sop_r', ComponentType.OR4, { delay: 2 })
    b.add('sop_t', ComponentType.OR2, { delay: 6 })
    for (let i = 0; i < 4; i++) b.wire(terms[i], p('sop_l', `in${i + 1}`))
    for (let i = 4; i < 8; i++) b.wire(terms[i], p('sop_r', `in${i - 3}`))
    b.wire(p('sop_l', 'out'), p('sop_t', 'in1')).wire(p('sop_r', 'out'), p('sop_t', 'in2'))
    return { c: b.build(), sop: p('sop_t', 'out') }
  }
  const { c, sop } = bench()
  const PATTERNS = [0x00, 0xff, 0xaa, 0x55, 0x0f, 0xf0, 0x81, 0x24]

  for (let index = 0; index < 8; index++) {
    it(`select ${bin(index, 3)} settles to the right bit of every pattern despite the skew`, () => {
      for (const pattern of PATTERNS) {
        c.setMany({
          sa: bit((index >> 2) & 1),
          sb: bit((index >> 1) & 1),
          sc: bit(index & 1),
          ...word('d', pattern, 8)
        })
        const want = bit((pattern >> index) & 1)
        expect(c.pin(sop), `gates, pattern ${bin(pattern, 8)}`).toBe(want)
        expect(c.pin(p('mux', 'Z')), `part, pattern ${bin(pattern, 8)}`).toBe(want)
        expect(c.oscillated, 'no oscillation').toBe(false)
      }
    })
  }

  it('changing every input at once still settles to the same values as changing them one by one', () => {
    c.setMany({ sa: ZERO, sb: ZERO, sc: ZERO, ...word('d', 0x00, 8) })
    c.setMany({ sa: ONE, sb: ONE, sc: ONE, ...word('d', 0xff, 8) })
    const atOnce = c.pin(sop)
    c.setMany({ sa: ZERO, sb: ZERO, sc: ZERO, ...word('d', 0x00, 8) })
    c.set('sa', ONE)
    c.set('sb', ONE)
    c.set('sc', ONE)
    for (let i = 0; i < 8; i++) c.set(`d${i}`, ONE)
    expect(c.pin(sop)).toBe(atOnce)
    expect(c.pin(sop)).toBe(ONE)
    expect(c.pin(p('mux', 'Z'))).toBe(ONE)
  })
})

// ---------------------------------------------------------------------------
// 13. N-wide 2:1 mux: four gate slices vs one N_MUX_2TO1
// ---------------------------------------------------------------------------

describe('4-wide 2:1 mux from gates vs N_MUX_2TO1 (S=0 selects the left/X set)', () => {
  function bench(): Circuit {
    const b = new CircuitBuilder()
    addLiteral(b, 's')
    b.add('nmux', ComponentType.N_MUX_2TO1, { bits: 4 }).wire(hi('s'), p('nmux', 'S'))
    for (let i = 0; i < 4; i++) {
      b.switch(`x${i}`)
        .switch(`y${i}`)
        .wire(p(`x${i}`, 'out'), p('nmux', `X${i}`))
        .wire(p(`y${i}`, 'out'), p('nmux', `Y${i}`))
        .add(`gx${i}`, ComponentType.AND2)
        .wire(p(`x${i}`, 'out'), p(`gx${i}`, 'in1'))
        .wire(lo('s'), p(`gx${i}`, 'in2'))
        .add(`gy${i}`, ComponentType.AND2)
        .wire(p(`y${i}`, 'out'), p(`gy${i}`, 'in1'))
        .wire(hi('s'), p(`gy${i}`, 'in2'))
        .add(`g${i}`, ComponentType.OR2)
        .wire(p(`gx${i}`, 'out'), p(`g${i}`, 'in1'))
        .wire(p(`gy${i}`, 'out'), p(`g${i}`, 'in2'))
    }
    return b.build()
  }
  const c = bench()
  const gates = (): string => [3, 2, 1, 0].map((i) => c.pin(p(`g${i}`, 'out'))).join('')

  for (let xv = 0; xv < 16; xv++) {
    it(`X=${bin(xv, 4)} against all 16 Y values, both select positions`, () => {
      for (let yv = 0; yv < 16; yv++) {
        c.setMany({ s: ZERO, ...word('x', xv, 4), ...word('y', yv, 4) })
        expect(c.vec('nmux', 'Z', 4), `S=0 part X=${bin(xv, 4)} Y=${bin(yv, 4)}`).toBe(bin(xv, 4))
        expect(gates(), `S=0 gates X=${bin(xv, 4)} Y=${bin(yv, 4)}`).toBe(bin(xv, 4))
        c.set('s', ONE)
        expect(c.vec('nmux', 'Z', 4), `S=1 part X=${bin(xv, 4)} Y=${bin(yv, 4)}`).toBe(bin(yv, 4))
        expect(gates(), `S=1 gates X=${bin(xv, 4)} Y=${bin(yv, 4)}`).toBe(bin(yv, 4))
      }
    })
  }

  it('an undetermined select gives all X on the part, while the gates keep controlling zeroes', () => {
    const b = new CircuitBuilder().add('gnd', ComponentType.GROUND)
    const sPin = driverPin(b, 's', 'x')
    const sLo = invert(b, 'ns', sPin)
    b.add('nmux', ComponentType.N_MUX_2TO1, { bits: 2 }).wire(sPin, p('nmux', 'S'))
    for (let i = 0; i < 2; i++) {
      b.switch(`x${i}`)
        .switch(`y${i}`)
        .wire(p(`x${i}`, 'out'), p('nmux', `X${i}`))
        .wire(p(`y${i}`, 'out'), p('nmux', `Y${i}`))
        .add(`gx${i}`, ComponentType.AND2)
        .wire(p(`x${i}`, 'out'), p(`gx${i}`, 'in1'))
        .wire(sLo, p(`gx${i}`, 'in2'))
        .add(`gy${i}`, ComponentType.AND2)
        .wire(p(`y${i}`, 'out'), p(`gy${i}`, 'in1'))
        .wire(sPin, p(`gy${i}`, 'in2'))
        .add(`g${i}`, ComponentType.OR2)
        .wire(p(`gx${i}`, 'out'), p(`g${i}`, 'in1'))
        .wire(p(`gy${i}`, 'out'), p(`g${i}`, 'in2'))
    }
    const cx = b.build()
    cx.setMany({ x0: ZERO, x1: ONE, y0: ZERO, y1: ONE })
    expect(cx.vec('nmux', 'Z', 2), 'part goes all X').toBe('XX')
    expect(cx.pin(p('g0', 'out')), 'gate slice with both data 0').toBe(ZERO)
    expect(cx.pin(p('g1', 'out')), 'gate slice with data 1').toBe(X)
  })
})

// ---------------------------------------------------------------------------
// 14. The same mux wired through pin labels (virtual connections)
// ---------------------------------------------------------------------------

describe('4:1 mux wired entirely through pin labels vs the same mux wired with wires', () => {
  /** No wires at all: every connection is made by giving two pins the same label. */
  function labelled(): Circuit {
    const b = new CircuitBuilder()
    for (const s of ['a', 'b']) {
      b.switch(s).add(`n_${s}`, ComponentType.NOT)
      b.label(p(s, 'out'), s).label(p(`n_${s}`, 'in1'), s).label(p(`n_${s}`, 'out'), `${s}bar`)
    }
    b.add('mux', ComponentType.MUX_4)
    b.label(p('mux', 'A'), 'a').label(p('mux', 'B'), 'b')
    b.add('sop', ComponentType.OR4)
    for (let i = 0; i < 4; i++) {
      b.switch(`d${i}`).label(p(`d${i}`, 'out'), `d${i}`)
      b.label(p('mux', `in${i}`), `d${i}`)
      b.add(`t${i}`, ComponentType.AND3)
      b.label(p(`t${i}`, 'in1'), `d${i}`)
        .label(p(`t${i}`, 'in2'), i & 2 ? 'a' : 'abar')
        .label(p(`t${i}`, 'in3'), i & 1 ? 'b' : 'bbar')
        .label(p(`t${i}`, 'out'), `t${i}`)
        .label(p('sop', `in${i + 1}`), `t${i}`)
    }
    return b.build()
  }
  const c = labelled()

  for (let index = 0; index < 4; index++) {
    it(`AB=${bin(index, 2)} routes in${index} for all 16 data patterns`, () => {
      for (let pattern = 0; pattern < 16; pattern++) {
        c.setMany({
          a: bit((index >> 1) & 1),
          b: bit(index & 1),
          ...word('d', pattern, 4)
        })
        const want = bit((pattern >> index) & 1)
        expect(c.pin(p('mux', 'Z')), `part pattern ${bin(pattern, 4)}`).toBe(want)
        expect(c.pin(p('sop', 'out')), `gates pattern ${bin(pattern, 4)}`).toBe(want)
      }
    })
  }

  it('labels really made the connections (a labelled input is not floating)', () => {
    c.setMany({ a: ZERO, b: ZERO, d0: ONE, d1: ZERO, d2: ZERO, d3: ZERO })
    expect(c.pin(p('mux', 'in0'))).toBe(ONE)
    expect(c.pin(p('t0', 'in1'))).toBe(ONE)
    expect(c.pin(p('n_a', 'out'))).toBe(ONE)
  })
})

// ---------------------------------------------------------------------------
// 15. A part and an equivalent gate network driving the same net
// ---------------------------------------------------------------------------

describe('MUX_2 and its AND-OR twin tied to one net', () => {
  function bench(initialSelect: LogicValue): Circuit {
    const b = new CircuitBuilder()
    addLiteral(b, 's', initialSelect)
    b.switch('d0', ONE)
      .switch('d1', ONE)
      .add('t0', ComponentType.AND2)
      .wire(p('d0', 'out'), p('t0', 'in1'))
      .wire(lo('s'), p('t0', 'in2'))
      .add('t1', ComponentType.AND2)
      .wire(p('d1', 'out'), p('t1', 'in1'))
      .wire(hi('s'), p('t1', 'in2'))
      .add('sop', ComponentType.OR2)
      .wire(p('t0', 'out'), p('sop', 'in1'))
      .wire(p('t1', 'out'), p('sop', 'in2'))
      .add('mux', ComponentType.MUX_2)
      .wire(hi('s'), p('mux', 'A'))
      .wire(p('d0', 'out'), p('mux', 'in0'))
      .wire(p('d1', 'out'), p('mux', 'in1'))
      .probe('bus')
      .wire(p('mux', 'Z'), p('bus', 'in'))
      .wire(p('sop', 'out'), p('bus', 'in'))
    return b.build()
  }

  it('two drivers computing the same function agree, so the net carries that function', () => {
    const c = bench(ZERO)
    for (const [s, d0, d1] of allCombos(3)) {
      c.setMany({ s, d0, d1 })
      expect(c.pin(p('bus', 'in')), `A=${s} in0=${d0} in1=${d1}`).toBe(s === ONE ? d1 : d0)
    }
  })

  it("the gate side's hazard makes the shared net disagree for exactly one nanosecond", () => {
    const c = bench(ONE)
    expect(trace(c, 'bus')).toEqual([[0, ONE]])
    c.set('s', ZERO)
    // The part holds 1 while the AND-OR network dips to 0: two drivers, two values -> X.
    expect(trace(c, 'bus')).toEqual([
      [0, ONE],
      [3, X],
      [4, ONE]
    ])
  })
})

// ---------------------------------------------------------------------------
// 16. All four tristate orientations used as one 4:1 mux
// ---------------------------------------------------------------------------

describe('4:1 tristate mux built from the four tristate orientations', () => {
  function bench(): Circuit {
    const orientations = [
      ComponentType.TRISTATE_RIGHT,
      ComponentType.TRISTATE_LEFT,
      ComponentType.TRISTATE_UP,
      ComponentType.TRISTATE_DOWN
    ]
    const b = new CircuitBuilder()
      .switch('a')
      .switch('b')
      .add('dec', ComponentType.DECODER_2TO4)
      .add('mux', ComponentType.MUX_4)
      .connect(p('a', 'out'), p('dec', 'A'), p('mux', 'A'))
      .connect(p('b', 'out'), p('dec', 'B'), p('mux', 'B'))
      .probe('bus')
    for (let i = 0; i < 4; i++) {
      b.switch(`d${i}`)
        .add(`ts${i}`, orientations[i])
        .connect(p(`d${i}`, 'out'), p(`ts${i}`, 'in'), p('mux', `in${i}`))
        .wire(p('dec', `out${i}`), p(`ts${i}`, 'ctl'))
        .wire(p(`ts${i}`, 'out'), p('bus', 'in'))
    }
    return b.build()
  }
  const c = bench()

  for (let index = 0; index < 4; index++) {
    it(`AB=${bin(index, 2)} routes in${index} through its buffer for all 16 data patterns`, () => {
      for (let pattern = 0; pattern < 16; pattern++) {
        c.setMany({ a: bit((index >> 1) & 1), b: bit(index & 1), ...word('d', pattern, 4) })
        const want = bit((pattern >> index) & 1)
        // Every buffer output is on the shared net, so reading any of them reads
        // the resolved net: a buffer that failed to release would show up as X.
        expect(c.pin(p('bus', 'in')), `net, pattern ${bin(pattern, 4)}`).toBe(want)
        expect(c.pin(p('mux', 'Z')), `MUX_4, pattern ${bin(pattern, 4)}`).toBe(want)
        expect(c.pin(p(`ts${index}`, 'out')), `driving buffer, pattern ${bin(pattern, 4)}`).toBe(want)
      }
    })
  }

  it('the three disabled buffers really release: the net follows the selected input alone', () => {
    for (let index = 0; index < 4; index++) {
      // Selected input 0, every other input 1: any buffer still driving would give X.
      const pattern = 15 & ~(1 << index)
      c.setMany({ a: bit((index >> 1) & 1), b: bit(index & 1), ...word('d', pattern, 4) })
      expect(c.pin(p('bus', 'in')), `select ${index} with the others high`).toBe(ZERO)
      c.setMany(word('d', 1 << index, 4))
      expect(c.pin(p('bus', 'in')), `select ${index} with the others low`).toBe(ONE)
    }
  })

  it('every orientation drives identically (same behavior, different geometry)', () => {
    c.setMany({ d0: ONE, d1: ONE, d2: ONE, d3: ONE })
    for (let index = 0; index < 4; index++) {
      c.setMany({ a: bit((index >> 1) & 1), b: bit(index & 1) })
      expect(c.pin(p(`ts${index}`, 'out')), `buffer ${index} drives`).toBe(ONE)
      expect(c.pin(p('bus', 'in'))).toBe(ONE)
    }
  })
})

// ---------------------------------------------------------------------------
// 17. Wider compositions with no single equivalent part
// ---------------------------------------------------------------------------

describe('16:1 mux: AND5/OR tree vs a tree of two MUX_8 and one MUX_2', () => {
  function bench(): { c: Circuit; sop: PinId } {
    const b = new CircuitBuilder()
    for (const s of ['sa', 'sb', 'sc', 'sd']) addLiteral(b, s)
    b.add('mlo', ComponentType.MUX_8)
      .add('mhi', ComponentType.MUX_8)
      .add('top', ComponentType.MUX_2)
      .connect(hi('sb'), p('mlo', 'A'), p('mhi', 'A'))
      .connect(hi('sc'), p('mlo', 'B'), p('mhi', 'B'))
      .connect(hi('sd'), p('mlo', 'C'), p('mhi', 'C'))
      .wire(p('mlo', 'Z'), p('top', 'in0'))
      .wire(p('mhi', 'Z'), p('top', 'in1'))
      .wire(hi('sa'), p('top', 'A'))
    const terms: PinId[] = []
    for (let i = 0; i < 16; i++) {
      b.switch(`d${i}`)
      b.wire(p(`d${i}`, 'out'), i < 8 ? p('mlo', `in${i}`) : p('mhi', `in${i - 8}`))
      terms.push(andOf(b, `t${i}`, [p(`d${i}`, 'out'), ...minterm(['sa', 'sb', 'sc', 'sd'], i)]))
    }
    const sop = orOf(b, 'sop', terms)
    return { c: b.build(), sop }
  }
  const { c, sop } = bench()
  const select = (index: number): Record<string, LogicValue> => ({
    sa: bit((index >> 3) & 1),
    sb: bit((index >> 2) & 1),
    sc: bit((index >> 1) & 1),
    sd: bit(index & 1)
  })

  for (let index = 0; index < 16; index++) {
    it(`select ${bin(index, 4)} routes in${index} (checked against all 16 one-hot patterns)`, () => {
      for (let onehot = 0; onehot < 16; onehot++) {
        const sw: Record<string, LogicValue> = { ...select(index) }
        for (let i = 0; i < 16; i++) sw[`d${i}`] = bit(i === onehot ? 1 : 0)
        c.setMany(sw)
        const want = bit(index === onehot ? 1 : 0)
        expect(c.pin(p('top', 'Z')), `part tree, only in${onehot} high`).toBe(want)
        expect(c.pin(sop), `AND5-OR network, only in${onehot} high`).toBe(want)
      }
    })
  }

  it('both implementations follow a walking pattern across every select', () => {
    for (let index = 0; index < 16; index++) {
      const sw: Record<string, LogicValue> = { ...select(index) }
      for (let i = 0; i < 16; i++) sw[`d${i}`] = bit((i * 7) % 3 === 0 ? 1 : 0)
      c.setMany(sw)
      const want = bit((index * 7) % 3 === 0 ? 1 : 0)
      expect(c.pin(p('top', 'Z')), `part tree at ${bin(index, 4)}`).toBe(want)
      expect(c.pin(sop), `gates at ${bin(index, 4)}`).toBe(want)
    }
  })
})

describe('4:16 decoder: AND4 network vs two DECODER_3TO8 halves with an enable', () => {
  function bench(): Circuit {
    const b = new CircuitBuilder()
    for (const s of ['sa', 'sb', 'sc', 'sd']) addLiteral(b, s)
    b.add('dlo', ComponentType.DECODER_3TO8)
      .add('dhi', ComponentType.DECODER_3TO8)
      .connect(hi('sb'), p('dlo', 'A'), p('dhi', 'A'))
      .connect(hi('sc'), p('dlo', 'B'), p('dhi', 'B'))
      .connect(hi('sd'), p('dlo', 'C'), p('dhi', 'C'))
    for (let i = 0; i < 8; i++) {
      b.add(`e${i}`, ComponentType.AND2)
        .wire(p('dlo', `out${i}`), p(`e${i}`, 'in1'))
        .wire(lo('sa'), p(`e${i}`, 'in2'))
        .add(`e${i + 8}`, ComponentType.AND2)
        .wire(p('dhi', `out${i}`), p(`e${i + 8}`, 'in1'))
        .wire(hi('sa'), p(`e${i + 8}`, 'in2'))
    }
    for (let i = 0; i < 16; i++) andOf(b, `g${i}`, minterm(['sa', 'sb', 'sc', 'sd'], i))
    return b.build()
  }
  const c = bench()

  for (let index = 0; index < 16; index++) {
    it(`select ${bin(index, 4)} asserts line ${index} only, in both implementations`, () => {
      c.setMany({
        sa: bit((index >> 3) & 1),
        sb: bit((index >> 2) & 1),
        sc: bit((index >> 1) & 1),
        sd: bit(index & 1)
      })
      for (let i = 0; i < 16; i++) {
        const want = bit(i === index ? 1 : 0)
        expect(c.pin(p(`e${i}`, 'out')), `two 3:8 halves, line ${i}`).toBe(want)
        expect(c.pin(p(`g${i}`, 'out')), `AND4 network, line ${i}`).toBe(want)
      }
    })
  }

  it('both implementations are one-hot for all 16 selects', () => {
    for (let index = 0; index < 16; index++) {
      c.setMany({
        sa: bit((index >> 3) & 1),
        sb: bit((index >> 2) & 1),
        sc: bit((index >> 1) & 1),
        sd: bit(index & 1)
      })
      const parts = Array.from({ length: 16 }, (_, i) => c.pin(p(`e${i}`, 'out')))
      const gates = Array.from({ length: 16 }, (_, i) => c.pin(p(`g${i}`, 'out')))
      expect(parts.filter((v) => v === ONE).length, `parts ${bin(index, 4)}`).toBe(1)
      expect(gates.filter((v) => v === ONE).length, `gates ${bin(index, 4)}`).toBe(1)
      expect(parts.indexOf(ONE)).toBe(index)
      expect(gates.indexOf(ONE)).toBe(index)
    }
  })
})

// ---------------------------------------------------------------------------
// 18. Reconvergent fan-out inside a combinational network (decisions 1 and 2)
// ---------------------------------------------------------------------------

describe('two paths from one switch reconverging on an XOR2', () => {
  /** s -> NOT(delay d1) -> in1 and s -> NOT(delay d2) -> in2; the XOR is always 0. */
  function bench(d1: number, d2: number, xorDelay = 1): Circuit {
    return new CircuitBuilder()
      .switch('s', ZERO)
      .add('n1', ComponentType.NOT, { delay: d1 })
      .add('n2', ComponentType.NOT, { delay: d2 })
      .add('x', ComponentType.XOR2, { delay: xorDelay })
      .probe('y')
      .wire(p('s', 'out'), p('n1', 'in1'))
      .wire(p('s', 'out'), p('n2', 'in1'))
      .wire(p('n1', 'out'), p('x', 'in1'))
      .wire(p('n2', 'out'), p('x', 'in2'))
      .wire(p('x', 'out'), p('y', 'in'))
      .build()
  }

  it('equal delays: both inputs change in the same instant, so the XOR never glitches', () => {
    const c = bench(2, 2)
    expect(trace(c, 'y')).toEqual([[0, ZERO]])
    c.set('s', ONE)
    expect(trace(c, 'y')).toEqual([[0, ZERO]])
    expect(c.pin(p('x', 'out'))).toBe(ZERO)
    expect(c.time).toBe(3)
  })

  it('a 1 ns skew shows up as a 1 ns pulse (pulse width equals the gate delay)', () => {
    const c = bench(2, 3)
    c.set('s', ONE)
    expect(trace(c, 'y')).toEqual([
      [0, ZERO],
      [4, ONE],
      [5, ZERO]
    ])
    expect(c.pin(p('x', 'out'))).toBe(ZERO)
  })

  it('the same skew through a slower XOR is swallowed (inertial delay)', () => {
    const c = bench(2, 3, 2)
    c.set('s', ONE)
    expect(trace(c, 'y')).toEqual([[0, ZERO]])
    expect(c.pin(p('x', 'out'))).toBe(ZERO)
  })

  it('a 3 ns skew through a 2 ns XOR does reach the output', () => {
    const c = bench(2, 5, 2)
    c.set('s', ONE)
    expect(trace(c, 'y').map(([, v]) => v)).toEqual([ZERO, ONE, ZERO])
    expect(c.pin(p('x', 'out'))).toBe(ZERO)
  })

  it('the settled value is 0 for both switch positions and every skew', () => {
    for (const [d1, d2] of [
      [1, 1],
      [1, 4],
      [4, 1],
      [7, 3]
    ]) {
      const c = bench(d1, d2)
      c.set('s', ONE)
      expect(c.pin(p('x', 'out')), `delays ${d1}/${d2} after 0->1`).toBe(ZERO)
      c.set('s', ZERO)
      expect(c.pin(p('x', 'out')), `delays ${d1}/${d2} after 1->0`).toBe(ZERO)
    }
  })
})

describe('a mux select tied to one of its own data inputs', () => {
  /** Z = A ? in1 : in0 with in1 wired to A, so Z = A + A'·in0 = A or in0. */
  function bench(): Circuit {
    const b = new CircuitBuilder()
    addLiteral(b, 's')
    b.switch('d0')
      .add('mux', ComponentType.MUX_2)
      .wire(hi('s'), p('mux', 'A'))
      .wire(hi('s'), p('mux', 'in1'))
      .wire(p('d0', 'out'), p('mux', 'in0'))
      .add('t0', ComponentType.AND2)
      .wire(p('d0', 'out'), p('t0', 'in1'))
      .wire(lo('s'), p('t0', 'in2'))
      .add('t1', ComponentType.AND2)
      .wire(hi('s'), p('t1', 'in1'))
      .wire(hi('s'), p('t1', 'in2'))
      .add('sop', ComponentType.OR2)
      .wire(p('t0', 'out'), p('sop', 'in1'))
      .wire(p('t1', 'out'), p('sop', 'in2'))
    return b.build()
  }
  const c = bench()

  for (const [s, d0] of allCombos(2)) {
    const want = s === ONE ? ONE : d0
    it(`A=${s} (also feeding in1) in0=${d0} -> ${want}`, () => {
      c.setMany({ s, d0 })
      expect(c.pin(p('mux', 'Z')), 'MUX_2 part').toBe(want)
      expect(c.pin(p('sop', 'out')), 'AND-OR network').toBe(want)
    })
  }
})
