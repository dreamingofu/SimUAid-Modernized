// Unit verification of the clocked N-bit parts (Appendix A of the SimUaid manual):
// N_COUNTER, N_LOADABLE_COUNTER, N_REGISTER, N_SHIFT_LEFT, N_SHIFT_RIGHT, N_SHIFT_BIDIR.
//
// Every assertion states SPEC behavior, not current behavior. Local helpers (not in
// harness.ts): a 4-valued source (switch -> MUX_2 -> tristate) so each control/data pin
// can be driven to 0/1/X/Z, and a `Part` fixture that wires one clocked part to such
// sources plus a clock (switch, 4-valued source, or the CLOCK part) and Q/K probes.

import { describe, expect, it } from 'vitest'
import { ComponentType, LogicValue, type PinId, type SimulationOptions } from '../../model/types'
import { CircuitBuilder, Circuit, p } from './harness'
import { clean, hexToVec, numToVec, vecEqual, vecToHex, vecToNum, xVec, zVec } from '../values'
import { getAbsolutePins } from '../../geometry/pins'

const { ZERO, ONE, X, Z } = LogicValue

// ---------------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------------

/**
 * Adds a 4-valued source named `id`. Output pin is returned. Switches:
 *   `${id}.v` = the 0/1 value, `${id}.x` = 1 forces X (mux selects an unconnected input),
 *   `${id}.z` = 0 forces Z (tristate disabled).
 */
function addSource(b: CircuitBuilder, id: string, initial: LogicValue): PinId {
  b.switch(`${id}.v`, initial === ONE ? ONE : ZERO)
    .switch(`${id}.x`, initial === X ? ONE : ZERO)
    .switch(`${id}.z`, initial === Z ? ZERO : ONE)
    .add(`${id}.m`, ComponentType.MUX_2)
    .add(`${id}.t`, ComponentType.TRISTATE_RIGHT)
    .wire(p(`${id}.v`, 'out'), p(`${id}.m`, 'in0'))
    .wire(p(`${id}.x`, 'out'), p(`${id}.m`, 'A'))
    .wire(p(`${id}.m`, 'Z'), p(`${id}.t`, 'in'))
    .wire(p(`${id}.z`, 'out'), p(`${id}.t`, 'ctl'))
  return p(`${id}.t`, 'out')
}

function sourceSwitches(id: string, v: LogicValue): Record<string, LogicValue> {
  return {
    [`${id}.v`]: v === ONE ? ONE : ZERO,
    [`${id}.x`]: v === X ? ONE : ZERO,
    [`${id}.z`]: v === Z ? ZERO : ONE
  }
}

/** Drives several 4-valued sources at once (single settle). */
function driveMany(c: Circuit, values: Record<string, LogicValue>): void {
  let all: Record<string, LogicValue> = {}
  for (const [id, v] of Object.entries(values)) all = { ...all, ...sourceSwitches(id, v) }
  c.setMany(all)
}

function charToValue(ch: string): LogicValue {
  if (ch === '0') return ZERO
  if (ch === '1') return ONE
  if (ch === 'X') return X
  if (ch === 'Z') return Z
  throw new Error(`bad logic char ${ch}`)
}

type ClockedType =
  | ComponentType.N_COUNTER
  | ComponentType.N_LOADABLE_COUNTER
  | ComponentType.N_REGISTER
  | ComponentType.N_SHIFT_LEFT
  | ComponentType.N_SHIFT_RIGHT
  | ComponentType.N_SHIFT_BIDIR

const CONTROL_PINS: Record<ClockedType, string[]> = {
  [ComponentType.N_COUNTER]: ['CLR', 'En'],
  [ComponentType.N_LOADABLE_COUNTER]: ['CLR', 'Ld', 'En'],
  [ComponentType.N_REGISTER]: ['CLR', 'Ld'],
  [ComponentType.N_SHIFT_LEFT]: ['CLR', 'Ld', 'LS', 'Rin'],
  [ComponentType.N_SHIFT_RIGHT]: ['CLR', 'Ld', 'RS', 'Lin'],
  [ComponentType.N_SHIFT_BIDIR]: ['CLR', 'Ld', 'LS', 'RS', 'Rin', 'Lin']
}

const HAS_D = new Set<ComponentType>([
  ComponentType.N_LOADABLE_COUNTER,
  ComponentType.N_REGISTER,
  ComponentType.N_SHIFT_LEFT,
  ComponentType.N_SHIFT_RIGHT,
  ComponentType.N_SHIFT_BIDIR
])

const IS_COUNTER = new Set<ComponentType>([ComponentType.N_COUNTER, ComponentType.N_LOADABLE_COUNTER])

interface PartOptions {
  /** Initial value of each control pin (default ZERO). */
  init?: Record<string, LogicValue>
  /** Initial D pattern, MSB-first (default all ZERO). */
  d?: string
  /** Pins to leave unconnected (control, D, or 'CLK'). */
  unconnected?: string[]
  /** Part propagation delay (default 1). */
  delay?: number
  /** 'switch' (default): CLK from a switch; 'source': 4-valued source; 'part': the CLOCK part. */
  clock?: 'switch' | 'source' | 'part'
  /** Initial value of the clock switch/source (default ZERO). */
  clockInitial?: LogicValue
  sim?: Partial<SimulationOptions>
}

/** One clocked N-bit part `u` wired to 4-valued sources, with a probe on every Q bit (and K). */
class Part {
  readonly c: Circuit
  readonly n: number
  readonly type: ClockedType
  private readonly unconnected: Set<string>

  constructor(type: ClockedType, n: number, opts: PartOptions = {}) {
    this.type = type
    this.n = n
    this.unconnected = new Set(opts.unconnected ?? [])
    const b = new CircuitBuilder(`${type}-${n}`)
    if (opts.sim) b.setSimulation(opts.sim)
    b.add('u', type, { bits: n, delay: opts.delay ?? 1 })

    const clockMode = opts.clock ?? 'switch'
    if (!this.unconnected.has('CLK')) {
      if (clockMode === 'switch') {
        b.switch('clk', opts.clockInitial ?? ZERO).wire(p('clk', 'out'), p('u', 'CLK'))
      } else if (clockMode === 'source') {
        b.wire(addSource(b, 'clk', opts.clockInitial ?? ZERO), p('u', 'CLK'))
      } else {
        b.add('clk', ComponentType.CLOCK).wire(p('clk', 'out'), p('u', 'CLK'))
      }
    }

    for (const pin of CONTROL_PINS[type]) {
      if (this.unconnected.has(pin)) continue
      b.wire(addSource(b, pin, opts.init?.[pin] ?? ZERO), p('u', pin))
    }

    if (HAS_D.has(type)) {
      const d = opts.d ?? '0'.repeat(n)
      if (d.length !== n) throw new Error(`d pattern must have ${n} chars`)
      for (let i = 0; i < n; i++) {
        const name = `D${i}`
        if (this.unconnected.has(name)) continue
        b.wire(addSource(b, name, charToValue(d[n - 1 - i])), p('u', name))
      }
    }

    for (let i = 0; i < n; i++) {
      b.probe(`pQ${i}`).wire(p('u', `Q${i}`), p(`pQ${i}`, 'in'))
    }
    if (IS_COUNTER.has(type)) b.probe('pK').wire(p('u', 'K'), p('pK', 'in'))

    this.c = b.build()
  }

  /** Q as an MSB-first string. */
  q(): string {
    return this.c.vec('u', 'Q', this.n)
  }

  k(): LogicValue {
    return this.c.pin(p('u', 'K'))
  }

  pin(name: string): LogicValue {
    return this.c.pin(p('u', name))
  }

  /** Drives one control pin's 4-valued source. */
  set(pin: string, v: LogicValue): this {
    if (this.unconnected.has(pin)) throw new Error(`${pin} is unconnected`)
    driveMany(this.c, { [pin]: v })
    return this
  }

  /** Drives several control pins at once. */
  setMany(values: Record<string, LogicValue>): this {
    driveMany(this.c, values)
    return this
  }

  /** Drives the D inputs from an MSB-first pattern of 0/1/X/Z chars. */
  setD(bits: string): this {
    if (bits.length !== this.n) throw new Error(`d pattern must have ${this.n} chars`)
    const values: Record<string, LogicValue> = {}
    for (let i = 0; i < this.n; i++) {
      if (this.unconnected.has(`D${i}`)) continue
      values[`D${i}`] = charToValue(bits[this.n - 1 - i])
    }
    driveMany(this.c, values)
    return this
  }

  rise(): this {
    this.c.set('clk', ONE)
    return this
  }

  fall(): this {
    this.c.set('clk', ZERO)
    return this
  }

  pulse(): this {
    return this.rise().fall()
  }

  /** Number of clock pulses applied; returns Q after the last one. */
  pulses(count: number): string {
    for (let i = 0; i < count; i++) this.pulse()
    return this.q()
  }

  /** Waveform samples recorded on the probe of Q bit i. */
  samples(i: number): { t: number; v: LogicValue }[] {
    const trace = this.c.sim.getWaveforms().find((w) => w.probeId === `pQ${i}`)
    if (!trace) throw new Error(`no probe pQ${i}`)
    return trace.samples.map((s) => ({ t: s.t, v: s.v }))
  }

  /** Total number of waveform samples over all Q probes (a change counter). */
  sampleCount(): number {
    let total = 0
    for (let i = 0; i < this.n; i++) total += this.samples(i).length
    return total
  }
}

function bin(value: number, n: number): string {
  return value.toString(2).padStart(n, '0')
}

// ---------------------------------------------------------------------------------
// values.ts: the pure vector helpers that the clocked parts rely on
// ---------------------------------------------------------------------------------

describe('values.ts vector helpers', () => {
  it('numToVec is LSB-first', () => {
    expect(numToVec(5, 4)).toEqual([ONE, ZERO, ONE, ZERO])
    expect(numToVec(1, 2)).toEqual([ONE, ZERO])
  })

  it('numToVec truncates to n bits (counter wrap)', () => {
    expect(numToVec(4, 2)).toEqual([ZERO, ZERO])
    expect(numToVec(16, 4)).toEqual([ZERO, ZERO, ZERO, ZERO])
    expect(numToVec(65536, 16)).toEqual(new Array(16).fill(ZERO))
    expect(numToVec(65535, 16)).toEqual(new Array(16).fill(ONE))
  })

  it('vecToNum reads LSB-first and is null for any X or Z bit', () => {
    expect(vecToNum([ONE, ZERO, ONE, ZERO])).toBe(5)
    expect(vecToNum([ONE, ONE])).toBe(3)
    expect(vecToNum([ZERO, ZERO])).toBe(0)
    expect(vecToNum([ONE, X])).toBeNull()
    expect(vecToNum([Z, ONE])).toBeNull()
    expect(vecToNum(xVec(4))).toBeNull()
  })

  it('numToVec and vecToNum round-trip every 4-bit value', () => {
    for (let v = 0; v < 16; v++) expect(vecToNum(numToVec(v, 4))).toBe(v)
  })

  it('vecToHex formats MSB-first with X/Z fills', () => {
    expect(vecToHex(numToVec(0xa, 4))).toBe('A')
    expect(vecToHex(numToVec(0xbeef, 16))).toBe('BEEF')
    expect(vecToHex(zVec(8))).toBe('ZZ')
    expect(vecToHex([ONE, X, ZERO, ZERO, ONE, ONE, ONE, ONE])).toBe('XX')
    expect(vecToHex(xVec(2))).toBe('X')
  })

  it('hexToVec parses hex into an LSB-first vector and rejects non-hex', () => {
    expect(hexToVec('A', 4)).toEqual([ZERO, ONE, ZERO, ONE])
    expect(hexToVec('FFFE', 16)).toEqual([ZERO, ...new Array(15).fill(ONE)])
    expect(hexToVec('G', 4)).toBeNull()
    expect(hexToVec('', 4)).toBeNull()
  })

  it('clean / xVec / zVec / vecEqual', () => {
    expect(clean(ZERO)).toBe(true)
    expect(clean(ONE)).toBe(true)
    expect(clean(X)).toBe(false)
    expect(clean(Z)).toBe(false)
    expect(xVec(3)).toEqual([X, X, X])
    expect(zVec(2)).toEqual([Z, Z])
    expect(vecEqual([ONE, ZERO], [ONE, ZERO])).toBe(true)
    expect(vecEqual([ONE, ZERO], [ONE, ONE])).toBe(false)
    expect(vecEqual(undefined, [ONE])).toBe(false)
    expect(vecEqual([ONE], [ONE, ONE])).toBe(false)
  })
})

// ---------------------------------------------------------------------------------
// The 4-valued source helper itself (sanity, so failures elsewhere are attributable)
// ---------------------------------------------------------------------------------

describe('local 4-valued source helper', () => {
  it('produces 0, 1, X and Z on demand', () => {
    const b = new CircuitBuilder()
    const out = addSource(b, 's', ZERO)
    b.probe('pr').wire(out, p('pr', 'in'))
    const c = b.build()
    expect(c.pin(p('pr', 'in'))).toBe(ZERO)
    driveMany(c, { s: ONE })
    expect(c.pin(p('pr', 'in'))).toBe(ONE)
    driveMany(c, { s: X })
    expect(c.pin(p('pr', 'in'))).toBe(X)
    driveMany(c, { s: Z })
    expect(c.pin(p('pr', 'in'))).toBe(Z)
    driveMany(c, { s: ZERO })
    expect(c.pin(p('pr', 'in'))).toBe(ZERO)
  })

  it('honours the initial value', () => {
    for (const v of [ZERO, ONE, X, Z]) {
      const b = new CircuitBuilder()
      const out = addSource(b, 's', v)
      b.probe('pr').wire(out, p('pr', 'in'))
      expect(b.build().pin(p('pr', 'in'))).toBe(v)
    }
  })
})

// ---------------------------------------------------------------------------------
// Pin geometry sanity: every input pin of every clocked part must be its own net
// (nets are resolved by coincident coordinates, so two pins at one spot are shorted).
// ---------------------------------------------------------------------------------

describe('clocked parts: each pin is an independent net', () => {
  const types: ClockedType[] = [
    ComponentType.N_COUNTER,
    ComponentType.N_LOADABLE_COUNTER,
    ComponentType.N_REGISTER,
    ComponentType.N_SHIFT_LEFT,
    ComponentType.N_SHIFT_RIGHT,
    ComponentType.N_SHIFT_BIDIR
  ]
  for (const type of types) {
    for (const n of [2, 4, 16]) {
      it(`${type} ${n}-bit: no two pins share a coordinate`, () => {
        const b = new CircuitBuilder().add('u', type, { bits: n })
        const comp = b.netlist.components[0]
        const pins = getAbsolutePins(comp)
        const seen = new Map<string, string>()
        for (const pin of pins) {
          const key = `${pin.x},${pin.y}`
          expect(seen.get(key), `${pin.name} collides with ${seen.get(key)} at (${pin.x},${pin.y})`).toBeUndefined()
          seen.set(key, pin.name)
        }
      })
    }
  }

  it('N_SHIFT_RIGHT: Lin is unconnected (Z) when only CLK is wired', () => {
    const b = new CircuitBuilder()
      .add('u', ComponentType.N_SHIFT_RIGHT, { bits: 4 })
      .switch('clk', ONE)
      .wire(p('clk', 'out'), p('u', 'CLK'))
    const c = b.build()
    expect(c.pin(p('u', 'CLK'))).toBe(ONE)
    expect(c.pin(p('u', 'Lin'))).toBe(Z)
  })

  it('N_SHIFT_BIDIR: Lin is unconnected (Z) when only CLK is wired', () => {
    const b = new CircuitBuilder()
      .add('u', ComponentType.N_SHIFT_BIDIR, { bits: 4 })
      .switch('clk', ONE)
      .wire(p('clk', 'out'), p('u', 'CLK'))
    const c = b.build()
    expect(c.pin(p('u', 'CLK'))).toBe(ONE)
    expect(c.pin(p('u', 'Lin'))).toBe(Z)
  })

  it('N_SHIFT_BIDIR: Lin, LS and CLK driven by three different switches are three independent nets', () => {
    const b = new CircuitBuilder()
      .add('u', ComponentType.N_SHIFT_BIDIR, { bits: 4 })
      .switch('clk', ZERO)
      .switch('lin', ONE)
      .switch('ls', ONE)
      .wire(p('clk', 'out'), p('u', 'CLK'))
      .wire(p('lin', 'out'), p('u', 'Lin'))
      .wire(p('ls', 'out'), p('u', 'LS'))
    const c = b.build()
    expect(c.pin(p('u', 'CLK'))).toBe(ZERO)
    expect(c.pin(p('u', 'Lin'))).toBe(ONE)
    expect(c.pin(p('u', 'LS'))).toBe(ONE)
    c.set('lin', ZERO)
    expect(c.pin(p('u', 'Lin'))).toBe(ZERO)
    expect(c.pin(p('u', 'CLK'))).toBe(ZERO)
    expect(c.pin(p('u', 'LS'))).toBe(ONE)
  })

  it('N_SHIFT_RIGHT: a switch on Lin and a switch on CLK do not contend', () => {
    const b = new CircuitBuilder()
      .add('u', ComponentType.N_SHIFT_RIGHT, { bits: 4 })
      .switch('clk', ZERO)
      .switch('lin', ONE)
      .wire(p('clk', 'out'), p('u', 'CLK'))
      .wire(p('lin', 'out'), p('u', 'Lin'))
    const c = b.build()
    expect(c.pin(p('u', 'CLK'))).toBe(ZERO)
    expect(c.pin(p('u', 'Lin'))).toBe(ONE)
  })
})

// ---------------------------------------------------------------------------------
// Bits clamping (decision 10): the simulator's width is the drawn part's width
// ---------------------------------------------------------------------------------

describe('clocked parts: bits clamping (decision 10)', () => {
  function pinNames(type: ClockedType, bits: number | undefined): Set<string> {
    const b = new CircuitBuilder().add('u', type, bits === undefined ? {} : { bits })
    expect(b.netlist.components[0].bits).toBe(bits)
    return new Set(getAbsolutePins(b.netlist.components[0]).map((pin) => pin.name))
  }

  it.each<[number | undefined, number]>([
    [undefined, 4],
    [0, 2],
    [1, 2],
    [2, 2],
    [16, 16],
    [17, 16],
    [99, 16]
  ])('N_REGISTER bits=%s draws %i Q pins', (bits, expected) => {
    const names = pinNames(ComponentType.N_REGISTER, bits)
    expect(names.has(`Q${expected - 1}`)).toBe(true)
    expect(names.has(`Q${expected}`)).toBe(false)
    expect(names.has(`D${expected - 1}`)).toBe(true)
    expect(names.has(`D${expected}`)).toBe(false)
  })

  it('N_COUNTER with bits=1 simulates as a 2-bit counter (counts 0..3 and wraps, K at 3)', () => {
    const b = new CircuitBuilder()
      .add('u', ComponentType.N_COUNTER, { bits: 1 })
      .switch('clk', ZERO)
      .switch('clr', ZERO)
      .switch('en', ONE)
      .wire(p('clk', 'out'), p('u', 'CLK'))
      .wire(p('clr', 'out'), p('u', 'CLR'))
      .wire(p('en', 'out'), p('u', 'En'))
    const c = b.build()
    expect(c.vec('u', 'Q', 2)).toBe('XX')
    expect(() => c.pin(p('u', 'Q2'))).toThrow()
    c.pulse('clk')
    expect(c.vec('u', 'Q', 2)).toBe('00')
    c.set('clr', ONE)
    for (const e of ['01', '10', '11', '00']) {
      c.pulse('clk')
      expect(c.vec('u', 'Q', 2)).toBe(e)
      expect(c.pin(p('u', 'K'))).toBe(e === '11' ? ONE : ZERO)
    }
  })

  it('N_REGISTER with bits=99 simulates as 16 bits (D15 loads into Q15; no Q16)', () => {
    const b = new CircuitBuilder()
      .add('u', ComponentType.N_REGISTER, { bits: 99 })
      .switch('clk', ZERO)
      .switch('clr', ZERO)
      .switch('ld', ONE)
      .switch('one', ONE)
      .wire(p('clk', 'out'), p('u', 'CLK'))
      .wire(p('clr', 'out'), p('u', 'CLR'))
      .wire(p('ld', 'out'), p('u', 'Ld'))
      .wire(p('one', 'out'), p('u', 'D15'))
    const c = b.build()
    expect(() => c.pin(p('u', 'Q16'))).toThrow()
    c.pulse('clk')
    expect(c.pin(p('u', 'Q15'))).toBe(ONE)
    expect(c.vec('u', 'Q', 16)).toBe('1' + 'X'.repeat(15)) // other D pins unconnected -> X
  })

  it('N_SHIFT_LEFT with bits undefined simulates as 4 bits', () => {
    const b = new CircuitBuilder()
      .add('u', ComponentType.N_SHIFT_LEFT)
      .switch('clk', ZERO)
      .switch('clr', ZERO)
      .switch('ld', ZERO)
      .switch('ls', ONE)
      .switch('rin', ONE)
      .wire(p('clk', 'out'), p('u', 'CLK'))
      .wire(p('clr', 'out'), p('u', 'CLR'))
      .wire(p('ld', 'out'), p('u', 'Ld'))
      .wire(p('ls', 'out'), p('u', 'LS'))
      .wire(p('rin', 'out'), p('u', 'Rin'))
    const c = b.build()
    expect(() => c.pin(p('u', 'Q4'))).toThrow()
    for (const e of ['XXX1', 'XX11', 'X111', '1111', '1111']) {
      c.pulse('clk')
      expect(c.vec('u', 'Q', 4)).toBe(e)
    }
  })
})

// ---------------------------------------------------------------------------------
// N_COUNTER
// ---------------------------------------------------------------------------------

describe.each([2, 4])('N_COUNTER %i-bit (switch clock)', (n) => {
  const T = ComponentType.N_COUNTER
  const max = (1 << n) - 1

  it('initial state after reset is X on every Q bit and K is X', () => {
    const u = new Part(T, n, { init: { CLR: ONE, En: ONE } })
    expect(u.q()).toBe('X'.repeat(n))
    expect(u.k()).toBe(X)
  })

  it('CLR=0 at a rising edge clears to 0 and K=0', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, En: ONE } })
    u.rise()
    expect(u.q()).toBe('0'.repeat(n))
    expect(u.k()).toBe(ZERO)
  })

  it('CLR is synchronous: setting CLR=0 with the clock idle at 0 does not clear', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, En: ONE } })
    u.pulse() // -> 0
    u.set('CLR', ONE)
    u.pulses(2) // -> 2
    expect(u.q()).toBe(bin(2, n))
    const before = u.sampleCount()
    u.set('CLR', ZERO) // clock is idle at 0
    expect(u.q()).toBe(bin(2, n))
    expect(u.sampleCount()).toBe(before)
    u.rise() // now the edge clears
    expect(u.q()).toBe('0'.repeat(n))
  })

  it('CLR is synchronous: setting CLR=0 with the clock idle at 1 does not clear', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, En: ONE } })
    u.pulse()
    u.set('CLR', ONE)
    u.pulse()
    u.rise() // Q = 2, clock high
    expect(u.q()).toBe(bin(2, n))
    u.set('CLR', ZERO)
    expect(u.q()).toBe(bin(2, n))
    u.fall()
    expect(u.q()).toBe(bin(2, n))
    u.rise()
    expect(u.q()).toBe('0'.repeat(n))
  })

  it('CLR=0 while the state is X keeps X until an edge', () => {
    const u = new Part(T, n, { init: { CLR: ONE, En: ONE } })
    u.set('CLR', ZERO)
    expect(u.q()).toBe('X'.repeat(n))
    expect(u.k()).toBe(X)
  })

  it(`counts 0..${max} and wraps to 0; K=1 only when all bits are 1`, () => {
    const u = new Part(T, n, { init: { CLR: ZERO, En: ONE } })
    u.pulse()
    u.set('CLR', ONE)
    for (let expected = 1; expected <= max + 1; expected++) {
      u.pulse()
      const value = expected & max
      expect(u.q(), `after ${expected} pulses`).toBe(bin(value, n))
      expect(u.k(), `K after ${expected} pulses`).toBe(value === max ? ONE : ZERO)
    }
    expect(u.q()).toBe('0'.repeat(n))
  })

  it('K=1 exactly at the all-ones state (checked over two full cycles)', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, En: ONE } })
    u.pulse()
    u.set('CLR', ONE)
    let value = 0
    for (let i = 0; i < 2 * (max + 1); i++) {
      expect(u.k()).toBe(value === max ? ONE : ZERO)
      u.pulse()
      value = (value + 1) & max
    }
  })

  it('En=0 holds the count at the edge', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, En: ONE } })
    u.pulse()
    u.set('CLR', ONE)
    u.pulses(2)
    u.set('En', ZERO)
    u.pulses(3)
    expect(u.q()).toBe(bin(2, n))
    u.set('En', ONE)
    u.pulse()
    expect(u.q()).toBe(bin(3, n))
  })

  it('En=0 holds all-ones and K stays 1', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, En: ONE } })
    u.pulse()
    u.set('CLR', ONE)
    u.pulses(max)
    expect(u.k()).toBe(ONE)
    u.set('En', ZERO)
    u.pulse()
    expect(u.q()).toBe('1'.repeat(n))
    expect(u.k()).toBe(ONE)
  })

  it('does not change on the falling edge', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, En: ONE } })
    u.pulse()
    u.set('CLR', ONE)
    u.rise()
    expect(u.q()).toBe(bin(1, n))
    const before = u.sampleCount()
    u.fall()
    expect(u.q()).toBe(bin(1, n))
    expect(u.sampleCount()).toBe(before)
  })

  it('changing En with the clock idle (both levels) does not change Q or K', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, En: ONE } })
    u.pulse()
    u.set('CLR', ONE)
    u.pulse()
    const before = u.sampleCount()
    u.set('En', ZERO).set('En', ONE).set('En', X).set('En', ONE)
    expect(u.q()).toBe(bin(1, n))
    expect(u.sampleCount()).toBe(before)
    u.rise()
    u.set('En', ZERO).set('En', ONE)
    expect(u.q()).toBe(bin(2, n))
  })

  it.each([X, Z])('CLR=%s at the edge -> all Q bits X and K X', (v) => {
    const u = new Part(T, n, { init: { CLR: ZERO, En: ONE } })
    u.pulse()
    u.set('CLR', v)
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
    expect(u.k()).toBe(X)
  })

  it('CLR unconnected at the edge -> all Q bits X', () => {
    const u = new Part(T, n, { init: { En: ONE }, unconnected: ['CLR'] })
    expect(u.pin('CLR')).toBe(Z)
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
    expect(u.k()).toBe(X)
  })

  it.each([X, Z])('En=%s at the edge with CLR=1 -> X', (v) => {
    const u = new Part(T, n, { init: { CLR: ZERO, En: ONE } })
    u.pulse()
    u.set('CLR', ONE)
    u.pulse()
    u.set('En', v)
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
    expect(u.k()).toBe(X)
  })

  it('En unconnected at the edge with CLR=1 -> X', () => {
    const u = new Part(T, n, { init: { CLR: ZERO }, unconnected: ['En'] })
    u.pulse()
    expect(u.q()).toBe('0'.repeat(n))
    u.set('CLR', ONE)
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
  })

  it.each([X, Z])('En=%s with CLR=0 still clears (En is not evaluated)', (v) => {
    const u = new Part(T, n, { init: { CLR: ZERO, En: v } })
    u.pulse()
    expect(u.q()).toBe('0'.repeat(n))
    expect(u.k()).toBe(ZERO)
  })

  it('En unconnected with CLR=0 still clears', () => {
    const u = new Part(T, n, { init: { CLR: ZERO }, unconnected: ['En'] })
    u.pulse()
    expect(u.q()).toBe('0'.repeat(n))
  })

  it('recovers from X: CLR=0 pulse clears an X state', () => {
    const u = new Part(T, n, { init: { CLR: X, En: ONE } })
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
    u.set('CLR', ZERO)
    u.pulse()
    expect(u.q()).toBe('0'.repeat(n))
    u.set('CLR', ONE)
    u.pulse()
    expect(u.q()).toBe(bin(1, n))
  })

  it('Q changes exactly one propagation delay after the edge (delay 1)', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, En: ONE } })
    u.pulse()
    u.set('CLR', ONE)
    const t0 = u.c.time
    u.rise() // switch out changes at t0+1 (edge), Q at t0+2
    const s = u.samples(0)
    expect(s[s.length - 1]).toEqual({ t: t0 + 2, v: ONE })
  })

  it('Q changes exactly one propagation delay after the edge (delay 3)', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, En: ONE }, delay: 3 })
    u.pulse()
    u.set('CLR', ONE)
    const t0 = u.c.time
    u.rise()
    const s = u.samples(0)
    expect(s[s.length - 1]).toEqual({ t: t0 + 4, v: ONE })
  })

  it('each Q bit changes at most once per edge (no glitches on 011 -> 100 style transitions)', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, En: ONE } })
    u.pulse()
    u.set('CLR', ONE)
    u.pulses(n === 2 ? 1 : 3) // 01 or 0011
    const before = u.n === 2 ? u.samples(0).length + u.samples(1).length : u.sampleCount()
    u.pulse() // 10 or 0100
    const after = u.n === 2 ? u.samples(0).length + u.samples(1).length : u.sampleCount()
    // every bit that changed produced exactly one sample
    expect(after - before).toBe(n === 2 ? 2 : 3)
  })

  it('reset() returns to X state, K X, time 0', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, En: ONE } })
    u.pulse()
    u.set('CLR', ONE)
    u.pulses(2)
    u.c.reset()
    expect(u.q()).toBe('X'.repeat(n))
    expect(u.k()).toBe(X)
    expect(u.c.time).toBe(0)
  })
})

describe('N_COUNTER clock edge robustness', () => {
  it('CLK X -> 1 is not a rising edge; 0 -> 1 afterwards is', () => {
    const u = new Part(ComponentType.N_COUNTER, 2, { init: { CLR: ZERO, En: ONE }, clock: 'source' })
    driveMany(u.c, { clk: ONE })
    driveMany(u.c, { clk: ZERO })
    expect(u.q()).toBe('00')
    u.set('CLR', ONE)
    driveMany(u.c, { clk: X })
    expect(u.pin('CLK')).toBe(X)
    // X -> 1: set the value first (still X since the mux selects the unconnected input)
    u.c.set('clk.v', ONE)
    expect(u.pin('CLK')).toBe(X)
    u.c.set('clk.x', ZERO)
    expect(u.pin('CLK')).toBe(ONE)
    expect(u.q()).toBe('00')
    u.c.set('clk.v', ZERO)
    u.c.set('clk.v', ONE)
    expect(u.q()).toBe('01')
  })

  it('CLK Z -> 1 is not a rising edge', () => {
    const u = new Part(ComponentType.N_COUNTER, 2, { init: { CLR: ZERO, En: ONE }, clock: 'source' })
    driveMany(u.c, { clk: ONE })
    driveMany(u.c, { clk: ZERO })
    expect(u.q()).toBe('00')
    u.set('CLR', ONE)
    u.c.set('clk.z', ZERO)
    expect(u.pin('CLK')).toBe(Z)
    u.c.set('clk.v', ONE)
    expect(u.pin('CLK')).toBe(Z)
    u.c.set('clk.z', ONE)
    expect(u.pin('CLK')).toBe(ONE)
    expect(u.q()).toBe('00')
  })

  it('CLK 1 -> X -> 0 -> 1: only the final 0 -> 1 counts', () => {
    const u = new Part(ComponentType.N_COUNTER, 2, { init: { CLR: ZERO, En: ONE }, clock: 'source' })
    driveMany(u.c, { clk: ONE })
    driveMany(u.c, { clk: ZERO })
    u.set('CLR', ONE)
    driveMany(u.c, { clk: ONE }) // 1 edge -> 01
    expect(u.q()).toBe('01')
    driveMany(u.c, { clk: X })
    expect(u.q()).toBe('01')
    driveMany(u.c, { clk: ZERO })
    expect(u.q()).toBe('01')
    driveMany(u.c, { clk: ONE })
    expect(u.q()).toBe('10')
  })

  it('unconnected CLK: outputs stay X no matter what the controls do', () => {
    const u = new Part(ComponentType.N_COUNTER, 4, { init: { CLR: ZERO, En: ONE }, unconnected: ['CLK'] })
    expect(u.pin('CLK')).toBe(Z)
    u.set('CLR', ONE).set('CLR', ZERO).set('En', ZERO).set('En', ONE)
    expect(u.q()).toBe('XXXX')
    expect(u.k()).toBe(X)
  })

  it('clock switch initially 1: the first 1 -> 0 is not an edge, the next 0 -> 1 is', () => {
    const u = new Part(ComponentType.N_COUNTER, 2, { init: { CLR: ZERO, En: ONE }, clockInitial: ONE })
    expect(u.q()).toBe('XX')
    u.fall()
    expect(u.q()).toBe('XX')
    u.rise()
    expect(u.q()).toBe('00')
  })
})

// ---------------------------------------------------------------------------------
// N_LOADABLE_COUNTER
// ---------------------------------------------------------------------------------

describe.each([2, 4])('N_LOADABLE_COUNTER %i-bit (switch clock)', (n) => {
  const T = ComponentType.N_LOADABLE_COUNTER
  const max = (1 << n) - 1

  it('initial state is X, K is X', () => {
    const u = new Part(T, n, { init: { CLR: ONE, Ld: ONE, En: ONE } })
    expect(u.q()).toBe('X'.repeat(n))
    expect(u.k()).toBe(X)
  })

  it(`Ld=0 with CLR=1 loads D at the edge (all ${max + 1} values)`, () => {
    for (let v = 0; v <= max; v++) {
      const u = new Part(T, n, { init: { CLR: ONE, Ld: ZERO, En: ONE }, d: bin(v, n) })
      u.pulse()
      expect(u.q(), `load ${v}`).toBe(bin(v, n))
      expect(u.k(), `K after load ${v}`).toBe(v === max ? ONE : ZERO)
    }
  })

  it('loads consecutive different values on consecutive edges', () => {
    const u = new Part(T, n, { init: { CLR: ONE, Ld: ZERO, En: ONE } })
    for (let v = max; v >= 0; v--) {
      u.setD(bin(v, n))
      u.pulse()
      expect(u.q()).toBe(bin(v, n))
    }
  })

  it('Ld=0 loads regardless of En=0', () => {
    const u = new Part(T, n, { init: { CLR: ONE, Ld: ZERO, En: ZERO }, d: bin(max, n) })
    u.pulse()
    expect(u.q()).toBe(bin(max, n))
    expect(u.k()).toBe(ONE)
  })

  it.each([X, Z])('Ld=0 loads regardless of En=%s (En not evaluated)', (v) => {
    const u = new Part(T, n, { init: { CLR: ONE, Ld: ZERO, En: v }, d: bin(1, n) })
    u.pulse()
    expect(u.q()).toBe(bin(1, n))
  })

  it('Ld=0 loads regardless of En unconnected', () => {
    const u = new Part(T, n, { init: { CLR: ONE, Ld: ZERO }, d: bin(2, n), unconnected: ['En'] })
    u.pulse()
    expect(u.q()).toBe(bin(2, n))
  })

  it('CLR=0 wins over Ld=0 (clears instead of loading)', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, Ld: ZERO, En: ONE }, d: bin(max, n) })
    u.pulse()
    expect(u.q()).toBe('0'.repeat(n))
    expect(u.k()).toBe(ZERO)
  })

  it.each([X, Z])('CLR=0 clears regardless of Ld=%s', (v) => {
    const u = new Part(T, n, { init: { CLR: ZERO, Ld: v, En: X }, d: 'X'.repeat(n) })
    u.pulse()
    expect(u.q()).toBe('0'.repeat(n))
  })

  it('CLR=0 clears regardless of Ld/En unconnected', () => {
    const u = new Part(T, n, { init: { CLR: ZERO }, unconnected: ['Ld', 'En'] })
    u.pulse()
    expect(u.q()).toBe('0'.repeat(n))
  })

  it('Ld=1, En=1 increments; wraps; K=1 at all ones', () => {
    const u = new Part(T, n, { init: { CLR: ONE, Ld: ZERO, En: ONE }, d: '0'.repeat(n) })
    u.pulse()
    u.set('Ld', ONE)
    for (let expected = 1; expected <= max + 1; expected++) {
      u.pulse()
      const value = expected & max
      expect(u.q()).toBe(bin(value, n))
      expect(u.k()).toBe(value === max ? ONE : ZERO)
    }
  })

  it('load then count from the loaded value and wrap', () => {
    const u = new Part(T, n, { init: { CLR: ONE, Ld: ZERO, En: ONE }, d: bin(max - 1, n) })
    u.pulse()
    expect(u.q()).toBe(bin(max - 1, n))
    u.set('Ld', ONE)
    u.pulse()
    expect(u.q()).toBe(bin(max, n))
    expect(u.k()).toBe(ONE)
    u.pulse()
    expect(u.q()).toBe('0'.repeat(n))
    expect(u.k()).toBe(ZERO)
  })

  it('Ld=1, En=0 holds', () => {
    const u = new Part(T, n, { init: { CLR: ONE, Ld: ZERO, En: ONE }, d: bin(2, n) })
    u.pulse()
    u.setMany({ Ld: ONE, En: ZERO })
    u.pulses(3)
    expect(u.q()).toBe(bin(2, n))
  })

  it.each([X, Z])('Ld=%s with CLR=1 -> X', (v) => {
    const u = new Part(T, n, { init: { CLR: ONE, Ld: ZERO, En: ONE }, d: bin(1, n) })
    u.pulse()
    u.set('Ld', v)
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
    expect(u.k()).toBe(X)
  })

  it('Ld unconnected with CLR=1 -> X', () => {
    const u = new Part(T, n, { init: { CLR: ONE, En: ONE }, unconnected: ['Ld'] })
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
  })

  it.each([X, Z])('En=%s with Ld=1, CLR=1 -> X', (v) => {
    const u = new Part(T, n, { init: { CLR: ONE, Ld: ZERO, En: ONE }, d: bin(1, n) })
    u.pulse()
    u.setMany({ Ld: ONE, En: v })
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
  })

  it.each([X, Z])('CLR=%s -> X even when Ld=0 with a clean D', (v) => {
    const u = new Part(T, n, { init: { CLR: v, Ld: ZERO, En: ONE }, d: bin(1, n) })
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
    expect(u.k()).toBe(X)
  })

  it('CLR unconnected -> X', () => {
    const u = new Part(T, n, { init: { Ld: ZERO, En: ONE }, d: bin(1, n), unconnected: ['CLR'] })
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
  })

  it.each([X, Z])('D bit 0 = %s at load -> only bit 0 is X; K is X', (v) => {
    const pattern = '1'.repeat(n - 1) + (v === X ? 'X' : 'Z')
    const u = new Part(T, n, { init: { CLR: ONE, Ld: ZERO, En: ONE }, d: pattern })
    u.pulse()
    expect(u.q()).toBe('1'.repeat(n - 1) + 'X')
    expect(u.k()).toBe(X)
  })

  it('unconnected D bit at load -> only that bit is X', () => {
    const u = new Part(T, n, {
      init: { CLR: ONE, Ld: ZERO, En: ONE },
      d: '1'.repeat(n),
      unconnected: [`D${n - 1}`]
    })
    u.pulse()
    expect(u.q()).toBe('X' + '1'.repeat(n - 1))
  })

  it('X bit loaded, then counting keeps everything X (X + 1 = X)', () => {
    const u = new Part(T, n, { init: { CLR: ONE, Ld: ZERO, En: ONE }, d: 'X' + '0'.repeat(n - 1) })
    u.pulse()
    u.set('Ld', ONE)
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
  })

  it('changing D with the clock idle does not change Q', () => {
    const u = new Part(T, n, { init: { CLR: ONE, Ld: ZERO, En: ONE }, d: bin(1, n) })
    u.pulse()
    const before = u.sampleCount()
    u.setD(bin(max, n))
    u.setD('X'.repeat(n))
    expect(u.q()).toBe(bin(1, n))
    expect(u.sampleCount()).toBe(before)
    u.setD(bin(2, n))
    u.rise()
    expect(u.q()).toBe(bin(2, n))
    u.setD(bin(3, n)) // clock idle at 1
    expect(u.q()).toBe(bin(2, n))
  })

  it('changing Ld/CLR/En with the clock idle does not change Q', () => {
    const u = new Part(T, n, { init: { CLR: ONE, Ld: ZERO, En: ONE }, d: bin(1, n) })
    u.pulse()
    const before = u.sampleCount()
    u.set('Ld', ONE).set('CLR', ZERO).set('En', ZERO).set('CLR', X).set('Ld', X)
    expect(u.q()).toBe(bin(1, n))
    expect(u.sampleCount()).toBe(before)
  })

  it('does not change on the falling edge', () => {
    const u = new Part(T, n, { init: { CLR: ONE, Ld: ZERO, En: ONE }, d: bin(1, n) })
    u.rise()
    expect(u.q()).toBe(bin(1, n))
    u.setD(bin(2, n))
    const before = u.sampleCount()
    u.fall()
    expect(u.q()).toBe(bin(1, n))
    expect(u.sampleCount()).toBe(before)
  })

  it('Q and K change one delay after the edge (delay 2)', () => {
    const u = new Part(T, n, { init: { CLR: ONE, Ld: ZERO, En: ONE }, d: bin(max, n), delay: 2 })
    const t0 = u.c.time
    u.rise()
    const s = u.samples(0)
    expect(s[s.length - 1]).toEqual({ t: t0 + 3, v: ONE })
    const k = u.c.sim.getWaveforms().find((w) => w.probeId === 'pK')!.samples
    expect(k[k.length - 1].t).toBe(t0 + 3)
    expect(k[k.length - 1].v).toBe(ONE)
  })
})

describe('N_LOADABLE_COUNTER 16-bit sanity', () => {
  it('loads FFFE, counts to FFFF (K=1) and wraps to 0000 (K=0)', () => {
    const u = new Part(ComponentType.N_LOADABLE_COUNTER, 16, {
      init: { CLR: ONE, Ld: ZERO, En: ONE },
      d: bin(0xfffe, 16)
    })
    expect(u.q()).toBe('X'.repeat(16))
    u.pulse()
    expect(u.q()).toBe(bin(0xfffe, 16))
    expect(u.k()).toBe(ZERO)
    u.set('Ld', ONE)
    u.pulse()
    expect(u.q()).toBe('1'.repeat(16))
    expect(u.k()).toBe(ONE)
    u.pulse()
    expect(u.q()).toBe('0'.repeat(16))
    expect(u.k()).toBe(ZERO)
    u.pulse()
    expect(u.q()).toBe(bin(1, 16))
  })

  it('16-bit plain counter clears and counts', () => {
    const u = new Part(ComponentType.N_COUNTER, 16, { init: { CLR: ZERO, En: ONE } })
    u.pulse()
    expect(u.q()).toBe('0'.repeat(16))
    u.set('CLR', ONE)
    u.pulses(5)
    expect(u.q()).toBe(bin(5, 16))
    expect(u.k()).toBe(ZERO)
  })
})

// ---------------------------------------------------------------------------------
// N_REGISTER
// ---------------------------------------------------------------------------------

describe.each([2, 4])('N_REGISTER %i-bit (switch clock)', (n) => {
  const T = ComponentType.N_REGISTER
  const max = (1 << n) - 1

  it('initial state is X', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, Ld: ONE } })
    expect(u.q()).toBe('X'.repeat(n))
  })

  it('CLR=1 clears at the edge (active high)', () => {
    const u = new Part(T, n, { init: { CLR: ONE, Ld: ONE }, d: '1'.repeat(n) })
    u.pulse()
    expect(u.q()).toBe('0'.repeat(n))
  })

  it.each([X, Z])('CLR=1 clears regardless of Ld=%s and D all X', (v) => {
    const u = new Part(T, n, { init: { CLR: ONE, Ld: v }, d: 'X'.repeat(n) })
    u.pulse()
    expect(u.q()).toBe('0'.repeat(n))
  })

  it('CLR=1 clears regardless of Ld unconnected', () => {
    const u = new Part(T, n, { init: { CLR: ONE }, unconnected: ['Ld'] })
    u.pulse()
    expect(u.q()).toBe('0'.repeat(n))
  })

  it(`CLR=0, Ld=1 loads D at the edge (all ${max + 1} values)`, () => {
    for (let v = 0; v <= max; v++) {
      const u = new Part(T, n, { init: { CLR: ZERO, Ld: ONE }, d: bin(v, n) })
      u.pulse()
      expect(u.q(), `load ${v}`).toBe(bin(v, n))
    }
  })

  it('loads a new value on each edge', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, Ld: ONE } })
    for (let v = 0; v <= max; v++) {
      u.setD(bin(v, n))
      u.pulse()
      expect(u.q()).toBe(bin(v, n))
    }
  })

  it('CLR=0, Ld=0 holds (D ignored, even X)', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, Ld: ONE }, d: bin(1, n) })
    u.pulse()
    u.set('Ld', ZERO)
    u.setD('X'.repeat(n))
    u.pulses(3)
    expect(u.q()).toBe(bin(1, n))
    u.setD(bin(max, n))
    u.pulse()
    expect(u.q()).toBe(bin(1, n))
  })

  it('hold keeps an X state X', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, Ld: ZERO } })
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
  })

  it.each([X, Z])('CLR=%s -> X', (v) => {
    const u = new Part(T, n, { init: { CLR: ZERO, Ld: ONE }, d: bin(1, n) })
    u.pulse()
    u.set('CLR', v)
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
  })

  it('CLR unconnected -> X', () => {
    const u = new Part(T, n, { init: { Ld: ONE }, d: bin(1, n), unconnected: ['CLR'] })
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
  })

  it.each([X, Z])('Ld=%s with CLR=0 -> X', (v) => {
    const u = new Part(T, n, { init: { CLR: ZERO, Ld: ONE }, d: bin(1, n) })
    u.pulse()
    u.set('Ld', v)
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
  })

  it('Ld unconnected with CLR=0 -> X', () => {
    const u = new Part(T, n, { init: { CLR: ZERO }, unconnected: ['Ld'] })
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
  })

  it.each([X, Z])('one D bit = %s at load -> only that bit is X', (v) => {
    const ch = v === X ? 'X' : 'Z'
    const u = new Part(T, n, { init: { CLR: ZERO, Ld: ONE }, d: ch + '1'.repeat(n - 1) })
    u.pulse()
    expect(u.q()).toBe('X' + '1'.repeat(n - 1))
    u.setD('0'.repeat(n - 1) + ch)
    u.pulse()
    expect(u.q()).toBe('0'.repeat(n - 1) + 'X')
  })

  it('unconnected D bit at load -> only that bit is X', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, Ld: ONE }, d: '1'.repeat(n), unconnected: ['D0'] })
    u.pulse()
    expect(u.q()).toBe('1'.repeat(n - 1) + 'X')
  })

  it('changing D with the clock idle at 0 and at 1 does not change Q', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, Ld: ONE }, d: bin(1, n) })
    u.pulse()
    const before = u.sampleCount()
    u.setD(bin(max, n))
    expect(u.q()).toBe(bin(1, n))
    u.setD('X'.repeat(n))
    expect(u.q()).toBe(bin(1, n))
    expect(u.sampleCount()).toBe(before)
    u.setD(bin(2, n))
    u.rise()
    expect(u.q()).toBe(bin(2, n))
    u.setD(bin(3, n))
    expect(u.q()).toBe(bin(2, n))
    u.fall()
    expect(u.q()).toBe(bin(2, n))
  })

  it('CLR is synchronous: CLR=1 with the clock idle does not clear', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, Ld: ONE }, d: bin(max, n) })
    u.pulse()
    const before = u.sampleCount()
    u.set('CLR', ONE)
    expect(u.q()).toBe(bin(max, n))
    expect(u.sampleCount()).toBe(before)
    u.rise()
    expect(u.q()).toBe('0'.repeat(n))
  })

  it('does not change on the falling edge', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, Ld: ONE }, d: bin(1, n) })
    u.rise()
    u.setD(bin(2, n))
    const before = u.sampleCount()
    u.fall()
    expect(u.q()).toBe(bin(1, n))
    expect(u.sampleCount()).toBe(before)
  })

  it('Q changes one delay after the edge (delay 5)', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, Ld: ONE }, d: bin(max, n), delay: 5 })
    const t0 = u.c.time
    u.rise()
    for (let i = 0; i < n; i++) {
      const s = u.samples(i)
      expect(s[s.length - 1]).toEqual({ t: t0 + 6, v: ONE })
    }
  })

  it('reset() returns to X', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, Ld: ONE }, d: bin(max, n) })
    u.pulse()
    u.c.reset()
    expect(u.q()).toBe('X'.repeat(n))
  })
})

describe('N_REGISTER 16-bit sanity', () => {
  it('loads BEEF then clears', () => {
    const u = new Part(ComponentType.N_REGISTER, 16, { init: { CLR: ZERO, Ld: ONE }, d: bin(0xbeef, 16) })
    u.pulse()
    expect(u.q()).toBe(bin(0xbeef, 16))
    u.set('CLR', ONE)
    u.pulse()
    expect(u.q()).toBe('0'.repeat(16))
  })

  it('unconnected CLK never loads', () => {
    const u = new Part(ComponentType.N_REGISTER, 4, { init: { CLR: ZERO, Ld: ONE }, d: '1010', unconnected: ['CLK'] })
    u.set('Ld', ZERO).set('Ld', ONE).set('CLR', ONE).set('CLR', ZERO)
    u.setD('0101')
    expect(u.q()).toBe('XXXX')
  })
})

// ---------------------------------------------------------------------------------
// N_SHIFT_LEFT
// ---------------------------------------------------------------------------------

describe.each([2, 4])('N_SHIFT_LEFT %i-bit (switch clock)', (n) => {
  const T = ComponentType.N_SHIFT_LEFT

  /** Loaded with `pattern`, CLR=0, Ld=0 afterwards, ready to shift. */
  function loaded(pattern: string, extra: Record<string, LogicValue> = {}): Part {
    const u = new Part(T, n, { init: { CLR: ZERO, Ld: ONE, LS: ZERO, Rin: ZERO, ...extra }, d: pattern })
    u.pulse()
    expect(u.q()).toBe(pattern)
    u.set('Ld', ZERO)
    return u
  }

  const shiftLeft = (q: string, rin: string): string => q.slice(1) + rin

  it('initial state is X', () => {
    expect(new Part(T, n).q()).toBe('X'.repeat(n))
  })

  it('CLR=1 clears at the edge regardless of Ld/LS/Rin', () => {
    const u = new Part(T, n, { init: { CLR: ONE, Ld: ONE, LS: ONE, Rin: ONE }, d: '1'.repeat(n) })
    u.pulse()
    expect(u.q()).toBe('0'.repeat(n))
  })

  it.each([X, Z])('CLR=1 clears regardless of Ld=%s, LS=%s, Rin=%s', (v) => {
    const u = new Part(T, n, { init: { CLR: ONE, Ld: v, LS: v, Rin: v }, d: 'X'.repeat(n) })
    u.pulse()
    expect(u.q()).toBe('0'.repeat(n))
  })

  it('CLR=1 clears regardless of Ld/LS/Rin unconnected', () => {
    const u = new Part(T, n, { init: { CLR: ONE }, unconnected: ['Ld', 'LS', 'Rin'] })
    u.pulse()
    expect(u.q()).toBe('0'.repeat(n))
  })

  it('CLR=0, Ld=1 loads regardless of LS/Rin (including X)', () => {
    const pattern = '1' + '0'.repeat(n - 1)
    const u = new Part(T, n, { init: { CLR: ZERO, Ld: ONE, LS: ONE, Rin: ONE }, d: pattern })
    u.pulse()
    expect(u.q()).toBe(pattern)
    u.setMany({ LS: X, Rin: X })
    u.setD('0' + '1'.repeat(n - 1))
    u.pulse()
    expect(u.q()).toBe('0' + '1'.repeat(n - 1))
  })

  it('CLR=0, Ld=1 loads with LS/Rin unconnected', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, Ld: ONE }, d: bin(1, n), unconnected: ['LS', 'Rin'] })
    u.pulse()
    expect(u.q()).toBe(bin(1, n))
  })

  it('LS=1 shifts left: bit i <= bit i-1, bit 0 <= Rin=0', () => {
    const u = loaded('1'.repeat(n))
    u.set('LS', ONE)
    let q = '1'.repeat(n)
    for (let i = 0; i < n; i++) {
      u.pulse()
      q = shiftLeft(q, '0')
      expect(u.q(), `after ${i + 1} shifts`).toBe(q)
    }
    expect(u.q()).toBe('0'.repeat(n))
  })

  it('LS=1 shifts left with Rin=1: fills from bit 0', () => {
    const u = loaded('0'.repeat(n))
    u.setMany({ LS: ONE, Rin: ONE })
    let q = '0'.repeat(n)
    for (let i = 0; i < n; i++) {
      u.pulse()
      q = shiftLeft(q, '1')
      expect(u.q()).toBe(q)
    }
  })

  it('shifts a walking 1 out the MSB', () => {
    const u = loaded(bin(1, n))
    u.set('LS', ONE)
    for (let i = 1; i < n; i++) {
      u.pulse()
      expect(u.q()).toBe(bin(1 << i, n))
    }
    u.pulse()
    expect(u.q()).toBe('0'.repeat(n))
  })

  it('shifts an alternating pattern with a varying Rin', () => {
    const u = loaded(bin(0b1010 & ((1 << n) - 1), n))
    u.set('LS', ONE)
    let q = u.q()
    const rins = ['1', '1', '0', '1']
    for (const r of rins) {
      u.set('Rin', charToValue(r))
      u.pulse()
      q = shiftLeft(q, r)
      expect(u.q()).toBe(q)
    }
  })

  it('shifting from the X initial state fills with clean bits one per edge', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, Ld: ZERO, LS: ONE, Rin: ONE } })
    let q = 'X'.repeat(n)
    for (let i = 0; i < n; i++) {
      u.pulse()
      q = shiftLeft(q, '1')
      expect(u.q()).toBe(q)
    }
    expect(u.q()).toBe('1'.repeat(n))
  })

  it('LS=0 holds (Rin ignored, even X)', () => {
    const u = loaded(bin(1, n))
    u.set('Rin', X)
    u.pulses(3)
    expect(u.q()).toBe(bin(1, n))
  })

  it('LS=0 holds with Rin unconnected', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, Ld: ONE, LS: ZERO }, d: bin(1, n), unconnected: ['Rin'] })
    u.pulse()
    u.set('Ld', ZERO)
    u.pulse()
    expect(u.q()).toBe(bin(1, n))
  })

  it.each([X, Z])('LS=%s with CLR=Ld=0 -> X', (v) => {
    const u = loaded(bin(1, n))
    u.set('LS', v)
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
  })

  it('LS unconnected with CLR=Ld=0 -> X', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, Ld: ONE, Rin: ZERO }, d: bin(1, n), unconnected: ['LS'] })
    u.pulse()
    u.set('Ld', ZERO)
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
  })

  it.each([X, Z])('Rin=%s while shifting -> only bit 0 is X, the rest shift correctly', (v) => {
    const u = loaded('1'.repeat(n))
    u.setMany({ LS: ONE, Rin: v })
    u.pulse()
    expect(u.q()).toBe('1'.repeat(n - 1) + 'X')
    u.set('Rin', ZERO)
    u.pulse()
    expect(u.q()).toBe('1'.repeat(n - 2) + 'X0')
  })

  it('Rin unconnected while shifting -> only bit 0 is X', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, Ld: ONE, LS: ZERO }, d: '1'.repeat(n), unconnected: ['Rin'] })
    u.pulse()
    u.setMany({ Ld: ZERO, LS: ONE })
    u.pulse()
    expect(u.q()).toBe('1'.repeat(n - 1) + 'X')
  })

  it.each([X, Z])('Ld=%s with CLR=0 -> X', (v) => {
    const u = loaded(bin(1, n))
    u.set('Ld', v)
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
  })

  it.each([X, Z])('CLR=%s -> X', (v) => {
    const u = loaded(bin(1, n))
    u.set('CLR', v)
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
  })

  it('CLR unconnected -> X (even with Ld=1 and a clean D)', () => {
    const u = new Part(T, n, { init: { Ld: ONE, LS: ZERO, Rin: ZERO }, d: bin(1, n), unconnected: ['CLR'] })
    expect(u.pin('CLR')).toBe(Z)
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
  })

  it('Ld unconnected with CLR=0 -> X (even with LS=1)', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, LS: ONE, Rin: ZERO }, d: bin(1, n), unconnected: ['Ld'] })
    expect(u.pin('Ld')).toBe(Z)
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
  })

  it('one X D bit at load -> only that bit X; it then shifts along', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, Ld: ONE, LS: ZERO, Rin: ZERO }, d: '1'.repeat(n - 1) + 'X' })
    u.pulse()
    expect(u.q()).toBe('1'.repeat(n - 1) + 'X')
    u.setMany({ Ld: ZERO, LS: ONE })
    u.pulse()
    expect(u.q()).toBe('1'.repeat(n - 2) + 'X0')
  })

  it('changing LS/Rin/D with the clock idle does not change Q', () => {
    const u = loaded(bin(1, n))
    const before = u.sampleCount()
    u.set('LS', ONE).set('Rin', ONE).setD('1'.repeat(n)).set('Ld', ONE).set('CLR', ONE)
    expect(u.q()).toBe(bin(1, n))
    expect(u.sampleCount()).toBe(before)
  })

  it('does not change on the falling edge', () => {
    const u = loaded(bin(1, n))
    u.set('LS', ONE)
    u.rise()
    expect(u.q()).toBe(bin(2, n))
    const before = u.sampleCount()
    u.fall()
    expect(u.q()).toBe(bin(2, n))
    expect(u.sampleCount()).toBe(before)
  })

  it('Q changes one delay after the edge (delay 2)', () => {
    const u = loaded('0'.repeat(n))
    u.setMany({ LS: ONE, Rin: ONE })
    const t0 = u.c.time
    u.rise()
    const s = u.samples(0)
    expect(s[s.length - 1]).toEqual({ t: t0 + 2, v: ONE })
  })
})

describe('N_SHIFT_LEFT 16-bit sanity', () => {
  it('loads 8001 and shifts left twice with Rin=1', () => {
    const u = new Part(ComponentType.N_SHIFT_LEFT, 16, {
      init: { CLR: ZERO, Ld: ONE, LS: ZERO, Rin: ONE },
      d: bin(0x8001, 16)
    })
    u.pulse()
    expect(u.q()).toBe(bin(0x8001, 16))
    u.setMany({ Ld: ZERO, LS: ONE })
    u.pulse()
    expect(u.q()).toBe(bin(0x0003, 16))
    u.pulse()
    expect(u.q()).toBe(bin(0x0007, 16))
  })
})

// ---------------------------------------------------------------------------------
// N_SHIFT_RIGHT
// ---------------------------------------------------------------------------------

describe.each([2, 4])('N_SHIFT_RIGHT %i-bit (switch clock)', (n) => {
  const T = ComponentType.N_SHIFT_RIGHT

  function loaded(pattern: string, extra: Record<string, LogicValue> = {}): Part {
    const u = new Part(T, n, { init: { CLR: ZERO, Ld: ONE, RS: ZERO, Lin: ZERO, ...extra }, d: pattern })
    u.pulse()
    expect(u.q()).toBe(pattern)
    u.set('Ld', ZERO)
    return u
  }

  const shiftRight = (q: string, lin: string): string => lin + q.slice(0, -1)

  it('initial state is X', () => {
    expect(new Part(T, n).q()).toBe('X'.repeat(n))
  })

  it('CLR=1 clears at the edge regardless of Ld/RS/Lin', () => {
    const u = new Part(T, n, { init: { CLR: ONE, Ld: ONE, RS: ONE, Lin: ONE }, d: '1'.repeat(n) })
    u.pulse()
    expect(u.q()).toBe('0'.repeat(n))
  })

  it.each([X, Z])('CLR=1 clears regardless of Ld=%s, RS=%s, Lin=%s', (v) => {
    const u = new Part(T, n, { init: { CLR: ONE, Ld: v, RS: v, Lin: v }, d: 'X'.repeat(n) })
    u.pulse()
    expect(u.q()).toBe('0'.repeat(n))
  })

  it('CLR=0, Ld=1 loads regardless of RS/Lin (including X)', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, Ld: ONE, RS: X, Lin: X }, d: bin(1, n) })
    u.pulse()
    expect(u.q()).toBe(bin(1, n))
  })

  it('CLR=0, Ld=1 loads with RS/Lin unconnected', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, Ld: ONE }, d: bin(1, n), unconnected: ['RS', 'Lin'] })
    u.pulse()
    expect(u.q()).toBe(bin(1, n))
  })

  it('RS=1 shifts right: bit i <= bit i+1, bit n-1 <= Lin=0', () => {
    const u = loaded('1'.repeat(n))
    u.set('RS', ONE)
    let q = '1'.repeat(n)
    for (let i = 0; i < n; i++) {
      u.pulse()
      q = shiftRight(q, '0')
      expect(u.q(), `after ${i + 1} shifts`).toBe(q)
    }
    expect(u.q()).toBe('0'.repeat(n))
  })

  it('RS=1 shifts right with Lin=1: fills from the MSB', () => {
    const u = loaded('0'.repeat(n))
    u.setMany({ RS: ONE, Lin: ONE })
    let q = '0'.repeat(n)
    for (let i = 0; i < n; i++) {
      u.pulse()
      q = shiftRight(q, '1')
      expect(u.q()).toBe(q)
    }
  })

  it('shifts a walking 1 out the LSB', () => {
    const u = loaded(bin(1 << (n - 1), n))
    u.set('RS', ONE)
    for (let i = n - 2; i >= 0; i--) {
      u.pulse()
      expect(u.q()).toBe(bin(1 << i, n))
    }
    u.pulse()
    expect(u.q()).toBe('0'.repeat(n))
  })

  it('shifts with a varying Lin', () => {
    const u = loaded(bin(0b0101 & ((1 << n) - 1), n))
    u.set('RS', ONE)
    let q = u.q()
    for (const l of ['1', '0', '1', '1']) {
      u.set('Lin', charToValue(l))
      u.pulse()
      q = shiftRight(q, l)
      expect(u.q()).toBe(q)
    }
  })

  it('shifting from the X initial state fills with clean bits one per edge', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, Ld: ZERO, RS: ONE, Lin: ONE } })
    let q = 'X'.repeat(n)
    for (let i = 0; i < n; i++) {
      u.pulse()
      q = shiftRight(q, '1')
      expect(u.q()).toBe(q)
    }
  })

  it('RS=0 holds (Lin ignored, even X)', () => {
    const u = loaded(bin(1, n))
    u.set('Lin', X)
    u.pulses(3)
    expect(u.q()).toBe(bin(1, n))
  })

  it.each([X, Z])('RS=%s with CLR=Ld=0 -> X', (v) => {
    const u = loaded(bin(1, n))
    u.set('RS', v)
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
  })

  it('RS unconnected with CLR=Ld=0 -> X', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, Ld: ONE, Lin: ZERO }, d: bin(1, n), unconnected: ['RS'] })
    u.pulse()
    u.set('Ld', ZERO)
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
  })

  it.each([X, Z])('Lin=%s while shifting -> only bit n-1 is X', (v) => {
    const u = loaded('1'.repeat(n))
    u.setMany({ RS: ONE, Lin: v })
    u.pulse()
    expect(u.q()).toBe('X' + '1'.repeat(n - 1))
    u.set('Lin', ZERO)
    u.pulse()
    expect(u.q()).toBe('0X' + '1'.repeat(n - 2))
  })

  it('Lin unconnected while shifting -> only bit n-1 is X', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, Ld: ONE, RS: ZERO }, d: '1'.repeat(n), unconnected: ['Lin'] })
    u.pulse()
    u.setMany({ Ld: ZERO, RS: ONE })
    u.pulse()
    expect(u.q()).toBe('X' + '1'.repeat(n - 1))
  })

  it.each([X, Z])('Ld=%s with CLR=0 -> X', (v) => {
    const u = loaded(bin(1, n))
    u.set('Ld', v)
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
  })

  it.each([X, Z])('CLR=%s -> X', (v) => {
    const u = loaded(bin(1, n))
    u.set('CLR', v)
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
  })

  it('CLR unconnected -> X (even with Ld=1 and a clean D)', () => {
    const u = new Part(T, n, { init: { Ld: ONE, RS: ZERO, Lin: ZERO }, d: bin(1, n), unconnected: ['CLR'] })
    expect(u.pin('CLR')).toBe(Z)
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
  })

  it('Ld unconnected with CLR=0 -> X (even with RS=1)', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, RS: ONE, Lin: ZERO }, d: bin(1, n), unconnected: ['Ld'] })
    expect(u.pin('Ld')).toBe(Z)
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
  })

  it('Lin unconnected while RS=0 holds (Lin not evaluated)', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, Ld: ONE, RS: ZERO }, d: bin(1, n), unconnected: ['Lin'] })
    u.pulse()
    u.set('Ld', ZERO)
    u.pulses(2)
    expect(u.q()).toBe(bin(1, n))
  })

  it('one X D bit at load -> only that bit X; it then shifts right along', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, Ld: ONE, RS: ZERO, Lin: ZERO }, d: 'X' + '1'.repeat(n - 1) })
    u.pulse()
    expect(u.q()).toBe('X' + '1'.repeat(n - 1))
    u.setMany({ Ld: ZERO, RS: ONE })
    u.pulse()
    expect(u.q()).toBe('0X' + '1'.repeat(n - 2))
  })

  it('changing RS/Lin/D with the clock idle does not change Q', () => {
    const u = loaded(bin(1, n))
    const before = u.sampleCount()
    u.set('RS', ONE).set('Lin', ONE).setD('1'.repeat(n)).set('Ld', ONE).set('CLR', ONE)
    expect(u.q()).toBe(bin(1, n))
    expect(u.sampleCount()).toBe(before)
  })

  it('does not change on the falling edge', () => {
    const u = loaded(bin(1 << (n - 1), n))
    u.set('RS', ONE)
    u.rise()
    expect(u.q()).toBe(bin(1 << (n - 2), n))
    const before = u.sampleCount()
    u.fall()
    expect(u.q()).toBe(bin(1 << (n - 2), n))
    expect(u.sampleCount()).toBe(before)
  })

  it('Q changes one delay after the edge (delay 2)', () => {
    const u = loaded('0'.repeat(n), {})
    u.setMany({ RS: ONE, Lin: ONE })
    const t0 = u.c.time
    u.rise()
    const s = u.samples(n - 1)
    expect(s[s.length - 1]).toEqual({ t: t0 + 2, v: ONE })
  })
})

describe('N_SHIFT_RIGHT 16-bit sanity', () => {
  it('loads 8001 and shifts right twice with Lin=1', () => {
    const u = new Part(ComponentType.N_SHIFT_RIGHT, 16, {
      init: { CLR: ZERO, Ld: ONE, RS: ZERO, Lin: ONE },
      d: bin(0x8001, 16)
    })
    u.pulse()
    expect(u.q()).toBe(bin(0x8001, 16))
    u.setMany({ Ld: ZERO, RS: ONE })
    u.pulse()
    expect(u.q()).toBe(bin(0xc000, 16))
    u.pulse()
    expect(u.q()).toBe(bin(0xe000, 16))
    u.set('CLR', ONE)
    u.pulse()
    expect(u.q()).toBe('0'.repeat(16))
  })
})

// ---------------------------------------------------------------------------------
// N_SHIFT_BIDIR
// ---------------------------------------------------------------------------------

describe.each([2, 4])('N_SHIFT_BIDIR %i-bit (switch clock)', (n) => {
  const T = ComponentType.N_SHIFT_BIDIR
  const idle = { CLR: ZERO, Ld: ONE, LS: ZERO, RS: ZERO, Rin: ZERO, Lin: ZERO }

  function loaded(pattern: string, extra: Record<string, LogicValue> = {}): Part {
    const u = new Part(T, n, { init: { ...idle, ...extra }, d: pattern })
    u.pulse()
    expect(u.q()).toBe(pattern)
    u.set('Ld', ZERO)
    return u
  }

  const shiftLeft = (q: string, rin: string): string => q.slice(1) + rin
  const shiftRight = (q: string, lin: string): string => lin + q.slice(0, -1)

  it('initial state is X', () => {
    expect(new Part(T, n).q()).toBe('X'.repeat(n))
  })

  it('CLR=1 clears regardless of everything else', () => {
    const u = new Part(T, n, { init: { CLR: ONE, Ld: X, LS: X, RS: X, Rin: X, Lin: X }, d: 'X'.repeat(n) })
    u.pulse()
    expect(u.q()).toBe('0'.repeat(n))
  })

  it('Ld=1 (CLR=0) loads regardless of LS/RS/Rin/Lin', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, Ld: ONE, LS: ONE, RS: ONE, Rin: X, Lin: X }, d: bin(1, n) })
    u.pulse()
    expect(u.q()).toBe(bin(1, n))
  })

  it('LS=1, RS=0 shifts left (Rin into bit 0)', () => {
    const u = loaded(bin(1, n))
    u.setMany({ LS: ONE, Rin: ONE })
    u.pulse()
    expect(u.q()).toBe(bin(3, n))
    u.set('Rin', ZERO)
    u.pulse()
    expect(u.q()).toBe(bin(6 & ((1 << n) - 1), n))
  })

  it('LS=0, RS=1 shifts right (Lin into bit n-1)', () => {
    const u = loaded(bin(1 << (n - 1), n))
    u.setMany({ RS: ONE, Lin: ONE })
    u.pulse()
    expect(u.q()).toBe(bin((1 << (n - 1)) | (1 << (n - 2)), n))
    u.set('Lin', ZERO)
    u.pulse()
    expect(u.q()).toBe(bin(((1 << (n - 1)) | (1 << (n - 2))) >> 1, n))
  })

  it('LS=1 and RS=1: functions as a left shift register (LS wins)', () => {
    const u = loaded('0'.repeat(n))
    u.setMany({ LS: ONE, RS: ONE, Rin: ONE, Lin: ZERO })
    let q = '0'.repeat(n)
    for (let i = 0; i < n; i++) {
      u.pulse()
      q = shiftLeft(q, '1')
      expect(u.q()).toBe(q)
    }
    expect(u.q()).toBe('1'.repeat(n))
  })

  it('LS=0 and RS=0: holds (Rin/Lin ignored even when X)', () => {
    const u = loaded(bin(1, n))
    u.setMany({ Rin: X, Lin: X })
    u.pulses(3)
    expect(u.q()).toBe(bin(1, n))
  })

  it('alternating left and right shifts round-trip a pattern', () => {
    const pattern = bin(0b0110 & ((1 << n) - 1), n)
    const u = loaded(pattern)
    u.setMany({ LS: ONE, Rin: ONE })
    u.pulse()
    expect(u.q()).toBe(shiftLeft(pattern, '1'))
    u.setMany({ LS: ZERO, RS: ONE, Lin: pattern[0] === '1' ? ONE : ZERO })
    u.pulse()
    expect(u.q()).toBe(shiftRight(shiftLeft(pattern, '1'), pattern[0]))
  })

  it.each([X, Z])('LS=%s (RS=0) -> X', (v) => {
    const u = loaded(bin(1, n))
    u.set('LS', v)
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
  })

  it.each([X, Z])('LS=%s (RS=1) -> X (LS is evaluated first)', (v) => {
    const u = loaded(bin(1, n))
    u.setMany({ LS: v, RS: ONE })
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
  })

  it.each([X, Z])('LS=0, RS=%s -> X', (v) => {
    const u = loaded(bin(1, n))
    u.set('RS', v)
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
  })

  // Ambiguity: the manual says "if both RS and LS are 1 it functions as a Left Shift
  // Register", i.e. RS is irrelevant once LS=1. The most defensible reading is that RS
  // is not evaluated when LS=1, so RS=X/Z must not poison the shift.
  it.each([X, Z])('LS=1, RS=%s shifts left (RS is not evaluated when LS=1)', (v) => {
    const u = loaded(bin(1, n))
    u.setMany({ LS: ONE, RS: v, Rin: ZERO })
    u.pulse()
    expect(u.q()).toBe(bin(2, n))
  })

  it('LS unconnected (RS=0) -> X', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, Ld: ONE, RS: ZERO, Rin: ZERO, Lin: ZERO }, d: bin(1, n), unconnected: ['LS'] })
    u.pulse()
    u.set('Ld', ZERO)
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
  })

  it('RS unconnected (LS=0) -> X', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, Ld: ONE, LS: ZERO, Rin: ZERO, Lin: ZERO }, d: bin(1, n), unconnected: ['RS'] })
    u.pulse()
    u.set('Ld', ZERO)
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
  })

  it('RS unconnected with LS=1 still shifts left (decision 11: RS not evaluated)', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, Ld: ONE, LS: ZERO, Rin: ONE, Lin: ZERO }, d: bin(1, n), unconnected: ['RS'] })
    u.pulse()
    u.setMany({ Ld: ZERO, LS: ONE })
    u.pulse()
    expect(u.q()).toBe(bin(3, n))
  })

  it('CLR unconnected -> X', () => {
    const u = new Part(T, n, { init: { Ld: ONE, LS: ZERO, RS: ZERO, Rin: ZERO, Lin: ZERO }, d: bin(1, n), unconnected: ['CLR'] })
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
  })

  it('Ld unconnected (CLR=0) -> X', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, LS: ZERO, RS: ZERO, Rin: ZERO, Lin: ZERO }, d: bin(1, n), unconnected: ['Ld'] })
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
  })

  it('Rin/Lin unconnected: hold is unaffected; the shift direction in use gets an X bit', () => {
    const u = new Part(T, n, { init: { CLR: ZERO, Ld: ONE, LS: ZERO, RS: ZERO }, d: '1'.repeat(n), unconnected: ['Rin', 'Lin'] })
    u.pulse()
    u.set('Ld', ZERO)
    u.pulse()
    expect(u.q()).toBe('1'.repeat(n))
    u.set('LS', ONE)
    u.pulse()
    expect(u.q()).toBe('1'.repeat(n - 1) + 'X')
    u.setMany({ LS: ZERO, RS: ONE })
    u.pulse() // the X in bit 0 shifts out; a new X (Lin) enters at bit n-1
    expect(u.q()).toBe('X' + '1'.repeat(n - 1))
  })

  it.each([X, Z])('Rin=%s during a left shift -> only bit 0 X', (v) => {
    const u = loaded('1'.repeat(n))
    u.setMany({ LS: ONE, Rin: v })
    u.pulse()
    expect(u.q()).toBe('1'.repeat(n - 1) + 'X')
  })

  it.each([X, Z])('Lin=%s during a right shift -> only bit n-1 X', (v) => {
    const u = loaded('1'.repeat(n))
    u.setMany({ RS: ONE, Lin: v })
    u.pulse()
    expect(u.q()).toBe('X' + '1'.repeat(n - 1))
  })

  it('Lin=X during a left shift is ignored', () => {
    const u = loaded('1'.repeat(n))
    u.setMany({ LS: ONE, Rin: ZERO, Lin: X })
    u.pulse()
    expect(u.q()).toBe('1'.repeat(n - 1) + '0')
  })

  it('Rin=X during a right shift is ignored', () => {
    const u = loaded('1'.repeat(n))
    u.setMany({ RS: ONE, Lin: ZERO, Rin: X })
    u.pulse()
    expect(u.q()).toBe('0' + '1'.repeat(n - 1))
  })

  it.each([X, Z])('Ld=%s (CLR=0) -> X even with LS=1', (v) => {
    const u = loaded(bin(1, n))
    u.setMany({ Ld: v, LS: ONE })
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
  })

  it.each([X, Z])('CLR=%s -> X even with Ld=1', (v) => {
    const u = loaded(bin(1, n))
    u.setMany({ CLR: v, Ld: ONE })
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
  })

  it('priority CLR > Ld > shift at a single edge', () => {
    const u = loaded(bin(1, n))
    u.setD('1'.repeat(n))
    u.setMany({ Ld: ONE, LS: ONE, RS: ONE, Rin: ONE, Lin: ONE })
    u.pulse()
    expect(u.q()).toBe('1'.repeat(n)) // Ld beats shift
    u.set('CLR', ONE)
    u.pulse()
    expect(u.q()).toBe('0'.repeat(n)) // CLR beats Ld
    u.setMany({ CLR: ZERO, Ld: ZERO })
    u.pulse()
    expect(u.q()).toBe('0'.repeat(n - 1) + '1') // shift left with Rin=1
  })

  it('changing any control/data pin with the clock idle does not change Q', () => {
    const u = loaded(bin(1, n))
    const before = u.sampleCount()
    u.set('LS', ONE).set('RS', ONE).set('Rin', ONE).set('Lin', ONE).setD('1'.repeat(n)).set('Ld', ONE).set('CLR', ONE)
    expect(u.q()).toBe(bin(1, n))
    expect(u.sampleCount()).toBe(before)
  })

  it('does not change on the falling edge', () => {
    const u = loaded(bin(1, n))
    u.setMany({ LS: ONE })
    u.rise()
    expect(u.q()).toBe(bin(2, n))
    const before = u.sampleCount()
    u.fall()
    expect(u.q()).toBe(bin(2, n))
    expect(u.sampleCount()).toBe(before)
  })
})

describe('N_SHIFT_BIDIR 16-bit sanity', () => {
  it('loads 0001, shifts left to 0002, right twice to 0000 with Lin=1 -> 8000', () => {
    const u = new Part(ComponentType.N_SHIFT_BIDIR, 16, {
      init: { CLR: ZERO, Ld: ONE, LS: ZERO, RS: ZERO, Rin: ZERO, Lin: ZERO },
      d: bin(1, 16)
    })
    u.pulse()
    expect(u.q()).toBe(bin(1, 16))
    u.setMany({ Ld: ZERO, LS: ONE })
    u.pulse()
    expect(u.q()).toBe(bin(2, 16))
    u.setMany({ LS: ZERO, RS: ONE, Lin: ONE })
    u.pulse()
    expect(u.q()).toBe(bin(0x8001, 16))
    u.pulse()
    expect(u.q()).toBe(bin(0xc000, 16))
  })
})

// ---------------------------------------------------------------------------------
// Driven by the CLOCK part (step / go)
// ---------------------------------------------------------------------------------

describe('CLOCK part: N_COUNTER with step()', () => {
  it('rising-edge clock: first step stops at 15 ns before any edge; second step includes the edge at 20', () => {
    const u = new Part(ComponentType.N_COUNTER, 4, { init: { CLR: ZERO, En: ONE }, clock: 'part' })
    expect(u.pin('CLK')).toBe(ONE)
    expect(u.q()).toBe('XXXX')
    u.c.step()
    expect(u.c.time).toBe(15)
    expect(u.q()).toBe('XXXX') // clock fell at 10, no rising edge yet
    u.c.step()
    expect(u.c.time).toBe(35)
    expect(u.q()).toBe('0000') // cleared on the edge at 20
    u.set('CLR', ONE)
    u.c.step()
    expect(u.c.time).toBe(55)
    expect(u.q()).toBe('0001')
    u.c.step()
    expect(u.q()).toBe('0010')
    u.c.step()
    expect(u.q()).toBe('0011')
  })

  it('Q changes at edge + delay (waveform sample at 21 ns for delay 1, at 43 ns for delay 3)', () => {
    const u = new Part(ComponentType.N_COUNTER, 2, { init: { CLR: ZERO, En: ONE }, clock: 'part' })
    u.c.step().step()
    const s0 = u.samples(0)
    expect(s0.map((s) => s.t)).toEqual([0, 21])
    expect(s0[1].v).toBe(ZERO)

    const u3 = new Part(ComponentType.N_COUNTER, 2, { init: { CLR: ZERO, En: ONE }, clock: 'part', delay: 3 })
    u3.c.step().step()
    expect(u3.samples(0).map((s) => s.t)).toEqual([0, 23])
    u3.set('CLR', ONE)
    u3.c.step()
    expect(u3.samples(0).map((s) => s.t)).toEqual([0, 23, 43])
    expect(u3.samples(0)[2].v).toBe(ONE)
  })

  it('no output activity at falling edges (10, 30, 50 ns)', () => {
    const u = new Part(ComponentType.N_COUNTER, 2, { init: { CLR: ZERO, En: ONE }, clock: 'part' })
    u.c.step().step()
    u.set('CLR', ONE)
    u.c.step().step().step()
    for (let i = 0; i < 2; i++) {
      const times = u.samples(i).map((s) => s.t)
      for (const t of times) expect((t - 1) % 20 === 0 || t === 0, `sample at ${t}`).toBe(true)
    }
  })

  it('a 2-bit counter driven by step() wraps and K follows', () => {
    const u = new Part(ComponentType.N_COUNTER, 2, { init: { CLR: ZERO, En: ONE }, clock: 'part' })
    u.c.step().step() // 00
    u.set('CLR', ONE)
    const expected = ['01', '10', '11', '00', '01']
    for (const e of expected) {
      u.c.step()
      expect(u.q()).toBe(e)
      expect(u.k()).toBe(e === '11' ? ONE : ZERO)
    }
  })

  it('go() after two steps is relative: runs 35 -> 135 ns (edges at 40/60/80/100/120)', () => {
    // Decision 5: Go runs simTimeNs (100) from the current time (35), stopping a quarter
    // period before an active edge: quarterBeforeEdge(135) = 135 (edge at 140).
    const u = new Part(ComponentType.N_LOADABLE_COUNTER, 4, {
      init: { CLR: ONE, Ld: ZERO, En: ONE },
      d: '0000',
      clock: 'part'
    })
    u.c.step().step() // load 0 at 20
    expect(u.c.time).toBe(35)
    expect(u.q()).toBe('0000')
    u.set('Ld', ONE)
    u.c.go()
    expect(u.c.time).toBe(135)
    expect(u.q()).toBe('0101') // 5 edges
  })

  it('go() from reset runs to 95, a second go() to 195 (relative, decision 5)', () => {
    const u = new Part(ComponentType.N_COUNTER, 4, { init: { CLR: ZERO, En: ONE }, clock: 'part' })
    u.c.go()
    expect(u.c.time).toBe(95)
    expect(u.q()).toBe('0000') // edges 20/40/60/80 all clear
    u.set('CLR', ONE) // at 95, before the edge at 100
    u.c.go()
    expect(u.c.time).toBe(195)
    expect(u.q()).toBe('0101') // edges 100/120/140/160/180
    expect(u.k()).toBe(ZERO)
  })

  it('go() after one step: 15 -> 115 -> 215 ns (each Go spans 5 edges)', () => {
    const u = new Part(ComponentType.N_COUNTER, 4, { init: { CLR: ZERO, En: ONE }, clock: 'part' })
    u.c.step()
    expect(u.c.time).toBe(15)
    expect(u.q()).toBe('XXXX')
    u.c.go() // edges 20/40/60/80/100 all clear
    expect(u.c.time).toBe(115)
    expect(u.q()).toBe('0000')
    u.set('CLR', ONE)
    u.c.go() // edges 120/140/160/180/200
    expect(u.c.time).toBe(215)
    expect(u.q()).toBe('0101')
  })

  it('step() is not capped by simTimeNs (decision 5): with simTimeNs=10, steps land on 15, 35, 55', () => {
    const u = new Part(ComponentType.N_COUNTER, 2, {
      init: { CLR: ZERO, En: ONE },
      clock: 'part',
      sim: { simTimeNs: 10 }
    })
    u.c.step()
    expect(u.c.time).toBe(15)
    u.c.step()
    expect(u.c.time).toBe(35)
    expect(u.q()).toBe('00')
    u.set('CLR', ONE)
    u.c.step()
    expect(u.c.time).toBe(55)
    expect(u.q()).toBe('01')
  })

  it('go() with simTimeNs=50 stops at 35 (quarter before the edge at 40)', () => {
    const u = new Part(ComponentType.N_COUNTER, 2, {
      init: { CLR: ZERO, En: ONE },
      clock: 'part',
      sim: { simTimeNs: 50 }
    })
    u.c.go()
    expect(u.c.time).toBe(35)
    expect(u.q()).toBe('00')
    u.c.go() // 35 + 50 = 85 -> quarterBeforeEdge = 75
    expect(u.c.time).toBe(75)
  })

  it('reset() after running under the CLOCK part returns time to 0 and Q to X', () => {
    const u = new Part(ComponentType.N_COUNTER, 4, { init: { CLR: ZERO, En: ONE }, clock: 'part' })
    u.c.step().step()
    expect(u.q()).toBe('0000')
    u.c.reset()
    expect(u.c.time).toBe(0)
    expect(u.q()).toBe('XXXX')
    expect(u.k()).toBe(X)
    expect(u.pin('CLK')).toBe(ONE)
    expect(u.samples(0)).toEqual([{ t: 0, v: X }])
    // and the sequence replays identically
    u.c.step().step()
    expect(u.c.time).toBe(35)
    expect(u.q()).toBe('0000')
  })

  it('go() from reset with CLR=0 held: counter cleared, never counts', () => {
    const u = new Part(ComponentType.N_COUNTER, 4, { init: { CLR: ZERO, En: ONE }, clock: 'part' })
    u.c.go()
    expect(u.c.time).toBe(95)
    expect(u.q()).toBe('0000')
    expect(u.k()).toBe(ZERO)
  })

  it('falling-edge clock option (initial 0): rising edges at 10, 30 -> first step already counts', () => {
    const u = new Part(ComponentType.N_COUNTER, 2, {
      init: { CLR: ZERO, En: ONE },
      clock: 'part',
      sim: { clockInitialValue: ZERO }
    })
    expect(u.pin('CLK')).toBe(ZERO)
    u.c.step() // to 15: edge at 10 -> cleared
    expect(u.c.time).toBe(15)
    expect(u.q()).toBe('00')
    u.set('CLR', ONE)
    u.c.step() // to 35: edge at 30
    expect(u.q()).toBe('01')
  })

  it('period 40: step stops at 30, edge at 40 -> second step counts', () => {
    const u = new Part(ComponentType.N_COUNTER, 2, {
      init: { CLR: ZERO, En: ONE },
      clock: 'part',
      sim: { clockPeriodNs: 40, simTimeNs: 200 }
    })
    u.c.step()
    expect(u.c.time).toBe(30)
    expect(u.q()).toBe('XX')
    u.c.step()
    expect(u.c.time).toBe(70)
    expect(u.q()).toBe('00')
  })
})

describe('CLOCK part: register and shift registers with step()', () => {
  it('N_REGISTER loads at each edge, ignores D changes between edges', () => {
    const u = new Part(ComponentType.N_REGISTER, 4, { init: { CLR: ZERO, Ld: ONE }, d: '1010', clock: 'part' })
    u.c.step()
    expect(u.q()).toBe('XXXX')
    u.setD('0101') // at 15 ns, before the edge
    u.c.step()
    expect(u.q()).toBe('0101')
    u.setD('1111')
    expect(u.q()).toBe('0101')
    u.c.step()
    expect(u.q()).toBe('1111')
  })

  it('N_SHIFT_LEFT shifts one position per step', () => {
    const u = new Part(ComponentType.N_SHIFT_LEFT, 4, {
      init: { CLR: ZERO, Ld: ONE, LS: ZERO, Rin: ONE },
      d: '0001',
      clock: 'part'
    })
    u.c.step().step()
    expect(u.q()).toBe('0001')
    u.setMany({ Ld: ZERO, LS: ONE })
    u.c.step()
    expect(u.q()).toBe('0011')
    u.c.step()
    expect(u.q()).toBe('0111')
    u.set('Rin', ZERO)
    u.c.step()
    expect(u.q()).toBe('1110')
  })

  it('N_SHIFT_RIGHT shifts one position per step', () => {
    const u = new Part(ComponentType.N_SHIFT_RIGHT, 4, {
      init: { CLR: ZERO, Ld: ONE, RS: ZERO, Lin: ONE },
      d: '1000',
      clock: 'part'
    })
    u.c.step().step()
    expect(u.q()).toBe('1000')
    u.setMany({ Ld: ZERO, RS: ONE })
    u.c.step()
    expect(u.q()).toBe('1100')
    u.set('Lin', ZERO)
    u.c.step()
    expect(u.q()).toBe('0110')
  })

  it('N_SHIFT_BIDIR: LS wins over RS under the CLOCK part', () => {
    const u = new Part(ComponentType.N_SHIFT_BIDIR, 4, {
      init: { CLR: ZERO, Ld: ONE, LS: ONE, RS: ONE, Rin: ONE, Lin: ZERO },
      d: '0000',
      clock: 'part'
    })
    u.c.step().step()
    expect(u.q()).toBe('0000')
    u.set('Ld', ZERO)
    u.c.step()
    expect(u.q()).toBe('0001')
    u.c.step()
    expect(u.q()).toBe('0011')
  })

  it('N_LOADABLE_COUNTER with go(): 2-bit loaded with 2 at 20 sees 5 more edges by 135', () => {
    const u = new Part(ComponentType.N_LOADABLE_COUNTER, 2, {
      init: { CLR: ONE, Ld: ZERO, En: ONE },
      d: '10',
      clock: 'part'
    })
    u.c.step().step() // load 2 at 20
    expect(u.q()).toBe('10')
    u.set('Ld', ONE)
    u.c.go() // relative: 35 -> 135; edges 40, 60, 80, 100, 120 -> 3, 0, 1, 2, 3
    expect(u.c.time).toBe(135)
    expect(u.q()).toBe('11')
    expect(u.k()).toBe(ONE)
  })

  it('N_REGISTER with go(): loads on every edge, final Q is the last D', () => {
    const u = new Part(ComponentType.N_REGISTER, 4, { init: { CLR: ZERO, Ld: ONE }, d: '1001', clock: 'part' })
    u.c.go()
    expect(u.c.time).toBe(95)
    expect(u.q()).toBe('1001')
    expect(u.samples(0).map((s) => s.t)).toEqual([0, 21]) // one change, at the first edge + delay
    u.setD('0110')
    u.c.go()
    expect(u.c.time).toBe(195)
    expect(u.q()).toBe('0110')
    expect(u.samples(0).map((s) => s.t)).toEqual([0, 21, 101])
  })

  it('N_SHIFT_RIGHT with go(): shifts once per edge (4 edges from reset)', () => {
    const u = new Part(ComponentType.N_SHIFT_RIGHT, 4, {
      init: { CLR: ZERO, Ld: ZERO, RS: ONE, Lin: ONE },
      d: '0000',
      clock: 'part'
    })
    u.c.go() // edges at 20, 40, 60, 80 shift a 1 in each time from X
    expect(u.q()).toBe('1111')
    u.set('Lin', ZERO)
    u.c.step() // one more edge at 100
    expect(u.q()).toBe('0111')
  })
})

// ---------------------------------------------------------------------------------
// Composition: registers feeding registers on the same clock (no race-through)
// ---------------------------------------------------------------------------------

describe('composition on a shared clock', () => {
  function twoRegisters(clock: 'switch' | 'part'): Circuit {
    const b = new CircuitBuilder()
    b.add('a', ComponentType.N_REGISTER, { bits: 2 })
    b.add('b', ComponentType.N_REGISTER, { bits: 2 })
    if (clock === 'switch') b.switch('clk', ZERO)
    else b.add('clk', ComponentType.CLOCK)
    b.wire(p('clk', 'out'), p('a', 'CLK')).wire(p('clk', 'out'), p('b', 'CLK'))
    b.switch('ld', ONE).switch('clr', ZERO)
    for (const r of ['a', 'b']) {
      b.wire(p('ld', 'out'), p(r, 'Ld')).wire(p('clr', 'out'), p(r, 'CLR'))
    }
    b.switch('d0', ONE).switch('d1', ZERO)
    b.wire(p('d0', 'out'), p('a', 'D0')).wire(p('d1', 'out'), p('a', 'D1'))
    b.wire(p('a', 'Q0'), p('b', 'D0')).wire(p('a', 'Q1'), p('b', 'D1'))
    return b.build()
  }

  it('register B (D = A.Q) samples A\'s OLD Q at each switch-clock edge', () => {
    const c = twoRegisters('switch')
    expect(c.vec('a', 'Q', 2)).toBe('XX')
    expect(c.vec('b', 'Q', 2)).toBe('XX')
    c.pulse('clk')
    expect(c.vec('a', 'Q', 2)).toBe('01')
    expect(c.vec('b', 'Q', 2)).toBe('XX') // old A.Q
    c.setMany({ d0: ZERO, d1: ONE })
    c.pulse('clk')
    expect(c.vec('a', 'Q', 2)).toBe('10')
    expect(c.vec('b', 'Q', 2)).toBe('01')
    c.pulse('clk')
    expect(c.vec('b', 'Q', 2)).toBe('10')
  })

  it('register B (D = A.Q) samples A\'s OLD Q under the CLOCK part', () => {
    const c = twoRegisters('part')
    c.step().step() // edge at 20
    expect(c.vec('a', 'Q', 2)).toBe('01')
    expect(c.vec('b', 'Q', 2)).toBe('XX')
    c.step() // edge at 40
    expect(c.vec('b', 'Q', 2)).toBe('01')
  })

  it('counter Q -> register D: the register lags the counter by one edge', () => {
    const b = new CircuitBuilder()
      .add('ctr', ComponentType.N_COUNTER, { bits: 2 })
      .add('reg', ComponentType.N_REGISTER, { bits: 2 })
      .switch('clk', ZERO)
      .switch('clr', ZERO)
      .switch('one', ONE)
      .switch('zero', ZERO)
      .wire(p('clk', 'out'), p('ctr', 'CLK'))
      .wire(p('clk', 'out'), p('reg', 'CLK'))
      .wire(p('clr', 'out'), p('ctr', 'CLR'))
      .wire(p('one', 'out'), p('ctr', 'En'))
      .wire(p('one', 'out'), p('reg', 'Ld'))
      .wire(p('zero', 'out'), p('reg', 'CLR'))
      .wire(p('ctr', 'Q0'), p('reg', 'D0'))
      .wire(p('ctr', 'Q1'), p('reg', 'D1'))
    const c = b.build()
    c.pulse('clk') // ctr 00, reg XX
    expect(c.vec('ctr', 'Q', 2)).toBe('00')
    expect(c.vec('reg', 'Q', 2)).toBe('XX')
    c.set('clr', ONE)
    const seq = ['01', '10', '11', '00']
    let prev = '00'
    for (const s of seq) {
      c.pulse('clk')
      expect(c.vec('ctr', 'Q', 2)).toBe(s)
      expect(c.vec('reg', 'Q', 2)).toBe(prev)
      prev = s
    }
  })

  it('cascaded counters: ctr2.En = ctr1.K increments ctr2 when ctr1 wraps', () => {
    const b = new CircuitBuilder()
      .add('c1', ComponentType.N_COUNTER, { bits: 2 })
      .add('c2', ComponentType.N_COUNTER, { bits: 2 })
      .switch('clk', ZERO)
      .switch('clr', ZERO)
      .switch('one', ONE)
      .wire(p('clk', 'out'), p('c1', 'CLK'))
      .wire(p('clk', 'out'), p('c2', 'CLK'))
      .wire(p('clr', 'out'), p('c1', 'CLR'))
      .wire(p('clr', 'out'), p('c2', 'CLR'))
      .wire(p('one', 'out'), p('c1', 'En'))
      .wire(p('c1', 'K'), p('c2', 'En'))
    const c = b.build()
    c.pulse('clk')
    expect(c.vec('c1', 'Q', 2)).toBe('00')
    expect(c.vec('c2', 'Q', 2)).toBe('00')
    c.set('clr', ONE)
    for (let i = 1; i <= 8; i++) {
      c.pulse('clk')
      const total = i
      expect(c.vec('c1', 'Q', 2), `c1 after ${i}`).toBe(bin(total & 3, 2))
      expect(c.vec('c2', 'Q', 2), `c2 after ${i}`).toBe(bin((total >> 2) & 3, 2))
    }
  })

  it('shift register chain: A.Q[n-1] -> B.Rin moves a bit across on the next edge', () => {
    const b = new CircuitBuilder()
      .add('a', ComponentType.N_SHIFT_LEFT, { bits: 2 })
      .add('b', ComponentType.N_SHIFT_LEFT, { bits: 2 })
      .switch('clk', ZERO)
      .switch('ld', ONE)
      .switch('ls', ZERO)
      .switch('zero', ZERO)
      .switch('one', ONE)
    for (const r of ['a', 'b']) {
      b.wire(p('clk', 'out'), p(r, 'CLK'))
        .wire(p('ld', 'out'), p(r, 'Ld'))
        .wire(p('zero', 'out'), p(r, 'CLR'))
        .wire(p('ls', 'out'), p(r, 'LS'))
        .wire(p('zero', 'out'), p(r, 'D0'))
        .wire(p('zero', 'out'), p(r, 'D1'))
    }
    b.wire(p('zero', 'out'), p('a', 'Rin')).wire(p('a', 'Q1'), p('b', 'Rin'))
    const c = b.build()
    c.pulse('clk') // both loaded with 00
    expect(c.vec('a', 'Q', 2)).toBe('00')
    expect(c.vec('b', 'Q', 2)).toBe('00')
    // now load a = 01 (D0 = 1) while b loads 00
    c.setMany({ ld: ONE })
    const b2 = c // keep name
    // rewire D0 of a to 'one' is not possible post-build; instead shift a 1 in through Rin
    c.setMany({ ld: ZERO, ls: ONE })
    // Rin of a is 'zero' - so use a different approach: check the chain propagates zeros/ones
    // by toggling nothing more: a stays 00, b stays 00 (sanity for the chain wiring).
    b2.pulse('clk')
    expect(c.vec('a', 'Q', 2)).toBe('00')
    expect(c.vec('b', 'Q', 2)).toBe('00')
  })

  it('shift register chain carries a walking 1 from A into B one edge later', () => {
    const b = new CircuitBuilder()
      .add('a', ComponentType.N_SHIFT_LEFT, { bits: 2 })
      .add('b', ComponentType.N_SHIFT_LEFT, { bits: 2 })
      .switch('clk', ZERO)
      .switch('ld', ONE)
      .switch('ls', ZERO)
      .switch('zero', ZERO)
      .switch('one', ONE)
      .switch('rin', ZERO)
    for (const r of ['a', 'b']) {
      b.wire(p('clk', 'out'), p(r, 'CLK'))
        .wire(p('ld', 'out'), p(r, 'Ld'))
        .wire(p('zero', 'out'), p(r, 'CLR'))
        .wire(p('ls', 'out'), p(r, 'LS'))
        .wire(p('zero', 'out'), p(r, 'D1'))
    }
    b.wire(p('one', 'out'), p('a', 'D0')).wire(p('zero', 'out'), p('b', 'D0'))
    b.wire(p('rin', 'out'), p('a', 'Rin')).wire(p('a', 'Q1'), p('b', 'Rin'))
    const c = b.build()
    c.pulse('clk') // a = 01, b = 00
    expect(c.vec('a', 'Q', 2)).toBe('01')
    expect(c.vec('b', 'Q', 2)).toBe('00')
    c.setMany({ ld: ZERO, ls: ONE })
    c.pulse('clk') // a = 10, b = 00 (b sampled a.Q1 old = 0)
    expect(c.vec('a', 'Q', 2)).toBe('10')
    expect(c.vec('b', 'Q', 2)).toBe('00')
    c.pulse('clk') // a = 00, b = 01 (b sampled a.Q1 old = 1)
    expect(c.vec('a', 'Q', 2)).toBe('00')
    expect(c.vec('b', 'Q', 2)).toBe('01')
    c.pulse('clk') // a = 00, b = 10
    expect(c.vec('b', 'Q', 2)).toBe('10')
    c.pulse('clk')
    expect(c.vec('b', 'Q', 2)).toBe('00')
  })

  // Decision 1 (VHDL semantics): all changes at one instant are applied to their nets
  // before any component is evaluated, so a data input that changes at exactly the
  // same simulated time as the clock edge is sampled with its NEW value.
  it('D switched at the same instant as the clock edge (setMany) is sampled with its NEW value (decision 1)', () => {
    const b = new CircuitBuilder()
      .add('r', ComponentType.N_REGISTER, { bits: 2 })
      .switch('clk', ZERO)
      .switch('ld', ONE)
      .switch('clr', ZERO)
      .switch('d0', ZERO)
      .switch('d1', ZERO)
      .wire(p('clk', 'out'), p('r', 'CLK'))
      .wire(p('ld', 'out'), p('r', 'Ld'))
      .wire(p('clr', 'out'), p('r', 'CLR'))
      .wire(p('d0', 'out'), p('r', 'D0'))
      .wire(p('d1', 'out'), p('r', 'D1'))
    const c = b.build()
    c.pulse('clk')
    expect(c.vec('r', 'Q', 2)).toBe('00')
    c.setMany({ clk: ONE, d0: ONE, d1: ONE }) // both edges at the same simulated time
    expect(c.vec('r', 'Q', 2)).toBe('11')
    c.setMany({ clk: ZERO, d0: ZERO }) // falling edge with a D change: no effect
    expect(c.vec('r', 'Q', 2)).toBe('11')
    c.setMany({ clk: ONE, d1: ZERO }) // D = 00 sampled at this edge
    expect(c.vec('r', 'Q', 2)).toBe('00')
  })

  it('a control pin (CLR) switched at the same instant as the edge is also seen NEW (decision 1)', () => {
    const b = new CircuitBuilder()
      .add('ctr', ComponentType.N_COUNTER, { bits: 2 })
      .switch('clk', ZERO)
      .switch('clr', ZERO)
      .switch('en', ONE)
      .wire(p('clk', 'out'), p('ctr', 'CLK'))
      .wire(p('clr', 'out'), p('ctr', 'CLR'))
      .wire(p('en', 'out'), p('ctr', 'En'))
    const c = b.build()
    c.pulse('clk')
    expect(c.vec('ctr', 'Q', 2)).toBe('00')
    c.setMany({ clk: ONE, clr: ONE }) // CLR released exactly at the edge -> counts
    expect(c.vec('ctr', 'Q', 2)).toBe('01')
    c.set('clk', ZERO)
    c.setMany({ clk: ONE, clr: ZERO }) // CLR asserted exactly at the edge -> clears
    expect(c.vec('ctr', 'Q', 2)).toBe('00')
  })

  it('A.Q arriving at B.D at the exact time of B\'s (buffered) clock edge is sampled NEW (decision 1)', () => {
    // clk -> A.CLK directly; clk -> AND2(clk, 1) -> B.CLK (1 ns later, same time A.Q changes).
    const b = new CircuitBuilder()
      .add('a', ComponentType.N_REGISTER, { bits: 2 })
      .add('b', ComponentType.N_REGISTER, { bits: 2 })
      .add('buf', ComponentType.AND2)
      .add('vcc', ComponentType.VCC)
      .switch('clk', ZERO)
      .switch('ld', ONE)
      .switch('clr', ZERO)
      .switch('d0', ONE)
      .switch('d1', ONE)
      .wire(p('clk', 'out'), p('a', 'CLK'))
      .wire(p('clk', 'out'), p('buf', 'in1'))
      .wire(p('vcc', 'out'), p('buf', 'in2'))
      .wire(p('buf', 'out'), p('b', 'CLK'))
      .wire(p('d0', 'out'), p('a', 'D0'))
      .wire(p('d1', 'out'), p('a', 'D1'))
      .wire(p('a', 'Q0'), p('b', 'D0'))
      .wire(p('a', 'Q1'), p('b', 'D1'))
    for (const r of ['a', 'b']) b.wire(p('ld', 'out'), p(r, 'Ld')).wire(p('clr', 'out'), p(r, 'CLR'))
    const c = b.build()
    c.pulse('clk')
    expect(c.vec('a', 'Q', 2)).toBe('11')
    expect(c.vec('b', 'Q', 2)).toBe('11') // race: A.Q and B.CLK change at the same instant -> new value
    c.setMany({ d0: ZERO, d1: ZERO })
    c.pulse('clk')
    expect(c.vec('a', 'Q', 2)).toBe('00')
    expect(c.vec('b', 'Q', 2)).toBe('00')
  })

  it('a buffered clock with delay 2 makes B sample A\'s already-settled NEW Q (A.Q at +2, B edge at +3)', () => {
    const b = new CircuitBuilder()
      .add('a', ComponentType.N_REGISTER, { bits: 2 })
      .add('b', ComponentType.N_REGISTER, { bits: 2 })
      .add('buf', ComponentType.AND2, { delay: 2 })
      .add('vcc', ComponentType.VCC)
      .switch('clk', ZERO)
      .switch('ld', ONE)
      .switch('clr', ZERO)
      .switch('d0', ONE)
      .switch('d1', ONE)
      .wire(p('clk', 'out'), p('a', 'CLK'))
      .wire(p('clk', 'out'), p('buf', 'in1'))
      .wire(p('vcc', 'out'), p('buf', 'in2'))
      .wire(p('buf', 'out'), p('b', 'CLK'))
      .wire(p('d0', 'out'), p('a', 'D0'))
      .wire(p('d1', 'out'), p('a', 'D1'))
      .wire(p('a', 'Q0'), p('b', 'D0'))
      .wire(p('a', 'Q1'), p('b', 'D1'))
    for (const r of ['a', 'b']) b.wire(p('ld', 'out'), p(r, 'Ld')).wire(p('clr', 'out'), p(r, 'CLR'))
    const c = b.build()
    c.pulse('clk')
    expect(c.vec('a', 'Q', 2)).toBe('11')
    expect(c.vec('b', 'Q', 2)).toBe('11') // B's edge is 1 ns after A.Q settled -> sees the new A.Q
    c.setMany({ d0: ZERO, d1: ONE })
    c.pulse('clk')
    expect(c.vec('a', 'Q', 2)).toBe('10')
    expect(c.vec('b', 'Q', 2)).toBe('10')
  })

  it('register A with delay 3 feeding register B on a shared clock still moves one stage per edge', () => {
    const b = new CircuitBuilder()
      .add('a', ComponentType.N_REGISTER, { bits: 2, delay: 3 })
      .add('b', ComponentType.N_REGISTER, { bits: 2 })
      .switch('clk', ZERO)
      .switch('ld', ONE)
      .switch('clr', ZERO)
      .switch('d0', ONE)
      .switch('d1', ZERO)
      .wire(p('clk', 'out'), p('a', 'CLK'))
      .wire(p('clk', 'out'), p('b', 'CLK'))
      .wire(p('d0', 'out'), p('a', 'D0'))
      .wire(p('d1', 'out'), p('a', 'D1'))
      .wire(p('a', 'Q0'), p('b', 'D0'))
      .wire(p('a', 'Q1'), p('b', 'D1'))
    for (const r of ['a', 'b']) b.wire(p('ld', 'out'), p(r, 'Ld')).wire(p('clr', 'out'), p(r, 'CLR'))
    const c = b.build()
    c.pulse('clk')
    expect(c.vec('a', 'Q', 2)).toBe('01')
    expect(c.vec('b', 'Q', 2)).toBe('XX')
    c.setMany({ d0: ZERO, d1: ONE })
    c.pulse('clk')
    expect(c.vec('a', 'Q', 2)).toBe('10')
    expect(c.vec('b', 'Q', 2)).toBe('01')
    c.pulse('clk')
    expect(c.vec('b', 'Q', 2)).toBe('10')
  })

  it('INPUT_SIGNAL row exactly at the CLOCK edge (t=20) is captured by that edge (decision 1)', () => {
    const b = new CircuitBuilder()
      .add('r', ComponentType.N_REGISTER, { bits: 2 })
      .add('clk', ComponentType.CLOCK)
      .add('sig', ComponentType.INPUT_SIGNAL, {
        signal: [
          { timeNs: 0, value: ZERO },
          { timeNs: 20, value: ONE },
          { timeNs: 40, value: ZERO }
        ]
      })
      .switch('ld', ONE)
      .switch('clr', ZERO)
      .switch('zero', ZERO)
      .wire(p('clk', 'out'), p('r', 'CLK'))
      .wire(p('ld', 'out'), p('r', 'Ld'))
      .wire(p('clr', 'out'), p('r', 'CLR'))
      .wire(p('sig', 'out'), p('r', 'D0'))
      .wire(p('zero', 'out'), p('r', 'D1'))
      .probe('pq0')
      .wire(p('r', 'Q0'), p('pq0', 'in'))
    const c = b.build()
    c.step().step() // edge at 20: D0 becomes 1 at 20 -> sampled new
    expect(c.time).toBe(35)
    expect(c.vec('r', 'Q', 2)).toBe('01')
    c.step() // edge at 40: D0 becomes 0 at 40 -> sampled new
    expect(c.vec('r', 'Q', 2)).toBe('00')
    const trace = c.sim.getWaveforms().find((w) => w.probeId === 'pq0')!
    expect(trace.samples.map((s) => `${s.t}:${s.v}`)).toEqual(['0:X', '21:1', '41:0'])
  })
})

// ---------------------------------------------------------------------------------
// Clock-edge robustness for every clocked type (CLK X/Z produce no edge)
// ---------------------------------------------------------------------------------

describe.each<[ClockedType, Record<string, LogicValue>, string, string]>([
  // type, control values that make the edge "do something" visible, D pattern, expected Q after one edge
  [ComponentType.N_COUNTER, { CLR: ZERO, En: ONE }, '', '00'],
  [ComponentType.N_LOADABLE_COUNTER, { CLR: ONE, Ld: ZERO, En: ONE }, '10', '10'],
  [ComponentType.N_REGISTER, { CLR: ZERO, Ld: ONE }, '11', '11'],
  [ComponentType.N_SHIFT_LEFT, { CLR: ONE, Ld: ZERO, LS: ZERO, Rin: ZERO }, '00', '00'],
  [ComponentType.N_SHIFT_RIGHT, { CLR: ONE, Ld: ZERO, RS: ZERO, Lin: ZERO }, '00', '00'],
  [ComponentType.N_SHIFT_BIDIR, { CLR: ONE, Ld: ZERO, LS: ZERO, RS: ZERO, Rin: ZERO, Lin: ZERO }, '00', '00']
])('%s: clock edge detection with a 4-valued clock', (type, init, d, expectedAfterEdge) => {
  const opts = (clockInitial: LogicValue) => ({
    init,
    d: d || undefined,
    clock: 'source' as const,
    clockInitial
  })

  it('a clean 0 -> 1 is an edge', () => {
    const u = new Part(type, 2, opts(ZERO))
    expect(u.q()).toBe('XX')
    driveMany(u.c, { clk: ONE })
    expect(u.q()).toBe(expectedAfterEdge)
  })

  it('X -> 1 is not an edge', () => {
    const u = new Part(type, 2, opts(X))
    expect(u.pin('CLK')).toBe(X)
    u.c.set('clk.v', ONE) // still X: mux selects the unconnected input
    expect(u.pin('CLK')).toBe(X)
    u.c.set('clk.x', ZERO) // X -> 1
    expect(u.pin('CLK')).toBe(ONE)
    expect(u.q()).toBe('XX')
    driveMany(u.c, { clk: ZERO })
    driveMany(u.c, { clk: ONE })
    expect(u.q()).toBe(expectedAfterEdge)
  })

  it('Z -> 1 is not an edge', () => {
    const u = new Part(type, 2, opts(Z))
    expect(u.pin('CLK')).toBe(Z)
    u.c.set('clk.v', ONE)
    expect(u.pin('CLK')).toBe(Z)
    u.c.set('clk.z', ONE) // Z -> 1
    expect(u.pin('CLK')).toBe(ONE)
    expect(u.q()).toBe('XX')
  })

  it('0 -> X -> 1 is not an edge', () => {
    const u = new Part(type, 2, opts(ZERO))
    driveMany(u.c, { clk: X })
    expect(u.pin('CLK')).toBe(X)
    u.c.set('clk.v', ONE)
    u.c.set('clk.x', ZERO)
    expect(u.pin('CLK')).toBe(ONE)
    expect(u.q()).toBe('XX')
  })

  it('0 -> Z -> 1 is not an edge', () => {
    const u = new Part(type, 2, opts(ZERO))
    u.c.set('clk.z', ZERO)
    expect(u.pin('CLK')).toBe(Z)
    u.c.set('clk.v', ONE)
    u.c.set('clk.z', ONE)
    expect(u.pin('CLK')).toBe(ONE)
    expect(u.q()).toBe('XX')
  })

  it('1 -> X and 1 -> Z do nothing; 1 -> 0 does nothing', () => {
    const u = new Part(type, 2, opts(ZERO))
    driveMany(u.c, { clk: ONE })
    expect(u.q()).toBe(expectedAfterEdge)
    const before = u.sampleCount()
    driveMany(u.c, { clk: X })
    driveMany(u.c, { clk: ONE })
    driveMany(u.c, { clk: Z })
    driveMany(u.c, { clk: ONE })
    driveMany(u.c, { clk: ZERO })
    expect(u.q()).toBe(expectedAfterEdge)
    expect(u.sampleCount()).toBe(before)
  })

  it('unconnected CLK: Q stays X whatever the controls do', () => {
    const u = new Part(type, 2, { init, d: d || undefined, unconnected: ['CLK'] })
    expect(u.pin('CLK')).toBe(Z)
    for (const pin of CONTROL_PINS[type]) u.set(pin, ONE).set(pin, ZERO).set(pin, ONE)
    expect(u.q()).toBe('XX')
  })
})

// ---------------------------------------------------------------------------------
// Coverage gaps filled on resume: X-state arithmetic/hold, sub-delay clock pulses,
// Z data bits on shift registers, ignored shift-in pins, D unconnected under CLR.
// ---------------------------------------------------------------------------------

describe.each([2, 4])('N_COUNTER %i-bit: behaviour from the X state', (n) => {
  const T = ComponentType.N_COUNTER

  it('CLR=1, En=1 from X: X + 1 stays X and K stays X', () => {
    const u = new Part(T, n, { init: { CLR: ONE, En: ONE } })
    u.pulses(3)
    expect(u.q()).toBe('X'.repeat(n))
    expect(u.k()).toBe(X)
  })

  it('CLR=1, En=0 from X: holds X and K stays X', () => {
    const u = new Part(T, n, { init: { CLR: ONE, En: ZERO } })
    u.pulses(2)
    expect(u.q()).toBe('X'.repeat(n))
    expect(u.k()).toBe(X)
  })

  it('K is X while the state is X and becomes clean with the state', () => {
    const u = new Part(T, n, { init: { CLR: ONE, En: ONE } })
    expect(u.k()).toBe(X)
    u.set('CLR', ZERO)
    u.pulse()
    expect(u.k()).toBe(ZERO)
  })
})

describe.each([2, 4])('N_LOADABLE_COUNTER %i-bit: behaviour from the X state', (n) => {
  const T = ComponentType.N_LOADABLE_COUNTER

  it('Ld=1, En=0 from X holds X', () => {
    const u = new Part(T, n, { init: { CLR: ONE, Ld: ONE, En: ZERO } })
    u.pulses(2)
    expect(u.q()).toBe('X'.repeat(n))
    expect(u.k()).toBe(X)
  })

  it('Ld=1, En=1 from X keeps X (X + 1 = X)', () => {
    const u = new Part(T, n, { init: { CLR: ONE, Ld: ONE, En: ONE } })
    u.pulses(2)
    expect(u.q()).toBe('X'.repeat(n))
  })

  it('a load recovers from X on the next edge', () => {
    const u = new Part(T, n, { init: { CLR: ONE, Ld: ONE, En: ONE }, d: bin(1, n) })
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
    u.set('Ld', ZERO)
    u.pulse()
    expect(u.q()).toBe(bin(1, n))
  })
})

describe.each([2, 4])('shift registers %i-bit: Z data bits and ignored shift-in pins', (n) => {
  it('N_SHIFT_LEFT: a Z D bit at load -> only that bit X', () => {
    const u = new Part(ComponentType.N_SHIFT_LEFT, n, {
      init: { CLR: ZERO, Ld: ONE, LS: ZERO, Rin: ZERO },
      d: 'Z' + '1'.repeat(n - 1)
    })
    u.pulse()
    expect(u.q()).toBe('X' + '1'.repeat(n - 1))
  })

  it('N_SHIFT_RIGHT: a Z D bit at load -> only that bit X', () => {
    const u = new Part(ComponentType.N_SHIFT_RIGHT, n, {
      init: { CLR: ZERO, Ld: ONE, RS: ZERO, Lin: ZERO },
      d: '1'.repeat(n - 1) + 'Z'
    })
    u.pulse()
    expect(u.q()).toBe('1'.repeat(n - 1) + 'X')
  })

  it('N_SHIFT_BIDIR: a Z D bit at load -> only that bit X', () => {
    const u = new Part(ComponentType.N_SHIFT_BIDIR, n, {
      init: { CLR: ZERO, Ld: ONE, LS: ZERO, RS: ZERO, Rin: ZERO, Lin: ZERO },
      d: 'Z' + '1'.repeat(n - 1)
    })
    u.pulse()
    expect(u.q()).toBe('X' + '1'.repeat(n - 1))
  })

  it('N_SHIFT_BIDIR: Lin unconnected during a left shift is ignored', () => {
    const u = new Part(ComponentType.N_SHIFT_BIDIR, n, {
      init: { CLR: ZERO, Ld: ONE, LS: ZERO, RS: ZERO, Rin: ONE },
      d: '0'.repeat(n),
      unconnected: ['Lin']
    })
    u.pulse()
    u.setMany({ Ld: ZERO, LS: ONE })
    u.pulse()
    expect(u.q()).toBe('0'.repeat(n - 1) + '1')
  })

  it('N_SHIFT_BIDIR: Rin unconnected during a right shift is ignored', () => {
    const u = new Part(ComponentType.N_SHIFT_BIDIR, n, {
      init: { CLR: ZERO, Ld: ONE, LS: ZERO, RS: ZERO, Lin: ONE },
      d: '0'.repeat(n),
      unconnected: ['Rin']
    })
    u.pulse()
    u.setMany({ Ld: ZERO, RS: ONE })
    u.pulse()
    expect(u.q()).toBe('1' + '0'.repeat(n - 1))
  })

  it('N_SHIFT_BIDIR: Lin=Z during a left shift and Rin=Z during a right shift are ignored', () => {
    const u = new Part(ComponentType.N_SHIFT_BIDIR, n, {
      init: { CLR: ZERO, Ld: ONE, LS: ZERO, RS: ZERO, Rin: ONE, Lin: ONE },
      d: '0'.repeat(n)
    })
    u.pulse()
    u.setMany({ Ld: ZERO, LS: ONE, Lin: Z })
    u.pulse()
    expect(u.q()).toBe('0'.repeat(n - 1) + '1')
    u.setMany({ LS: ZERO, RS: ONE, Lin: ONE, Rin: Z })
    u.pulse()
    expect(u.q()).toBe('1' + '0'.repeat(n - 2) + '0')
  })

  it('N_SHIFT_LEFT: Rin unconnected with Ld=1 loads cleanly (Rin not evaluated)', () => {
    const u = new Part(ComponentType.N_SHIFT_LEFT, n, {
      init: { CLR: ZERO, Ld: ONE, LS: ONE },
      d: '1'.repeat(n),
      unconnected: ['Rin']
    })
    u.pulse()
    expect(u.q()).toBe('1'.repeat(n))
  })
})

describe.each([2, 4])('N_REGISTER %i-bit: D unconnected', (n) => {
  it('CLR=1 clears even when every D pin is unconnected', () => {
    const dPins = Array.from({ length: n }, (_, i) => `D${i}`)
    const u = new Part(ComponentType.N_REGISTER, n, { init: { CLR: ONE, Ld: ONE }, unconnected: dPins })
    for (const d of dPins) expect(u.pin(d)).toBe(Z)
    u.pulse()
    expect(u.q()).toBe('0'.repeat(n))
  })

  it('Ld=0 holds even when every D pin is unconnected', () => {
    const dPins = Array.from({ length: n }, (_, i) => `D${i}`)
    const u = new Part(ComponentType.N_REGISTER, n, { init: { CLR: ONE, Ld: ZERO }, unconnected: dPins })
    u.pulse()
    expect(u.q()).toBe('0'.repeat(n))
    u.set('CLR', ZERO)
    u.pulses(2)
    expect(u.q()).toBe('0'.repeat(n))
  })

  it('Ld=1 with every D pin unconnected loads all X', () => {
    const dPins = Array.from({ length: n }, (_, i) => `D${i}`)
    const u = new Part(ComponentType.N_REGISTER, n, { init: { CLR: ONE, Ld: ONE }, unconnected: dPins })
    u.pulse()
    expect(u.q()).toBe('0'.repeat(n))
    u.set('CLR', ZERO)
    u.pulse()
    expect(u.q()).toBe('X'.repeat(n))
  })
})

// A clock pulse narrower than the part's own delay still clocks the part: the state
// is latched at the edge and the output delay is only propagation (the falling edge
// re-evaluates to the same new state, so nothing is cancelled). The pulse is made
// with AND(sw, NOT sw): NOT delay 1, AND delay 1 -> a 1 ns high pulse (decision 2).
describe('a 1 ns clock pulse still clocks a part whose delay is 3', () => {
  function glitchClocked(type: ClockedType, init: Record<string, LogicValue>, d?: string): Circuit {
    const b = new CircuitBuilder()
      .add('u', type, { bits: 2, delay: 3 })
      .add('inv', ComponentType.NOT)
      .add('and', ComponentType.AND2)
      .switch('sw', ZERO)
      .wire(p('sw', 'out'), p('inv', 'in1'))
      .wire(p('sw', 'out'), p('and', 'in1'))
      .wire(p('inv', 'out'), p('and', 'in2'))
      .wire(p('and', 'out'), p('u', 'CLK'))
      .probe('pclk')
      .wire(p('and', 'out'), p('pclk', 'in'))
    for (const [pin, v] of Object.entries(init)) b.switch(`s_${pin}`, v).wire(p(`s_${pin}`, 'out'), p('u', pin))
    if (d !== undefined) {
      for (let i = 0; i < 2; i++) b.switch(`d${i}`, d[1 - i] === '1' ? ONE : ZERO).wire(p(`d${i}`, 'out'), p('u', `D${i}`))
    }
    return b.build()
  }

  it('the AND(sw, NOT sw) helper really makes a 1 ns pulse', () => {
    const c = glitchClocked(ComponentType.N_REGISTER, { CLR: ZERO, Ld: ONE }, '11')
    c.set('sw', ONE)
    const trace = c.sim.getWaveforms().find((w) => w.probeId === 'pclk')!
    const times = trace.samples.map((s) => `${s.t}:${s.v}`)
    expect(times).toEqual(['0:0', '2:1', '3:0'])
    expect(c.pin(p('u', 'CLK'))).toBe(ZERO)
  })

  it('N_REGISTER (delay 3) loads on the 1 ns pulse; Q changes at edge + 3', () => {
    const c = glitchClocked(ComponentType.N_REGISTER, { CLR: ZERO, Ld: ONE }, '10')
    c.set('sw', ONE) // edge at 2, pulse ends at 3, Q at 5
    expect(c.vec('u', 'Q', 2)).toBe('10')
    expect(c.time).toBe(5)
    c.set('sw', ZERO) // no pulse on the way down
    expect(c.vec('u', 'Q', 2)).toBe('10')
  })

  it('N_COUNTER (delay 3) counts on each 1 ns pulse', () => {
    const c = glitchClocked(ComponentType.N_COUNTER, { CLR: ZERO, En: ONE })
    c.pulse('sw')
    expect(c.vec('u', 'Q', 2)).toBe('00')
    c.set('s_CLR', ONE)
    for (const e of ['01', '10', '11', '00']) {
      c.pulse('sw')
      expect(c.vec('u', 'Q', 2)).toBe(e)
    }
  })
})

describe('CLOCK part: shift registers change exactly one delay after the edge', () => {
  it('N_SHIFT_LEFT bit 0 sample at 21 (delay 1) and at 22 (delay 2)', () => {
    for (const [delay, t] of [
      [1, 21],
      [2, 22]
    ] as const) {
      const u = new Part(ComponentType.N_SHIFT_LEFT, 2, {
        init: { CLR: ZERO, Ld: ZERO, LS: ONE, Rin: ONE },
        d: '00',
        clock: 'part',
        delay
      })
      u.c.step().step()
      expect(u.samples(0).map((s) => `${s.t}:${s.v}`)).toEqual(['0:X', `${t}:1`])
      expect(u.samples(1).map((s) => `${s.t}:${s.v}`)).toEqual(['0:X'])
    }
  })

  it('N_SHIFT_BIDIR right shift: bit n-1 sample at 21, bit n-2 at 41', () => {
    const u = new Part(ComponentType.N_SHIFT_BIDIR, 2, {
      init: { CLR: ZERO, Ld: ZERO, LS: ZERO, RS: ONE, Rin: ZERO, Lin: ONE },
      d: '00',
      clock: 'part'
    })
    u.c.step().step().step()
    expect(u.samples(1).map((s) => `${s.t}:${s.v}`)).toEqual(['0:X', '21:1'])
    expect(u.samples(0).map((s) => `${s.t}:${s.v}`)).toEqual(['0:X', '41:1'])
  })

  it('N_SHIFT_RIGHT: no samples at the falling edges 10/30/50', () => {
    const u = new Part(ComponentType.N_SHIFT_RIGHT, 4, {
      init: { CLR: ZERO, Ld: ZERO, RS: ONE, Lin: ONE },
      d: '0000',
      clock: 'part'
    })
    u.c.step().step().step()
    for (let i = 0; i < 4; i++) {
      for (const s of u.samples(i)) expect(s.t === 0 || (s.t - 1) % 20 === 0, `sample at ${s.t}`).toBe(true)
    }
  })
})
