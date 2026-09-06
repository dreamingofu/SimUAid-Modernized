// Cross-check of model/partDefinitions.ts against sim/engine.ts.
//
// Nothing here re-tests part behavior (the other files do that exhaustively).
// This file verifies the *contract* between the drawn part and the simulator:
//
//   1. every ComponentType, at every supported width, yields a well-formed
//      PartDefinition: unique pin names, valid roles, pins inside the footprint
//      and — the defect class that once shorted Lin against CLK on the
//      bidirectional shift register — no two pins on the same coordinate;
//   2. an explicit, literal table of which pin names the engine READS and WRITES
//      per ComponentType (derived by reading engine.ts / parts.ts), checked both
//      statically against the definition and dynamically against the running
//      Simulator, so an unread input or an unwritten output cannot slip through;
//   3. effectiveBits / getPartDefinition / smPinCounts clamping and caching;
//   4. registry coverage (every type is constructible and classified exactly
//      once) plus the label prefixes and titles the renderer relies on;
//   5. the part catalogue against the manual's Parts menu (§1.4, Appendix A).
//
// Vectors are LSB-first (pin i is bit i). Default part delay is 1 ns.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ComponentType,
  LogicValue,
  makePinId,
  parsePinId,
  type Component,
  type SmRow
} from '../../model/types'
import {
  DEFAULT_BITS,
  MAX_BITS,
  MAX_BUS_BITS,
  MIN_BITS,
  SM_DEFAULT_PINS,
  SM_MAX_PINS,
  SM_MIN_PINS,
  defOf,
  effectiveBits,
  getPartDefinition,
  isBusType,
  isNBitType,
  maxBitsFor,
  smPinCounts,
  type PartDefinition,
  type PinDef,
  type PinRole
} from '../../model/partDefinitions'
import { buildSimGraph } from '../graph'
import { Simulator } from '../engine'
import { CircuitBuilder, p, type Circuit } from './harness'

const { ZERO, ONE, X, Z } = LogicValue

const T = ComponentType

// ---------------------------------------------------------------------------
// Type groups and the widths every parameterized part is checked at
// ---------------------------------------------------------------------------

const ALL_TYPES: ComponentType[] = Object.values(ComponentType)

const GATE_TYPES: ComponentType[] = [
  T.AND2, T.AND3, T.AND4, T.AND5,
  T.OR2, T.OR3, T.OR4, T.OR5,
  T.NAND2, T.NAND3, T.NAND4, T.NAND5,
  T.NOR2, T.NOR3, T.NOR4, T.NOR5,
  T.XOR2, T.XNOR2, T.NOT
]

const GATE_ARITY: Record<string, number> = {
  [T.AND2]: 2, [T.AND3]: 3, [T.AND4]: 4, [T.AND5]: 5,
  [T.OR2]: 2, [T.OR3]: 3, [T.OR4]: 4, [T.OR5]: 5,
  [T.NAND2]: 2, [T.NAND3]: 3, [T.NAND4]: 4, [T.NAND5]: 5,
  [T.NOR2]: 2, [T.NOR3]: 3, [T.NOR4]: 4, [T.NOR5]: 5,
  [T.XOR2]: 2, [T.XNOR2]: 2, [T.NOT]: 1
}

/** N-bit parts: one pin per bit, widths MIN_BITS..MAX_BITS. */
const N_BIT_TYPES: ComponentType[] = [
  T.N_ADDER,
  T.N_COUNTER,
  T.N_LOADABLE_COUNTER,
  T.N_REGISTER,
  T.N_SHIFT_LEFT,
  T.N_SHIFT_RIGHT,
  T.N_SHIFT_BIDIR,
  T.N_MUX_2TO1,
  T.N_TRISTATE
]

/** Bus parts: a pin can carry a whole vector, widths up to MAX_BUS_BITS. */
const BUS_TYPES: ComponentType[] = [
  T.BUS_INPUT,
  T.BUS_PROBE,
  T.SPLITTER,
  T.MERGER,
  T.COMPLEMENTER,
  T.BUS_TAP
]

const FIXED_TYPES: ComponentType[] = ALL_TYPES.filter(
  (t) => !N_BIT_TYPES.includes(t) && !BUS_TYPES.includes(t) && t !== T.STATE_MACHINE
)

const N_BIT_WIDTHS = [2, 4, 16]
const BUS_WIDTHS = [2, 4, 16, 32]

/** (smInputs, smOutputs) pairs: the default, both extremes and a few mixes. */
const SM_SHAPES: [number | undefined, number | undefined][] = [
  [undefined, undefined],
  [1, 1],
  [1, 8],
  [8, 1],
  [8, 8],
  [4, 4],
  [2, 5],
  [6, 3],
  [3, 7]
]

interface PartCase {
  name: string
  type: ComponentType
  bits?: number
  smInputs?: number
  smOutputs?: number
  /** The effective data width the definition and the engine must agree on. */
  n: number
}

function caseOf(type: ComponentType, bits?: number, sm?: [number | undefined, number | undefined]): PartCase {
  if (type === T.STATE_MACHINE) {
    const [smInputs, smOutputs] = sm ?? [undefined, undefined]
    const { nIn, nOut } = smPinCounts({ smInputs, smOutputs })
    const asked = `${smInputs ?? 'default'}x${smOutputs ?? 'default'}`
    return { name: `STATE_MACHINE ${asked} -> ${nIn}in/${nOut}out`, type, smInputs, smOutputs, n: 0 }
  }
  const n = effectiveBits(type, bits)
  return { name: bits === undefined ? type : `${type} ${bits}-bit`, type, bits, n }
}

const ALL_CASES: PartCase[] = [
  ...FIXED_TYPES.map((t) => caseOf(t)),
  ...N_BIT_TYPES.flatMap((t) => N_BIT_WIDTHS.map((b) => caseOf(t, b))),
  ...BUS_TYPES.flatMap((t) => BUS_WIDTHS.map((b) => caseOf(t, b))),
  ...SM_SHAPES.map((s) => caseOf(T.STATE_MACHINE, undefined, s))
]

/** The AddOptions a PartCase turns into, so CircuitBuilder places it correctly. */
function optionsOf(c: PartCase, extra: Partial<Component> = {}): Partial<Component> {
  return {
    ...(c.bits !== undefined ? { bits: c.bits } : {}),
    ...(c.smInputs !== undefined ? { smInputs: c.smInputs } : {}),
    ...(c.smOutputs !== undefined ? { smOutputs: c.smOutputs } : {}),
    ...extra
  }
}

const defFor = (c: PartCase): PartDefinition =>
  defOf({ type: c.type, ...optionsOf(c) } as Pick<Component, 'type' | 'bits' | 'smInputs' | 'smOutputs'>)

const rng = (prefix: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`)

const sorted = (a: string[]): string[] => [...a].sort()

const VALID_ROLES: PinRole[] = ['input', 'output', 'clock', 'preset', 'clear']
const SINK_ROLES: PinRole[] = ['input', 'clock', 'preset', 'clear']

const sinkPins = (def: PartDefinition): PinDef[] => def.pins.filter((q) => q.role !== 'output')
const outPins = (def: PartDefinition): PinDef[] => def.pins.filter((q) => q.role === 'output')

// ---------------------------------------------------------------------------
// 1. Pin-definition invariants — every type, every supported width
// ---------------------------------------------------------------------------

describe('part definitions are well formed', () => {
  it.each(ALL_CASES.map((c) => [c.name, c] as const))('%s: defOf returns at least one pin', (_n, c) => {
    const def = defFor(c)
    expect(Array.isArray(def.pins)).toBe(true)
    expect(def.pins.length).toBeGreaterThan(0)
  })

  it.each(ALL_CASES.map((c) => [c.name, c] as const))('%s: footprint has a positive size', (_n, c) => {
    const def = defFor(c)
    expect(Number.isFinite(def.width)).toBe(true)
    expect(Number.isFinite(def.height)).toBe(true)
    expect(def.width).toBeGreaterThan(0)
    expect(def.height).toBeGreaterThan(0)
  })

  it.each(ALL_CASES.map((c) => [c.name, c] as const))('%s: pin names are unique', (_n, c) => {
    const names = defFor(c).pins.map((q) => q.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it.each(ALL_CASES.map((c) => [c.name, c] as const))('%s: every pin has a valid role', (_n, c) => {
    for (const q of defFor(c).pins) {
      expect(VALID_ROLES, `${c.name}#${q.name}`).toContain(q.role)
    }
  })

  it.each(ALL_CASES.map((c) => [c.name, c] as const))('%s: every pin lies inside the footprint', (_n, c) => {
    const def = defFor(c)
    for (const q of def.pins) {
      const where = `${c.name}#${q.name} at (${q.dx},${q.dy}) in ${def.width}x${def.height}`
      expect(q.dx, where).toBeGreaterThanOrEqual(0)
      expect(q.dx, where).toBeLessThanOrEqual(def.width)
      expect(q.dy, where).toBeGreaterThanOrEqual(0)
      expect(q.dy, where).toBeLessThanOrEqual(def.height)
    }
  })

  // The net resolver unions pins by coordinate, so two pins sharing (dx,dy) are
  // permanently shorted together (this is what shorted Lin against CLK on the
  // bidirectional shift register and Lin against CLK on the right shift register).
  it.each(ALL_CASES.map((c) => [c.name, c] as const))('%s: no two pins share a coordinate', (_n, c) => {
    const seen = new Map<string, string>()
    const collisions: string[] = []
    for (const q of defFor(c).pins) {
      const key = `${q.dx},${q.dy}`
      const other = seen.get(key)
      if (other !== undefined) collisions.push(`${other} and ${q.name} both at (${key})`)
      seen.set(key, q.name)
    }
    expect(collisions, `${c.name}: shorted pins`).toEqual([])
  })

  it.each(ALL_CASES.map((c) => [c.name, c] as const))('%s: bus pin widths equal the part width', (_n, c) => {
    for (const q of defFor(c).pins) {
      if (q.width === undefined) continue
      expect(q.width, `${c.name}#${q.name}`).toBe(c.n)
    }
  })

  it.each(ALL_CASES.map((c) => [c.name, c] as const))('%s: has at least one sink or source pin', (_n, c) => {
    const def = defFor(c)
    expect(sinkPins(def).length + outPins(def).length).toBe(def.pins.length)
  })

  // Pin ids are `${componentId}#${pinName}`, so a '#' inside a pin name would
  // make parsePinId (and therefore every engine lookup) split in the wrong place.
  it.each(ALL_CASES.map((c) => [c.name, c] as const))('%s: pin names round-trip through PinId', (_n, c) => {
    for (const q of defFor(c).pins) {
      expect(q.name, `${c.name}#${q.name}`).not.toContain('#')
      expect(q.name.length, `${c.name}: empty pin name`).toBeGreaterThan(0)
      const { componentId, pinName } = parsePinId(makePinId('comp1', q.name))
      expect(componentId).toBe('comp1')
      expect(pinName).toBe(q.name)
    }
  })

  it.each(ALL_CASES.map((c) => [c.name, c] as const))(
    '%s: getPinValues and getBusPinValues partition every declared pin',
    (_n, c) => {
      const circuit = new CircuitBuilder().add('u', c.type, optionsOf(c)).build()
      const single = circuit.sim.getPinValues()
      const bus = circuit.sim.getBusPinValues()
      for (const q of defFor(c).pins) {
        const id = p('u', q.name)
        const inSingle = id in single
        const inBus = id in bus
        expect([inSingle, inBus].filter(Boolean).length, `${c.name}#${q.name}`).toBe(1)
        expect(q.width !== undefined ? inBus : inSingle, `${c.name}#${q.name} width ${q.width}`).toBe(true)
      }
    }
  )

  it('every state-machine shape from 1x1 to 8x8 keeps its pins on distinct coordinates', () => {
    const collisions: string[] = []
    for (let nIn = SM_MIN_PINS; nIn <= SM_MAX_PINS; nIn++) {
      for (let nOut = SM_MIN_PINS; nOut <= SM_MAX_PINS; nOut++) {
        const def = defOf({ type: T.STATE_MACHINE, smInputs: nIn, smOutputs: nOut })
        const seen = new Set<string>()
        for (const q of def.pins) {
          const key = `${q.dx},${q.dy}`
          if (seen.has(key)) collisions.push(`SM ${nIn}x${nOut}: ${q.name} at (${key})`)
          seen.add(key)
        }
      }
    }
    expect(collisions).toEqual([])
  })

  it('every N-bit part keeps its pins distinct at every width in MIN_BITS..MAX_BITS', () => {
    const collisions: string[] = []
    for (const type of N_BIT_TYPES) {
      for (let n = MIN_BITS; n <= MAX_BITS; n++) {
        const def = getPartDefinition(type, n)
        const seen = new Set<string>()
        for (const q of def.pins) {
          const key = `${q.dx},${q.dy}`
          if (seen.has(key)) collisions.push(`${type} ${n}-bit: ${q.name} at (${key})`)
          seen.add(key)
        }
      }
    }
    expect(collisions).toEqual([])
  })

  it('every bus part keeps its pins distinct at every width in 1..MAX_BUS_BITS', () => {
    const collisions: string[] = []
    for (const type of BUS_TYPES) {
      for (let n = 1; n <= MAX_BUS_BITS; n++) {
        const def = getPartDefinition(type, n)
        const seen = new Set<string>()
        for (const q of def.pins) {
          const key = `${q.dx},${q.dy}`
          if (seen.has(key)) collisions.push(`${type} ${n}-bit: ${q.name} at (${key})`)
          seen.add(key)
        }
      }
    }
    expect(collisions).toEqual([])
  })

  // Decision 9 fixed the shift-register geometry; pin them down explicitly.
  it('right shift register puts Lin at (0,60) and CLK at (0,80) (decision 9)', () => {
    for (const n of N_BIT_WIDTHS) {
      const def = getPartDefinition(T.N_SHIFT_RIGHT, n)
      const at = (name: string): string => {
        const q = def.pins.find((r) => r.name === name)!
        return `${q.dx},${q.dy}`
      }
      expect(def.height, `${n}-bit`).toBe(100)
      expect(at('Lin'), `${n}-bit Lin`).toBe('0,60')
      expect(at('CLK'), `${n}-bit CLK`).toBe('0,80')
      expect(at('Ld'), `${n}-bit Ld`).toBe(`${def.width},20`)
      expect(at('CLR'), `${n}-bit CLR`).toBe(`${def.width},40`)
      expect(at('RS'), `${n}-bit RS`).toBe(`${def.width},60`)
    }
  })

  it('bidirectional shift register is 120 tall with Ld/CLR/LS/Lin/CLK at 20/40/60/80/100 (decision 9)', () => {
    for (const n of N_BIT_WIDTHS) {
      const def = getPartDefinition(T.N_SHIFT_BIDIR, n)
      const at = (name: string): string => {
        const q = def.pins.find((r) => r.name === name)!
        return `${q.dx},${q.dy}`
      }
      expect(def.height, `${n}-bit`).toBe(120)
      expect(at('Ld')).toBe('0,20')
      expect(at('CLR')).toBe('0,40')
      expect(at('LS')).toBe('0,60')
      expect(at('Lin')).toBe('0,80')
      expect(at('CLK')).toBe('0,100')
      expect(at('Rin')).toBe(`${def.width},40`)
      expect(at('RS')).toBe(`${def.width},60`)
    }
  })

  it('left shift register has Rin on the right edge and no Lin/RS', () => {
    for (const n of N_BIT_WIDTHS) {
      const def = getPartDefinition(T.N_SHIFT_LEFT, n)
      const names = def.pins.map((q) => q.name)
      expect(names).toContain('Rin')
      expect(names).not.toContain('Lin')
      expect(names).not.toContain('RS')
      expect(def.pins.find((q) => q.name === 'Rin')!.dx).toBe(def.width)
    }
  })

  it('right shift register has Lin on the left edge and no Rin/LS', () => {
    for (const n of N_BIT_WIDTHS) {
      const def = getPartDefinition(T.N_SHIFT_RIGHT, n)
      const names = def.pins.map((q) => q.name)
      expect(names).toContain('Lin')
      expect(names).not.toContain('Rin')
      expect(names).not.toContain('LS')
      expect(def.pins.find((q) => q.name === 'Lin')!.dx).toBe(0)
    }
  })
})

// ---------------------------------------------------------------------------
// 2. The engine's read/write contract, encoded literally
// ---------------------------------------------------------------------------

interface Contract {
  /** Pin names the engine consults while evaluating the part (readPin/readVec/readBus). */
  reads: (n: number) => string[]
  /** Pin names the engine drives through scheduleOutput / scheduleBusOutput. */
  writes: (n: number) => string[]
  /** Output pins driven directly by reset()/scheduleStimulus() rather than by an eval. */
  stimulus?: string[]
  /** Sink pins the engine exposes to the UI (getPinValues / probe traces) but never evaluates. */
  display?: string[]
  /**
   * Pin names the engine asks for that the definition does not declare. These
   * read back Z and their value is discarded, so they are harmless — but they are
   * listed so the cross-check stays exact.
   */
  absentReads?: string[]
}

const none = (): string[] => []

function gateContract(arity: number): Contract {
  return { reads: () => Array.from({ length: arity }, (_, i) => `in${i + 1}`), writes: () => ['out'] }
}

const CONTRACT: Record<string, Contract> = {
  // --- gates: engine reads comp.inputPinNames and writes 'out'
  ...Object.fromEntries(GATE_TYPES.map((t) => [t, gateContract(GATE_ARITY[t])])),

  // --- sources / sinks driven or displayed by the engine, never evaluated
  [T.SWITCH]: { reads: none, writes: () => ['out'] },
  [T.VCC]: { reads: none, writes: none, stimulus: ['out'] },
  [T.GROUND]: { reads: none, writes: none, stimulus: ['out'] },
  [T.CLOCK]: { reads: none, writes: none, stimulus: ['out'] },
  [T.INPUT_SIGNAL]: { reads: none, writes: none, stimulus: ['out'] },
  [T.BUS_INPUT]: { reads: none, writes: none, stimulus: ['out'] },
  [T.PROBE]: { reads: none, writes: none, display: ['in'] },
  [T.BUS_PROBE]: { reads: none, writes: none, display: ['in'] },
  [T.SEVEN_SEGMENT]: { reads: none, writes: none, display: ['1', '2', '3', '4', '5', '6', '7'] },
  [T.CHECKER]: { reads: () => ['in'], writes: none, stimulus: ['out'] },

  // --- flip-flops (logic.ts nextFlipFlopQ receives d/j/k eagerly)
  [T.D_FLIPFLOP]: { reads: () => ['CLK', 'S', 'R', 'D'], writes: () => ['Q', "Q'"], absentReads: ['J', 'K'] },
  [T.JK_FLIPFLOP]: { reads: () => ['CLK', 'S', 'R', 'J', 'K'], writes: () => ['Q', "Q'"], absentReads: ['D'] },

  // --- fixed combinational
  [T.FULL_ADDER]: { reads: () => ['X', 'Y', 'Cin'], writes: () => ['Sum', 'Cout'] },
  [T.DECODER_2TO4]: { reads: () => ['A', 'B'], writes: () => rng('out', 4) },
  [T.DECODER_3TO8]: { reads: () => ['A', 'B', 'C'], writes: () => rng('out', 8) },
  [T.MUX_2]: { reads: () => ['A', ...rng('in', 2)], writes: () => ['Z'] },
  [T.MUX_4]: { reads: () => ['A', 'B', ...rng('in', 4)], writes: () => ['Z'] },
  [T.MUX_8]: { reads: () => ['A', 'B', 'C', ...rng('in', 8)], writes: () => ['Z'] },
  [T.TRISTATE_RIGHT]: { reads: () => ['ctl', 'in'], writes: () => ['out'] },
  [T.TRISTATE_LEFT]: { reads: () => ['ctl', 'in'], writes: () => ['out'] },
  [T.TRISTATE_UP]: { reads: () => ['ctl', 'in'], writes: () => ['out'] },
  [T.TRISTATE_DOWN]: { reads: () => ['ctl', 'in'], writes: () => ['out'] },

  // --- N-bit
  [T.N_ADDER]: {
    reads: (n) => ['Cin', ...rng('X', n), ...rng('Y', n)],
    writes: (n) => ['Cout', ...rng('S', n)]
  },
  [T.N_COUNTER]: {
    reads: () => ['CLK', 'CLR', 'En'],
    writes: (n) => ['K', ...rng('Q', n)]
  },
  [T.N_LOADABLE_COUNTER]: {
    reads: (n) => ['CLK', 'CLR', 'Ld', 'En', ...rng('D', n)],
    writes: (n) => ['K', ...rng('Q', n)]
  },
  [T.N_REGISTER]: {
    reads: (n) => ['CLK', 'CLR', 'Ld', ...rng('D', n)],
    writes: (n) => rng('Q', n)
  },
  [T.N_SHIFT_LEFT]: {
    reads: (n) => ['CLK', 'CLR', 'Ld', 'LS', 'Rin', ...rng('D', n)],
    writes: (n) => rng('Q', n)
  },
  [T.N_SHIFT_RIGHT]: {
    reads: (n) => ['CLK', 'CLR', 'Ld', 'RS', 'Lin', ...rng('D', n)],
    writes: (n) => rng('Q', n)
  },
  [T.N_SHIFT_BIDIR]: {
    reads: (n) => ['CLK', 'CLR', 'Ld', 'LS', 'Rin', 'RS', 'Lin', ...rng('D', n)],
    writes: (n) => rng('Q', n)
  },
  [T.N_MUX_2TO1]: {
    reads: (n) => ['S', ...rng('X', n), ...rng('Y', n)],
    writes: (n) => rng('Z', n)
  },
  [T.N_TRISTATE]: {
    reads: (n) => ['ctl', ...rng('in', n)],
    writes: (n) => rng('out', n)
  },

  // --- bus
  [T.SPLITTER]: { reads: () => ['in'], writes: (n) => rng('out', n) },
  [T.MERGER]: { reads: (n) => rng('in', n), writes: () => ['out'] },
  [T.COMPLEMENTER]: { reads: () => ['en', 'in'], writes: () => ['out'] },
  [T.BUS_TAP]: { reads: () => ['in'], writes: () => ['out'] },

  // --- state machine (in1..inN are read through the compiled table's terms)
  [T.STATE_MACHINE]: { reads: none, writes: none }
}

function contractFor(c: PartCase): { reads: string[]; writes: string[]; contract: Contract } {
  if (c.type === T.STATE_MACHINE) {
    const { nIn, nOut } = smPinCounts({ smInputs: c.smInputs, smOutputs: c.smOutputs })
    return {
      contract: CONTRACT[T.STATE_MACHINE],
      reads: ['CLK', ...Array.from({ length: nIn }, (_, i) => `in${i + 1}`)],
      writes: Array.from({ length: nOut }, (_, i) => `out${i + 1}`)
    }
  }
  const contract = CONTRACT[c.type]
  return { contract, reads: contract.reads(c.n), writes: contract.writes(c.n) }
}

describe('every ComponentType has an engine read/write contract', () => {
  it('the contract table covers the whole ComponentType enum exactly once', () => {
    expect(sorted(Object.keys(CONTRACT))).toEqual(sorted(ALL_TYPES as string[]))
  })
})

describe('contract vs. definition (static)', () => {
  it.each(ALL_CASES.map((c) => [c.name, c] as const))(
    '%s: every pin the engine reads is declared with a sink role',
    (_n, c) => {
      const def = defFor(c)
      const { reads, contract } = contractFor(c)
      for (const name of [...reads, ...(contract.display ?? [])]) {
        const pin = def.pins.find((q) => q.name === name)
        expect(pin, `${c.name}: engine reads undeclared pin "${name}"`).toBeDefined()
        expect(SINK_ROLES, `${c.name}#${name} role`).toContain(pin!.role)
      }
    }
  )

  it.each(ALL_CASES.map((c) => [c.name, c] as const))(
    '%s: every pin the engine writes is declared with the output role',
    (_n, c) => {
      const def = defFor(c)
      const { writes, contract } = contractFor(c)
      for (const name of [...writes, ...(contract.stimulus ?? [])]) {
        const pin = def.pins.find((q) => q.name === name)
        expect(pin, `${c.name}: engine writes undeclared pin "${name}"`).toBeDefined()
        expect(pin!.role, `${c.name}#${name} role`).toBe('output')
      }
    }
  )

  it.each(ALL_CASES.map((c) => [c.name, c] as const))(
    '%s: no declared input pin is left unread by the engine',
    (_n, c) => {
      const def = defFor(c)
      const { reads, contract } = contractFor(c)
      const covered = new Set([...reads, ...(contract.display ?? [])])
      const unread = sinkPins(def)
        .map((q) => q.name)
        .filter((name) => !covered.has(name))
      expect(unread, `${c.name}: input pins the engine never reads`).toEqual([])
    }
  )

  it.each(ALL_CASES.map((c) => [c.name, c] as const))(
    '%s: no declared output pin is left undriven by the engine',
    (_n, c) => {
      const def = defFor(c)
      const { writes, contract } = contractFor(c)
      const covered = new Set([...writes, ...(contract.stimulus ?? [])])
      const unwritten = outPins(def)
        .map((q) => q.name)
        .filter((name) => !covered.has(name))
      expect(unwritten, `${c.name}: output pins nothing ever drives`).toEqual([])
    }
  )

  it.each(ALL_CASES.map((c) => [c.name, c] as const))(
    '%s: pins listed as absent reads really are absent from the definition',
    (_n, c) => {
      const names = defFor(c).pins.map((q) => q.name)
      for (const name of contractFor(c).contract.absentReads ?? []) {
        expect(names, `${c.name}: "${name}" is declared after all`).not.toContain(name)
      }
    }
  )

  it.each(ALL_CASES.map((c) => [c.name, c] as const))(
    '%s: buildSimGraph classifies the same pins as sinks and sources',
    (_n, c) => {
      const b = new CircuitBuilder().add('u', c.type, optionsOf(c))
      const g = buildSimGraph(b.netlist)
      const comp = g.components.get('u')!
      const def = defFor(c)
      expect(sorted(comp.inputPinNames)).toEqual(sorted(sinkPins(def).map((q) => q.name)))
      expect(sorted(comp.outputPinNames)).toEqual(sorted(outPins(def).map((q) => q.name)))
      // Every declared pin gets a net, so scheduleOutput's `pinName in pinNet`
      // guard never silently drops an output.
      for (const q of def.pins) expect(comp.pinNet[q.name], `${c.name}#${q.name}`).toBeDefined()
      expect(comp.bits, `${c.name} width`).toBe(c.type === T.STATE_MACHINE ? 0 : c.n)
    }
  )
})

// ---------------------------------------------------------------------------
// 3. The same contract observed on the running Simulator
// ---------------------------------------------------------------------------

interface Observed {
  reads: Set<string>
  writes: Set<string>
}

const observations = new Map<string, Observed>()
let capturing = false

function noteRead(id: string, name: string): void {
  if (!capturing) return
  const o = observations.get(id) ?? { reads: new Set<string>(), writes: new Set<string>() }
  o.reads.add(name)
  observations.set(id, o)
}

function noteWrite(id: string, name: string): void {
  if (!capturing) return
  const o = observations.get(id) ?? { reads: new Set<string>(), writes: new Set<string>() }
  o.writes.add(name)
  observations.set(id, o)
}

type AnyFn = (...args: never[]) => unknown
const proto = Simulator.prototype as unknown as Record<string, AnyFn>
const originals: Record<string, AnyFn> = {}

beforeAll(() => {
  for (const name of ['readPin', 'readBusOrNull', 'scheduleOutput', 'scheduleBusOutput']) {
    originals[name] = proto[name]
  }
  const wrapRead = (name: string): void => {
    const original = originals[name] as unknown as (c: { id: string }, pin: string) => unknown
    proto[name] = function (this: unknown, comp: { id: string }, pin: string): unknown {
      noteRead(comp.id, pin)
      return original.call(this, comp, pin)
    } as unknown as AnyFn
  }
  const wrapWrite = (name: string): void => {
    const original = originals[name] as unknown as (c: { id: string }, pin: string, v: unknown) => unknown
    proto[name] = function (this: unknown, comp: { id: string }, pin: string, value: unknown): unknown {
      noteWrite(comp.id, pin)
      return original.call(this, comp, pin, value)
    } as unknown as AnyFn
  }
  wrapRead('readPin')
  wrapRead('readBusOrNull')
  wrapWrite('scheduleOutput')
  wrapWrite('scheduleBusOutput')
})

afterAll(() => {
  for (const [name, fn] of Object.entries(originals)) proto[name] = fn
})

/**
 * A part wired so every single-bit sink pin has its own switch and every bus sink
 * pin its own merger-of-switches. Outputs are left dangling (they still get a net,
 * so the engine still drives them).
 */
class Rig {
  readonly circuit: Circuit
  /** Pin name -> switch id for the single-bit sink pins. */
  readonly switchOf = new Map<string, string>()
  /** Extra switch ids that feed the bus sources. */
  readonly busSwitchIds: string[] = []
  readonly clkPin: string | null

  constructor(readonly part: PartCase, extra: Partial<Component> = {}) {
    const b = new CircuitBuilder()
    // Placed through the builder so the part gets its own grid cell; a manually
    // pushed component would sit at (0,0) and short its pins against the first
    // switch placed afterwards.
    b.add('u', part.type, optionsOf(part, extra))
    const def = defFor(part)

    let busIndex = 0
    for (const q of sinkPins(def)) {
      // BUS_TAP's 'in' has no declared width: it takes the width of the bus it
      // is wired to, so it needs a bus source, not a switch.
      const isBus = q.width !== undefined || (part.type === T.BUS_TAP && q.name === 'in')
      if (!isBus) {
        const id = `sw_${q.name}`
        b.switch(id, ZERO)
        b.wire(p(id, 'out'), p('u', q.name))
        this.switchOf.set(q.name, id)
        continue
      }
      const width = q.width ?? 8
      const mid = `mg${busIndex++}`
      b.add(mid, T.MERGER, { bits: width })
      for (let i = 0; i < width; i++) {
        const sid = `${mid}_s${i}`
        b.switch(sid, ZERO)
        b.wire(p(sid, 'out'), p(mid, `in${i}`))
        this.busSwitchIds.push(sid)
      }
      b.wire(p(mid, 'out'), p('u', q.name))
    }

    this.clkPin = sinkPins(def).find((q) => q.role === 'clock')?.name ?? null
    this.circuit = b.build()
  }

  /** All switch ids that reach the part, in a stable order. */
  get switchIds(): string[] {
    return [...this.switchOf.values(), ...this.busSwitchIds]
  }

  apply(ones: Set<string>): void {
    const values: Record<string, LogicValue> = {}
    for (const id of this.switchIds) values[id] = ones.has(id) ? ONE : ZERO
    if (this.clkPin) values[this.switchOf.get(this.clkPin)!] = ZERO
    this.circuit.setMany(values)
    if (this.clkPin) {
      const clk = this.switchOf.get(this.clkPin)!
      this.circuit.set(clk, ONE)
      this.circuit.set(clk, ZERO)
    }
  }

  /**
   * All-zeros, all-ones, every one-hot and every one-cold pattern, each followed
   * by a full clock pulse. Together these reach every branch of the priority
   * chains in parts.ts (a one-hot Ld loads, a one-cold Ld on a counter enables
   * the load path, all-ones enables En, etc.) and every mux/decoder select value.
   */
  sweep(): void {
    const ids = this.switchIds
    const patterns: Set<string>[] = [new Set(), new Set(ids)]
    for (const id of ids) patterns.push(new Set([id]))
    for (const id of ids) patterns.push(new Set(ids.filter((other) => other !== id)))
    for (const pattern of patterns) this.apply(pattern)
  }
}

function observe(part: PartCase, extra: Partial<Component> = {}, drive?: (rig: Rig) => void): Observed {
  observations.clear()
  const rig = new Rig(part, extra)
  capturing = true
  try {
    if (drive) drive(rig)
    else rig.sweep()
  } finally {
    capturing = false
  }
  return observations.get('u') ?? { reads: new Set(), writes: new Set() }
}

/** Cases whose outputs the engine computes in applyEval (everything but the sources/sinks). */
const EVALUATED_CASES = ALL_CASES.filter((c) => {
  const { contract } = contractFor(c)
  return contract.reads !== none || contract.writes !== none
}).filter((c) => c.type !== T.SWITCH && c.type !== T.CHECKER)

const SM_TABLE = (nIn: number, nOut: number): { pinLabels: Record<string, string>; smTable: SmRow[] } => {
  const inLabels = 'ABCDEFGH'.slice(0, nIn).split('')
  const outLabels = 'PQRSTUVW'.slice(0, nOut).split('')
  const pinLabels: Record<string, string> = {}
  inLabels.forEach((l, i) => (pinLabels[`in${i + 1}`] = l))
  outLabels.forEach((l, i) => (pinLabels[`out${i + 1}`] = l))
  const smTable: SmRow[] = inLabels.map((l, i) => ({
    present: '0',
    input: l,
    output: outLabels[Math.min(i, nOut - 1)],
    next: '0'
  }))
  smTable.push({ present: '0', input: '-', output: '0', next: '0' })
  return { pinLabels, smTable }
}

describe('contract vs. the running Simulator (dynamic)', () => {
  it.each(EVALUATED_CASES.map((c) => [c.name, c] as const))(
    '%s: the engine reads exactly the pins the contract lists',
    (_n, c) => {
      const { reads, contract } = contractFor(c)
      const extra =
        c.type === T.STATE_MACHINE
          ? SM_TABLE(smPinCounts({ smInputs: c.smInputs, smOutputs: c.smOutputs }).nIn,
              smPinCounts({ smInputs: c.smInputs, smOutputs: c.smOutputs }).nOut)
          : {}
      const observed = observe(c, extra)
      const allowed = new Set([...reads, ...(contract.absentReads ?? [])])
      const unexpected = [...observed.reads].filter((name) => !allowed.has(name))
      const missed = reads.filter((name) => !observed.reads.has(name))
      expect(unexpected, `${c.name}: engine read pins outside the contract`).toEqual([])
      expect(sorted(missed), `${c.name}: contract pins the engine never read`).toEqual([])
    }
  )

  it.each(EVALUATED_CASES.map((c) => [c.name, c] as const))(
    '%s: the engine drives exactly the output pins the contract lists',
    (_n, c) => {
      const { writes } = contractFor(c)
      const extra =
        c.type === T.STATE_MACHINE
          ? SM_TABLE(smPinCounts({ smInputs: c.smInputs, smOutputs: c.smOutputs }).nIn,
              smPinCounts({ smInputs: c.smInputs, smOutputs: c.smOutputs }).nOut)
          : {}
      const observed = observe(c, extra)
      expect(sorted([...observed.writes]), c.name).toEqual(sorted(writes))
    }
  )

  it('SWITCH drives its own out pin when toggled', () => {
    observations.clear()
    const c = new CircuitBuilder().switch('u', ZERO).build()
    capturing = true
    c.set('u', ONE)
    capturing = false
    expect([...(observations.get('u')?.writes ?? [])]).toEqual(['out'])
    expect([...(observations.get('u')?.reads ?? [])]).toEqual([])
  })

  it('CHECKER reads its in pin when it samples and drives its out pin from the .chk input line', () => {
    observations.clear()
    const b = new CircuitBuilder()
      .add('u', T.CHECKER, { chk: { input: '01', output: '01' } })
      .switch('drv', ONE)
      .wire(p('drv', 'out'), p('u', 'in'))
    const c = b.build()
    expect(c.pin(p('u', 'out'))).toBe(ZERO) // slot 0 of "01"
    capturing = true
    c.go()
    capturing = false
    expect([...(observations.get('u')?.reads ?? [])]).toEqual(['in'])
    expect([...(observations.get('u')?.writes ?? [])]).toEqual([])
    expect(c.pin(p('u', 'out'))).toBe(ONE) // slot 1 of "01"
  })

  it.each([
    [T.VCC, ONE],
    [T.GROUND, ZERO]
  ])('%s drives its out pin without ever being evaluated', (type, value) => {
    const c = new CircuitBuilder().add('u', type).build()
    expect(c.pin(p('u', 'out'))).toBe(value)
  })

  it('CLOCK drives its out pin from the configured initial value', () => {
    const c = new CircuitBuilder().add('u', T.CLOCK).build()
    expect(c.pin(p('u', 'out'))).toBe(ONE)
    const c2 = new CircuitBuilder()
      .add('u', T.CLOCK)
      .setSimulation({ clockInitialValue: ZERO })
      .build()
    expect(c2.pin(p('u', 'out'))).toBe(ZERO)
  })

  it('INPUT_SIGNAL drives its out pin from its waveform', () => {
    const c = new CircuitBuilder()
      .add('u', T.INPUT_SIGNAL, { signal: [{ timeNs: 0, value: ONE }] })
      .build()
    expect(c.pin(p('u', 'out'))).toBe(ONE)
  })

  it.each(BUS_WIDTHS)('BUS_INPUT %i-bit drives its out pin from its label', (n) => {
    const c = new CircuitBuilder().add('u', T.BUS_INPUT, { bits: n, label: '3' }).build()
    expect(c.bus(p('u', 'out'))).toBe('3'.padStart(Math.ceil(n / 4), '0'))
  })

  it('PROBE: the engine follows the net on its in pin (a trace exists and moves)', () => {
    const c = new CircuitBuilder()
      .switch('s', ZERO)
      .probe('u')
      .wire(p('s', 'out'), p('u', 'in'))
      .build()
    expect(c.sim.getWaveforms().map((w) => w.probeId)).toEqual(['u'])
    c.set('s', ONE)
    const samples = c.sim.getWaveforms()[0].samples
    expect(samples[0].v).toBe(ZERO)
    expect(samples[samples.length - 1].v).toBe(ONE)
  })

  it('BUS_PROBE: the engine follows the bus on its in pin', () => {
    const c = new CircuitBuilder()
      .add('src', T.BUS_INPUT, { bits: 4, label: 'A' })
      .add('u', T.BUS_PROBE, { bits: 4 })
      .wire(p('src', 'out'), p('u', 'in'))
      .build()
    const traces = c.sim.getWaveforms()
    expect(traces.map((w) => w.probeId)).toEqual(['u'])
    expect(traces[0].bus).toBe(true)
    expect(traces[0].samples[0].hex).toBe('A')
  })

  it('SEVEN_SEGMENT: all seven inputs are exposed to the renderer through getPinValues', () => {
    const b = new CircuitBuilder().add('u', T.SEVEN_SEGMENT)
    for (let i = 1; i <= 7; i++) {
      b.switch(`s${i}`, i % 2 === 1 ? ONE : ZERO)
      b.wire(p(`s${i}`, 'out'), p('u', String(i)))
    }
    const c = b.build()
    for (let i = 1; i <= 7; i++) {
      expect(c.pin(p('u', String(i))), `segment ${i}`).toBe(i % 2 === 1 ? ONE : ZERO)
    }
  })
})

// ---------------------------------------------------------------------------
// 4. Named dependency proofs for the control pins that are easy to lose
// ---------------------------------------------------------------------------

/** Drives one part with switches; helper for the targeted control-pin proofs. */
function rigFor(type: ComponentType, bits?: number): Rig {
  return new Rig(caseOf(type, bits))
}

function setPins(rig: Rig, values: Record<string, LogicValue>): void {
  const map: Record<string, LogicValue> = {}
  for (const [pin, v] of Object.entries(values)) map[rig.switchOf.get(pin)!] = v
  rig.circuit.setMany(map)
}

function pulseClk(rig: Rig): void {
  const clk = rig.switchOf.get(rig.clkPin!)!
  rig.circuit.set(clk, ONE)
  rig.circuit.set(clk, ZERO)
}

const qOf = (rig: Rig, n: number): string => rig.circuit.vec('u', 'Q', n)

/** An n-bit value as the simulator formats bus pins: uppercase hex, MSB first. */
const hexOf = (value: bigint, n: number): string =>
  value.toString(16).toUpperCase().padStart(Math.ceil(n / 4), '0')

describe('control pins the engine must not ignore', () => {
  it('N_COUNTER: En gates the count (CLR=1)', () => {
    const rig = rigFor(T.N_COUNTER, 4)
    setPins(rig, { CLK: ZERO, CLR: ZERO, En: ZERO })
    pulseClk(rig) // CLR=0 clears synchronously
    expect(qOf(rig, 4)).toBe('0000')
    setPins(rig, { CLR: ONE, En: ZERO })
    pulseClk(rig)
    pulseClk(rig)
    expect(qOf(rig, 4), 'En=0 must hold the count').toBe('0000')
    setPins(rig, { En: ONE })
    pulseClk(rig)
    pulseClk(rig)
    expect(qOf(rig, 4)).toBe('0010')
  })

  it('N_COUNTER: CLR=0 clears synchronously', () => {
    const rig = rigFor(T.N_COUNTER, 4)
    setPins(rig, { CLK: ZERO, CLR: ZERO, En: ONE })
    pulseClk(rig)
    setPins(rig, { CLR: ONE })
    pulseClk(rig)
    pulseClk(rig)
    pulseClk(rig)
    expect(qOf(rig, 4)).toBe('0011')
    setPins(rig, { CLR: ZERO })
    pulseClk(rig)
    expect(qOf(rig, 4)).toBe('0000')
  })

  it('N_COUNTER: K rises only when every output bit is 1', () => {
    const rig = rigFor(T.N_COUNTER, 2)
    setPins(rig, { CLK: ZERO, CLR: ZERO, En: ONE })
    pulseClk(rig)
    setPins(rig, { CLR: ONE })
    expect(rig.circuit.pin(p('u', 'K'))).toBe(ZERO)
    pulseClk(rig)
    pulseClk(rig)
    expect(qOf(rig, 2)).toBe('10')
    expect(rig.circuit.pin(p('u', 'K'))).toBe(ZERO)
    pulseClk(rig)
    expect(qOf(rig, 2)).toBe('11')
    expect(rig.circuit.pin(p('u', 'K'))).toBe(ONE)
  })

  it('N_LOADABLE_COUNTER: En gates the count when Ld=CLR=1', () => {
    const rig = rigFor(T.N_LOADABLE_COUNTER, 4)
    setPins(rig, { CLK: ZERO, CLR: ONE, Ld: ZERO, D0: ZERO, D1: ZERO, D2: ZERO, D3: ZERO })
    pulseClk(rig)
    setPins(rig, { Ld: ONE, En: ZERO })
    pulseClk(rig)
    expect(qOf(rig, 4), 'En=0 holds').toBe('0000')
    setPins(rig, { En: ONE })
    pulseClk(rig)
    expect(qOf(rig, 4)).toBe('0001')
  })

  it('N_LOADABLE_COUNTER: Ld=0 loads D (CLR=1) and D is really read', () => {
    const rig = rigFor(T.N_LOADABLE_COUNTER, 4)
    setPins(rig, { CLK: ZERO, CLR: ONE, Ld: ZERO, En: ZERO, D0: ONE, D1: ZERO, D2: ONE, D3: ZERO })
    pulseClk(rig)
    expect(qOf(rig, 4)).toBe('0101')
    setPins(rig, { D0: ZERO, D3: ONE })
    pulseClk(rig)
    expect(qOf(rig, 4)).toBe('1100')
  })

  it('N_LOADABLE_COUNTER: CLR=0 wins over Ld', () => {
    const rig = rigFor(T.N_LOADABLE_COUNTER, 4)
    setPins(rig, { CLK: ZERO, CLR: ZERO, Ld: ZERO, En: ONE, D0: ONE, D1: ONE, D2: ONE, D3: ONE })
    pulseClk(rig)
    expect(qOf(rig, 4)).toBe('0000')
  })

  it.each([T.N_REGISTER, T.N_SHIFT_LEFT, T.N_SHIFT_RIGHT, T.N_SHIFT_BIDIR])(
    '%s: Ld=1 loads D on the rising edge (CLR=0)',
    (type) => {
      const rig = rigFor(type, 4)
      setPins(rig, { CLK: ZERO, CLR: ZERO, Ld: ONE, D0: ONE, D1: ONE, D2: ZERO, D3: ONE })
      pulseClk(rig)
      expect(qOf(rig, 4)).toBe('1011')
      setPins(rig, { Ld: ZERO, D0: ZERO, D1: ZERO, D2: ZERO, D3: ZERO })
      pulseClk(rig)
      expect(qOf(rig, 4), 'Ld=0 must not load').toBe('1011')
    }
  )

  it.each([T.N_REGISTER, T.N_SHIFT_LEFT, T.N_SHIFT_RIGHT, T.N_SHIFT_BIDIR])(
    '%s: CLR=1 clears on the rising edge and overrides Ld',
    (type) => {
      const rig = rigFor(type, 4)
      setPins(rig, { CLK: ZERO, CLR: ZERO, Ld: ONE, D0: ONE, D1: ONE, D2: ONE, D3: ONE })
      pulseClk(rig)
      expect(qOf(rig, 4)).toBe('1111')
      setPins(rig, { CLR: ONE })
      pulseClk(rig)
      expect(qOf(rig, 4)).toBe('0000')
    }
  )

  it.each([T.N_SHIFT_LEFT, T.N_SHIFT_BIDIR])('%s: LS=1 shifts left and Rin lands in bit 0', (type) => {
    const rig = rigFor(type, 4)
    setPins(rig, { CLK: ZERO, CLR: ONE, Ld: ZERO, LS: ZERO, Rin: ZERO })
    pulseClk(rig)
    setPins(rig, { CLR: ZERO, LS: ONE, Rin: ONE })
    pulseClk(rig)
    expect(qOf(rig, 4)).toBe('0001')
    setPins(rig, { Rin: ZERO })
    pulseClk(rig)
    expect(qOf(rig, 4)).toBe('0010')
    setPins(rig, { LS: ZERO })
    pulseClk(rig)
    expect(qOf(rig, 4), 'LS=0 must stop the shift').toBe('0010')
  })

  it.each([T.N_SHIFT_RIGHT, T.N_SHIFT_BIDIR])('%s: RS=1 shifts right and Lin lands in bit n-1', (type) => {
    const rig = rigFor(type, 4)
    const zeroLs: Record<string, LogicValue> = type === T.N_SHIFT_BIDIR ? { LS: ZERO } : {}
    setPins(rig, { CLK: ZERO, CLR: ONE, Ld: ZERO, RS: ZERO, Lin: ZERO, ...zeroLs })
    pulseClk(rig)
    setPins(rig, { CLR: ZERO, RS: ONE, Lin: ONE })
    pulseClk(rig)
    expect(qOf(rig, 4)).toBe('1000')
    setPins(rig, { Lin: ZERO })
    pulseClk(rig)
    expect(qOf(rig, 4)).toBe('0100')
    setPins(rig, { RS: ZERO })
    pulseClk(rig)
    expect(qOf(rig, 4), 'RS=0 must stop the shift').toBe('0100')
  })

  it('N_SHIFT_BIDIR: LS=RS=1 behaves as a left shift (manual §1.4.2.3, decision 11)', () => {
    const rig = rigFor(T.N_SHIFT_BIDIR, 4)
    setPins(rig, { CLK: ZERO, CLR: ONE, Ld: ZERO, LS: ZERO, RS: ZERO, Rin: ZERO, Lin: ZERO })
    pulseClk(rig)
    setPins(rig, { CLR: ZERO, LS: ONE, RS: ONE, Rin: ONE, Lin: ZERO })
    pulseClk(rig)
    expect(qOf(rig, 4)).toBe('0001')
  })

  it.each([T.TRISTATE_RIGHT, T.TRISTATE_LEFT, T.TRISTATE_UP, T.TRISTATE_DOWN])(
    '%s: ctl selects between the input and Z',
    (type) => {
      const rig = rigFor(type)
      setPins(rig, { ctl: ONE, in: ONE })
      expect(rig.circuit.pin(p('u', 'out'))).toBe(ONE)
      setPins(rig, { ctl: ZERO })
      expect(rig.circuit.pin(p('u', 'out'))).toBe(Z)
      setPins(rig, { ctl: ONE, in: ZERO })
      expect(rig.circuit.pin(p('u', 'out'))).toBe(ZERO)
    }
  )

  it.each(N_BIT_WIDTHS)('N_TRISTATE %i-bit: ctl releases every output', (n) => {
    const rig = rigFor(T.N_TRISTATE, n)
    setPins(rig, Object.fromEntries([['ctl', ONE], ...rng('in', n).map((name) => [name, ONE])]))
    expect(rig.circuit.vec('u', 'out', n)).toBe('1'.repeat(n))
    setPins(rig, { ctl: ZERO })
    for (let i = 0; i < n; i++) expect(rig.circuit.pin(p('u', `out${i}`)), `out${i}`).toBe(Z)
  })

  it.each(BUS_WIDTHS)('COMPLEMENTER %i-bit: en switches between complement and pass-through', (n) => {
    const mask = (1n << BigInt(n)) - 1n
    const value = 5n & mask
    const b = new CircuitBuilder()
      .add('src', T.BUS_INPUT, { bits: n, label: hexOf(value, n) })
      .add('u', T.COMPLEMENTER, { bits: n })
      .switch('en', ZERO)
      .wire(p('src', 'out'), p('u', 'in'))
      .wire(p('en', 'out'), p('u', 'en'))
    const c = b.build()
    expect(c.bus(p('u', 'out')), 'en=0 passes through').toBe(hexOf(value, n))
    c.set('en', ONE)
    expect(c.bus(p('u', 'out')), 'en=1 complements').toBe(hexOf(~value & mask, n))
  })

  it('FULL_ADDER: Cin is read and Cout is driven', () => {
    const rig = rigFor(T.FULL_ADDER)
    setPins(rig, { X: ONE, Y: ZERO, Cin: ZERO })
    expect(rig.circuit.pin(p('u', 'Sum'))).toBe(ONE)
    expect(rig.circuit.pin(p('u', 'Cout'))).toBe(ZERO)
    setPins(rig, { Cin: ONE })
    expect(rig.circuit.pin(p('u', 'Sum'))).toBe(ZERO)
    expect(rig.circuit.pin(p('u', 'Cout'))).toBe(ONE)
  })

  it.each(N_BIT_WIDTHS)('N_ADDER %i-bit: Cin is read and Cout is driven', (n) => {
    const rig = rigFor(T.N_ADDER, n)
    const all = (prefix: string, v: LogicValue): [string, LogicValue][] =>
      rng(prefix, n).map((name) => [name, v])
    setPins(rig, Object.fromEntries([...all('X', ONE), ...all('Y', ZERO), ['Cin', ZERO]]))
    expect(rig.circuit.vec('u', 'S', n)).toBe('1'.repeat(n))
    expect(rig.circuit.pin(p('u', 'Cout'))).toBe(ZERO)
    setPins(rig, { Cin: ONE })
    expect(rig.circuit.vec('u', 'S', n)).toBe('0'.repeat(n))
    expect(rig.circuit.pin(p('u', 'Cout'))).toBe(ONE)
  })

  it.each([
    [T.DECODER_2TO4, ['A', 'B'], 4],
    [T.DECODER_3TO8, ['A', 'B', 'C'], 8]
  ] as const)('%s: every select pin is read (A is the MSB)', (type, selects, outs) => {
    const rig = rigFor(type)
    for (let index = 0; index < outs; index++) {
      const values: Record<string, LogicValue> = {}
      selects.forEach((name, i) => {
        values[name] = (index >> (selects.length - 1 - i)) & 1 ? ONE : ZERO
      })
      setPins(rig, values)
      for (let o = 0; o < outs; o++) {
        expect(rig.circuit.pin(p('u', `out${o}`)), `select=${index} out${o}`).toBe(o === index ? ONE : ZERO)
      }
    }
  })

  it.each([
    [T.MUX_2, ['A'], 2],
    [T.MUX_4, ['A', 'B'], 4],
    [T.MUX_8, ['A', 'B', 'C'], 8]
  ] as const)('%s: every select pin and every data pin is read (A is the MSB)', (type, selects, ins) => {
    const rig = rigFor(type)
    for (let index = 0; index < ins; index++) {
      const values: Record<string, LogicValue> = {}
      selects.forEach((name, i) => {
        values[name] = (index >> (selects.length - 1 - i)) & 1 ? ONE : ZERO
      })
      for (let i = 0; i < ins; i++) values[`in${i}`] = i === index ? ONE : ZERO
      setPins(rig, values)
      expect(rig.circuit.pin(p('u', 'Z')), `select=${index} picks in${index}`).toBe(ONE)
      for (let i = 0; i < ins; i++) values[`in${i}`] = i === index ? ZERO : ONE
      setPins(rig, values)
      expect(rig.circuit.pin(p('u', 'Z')), `select=${index} picks in${index}`).toBe(ZERO)
    }
  })

  it.each(N_BIT_WIDTHS)('N_MUX_2TO1 %i-bit: S=0 picks X, S=1 picks Y', (n) => {
    const rig = rigFor(T.N_MUX_2TO1, n)
    const all = (prefix: string, v: LogicValue): [string, LogicValue][] =>
      rng(prefix, n).map((name) => [name, v])
    setPins(rig, Object.fromEntries([['S', ZERO], ...all('X', ONE), ...all('Y', ZERO)]))
    expect(rig.circuit.vec('u', 'Z', n)).toBe('1'.repeat(n))
    setPins(rig, { S: ONE })
    expect(rig.circuit.vec('u', 'Z', n)).toBe('0'.repeat(n))
  })

  it.each([T.D_FLIPFLOP, T.JK_FLIPFLOP])('%s: S and R are read and are active low', (type) => {
    const rig = rigFor(type)
    setPins(rig, { CLK: ZERO, S: ONE, R: ZERO })
    expect(rig.circuit.pin(p('u', 'Q')), 'R=0 clears').toBe(ZERO)
    expect(rig.circuit.pin(p('u', "Q'"))).toBe(ONE)
    setPins(rig, { S: ZERO, R: ONE })
    expect(rig.circuit.pin(p('u', 'Q')), 'S=0 presets').toBe(ONE)
    expect(rig.circuit.pin(p('u', "Q'"))).toBe(ZERO)
    setPins(rig, { S: ZERO, R: ZERO })
    expect(rig.circuit.pin(p('u', 'Q')), 'S=R=0 is illegal -> X').toBe(X)
  })

  it('D_FLIPFLOP: CLK is read and D is captured on the rising edge only', () => {
    const rig = rigFor(T.D_FLIPFLOP)
    setPins(rig, { S: ONE, R: ZERO, CLK: ZERO, D: ZERO })
    setPins(rig, { R: ONE })
    setPins(rig, { D: ONE })
    expect(rig.circuit.pin(p('u', 'Q')), 'no edge yet').toBe(ZERO)
    setPins(rig, { CLK: ONE })
    expect(rig.circuit.pin(p('u', 'Q'))).toBe(ONE)
    setPins(rig, { D: ZERO })
    expect(rig.circuit.pin(p('u', 'Q')), 'level change without an edge').toBe(ONE)
    setPins(rig, { CLK: ZERO })
    expect(rig.circuit.pin(p('u', 'Q')), 'falling edge is not active').toBe(ONE)
    setPins(rig, { CLK: ONE })
    expect(rig.circuit.pin(p('u', 'Q'))).toBe(ZERO)
  })

  it('JK_FLIPFLOP: CLK is read and J/K act on the falling edge only', () => {
    const rig = rigFor(T.JK_FLIPFLOP)
    setPins(rig, { S: ONE, R: ZERO, CLK: ZERO, J: ZERO, K: ZERO })
    setPins(rig, { R: ONE })
    setPins(rig, { J: ONE, CLK: ONE })
    expect(rig.circuit.pin(p('u', 'Q')), 'rising edge is not active').toBe(ZERO)
    setPins(rig, { CLK: ZERO })
    expect(rig.circuit.pin(p('u', 'Q')), 'J=1 sets on the falling edge').toBe(ONE)
    setPins(rig, { J: ZERO, K: ONE, CLK: ONE })
    setPins(rig, { CLK: ZERO })
    expect(rig.circuit.pin(p('u', 'Q')), 'K=1 resets on the falling edge').toBe(ZERO)
    setPins(rig, { J: ONE, K: ONE, CLK: ONE })
    setPins(rig, { CLK: ZERO })
    expect(rig.circuit.pin(p('u', 'Q')), 'J=K=1 toggles').toBe(ONE)
  })

  it.each(BUS_WIDTHS)('SPLITTER %i-bit: out i carries bit i of the bus', (n) => {
    const value = 5n & ((1n << BigInt(n)) - 1n)
    const c = new CircuitBuilder()
      .add('src', T.BUS_INPUT, { bits: n, label: hexOf(value, n) })
      .add('u', T.SPLITTER, { bits: n })
      .wire(p('src', 'out'), p('u', 'in'))
      .build()
    for (let i = 0; i < n; i++) {
      expect(c.pin(p('u', `out${i}`)), `out${i}`).toBe((value >> BigInt(i)) & 1n ? ONE : ZERO)
    }
  })

  it.each(BUS_WIDTHS)('MERGER %i-bit: in i becomes bit i of the bus', (n) => {
    const rig = rigFor(T.MERGER, n)
    setPins(rig, Object.fromEntries(rng('in', n).map((name, i) => [name, i % 2 === 0 ? ONE : ZERO])))
    let value = 0n
    for (let i = 0; i < n; i++) if (i % 2 === 0) value |= 1n << BigInt(i)
    expect(rig.circuit.bus(p('u', 'out'))).toBe(hexOf(value, n))
  })

  it('BUS_TAP: the in pin is read and the tapped slice reaches out', () => {
    const c = new CircuitBuilder()
      .add('src', T.BUS_INPUT, { bits: 8, label: 'A5' })
      .add('u', T.BUS_TAP, { bits: 4, tapStart: 4 })
      .wire(p('src', 'out'), p('u', 'in'))
      .build()
    expect(c.bus(p('u', 'out'))).toBe('A')
  })

  it('BUS_TAP with bits=1 drives a single-bit net, not a bus', () => {
    const c = new CircuitBuilder()
      .add('src', T.BUS_INPUT, { bits: 8, label: 'A5' })
      .add('u', T.BUS_TAP, { bits: 1, tapStart: 7 })
      .wire(p('src', 'out'), p('u', 'in'))
      .build()
    expect(c.pin(p('u', 'out'))).toBe(ONE)
  })
})

// ---------------------------------------------------------------------------
// 5. effectiveBits / getPartDefinition clamping and caching (decision 10)
// ---------------------------------------------------------------------------

describe('effectiveBits clamping (decision 10)', () => {
  it.each(FIXED_TYPES)('%s is not parameterized: effectiveBits is 0', (type) => {
    expect(effectiveBits(type, undefined)).toBe(0)
    expect(effectiveBits(type, 8)).toBe(0)
  })

  it('STATE_MACHINE is not width-parameterized either', () => {
    expect(effectiveBits(T.STATE_MACHINE, undefined)).toBe(0)
    expect(effectiveBits(T.STATE_MACHINE, 8)).toBe(0)
  })

  it.each(N_BIT_TYPES)('%s: undefined bits means DEFAULT_BITS', (type) => {
    expect(effectiveBits(type, undefined)).toBe(DEFAULT_BITS)
  })

  it.each(BUS_TYPES)('%s: undefined bits means DEFAULT_BITS', (type) => {
    expect(effectiveBits(type, undefined)).toBe(DEFAULT_BITS)
  })

  it.each(N_BIT_TYPES)('%s: below MIN_BITS clamps up to MIN_BITS', (type) => {
    for (const bits of [-100, -1, 0, 1]) {
      expect(effectiveBits(type, bits), `bits=${bits}`).toBe(MIN_BITS)
    }
  })

  it.each(N_BIT_TYPES)('%s: above MAX_BITS clamps down to MAX_BITS', (type) => {
    for (const bits of [MAX_BITS + 1, 32, 1000]) {
      expect(effectiveBits(type, bits), `bits=${bits}`).toBe(MAX_BITS)
    }
  })

  it.each(N_BIT_TYPES)('%s: widths inside the range pass through unchanged', (type) => {
    for (let bits = MIN_BITS; bits <= MAX_BITS; bits++) expect(effectiveBits(type, bits)).toBe(bits)
  })

  it.each(BUS_TYPES.filter((t) => t !== T.BUS_TAP))('%s: clamps to MIN_BITS..MAX_BUS_BITS', (type) => {
    expect(effectiveBits(type, 0)).toBe(MIN_BITS)
    expect(effectiveBits(type, 1)).toBe(MIN_BITS)
    expect(effectiveBits(type, MAX_BUS_BITS)).toBe(MAX_BUS_BITS)
    expect(effectiveBits(type, MAX_BUS_BITS + 1)).toBe(MAX_BUS_BITS)
    expect(effectiveBits(type, 1000)).toBe(MAX_BUS_BITS)
    expect(effectiveBits(type, MAX_BITS + 1)).toBe(MAX_BITS + 1)
  })

  it('BUS_TAP has a 1-bit minimum (a one-bit tap is a plain net)', () => {
    expect(effectiveBits(T.BUS_TAP, 1)).toBe(1)
    expect(effectiveBits(T.BUS_TAP, 0)).toBe(1)
    expect(effectiveBits(T.BUS_TAP, -7)).toBe(1)
    expect(effectiveBits(T.BUS_TAP, MAX_BUS_BITS + 5)).toBe(MAX_BUS_BITS)
  })

  it('BUS_TAP is the only parameterized type whose minimum is 1', () => {
    for (const type of [...N_BIT_TYPES, ...BUS_TYPES]) {
      const expected = type === T.BUS_TAP ? 1 : MIN_BITS
      expect(effectiveBits(type, 1), type).toBe(expected)
    }
  })

  // A width must be a whole number: it counts pins, sizes vectors and is handed
  // straight to xVec()/numToVec() by the engine.
  it.each([...N_BIT_TYPES, ...BUS_TYPES])(
    '%s: effectiveBits always returns a whole number inside the range',
    (type) => {
      const min = type === T.BUS_TAP ? 1 : MIN_BITS
      const max = maxBitsFor(type)
      for (const bits of [undefined, -3, 0, 1, 2, 3.5, 4, 4.5, 15.25, 16, 33, 1000, Number.NaN, Infinity, -Infinity]) {
        const n = effectiveBits(type, bits as number | undefined)
        expect(Number.isInteger(n), `${type} bits=${String(bits)} -> ${n}`).toBe(true)
        expect(n, `${type} bits=${String(bits)}`).toBeGreaterThanOrEqual(min)
        expect(n, `${type} bits=${String(bits)}`).toBeLessThanOrEqual(max)
      }
    }
  )

  // The pins the width parameterizes: `vec` prefixes get one pin per bit, `bus`
  // pins carry the whole vector on one pin.
  const DATA_PINS: Record<string, { vec: string[]; bus: string[] }> = {
    [T.N_ADDER]: { vec: ['X', 'Y', 'S'], bus: [] },
    [T.N_COUNTER]: { vec: ['Q'], bus: [] },
    [T.N_LOADABLE_COUNTER]: { vec: ['D', 'Q'], bus: [] },
    [T.N_REGISTER]: { vec: ['D', 'Q'], bus: [] },
    [T.N_SHIFT_LEFT]: { vec: ['D', 'Q'], bus: [] },
    [T.N_SHIFT_RIGHT]: { vec: ['D', 'Q'], bus: [] },
    [T.N_SHIFT_BIDIR]: { vec: ['D', 'Q'], bus: [] },
    [T.N_MUX_2TO1]: { vec: ['X', 'Y', 'Z'], bus: [] },
    [T.N_TRISTATE]: { vec: ['in', 'out'], bus: [] },
    [T.BUS_INPUT]: { vec: [], bus: ['out'] },
    [T.BUS_PROBE]: { vec: [], bus: ['in'] },
    [T.SPLITTER]: { vec: ['out'], bus: ['in'] },
    [T.MERGER]: { vec: ['in'], bus: ['out'] },
    [T.COMPLEMENTER]: { vec: [], bus: ['in', 'out'] },
    // BUS_TAP's 'in' takes the width of the bus it is wired to, and a 1-bit tap
    // drives a plain net, so its output is only a bus pin above 1 bit.
    [T.BUS_TAP]: { vec: [], bus: [] }
  }

  it('the data-pin table covers every parameterized type', () => {
    expect(sorted(Object.keys(DATA_PINS))).toEqual(sorted([...N_BIT_TYPES, ...BUS_TYPES] as string[]))
  })

  it.each([...N_BIT_TYPES, ...BUS_TYPES])(
    '%s: the definition exposes exactly effectiveBits data pins at every width',
    (type) => {
      const spec = DATA_PINS[type]
      for (const bits of [undefined, 0, 1, 3, 4, 16, 33]) {
        const n = effectiveBits(type, bits)
        const def = getPartDefinition(type, bits)
        const names = def.pins.map((q) => q.name)
        for (const prefix of spec.vec) {
          for (let i = 0; i < n; i++) {
            expect(names, `${type} bits=${String(bits)}: ${prefix}${i}`).toContain(`${prefix}${i}`)
          }
          expect(names, `${type} bits=${String(bits)}: ${prefix}${n} must not exist`).not.toContain(`${prefix}${n}`)
        }
        for (const name of spec.bus) {
          const pin = def.pins.find((q) => q.name === name)!
          expect(pin.width, `${type} bits=${String(bits)}: ${name} width`).toBe(n)
        }
      }
    }
  )

  it('BUS_TAP drives a bus pin above 1 bit and a plain net at exactly 1 bit', () => {
    expect(getPartDefinition(T.BUS_TAP, 1).pins.find((q) => q.name === 'out')!.width).toBeUndefined()
    for (const n of [2, 4, 16, 32]) {
      expect(getPartDefinition(T.BUS_TAP, n).pins.find((q) => q.name === 'out')!.width).toBe(n)
    }
    // The tap's input takes the width of the bus it is wired to, so it declares none.
    expect(getPartDefinition(T.BUS_TAP, 4).pins.find((q) => q.name === 'in')!.width).toBeUndefined()
  })

  it.each([...N_BIT_TYPES, ...BUS_TYPES])(
    '%s: the Simulator can be constructed for any bits value in a file',
    (type) => {
      for (const bits of [undefined, 0, 1, 4, 33, 4.5, Number.NaN]) {
        expect(
          () => new CircuitBuilder().add('u', type, { bits: bits as number | undefined }).build(),
          `${type} bits=${String(bits)}`
        ).not.toThrow()
      }
    }
  )
})

describe('getPartDefinition caching and identity', () => {
  it.each([...N_BIT_TYPES, ...BUS_TYPES])('%s: the same (type,bits) returns the same object', (type) => {
    for (const bits of [2, 4, 16]) {
      expect(getPartDefinition(type, bits)).toBe(getPartDefinition(type, bits))
    }
  })

  it.each([...N_BIT_TYPES, ...BUS_TYPES])(
    '%s: bits values that clamp to the same width share one definition',
    (type) => {
      const max = maxBitsFor(type)
      expect(getPartDefinition(type, max)).toBe(getPartDefinition(type, max + 100))
      const min = type === T.BUS_TAP ? 1 : MIN_BITS
      expect(getPartDefinition(type, min)).toBe(getPartDefinition(type, -50))
      expect(getPartDefinition(type, undefined)).toBe(getPartDefinition(type, DEFAULT_BITS))
    }
  )

  it.each([...N_BIT_TYPES, ...BUS_TYPES])('%s: different widths return different definitions', (type) => {
    expect(getPartDefinition(type, 2)).not.toBe(getPartDefinition(type, 4))
  })

  it.each(FIXED_TYPES)('%s: the fixed definition is a stable object and ignores bits', (type) => {
    expect(getPartDefinition(type)).toBe(getPartDefinition(type, 9))
  })

  it.each(ALL_CASES.map((c) => [c.name, c] as const))('%s: defOf agrees with getPartDefinition', (_n, c) => {
    if (c.type === T.STATE_MACHINE) {
      // getPartDefinition() always yields the default-shaped state machine.
      expect(getPartDefinition(T.STATE_MACHINE, 7)).toBe(
        defOf({ type: T.STATE_MACHINE, smInputs: SM_DEFAULT_PINS, smOutputs: SM_DEFAULT_PINS })
      )
      return
    }
    expect(defFor(c)).toBe(getPartDefinition(c.type, c.bits))
  })
})

// ---------------------------------------------------------------------------
// 6. State-machine pin counts
// ---------------------------------------------------------------------------

describe('smPinCounts clamping and agreement with the definition', () => {
  it('undefined counts default to SM_DEFAULT_PINS on both sides (decision 10)', () => {
    expect(smPinCounts({ smInputs: undefined, smOutputs: undefined })).toEqual({
      nIn: SM_DEFAULT_PINS,
      nOut: SM_DEFAULT_PINS
    })
  })

  it.each([-10, -1, 0, 1])('smInputs/smOutputs %i clamp up to SM_MIN_PINS', (v) => {
    expect(smPinCounts({ smInputs: v, smOutputs: v })).toEqual({ nIn: SM_MIN_PINS, nOut: SM_MIN_PINS })
  })

  it.each([SM_MAX_PINS + 1, 20, 1000])('smInputs/smOutputs %i clamp down to SM_MAX_PINS', (v) => {
    expect(smPinCounts({ smInputs: v, smOutputs: v })).toEqual({ nIn: SM_MAX_PINS, nOut: SM_MAX_PINS })
  })

  it('counts inside the range pass through, independently for inputs and outputs', () => {
    for (let i = SM_MIN_PINS; i <= SM_MAX_PINS; i++) {
      for (let o = SM_MIN_PINS; o <= SM_MAX_PINS; o++) {
        expect(smPinCounts({ smInputs: i, smOutputs: o })).toEqual({ nIn: i, nOut: o })
      }
    }
  })

  it('smPinCounts always returns whole numbers inside SM_MIN_PINS..SM_MAX_PINS', () => {
    for (const v of [undefined, -1, 0, 1, 3.5, 8, 9, Number.NaN, Infinity]) {
      const { nIn, nOut } = smPinCounts({ smInputs: v as number | undefined, smOutputs: v as number | undefined })
      for (const n of [nIn, nOut]) {
        expect(Number.isInteger(n), `smInputs=${String(v)} -> ${n}`).toBe(true)
        expect(n).toBeGreaterThanOrEqual(SM_MIN_PINS)
        expect(n).toBeLessThanOrEqual(SM_MAX_PINS)
      }
    }
  })

  it('the definition exposes exactly nIn inputs, nOut outputs and one clock', () => {
    for (let i = SM_MIN_PINS; i <= SM_MAX_PINS; i++) {
      for (let o = SM_MIN_PINS; o <= SM_MAX_PINS; o++) {
        const def = defOf({ type: T.STATE_MACHINE, smInputs: i, smOutputs: o })
        const ins = def.pins.filter((q) => q.role === 'input').map((q) => q.name)
        const outs = def.pins.filter((q) => q.role === 'output').map((q) => q.name)
        const clocks = def.pins.filter((q) => q.role === 'clock').map((q) => q.name)
        expect(ins, `${i}x${o}`).toEqual(Array.from({ length: i }, (_, k) => `in${k + 1}`))
        expect(outs, `${i}x${o}`).toEqual(Array.from({ length: o }, (_, k) => `out${k + 1}`))
        expect(clocks, `${i}x${o}`).toEqual(['CLK'])
        expect(def.pins.length).toBe(i + o + 1)
      }
    }
  })

  it('out-of-range counts give the clamped pin set, not a broken one', () => {
    const def = defOf({ type: T.STATE_MACHINE, smInputs: 20, smOutputs: 0 })
    expect(def.pins.filter((q) => q.role === 'input').length).toBe(SM_MAX_PINS)
    expect(def.pins.filter((q) => q.role === 'output').length).toBe(SM_MIN_PINS)
  })

  it('the state-machine definition is cached per (nIn,nOut)', () => {
    expect(defOf({ type: T.STATE_MACHINE, smInputs: 3, smOutputs: 5 })).toBe(
      defOf({ type: T.STATE_MACHINE, smInputs: 3, smOutputs: 5 })
    )
    expect(defOf({ type: T.STATE_MACHINE, smInputs: 3, smOutputs: 5 })).not.toBe(
      defOf({ type: T.STATE_MACHINE, smInputs: 5, smOutputs: 3 })
    )
    expect(defOf({ type: T.STATE_MACHINE, smInputs: 99, smOutputs: 99 })).toBe(
      defOf({ type: T.STATE_MACHINE, smInputs: SM_MAX_PINS, smOutputs: SM_MAX_PINS })
    )
  })

  it('the engine sees the clamped pin set too (smInputs=9 exposes in1..in8 only)', () => {
    const b = new CircuitBuilder().add('u', T.STATE_MACHINE, { smInputs: 9, smOutputs: 9 })
    const g = buildSimGraph(b.netlist)
    const comp = g.components.get('u')!
    expect(sorted(comp.inputPinNames)).toEqual(
      sorted(['CLK', ...Array.from({ length: SM_MAX_PINS }, (_, i) => `in${i + 1}`)])
    )
    expect(sorted(comp.outputPinNames)).toEqual(
      sorted(Array.from({ length: SM_MAX_PINS }, (_, i) => `out${i + 1}`))
    )
  })

  it('the label maps the state table compiles against use the same clamped counts', () => {
    const { pinLabels, smTable } = SM_TABLE(SM_DEFAULT_PINS, SM_DEFAULT_PINS)
    const c = new CircuitBuilder()
      .add('u', T.STATE_MACHINE, { pinLabels, smTable })
      .build()
    // No explicit smInputs/smOutputs: the default 4x4 shape must be what the
    // table was compiled against, so every output pin is driven.
    for (let i = 1; i <= SM_DEFAULT_PINS; i++) {
      expect([ZERO, ONE, X], `out${i}`).toContain(c.pin(p('u', `out${i}`)))
    }
  })
})

// ---------------------------------------------------------------------------
// 7. Registry coverage
// ---------------------------------------------------------------------------

describe('registry coverage', () => {
  it('the enum has no duplicate values', () => {
    expect(new Set(ALL_TYPES).size).toBe(ALL_TYPES.length)
  })

  it('the three type groups partition the enum (with STATE_MACHINE on its own)', () => {
    const grouped = [...N_BIT_TYPES, ...BUS_TYPES, ...FIXED_TYPES, T.STATE_MACHINE]
    expect(sorted(grouped as string[])).toEqual(sorted(ALL_TYPES as string[]))
    expect(new Set(grouped).size).toBe(grouped.length)
  })

  it.each(ALL_TYPES)('%s is classified by exactly one of isNBitType / isBusType', (type) => {
    const flags = [isNBitType(type), isBusType(type)].filter(Boolean).length
    expect(flags, `${type}: nbit=${isNBitType(type)} bus=${isBusType(type)}`).toBeLessThanOrEqual(1)
    const expected = N_BIT_TYPES.includes(type) ? 'nbit' : BUS_TYPES.includes(type) ? 'bus' : 'fixed'
    expect(isNBitType(type) ? 'nbit' : isBusType(type) ? 'bus' : 'fixed').toBe(expected)
  })

  it.each(ALL_TYPES)('%s: maxBitsFor matches its group', (type) => {
    expect(maxBitsFor(type)).toBe(isBusType(type) ? MAX_BUS_BITS : MAX_BITS)
  })

  it('the manual bit ranges hold: N-bit parts 2..16, bus parts 2..32', () => {
    expect(MIN_BITS).toBe(2)
    expect(MAX_BITS).toBe(16)
    expect(MAX_BUS_BITS).toBe(32)
    expect(DEFAULT_BITS).toBe(4)
    for (const type of N_BIT_TYPES) expect(maxBitsFor(type), type).toBe(16)
    for (const type of BUS_TYPES) expect(maxBitsFor(type), type).toBe(32)
  })

  it.each(ALL_TYPES)('%s: defOf never throws and never returns an empty definition', (type) => {
    expect(() => defOf({ type })).not.toThrow()
    const def = defOf({ type })
    expect(def, type).toBeDefined()
    expect(def.pins.length, type).toBeGreaterThan(0)
  })

  it.each(ALL_TYPES)('%s: the sim graph can be built for a bare instance', (type) => {
    const b = new CircuitBuilder().add('u', type)
    expect(() => buildSimGraph(b.netlist)).not.toThrow()
    expect(buildSimGraph(b.netlist).components.get('u')).toBeDefined()
  })

  it.each(ALL_TYPES)('%s: an isolated instance simulates and leaves its inputs at Z', (type) => {
    const c = new CircuitBuilder().add('u', type).build()
    const def = defOf({ type })
    for (const q of sinkPins(def)) {
      if (q.width !== undefined) {
        expect(c.bus(p('u', q.name)), `${type}#${q.name}`).toBe('Z'.repeat(Math.ceil(q.width / 4)))
      } else {
        expect(c.pin(p('u', q.name)), `${type}#${q.name}`).toBe(Z)
      }
    }
    expect(c.time).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 8. Label prefixes and titles the UI depends on
// ---------------------------------------------------------------------------

const EXPECTED_PREFIX: Record<string, string> = {
  ...Object.fromEntries(GATE_TYPES.map((t) => [t, 'U'])),
  [T.SWITCH]: 'SW',
  [T.PROBE]: 'P',
  [T.D_FLIPFLOP]: 'FF',
  [T.JK_FLIPFLOP]: 'FF',
  [T.CLOCK]: 'CLK',
  [T.INPUT_SIGNAL]: 'IN',
  [T.FULL_ADDER]: 'FA',
  [T.DECODER_2TO4]: 'DEC',
  [T.DECODER_3TO8]: 'DEC',
  [T.MUX_2]: 'MUX',
  [T.MUX_4]: 'MUX',
  [T.MUX_8]: 'MUX',
  [T.SEVEN_SEGMENT]: 'SEG',
  [T.TRISTATE_RIGHT]: 'TS',
  [T.TRISTATE_LEFT]: 'TS',
  [T.TRISTATE_UP]: 'TS',
  [T.TRISTATE_DOWN]: 'TS',
  [T.VCC]: 'V',
  [T.GROUND]: 'GND',
  [T.CHECKER]: 'CHK',
  [T.N_ADDER]: 'ADD',
  [T.N_COUNTER]: 'CTR',
  [T.N_LOADABLE_COUNTER]: 'CTR',
  [T.N_REGISTER]: 'REG',
  [T.N_SHIFT_LEFT]: 'SR',
  [T.N_SHIFT_RIGHT]: 'SR',
  [T.N_SHIFT_BIDIR]: 'SR',
  [T.N_MUX_2TO1]: 'MUX',
  [T.N_TRISTATE]: 'TS',
  [T.BUS_INPUT]: 'BI',
  [T.BUS_PROBE]: 'BP',
  [T.SPLITTER]: 'SPL',
  [T.MERGER]: 'MRG',
  [T.COMPLEMENTER]: 'CMP',
  [T.BUS_TAP]: 'TAP',
  [T.STATE_MACHINE]: 'SM'
}

describe('label prefixes and titles', () => {
  it('the expected-prefix table covers every ComponentType', () => {
    expect(sorted(Object.keys(EXPECTED_PREFIX))).toEqual(sorted(ALL_TYPES as string[]))
  })

  it.each(ALL_CASES.map((c) => [c.name, c] as const))('%s: has the documented label prefix', (_n, c) => {
    const def = defFor(c)
    expect(def.defaultLabelPrefix).toBe(EXPECTED_PREFIX[c.type])
    expect(def.defaultLabelPrefix.trim().length).toBeGreaterThan(0)
  })

  it.each([...N_BIT_TYPES, ...BUS_TYPES])('%s: the prefix does not change with the width', (type) => {
    const prefixes = new Set([2, 4, 16].map((n) => getPartDefinition(type, n).defaultLabelPrefix))
    expect([...prefixes]).toHaveLength(1)
  })

  it.each(ALL_CASES.map((c) => [c.name, c] as const))('%s: any title present is non-empty', (_n, c) => {
    const title = defFor(c).title
    if (title !== undefined) expect(title.trim().length).toBeGreaterThan(0)
  })

  // NBitDialog renders `getPartDefinition(type, bits).title` with a trailing
  // width stripped, so every N-bit part needs a title of the form "<name> <n>".
  it.each(N_BIT_TYPES)('%s: the title is "<name> <bits>" and the name is width independent', (type) => {
    const names = new Set<string>()
    for (const n of [2, 4, 16]) {
      const title = getPartDefinition(type, n).title
      expect(title, `${type} ${n}-bit`).toBeDefined()
      expect(title!.endsWith(` ${n}`), `${type} title "${title}"`).toBe(true)
      names.add(title!.replace(/ \d+$/, ''))
    }
    expect([...names], type).toHaveLength(1)
    expect([...names][0].length).toBeGreaterThan(0)
  })

  it('COMPLEMENTER carries a width-tagged title too', () => {
    for (const n of BUS_WIDTHS) {
      expect(getPartDefinition(T.COMPLEMENTER, n).title).toBe(`Complementer ${n}`)
    }
  })

  it.each([
    [T.FULL_ADDER, 'F A'],
    [T.DECODER_2TO4, 'Decoder'],
    [T.DECODER_3TO8, 'Decoder'],
    [T.MUX_2, 'Mux'],
    [T.MUX_4, 'Mux'],
    [T.MUX_8, 'Mux'],
    [T.STATE_MACHINE, 'State Machine'],
    [T.CHECKER, 'Checker']
  ] as const)('%s renders the title "%s"', (type, title) => {
    expect(defOf({ type }).title).toBe(title)
  })

  it.each(N_BIT_TYPES)('%s: the title names the part per Appendix A', (type) => {
    const base = getPartDefinition(type, 4).title!.replace(/ \d+$/, '')
    const expected: Record<string, string> = {
      [T.N_ADDER]: 'Adder',
      [T.N_COUNTER]: 'Counter',
      [T.N_LOADABLE_COUNTER]: 'Counter',
      [T.N_REGISTER]: 'Register',
      [T.N_SHIFT_LEFT]: 'Left SR',
      [T.N_SHIFT_RIGHT]: 'Right SR',
      [T.N_SHIFT_BIDIR]: 'Bidir SR',
      [T.N_MUX_2TO1]: '2-to-1 Mux',
      [T.N_TRISTATE]: 'Tristate'
    }
    expect(base).toBe(expected[type])
  })
})

// ---------------------------------------------------------------------------
// 9. The part catalogue vs. the manual's Parts menu (§1.4) and Appendix A
// ---------------------------------------------------------------------------

/**
 * The Parts menu as printed in the manual (§1.4, "These devices include"),
 * mapped onto the ComponentTypes that implement each entry. Two menu entries are
 * pure orientation variants that Appendix A defines by reference:
 * "Adder for Register" is the N-bit adder with one input set at the top, and
 * "Register for Adder" is the bidirectional shift register with its pins at the
 * bottom; both are covered by the part they are defined as.
 */
const PARTS_MENU: { group: string; entry: string; types: ComponentType[] }[] = [
  { group: 'Basic Gates', entry: '2 to 5 input AND', types: [T.AND2, T.AND3, T.AND4, T.AND5] },
  { group: 'Basic Gates', entry: '2 to 5 input OR', types: [T.OR2, T.OR3, T.OR4, T.OR5] },
  { group: 'Basic Gates', entry: '2 to 5 input NAND', types: [T.NAND2, T.NAND3, T.NAND4, T.NAND5] },
  { group: 'Basic Gates', entry: '2 to 5 input NOR', types: [T.NOR2, T.NOR3, T.NOR4, T.NOR5] },
  { group: 'Basic Gates', entry: '2 input XOR and XNOR', types: [T.XOR2, T.XNOR2] },
  { group: 'Basic Gates', entry: 'Inverter', types: [T.NOT] },
  { group: 'I/O Devices', entry: 'Output Probe', types: [T.PROBE] },
  { group: 'I/O Devices', entry: 'Switch', types: [T.SWITCH] },
  { group: 'I/O Devices', entry: '7-Segment Indication', types: [T.SEVEN_SEGMENT] },
  { group: 'I/O Devices', entry: 'Input Signal', types: [T.INPUT_SIGNAL] },
  { group: 'Flip-Flops', entry: 'D Flip-Flop', types: [T.D_FLIPFLOP] },
  { group: 'Flip-Flops', entry: 'J-K Flip-Flop', types: [T.JK_FLIPFLOP] },
  { group: 'N-bit Parts', entry: 'Counter and Loadable Counter', types: [T.N_COUNTER, T.N_LOADABLE_COUNTER] },
  { group: 'N-bit Parts', entry: 'Register and Register for Adder', types: [T.N_REGISTER, T.N_SHIFT_BIDIR] },
  { group: 'N-bit Parts', entry: 'Adder and Adder for Register', types: [T.N_ADDER] },
  { group: 'N-bit Parts', entry: 'N-Wide 2-to-1 MUX', types: [T.N_MUX_2TO1] },
  {
    group: 'N-bit Parts',
    entry: 'Shift Registers: Left Shift, Right Shift, and Bidirectional',
    types: [T.N_SHIFT_LEFT, T.N_SHIFT_RIGHT, T.N_SHIFT_BIDIR]
  },
  { group: 'N-bit Parts', entry: 'Tristate Buffers', types: [T.N_TRISTATE] },
  { group: 'Bus Parts', entry: 'Bus Probe and Bus Input', types: [T.BUS_PROBE, T.BUS_INPUT] },
  { group: 'Bus Parts', entry: 'Splitter and Merger', types: [T.SPLITTER, T.MERGER] },
  { group: 'Bus Parts', entry: 'Bus Tap', types: [T.BUS_TAP] },
  { group: 'Bus Parts', entry: 'Complementer', types: [T.COMPLEMENTER] },
  { group: 'Bus Parts', entry: 'Tristate Buffer', types: [T.N_TRISTATE] },
  { group: 'Clock', entry: 'Clock', types: [T.CLOCK] },
  { group: 'Checker', entry: 'Checker', types: [T.CHECKER] },
  { group: '+V', entry: '+V', types: [T.VCC] },
  { group: 'Ground', entry: 'Ground', types: [T.GROUND] },
  { group: 'Other Parts', entry: 'Full Adder', types: [T.FULL_ADDER] },
  { group: 'Other Parts', entry: 'Decoder', types: [T.DECODER_2TO4, T.DECODER_3TO8] },
  { group: 'Other Parts', entry: 'MUX', types: [T.MUX_2, T.MUX_4, T.MUX_8] },
  { group: 'Other Parts', entry: 'State Machine', types: [T.STATE_MACHINE] },
  {
    group: 'Other Parts',
    entry: 'Tristate Buffer',
    types: [T.TRISTATE_RIGHT, T.TRISTATE_LEFT, T.TRISTATE_UP, T.TRISTATE_DOWN]
  }
]

describe('part catalogue vs. the manual Parts menu (§1.4 / Appendix A)', () => {
  it.each(PARTS_MENU.map((m) => [`${m.group}: ${m.entry}`, m] as const))(
    'menu entry %s is implemented',
    (_n, m) => {
      for (const type of m.types) {
        expect(ALL_TYPES, `${m.entry} -> ${type}`).toContain(type)
        expect(() => defOf({ type })).not.toThrow()
      }
    }
  )

  it('the menu covers every implemented ComponentType (no undocumented parts)', () => {
    const covered = new Set(PARTS_MENU.flatMap((m) => m.types))
    const extra = ALL_TYPES.filter((t) => !covered.has(t))
    expect(extra, 'ComponentTypes with no Parts-menu entry').toEqual([])
  })

  it('the implementation covers every Parts-menu entry (no missing parts)', () => {
    const missing = PARTS_MENU.filter((m) => m.types.length === 0).map((m) => `${m.group}: ${m.entry}`)
    expect(missing).toEqual([])
  })

  it('Appendix A: only one clock, one checker and one state machine per circuit', () => {
    // The manual restricts these to one instance; the definitions must at least
    // exist and be distinct so the editor can enforce it.
    for (const type of [T.CLOCK, T.CHECKER, T.STATE_MACHINE]) {
      expect(defOf({ type }).pins.length).toBeGreaterThan(0)
    }
    expect(defOf({ type: T.CLOCK })).not.toBe(defOf({ type: T.CHECKER }))
  })

  it('Appendix A: gate arities match the menu (AND/OR/NAND/NOR 2..5, XOR/XNOR 2, NOT 1)', () => {
    for (const type of GATE_TYPES) {
      const def = defOf({ type })
      const ins = def.pins.filter((q) => q.role === 'input')
      const outs = def.pins.filter((q) => q.role === 'output')
      expect(ins.length, type).toBe(GATE_ARITY[type])
      expect(outs.map((q) => q.name), type).toEqual(['out'])
      expect(ins.map((q) => q.name), type).toEqual(
        Array.from({ length: GATE_ARITY[type] }, (_, i) => `in${i + 1}`)
      )
    }
  })

  it('Appendix A: the decoder and mux families have the right pin counts', () => {
    expect(defOf({ type: T.DECODER_2TO4 }).pins.filter((q) => q.role === 'output')).toHaveLength(4)
    expect(defOf({ type: T.DECODER_3TO8 }).pins.filter((q) => q.role === 'output')).toHaveLength(8)
    expect(defOf({ type: T.MUX_2 }).pins.filter((q) => q.role === 'input')).toHaveLength(3)
    expect(defOf({ type: T.MUX_4 }).pins.filter((q) => q.role === 'input')).toHaveLength(6)
    expect(defOf({ type: T.MUX_8 }).pins.filter((q) => q.role === 'input')).toHaveLength(11)
  })

  it('Appendix A: the flip-flops expose D/J/K, CLK, S, R, Q and Q-not', () => {
    const d = defOf({ type: T.D_FLIPFLOP })
    expect(sorted(d.pins.map((q) => q.name))).toEqual(sorted(['D', 'CLK', 'S', 'R', 'Q', "Q'"]))
    expect(d.pins.find((q) => q.name === 'S')!.role).toBe('preset')
    expect(d.pins.find((q) => q.name === 'R')!.role).toBe('clear')
    expect(d.pins.find((q) => q.name === 'CLK')!.role).toBe('clock')
    const jk = defOf({ type: T.JK_FLIPFLOP })
    expect(sorted(jk.pins.map((q) => q.name))).toEqual(sorted(['J', 'K', 'CLK', 'S', 'R', 'Q', "Q'"]))
    expect(jk.pins.find((q) => q.name === 'S')!.role).toBe('preset')
    expect(jk.pins.find((q) => q.name === 'R')!.role).toBe('clear')
    expect(jk.pins.find((q) => q.name === 'CLK')!.role).toBe('clock')
  })

  it('Appendix A: every clocked part declares exactly one pin with the clock role', () => {
    const clocked = [T.D_FLIPFLOP, T.JK_FLIPFLOP, T.STATE_MACHINE, ...N_BIT_TYPES]
    for (const type of clocked) {
      const isSequential = type !== T.N_ADDER && type !== T.N_MUX_2TO1 && type !== T.N_TRISTATE
      const clocks = defOf({ type }).pins.filter((q) => q.role === 'clock')
      expect(clocks.length, type).toBe(isSequential ? 1 : 0)
      if (isSequential) expect(clocks[0].name, type).toBe('CLK')
    }
  })
})
