// Sequential integration: circuits assembled from flip-flops, gates and muxes must
// behave exactly like the equivalent built-in N-bit part (shift registers, counters,
// registers), and clocked structures driven by the CLOCK part must show the manual's
// timing (active edge time + accumulated propagation delay). Also covers the manual's
// §4 accumulator exercise, the shift-and-add multiplier data path of §4 / Fig. 13,
// and decision 1 (a data input changing at the exact instant of an active edge is the
// value that edge samples).
//
// Local helpers (not in harness.ts): a 4-valued source (switch -> MUX_2 -> tristate)
// so any control pin can be driven 0/1/X/Z, `addMux2`/`addAnd` builders, and three
// "rig" classes that wire a built-in clocked part and a discrete equivalent built
// from D flip-flops to the *same* sources so both can be compared after every clock.

import { describe, expect, it } from 'vitest'
import { ComponentType, LogicValue, type PinId } from '../../model/types'
import { CircuitBuilder, Circuit, p } from './harness'

const { ZERO, ONE, X, Z } = LogicValue

// --------------------------------------------------------------------------------
// Small helpers
// --------------------------------------------------------------------------------

const bit = (b: number): LogicValue => (b ? ONE : ZERO)
const bin = (v: number, n: number): string => (v & ((1 << n) - 1)).toString(2).padStart(n, '0')
const range = (n: number): number[] => [...Array(n).keys()]

function charToValue(ch: string): LogicValue {
  if (ch === '0') return ZERO
  if (ch === '1') return ONE
  if (ch === 'X') return X
  if (ch === 'Z') return Z
  throw new Error(`bad logic char ${ch}`)
}

const trace = (c: Circuit, probeId: string): [number, LogicValue][] => {
  const w = c.sim.getWaveforms().find((t) => t.probeId === probeId)
  if (!w) throw new Error(`no probe ${probeId}`)
  return w.samples.map((s) => [s.t, s.v])
}

/** Adds an INPUT_SIGNAL with the given (time, value) rows; returns its output pin. */
function addSignal(b: CircuitBuilder, id: string, rows: [number, LogicValue][]): PinId {
  b.add(id, ComponentType.INPUT_SIGNAL, {
    signal: rows.map(([timeNs, value]) => ({ timeNs, value }))
  })
  return p(id, 'out')
}

/**
 * A source that can be driven to any of the four logic values. `${id}$v` carries the
 * 0/1 level, `${id}$x` selects the mux's unconnected input (X) and `${id}$z` turns the
 * tristate off (Z).
 */
function addSrc(b: CircuitBuilder, id: string, initial: LogicValue = ZERO): PinId {
  b.switch(`${id}$v`, initial === ONE ? ONE : ZERO)
    .switch(`${id}$x`, initial === X ? ONE : ZERO)
    .switch(`${id}$z`, initial === Z ? ZERO : ONE)
    .add(`${id}$m`, ComponentType.MUX_2)
    .add(`${id}$t`, ComponentType.TRISTATE_RIGHT)
    .wire(p(`${id}$v`, 'out'), p(`${id}$m`, 'in0'))
    .wire(p(`${id}$x`, 'out'), p(`${id}$m`, 'A'))
    .wire(p(`${id}$m`, 'Z'), p(`${id}$t`, 'in'))
    .wire(p(`${id}$z`, 'out'), p(`${id}$t`, 'ctl'))
  return p(`${id}$t`, 'out')
}

/**
 * Drives several 4-valued sources. The mux value is moved first (invisible while the
 * tristate is off) and the tristate afterwards, so a source leaving Z reaches its new
 * value in one net transition instead of glitching through the stale mux output — the
 * source must not manufacture clock edges of its own.
 */
function drive(c: Circuit, values: Record<string, LogicValue>): void {
  const data: Record<string, LogicValue> = {}
  const enable: Record<string, LogicValue> = {}
  for (const [id, v] of Object.entries(values)) {
    if (v === Z) {
      enable[`${id}$z`] = ZERO // release the net; leave the mux value alone
    } else {
      data[`${id}$v`] = v === ONE ? ONE : ZERO
      data[`${id}$x`] = v === X ? ONE : ZERO
      enable[`${id}$z`] = ONE
    }
  }
  c.setMany(data)
  c.setMany(enable)
}

/** 2-to-1 mux: A = 0 selects in0, A = 1 selects in1. Returns the output pin. */
function addMux2(b: CircuitBuilder, id: string, sel: PinId, in0: PinId, in1: PinId): PinId {
  b.add(id, ComponentType.MUX_2).wire(sel, p(id, 'A')).wire(in0, p(id, 'in0')).wire(in1, p(id, 'in1'))
  return p(id, 'Z')
}

const AND_GATE: Record<number, ComponentType> = {
  2: ComponentType.AND2,
  3: ComponentType.AND3,
  4: ComponentType.AND4,
  5: ComponentType.AND5
}

function addAnd(b: CircuitBuilder, id: string, inputs: PinId[]): PinId {
  b.add(id, AND_GATE[inputs.length])
  inputs.forEach((src, i) => b.wire(src, p(id, `in${i + 1}`)))
  return p(id, 'out')
}

// --------------------------------------------------------------------------------
// Reference models written straight from Appendix A, used by the fuzz tests so a
// shared mistake in the built-in part and in the discrete equivalent still fails.
// States and D patterns are MSB-first strings of 0/1/X.
// --------------------------------------------------------------------------------

const fixV = (v: LogicValue): string => (v === ZERO ? '0' : v === ONE ? '1' : 'X')
const fixD = (d: string): string => [...d].map((ch) => (ch === '0' || ch === '1' ? ch : 'X')).join('')

function modelShift(
  kind: ShiftKind,
  state: string,
  ctl: Record<string, LogicValue>,
  d: string
): string {
  const n = state.length
  const all = (ch: string): string => ch.repeat(n)
  if (ctl.CLR !== ZERO && ctl.CLR !== ONE) return all('X')
  if (ctl.CLR === ONE) return all('0')
  if (ctl.Ld !== ZERO && ctl.Ld !== ONE) return all('X')
  if (ctl.Ld === ONE) return fixD(d)
  if (kind !== ComponentType.N_SHIFT_RIGHT) {
    if (ctl.LS !== ZERO && ctl.LS !== ONE) return all('X')
    if (ctl.LS === ONE) return state.slice(1) + fixV(ctl.Rin)
  }
  if (kind !== ComponentType.N_SHIFT_LEFT) {
    if (ctl.RS !== ZERO && ctl.RS !== ONE) return all('X')
    if (ctl.RS === ONE) return fixV(ctl.Lin) + state.slice(0, n - 1)
  }
  return state
}

function modelCounter(
  loadable: boolean,
  state: string,
  ctl: Record<string, LogicValue>,
  d: string
): string {
  const n = state.length
  const all = (ch: string): string => ch.repeat(n)
  if (ctl.CLR !== ZERO && ctl.CLR !== ONE) return all('X')
  if (ctl.CLR === ZERO) return all('0')
  if (loadable) {
    if (ctl.Ld !== ZERO && ctl.Ld !== ONE) return all('X')
    if (ctl.Ld === ZERO) return fixD(d)
  }
  if (ctl.En !== ZERO && ctl.En !== ONE) return all('X')
  if (ctl.En === ZERO) return state
  if (state.includes('X')) return all('X')
  return bin(parseInt(state, 2) + 1, n)
}

function modelRegister(state: string, ctl: Record<string, LogicValue>, d: string): string {
  const n = state.length
  if (ctl.CLR !== ZERO && ctl.CLR !== ONE) return 'X'.repeat(n)
  if (ctl.CLR === ONE) return '0'.repeat(n)
  if (ctl.Ld !== ZERO && ctl.Ld !== ONE) return 'X'.repeat(n)
  if (ctl.Ld === ONE) return fixD(d)
  return state
}

/** Deterministic pseudo-random generator so fuzz cases are reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s
  }
}

/** Toggles each switch there and back, asserting the observed state never moves. */
function wiggleAll(c: Circuit, switches: string[], read: () => string): void {
  const before = read()
  for (const s of switches) {
    c.toggle(s)
    expect(read()).toBe(before)
    c.toggle(s)
    expect(read()).toBe(before)
  }
}

// --------------------------------------------------------------------------------
// Rigs: a built-in clocked part and a discrete equivalent on the same sources
// --------------------------------------------------------------------------------

type ShiftKind =
  | ComponentType.N_SHIFT_LEFT
  | ComponentType.N_SHIFT_RIGHT
  | ComponentType.N_SHIFT_BIDIR

const SHIFT_CONTROLS: Record<ShiftKind, string[]> = {
  [ComponentType.N_SHIFT_LEFT]: ['CLR', 'Ld', 'LS', 'Rin'],
  [ComponentType.N_SHIFT_RIGHT]: ['CLR', 'Ld', 'RS', 'Lin'],
  [ComponentType.N_SHIFT_BIDIR]: ['CLR', 'Ld', 'LS', 'RS', 'Rin', 'Lin']
}

/**
 * A built-in shift register `u` and an equivalent D-flip-flop chain f0..f(n-1),
 * both clocked by the switch `clk` and both fed by the same 4-valued sources.
 *
 * Next state per bit, mirroring Appendix A's priority (CLR, then Ld, then LS/RS):
 *   D_i = mux(CLR, mux(Ld, mux(LS/RS, Q_i, shift source), D_i), 0)
 * The mux chain reproduces the part's don't-care semantics exactly: a lower
 * priority control that is X/Z is simply not selected.
 */
class ShiftRig {
  readonly c: Circuit

  constructor(
    readonly kind: ShiftKind,
    readonly n = 4
  ) {
    const b = new CircuitBuilder(`shift-${kind}`)
    b.add('vcc', ComponentType.VCC).add('gnd', ComponentType.GROUND).switch('clk', ZERO)
    b.add('u', kind, { bits: n }).wire(p('clk', 'out'), p('u', 'CLK'))

    const ctl: Record<string, PinId> = {}
    for (const name of SHIFT_CONTROLS[kind]) {
      ctl[name] = addSrc(b, name, ZERO)
      b.wire(ctl[name], p('u', name))
    }
    const dPin: PinId[] = []
    for (let i = 0; i < n; i++) {
      const src = addSrc(b, `D${i}`, ZERO)
      dPin.push(src)
      b.wire(src, p('u', `D${i}`))
    }
    for (let i = 0; i < n; i++) {
      b.add(`f${i}`, ComponentType.D_FLIPFLOP)
        .wire(p('vcc', 'out'), p(`f${i}`, 'S'))
        .wire(p('vcc', 'out'), p(`f${i}`, 'R'))
        .wire(p('clk', 'out'), p(`f${i}`, 'CLK'))
    }
    const q = (i: number): PinId => p(`f${i}`, 'Q')
    for (let i = 0; i < n; i++) {
      let shifted: PinId
      if (kind === ComponentType.N_SHIFT_LEFT) {
        shifted = addMux2(b, `ml${i}`, ctl['LS'], q(i), i === 0 ? ctl['Rin'] : q(i - 1))
      } else if (kind === ComponentType.N_SHIFT_RIGHT) {
        shifted = addMux2(b, `mr${i}`, ctl['RS'], q(i), i === n - 1 ? ctl['Lin'] : q(i + 1))
      } else {
        const right = addMux2(b, `mr${i}`, ctl['RS'], q(i), i === n - 1 ? ctl['Lin'] : q(i + 1))
        shifted = addMux2(b, `ml${i}`, ctl['LS'], right, i === 0 ? ctl['Rin'] : q(i - 1))
      }
      const loaded = addMux2(b, `mld${i}`, ctl['Ld'], shifted, dPin[i])
      const cleared = addMux2(b, `mclr${i}`, ctl['CLR'], loaded, p('gnd', 'out'))
      b.wire(cleared, p(`f${i}`, 'D'))
    }
    this.c = b.build()
  }

  set(name: string, v: LogicValue): this {
    drive(this.c, { [name]: v })
    return this
  }

  setMany(values: Record<string, LogicValue>): this {
    drive(this.c, values)
    return this
  }

  /** Drives the D inputs from an MSB-first pattern of 0/1/X/Z characters. */
  setD(bits: string): this {
    const values: Record<string, LogicValue> = {}
    for (let i = 0; i < this.n; i++) values[`D${i}`] = charToValue(bits[this.n - 1 - i])
    drive(this.c, values)
    return this
  }

  pulse(): this {
    this.c.set('clk', ONE)
    this.c.set('clk', ZERO)
    return this
  }

  /** Q of the built-in part, MSB first. */
  part(): string {
    return this.c.vec('u', 'Q', this.n)
  }

  /** Q of the flip-flop chain, MSB first. */
  ffs(): string {
    let s = ''
    for (let i = this.n - 1; i >= 0; i--) s += this.c.pin(p(`f${i}`, 'Q'))
    return s
  }

  /** Asserts the two implementations agree and returns the common value. */
  agreed(): string {
    const part = this.part()
    expect(this.ffs()).toBe(part)
    return part
  }

  /** Clears both implementations to all zeroes via one CLR = 1 edge. */
  clear(): this {
    this.setMany({ CLR: ONE })
    this.pulse()
    this.setMany({ CLR: ZERO })
    return this
  }
}

/** A built-in counter `u` and a synchronous D-flip-flop equivalent on the same sources. */
class CounterRig {
  readonly c: Circuit

  constructor(
    readonly loadable: boolean,
    readonly n = 4
  ) {
    const b = new CircuitBuilder(`counter-${loadable ? 'ld' : 'plain'}`)
    b.add('vcc', ComponentType.VCC).add('gnd', ComponentType.GROUND).switch('clk', ZERO)
    const type = loadable ? ComponentType.N_LOADABLE_COUNTER : ComponentType.N_COUNTER
    b.add('u', type, { bits: n }).wire(p('clk', 'out'), p('u', 'CLK'))

    const ctl: Record<string, PinId> = {}
    for (const name of loadable ? ['CLR', 'Ld', 'En'] : ['CLR', 'En']) {
      ctl[name] = addSrc(b, name, ZERO)
      b.wire(ctl[name], p('u', name))
    }
    const dPin: PinId[] = []
    if (loadable) {
      for (let i = 0; i < n; i++) {
        const src = addSrc(b, `D${i}`, ZERO)
        dPin.push(src)
        b.wire(src, p('u', `D${i}`))
      }
    }
    for (let i = 0; i < n; i++) {
      b.add(`f${i}`, ComponentType.D_FLIPFLOP)
        .wire(p('vcc', 'out'), p(`f${i}`, 'S'))
        .wire(p('vcc', 'out'), p(`f${i}`, 'R'))
        .wire(p('clk', 'out'), p(`f${i}`, 'CLK'))
    }
    const q = (i: number): PinId => p(`f${i}`, 'Q')
    for (let i = 0; i < n; i++) {
      // Ripple-carry-free toggle term: bit i toggles when every lower bit is 1.
      const carry = i === 0 ? p('vcc', 'out') : i === 1 ? q(0) : addAnd(b, `ca${i}`, range(i).map(q))
      b.add(`inc${i}`, ComponentType.XOR2)
        .wire(q(i), p(`inc${i}`, 'in1'))
        .wire(carry, p(`inc${i}`, 'in2'))
      let d = addMux2(b, `men${i}`, ctl['En'], q(i), p(`inc${i}`, 'out'))
      if (loadable) d = addMux2(b, `mld${i}`, ctl['Ld'], dPin[i], d)
      d = addMux2(b, `mclr${i}`, ctl['CLR'], p('gnd', 'out'), d)
      b.wire(d, p(`f${i}`, 'D'))
    }
    addAnd(b, 'kgate', range(n).map(q))
    this.c = b.build()
  }

  set(name: string, v: LogicValue): this {
    drive(this.c, { [name]: v })
    return this
  }

  setMany(values: Record<string, LogicValue>): this {
    drive(this.c, values)
    return this
  }

  setD(bits: string): this {
    const values: Record<string, LogicValue> = {}
    for (let i = 0; i < this.n; i++) values[`D${i}`] = charToValue(bits[this.n - 1 - i])
    drive(this.c, values)
    return this
  }

  pulse(): this {
    this.c.set('clk', ONE)
    this.c.set('clk', ZERO)
    return this
  }

  part(): string {
    return this.c.vec('u', 'Q', this.n)
  }

  ffs(): string {
    let s = ''
    for (let i = this.n - 1; i >= 0; i--) s += this.c.pin(p(`f${i}`, 'Q'))
    return s
  }

  agreed(): string {
    const part = this.part()
    expect(this.ffs()).toBe(part)
    return part
  }

  k(): LogicValue {
    return this.c.pin(p('u', 'K'))
  }

  kGate(): LogicValue {
    return this.c.pin(p('kgate', 'out'))
  }

  /** CLR = 0 (active low) on one edge zeroes both implementations. */
  clear(): this {
    this.setMany({ CLR: ZERO })
    this.pulse()
    this.setMany({ CLR: ONE })
    return this
  }
}

/** A built-in N_REGISTER and a D-flip-flop + load-enable-mux equivalent. */
class RegisterRig {
  readonly c: Circuit

  constructor(readonly n = 4) {
    const b = new CircuitBuilder('register')
    b.add('vcc', ComponentType.VCC).add('gnd', ComponentType.GROUND).switch('clk', ZERO)
    b.add('u', ComponentType.N_REGISTER, { bits: n }).wire(p('clk', 'out'), p('u', 'CLK'))

    const ctl: Record<string, PinId> = {}
    for (const name of ['CLR', 'Ld']) {
      ctl[name] = addSrc(b, name, ZERO)
      b.wire(ctl[name], p('u', name))
    }
    const dPin: PinId[] = []
    for (let i = 0; i < n; i++) {
      const src = addSrc(b, `D${i}`, ZERO)
      dPin.push(src)
      b.wire(src, p('u', `D${i}`))
    }
    for (let i = 0; i < n; i++) {
      b.add(`f${i}`, ComponentType.D_FLIPFLOP)
        .wire(p('vcc', 'out'), p(`f${i}`, 'S'))
        .wire(p('vcc', 'out'), p(`f${i}`, 'R'))
        .wire(p('clk', 'out'), p(`f${i}`, 'CLK'))
      const loaded = addMux2(b, `mld${i}`, ctl['Ld'], p(`f${i}`, 'Q'), dPin[i])
      const cleared = addMux2(b, `mclr${i}`, ctl['CLR'], loaded, p('gnd', 'out'))
      b.wire(cleared, p(`f${i}`, 'D'))
    }
    this.c = b.build()
  }

  setMany(values: Record<string, LogicValue>): this {
    drive(this.c, values)
    return this
  }

  setD(bits: string): this {
    const values: Record<string, LogicValue> = {}
    for (let i = 0; i < this.n; i++) values[`D${i}`] = charToValue(bits[this.n - 1 - i])
    drive(this.c, values)
    return this
  }

  pulse(): this {
    this.c.set('clk', ONE)
    this.c.set('clk', ZERO)
    return this
  }

  part(): string {
    return this.c.vec('u', 'Q', this.n)
  }

  ffs(): string {
    let s = ''
    for (let i = this.n - 1; i >= 0; i--) s += this.c.pin(p(`f${i}`, 'Q'))
    return s
  }

  agreed(): string {
    const part = this.part()
    expect(this.ffs()).toBe(part)
    return part
  }
}

// ================================================================================
// 0. The local 4-valued source itself (so failures elsewhere are attributable)
// ================================================================================

describe('local 4-valued source', () => {
  function sourceCircuit(initial: LogicValue): Circuit {
    const b = new CircuitBuilder('src')
    const out = addSrc(b, 's', initial)
    b.probe('pr').wire(out, p('pr', 'in'))
    return b.build()
  }

  it.each([ZERO, ONE, X, Z])('starts at %s', (v) => {
    expect(sourceCircuit(v).pin(p('pr', 'in'))).toBe(v)
  })

  const values = [ZERO, ONE, X, Z]
  const pairs: [LogicValue, LogicValue][] = []
  for (const a of values) for (const b of values) if (a !== b) pairs.push([a, b])

  it.each(pairs)('%s -> %s is a single clean net transition (no glitch)', (a, b) => {
    const c = sourceCircuit(a)
    drive(c, { s: b })
    expect(c.pin(p('pr', 'in'))).toBe(b)
    expect(trace(c, 'pr')).toEqual([
      [0, a],
      [c.time, b]
    ])
  })

  it.each(values)('%s -> %s (unchanged) produces no new sample', (v) => {
    const c = sourceCircuit(v)
    drive(c, { s: v })
    expect(trace(c, 'pr')).toEqual([[0, v]])
  })
})

// ================================================================================
// 1. Shift registers
// ================================================================================

describe('4-bit LEFT shift register: D flip-flop chain vs N_SHIFT_LEFT', () => {
  const LEFT = ComponentType.N_SHIFT_LEFT

  it('both implementations power up undetermined', () => {
    const r = new ShiftRig(LEFT)
    expect(r.part()).toBe('XXXX')
    expect(r.ffs()).toBe('XXXX')
  })

  it('CLR = 1 on one edge clears both to 0000', () => {
    const r = new ShiftRig(LEFT)
    r.setMany({ CLR: ONE })
    expect(r.agreed()).toBe('XXXX') // CLR is synchronous
    r.pulse()
    expect(r.agreed()).toBe('0000')
  })

  it('shifts a 24-bit serial pattern in identically (data on Rin enters bit 0)', () => {
    const r = new ShiftRig(LEFT).clear()
    r.setMany({ Ld: ZERO, LS: ONE })
    const pattern = '110100101101000111100101'
    let expected = '0000'
    const partSeq: string[] = []
    const ffSeq: string[] = []
    const wantSeq: string[] = []
    for (const ch of pattern) {
      r.setMany({ Rin: charToValue(ch) })
      r.pulse()
      expected = expected.slice(1) + ch
      partSeq.push(r.part())
      ffSeq.push(r.ffs())
      wantSeq.push(expected)
    }
    expect(partSeq).toEqual(wantSeq)
    expect(ffSeq).toEqual(wantSeq)
  })

  it('Rin = X shifts an X into bit 0 that travels to the MSB (both)', () => {
    const r = new ShiftRig(LEFT).clear()
    r.setMany({ LS: ONE, Rin: X })
    r.pulse()
    expect(r.agreed()).toBe('000X')
    r.setMany({ Rin: ZERO })
    const want = ['00X0', '0X00', 'X000', '0000']
    for (const w of want) {
      r.pulse()
      expect(r.agreed()).toBe(w)
    }
  })

  it('Rin = Z shifts in X (an unconnected serial input is undetermined)', () => {
    const r = new ShiftRig(LEFT).clear()
    r.setMany({ LS: ONE, Rin: Z })
    r.pulse()
    expect(r.agreed()).toBe('000X')
  })

  it.each(range(16))('Ld = 1 loads D = %i on the edge (both)', (v) => {
    const r = new ShiftRig(LEFT).clear()
    r.setMany({ Ld: ONE, LS: ZERO })
    r.setD(bin(v, 4))
    expect(r.agreed()).toBe('0000') // synchronous: nothing yet
    r.pulse()
    expect(r.agreed()).toBe(bin(v, 4))
  })

  it('Ld = 1 beats LS = 1 (loads instead of shifting)', () => {
    const r = new ShiftRig(LEFT).clear()
    r.setMany({ Ld: ONE, LS: ONE, Rin: ONE })
    r.setD('1010')
    r.pulse()
    expect(r.agreed()).toBe('1010')
  })

  it('CLR = 1 beats Ld = 1 and LS = 1 (clears)', () => {
    const r = new ShiftRig(LEFT).clear()
    r.setD('1111')
    r.setMany({ Ld: ONE })
    r.pulse()
    expect(r.agreed()).toBe('1111')
    r.setMany({ CLR: ONE, Ld: ONE, LS: ONE, Rin: ONE })
    r.pulse()
    expect(r.agreed()).toBe('0000')
  })

  it('holds over 6 clocks with CLR = Ld = LS = 0', () => {
    const r = new ShiftRig(LEFT).clear()
    r.setD('1011')
    r.setMany({ Ld: ONE })
    r.pulse()
    r.setMany({ Ld: ZERO, LS: ZERO, Rin: ONE })
    r.setD('0100')
    for (let i = 0; i < 6; i++) {
      r.pulse()
      expect(r.agreed()).toBe('1011')
    }
  })

  it('is fully synchronous: control changes with the clock idle change nothing', () => {
    const r = new ShiftRig(LEFT).clear()
    r.setD('0110')
    r.setMany({ Ld: ONE })
    r.pulse()
    r.setMany({ Ld: ZERO })
    for (const level of [ZERO, ONE]) {
      r.c.set('clk', level)
      const before = r.agreed()
      for (const name of ['CLR', 'Ld', 'LS', 'Rin', 'D0', 'D3']) {
        for (const v of [ONE, ZERO]) {
          r.setMany({ [name]: v })
          expect(r.agreed()).toBe(before)
        }
      }
      r.setMany({ CLR: ZERO, Ld: ZERO, LS: ZERO, Rin: ZERO })
    }
    r.c.set('clk', ZERO)
  })

  it.each([X, Z])('CLR = %s at the edge makes every bit X (both)', (v) => {
    const r = new ShiftRig(LEFT).clear()
    r.setMany({ CLR: v })
    r.pulse()
    expect(r.agreed()).toBe('XXXX')
  })

  it.each([X, Z])('Ld = %s with CLR = 0 makes every bit X (both)', (v) => {
    const r = new ShiftRig(LEFT).clear()
    r.setMany({ Ld: v })
    r.pulse()
    expect(r.agreed()).toBe('XXXX')
  })

  it.each([X, Z])('LS = %s with CLR = Ld = 0 makes every bit X (both)', (v) => {
    const r = new ShiftRig(LEFT).clear()
    r.setMany({ LS: v })
    r.pulse()
    expect(r.agreed()).toBe('XXXX')
  })

  it.each([X, Z])('CLR = 1 clears even when Ld and LS are %s (not consulted)', (v) => {
    const r = new ShiftRig(LEFT).clear()
    r.setD('1111')
    r.setMany({ Ld: ONE })
    r.pulse()
    r.setMany({ CLR: ONE, Ld: v, LS: v, Rin: v })
    r.pulse()
    expect(r.agreed()).toBe('0000')
  })

  it.each([X, Z])('a D bit = %s at load makes only that bit X (both)', (v) => {
    const r = new ShiftRig(LEFT).clear()
    r.setMany({ Ld: ONE })
    r.setD('1111')
    r.pulse()
    expect(r.agreed()).toBe('1111')
    drive(r.c, { D2: v })
    r.pulse()
    expect(r.agreed()).toBe('1X11')
  })

  it('recovers from an all-X state with one CLR = 1 edge', () => {
    const r = new ShiftRig(LEFT)
    r.setMany({ CLR: X })
    r.pulse()
    expect(r.agreed()).toBe('XXXX')
    r.setMany({ CLR: ONE })
    r.pulse()
    expect(r.agreed()).toBe('0000')
  })

  it('part, flip-flop chain and the Appendix A model agree over 200 random steps', () => {
    const r = new ShiftRig(LEFT).clear()
    const rnd = lcg(0x5eed)
    const pick = (): LogicValue => [ZERO, ONE, ZERO, ONE, ZERO, ONE, X, Z][rnd() % 8]
    let model = '0000'
    const parts: string[] = []
    const chains: string[] = []
    const models: string[] = []
    for (let step = 0; step < 200; step++) {
      const ctl = { CLR: pick(), Ld: pick(), LS: pick(), Rin: pick() }
      const d = [...'0123'].map(() => (rnd() % 2 ? '1' : '0')).join('')
      r.setMany(ctl)
      r.setD(d)
      r.pulse()
      model = modelShift(LEFT, model, ctl, d)
      parts.push(r.part())
      chains.push(r.ffs())
      models.push(model)
    }
    expect(parts).toEqual(models)
    expect(chains).toEqual(models)
  })
})

describe('4-bit RIGHT shift register: D flip-flop chain vs N_SHIFT_RIGHT', () => {
  const RIGHT = ComponentType.N_SHIFT_RIGHT

  it('both implementations power up undetermined', () => {
    const r = new ShiftRig(RIGHT)
    expect(r.part()).toBe('XXXX')
    expect(r.ffs()).toBe('XXXX')
  })

  it('shifts a 24-bit serial pattern in identically (data on Lin enters bit 3)', () => {
    const r = new ShiftRig(RIGHT).clear()
    r.setMany({ Ld: ZERO, RS: ONE })
    const pattern = '101100011110100101101001'
    let expected = '0000'
    const partSeq: string[] = []
    const ffSeq: string[] = []
    const wantSeq: string[] = []
    for (const ch of pattern) {
      r.setMany({ Lin: charToValue(ch) })
      r.pulse()
      expected = ch + expected.slice(0, 3)
      partSeq.push(r.part())
      ffSeq.push(r.ffs())
      wantSeq.push(expected)
    }
    expect(partSeq).toEqual(wantSeq)
    expect(ffSeq).toEqual(wantSeq)
  })

  it('Lin = X shifts an X into bit 3 that travels to the LSB (both)', () => {
    const r = new ShiftRig(RIGHT).clear()
    r.setMany({ RS: ONE, Lin: X })
    r.pulse()
    expect(r.agreed()).toBe('X000')
    r.setMany({ Lin: ZERO })
    for (const w of ['0X00', '00X0', '000X', '0000']) {
      r.pulse()
      expect(r.agreed()).toBe(w)
    }
  })

  it('Lin = Z shifts in X', () => {
    const r = new ShiftRig(RIGHT).clear()
    r.setMany({ RS: ONE, Lin: Z })
    r.pulse()
    expect(r.agreed()).toBe('X000')
  })

  it.each(range(16))('Ld = 1 loads D = %i on the edge (both)', (v) => {
    const r = new ShiftRig(RIGHT).clear()
    r.setMany({ Ld: ONE, RS: ZERO })
    r.setD(bin(v, 4))
    r.pulse()
    expect(r.agreed()).toBe(bin(v, 4))
  })

  it('Ld = 1 beats RS = 1 (loads instead of shifting)', () => {
    const r = new ShiftRig(RIGHT).clear()
    r.setMany({ Ld: ONE, RS: ONE, Lin: ONE })
    r.setD('0101')
    r.pulse()
    expect(r.agreed()).toBe('0101')
  })

  it('CLR = 1 beats Ld = 1 and RS = 1 (clears)', () => {
    const r = new ShiftRig(RIGHT).clear()
    r.setD('1111')
    r.setMany({ Ld: ONE })
    r.pulse()
    expect(r.agreed()).toBe('1111')
    r.setMany({ CLR: ONE, Ld: ONE, RS: ONE, Lin: ONE })
    r.pulse()
    expect(r.agreed()).toBe('0000')
  })

  it('holds over 6 clocks with CLR = Ld = RS = 0', () => {
    const r = new ShiftRig(RIGHT).clear()
    r.setD('1101')
    r.setMany({ Ld: ONE })
    r.pulse()
    r.setMany({ Ld: ZERO, RS: ZERO, Lin: ONE })
    for (let i = 0; i < 6; i++) {
      r.pulse()
      expect(r.agreed()).toBe('1101')
    }
  })

  it('is fully synchronous: control changes with the clock idle change nothing', () => {
    const r = new ShiftRig(RIGHT).clear()
    r.setD('1001')
    r.setMany({ Ld: ONE })
    r.pulse()
    r.setMany({ Ld: ZERO })
    for (const level of [ZERO, ONE]) {
      r.c.set('clk', level)
      const before = r.agreed()
      for (const name of ['CLR', 'Ld', 'RS', 'Lin', 'D1', 'D2']) {
        for (const v of [ONE, ZERO]) {
          r.setMany({ [name]: v })
          expect(r.agreed()).toBe(before)
        }
      }
      r.setMany({ CLR: ZERO, Ld: ZERO, RS: ZERO, Lin: ZERO })
    }
    r.c.set('clk', ZERO)
  })

  it.each([X, Z])('CLR = %s at the edge makes every bit X (both)', (v) => {
    const r = new ShiftRig(RIGHT).clear()
    r.setMany({ CLR: v })
    r.pulse()
    expect(r.agreed()).toBe('XXXX')
  })

  it.each([X, Z])('RS = %s with CLR = Ld = 0 makes every bit X (both)', (v) => {
    const r = new ShiftRig(RIGHT).clear()
    r.setMany({ RS: v })
    r.pulse()
    expect(r.agreed()).toBe('XXXX')
  })

  it('part, flip-flop chain and the Appendix A model agree over 200 random steps', () => {
    const r = new ShiftRig(RIGHT).clear()
    const rnd = lcg(0x1234)
    const pick = (): LogicValue => [ZERO, ONE, ZERO, ONE, ZERO, ONE, X, Z][rnd() % 8]
    let model = '0000'
    const parts: string[] = []
    const chains: string[] = []
    const models: string[] = []
    for (let step = 0; step < 200; step++) {
      const ctl = { CLR: pick(), Ld: pick(), RS: pick(), Lin: pick() }
      const d = [...'0123'].map(() => (rnd() % 2 ? '1' : '0')).join('')
      r.setMany(ctl)
      r.setD(d)
      r.pulse()
      model = modelShift(RIGHT, model, ctl, d)
      parts.push(r.part())
      chains.push(r.ffs())
      models.push(model)
    }
    expect(parts).toEqual(models)
    expect(chains).toEqual(models)
  })
})

describe('4-bit BIDIRECTIONAL shift register vs a mux-fed flip-flop chain', () => {
  const BIDIR = ComponentType.N_SHIFT_BIDIR

  function loaded(pattern: string): ShiftRig {
    const r = new ShiftRig(BIDIR).clear()
    r.setD(pattern)
    r.setMany({ Ld: ONE })
    r.pulse()
    r.setMany({ Ld: ZERO })
    return r
  }

  it('LS = 0, RS = 0 holds', () => {
    const r = loaded('1001')
    r.setMany({ Rin: ONE, Lin: ONE })
    r.pulse()
    expect(r.agreed()).toBe('1001')
  })

  it('LS = 0, RS = 1 shifts right with Lin entering bit 3', () => {
    const r = loaded('1001')
    r.setMany({ RS: ONE, Lin: ONE, Rin: ZERO })
    r.pulse()
    expect(r.agreed()).toBe('1100')
    r.pulse()
    expect(r.agreed()).toBe('1110')
  })

  it('LS = 1, RS = 0 shifts left with Rin entering bit 0', () => {
    const r = loaded('1001')
    r.setMany({ LS: ONE, Rin: ONE, Lin: ZERO })
    r.pulse()
    expect(r.agreed()).toBe('0011')
    r.pulse()
    expect(r.agreed()).toBe('0111')
  })

  it('LS = 1 and RS = 1 together act as a LEFT shift register (manual Appendix A)', () => {
    const r = loaded('1001')
    r.setMany({ LS: ONE, RS: ONE, Rin: ONE, Lin: ZERO })
    r.pulse()
    expect(r.agreed()).toBe('0011')
    r.pulse()
    expect(r.agreed()).toBe('0111')
  })

  it.each([X, Z])('LS = 1 ignores RS = %s entirely (decision 11)', (v) => {
    const r = loaded('1001')
    r.setMany({ LS: ONE, RS: v, Rin: ONE })
    r.pulse()
    expect(r.agreed()).toBe('0011')
  })

  it.each([X, Z])('LS = 1 ignores Lin = %s (only Rin matters when shifting left)', (v) => {
    const r = loaded('1001')
    r.setMany({ LS: ONE, Lin: v, Rin: ZERO })
    r.pulse()
    expect(r.agreed()).toBe('0010')
  })

  it.each([X, Z])('LS = 0 with RS = %s makes every bit X', (v) => {
    const r = loaded('1001')
    r.setMany({ LS: ZERO, RS: v })
    r.pulse()
    expect(r.agreed()).toBe('XXXX')
  })

  it.each([ZERO, ONE, X, Z])('LS = X makes every bit X regardless of RS = %s', (v) => {
    const r = loaded('1001')
    r.setMany({ LS: X, RS: v })
    r.pulse()
    expect(r.agreed()).toBe('XXXX')
  })

  it('Ld = 1 beats both LS and RS', () => {
    const r = loaded('1001')
    r.setD('0110')
    r.setMany({ Ld: ONE, LS: ONE, RS: ONE, Rin: ONE, Lin: ONE })
    r.pulse()
    expect(r.agreed()).toBe('0110')
  })

  it('CLR = 1 beats Ld, LS and RS', () => {
    const r = loaded('1001')
    r.setD('0110')
    r.setMany({ CLR: ONE, Ld: ONE, LS: ONE, RS: ONE, Rin: ONE, Lin: ONE })
    r.pulse()
    expect(r.agreed()).toBe('0000')
  })

  it('shifts left then right back to the original value', () => {
    const r = loaded('0110')
    r.setMany({ LS: ONE, Rin: ZERO })
    r.pulse()
    expect(r.agreed()).toBe('1100')
    r.setMany({ LS: ZERO, RS: ONE, Lin: ZERO })
    r.pulse()
    expect(r.agreed()).toBe('0110')
  })

  it('part, mux-fed chain and the Appendix A model agree over 200 random steps', () => {
    const r = new ShiftRig(BIDIR).clear()
    const rnd = lcg(0xbeef)
    const pick = (): LogicValue => [ZERO, ONE, ZERO, ONE, ZERO, ONE, X, Z][rnd() % 8]
    let model = '0000'
    const parts: string[] = []
    const chains: string[] = []
    const models: string[] = []
    for (let step = 0; step < 200; step++) {
      const ctl = { CLR: pick(), Ld: pick(), LS: pick(), RS: pick(), Rin: pick(), Lin: pick() }
      const d = [...'0123'].map(() => (rnd() % 2 ? '1' : '0')).join('')
      r.setMany(ctl)
      r.setD(d)
      r.pulse()
      model = modelShift(BIDIR, model, ctl, d)
      parts.push(r.part())
      chains.push(r.ffs())
      models.push(model)
    }
    expect(parts).toEqual(models)
    expect(chains).toEqual(models)
  })
})

// ================================================================================
// 2. Counters
// ================================================================================

describe('ripple counters from JK flip-flops vs N_COUNTER', () => {
  /** n JK flip-flops in toggle mode; stage i is clocked by stage i-1's Q (or Q'). */
  function rippleCounter(n: number, fromQ: boolean): Circuit {
    const b = new CircuitBuilder(`ripple-${n}`)
      .switch('clk', ZERO)
      .switch('clr', ONE)
      .add('vcc', ComponentType.VCC)
      .add('ctr', ComponentType.N_COUNTER, { bits: n })
      .wire(p('clk', 'out'), p('ctr', 'CLK'))
      .wire(p('vcc', 'out'), p('ctr', 'En'))
      .wire(p('clr', 'out'), p('ctr', 'CLR'))
    for (let i = 0; i < n; i++) {
      b.add(`j${i}`, ComponentType.JK_FLIPFLOP)
        .wire(p('vcc', 'out'), p(`j${i}`, 'J'))
        .wire(p('vcc', 'out'), p(`j${i}`, 'K'))
        .wire(p('vcc', 'out'), p(`j${i}`, 'S'))
        .wire(p('clr', 'out'), p(`j${i}`, 'R'))
        .wire(i === 0 ? p('clk', 'out') : p(`j${i - 1}`, fromQ ? 'Q' : "Q'"), p(`j${i}`, 'CLK'))
    }
    return b.build()
  }

  const ripple = (c: Circuit, n: number): string => {
    let s = ''
    for (let i = n - 1; i >= 0; i--) s += c.pin(p(`j${i}`, 'Q'))
    return s
  }

  it.each([3, 4])('%i-bit ripple up counter matches N_COUNTER over a full wrap plus extras', (n) => {
    const c = rippleCounter(n, true)
    c.set('clr', ZERO)
    c.pulse('clk')
    c.set('clr', ONE)
    expect(ripple(c, n)).toBe('0'.repeat(n))
    expect(c.vec('ctr', 'Q', n)).toBe('0'.repeat(n))
    const rippleSeq: string[] = []
    const partSeq: string[] = []
    const want: string[] = []
    for (let k = 1; k <= (1 << n) + 5; k++) {
      c.pulse('clk')
      rippleSeq.push(ripple(c, n))
      partSeq.push(c.vec('ctr', 'Q', n))
      want.push(bin(k, n))
    }
    expect(rippleSeq).toEqual(want)
    expect(partSeq).toEqual(want)
  })

  it("3-bit ripple DOWN counter (clocked from Q') counts 7, 6, 5 ... after a clear", () => {
    const c = rippleCounter(3, false)
    c.set('clr', ZERO)
    c.pulse('clk')
    c.set('clr', ONE)
    expect(ripple(c, 3)).toBe('000')
    const seq: string[] = []
    for (let k = 1; k <= 10; k++) {
      c.pulse('clk')
      seq.push(ripple(c, 3))
    }
    expect(seq).toEqual([7, 6, 5, 4, 3, 2, 1, 0, 7, 6].map((v) => bin(v, 3)))
  })

  it('a 4-bit ripple counter reaches the all-ones state exactly once per 16 clocks', () => {
    const c = rippleCounter(4, true)
    c.set('clr', ZERO)
    c.pulse('clk')
    c.set('clr', ONE)
    let allOnes = 0
    for (let k = 1; k <= 32; k++) {
      c.pulse('clk')
      if (ripple(c, 4) === '1111') allOnes++
    }
    expect(allOnes).toBe(2)
  })
})

describe('ripple vs synchronous counter timing under the CLOCK part', () => {
  it('a 3-bit JK ripple counter settles bit i one extra delay after each falling edge', () => {
    const b = new CircuitBuilder('ripple-timing')
      .add('clk', ComponentType.CLOCK)
      .add('vcc', ComponentType.VCC)
    addSignal(b, 'rst', [
      [0, ZERO],
      [5, ONE]
    ])
    for (let i = 0; i < 3; i++) {
      b.add(`j${i}`, ComponentType.JK_FLIPFLOP)
        .wire(p('vcc', 'out'), p(`j${i}`, 'J'))
        .wire(p('vcc', 'out'), p(`j${i}`, 'K'))
        .wire(p('vcc', 'out'), p(`j${i}`, 'S'))
        .wire(p('rst', 'out'), p(`j${i}`, 'R'))
        .wire(i === 0 ? p('clk', 'out') : p(`j${i - 1}`, 'Q'), p(`j${i}`, 'CLK'))
        .probe(`pq${i}`)
        .wire(p(`j${i}`, 'Q'), p(`pq${i}`, 'in'))
    }
    const c = b.setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 200 }).build()
    c.go()
    expect(c.time).toBe(195)
    // JK flip-flops use the FALLING edges, which sit at 10, 30, 50 ... for period 20.
    expect(trace(c, 'pq0')).toEqual([
      [0, ZERO],
      [11, ONE],
      [31, ZERO],
      [51, ONE],
      [71, ZERO],
      [91, ONE],
      [111, ZERO],
      [131, ONE],
      [151, ZERO],
      [171, ONE],
      [191, ZERO]
    ])
    expect(trace(c, 'pq1')).toEqual([
      [0, ZERO],
      [32, ONE],
      [72, ZERO],
      [112, ONE],
      [152, ZERO],
      [192, ONE]
    ])
    expect(trace(c, 'pq2')).toEqual([
      [0, ZERO],
      [73, ONE],
      [153, ZERO]
    ])
  })

  it('a 3-bit N_COUNTER changes every bit exactly one delay after the rising edge', () => {
    const b = new CircuitBuilder('sync-timing')
      .add('clk', ComponentType.CLOCK)
      .add('vcc', ComponentType.VCC)
      .add('ctr', ComponentType.N_COUNTER, { bits: 3 })
      .wire(p('clk', 'out'), p('ctr', 'CLK'))
      .wire(p('vcc', 'out'), p('ctr', 'En'))
    addSignal(b, 'clrsig', [
      [0, ZERO],
      [25, ONE]
    ])
    b.wire(p('clrsig', 'out'), p('ctr', 'CLR'))
    for (let i = 0; i < 3; i++) b.probe(`pq${i}`).wire(p('ctr', `Q${i}`), p(`pq${i}`, 'in'))
    const c = b.setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 200 }).build()
    c.go()
    expect(trace(c, 'pq0')).toEqual([
      [0, X],
      [21, ZERO],
      [41, ONE],
      [61, ZERO],
      [81, ONE],
      [101, ZERO],
      [121, ONE],
      [141, ZERO],
      [161, ONE],
      [181, ZERO]
    ])
    expect(trace(c, 'pq1')).toEqual([
      [0, X],
      [21, ZERO],
      [61, ONE],
      [101, ZERO],
      [141, ONE],
      [181, ZERO]
    ])
    expect(trace(c, 'pq2')).toEqual([
      [0, X],
      [21, ZERO],
      [101, ONE],
      [181, ZERO]
    ])
  })
})

describe('synchronous counter from D flip-flops vs N_COUNTER', () => {
  it.each([2, 3, 4])('%i-bit: two full wraps of counting agree bit for bit', (n) => {
    const r = new CounterRig(false, n).clear()
    r.setMany({ En: ONE })
    const partSeq: string[] = []
    const ffSeq: string[] = []
    const want: string[] = []
    for (let k = 1; k <= 2 * (1 << n) + 3; k++) {
      r.pulse()
      partSeq.push(r.part())
      ffSeq.push(r.ffs())
      want.push(bin(k, n))
    }
    expect(partSeq).toEqual(want)
    expect(ffSeq).toEqual(want)
  })

  it('En = 0 holds the count at the edge (both)', () => {
    const r = new CounterRig(false, 4).clear()
    r.setMany({ En: ONE })
    r.pulse()
    r.pulse()
    expect(r.agreed()).toBe('0010')
    r.setMany({ En: ZERO })
    for (let i = 0; i < 5; i++) {
      r.pulse()
      expect(r.agreed()).toBe('0010')
    }
    r.setMany({ En: ONE })
    r.pulse()
    expect(r.agreed()).toBe('0011')
  })

  it('CLR = 0 clears only at an edge (both)', () => {
    const r = new CounterRig(false, 4).clear()
    r.setMany({ En: ONE })
    for (let i = 0; i < 5; i++) r.pulse()
    expect(r.agreed()).toBe('0101')
    r.setMany({ CLR: ZERO })
    expect(r.agreed()).toBe('0101') // synchronous CLR: no change without an edge
    r.pulse()
    expect(r.agreed()).toBe('0000')
  })

  it('CLR = 0 beats En = 1', () => {
    const r = new CounterRig(false, 4).clear()
    r.setMany({ En: ONE })
    r.pulse()
    r.setMany({ CLR: ZERO, En: ONE })
    r.pulse()
    expect(r.agreed()).toBe('0000')
  })

  it.each([X, Z])('CLR = %s at the edge makes every bit X (both)', (v) => {
    const r = new CounterRig(false, 4).clear()
    r.setMany({ CLR: v })
    r.pulse()
    expect(r.agreed()).toBe('XXXX')
  })

  it.each([X, Z])('En = %s with CLR = 1 makes every bit X (both)', (v) => {
    const r = new CounterRig(false, 4).clear()
    r.setMany({ En: v })
    r.pulse()
    expect(r.agreed()).toBe('XXXX')
  })

  it.each([X, Z])('CLR = 0 clears even when En = %s (En is not consulted)', (v) => {
    const r = new CounterRig(false, 4).clear()
    r.setMany({ En: ONE })
    r.pulse()
    r.setMany({ CLR: ZERO, En: v })
    r.pulse()
    expect(r.agreed()).toBe('0000')
  })

  it('an all-X count stays X while counting and recovers only through CLR', () => {
    const r = new CounterRig(false, 4)
    r.setMany({ CLR: ONE, En: ONE })
    r.pulse()
    expect(r.agreed()).toBe('XXXX')
    r.pulse()
    expect(r.agreed()).toBe('XXXX')
    r.setMany({ CLR: ZERO })
    r.pulse()
    expect(r.agreed()).toBe('0000')
  })

  it('K matches an AND of all four Q bits at every state of two full cycles', () => {
    const r = new CounterRig(false, 4).clear()
    r.setMany({ En: ONE })
    for (let k = 1; k <= 32; k++) {
      r.pulse()
      const q = r.agreed()
      expect(r.k()).toBe(bit(q === '1111' ? 1 : 0))
      expect(r.kGate()).toBe(r.k())
    }
  })

  it('K is 1 in exactly one of the 16 states', () => {
    const r = new CounterRig(false, 4).clear()
    r.setMany({ En: ONE })
    let high = 0
    for (let k = 0; k < 16; k++) {
      expect(r.k()).toBe(bit(r.part() === '1111' ? 1 : 0))
      if (r.k() === ONE) high++
      r.pulse()
    }
    expect(high).toBe(1)
  })

  it('K stays 1 while the all-ones state is held with En = 0', () => {
    const r = new CounterRig(false, 4).clear()
    r.setMany({ En: ONE })
    for (let k = 0; k < 15; k++) r.pulse()
    expect(r.agreed()).toBe('1111')
    expect(r.k()).toBe(ONE)
    r.setMany({ En: ZERO })
    for (let k = 0; k < 4; k++) {
      r.pulse()
      expect(r.agreed()).toBe('1111')
      expect(r.k()).toBe(ONE)
    }
  })

  it('K is X while the count is undetermined', () => {
    const r = new CounterRig(false, 4)
    expect(r.part()).toBe('XXXX')
    expect(r.k()).toBe(X)
    expect(r.kGate()).toBe(X)
  })
})

describe('loadable counter from flip-flops + muxes vs N_LOADABLE_COUNTER', () => {
  /** Spec next state: CLR = 0 clears, else Ld = 0 loads D, else En = 1 increments. */
  function expected(state: number, clr: LogicValue, ld: LogicValue, en: LogicValue, d: number): string {
    if (clr === ZERO) return bin(0, 4)
    if (clr !== ONE) return 'XXXX'
    if (ld === ZERO) return bin(d, 4)
    if (ld !== ONE) return 'XXXX'
    if (en === ZERO) return bin(state, 4)
    if (en !== ONE) return 'XXXX'
    return bin(state + 1, 4)
  }

  function load(r: CounterRig, value: number): void {
    r.setD(bin(value, 4))
    r.setMany({ CLR: ONE, Ld: ZERO, En: ZERO })
    r.pulse()
    expect(r.agreed()).toBe(bin(value, 4))
  }

  const combos: [LogicValue, LogicValue, LogicValue][] = []
  for (const clr of [ZERO, ONE]) for (const ld of [ZERO, ONE]) for (const en of [ZERO, ONE]) combos.push([clr, ld, en])

  it.each(combos)('CLR=%s Ld=%s En=%s behaves per the priority chain from all 16 states', (clr, ld, en) => {
    const r = new CounterRig(true, 4)
    const partSeq: string[] = []
    const ffSeq: string[] = []
    const want: string[] = []
    for (let state = 0; state < 16; state++) {
      load(r, state)
      const d = (state + 7) % 16
      r.setD(bin(d, 4))
      r.setMany({ CLR: clr, Ld: ld, En: en })
      r.pulse()
      partSeq.push(r.part())
      ffSeq.push(r.ffs())
      want.push(expected(state, clr, ld, en, d))
    }
    expect(partSeq).toEqual(want)
    expect(ffSeq).toEqual(want)
  })

  it('loads then counts from the loaded value through the wrap', () => {
    const r = new CounterRig(true, 4)
    load(r, 13)
    r.setMany({ CLR: ONE, Ld: ONE, En: ONE })
    const seq: string[] = []
    for (let k = 0; k < 6; k++) {
      r.pulse()
      seq.push(r.agreed())
    }
    expect(seq).toEqual([14, 15, 0, 1, 2, 3].map((v) => bin(v, 4)))
  })

  it('K follows the loaded value, not just the counting sequence', () => {
    const r = new CounterRig(true, 4)
    load(r, 15)
    expect(r.k()).toBe(ONE)
    expect(r.kGate()).toBe(ONE)
    load(r, 14)
    expect(r.k()).toBe(ZERO)
    expect(r.kGate()).toBe(ZERO)
  })

  it.each([X, Z])('Ld = %s with CLR = 1 makes every bit X (both)', (v) => {
    const r = new CounterRig(true, 4)
    load(r, 5)
    r.setMany({ CLR: ONE, Ld: v })
    r.pulse()
    expect(r.agreed()).toBe('XXXX')
  })

  it.each([X, Z])('CLR = 0 clears even when Ld and En are %s', (v) => {
    const r = new CounterRig(true, 4)
    load(r, 5)
    r.setMany({ CLR: ZERO, Ld: v, En: v })
    r.pulse()
    expect(r.agreed()).toBe('0000')
  })

  it.each([X, Z])('Ld = 0 loads even when En is %s', (v) => {
    const r = new CounterRig(true, 4)
    load(r, 5)
    r.setD('1010')
    r.setMany({ CLR: ONE, Ld: ZERO, En: v })
    r.pulse()
    expect(r.agreed()).toBe('1010')
  })

  it.each([X, Z])('a D bit = %s at load makes only that bit X (both)', (v) => {
    const r = new CounterRig(true, 4)
    load(r, 15)
    drive(r.c, { D1: v })
    r.setMany({ CLR: ONE, Ld: ZERO })
    r.pulse()
    expect(r.agreed()).toBe('11X1')
  })

  it('part, flip-flop version and the Appendix A model agree over 150 random steps', () => {
    const r = new CounterRig(true, 4)
    const rnd = lcg(0xc0ffee)
    const pick = (): LogicValue => [ZERO, ONE, ZERO, ONE, ZERO, ONE, X, Z][rnd() % 8]
    let model = 'XXXX'
    const parts: string[] = []
    const chains: string[] = []
    const models: string[] = []
    const carries: LogicValue[] = []
    const wantCarries: LogicValue[] = []
    for (let step = 0; step < 150; step++) {
      const ctl = { CLR: pick(), Ld: pick(), En: pick() }
      const d = bin(rnd() % 16, 4)
      r.setMany(ctl)
      r.setD(d)
      r.pulse()
      model = modelCounter(true, model, ctl, d)
      parts.push(r.part())
      chains.push(r.ffs())
      models.push(model)
      carries.push(r.k())
      wantCarries.push(model.includes('X') ? X : bit(model === '1111' ? 1 : 0))
    }
    expect(parts).toEqual(models)
    expect(chains).toEqual(models)
    expect(carries).toEqual(wantCarries)
  })
})

describe('cascaded counters', () => {
  it('two 2-bit N_COUNTERs chained K -> En count exactly like one 4-bit N_COUNTER', () => {
    const b = new CircuitBuilder('cascade')
      .switch('clk', ZERO)
      .switch('clr', ONE)
      .add('vcc', ComponentType.VCC)
      .add('lo', ComponentType.N_COUNTER, { bits: 2 })
      .add('hi', ComponentType.N_COUNTER, { bits: 2 })
      .add('ref', ComponentType.N_COUNTER, { bits: 4 })
      .wire(p('clk', 'out'), p('lo', 'CLK'))
      .wire(p('clk', 'out'), p('hi', 'CLK'))
      .wire(p('clk', 'out'), p('ref', 'CLK'))
      .wire(p('clr', 'out'), p('lo', 'CLR'))
      .wire(p('clr', 'out'), p('hi', 'CLR'))
      .wire(p('clr', 'out'), p('ref', 'CLR'))
      .wire(p('vcc', 'out'), p('lo', 'En'))
      .wire(p('vcc', 'out'), p('ref', 'En'))
      .wire(p('lo', 'K'), p('hi', 'En'))
    const c = b.build()
    c.set('clr', ZERO)
    c.pulse('clk')
    c.set('clr', ONE)
    const cascade: string[] = []
    const ref: string[] = []
    const want: string[] = []
    for (let k = 1; k <= 20; k++) {
      c.pulse('clk')
      cascade.push(c.vec('hi', 'Q', 2) + c.vec('lo', 'Q', 2))
      ref.push(c.vec('ref', 'Q', 4))
      want.push(bin(k, 4))
    }
    expect(cascade).toEqual(want)
    expect(ref).toEqual(want)
  })
})

// ================================================================================
// 3. Register
// ================================================================================

describe('4-bit register from D flip-flops + load muxes vs N_REGISTER', () => {
  it('powers up undetermined in both implementations', () => {
    const r = new RegisterRig()
    expect(r.part()).toBe('XXXX')
    expect(r.ffs()).toBe('XXXX')
  })

  it.each(range(16))('Ld = 1, CLR = 0 loads D = %i on the rising edge (both)', (v) => {
    const r = new RegisterRig()
    r.setMany({ CLR: ONE })
    r.pulse()
    r.setMany({ CLR: ZERO, Ld: ONE })
    r.setD(bin(v, 4))
    expect(r.agreed()).toBe('0000')
    r.pulse()
    expect(r.agreed()).toBe(bin(v, 4))
  })

  it('holds while Ld = 0 no matter how D moves (manual: "loads when CLR = 0 and Ld = 1")', () => {
    const r = new RegisterRig()
    r.setMany({ CLR: ZERO, Ld: ONE })
    r.setD('1011')
    r.pulse()
    expect(r.agreed()).toBe('1011')
    r.setMany({ Ld: ZERO })
    for (let v = 0; v < 16; v++) {
      r.setD(bin(v, 4))
      r.pulse()
      expect(r.agreed()).toBe('1011')
    }
  })

  it('CLR = 1 clears on the edge and beats Ld = 1', () => {
    const r = new RegisterRig()
    r.setMany({ CLR: ZERO, Ld: ONE })
    r.setD('1111')
    r.pulse()
    expect(r.agreed()).toBe('1111')
    r.setMany({ CLR: ONE, Ld: ONE })
    r.setD('1010')
    expect(r.agreed()).toBe('1111') // synchronous
    r.pulse()
    expect(r.agreed()).toBe('0000')
  })

  it('CLR is synchronous: raising CLR with the clock idle does not clear', () => {
    const r = new RegisterRig()
    r.setMany({ CLR: ZERO, Ld: ONE })
    r.setD('0110')
    r.pulse()
    for (const level of [ZERO, ONE]) {
      r.c.set('clk', level)
      r.setMany({ CLR: ONE })
      expect(r.agreed()).toBe('0110')
      r.setMany({ CLR: ZERO })
      expect(r.agreed()).toBe('0110')
    }
    r.c.set('clk', ZERO)
  })

  it.each([X, Z])('CLR = %s at the edge makes every bit X (both)', (v) => {
    const r = new RegisterRig()
    r.setMany({ CLR: ONE })
    r.pulse()
    r.setMany({ CLR: v })
    r.pulse()
    expect(r.agreed()).toBe('XXXX')
  })

  it.each([X, Z])('Ld = %s with CLR = 0 makes every bit X (both)', (v) => {
    const r = new RegisterRig()
    r.setMany({ CLR: ONE })
    r.pulse()
    r.setMany({ CLR: ZERO, Ld: v })
    r.pulse()
    expect(r.agreed()).toBe('XXXX')
  })

  it.each([X, Z])('CLR = 1 clears even when Ld = %s (Ld is not consulted)', (v) => {
    const r = new RegisterRig()
    r.setMany({ CLR: ONE, Ld: v })
    r.pulse()
    expect(r.agreed()).toBe('0000')
  })

  it.each([X, Z])('a D bit = %s at load makes only that bit X (both)', (v) => {
    const r = new RegisterRig()
    r.setMany({ CLR: ZERO, Ld: ONE })
    r.setD('1111')
    r.pulse()
    drive(r.c, { D3: v })
    r.pulse()
    expect(r.agreed()).toBe('X111')
  })

  it('part, flip-flop version and the Appendix A model agree over 150 random steps', () => {
    const r = new RegisterRig()
    const rnd = lcg(0xfeed)
    const pick = (): LogicValue => [ZERO, ONE, ZERO, ONE, ZERO, ONE, X, Z][rnd() % 8]
    let model = 'XXXX'
    const parts: string[] = []
    const chains: string[] = []
    const models: string[] = []
    for (let step = 0; step < 150; step++) {
      const ctl = { CLR: pick(), Ld: pick() }
      const d = bin(rnd() % 16, 4)
      r.setMany(ctl)
      r.setD(d)
      r.pulse()
      model = modelRegister(model, ctl, d)
      parts.push(r.part())
      chains.push(r.ffs())
      models.push(model)
    }
    expect(parts).toEqual(models)
    expect(chains).toEqual(models)
  })
})

// ================================================================================
// 4. Frequency division under the CLOCK part
// ================================================================================

describe('frequency division under the CLOCK part', () => {
  /** `stages` toggle flip-flops (D tied to Q'), each clocked by the previous Q. */
  function dividerChain(stages: number, delay = 1, period = 20, simTimeNs = 200): Circuit {
    const b = new CircuitBuilder(`divider-${stages}`)
      .add('clk', ComponentType.CLOCK)
      .add('vcc', ComponentType.VCC)
      .probe('pclk')
      .wire(p('clk', 'out'), p('pclk', 'in'))
    addSignal(b, 'rst', [
      [0, ZERO],
      [5, ONE]
    ])
    for (let i = 1; i <= stages; i++) {
      b.add(`f${i}`, ComponentType.D_FLIPFLOP, { delay })
        .wire(p('vcc', 'out'), p(`f${i}`, 'S'))
        .wire(p('rst', 'out'), p(`f${i}`, 'R'))
        .wire(p(`f${i}`, "Q'"), p(`f${i}`, 'D'))
        .wire(i === 1 ? p('clk', 'out') : p(`f${i - 1}`, 'Q'), p(`f${i}`, 'CLK'))
        .probe(`pq${i}`)
        .wire(p(`f${i}`, 'Q'), p(`pq${i}`, 'in'))
    }
    return b.setSimulation({ clockPeriodNs: period, clockInitialValue: ONE, simTimeNs }).build()
  }

  it('the CLOCK part itself toggles every half period with no delay', () => {
    const c = dividerChain(1)
    c.go()
    const want: [number, LogicValue][] = [[0, ONE]]
    for (let k = 1; k <= 19; k++) want.push([10 * k, k % 2 === 1 ? ZERO : ONE])
    expect(trace(c, 'pclk')).toEqual(want)
  })

  it('divide-by-2: the flip-flop toggles one delay after every rising edge (20, 40, ...)', () => {
    const c = dividerChain(1)
    c.go()
    expect(c.time).toBe(195)
    expect(trace(c, 'pq1')).toEqual([
      [0, ZERO],
      [21, ONE],
      [41, ZERO],
      [61, ONE],
      [81, ZERO],
      [101, ONE],
      [121, ZERO],
      [141, ONE],
      [161, ZERO],
      [181, ONE]
    ])
  })

  it('divide-by-4: the second stage toggles at edge + 2 delays', () => {
    const c = dividerChain(2)
    c.go()
    expect(trace(c, 'pq2')).toEqual([
      [0, ZERO],
      [22, ONE],
      [62, ZERO],
      [102, ONE],
      [142, ZERO],
      [182, ONE]
    ])
  })

  it('divide-by-8: the third stage toggles at edge + 3 delays', () => {
    const c = dividerChain(3)
    c.go()
    expect(trace(c, 'pq3')).toEqual([
      [0, ZERO],
      [23, ONE],
      [103, ZERO],
      [183, ONE]
    ])
  })

  it('each stage has exactly half the transitions of the previous one', () => {
    const c = dividerChain(3)
    c.go()
    expect(trace(c, 'pq1').length).toBe(10)
    expect(trace(c, 'pq2').length).toBe(6)
    expect(trace(c, 'pq3').length).toBe(4)
  })

  it('with 3 ns parts the delays accumulate: 23, 26, 29 after the first edge', () => {
    const c = dividerChain(3, 3)
    c.go()
    expect(trace(c, 'pq1')).toEqual([
      [0, ZERO],
      [23, ONE],
      [43, ZERO],
      [63, ONE],
      [83, ZERO],
      [103, ONE],
      [123, ZERO],
      [143, ONE],
      [163, ZERO],
      [183, ONE]
    ])
    expect(trace(c, 'pq2')).toEqual([
      [0, ZERO],
      [26, ONE],
      [66, ZERO],
      [106, ONE],
      [146, ZERO],
      [186, ONE]
    ])
    expect(trace(c, 'pq3')).toEqual([
      [0, ZERO],
      [29, ONE],
      [109, ZERO],
      [189, ONE]
    ])
  })

  it('Step stops a quarter period before each active edge and crosses exactly one edge', () => {
    const c = dividerChain(1)
    const times: number[] = []
    const values: LogicValue[] = []
    for (let i = 0; i < 4; i++) {
      c.step()
      times.push(c.time)
      values.push(c.pin(p('f1', 'Q')))
    }
    expect(times).toEqual([15, 35, 55, 75])
    expect(values).toEqual([ZERO, ONE, ZERO, ONE])
  })

  it('an odd clock period keeps active edges on exact multiples of the period (decision 6)', () => {
    const c = dividerChain(1, 1, 25, 100)
    c.go()
    expect(c.time).toBe(94)
    expect(trace(c, 'pclk')).toEqual([
      [0, ONE],
      [12, ZERO],
      [25, ONE],
      [37, ZERO],
      [50, ONE],
      [62, ZERO],
      [75, ONE],
      [87, ZERO]
    ])
    expect(trace(c, 'pq1')).toEqual([
      [0, ZERO],
      [26, ONE],
      [51, ZERO],
      [76, ONE]
    ])
  })

  it('a falling-edge clock (initial 0) puts the D flip-flop edges at 10, 30, 50 ...', () => {
    const b = new CircuitBuilder('divider-fall')
      .add('clk', ComponentType.CLOCK)
      .add('vcc', ComponentType.VCC)
    addSignal(b, 'rst', [
      [0, ZERO],
      [5, ONE]
    ])
    b.add('f1', ComponentType.D_FLIPFLOP)
      .wire(p('vcc', 'out'), p('f1', 'S'))
      .wire(p('rst', 'out'), p('f1', 'R'))
      .wire(p('f1', "Q'"), p('f1', 'D'))
      .wire(p('clk', 'out'), p('f1', 'CLK'))
      .probe('pq1')
      .wire(p('f1', 'Q'), p('pq1', 'in'))
    const c = b.setSimulation({ clockPeriodNs: 20, clockInitialValue: ZERO, simTimeNs: 100 }).build()
    c.go()
    // Clock starts at 0, so the *rising* transitions are the odd toggles at 10, 30, ...
    expect(trace(c, 'pq1')).toEqual([
      [0, ZERO],
      [11, ONE],
      [31, ZERO],
      [51, ONE],
      [71, ZERO],
      [91, ONE]
    ])
  })
})

// ================================================================================
// 5. The manual's §4 accumulator exercise
// ================================================================================

describe("the manual's N_ADDER + N_REGISTER accumulator", () => {
  /** Register fed by an adder; `feedback` routes Q back into X (accumulate) or not. */
  function accumulator(n: number, feedback: boolean): Circuit {
    const b = new CircuitBuilder(`acc-${n}-${feedback}`)
      .switch('clk', ZERO)
      .switch('clr', ZERO)
      .switch('ld', ONE)
      .switch('cin', ZERO)
      .add('reg', ComponentType.N_REGISTER, { bits: n })
      .add('add', ComponentType.N_ADDER, { bits: n })
      .wire(p('clk', 'out'), p('reg', 'CLK'))
      .wire(p('ld', 'out'), p('reg', 'Ld'))
      .wire(p('clr', 'out'), p('reg', 'CLR'))
      .wire(p('cin', 'out'), p('add', 'Cin'))
    for (let i = 0; i < n; i++) {
      b.switch(`y${i}`, ZERO).wire(p(`y${i}`, 'out'), p('add', `Y${i}`))
      b.wire(p('add', `S${i}`), p('reg', `D${i}`))
      if (feedback) b.wire(p('reg', `Q${i}`), p('add', `X${i}`))
      else b.switch(`x${i}`, ZERO).wire(p(`x${i}`, 'out'), p('add', `X${i}`))
    }
    return b.build()
  }

  function setBits(c: Circuit, prefix: string, value: number, n: number): void {
    const vals: Record<string, LogicValue> = {}
    for (let i = 0; i < n; i++) vals[`${prefix}${i}`] = bit((value >> i) & 1)
    c.setMany(vals)
  }

  function cleared(n: number, feedback = true): Circuit {
    const c = accumulator(n, feedback)
    c.set('clr', ONE)
    c.pulse('clk')
    c.set('clr', ZERO)
    expect(c.vec('reg', 'Q', n)).toBe('0'.repeat(n))
    return c
  }

  it.each(range(15).map((i) => i + 1))('accumulates Y = %i over 20 clocks with wrap-around', (y) => {
    const c = cleared(4)
    setBits(c, 'y', y, 4)
    const seen: string[] = []
    const want: string[] = []
    for (let k = 1; k <= 20; k++) {
      c.pulse('clk')
      seen.push(c.vec('reg', 'Q', 4))
      want.push(bin(k * y, 4))
    }
    expect(seen).toEqual(want)
  })

  it('Cout of the adder marks each wrap of the 4-bit accumulator', () => {
    const c = cleared(4)
    setBits(c, 'y', 5, 4)
    const carries: LogicValue[] = []
    const want: LogicValue[] = []
    for (let k = 0; k < 10; k++) {
      // Cout is combinational on the *current* register value.
      carries.push(c.pin(p('add', 'Cout')))
      want.push(bit(((k * 5) % 16) + 5 > 15 ? 1 : 0))
      c.pulse('clk')
    }
    expect(carries).toEqual(want)
  })

  it('Cin = 1 accumulates Y + 1 per clock', () => {
    const c = cleared(4)
    setBits(c, 'y', 3, 4)
    c.set('cin', ONE)
    const seen: string[] = []
    for (let k = 1; k <= 8; k++) {
      c.pulse('clk')
      seen.push(c.vec('reg', 'Q', 4))
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((k) => bin(k * 4, 4)))
  })

  it('an 8-bit accumulator adds Y = 5 through several wraps', () => {
    const c = cleared(8)
    setBits(c, 'y', 5, 8)
    const seen: string[] = []
    const want: string[] = []
    for (let k = 1; k <= 60; k++) {
      c.pulse('clk')
      seen.push(c.vec('reg', 'Q', 8))
      want.push(bin(k * 5, 8))
    }
    expect(seen).toEqual(want)
  })

  it('Ld = 0 freezes the accumulator (manual: loads only when CLR = 0 and Ld = 1)', () => {
    const c = cleared(4)
    setBits(c, 'y', 6, 4)
    c.pulse('clk')
    expect(c.vec('reg', 'Q', 4)).toBe(bin(6, 4))
    c.set('ld', ZERO)
    for (let k = 0; k < 5; k++) {
      c.pulse('clk')
      expect(c.vec('reg', 'Q', 4)).toBe(bin(6, 4))
    }
    c.set('ld', ONE)
    c.pulse('clk')
    expect(c.vec('reg', 'Q', 4)).toBe(bin(12, 4))
  })

  it('CLR = 1 restarts the accumulation from zero at the next edge', () => {
    const c = cleared(4)
    setBits(c, 'y', 7, 4)
    c.pulse('clk')
    c.pulse('clk')
    expect(c.vec('reg', 'Q', 4)).toBe(bin(14, 4))
    c.set('clr', ONE)
    expect(c.vec('reg', 'Q', 4)).toBe(bin(14, 4))
    c.pulse('clk')
    expect(c.vec('reg', 'Q', 4)).toBe('0000')
    c.set('clr', ZERO)
    c.pulse('clk')
    expect(c.vec('reg', 'Q', 4)).toBe(bin(7, 4))
  })

  it('changing Y mid-run changes only the increments that follow', () => {
    const c = cleared(4)
    setBits(c, 'y', 2, 4)
    c.pulse('clk')
    c.pulse('clk')
    expect(c.vec('reg', 'Q', 4)).toBe(bin(4, 4))
    setBits(c, 'y', 5, 4)
    expect(c.vec('reg', 'Q', 4)).toBe(bin(4, 4)) // register is clocked, Y is not
    c.pulse('clk')
    expect(c.vec('reg', 'Q', 4)).toBe(bin(9, 4))
  })

  it('without the feedback wire the sum does not accumulate (manual §4 step e)', () => {
    const c = cleared(4, false)
    setBits(c, 'x', 5, 4)
    setBits(c, 'y', 6, 4)
    // Flipping X and Y changes the adder output immediately, not the register.
    expect(c.vec('add', 'S', 4)).toBe(bin(11, 4))
    expect(c.vec('reg', 'Q', 4)).toBe('0000')
    for (let k = 0; k < 6; k++) {
      c.pulse('clk')
      expect(c.vec('reg', 'Q', 4)).toBe(bin(11, 4))
    }
    setBits(c, 'x', 1, 4)
    expect(c.vec('add', 'S', 4)).toBe(bin(7, 4))
    expect(c.vec('reg', 'Q', 4)).toBe(bin(11, 4))
    c.pulse('clk')
    expect(c.vec('reg', 'Q', 4)).toBe(bin(7, 4))
  })

  it('a bus probe on the accumulator shows the running total in hex', () => {
    const b = new CircuitBuilder('acc-bus')
      .switch('clk', ZERO)
      .switch('clr', ZERO)
      .add('vcc', ComponentType.VCC)
      .add('gnd', ComponentType.GROUND)
      .add('reg', ComponentType.N_REGISTER, { bits: 4 })
      .add('add', ComponentType.N_ADDER, { bits: 4 })
      .add('mg', ComponentType.MERGER, { bits: 4 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
      .wire(p('clk', 'out'), p('reg', 'CLK'))
      .wire(p('vcc', 'out'), p('reg', 'Ld'))
      .wire(p('clr', 'out'), p('reg', 'CLR'))
      .wire(p('gnd', 'out'), p('add', 'Cin'))
      .wire(p('mg', 'out'), p('bp', 'in'))
    for (let i = 0; i < 4; i++) {
      b.switch(`y${i}`, bit((7 >> i) & 1))
        .wire(p(`y${i}`, 'out'), p('add', `Y${i}`))
        .wire(p('reg', `Q${i}`), p('add', `X${i}`))
        .wire(p('add', `S${i}`), p('reg', `D${i}`))
        .wire(p('reg', `Q${i}`), p('mg', `in${i}`))
    }
    const c = b.build()
    c.set('clr', ONE)
    c.pulse('clk')
    c.set('clr', ZERO)
    expect(c.bus(p('bp', 'in'))).toBe('0')
    const hex: string[] = []
    for (let k = 1; k <= 6; k++) {
      c.pulse('clk')
      hex.push(c.bus(p('bp', 'in')))
    }
    expect(hex).toEqual(['7', 'E', '5', 'C', '3', 'A'])
  })

  it('under the CLOCK part the register settles at edge + 1 and the adder at edge + 2', () => {
    const b = new CircuitBuilder('acc-timing')
      .add('clk', ComponentType.CLOCK)
      .add('vcc', ComponentType.VCC)
      .add('gnd', ComponentType.GROUND)
      .add('reg', ComponentType.N_REGISTER, { bits: 4 })
      .add('add', ComponentType.N_ADDER, { bits: 4 })
      .probe('pq0')
      .probe('ps0')
      .wire(p('clk', 'out'), p('reg', 'CLK'))
      .wire(p('vcc', 'out'), p('reg', 'Ld'))
      .wire(p('gnd', 'out'), p('add', 'Cin'))
      .wire(p('reg', 'Q0'), p('pq0', 'in'))
      .wire(p('add', 'S0'), p('ps0', 'in'))
    addSignal(b, 'clrsig', [
      [0, ONE],
      [25, ZERO]
    ])
    b.wire(p('clrsig', 'out'), p('reg', 'CLR'))
    for (let i = 0; i < 4; i++) {
      b.wire(i < 2 ? p('vcc', 'out') : p('gnd', 'out'), p('add', `Y${i}`)) // Y = 3
        .wire(p('reg', `Q${i}`), p('add', `X${i}`))
        .wire(p('add', `S${i}`), p('reg', `D${i}`))
    }
    const c = b.setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 200 }).build()
    c.go()
    expect(trace(c, 'pq0')).toEqual([
      [0, X],
      [21, ZERO],
      [41, ONE],
      [61, ZERO],
      [81, ONE],
      [101, ZERO],
      [121, ONE],
      [141, ZERO],
      [161, ONE],
      [181, ZERO]
    ])
    expect(trace(c, 'ps0')).toEqual([
      [0, X],
      [22, ONE],
      [42, ZERO],
      [62, ONE],
      [82, ZERO],
      [102, ONE],
      [122, ZERO],
      [142, ONE],
      [162, ZERO],
      [182, ONE]
    ])
    expect(c.vec('reg', 'Q', 4)).toBe(bin(8, 4)) // 3 * 8 mod 16 after 8 accumulating edges
  })
})

// ================================================================================
// 6. Shift-and-add multiplier data path (manual §4 / Fig. 13)
// ================================================================================

describe('shift-and-add multiplier data path', () => {
  /**
   * ACC (4-bit right shift register) holds the high half of the product, M the low
   * half and the multiplier. Each bit position takes two clocks:
   *   add   phase (`phase` = 0): ACC.Ld = M.Q0, so ACC <- ACC + Y and the carry
   *                              flip-flop captures Cout.
   *   shift phase (`phase` = 1): {C, ACC, M} shifts right one place; C is reloaded
   *                              with 0 by the same edge.
   */
  function multiplierRig(): Circuit {
    const b = new CircuitBuilder('multiplier')
      .add('vcc', ComponentType.VCC)
      .add('gnd', ComponentType.GROUND)
      .switch('clk', ZERO)
      .switch('init', ZERO)
      .switch('phase', ZERO)
      .add('acc', ComponentType.N_SHIFT_RIGHT, { bits: 4 })
      .add('m', ComponentType.N_SHIFT_RIGHT, { bits: 4 })
      .add('add', ComponentType.N_ADDER, { bits: 4 })
      .add('nphase', ComponentType.NOT)
      .add('ninit', ComponentType.NOT)
      .add('ldand', ComponentType.AND2)
      .add('cff', ComponentType.D_FLIPFLOP)
      .wire(p('phase', 'out'), p('nphase', 'in1'))
      .wire(p('init', 'out'), p('ninit', 'in1'))
      .wire(p('nphase', 'out'), p('ldand', 'in1'))
      .wire(p('m', 'Q0'), p('ldand', 'in2'))
      .wire(p('clk', 'out'), p('acc', 'CLK'))
      .wire(p('init', 'out'), p('acc', 'CLR'))
      .wire(p('ldand', 'out'), p('acc', 'Ld'))
      .wire(p('phase', 'out'), p('acc', 'RS'))
      .wire(p('cff', 'Q'), p('acc', 'Lin'))
      .wire(p('clk', 'out'), p('m', 'CLK'))
      .wire(p('gnd', 'out'), p('m', 'CLR'))
      .wire(p('init', 'out'), p('m', 'Ld'))
      .wire(p('phase', 'out'), p('m', 'RS'))
      .wire(p('acc', 'Q0'), p('m', 'Lin'))
      .wire(p('gnd', 'out'), p('add', 'Cin'))
      .wire(p('clk', 'out'), p('cff', 'CLK'))
      .wire(p('vcc', 'out'), p('cff', 'S'))
      .wire(p('ninit', 'out'), p('cff', 'R'))
    const carryD = addMux2(b, 'cmux', p('ldand', 'out'), p('gnd', 'out'), p('add', 'Cout'))
    b.wire(carryD, p('cff', 'D'))
    for (let i = 0; i < 4; i++) {
      b.switch(`y${i}`, ZERO).wire(p(`y${i}`, 'out'), p('add', `Y${i}`))
      b.switch(`md${i}`, ZERO).wire(p(`md${i}`, 'out'), p('m', `D${i}`))
      b.wire(p('acc', `Q${i}`), p('add', `X${i}`))
      b.wire(p('add', `S${i}`), p('acc', `D${i}`))
    }
    return b.build()
  }

  const product = (c: Circuit): number => parseInt(c.vec('acc', 'Q', 4) + c.vec('m', 'Q', 4), 2)

  /** Loads the operands, runs the four add/shift pairs and returns every snapshot. */
  function run(c: Circuit, a: number, m: number): number[] {
    c.reset()
    const vals: Record<string, LogicValue> = { init: ZERO, phase: ZERO, clk: ZERO }
    for (let i = 0; i < 4; i++) {
      vals[`y${i}`] = bit((a >> i) & 1)
      vals[`md${i}`] = bit((m >> i) & 1)
    }
    c.setMany(vals)
    c.set('init', ONE)
    c.pulse('clk')
    c.set('init', ZERO)
    const snapshots = [product(c)]
    for (let step = 0; step < 4; step++) {
      c.set('phase', ZERO)
      c.pulse('clk')
      snapshots.push(product(c))
      c.set('phase', ONE)
      c.pulse('clk')
      snapshots.push(product(c))
    }
    c.set('phase', ZERO)
    return snapshots
  }

  it('initialises to {0000, multiplier} on the init clock', () => {
    const c = multiplierRig()
    const snaps = run(c, 3, 5)
    expect(snaps[0]).toBe(5)
    expect(c.vec('acc', 'Q', 4)).toBe('0000')
  })

  it('3 x 5 walks through the textbook partial products', () => {
    const c = multiplierRig()
    expect(run(c, 3, 5)).toEqual([5, 53, 26, 26, 13, 61, 30, 30, 15])
  })

  it('15 x 15 uses the carry flip-flop on three of the four adds', () => {
    const c = multiplierRig()
    expect(run(c, 15, 15)).toEqual([15, 255, 127, 111, 183, 167, 211, 195, 225])
  })

  it.each([
    [0, 0],
    [0, 9],
    [9, 0],
    [1, 1],
    [1, 15],
    [15, 1],
    [2, 3],
    [3, 2],
    [4, 4],
    [5, 5],
    [6, 7],
    [7, 6],
    [8, 8],
    [9, 11],
    [11, 9],
    [12, 13],
    [13, 12],
    [14, 14],
    [15, 14],
    [10, 10]
  ])('%i x %i produces the right 8-bit product', (a, m) => {
    const c = multiplierRig()
    const snaps = run(c, a, m)
    expect(snaps[snaps.length - 1]).toBe(a * m)
  })

  it('produces the correct product for all 256 operand pairs', () => {
    const c = multiplierRig()
    const bad: string[] = []
    for (let a = 0; a < 16; a++) {
      for (let m = 0; m < 16; m++) {
        const snaps = run(c, a, m)
        const got = snaps[snaps.length - 1]
        if (got !== a * m) bad.push(`${a}x${m}=${got} (want ${a * m})`)
      }
    }
    expect(bad).toEqual([])
  })

  it('the multiplier register ends up holding the low half of the product', () => {
    const c = multiplierRig()
    run(c, 13, 11)
    expect(c.vec('acc', 'Q', 4)).toBe(bin((13 * 11) >> 4, 4))
    expect(c.vec('m', 'Q', 4)).toBe(bin(13 * 11, 4))
  })

  it('the add phase is skipped when the multiplier bit is 0 (accumulator holds)', () => {
    const c = multiplierRig()
    // 5 x 4: multiplier bits 0 and 1 are 0, so the first two add phases must hold.
    const snaps = run(c, 5, 4)
    expect(snaps[0]).toBe(4) // {0000, 0100}
    expect(snaps[1]).toBe(4) // add phase, multiplier bit 0 = 0 -> unchanged
    expect(snaps[2]).toBe(2) // shift
    expect(snaps[3]).toBe(2) // add phase, multiplier bit 1 = 0 -> unchanged
    expect(snaps[snaps.length - 1]).toBe(20)
  })

  it('leaves the carry flip-flop at 0 once the last shift is done', () => {
    const c = multiplierRig()
    run(c, 15, 15)
    expect(c.pin(p('cff', 'Q'))).toBe(ZERO)
  })
})

// ================================================================================
// 7. Clocked parts and the clock edge instant
// ================================================================================

describe('clocked parts ignore their data inputs while the clock is static', () => {
  function switched(b: CircuitBuilder, target: string, pins: Record<string, LogicValue>): void {
    for (const [name, v] of Object.entries(pins)) {
      b.switch(`s_${name}`, v).wire(p(`s_${name}`, 'out'), p(target, name))
    }
  }

  interface Fixture {
    c: Circuit
    wiggles: string[]
    read: () => string
  }

  function dFlipFlop(): Fixture {
    const b = new CircuitBuilder('static-d').switch('clk', ZERO).add('u', ComponentType.D_FLIPFLOP)
    b.wire(p('clk', 'out'), p('u', 'CLK'))
    switched(b, 'u', { D: ONE, S: ONE, R: ONE })
    const c = b.build()
    c.pulse('clk')
    return { c, wiggles: ['s_D'], read: () => c.pin(p('u', 'Q')) }
  }

  function jkFlipFlop(): Fixture {
    const b = new CircuitBuilder('static-jk').switch('clk', ZERO).add('u', ComponentType.JK_FLIPFLOP)
    b.wire(p('clk', 'out'), p('u', 'CLK'))
    switched(b, 'u', { J: ONE, K: ZERO, S: ONE, R: ONE })
    const c = b.build()
    c.pulse('clk')
    return { c, wiggles: ['s_J', 's_K'], read: () => c.pin(p('u', 'Q')) }
  }

  function nBit(type: ComponentType, pins: Record<string, LogicValue>, setup: (c: Circuit) => void): Fixture {
    const b = new CircuitBuilder(`static-${type}`).switch('clk', ZERO).add('u', type, { bits: 4 })
    b.wire(p('clk', 'out'), p('u', 'CLK'))
    switched(b, 'u', pins)
    const hasD = type !== ComponentType.N_COUNTER
    if (hasD) {
      for (let i = 0; i < 4; i++) {
        b.switch(`s_D${i}`, bit((0b1001 >> i) & 1)).wire(p(`s_D${i}`, 'out'), p('u', `D${i}`))
      }
    }
    const c = b.build()
    setup(c)
    const wiggles = Object.keys(pins).map((n) => `s_${n}`)
    if (hasD) for (let i = 0; i < 4; i++) wiggles.push(`s_D${i}`)
    return { c, wiggles, read: () => c.vec('u', 'Q', 4) }
  }

  function stateMachine(): Fixture {
    const b = new CircuitBuilder('static-sm')
      .switch('clk', ZERO)
      .add('u', ComponentType.STATE_MACHINE, {
        smInputs: 1,
        smOutputs: 1,
        pinLabels: { in1: 'A', out1: 'Y' },
        smTable: [
          { present: '0', input: 'A', output: 'Y', next: '1' },
          { present: '0', input: "A'", output: '0', next: '0' },
          { present: '1', input: 'A', output: '0', next: '0' },
          { present: '1', input: "A'", output: 'Y', next: '1' }
        ]
      })
      .switch('s_in1', ONE)
      .wire(p('clk', 'out'), p('u', 'CLK'))
      .wire(p('s_in1', 'out'), p('u', 'in1'))
    const c = b.build()
    c.pulse('clk')
    return { c, wiggles: ['s_in1'], read: () => c.sim.getSmDisplays()[p('u', 'state')] }
  }

  const fixtures: [string, () => Fixture][] = [
    ['D_FLIPFLOP', dFlipFlop],
    ['JK_FLIPFLOP', jkFlipFlop],
    [
      'N_COUNTER',
      () =>
        nBit(ComponentType.N_COUNTER, { CLR: ONE, En: ONE }, (c) => {
          c.set('s_CLR', ZERO)
          c.pulse('clk')
          c.set('s_CLR', ONE)
          c.pulse('clk')
        })
    ],
    [
      'N_LOADABLE_COUNTER',
      () =>
        nBit(ComponentType.N_LOADABLE_COUNTER, { CLR: ONE, Ld: ZERO, En: ZERO }, (c) => {
          c.pulse('clk')
          c.set('s_Ld', ONE)
        })
    ],
    [
      'N_REGISTER',
      () =>
        nBit(ComponentType.N_REGISTER, { CLR: ZERO, Ld: ONE }, (c) => {
          c.pulse('clk')
          c.set('s_Ld', ZERO)
        })
    ],
    [
      'N_SHIFT_LEFT',
      () =>
        nBit(ComponentType.N_SHIFT_LEFT, { CLR: ZERO, Ld: ONE, LS: ZERO, Rin: ZERO }, (c) => {
          c.pulse('clk')
          c.set('s_Ld', ZERO)
        })
    ],
    [
      'N_SHIFT_RIGHT',
      () =>
        nBit(ComponentType.N_SHIFT_RIGHT, { CLR: ZERO, Ld: ONE, RS: ZERO, Lin: ZERO }, (c) => {
          c.pulse('clk')
          c.set('s_Ld', ZERO)
        })
    ],
    [
      'N_SHIFT_BIDIR',
      () =>
        nBit(
          ComponentType.N_SHIFT_BIDIR,
          { CLR: ZERO, Ld: ONE, LS: ZERO, RS: ZERO, Rin: ZERO, Lin: ZERO },
          (c) => {
            c.pulse('clk')
            c.set('s_Ld', ZERO)
          }
        )
    ],
    ['STATE_MACHINE', stateMachine]
  ]

  it.each(fixtures)('%s holds its state while the clock stays low', (_name, make) => {
    const f = make()
    f.c.set('clk', ZERO)
    expect(f.read()).not.toContain('X') // the setup must leave a determined state
    wiggleAll(f.c, f.wiggles, f.read)
  })

  it.each(fixtures)('%s holds its state while the clock stays high', (_name, make) => {
    const f = make()
    f.c.set('clk', ONE)
    expect(f.read()).not.toContain('X')
    wiggleAll(f.c, f.wiggles, f.read)
  })

  it('the state machine still updates its Mealy output while the clock is static', () => {
    const f = stateMachine()
    f.c.set('clk', ZERO)
    const state = f.read()
    const before = f.c.pin(p('u', 'out1'))
    f.c.toggle('s_in1')
    expect(f.read()).toBe(state)
    expect(f.c.pin(p('u', 'out1'))).not.toBe(before)
  })
})

describe('a data input changing at the exact instant of the active edge (decision 1)', () => {
  const CLK_ROWS: [number, LogicValue][] = [
    [0, ZERO],
    [10, ONE],
    [20, ZERO],
    [30, ONE],
    [40, ZERO]
  ]

  it.each([9, 10])('D flip-flop: D rising at t = %i is captured by the edge at 10', (t) => {
    const b = new CircuitBuilder('edge-d').add('vcc', ComponentType.VCC)
    const clk = addSignal(b, 'sclk', CLK_ROWS)
    const dat = addSignal(b, 'sd', [
      [0, ZERO],
      [t, ONE]
    ])
    const rst = addSignal(b, 'srst', [
      [0, ZERO],
      [5, ONE]
    ])
    b.add('u', ComponentType.D_FLIPFLOP)
      .wire(p('vcc', 'out'), p('u', 'S'))
      .wire(rst, p('u', 'R'))
      .wire(clk, p('u', 'CLK'))
      .wire(dat, p('u', 'D'))
      .probe('pq')
      .wire(p('u', 'Q'), p('pq', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 50 })
    const c = b.build()
    c.go()
    expect(trace(c, 'pq')).toEqual([
      [0, ZERO],
      [11, ONE]
    ])
  })

  it('D flip-flop: D rising one nanosecond after the edge is not captured by it', () => {
    const b = new CircuitBuilder('edge-d-late').add('vcc', ComponentType.VCC)
    const clk = addSignal(b, 'sclk', CLK_ROWS)
    const dat = addSignal(b, 'sd', [
      [0, ZERO],
      [11, ONE],
      [25, ZERO]
    ])
    const rst = addSignal(b, 'srst', [
      [0, ZERO],
      [5, ONE]
    ])
    b.add('u', ComponentType.D_FLIPFLOP)
      .wire(p('vcc', 'out'), p('u', 'S'))
      .wire(rst, p('u', 'R'))
      .wire(clk, p('u', 'CLK'))
      .wire(dat, p('u', 'D'))
      .probe('pq')
      .wire(p('u', 'Q'), p('pq', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 50 })
    const c = b.build()
    c.go()
    expect(trace(c, 'pq')).toEqual([[0, ZERO]])
  })

  it('JK flip-flop: J rising exactly at the falling edge is captured by it', () => {
    const b = new CircuitBuilder('edge-jk').add('vcc', ComponentType.VCC).add('gnd', ComponentType.GROUND)
    const clk = addSignal(b, 'sclk', [
      [0, ONE],
      [10, ZERO],
      [20, ONE]
    ])
    const j = addSignal(b, 'sj', [
      [0, ZERO],
      [10, ONE]
    ])
    const rst = addSignal(b, 'srst', [
      [0, ZERO],
      [5, ONE]
    ])
    b.add('u', ComponentType.JK_FLIPFLOP)
      .wire(p('vcc', 'out'), p('u', 'S'))
      .wire(rst, p('u', 'R'))
      .wire(clk, p('u', 'CLK'))
      .wire(j, p('u', 'J'))
      .wire(p('gnd', 'out'), p('u', 'K'))
      .probe('pq')
      .wire(p('u', 'Q'), p('pq', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 50 })
    const c = b.build()
    c.go()
    expect(trace(c, 'pq')).toEqual([
      [0, ZERO],
      [11, ONE]
    ])
  })

  it('N_REGISTER: D changing exactly at the edge loads the new value', () => {
    const b = new CircuitBuilder('edge-reg').add('vcc', ComponentType.VCC).add('gnd', ComponentType.GROUND)
    const clk = addSignal(b, 'sclk', CLK_ROWS)
    const d0 = addSignal(b, 'sd0', [
      [0, ZERO],
      [10, ONE]
    ])
    b.add('u', ComponentType.N_REGISTER, { bits: 2 })
      .wire(clk, p('u', 'CLK'))
      .wire(p('vcc', 'out'), p('u', 'Ld'))
      .wire(p('gnd', 'out'), p('u', 'CLR'))
      .wire(d0, p('u', 'D0'))
      .wire(p('gnd', 'out'), p('u', 'D1'))
      .probe('pq0')
      .wire(p('u', 'Q0'), p('pq0', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 50 })
    const c = b.build()
    c.go()
    expect(trace(c, 'pq0')).toEqual([
      [0, X],
      [11, ONE]
    ])
  })

  it('N_REGISTER: CLR going high exactly at the edge clears instead of loading', () => {
    const b = new CircuitBuilder('edge-reg-clr').add('vcc', ComponentType.VCC)
    const clk = addSignal(b, 'sclk', CLK_ROWS)
    const clr = addSignal(b, 'sclr', [
      [0, ZERO],
      [30, ONE]
    ])
    b.add('u', ComponentType.N_REGISTER, { bits: 2 })
      .wire(clk, p('u', 'CLK'))
      .wire(p('vcc', 'out'), p('u', 'Ld'))
      .wire(clr, p('u', 'CLR'))
      .wire(p('vcc', 'out'), p('u', 'D0'))
      .wire(p('vcc', 'out'), p('u', 'D1'))
      .probe('pq0')
      .wire(p('u', 'Q0'), p('pq0', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 50 })
    const c = b.build()
    c.go()
    expect(trace(c, 'pq0')).toEqual([
      [0, X],
      [11, ONE],
      [31, ZERO]
    ])
  })

  it('N_COUNTER: En rising exactly at the edge makes that edge count', () => {
    const b = new CircuitBuilder('edge-ctr')
    const clk = addSignal(b, 'sclk', [
      [0, ZERO],
      [10, ONE],
      [20, ZERO],
      [30, ONE],
      [40, ZERO]
    ])
    const clr = addSignal(b, 'sclr', [
      [0, ZERO],
      [15, ONE]
    ])
    const en = addSignal(b, 'sen', [
      [0, ZERO],
      [30, ONE]
    ])
    b.add('u', ComponentType.N_COUNTER, { bits: 2 })
      .wire(clk, p('u', 'CLK'))
      .wire(clr, p('u', 'CLR'))
      .wire(en, p('u', 'En'))
      .probe('pq0')
      .wire(p('u', 'Q0'), p('pq0', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 50 })
    const c = b.build()
    c.go()
    expect(trace(c, 'pq0')).toEqual([
      [0, X],
      [11, ZERO],
      [31, ONE]
    ])
  })

  it('N_LOADABLE_COUNTER: Ld dropping exactly at the edge loads instead of counting', () => {
    const b = new CircuitBuilder('edge-ldctr').add('vcc', ComponentType.VCC).add('gnd', ComponentType.GROUND)
    const clk = addSignal(b, 'sclk', CLK_ROWS)
    const ld = addSignal(b, 'sld', [
      [0, ONE],
      [10, ZERO]
    ])
    b.add('u', ComponentType.N_LOADABLE_COUNTER, { bits: 2 })
      .wire(clk, p('u', 'CLK'))
      .wire(p('vcc', 'out'), p('u', 'CLR'))
      .wire(ld, p('u', 'Ld'))
      .wire(p('gnd', 'out'), p('u', 'En'))
      .wire(p('vcc', 'out'), p('u', 'D0'))
      .wire(p('vcc', 'out'), p('u', 'D1'))
      .probe('pq0')
      .wire(p('u', 'Q0'), p('pq0', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 50 })
    const c = b.build()
    c.go()
    expect(trace(c, 'pq0')).toEqual([
      [0, X],
      [11, ONE]
    ])
  })

  it('N_SHIFT_RIGHT: Lin changing exactly at the edge is the bit shifted in', () => {
    const b = new CircuitBuilder('edge-sr').add('vcc', ComponentType.VCC).add('gnd', ComponentType.GROUND)
    const clk = addSignal(b, 'sclk', CLK_ROWS)
    const lin = addSignal(b, 'slin', [
      [0, ZERO],
      [30, ONE]
    ])
    b.add('u', ComponentType.N_SHIFT_RIGHT, { bits: 2 })
      .wire(clk, p('u', 'CLK'))
      .wire(p('gnd', 'out'), p('u', 'CLR'))
      .wire(p('gnd', 'out'), p('u', 'Ld'))
      .wire(p('vcc', 'out'), p('u', 'RS'))
      .wire(lin, p('u', 'Lin'))
      .wire(p('gnd', 'out'), p('u', 'D0'))
      .wire(p('gnd', 'out'), p('u', 'D1'))
      .probe('pq1')
      .wire(p('u', 'Q1'), p('pq1', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 50 })
    const c = b.build()
    c.go()
    expect(trace(c, 'pq1')).toEqual([
      [0, X],
      [11, ZERO],
      [31, ONE]
    ])
  })

  it('STATE_MACHINE: an input changing exactly at the edge decides the transition', () => {
    const b = new CircuitBuilder('edge-sm')
    const clk = addSignal(b, 'sclk', CLK_ROWS)
    const a = addSignal(b, 'sa', [
      [0, ZERO],
      [10, ONE]
    ])
    b.add('u', ComponentType.STATE_MACHINE, {
      smInputs: 1,
      smOutputs: 1,
      pinLabels: { in1: 'A', out1: 'Y' },
      smTable: [
        { present: '0', input: 'A', output: 'Y', next: '1' },
        { present: '0', input: "A'", output: '0', next: '0' },
        { present: '1', input: '-', output: '0', next: '1' }
      ]
    })
      .wire(clk, p('u', 'CLK'))
      .wire(a, p('u', 'in1'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 50 })
    const c = b.build()
    c.go()
    expect(c.sim.getSmDisplays()[p('u', 'state')]).toBe('1')
  })

  it('a flip-flop chain whose Q lands exactly on the next stage\'s buffered edge passes the new value', () => {
    // f1 (delay 2) and the two 1 ns inverters both settle at edge + 2, so f2 sees
    // its clock rise and its D change in the same instant and samples the NEW D.
    const b = new CircuitBuilder('race').add('vcc', ComponentType.VCC)
    const clk = addSignal(b, 'sclk', [
      [0, ZERO],
      [10, ONE],
      [20, ZERO]
    ])
    const rst = addSignal(b, 'srst', [
      [0, ZERO],
      [5, ONE]
    ])
    b.add('n1', ComponentType.NOT, { delay: 1 })
      .add('n2', ComponentType.NOT, { delay: 1 })
      .wire(clk, p('n1', 'in1'))
      .wire(p('n1', 'out'), p('n2', 'in1'))
      .add('f1', ComponentType.D_FLIPFLOP, { delay: 2 })
      .add('f2', ComponentType.D_FLIPFLOP, { delay: 1 })
      .wire(p('vcc', 'out'), p('f1', 'S'))
      .wire(p('vcc', 'out'), p('f2', 'S'))
      .wire(rst, p('f1', 'R'))
      .wire(rst, p('f2', 'R'))
      .wire(clk, p('f1', 'CLK'))
      .wire(p('vcc', 'out'), p('f1', 'D'))
      .wire(p('n2', 'out'), p('f2', 'CLK'))
      .wire(p('f1', 'Q'), p('f2', 'D'))
      .probe('pq2')
      .wire(p('f2', 'Q'), p('pq2', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 50 })
    const c = b.build()
    c.go()
    expect(trace(c, 'pq2')).toEqual([
      [0, ZERO],
      [13, ONE]
    ])
  })

  it('the same chain with a slower first stage samples the old value instead', () => {
    const b = new CircuitBuilder('race-late').add('vcc', ComponentType.VCC)
    const clk = addSignal(b, 'sclk', [
      [0, ZERO],
      [10, ONE],
      [20, ZERO]
    ])
    const rst = addSignal(b, 'srst', [
      [0, ZERO],
      [5, ONE]
    ])
    b.add('n1', ComponentType.NOT, { delay: 1 })
      .add('n2', ComponentType.NOT, { delay: 1 })
      .wire(clk, p('n1', 'in1'))
      .wire(p('n1', 'out'), p('n2', 'in1'))
      .add('f1', ComponentType.D_FLIPFLOP, { delay: 3 })
      .add('f2', ComponentType.D_FLIPFLOP, { delay: 1 })
      .wire(p('vcc', 'out'), p('f1', 'S'))
      .wire(p('vcc', 'out'), p('f2', 'S'))
      .wire(rst, p('f1', 'R'))
      .wire(rst, p('f2', 'R'))
      .wire(clk, p('f1', 'CLK'))
      .wire(p('vcc', 'out'), p('f1', 'D'))
      .wire(p('n2', 'out'), p('f2', 'CLK'))
      .wire(p('f1', 'Q'), p('f2', 'D'))
      .probe('pq2')
      .wire(p('f2', 'Q'), p('pq2', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 50 })
    const c = b.build()
    c.go()
    expect(trace(c, 'pq2')).toEqual([[0, ZERO]])
  })
})

// ================================================================================
// 8. Feedback shift registers: ring and Johnson counters
// ================================================================================

describe('feedback shift registers (part output wired back to its own serial input)', () => {
  /**
   * A 4-bit left shift register whose Rin comes from its own Q3 (ring counter) or
   * from Q3 inverted (Johnson / twisted-ring counter), next to a flip-flop chain
   * with the same feedback. LS is tied high; Ld/CLR preload and clear.
   */
  function ringRig(twisted: boolean): Circuit {
    const b = new CircuitBuilder(`ring-${twisted}`)
      .switch('clk', ZERO)
      .switch('clr', ZERO)
      .switch('ld', ZERO)
      .add('vcc', ComponentType.VCC)
      .add('gnd', ComponentType.GROUND)
      .add('u', ComponentType.N_SHIFT_LEFT, { bits: 4 })
      .wire(p('clk', 'out'), p('u', 'CLK'))
      .wire(p('clr', 'out'), p('u', 'CLR'))
      .wire(p('ld', 'out'), p('u', 'Ld'))
      .wire(p('vcc', 'out'), p('u', 'LS'))
    for (let i = 0; i < 4; i++) {
      b.switch(`d${i}`, ZERO).wire(p(`d${i}`, 'out'), p('u', `D${i}`))
    }
    if (twisted) {
      b.add('nu', ComponentType.NOT).wire(p('u', 'Q3'), p('nu', 'in1')).wire(p('nu', 'out'), p('u', 'Rin'))
    } else {
      b.wire(p('u', 'Q3'), p('u', 'Rin'))
    }
    for (let i = 0; i < 4; i++) {
      b.add(`f${i}`, ComponentType.D_FLIPFLOP)
        .wire(p('vcc', 'out'), p(`f${i}`, 'S'))
        .wire(p('vcc', 'out'), p(`f${i}`, 'R'))
        .wire(p('clk', 'out'), p(`f${i}`, 'CLK'))
    }
    let feedback = p('f3', 'Q')
    if (twisted) {
      b.add('nf', ComponentType.NOT).wire(p('f3', 'Q'), p('nf', 'in1'))
      feedback = p('nf', 'out')
    }
    for (let i = 0; i < 4; i++) {
      const shifted = i === 0 ? feedback : p(`f${i - 1}`, 'Q')
      const loaded = addMux2(b, `mld${i}`, p('ld', 'out'), shifted, p(`d${i}`, 'out'))
      const cleared = addMux2(b, `mclr${i}`, p('clr', 'out'), loaded, p('gnd', 'out'))
      b.wire(cleared, p(`f${i}`, 'D'))
    }
    return b.build()
  }

  const both = (c: Circuit): [string, string] => [
    c.vec('u', 'Q', 4),
    [3, 2, 1, 0].map((i) => c.pin(p(`f${i}`, 'Q'))).join('')
  ]

  function preload(c: Circuit, value: number): void {
    c.setMany({ clr: ONE, ld: ZERO })
    c.pulse('clk')
    const vals: Record<string, LogicValue> = { clr: ZERO, ld: ONE }
    for (let i = 0; i < 4; i++) vals[`d${i}`] = bit((value >> i) & 1)
    c.setMany(vals)
    c.pulse('clk')
    c.set('ld', ZERO)
  }

  it('ring counter: a single 1 rotates through all four positions with period 4', () => {
    const c = ringRig(false)
    preload(c, 1)
    expect(both(c)).toEqual(['0001', '0001'])
    const want = ['0010', '0100', '1000', '0001', '0010', '0100', '1000', '0001']
    for (const w of want) {
      c.pulse('clk')
      expect(both(c)).toEqual([w, w])
    }
  })

  it('ring counter: an all-zero state is a dead state that never leaves', () => {
    const c = ringRig(false)
    preload(c, 0)
    for (let k = 0; k < 5; k++) {
      c.pulse('clk')
      expect(both(c)).toEqual(['0000', '0000'])
    }
  })

  it('ring counter preloaded with two ones keeps both circulating', () => {
    const c = ringRig(false)
    preload(c, 0b1001)
    const want = ['0011', '0110', '1100', '1001']
    for (const w of want) {
      c.pulse('clk')
      expect(both(c)).toEqual([w, w])
    }
  })

  it('Johnson counter: 8 distinct states before repeating', () => {
    const c = ringRig(true)
    preload(c, 0)
    const want = ['0001', '0011', '0111', '1111', '1110', '1100', '1000', '0000']
    for (const w of want) {
      c.pulse('clk')
      expect(both(c)).toEqual([w, w])
    }
    // and the sequence repeats
    c.pulse('clk')
    expect(both(c)).toEqual(['0001', '0001'])
  })

  it('Johnson counter: CLR forces it back to the start of the sequence', () => {
    const c = ringRig(true)
    preload(c, 0)
    for (let k = 0; k < 5; k++) c.pulse('clk')
    expect(both(c)).toEqual(['1110', '1110'])
    c.set('clr', ONE)
    c.pulse('clk')
    expect(both(c)).toEqual(['0000', '0000'])
    c.set('clr', ZERO)
    c.pulse('clk')
    expect(both(c)).toEqual(['0001', '0001'])
  })

  it('bidirectional rotate: LS rotates left, RS rotates right, LS wins when both are 1', () => {
    const b = new CircuitBuilder('rotate')
      .switch('clk', ZERO)
      .switch('ls', ZERO)
      .switch('rs', ZERO)
      .add('gnd', ComponentType.GROUND)
      .add('vcc', ComponentType.VCC)
      .add('u', ComponentType.N_SHIFT_BIDIR, { bits: 4 })
      .switch('ld', ONE)
      .wire(p('clk', 'out'), p('u', 'CLK'))
      .wire(p('gnd', 'out'), p('u', 'CLR'))
      .wire(p('ld', 'out'), p('u', 'Ld'))
      .wire(p('ls', 'out'), p('u', 'LS'))
      .wire(p('rs', 'out'), p('u', 'RS'))
      .wire(p('u', 'Q3'), p('u', 'Rin'))
      .wire(p('u', 'Q0'), p('u', 'Lin'))
    for (let i = 0; i < 4; i++) {
      b.switch(`d${i}`, bit((0b1001 >> i) & 1)).wire(p(`d${i}`, 'out'), p('u', `D${i}`))
    }
    const c = b.build()
    c.pulse('clk')
    expect(c.vec('u', 'Q', 4)).toBe('1001')
    c.setMany({ ld: ZERO, ls: ONE })
    c.pulse('clk')
    expect(c.vec('u', 'Q', 4)).toBe('0011')
    c.pulse('clk')
    expect(c.vec('u', 'Q', 4)).toBe('0110')
    c.setMany({ ls: ZERO, rs: ONE })
    c.pulse('clk')
    expect(c.vec('u', 'Q', 4)).toBe('0011')
    c.pulse('clk')
    expect(c.vec('u', 'Q', 4)).toBe('1001')
    c.setMany({ ls: ONE, rs: ONE }) // LS wins: rotate left again
    c.pulse('clk')
    expect(c.vec('u', 'Q', 4)).toBe('0011')
  })
})

// ================================================================================
// 9. Bit-serial adder: shift registers + FULL_ADDER + carry flip-flop
// ================================================================================

describe('bit-serial adder built from shift registers and a full adder', () => {
  function serialAdder(): Circuit {
    const b = new CircuitBuilder('serial-adder')
      .switch('clk', ZERO)
      .switch('ld', ZERO)
      .switch('rclr', ZERO)
      .switch('crst', ONE)
      .add('vcc', ComponentType.VCC)
      .add('gnd', ComponentType.GROUND)
      .add('nld', ComponentType.NOT)
      .add('a', ComponentType.N_SHIFT_RIGHT, { bits: 4 })
      .add('bb', ComponentType.N_SHIFT_RIGHT, { bits: 4 })
      .add('res', ComponentType.N_SHIFT_RIGHT, { bits: 4 })
      .add('fa', ComponentType.FULL_ADDER)
      .add('cff', ComponentType.D_FLIPFLOP)
      .wire(p('ld', 'out'), p('nld', 'in1'))
      .wire(p('clk', 'out'), p('a', 'CLK'))
      .wire(p('gnd', 'out'), p('a', 'CLR'))
      .wire(p('ld', 'out'), p('a', 'Ld'))
      .wire(p('nld', 'out'), p('a', 'RS'))
      .wire(p('gnd', 'out'), p('a', 'Lin'))
      .wire(p('clk', 'out'), p('bb', 'CLK'))
      .wire(p('gnd', 'out'), p('bb', 'CLR'))
      .wire(p('ld', 'out'), p('bb', 'Ld'))
      .wire(p('nld', 'out'), p('bb', 'RS'))
      .wire(p('gnd', 'out'), p('bb', 'Lin'))
      .wire(p('clk', 'out'), p('res', 'CLK'))
      .wire(p('rclr', 'out'), p('res', 'CLR'))
      .wire(p('gnd', 'out'), p('res', 'Ld'))
      .wire(p('nld', 'out'), p('res', 'RS'))
      .wire(p('fa', 'Sum'), p('res', 'Lin'))
      .wire(p('a', 'Q0'), p('fa', 'X'))
      .wire(p('bb', 'Q0'), p('fa', 'Y'))
      .wire(p('cff', 'Q'), p('fa', 'Cin'))
      .wire(p('clk', 'out'), p('cff', 'CLK'))
      .wire(p('vcc', 'out'), p('cff', 'S'))
      .wire(p('crst', 'out'), p('cff', 'R'))
      .wire(p('fa', 'Cout'), p('cff', 'D'))
    for (let i = 0; i < 4; i++) {
      b.switch(`ai${i}`, ZERO).wire(p(`ai${i}`, 'out'), p('a', `D${i}`))
      b.switch(`bi${i}`, ZERO).wire(p(`bi${i}`, 'out'), p('bb', `D${i}`))
    }
    return b.build()
  }

  /** Loads the operands, runs four bit times and returns {sum, carry}. */
  function add(c: Circuit, x: number, y: number): { sum: number; carry: LogicValue } {
    c.reset()
    const vals: Record<string, LogicValue> = { clk: ZERO, ld: ONE, rclr: ONE, crst: ZERO }
    for (let i = 0; i < 4; i++) {
      vals[`ai${i}`] = bit((x >> i) & 1)
      vals[`bi${i}`] = bit((y >> i) & 1)
    }
    c.setMany(vals)
    c.pulse('clk')
    c.setMany({ ld: ZERO, rclr: ZERO, crst: ONE })
    for (let k = 0; k < 4; k++) c.pulse('clk')
    return { sum: parseInt(c.vec('res', 'Q', 4), 2), carry: c.pin(p('cff', 'Q')) }
  }

  it('loads the operands and clears the result on the load clock', () => {
    const c = serialAdder()
    c.setMany({ ld: ONE, rclr: ONE, crst: ZERO, ai0: ONE, ai1: ONE, bi1: ONE })
    c.pulse('clk')
    expect(c.vec('a', 'Q', 4)).toBe('0011')
    expect(c.vec('bb', 'Q', 4)).toBe('0010')
    expect(c.vec('res', 'Q', 4)).toBe('0000')
    expect(c.pin(p('cff', 'Q'))).toBe(ZERO)
  })

  it('11 + 6 gives sum 1 with a carry out (bit-serial, LSB first)', () => {
    const c = serialAdder()
    expect(add(c, 11, 6)).toEqual({ sum: 1, carry: ONE })
  })

  it.each([
    [0, 0],
    [1, 0],
    [0, 1],
    [7, 8],
    [8, 8],
    [15, 1],
    [9, 9],
    [5, 10],
    [12, 3],
    [15, 15]
  ])('adds %i + %i bit-serially', (x, y) => {
    const c = serialAdder()
    expect(add(c, x, y)).toEqual({ sum: (x + y) % 16, carry: bit(x + y > 15 ? 1 : 0) })
  })

  it('adds every 4-bit operand pair correctly (all 256)', () => {
    const c = serialAdder()
    const bad: string[] = []
    for (let x = 0; x < 16; x++) {
      for (let y = 0; y < 16; y++) {
        const got = add(c, x, y)
        const wantSum = (x + y) % 16
        const wantCarry = bit(x + y > 15 ? 1 : 0)
        if (got.sum !== wantSum || got.carry !== wantCarry) {
          bad.push(`${x}+${y} -> ${got.sum}/${got.carry} (want ${wantSum}/${wantCarry})`)
        }
      }
    }
    expect(bad).toEqual([])
  })

  it('the operand registers are empty after four bit times (zeroes shifted in)', () => {
    const c = serialAdder()
    add(c, 13, 6)
    expect(c.vec('a', 'Q', 4)).toBe('0000')
    expect(c.vec('bb', 'Q', 4)).toBe('0000')
  })
})

// ================================================================================
// 10. Widths at the ends of the N-bit range
// ================================================================================

describe('shift-register equivalence at the ends of the width range', () => {
  it('2-bit left shift register matches its two-flip-flop chain over 20 serial bits', () => {
    const r = new ShiftRig(ComponentType.N_SHIFT_LEFT, 2).clear()
    r.setMany({ LS: ONE })
    let expected = '00'
    const seen: string[] = []
    const want: string[] = []
    for (const ch of '10110001110100101101') {
      r.setMany({ Rin: charToValue(ch) })
      r.pulse()
      expected = expected.slice(1) + ch
      seen.push(r.agreed())
      want.push(expected)
    }
    expect(seen).toEqual(want)
  })

  it('16-bit right shift register matches its flip-flop chain over 20 serial bits', () => {
    const r = new ShiftRig(ComponentType.N_SHIFT_RIGHT, 16).clear()
    r.setMany({ RS: ONE })
    let expected = '0'.repeat(16)
    const seen: string[] = []
    const want: string[] = []
    for (const ch of '11010010110100011110') {
      r.setMany({ Lin: charToValue(ch) })
      r.pulse()
      expected = ch + expected.slice(0, 15)
      seen.push(r.agreed())
      want.push(expected)
    }
    expect(seen).toEqual(want)
  })

  it('16-bit register loads and holds a wide pattern', () => {
    const r = new RegisterRig(16)
    r.setMany({ CLR: ZERO, Ld: ONE })
    r.setD('1011001110001111')
    r.pulse()
    expect(r.agreed()).toBe('1011001110001111')
    r.setMany({ Ld: ZERO })
    r.setD('0000000000000000')
    r.pulse()
    expect(r.agreed()).toBe('1011001110001111')
  })

  it('2-bit counter agrees with its flip-flop version through eight wraps', () => {
    const r = new CounterRig(false, 2).clear()
    r.setMany({ En: ONE })
    const seen: string[] = []
    const want: string[] = []
    for (let k = 1; k <= 32; k++) {
      r.pulse()
      seen.push(r.agreed())
      want.push(bin(k, 2))
    }
    expect(seen).toEqual(want)
  })
})

// ================================================================================
// 11. Sequential timing corners
// ================================================================================

describe('sequential timing corners', () => {
  it('a flip-flop whose clock ticks faster than its delay swallows the pulse (decision 2)', () => {
    const b = new CircuitBuilder('inertial-ff').add('vcc', ComponentType.VCC)
    const clk = addSignal(b, 'sclk', [
      [0, ZERO],
      [10, ONE],
      [12, ZERO],
      [13, ONE],
      [30, ZERO]
    ])
    const dat = addSignal(b, 'sd', [
      [0, ONE],
      [11, ZERO]
    ])
    const rst = addSignal(b, 'srst', [
      [0, ZERO],
      [5, ONE]
    ])
    b.add('u', ComponentType.D_FLIPFLOP, { delay: 5 })
      .wire(p('vcc', 'out'), p('u', 'S'))
      .wire(rst, p('u', 'R'))
      .wire(clk, p('u', 'CLK'))
      .wire(dat, p('u', 'D'))
      .probe('pq')
      .wire(p('u', 'Q'), p('pq', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 60 })
    const c = b.build()
    c.go()
    expect(trace(c, 'pq')).toEqual([[0, ZERO]])
  })

  it('the same waveform with a 2 ns flip-flop does show the short pulse', () => {
    const b = new CircuitBuilder('inertial-ff-fast').add('vcc', ComponentType.VCC)
    const clk = addSignal(b, 'sclk', [
      [0, ZERO],
      [10, ONE],
      [12, ZERO],
      [13, ONE],
      [30, ZERO]
    ])
    const dat = addSignal(b, 'sd', [
      [0, ONE],
      [11, ZERO]
    ])
    const rst = addSignal(b, 'srst', [
      [0, ZERO],
      [5, ONE]
    ])
    b.add('u', ComponentType.D_FLIPFLOP, { delay: 2 })
      .wire(p('vcc', 'out'), p('u', 'S'))
      .wire(rst, p('u', 'R'))
      .wire(clk, p('u', 'CLK'))
      .wire(dat, p('u', 'D'))
      .probe('pq')
      .wire(p('u', 'Q'), p('pq', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 60 })
    const c = b.build()
    c.go()
    expect(trace(c, 'pq')).toEqual([
      [0, ZERO],
      [12, ONE],
      [15, ZERO]
    ])
  })

  it('Go is relative: three Go runs advance the counter by five edges each', () => {
    const b = new CircuitBuilder('relative-go')
      .add('clk', ComponentType.CLOCK)
      .add('vcc', ComponentType.VCC)
      .add('ctr', ComponentType.N_COUNTER, { bits: 4 })
      .wire(p('clk', 'out'), p('ctr', 'CLK'))
      .wire(p('vcc', 'out'), p('ctr', 'En'))
    addSignal(b, 'clrsig', [
      [0, ZERO],
      [25, ONE]
    ])
    b.wire(p('clrsig', 'out'), p('ctr', 'CLR'))
    const c = b.setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 100 }).build()
    c.go()
    expect(c.time).toBe(95)
    expect(c.vec('ctr', 'Q', 4)).toBe(bin(3, 4)) // edges at 40, 60, 80 after the clear at 20
    c.go()
    expect(c.time).toBe(195)
    expect(c.vec('ctr', 'Q', 4)).toBe(bin(8, 4))
    c.go()
    expect(c.time).toBe(295)
    expect(c.vec('ctr', 'Q', 4)).toBe(bin(13, 4))
  })

  it('a counter clocked by a divide-by-2 flip-flop advances at half the rate', () => {
    const b = new CircuitBuilder('two-domains')
      .add('clk', ComponentType.CLOCK)
      .add('vcc', ComponentType.VCC)
      .add('ctr', ComponentType.N_COUNTER, { bits: 4 })
    addSignal(b, 'rst', [
      [0, ZERO],
      [5, ONE]
    ])
    addSignal(b, 'clrsig', [
      [0, ZERO],
      [25, ONE]
    ])
    b.add('div', ComponentType.D_FLIPFLOP)
      .wire(p('vcc', 'out'), p('div', 'S'))
      .wire(p('rst', 'out'), p('div', 'R'))
      .wire(p('div', "Q'"), p('div', 'D'))
      .wire(p('clk', 'out'), p('div', 'CLK'))
      .wire(p('div', 'Q'), p('ctr', 'CLK'))
      .wire(p('vcc', 'out'), p('ctr', 'En'))
      .wire(p('clrsig', 'out'), p('ctr', 'CLR'))
      .probe('pq0')
      .wire(p('ctr', 'Q0'), p('pq0', 'in'))
    const c = b.setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 200 }).build()
    c.go()
    // The divider rises at 21, 61, 101, 141, 181; the first of those still has CLR = 0.
    expect(trace(c, 'pq0')).toEqual([
      [0, X],
      [22, ZERO],
      [62, ONE],
      [102, ZERO],
      [142, ONE],
      [182, ZERO]
    ])
    expect(c.vec('ctr', 'Q', 4)).toBe(bin(4, 4))
  })

  it('every bit of a counter that changes at one edge records exactly one probe sample', () => {
    const b = new CircuitBuilder('one-sample')
      .switch('clk', ZERO)
      .switch('clr', ZERO)
      .add('vcc', ComponentType.VCC)
      .add('ctr', ComponentType.N_COUNTER, { bits: 4 })
      .wire(p('clk', 'out'), p('ctr', 'CLK'))
      .wire(p('vcc', 'out'), p('ctr', 'En'))
      .wire(p('clr', 'out'), p('ctr', 'CLR'))
    for (let i = 0; i < 4; i++) b.probe(`pq${i}`).wire(p('ctr', `Q${i}`), p(`pq${i}`, 'in'))
    const c = b.build()
    c.pulse('clk') // CLR = 0 -> 0000
    c.set('clr', ONE)
    for (let k = 0; k < 7; k++) c.pulse('clk') // up to 0111
    expect(c.vec('ctr', 'Q', 4)).toBe('0111')
    const before = range(4).map((i) => trace(c, `pq${i}`).length)
    c.pulse('clk') // 0111 -> 1000: all four bits change in the same instant
    expect(c.vec('ctr', 'Q', 4)).toBe('1000')
    const after = range(4).map((i) => trace(c, `pq${i}`).length)
    expect(after.map((n, i) => n - before[i])).toEqual([1, 1, 1, 1])
    const times = range(4).map((i) => trace(c, `pq${i}`).slice(-1)[0][0])
    expect(new Set(times).size).toBe(1)
  })

  it('probe traces of a sequential circuit never step backwards in time (decision 13)', () => {
    const b = new CircuitBuilder('no-replay')
      .add('clk', ComponentType.CLOCK)
      .add('vcc', ComponentType.VCC)
      .switch('clr', ZERO)
      .add('ctr', ComponentType.N_COUNTER, { bits: 3 })
      .wire(p('clk', 'out'), p('ctr', 'CLK'))
      .wire(p('vcc', 'out'), p('ctr', 'En'))
      .wire(p('clr', 'out'), p('ctr', 'CLR'))
      .probe('pq0')
      .wire(p('ctr', 'Q0'), p('pq0', 'in'))
    const c = b.setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 100 }).build()
    // Toggle switches first (LIVE mode advances time), then start the clock.
    c.set('clr', ONE)
    c.set('clr', ZERO)
    c.go()
    const ts = trace(c, 'pq0').map(([t]) => t)
    expect(ts).toEqual([...ts].sort((a, b2) => a - b2))
    expect(new Set(ts).size).toBe(ts.length)
  })
})

// ================================================================================
// 12. Decoding a counter: ripple glitches vs a clean synchronous transition
// ================================================================================

describe('a 3-to-8 decoder on a counter', () => {
  function decodedRipple(): Circuit {
    const b = new CircuitBuilder('decoded-ripple')
      .add('clk', ComponentType.CLOCK)
      .add('vcc', ComponentType.VCC)
      .add('dec', ComponentType.DECODER_3TO8)
    addSignal(b, 'rst', [
      [0, ZERO],
      [5, ONE]
    ])
    for (let i = 0; i < 3; i++) {
      b.add(`j${i}`, ComponentType.JK_FLIPFLOP)
        .wire(p('vcc', 'out'), p(`j${i}`, 'J'))
        .wire(p('vcc', 'out'), p(`j${i}`, 'K'))
        .wire(p('vcc', 'out'), p(`j${i}`, 'S'))
        .wire(p('rst', 'out'), p(`j${i}`, 'R'))
        .wire(i === 0 ? p('clk', 'out') : p(`j${i - 1}`, 'Q'), p(`j${i}`, 'CLK'))
    }
    b.wire(p('j2', 'Q'), p('dec', 'A')).wire(p('j1', 'Q'), p('dec', 'B')).wire(p('j0', 'Q'), p('dec', 'C'))
    for (let i = 0; i < 8; i++) b.probe(`po${i}`).wire(p('dec', `out${i}`), p(`po${i}`, 'in'))
    return b.setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 200 }).build()
  }

  function decodedSync(): Circuit {
    const b = new CircuitBuilder('decoded-sync')
      .add('clk', ComponentType.CLOCK)
      .add('vcc', ComponentType.VCC)
      .add('ctr', ComponentType.N_COUNTER, { bits: 3 })
      .add('dec', ComponentType.DECODER_3TO8)
      .wire(p('clk', 'out'), p('ctr', 'CLK'))
      .wire(p('vcc', 'out'), p('ctr', 'En'))
    addSignal(b, 'clrsig', [
      [0, ZERO],
      [25, ONE]
    ])
    b.wire(p('clrsig', 'out'), p('ctr', 'CLR'))
      .wire(p('ctr', 'Q2'), p('dec', 'A'))
      .wire(p('ctr', 'Q1'), p('dec', 'B'))
      .wire(p('ctr', 'Q0'), p('dec', 'C'))
    for (let i = 0; i < 8; i++) b.probe(`po${i}`).wire(p('dec', `out${i}`), p(`po${i}`, 'in'))
    return b.setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 200 }).build()
  }

  it('the ripple counter makes the decoder glitch through 2 and 0 on the 3 -> 4 step', () => {
    const c = decodedRipple()
    c.go()
    expect(trace(c, 'po3')).toEqual([
      [0, ZERO],
      [52, ONE],
      [72, ZERO]
    ])
    expect(trace(c, 'po2')).toEqual([
      [0, ZERO],
      [33, ONE],
      [52, ZERO],
      [72, ONE],
      [73, ZERO],
      [193, ONE]
    ])
    expect(trace(c, 'po0')).toEqual([
      [0, ONE],
      [12, ZERO],
      [32, ONE],
      [33, ZERO],
      [73, ONE],
      [74, ZERO],
      [154, ONE],
      [172, ZERO],
      [192, ONE],
      [193, ZERO]
    ])
    expect(trace(c, 'po4')).toEqual([
      [0, ZERO],
      [74, ONE],
      [92, ZERO],
      [112, ONE],
      [113, ZERO],
      [153, ONE],
      [154, ZERO]
    ])
  })

  it('the synchronous counter decodes 3 -> 4 with no intermediate output at all', () => {
    const c = decodedSync()
    c.go()
    expect(trace(c, 'po3')).toEqual([
      [0, X],
      [22, ZERO],
      [82, ONE],
      [102, ZERO]
    ])
    expect(trace(c, 'po4')).toEqual([
      [0, X],
      [22, ZERO],
      [102, ONE],
      [122, ZERO]
    ])
    expect(trace(c, 'po2')).toEqual([
      [0, X],
      [22, ZERO],
      [62, ONE],
      [82, ZERO]
    ])
    expect(trace(c, 'po0')).toEqual([
      [0, X],
      [22, ONE],
      [42, ZERO],
      [182, ONE]
    ])
  })

  it('exactly one decoder output is high in every settled state of the synchronous counter', () => {
    const b = new CircuitBuilder('decoded-static')
      .switch('clk', ZERO)
      .switch('clr', ZERO)
      .add('vcc', ComponentType.VCC)
      .add('ctr', ComponentType.N_COUNTER, { bits: 3 })
      .add('dec', ComponentType.DECODER_3TO8)
      .wire(p('clk', 'out'), p('ctr', 'CLK'))
      .wire(p('vcc', 'out'), p('ctr', 'En'))
      .wire(p('clr', 'out'), p('ctr', 'CLR'))
      .wire(p('ctr', 'Q2'), p('dec', 'A'))
      .wire(p('ctr', 'Q1'), p('dec', 'B'))
      .wire(p('ctr', 'Q0'), p('dec', 'C'))
    const c = b.build()
    c.pulse('clk')
    c.set('clr', ONE)
    for (let k = 0; k < 16; k++) {
      const count = k % 8
      const highs = range(8).filter((i) => c.pin(p('dec', `out${i}`)) === ONE)
      expect(highs).toEqual([count])
      c.pulse('clk')
    }
  })
})

// ================================================================================
// 13. Composite control: state machine + counter, and a checker over a chain
// ================================================================================

describe('a state machine controlling a counter', () => {
  function countAndHalt(): Circuit {
    return new CircuitBuilder('count-halt')
      .switch('clk', ZERO)
      .switch('clr', ONE)
      .add('ctr', ComponentType.N_COUNTER, { bits: 4 })
      .add('sm', ComponentType.STATE_MACHINE, {
        smInputs: 1,
        smOutputs: 1,
        pinLabels: { in1: 'K', out1: 'En' },
        smTable: [
          { present: '0', input: "K'", output: 'En', next: '0' },
          { present: '0', input: 'K', output: '0', next: '1' },
          { present: '1', input: '-', output: '0', next: '1' }
        ]
      })
      .wire(p('clk', 'out'), p('ctr', 'CLK'))
      .wire(p('clk', 'out'), p('sm', 'CLK'))
      .wire(p('clr', 'out'), p('ctr', 'CLR'))
      .wire(p('ctr', 'K'), p('sm', 'in1'))
      .wire(p('sm', 'out1'), p('ctr', 'En'))
      .build()
  }

  it('counts 0..15 then halts, leaving the machine in its stopped state', () => {
    const c = countAndHalt()
    c.set('clr', ZERO)
    c.pulse('clk')
    c.set('clr', ONE)
    expect(c.vec('ctr', 'Q', 4)).toBe('0000')
    expect(c.pin(p('sm', 'out1'))).toBe(ONE) // K = 0 -> enabled
    const seen: number[] = []
    for (let k = 0; k < 24; k++) {
      c.pulse('clk')
      seen.push(parseInt(c.vec('ctr', 'Q', 4), 2))
    }
    const want = [...range(15).map((i) => i + 1), ...new Array(9).fill(15)]
    expect(seen).toEqual(want)
    expect(c.pin(p('ctr', 'K'))).toBe(ONE)
    expect(c.pin(p('sm', 'out1'))).toBe(ZERO)
    expect(c.sim.getSmDisplays()[p('sm', 'state')]).toBe('1')
  })

  it('the enable output drops asynchronously as soon as K rises', () => {
    const c = countAndHalt()
    c.set('clr', ZERO)
    c.pulse('clk')
    c.set('clr', ONE)
    for (let k = 0; k < 14; k++) c.pulse('clk')
    expect(c.vec('ctr', 'Q', 4)).toBe('1110')
    expect(c.pin(p('sm', 'out1'))).toBe(ONE)
    c.pulse('clk')
    expect(c.vec('ctr', 'Q', 4)).toBe('1111')
    expect(c.pin(p('ctr', 'K'))).toBe(ONE)
    expect(c.pin(p('sm', 'out1'))).toBe(ZERO) // Mealy output, no clock needed
    expect(c.sim.getSmDisplays()[p('sm', 'state')]).toBe('0') // state moves on the NEXT edge
  })
})

describe('a checker verifying a two-stage flip-flop delay line', () => {
  function checkerChain(stages: number, chk: { input: string; output: string }): Circuit {
    const b = new CircuitBuilder(`chk-${stages}`)
      .add('clk', ComponentType.CLOCK)
      .add('vcc', ComponentType.VCC)
      .add('chk', ComponentType.CHECKER, { chk })
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 400 })
    for (let i = 1; i <= stages; i++) {
      b.add(`f${i}`, ComponentType.D_FLIPFLOP)
        .wire(p('vcc', 'out'), p(`f${i}`, 'S'))
        .wire(p('vcc', 'out'), p(`f${i}`, 'R'))
        .wire(p('clk', 'out'), p(`f${i}`, 'CLK'))
        .wire(i === 1 ? p('chk', 'out') : p(`f${i - 1}`, 'Q'), p(`f${i}`, 'D'))
    }
    b.wire(p(`f${stages}`, 'Q'), p('chk', 'in'))
    return b.build()
  }

  const INPUT = '01101001'

  it('passes when the expected sequence is the input delayed by two slots', () => {
    const c = checkerChain(2, { input: INPUT, output: 'XX011010' })
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 6, sampled: 6, failures: 0 })
    expect(c.sim.getSmDisplays()[p('chk', 'result')]).toBe('PASS')
  })

  it('fails when only one flip-flop is in the path', () => {
    const c = checkerChain(1, { input: INPUT, output: 'XX011010' })
    c.go()
    const result = c.sim.getCheckerResult()
    expect(result?.sampled).toBe(6)
    expect(result?.failures).toBeGreaterThan(0)
    expect(c.sim.getSmDisplays()[p('chk', 'result')]).toBe('FAIL')
  })

  it('fails when three flip-flops are in the path', () => {
    const c = checkerChain(3, { input: INPUT, output: 'XX011010' })
    c.go()
    expect(c.sim.getCheckerResult()?.failures).toBeGreaterThan(0)
  })

  it('an all-X expectation never fails no matter what the chain does', () => {
    const c = checkerChain(2, { input: INPUT, output: 'XXXXXXXX' })
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 0, sampled: 0, failures: 0 })
    expect(c.sim.getSmDisplays()[p('chk', 'result')]).toBe('READY')
  })
})

// ================================================================================
// 14. Serial capture, slow parts and CHANGE mode
// ================================================================================

describe('serial capture of an INPUT_SIGNAL stream by a shift register', () => {
  it('captures one bit per clock period and shows the exact settle times', () => {
    const b = new CircuitBuilder('serial-capture')
      .add('clk', ComponentType.CLOCK)
      .add('vcc', ComponentType.VCC)
      .add('gnd', ComponentType.GROUND)
      .add('u', ComponentType.N_SHIFT_RIGHT, { bits: 4 })
      .wire(p('clk', 'out'), p('u', 'CLK'))
      .wire(p('gnd', 'out'), p('u', 'Ld'))
      .wire(p('vcc', 'out'), p('u', 'RS'))
    addSignal(b, 'clrsig', [
      [0, ONE],
      [25, ZERO]
    ])
    addSignal(b, 'din', [
      [0, ZERO],
      [25, ONE],
      [45, ZERO],
      [65, ONE],
      [105, ZERO],
      [125, ONE],
      [145, ZERO]
    ])
    b.wire(p('clrsig', 'out'), p('u', 'CLR')).wire(p('din', 'out'), p('u', 'Lin'))
    for (let i = 0; i < 4; i++) b.wire(p('gnd', 'out'), p('u', `D${i}`))
    b.probe('pq3').wire(p('u', 'Q3'), p('pq3', 'in'))
    b.probe('pq0').wire(p('u', 'Q0'), p('pq0', 'in'))
    const c = b.setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 200 }).build()
    c.go()
    expect(trace(c, 'pq3')).toEqual([
      [0, X],
      [21, ZERO],
      [41, ONE],
      [61, ZERO],
      [81, ONE],
      [121, ZERO],
      [141, ONE],
      [161, ZERO]
    ])
    expect(trace(c, 'pq0')).toEqual([
      [0, X],
      [21, ZERO],
      [101, ONE],
      [121, ZERO],
      [141, ONE],
      [181, ZERO]
    ])
    expect(c.vec('u', 'Q', 4)).toBe('0010')
  })
})

describe('an accumulator with a slow register', () => {
  it('settles the register at edge + 4 and the adder at edge + 5', () => {
    const b = new CircuitBuilder('slow-acc')
      .add('clk', ComponentType.CLOCK)
      .add('vcc', ComponentType.VCC)
      .add('gnd', ComponentType.GROUND)
      .add('reg', ComponentType.N_REGISTER, { bits: 4, delay: 4 })
      .add('add', ComponentType.N_ADDER, { bits: 4, delay: 1 })
      .probe('pq0')
      .probe('ps0')
      .wire(p('clk', 'out'), p('reg', 'CLK'))
      .wire(p('vcc', 'out'), p('reg', 'Ld'))
      .wire(p('gnd', 'out'), p('add', 'Cin'))
      .wire(p('reg', 'Q0'), p('pq0', 'in'))
      .wire(p('add', 'S0'), p('ps0', 'in'))
    addSignal(b, 'clrsig', [
      [0, ONE],
      [25, ZERO]
    ])
    b.wire(p('clrsig', 'out'), p('reg', 'CLR'))
    for (let i = 0; i < 4; i++) {
      b.wire(i < 2 ? p('vcc', 'out') : p('gnd', 'out'), p('add', `Y${i}`)) // Y = 3
        .wire(p('reg', `Q${i}`), p('add', `X${i}`))
        .wire(p('add', `S${i}`), p('reg', `D${i}`))
    }
    const c = b.setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 200 }).build()
    c.go()
    expect(trace(c, 'pq0')).toEqual([
      [0, X],
      [24, ZERO],
      [44, ONE],
      [64, ZERO],
      [84, ONE],
      [104, ZERO],
      [124, ONE],
      [144, ZERO],
      [164, ONE],
      [184, ZERO]
    ])
    expect(trace(c, 'ps0')).toEqual([
      [0, X],
      [25, ONE],
      [45, ZERO],
      [65, ONE],
      [85, ZERO],
      [105, ONE],
      [125, ZERO],
      [145, ONE],
      [165, ZERO],
      [185, ONE]
    ])
    expect(c.vec('reg', 'Q', 4)).toBe(bin(24, 4))
  })
})

describe('CHANGE mode (one queued event at a time) on a sequential circuit', () => {
  /** A toggle-flip-flop chain cleared through the active-low R switch `rst`. */
  function divider(stages: number): Circuit {
    const b = new CircuitBuilder(`change-${stages}`)
      .switch('clk', ZERO)
      .switch('rst', ZERO)
      .add('vcc', ComponentType.VCC)
    for (let i = 1; i <= stages; i++) {
      b.add(`f${i}`, ComponentType.D_FLIPFLOP)
        .wire(p('vcc', 'out'), p(`f${i}`, 'S'))
        .wire(p('rst', 'out'), p(`f${i}`, 'R'))
        .wire(p(`f${i}`, "Q'"), p(`f${i}`, 'D'))
        .wire(i === 1 ? p('clk', 'out') : p(`f${i - 1}`, 'Q'), p(`f${i}`, 'CLK'))
    }
    const c = b.build()
    c.set('rst', ONE) // release the asynchronous clear; every Q starts at 0
    return c
  }

  const chainState = (c: Circuit, stages: number): string =>
    range(stages)
      .map((i) => c.pin(p(`f${stages - i}`, 'Q')))
      .join('')

  it('a single change step does not settle the whole chain', () => {
    const c = divider(3)
    const before = chainState(c, 3)
    expect(before).toBe('000')
    c.sim.toggle('clk', false)
    expect(c.sim.changeStep()).toBe(true)
    expect(chainState(c, 3)).toBe(before) // only the switch output moved
    let guard = 0
    while (c.sim.changeStep()) if (++guard > 100) throw new Error('did not settle')
    expect(chainState(c, 3)).not.toBe(before)
  })

  it('stepping event by event reaches the same state as a normal settle', () => {
    const stepped = divider(3)
    const settled = divider(3)
    expect(chainState(stepped, 3)).toBe(chainState(settled, 3))
    for (let k = 0; k < 12; k++) {
      for (const level of [ONE, ZERO]) {
        settled.set('clk', level)
        stepped.sim.toggle('clk', false)
        let guard = 0
        while (stepped.sim.changeStep()) if (++guard > 200) throw new Error('did not settle')
      }
      expect(chainState(stepped, 3)).toBe(chainState(settled, 3))
    }
  })

  it('change-step times never move backwards', () => {
    const c = divider(3)
    c.sim.toggle('clk', false)
    const times: number[] = []
    let guard = 0
    while (c.sim.changeStep()) {
      times.push(c.sim.time)
      if (++guard > 100) throw new Error('did not settle')
    }
    expect(times.length).toBeGreaterThan(1)
    expect(times).toEqual([...times].sort((a, b2) => a - b2))
  })
})

// ================================================================================
// 15. Clock integrity, gated clocks and X propagation through sequential loops
// ================================================================================

describe('undetermined clock levels in a sequential chain', () => {
  /** One toggle flip-flop whose clock comes from a 4-valued source. */
  function toggleStage(): { c: Circuit; clk: (v: LogicValue) => void } {
    const b = new CircuitBuilder('xclock').add('vcc', ComponentType.VCC).switch('rst', ZERO)
    const clk = addSrc(b, 'ck', ZERO)
    b.add('f', ComponentType.D_FLIPFLOP)
      .wire(p('vcc', 'out'), p('f', 'S'))
      .wire(p('rst', 'out'), p('f', 'R'))
      .wire(p('f', "Q'"), p('f', 'D'))
      .wire(clk, p('f', 'CLK'))
    const c = b.build()
    c.set('rst', ONE)
    return { c, clk: (v) => drive(c, { ck: v }) }
  }

  it('0 -> X -> 1 is not a rising edge, but 1 -> 0 -> 1 afterwards is', () => {
    const { c, clk } = toggleStage()
    expect(c.pin(p('f', 'Q'))).toBe(ZERO)
    clk(X)
    clk(ONE)
    expect(c.pin(p('f', 'Q'))).toBe(ZERO)
    clk(ZERO)
    clk(ONE)
    expect(c.pin(p('f', 'Q'))).toBe(ONE)
  })

  it('0 -> Z -> 1 is not a rising edge either', () => {
    const { c, clk } = toggleStage()
    clk(Z)
    clk(ONE)
    expect(c.pin(p('f', 'Q'))).toBe(ZERO)
  })

  it('an X clock does not corrupt the stored value', () => {
    const { c, clk } = toggleStage()
    clk(ONE)
    expect(c.pin(p('f', 'Q'))).toBe(ONE)
    clk(X)
    expect(c.pin(p('f', 'Q'))).toBe(ONE)
    clk(Z)
    expect(c.pin(p('f', 'Q'))).toBe(ONE)
    clk(ZERO)
    expect(c.pin(p('f', 'Q'))).toBe(ONE)
  })

  it('a divide-by-2 stage fed by an X clock leaves the following stage untouched', () => {
    const b = new CircuitBuilder('xclock-chain').add('vcc', ComponentType.VCC).switch('rst', ZERO)
    const clk = addSrc(b, 'ck', ZERO)
    for (const id of ['f1', 'f2']) {
      b.add(id, ComponentType.D_FLIPFLOP)
        .wire(p('vcc', 'out'), p(id, 'S'))
        .wire(p('rst', 'out'), p(id, 'R'))
        .wire(p(id, "Q'"), p(id, 'D'))
    }
    b.wire(clk, p('f1', 'CLK')).wire(p('f1', 'Q'), p('f2', 'CLK'))
    const c = b.build()
    c.set('rst', ONE)
    for (const v of [ONE, ZERO, ONE, ZERO]) drive(c, { ck: v })
    expect(c.pin(p('f1', 'Q'))).toBe(ZERO)
    expect(c.pin(p('f2', 'Q'))).toBe(ONE)
    drive(c, { ck: X })
    drive(c, { ck: ONE })
    expect(c.pin(p('f1', 'Q'))).toBe(ZERO)
    expect(c.pin(p('f2', 'Q'))).toBe(ONE)
  })
})

describe('a gated clock', () => {
  function gated(): Circuit {
    return new CircuitBuilder('gated-clock')
      .switch('clk', ZERO)
      .switch('gate', ONE)
      .switch('clr', ONE)
      .add('vcc', ComponentType.VCC)
      .add('and', ComponentType.AND2)
      .add('ctr', ComponentType.N_COUNTER, { bits: 4 })
      .wire(p('clk', 'out'), p('and', 'in1'))
      .wire(p('gate', 'out'), p('and', 'in2'))
      .wire(p('and', 'out'), p('ctr', 'CLK'))
      .wire(p('vcc', 'out'), p('ctr', 'En'))
      .wire(p('clr', 'out'), p('ctr', 'CLR'))
      .build()
  }

  function cleared(): Circuit {
    const c = gated()
    c.set('clr', ZERO)
    c.pulse('clk')
    c.set('clr', ONE)
    expect(c.vec('ctr', 'Q', 4)).toBe('0000')
    return c
  }

  it('counts normally while the gate is open', () => {
    const c = cleared()
    for (let k = 1; k <= 5; k++) {
      c.pulse('clk')
      expect(c.vec('ctr', 'Q', 4)).toBe(bin(k, 4))
    }
  })

  it('a closed gate blocks the clock entirely', () => {
    const c = cleared()
    c.set('gate', ZERO)
    for (let k = 0; k < 5; k++) {
      c.pulse('clk')
      expect(c.vec('ctr', 'Q', 4)).toBe('0000')
    }
  })

  it('opening the gate while the clock is high produces a real edge (classic hazard)', () => {
    const c = cleared()
    c.setMany({ gate: ZERO })
    c.set('clk', ONE) // gated clock stays low
    expect(c.vec('ctr', 'Q', 4)).toBe('0000')
    c.set('gate', ONE) // gated clock rises now: the counter sees an edge
    expect(c.vec('ctr', 'Q', 4)).toBe('0001')
    c.set('gate', ZERO) // falling edge: no count
    expect(c.vec('ctr', 'Q', 4)).toBe('0001')
    c.set('clk', ZERO)
    expect(c.vec('ctr', 'Q', 4)).toBe('0001')
  })

  it('toggling the gate while the clock is low never produces an edge', () => {
    const c = cleared()
    c.set('clk', ZERO)
    for (let k = 0; k < 4; k++) {
      c.set('gate', ZERO)
      c.set('gate', ONE)
      expect(c.vec('ctr', 'Q', 4)).toBe('0000')
    }
  })
})

describe('X propagating around a register/adder loop', () => {
  it('one dangling D bit makes the whole accumulator undetermined after two clocks', () => {
    const b = new CircuitBuilder('dangling-d')
      .switch('clk', ZERO)
      .switch('clr', ZERO)
      .add('vcc', ComponentType.VCC)
      .add('gnd', ComponentType.GROUND)
      .add('reg', ComponentType.N_REGISTER, { bits: 4 })
      .add('add', ComponentType.N_ADDER, { bits: 4 })
      .wire(p('clk', 'out'), p('reg', 'CLK'))
      .wire(p('vcc', 'out'), p('reg', 'Ld'))
      .wire(p('clr', 'out'), p('reg', 'CLR'))
      .wire(p('gnd', 'out'), p('add', 'Cin'))
    for (let i = 0; i < 4; i++) {
      b.wire(i < 2 ? p('vcc', 'out') : p('gnd', 'out'), p('add', `Y${i}`)) // Y = 3
        .wire(p('reg', `Q${i}`), p('add', `X${i}`))
      if (i < 3) b.wire(p('add', `S${i}`), p('reg', `D${i}`)) // D3 is left dangling
    }
    const c = b.build()
    c.set('clr', ONE)
    c.pulse('clk')
    c.set('clr', ZERO)
    expect(c.vec('reg', 'Q', 4)).toBe('0000')
    c.pulse('clk')
    expect(c.vec('reg', 'Q', 4)).toBe('X011') // D3 unconnected -> X, low bits are 0 + 3
    expect(c.vec('add', 'S', 4)).toBe('XXXX') // an X operand bit makes the whole sum X
    c.pulse('clk')
    expect(c.vec('reg', 'Q', 4)).toBe('XXXX')
    c.set('clr', ONE)
    c.pulse('clk')
    expect(c.vec('reg', 'Q', 4)).toBe('0000') // CLR recovers the loop
  })
})

describe('a register looped through bus parts complements itself every clock', () => {
  function busLoop(): Circuit {
    const b = new CircuitBuilder('bus-loop')
      .switch('clk', ZERO)
      .switch('clr', ZERO)
      .switch('en', ONE)
      .add('vcc', ComponentType.VCC)
      .add('reg', ComponentType.N_REGISTER, { bits: 4 })
      .add('mg', ComponentType.MERGER, { bits: 4 })
      .add('cp', ComponentType.COMPLEMENTER, { bits: 4 })
      .add('sp', ComponentType.SPLITTER, { bits: 4 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
      .wire(p('clk', 'out'), p('reg', 'CLK'))
      .wire(p('vcc', 'out'), p('reg', 'Ld'))
      .wire(p('clr', 'out'), p('reg', 'CLR'))
      .wire(p('mg', 'out'), p('cp', 'in'))
      .wire(p('mg', 'out'), p('bp', 'in'))
      .wire(p('en', 'out'), p('cp', 'en'))
      .wire(p('cp', 'out'), p('sp', 'in'))
    for (let i = 0; i < 4; i++) {
      b.wire(p('reg', `Q${i}`), p('mg', `in${i}`)).wire(p('sp', `out${i}`), p('reg', `D${i}`))
    }
    const c = b.build()
    c.set('clr', ONE)
    c.pulse('clk')
    c.set('clr', ZERO)
    return c
  }

  it('alternates 0 and F on the bus while the complementer is enabled', () => {
    const c = busLoop()
    expect(c.bus(p('bp', 'in'))).toBe('0')
    const seen: string[] = []
    for (let k = 0; k < 6; k++) {
      c.pulse('clk')
      seen.push(c.bus(p('bp', 'in')))
    }
    expect(seen).toEqual(['F', '0', 'F', '0', 'F', '0'])
  })

  it('holds its value when the complementer only passes the bus through', () => {
    const c = busLoop()
    c.pulse('clk')
    expect(c.bus(p('bp', 'in'))).toBe('F')
    c.set('en', ZERO)
    for (let k = 0; k < 5; k++) {
      c.pulse('clk')
      expect(c.bus(p('bp', 'in'))).toBe('F')
    }
    c.set('en', ONE)
    c.pulse('clk')
    expect(c.bus(p('bp', 'in'))).toBe('0')
  })

  it.each([X, Z])('an undetermined complementer enable (%s) makes the loop X', (v) => {
    const b = new CircuitBuilder('bus-loop-x')
      .switch('clk', ZERO)
      .switch('clr', ZERO)
      .add('vcc', ComponentType.VCC)
      .add('reg', ComponentType.N_REGISTER, { bits: 4 })
      .add('mg', ComponentType.MERGER, { bits: 4 })
      .add('cp', ComponentType.COMPLEMENTER, { bits: 4 })
      .add('sp', ComponentType.SPLITTER, { bits: 4 })
      .wire(p('clk', 'out'), p('reg', 'CLK'))
      .wire(p('vcc', 'out'), p('reg', 'Ld'))
      .wire(p('clr', 'out'), p('reg', 'CLR'))
      .wire(p('mg', 'out'), p('cp', 'in'))
      .wire(p('cp', 'out'), p('sp', 'in'))
    const en = addSrc(b, 'en', v)
    b.wire(en, p('cp', 'en'))
    for (let i = 0; i < 4; i++) {
      b.wire(p('reg', `Q${i}`), p('mg', `in${i}`)).wire(p('sp', `out${i}`), p('reg', `D${i}`))
    }
    const c = b.build()
    c.set('clr', ONE)
    c.pulse('clk')
    c.set('clr', ZERO)
    expect(c.vec('reg', 'Q', 4)).toBe('0000')
    c.pulse('clk')
    expect(c.vec('reg', 'Q', 4)).toBe('XXXX')
  })
})

describe('plain counter randomized cross-check', () => {
  it('part, flip-flop version and the Appendix A model agree over 150 random steps', () => {
    const r = new CounterRig(false, 4)
    const rnd = lcg(0xa5a5)
    const pick = (): LogicValue => [ZERO, ONE, ONE, ONE, ZERO, ONE, X, Z][rnd() % 8]
    let model = 'XXXX'
    const parts: string[] = []
    const chains: string[] = []
    const models: string[] = []
    for (let step = 0; step < 150; step++) {
      const ctl = { CLR: pick(), En: pick() }
      r.setMany(ctl)
      r.pulse()
      model = modelCounter(false, model, ctl, '0000')
      parts.push(r.part())
      chains.push(r.ffs())
      models.push(model)
    }
    expect(parts).toEqual(models)
    expect(chains).toEqual(models)
  })
})

// ================================================================================
// 16. Inverted clocks and reset-time clock levels
// ================================================================================

describe('a clock that reaches the flip-flop through an inverter', () => {
  /** Toggle flip-flop clocked by NOT(clk); `rst` is the active-low asynchronous clear. */
  function invertedClock(initial: LogicValue): Circuit {
    const c = new CircuitBuilder('inv-clock')
      .switch('clk', initial)
      .switch('rst', ZERO)
      .add('vcc', ComponentType.VCC)
      .add('inv', ComponentType.NOT)
      .add('f', ComponentType.D_FLIPFLOP)
      .wire(p('clk', 'out'), p('inv', 'in1'))
      .wire(p('inv', 'out'), p('f', 'CLK'))
      .wire(p('vcc', 'out'), p('f', 'S'))
      .wire(p('rst', 'out'), p('f', 'R'))
      .wire(p('f', "Q'"), p('f', 'D'))
      .build()
    c.set('rst', ONE)
    return c
  }

  it('settling the inverter at reset is not treated as a clock edge (switch low)', () => {
    const c = invertedClock(ZERO)
    expect(c.pin(p('inv', 'out'))).toBe(ONE)
    expect(c.pin(p('f', 'Q'))).toBe(ZERO)
  })

  it('settling the inverter at reset is not treated as a clock edge (switch high)', () => {
    const c = invertedClock(ONE)
    expect(c.pin(p('inv', 'out'))).toBe(ZERO)
    expect(c.pin(p('f', 'Q'))).toBe(ZERO)
  })

  it('the flip-flop toggles on the FALLING edge of the switch', () => {
    const c = invertedClock(ZERO)
    c.set('clk', ONE) // inverted clock falls: no toggle
    expect(c.pin(p('f', 'Q'))).toBe(ZERO)
    c.set('clk', ZERO) // inverted clock rises: toggle
    expect(c.pin(p('f', 'Q'))).toBe(ONE)
    c.set('clk', ONE)
    expect(c.pin(p('f', 'Q'))).toBe(ONE)
    c.set('clk', ZERO)
    expect(c.pin(p('f', 'Q'))).toBe(ZERO)
  })

  it('a counter behind an inverter counts on the switch falling edges only', () => {
    const b = new CircuitBuilder('inv-counter')
      .switch('clk', ZERO)
      .switch('clr', ONE)
      .add('vcc', ComponentType.VCC)
      .add('inv', ComponentType.NOT)
      .add('ctr', ComponentType.N_COUNTER, { bits: 3 })
      .wire(p('clk', 'out'), p('inv', 'in1'))
      .wire(p('inv', 'out'), p('ctr', 'CLK'))
      .wire(p('vcc', 'out'), p('ctr', 'En'))
      .wire(p('clr', 'out'), p('ctr', 'CLR'))
    const c = b.build()
    c.set('clr', ZERO)
    c.set('clk', ONE)
    c.set('clk', ZERO) // inverted rising edge -> clear takes effect
    c.set('clr', ONE)
    expect(c.vec('ctr', 'Q', 3)).toBe('000')
    const seen: string[] = []
    for (let k = 1; k <= 9; k++) {
      c.set('clk', ONE)
      seen.push(c.vec('ctr', 'Q', 3)) // rising switch edge: nothing
      c.set('clk', ZERO)
      seen.push(c.vec('ctr', 'Q', 3)) // falling switch edge: count
    }
    const want: string[] = []
    for (let k = 1; k <= 9; k++) want.push(bin(k - 1, 3), bin(k, 3))
    expect(seen).toEqual(want)
  })

  it('two flip-flops on opposite clock phases form a shift register that moves one bit per full cycle', () => {
    const b = new CircuitBuilder('two-phase')
      .switch('clk', ZERO)
      .switch('din', ZERO)
      .switch('rst', ZERO)
      .add('vcc', ComponentType.VCC)
      .add('inv', ComponentType.NOT)
      .wire(p('clk', 'out'), p('inv', 'in1'))
    for (const id of ['fa', 'fb']) {
      b.add(id, ComponentType.D_FLIPFLOP)
        .wire(p('vcc', 'out'), p(id, 'S'))
        .wire(p('rst', 'out'), p(id, 'R'))
    }
    b.wire(p('clk', 'out'), p('fa', 'CLK'))
      .wire(p('inv', 'out'), p('fb', 'CLK'))
      .wire(p('din', 'out'), p('fa', 'D'))
      .wire(p('fa', 'Q'), p('fb', 'D'))
    const c = b.build()
    c.set('rst', ONE)
    expect(c.pin(p('fa', 'Q'))).toBe(ZERO)
    expect(c.pin(p('fb', 'Q'))).toBe(ZERO)
    c.set('din', ONE)
    c.set('clk', ONE) // fa captures on the rising edge
    expect(c.pin(p('fa', 'Q'))).toBe(ONE)
    expect(c.pin(p('fb', 'Q'))).toBe(ZERO)
    c.set('clk', ZERO) // fb captures on the falling edge (inverted rising)
    expect(c.pin(p('fb', 'Q'))).toBe(ONE)
    c.set('din', ZERO)
    c.set('clk', ONE)
    expect(c.pin(p('fa', 'Q'))).toBe(ZERO)
    expect(c.pin(p('fb', 'Q'))).toBe(ONE)
    c.set('clk', ZERO)
    expect(c.pin(p('fb', 'Q'))).toBe(ZERO)
  })
})

// ================================================================================
// 17. Checker 'R' soft-resets the sequential circuit under test (decision 8)
// ================================================================================

describe("a checker 'R' slot resets the circuit under test", () => {
  function delayLine(chk: { input: string; output: string }): Circuit {
    return new CircuitBuilder('chk-reset')
      .add('clk', ComponentType.CLOCK)
      .add('vcc', ComponentType.VCC)
      .add('chk', ComponentType.CHECKER, { chk })
      .add('f', ComponentType.D_FLIPFLOP)
      .wire(p('vcc', 'out'), p('f', 'S'))
      .wire(p('vcc', 'out'), p('f', 'R'))
      .wire(p('clk', 'out'), p('f', 'CLK'))
      .wire(p('chk', 'out'), p('f', 'D'))
      .wire(p('f', 'Q'), p('chk', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 200 })
      .build()
  }

  it('passes when the slots after R are expected to be undetermined again', () => {
    const c = delayLine({ input: '0110R110', output: 'X011XX11' })
    c.go()
    expect(c.sim.getCheckerResult()).toEqual({ total: 5, sampled: 5, failures: 0 })
    expect(c.sim.getSmDisplays()[p('chk', 'result')]).toBe('PASS')
  })

  it('fails when the slot right after R is expected to still hold the old value', () => {
    const c = delayLine({ input: '0110R110', output: 'X011011' + '1' })
    c.go()
    expect(c.sim.getCheckerResult()?.failures).toBeGreaterThan(0)
  })

  it('the flip-flop is undetermined again immediately after the R slot is driven', () => {
    const c = delayLine({ input: '0110R110', output: 'X011XX11' })
    for (let i = 0; i < 5; i++) c.step() // through the edge that starts slot 4
    expect(c.time).toBe(95)
    expect(c.pin(p('f', 'Q'))).toBe(X)
  })
})
