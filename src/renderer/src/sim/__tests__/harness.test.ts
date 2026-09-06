import { describe, expect, it } from 'vitest'
import { ComponentType, LogicValue } from '../../model/types'
import { CircuitBuilder, p } from './harness'

const { ZERO, ONE, X, Z } = LogicValue

describe('harness smoke test', () => {
  it('wires a switch through an AND2 to a probe', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .switch('b', ZERO)
      .add('g', ComponentType.AND2)
      .probe('y')
      .wire(p('a', 'out'), p('g', 'in1'))
      .wire(p('b', 'out'), p('g', 'in2'))
      .wire(p('g', 'out'), p('y', 'in'))
      .build()

    expect(c.pin(p('y', 'in'))).toBe(ZERO)
    c.set('a', ONE)
    expect(c.pin(p('y', 'in'))).toBe(ZERO)
    c.set('b', ONE)
    expect(c.pin(p('y', 'in'))).toBe(ONE)
  })

  it('connects pins virtually through labels', () => {
    const c = new CircuitBuilder()
      .switch('a', ONE)
      .add('n', ComponentType.NOT)
      .label(p('a', 'out'), 'sig')
      .label(p('n', 'in1'), 'sig')
      .build()
    expect(c.pin(p('n', 'out'))).toBe(ZERO)
  })

  it('reports Z on unconnected inputs and X on gate outputs fed by Z', () => {
    const c = new CircuitBuilder().add('g', ComponentType.AND2).build()
    expect(c.pin(p('g', 'in1'))).toBe(Z)
    expect(c.pin(p('g', 'out'))).toBe(X)
  })
})
