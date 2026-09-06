// Unit verification of every gate part (AND/OR/NAND/NOR 2..5, XOR2, XNOR2, NOT)
// against the SimUaid manual (§1.9 logic values, Appendix B delays):
//   - exhaustive 0/1 truth tables, through evalGate() and through the Simulator
//   - 4-valued semantics: a controlling value (0 for AND/NAND, 1 for OR/NOR)
//     dominates X/Z on other inputs; otherwise the output is X; NOT/XOR/XNOR of
//     any X/Z is X
//   - an unconnected input reads Z and behaves like a Z-driven one
//   - output changes are applied at now + delay, delays accumulate along chains
// Expected values come from an independent reference model (`ref`) written from
// the spec, never from the code under test.

import { describe, expect, it } from 'vitest'
import { ComponentType, LogicValue, type PinId } from '../../model/types'
import { getPartDefinition } from '../../model/partDefinitions'
import { buildSimGraph } from '../graph'
import { evalGate, gateFamily, type GateFamily } from '../logic'
import { CircuitBuilder, allCombos, p, type Circuit } from './harness'

const { ZERO, ONE, X, Z } = LogicValue
const ALL4: readonly LogicValue[] = [ZERO, ONE, X, Z]

/** The harness gives every placed part, switches included, a 1 ns delay. */
const SWITCH_DELAY = 1

interface GateSpec {
  type: ComponentType
  family: GateFamily
  arity: number
}

const GATES: GateSpec[] = [
  { type: ComponentType.AND2, family: 'and', arity: 2 },
  { type: ComponentType.AND3, family: 'and', arity: 3 },
  { type: ComponentType.AND4, family: 'and', arity: 4 },
  { type: ComponentType.AND5, family: 'and', arity: 5 },
  { type: ComponentType.OR2, family: 'or', arity: 2 },
  { type: ComponentType.OR3, family: 'or', arity: 3 },
  { type: ComponentType.OR4, family: 'or', arity: 4 },
  { type: ComponentType.OR5, family: 'or', arity: 5 },
  { type: ComponentType.NAND2, family: 'nand', arity: 2 },
  { type: ComponentType.NAND3, family: 'nand', arity: 3 },
  { type: ComponentType.NAND4, family: 'nand', arity: 4 },
  { type: ComponentType.NAND5, family: 'nand', arity: 5 },
  { type: ComponentType.NOR2, family: 'nor', arity: 2 },
  { type: ComponentType.NOR3, family: 'nor', arity: 3 },
  { type: ComponentType.NOR4, family: 'nor', arity: 4 },
  { type: ComponentType.NOR5, family: 'nor', arity: 5 },
  { type: ComponentType.XOR2, family: 'xor', arity: 2 },
  { type: ComponentType.XNOR2, family: 'xnor', arity: 2 },
  { type: ComponentType.NOT, family: 'not', arity: 1 }
]

// ---------------------------------------------------------------------------
// Reference model (spec §1.9): independent of sim/logic.ts.
// ---------------------------------------------------------------------------

const isBit = (v: LogicValue): boolean => v === ZERO || v === ONE

function refNot(v: LogicValue): LogicValue {
  return v === ZERO ? ONE : v === ONE ? ZERO : X
}

function refAnd(inputs: LogicValue[]): LogicValue {
  if (inputs.some((v) => v === ZERO)) return ZERO // controlling 0 dominates
  return inputs.every((v) => v === ONE) ? ONE : X
}

function refOr(inputs: LogicValue[]): LogicValue {
  if (inputs.some((v) => v === ONE)) return ONE // controlling 1 dominates
  return inputs.every((v) => v === ZERO) ? ZERO : X
}

function refXor(inputs: LogicValue[]): LogicValue {
  if (!inputs.every(isBit)) return X
  return inputs.filter((v) => v === ONE).length % 2 === 1 ? ONE : ZERO
}

function ref(family: GateFamily, inputs: LogicValue[]): LogicValue {
  switch (family) {
    case 'and':
      return refAnd(inputs)
    case 'nand':
      return refNot(refAnd(inputs))
    case 'or':
      return refOr(inputs)
    case 'nor':
      return refNot(refOr(inputs))
    case 'xor':
      return refXor(inputs)
    case 'xnor':
      return refNot(refXor(inputs))
    case 'not':
      return refNot(inputs[0])
  }
}

// ---------------------------------------------------------------------------
// Local helpers (not in the harness).
// ---------------------------------------------------------------------------

const inputNames = (arity: number): string[] =>
  Array.from({ length: arity }, (_, i) => `in${i + 1}`)

/** "in1=0 in2=X ..." */
const fmt = (inputs: LogicValue[]): string => inputs.map((v, i) => `in${i + 1}=${v}`).join(' ')

/** Formats the values of every input except in{k+1}. */
const fmtExcept = (others: LogicValue[], k: number): string =>
  others.map((v, j) => `in${(j < k ? j : j + 1) + 1}=${v}`).join(' ') || '(no other inputs)'

/** Full input vector with `v` inserted at position k (0-based). */
const withAt = (others: LogicValue[], k: number, v: LogicValue): LogicValue[] => [
  ...others.slice(0, k),
  v,
  ...others.slice(k)
]

/** All 4^n input vectors over {0,1,X,Z}. */
function allCombos4(n: number): LogicValue[][] {
  let out: LogicValue[][] = [[]]
  for (let i = 0; i < n; i++) out = out.flatMap((row) => ALL4.map((v) => [...row, v]))
  return out
}

type Row = [string, LogicValue[]]
const rows = (n: number): Row[] => allCombos(n).map((inputs) => [fmt(inputs), inputs])
const rowsExcept = (arity: number, k: number): Row[] =>
  allCombos(arity - 1).map((others) => [fmtExcept(others, k), others])

const sw = (i: number): string => `s${i}` // switch feeding in{i}
const inPin = (i: number): PinId => p('g', `in${i}`)
const OUT = p('g', 'out')
const PROBE = p('y', 'in')
const IN1_PROBE = p('ps', 'in')

const switchMap = (inputs: LogicValue[]): Record<string, LogicValue> =>
  Object.fromEntries(inputs.map((v, i) => [sw(i + 1), v]))

/** Switch map for every input except in{k+1}. */
const switchMapExcept = (others: LogicValue[], k: number): Record<string, LogicValue> =>
  Object.fromEntries(others.map((v, j) => [sw((j < k ? j : j + 1) + 1), v]))

/** Switches s1..sN (all 0) on in1..inN, probe `y` on out, probe `ps` on the in1 net. */
function gateCircuit(type: ComponentType, arity: number, gateOpts: { delay?: number } = {}): Circuit {
  const b = new CircuitBuilder().add('g', type, gateOpts).probe('y').wire(OUT, PROBE)
  for (let i = 1; i <= arity; i++) b.switch(sw(i), ZERO).wire(p(sw(i), 'out'), inPin(i))
  b.probe('ps').wire(p(sw(1), 'out'), IN1_PROBE)
  return b.build()
}

type Source = 'x' | 'z' | 'open'

/** Switches on every input except in{k+1}, which is fed by `source`. */
function gateCircuitWith(type: ComponentType, arity: number, k: number, source: Source): Circuit {
  const b = new CircuitBuilder().add('g', type).probe('y').wire(OUT, PROBE)
  for (let i = 0; i < arity; i++) {
    if (i === k) continue
    b.switch(sw(i + 1), ZERO).wire(p(sw(i + 1), 'out'), inPin(i + 1))
  }
  if (source === 'x') {
    // A NOT gate with an open input outputs X (spec: NOT of Z is X).
    b.add('xs', ComponentType.NOT).wire(p('xs', 'out'), inPin(k + 1))
  } else if (source === 'z') {
    // A tristate buffer with ctl=0 drives Z onto the wire.
    b.switch('ctl', ZERO)
      .switch('zin', ZERO)
      .add('ts', ComponentType.TRISTATE_RIGHT)
      .wire(p('ctl', 'out'), p('ts', 'ctl'))
      .wire(p('zin', 'out'), p('ts', 'in'))
      .wire(p('ts', 'out'), inPin(k + 1))
  }
  return b.build()
}

interface Sample {
  t: number
  v: LogicValue
}

function samples(c: Circuit, probeId: string): Sample[] {
  const trace = c.sim.getWaveforms().find((w) => w.probeId === probeId)
  if (!trace) throw new Error(`no probe ${probeId}`)
  return trace.samples.map(({ t, v }) => ({ t, v }))
}

function lastSample(c: Circuit, probeId: string): Sample {
  const s = samples(c, probeId)
  return s[s.length - 1]
}

/** Values for in2..inN such that flipping in1 from 0 to 1 flips the output. */
function flipContext(family: GateFamily, arity: number): LogicValue[] {
  for (const others of allCombos(arity - 1)) {
    if (ref(family, [ZERO, ...others]) !== ref(family, [ONE, ...others])) return others
  }
  throw new Error(`no flipping context for ${family}`)
}

interface TraceEntry {
  time: number
  values: LogicValue[]
}

/**
 * CHANGE-mode style: toggles a switch without settling, then applies queued
 * events one at a time, recording sim time and the given pins after each.
 */
function traceToggle(c: Circuit, switchId: string, pins: PinId[]): TraceEntry[] {
  c.sim.toggle(switchId, false)
  const trace: TraceEntry[] = []
  while (c.sim.changeStep()) {
    trace.push({ time: c.sim.time, values: pins.map((id) => c.pin(id)) })
    if (trace.length > 1000) throw new Error('event queue did not drain')
  }
  return trace
}

/** switch a -> NOT n (given delay) -> probe y; probe pa on the a net. */
function inverter(delay: number): Circuit {
  return new CircuitBuilder()
    .switch('a', ZERO)
    .add('n', ComponentType.NOT, { delay })
    .probe('pa')
    .probe('y')
    .connect(p('a', 'out'), p('n', 'in1'), p('pa', 'in'))
    .wire(p('n', 'out'), p('y', 'in'))
    .build()
}

const PA = p('pa', 'in')
const PY = p('y', 'in')

// ---------------------------------------------------------------------------
// Part definitions
// ---------------------------------------------------------------------------

describe('gate part definitions', () => {
  describe.each(GATES)('$type', ({ type, family, arity }) => {
    const def = getPartDefinition(type)

    it(`has pins in1..in${arity} followed by out`, () => {
      expect(def.pins.map((pin) => pin.name)).toEqual([...inputNames(arity), 'out'])
    })

    it('marks in* as inputs and out as the only output', () => {
      for (const pin of def.pins) {
        expect(pin.role, pin.name).toBe(pin.name === 'out' ? 'output' : 'input')
      }
    })

    it('is a single-bit part (no bus pins)', () => {
      for (const pin of def.pins) expect(pin.width, pin.name).toBeUndefined()
    })

    it('places every pin on a distinct grid point (so wires attach unambiguously)', () => {
      const keys = def.pins.map((pin) => `${pin.dx},${pin.dy}`)
      expect(new Set(keys).size).toBe(def.pins.length)
      for (const pin of def.pins) {
        expect(pin.dx % 10, `${pin.name}.dx`).toBe(0)
        expect(pin.dy % 10, `${pin.name}.dy`).toBe(0)
      }
    })

    it(`gateFamily() is '${family}'`, () => {
      expect(gateFamily(type)).toBe(family)
    })

    it(`sim graph inputPinNames is [in1..in${arity}] in order and outputPinNames is [out]`, () => {
      const b = new CircuitBuilder().add('g', type)
      const g = buildSimGraph(b.netlist).components.get('g')
      expect(g).toBeDefined()
      expect(g!.inputPinNames).toEqual(inputNames(arity))
      expect(g!.outputPinNames).toEqual(['out'])
    })

    it('keeps inputPinNames complete and ordered even when only some inputs are wired', () => {
      const b = new CircuitBuilder().add('g', type).switch('a', ONE)
      b.wire(p('a', 'out'), inPin(arity)) // wire only the last input
      const g = buildSimGraph(b.netlist).components.get('g')!
      expect(g.inputPinNames).toEqual(inputNames(arity))
    })
  })

  it('gateFamily() is null for every non-gate part', () => {
    const gateTypes = new Set(GATES.map((g) => g.type))
    for (const type of Object.values(ComponentType)) {
      if (gateTypes.has(type)) continue
      expect(gateFamily(type), type).toBeNull()
    }
  })

  it('the GATES table covers every gate ComponentType exactly once', () => {
    const expected = Object.values(ComponentType).filter((t) => /^(AND|OR|NAND|NOR)[2-5]$|^X?N?OR2$|^NOT$/.test(t))
    expect([...GATES.map((g) => g.type)].sort()).toEqual([...expected].sort())
  })
})

// ---------------------------------------------------------------------------
// evalGate: pure-function truth tables
// ---------------------------------------------------------------------------

describe('evalGate: literal truth tables', () => {
  const LITERAL: [GateFamily, LogicValue[], LogicValue][] = [
    ['and', [ZERO, ZERO], ZERO],
    ['and', [ZERO, ONE], ZERO],
    ['and', [ONE, ZERO], ZERO],
    ['and', [ONE, ONE], ONE],
    ['or', [ZERO, ZERO], ZERO],
    ['or', [ZERO, ONE], ONE],
    ['or', [ONE, ZERO], ONE],
    ['or', [ONE, ONE], ONE],
    ['nand', [ZERO, ZERO], ONE],
    ['nand', [ZERO, ONE], ONE],
    ['nand', [ONE, ZERO], ONE],
    ['nand', [ONE, ONE], ZERO],
    ['nor', [ZERO, ZERO], ONE],
    ['nor', [ZERO, ONE], ZERO],
    ['nor', [ONE, ZERO], ZERO],
    ['nor', [ONE, ONE], ZERO],
    ['xor', [ZERO, ZERO], ZERO],
    ['xor', [ZERO, ONE], ONE],
    ['xor', [ONE, ZERO], ONE],
    ['xor', [ONE, ONE], ZERO],
    ['xnor', [ZERO, ZERO], ONE],
    ['xnor', [ZERO, ONE], ZERO],
    ['xnor', [ONE, ZERO], ZERO],
    ['xnor', [ONE, ONE], ONE],
    ['not', [ZERO], ONE],
    ['not', [ONE], ZERO],
    // wider gates
    ['and', [ONE, ONE, ONE, ONE, ONE], ONE],
    ['and', [ONE, ONE, ONE, ONE, ZERO], ZERO],
    ['and', [ZERO, ONE, ONE], ZERO],
    ['or', [ZERO, ZERO, ZERO, ZERO, ZERO], ZERO],
    ['or', [ZERO, ZERO, ZERO, ZERO, ONE], ONE],
    ['or', [ONE, ZERO, ZERO], ONE],
    ['nand', [ONE, ONE, ONE], ZERO],
    ['nand', [ONE, ONE, ONE, ZERO], ONE],
    ['nor', [ZERO, ZERO, ZERO, ZERO], ONE],
    ['nor', [ZERO, ZERO, ONE, ZERO, ZERO], ZERO]
  ]

  it.each(LITERAL)('%s(%s) = %s', (family, inputs, y) => {
    expect(evalGate(family, inputs)).toBe(y)
    expect(ref(family, inputs), 'reference model self-check').toBe(y)
  })
})

describe('evalGate: exhaustive 0/1 truth tables', () => {
  describe.each(GATES)('$type', ({ family, arity }) => {
    it.each(rows(arity))('%s', (_label, inputs) => {
      expect(evalGate(family, inputs)).toBe(ref(family, inputs))
    })
  })
})

describe('evalGate: X and Z inputs (literal cases)', () => {
  const LITERAL: [GateFamily, LogicValue[], LogicValue][] = [
    // controlling 0 dominates X/Z for AND/NAND
    ['and', [ZERO, X], ZERO],
    ['and', [X, ZERO], ZERO],
    ['and', [ZERO, Z], ZERO],
    ['and', [Z, ZERO], ZERO],
    ['and', [X, Z, ZERO, X, Z], ZERO],
    ['nand', [ZERO, X], ONE],
    ['nand', [Z, ZERO], ONE],
    ['nand', [X, X, ZERO], ONE],
    // otherwise X
    ['and', [ONE, X], X],
    ['and', [ONE, Z], X],
    ['and', [X, X], X],
    ['and', [Z, Z], X],
    ['and', [X, Z], X],
    ['and', [ONE, ONE, ONE, ONE, Z], X],
    ['nand', [ONE, X], X],
    ['nand', [ONE, Z], X],
    ['nand', [Z, Z], X],
    // controlling 1 dominates X/Z for OR/NOR
    ['or', [ONE, X], ONE],
    ['or', [X, ONE], ONE],
    ['or', [ONE, Z], ONE],
    ['or', [Z, ONE], ONE],
    ['or', [X, Z, ONE, X, Z], ONE],
    ['nor', [ONE, X], ZERO],
    ['nor', [Z, ONE], ZERO],
    ['nor', [X, X, ONE], ZERO],
    // otherwise X
    ['or', [ZERO, X], X],
    ['or', [ZERO, Z], X],
    ['or', [X, X], X],
    ['or', [Z, Z], X],
    ['or', [ZERO, ZERO, ZERO, ZERO, X], X],
    ['nor', [ZERO, X], X],
    ['nor', [ZERO, Z], X],
    ['nor', [X, Z], X],
    // XOR/XNOR with any X/Z is X
    ['xor', [ZERO, X], X],
    ['xor', [ONE, X], X],
    ['xor', [ZERO, Z], X],
    ['xor', [ONE, Z], X],
    ['xor', [X, X], X],
    ['xor', [Z, Z], X],
    ['xnor', [ZERO, X], X],
    ['xnor', [ONE, X], X],
    ['xnor', [ZERO, Z], X],
    ['xnor', [ONE, Z], X],
    ['xnor', [X, Z], X],
    // NOT of X/Z is X
    ['not', [X], X],
    ['not', [Z], X]
  ]

  it.each(LITERAL)('%s(%s) = %s', (family, inputs, y) => {
    expect(evalGate(family, inputs)).toBe(y)
    expect(ref(family, inputs), 'reference model self-check').toBe(y)
  })

  it('NOT with no input value at all is X', () => {
    expect(evalGate('not', [])).toBe(X)
  })
})

describe('evalGate: each input X or Z while the others sweep 0/1', () => {
  describe.each(GATES)('$type', ({ family, arity }) => {
    for (let k = 0; k < arity; k++) {
      for (const v of [X, Z]) {
        it(`in${k + 1}=${v}: controlling value dominates, otherwise X`, () => {
          for (const others of allCombos(arity - 1)) {
            const inputs = withAt(others, k, v)
            expect(evalGate(family, inputs), fmt(inputs)).toBe(ref(family, inputs))
          }
        })
      }
    }

    it(`matches the reference model on all ${4 ** arity} four-valued input vectors`, () => {
      for (const inputs of allCombos4(arity)) {
        expect(evalGate(family, inputs), fmt(inputs)).toBe(ref(family, inputs))
      }
    })
  })
})

// ---------------------------------------------------------------------------
// Simulator: truth tables through switches and a probe
// ---------------------------------------------------------------------------

describe('Simulator: 0/1 truth tables (switch on every input, probe on out)', () => {
  describe.each(GATES)('$type', ({ type, family, arity }) => {
    const c = gateCircuit(type, arity)

    it('settles to a clean value with all inputs 0', () => {
      const expected = ref(family, new Array<LogicValue>(arity).fill(ZERO))
      expect(c.pin(PROBE)).toBe(expected)
      expect(c.oscillated).toBe(false)
    })

    it.each(rows(arity))('%s', (_label, inputs) => {
      c.setMany(switchMap(inputs))
      const expected = ref(family, inputs)
      for (let i = 0; i < arity; i++) expect(c.pin(inPin(i + 1)), `in${i + 1}`).toBe(inputs[i])
      expect(c.pin(PROBE)).toBe(expected)
      expect(c.pin(OUT)).toBe(expected)
    })

    it('reaches every row again after a reset', () => {
      c.reset()
      for (const inputs of allCombos(arity)) {
        c.setMany(switchMap(inputs))
        expect(c.pin(PROBE), fmt(inputs)).toBe(ref(family, inputs))
      }
    })

    it('reaches every row when all switches change at once (setMany) and one at a time (set)', () => {
      for (const inputs of allCombos(arity)) {
        for (let i = 0; i < arity; i++) c.set(sw(i + 1), inputs[i])
        expect(c.pin(PROBE), fmt(inputs)).toBe(ref(family, inputs))
      }
    })
  })
})

describe.each([
  ['X-driven (NOT gate with an open input)', 'x', X],
  ['Z-driven (tristate buffer with ctl=0)', 'z', Z],
  ['unconnected (no wire at all)', 'open', Z]
] as [string, Source, LogicValue][])('Simulator: one input %s', (_title, source, pinValue) => {
  describe.each(GATES)('$type', ({ type, family, arity }) => {
    for (let k = 0; k < arity; k++) {
      describe(`in${k + 1}`, () => {
        const c = gateCircuitWith(type, arity, k, source)

        it(`reads ${pinValue} at the pin`, () => {
          expect(c.pin(inPin(k + 1))).toBe(pinValue)
        })

        it.each(rowsExcept(arity, k))('%s', (_label, others) => {
          c.setMany(switchMapExcept(others, k))
          const inputs = withAt(others, k, pinValue)
          expect(c.pin(inPin(k + 1))).toBe(pinValue)
          expect(c.pin(PROBE), fmt(inputs)).toBe(ref(family, inputs))
          expect(c.pin(OUT), fmt(inputs)).toBe(ref(family, inputs))
        })

        if (source === 'z') {
          it('the wire is real: enabling the tristate makes the input take effect again', () => {
            const others = new Array<LogicValue>(arity - 1).fill(ZERO)
            c.setMany(switchMapExcept(others, k))
            c.set('zin', ONE)
            c.set('ctl', ONE)
            expect(c.pin(inPin(k + 1))).toBe(ONE)
            expect(c.pin(PROBE)).toBe(ref(family, withAt(others, k, ONE)))
            c.set('zin', ZERO)
            expect(c.pin(inPin(k + 1))).toBe(ZERO)
            expect(c.pin(PROBE)).toBe(ref(family, withAt(others, k, ZERO)))
            c.set('ctl', ZERO)
            expect(c.pin(inPin(k + 1))).toBe(Z)
            expect(c.pin(PROBE)).toBe(ref(family, withAt(others, k, Z)))
          })
        }
      })
    }
  })
})

describe('Simulator: fully unconnected gates', () => {
  describe.each(GATES)('$type', ({ type }) => {
    it('reads Z on every input and X on the output', () => {
      const c = new CircuitBuilder().add('g', type).build()
      const def = getPartDefinition(type)
      for (const pin of def.pins) {
        expect(c.pin(p('g', pin.name)), pin.name).toBe(pin.name === 'out' ? X : Z)
      }
    })
  })

  it('contention: two switches driving 0 and 1 onto one input makes that input X', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .switch('b', ONE)
      .switch('s2', ONE)
      .add('g', ComponentType.AND2)
      .connect(inPin(1), p('a', 'out'), p('b', 'out'))
      .wire(p('s2', 'out'), inPin(2))
      .build()
    expect(c.pin(inPin(1))).toBe(X)
    expect(c.pin(OUT)).toBe(X)
    c.set('s2', ZERO)
    expect(c.pin(OUT)).toBe(ZERO) // controlling 0 still dominates the X
  })
})

// ---------------------------------------------------------------------------
// Simulator: propagation delay
// ---------------------------------------------------------------------------

describe('Simulator: propagation delay', () => {
  it('default 1 ns: NOT output changes 1 ns after its input changes', () => {
    const c = inverter(1)
    const t0 = c.time
    expect(c.pin(PY)).toBe(ONE)
    c.set('a', ONE)
    const tIn = lastSample(c, 'pa')
    const tOut = lastSample(c, 'y')
    expect(tIn.v).toBe(ONE)
    expect(tOut.v).toBe(ZERO)
    expect(tOut.t - tIn.t).toBe(1)
    expect(c.time).toBe(tOut.t)
    expect(c.time - t0).toBe(SWITCH_DELAY + 1)
  })

  it('custom delay 5: NOT output changes exactly 5 ns after its input changes', () => {
    const c = inverter(5)
    const t0 = c.time
    c.set('a', ONE)
    const tIn = lastSample(c, 'pa')
    const tOut = lastSample(c, 'y')
    expect(tOut.v).toBe(ZERO)
    expect(tOut.t - tIn.t).toBe(5)
    expect(c.time).toBe(tOut.t)
    expect(c.time - t0).toBe(SWITCH_DELAY + 5)
    // and again on the way back
    c.set('a', ZERO)
    expect(lastSample(c, 'y').v).toBe(ONE)
    expect(lastSample(c, 'y').t - lastSample(c, 'pa').t).toBe(5)
  })

  it('the output changes exactly once per input change (no extra samples)', () => {
    const c = inverter(3)
    const before = samples(c, 'y').length
    c.set('a', ONE)
    expect(samples(c, 'y').length).toBe(before + 1)
    c.set('a', ZERO)
    expect(samples(c, 'y').length).toBe(before + 2)
  })

  describe.each(GATES)('$type applies its configured delay', ({ type, family, arity }) => {
    it('output flips 4 ns after the in1 net flips, and sim.time stops there', () => {
      const c = gateCircuit(type, arity, { delay: 4 })
      const others = flipContext(family, arity)
      c.setMany(switchMap([ZERO, ...others]))
      expect(c.pin(PROBE)).toBe(ref(family, [ZERO, ...others]))
      c.set(sw(1), ONE)
      const tIn = lastSample(c, 'ps')
      const tOut = lastSample(c, 'y')
      expect(tIn.v).toBe(ONE)
      expect(tOut.v).toBe(ref(family, [ONE, ...others]))
      expect(tOut.t - tIn.t).toBe(4)
      expect(c.time).toBe(tOut.t)
    })

    it('output flips 1 ns after the in1 net flips with the default delay', () => {
      const c = gateCircuit(type, arity)
      const others = flipContext(family, arity)
      c.setMany(switchMap([ZERO, ...others]))
      c.set(sw(1), ONE)
      expect(lastSample(c, 'y').t - lastSample(c, 'ps').t).toBe(1)
    })
  })

  it('an input change that does not change the output produces no output event', () => {
    const c = gateCircuit(ComponentType.AND2, 2)
    const before = samples(c, 'y')
    c.set(sw(2), ONE) // in1 is still 0, so AND2 stays 0
    expect(c.pin(PROBE)).toBe(ZERO)
    expect(samples(c, 'y')).toEqual(before)
  })

  it('chained gates accumulate their delays: NOT(1) -> NOT(5) -> AND2(3)', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .switch('b', ONE)
      .add('n1', ComponentType.NOT, { delay: 1 })
      .add('n2', ComponentType.NOT, { delay: 5 })
      .add('g', ComponentType.AND2, { delay: 3 })
      .probe('pa')
      .probe('p1')
      .probe('p2')
      .probe('y')
      .connect(p('a', 'out'), p('n1', 'in1'), p('pa', 'in'))
      .connect(p('n1', 'out'), p('n2', 'in1'), p('p1', 'in'))
      .connect(p('n2', 'out'), p('g', 'in1'), p('p2', 'in'))
      .wire(p('b', 'out'), p('g', 'in2'))
      .wire(p('g', 'out'), p('y', 'in'))
      .build()
    expect(c.pin(p('y', 'in'))).toBe(ZERO) // a=0 -> n1=1 -> n2=0 -> AND(0,1)=0

    c.set('a', ONE)
    const tA = lastSample(c, 'pa').t
    expect(lastSample(c, 'p1')).toEqual({ t: tA + 1, v: ZERO })
    expect(lastSample(c, 'p2')).toEqual({ t: tA + 1 + 5, v: ONE })
    expect(lastSample(c, 'y')).toEqual({ t: tA + 1 + 5 + 3, v: ONE })
    expect(c.time).toBe(tA + 9)
  })

  it('delays are per instance: two NOTs on one switch change at +1 and +7', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .add('n1', ComponentType.NOT, { delay: 1 })
      .add('n2', ComponentType.NOT, { delay: 7 })
      .probe('pa')
      .probe('y1')
      .probe('y2')
      .connect(p('a', 'out'), p('n1', 'in1'), p('n2', 'in1'), p('pa', 'in'))
      .wire(p('n1', 'out'), p('y1', 'in'))
      .wire(p('n2', 'out'), p('y2', 'in'))
      .build()
    c.set('a', ONE)
    const tA = lastSample(c, 'pa').t
    expect(lastSample(c, 'y1')).toEqual({ t: tA + 1, v: ZERO })
    expect(lastSample(c, 'y2')).toEqual({ t: tA + 7, v: ZERO })
    expect(c.time).toBe(tA + 7)
  })

  it('CHANGE mode: the output holds its old value until exactly now + delay', () => {
    const c = inverter(5)
    const trace = traceToggle(c, 'a', [PA, PY])
    const inIdx = trace.findIndex((e) => e.values[0] === ONE)
    const outIdx = trace.findIndex((e) => e.values[1] === ZERO)
    expect(inIdx).toBeGreaterThanOrEqual(0)
    expect(outIdx).toBeGreaterThan(inIdx)
    const tIn = trace[inIdx].time
    expect(trace[outIdx].time).toBe(tIn + 5)
    for (const e of trace.slice(0, outIdx)) {
      expect(e.values[1], `output at t=${e.time}`).toBe(ONE)
      expect(e.time).toBeLessThanOrEqual(tIn + 5)
    }
    // once drained the circuit is quiescent and consistent
    expect(c.pin(PA)).toBe(ONE)
    expect(c.pin(PY)).toBe(ZERO)
  })

  it('CHANGE mode: an input pulse shorter than the delay does not leave the output inverted', () => {
    const c = inverter(5)
    expect(c.pin(PY)).toBe(ONE)
    c.sim.toggle('a', false)
    let guard = 0
    while (c.pin(PA) !== ONE) {
      expect(c.sim.changeStep()).toBe(true)
      if (++guard > 100) throw new Error('input never rose')
    }
    c.sim.toggle('a', false) // back to 0 one ns later: a 1 ns pulse into a 5 ns inverter
    c.sim.drain()
    expect(c.pin(PA)).toBe(ZERO)
    // Under transport delay the output would pulse 0 then return to 1; under
    // inertial delay it would never move. Either way NOT(0) must end up 1.
    expect(c.pin(PY)).toBe(ONE)
  })

  it('LIVE mode: a hazard glitch shorter than the next gate delay still leaves that gate consistent', () => {
    // a --+--------------> AND2 g (1 ns) --> NOT h (5 ns) --> y
    //     +-- NOT n1 (1) -^
    // g = a AND NOT a is 0 in steady state; toggling a produces a 1 ns glitch on g.
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .add('n1', ComponentType.NOT)
      .add('g', ComponentType.AND2)
      .add('h', ComponentType.NOT, { delay: 5 })
      .probe('pg')
      .probe('y')
      .connect(p('a', 'out'), p('n1', 'in1'), p('g', 'in1'))
      .wire(p('n1', 'out'), p('g', 'in2'))
      .connect(p('g', 'out'), p('h', 'in1'), p('pg', 'in'))
      .wire(p('h', 'out'), p('y', 'in'))
      .build()
    expect(c.pin(p('pg', 'in'))).toBe(ZERO)
    expect(c.pin(p('y', 'in'))).toBe(ONE)

    c.set('a', ONE)
    expect(c.pin(p('pg', 'in'))).toBe(ZERO)
    expect(c.oscillated).toBe(false)
    // h's input is 0 and the circuit is quiescent, so h must output NOT(0) = 1.
    expect(c.pin(p('y', 'in'))).toBe(ONE)

    c.set('a', ZERO)
    expect(c.pin(p('pg', 'in'))).toBe(ZERO)
    expect(c.pin(p('y', 'in'))).toBe(ONE)
  })

  it('LIVE mode: a slow gate downstream of a fast XOR sees the final value of a same-time double change', () => {
    // Both inputs of the XOR flip at the same time; XOR(1,1) = 0 must hold at the
    // slow inverter regardless of how the two switch events interleave.
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .switch('b', ZERO)
      .add('x', ComponentType.XOR2)
      .add('h', ComponentType.NOT, { delay: 6 })
      .probe('px')
      .probe('y')
      .wire(p('a', 'out'), p('x', 'in1'))
      .wire(p('b', 'out'), p('x', 'in2'))
      .connect(p('x', 'out'), p('h', 'in1'), p('px', 'in'))
      .wire(p('h', 'out'), p('y', 'in'))
      .build()
    c.setMany({ a: ONE, b: ONE })
    expect(c.pin(p('px', 'in'))).toBe(ZERO)
    expect(c.pin(p('y', 'in'))).toBe(ONE)
  })
})

// ---------------------------------------------------------------------------
// Simulator: composed gates
// ---------------------------------------------------------------------------

describe('Simulator: composed gates', () => {
  it('NOT(NAND2(a,b)) equals AND2(a,b) for every input and settles in 2 ns', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .switch('b', ZERO)
      .add('nd', ComponentType.NAND2)
      .add('n', ComponentType.NOT)
      .probe('pa')
      .probe('y')
      .connect(p('a', 'out'), p('nd', 'in1'), p('pa', 'in'))
      .wire(p('b', 'out'), p('nd', 'in2'))
      .wire(p('nd', 'out'), p('n', 'in1'))
      .wire(p('n', 'out'), p('y', 'in'))
      .build()
    for (const [a, b] of allCombos(2)) {
      c.setMany({ a, b })
      expect(c.pin(p('y', 'in')), `a=${a} b=${b}`).toBe(refAnd([a, b]))
    }
    c.setMany({ a: ZERO, b: ONE })
    c.set('a', ONE)
    expect(lastSample(c, 'y')).toEqual({ t: lastSample(c, 'pa').t + 2, v: ONE })
  })

  it('XOR2 built from four NAND2s matches the XOR2 part for every 0/1 input', () => {
    const b = new CircuitBuilder()
      .switch('a', ZERO)
      .switch('b', ZERO)
      .add('n1', ComponentType.NAND2)
      .add('n2', ComponentType.NAND2)
      .add('n3', ComponentType.NAND2)
      .add('n4', ComponentType.NAND2)
      .add('x', ComponentType.XOR2)
      .probe('pa')
      .probe('y')
      .probe('yx')
      .connect(p('a', 'out'), p('n1', 'in1'), p('n2', 'in1'), p('x', 'in1'), p('pa', 'in'))
      .connect(p('b', 'out'), p('n1', 'in2'), p('n3', 'in1'), p('x', 'in2'))
      .connect(p('n1', 'out'), p('n2', 'in2'), p('n3', 'in2'))
      .wire(p('n2', 'out'), p('n4', 'in1'))
      .wire(p('n3', 'out'), p('n4', 'in2'))
      .wire(p('n4', 'out'), p('y', 'in'))
      .wire(p('x', 'out'), p('yx', 'in'))
    const c = b.build()
    for (const [a, bb] of allCombos(2)) {
      c.setMany({ a, b: bb })
      expect(c.pin(p('y', 'in')), `a=${a} b=${bb}`).toBe(refXor([a, bb]))
      expect(c.pin(p('yx', 'in')), `a=${a} b=${bb}`).toBe(refXor([a, bb]))
      expect(c.oscillated).toBe(false)
    }
    // deepest path is three NAND levels: a=0->1 with b=1 changes y at +3
    c.setMany({ a: ZERO, b: ONE })
    c.set('a', ONE)
    expect(lastSample(c, 'y')).toEqual({ t: lastSample(c, 'pa').t + 3, v: ZERO })
  })

  it("De Morgan: NOR2(a,b) equals AND2(NOT a, NOT b) for every 0/1 input and with 'a' open", () => {
    const build = (openA: boolean): Circuit => {
      const b = new CircuitBuilder()
        .switch('a', ZERO)
        .switch('b', ZERO)
        .add('nor', ComponentType.NOR2)
        .add('na', ComponentType.NOT)
        .add('nb', ComponentType.NOT)
        .add('and', ComponentType.AND2)
        .probe('y1')
        .probe('y2')
      if (!openA) b.connect(p('a', 'out'), p('nor', 'in1'), p('na', 'in1'))
      b.connect(p('b', 'out'), p('nor', 'in2'), p('nb', 'in1'))
        .wire(p('na', 'out'), p('and', 'in1'))
        .wire(p('nb', 'out'), p('and', 'in2'))
        .wire(p('nor', 'out'), p('y1', 'in'))
        .wire(p('and', 'out'), p('y2', 'in'))
      return b.build()
    }
    const wired = build(false)
    for (const [a, b] of allCombos(2)) {
      wired.setMany({ a, b })
      expect(wired.pin(p('y1', 'in')), `a=${a} b=${b}`).toBe(refNot(refOr([a, b])))
      expect(wired.pin(p('y2', 'in')), `a=${a} b=${b}`).toBe(wired.pin(p('y1', 'in')))
    }
    const open = build(true)
    open.set('b', ONE)
    expect(open.pin(p('y1', 'in'))).toBe(ZERO) // NOR(Z,1) = 0
    expect(open.pin(p('y2', 'in'))).toBe(ZERO) // AND(X,0) = 0
    open.set('b', ZERO)
    expect(open.pin(p('y1', 'in'))).toBe(X) // NOR(Z,0) = X
    expect(open.pin(p('y2', 'in'))).toBe(X) // AND(X,1) = X
  })

  it('fan-out from one switch: XOR2(a,a) = 0, AND2(a,a) = a, NAND2(a,a) = NOT a', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .add('x', ComponentType.XOR2)
      .add('g', ComponentType.AND2)
      .add('nd', ComponentType.NAND2)
      .connect(p('a', 'out'), p('x', 'in1'), p('x', 'in2'), p('g', 'in1'), p('g', 'in2'), p('nd', 'in1'), p('nd', 'in2'))
      .build()
    for (const a of [ZERO, ONE, ZERO]) {
      c.set('a', a)
      expect(c.pin(p('x', 'out')), `a=${a}`).toBe(ZERO)
      expect(c.pin(p('g', 'out')), `a=${a}`).toBe(a)
      expect(c.pin(p('nd', 'out')), `a=${a}`).toBe(refNot(a))
    }
  })

  it('fan-out from one gate output feeds several gate inputs', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .switch('b', ZERO)
      .add('n', ComponentType.NOT)
      .add('g1', ComponentType.AND2)
      .add('g2', ComponentType.OR2)
      .add('g3', ComponentType.XNOR2)
      .connect(p('a', 'out'), p('n', 'in1'))
      .connect(p('n', 'out'), p('g1', 'in1'), p('g2', 'in1'), p('g3', 'in1'))
      .connect(p('b', 'out'), p('g1', 'in2'), p('g2', 'in2'), p('g3', 'in2'))
      .build()
    for (const [a, b] of allCombos(2)) {
      c.setMany({ a, b })
      const na = refNot(a)
      expect(c.pin(p('g1', 'out')), `a=${a} b=${b}`).toBe(refAnd([na, b]))
      expect(c.pin(p('g2', 'out')), `a=${a} b=${b}`).toBe(refOr([na, b]))
      expect(c.pin(p('g3', 'out')), `a=${a} b=${b}`).toBe(refNot(refXor([na, b])))
    }
  })

  it('virtual (label) connections drive gate inputs like wires', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .switch('b', ZERO)
      .switch('d', ZERO)
      .add('g', ComponentType.AND3)
      .label(p('a', 'out'), 'A')
      .label(p('g', 'in1'), 'A')
      .label(p('b', 'out'), 'B')
      .label(p('g', 'in2'), 'B')
      .wire(p('d', 'out'), p('g', 'in3')) // mixed: one wired input
      .build()
    for (const [a, b, d] of allCombos(3)) {
      c.setMany({ a, b, d })
      expect(c.pin(p('g', 'out')), `a=${a} b=${b} d=${d}`).toBe(refAnd([a, b, d]))
    }
  })

  it('a gate whose output is not wired anywhere still computes', () => {
    const c = new CircuitBuilder()
      .switch('a', ONE)
      .switch('b', ONE)
      .add('g', ComponentType.NOR2)
      .wire(p('a', 'out'), p('g', 'in1'))
      .wire(p('b', 'out'), p('g', 'in2'))
      .build()
    expect(c.pin(p('g', 'out'))).toBe(ZERO)
    c.setMany({ a: ZERO, b: ZERO })
    expect(c.pin(p('g', 'out'))).toBe(ONE)
  })

  it('a 3-level AND/OR/NOT network (sum of products) matches its boolean function', () => {
    // f = (a AND b) OR (NOT c AND d)
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .switch('b', ZERO)
      .switch('c', ZERO)
      .switch('d', ZERO)
      .add('g1', ComponentType.AND2)
      .add('nc', ComponentType.NOT)
      .add('g2', ComponentType.AND2)
      .add('o', ComponentType.OR2)
      .probe('y')
      .wire(p('a', 'out'), p('g1', 'in1'))
      .wire(p('b', 'out'), p('g1', 'in2'))
      .wire(p('c', 'out'), p('nc', 'in1'))
      .wire(p('nc', 'out'), p('g2', 'in1'))
      .wire(p('d', 'out'), p('g2', 'in2'))
      .wire(p('g1', 'out'), p('o', 'in1'))
      .wire(p('g2', 'out'), p('o', 'in2'))
      .wire(p('o', 'out'), p('y', 'in'))
      .build()
    for (const [a, b, cc, d] of allCombos(4)) {
      c.setMany({ a, b, c: cc, d })
      const expected = refOr([refAnd([a, b]), refAnd([refNot(cc), d])])
      expect(c.pin(p('y', 'in')), `a=${a} b=${b} c=${cc} d=${d}`).toBe(expected)
    }
  })

  it('two gate outputs on one net: agreeing drivers keep their value, disagreeing ones give X (decision 3)', () => {
    // net A: NOT n1(a) and NOT n2(a) -> always agree -> NOT a
    // net B: NOT n3(a) and AND2 buf(a, a) -> always disagree -> X
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .add('n1', ComponentType.NOT)
      .add('n2', ComponentType.NOT)
      .add('n3', ComponentType.NOT)
      .add('buf', ComponentType.AND2)
      .add('ra', ComponentType.AND2) // reader of net A (with in2 = 1)
      .add('rb', ComponentType.OR2) // reader of net B (with in2 = 0)
      .switch('one', ONE)
      .switch('zero', ZERO)
      .probe('pA')
      .probe('pB')
      .connect(p('a', 'out'), p('n1', 'in1'), p('n2', 'in1'), p('n3', 'in1'), p('buf', 'in1'), p('buf', 'in2'))
      .connect(p('n1', 'out'), p('n2', 'out'), p('ra', 'in1'), p('pA', 'in'))
      .connect(p('n3', 'out'), p('buf', 'out'), p('rb', 'in1'), p('pB', 'in'))
      .wire(p('one', 'out'), p('ra', 'in2'))
      .wire(p('zero', 'out'), p('rb', 'in2'))
      .build()
    for (const a of [ZERO, ONE, ZERO]) {
      c.set('a', a)
      expect(c.pin(p('pA', 'in')), `a=${a} net A`).toBe(refNot(a))
      expect(c.pin(p('ra', 'out')), `a=${a} AND(netA, 1)`).toBe(refNot(a))
      expect(c.pin(p('pB', 'in')), `a=${a} net B`).toBe(X)
      expect(c.pin(p('rb', 'out')), `a=${a} OR(netB, 0)`).toBe(X)
    }
  })
})

// ---------------------------------------------------------------------------
// Simulator: X and Z on several inputs at once
// ---------------------------------------------------------------------------

describe('Simulator: X and Z on several inputs at once', () => {
  describe.each(GATES)('$type', ({ type, arity }) => {
    it('outputs X when every input is X-driven', () => {
      const b = new CircuitBuilder().add('g', type)
      for (let i = 1; i <= arity; i++) b.add(`x${i}`, ComponentType.NOT).wire(p(`x${i}`, 'out'), inPin(i))
      const c = b.build()
      for (let i = 1; i <= arity; i++) expect(c.pin(inPin(i)), `in${i}`).toBe(X)
      expect(c.pin(OUT)).toBe(X)
    })

    if (arity >= 2) {
      it('outputs X when one input is X-driven and the rest are unconnected', () => {
        const c = new CircuitBuilder()
          .add('g', type)
          .add('xs', ComponentType.NOT)
          .wire(p('xs', 'out'), inPin(1))
          .build()
        expect(c.pin(inPin(1))).toBe(X)
        for (let i = 2; i <= arity; i++) expect(c.pin(inPin(i)), `in${i}`).toBe(Z)
        expect(c.pin(OUT)).toBe(X)
      })
    }
  })

  /** in1 = X (open NOT), in2 = Z (unconnected), in3 = switch s. */
  function xzs(type: ComponentType): Circuit {
    return new CircuitBuilder()
      .add('g', type)
      .add('xs', ComponentType.NOT)
      .switch('s', ZERO)
      .probe('y')
      .wire(p('xs', 'out'), inPin(1))
      .wire(p('s', 'out'), inPin(3))
      .wire(OUT, PROBE)
      .build()
  }

  it.each([
    [ComponentType.AND3, ZERO, ZERO],
    [ComponentType.AND3, ONE, X],
    [ComponentType.OR3, ONE, ONE],
    [ComponentType.OR3, ZERO, X],
    [ComponentType.NAND3, ZERO, ONE],
    [ComponentType.NAND3, ONE, X],
    [ComponentType.NOR3, ONE, ZERO],
    [ComponentType.NOR3, ZERO, X]
  ] as [ComponentType, LogicValue, LogicValue][])('%s(X, Z, %s) = %s', (type, s, expected) => {
    const c = xzs(type)
    c.set('s', s)
    expect(c.pin(inPin(1))).toBe(X)
    expect(c.pin(inPin(2))).toBe(Z)
    expect(c.pin(inPin(3))).toBe(s)
    expect(c.pin(PROBE)).toBe(expected)
  })

  it.each([ComponentType.XOR2, ComponentType.XNOR2])('%s(X, Z) = X', (type) => {
    const c = new CircuitBuilder()
      .add('g', type)
      .add('xs', ComponentType.NOT)
      .wire(p('xs', 'out'), inPin(1))
      .build()
    expect(c.pin(inPin(1))).toBe(X)
    expect(c.pin(inPin(2))).toBe(Z)
    expect(c.pin(OUT)).toBe(X)
  })

  it('a transition to X honours the gate delay (AND2 delay 3, in1 released to Z by a tristate)', () => {
    const c = new CircuitBuilder()
      .switch('ctl', ONE)
      .switch('d', ONE)
      .switch('b', ONE)
      .add('ts', ComponentType.TRISTATE_RIGHT)
      .add('g', ComponentType.AND2, { delay: 3 })
      .probe('p1')
      .probe('y')
      .wire(p('ctl', 'out'), p('ts', 'ctl'))
      .wire(p('d', 'out'), p('ts', 'in'))
      .connect(p('ts', 'out'), inPin(1), p('p1', 'in'))
      .wire(p('b', 'out'), inPin(2))
      .wire(OUT, PROBE)
      .build()
    expect(c.pin(inPin(1))).toBe(ONE)
    expect(c.pin(PROBE)).toBe(ONE)
    c.set('ctl', ZERO)
    const tZ = lastSample(c, 'p1')
    expect(tZ.v).toBe(Z)
    expect(lastSample(c, 'y')).toEqual({ t: tZ.t + 3, v: X })
    expect(c.time).toBe(tZ.t + 3)
    // and back to a clean value, again 3 ns after the input
    c.set('ctl', ONE)
    const tOne = lastSample(c, 'p1')
    expect(tOne.v).toBe(ONE)
    expect(lastSample(c, 'y')).toEqual({ t: tOne.t + 3, v: ONE })
  })
})

// ---------------------------------------------------------------------------
// Simulator: inertial delay (implementation decision 2)
// ---------------------------------------------------------------------------

/**
 * a --+---------------------------> g.in1
 *     +-- NOT n (notDelay) --------> g.in2      g (gateDelay) -> probe y; probe pa on a
 * g(a, NOT a) is constant in steady state; toggling `a` opens a `notDelay` ns
 * window in which both inputs carry the new value of `a`.
 */
function hazardCircuit(type: ComponentType, initial: LogicValue, notDelay: number, gateDelay: number): Circuit {
  return new CircuitBuilder()
    .switch('a', initial)
    .add('n', ComponentType.NOT, { delay: notDelay })
    .add('g', type, { delay: gateDelay })
    .probe('pa')
    .probe('y')
    .connect(p('a', 'out'), p('n', 'in1'), p('g', 'in1'), p('pa', 'in'))
    .wire(p('n', 'out'), p('g', 'in2'))
    .wire(p('g', 'out'), p('y', 'in'))
    .build()
}

/** [notDelay, gateDelay] pairs where the input pulse is shorter than the gate delay. */
const SWALLOWED: [number, number][] = [
  [1, 2],
  [1, 3],
  [2, 3],
  [1, 5],
  [4, 5]
]
/** [notDelay, gateDelay] pairs where the pulse is at least as long as the gate delay. */
const PASSED: [number, number][] = [
  [1, 1],
  [2, 2],
  [2, 1],
  [3, 2],
  [5, 1],
  [5, 5]
]

describe('Simulator: inertial delay (decision 2)', () => {
  it('AND2(a, NOT a) with NOT delay 1 and AND delay 2 stays 0 after a rises (no output event at all)', () => {
    const c = hazardCircuit(ComponentType.AND2, ZERO, 1, 2)
    expect(samples(c, 'y')).toEqual([{ t: 0, v: ZERO }])
    c.set('a', ONE)
    expect(c.pin(PA)).toBe(ONE)
    expect(c.pin(p('n', 'out'))).toBe(ZERO)
    expect(samples(c, 'y')).toEqual([{ t: 0, v: ZERO }])
    expect(c.pin(PY)).toBe(ZERO)
    expect(c.oscillated).toBe(false)
  })

  it('AND2(a, NOT a) with NOT delay 1 and AND delay 1 shows a 1 ns glitch after a rises', () => {
    const c = hazardCircuit(ComponentType.AND2, ZERO, 1, 1)
    c.set('a', ONE)
    const tA = lastSample(c, 'pa').t
    expect(samples(c, 'y')).toEqual([
      { t: 0, v: ZERO },
      { t: tA + 1, v: ONE },
      { t: tA + 2, v: ZERO }
    ])
    expect(c.pin(PY)).toBe(ZERO)
  })

  it('AND2(a, NOT a): a falling never glitches (AND(0, x) = 0 throughout)', () => {
    for (const [nd, gd] of [...SWALLOWED, ...PASSED]) {
      const c = hazardCircuit(ComponentType.AND2, ONE, nd, gd)
      expect(samples(c, 'y'), `NOT ${nd} / AND ${gd}`).toEqual([{ t: 0, v: ZERO }])
      c.set('a', ZERO)
      expect(samples(c, 'y'), `NOT ${nd} / AND ${gd}`).toEqual([{ t: 0, v: ZERO }])
    }
  })

  // Every 2-input gate g(a, NOT a): during the window both inputs equal the new
  // value of a, so the output would momentarily be g(a', a'). That pulse is
  // exactly notDelay ns wide; it reaches the output iff notDelay >= gateDelay.
  describe.each(GATES.filter((g) => g.arity === 2))('$type(a, NOT a)', ({ type, family }) => {
    for (const from of [ZERO, ONE]) {
      const to = refNot(from)
      const steady = ref(family, [from, refNot(from)])
      const windowValue = ref(family, [to, to])
      const dir = `a ${from}->${to}`

      if (windowValue === steady) {
        it.each([...SWALLOWED, ...PASSED])(`${dir}: output constant ${steady} (NOT %i ns / gate %i ns), no event`, (nd, gd) => {
          const c = hazardCircuit(type, from, nd, gd)
          expect(samples(c, 'y')).toEqual([{ t: 0, v: steady }])
          c.set('a', to)
          expect(samples(c, 'y')).toEqual([{ t: 0, v: steady }])
          expect(c.pin(PY)).toBe(steady)
        })
        continue
      }

      it.each(SWALLOWED)(`${dir}: NOT %i ns / gate %i ns -> the ${windowValue} pulse is shorter than the delay and is swallowed`, (nd, gd) => {
        const c = hazardCircuit(type, from, nd, gd)
        expect(samples(c, 'y')).toEqual([{ t: 0, v: steady }])
        c.set('a', to)
        expect(c.pin(PA)).toBe(to)
        expect(samples(c, 'y')).toEqual([{ t: 0, v: steady }])
        expect(c.pin(PY)).toBe(steady)
        expect(c.oscillated).toBe(false)
      })

      it.each(PASSED)(`${dir}: NOT %i ns / gate %i ns -> a ${windowValue} glitch lasting NOT-delay ns appears`, (nd, gd) => {
        const c = hazardCircuit(type, from, nd, gd)
        c.set('a', to)
        const tA = lastSample(c, 'pa').t
        expect(samples(c, 'y')).toEqual([
          { t: 0, v: steady },
          { t: tA + gd, v: windowValue },
          { t: tA + gd + nd, v: steady }
        ])
        expect(c.pin(PY)).toBe(steady)
        expect(c.time).toBe(tA + gd + nd)
      })
    }
  })

  it('CHANGE mode: a 1 ns switch pulse into a 5 ns inverter produces no output event', () => {
    const c = inverter(5)
    expect(samples(c, 'y')).toEqual([{ t: 0, v: ONE }])
    c.sim.toggle('a', false)
    expect(c.sim.changeStep()).toBe(true) // a.out rises at t = 1
    expect(c.time).toBe(1)
    expect(c.pin(PA)).toBe(ONE)
    expect(c.pin(PY)).toBe(ONE) // NOT output still pending (would be at t = 6)
    c.sim.toggle('a', false) // a falls again at t = 2
    c.sim.drain()
    expect(samples(c, 'pa')).toEqual([
      { t: 0, v: ZERO },
      { t: 1, v: ONE },
      { t: 2, v: ZERO }
    ])
    expect(samples(c, 'y')).toEqual([{ t: 0, v: ONE }])
    expect(c.pin(PY)).toBe(ONE)
  })
})

// ---------------------------------------------------------------------------
// Simulator: waveform-driven inverter (manual Appendix B example)
// ---------------------------------------------------------------------------

/** INPUT_SIGNAL s -> NOT n (delay) -> probe y; probe pa on the signal net. */
function signalInverter(rows: [number, LogicValue][], delay: number): Circuit {
  return new CircuitBuilder()
    .add('s', ComponentType.INPUT_SIGNAL, { signal: rows.map(([timeNs, value]) => ({ timeNs, value })) })
    .add('n', ComponentType.NOT, { delay })
    .probe('pa')
    .probe('y')
    .connect(p('s', 'out'), p('n', 'in1'), p('pa', 'in'))
    .wire(p('n', 'out'), p('y', 'in'))
    .build()
}

describe('Simulator: inverter driven by an input waveform (manual Appendix B)', () => {
  it('input to 1 at 4 ns, inverter delay 2 -> output to 0 at 6 ns (Go)', () => {
    const c = signalInverter([[0, ZERO], [4, ONE]], 2)
    expect(c.time).toBe(0)
    expect(samples(c, 'pa')).toEqual([{ t: 0, v: ZERO }])
    expect(samples(c, 'y')).toEqual([{ t: 0, v: ONE }])
    c.go()
    expect(samples(c, 'pa')).toEqual([
      { t: 0, v: ZERO },
      { t: 4, v: ONE }
    ])
    expect(samples(c, 'y')).toEqual([
      { t: 0, v: ONE },
      { t: 6, v: ZERO }
    ])
  })

  it('input to 1 at 4 ns, inverter delay 2 -> the pending change sits in the queue until Change applies it at 6 ns', () => {
    const c = signalInverter([[0, ZERO], [4, ONE]], 2)
    c.step() // with only input signals, Step runs to the next queued change
    expect(c.time).toBe(4)
    expect(c.pin(PA)).toBe(ONE)
    expect(c.pin(PY)).toBe(ONE) // still pending
    expect(c.sim.changeStep()).toBe(true)
    expect(c.time).toBe(6)
    expect(c.pin(PY)).toBe(ZERO)
    expect(samples(c, 'y')).toEqual([
      { t: 0, v: ONE },
      { t: 6, v: ZERO }
    ])
    expect(c.sim.changeStep()).toBe(false) // nothing else pending
  })

  it('a 2 ns input pulse into a 2 ns inverter (equal) appears on the output as a 2 ns pulse', () => {
    const c = signalInverter([[0, ZERO], [4, ONE], [6, ZERO]], 2)
    c.go()
    expect(samples(c, 'y')).toEqual([
      { t: 0, v: ONE },
      { t: 6, v: ZERO },
      { t: 8, v: ONE }
    ])
  })

  it('a 3 ns input pulse into a 2 ns inverter (longer) appears on the output as a 3 ns pulse', () => {
    const c = signalInverter([[0, ZERO], [4, ONE], [7, ZERO]], 2)
    c.go()
    expect(samples(c, 'y')).toEqual([
      { t: 0, v: ONE },
      { t: 6, v: ZERO },
      { t: 9, v: ONE }
    ])
  })

  it('a 1 ns input pulse into a 2 ns inverter (shorter) never reaches the output', () => {
    const c = signalInverter([[0, ZERO], [4, ONE], [5, ZERO]], 2)
    c.go()
    expect(samples(c, 'pa')).toEqual([
      { t: 0, v: ZERO },
      { t: 4, v: ONE },
      { t: 5, v: ZERO }
    ])
    expect(samples(c, 'y')).toEqual([{ t: 0, v: ONE }])
    expect(c.pin(PY)).toBe(ONE)
  })

  it('a 4 ns input pulse into a 5 ns inverter never reaches the output; a 5 ns one does', () => {
    const short = signalInverter([[0, ZERO], [10, ONE], [14, ZERO]], 5)
    short.go()
    expect(samples(short, 'y')).toEqual([{ t: 0, v: ONE }])
    const exact = signalInverter([[0, ZERO], [10, ONE], [15, ZERO]], 5)
    exact.go()
    expect(samples(exact, 'y')).toEqual([
      { t: 0, v: ONE },
      { t: 15, v: ZERO },
      { t: 20, v: ONE }
    ])
  })

  it('X and Z rows propagate as X through the inverter after its delay', () => {
    const c = signalInverter([[0, ZERO], [4, X], [8, Z], [12, ONE]], 2)
    c.go()
    expect(samples(c, 'pa')).toEqual([
      { t: 0, v: ZERO },
      { t: 4, v: X },
      { t: 8, v: Z },
      { t: 12, v: ONE }
    ])
    // NOT(X) = NOT(Z) = X, so the output changes only twice
    expect(samples(c, 'y')).toEqual([
      { t: 0, v: ONE },
      { t: 6, v: X },
      { t: 14, v: ZERO }
    ])
  })
})

// ---------------------------------------------------------------------------
// Simulator: same-instant input changes and Reset
// ---------------------------------------------------------------------------

describe('Simulator: same-instant input changes are evaluated together (decision 1)', () => {
  it('XOR2: both inputs flip at the same instant -> no output event at all', () => {
    const c = gateCircuit(ComponentType.XOR2, 2)
    expect(samples(c, 'y')).toEqual([{ t: 0, v: ZERO }])
    c.setMany({ s1: ONE, s2: ONE })
    expect(c.pin(inPin(1))).toBe(ONE)
    expect(c.pin(inPin(2))).toBe(ONE)
    expect(samples(c, 'y')).toEqual([{ t: 0, v: ZERO }])
    c.setMany({ s1: ZERO, s2: ZERO })
    expect(samples(c, 'y')).toEqual([{ t: 0, v: ZERO }])
  })

  it('AND2: in1 rises while in2 falls at the same instant -> output stays 0 with no event', () => {
    const c = gateCircuit(ComponentType.AND2, 2)
    c.set(sw(2), ONE)
    expect(samples(c, 'y')).toEqual([{ t: 0, v: ZERO }])
    c.setMany({ s1: ONE, s2: ZERO })
    expect(samples(c, 'y')).toEqual([{ t: 0, v: ZERO }])
    expect(c.pin(PROBE)).toBe(ZERO)
  })

  it('AND2: both inputs rise at once -> exactly one output event, 1 ns after the inputs', () => {
    const c = gateCircuit(ComponentType.AND2, 2)
    c.setMany({ s1: ONE, s2: ONE })
    const tIn = lastSample(c, 'ps').t
    expect(samples(c, 'y')).toEqual([
      { t: 0, v: ZERO },
      { t: tIn + 1, v: ONE }
    ])
  })

  it('NAND3: all three inputs rise at once -> one clean 1->0 transition after the delay', () => {
    const c = gateCircuit(ComponentType.NAND3, 3, { delay: 2 })
    c.setMany({ s1: ONE, s2: ONE, s3: ONE })
    const tIn = lastSample(c, 'ps').t
    expect(samples(c, 'y')).toEqual([
      { t: 0, v: ONE },
      { t: tIn + 2, v: ZERO }
    ])
  })
})

describe('Simulator: Reset presents the settled circuit at t = 0 (decision 4)', () => {
  it('right after build the time is 0 and every probe has exactly one sample at t = 0', () => {
    const c = gateCircuit(ComponentType.NOR3, 3)
    expect(c.time).toBe(0)
    expect(samples(c, 'ps')).toEqual([{ t: 0, v: ZERO }])
    expect(samples(c, 'y')).toEqual([{ t: 0, v: ONE }])
  })

  it('a gate chain is fully settled at t = 0 (no X transient left over from evaluation order)', () => {
    // g placed BEFORE its driver n so a naive in-order evaluation would see X first.
    const c = new CircuitBuilder()
      .add('g', ComponentType.AND2)
      .add('n', ComponentType.NOT)
      .switch('a', ZERO)
      .switch('b', ONE)
      .probe('y')
      .wire(p('a', 'out'), p('n', 'in1'))
      .wire(p('n', 'out'), p('g', 'in1'))
      .wire(p('b', 'out'), p('g', 'in2'))
      .wire(p('g', 'out'), p('y', 'in'))
      .build()
    expect(c.time).toBe(0)
    expect(samples(c, 'y')).toEqual([{ t: 0, v: ONE }])
  })

  it('reset() returns time to 0, clears the traces to one t = 0 sample and re-settles from the switch positions', () => {
    const c = gateCircuit(ComponentType.AND2, 2, { delay: 3 })
    c.setMany({ s1: ONE, s2: ONE })
    expect(c.time).toBeGreaterThan(0)
    expect(samples(c, 'y').length).toBe(2)
    c.reset()
    expect(c.time).toBe(0)
    const in1 = c.pin(inPin(1))
    const in2 = c.pin(inPin(2))
    expect(samples(c, 'ps')).toEqual([{ t: 0, v: in1 }])
    expect(samples(c, 'y')).toEqual([{ t: 0, v: refAnd([in1, in2]) }])
    expect(c.pin(PROBE)).toBe(refAnd([in1, in2]))
    // toggling after reset propagates with the same delays as before
    c.set(sw(1), refNot(in1))
    expect(lastSample(c, 'y').t - lastSample(c, 'ps').t).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Simulator: delay range and gate feedback loops
// ---------------------------------------------------------------------------

describe('Simulator: delay range', () => {
  it('delay 999 (top of the manual range): output changes 999 ns after the input', () => {
    const c = inverter(999)
    c.set('a', ONE)
    const tIn = lastSample(c, 'pa')
    expect(lastSample(c, 'y')).toEqual({ t: tIn.t + 999, v: ZERO })
    expect(c.time).toBe(tIn.t + 999)
  })

  it('a slow gate (999) and a fast gate (1) on the same input each keep their own delay', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .add('slow', ComponentType.OR2, { delay: 999 })
      .add('fast', ComponentType.OR2, { delay: 1 })
      .probe('pa')
      .probe('ys')
      .probe('yf')
      .connect(p('a', 'out'), p('slow', 'in1'), p('slow', 'in2'), p('fast', 'in1'), p('fast', 'in2'), p('pa', 'in'))
      .wire(p('slow', 'out'), p('ys', 'in'))
      .wire(p('fast', 'out'), p('yf', 'in'))
      .build()
    c.set('a', ONE)
    const tA = lastSample(c, 'pa').t
    expect(lastSample(c, 'yf')).toEqual({ t: tA + 1, v: ONE })
    expect(lastSample(c, 'ys')).toEqual({ t: tA + 999, v: ONE })
  })
})

describe('Simulator: gate feedback loops', () => {
  /** Cross-coupled NOR2 SR latch: q = NOR(r, qbar), qbar = NOR(s, q). */
  function srLatch(): Circuit {
    return new CircuitBuilder()
      .switch('s', ZERO)
      .switch('r', ZERO)
      .add('nq', ComponentType.NOR2)
      .add('nqb', ComponentType.NOR2)
      .probe('q')
      .probe('qb')
      .wire(p('r', 'out'), p('nq', 'in1'))
      .wire(p('s', 'out'), p('nqb', 'in1'))
      .connect(p('nq', 'out'), p('nqb', 'in2'), p('q', 'in'))
      .connect(p('nqb', 'out'), p('nq', 'in2'), p('qb', 'in'))
      .build()
  }
  const Q = p('q', 'in')
  const QB = p('qb', 'in')

  it('NOR2 SR latch: unknown until set; then set, hold, reset, hold; S=R=1 forces both outputs 0', () => {
    const c = srLatch()
    expect(c.pin(Q)).toBe(X)
    expect(c.pin(QB)).toBe(X)
    expect(c.oscillated).toBe(false)

    c.set('s', ONE)
    expect(c.pin(Q)).toBe(ONE)
    expect(c.pin(QB)).toBe(ZERO)
    c.set('s', ZERO) // hold
    expect(c.pin(Q)).toBe(ONE)
    expect(c.pin(QB)).toBe(ZERO)

    c.set('r', ONE)
    expect(c.pin(Q)).toBe(ZERO)
    expect(c.pin(QB)).toBe(ONE)
    c.set('r', ZERO) // hold
    expect(c.pin(Q)).toBe(ZERO)
    expect(c.pin(QB)).toBe(ONE)

    c.set('s', ONE)
    expect(c.pin(Q)).toBe(ONE)
    c.set('r', ONE) // S = R = 1
    expect(c.pin(Q)).toBe(ZERO)
    expect(c.pin(QB)).toBe(ZERO)
    c.set('r', ZERO) // S still 1 -> set
    expect(c.pin(Q)).toBe(ONE)
    expect(c.pin(QB)).toBe(ZERO)
    expect(c.oscillated).toBe(false)
  })

  it('NOR2 SR latch: set takes 2 gate delays (qbar first, then q)', () => {
    const c = srLatch()
    c.set('s', ONE)
    const tQb = lastSample(c, 'qb')
    const tQ = lastSample(c, 'q')
    expect(tQb.v).toBe(ZERO)
    expect(tQ.v).toBe(ONE)
    expect(tQ.t - tQb.t).toBe(1)
    expect(c.time).toBe(tQ.t)
  })

  it('NOR2 SR latch: releasing S = R = 1 together (equal delays) is metastable -> outputs X, run terminates', () => {
    const c = srLatch()
    c.setMany({ s: ONE, r: ONE })
    expect(c.pin(Q)).toBe(ZERO)
    expect(c.pin(QB)).toBe(ZERO)
    c.setMany({ s: ZERO, r: ZERO })
    expect(c.pin(Q)).toBe(X)
    expect(c.pin(QB)).toBe(X)
  })

  it('NAND2 with its output fed back to in2: a = 0 is stable at 1; a = 1 oscillates, is flagged and reads X', () => {
    const c = new CircuitBuilder()
      .switch('a', ZERO)
      .add('g', ComponentType.NAND2)
      .probe('y')
      .wire(p('a', 'out'), p('g', 'in1'))
      .connect(p('g', 'out'), p('g', 'in2'), p('y', 'in'))
      .build()
    expect(c.pin(PY)).toBe(ONE)
    expect(c.oscillated).toBe(false)
    c.set('a', ONE)
    expect(c.oscillated).toBe(true)
    expect(c.pin(PY)).toBe(X)
    // a back to 0 resolves the loop again: NAND(0, x) = 1
    c.set('a', ZERO)
    expect(c.oscillated).toBe(false)
    expect(c.pin(PY)).toBe(ONE)
  })

  it('a NOT gate driving its own input is X and does not oscillate (NOT X = X)', () => {
    const c = new CircuitBuilder()
      .add('n', ComponentType.NOT)
      .probe('y')
      .connect(p('n', 'out'), p('n', 'in1'), p('y', 'in'))
      .build()
    expect(c.pin(PY)).toBe(X)
    expect(c.oscillated).toBe(false)
    expect(samples(c, 'y')).toEqual([{ t: 0, v: X }])
  })
})
