// Unit verification of the N-bit combinational parts: N_ADDER, N_MUX_2TO1 and
// N_TRISTATE (SimUaid Reference Manual, Appendix A; condensed spec "N-bit parts").
//
// Every assertion states SPEC-CORRECT behavior. Conventions used throughout:
//   * data pin i is bit i (bit 0 = LSB); vectors handed to helpers are numbers,
//   * strings read back from the circuit are MSB-first ("0101" == 5),
//   * parts are driven by SWITCHes either through drawn wires ('wire' mode) or
//     through shared pin labels ('label' mode — virtual connections),
//   * an "X source" is a NOT gate whose input is left unconnected (Z -> X),
//   * a 'z' feed leaves the pin unconnected.

import { beforeAll, describe, expect, it } from 'vitest'
import { ComponentType, LogicValue, type Component } from '../../model/types'
import {
  DEFAULT_BITS,
  MAX_BITS,
  MIN_BITS,
  defOf,
  effectiveBits,
  isBusType,
  isNBitType,
  maxBitsFor,
  type PinDef
} from '../../model/partDefinitions'
import { clean, numToVec, vecToNum, xVec, zVec } from '../values'
import { CircuitBuilder, type Circuit, p } from './harness'

const { ZERO, ONE, X, Z } = LogicValue

// ---------------------------------------------------------------------------
// Local helpers (the shared harness has no N-bit rig, so one lives here).
// ---------------------------------------------------------------------------

type Mode = 'wire' | 'label'
/** How an input pin of the part under test is fed. */
type Feed = 'switch' | 'z' | 'x'

interface PartSpec {
  type: ComponentType
  /** undefined => the `bits` key is omitted from the component (DEFAULT_BITS path). */
  bits?: number
  inputs: string[]
  outputs: string[]
  delay?: number
}

const PART = 'U'
const probeId = (pin: string): string => `P_${pin}`
const xSourceId = (pin: string): string => `XS_${pin}`

function names(prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`)
}

/** The width the part definition actually exposes for a requested `bits`. */
function clampBits(bits: number | undefined): number {
  return Math.min(MAX_BITS, Math.max(MIN_BITS, bits ?? DEFAULT_BITS))
}

function adderSpec(bits: number | undefined, delay?: number): PartSpec {
  const w = clampBits(bits)
  return {
    type: ComponentType.N_ADDER,
    bits,
    inputs: [...names('X', w), ...names('Y', w), 'Cin'],
    outputs: [...names('S', w), 'Cout'],
    delay
  }
}

function muxSpec(bits: number | undefined, delay?: number): PartSpec {
  const w = clampBits(bits)
  return {
    type: ComponentType.N_MUX_2TO1,
    bits,
    inputs: [...names('X', w), ...names('Y', w), 'S'],
    outputs: names('Z', w),
    delay
  }
}

function tristateSpec(bits: number | undefined, delay?: number): PartSpec {
  const w = clampBits(bits)
  return {
    type: ComponentType.N_TRISTATE,
    bits,
    inputs: [...names('in', w), 'ctl'],
    outputs: names('out', w),
    delay
  }
}

/** MSB-first binary string of the low `n` bits of `value`. */
function bin(value: number, n: number): string {
  return (value & ((1 << n) - 1)).toString(2).padStart(n, '0')
}

function vecSwitches(prefix: string, n: number, value: number): Record<string, LogicValue> {
  const out: Record<string, LogicValue> = {}
  for (let i = 0; i < n; i++) out[`${prefix}${i}`] = (value >> i) & 1 ? ONE : ZERO
  return out
}

/** Deterministic PRNG (mulberry32) so the random samples are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface AddCase {
  x: number
  y: number
  cin: 0 | 1
}

function randomAddCases(n: number, count: number, seed: number): AddCase[] {
  const r = rng(seed)
  const span = 1 << n
  return Array.from({ length: count }, () => ({
    x: Math.floor(r() * span),
    y: Math.floor(r() * span),
    cin: r() < 0.5 ? 0 : 1
  }))
}

function edgeAddCases(n: number): AddCase[] {
  const max = (1 << n) - 1
  const alt = n === 8 ? 0xaa : 0xaaaa
  const altInv = n === 8 ? 0x55 : 0x5555
  const half = 1 << (n - 1)
  return [
    { x: 0, y: 0, cin: 0 },
    { x: 0, y: 0, cin: 1 },
    { x: max, y: 0, cin: 0 },
    { x: 0, y: max, cin: 0 },
    { x: max, y: 0, cin: 1 }, // max + 1 -> wraps to 0 with Cout
    { x: 0, y: max, cin: 1 },
    { x: max, y: 1, cin: 0 },
    { x: 1, y: max, cin: 0 },
    { x: max, y: max, cin: 0 },
    { x: max, y: max, cin: 1 },
    { x: alt, y: altInv, cin: 0 }, // 1010.. + 0101.. = all ones, no carry
    { x: alt, y: altInv, cin: 1 }, // ... + 1 = wraps
    { x: alt, y: alt, cin: 0 },
    { x: altInv, y: altInv, cin: 0 },
    { x: altInv, y: altInv, cin: 1 },
    { x: half, y: half, cin: 0 }, // MSB carry only
    { x: half - 1, y: 1, cin: 0 }, // long carry chain through the low bits
    { x: half - 1, y: 0, cin: 1 },
    { x: 1, y: 1, cin: 1 }
  ]
}

/** A part under test wired to switches / X sources / probes, with typed accessors. */
class Rig {
  constructor(
    readonly c: Circuit,
    readonly spec: PartSpec,
    private readonly switchIds: ReadonlySet<string>
  ) {}

  /** Sets switches (ignoring pins that are not fed by a switch) and settles. */
  set(values: Record<string, LogicValue>): this {
    const filtered: Record<string, LogicValue> = {}
    for (const [id, v] of Object.entries(values)) if (this.switchIds.has(id)) filtered[id] = v
    this.c.setMany(filtered)
    return this
  }

  setVec(prefix: string, n: number, value: number): this {
    return this.set(vecSwitches(prefix, n, value))
  }

  /** Value at the probe attached to an output pin. */
  out(pin: string): LogicValue {
    return this.c.pin(p(probeId(pin), 'in'))
  }

  /** MSB-first string of probes on `prefix0..prefix{n-1}`. */
  outVec(prefix: string, n: number): string {
    let s = ''
    for (let i = n - 1; i >= 0; i--) s += this.out(`${prefix}${i}`)
    return s
  }
}

function buildRig(
  spec: PartSpec,
  mode: Mode,
  feeds: Record<string, Feed> = {},
  initial: Record<string, LogicValue> = {}
): Rig {
  const b = new CircuitBuilder()
  const opts: Partial<Omit<Component, 'id' | 'type'>> = { delay: spec.delay ?? 1 }
  if (spec.bits !== undefined) opts.bits = spec.bits
  b.add(PART, spec.type, opts)

  const link = (from: string, to: string, label: string): void => {
    if (mode === 'wire') {
      b.wire(from, to)
    } else {
      b.label(from, label)
      b.label(to, label)
    }
  }

  const switchIds = new Set<string>()
  for (const pin of spec.inputs) {
    const feed = feeds[pin] ?? 'switch'
    if (feed === 'z') continue
    if (feed === 'switch') {
      b.switch(pin, initial[pin] ?? ZERO)
      switchIds.add(pin)
      link(p(pin, 'out'), p(PART, pin), `L_${pin}`)
    } else {
      b.add(xSourceId(pin), ComponentType.NOT) // in1 unconnected (Z) => out is X
      link(p(xSourceId(pin), 'out'), p(PART, pin), `L_${pin}`)
    }
  }
  for (const pin of spec.outputs) {
    b.probe(probeId(pin))
    link(p(PART, pin), p(probeId(pin), 'in'), `L_${pin}`)
  }
  return new Rig(b.build(), spec, switchIds)
}

// --- adder-specific drivers ---

function addAndCheck(rig: Rig, n: number, x: number, y: number, cin: 0 | 1): void {
  rig.set({ ...vecSwitches('X', n, x), ...vecSwitches('Y', n, y), Cin: cin ? ONE : ZERO })
  const total = x + y + cin
  expect(rig.outVec('S', n), `S for ${x} + ${y} + ${cin} (n=${n})`).toBe(bin(total, n))
  expect(rig.out('Cout'), `Cout for ${x} + ${y} + ${cin} (n=${n})`).toBe(total >> n ? ONE : ZERO)
}

function expectAdderAllX(rig: Rig, n: number, why: string): void {
  expect(rig.outVec('S', n), `S ${why}`).toBe('X'.repeat(n))
  expect(rig.out('Cout'), `Cout ${why}`).toBe(X)
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i)
}

function pinsOf(type: ComponentType, bits?: number): PinDef[] {
  return defOf({ type, bits }).pins
}

function pinNames(type: ComponentType, bits?: number): string[] {
  return pinsOf(type, bits).map((pin) => pin.name)
}

// ---------------------------------------------------------------------------
// Part definitions: pin names, roles, ordering, DEFAULT_BITS, clamping.
// ---------------------------------------------------------------------------

describe('part definitions: N-bit combinational pin sets', () => {
  it('MIN_BITS/MAX_BITS match the manual range of 2 to 16 bits', () => {
    expect(MIN_BITS).toBe(2)
    expect(MAX_BITS).toBe(16)
  })

  it.each([2, 3, 4, 8, 16])('N_ADDER %i-bit exposes exactly X/Y/S rows plus Cin and Cout', (n) => {
    const pins = pinsOf(ComponentType.N_ADDER, n)
    const expected = [...names('X', n), ...names('Y', n), ...names('S', n), 'Cout', 'Cin'].sort()
    expect(pins.map((pin) => pin.name).sort()).toEqual(expected)
    for (const pin of pins) {
      const isOut = pin.name.startsWith('S') || pin.name === 'Cout'
      expect(pin.role, `role of ${pin.name}`).toBe(isOut ? 'output' : 'input')
      expect(pin.width, `${pin.name} is a single-bit pin`).toBeUndefined()
    }
  })

  it('N_ADDER: X row sits left of the Y row (S=0 selects "left" convention shared with the mux)', () => {
    const pins = pinsOf(ComponentType.N_ADDER, 4)
    const dx = (name: string): number => pins.find((pin) => pin.name === name)!.dx
    expect(Math.max(...names('X', 4).map(dx))).toBeLessThan(Math.min(...names('Y', 4).map(dx)))
  })

  it('N_ADDER: bit index increases monotonically along each data row (X, Y and S agree)', () => {
    const pins = pinsOf(ComponentType.N_ADDER, 4)
    const dx = (name: string): number => pins.find((pin) => pin.name === name)!.dx
    for (const prefix of ['X', 'Y', 'S']) {
      for (let i = 1; i < 4; i++) {
        expect(dx(`${prefix}${i}`), `${prefix}${i} right of ${prefix}${i - 1}`).toBeGreaterThan(dx(`${prefix}${i - 1}`))
      }
    }
  })

  it.each([2, 4, 16])('N_MUX_2TO1 %i-bit exposes X/Y input rows, a Z output row and S', (n) => {
    const pins = pinsOf(ComponentType.N_MUX_2TO1, n)
    const expected = [...names('X', n), ...names('Y', n), ...names('Z', n), 'S'].sort()
    expect(pins.map((pin) => pin.name).sort()).toEqual(expected)
    for (const pin of pins) {
      expect(pin.role, `role of ${pin.name}`).toBe(pin.name.startsWith('Z') ? 'output' : 'input')
    }
    const dx = (name: string): number => pins.find((pin) => pin.name === name)!.dx
    expect(Math.max(...names('X', n).map(dx)), 'X is the left set').toBeLessThan(Math.min(...names('Y', n).map(dx)))
  })

  it.each([2, 4, 16])('N_TRISTATE %i-bit exposes in/out rows and ctl', (n) => {
    const pins = pinsOf(ComponentType.N_TRISTATE, n)
    const expected = [...names('in', n), ...names('out', n), 'ctl'].sort()
    expect(pins.map((pin) => pin.name).sort()).toEqual(expected)
    for (const pin of pins) {
      expect(pin.role, `role of ${pin.name}`).toBe(pin.name.startsWith('out') ? 'output' : 'input')
    }
  })

  it.each([ComponentType.N_ADDER, ComponentType.N_MUX_2TO1, ComponentType.N_TRISTATE])(
    '%s without a bits field is a DEFAULT_BITS-wide part',
    (type) => {
      const dataPrefix = type === ComponentType.N_TRISTATE ? 'out' : type === ComponentType.N_ADDER ? 'S' : 'Z'
      const outs = pinNames(type, undefined).filter((n) => n.startsWith(dataPrefix) && n !== 'S')
      expect(outs.sort()).toEqual(names(dataPrefix, DEFAULT_BITS).sort())
      expect(pinNames(type, undefined)).toEqual(pinNames(type, DEFAULT_BITS))
    }
  )

  it.each([
    [1, MIN_BITS],
    [0, MIN_BITS],
    [-3, MIN_BITS],
    [17, MAX_BITS],
    [32, MAX_BITS],
    [100, MAX_BITS],
    [2, 2],
    [16, 16]
  ])('bits=%i is clamped to a %i-bit definition for all three parts', (bits, width) => {
    expect(pinNames(ComponentType.N_ADDER, bits)).toEqual(pinNames(ComponentType.N_ADDER, width))
    expect(pinNames(ComponentType.N_MUX_2TO1, bits)).toEqual(pinNames(ComponentType.N_MUX_2TO1, width))
    expect(pinNames(ComponentType.N_TRISTATE, bits)).toEqual(pinNames(ComponentType.N_TRISTATE, width))
  })
})

// ---------------------------------------------------------------------------
// effectiveBits: the single clamped width shared by the drawn part and the
// simulator (decision 10). Tested here as a pure function; the simulator-side
// consequences are asserted per part further down.
// ---------------------------------------------------------------------------

describe('effectiveBits for the N-bit combinational parts (decision 10)', () => {
  const types = [ComponentType.N_ADDER, ComponentType.N_MUX_2TO1, ComponentType.N_TRISTATE]

  it.each(types)('%s is an N-bit (net) part, not a bus part, so its ceiling is MAX_BITS = 16', (type) => {
    expect(isNBitType(type)).toBe(true)
    expect(isBusType(type)).toBe(false)
    expect(maxBitsFor(type)).toBe(MAX_BITS)
  })

  it.each<[number | undefined, number]>([
    [undefined, DEFAULT_BITS],
    [0, MIN_BITS],
    [1, MIN_BITS],
    [-1, MIN_BITS],
    [2, 2],
    [3, 3],
    [8, 8],
    [16, 16],
    [17, MAX_BITS],
    [32, MAX_BITS],
    [1000, MAX_BITS]
  ])('bits=%s -> effective width %i for all three parts', (bits, width) => {
    for (const type of types) expect(effectiveBits(type, bits), type).toBe(width)
  })

  it('the pin set exposed by defOf has exactly effectiveBits data pins', () => {
    for (const type of types) {
      for (const bits of [undefined, 0, 1, 5, 16, 17, 32]) {
        const w = effectiveBits(type, bits)
        const dataOut = type === ComponentType.N_ADDER ? 'S' : type === ComponentType.N_MUX_2TO1 ? 'Z' : 'out'
        const outs = pinNames(type, bits).filter((n) => n.startsWith(dataOut) && n !== 'S')
        expect(outs.sort(), `${type} bits=${bits}`).toEqual(names(dataOut, w).sort())
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Bit ordering as seen by the simulator: data pin i carries bit i, so X0, Y0,
// S0, Z0, in0 and out0 are the LSBs.
// ---------------------------------------------------------------------------

describe('bit ordering: pin i is bit i (X0/Y0/S0/Z0/in0/out0 are LSBs)', () => {
  it.each(range(4))('N_ADDER 4-bit: X%i alone -> only S%i is 1; Y%i alone -> only S%i is 1', (i) => {
    const rig = buildRig(adderSpec(4), 'wire')
    rig.set({ ...vecSwitches('X', 4, 0), ...vecSwitches('Y', 4, 0), Cin: ZERO, [`X${i}`]: ONE })
    for (let k = 0; k < 4; k++) expect(rig.out(`S${k}`), `S${k} with X${i}=1`).toBe(k === i ? ONE : ZERO)
    expect(rig.out('Cout')).toBe(ZERO)
    rig.set({ [`X${i}`]: ZERO, [`Y${i}`]: ONE })
    for (let k = 0; k < 4; k++) expect(rig.out(`S${k}`), `S${k} with Y${i}=1`).toBe(k === i ? ONE : ZERO)
    expect(rig.out('Cout')).toBe(ZERO)
  })

  it('N_ADDER 4-bit: X3 + Y3 (the MSB pair) is the only pair that raises Cout with S = 0000', () => {
    const rig = buildRig(adderSpec(4), 'wire')
    rig.set({ X3: ONE, Y3: ONE })
    expect(rig.outVec('S', 4)).toBe('0000')
    expect(rig.out('Cout')).toBe(ONE)
    rig.set({ X3: ZERO, Y3: ZERO, X0: ONE, Y0: ONE })
    expect(rig.outVec('S', 4), 'X0 + Y0 carries into S1').toBe('0010')
    expect(rig.out('Cout')).toBe(ZERO)
  })

  it('N_ADDER 4-bit: Cin adds into bit 0 (0111 + 0000 + 1 = 1000)', () => {
    const rig = buildRig(adderSpec(4), 'wire')
    rig.set({ ...vecSwitches('X', 4, 0b0111), Cin: ONE })
    expect(rig.outVec('S', 4)).toBe('1000')
    expect(rig.out('Cout')).toBe(ZERO)
  })

  it.each(range(4))('N_MUX_2TO1 4-bit: X%i alone (S=0) -> only Z%i; Y%i alone (S=1) -> only Z%i', (i) => {
    const rig = buildRig(muxSpec(4), 'wire')
    rig.set({ ...vecSwitches('X', 4, 0), ...vecSwitches('Y', 4, 0), S: ZERO, [`X${i}`]: ONE })
    for (let k = 0; k < 4; k++) expect(rig.out(`Z${k}`), `Z${k} with X${i}=1, S=0`).toBe(k === i ? ONE : ZERO)
    rig.set({ S: ONE })
    expect(rig.outVec('Z', 4), 'S=1 shows Y = 0000').toBe('0000')
    rig.set({ [`Y${i}`]: ONE })
    for (let k = 0; k < 4; k++) expect(rig.out(`Z${k}`), `Z${k} with Y${i}=1, S=1`).toBe(k === i ? ONE : ZERO)
  })

  it.each(range(4))('N_TRISTATE 4-bit: in%i alone with ctl=1 -> only out%i is 1', (i) => {
    const rig = buildRig(tristateSpec(4), 'wire')
    rig.set({ ...vecSwitches('in', 4, 0), ctl: ONE, [`in${i}`]: ONE })
    for (let k = 0; k < 4; k++) expect(rig.out(`out${k}`), `out${k} with in${i}=1`).toBe(k === i ? ONE : ZERO)
  })
})

// ---------------------------------------------------------------------------
// values.ts helpers the adder relies on (pure functions).
// ---------------------------------------------------------------------------

describe('values.ts vector helpers (LSB-first)', () => {
  it('numToVec puts bit 0 at index 0', () => {
    expect(numToVec(6, 4)).toEqual([ZERO, ONE, ONE, ZERO])
    expect(numToVec(1, 4)).toEqual([ONE, ZERO, ZERO, ZERO])
    expect(numToVec(8, 4)).toEqual([ZERO, ZERO, ZERO, ONE])
  })

  it('numToVec drops bits above the width (modulo 2^n)', () => {
    expect(numToVec(0x1f, 4)).toEqual([ONE, ONE, ONE, ONE])
    expect(numToVec(0x10, 4)).toEqual([ZERO, ZERO, ZERO, ZERO])
    expect(numToVec(0x1ffff, 16)).toEqual(new Array(16).fill(ONE))
  })

  it.each(range(16))('vecToNum inverts numToVec for %i at width 4', (v) => {
    expect(vecToNum(numToVec(v, 4))).toBe(v)
  })

  it('vecToNum round-trips the 16-bit extremes', () => {
    expect(vecToNum(numToVec(0xffff, 16))).toBe(0xffff)
    expect(vecToNum(numToVec(0x8000, 16))).toBe(0x8000)
    expect(vecToNum(numToVec(0xaaaa, 16))).toBe(0xaaaa)
  })

  it.each(range(4))('vecToNum is null when bit %i is X', (i) => {
    const vec = numToVec(0xf, 4)
    vec[i] = X
    expect(vecToNum(vec)).toBeNull()
  })

  it.each(range(4))('vecToNum is null when bit %i is Z', (i) => {
    const vec = numToVec(0x0, 4)
    vec[i] = Z
    expect(vecToNum(vec)).toBeNull()
  })

  it('vecToNum of an empty vector is 0 and clean() only accepts 0/1', () => {
    expect(vecToNum([])).toBe(0)
    expect(clean(ZERO)).toBe(true)
    expect(clean(ONE)).toBe(true)
    expect(clean(X)).toBe(false)
    expect(clean(Z)).toBe(false)
  })

  it('xVec / zVec build fills of the requested width', () => {
    expect(xVec(3)).toEqual([X, X, X])
    expect(zVec(2)).toEqual([Z, Z])
    expect(xVec(0)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// N-bit adder: S = X + Y + Cin (mod 2^n), Cout = carry.
// ---------------------------------------------------------------------------

describe.each([2, 3, 4])('N_ADDER %i-bit exhaustive truth table (switches through wires)', (n) => {
  let rig: Rig
  beforeAll(() => {
    rig = buildRig(adderSpec(n), 'wire')
  })

  const cases = range(1 << n).flatMap((x) => [0, 1].map((cin) => [x, cin as 0 | 1] as const))
  it.each(cases)(`X=%i Cin=%i: every Y gives the correct ${n}-bit sum and carry`, (x, cin) => {
    for (let y = 0; y < 1 << n; y++) addAndCheck(rig, n, x, y, cin)
  })
})

describe('N_ADDER 2-bit exhaustive truth table (switches through pin labels)', () => {
  let rig: Rig
  beforeAll(() => {
    rig = buildRig(adderSpec(2), 'label')
  })

  const cases = range(4).flatMap((x) => range(4).flatMap((y) => [0, 1].map((cin) => [x, y, cin as 0 | 1] as const)))
  it.each(cases)('%i + %i + %i via labels', (x, y, cin) => {
    addAndCheck(rig, 2, x, y, cin)
  })
})

describe.each([3, 4])('N_ADDER %i-bit exhaustive truth table (switches through pin labels)', (n) => {
  let rig: Rig
  beforeAll(() => {
    rig = buildRig(adderSpec(n), 'label')
  })

  const cases = range(1 << n).flatMap((x) => [0, 1].map((cin) => [x, cin as 0 | 1] as const))
  it.each(cases)(`X=%i Cin=%i via labels: every Y gives the correct ${n}-bit sum and carry`, (x, cin) => {
    for (let y = 0; y < 1 << n; y++) addAndCheck(rig, n, x, y, cin)
  })
})

describe.each([8, 16])('N_ADDER %i-bit through pin labels', (n) => {
  let rig: Rig
  beforeAll(() => {
    rig = buildRig(adderSpec(n), 'label')
  })

  it.each(edgeAddCases(n))(`${n}-bit via labels: $x + $y + $cin`, ({ x, y, cin }) => {
    addAndCheck(rig, n, x, y, cin)
  })

  it.each(randomAddCases(n, 25, 0xabc + n))(`${n}-bit random via labels: $x + $y + $cin`, ({ x, y, cin }) => {
    addAndCheck(rig, n, x, y, cin)
  })
})

describe('N_ADDER 4-bit through pin labels matches the wire-connected adder', () => {
  let wired: Rig
  let labelled: Rig
  beforeAll(() => {
    wired = buildRig(adderSpec(4), 'wire')
    labelled = buildRig(adderSpec(4), 'label')
  })

  it.each([
    [0, 0, 0],
    [15, 1, 0],
    [15, 15, 1],
    [9, 6, 0],
    [9, 6, 1],
    [5, 10, 0],
    [8, 8, 0],
    [7, 1, 0],
    [3, 12, 1]
  ] as const)('%i + %i + %i: both connection styles agree and are correct', (x, y, cin) => {
    addAndCheck(wired, 4, x, y, cin)
    addAndCheck(labelled, 4, x, y, cin)
    expect(labelled.outVec('S', 4)).toBe(wired.outVec('S', 4))
    expect(labelled.out('Cout')).toBe(wired.out('Cout'))
  })

  it('mixed: X inputs via labels, Y inputs via wires', () => {
    const b = new CircuitBuilder().add(PART, ComponentType.N_ADDER, { bits: 4 })
    for (let i = 0; i < 4; i++) {
      b.switch(`X${i}`, ZERO).label(p(`X${i}`, 'out'), `bx${i}`).label(p(PART, `X${i}`), `bx${i}`)
      b.switch(`Y${i}`, ZERO).wire(p(`Y${i}`, 'out'), p(PART, `Y${i}`))
    }
    b.switch('Cin', ZERO).wire(p('Cin', 'out'), p(PART, 'Cin'))
    const c = b.build()
    c.setMany({ ...vecSwitches('X', 4, 0xb), ...vecSwitches('Y', 4, 0x6), Cin: ONE })
    expect(c.vec(PART, 'S', 4)).toBe(bin(0xb + 0x6 + 1, 4))
    expect(c.pin(p(PART, 'Cout'))).toBe(ONE)
  })
})

describe.each([8, 16])('N_ADDER %i-bit edge values', (n) => {
  let rig: Rig
  beforeAll(() => {
    rig = buildRig(adderSpec(n), 'wire')
  })

  it.each(edgeAddCases(n))(`${n}-bit: $x + $y + $cin`, ({ x, y, cin }) => {
    addAndCheck(rig, n, x, y, cin)
  })

  it('walking one: a single set bit in X plus the same bit in Y carries into the next bit', () => {
    for (let i = 0; i < n; i++) addAndCheck(rig, n, 1 << i, 1 << i, 0)
  })

  it('each single bit of X plus 0 passes straight to S', () => {
    for (let i = 0; i < n; i++) addAndCheck(rig, n, 1 << i, 0, 0)
  })

  it('each single bit of Y plus 0 passes straight to S', () => {
    for (let i = 0; i < n; i++) addAndCheck(rig, n, 0, 1 << i, 0)
  })
})

describe.each([8, 16])('N_ADDER %i-bit random sample (200 cases, seeded)', (n) => {
  let rig: Rig
  beforeAll(() => {
    rig = buildRig(adderSpec(n), 'wire')
  })

  it.each(randomAddCases(n, 200, 0x5eed + n))(`${n}-bit: $x + $y + $cin`, ({ x, y, cin }) => {
    addAndCheck(rig, n, x, y, cin)
  })
})

describe.each([2, 4])('N_ADDER %i-bit: X or Z on any single input bit makes ALL outputs X', (n) => {
  const max = (1 << n) - 1
  const inputPins = [...names('X', n), ...names('Y', n), 'Cin']

  describe.each(inputPins)('pin %s', (pin) => {
    it.each(['z', 'x'] as const)('fed %s (wires): S and Cout are all X whatever the other inputs are', (feed) => {
      const rig = buildRig(adderSpec(n), 'wire', { [pin]: feed })
      expectAdderAllX(rig, n, `with ${pin}=${feed}, others 0`)
      rig.set({ ...vecSwitches('X', n, max), ...vecSwitches('Y', n, max), Cin: ONE })
      expectAdderAllX(rig, n, `with ${pin}=${feed}, others all ones`)
      rig.set({ ...vecSwitches('X', n, 0x5 & max), ...vecSwitches('Y', n, 0xa & max), Cin: ZERO })
      expectAdderAllX(rig, n, `with ${pin}=${feed}, others alternating`)
    })

    it.each(['z', 'x'] as const)('fed %s (labels): S and Cout are all X', (feed) => {
      const rig = buildRig(adderSpec(n), 'label', { [pin]: feed })
      expectAdderAllX(rig, n, `with ${pin}=${feed}, others 0 (labels)`)
      rig.set({ ...vecSwitches('X', n, max), ...vecSwitches('Y', n, 0), Cin: ONE })
      expectAdderAllX(rig, n, `with ${pin}=${feed}, X all ones (labels)`)
    })
  })
})

describe('N_ADDER 16-bit: X/Z on one bit of a wide adder', () => {
  it.each(['X0', 'X15', 'Y7', 'Cin'])('%s unconnected: S and Cout are all X', (pin) => {
    const rig = buildRig(adderSpec(16), 'wire', { [pin]: 'z' })
    rig.set({ ...vecSwitches('X', 16, 0x1234), ...vecSwitches('Y', 16, 0x4321), Cin: ZERO })
    expectAdderAllX(rig, 16, `with ${pin} unconnected`)
  })

  it.each(['X8', 'Y0', 'Y15'])('%s driven X: S and Cout are all X', (pin) => {
    const rig = buildRig(adderSpec(16), 'wire', { [pin]: 'x' })
    rig.set({ ...vecSwitches('X', 16, 0xffff), ...vecSwitches('Y', 16, 0x0001), Cin: ZERO })
    expectAdderAllX(rig, 16, `with ${pin} = X`)
  })
})

describe.each([3, 8])('N_ADDER %i-bit: X or Z on a single input bit (spot checks)', (n) => {
  const max = (1 << n) - 1
  const inputPins = [...names('X', n), ...names('Y', n), 'Cin']

  it.each(inputPins)('%s unconnected: S and Cout are all X', (pin) => {
    const rig = buildRig(adderSpec(n), 'wire', { [pin]: 'z' })
    rig.set({ ...vecSwitches('X', n, max), ...vecSwitches('Y', n, 1), Cin: ZERO })
    expectAdderAllX(rig, n, `with ${pin} unconnected`)
  })

  it.each(inputPins)('%s driven X: S and Cout are all X', (pin) => {
    const rig = buildRig(adderSpec(n), 'wire', { [pin]: 'x' })
    rig.set({ ...vecSwitches('X', n, 0), ...vecSwitches('Y', n, 0), Cin: ONE })
    expectAdderAllX(rig, n, `with ${pin} = X`)
  })
})

describe('N_ADDER: several undetermined inputs at once', () => {
  it('X0 = X and Y3 = Z together: all outputs X', () => {
    const rig = buildRig(adderSpec(4), 'wire', { X0: 'x', Y3: 'z' })
    rig.set({ ...vecSwitches('X', 4, 0xf), ...vecSwitches('Y', 4, 0xf), Cin: ONE })
    expectAdderAllX(rig, 4, 'with X0 = X and Y3 = Z')
  })

  it('every input X: all outputs X', () => {
    const feeds: Record<string, Feed> = { Cin: 'x' }
    for (const pin of [...names('X', 4), ...names('Y', 4)]) feeds[pin] = 'x'
    const rig = buildRig(adderSpec(4), 'wire', feeds)
    expectAdderAllX(rig, 4, 'with every input X')
  })

  it('an X bit that becomes clean again restores the correct sum (no sticky X)', () => {
    // X0 is fed by an AND2 whose second input is a switch: 'g' = 0 forces the gate
    // to 0 (clean), 'g' = 1 with the other input unconnected gives X.
    const b = new CircuitBuilder().add(PART, ComponentType.N_ADDER, { bits: 2 })
    b.add('gate', ComponentType.AND2).switch('g', ONE)
    b.wire(p('g', 'out'), p('gate', 'in2')).wire(p('gate', 'out'), p(PART, 'X0'))
    for (const pin of ['X1', 'Y0', 'Y1', 'Cin']) b.switch(pin, ZERO).wire(p(pin, 'out'), p(PART, pin))
    const c = b.build()
    expect(c.pin(p(PART, 'X0')), 'AND(Z, 1) is X').toBe(X)
    expect(c.vec(PART, 'S', 2)).toBe('XX')
    expect(c.pin(p(PART, 'Cout'))).toBe(X)
    c.set('g', ZERO)
    expect(c.pin(p(PART, 'X0')), 'AND(Z, 0) is a controlled 0').toBe(ZERO)
    c.setMany({ X1: ONE, Y1: ONE })
    expect(c.vec(PART, 'S', 2)).toBe('00')
    expect(c.pin(p(PART, 'Cout'))).toBe(ONE)
  })
})

describe('N_ADDER: an input bit driven by two switches (wired-net resolution, decision 3)', () => {
  function twoDriverRig(): Circuit {
    const b = new CircuitBuilder().add(PART, ComponentType.N_ADDER, { bits: 2 })
    b.switch('a', ZERO).switch('b', ZERO)
    b.wire(p('a', 'out'), p(PART, 'X0')).wire(p('b', 'out'), p(PART, 'X0'))
    for (const pin of ['X1', 'Y0', 'Y1', 'Cin']) b.switch(pin, ZERO).wire(p(pin, 'out'), p(PART, pin))
    return b.build()
  }

  it('agreeing drivers (0/0 then 1/1) act like a single clean switch', () => {
    const c = twoDriverRig()
    expect(c.pin(p(PART, 'X0'))).toBe(ZERO)
    expect(c.vec(PART, 'S', 2)).toBe('00')
    c.setMany({ a: ONE, b: ONE })
    expect(c.pin(p(PART, 'X0'))).toBe(ONE)
    expect(c.vec(PART, 'S', 2)).toBe('01')
    expect(c.pin(p(PART, 'Cout'))).toBe(ZERO)
  })

  it('disagreeing drivers make X0 = X and therefore every adder output X', () => {
    const c = twoDriverRig()
    c.set('a', ONE)
    expect(c.pin(p(PART, 'X0'))).toBe(X)
    expect(c.vec(PART, 'S', 2)).toBe('XX')
    expect(c.pin(p(PART, 'Cout'))).toBe(X)
    c.set('b', ONE)
    expect(c.vec(PART, 'S', 2), 'agreement again resolves the sum').toBe('01')
  })
})

describe('N_ADDER: unconnected pins', () => {
  it('a bare adder (nothing connected) has Z on every input and X on every output', () => {
    const c = new CircuitBuilder().add(PART, ComponentType.N_ADDER, { bits: 4 }).build()
    for (const pin of [...names('X', 4), ...names('Y', 4), 'Cin']) {
      expect(c.pin(p(PART, pin)), `${pin} is Z`).toBe(Z)
    }
    expect(c.vec(PART, 'S', 4)).toBe('XXXX')
    expect(c.pin(p(PART, 'Cout'))).toBe(X)
  })

  it('only the X operand connected: still all X', () => {
    const feeds: Record<string, Feed> = { Cin: 'z' }
    for (const y of names('Y', 4)) feeds[y] = 'z'
    const rig = buildRig(adderSpec(4), 'wire', feeds)
    rig.setVec('X', 4, 0xf)
    expectAdderAllX(rig, 4, 'with Y and Cin unconnected')
  })

  it('X and Y connected but Cin unconnected: all X (manual requires every input driven)', () => {
    const rig = buildRig(adderSpec(3), 'wire', { Cin: 'z' })
    rig.set({ ...vecSwitches('X', 3, 3), ...vecSwitches('Y', 3, 4) })
    expectAdderAllX(rig, 3, 'with Cin unconnected')
  })
})

describe('N_ADDER: initial state and reset', () => {
  it('outputs are correct immediately after build for non-zero switch positions', () => {
    const initial = { ...vecSwitches('X', 4, 0x9), ...vecSwitches('Y', 4, 0x7), Cin: ONE }
    const rig = buildRig(adderSpec(4), 'wire', {}, initial)
    expect(rig.outVec('S', 4)).toBe(bin(0x9 + 0x7 + 1, 4))
    expect(rig.out('Cout')).toBe(ONE)
  })

  it('reset() re-evaluates the adder from the current switch positions', () => {
    const rig = buildRig(adderSpec(4), 'wire')
    rig.set({ ...vecSwitches('X', 4, 0xc), ...vecSwitches('Y', 4, 0x3), Cin: ZERO })
    expect(rig.outVec('S', 4)).toBe('1111')
    rig.c.reset()
    expect(rig.c.time).toBeGreaterThanOrEqual(0)
    expect(rig.outVec('S', 4)).toBe('1111')
    expect(rig.out('Cout')).toBe(ZERO)
    rig.set({ Cin: ONE })
    expect(rig.outVec('S', 4)).toBe('0000')
    expect(rig.out('Cout')).toBe(ONE)
  })

  it('a probe on Cout records the carry transitions in its waveform', () => {
    const rig = buildRig(adderSpec(2), 'wire')
    rig.set({ ...vecSwitches('X', 2, 3), ...vecSwitches('Y', 2, 1) })
    rig.set({ ...vecSwitches('Y', 2, 0) })
    const trace = rig.c.sim.getWaveforms().find((w) => w.probeId === probeId('Cout'))!
    expect(trace).toBeDefined()
    const values = trace.samples.map((s) => s.v)
    expect(values[values.length - 1]).toBe(ZERO)
    expect(values).toContain(ONE)
    for (let i = 1; i < trace.samples.length; i++) {
      expect(trace.samples[i].t).toBeGreaterThanOrEqual(trace.samples[i - 1].t)
    }
  })
})

describe('N_ADDER: DEFAULT_BITS and bits clamping as seen by the simulator', () => {
  it('bits omitted: simulates as a DEFAULT_BITS (4-bit) adder', () => {
    const rig = buildRig(adderSpec(undefined), 'wire')
    addAndCheck(rig, DEFAULT_BITS, 0xf, 0x1, 0)
    addAndCheck(rig, DEFAULT_BITS, 0x8, 0x7, 1)
    addAndCheck(rig, DEFAULT_BITS, 0x5, 0xa, 0)
  })

  it.each([1, 0])('bits=%i: the rendered part has MIN_BITS pins and must add as a 2-bit adder', (bits) => {
    const rig = buildRig(adderSpec(bits), 'wire')
    addAndCheck(rig, MIN_BITS, 3, 0, 0)
    addAndCheck(rig, MIN_BITS, 3, 1, 0)
    addAndCheck(rig, MIN_BITS, 1, 2, 1)
    addAndCheck(rig, MIN_BITS, 2, 2, 0)
  })

  it.each([17, 32])('bits=%i: the rendered part has MAX_BITS pins and must add as a 16-bit adder', (bits) => {
    const rig = buildRig(adderSpec(bits), 'wire')
    addAndCheck(rig, MAX_BITS, 0xffff, 0x0001, 0)
    addAndCheck(rig, MAX_BITS, 0x1234, 0x4321, 1)
    addAndCheck(rig, MAX_BITS, 0x0000, 0x0000, 0)
  })
})

describe('N_ADDER: propagation delay', () => {
  function settleTime(delay: number): number {
    const rig = buildRig(adderSpec(2, delay), 'wire')
    const before = rig.c.time
    rig.set({ X0: ONE })
    expect(rig.outVec('S', 2)).toBe('01')
    return rig.c.time - before
  }

  it('a change takes at least the adder delay to reach S', () => {
    expect(settleTime(1)).toBeGreaterThanOrEqual(1)
    expect(settleTime(5)).toBeGreaterThanOrEqual(5)
  })

  it('raising the adder delay by k ns delays the settled output by exactly k ns', () => {
    const base = settleTime(1)
    expect(settleTime(2) - base).toBe(1)
    expect(settleTime(3) - base).toBe(2)
    expect(settleTime(10) - base).toBe(9)
  })

  /**
   * Inputs that reach the adder at different times (X0 straight from the switch,
   * Y0 through an inverter) must still settle to the sum of the settled inputs,
   * whatever the adder's own delay is.
   */
  function staggeredRig(delay: number): Circuit {
    return new CircuitBuilder()
      .switch('s', ZERO)
      .switch('X1', ZERO)
      .switch('Y1', ZERO)
      .switch('Cin', ZERO)
      .add('inv', ComponentType.NOT)
      .add(PART, ComponentType.N_ADDER, { bits: 2, delay })
      .probe('P_S0')
      .probe('P_S1')
      .probe('P_Cout')
      .wire(p('s', 'out'), p(PART, 'X0'))
      .wire(p('s', 'out'), p('inv', 'in1'))
      .wire(p('inv', 'out'), p(PART, 'Y0'))
      .wire(p('X1', 'out'), p(PART, 'X1'))
      .wire(p('Y1', 'out'), p(PART, 'Y1'))
      .wire(p('Cin', 'out'), p(PART, 'Cin'))
      .wire(p(PART, 'S0'), p('P_S0', 'in'))
      .wire(p(PART, 'S1'), p('P_S1', 'in'))
      .wire(p(PART, 'Cout'), p('P_Cout', 'in'))
      .build()
  }

  it.each([1, 2, 3, 5])('delay %i: X0 = s, Y0 = NOT s always settles to S = 01', (delay) => {
    const c = staggeredRig(delay)
    const S = (): string => `${c.pin(p('P_S1', 'in'))}${c.pin(p('P_S0', 'in'))}`
    expect(S(), 's=0 -> 0 + 1').toBe('01')
    c.set('s', ONE)
    expect(S(), 's=1 -> 1 + 0').toBe('01')
    expect(c.pin(p('P_Cout', 'in'))).toBe(ZERO)
    c.set('s', ZERO)
    expect(S(), 's back to 0 -> 0 + 1').toBe('01')
    c.set('X1', ONE)
    c.set('s', ONE)
    expect(S(), 'X=11, Y=00 -> 11').toBe('11')
    expect(c.pin(p('P_Cout', 'in'))).toBe(ZERO)
  })

  // Inertial delay (decision 2). Timeline of staggeredRig after c.set('s', ONE) at t=0:
  //   t=1  switch output rises: X0 = 1 while Y0 (NOT, delay 1) is still 1 -> adder sees 1 + 1
  //   t=2  NOT output falls: adder sees 1 + 0 again
  // so the adder's inputs are "wrong" for exactly 1 ns.
  const trace = (c: Circuit, probe: string): [number, LogicValue][] =>
    c.sim.getWaveforms().find((w) => w.probeId === probe)!.samples.map((s) => [s.t, s.v])

  it('inertial delay: with adder delay 1 the 1 ns overlap appears on S as a 1 ns glitch (S=10 on [2,3))', () => {
    const c = staggeredRig(1)
    c.set('s', ONE)
    expect(trace(c, 'P_S0')).toEqual([
      [0, ONE],
      [2, ZERO],
      [3, ONE]
    ])
    expect(trace(c, 'P_S1')).toEqual([
      [0, ZERO],
      [2, ONE],
      [3, ZERO]
    ])
    expect(trace(c, 'P_Cout')).toEqual([[0, ZERO]])
  })

  it.each([2, 3, 5])('inertial delay: with adder delay %i the 1 ns overlap is swallowed and S never moves', (delay) => {
    const c = staggeredRig(delay)
    c.set('s', ONE)
    expect(trace(c, 'P_S0')).toEqual([[0, ONE]])
    expect(trace(c, 'P_S1')).toEqual([[0, ZERO]])
    expect(trace(c, 'P_Cout')).toEqual([[0, ZERO]])
  })
})

// ---------------------------------------------------------------------------
// N-wide 2-to-1 mux: S=0 selects the left (X) set, S=1 the right (Y) set.
// ---------------------------------------------------------------------------

function muxCheck(rig: Rig, n: number, s: 0 | 1, x: number, y: number): void {
  rig.set({ ...vecSwitches('X', n, x), ...vecSwitches('Y', n, y), S: s ? ONE : ZERO })
  expect(rig.outVec('Z', n), `Z for S=${s} X=${x} Y=${y} (n=${n})`).toBe(bin(s ? y : x, n))
}

describe.each([2, 3, 4])('N_MUX_2TO1 %i-bit exhaustive (switches through wires)', (n) => {
  let rig: Rig
  beforeAll(() => {
    rig = buildRig(muxSpec(n), 'wire')
  })

  const cases = [0, 1].flatMap((s) => range(1 << n).map((x) => [s as 0 | 1, x] as const))
  it.each(cases)('S=%i X=%i: every Y gives Z = S ? Y : X', (s, x) => {
    for (let y = 0; y < 1 << n; y++) muxCheck(rig, n, s, x, y)
  })
})

describe('N_MUX_2TO1 2-bit exhaustive (switches through pin labels)', () => {
  let rig: Rig
  beforeAll(() => {
    rig = buildRig(muxSpec(2), 'label')
  })

  const cases = [0, 1].flatMap((s) => range(4).flatMap((x) => range(4).map((y) => [s as 0 | 1, x, y] as const)))
  it.each(cases)('S=%i X=%i Y=%i via labels', (s, x, y) => {
    muxCheck(rig, 2, s, x, y)
  })
})

describe.each([3, 4])('N_MUX_2TO1 %i-bit exhaustive (switches through pin labels)', (n) => {
  let rig: Rig
  beforeAll(() => {
    rig = buildRig(muxSpec(n), 'label')
  })

  const cases = [0, 1].flatMap((s) => range(1 << n).map((x) => [s as 0 | 1, x] as const))
  it.each(cases)('S=%i X=%i via labels: every Y gives Z = S ? Y : X', (s, x) => {
    for (let y = 0; y < 1 << n; y++) muxCheck(rig, n, s, x, y)
  })
})

describe.each([8, 16])('N_MUX_2TO1 %i-bit through pin labels', (n) => {
  let rig: Rig
  beforeAll(() => {
    rig = buildRig(muxSpec(n), 'label')
  })
  const max = (1 << n) - 1
  const alt = n === 8 ? 0xaa : 0xaaaa

  it('edge patterns via labels for both select values', () => {
    muxCheck(rig, n, 0, 0, max)
    muxCheck(rig, n, 1, 0, max)
    muxCheck(rig, n, 0, alt, ~alt & max)
    muxCheck(rig, n, 1, alt, ~alt & max)
    muxCheck(rig, n, 0, max, 0)
    muxCheck(rig, n, 1, max, 0)
  })

  it.each(randomAddCases(n, 20, 0x321 + n))(`${n}-bit random via labels: S=$cin X=$x Y=$y`, ({ x, y, cin }) => {
    muxCheck(rig, n, cin, x, y)
  })
})

describe.each([8, 16])('N_MUX_2TO1 %i-bit samples', (n) => {
  let rig: Rig
  beforeAll(() => {
    rig = buildRig(muxSpec(n), 'wire')
  })
  const max = (1 << n) - 1
  const alt = n === 8 ? 0xaa : 0xaaaa

  it('S=0 passes X for edge patterns', () => {
    muxCheck(rig, n, 0, 0, max)
    muxCheck(rig, n, 0, max, 0)
    muxCheck(rig, n, 0, alt, ~alt & max)
    muxCheck(rig, n, 0, 1, max)
  })

  it('S=1 passes Y for edge patterns', () => {
    muxCheck(rig, n, 1, max, 0)
    muxCheck(rig, n, 1, 0, max)
    muxCheck(rig, n, 1, ~alt & max, alt)
    muxCheck(rig, n, 1, max, 1 << (n - 1))
  })

  it('flipping S alone switches between the two operands', () => {
    muxCheck(rig, n, 0, 0x33 & max, 0xcc & max)
    rig.set({ S: ONE })
    expect(rig.outVec('Z', n)).toBe(bin(0xcc & max, n))
    rig.set({ S: ZERO })
    expect(rig.outVec('Z', n)).toBe(bin(0x33 & max, n))
  })

  it.each(randomAddCases(n, 40, 0x77 + n))(`${n}-bit random: S=$cin X=$x Y=$y`, ({ x, y, cin }) => {
    muxCheck(rig, n, cin, x, y)
  })
})

describe.each([2, 4])('N_MUX_2TO1 %i-bit: X/Z on a single data bit', (n) => {
  const max = (1 << n) - 1
  const xPat = 0x5 & max
  const yPat = 0xa & max

  describe.each(range(n))('bit %i', (i) => {
    it.each(['z', 'x'] as const)(`X${i} fed %s, S=0: only Z${i} is X; S=1: Y passes cleanly`, (feed) => {
      const rig = buildRig(muxSpec(n), 'wire', { [`X${i}`]: feed })
      rig.set({ ...vecSwitches('X', n, xPat), ...vecSwitches('Y', n, yPat), S: ZERO })
      const expected = bin(xPat, n).split('')
      expected[n - 1 - i] = 'X'
      expect(rig.outVec('Z', n), `S=0 with X${i}=${feed}`).toBe(expected.join(''))
      rig.set({ S: ONE })
      expect(rig.outVec('Z', n), `S=1 ignores X${i}=${feed}`).toBe(bin(yPat, n))
      rig.set({ ...vecSwitches('Y', n, max) })
      expect(rig.outVec('Z', n), `S=1 follows Y while X${i}=${feed}`).toBe(bin(max, n))
    })

    it.each(['z', 'x'] as const)(`Y${i} fed %s, S=1: only Z${i} is X; S=0: X passes cleanly`, (feed) => {
      const rig = buildRig(muxSpec(n), 'wire', { [`Y${i}`]: feed })
      rig.set({ ...vecSwitches('X', n, xPat), ...vecSwitches('Y', n, yPat), S: ONE })
      const expected = bin(yPat, n).split('')
      expected[n - 1 - i] = 'X'
      expect(rig.outVec('Z', n), `S=1 with Y${i}=${feed}`).toBe(expected.join(''))
      rig.set({ S: ZERO })
      expect(rig.outVec('Z', n), `S=0 ignores Y${i}=${feed}`).toBe(bin(xPat, n))
      rig.set({ ...vecSwitches('X', n, 0) })
      expect(rig.outVec('Z', n), `S=0 follows X while Y${i}=${feed}`).toBe(bin(0, n))
    })

    it.each(['z', 'x'] as const)(`X${i} fed %s through labels behaves the same`, (feed) => {
      const rig = buildRig(muxSpec(n), 'label', { [`X${i}`]: feed })
      rig.set({ ...vecSwitches('X', n, max), ...vecSwitches('Y', n, 0), S: ZERO })
      const expected = bin(max, n).split('')
      expected[n - 1 - i] = 'X'
      expect(rig.outVec('Z', n)).toBe(expected.join(''))
      rig.set({ S: ONE })
      expect(rig.outVec('Z', n)).toBe(bin(0, n))
    })
  })
})

describe('N_MUX_2TO1: several undetermined data bits at once', () => {
  it('X0 driven X and X2 unconnected, S=0: Z0 and Z2 are X while Z1 and Z3 follow X1/X3', () => {
    const rig = buildRig(muxSpec(4), 'wire', { X0: 'x', X2: 'z' })
    rig.set({ ...vecSwitches('X', 4, 0xf), ...vecSwitches('Y', 4, 0x0), S: ZERO })
    expect(rig.outVec('Z', 4)).toBe('1X1X')
    rig.set({ X3: ZERO })
    expect(rig.outVec('Z', 4)).toBe('0X1X')
    rig.set({ S: ONE })
    expect(rig.outVec('Z', 4), 'S=1 ignores both bad X bits').toBe('0000')
  })

  it('Y1 driven X and Y3 unconnected, S=1: Z1 and Z3 are X; S=0 is clean', () => {
    const rig = buildRig(muxSpec(4), 'wire', { Y1: 'x', Y3: 'z' })
    rig.set({ ...vecSwitches('X', 4, 0x6), ...vecSwitches('Y', 4, 0x5), S: ONE })
    expect(rig.outVec('Z', 4)).toBe('X1X1')
    rig.set({ S: ZERO })
    expect(rig.outVec('Z', 4)).toBe('0110')
  })

  it('X0 bad and Y0 bad: Z0 is X for both select values, other bits clean', () => {
    const rig = buildRig(muxSpec(2), 'wire', { X0: 'z', Y0: 'x' })
    rig.set({ X1: ONE, Y1: ZERO, S: ZERO })
    expect(rig.outVec('Z', 2)).toBe('1X')
    rig.set({ S: ONE })
    expect(rig.outVec('Z', 2)).toBe('0X')
  })

  it('a whole side X with the other side clean: only the selected side matters', () => {
    const feeds: Record<string, Feed> = {}
    for (const x of names('X', 4)) feeds[x] = 'x'
    const rig = buildRig(muxSpec(4), 'wire', feeds)
    rig.set({ ...vecSwitches('Y', 4, 0xc), S: ZERO })
    expect(rig.outVec('Z', 4)).toBe('XXXX')
    rig.set({ S: ONE })
    expect(rig.outVec('Z', 4)).toBe('1100')
  })
})

describe('N_MUX_2TO1: select line X/Z and unconnected pins', () => {
  it.each(['z', 'x'] as const)('S fed %s while a data bit is also X: all outputs X', (feed) => {
    const rig = buildRig(muxSpec(4), 'wire', { S: feed, X1: 'x', Y2: 'z' })
    rig.set({ ...vecSwitches('X', 4, 0xf), ...vecSwitches('Y', 4, 0xf) })
    expect(rig.outVec('Z', 4)).toBe('XXXX')
  })

  it.each(['z', 'x'] as const)('4-bit S fed %s: all outputs X even when X and Y agree', (feed) => {
    const rig = buildRig(muxSpec(4), 'wire', { S: feed })
    expect(rig.outVec('Z', 4)).toBe('XXXX')
    rig.set({ ...vecSwitches('X', 4, 0x9), ...vecSwitches('Y', 4, 0x9) })
    expect(rig.outVec('Z', 4), 'even identical operands do not resolve a bad select').toBe('XXXX')
    rig.set({ ...vecSwitches('X', 4, 0xf), ...vecSwitches('Y', 4, 0x0) })
    expect(rig.outVec('Z', 4)).toBe('XXXX')
  })

  it.each(['z', 'x'] as const)('2-bit S fed %s through labels: all outputs X', (feed) => {
    const rig = buildRig(muxSpec(2), 'label', { S: feed })
    rig.set({ ...vecSwitches('X', 2, 3), ...vecSwitches('Y', 2, 3) })
    expect(rig.outVec('Z', 2)).toBe('XX')
  })

  it('a bare mux (nothing connected) has X on every output', () => {
    const c = new CircuitBuilder().add(PART, ComponentType.N_MUX_2TO1, { bits: 4 }).build()
    expect(c.pin(p(PART, 'S'))).toBe(Z)
    expect(c.vec(PART, 'Z', 4)).toBe('XXXX')
  })

  it('S connected but the whole selected side unconnected: all X; the other side still passes', () => {
    const feeds: Record<string, Feed> = {}
    for (const y of names('Y', 4)) feeds[y] = 'z'
    const rig = buildRig(muxSpec(4), 'wire', feeds)
    rig.set({ ...vecSwitches('X', 4, 0x6), S: ONE })
    expect(rig.outVec('Z', 4), 'S=1 selects the unconnected Y side').toBe('XXXX')
    rig.set({ S: ZERO })
    expect(rig.outVec('Z', 4), 'S=0 selects the connected X side').toBe('0110')
  })
})

describe('N_MUX_2TO1: DEFAULT_BITS, clamping, delay and initial state', () => {
  it('bits omitted: simulates as a DEFAULT_BITS (4-bit) mux', () => {
    const rig = buildRig(muxSpec(undefined), 'wire')
    muxCheck(rig, DEFAULT_BITS, 0, 0xa, 0x5)
    muxCheck(rig, DEFAULT_BITS, 1, 0xa, 0x5)
  })

  it('bits=1: the rendered part has MIN_BITS pins and must mux both bits', () => {
    const rig = buildRig(muxSpec(1), 'wire')
    muxCheck(rig, MIN_BITS, 0, 3, 0)
    muxCheck(rig, MIN_BITS, 1, 0, 3)
    muxCheck(rig, MIN_BITS, 1, 1, 2)
  })

  it('bits=20: the rendered part has MAX_BITS pins and must mux all 16 bits', () => {
    const rig = buildRig(muxSpec(20), 'wire')
    muxCheck(rig, MAX_BITS, 0, 0xffff, 0)
    muxCheck(rig, MAX_BITS, 1, 0, 0x8001)
  })

  it('bits=0: clamped to MIN_BITS, muxes both bits', () => {
    const rig = buildRig(muxSpec(0), 'wire')
    muxCheck(rig, MIN_BITS, 0, 2, 1)
    muxCheck(rig, MIN_BITS, 1, 2, 1)
  })

  it.each([17, 32])('bits=%i: clamped to MAX_BITS, muxes all 16 bits', (bits) => {
    const rig = buildRig(muxSpec(bits), 'wire')
    muxCheck(rig, MAX_BITS, 0, 0x8000, 0x0001)
    muxCheck(rig, MAX_BITS, 1, 0x8000, 0x0001)
    muxCheck(rig, MAX_BITS, 1, 0, 0xffff)
  })

  it('bits=1 through pin labels: still a 2-bit mux', () => {
    const rig = buildRig(muxSpec(1), 'label')
    muxCheck(rig, MIN_BITS, 0, 1, 2)
    muxCheck(rig, MIN_BITS, 1, 1, 2)
  })

  it('initial switch positions are reflected right after build', () => {
    const rig = buildRig(muxSpec(3), 'wire', {}, { ...vecSwitches('X', 3, 0b101), ...vecSwitches('Y', 3, 0b010), S: ONE })
    expect(rig.outVec('Z', 3)).toBe('010')
  })

  it('raising the mux delay by k ns delays the settled output by exactly k ns', () => {
    const settle = (delay: number): number => {
      const rig = buildRig(muxSpec(2, delay), 'wire')
      const before = rig.c.time
      rig.set({ X0: ONE })
      expect(rig.outVec('Z', 2)).toBe('01')
      return rig.c.time - before
    }
    const base = settle(1)
    expect(settle(4) - base).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// N-bit tristate: ctl=0 -> all Z; ctl=1 -> out = in; ctl X/Z -> all X.
// ---------------------------------------------------------------------------

describe.each([2, 4])('N_TRISTATE %i-bit exhaustive (switches through wires)', (n) => {
  let rig: Rig
  beforeAll(() => {
    rig = buildRig(tristateSpec(n), 'wire')
  })

  it.each(range(1 << n))('ctl=1 in=%i: outputs equal inputs', (v) => {
    rig.set({ ...vecSwitches('in', n, v), ctl: ONE })
    expect(rig.outVec('out', n)).toBe(bin(v, n))
  })

  it.each(range(1 << n))('ctl=0 in=%i: every output is Z', (v) => {
    rig.set({ ...vecSwitches('in', n, v), ctl: ZERO })
    expect(rig.outVec('out', n)).toBe('Z'.repeat(n))
  })
})

describe('N_TRISTATE 2-bit exhaustive (switches through pin labels)', () => {
  let rig: Rig
  beforeAll(() => {
    rig = buildRig(tristateSpec(2), 'label')
  })

  it.each(range(4))('ctl=1 in=%i via labels: outputs equal inputs', (v) => {
    rig.set({ ...vecSwitches('in', 2, v), ctl: ONE })
    expect(rig.outVec('out', 2)).toBe(bin(v, 2))
  })

  it.each(range(4))('ctl=0 in=%i via labels: outputs are Z', (v) => {
    rig.set({ ...vecSwitches('in', 2, v), ctl: ZERO })
    expect(rig.outVec('out', 2)).toBe('ZZ')
  })
})

describe.each([3, 4])('N_TRISTATE %i-bit exhaustive (switches through pin labels)', (n) => {
  let rig: Rig
  beforeAll(() => {
    rig = buildRig(tristateSpec(n), 'label')
  })

  it.each(range(1 << n))('ctl=1 in=%i via labels: outputs equal inputs', (v) => {
    rig.set({ ...vecSwitches('in', n, v), ctl: ONE })
    expect(rig.outVec('out', n)).toBe(bin(v, n))
  })

  it.each(range(1 << n))('ctl=0 in=%i via labels: every output is Z', (v) => {
    rig.set({ ...vecSwitches('in', n, v), ctl: ZERO })
    expect(rig.outVec('out', n)).toBe('Z'.repeat(n))
  })
})

describe.each([8, 16])('N_TRISTATE %i-bit through pin labels', (n) => {
  let rig: Rig
  beforeAll(() => {
    rig = buildRig(tristateSpec(n), 'label')
  })
  const max = (1 << n) - 1
  const alt = n === 8 ? 0xaa : 0xaaaa

  it.each([0, max, alt, ~alt & max, 1, 1 << (n - 1)])('ctl=1 passes %i via labels; ctl=0 blanks it', (v) => {
    rig.set({ ...vecSwitches('in', n, v), ctl: ONE })
    expect(rig.outVec('out', n)).toBe(bin(v, n))
    rig.set({ ctl: ZERO })
    expect(rig.outVec('out', n)).toBe('Z'.repeat(n))
  })
})

describe.each([8, 16])('N_TRISTATE %i-bit samples', (n) => {
  let rig: Rig
  beforeAll(() => {
    rig = buildRig(tristateSpec(n), 'wire')
  })
  const max = (1 << n) - 1
  const alt = n === 8 ? 0xaa : 0xaaaa

  it.each([0, 1, max, alt, ~alt & max, 1 << (n - 1)])('ctl=1 passes %i', (v) => {
    rig.set({ ...vecSwitches('in', n, v), ctl: ONE })
    expect(rig.outVec('out', n)).toBe(bin(v, n))
  })

  it.each([0, max, alt])('ctl=0 blanks %i to all Z', (v) => {
    rig.set({ ...vecSwitches('in', n, v), ctl: ZERO })
    expect(rig.outVec('out', n)).toBe('Z'.repeat(n))
  })

  it('ctl 0 -> 1 -> 0 re-drives and releases every output', () => {
    rig.set({ ...vecSwitches('in', n, alt), ctl: ZERO })
    expect(rig.outVec('out', n)).toBe('Z'.repeat(n))
    rig.set({ ctl: ONE })
    expect(rig.outVec('out', n)).toBe(bin(alt, n))
    rig.set({ ...vecSwitches('in', n, max) })
    expect(rig.outVec('out', n), 'inputs track while enabled').toBe(bin(max, n))
    rig.set({ ctl: ZERO })
    expect(rig.outVec('out', n)).toBe('Z'.repeat(n))
  })

  it.each(randomAddCases(n, 30, 0x99 + n))(`${n}-bit random: in=$x`, ({ x }) => {
    rig.set({ ...vecSwitches('in', n, x), ctl: ONE })
    expect(rig.outVec('out', n)).toBe(bin(x, n))
  })
})

describe('N_TRISTATE: control line X/Z', () => {
  it.each(['z', 'x'] as const)('4-bit ctl fed %s: all outputs X regardless of inputs', (feed) => {
    const rig = buildRig(tristateSpec(4), 'wire', { ctl: feed })
    expect(rig.outVec('out', 4)).toBe('XXXX')
    rig.setVec('in', 4, 0xf)
    expect(rig.outVec('out', 4)).toBe('XXXX')
    rig.setVec('in', 4, 0x6)
    expect(rig.outVec('out', 4)).toBe('XXXX')
  })

  it.each(['z', 'x'] as const)('2-bit ctl fed %s through labels: all outputs X', (feed) => {
    const rig = buildRig(tristateSpec(2), 'label', { ctl: feed })
    rig.setVec('in', 2, 3)
    expect(rig.outVec('out', 2)).toBe('XX')
  })

  it('a bare tristate (nothing connected) has X on every output', () => {
    const c = new CircuitBuilder().add(PART, ComponentType.N_TRISTATE, { bits: 4 }).build()
    expect(c.pin(p(PART, 'ctl'))).toBe(Z)
    expect(c.vec(PART, 'out', 4)).toBe('XXXX')
  })

  it.each(['z', 'x'] as const)('ctl fed %s while an input bit is also X/Z: still all X (ctl dominates)', (feed) => {
    const rig = buildRig(tristateSpec(4), 'wire', { ctl: feed, in0: 'z', in3: 'x' })
    rig.set({ in1: ONE, in2: ONE })
    expect(rig.outVec('out', 4)).toBe('XXXX')
  })

  it('every input unconnected: ctl=0 still releases all outputs (Z); ctl=1 gives all X', () => {
    const feeds: Record<string, Feed> = {}
    for (const pin of names('in', 4)) feeds[pin] = 'z'
    const rig = buildRig(tristateSpec(4), 'wire', feeds)
    rig.set({ ctl: ZERO })
    expect(rig.outVec('out', 4)).toBe('ZZZZ')
    rig.set({ ctl: ONE })
    expect(rig.outVec('out', 4)).toBe('XXXX')
    rig.set({ ctl: ZERO })
    expect(rig.outVec('out', 4)).toBe('ZZZZ')
  })

  it('ctl is the only pin connected: ctl=0 -> Z on every (unconnected-input) output, ctl=1 -> X', () => {
    const c = new CircuitBuilder()
      .add(PART, ComponentType.N_TRISTATE, { bits: 3 })
      .switch('ctl', ZERO)
      .wire(p('ctl', 'out'), p(PART, 'ctl'))
      .build()
    expect(c.vec(PART, 'out', 3)).toBe('ZZZ')
    c.set('ctl', ONE)
    expect(c.vec(PART, 'out', 3)).toBe('XXX')
  })
})

describe('N_TRISTATE: several undetermined input bits at once', () => {
  it('in1 driven X and in3 unconnected with ctl=1: out1 and out3 are X, out0/out2 pass', () => {
    const rig = buildRig(tristateSpec(4), 'wire', { in1: 'x', in3: 'z' })
    rig.set({ ...vecSwitches('in', 4, 0xf), ctl: ONE })
    expect(rig.outVec('out', 4)).toBe('X1X1')
    rig.set({ in0: ZERO })
    expect(rig.outVec('out', 4)).toBe('X1X0')
    rig.set({ ctl: ZERO })
    expect(rig.outVec('out', 4), 'disable dominates every bit').toBe('ZZZZ')
  })

  it('the same through pin labels', () => {
    const rig = buildRig(tristateSpec(4), 'label', { in0: 'z', in2: 'x' })
    rig.set({ ...vecSwitches('in', 4, 0xf), ctl: ONE })
    expect(rig.outVec('out', 4)).toBe('1X1X')
    rig.set({ ctl: ZERO })
    expect(rig.outVec('out', 4)).toBe('ZZZZ')
  })
})

describe.each([2, 4])('N_TRISTATE %i-bit: X/Z on a single input bit', (n) => {
  const max = (1 << n) - 1

  describe.each(range(n))('bit %i', (i) => {
    it.each(['z', 'x'] as const)(`in${i} fed %s with ctl=1: only out${i} is X, others pass`, (feed) => {
      const rig = buildRig(tristateSpec(n), 'wire', { [`in${i}`]: feed })
      for (const v of [0, max, 0x5 & max]) {
        rig.set({ ...vecSwitches('in', n, v), ctl: ONE })
        const expected = bin(v, n).split('')
        expected[n - 1 - i] = 'X'
        expect(rig.outVec('out', n), `in=${v} with in${i}=${feed}`).toBe(expected.join(''))
      }
    })

    it.each(['z', 'x'] as const)(`in${i} fed %s with ctl=0: all outputs still Z (disable dominates)`, (feed) => {
      const rig = buildRig(tristateSpec(n), 'wire', { [`in${i}`]: feed })
      rig.set({ ...vecSwitches('in', n, max), ctl: ZERO })
      expect(rig.outVec('out', n)).toBe('Z'.repeat(n))
    })

    it.each(['z', 'x'] as const)(`in${i} fed %s through labels, ctl=1: only out${i} is X`, (feed) => {
      const rig = buildRig(tristateSpec(n), 'label', { [`in${i}`]: feed })
      rig.set({ ...vecSwitches('in', n, max), ctl: ONE })
      const expected = bin(max, n).split('')
      expected[n - 1 - i] = 'X'
      expect(rig.outVec('out', n)).toBe(expected.join(''))
    })
  })
})

describe('N_TRISTATE: DEFAULT_BITS, clamping, delay and initial state', () => {
  it('bits omitted: simulates as a DEFAULT_BITS (4-bit) tristate', () => {
    const rig = buildRig(tristateSpec(undefined), 'wire')
    rig.set({ ...vecSwitches('in', DEFAULT_BITS, 0xb), ctl: ONE })
    expect(rig.outVec('out', DEFAULT_BITS)).toBe(bin(0xb, DEFAULT_BITS))
    rig.set({ ctl: ZERO })
    expect(rig.outVec('out', DEFAULT_BITS)).toBe('Z'.repeat(DEFAULT_BITS))
  })

  it('bits=1: the rendered part has MIN_BITS pins and must buffer both bits', () => {
    const rig = buildRig(tristateSpec(1), 'wire')
    rig.set({ ...vecSwitches('in', MIN_BITS, 3), ctl: ONE })
    expect(rig.outVec('out', MIN_BITS)).toBe('11')
    rig.set({ ...vecSwitches('in', MIN_BITS, 2) })
    expect(rig.outVec('out', MIN_BITS)).toBe('10')
    rig.set({ ctl: ZERO })
    expect(rig.outVec('out', MIN_BITS)).toBe('ZZ')
  })

  it('bits=40: the rendered part has MAX_BITS pins and must buffer all 16 bits', () => {
    const rig = buildRig(tristateSpec(40), 'wire')
    rig.set({ ...vecSwitches('in', MAX_BITS, 0xbeef), ctl: ONE })
    expect(rig.outVec('out', MAX_BITS)).toBe(bin(0xbeef, MAX_BITS))
    rig.set({ ctl: ZERO })
    expect(rig.outVec('out', MAX_BITS)).toBe('Z'.repeat(MAX_BITS))
  })

  it('bits=0: clamped to MIN_BITS, buffers both bits', () => {
    const rig = buildRig(tristateSpec(0), 'wire')
    rig.set({ ...vecSwitches('in', MIN_BITS, 1), ctl: ONE })
    expect(rig.outVec('out', MIN_BITS)).toBe('01')
    rig.set({ ctl: ZERO })
    expect(rig.outVec('out', MIN_BITS)).toBe('ZZ')
  })

  it.each([17, 32])('bits=%i: clamped to MAX_BITS, buffers all 16 bits', (bits) => {
    const rig = buildRig(tristateSpec(bits), 'wire')
    rig.set({ ...vecSwitches('in', MAX_BITS, 0x8001), ctl: ONE })
    expect(rig.outVec('out', MAX_BITS)).toBe(bin(0x8001, MAX_BITS))
    rig.set({ ...vecSwitches('in', MAX_BITS, 0x7ffe) })
    expect(rig.outVec('out', MAX_BITS)).toBe(bin(0x7ffe, MAX_BITS))
    rig.set({ ctl: ZERO })
    expect(rig.outVec('out', MAX_BITS)).toBe('Z'.repeat(MAX_BITS))
  })

  it('bits=1 through pin labels: still a 2-bit buffer', () => {
    const rig = buildRig(tristateSpec(1), 'label')
    rig.set({ ...vecSwitches('in', MIN_BITS, 2), ctl: ONE })
    expect(rig.outVec('out', MIN_BITS)).toBe('10')
    rig.set({ ctl: ZERO })
    expect(rig.outVec('out', MIN_BITS)).toBe('ZZ')
  })

  it('initial switch positions are reflected right after build (enabled and disabled)', () => {
    const on = buildRig(tristateSpec(3), 'wire', {}, { ...vecSwitches('in', 3, 0b110), ctl: ONE })
    expect(on.outVec('out', 3)).toBe('110')
    const off = buildRig(tristateSpec(3), 'wire', {}, { ...vecSwitches('in', 3, 0b110), ctl: ZERO })
    expect(off.outVec('out', 3)).toBe('ZZZ')
  })

  it('raising the tristate delay by k ns delays the settled output by exactly k ns', () => {
    const settle = (delay: number): number => {
      const rig = buildRig(tristateSpec(2, delay), 'wire', {}, { ctl: ONE })
      const before = rig.c.time
      rig.set({ in0: ONE })
      expect(rig.outVec('out', 2)).toBe('01')
      return rig.c.time - before
    }
    const base = settle(1)
    expect(settle(6) - base).toBe(5)
  })
})

describe('N_TRISTATE: composed usage', () => {
  it('a released (Z) output reads as an unconnected input downstream: AND2 gives X', () => {
    const c = new CircuitBuilder()
      .switch('d', ONE)
      .switch('ctl', ZERO)
      .switch('one', ONE)
      .add(PART, ComponentType.N_TRISTATE, { bits: 2 })
      .add('g', ComponentType.AND2)
      .probe('y')
      .wire(p('d', 'out'), p(PART, 'in0'))
      .wire(p('ctl', 'out'), p(PART, 'ctl'))
      .wire(p(PART, 'out0'), p('g', 'in1'))
      .wire(p('one', 'out'), p('g', 'in2'))
      .wire(p('g', 'out'), p('y', 'in'))
      .build()
    expect(c.pin(p(PART, 'out0')), 'disabled buffer output is Z').toBe(Z)
    expect(c.pin(p('y', 'in')), 'AND of Z and 1 is X').toBe(X)
    c.set('ctl', ONE)
    expect(c.pin(p('y', 'in')), 'enabled: AND of 1 and 1').toBe(ONE)
    c.set('d', ZERO)
    expect(c.pin(p('y', 'in')), 'enabled: AND of 0 and 1').toBe(ZERO)
    c.set('ctl', ZERO)
    expect(c.pin(p('y', 'in')), 'disabled again: X').toBe(X)
  })

  /** Two 4-bit tristates sharing their outputs (a classic shared bus). */
  function sharedBus(): Circuit {
    const b = new CircuitBuilder()
      .add('A', ComponentType.N_TRISTATE, { bits: 4 })
      .add('B', ComponentType.N_TRISTATE, { bits: 4 })
      .switch('enA', ZERO)
      .switch('enB', ZERO)
      .wire(p('enA', 'out'), p('A', 'ctl'))
      .wire(p('enB', 'out'), p('B', 'ctl'))
    for (let i = 0; i < 4; i++) {
      b.switch(`a${i}`, ZERO).wire(p(`a${i}`, 'out'), p('A', `in${i}`))
      b.switch(`b${i}`, ZERO).wire(p(`b${i}`, 'out'), p('B', `in${i}`))
      b.probe(`bus${i}`)
      b.wire(p('A', `out${i}`), p('B', `out${i}`))
      b.wire(p('A', `out${i}`), p(`bus${i}`, 'in'))
    }
    return b.build()
  }
  const busValue = (c: Circuit): string => {
    let s = ''
    for (let i = 3; i >= 0; i--) s += c.pin(p(`bus${i}`, 'in'))
    return s
  }

  it('both buffers disabled: the shared bus floats at Z', () => {
    const c = sharedBus()
    c.setMany({ ...vecSwitches('a', 4, 0xf), ...vecSwitches('b', 4, 0x3) })
    expect(busValue(c)).toBe('ZZZZ')
  })

  it('exactly one buffer enabled: the bus carries that buffer\'s inputs', () => {
    const c = sharedBus()
    c.setMany({ ...vecSwitches('a', 4, 0x9), ...vecSwitches('b', 4, 0x6), enA: ONE })
    expect(busValue(c)).toBe('1001')
    c.setMany({ enA: ZERO, enB: ONE })
    expect(busValue(c)).toBe('0110')
    c.setMany({ ...vecSwitches('b', 4, 0xc) })
    expect(busValue(c)).toBe('1100')
    c.setMany({ enB: ZERO })
    expect(busValue(c)).toBe('ZZZZ')
  })

  it('both enabled with different data: differing bits are X, agreeing bits keep their value (decision 3)', () => {
    // Wired-net resolution: several drivers with the SAME value keep it (0/0 -> 0,
    // 1/1 -> 1); any disagreement gives X. a = 1100, b = 1010 -> bus = 1XX0.
    const c = sharedBus()
    c.setMany({ ...vecSwitches('a', 4, 0b1100), ...vecSwitches('b', 4, 0b1010), enA: ONE, enB: ONE })
    expect(busValue(c)).toBe('1XX0')
    c.setMany({ ...vecSwitches('b', 4, 0b1100) })
    expect(busValue(c), 'full agreement is clean').toBe('1100')
    c.setMany({ enA: ZERO })
    expect(busValue(c), 'one driver left').toBe('1100')
  })

  it('an enabled buffer plus a released one: the released (Z) side never disturbs the bus', () => {
    const c = sharedBus()
    c.setMany({ ...vecSwitches('a', 4, 0b0101), ...vecSwitches('b', 4, 0b1010), enA: ONE, enB: ZERO })
    expect(busValue(c)).toBe('0101')
    c.setMany({ ...vecSwitches('b', 4, 0b1111) })
    expect(busValue(c), 'changing the disabled side is invisible').toBe('0101')
  })

  /**
   * Inertial delay (decision 2) through a tristate: ctl is fed a 1 ns pulse from
   * AND(s, NOT s) (both delay 1). After c.set('s', ONE) at t=0: s rises at t=1,
   * ctl = 1 on [2, 3) only.
   */
  function pulsedTristate(delay: number): Circuit {
    return new CircuitBuilder()
      .switch('s', ZERO)
      .switch('in0', ONE)
      .switch('in1', ONE)
      .add('inv', ComponentType.NOT)
      .add('pulse', ComponentType.AND2)
      .add(PART, ComponentType.N_TRISTATE, { bits: 2, delay })
      .probe('P_out0')
      .probe('P_out1')
      .wire(p('s', 'out'), p('inv', 'in1'))
      .wire(p('s', 'out'), p('pulse', 'in1'))
      .wire(p('inv', 'out'), p('pulse', 'in2'))
      .wire(p('pulse', 'out'), p(PART, 'ctl'))
      .wire(p('in0', 'out'), p(PART, 'in0'))
      .wire(p('in1', 'out'), p(PART, 'in1'))
      .wire(p(PART, 'out0'), p('P_out0', 'in'))
      .wire(p(PART, 'out1'), p('P_out1', 'in'))
      .build()
  }
  const trace = (c: Circuit, probe: string): [number, LogicValue][] =>
    c.sim.getWaveforms().find((w) => w.probeId === probe)!.samples.map((s) => [s.t, s.v])

  it('inertial delay: a 1 ns ctl pulse into a delay-1 tristate drives the inputs for 1 ns ([3,4))', () => {
    const c = pulsedTristate(1)
    expect(c.pin(p(PART, 'ctl'))).toBe(ZERO)
    c.set('s', ONE)
    expect(c.pin(p(PART, 'ctl')), 'pulse is over').toBe(ZERO)
    expect(trace(c, 'P_out0')).toEqual([
      [0, Z],
      [3, ONE],
      [4, Z]
    ])
    expect(trace(c, 'P_out1')).toEqual([
      [0, Z],
      [3, ONE],
      [4, Z]
    ])
  })

  it.each([2, 4])('inertial delay: a 1 ns ctl pulse into a delay-%i tristate never reaches the outputs', (delay) => {
    const c = pulsedTristate(delay)
    c.set('s', ONE)
    expect(trace(c, 'P_out0')).toEqual([[0, Z]])
    expect(trace(c, 'P_out1')).toEqual([[0, Z]])
    expect(c.vec(PART, 'out', 2)).toBe('ZZ')
  })
})

// ---------------------------------------------------------------------------
// Coverage fill: X/Z handling at the remaining widths (3, 8, 16) so every
// manual-supported width is exercised for the per-bit and control-pin rules.
// ---------------------------------------------------------------------------

describe.each([3, 8, 16])('N_MUX_2TO1 %i-bit: X/Z on a single data bit (all widths)', (n) => {
  const max = (1 << n) - 1
  const xPat = 0x5a5a & max
  const yPat = 0xa5a5 & max

  it.each(range(n))('X%i unconnected, S=0: only Z%i is X; S=1: Y passes cleanly', (i) => {
    const rig = buildRig(muxSpec(n), 'wire', { [`X${i}`]: 'z' })
    rig.set({ ...vecSwitches('X', n, xPat), ...vecSwitches('Y', n, yPat), S: ZERO })
    const expected = bin(xPat, n).split('')
    expected[n - 1 - i] = 'X'
    expect(rig.outVec('Z', n), `S=0 with X${i}=Z`).toBe(expected.join(''))
    rig.set({ S: ONE })
    expect(rig.outVec('Z', n), `S=1 ignores X${i}=Z`).toBe(bin(yPat, n))
  })

  it.each(range(n))('Y%i driven X, S=1: only Z%i is X; S=0: X passes cleanly', (i) => {
    const rig = buildRig(muxSpec(n), 'wire', { [`Y${i}`]: 'x' })
    rig.set({ ...vecSwitches('X', n, xPat), ...vecSwitches('Y', n, yPat), S: ONE })
    const expected = bin(yPat, n).split('')
    expected[n - 1 - i] = 'X'
    expect(rig.outVec('Z', n), `S=1 with Y${i}=X`).toBe(expected.join(''))
    rig.set({ S: ZERO })
    expect(rig.outVec('Z', n), `S=0 ignores Y${i}=X`).toBe(bin(xPat, n))
  })

  it.each(['z', 'x'] as const)(`${n}-bit S fed %s: all outputs X`, (feed) => {
    const rig = buildRig(muxSpec(n), 'wire', { S: feed })
    rig.set({ ...vecSwitches('X', n, max), ...vecSwitches('Y', n, max) })
    expect(rig.outVec('Z', n)).toBe('X'.repeat(n))
    rig.set({ ...vecSwitches('X', n, 0), ...vecSwitches('Y', n, max) })
    expect(rig.outVec('Z', n)).toBe('X'.repeat(n))
  })

  it.each(['z', 'x'] as const)(`${n}-bit S fed %s through labels: all outputs X`, (feed) => {
    const rig = buildRig(muxSpec(n), 'label', { S: feed })
    rig.set({ ...vecSwitches('X', n, xPat), ...vecSwitches('Y', n, yPat) })
    expect(rig.outVec('Z', n)).toBe('X'.repeat(n))
  })
})

describe.each([3, 8, 16])('N_TRISTATE %i-bit: X/Z on a single input bit and on ctl (all widths)', (n) => {
  const max = (1 << n) - 1
  const pat = 0x5a5a & max

  it.each(range(n))('in%i unconnected with ctl=1: only out%i is X; ctl=0: all Z', (i) => {
    const rig = buildRig(tristateSpec(n), 'wire', { [`in${i}`]: 'z' })
    rig.set({ ...vecSwitches('in', n, pat), ctl: ONE })
    const expected = bin(pat, n).split('')
    expected[n - 1 - i] = 'X'
    expect(rig.outVec('out', n), `in${i}=Z, ctl=1`).toBe(expected.join(''))
    rig.set({ ctl: ZERO })
    expect(rig.outVec('out', n), `in${i}=Z, ctl=0`).toBe('Z'.repeat(n))
  })

  it.each(range(n))('in%i driven X with ctl=1: only out%i is X', (i) => {
    const rig = buildRig(tristateSpec(n), 'wire', { [`in${i}`]: 'x' })
    rig.set({ ...vecSwitches('in', n, ~pat & max), ctl: ONE })
    const expected = bin(~pat & max, n).split('')
    expected[n - 1 - i] = 'X'
    expect(rig.outVec('out', n), `in${i}=X, ctl=1`).toBe(expected.join(''))
  })

  it.each(['z', 'x'] as const)(`${n}-bit ctl fed %s: all outputs X regardless of inputs`, (feed) => {
    const rig = buildRig(tristateSpec(n), 'wire', { ctl: feed })
    rig.setVec('in', n, pat)
    expect(rig.outVec('out', n)).toBe('X'.repeat(n))
    rig.setVec('in', n, 0)
    expect(rig.outVec('out', n)).toBe('X'.repeat(n))
  })

  it.each(['z', 'x'] as const)(`${n}-bit ctl fed %s through labels: all outputs X`, (feed) => {
    const rig = buildRig(tristateSpec(n), 'label', { ctl: feed })
    rig.setVec('in', n, max)
    expect(rig.outVec('out', n)).toBe('X'.repeat(n))
  })
})

describe.each([8, 16])('N_ADDER %i-bit: X/Z on every single input pin (wires and labels)', (n) => {
  const max = (1 << n) - 1
  const inputPins = [...names('X', n), ...names('Y', n), 'Cin']

  it.each(inputPins)('%s unconnected (wires): S and Cout are all X', (pin) => {
    const rig = buildRig(adderSpec(n), 'wire', { [pin]: 'z' })
    rig.set({ ...vecSwitches('X', n, 0x5a5a & max), ...vecSwitches('Y', n, 0xa5a5 & max), Cin: ONE })
    expectAdderAllX(rig, n, `with ${pin} unconnected`)
  })

  it.each(inputPins)('%s driven X (labels): S and Cout are all X', (pin) => {
    const rig = buildRig(adderSpec(n), 'label', { [pin]: 'x' })
    rig.set({ ...vecSwitches('X', n, max), ...vecSwitches('Y', n, max), Cin: ONE })
    expectAdderAllX(rig, n, `with ${pin} = X (labels)`)
  })
})

describe('N_MUX_2TO1: a bad bit on the selected side does not leak into neighbouring bits', () => {
  it('16-bit, X7 unconnected, S=0: exactly one X in Z at bit 7 across several patterns', () => {
    const rig = buildRig(muxSpec(16), 'wire', { X7: 'z' })
    for (const v of [0, 0xffff, 0x8000, 0x0080, 0x7f7f]) {
      rig.set({ ...vecSwitches('X', 16, v), ...vecSwitches('Y', 16, 0), S: ZERO })
      const out = rig.outVec('Z', 16)
      expect(out.split('').filter((c) => c === 'X').length, `X count for ${v}`).toBe(1)
      expect(out[16 - 1 - 7], `bit 7 for ${v}`).toBe('X')
      expect(out.slice(0, 8) + out.slice(9), `other bits for ${v}`).toBe(bin(v, 16).slice(0, 8) + bin(v, 16).slice(9))
    }
  })
})
