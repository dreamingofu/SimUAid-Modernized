import { describe, expect, it } from 'vitest'
import { ComponentType, LogicValue } from '../model/types'
import { CircuitBuilder } from '../sim/__tests__/harness'
import { generateVhdl, validateForVhdl } from './export'

const { ZERO } = LogicValue

describe('structural VHDL export', () => {
  it('connects an input to every probe sharing its net', () => {
    const b = new CircuitBuilder()
      .switch('sw', ZERO, { label: 'A' })
      .probe('p1', { label: 'Y' })
      .probe('p2', { label: 'Z' })
      .connect('sw#out', 'p1#in', 'p2#in')
    const { entity } = generateVhdl(b.netlist, 'circuit', 'synth')
    const drive = entity.match(/(net_\d+) <= A;/)
    expect(drive).not.toBeNull()
    expect(entity).toContain(`Y <= ${drive![1]};`)
    expect(entity).toContain(`Z <= ${drive![1]};`)
  })

  it('keeps both drivers when two input ports share a resolved net', () => {
    const b = new CircuitBuilder()
      .switch('a', ZERO, { label: 'A' })
      .switch('b', ZERO, { label: 'B' })
      .probe('p', { label: 'Y' })
      .connect('a#out', 'b#out', 'p#in')
    const { entity } = generateVhdl(b.netlist, 'circuit', 'synth')
    const drive = entity.match(/(net_\d+) <= A;/)
    expect(drive).not.toBeNull()
    expect(entity).toContain(`${drive![1]} <= B;`)
    expect(entity).toContain(`Y <= ${drive![1]};`)
  })

  it('uses legal names for built-in NOT components and in/out pins', () => {
    const b = new CircuitBuilder().add('not', ComponentType.NOT)
    const files = generateVhdl(b.netlist, 'circuit', 'synth')
    expect(files.entity).toContain('part_not port map (pin_in1 =>')
    expect(files.entity).toContain('pin_out =>')
    expect(files.packages[0].contents).toContain('component part_not')
    expect(files.packages[0].contents).toContain('pin_in1 : in std_logic')
  })

  it('maps constants to actual drivers instead of unimplemented components', () => {
    const b = new CircuitBuilder()
      .add('vcc', ComponentType.VCC)
      .add('gnd', ComponentType.GROUND)
      .probe('p', { label: 'Y' })
      .wire('vcc#out', 'p#in')
    const { entity, packages } = generateVhdl(b.netlist, 'circuit', 'sim')
    expect(entity).toMatch(/net_\d+ <= '1';/)
    expect(entity).toMatch(/net_\d+ <= '0';/)
    expect(packages[0].contents).not.toContain('component part_vcc')
  })

  it('exports clock as an explicit input port', () => {
    const b = new CircuitBuilder().add('clk', ComponentType.CLOCK, { label: 'clk' })
    const { entity } = generateVhdl(b.netlist, 'circuit', 'sim')
    expect(entity).toContain('clk : in std_logic')
    expect(entity).toMatch(/net_\d+ <= clk;/)
  })

  it('avoids generated signal/instance names colliding with user labels', () => {
    const b = new CircuitBuilder()
      .switch('sw', ZERO, { label: 'net_0' })
      .add('a', ComponentType.NOT, { label: 'u0' })
      .add('b', ComponentType.NOT)
    const { entity } = generateVhdl(b.netlist, 'circuit', 'synth')
    expect(entity).not.toContain('signal net_0 :')
    expect(entity.match(/\bu0:/g)).toHaveLength(1)
  })

  it.each(['signal', 'Out', 'A_', 'A__B'])('rejects invalid label %s', (label) => {
    const b = new CircuitBuilder().switch('sw', ZERO, { label })
    expect(validateForVhdl(b.netlist)).not.toEqual([])
  })

  it('detects collisions with expanded seven-segment port names', () => {
    const b = new CircuitBuilder()
      .add('seg', ComponentType.SEVEN_SEGMENT, { label: 'Display' })
      .probe('p', { label: 'display_1' })
    expect(validateForVhdl(b.netlist).join('\n')).toContain('conflict')
  })

  it('detects duplicate device labels case-insensitively', () => {
    const b = new CircuitBuilder()
      .add('a', ComponentType.NOT, { label: 'Gate1' })
      .add('b', ComponentType.NOT, { label: 'gate1' })
    expect(validateForVhdl(b.netlist).join('\n')).toContain('conflict')
  })

  it.each([ComponentType.N_ADDER, ComponentType.BUS_INPUT, ComponentType.STATE_MACHINE, ComponentType.CHECKER])(
    'rejects %s whose configuration cannot be represented by the structural template',
    (type) => {
      const b = new CircuitBuilder().add('part', type)
      expect(validateForVhdl(b.netlist).join('\n')).toContain('not supported')
      expect(() => generateVhdl(b.netlist, 'circuit', 'synth')).toThrow()
    }
  )

  it('rejects invalid entity names even when called without the dialog', () => {
    const b = new CircuitBuilder()
    expect(() => generateVhdl(b.netlist, 'architecture', 'synth')).toThrow()
    expect(() => generateVhdl(b.netlist, '../circuit', 'synth')).toThrow()
    expect(() => generateVhdl(b.netlist, 'SimUAid_Synthesis_Package', 'synth')).toThrow()
  })

  it('rejects labels that would hide VHDL types used by generated declarations', () => {
    const b = new CircuitBuilder().switch('sw', ZERO, { label: 'std_logic' })
    expect(validateForVhdl(b.netlist).join('\n')).toContain('conflict')
  })

  it('marks component declarations as requiring external implementations', () => {
    const b = new CircuitBuilder().add('gate', ComponentType.AND2)
    const files = generateVhdl(b.netlist, 'circuit', 'sim')
    expect(files.entity).toContain('External component implementations are required')
    expect(files.packages[0].contents).toContain('declarations only')
    expect(files.entity).toContain('generic map (tpd => 1 ns)')
  })
})
