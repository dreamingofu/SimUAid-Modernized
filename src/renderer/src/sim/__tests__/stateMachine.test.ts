// Unit verification of the STATE_MACHINE part: the pure table-parsing functions
// in sim/stateMachine.ts and the part's behaviour inside the Simulator.
//
// Spec (SimUaid manual): user guide "Using State Machines" / "Example of Using a
// State Machine" (multiplier control, Table 1) and reference manual §1.4.5.
//  - Mealy machine: outputs follow the active row immediately (no clock).
//  - The state changes ONLY on the rising edge of CLK, to the active row's next state.
//  - Input cell: pin labels ANDed; prime = complement; labels may be separated by a
//    space or a prime ("K M'" or "K'M'"); "-" = don't care for all inputs.
//  - Output cell: labels that are 1, separated by spaces; "0" = all outputs 0.
//  - Empty rows are ignored; a partially empty row is a syntax error.
//  - Rows are matched in order.

import { describe, expect, it } from 'vitest'
import {
  ComponentType,
  LogicValue,
  type Component,
  type SignalRow,
  type SimulationOptions,
  type SmRow
} from '../../model/types'
import { defOf } from '../../model/partDefinitions'
import {
  checkCell,
  compileTable,
  parseInputExpr,
  parseOutputs,
  smLabelMaps,
  termsMatch,
  type SmTerm
} from '../stateMachine'
import { CircuitBuilder, p, type Circuit } from './harness'

const { ZERO, ONE, X, Z } = LogicValue

// ---------------------------------------------------------------------------
// Local helpers (the shared harness has no state-machine specific support).
// ---------------------------------------------------------------------------

function row(present: string, input: string, output: string, next: string): SmRow {
  return { present, input, output, next }
}

const EMPTY_ROW: SmRow = row('', '', '', '')

/** A bare STATE_MACHINE Component for the pure-function tests. */
function smComponent(opts: {
  inputs: string[]
  outputs: string[]
  table?: SmRow[]
  smInputs?: number | null
  smOutputs?: number | null
}): Component {
  const pinLabels: Record<string, string> = {}
  opts.inputs.forEach((l, i) => {
    if (l) pinLabels[`in${i + 1}`] = l
  })
  opts.outputs.forEach((l, i) => {
    if (l) pinLabels[`out${i + 1}`] = l
  })
  const comp: Component = {
    id: 'sm',
    type: ComponentType.STATE_MACHINE,
    x: 0,
    y: 0,
    rotation: 0,
    label: '',
    pinLabels,
    delay: 1,
    smInputs: opts.inputs.length,
    smOutputs: opts.outputs.length,
    smTable: opts.table
  }
  if (opts.smInputs === null) delete comp.smInputs
  else if (opts.smInputs !== undefined) comp.smInputs = opts.smInputs
  if (opts.smOutputs === null) delete comp.smOutputs
  else if (opts.smOutputs !== undefined) comp.smOutputs = opts.smOutputs
  return comp
}

function term(pinName: string, negated = false): SmTerm {
  return { pinName, negated }
}

/** readPin stub for termsMatch. */
function pins(values: Record<string, LogicValue>): (pinName: string) => LogicValue {
  return (name) => values[name] ?? Z
}

// The manual's multiplier control example (Table 1) with S0..S3 written as 0..3.
const MULT_INPUTS = ['St', 'K', 'M']
const MULT_OUTPUTS = ['Load', 'Sh', 'Ad', 'Done']
const MULT_TABLE: SmRow[] = [
  row('0', 'St', 'Load', '1'), // 0
  row('0', "St'", '0', '0'), // 1
  row('1', "K M'", 'Sh', '3'), // 2
  row('1', "K'M'", 'Sh', '1'), // 3
  row('1', 'M', 'Ad', '2'), // 4
  row('2', "K'", 'Sh', '1'), // 5
  row('2', 'K', 'Sh', '3'), // 6
  row('3', '-', 'Done', '0') // 7
]

interface SmSpec {
  inputs: string[]
  outputs: string[]
  table: SmRow[]
  /** Inputs left floating (Z) instead of getting a switch. */
  floating?: string[]
  /**
   * Inputs fed through a 2-input gate whose second input is floating so the
   * switch can produce X: 'and' => switch 0 -> 0, switch 1 -> X;
   * 'or' => switch 1 -> 1, switch 0 -> X.
   */
  xSource?: Record<string, 'and' | 'or'>
  /** INPUT_SIGNAL waveforms keyed by input label (replaces the switch). */
  signals?: Record<string, SignalRow[]>
  /** Initial switch positions (default ZERO for every switch, including 'clk'). */
  initial?: Record<string, LogicValue>
  /** 'switch' (default): a switch named 'clk' on CLK; 'clock': the CLOCK part; 'none': CLK floating. */
  clk?: 'switch' | 'clock' | 'none'
  /** Simulation options (period, limit, clock initial value). */
  sim?: Partial<SimulationOptions>
  /** Propagation delay of the state machine part (default 1 ns). */
  delay?: number
}

/** State machine 'sm' with a switch per input (ids = input labels), a probe per output. */
class SmCircuit {
  readonly c: Circuit

  constructor(private spec: SmSpec) {
    const b = new CircuitBuilder()
    const pinLabels: Record<string, string> = {}
    spec.inputs.forEach((l, i) => {
      if (l) pinLabels[`in${i + 1}`] = l
    })
    spec.outputs.forEach((l, i) => {
      if (l) pinLabels[`out${i + 1}`] = l
    })
    if (spec.sim) b.setSimulation(spec.sim)
    b.add('sm', ComponentType.STATE_MACHINE, {
      smInputs: spec.inputs.length,
      smOutputs: spec.outputs.length,
      smTable: spec.table,
      pinLabels,
      ...(spec.delay !== undefined ? { delay: spec.delay } : {})
    })

    const clk = spec.clk ?? 'switch'
    if (clk === 'switch') {
      b.switch('clk', spec.initial?.clk ?? ZERO)
      b.wire(p('clk', 'out'), p('sm', 'CLK'))
    } else if (clk === 'clock') {
      b.add('clock', ComponentType.CLOCK)
      b.wire(p('clock', 'out'), p('sm', 'CLK'))
    }

    spec.inputs.forEach((label, i) => {
      const pin = p('sm', `in${i + 1}`)
      if (spec.floating?.includes(label)) return
      if (spec.signals?.[label]) {
        b.add(`sig_${label}`, ComponentType.INPUT_SIGNAL, { signal: spec.signals[label] })
        b.wire(p(`sig_${label}`, 'out'), pin)
        return
      }
      b.switch(label, spec.initial?.[label] ?? ZERO)
      const kind = spec.xSource?.[label]
      if (kind) {
        const gateId = `x_${label}`
        b.add(gateId, kind === 'and' ? ComponentType.AND2 : ComponentType.OR2)
        b.wire(p(label, 'out'), p(gateId, 'in1'))
        b.wire(p(gateId, 'out'), pin)
      } else {
        b.wire(p(label, 'out'), pin)
      }
    })

    spec.outputs.forEach((label, i) => {
      b.probe(`P_${label}`)
      b.wire(p('sm', `out${i + 1}`), p(`P_${label}`, 'in'))
    })

    this.c = b.build()
  }

  /** Value seen by the probe on an output. */
  out(label: string): LogicValue {
    return this.c.pin(p(`P_${label}`, 'in'))
  }

  /** All outputs as {label: value}. */
  outs(): Record<string, LogicValue> {
    const r: Record<string, LogicValue> = {}
    for (const l of this.spec.outputs) r[l] = this.out(l)
    return r
  }

  /** Expected output record with only the listed labels at 1. */
  only(...high: string[]): Record<string, LogicValue> {
    const r: Record<string, LogicValue> = {}
    for (const l of this.spec.outputs) r[l] = high.includes(l) ? ONE : ZERO
    return r
  }

  all(v: LogicValue): Record<string, LogicValue> {
    const r: Record<string, LogicValue> = {}
    for (const l of this.spec.outputs) r[l] = v
    return r
  }

  /** The state-number display of the part. */
  get state(): string {
    return this.c.sim.getSmDisplays()[p('sm', 'state')]
  }

  /** Index (into the raw table) of the active row, or null. */
  get active(): number | null {
    return this.c.sim.getSmActive()['sm'] ?? null
  }

  set(label: string, v: LogicValue): this {
    this.c.set(label, v)
    return this
  }

  setMany(values: Record<string, LogicValue>): this {
    this.c.setMany(values)
    return this
  }

  /** One manual clock pulse on the 'clk' switch (0 -> 1 -> 0). */
  clock(): this {
    this.c.pulse('clk')
    return this
  }

  rise(): this {
    this.c.rise('clk')
    return this
  }

  fall(): this {
    this.c.fall('clk')
    return this
  }
}

function multiplier(extra: Partial<SmSpec> = {}): SmCircuit {
  return new SmCircuit({ inputs: MULT_INPUTS, outputs: MULT_OUTPUTS, table: MULT_TABLE, ...extra })
}

const MULT_LABELS = new Map([
  ['St', 'in1'],
  ['K', 'in2'],
  ['M', 'in3']
])
const MULT_OUT_LABELS = new Map([
  ['Load', 'out1'],
  ['Sh', 'out2'],
  ['Ad', 'out3'],
  ['Done', 'out4']
])

// ===========================================================================
// parseInputExpr
// ===========================================================================

describe('parseInputExpr', () => {
  it.each<[string, SmTerm[]]>([
    ['St', [term('in1')]],
    ["St'", [term('in1', true)]],
    ['K', [term('in2')]],
    ["K M'", [term('in2'), term('in3', true)]],
    ["K'M'", [term('in2', true), term('in3', true)]],
    ["K'M", [term('in2', true), term('in3')]],
    ["KM'", [term('in2'), term('in3', true)]],
    ['KM', [term('in2'), term('in3')]],
    ["K' M'", [term('in2', true), term('in3', true)]],
    ['St K M', [term('in1'), term('in2'), term('in3')]],
    ["St'K'M'", [term('in1', true), term('in2', true), term('in3', true)]],
    ['M K', [term('in3'), term('in2')]]
  ])('parses %j to the expected AND terms (pin names, not labels)', (expr, expected) => {
    expect(parseInputExpr(expr, MULT_LABELS)).toEqual(expected)
  })

  it('ignores leading and trailing whitespace', () => {
    expect(parseInputExpr("  K M'  ", MULT_LABELS)).toEqual([term('in2'), term('in3', true)])
  })

  it('accepts multiple spaces and tabs between labels', () => {
    expect(parseInputExpr("K \t  M'", MULT_LABELS)).toEqual([term('in2'), term('in3', true)])
  })

  it('returns null (don’t care) for "-"', () => {
    expect(parseInputExpr('-', MULT_LABELS)).toBeNull()
  })

  it('returns null for "-" surrounded by whitespace', () => {
    expect(parseInputExpr('  -  ', MULT_LABELS)).toBeNull()
  })

  it('accepts "-" even when the machine has no labeled inputs', () => {
    expect(parseInputExpr('-', new Map())).toBeNull()
  })

  it('reports an error (string) for an empty cell', () => {
    expect(typeof parseInputExpr('', MULT_LABELS)).toBe('string')
  })

  it('reports an error for a whitespace-only cell', () => {
    expect(typeof parseInputExpr('   ', MULT_LABELS)).toBe('string')
  })

  it('reports an error naming the unknown label', () => {
    const r = parseInputExpr('Q', MULT_LABELS)
    expect(typeof r).toBe('string')
    expect(r as string).toContain('Q')
  })

  it('reports an error for an unknown label following a valid one', () => {
    expect(typeof parseInputExpr('K Q', MULT_LABELS)).toBe('string')
  })

  it('reports an error for an unknown label concatenated to a valid one', () => {
    expect(typeof parseInputExpr("K'Q", MULT_LABELS)).toBe('string')
  })

  it('reports an error for a bare prime', () => {
    expect(typeof parseInputExpr("'", MULT_LABELS)).toBe('string')
  })

  it('reports an error for a leading prime', () => {
    expect(typeof parseInputExpr("'K", MULT_LABELS)).toBe('string')
  })

  it('reports an error for a double prime', () => {
    expect(typeof parseInputExpr("K''", MULT_LABELS)).toBe('string')
  })

  it('reports an error when "-" is mixed with labels (dash means all inputs don’t care)', () => {
    expect(typeof parseInputExpr('K -', MULT_LABELS)).toBe('string')
  })

  it('reports an error for any label when the machine has no labeled inputs', () => {
    expect(typeof parseInputExpr('K', new Map())).toBe('string')
  })

  describe('greedy longest-label matching', () => {
    const labels = new Map([
      ['A', 'in1'],
      ['AB', 'in2'],
      ['B', 'in3']
    ])

    it.each<[string, SmTerm[]]>([
      ['AB', [term('in2')]],
      ["AB'", [term('in2', true)]],
      ['A B', [term('in1'), term('in3')]],
      ["A'B", [term('in1', true), term('in3')]],
      ['BA', [term('in3'), term('in1')]],
      ['ABA', [term('in2'), term('in1')]],
      ['ABB', [term('in2'), term('in3')]],
      ["A'AB", [term('in1', true), term('in2')]],
      ['B AB A', [term('in3'), term('in2'), term('in1')]]
    ])('parses %j preferring the longest label at each position', (expr, expected) => {
      expect(parseInputExpr(expr, labels)).toEqual(expected)
    })

    it('does not depend on map insertion order', () => {
      const reversed = new Map([
        ['B', 'in3'],
        ['AB', 'in2'],
        ['A', 'in1']
      ])
      expect(parseInputExpr('AB', reversed)).toEqual([term('in2')])
      expect(parseInputExpr('ABA', reversed)).toEqual([term('in2'), term('in1')])
    })

    it('handles labels with digits (X1, X2, X12)', () => {
      const l = new Map([
        ['X1', 'in1'],
        ['X2', 'in2'],
        ['X12', 'in3']
      ])
      expect(parseInputExpr("X1X2'", l)).toEqual([term('in1'), term('in2', true)])
      expect(parseInputExpr('X12', l)).toEqual([term('in3')])
      expect(parseInputExpr("X12'X1", l)).toEqual([term('in3', true), term('in1')])
    })

    it('a label that is a prefix of another followed by a prime still parses (S vs St)', () => {
      const l = new Map([
        ['S', 'in1'],
        ['St', 'in2']
      ])
      expect(parseInputExpr("S'St", l)).toEqual([term('in1', true), term('in2')])
      expect(parseInputExpr("St'S", l)).toEqual([term('in2', true), term('in1')])
      expect(parseInputExpr('S St', l)).toEqual([term('in1'), term('in2')])
    })
  })

  it('parses the eight literals of a maximum-size machine written with primes as separators', () => {
    const l = new Map(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((lab, i) => [lab, `in${i + 1}`] as [string, string]))
    expect(parseInputExpr("A'B'C'D'E'F'G'H'", l)).toEqual(
      ['in1', 'in2', 'in3', 'in4', 'in5', 'in6', 'in7', 'in8'].map((pin) => term(pin, true))
    )
  })

  it('the same literal may appear twice (A A is just A)', () => {
    expect(parseInputExpr('K K', MULT_LABELS)).toEqual([term('in2'), term('in2')])
  })
})

// ===========================================================================
// parseOutputs
// ===========================================================================

describe('parseOutputs', () => {
  it.each<[string, string[]]>([
    ['Load', ['out1']],
    ['Sh', ['out2']],
    ['Sh Ad', ['out2', 'out3']],
    ['Load Sh Ad Done', ['out1', 'out2', 'out3', 'out4']],
    ['Done Load', ['out4', 'out1']],
    ['  Load   Done  ', ['out1', 'out4']],
    ['Load\tDone', ['out1', 'out4']]
  ])('parses %j to the pin names driven high', (expr, expected) => {
    expect(parseOutputs(expr, MULT_OUT_LABELS)).toEqual(expected)
  })

  it('"0" means all outputs zero (empty high list)', () => {
    expect(parseOutputs('0', MULT_OUT_LABELS)).toEqual([])
  })

  it('"0" with surrounding whitespace is still all-zero', () => {
    expect(parseOutputs(' 0 ', MULT_OUT_LABELS)).toEqual([])
  })

  it('reports an error for an empty cell', () => {
    expect(typeof parseOutputs('', MULT_OUT_LABELS)).toBe('string')
  })

  it('reports an error for a whitespace-only cell', () => {
    expect(typeof parseOutputs('  ', MULT_OUT_LABELS)).toBe('string')
  })

  it('reports an error naming an unknown label', () => {
    const r = parseOutputs('Foo', MULT_OUT_LABELS)
    expect(typeof r).toBe('string')
    expect(r as string).toContain('Foo')
  })

  it('reports an error for an unknown label among valid ones', () => {
    expect(typeof parseOutputs('Load Foo', MULT_OUT_LABELS)).toBe('string')
  })

  it('requires spaces between output labels (concatenation is an error)', () => {
    expect(typeof parseOutputs('LoadSh', MULT_OUT_LABELS)).toBe('string')
  })

  it('rejects an input label used in the output column', () => {
    expect(typeof parseOutputs('St', MULT_OUT_LABELS)).toBe('string')
  })

  it('rejects "0" mixed with labels', () => {
    expect(typeof parseOutputs('0 Load', MULT_OUT_LABELS)).toBe('string')
  })

  it('rejects a primed output label', () => {
    expect(typeof parseOutputs("Load'", MULT_OUT_LABELS)).toBe('string')
  })
})

// ===========================================================================
// parseState (not exported; exercised through checkCell)
// ===========================================================================

describe('parseState (through checkCell)', () => {
  const comp = smComponent({ inputs: MULT_INPUTS, outputs: MULT_OUTPUTS })

  it.each(['0', '1', '3', '7', '15', ' 2 '])('accepts the non-negative integer %j', (s) => {
    expect(checkCell(comp, row(s, 'St', 'Load', s), 'present')).toBeNull()
    expect(checkCell(comp, row(s, 'St', 'Load', s), 'next')).toBeNull()
  })

  it.each(['S0', '-1', '1.5', 'abc', '1 2', '+1', 'one'])('rejects %j as a state', (s) => {
    expect(typeof checkCell(comp, row(s, 'St', 'Load', '0'), 'present')).toBe('string')
    expect(typeof checkCell(comp, row('0', 'St', 'Load', s), 'next')).toBe('string')
  })

  it('rejects an empty present state in an otherwise filled row', () => {
    expect(typeof checkCell(comp, row('', 'St', 'Load', '1'), 'present')).toBe('string')
  })

  it('rejects an empty next state in an otherwise filled row', () => {
    expect(typeof checkCell(comp, row('0', 'St', 'Load', ''), 'next')).toBe('string')
  })
})

// ===========================================================================
// checkCell
// ===========================================================================

describe('checkCell', () => {
  const comp = smComponent({ inputs: MULT_INPUTS, outputs: MULT_OUTPUTS })

  it.each<keyof SmRow>(['present', 'input', 'output', 'next'])(
    'returns null for the %s cell of a completely empty row (empty rows are ignored)',
    (col) => {
      expect(checkCell(comp, EMPTY_ROW, col)).toBeNull()
    }
  )

  it.each<keyof SmRow>(['present', 'input', 'output', 'next'])(
    'returns null for the %s cell of a whitespace-only row',
    (col) => {
      expect(checkCell(comp, row(' ', '  ', '\t', ' '), col)).toBeNull()
    }
  )

  it.each<keyof SmRow>(['present', 'input', 'output', 'next'])(
    'returns null for a valid %s cell',
    (col) => {
      expect(checkCell(comp, row('1', "K M'", 'Sh', '3'), col)).toBeNull()
    }
  )

  it('flags only the bad cell of a row', () => {
    const r = row('1', 'Bogus', 'Sh', '3')
    expect(checkCell(comp, r, 'present')).toBeNull()
    expect(typeof checkCell(comp, r, 'input')).toBe('string')
    expect(checkCell(comp, r, 'output')).toBeNull()
    expect(checkCell(comp, r, 'next')).toBeNull()
  })

  it('flags an unknown output label in the output cell', () => {
    expect(typeof checkCell(comp, row('1', 'K', 'Bogus', '3'), 'output')).toBe('string')
  })

  it('a partially empty row is a syntax error on each empty cell', () => {
    const r = row('1', '', '', '3')
    expect(checkCell(comp, r, 'present')).toBeNull()
    expect(typeof checkCell(comp, r, 'input')).toBe('string')
    expect(typeof checkCell(comp, r, 'output')).toBe('string')
    expect(checkCell(comp, r, 'next')).toBeNull()
  })

  it('a row with only the input filled is a syntax error on the three empty cells', () => {
    const r = row('', 'K', '', '')
    expect(typeof checkCell(comp, r, 'present')).toBe('string')
    expect(checkCell(comp, r, 'input')).toBeNull()
    expect(typeof checkCell(comp, r, 'output')).toBe('string')
    expect(typeof checkCell(comp, r, 'next')).toBe('string')
  })
})

// ===========================================================================
// smLabelMaps
// ===========================================================================

describe('smLabelMaps', () => {
  it('maps labels to in1..inN / out1..outN pin names', () => {
    const { inputs, outputs } = smLabelMaps(
      smComponent({ inputs: MULT_INPUTS, outputs: MULT_OUTPUTS })
    )
    expect(inputs).toEqual(MULT_LABELS)
    expect(outputs).toEqual(MULT_OUT_LABELS)
  })

  it('skips unlabeled pins', () => {
    const { inputs, outputs } = smLabelMaps(smComponent({ inputs: ['A', '', 'C'], outputs: ['', 'Y'] }))
    expect([...inputs.entries()]).toEqual([
      ['A', 'in1'],
      ['C', 'in3']
    ])
    expect([...outputs.entries()]).toEqual([['Y', 'out2']])
  })

  it('ignores labels on pins beyond the configured input/output counts', () => {
    const comp = smComponent({ inputs: ['A', 'B'], outputs: ['Y'] })
    comp.pinLabels['in3'] = 'Ghost'
    comp.pinLabels['out2'] = 'GhostOut'
    const { inputs, outputs } = smLabelMaps(comp)
    expect(inputs.has('Ghost')).toBe(false)
    expect(outputs.has('GhostOut')).toBe(false)
  })

  it('does not confuse an input label with an output label of the same text', () => {
    const { inputs, outputs } = smLabelMaps(smComponent({ inputs: ['A'], outputs: ['A'] }))
    expect(inputs.get('A')).toBe('in1')
    expect(outputs.get('A')).toBe('out1')
  })

  it('uses the same default pin count as the part definition when smInputs/smOutputs are absent', () => {
    // defOf() gives an SM without explicit counts 4 inputs and 4 outputs; the
    // label maps must agree, otherwise a label on a physically present pin is
    // rejected by the table syntax check.
    const comp = smComponent({ inputs: ['A', 'B', 'C', 'D'], outputs: ['Y'], smInputs: null, smOutputs: null })
    const { inputs, outputs } = smLabelMaps(comp)
    expect(inputs.get('A')).toBe('in1')
    expect(inputs.get('D')).toBe('in4')
    expect(outputs.get('Y')).toBe('out1')
  })
})

// ===========================================================================
// compileTable
// ===========================================================================

describe('compileTable', () => {
  it('compiles the multiplier control table with no errors', () => {
    const { rows, errors } = compileTable(
      smComponent({ inputs: MULT_INPUTS, outputs: MULT_OUTPUTS, table: MULT_TABLE })
    )
    expect(errors).toEqual([])
    expect(rows).toEqual([
      { index: 0, present: 0, terms: [term('in1')], highOutputs: ['out1'], next: 1 },
      { index: 1, present: 0, terms: [term('in1', true)], highOutputs: [], next: 0 },
      { index: 2, present: 1, terms: [term('in2'), term('in3', true)], highOutputs: ['out2'], next: 3 },
      { index: 3, present: 1, terms: [term('in2', true), term('in3', true)], highOutputs: ['out2'], next: 1 },
      { index: 4, present: 1, terms: [term('in3')], highOutputs: ['out3'], next: 2 },
      { index: 5, present: 2, terms: [term('in2', true)], highOutputs: ['out2'], next: 1 },
      { index: 6, present: 2, terms: [term('in2')], highOutputs: ['out2'], next: 3 },
      { index: 7, present: 3, terms: null, highOutputs: ['out4'], next: 0 }
    ])
  })

  it('returns no rows and no errors when the component has no table', () => {
    expect(compileTable(smComponent({ inputs: ['A'], outputs: ['Y'] }))).toEqual({ rows: [], errors: [] })
  })

  it('returns no rows and no errors for a table of only empty rows', () => {
    const comp = smComponent({ inputs: ['A'], outputs: ['Y'], table: [EMPTY_ROW, EMPTY_ROW] })
    expect(compileTable(comp)).toEqual({ rows: [], errors: [] })
  })

  it('skips empty rows but keeps the raw table index on the compiled rows', () => {
    const comp = smComponent({
      inputs: ['A'],
      outputs: ['Y'],
      table: [EMPTY_ROW, row('0', 'A', 'Y', '1'), EMPTY_ROW, EMPTY_ROW, row('1', '-', '0', '0'), EMPTY_ROW]
    })
    const { rows, errors } = compileTable(comp)
    expect(errors).toEqual([])
    expect(rows.map((r) => r.index)).toEqual([1, 4])
    expect(rows[0]).toMatchObject({ present: 0, next: 1 })
    expect(rows[1]).toMatchObject({ present: 1, next: 0, terms: null, highOutputs: [] })
  })

  it('treats a whitespace-only row as empty', () => {
    const comp = smComponent({
      inputs: ['A'],
      outputs: ['Y'],
      table: [row(' ', '\t', '  ', ' '), row('0', 'A', 'Y', '0')]
    })
    const { rows, errors } = compileTable(comp)
    expect(errors).toEqual([])
    expect(rows.map((r) => r.index)).toEqual([1])
  })

  it('reports a partially empty row as errors on its empty cells and drops the row', () => {
    const comp = smComponent({
      inputs: ['A'],
      outputs: ['Y'],
      table: [row('0', 'A', 'Y', '0'), row('1', '', 'Y', '')]
    })
    const { rows, errors } = compileTable(comp)
    expect(rows.map((r) => r.index)).toEqual([0])
    expect(errors.map((e) => [e.row, e.column]).sort()).toEqual([
      [1, 'input'],
      [1, 'next']
    ])
    for (const e of errors) expect(typeof e.message).toBe('string')
  })

  it('reports each bad cell with its row index and column', () => {
    const comp = smComponent({
      inputs: MULT_INPUTS,
      outputs: MULT_OUTPUTS,
      table: [
        row('S0', 'St', 'Load', '1'), // bad present
        row('0', 'Bogus', 'Load', '1'), // bad input
        row('0', 'St', 'Bogus', '1'), // bad output
        row('0', 'St', 'Load', 'S1'), // bad next
        row('0', "St'", '0', '0') // good
      ]
    })
    const { rows, errors } = compileTable(comp)
    expect(rows.map((r) => r.index)).toEqual([4])
    expect(errors.map((e) => [e.row, e.column])).toEqual([
      [0, 'present'],
      [1, 'input'],
      [2, 'output'],
      [3, 'next']
    ])
  })

  it('reports every bad cell of a row that is wrong in all four columns', () => {
    const comp = smComponent({
      inputs: MULT_INPUTS,
      outputs: MULT_OUTPUTS,
      table: [row('x', 'y', 'z', 'w')]
    })
    const { rows, errors } = compileTable(comp)
    expect(rows).toEqual([])
    expect(errors.map((e) => e.column).sort()).toEqual(['input', 'next', 'output', 'present'])
    expect(errors.every((e) => e.row === 0)).toBe(true)
  })

  it('still compiles the valid rows that follow an erroneous one', () => {
    const comp = smComponent({
      inputs: ['A'],
      outputs: ['Y'],
      table: [row('0', 'Nope', 'Y', '1'), row('0', '-', 'Y', '1'), row('1', 'A', '0', '0')]
    })
    const { rows, errors } = compileTable(comp)
    expect(errors.map((e) => e.row)).toEqual([0])
    expect(rows.map((r) => r.index)).toEqual([1, 2])
  })

  it('compiles a don’t-care input to terms === null and "0" output to []', () => {
    const comp = smComponent({ inputs: ['A'], outputs: ['Y'], table: [row('5', '-', '0', '6')] })
    expect(compileTable(comp).rows).toEqual([{ index: 0, present: 5, terms: null, highOutputs: [], next: 6 }])
  })

  it('accepts a table that references only some of the labeled pins', () => {
    const comp = smComponent({ inputs: MULT_INPUTS, outputs: MULT_OUTPUTS, table: [row('0', 'K', 'Ad', '0')] })
    const { rows, errors } = compileTable(comp)
    expect(errors).toEqual([])
    expect(rows[0]).toMatchObject({ terms: [term('in2')], highOutputs: ['out3'] })
  })

  it('reads state numbers numerically ("03" is state 3, "010" is state 10)', () => {
    const comp = smComponent({ inputs: ['A'], outputs: ['Y'], table: [row('03', '-', '0', '010')] })
    const { rows, errors } = compileTable(comp)
    expect(errors).toEqual([])
    expect(rows[0]).toMatchObject({ present: 3, next: 10 })
  })

  it('compiles a row using all 8 inputs and all 8 outputs of a maximum-size machine', () => {
    const ins = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
    const outs = ['O1', 'O2', 'O3', 'O4', 'O5', 'O6', 'O7', 'O8']
    const comp = smComponent({ inputs: ins, outputs: outs, table: [row('0', "A B' C D' E F' G H'", outs.join(' '), '0')] })
    const { rows, errors } = compileTable(comp)
    expect(errors).toEqual([])
    expect(rows[0].terms).toEqual(ins.map((_, i) => term(`in${i + 1}`, i % 2 === 1)))
    expect(rows[0].highOutputs).toEqual(outs.map((_, i) => `out${i + 1}`))
  })
})

// ===========================================================================
// termsMatch
// ===========================================================================

describe('termsMatch', () => {
  it('null terms (don’t care) match regardless of the inputs', () => {
    expect(termsMatch(null, pins({}))).toBe(true)
    expect(termsMatch(null, pins({ in1: X, in2: Z }))).toBe(true)
    expect(termsMatch(null, pins({ in1: ZERO, in2: ONE }))).toBe(true)
  })

  it('an empty term list matches', () => {
    expect(termsMatch([], pins({ in1: X }))).toBe(true)
  })

  describe('single positive literal A', () => {
    const t = [term('in1')]
    it('A=1 matches', () => expect(termsMatch(t, pins({ in1: ONE }))).toBe(true))
    it('A=0 does not match', () => expect(termsMatch(t, pins({ in1: ZERO }))).toBe(false))
    it('A=X is unresolved (null)', () => expect(termsMatch(t, pins({ in1: X }))).toBeNull())
    it('A=Z is unresolved (null)', () => expect(termsMatch(t, pins({ in1: Z }))).toBeNull())
    it('unconnected pin (readPin falls back to Z) is unresolved', () =>
      expect(termsMatch(t, pins({}))).toBeNull())
  })

  describe("single negated literal A'", () => {
    const t = [term('in1', true)]
    it('A=0 matches', () => expect(termsMatch(t, pins({ in1: ZERO }))).toBe(true))
    it('A=1 does not match', () => expect(termsMatch(t, pins({ in1: ONE }))).toBe(false))
    it('A=X is unresolved (null)', () => expect(termsMatch(t, pins({ in1: X }))).toBeNull())
    it('A=Z is unresolved (null)', () => expect(termsMatch(t, pins({ in1: Z }))).toBeNull())
  })

  describe("two literals K M' (full truth table)", () => {
    const t = [term('in2'), term('in3', true)]
    it.each<[LogicValue, LogicValue, boolean]>([
      [ZERO, ZERO, false],
      [ZERO, ONE, false],
      [ONE, ZERO, true],
      [ONE, ONE, false]
    ])('K=%s M=%s -> %s', (k, m, expected) => {
      expect(termsMatch(t, pins({ in2: k, in3: m }))).toBe(expected)
    })

    it('K=X with M satisfied is unresolved', () => {
      expect(termsMatch(t, pins({ in2: X, in3: ZERO }))).toBeNull()
    })
    it('K=Z with M satisfied is unresolved', () => {
      expect(termsMatch(t, pins({ in2: Z, in3: ZERO }))).toBeNull()
    })
    it('M=X with K satisfied is unresolved', () => {
      expect(termsMatch(t, pins({ in2: ONE, in3: X }))).toBeNull()
    })
    it('M=Z with K satisfied is unresolved', () => {
      expect(termsMatch(t, pins({ in2: ONE, in3: Z }))).toBeNull()
    })
    it('both X is unresolved', () => {
      expect(termsMatch(t, pins({ in2: X, in3: X }))).toBeNull()
    })
  })

  describe("three literals St' K M", () => {
    const t = [term('in1', true), term('in2'), term('in3')]
    it('matches only for St=0 K=1 M=1', () => {
      expect(termsMatch(t, pins({ in1: ZERO, in2: ONE, in3: ONE }))).toBe(true)
      expect(termsMatch(t, pins({ in1: ONE, in2: ONE, in3: ONE }))).toBe(false)
      expect(termsMatch(t, pins({ in1: ZERO, in2: ZERO, in3: ONE }))).toBe(false)
      expect(termsMatch(t, pins({ in1: ZERO, in2: ONE, in3: ZERO }))).toBe(false)
    })
    it('is unresolved when the last literal is Z and the others are satisfied', () => {
      expect(termsMatch(t, pins({ in1: ZERO, in2: ONE, in3: Z }))).toBeNull()
    })
  })

  it('only reads the pins named in the terms', () => {
    const seen: string[] = []
    termsMatch([term('in2')], (name) => {
      seen.push(name)
      return ONE
    })
    expect(seen).toEqual(['in2'])
  })
})

// ===========================================================================
// STATE_MACHINE part in the Simulator: the manual's multiplier control example
// ===========================================================================

describe('STATE_MACHINE: multiplier control (manual Table 1)', () => {
  describe('after reset', () => {
    it('is in the first row’s present state (0) and displays it', () => {
      const m = multiplier()
      expect(m.state).toBe('0')
    })

    it('with St=0 the active row is row 1 (St’) and every output is 0', () => {
      const m = multiplier()
      expect(m.active).toBe(1)
      expect(m.outs()).toEqual(m.only())
    })

    it('with St=1 at reset the active row is row 0 and Load=1 (no clock needed)', () => {
      const m = multiplier({ initial: { St: ONE } })
      expect(m.state).toBe('0')
      expect(m.active).toBe(0)
      expect(m.outs()).toEqual(m.only('Load'))
    })

    it('probes on outputs read the same values as the SM output pins', () => {
      const m = multiplier({ initial: { St: ONE } })
      expect(m.c.pin(p('sm', 'out1'))).toBe(ONE)
      expect(m.c.pin(p('sm', 'out2'))).toBe(ZERO)
      expect(m.c.pin(p('sm', 'out3'))).toBe(ZERO)
      expect(m.c.pin(p('sm', 'out4'))).toBe(ZERO)
    })
  })

  describe('Mealy outputs follow the inputs without a clock', () => {
    it('St 0->1 in state 0 raises Load immediately and leaves the state at 0', () => {
      const m = multiplier()
      m.set('St', ONE)
      expect(m.outs()).toEqual(m.only('Load'))
      expect(m.active).toBe(0)
      expect(m.state).toBe('0')
    })

    it('St 1->0 in state 0 drops Load immediately', () => {
      const m = multiplier({ initial: { St: ONE } })
      m.set('St', ZERO)
      expect(m.outs()).toEqual(m.only())
      expect(m.active).toBe(1)
      expect(m.state).toBe('0')
    })

    it('K and M are irrelevant in state 0', () => {
      const m = multiplier()
      m.setMany({ K: ONE, M: ONE })
      expect(m.outs()).toEqual(m.only())
      m.set('St', ONE)
      expect(m.outs()).toEqual(m.only('Load'))
      expect(m.state).toBe('0')
    })

    it('toggling St repeatedly never changes the state', () => {
      const m = multiplier()
      for (let i = 0; i < 4; i++) {
        m.set('St', ONE)
        expect(m.state).toBe('0')
        m.set('St', ZERO)
        expect(m.state).toBe('0')
      }
    })
  })

  describe('state changes only on the rising CLK edge', () => {
    it('a rising edge with St=1 moves S0 -> S1 and updates the display', () => {
      const m = multiplier({ initial: { St: ONE } })
      m.rise()
      expect(m.state).toBe('1')
    })

    it('a rising edge with St=0 keeps S0 (row 1: next S0)', () => {
      const m = multiplier()
      m.rise()
      expect(m.state).toBe('0')
      expect(m.active).toBe(1)
    })

    it('the falling edge does not change the state', () => {
      const m = multiplier({ initial: { St: ONE } })
      m.rise()
      expect(m.state).toBe('1')
      m.set('M', ONE) // row 4 active: next would be S2
      m.fall()
      expect(m.state).toBe('1')
    })

    it('changing inputs while CLK is held high does not change the state', () => {
      const m = multiplier({ initial: { St: ONE, clk: ONE } })
      expect(m.state).toBe('0')
      m.set('St', ZERO)
      m.set('St', ONE)
      expect(m.state).toBe('0')
      expect(m.outs()).toEqual(m.only('Load'))
    })

    it('changing inputs while CLK is held low does not change the state', () => {
      const m = multiplier({ initial: { St: ONE } })
      m.rise()
      m.fall()
      expect(m.state).toBe('1')
      m.set('M', ONE)
      m.set('K', ONE)
      m.set('M', ZERO)
      expect(m.state).toBe('1')
    })

    it('after the edge the outputs immediately reflect the new state’s active row', () => {
      // S0, St=1 -> Load. Edge -> S1 with K=0, M=0 -> row 3 (K'M') -> Sh.
      const m = multiplier({ initial: { St: ONE } })
      m.rise()
      expect(m.state).toBe('1')
      expect(m.active).toBe(3)
      expect(m.outs()).toEqual(m.only('Sh'))
    })

    it('each rising edge advances exactly one transition', () => {
      // S0 -St-> S1 -M-> S2 -K-> S3 --> S0
      const m = multiplier({ initial: { St: ONE, M: ONE, K: ONE } })
      m.clock()
      expect(m.state).toBe('1')
      m.clock()
      expect(m.state).toBe('2')
      m.clock()
      expect(m.state).toBe('3')
      m.clock()
      expect(m.state).toBe('0')
    })

    it('with CLK unconnected the state never changes but outputs still follow inputs', () => {
      const m = multiplier({ clk: 'none' })
      expect(m.state).toBe('0')
      m.set('St', ONE)
      expect(m.outs()).toEqual(m.only('Load'))
      expect(m.state).toBe('0')
    })
  })

  describe('state S1 rows (row order 2: K M’, 3: K’M’, 4: M)', () => {
    function inS1(k: LogicValue, mm: LogicValue): SmCircuit {
      const m = multiplier({ initial: { St: ONE } })
      m.clock()
      expect(m.state).toBe('1')
      m.setMany({ K: k, M: mm })
      return m
    }

    it("K=0 M=0 -> row 3 (K'M'): Sh, next S1", () => {
      const m = inS1(ZERO, ZERO)
      expect(m.active).toBe(3)
      expect(m.outs()).toEqual(m.only('Sh'))
      m.clock()
      expect(m.state).toBe('1')
    })

    it("K=1 M=0 -> row 2 (K M'): Sh, next S3", () => {
      const m = inS1(ONE, ZERO)
      expect(m.active).toBe(2)
      expect(m.outs()).toEqual(m.only('Sh'))
      m.clock()
      expect(m.state).toBe('3')
    })

    it('K=0 M=1 -> row 4 (M): Ad, next S2', () => {
      const m = inS1(ZERO, ONE)
      expect(m.active).toBe(4)
      expect(m.outs()).toEqual(m.only('Ad'))
      m.clock()
      expect(m.state).toBe('2')
    })

    it('K=1 M=1 -> row 4 (M): Ad, next S2 (rows 2 and 3 need M’ / K’)', () => {
      const m = inS1(ONE, ONE)
      expect(m.active).toBe(4)
      expect(m.outs()).toEqual(m.only('Ad'))
      m.clock()
      expect(m.state).toBe('2')
    })

    it('St is irrelevant in S1', () => {
      const m = inS1(ZERO, ONE)
      m.set('St', ZERO)
      expect(m.outs()).toEqual(m.only('Ad'))
      expect(m.active).toBe(4)
    })
  })

  describe('state S2 rows (5: K’ -> S1, 6: K -> S3)', () => {
    function inS2(): SmCircuit {
      const m = multiplier({ initial: { St: ONE, M: ONE } })
      m.clock()
      m.clock()
      expect(m.state).toBe('2')
      return m
    }

    it("K=0 -> row 5: Sh, next S1", () => {
      const m = inS2()
      expect(m.active).toBe(5)
      expect(m.outs()).toEqual(m.only('Sh'))
      m.clock()
      expect(m.state).toBe('1')
    })

    it('K=1 -> row 6: Sh, next S3', () => {
      const m = inS2()
      m.set('K', ONE)
      expect(m.active).toBe(6)
      expect(m.outs()).toEqual(m.only('Sh'))
      m.clock()
      expect(m.state).toBe('3')
    })

    it('M and St are irrelevant in S2', () => {
      const m = inS2()
      m.setMany({ M: ZERO, St: ZERO })
      expect(m.active).toBe(5)
      expect(m.outs()).toEqual(m.only('Sh'))
    })
  })

  describe('state S3 (row 7: don’t care -> Done, next S0)', () => {
    function inS3(): SmCircuit {
      const m = multiplier({ initial: { St: ONE, K: ONE } })
      m.clock() // S1 (K=1, M=0 -> row 2 -> S3)
      m.clock()
      expect(m.state).toBe('3')
      return m
    }

    it('Done=1 with the inputs as they are', () => {
      const m = inS3()
      expect(m.active).toBe(7)
      expect(m.outs()).toEqual(m.only('Done'))
    })

    it.each<[LogicValue, LogicValue, LogicValue]>([
      [ZERO, ZERO, ZERO],
      [ZERO, ZERO, ONE],
      [ZERO, ONE, ZERO],
      [ZERO, ONE, ONE],
      [ONE, ZERO, ZERO],
      [ONE, ZERO, ONE],
      [ONE, ONE, ZERO],
      [ONE, ONE, ONE]
    ])('Done=1 for St=%s K=%s M=%s', (st, k, mm) => {
      const m = inS3()
      m.setMany({ St: st, K: k, M: mm })
      expect(m.active).toBe(7)
      expect(m.outs()).toEqual(m.only('Done'))
    })

    it('a rising edge returns to S0', () => {
      const m = inS3()
      m.set('St', ZERO)
      m.clock()
      expect(m.state).toBe('0')
      expect(m.active).toBe(1)
      expect(m.outs()).toEqual(m.only())
    })
  })

  describe('full multiplier control sequence', () => {
    it('walks S0 -> S1 -> S2 -> S1 -> S2 -> S1 -> S3 -> S0 for a 2-bit multiply', () => {
      // Multiplier bits M: 1, then 1 (two add/shift pairs); K=1 on the last shift.
      const m = multiplier()
      expect(m.state).toBe('0')
      expect(m.outs()).toEqual(m.only())

      m.set('St', ONE) // Start
      expect(m.outs()).toEqual(m.only('Load'))
      m.clock()
      expect(m.state).toBe('1')
      m.set('St', ZERO)

      m.set('M', ONE) // multiplier bit 1 -> add
      expect(m.outs()).toEqual(m.only('Ad'))
      m.clock()
      expect(m.state).toBe('2')
      expect(m.outs()).toEqual(m.only('Sh')) // K=0 -> shift, back to S1
      m.clock()
      expect(m.state).toBe('1')

      m.set('M', ONE) // next multiplier bit 1 -> add
      expect(m.outs()).toEqual(m.only('Ad'))
      m.clock()
      expect(m.state).toBe('2')
      m.set('K', ONE) // last shift
      expect(m.outs()).toEqual(m.only('Sh'))
      m.clock()
      expect(m.state).toBe('3')
      expect(m.outs()).toEqual(m.only('Done'))
      m.clock()
      expect(m.state).toBe('0')
      expect(m.outs()).toEqual(m.only())
    })

    it('walks S0 -> S1 -> S1 -> S3 -> S0 when the multiplier bits are 0 (shift only)', () => {
      const m = multiplier({ initial: { St: ONE } })
      m.clock()
      expect(m.state).toBe('1')
      m.set('St', ZERO)
      expect(m.outs()).toEqual(m.only('Sh')) // K'M' -> shift, stay in S1
      m.clock()
      expect(m.state).toBe('1')
      m.set('K', ONE) // last shift: K M' -> S3
      expect(m.outs()).toEqual(m.only('Sh'))
      m.clock()
      expect(m.state).toBe('3')
      expect(m.outs()).toEqual(m.only('Done'))
      m.clock()
      expect(m.state).toBe('0')
    })

    it('keeps waiting in S0 through many clocks while St=0', () => {
      const m = multiplier()
      for (let i = 0; i < 5; i++) {
        m.clock()
        expect(m.state).toBe('0')
        expect(m.outs()).toEqual(m.only())
      }
    })
  })

  describe('X and Z inputs', () => {
    it('St floating (Z) in S0: both S0 rows need St -> outputs X, no active row', () => {
      const m = multiplier({ floating: ['St'] })
      expect(m.c.pin(p('sm', 'in1'))).toBe(Z)
      expect(m.outs()).toEqual(m.all(X))
      expect(m.active).toBeNull()
      expect(m.state).toBe('0')
    })

    it('St at X in S0 -> outputs X, no active row', () => {
      const m = multiplier({ xSource: { St: 'and' }, initial: { St: ONE } })
      expect(m.c.pin(p('sm', 'in1'))).toBe(X)
      expect(m.outs()).toEqual(m.all(X))
      expect(m.active).toBeNull()
    })

    it('St recovering from X to 0 restores the row-1 outputs', () => {
      const m = multiplier({ xSource: { St: 'and' }, initial: { St: ONE } })
      m.set('St', ZERO)
      expect(m.c.pin(p('sm', 'in1'))).toBe(ZERO)
      expect(m.outs()).toEqual(m.only())
      expect(m.active).toBe(1)
    })

    it('St at X in S0 keeps the state on a rising edge and leaves outputs X', () => {
      const m = multiplier({ xSource: { St: 'and' }, initial: { St: ONE } })
      m.clock()
      expect(m.outs()).toEqual(m.all(X))
    })

    it('K=X, M=0 in S1: rows 2 and 3 need K, row 4 needs M=1 -> outputs X', () => {
      const m = multiplier({ xSource: { K: 'and' }, initial: { St: ONE } })
      m.clock()
      expect(m.state).toBe('1')
      m.set('K', ONE) // -> X through the AND with a floating input
      expect(m.c.pin(p('sm', 'in2'))).toBe(X)
      expect(m.outs()).toEqual(m.all(X))
      expect(m.active).toBeNull()
    })

    it('K=X, M=1 in S1: row 4 (M) matches without K -> Ad=1', () => {
      const m = multiplier({ xSource: { K: 'and' }, initial: { St: ONE } })
      m.clock()
      m.setMany({ K: ONE, M: ONE })
      expect(m.c.pin(p('sm', 'in2'))).toBe(X)
      expect(m.outs()).toEqual(m.only('Ad'))
      expect(m.active).toBe(4)
      m.clock()
      expect(m.state).toBe('2')
    })

    it('K floating (Z), M=1 in S1: row 4 still matches -> Ad=1', () => {
      const m = multiplier({ floating: ['K'], initial: { St: ONE, M: ONE } })
      m.clock()
      expect(m.state).toBe('1')
      expect(m.outs()).toEqual(m.only('Ad'))
      expect(m.active).toBe(4)
    })

    it('K floating (Z), M=0 in S1 -> outputs X', () => {
      const m = multiplier({ floating: ['K'], initial: { St: ONE } })
      m.clock()
      expect(m.state).toBe('1')
      expect(m.outs()).toEqual(m.all(X))
      expect(m.active).toBeNull()
    })

    it('M=X, K=0 in S1: rows 2, 3 need M and row 4 needs M -> outputs X', () => {
      const m = multiplier({ xSource: { M: 'and' }, initial: { St: ONE } })
      m.clock()
      m.set('M', ONE)
      expect(m.c.pin(p('sm', 'in3'))).toBe(X)
      expect(m.outs()).toEqual(m.all(X))
    })

    it('K=X in S2: both S2 rows need K -> outputs X', () => {
      const m = multiplier({ xSource: { K: 'and' }, initial: { St: ONE, M: ONE } })
      m.clock()
      m.clock()
      expect(m.state).toBe('2')
      m.set('K', ONE)
      expect(m.outs()).toEqual(m.all(X))
      expect(m.active).toBeNull()
    })

    it('K=1 via an OR source in S2 -> row 6; then K=X -> outputs X', () => {
      const m = multiplier({ xSource: { K: 'or' }, initial: { St: ONE, M: ONE, K: ONE } })
      m.clock()
      m.clock()
      expect(m.state).toBe('2')
      expect(m.c.pin(p('sm', 'in2'))).toBe(ONE)
      expect(m.active).toBe(6)
      m.set('K', ZERO) // OR with floating input -> X
      expect(m.c.pin(p('sm', 'in2'))).toBe(X)
      expect(m.outs()).toEqual(m.all(X))
    })

    it('an X on one input does not disturb rows of the current state that ignore it (M=X in S2)', () => {
      const m = multiplier({ xSource: { M: 'and' }, initial: { St: ONE, M: ONE } })
      // M=X at reset (AND with floating input). Reach S2 through S1 with a clean M first.
      m.set('M', ZERO)
      m.clock() // S1 with K=0, M=0 -> row 3
      m.set('M', ONE) // clean 1 not possible through the AND source; use K path instead
      expect(m.state).toBe('1')
      expect(m.c.pin(p('sm', 'in3'))).toBe(X)
      // Rows 2, 3 need M (unresolved) and row 4 needs M -> X in S1.
      expect(m.outs()).toEqual(m.all(X))
    })
  })
})

// This machine starts in S3 (first row) so the don't-care row is exercised with
// X/Z inputs without having to pass through rows that need them.
describe('STATE_MACHINE: don’t-care row with unresolved inputs', () => {
  const TABLE_S3_FIRST: SmRow[] = [
    row('3', '-', 'Done', '0'),
    row('0', 'St', 'Load', '1'),
    row('0', "St'", '0', '0')
  ]

  it('initial state is 3 (first row) and Done=1 with St floating', () => {
    const m = new SmCircuit({ inputs: ['St'], outputs: ['Load', 'Done'], table: TABLE_S3_FIRST, floating: ['St'] })
    expect(m.state).toBe('3')
    expect(m.active).toBe(0)
    expect(m.outs()).toEqual(m.only('Done'))
  })

  it('Done=1 with St at X', () => {
    const m = new SmCircuit({
      inputs: ['St'],
      outputs: ['Load', 'Done'],
      table: TABLE_S3_FIRST,
      xSource: { St: 'and' },
      initial: { St: ONE }
    })
    expect(m.c.pin(p('sm', 'in1'))).toBe(X)
    expect(m.state).toBe('3')
    expect(m.outs()).toEqual(m.only('Done'))
  })

  it('a rising edge leaves S3 for S0 even though St is X, after which outputs are X', () => {
    const m = new SmCircuit({
      inputs: ['St'],
      outputs: ['Load', 'Done'],
      table: TABLE_S3_FIRST,
      xSource: { St: 'and' },
      initial: { St: ONE }
    })
    m.clock()
    expect(m.state).toBe('0')
    expect(m.outs()).toEqual(m.all(X))
    expect(m.active).toBeNull()
  })
})

// ===========================================================================
// Row-order precedence
// ===========================================================================

describe('STATE_MACHINE: row-order precedence when several rows match', () => {
  const PA_THEN_DASH: SmRow[] = [row('0', 'A', 'P', '1'), row('0', '-', 'Q', '2'), row('1', '-', '0', '1'), row('2', '-', '0', '2')]

  it('A=1: the earlier specific row wins (P, next 1)', () => {
    const m = new SmCircuit({ inputs: ['A'], outputs: ['P', 'Q'], table: PA_THEN_DASH, initial: { A: ONE } })
    expect(m.active).toBe(0)
    expect(m.outs()).toEqual(m.only('P'))
    m.clock()
    expect(m.state).toBe('1')
  })

  it('A=0: only the don’t-care row matches (Q, next 2)', () => {
    const m = new SmCircuit({ inputs: ['A'], outputs: ['P', 'Q'], table: PA_THEN_DASH })
    expect(m.active).toBe(1)
    expect(m.outs()).toEqual(m.only('Q'))
    m.clock()
    expect(m.state).toBe('2')
  })

  it('A=X: the unresolved first row is skipped and the don’t-care row is active', () => {
    const m = new SmCircuit({
      inputs: ['A'],
      outputs: ['P', 'Q'],
      table: PA_THEN_DASH,
      xSource: { A: 'and' },
      initial: { A: ONE }
    })
    expect(m.c.pin(p('sm', 'in1'))).toBe(X)
    expect(m.active).toBe(1)
    expect(m.outs()).toEqual(m.only('Q'))
    m.clock()
    expect(m.state).toBe('2')
  })

  it('A floating: the don’t-care row is active', () => {
    const m = new SmCircuit({ inputs: ['A'], outputs: ['P', 'Q'], table: PA_THEN_DASH, floating: ['A'] })
    expect(m.active).toBe(1)
    expect(m.outs()).toEqual(m.only('Q'))
  })

  it('a don’t-care row placed first shadows every later row of that state', () => {
    const table = [row('0', '-', 'Q', '2'), row('0', 'A', 'P', '1'), row('2', '-', '0', '2')]
    const m = new SmCircuit({ inputs: ['A'], outputs: ['P', 'Q'], table, initial: { A: ONE } })
    expect(m.active).toBe(0)
    expect(m.outs()).toEqual(m.only('Q'))
    m.clock()
    expect(m.state).toBe('2')
  })

  it('two rows with identical inputs: the first wins', () => {
    const table = [row('0', 'A', 'P', '1'), row('0', 'A', 'Q', '2'), row('1', '-', '0', '1')]
    const m = new SmCircuit({ inputs: ['A'], outputs: ['P', 'Q'], table, initial: { A: ONE } })
    expect(m.active).toBe(0)
    expect(m.outs()).toEqual(m.only('P'))
    m.clock()
    expect(m.state).toBe('1')
  })

  it('overlapping rows A and B: the earlier one wins when both are 1', () => {
    const table = [row('0', 'A', 'P', '1'), row('0', 'B', 'Q', '2'), row('1', '-', '0', '1'), row('2', '-', '0', '2')]
    const m = new SmCircuit({ inputs: ['A', 'B'], outputs: ['P', 'Q'], table, initial: { A: ONE, B: ONE } })
    expect(m.active).toBe(0)
    expect(m.outs()).toEqual(m.only('P'))
    m.set('A', ZERO)
    expect(m.active).toBe(1)
    expect(m.outs()).toEqual(m.only('Q'))
  })

  it('rows of other states are never considered', () => {
    const table = [row('1', '-', 'Q', '1'), row('0', 'A', 'P', '1'), row('0', "A'", '0', '0')]
    const m = new SmCircuit({ inputs: ['A'], outputs: ['P', 'Q'], table })
    // Initial state is the first row's present state: 1.
    expect(m.state).toBe('1')
    expect(m.active).toBe(0)
    expect(m.outs()).toEqual(m.only('Q'))
  })

  it('the active row index refers to the raw table (empty rows count)', () => {
    const table = [EMPTY_ROW, row('0', 'A', 'P', '1'), EMPTY_ROW, row('0', '-', 'Q', '2'), row('1', '-', '0', '1'), row('2', '-', '0', '2')]
    const m = new SmCircuit({ inputs: ['A'], outputs: ['P', 'Q'], table, initial: { A: ONE } })
    expect(m.active).toBe(1)
    m.set('A', ZERO)
    expect(m.active).toBe(3)
  })
})

// ===========================================================================
// No matching row
// ===========================================================================

describe('STATE_MACHINE: no matching row', () => {
  const table = [row('0', 'A', 'P', '1'), row('1', 'A', 'P', '0')]

  it('A=0 in state 0 (only an A row exists) -> outputs X, no active row, state unchanged', () => {
    const m = new SmCircuit({ inputs: ['A'], outputs: ['P'], table })
    expect(m.state).toBe('0')
    expect(m.active).toBeNull()
    expect(m.outs()).toEqual(m.all(X))
  })

  it('A 0->1 makes the row active and the outputs resolve', () => {
    const m = new SmCircuit({ inputs: ['A'], outputs: ['P'], table })
    m.set('A', ONE)
    expect(m.active).toBe(0)
    expect(m.outs()).toEqual(m.only('P'))
  })

  it('A 1->0 back to no matching row -> outputs X again', () => {
    const m = new SmCircuit({ inputs: ['A'], outputs: ['P'], table, initial: { A: ONE } })
    m.set('A', ZERO)
    expect(m.active).toBeNull()
    expect(m.outs()).toEqual(m.all(X))
  })

  it('a next state that has no rows: outputs X and the display shows that state', () => {
    const t = [row('0', '-', 'P', '5')]
    const m = new SmCircuit({ inputs: ['A'], outputs: ['P'], table: t })
    expect(m.outs()).toEqual(m.only('P'))
    m.clock()
    expect(m.state).toBe('5')
    expect(m.active).toBeNull()
    expect(m.outs()).toEqual(m.all(X))
  })

  it('a rising edge with no active row leaves the outputs X', () => {
    const m = new SmCircuit({ inputs: ['A'], outputs: ['P'], table })
    m.clock()
    expect(m.outs()).toEqual(m.all(X))
    expect(m.active).toBeNull()
  })
})

// ===========================================================================
// Initial state and reset
// ===========================================================================

describe('STATE_MACHINE: initial state and reset', () => {
  it('initial state is the first row’s present state even when it is not 0', () => {
    const table = [row('2', 'A', 'P', '0'), row('2', "A'", '0', '2'), row('0', '-', '0', '2')]
    const m = new SmCircuit({ inputs: ['A'], outputs: ['P'], table })
    expect(m.state).toBe('2')
    expect(m.active).toBe(1)
  })

  it('leading empty rows are ignored when choosing the initial state', () => {
    const table = [EMPTY_ROW, EMPTY_ROW, row('7', '-', 'P', '7')]
    const m = new SmCircuit({ inputs: ['A'], outputs: ['P'], table })
    expect(m.state).toBe('7')
    expect(m.active).toBe(2)
    expect(m.outs()).toEqual(m.only('P'))
  })

  it('reset() restores the initial state after several transitions', () => {
    const m = multiplier({ initial: { St: ONE, M: ONE } })
    m.clock()
    m.clock()
    expect(m.state).toBe('2')
    m.c.reset()
    expect(m.state).toBe('0')
  })

  it('after reset() the outputs follow the current switch positions in the initial state', () => {
    const m = multiplier({ initial: { St: ONE, M: ONE } })
    m.clock()
    m.clock()
    expect(m.outs()).toEqual(m.only('Sh'))
    m.c.reset()
    // Switches keep their positions across a reset; St=1 in S0 -> Load.
    expect(m.state).toBe('0')
    expect(m.active).toBe(0)
    expect(m.outs()).toEqual(m.only('Load'))
  })

  it('after reset() the machine clocks normally again', () => {
    const m = multiplier({ initial: { St: ONE } })
    m.clock()
    m.clock()
    m.c.reset()
    expect(m.state).toBe('0')
    m.clock()
    expect(m.state).toBe('1')
  })

  it('reset() with CLK held high does not count as a rising edge', () => {
    const m = multiplier({ initial: { St: ONE, clk: ONE } })
    m.c.reset()
    expect(m.state).toBe('0')
    m.set('St', ZERO)
    m.set('St', ONE)
    expect(m.state).toBe('0')
  })

  it('getSmDisplays() reports the state number under the sm#state key through a full cycle', () => {
    const m = multiplier({ initial: { St: ONE, M: ONE, K: ONE } })
    const key = p('sm', 'state')
    expect(m.c.sim.getSmDisplays()[key]).toBe('0')
    m.clock()
    expect(m.c.sim.getSmDisplays()[key]).toBe('1')
    m.clock()
    expect(m.c.sim.getSmDisplays()[key]).toBe('2')
    m.clock()
    expect(m.c.sim.getSmDisplays()[key]).toBe('3')
    m.clock()
    expect(m.c.sim.getSmDisplays()[key]).toBe('0')
  })

  it('getSmActive() is keyed by the component id and tracks the active row', () => {
    const m = multiplier({ initial: { St: ONE } })
    expect(m.c.sim.getSmActive()).toEqual({ sm: 0 })
    m.set('St', ZERO)
    expect(m.c.sim.getSmActive()).toEqual({ sm: 1 })
    m.set('St', ONE)
    m.clock()
    expect(m.c.sim.getSmActive()).toEqual({ sm: 3 })
  })
})

// ===========================================================================
// Moore-style machine (same output on every row leaving a state)
// ===========================================================================

describe('STATE_MACHINE: Moore-style machine', () => {
  // 3-state ring counter enabled by En; Y=1 only in state 2.
  const MOORE: SmRow[] = [
    row('0', 'En', '0', '1'),
    row('0', "En'", '0', '0'),
    row('1', 'En', '0', '2'),
    row('1', "En'", '0', '1'),
    row('2', 'En', 'Y', '0'),
    row('2', "En'", 'Y', '2')
  ]
  const moore = (initial: Record<string, LogicValue> = {}): SmCircuit =>
    new SmCircuit({ inputs: ['En'], outputs: ['Y'], table: MOORE, initial })

  it('Y=0 in state 0 regardless of En', () => {
    const m = moore()
    expect(m.out('Y')).toBe(ZERO)
    m.set('En', ONE)
    expect(m.out('Y')).toBe(ZERO)
    expect(m.state).toBe('0')
  })

  it('holds the state while En=0', () => {
    const m = moore()
    m.clock()
    m.clock()
    expect(m.state).toBe('0')
  })

  it('advances one state per clock while En=1', () => {
    const m = moore({ En: ONE })
    m.clock()
    expect(m.state).toBe('1')
    expect(m.out('Y')).toBe(ZERO)
    m.clock()
    expect(m.state).toBe('2')
    expect(m.out('Y')).toBe(ONE)
    m.clock()
    expect(m.state).toBe('0')
    expect(m.out('Y')).toBe(ZERO)
  })

  it('in state 2 the output stays 1 while En toggles (output depends only on the state)', () => {
    const m = moore({ En: ONE })
    m.clock()
    m.clock()
    expect(m.state).toBe('2')
    expect(m.out('Y')).toBe(ONE)
    m.set('En', ZERO)
    expect(m.out('Y')).toBe(ONE)
    expect(m.active).toBe(5)
    m.set('En', ONE)
    expect(m.out('Y')).toBe(ONE)
    expect(m.active).toBe(4)
    expect(m.state).toBe('2')
  })

  it('in state 1 the output stays 0 while En toggles', () => {
    const m = moore({ En: ONE })
    m.clock()
    expect(m.state).toBe('1')
    m.set('En', ZERO)
    expect(m.out('Y')).toBe(ZERO)
    m.set('En', ONE)
    expect(m.out('Y')).toBe(ZERO)
  })

  it('En=0 holds in state 2 with Y=1 through several clocks', () => {
    const m = moore({ En: ONE })
    m.clock()
    m.clock()
    m.set('En', ZERO)
    for (let i = 0; i < 3; i++) {
      m.clock()
      expect(m.state).toBe('2')
      expect(m.out('Y')).toBe(ONE)
    }
  })
})

// ===========================================================================
// '101' sequence detector clocked by the CLOCK part
// ===========================================================================

describe("STATE_MACHINE: '101' sequence detector with the CLOCK part", () => {
  // Mealy detector: state 0 = nothing, 1 = saw '1', 2 = saw '10'.
  const DETECTOR: SmRow[] = [
    row('0', "A'", '0', '0'), // 0
    row('0', 'A', '0', '1'), // 1
    row('1', 'A', '0', '1'), // 2
    row('1', "A'", '0', '2'), // 3
    row('2', "A'", '0', '0'), // 4
    row('2', 'A', 'Det', '1') // 5
  ]

  describe('driven by a switch and step()', () => {
    // Default options: period 20 ns, rising-edge clock (initial 1), limit 100 ns.
    // Rising edges at 20, 40, 60, 80; each Step ends a quarter period before
    // the next rising edge (15, 35, 55, 75, 95).
    it('the first Step ends at 15 ns before any rising edge; the state is still 0', () => {
      const m = new SmCircuit({ inputs: ['A'], outputs: ['Det'], table: DETECTOR, clk: 'clock', initial: { A: ONE } })
      expect(m.state).toBe('0')
      m.c.step()
      expect(m.c.time).toBe(15)
      expect(m.state).toBe('0')
    })

    it('detects 1,0,1 with a rising edge per Step and a Mealy output before the edge', () => {
      const m = new SmCircuit({ inputs: ['A'], outputs: ['Det'], table: DETECTOR, clk: 'clock', initial: { A: ONE } })
      m.c.step() // 15
      m.c.step() // 35: edge at 20 with A=1 -> state 1
      expect(m.c.time).toBe(35)
      expect(m.state).toBe('1')
      expect(m.out('Det')).toBe(ZERO)

      m.set('A', ZERO)
      m.c.step() // 55: edge at 40 with A=0 -> state 2
      expect(m.state).toBe('2')
      expect(m.out('Det')).toBe(ZERO)

      m.set('A', ONE) // '101' complete: Mealy output now, before the clock
      expect(m.out('Det')).toBe(ONE)
      expect(m.active).toBe(5)
      expect(m.state).toBe('2')

      m.c.step() // 75: edge at 60 with A=1 -> state 1, Det drops
      expect(m.state).toBe('1')
      expect(m.out('Det')).toBe(ZERO)

      m.set('A', ZERO)
      m.c.step() // 95: edge at 80 -> state 2
      expect(m.state).toBe('2')
      m.set('A', ONE)
      expect(m.out('Det')).toBe(ONE)
    })

    it('1,1,0,1 also detects (overlapping prefix handled by state 1 self-loop)', () => {
      const m = new SmCircuit({ inputs: ['A'], outputs: ['Det'], table: DETECTOR, clk: 'clock', initial: { A: ONE } })
      m.c.step()
      m.c.step() // state 1
      expect(m.state).toBe('1')
      m.c.step() // A still 1 -> state 1
      expect(m.state).toBe('1')
      m.set('A', ZERO)
      m.c.step() // -> state 2
      expect(m.state).toBe('2')
      m.set('A', ONE)
      expect(m.out('Det')).toBe(ONE)
    })

    it('1,0,0 resets to state 0 with no detection', () => {
      const m = new SmCircuit({ inputs: ['A'], outputs: ['Det'], table: DETECTOR, clk: 'clock', initial: { A: ONE } })
      m.c.step()
      m.c.step() // state 1
      m.set('A', ZERO)
      m.c.step() // state 2
      expect(m.state).toBe('2')
      expect(m.out('Det')).toBe(ZERO)
      m.c.step() // A=0 -> state 0
      expect(m.state).toBe('0')
      expect(m.out('Det')).toBe(ZERO)
    })
  })

  describe('driven by an INPUT_SIGNAL and go()', () => {
    // A: 1 @0, 0 @30, 1 @50, 0 @70, 1 @90. Rising edges at 20, 40, 60, 80.
    //  t=20: A=1 -> S1;  t=30: A=0 (row 3);  t=40: -> S2;  t=50: A=1 -> Det=1 (Mealy)
    //  t=60: -> S1, Det=0;  t=70: A=0;  t=80: -> S2;  t=90: A=1 -> Det=1.  go() stops at 95.
    const signal: SignalRow[] = [
      { timeNs: 0, value: ONE },
      { timeNs: 30, value: ZERO },
      { timeNs: 50, value: ONE },
      { timeNs: 70, value: ZERO },
      { timeNs: 90, value: ONE }
    ]
    const build = (): SmCircuit =>
      new SmCircuit({ inputs: ['A'], outputs: ['Det'], table: DETECTOR, clk: 'clock', signals: { A: signal } })

    it('go() runs to 95 ns and ends in state 2 with Det=1', () => {
      const m = build()
      m.c.go()
      expect(m.c.time).toBe(95)
      expect(m.state).toBe('2')
      expect(m.out('Det')).toBe(ONE)
      expect(m.active).toBe(5)
    })

    it('the Det probe waveform pulses for one clock period at 51..61 ns and rises again at 91 ns', () => {
      const m = build()
      m.c.go()
      const trace = m.c.sim.getWaveforms().find((w) => w.probeId === 'P_Det')
      expect(trace).toBeDefined()
      const samples = trace!.samples.map((s) => `${s.t}:${s.v}`)
      expect(samples).toEqual(['0:0', '51:1', '61:0', '91:1'])
    })

    it('never oscillates', () => {
      const m = build()
      m.c.go()
      expect(m.c.oscillated).toBe(false)
    })

    it('a constant-1 input never detects (state parks in 1)', () => {
      const m = new SmCircuit({
        inputs: ['A'],
        outputs: ['Det'],
        table: DETECTOR,
        clk: 'clock',
        signals: { A: [{ timeNs: 0, value: ONE }] }
      })
      m.c.go()
      expect(m.state).toBe('1')
      expect(m.out('Det')).toBe(ZERO)
      const trace = m.c.sim.getWaveforms().find((w) => w.probeId === 'P_Det')!
      expect(trace.samples.every((s) => s.v === ZERO)).toBe(true)
    })
  })
})

// ===========================================================================
// smLabelMaps: agreement with the drawn part (implementation decision 10)
// ===========================================================================

describe('smLabelMaps: agreement with the part definition', () => {
  const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']

  function pinNames(comp: Component, role: 'input' | 'output'): string[] {
    return defOf(comp)
      .pins.filter((pin) => pin.role === role)
      .map((pin) => pin.name)
  }

  it('with smInputs/smOutputs absent it maps exactly the 4 + 4 pins the drawn part has', () => {
    const comp = smComponent({ inputs: LETTERS, outputs: LETTERS, smInputs: null, smOutputs: null })
    const { inputs, outputs } = smLabelMaps(comp)
    expect([...inputs.values()]).toEqual(pinNames(comp, 'input'))
    expect([...outputs.values()]).toEqual(pinNames(comp, 'output'))
    expect([...inputs.values()]).toEqual(['in1', 'in2', 'in3', 'in4'])
    expect([...outputs.values()]).toEqual(['out1', 'out2', 'out3', 'out4'])
  })

  it.each([1, 2, 3, 5, 8])('maps exactly the pins of a part with %i inputs and outputs', (n) => {
    const comp = smComponent({ inputs: LETTERS, outputs: LETTERS, smInputs: n, smOutputs: n })
    const { inputs, outputs } = smLabelMaps(comp)
    expect([...inputs.values()]).toEqual(pinNames(comp, 'input'))
    expect([...outputs.values()]).toEqual(pinNames(comp, 'output'))
    expect(inputs.size).toBe(n)
    expect(outputs.size).toBe(n)
  })

  it('clamps counts above 8 to the 8 pins the part actually has', () => {
    const comp = smComponent({ inputs: LETTERS, outputs: LETTERS, smInputs: 10, smOutputs: 10 })
    const { inputs, outputs } = smLabelMaps(comp)
    expect([...inputs.values()]).toEqual(pinNames(comp, 'input'))
    expect([...outputs.values()]).toEqual(pinNames(comp, 'output'))
    expect(inputs.size).toBe(8)
    expect(inputs.has('I')).toBe(false)
    expect(outputs.has('J')).toBe(false)
  })

  it('clamps counts below 1 to the single pin the part actually has', () => {
    const comp = smComponent({ inputs: ['A', 'B'], outputs: ['Y', 'W'], smInputs: 0, smOutputs: 0 })
    const { inputs, outputs } = smLabelMaps(comp)
    expect([...inputs.entries()]).toEqual([['A', 'in1']])
    expect([...outputs.entries()]).toEqual([['Y', 'out1']])
    expect([...inputs.values()]).toEqual(pinNames(comp, 'input'))
    expect([...outputs.values()]).toEqual(pinNames(comp, 'output'))
  })
})

// ===========================================================================
// STATE_MACHINE with the default pin counts, inside the Simulator
// ===========================================================================

describe('STATE_MACHINE with default pin counts (no smInputs/smOutputs)', () => {
  it('has 4 inputs and 4 outputs and the table may use the 4th of each', () => {
    const b = new CircuitBuilder()
    b.add('sm', ComponentType.STATE_MACHINE, {
      pinLabels: { in1: 'A', in2: 'B', in3: 'C', in4: 'D', out1: 'Y1', out2: 'Y2', out3: 'Y3', out4: 'Y4' },
      smTable: [row('0', 'D', 'Y4', '1'), row('0', "D'", 'Y1', '0'), row('1', '-', 'Y2 Y3', '0')]
    })
    b.switch('d', ZERO)
    b.wire(p('d', 'out'), p('sm', 'in4'))
    b.switch('clk', ZERO)
    b.wire(p('clk', 'out'), p('sm', 'CLK'))
    for (let i = 1; i <= 4; i++) {
      b.probe(`y${i}`)
      b.wire(p('sm', `out${i}`), p(`y${i}`, 'in'))
    }
    const c = b.build()
    const outs = (): string => [1, 2, 3, 4].map((i) => c.pin(p(`y${i}`, 'in'))).join('')

    expect(c.sim.getSmActive()['sm']).toBe(1)
    expect(outs()).toBe('1000')
    c.set('d', ONE)
    expect(c.sim.getSmActive()['sm']).toBe(0)
    expect(outs()).toBe('0001')
    c.pulse('clk')
    expect(c.sim.getSmDisplays()[p('sm', 'state')]).toBe('1')
    expect(outs()).toBe('0110')
  })

  it('a maximum-size 8 x 8 machine drives all eight outputs from a row over all eight inputs', () => {
    const ins = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
    const outs = ['O1', 'O2', 'O3', 'O4', 'O5', 'O6', 'O7', 'O8']
    const m = new SmCircuit({
      inputs: ins,
      outputs: outs,
      table: [row('0', 'A B C D E F G H', outs.join(' '), '1'), row('0', '-', '0', '0'), row('1', '-', 'O8', '1')],
      initial: Object.fromEntries(ins.map((l) => [l, ONE]))
    })
    expect(m.active).toBe(0)
    expect(m.outs()).toEqual(m.only(...outs))
    m.set('H', ZERO)
    expect(m.active).toBe(1)
    expect(m.outs()).toEqual(m.only())
    m.set('H', ONE)
    m.clock()
    expect(m.state).toBe('1')
    expect(m.outs()).toEqual(m.only('O8'))
  })
})

// ===========================================================================
// Same-instant input and CLK changes (implementation decision 1)
// ===========================================================================

describe('STATE_MACHINE: an input changing at the very instant of the rising edge is sampled as its new value', () => {
  it('St and CLK switches flipped together: the edge sees St=1 and moves S0 -> S1', () => {
    const m = multiplier()
    m.setMany({ St: ONE, clk: ONE })
    expect(m.state).toBe('1')
    expect(m.outs()).toEqual(m.only('Sh'))
  })

  it('St dropped together with the CLK edge: the edge sees St=0 and stays in S0', () => {
    const m = multiplier({ initial: { St: ONE } })
    m.setMany({ St: ZERO, clk: ONE })
    expect(m.state).toBe('0')
    expect(m.outs()).toEqual(m.only())
  })

  it('K raised together with the CLK edge in S2 takes the K row (S2 -> S3)', () => {
    const m = multiplier({ initial: { St: ONE, M: ONE } })
    m.clock()
    m.clock()
    expect(m.state).toBe('2')
    m.setMany({ K: ONE, clk: ONE })
    expect(m.state).toBe('3')
  })

  const DETECTOR: SmRow[] = [
    row('0', "A'", '0', '0'),
    row('0', 'A', '0', '1'),
    row('1', 'A', '0', '1'),
    row('1', "A'", '0', '2'),
    row('2', "A'", '0', '0'),
    row('2', 'A', 'Det', '1')
  ]

  it('an INPUT_SIGNAL row at exactly the clock edge (t=20) is captured by that edge', () => {
    const m = new SmCircuit({
      inputs: ['A'],
      outputs: ['Det'],
      table: DETECTOR,
      clk: 'clock',
      signals: { A: [{ timeNs: 0, value: ZERO }, { timeNs: 20, value: ONE }] }
    })
    m.c.step() // 15
    expect(m.state).toBe('0')
    m.c.step() // 35: edge at 20 with A becoming 1 at 20
    expect(m.c.time).toBe(35)
    expect(m.state).toBe('1')
  })

  it('an INPUT_SIGNAL dropping at exactly the clock edge (t=20) is seen as 0 by that edge', () => {
    const m = new SmCircuit({
      inputs: ['A'],
      outputs: ['Det'],
      table: DETECTOR,
      clk: 'clock',
      signals: { A: [{ timeNs: 0, value: ONE }, { timeNs: 20, value: ZERO }] }
    })
    m.c.step()
    m.c.step()
    expect(m.state).toBe('0')
  })
})

// ===========================================================================
// What counts as a rising edge on CLK
// ===========================================================================

describe('STATE_MACHINE: only a 0 -> 1 transition on CLK is a rising edge', () => {
  // A free-running 3-state ring (all rows don't-care) so every edge is visible.
  const RING: SmRow[] = [row('0', '-', '0', '1'), row('1', '-', '0', '2'), row('2', '-', 'Y', '0')]

  /** Adds the ring machine 'sm' (input unconnected) to a builder. */
  function addRing(b: CircuitBuilder): void {
    b.add('sm', ComponentType.STATE_MACHINE, {
      smInputs: 1,
      smOutputs: 1,
      smTable: RING,
      pinLabels: { in1: 'A', out1: 'Y' }
    })
  }
  const stateOf = (c: Circuit): string => c.sim.getSmDisplays()[p('sm', 'state')]

  it('a proper 0 -> 1 -> 0 -> 1 sequence on a switch advances one state per rising edge', () => {
    const b = new CircuitBuilder()
    addRing(b)
    b.switch('clk', ZERO)
    b.wire(p('clk', 'out'), p('sm', 'CLK'))
    const c = b.build()
    expect(stateOf(c)).toBe('0')
    c.rise('clk')
    expect(stateOf(c)).toBe('1')
    c.fall('clk')
    expect(stateOf(c)).toBe('1')
    c.rise('clk')
    expect(stateOf(c)).toBe('2')
    expect(c.pin(p('sm', 'out1'))).toBe(ONE)
    c.fall('clk')
    c.rise('clk')
    expect(stateOf(c)).toBe('0')
  })

  it('0 -> X -> 0 -> X on CLK (AND with a floating input) never advances the state', () => {
    const b = new CircuitBuilder()
    b.switch('clk', ZERO)
    b.add('g', ComponentType.AND2)
    addRing(b)
    b.wire(p('clk', 'out'), p('g', 'in1'))
    b.wire(p('g', 'out'), p('sm', 'CLK'))
    const c = b.build()
    expect(c.pin(p('sm', 'CLK'))).toBe(ZERO)
    for (let i = 0; i < 3; i++) {
      c.set('clk', ONE)
      expect(c.pin(p('sm', 'CLK'))).toBe(X)
      expect(stateOf(c)).toBe('0')
      c.set('clk', ZERO)
      expect(c.pin(p('sm', 'CLK'))).toBe(ZERO)
      expect(stateOf(c)).toBe('0')
    }
  })

  it('1 -> X -> 1 on CLK (OR with a floating input) is not a rising edge', () => {
    const b = new CircuitBuilder()
    b.switch('clk', ONE)
    b.add('g', ComponentType.OR2)
    addRing(b)
    b.wire(p('clk', 'out'), p('g', 'in1'))
    b.wire(p('g', 'out'), p('sm', 'CLK'))
    const c = b.build()
    expect(c.pin(p('sm', 'CLK'))).toBe(ONE)
    expect(stateOf(c)).toBe('0')
    c.set('clk', ZERO)
    expect(c.pin(p('sm', 'CLK'))).toBe(X)
    expect(stateOf(c)).toBe('0')
    c.set('clk', ONE)
    expect(c.pin(p('sm', 'CLK'))).toBe(ONE)
    expect(stateOf(c)).toBe('0')
  })

  it('Z -> 1 on CLK (tristate enabled onto a released net) is not a rising edge; a later 0 -> 1 is', () => {
    const b = new CircuitBuilder()
    b.switch('d', ONE) // data into the tristate
    b.switch('en', ZERO) // tristate control
    b.add('ts', ComponentType.TRISTATE_RIGHT)
    addRing(b)
    b.wire(p('d', 'out'), p('ts', 'in'))
    b.wire(p('en', 'out'), p('ts', 'ctl'))
    b.wire(p('ts', 'out'), p('sm', 'CLK'))
    const c = b.build()
    expect(c.pin(p('sm', 'CLK'))).toBe(Z)
    expect(stateOf(c)).toBe('0')

    c.set('en', ONE) // Z -> 1
    expect(c.pin(p('sm', 'CLK'))).toBe(ONE)
    expect(stateOf(c)).toBe('0')
    c.set('en', ZERO) // 1 -> Z
    c.set('en', ONE) // Z -> 1 again
    expect(stateOf(c)).toBe('0')

    c.set('d', ZERO) // 1 -> 0
    expect(c.pin(p('sm', 'CLK'))).toBe(ZERO)
    expect(stateOf(c)).toBe('0')
    c.set('d', ONE) // 0 -> 1: a real rising edge
    expect(stateOf(c)).toBe('1')
  })

  it('a machine whose rows are all don’t-care runs with its input unconnected', () => {
    const m = new SmCircuit({ inputs: ['A'], outputs: ['Y'], table: RING, floating: ['A'] })
    expect(m.state).toBe('0')
    expect(m.out('Y')).toBe(ZERO)
    m.clock()
    expect(m.state).toBe('1')
    expect(m.out('Y')).toBe(ZERO)
    m.clock()
    expect(m.state).toBe('2')
    expect(m.out('Y')).toBe(ONE)
    m.clock()
    expect(m.state).toBe('0')
    expect(m.out('Y')).toBe(ZERO)
  })

  it('with CLK initially 1, the first rising edge after a fall advances the state', () => {
    const m = multiplier({ initial: { St: ONE, clk: ONE } })
    m.fall()
    expect(m.state).toBe('0')
    m.rise()
    expect(m.state).toBe('1')
  })

  it('a rising edge with no matching row leaves the state unchanged (and a later match advances it)', () => {
    const table = [row('0', 'A', 'P', '1'), row('1', '-', '0', '1')]
    const m = new SmCircuit({ inputs: ['A'], outputs: ['P'], table })
    expect(m.active).toBeNull()
    m.clock()
    expect(m.state).toBe('0')
    m.set('A', ONE)
    m.clock()
    expect(m.state).toBe('1')
  })
})

// ===========================================================================
// Output delay (implementation decision 2: inertial delay)
// ===========================================================================

describe('STATE_MACHINE: output delay', () => {
  const FOLLOW: SmRow[] = [row('0', 'A', 'P', '0'), row('0', "A'", '0', '0')]

  function follower(delay: number, signal: SignalRow[]): SmCircuit {
    return new SmCircuit({ inputs: ['A'], outputs: ['P'], table: FOLLOW, clk: 'none', signals: { A: signal }, delay })
  }
  const trace = (m: SmCircuit): string[] =>
    m.c.sim
      .getWaveforms()
      .find((w) => w.probeId === 'P_P')!
      .samples.map((s) => `${s.t}:${s.v}`)

  it('with the default delay the output changes 1 ns after the input', () => {
    const m = new SmCircuit({
      inputs: ['A'],
      outputs: ['P'],
      table: FOLLOW,
      clk: 'none',
      signals: { A: [{ timeNs: 0, value: ZERO }, { timeNs: 10, value: ONE }, { timeNs: 40, value: ZERO }] }
    })
    m.c.go() // no clock: runs to now + simTimeNs = 100
    expect(m.c.time).toBe(100)
    expect(trace(m)).toEqual(['0:0', '11:1', '41:0'])
  })

  it('with delay 5 the output changes 5 ns after the input', () => {
    const m = follower(5, [{ timeNs: 0, value: ZERO }, { timeNs: 10, value: ONE }, { timeNs: 40, value: ZERO }])
    m.c.go()
    expect(trace(m)).toEqual(['0:0', '15:1', '45:0'])
    expect(m.out('P')).toBe(ZERO)
  })

  it('an input pulse shorter than the delay never reaches the output (inertial)', () => {
    const m = follower(5, [{ timeNs: 0, value: ZERO }, { timeNs: 10, value: ONE }, { timeNs: 12, value: ZERO }])
    m.c.go()
    expect(trace(m)).toEqual(['0:0'])
  })

  it('an input pulse equal to the delay does reach the output', () => {
    const m = follower(5, [{ timeNs: 0, value: ZERO }, { timeNs: 10, value: ONE }, { timeNs: 15, value: ZERO }])
    m.c.go()
    expect(trace(m)).toEqual(['0:0', '15:1', '20:0'])
  })

  it('a switch change is visible on the output after the switch and part delays', () => {
    const m = new SmCircuit({ inputs: ['A'], outputs: ['P'], table: FOLLOW, clk: 'none', delay: 3 })
    expect(m.c.time).toBe(0)
    m.set('A', ONE) // switch output at 1, SM output at 1 + 3
    expect(m.out('P')).toBe(ONE)
    expect(trace(m)).toEqual(['0:0', '4:1'])
  })

  it('the state display changes at the edge itself; the outputs follow after the delay', () => {
    const DETECTOR: SmRow[] = [
      row('0', "A'", '0', '0'),
      row('0', 'A', '0', '1'),
      row('1', 'A', '0', '1'),
      row('1', "A'", '0', '2'),
      row('2', "A'", '0', '0'),
      row('2', 'A', 'Det', '1')
    ]
    // A: 1@0, 0@30, 1@50 -> Det=1 (Mealy) at 50 + 3; edge at 60 -> S1, Det=0 at 63.
    const m = new SmCircuit({
      inputs: ['A'],
      outputs: ['Det'],
      table: DETECTOR,
      clk: 'clock',
      delay: 3,
      signals: { A: [{ timeNs: 0, value: ONE }, { timeNs: 30, value: ZERO }, { timeNs: 50, value: ONE }] }
    })
    m.c.step() // 15
    m.c.step() // 35 -> state 1 at 20
    m.c.step() // 55 -> state 2 at 40; Det rises at 53
    expect(m.state).toBe('2')
    expect(m.out('Det')).toBe(ONE)
    m.c.step() // 75 -> state 1 at 60; Det falls at 63
    expect(m.state).toBe('1')
    const samples = m.c.sim
      .getWaveforms()
      .find((w) => w.probeId === 'P_Det')!
      .samples.map((s) => `${s.t}:${s.v}`)
    expect(samples).toEqual(['0:0', '53:1', '63:0'])
  })
})

// ===========================================================================
// Composition with other parts / wiring styles
// ===========================================================================

describe('STATE_MACHINE: composed with other parts', () => {
  const SM_LABELS = { in1: 'St', in2: 'K', in3: 'M', out1: 'Load', out2: 'Sh', out3: 'Ad', out4: 'Done' }

  it('inputs and outputs connected by pin labels (the manual’s labeling tool) behave like wired ones', () => {
    const b = new CircuitBuilder()
    b.add('sm', ComponentType.STATE_MACHINE, { smInputs: 3, smOutputs: 4, smTable: MULT_TABLE, pinLabels: SM_LABELS })
    b.switch('st', ZERO)
    b.label(p('st', 'out'), 'St')
    b.switch('k', ZERO)
    b.label(p('k', 'out'), 'K')
    b.switch('mm', ZERO)
    b.label(p('mm', 'out'), 'M')
    b.switch('clk', ZERO)
    b.wire(p('clk', 'out'), p('sm', 'CLK'))
    b.probe('load')
    b.label(p('load', 'in'), 'Load')
    b.probe('sh')
    b.label(p('sh', 'in'), 'Sh')
    b.probe('done')
    b.label(p('done', 'in'), 'Done')
    const c = b.build()
    const state = (): string => c.sim.getSmDisplays()[p('sm', 'state')]

    expect(c.pin(p('sm', 'in1'))).toBe(ZERO)
    expect(c.pin(p('load', 'in'))).toBe(ZERO)
    c.set('st', ONE)
    expect(c.pin(p('load', 'in'))).toBe(ONE)
    c.pulse('clk')
    expect(state()).toBe('1')
    expect(c.pin(p('load', 'in'))).toBe(ZERO)
    expect(c.pin(p('sh', 'in'))).toBe(ONE)
    c.set('k', ONE) // K M' -> S3
    c.pulse('clk')
    expect(state()).toBe('3')
    expect(c.pin(p('done', 'in'))).toBe(ONE)
    expect(c.pin(p('sh', 'in'))).toBe(ZERO)
  })

  it('an SM output drives an ordinary gate (Load through a NOT) with one more gate delay', () => {
    const b = new CircuitBuilder()
    b.add('sm', ComponentType.STATE_MACHINE, { smInputs: 3, smOutputs: 4, smTable: MULT_TABLE, pinLabels: SM_LABELS })
    b.switch('st', ZERO)
    b.wire(p('st', 'out'), p('sm', 'in1'))
    b.switch('k', ZERO)
    b.wire(p('k', 'out'), p('sm', 'in2'))
    b.switch('mm', ZERO)
    b.wire(p('mm', 'out'), p('sm', 'in3'))
    b.add('n', ComponentType.NOT)
    b.wire(p('sm', 'out1'), p('n', 'in1'))
    b.probe('nload')
    b.wire(p('n', 'out'), p('nload', 'in'))
    const c = b.build()
    expect(c.pin(p('nload', 'in'))).toBe(ONE)
    c.set('st', ONE)
    expect(c.pin(p('nload', 'in'))).toBe(ZERO)
    const samples = c.sim.getWaveforms()[0].samples.map((s) => `${s.t}:${s.v}`)
    // switch at 1, SM output at 2, NOT output at 3
    expect(samples).toEqual(['0:1', '3:0'])
  })

  it('an SM output can clock a D flip-flop (Done latches St)', () => {
    const b = new CircuitBuilder()
    b.add('sm', ComponentType.STATE_MACHINE, { smInputs: 3, smOutputs: 4, smTable: MULT_TABLE, pinLabels: SM_LABELS })
    b.switch('st', ONE)
    b.wire(p('st', 'out'), p('sm', 'in1'))
    b.switch('k', ONE)
    b.wire(p('k', 'out'), p('sm', 'in2'))
    b.switch('mm', ZERO)
    b.wire(p('mm', 'out'), p('sm', 'in3'))
    b.switch('clk', ZERO)
    b.wire(p('clk', 'out'), p('sm', 'CLK'))
    b.add('ff', ComponentType.D_FLIPFLOP)
    b.add('vcc', ComponentType.VCC)
    b.wire(p('vcc', 'out'), p('ff', 'S'))
    b.wire(p('vcc', 'out'), p('ff', 'R'))
    b.wire(p('st', 'out'), p('ff', 'D'))
    b.wire(p('sm', 'out4'), p('ff', 'CLK'))
    const c = b.build()
    expect(c.pin(p('ff', 'Q'))).toBe(X)
    c.pulse('clk') // S1 (K=1, M=0 -> row 2 -> S3)
    c.pulse('clk') // S3: Done rises -> FF clocks D=1
    expect(c.sim.getSmDisplays()[p('sm', 'state')]).toBe('3')
    expect(c.pin(p('sm', 'out4'))).toBe(ONE)
    expect(c.pin(p('ff', 'Q'))).toBe(ONE)
  })

  it('an unlabeled output pin is 0 whenever a row is active and X otherwise', () => {
    const b = new CircuitBuilder()
    b.add('sm', ComponentType.STATE_MACHINE, {
      smInputs: 1,
      smOutputs: 2,
      pinLabels: { in1: 'A', out1: 'P' },
      smTable: [row('0', 'A', 'P', '0')]
    })
    b.switch('a', ONE)
    b.wire(p('a', 'out'), p('sm', 'in1'))
    b.probe('p1')
    b.wire(p('sm', 'out1'), p('p1', 'in'))
    b.probe('p2')
    b.wire(p('sm', 'out2'), p('p2', 'in'))
    const c = b.build()
    expect(c.pin(p('p1', 'in'))).toBe(ONE)
    expect(c.pin(p('p2', 'in'))).toBe(ZERO)
    c.set('a', ZERO)
    expect(c.pin(p('p1', 'in'))).toBe(X)
    expect(c.pin(p('p2', 'in'))).toBe(X)
  })

  it('an unlabeled, connected input pin has no effect on the machine', () => {
    const b = new CircuitBuilder()
    b.add('sm', ComponentType.STATE_MACHINE, {
      smInputs: 2,
      smOutputs: 1,
      pinLabels: { in1: 'A', out1: 'P' },
      smTable: [row('0', 'A', 'P', '0'), row('0', "A'", '0', '0')]
    })
    b.switch('a', ONE)
    b.wire(p('a', 'out'), p('sm', 'in1'))
    b.switch('junk', ZERO)
    b.wire(p('junk', 'out'), p('sm', 'in2'))
    const c = b.build()
    expect(c.pin(p('sm', 'out1'))).toBe(ONE)
    c.set('junk', ONE)
    expect(c.pin(p('sm', 'out1'))).toBe(ONE)
    expect(c.sim.getSmActive()['sm']).toBe(0)
  })
})

// ===========================================================================
// Empty / invalid tables
// ===========================================================================

describe('STATE_MACHINE: empty or invalid table', () => {
  it('an empty table: state 0, no active row, outputs X, and clocks do nothing', () => {
    const m = new SmCircuit({ inputs: ['A'], outputs: ['P'], table: [], initial: { A: ONE } })
    expect(m.state).toBe('0')
    expect(m.active).toBeNull()
    expect(m.outs()).toEqual(m.all(X))
    m.clock()
    expect(m.state).toBe('0')
    expect(m.outs()).toEqual(m.all(X))
  })

  it('a table of only empty rows behaves like an empty table', () => {
    const m = new SmCircuit({ inputs: ['A'], outputs: ['P'], table: [EMPTY_ROW, EMPTY_ROW] })
    expect(m.state).toBe('0')
    expect(m.active).toBeNull()
    expect(m.outs()).toEqual(m.all(X))
  })

  it('erroneous rows are dropped; the first VALID row decides the initial state', () => {
    const table = [row('S0', 'A', 'P', '1'), row('4', '-', 'P', '4')]
    const m = new SmCircuit({ inputs: ['A'], outputs: ['P'], table })
    expect(m.state).toBe('4')
    expect(m.active).toBe(1)
    expect(m.outs()).toEqual(m.only('P'))
  })

  it('a table of only erroneous rows behaves like an empty table', () => {
    const table = [row('S0', 'A', 'P', 'S1'), row('0', 'Nope', 'P', '0')]
    const m = new SmCircuit({ inputs: ['A'], outputs: ['P'], table, initial: { A: ONE } })
    expect(m.state).toBe('0')
    expect(m.active).toBeNull()
    expect(m.outs()).toEqual(m.all(X))
  })

  it('state numbers display as numbers ("010" shows as 10)', () => {
    const table = [row('0', '-', 'P', '010'), row('10', '-', '0', '0')]
    const m = new SmCircuit({ inputs: ['A'], outputs: ['P'], table })
    m.clock()
    expect(m.state).toBe('10')
    expect(m.active).toBe(1)
    m.clock()
    expect(m.state).toBe('0')
  })
})

// ===========================================================================
// Reset and repeated Go with the CLOCK part (implementation decisions 4 and 5)
// ===========================================================================

describe('STATE_MACHINE: reset and repeated Go with the CLOCK part', () => {
  const DETECTOR: SmRow[] = [
    row('0', "A'", '0', '0'),
    row('0', 'A', '0', '1'),
    row('1', 'A', '0', '1'),
    row('1', "A'", '0', '2'),
    row('2', "A'", '0', '0'),
    row('2', 'A', 'Det', '1')
  ]
  const signal: SignalRow[] = [
    { timeNs: 0, value: ONE },
    { timeNs: 30, value: ZERO },
    { timeNs: 50, value: ONE },
    { timeNs: 70, value: ZERO },
    { timeNs: 90, value: ONE }
  ]
  const build = (): SmCircuit =>
    new SmCircuit({ inputs: ['A'], outputs: ['Det'], table: DETECTOR, clk: 'clock', signals: { A: signal } })
  const detTrace = (m: SmCircuit): string[] =>
    m.c.sim
      .getWaveforms()
      .find((w) => w.probeId === 'P_Det')!
      .samples.map((s) => `${s.t}:${s.v}`)

  it('reset() returns to t=0 and the initial state, and the Det trace restarts with one sample', () => {
    const m = build()
    m.c.go()
    expect(m.state).toBe('2')
    m.c.reset()
    expect(m.c.time).toBe(0)
    expect(m.state).toBe('0')
    expect(m.active).toBe(1) // A=1 at t=0 -> row 1
    expect(m.out('Det')).toBe(ZERO)
    expect(detTrace(m)).toEqual(['0:0'])
  })

  it('after reset() the machine replays the same run', () => {
    const m = build()
    m.c.go()
    const first = detTrace(m)
    m.c.reset()
    m.c.go()
    expect(m.c.time).toBe(95)
    expect(m.state).toBe('2')
    expect(detTrace(m)).toEqual(first)
  })

  it('a second go() runs to 195 and keeps clocking (A held at 1 parks the machine in state 1)', () => {
    const m = build()
    m.c.go()
    m.c.go()
    expect(m.c.time).toBe(195)
    expect(m.state).toBe('1')
    expect(m.out('Det')).toBe(ZERO)
    // The edge at 100 leaves S2 for S1, so Det (1 since 91) drops at 101 and stays 0.
    expect(detTrace(m)).toEqual(['0:0', '51:1', '61:0', '91:1', '101:0'])
  })

  it('step() after go() continues one clock period at a time', () => {
    const m = build()
    m.c.go() // 95
    m.c.step()
    expect(m.c.time).toBe(115)
    expect(m.state).toBe('1')
  })
})

// ===========================================================================
// Falling-edge clock option: the state machine still changes on RISING edges
// ===========================================================================

describe('STATE_MACHINE: with a falling-edge clock the state still changes on rising edges', () => {
  // clockInitialValue ZERO: toggles at 10 (0->1), 20 (1->0), 30 (0->1), ...
  // Rising edges at 10, 30, 50, 70; Step ends a quarter period before each ACTIVE
  // (falling) edge: 15, 35, 55, 75.
  const DETECTOR: SmRow[] = [
    row('0', "A'", '0', '0'),
    row('0', 'A', '0', '1'),
    row('1', 'A', '0', '1'),
    row('1', "A'", '0', '2'),
    row('2', "A'", '0', '0'),
    row('2', 'A', 'Det', '1')
  ]

  it('the first Step already contains a rising edge (at 10 ns)', () => {
    const m = new SmCircuit({
      inputs: ['A'],
      outputs: ['Det'],
      table: DETECTOR,
      clk: 'clock',
      initial: { A: ONE },
      sim: { clockInitialValue: ZERO }
    })
    expect(m.c.pin(p('sm', 'CLK'))).toBe(ZERO)
    expect(m.state).toBe('0')
    m.c.step()
    expect(m.c.time).toBe(15)
    expect(m.state).toBe('1')
  })

  it('detects 1,0,1 using the rising edges at 30, 50 and 70', () => {
    const m = new SmCircuit({
      inputs: ['A'],
      outputs: ['Det'],
      table: DETECTOR,
      clk: 'clock',
      initial: { A: ONE },
      sim: { clockInitialValue: ZERO }
    })
    m.c.step() // 15: rose at 10 -> S1
    m.c.step() // 35: rose at 30, A=1 -> S1
    expect(m.state).toBe('1')
    m.set('A', ZERO)
    m.c.step() // 55: rose at 50, A=0 -> S2
    expect(m.state).toBe('2')
    m.set('A', ONE)
    expect(m.out('Det')).toBe(ONE)
    m.c.step() // 75: rose at 70 -> S1
    expect(m.state).toBe('1')
    expect(m.out('Det')).toBe(ZERO)
  })

  it('the falling edges (20, 40, ...) never change the state: a 3-state ring counts only the rising ones', () => {
    // Toggles at 10 (rise), 20 (fall), 30 (rise): two Steps (to 35) must advance the
    // ring exactly twice (state 2), not three times (which would wrap to state 0).
    const RING: SmRow[] = [row('0', '-', '0', '1'), row('1', '-', '0', '2'), row('2', '-', 'Y', '0')]
    const m = new SmCircuit({
      inputs: ['A'],
      outputs: ['Y'],
      table: RING,
      clk: 'clock',
      floating: ['A'],
      sim: { clockInitialValue: ZERO }
    })
    m.c.step()
    expect(m.c.time).toBe(15)
    expect(m.state).toBe('1')
    m.c.step()
    expect(m.c.time).toBe(35)
    expect(m.state).toBe('2')
    expect(m.out('Y')).toBe(ONE)
  })

  it('with the default rising-edge clock the same ring advances once per period (edges at 20, 40)', () => {
    const RING: SmRow[] = [row('0', '-', '0', '1'), row('1', '-', '0', '2'), row('2', '-', 'Y', '0')]
    const m = new SmCircuit({ inputs: ['A'], outputs: ['Y'], table: RING, clk: 'clock', floating: ['A'] })
    m.c.step() // 15: no edge yet
    expect(m.state).toBe('0')
    m.c.step() // 35: edge at 20
    expect(m.state).toBe('1')
    m.c.step() // 55: edge at 40
    expect(m.state).toBe('2')
    m.c.step() // 75: edge at 60
    expect(m.state).toBe('0')
  })
})

// ===========================================================================
// X -> 1 on CLK is not a rising edge (same rule as the flip-flops: previous 0, now 1)
// ===========================================================================

describe('STATE_MACHINE: 0 -> X -> 1 on CLK is not a rising edge', () => {
  const RING: SmRow[] = [row('0', '-', '0', '1'), row('1', '-', '0', '2'), row('2', '-', 'Y', '0')]

  it('CLK through a 2-input OR whose other input goes 0 -> Z -> 0: X -> 1 does not advance, a later 0 -> 1 does', () => {
    // OR(clk, en): en=0 -> out = clk; en floating (tristate off) -> out = X when clk=0, 1 when clk=1.
    const b = new CircuitBuilder()
    b.switch('clk', ZERO)
    b.switch('en', ZERO) // tristate control: 0 -> Z on the OR's second input
    b.switch('zero', ZERO) // tristate data
    b.add('ts', ComponentType.TRISTATE_RIGHT)
    b.add('g', ComponentType.OR2)
    b.add('sm', ComponentType.STATE_MACHINE, { smInputs: 1, smOutputs: 1, smTable: RING, pinLabels: { in1: 'A', out1: 'Y' } })
    b.wire(p('zero', 'out'), p('ts', 'in'))
    b.wire(p('en', 'out'), p('ts', 'ctl'))
    b.wire(p('clk', 'out'), p('g', 'in1'))
    b.wire(p('ts', 'out'), p('g', 'in2'))
    b.wire(p('g', 'out'), p('sm', 'CLK'))
    const c = b.build()
    const state = (): string => c.sim.getSmDisplays()[p('sm', 'state')]

    // OR(0, Z) = X at reset.
    expect(c.pin(p('sm', 'CLK'))).toBe(X)
    expect(state()).toBe('0')
    c.set('clk', ONE) // X -> 1: not a rising edge
    expect(c.pin(p('sm', 'CLK'))).toBe(ONE)
    expect(state()).toBe('0')
    c.set('clk', ZERO) // 1 -> X
    expect(c.pin(p('sm', 'CLK'))).toBe(X)
    expect(state()).toBe('0')

    c.set('en', ONE) // second input becomes a clean 0: CLK = X -> 0
    expect(c.pin(p('sm', 'CLK'))).toBe(ZERO)
    expect(state()).toBe('0')
    c.set('clk', ONE) // a real 0 -> 1
    expect(state()).toBe('1')
    c.set('clk', ZERO)
    c.set('clk', ONE)
    expect(state()).toBe('2')
  })
})

// ===========================================================================
// termsMatch: a literal that is definitely false ahead of an X literal
// ===========================================================================

describe('termsMatch: a definite mismatch before an unresolved literal', () => {
  it("A B with A=0, B=X does not match (false, not null)", () => {
    expect(termsMatch([term('in1'), term('in2')], pins({ in1: ZERO, in2: X }))).toBe(false)
  })

  it("A' B with A=1, B=Z does not match (false, not null)", () => {
    expect(termsMatch([term('in1', true), term('in2')], pins({ in1: ONE, in2: Z }))).toBe(false)
  })

  it('through the Simulator: row "A B" with A=0 and B=X is skipped and a later don’t-care row is active', () => {
    const table = [row('0', 'A B', 'P', '1'), row('0', '-', 'Q', '0')]
    const m = new SmCircuit({
      inputs: ['A', 'B'],
      outputs: ['P', 'Q'],
      table,
      xSource: { B: 'and' },
      initial: { B: ONE }
    })
    expect(m.c.pin(p('sm', 'in1'))).toBe(ZERO)
    expect(m.c.pin(p('sm', 'in2'))).toBe(X)
    expect(m.active).toBe(1)
    expect(m.outs()).toEqual(m.only('Q'))
    m.clock()
    expect(m.state).toBe('0')
  })

  it('through the Simulator: row "B A" (X literal first) with A=0 and B=X is likewise skipped for the later don’t-care row', () => {
    const table = [row('0', 'B A', 'P', '1'), row('0', '-', 'Q', '0')]
    const m = new SmCircuit({
      inputs: ['A', 'B'],
      outputs: ['P', 'Q'],
      table,
      xSource: { B: 'and' },
      initial: { B: ONE }
    })
    expect(m.c.pin(p('sm', 'in2'))).toBe(X)
    expect(m.active).toBe(1)
    expect(m.outs()).toEqual(m.only('Q'))
  })
})

// ===========================================================================
// Several state machines in one circuit
// ===========================================================================

describe('STATE_MACHINE: several machines in one circuit', () => {
  const TOGGLE: SmRow[] = [row('0', '-', 'Y', '1'), row('1', '-', '0', '0')]
  // Counts the rising edges at which its input is 1; P=1 once two were seen.
  const COUNT2: SmRow[] = [
    row('0', 'Y', '0', '1'),
    row('0', "Y'", '0', '0'),
    row('1', 'Y', '0', '2'),
    row('1', "Y'", '0', '1'),
    row('2', '-', 'P', '2')
  ]

  function twoMachines(): Circuit {
    const b = new CircuitBuilder()
    b.add('sm1', ComponentType.STATE_MACHINE, { smInputs: 1, smOutputs: 1, smTable: TOGGLE, pinLabels: { in1: 'A', out1: 'Y' } })
    b.add('sm2', ComponentType.STATE_MACHINE, { smInputs: 1, smOutputs: 1, smTable: COUNT2, pinLabels: { in1: 'Y', out1: 'P' } })
    b.switch('clk', ZERO)
    b.wire(p('clk', 'out'), p('sm1', 'CLK'))
    b.wire(p('clk', 'out'), p('sm2', 'CLK'))
    b.wire(p('sm1', 'out1'), p('sm2', 'in1'))
    b.probe('py')
    b.wire(p('sm1', 'out1'), p('py', 'in'))
    b.probe('pp')
    b.wire(p('sm2', 'out1'), p('pp', 'in'))
    return b.build()
  }
  const state = (c: Circuit, id: string): string => c.sim.getSmDisplays()[p(id, 'state')]

  it('getSmDisplays() and getSmActive() report each machine under its own key', () => {
    const c = twoMachines()
    expect(c.sim.getSmDisplays()).toEqual({ [p('sm1', 'state')]: '0', [p('sm2', 'state')]: '0' })
    expect(c.sim.getSmActive()).toEqual({ sm1: 0, sm2: 0 })
  })

  it('a machine fed by another machine’s output samples the OLD output on a shared clock edge', () => {
    const c = twoMachines()
    expect(c.pin(p('py', 'in'))).toBe(ONE) // sm1 in state 0 -> Y=1
    expect(c.pin(p('pp', 'in'))).toBe(ZERO)

    c.pulse('clk') // sm1 -> 1 (Y drops 1 ns later); sm2 saw Y=1 -> 1
    expect(state(c, 'sm1')).toBe('1')
    expect(c.pin(p('py', 'in'))).toBe(ZERO)
    expect(state(c, 'sm2')).toBe('1')
    expect(c.sim.getSmActive()).toEqual({ sm1: 1, sm2: 3 })

    c.pulse('clk') // sm1 -> 0 (Y rises); sm2 saw Y=0 -> stays 1
    expect(state(c, 'sm1')).toBe('0')
    expect(c.pin(p('py', 'in'))).toBe(ONE)
    expect(state(c, 'sm2')).toBe('1')

    c.pulse('clk') // sm2 saw Y=1 -> 2, P=1
    expect(state(c, 'sm2')).toBe('2')
    expect(c.pin(p('pp', 'in'))).toBe(ONE)
    expect(c.sim.getSmActive()['sm2']).toBe(4)
  })

  it('Y toggles once per edge and P rises one part delay after the third edge', () => {
    const c = twoMachines()
    c.pulse('clk')
    c.pulse('clk')
    c.pulse('clk')
    const traces = Object.fromEntries(
      c.sim.getWaveforms().map((w) => [w.probeId, w.samples.map((s) => `${s.t}:${s.v}`)])
    )
    // Switch delay 1 ns; the circuit settles after every toggle, so time advances by
    // the switch delay plus the SM delay when an output changes: CLK rises at 1
    // (Y falls at 2), the fall lands at 3, the next rise at 4 (Y rises at 5), the
    // fall at 6, the third rise at 7 (Y falls and P rises at 8).
    expect(traces['py']).toEqual(['0:1', '2:0', '5:1', '8:0'])
    expect(traces['pp']).toEqual(['0:0', '8:1'])
  })

  it('reset() restores both machines to their first rows', () => {
    const c = twoMachines()
    c.pulse('clk')
    c.pulse('clk')
    c.pulse('clk')
    expect(state(c, 'sm2')).toBe('2')
    c.reset()
    expect(c.sim.getSmDisplays()).toEqual({ [p('sm1', 'state')]: '0', [p('sm2', 'state')]: '0' })
    expect(c.pin(p('py', 'in'))).toBe(ONE)
    expect(c.pin(p('pp', 'in'))).toBe(ZERO)
  })
})
