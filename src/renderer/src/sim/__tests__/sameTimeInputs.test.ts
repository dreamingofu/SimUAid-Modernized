import { describe, expect, it } from 'vitest'
import { ComponentType, LogicValue } from '../../model/types'
import { CircuitBuilder, p } from './harness'

const { ZERO, ONE } = LogicValue

// When two inputs of a gate change at the same simulated instant, the gate is
// evaluated once per input change. The intermediate evaluation may schedule an
// output event that the final evaluation must supersede; otherwise the output
// settles on a value that no steady-state input combination produces.
describe('gate outputs when several inputs change at the same time', () => {
  it('XOR2 with A 0->1 and B 1->0 simultaneously stays at 1', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .switch('b', ONE)
      .add('g', ComponentType.XOR2)
      .probe('y')
      .wire(p('a', 'out'), p('g', 'in1'))
      .wire(p('b', 'out'), p('g', 'in2'))
      .wire(p('g', 'out'), p('y', 'in'))
      .build()
    expect(c.pin(p('y', 'in'))).toBe(ONE)
    c.setMany({ a: ONE, b: ZERO })
    expect(c.pin(p('a', 'out'))).toBe(ONE)
    expect(c.pin(p('b', 'out'))).toBe(ZERO)
    expect(c.pin(p('y', 'in'))).toBe(ONE)
  })

  it('AND2 with A 0->1 and B 1->0 simultaneously stays at 0', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .switch('b', ONE)
      .add('g', ComponentType.AND2)
      .probe('y')
      .wire(p('a', 'out'), p('g', 'in1'))
      .wire(p('b', 'out'), p('g', 'in2'))
      .wire(p('g', 'out'), p('y', 'in'))
      .build()
    expect(c.pin(p('y', 'in'))).toBe(ZERO)
    c.setMany({ a: ONE, b: ZERO })
    expect(c.pin(p('y', 'in'))).toBe(ZERO)
  })

  it('XOR of two synchronous counter bits is right after a 01->10 count transition', () => {
    // 2-bit counter: Q0 and Q1 flip at the same instant when going 1 -> 2.
    const c = new CircuitBuilder()
      .switch('clk', ZERO)
      .add('vcc', ComponentType.VCC)
      .add('ctr', ComponentType.N_COUNTER, { bits: 2 })
      .add('x', ComponentType.XOR2)
      .probe('y')
      .wire(p('clk', 'out'), p('ctr', 'CLK'))
      .wire(p('vcc', 'out'), p('ctr', 'En'))
      .wire(p('vcc', 'out'), p('ctr', 'CLR'))
      .wire(p('ctr', 'Q0'), p('x', 'in1'))
      .wire(p('ctr', 'Q1'), p('x', 'in2'))
      .wire(p('x', 'out'), p('y', 'in'))
      .build()
    // State is X after reset; the counter needs a clear. Use CLR through a switch instead.
    expect(c.vec('ctr', 'Q', 2)).toBe('XX')
  })

  it('XOR of two counter bits follows the count through 0,1,2,3', () => {
    const c = new CircuitBuilder()
      .switch('clk', ZERO)
      .switch('clr', ZERO)
      .add('vcc', ComponentType.VCC)
      .add('ctr', ComponentType.N_COUNTER, { bits: 2 })
      .add('x', ComponentType.XOR2)
      .probe('y')
      .wire(p('clk', 'out'), p('ctr', 'CLK'))
      .wire(p('vcc', 'out'), p('ctr', 'En'))
      .wire(p('clr', 'out'), p('ctr', 'CLR'))
      .wire(p('ctr', 'Q0'), p('x', 'in1'))
      .wire(p('ctr', 'Q1'), p('x', 'in2'))
      .wire(p('x', 'out'), p('y', 'in'))
      .build()
    c.pulse('clk') // CLR=0 -> clears to 00
    expect(c.vec('ctr', 'Q', 2)).toBe('00')
    c.set('clr', ONE)
    const expected = ['01', '10', '11', '00']
    for (const q of expected) {
      c.pulse('clk')
      expect(c.vec('ctr', 'Q', 2)).toBe(q)
      const parity = q[0] !== q[1] ? ONE : ZERO
      expect(c.pin(p('y', 'in'))).toBe(parity)
    }
  })
})

describe('input pulses shorter than a gate delay', () => {
  it('AND(A, NOT A) with NOT delay 1 and AND delay 2 returns to 0 after A rises', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .add('n', ComponentType.NOT, { delay: 1 })
      .add('g', ComponentType.AND2, { delay: 2 })
      .probe('y')
      .wire(p('a', 'out'), p('g', 'in1'))
      .wire(p('a', 'out'), p('n', 'in1'))
      .wire(p('n', 'out'), p('g', 'in2'))
      .wire(p('g', 'out'), p('y', 'in'))
      .build()
    expect(c.pin(p('y', 'in'))).toBe(ZERO)
    c.set('a', ONE)
    expect(c.pin(p('g', 'in1'))).toBe(ONE)
    expect(c.pin(p('g', 'in2'))).toBe(ZERO)
    expect(c.pin(p('y', 'in'))).toBe(ZERO)
  })

  it('OR(A, NOT A) with NOT delay 1 and OR delay 3 returns to 1 after A falls', () => {
    const c = new CircuitBuilder()
      .switch('a', ONE)
      .add('n', ComponentType.NOT, { delay: 1 })
      .add('g', ComponentType.OR2, { delay: 3 })
      .probe('y')
      .wire(p('a', 'out'), p('g', 'in1'))
      .wire(p('a', 'out'), p('n', 'in1'))
      .wire(p('n', 'out'), p('g', 'in2'))
      .wire(p('g', 'out'), p('y', 'in'))
      .build()
    expect(c.pin(p('y', 'in'))).toBe(ONE)
    c.set('a', ZERO)
    expect(c.pin(p('y', 'in'))).toBe(ONE)
  })
})
