// Composite circuits: parts wired together must reproduce textbook behavior and
// agree with the equivalent built-in part. Covers memory elements from gates,
// sequential blocks from flip-flops, combinational blocks from gates, bus flows,
// the state machine + checker as a system, and timing/glitch behavior.

import { describe, expect, it } from 'vitest'
import { ComponentType, LogicValue, type SignalRow } from '../../model/types'
import { CircuitBuilder, Circuit, allCombos, p } from './harness'

const { ZERO, ONE, X, Z } = LogicValue

const bit = (b: number): LogicValue => (b ? ONE : ZERO)
const trace = (c: Circuit, probeId: string): [number, LogicValue][] =>
  c.sim.getWaveforms().find((w) => w.probeId === probeId)!.samples.map((s) => [s.t, s.v])

/** D flip-flop with S and R tied high through a shared VCC part. */
function addDff(b: CircuitBuilder, id: string, vcc = 'vcc'): CircuitBuilder {
  b.add(id, ComponentType.D_FLIPFLOP).wire(p(vcc, 'out'), p(id, 'S')).wire(p(vcc, 'out'), p(id, 'R'))
  return b
}

describe('latches and flip-flops built from gates', () => {
  function norLatch(): Circuit {
    return new CircuitBuilder()
      .switch('s', ZERO)
      .switch('r', ZERO)
      .add('g1', ComponentType.NOR2) // Q  = NOR(R, Q')
      .add('g2', ComponentType.NOR2) // Q' = NOR(S, Q)
      .wire(p('r', 'out'), p('g1', 'in1'))
      .wire(p('g2', 'out'), p('g1', 'in2'))
      .wire(p('s', 'out'), p('g2', 'in1'))
      .wire(p('g1', 'out'), p('g2', 'in2'))
      .build()
  }

  it('NOR SR latch: unknown at power-up, then set / hold / reset / hold', () => {
    const c = norLatch()
    expect(c.pin(p('g1', 'out'))).toBe(X)
    c.set('s', ONE)
    expect(c.pin(p('g1', 'out'))).toBe(ONE)
    expect(c.pin(p('g2', 'out'))).toBe(ZERO)
    c.set('s', ZERO)
    expect(c.pin(p('g1', 'out'))).toBe(ONE)
    c.set('r', ONE)
    expect(c.pin(p('g1', 'out'))).toBe(ZERO)
    expect(c.pin(p('g2', 'out'))).toBe(ONE)
    c.set('r', ZERO)
    expect(c.pin(p('g1', 'out'))).toBe(ZERO)
  })

  it('NOR SR latch: S = R = 1 drives both outputs low', () => {
    const c = norLatch()
    c.setMany({ s: ONE, r: ONE })
    expect(c.pin(p('g1', 'out'))).toBe(ZERO)
    expect(c.pin(p('g2', 'out'))).toBe(ZERO)
  })

  it('NAND SR latch (active-low inputs): set / hold / reset', () => {
    const c = new CircuitBuilder()
      .switch('sn', ONE)
      .switch('rn', ONE)
      .add('g1', ComponentType.NAND2) // Q  = NAND(S', Q')
      .add('g2', ComponentType.NAND2) // Q' = NAND(R', Q)
      .wire(p('sn', 'out'), p('g1', 'in1'))
      .wire(p('g2', 'out'), p('g1', 'in2'))
      .wire(p('rn', 'out'), p('g2', 'in1'))
      .wire(p('g1', 'out'), p('g2', 'in2'))
      .build()
    c.set('sn', ZERO)
    expect(c.pin(p('g1', 'out'))).toBe(ONE)
    c.set('sn', ONE)
    expect(c.pin(p('g1', 'out'))).toBe(ONE)
    c.set('rn', ZERO)
    expect(c.pin(p('g1', 'out'))).toBe(ZERO)
    c.set('rn', ONE)
    expect(c.pin(p('g1', 'out'))).toBe(ZERO)
  })

  /** Classic 4-NAND gated D latch: a = NAND(D,E), b = NAND(a,E), Q = NAND(a,Q'), Q' = NAND(b,Q). */
  function gatedDLatch(b: CircuitBuilder, id: string, d: string, e: string): void {
    b.add(`${id}a`, ComponentType.NAND2)
      .add(`${id}b`, ComponentType.NAND2)
      .add(`${id}q`, ComponentType.NAND2)
      .add(`${id}qn`, ComponentType.NAND2)
      .wire(d, p(`${id}a`, 'in1'))
      .wire(e, p(`${id}a`, 'in2'))
      .wire(p(`${id}a`, 'out'), p(`${id}b`, 'in1'))
      .wire(e, p(`${id}b`, 'in2'))
      .wire(p(`${id}a`, 'out'), p(`${id}q`, 'in1'))
      .wire(p(`${id}qn`, 'out'), p(`${id}q`, 'in2'))
      .wire(p(`${id}b`, 'out'), p(`${id}qn`, 'in1'))
      .wire(p(`${id}q`, 'out'), p(`${id}qn`, 'in2'))
  }

  it('gated D latch from NANDs is transparent while E = 1 and holds while E = 0', () => {
    const b = new CircuitBuilder().switch('d', ZERO).switch('e', ONE)
    gatedDLatch(b, 'l', p('d', 'out'), p('e', 'out'))
    const c = b.build()
    expect(c.pin(p('lq', 'out'))).toBe(ZERO)
    c.set('d', ONE)
    expect(c.pin(p('lq', 'out'))).toBe(ONE)
    c.set('e', ZERO)
    c.set('d', ZERO)
    expect(c.pin(p('lq', 'out'))).toBe(ONE)
    c.set('d', ONE)
    c.set('d', ZERO)
    expect(c.pin(p('lq', 'out'))).toBe(ONE)
    c.set('e', ONE)
    expect(c.pin(p('lq', 'out'))).toBe(ZERO)
  })

  it('master-slave D flip-flop from two gated latches tracks the D_FLIPFLOP part over 40 clocks', () => {
    const b = new CircuitBuilder()
      .switch('d', ZERO)
      .switch('clk', ZERO)
      .add('vcc', ComponentType.VCC)
      .add('inv', ComponentType.NOT)
      .wire(p('clk', 'out'), p('inv', 'in1'))
    gatedDLatch(b, 'm', p('d', 'out'), p('inv', 'out')) // master open while CLK = 0
    gatedDLatch(b, 's', p('mq', 'out'), p('clk', 'out')) // slave open while CLK = 1
    addDff(b, 'ff').wire(p('d', 'out'), p('ff', 'D')).wire(p('clk', 'out'), p('ff', 'CLK'))
    const c = b.build()

    let seed = 7
    for (let i = 0; i < 40; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      const d = bit((seed >> 8) & 1)
      c.set('d', d) // clock is low: only the master follows
      c.rise('clk')
      expect(c.pin(p('sq', 'out'))).toBe(d)
      expect(c.pin(p('ff', 'Q'))).toBe(d)
      c.set('d', d === ONE ? ZERO : ONE) // clock high: slave must not change
      expect(c.pin(p('sq', 'out'))).toBe(d)
      expect(c.pin(p('ff', 'Q'))).toBe(d)
      c.fall('clk')
      expect(c.pin(p('sq', 'out'))).toBe(d)
      expect(c.pin(p('ff', 'Q'))).toBe(d)
    }
  })
})

describe('sequential blocks from flip-flops agree with the built-in parts', () => {
  it('4-bit shift register from D flip-flops matches N_SHIFT_RIGHT', () => {
    const b = new CircuitBuilder()
      .switch('sin', ZERO)
      .switch('clk', ZERO)
      .add('vcc', ComponentType.VCC)
      .add('gnd', ComponentType.GROUND)
      .add('sr', ComponentType.N_SHIFT_RIGHT, { bits: 4 })
      .wire(p('clk', 'out'), p('sr', 'CLK'))
      .wire(p('gnd', 'out'), p('sr', 'CLR'))
      .wire(p('gnd', 'out'), p('sr', 'Ld'))
      .wire(p('vcc', 'out'), p('sr', 'RS'))
      .wire(p('sin', 'out'), p('sr', 'Lin'))
    // Serial in enters bit 3 and moves toward bit 0, like the part.
    for (let i = 3; i >= 0; i--) {
      addDff(b, `f${i}`).wire(p('clk', 'out'), p(`f${i}`, 'CLK'))
      b.wire(i === 3 ? p('sin', 'out') : p(`f${i + 1}`, 'Q'), p(`f${i}`, 'D'))
    }
    const c = b.build()
    const ffs = (): string => [3, 2, 1, 0].map((i) => c.pin(p(`f${i}`, 'Q'))).join('')

    const pattern = [1, 1, 0, 1, 0, 0, 1, 0, 1, 1]
    let expected = 'XXXX'
    for (const s of pattern) {
      c.set('sin', bit(s))
      c.pulse('clk')
      expected = String(s) + expected.slice(0, 3)
      expect(c.vec('sr', 'Q', 4)).toBe(expected)
      expect(ffs()).toBe(expected)
    }
  })

  it('3-bit ripple counter from JK flip-flops counts like N_COUNTER', () => {
    const b = new CircuitBuilder()
      .switch('clk', ZERO)
      .switch('clr', ONE) // JK R (active low) and counter CLR (active low)
      .add('vcc', ComponentType.VCC)
      .add('ctr', ComponentType.N_COUNTER, { bits: 3 })
      .wire(p('clk', 'out'), p('ctr', 'CLK'))
      .wire(p('vcc', 'out'), p('ctr', 'En'))
      .wire(p('clr', 'out'), p('ctr', 'CLR'))
    for (let i = 0; i < 3; i++) {
      b.add(`j${i}`, ComponentType.JK_FLIPFLOP)
        .wire(p('vcc', 'out'), p(`j${i}`, 'J'))
        .wire(p('vcc', 'out'), p(`j${i}`, 'K'))
        .wire(p('vcc', 'out'), p(`j${i}`, 'S'))
        .wire(p('clr', 'out'), p(`j${i}`, 'R'))
        .wire(i === 0 ? p('clk', 'out') : p(`j${i - 1}`, 'Q'), p(`j${i}`, 'CLK'))
    }
    const c = b.build()
    const ripple = (): string => [2, 1, 0].map((i) => c.pin(p(`j${i}`, 'Q'))).join('')

    c.set('clr', ZERO) // async clear of the JKs; the counter clears on the next edge
    c.pulse('clk')
    c.set('clr', ONE)
    expect(ripple()).toBe('000')
    expect(c.vec('ctr', 'Q', 3)).toBe('000')
    for (let k = 1; k <= 10; k++) {
      c.pulse('clk')
      const expected = (k % 8).toString(2).padStart(3, '0')
      expect(ripple()).toBe(expected)
      expect(c.vec('ctr', 'Q', 3)).toBe(expected)
    }
  })

  it('synchronous 2-bit counter from D flip-flops (D0 = Q0\', D1 = Q1 xor Q0) matches N_COUNTER', () => {
    const b = new CircuitBuilder()
      .switch('clk', ZERO)
      .switch('rst', ONE) // FF R (active low)
      .switch('cclr', ONE) // counter CLR (active low)
      .add('vcc', ComponentType.VCC)
      .add('ctr', ComponentType.N_COUNTER, { bits: 2 })
      .add('x', ComponentType.XOR2)
      .wire(p('clk', 'out'), p('ctr', 'CLK'))
      .wire(p('vcc', 'out'), p('ctr', 'En'))
      .wire(p('cclr', 'out'), p('ctr', 'CLR'))
    for (const id of ['f0', 'f1']) {
      b.add(id, ComponentType.D_FLIPFLOP)
        .wire(p('vcc', 'out'), p(id, 'S'))
        .wire(p('rst', 'out'), p(id, 'R'))
        .wire(p('clk', 'out'), p(id, 'CLK'))
    }
    b.wire(p('f0', "Q'"), p('f0', 'D'))
      .wire(p('f0', 'Q'), p('x', 'in1'))
      .wire(p('f1', 'Q'), p('x', 'in2'))
      .wire(p('x', 'out'), p('f1', 'D'))
    const c = b.build()

    c.set('rst', ZERO)
    c.set('cclr', ZERO)
    c.pulse('clk')
    c.setMany({ rst: ONE, cclr: ONE })
    for (let k = 1; k <= 9; k++) {
      c.pulse('clk')
      const expected = (k % 4).toString(2).padStart(2, '0')
      expect(c.pin(p('f1', 'Q')) + c.pin(p('f0', 'Q'))).toBe(expected)
      expect(c.vec('ctr', 'Q', 2)).toBe(expected)
    }
  })

  it('register + adder accumulator (manual §4 exercise) adds Y on every clock under the CLOCK part', () => {
    const b = new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .add('vcc', ComponentType.VCC)
      .add('gnd', ComponentType.GROUND)
      .switch('clr', ONE)
      .add('reg', ComponentType.N_REGISTER, { bits: 4 })
      .add('add', ComponentType.N_ADDER, { bits: 4 })
      .wire(p('clk', 'out'), p('reg', 'CLK'))
      .wire(p('vcc', 'out'), p('reg', 'Ld'))
      .wire(p('clr', 'out'), p('reg', 'CLR'))
      .wire(p('gnd', 'out'), p('add', 'Cin'))
    for (let i = 0; i < 4; i++) {
      b.switch(`y${i}`, bit((3 >> i) & 1)) // Y = 3
        .wire(p(`y${i}`, 'out'), p('add', `Y${i}`))
        .wire(p('reg', `Q${i}`), p('add', `X${i}`))
        .wire(p('add', `S${i}`), p('reg', `D${i}`))
    }
    const c = b.setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 100 }).build()
    c.step() // to 15: no edge yet
    c.step() // edge at 20 with CLR = 1 -> 0000
    expect(c.vec('reg', 'Q', 4)).toBe('0000')
    c.set('clr', ZERO)
    for (let k = 1; k <= 7; k++) {
      c.step()
      expect(c.vec('reg', 'Q', 4)).toBe(((3 * k) % 16).toString(2).padStart(4, '0'))
    }
  })
})

describe('combinational blocks from gates agree with the built-in parts', () => {
  it('4:1 mux from NOT/AND3/OR4 matches MUX_4 for all 64 input combinations', () => {
    const b = new CircuitBuilder()
      .switch('a', ZERO)
      .switch('bb', ZERO)
      .add('mux', ComponentType.MUX_4)
      .add('na', ComponentType.NOT)
      .add('nb', ComponentType.NOT)
      .add('or', ComponentType.OR4)
      .wire(p('a', 'out'), p('mux', 'A'))
      .wire(p('bb', 'out'), p('mux', 'B'))
      .wire(p('a', 'out'), p('na', 'in1'))
      .wire(p('bb', 'out'), p('nb', 'in1'))
    for (let i = 0; i < 4; i++) {
      b.switch(`i${i}`, ZERO)
        .wire(p(`i${i}`, 'out'), p('mux', `in${i}`))
        .add(`g${i}`, ComponentType.AND3)
        .wire(p(`i${i}`, 'out'), p(`g${i}`, 'in1'))
        .wire(i & 2 ? p('a', 'out') : p('na', 'out'), p(`g${i}`, 'in2'))
        .wire(i & 1 ? p('bb', 'out') : p('nb', 'out'), p(`g${i}`, 'in3'))
        .wire(p(`g${i}`, 'out'), p('or', `in${i + 1}`))
    }
    const c = b.build()
    for (const combo of allCombos(6)) {
      c.setMany({ a: combo[0], bb: combo[1], i0: combo[2], i1: combo[3], i2: combo[4], i3: combo[5] })
      const index = (combo[0] === ONE ? 2 : 0) + (combo[1] === ONE ? 1 : 0)
      expect(c.pin(p('or', 'out'))).toBe(combo[2 + index])
      expect(c.pin(p('mux', 'Z'))).toBe(combo[2 + index])
    }
  })

  it('2:4 decoder from NOT/AND2 matches DECODER_2TO4', () => {
    const b = new CircuitBuilder()
      .switch('a', ZERO)
      .switch('bb', ZERO)
      .add('dec', ComponentType.DECODER_2TO4)
      .add('na', ComponentType.NOT)
      .add('nb', ComponentType.NOT)
      .wire(p('a', 'out'), p('dec', 'A'))
      .wire(p('bb', 'out'), p('dec', 'B'))
      .wire(p('a', 'out'), p('na', 'in1'))
      .wire(p('bb', 'out'), p('nb', 'in1'))
    for (let i = 0; i < 4; i++) {
      b.add(`g${i}`, ComponentType.AND2)
        .wire(i & 2 ? p('a', 'out') : p('na', 'out'), p(`g${i}`, 'in1'))
        .wire(i & 1 ? p('bb', 'out') : p('nb', 'out'), p(`g${i}`, 'in2'))
    }
    const c = b.build()
    for (const [a, bv] of allCombos(2)) {
      c.setMany({ a, bb: bv })
      const index = (a === ONE ? 2 : 0) + (bv === ONE ? 1 : 0)
      for (let i = 0; i < 4; i++) {
        expect(c.pin(p(`g${i}`, 'out'))).toBe(bit(i === index ? 1 : 0))
        expect(c.pin(p('dec', `out${i}`))).toBe(bit(i === index ? 1 : 0))
      }
    }
  })

  it('4-bit parity from an XOR2 chain and majority-of-3 from AND/OR vs FULL_ADDER Cout', () => {
    const b = new CircuitBuilder()
      .add('x1', ComponentType.XOR2)
      .add('x2', ComponentType.XOR2)
      .add('x3', ComponentType.XOR2)
      .wire(p('x1', 'out'), p('x2', 'in1'))
      .wire(p('x2', 'out'), p('x3', 'in1'))
    for (let i = 0; i < 4; i++) b.switch(`b${i}`, ZERO)
    b.wire(p('b0', 'out'), p('x1', 'in1'))
      .wire(p('b1', 'out'), p('x1', 'in2'))
      .wire(p('b2', 'out'), p('x2', 'in2'))
      .wire(p('b3', 'out'), p('x3', 'in2'))
    // majority(b0, b1, b2) = b0b1 + b0b2 + b1b2
    b.add('m1', ComponentType.AND2)
      .add('m2', ComponentType.AND2)
      .add('m3', ComponentType.AND2)
      .add('mo', ComponentType.OR3)
      .add('fa', ComponentType.FULL_ADDER)
      .wire(p('b0', 'out'), p('m1', 'in1'))
      .wire(p('b1', 'out'), p('m1', 'in2'))
      .wire(p('b0', 'out'), p('m2', 'in1'))
      .wire(p('b2', 'out'), p('m2', 'in2'))
      .wire(p('b1', 'out'), p('m3', 'in1'))
      .wire(p('b2', 'out'), p('m3', 'in2'))
      .wire(p('m1', 'out'), p('mo', 'in1'))
      .wire(p('m2', 'out'), p('mo', 'in2'))
      .wire(p('m3', 'out'), p('mo', 'in3'))
      .wire(p('b0', 'out'), p('fa', 'X'))
      .wire(p('b1', 'out'), p('fa', 'Y'))
      .wire(p('b2', 'out'), p('fa', 'Cin'))
    const c = b.build()
    for (const combo of allCombos(4)) {
      c.setMany({ b0: combo[0], b1: combo[1], b2: combo[2], b3: combo[3] })
      const ones = combo.filter((v) => v === ONE).length
      expect(c.pin(p('x3', 'out'))).toBe(bit(ones % 2))
      const maj = bit(combo.slice(0, 3).filter((v) => v === ONE).length >= 2 ? 1 : 0)
      expect(c.pin(p('mo', 'out'))).toBe(maj)
      expect(c.pin(p('fa', 'Cout'))).toBe(maj)
    }
  })
})

describe('bus flows', () => {
  it('BUS_INPUT -> SPLITTER -> NOT gates -> MERGER -> BUS_PROBE inverts, and COMPLEMENTER agrees', () => {
    const b = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 8, label: 'A5' })
      .add('sp', ComponentType.SPLITTER, { bits: 8 })
      .add('mg', ComponentType.MERGER, { bits: 8 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 8 })
      .add('cp', ComponentType.COMPLEMENTER, { bits: 8 })
      .add('cbp', ComponentType.BUS_PROBE, { bits: 8 })
      .switch('en', ONE)
      .wire(p('bi', 'out'), p('sp', 'in'))
      .wire(p('mg', 'out'), p('bp', 'in'))
      .wire(p('bi', 'out'), p('cp', 'in'))
      .wire(p('cp', 'out'), p('cbp', 'in'))
      .wire(p('en', 'out'), p('cp', 'en'))
    for (let i = 0; i < 8; i++) {
      b.add(`n${i}`, ComponentType.NOT).wire(p('sp', `out${i}`), p(`n${i}`, 'in1')).wire(p(`n${i}`, 'out'), p('mg', `in${i}`))
    }
    const c = b.build()
    expect(c.bus(p('bp', 'in'))).toBe('5A')
    expect(c.bus(p('cbp', 'in'))).toBe('5A')
    c.set('en', ZERO)
    expect(c.bus(p('cbp', 'in'))).toBe('A5')
  })

  it.each([
    [9, 4],
    [4, 9],
    [15, 15],
    [0, 1],
    [8, 8],
    [7, 12]
  ])('two\'s complement subtractor: %i - %i through COMPLEMENTER + N_ADDER with Cin = 1', (xv, yv) => {
    const b = new CircuitBuilder()
      .add('bx', ComponentType.BUS_INPUT, { bits: 4, label: xv.toString(16) })
      .add('by', ComponentType.BUS_INPUT, { bits: 4, label: yv.toString(16) })
      .add('cp', ComponentType.COMPLEMENTER, { bits: 4 })
      .add('sx', ComponentType.SPLITTER, { bits: 4 })
      .add('sy', ComponentType.SPLITTER, { bits: 4 })
      .add('add', ComponentType.N_ADDER, { bits: 4 })
      .add('mg', ComponentType.MERGER, { bits: 4 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
      .add('vcc', ComponentType.VCC)
      .wire(p('bx', 'out'), p('sx', 'in'))
      .wire(p('by', 'out'), p('cp', 'in'))
      .wire(p('vcc', 'out'), p('cp', 'en'))
      .wire(p('cp', 'out'), p('sy', 'in'))
      .wire(p('vcc', 'out'), p('add', 'Cin'))
      .wire(p('mg', 'out'), p('bp', 'in'))
    for (let i = 0; i < 4; i++) {
      b.wire(p('sx', `out${i}`), p('add', `X${i}`))
        .wire(p('sy', `out${i}`), p('add', `Y${i}`))
        .wire(p('add', `S${i}`), p('mg', `in${i}`))
    }
    const c = b.build()
    expect(c.bus(p('bp', 'in'))).toBe(((xv - yv + 16) % 16).toString(16).toUpperCase())
    expect(c.pin(p('add', 'Cout'))).toBe(bit(xv >= yv ? 1 : 0)) // no borrow
  })

  it('two tristate buffers on one net: the enabled one drives it, both off is Z, a conflict is X', () => {
    const c = new CircuitBuilder()
      .switch('ia', ONE)
      .switch('ib', ZERO)
      .switch('ea', ONE)
      .switch('eb', ZERO)
      .add('ta', ComponentType.TRISTATE_RIGHT)
      .add('tb', ComponentType.TRISTATE_RIGHT)
      .probe('bus')
      .wire(p('ia', 'out'), p('ta', 'in'))
      .wire(p('ea', 'out'), p('ta', 'ctl'))
      .wire(p('ib', 'out'), p('tb', 'in'))
      .wire(p('eb', 'out'), p('tb', 'ctl'))
      .wire(p('ta', 'out'), p('bus', 'in'))
      .wire(p('tb', 'out'), p('bus', 'in'))
      .build()
    expect(c.pin(p('bus', 'in'))).toBe(ONE)
    c.setMany({ ea: ZERO, eb: ONE })
    expect(c.pin(p('bus', 'in'))).toBe(ZERO)
    c.set('eb', ZERO)
    expect(c.pin(p('bus', 'in'))).toBe(Z)
    c.setMany({ ea: ONE, eb: ONE })
    expect(c.pin(p('bus', 'in'))).toBe(X)
    c.set('ib', ONE)
    expect(c.pin(p('bus', 'in'))).toBe(ONE)
  })
})

describe('state machine and checker as a system', () => {
  const row = (timeNs: number, value: LogicValue): SignalRow => ({ timeNs, value })

  it("a '101' Mealy detector as a STATE_MACHINE driven by an INPUT_SIGNAL under the CLOCK part", () => {
    // Input bit k is applied 5 ns after the rising edge that ends slot k-1 (edges at 20, 40, ...).
    const bits = [1, 0, 1, 1, 0, 1, 0, 0]
    const rows = [row(0, ZERO), ...bits.map((v, k) => row(5 + 20 * k, bit(v)))]
    const c = new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .add('sig', ComponentType.INPUT_SIGNAL, { signal: rows })
      .add('sm', ComponentType.STATE_MACHINE, {
        smInputs: 1,
        smOutputs: 1,
        pinLabels: { in1: 'A', out1: 'Det' },
        smTable: [
          { present: '0', input: 'A', output: '0', next: '1' },
          { present: '0', input: "A'", output: '0', next: '0' },
          { present: '1', input: "A'", output: '0', next: '2' },
          { present: '1', input: 'A', output: '0', next: '1' },
          { present: '2', input: 'A', output: 'Det', next: '1' },
          { present: '2', input: "A'", output: '0', next: '0' }
        ]
      })
      .probe('det')
      .wire(p('clk', 'out'), p('sm', 'CLK'))
      .wire(p('sig', 'out'), p('sm', 'in1'))
      .wire(p('sm', 'out1'), p('det', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 200 })
      .build()
    c.go()
    expect(c.time).toBe(195)
    // Det is a Mealy output: high while state = 2 and A = 1 (one part delay after each cause).
    expect(trace(c, 'det')).toEqual([
      [0, ZERO],
      [46, ONE],
      [61, ZERO],
      [106, ONE],
      [121, ZERO]
    ])
    expect(c.sim.getSmDisplays()[p('sm', 'state')]).toBe('0')
  })

  function checkerCircuit(chk: { input: string; output: string }, throughFlipFlop: boolean): Circuit {
    const b = new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .add('chk', ComponentType.CHECKER, { chk })
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 200 })
    if (throughFlipFlop) {
      b.add('vcc', ComponentType.VCC)
      addDff(b, 'ff').wire(p('clk', 'out'), p('ff', 'CLK')).wire(p('chk', 'out'), p('ff', 'D')).wire(p('ff', 'Q'), p('chk', 'in'))
    } else {
      b.wire(p('chk', 'out'), p('chk', 'in'))
    }
    return b.build()
  }

  it('a checker expecting a one-slot delay passes a D flip-flop and fails a plain wire', () => {
    const chk = { input: '0110100', output: 'X011010' }
    const ff = checkerCircuit(chk, true)
    ff.go()
    expect(ff.sim.getCheckerResult()).toEqual({ total: 6, sampled: 6, failures: 0 })
    expect(ff.sim.getSmDisplays()[p('chk', 'result')]).toBe('PASS')

    const wire = checkerCircuit(chk, false)
    wire.go()
    expect(wire.sim.getCheckerResult()).toEqual({ total: 6, sampled: 6, failures: 4 })
    expect(wire.sim.getSmDisplays()[p('chk', 'result')]).toBe('FAIL')
  })
})

describe('timing', () => {
  function glitchCircuit(andDelay: number): Circuit {
    return new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .add('n', ComponentType.NOT, { delay: 1 })
      .add('g', ComponentType.AND2, { delay: andDelay })
      .probe('y')
      .wire(p('clk', 'out'), p('n', 'in1'))
      .wire(p('clk', 'out'), p('g', 'in1'))
      .wire(p('n', 'out'), p('g', 'in2'))
      .wire(p('g', 'out'), p('y', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 100 })
      .build()
  }

  it('AND(CLK, NOT CLK) with equal delays glitches for 1 ns after every rising edge', () => {
    const c = glitchCircuit(1)
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

  it('AND(CLK, NOT CLK) with a slower AND swallows the pulse (inertial delay)', () => {
    const c = glitchCircuit(2)
    c.go()
    expect(trace(c, 'y')).toEqual([[0, ZERO]])
  })

  it('delays accumulate along a chain and the final value is the steady-state function', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .add('n1', ComponentType.NOT, { delay: 2 })
      .add('n2', ComponentType.NOT, { delay: 3 })
      .add('g', ComponentType.AND2, { delay: 4 })
      .probe('y')
      .wire(p('a', 'out'), p('n1', 'in1'))
      .wire(p('n1', 'out'), p('n2', 'in1'))
      .wire(p('n2', 'out'), p('g', 'in1'))
      .wire(p('a', 'out'), p('g', 'in2'))
      .wire(p('g', 'out'), p('y', 'in'))
      .build()
    c.set('a', ONE)
    // switch 1 + NOT 2 + NOT 3 + AND 4 = 10 ns; the AND saw (1, 1) at t = 1 and (1, 0)... no:
    // a rises at 1 (AND in2 = 1, in1 = old 0 -> stays 0); n2 falls... n1 falls at 3, n2 rises at 6,
    // AND(1, 1) -> 1 at 10.
    expect(c.pin(p('y', 'in'))).toBe(ONE)
    expect(c.time).toBe(10)
    expect(trace(c, 'y')).toEqual([
      [0, ZERO],
      [10, ONE]
    ])
  })
})
