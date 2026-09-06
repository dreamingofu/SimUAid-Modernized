// Integration tests: arithmetic composed from primitives (half adders, full adders,
// ripple-carry adders, subtractors) compared against the FULL_ADDER / N_ADDER parts
// and against plain arithmetic. Also covers settle time and inertial-delay behavior
// of composed circuits (spec IMPLEMENTATION DECISIONS 2 and the delay model).

import { describe, expect, it } from 'vitest'
import { ComponentType, LogicValue, type PinId } from '../../model/types'
import { CircuitBuilder, Circuit, p } from './harness'

const { ZERO, ONE, X, Z } = LogicValue
const { XOR2, AND2, OR2, NOT, FULL_ADDER, N_ADDER, VCC } = ComponentType

// ---------------------------------------------------------------------------
// Local helpers (the harness has no composite builders).
// ---------------------------------------------------------------------------

/** MSB-first bit string of `n` (width `bits`). */
function toBits(n: number, bits: number): string {
  return n.toString(2).padStart(bits, '0')
}

/** Switch map `prefix{bits-1}..prefix0` for the number `n` (bit 0 = LSB). */
function numSwitches(prefix: string, n: number, bits: number): Record<string, LogicValue> {
  const out: Record<string, LogicValue> = {}
  for (let i = 0; i < bits; i++) out[`${prefix}${i}`] = (n >> i) & 1 ? ONE : ZERO
  return out
}

/** Values of arbitrary pin ids as an MSB-first string (pins listed LSB-first). */
function vecOf(c: Circuit, pins: PinId[]): string {
  let s = ''
  for (let i = pins.length - 1; i >= 0; i--) s += c.pin(pins[i])
  return s
}

interface HalfAdder {
  sum: PinId
  carry: PinId
}

interface GateDelays {
  xor?: number
  and?: number
  or?: number
}

/** XOR2 + AND2 half adder fed from pins `a` and `b`. */
function addHalfAdder(b: CircuitBuilder, id: string, a: PinId, bb: PinId, d: GateDelays = {}): HalfAdder {
  const xorId = `${id}_xor`
  const andId = `${id}_and`
  b.add(xorId, XOR2, { delay: d.xor ?? 1 }).add(andId, AND2, { delay: d.and ?? 1 })
  b.wire(a, p(xorId, 'in1')).wire(a, p(andId, 'in1'))
  b.wire(bb, p(xorId, 'in2')).wire(bb, p(andId, 'in2'))
  return { sum: p(xorId, 'out'), carry: p(andId, 'out') }
}

interface FullAdderPins {
  sum: PinId
  cout: PinId
}

/** Two half adders + OR2 full adder. */
function addGateFullAdder(
  b: CircuitBuilder,
  id: string,
  x: PinId,
  y: PinId,
  cin: PinId,
  d: GateDelays = {}
): FullAdderPins {
  const h1 = addHalfAdder(b, `${id}_h1`, x, y, d)
  const h2 = addHalfAdder(b, `${id}_h2`, h1.sum, cin, d)
  const orId = `${id}_or`
  b.add(orId, OR2, { delay: d.or ?? 1 })
  b.wire(h1.carry, p(orId, 'in1')).wire(h2.carry, p(orId, 'in2'))
  return { sum: h2.sum, cout: p(orId, 'out') }
}

/** Places a FULL_ADDER part `id` wired to the given pins; returns its outputs. */
function addPartFullAdder(
  b: CircuitBuilder,
  id: string,
  x: PinId | null,
  y: PinId | null,
  cin: PinId | null,
  delay = 1
): FullAdderPins {
  b.add(id, FULL_ADDER, { delay })
  if (x) b.wire(x, p(id, 'X'))
  if (y) b.wire(y, p(id, 'Y'))
  if (cin) b.wire(cin, p(id, 'Cin'))
  return { sum: p(id, 'Sum'), cout: p(id, 'Cout') }
}

/** Ripple-carry chain of FULL_ADDER parts fa0..fa{n-1}; returns sum pins (LSB-first) and Cout. */
function addPartRipple(
  b: CircuitBuilder,
  id: string,
  xs: PinId[],
  ys: PinId[],
  cin: PinId | null,
  delays: number[] | number = 1
): { sums: PinId[]; cout: PinId } {
  const sums: PinId[] = []
  let carry: PinId | null = cin
  for (let i = 0; i < xs.length; i++) {
    const d = typeof delays === 'number' ? delays : delays[i]
    const fa = addPartFullAdder(b, `${id}${i}`, xs[i], ys[i], carry, d)
    sums.push(fa.sum)
    carry = fa.cout
  }
  return { sums, cout: carry! }
}

/** Adds switches prefix0..prefix{n-1} (all 0) and returns their output pins LSB-first. */
function addSwitchVec(b: CircuitBuilder, prefix: string, n: number): PinId[] {
  const pins: PinId[] = []
  for (let i = 0; i < n; i++) {
    b.switch(`${prefix}${i}`, ZERO)
    pins.push(p(`${prefix}${i}`, 'out'))
  }
  return pins
}

/** Wires an N_ADDER `id` (width n) to the given pins. */
function addNAdder(
  b: CircuitBuilder,
  id: string,
  n: number,
  xs: (PinId | null)[],
  ys: (PinId | null)[],
  cin: PinId | null
): { sums: PinId[]; cout: PinId } {
  b.add(id, N_ADDER, { bits: n })
  for (let i = 0; i < n; i++) {
    const x = xs[i]
    const y = ys[i]
    if (x) b.wire(x, p(id, `X${i}`))
    if (y) b.wire(y, p(id, `Y${i}`))
  }
  if (cin) b.wire(cin, p(id, 'Cin'))
  const sums: PinId[] = []
  for (let i = 0; i < n; i++) sums.push(p(id, `S${i}`))
  return { sums, cout: p(id, 'Cout') }
}

/** An X-valued source: a NOT gate with its input unconnected (NOT(Z) = X). */
function addXSource(b: CircuitBuilder, id: string): PinId {
  b.add(id, NOT)
  return p(id, 'out')
}

/** All (x, y, cin) rows for an n-bit adder, with expected sum bits and carry. */
function adderRows(n: number): [string, string, LogicValue, string, LogicValue][] {
  const rows: [string, string, LogicValue, string, LogicValue][] = []
  const max = 1 << n
  for (let x = 0; x < max; x++) {
    for (let y = 0; y < max; y++) {
      for (let c = 0; c < 2; c++) {
        const total = x + y + c
        rows.push([toBits(x, n), toBits(y, n), c ? ONE : ZERO, toBits(total & (max - 1), n), total >> n ? ONE : ZERO])
      }
    }
  }
  return rows
}

/** Sets x/y switch vectors and cin from MSB-first strings. */
function applyOperands(c: Circuit, xBits: string, yBits: string, cin: LogicValue): void {
  const n = xBits.length
  c.setMany({
    ...numSwitches('x', parseInt(xBits, 2), n),
    ...numSwitches('y', parseInt(yBits, 2), n),
    cin
  })
}

// ---------------------------------------------------------------------------
// (1) Half adder from XOR2 + AND2
// ---------------------------------------------------------------------------

describe('half adder from XOR2 + AND2', () => {
  function build(): { c: Circuit; ha: HalfAdder } {
    const b = new CircuitBuilder().switch('a', ZERO).switch('b', ZERO)
    const ha = addHalfAdder(b, 'ha', p('a', 'out'), p('b', 'out'))
    return { c: b.build(), ha }
  }

  it.each([
    [ZERO, ZERO, ZERO, ZERO],
    [ZERO, ONE, ONE, ZERO],
    [ONE, ZERO, ONE, ZERO],
    [ONE, ONE, ZERO, ONE]
  ])('a=%s b=%s -> sum=%s carry=%s', (a, bv, sum, carry) => {
    const { c, ha } = build()
    c.setMany({ a, b: bv })
    expect(c.pin(ha.sum)).toBe(sum)
    expect(c.pin(ha.carry)).toBe(carry)
  })

  it('all four combinations in sequence on one circuit', () => {
    const { c, ha } = build()
    for (const [a, bv] of [
      [ZERO, ZERO],
      [ONE, ZERO],
      [ONE, ONE],
      [ZERO, ONE],
      [ZERO, ZERO],
      [ONE, ONE]
    ] as [LogicValue, LogicValue][]) {
      c.setMany({ a, b: bv })
      const n = (a === ONE ? 1 : 0) + (bv === ONE ? 1 : 0)
      expect(c.pin(ha.sum)).toBe(n % 2 ? ONE : ZERO)
      expect(c.pin(ha.carry)).toBe(n === 2 ? ONE : ZERO)
    }
  })

  it('unconnected b: sum is X; carry is 0 when a=0 and X when a=1', () => {
    const b = new CircuitBuilder().switch('a', ZERO)
    b.add('ha_xor', XOR2).add('ha_and', AND2)
    b.wire(p('a', 'out'), p('ha_xor', 'in1')).wire(p('a', 'out'), p('ha_and', 'in1'))
    const c = b.build()
    expect(c.pin(p('ha_xor', 'in2'))).toBe(Z)
    expect(c.pin(p('ha_xor', 'out'))).toBe(X)
    expect(c.pin(p('ha_and', 'out'))).toBe(ZERO)
    c.set('a', ONE)
    expect(c.pin(p('ha_xor', 'out'))).toBe(X)
    expect(c.pin(p('ha_and', 'out'))).toBe(X)
  })

  it('X-driven a: sum is X; carry is 0 when b=0 and X when b=1', () => {
    const b = new CircuitBuilder().switch('b', ZERO)
    const xs = addXSource(b, 'xsrc')
    const ha = addHalfAdder(b, 'ha', xs, p('b', 'out'))
    const c = b.build()
    expect(c.pin(xs)).toBe(X)
    expect(c.pin(ha.sum)).toBe(X)
    expect(c.pin(ha.carry)).toBe(ZERO)
    c.set('b', ONE)
    expect(c.pin(ha.sum)).toBe(X)
    expect(c.pin(ha.carry)).toBe(X)
  })

  it('both inputs unconnected: sum X, carry X', () => {
    const b = new CircuitBuilder()
    b.add('ha_xor', XOR2).add('ha_and', AND2)
    const c = b.build()
    expect(c.pin(p('ha_xor', 'out'))).toBe(X)
    expect(c.pin(p('ha_and', 'out'))).toBe(X)
  })
})

// ---------------------------------------------------------------------------
// (2) Full adder from two half adders + OR2 vs the FULL_ADDER part
// ---------------------------------------------------------------------------

describe('full adder: two half adders + OR2 vs FULL_ADDER part', () => {
  function build(): { c: Circuit; gate: FullAdderPins; part: FullAdderPins } {
    const b = new CircuitBuilder().switch('x', ZERO).switch('y', ZERO).switch('cin', ZERO)
    const gate = addGateFullAdder(b, 'g', p('x', 'out'), p('y', 'out'), p('cin', 'out'))
    const part = addPartFullAdder(b, 'fa', p('x', 'out'), p('y', 'out'), p('cin', 'out'))
    return { c: b.build(), gate, part }
  }

  const rows: [LogicValue, LogicValue, LogicValue, LogicValue, LogicValue][] = []
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? ONE : ZERO
    const y = i & 2 ? ONE : ZERO
    const cin = i & 4 ? ONE : ZERO
    const total = (i & 1) + ((i >> 1) & 1) + ((i >> 2) & 1)
    rows.push([x, y, cin, total % 2 ? ONE : ZERO, total >= 2 ? ONE : ZERO])
  }

  it.each(rows)('x=%s y=%s cin=%s -> sum=%s cout=%s (gates and part agree)', (x, y, cin, sum, cout) => {
    const { c, gate, part } = build()
    c.setMany({ x, y, cin })
    expect(c.pin(gate.sum)).toBe(sum)
    expect(c.pin(gate.cout)).toBe(cout)
    expect(c.pin(part.sum)).toBe(sum)
    expect(c.pin(part.cout)).toBe(cout)
  })

  it('walks through all 8 combinations on one circuit and outputs stay identical', () => {
    const { c, gate, part } = build()
    const order = [0, 1, 3, 7, 6, 4, 5, 2, 0, 7, 0]
    for (const i of order) {
      const x = i & 1 ? ONE : ZERO
      const y = i & 2 ? ONE : ZERO
      const cin = i & 4 ? ONE : ZERO
      c.setMany({ x, y, cin })
      const total = (i & 1) + ((i >> 1) & 1) + ((i >> 2) & 1)
      expect(c.pin(part.sum)).toBe(total % 2 ? ONE : ZERO)
      expect(c.pin(part.cout)).toBe(total >= 2 ? ONE : ZERO)
      expect(c.pin(gate.sum)).toBe(c.pin(part.sum))
      expect(c.pin(gate.cout)).toBe(c.pin(part.cout))
    }
  })

  describe('FULL_ADDER part with an unconnected input gives X on both outputs', () => {
    it.each(['X', 'Y', 'Cin'])('pin %s unconnected', (open) => {
      const b = new CircuitBuilder().switch('x', ZERO).switch('y', ZERO).switch('cin', ZERO)
      const part = addPartFullAdder(
        b,
        'fa',
        open === 'X' ? null : p('x', 'out'),
        open === 'Y' ? null : p('y', 'out'),
        open === 'Cin' ? null : p('cin', 'out')
      )
      const c = b.build()
      expect(c.pin(p('fa', open))).toBe(Z)
      for (const combo of [
        [ZERO, ZERO, ZERO],
        [ONE, ONE, ONE],
        [ONE, ZERO, ONE],
        [ZERO, ONE, ZERO]
      ] as LogicValue[][]) {
        c.setMany({ x: combo[0], y: combo[1], cin: combo[2] })
        expect(c.pin(part.sum)).toBe(X)
        expect(c.pin(part.cout)).toBe(X)
      }
    })
  })

  describe('FULL_ADDER part with an X-driven input gives X on both outputs', () => {
    it.each(['X', 'Y', 'Cin'])('pin %s driven X', (xPin) => {
      const b = new CircuitBuilder().switch('x', ZERO).switch('y', ZERO).switch('cin', ZERO)
      const xs = addXSource(b, 'xsrc')
      const part = addPartFullAdder(
        b,
        'fa',
        xPin === 'X' ? xs : p('x', 'out'),
        xPin === 'Y' ? xs : p('y', 'out'),
        xPin === 'Cin' ? xs : p('cin', 'out')
      )
      const c = b.build()
      expect(c.pin(p('fa', xPin))).toBe(X)
      for (const combo of [
        [ZERO, ZERO, ZERO],
        [ONE, ONE, ONE],
        [ONE, ZERO, ONE]
      ] as LogicValue[][]) {
        c.setMany({ x: combo[0], y: combo[1], cin: combo[2] })
        expect(c.pin(part.sum)).toBe(X)
        expect(c.pin(part.cout)).toBe(X)
      }
    })
  })

  it('gate full adder with unconnected Cin: sum X; cout follows controlling values', () => {
    const b = new CircuitBuilder().switch('x', ZERO).switch('y', ZERO)
    b.add('open', NOT) // 'open#in1' is an unconnected net used as the Z source
    const gate = addGateFullAdder(b, 'g', p('x', 'out'), p('y', 'out'), p('open', 'in1'))
    const c = b.build()
    // x=y=0: h1.carry=0, h1.sum=0, h2.carry = AND(0, Z) = 0 -> OR(0,0)=0
    expect(c.pin(gate.sum)).toBe(X)
    expect(c.pin(gate.cout)).toBe(ZERO)
    // x=y=1: h1.carry=1 -> OR(1, *) = 1
    c.setMany({ x: ONE, y: ONE })
    expect(c.pin(gate.sum)).toBe(X)
    expect(c.pin(gate.cout)).toBe(ONE)
    // x!=y: h1.carry=0, h1.sum=1, h2.carry = AND(1, Z) = X -> OR(0, X) = X
    c.setMany({ x: ONE, y: ZERO })
    expect(c.pin(gate.sum)).toBe(X)
    expect(c.pin(gate.cout)).toBe(X)
    c.setMany({ x: ZERO, y: ONE })
    expect(c.pin(gate.sum)).toBe(X)
    expect(c.pin(gate.cout)).toBe(X)
  })

  it('gate full adder with unconnected X: sum X; cout 0 only when y=cin=0, 1 when y=cin=1', () => {
    const b = new CircuitBuilder().switch('y', ZERO).switch('cin', ZERO)
    b.add('open', NOT)
    const gate = addGateFullAdder(b, 'g', p('open', 'in1'), p('y', 'out'), p('cin', 'out'))
    const c = b.build()
    expect(c.pin(gate.sum)).toBe(X)
    expect(c.pin(gate.cout)).toBe(ZERO) // AND(Z,0)=0, XOR=X, AND(X,0)=0 -> 0
    c.setMany({ y: ONE, cin: ONE })
    expect(c.pin(gate.sum)).toBe(X)
    expect(c.pin(gate.cout)).toBe(X) // AND(Z,1)=X, AND(X,1)=X -> OR(X,X)=X
    c.setMany({ y: ONE, cin: ZERO })
    expect(c.pin(gate.sum)).toBe(X)
    expect(c.pin(gate.cout)).toBe(X) // AND(Z,1)=X, AND(X,0)=0 -> OR(X,0)=X
    c.setMany({ y: ZERO, cin: ONE })
    expect(c.pin(gate.sum)).toBe(X)
    expect(c.pin(gate.cout)).toBe(X) // AND(Z,0)=0, AND(X,1)=X -> X
  })
})

// ---------------------------------------------------------------------------
// (3) 4-bit ripple carry from four FULL_ADDER parts vs N_ADDER(4)
// ---------------------------------------------------------------------------

describe('4-bit ripple-carry (4 x FULL_ADDER) vs N_ADDER(4)', () => {
  function build(): { c: Circuit; ripple: { sums: PinId[]; cout: PinId }; nadd: { sums: PinId[]; cout: PinId } } {
    const b = new CircuitBuilder()
    const xs = addSwitchVec(b, 'x', 4)
    const ys = addSwitchVec(b, 'y', 4)
    b.switch('cin', ZERO)
    const cin = p('cin', 'out')
    const ripple = addPartRipple(b, 'fa', xs, ys, cin)
    const nadd = addNAdder(b, 'add', 4, xs, ys, cin)
    return { c: b.build(), ripple, nadd }
  }

  const shared = build()

  it.each(adderRows(4))('x=%s y=%s cin=%s -> sum=%s cout=%s', (xb, yb, cin, sum, cout) => {
    const { c, ripple, nadd } = shared
    applyOperands(c, xb, yb, cin)
    expect(vecOf(c, ripple.sums)).toBe(sum)
    expect(c.pin(ripple.cout)).toBe(cout)
    expect(vecOf(c, nadd.sums)).toBe(sum)
    expect(c.pin(nadd.cout)).toBe(cout)
    expect(c.oscillated).toBe(false)
  })

  it('all 512 combinations from a fresh circuit each time (no dependence on history)', () => {
    for (const [xb, yb, cin, sum, cout] of adderRows(4)) {
      const { c, ripple, nadd } = build()
      applyOperands(c, xb, yb, cin)
      expect(vecOf(c, ripple.sums)).toBe(sum)
      expect(c.pin(ripple.cout)).toBe(cout)
      expect(vecOf(c, nadd.sums)).toBe(sum)
      expect(c.pin(nadd.cout)).toBe(cout)
    }
  })

  it('after reset both adders show 0000 + 0000 + 0 = 0000, carry 0 at t=0', () => {
    const { c, ripple, nadd } = build()
    expect(c.time).toBe(0)
    expect(vecOf(c, ripple.sums)).toBe('0000')
    expect(c.pin(ripple.cout)).toBe(ZERO)
    expect(vecOf(c, nadd.sums)).toBe('0000')
    expect(c.pin(nadd.cout)).toBe(ZERO)
  })

  it('unconnected Cin poisons every stage of the ripple and the whole N_ADDER', () => {
    const b = new CircuitBuilder()
    const xs = addSwitchVec(b, 'x', 4)
    const ys = addSwitchVec(b, 'y', 4)
    const ripple = addPartRipple(b, 'fa', xs, ys, null)
    const nadd = addNAdder(b, 'add', 4, xs, ys, null)
    const c = b.build()
    expect(vecOf(c, ripple.sums)).toBe('XXXX')
    expect(c.pin(ripple.cout)).toBe(X)
    expect(vecOf(c, nadd.sums)).toBe('XXXX')
    expect(c.pin(nadd.cout)).toBe(X)
    c.setMany({ ...numSwitches('x', 5, 4), ...numSwitches('y', 10, 4) })
    expect(vecOf(c, ripple.sums)).toBe('XXXX')
    expect(vecOf(c, nadd.sums)).toBe('XXXX')
  })

  it('unconnected X2 poisons ripple stages 2 and 3 only; N_ADDER goes all X', () => {
    const b = new CircuitBuilder()
    const xs = addSwitchVec(b, 'x', 4)
    const ys = addSwitchVec(b, 'y', 4)
    b.switch('cin', ZERO)
    const cin = p('cin', 'out')
    const xsOpen: (PinId | null)[] = [xs[0], xs[1], null, xs[3]]
    const ripple = addPartRipple(b, 'fa', xsOpen as PinId[], ys, cin)
    const nadd = addNAdder(b, 'add', 4, xsOpen, ys, cin)
    const c = b.build()
    // x = ?011 (bit 2 open), y = 0001 -> stages 0,1 clean (11 + 01 = 100 -> s0=0, s1=0, carry into stage 2 = 1)
    c.setMany({ ...numSwitches('x', 0b1011, 4), ...numSwitches('y', 0b0001, 4) })
    expect(c.pin(ripple.sums[0])).toBe(ZERO)
    expect(c.pin(ripple.sums[1])).toBe(ZERO)
    expect(c.pin(ripple.sums[2])).toBe(X)
    expect(c.pin(ripple.sums[3])).toBe(X)
    expect(c.pin(ripple.cout)).toBe(X)
    expect(vecOf(c, nadd.sums)).toBe('XXXX')
    expect(c.pin(nadd.cout)).toBe(X)
  })
})

// ---------------------------------------------------------------------------
// (4) 2-bit adder from gates only vs N_ADDER(2)
// ---------------------------------------------------------------------------

describe('2-bit adder from XOR/AND/OR gates vs N_ADDER(2)', () => {
  function build(): { c: Circuit; gate: { sums: PinId[]; cout: PinId }; nadd: { sums: PinId[]; cout: PinId } } {
    const b = new CircuitBuilder()
    const xs = addSwitchVec(b, 'x', 2)
    const ys = addSwitchVec(b, 'y', 2)
    b.switch('cin', ZERO)
    const cin = p('cin', 'out')
    const fa0 = addGateFullAdder(b, 'g0', xs[0], ys[0], cin)
    const fa1 = addGateFullAdder(b, 'g1', xs[1], ys[1], fa0.cout)
    const nadd = addNAdder(b, 'add', 2, xs, ys, cin)
    return { c: b.build(), gate: { sums: [fa0.sum, fa1.sum], cout: fa1.cout }, nadd }
  }

  const shared = build()

  it.each(adderRows(2))('x=%s y=%s cin=%s -> sum=%s cout=%s', (xb, yb, cin, sum, cout) => {
    const { c, gate, nadd } = shared
    applyOperands(c, xb, yb, cin)
    expect(vecOf(c, gate.sums)).toBe(sum)
    expect(c.pin(gate.cout)).toBe(cout)
    expect(vecOf(c, nadd.sums)).toBe(sum)
    expect(c.pin(nadd.cout)).toBe(cout)
  })

  it('every combination from a fresh circuit', () => {
    for (const [xb, yb, cin, sum, cout] of adderRows(2)) {
      const { c, gate, nadd } = build()
      applyOperands(c, xb, yb, cin)
      expect(vecOf(c, gate.sums)).toBe(sum)
      expect(c.pin(gate.cout)).toBe(cout)
      expect(vecOf(c, nadd.sums)).toBe(sum)
      expect(c.pin(nadd.cout)).toBe(cout)
    }
  })

  it('gate adder with unconnected cin: sums X; N_ADDER(2) all X', () => {
    const b = new CircuitBuilder()
    const xs = addSwitchVec(b, 'x', 2)
    const ys = addSwitchVec(b, 'y', 2)
    b.add('open', NOT)
    const fa0 = addGateFullAdder(b, 'g0', xs[0], ys[0], p('open', 'in1'))
    const fa1 = addGateFullAdder(b, 'g1', xs[1], ys[1], fa0.cout)
    const nadd = addNAdder(b, 'add', 2, xs, ys, null)
    const c = b.build()
    expect(c.pin(fa0.sum)).toBe(X)
    // x=y=00: fa0.cout = 0 (controlling), so stage 1 is clean: 0+0+0
    expect(c.pin(fa0.cout)).toBe(ZERO)
    expect(c.pin(fa1.sum)).toBe(ZERO)
    expect(c.pin(fa1.cout)).toBe(ZERO)
    expect(vecOf(c, nadd.sums)).toBe('XX')
    expect(c.pin(nadd.cout)).toBe(X)
    // x0=1, y0=0: fa0.cout = X -> stage 1 sum X
    c.setMany({ x0: ONE })
    expect(c.pin(fa0.cout)).toBe(X)
    expect(c.pin(fa1.sum)).toBe(X)
  })
})

// ---------------------------------------------------------------------------
// (5) 4-bit subtractor: N_ADDER + NOT gates on Y + Cin = 1
// ---------------------------------------------------------------------------

describe('4-bit subtractor: N_ADDER(4) with Y complemented and Cin=1', () => {
  function build(): { c: Circuit; sums: PinId[]; cout: PinId } {
    const b = new CircuitBuilder()
    const xs = addSwitchVec(b, 'x', 4)
    const ys = addSwitchVec(b, 'y', 4)
    b.add('vcc', VCC)
    const nots: PinId[] = []
    for (let i = 0; i < 4; i++) {
      b.add(`n${i}`, NOT)
      b.wire(ys[i], p(`n${i}`, 'in1'))
      nots.push(p(`n${i}`, 'out'))
    }
    const nadd = addNAdder(b, 'sub', 4, xs, nots, p('vcc', 'out'))
    return { c: b.build(), sums: nadd.sums, cout: nadd.cout }
  }

  const rows: [string, string, string, LogicValue][] = []
  for (let x = 0; x < 16; x++) {
    for (let y = 0; y < 16; y++) {
      rows.push([toBits(x, 4), toBits(y, 4), toBits((x - y) & 15, 4), x >= y ? ONE : ZERO])
    }
  }

  const shared = build()

  it.each(rows)('x=%s - y=%s = %s (not-borrow=%s)', (xb, yb, diff, notBorrow) => {
    const { c, sums, cout } = shared
    c.setMany({ ...numSwitches('x', parseInt(xb, 2), 4), ...numSwitches('y', parseInt(yb, 2), 4) })
    expect(vecOf(c, sums)).toBe(diff)
    expect(c.pin(cout)).toBe(notBorrow)
  })

  it('VCC drives Cin as a constant 1 from reset', () => {
    const { c } = build()
    expect(c.pin(p('sub', 'Cin'))).toBe(ONE)
    expect(c.pin(p('vcc', 'out'))).toBe(ONE)
  })

  it('0 - 0 = 0 with Cout=1 (no borrow) at reset', () => {
    const { c, sums, cout } = build()
    expect(vecOf(c, sums)).toBe('0000')
    expect(c.pin(cout)).toBe(ONE)
  })

  it('0 - 1 = 1111 with Cout=0 (borrow)', () => {
    const { c, sums, cout } = build()
    c.set('y0', ONE)
    expect(vecOf(c, sums)).toBe('1111')
    expect(c.pin(cout)).toBe(ZERO)
  })

  it('subtractor built with a switch for Cin: Cin=0 gives x - y - 1', () => {
    const b = new CircuitBuilder()
    const xs = addSwitchVec(b, 'x', 4)
    const ys = addSwitchVec(b, 'y', 4)
    b.switch('cin', ONE)
    const nots: PinId[] = []
    for (let i = 0; i < 4; i++) {
      b.add(`n${i}`, NOT)
      b.wire(ys[i], p(`n${i}`, 'in1'))
      nots.push(p(`n${i}`, 'out'))
    }
    const nadd = addNAdder(b, 'sub', 4, xs, nots, p('cin', 'out'))
    const c = b.build()
    c.setMany({ ...numSwitches('x', 9, 4), ...numSwitches('y', 3, 4) })
    expect(vecOf(c, nadd.sums)).toBe(toBits(6, 4))
    expect(c.pin(nadd.cout)).toBe(ONE)
    c.set('cin', ZERO)
    expect(vecOf(c, nadd.sums)).toBe(toBits(5, 4))
    expect(c.pin(nadd.cout)).toBe(ONE)
    c.setMany({ ...numSwitches('x', 3, 4), ...numSwitches('y', 3, 4) })
    expect(vecOf(c, nadd.sums)).toBe('1111') // 3 - 3 - 1 = -1
    expect(c.pin(nadd.cout)).toBe(ZERO)
  })
})

// ---------------------------------------------------------------------------
// (6) Settle time of the ripple chain
// ---------------------------------------------------------------------------

describe('settle time of a 4-stage FULL_ADDER ripple', () => {
  function build(faDelay: number): { c: Circuit; sums: PinId[]; cout: PinId } {
    const b = new CircuitBuilder()
    const xs = addSwitchVec(b, 'x', 4)
    const ys = addSwitchVec(b, 'y', 4)
    b.switch('cin', ZERO)
    const ripple = addPartRipple(b, 'fa', xs, ys, p('cin', 'out'), faDelay)
    b.probe('ps3').wire(ripple.sums[3], p('ps3', 'in'))
    b.probe('ps0').wire(ripple.sums[0], p('ps0', 'in'))
    b.probe('pc').wire(ripple.cout, p('pc', 'in'))
    return { c: b.build(), sums: ripple.sums, cout: ripple.cout }
  }

  it('all delays 1: 0110+0001 -> toggling X0 ripples through 4 stages in 1 (switch) + 4 ns', () => {
    const { c, sums, cout } = build(1)
    c.setMany({ ...numSwitches('x', 0b0110, 4), ...numSwitches('y', 0b0001, 4) })
    expect(vecOf(c, sums)).toBe('0111')
    const t0 = c.time
    c.set('x0', ONE) // 0111 + 0001 = 1000: carry through every stage
    expect(vecOf(c, sums)).toBe('1000')
    expect(c.pin(cout)).toBe(ZERO)
    const elapsed = c.time - t0
    expect(elapsed).toBeLessThanOrEqual(4 + 2)
    expect(elapsed).toBe(5)
  })

  it('all delays 1: probe on Sum3 records exactly one change, 5 ns after the toggle', () => {
    const { c } = build(1)
    c.setMany({ ...numSwitches('x', 0b0110, 4), ...numSwitches('y', 0b0001, 4) })
    const t0 = c.time
    c.set('x0', ONE)
    const trace = c.sim.getWaveforms().find((w) => w.probeId === 'ps3')!
    const after = trace.samples.filter((s) => s.t > t0)
    expect(after).toEqual([{ t: t0 + 5, v: ONE }])
    // Sum0 flips 2 ns after the toggle (switch delay + FA0 delay).
    const s0 = c.sim.getWaveforms().find((w) => w.probeId === 'ps0')!
    expect(s0.samples.filter((s) => s.t > t0)).toEqual([{ t: t0 + 2, v: ZERO }])
  })

  it('all delays 1: toggling X0 back (1000 -> 0111) also takes 5 ns', () => {
    const { c, sums } = build(1)
    c.setMany({ ...numSwitches('x', 0b0111, 4), ...numSwitches('y', 0b0001, 4) })
    expect(vecOf(c, sums)).toBe('1000')
    const t0 = c.time
    c.set('x0', ZERO)
    expect(vecOf(c, sums)).toBe('0111')
    expect(c.time - t0).toBe(5)
  })

  it('all delays 1: a change that only affects the top stage settles in 2 ns', () => {
    const { c, sums } = build(1)
    c.setMany({ ...numSwitches('x', 0b0110, 4), ...numSwitches('y', 0b0001, 4) })
    const t0 = c.time
    c.set('x3', ONE) // 1110 + 0001 = 1111, no carry movement
    expect(vecOf(c, sums)).toBe('1111')
    expect(c.time - t0).toBe(2)
  })

  it('all delays 1: 1111 + 0000, cin 0 -> 1 ripples out to Cout in 5 ns', () => {
    const { c, sums, cout } = build(1)
    c.setMany({ ...numSwitches('x', 0b1111, 4) })
    const t0 = c.time
    c.set('cin', ONE)
    expect(vecOf(c, sums)).toBe('0000')
    expect(c.pin(cout)).toBe(ONE)
    expect(c.time - t0).toBe(5)
    const trace = c.sim.getWaveforms().find((w) => w.probeId === 'pc')!
    expect(trace.samples.filter((s) => s.t > t0)).toEqual([{ t: t0 + 5, v: ONE }])
  })

  it('FULL_ADDER delay 3: the same carry chain takes 1 + 4*3 = 13 ns', () => {
    const { c, sums } = build(3)
    c.setMany({ ...numSwitches('x', 0b0110, 4), ...numSwitches('y', 0b0001, 4) })
    expect(vecOf(c, sums)).toBe('0111')
    const t0 = c.time
    c.set('x0', ONE)
    expect(vecOf(c, sums)).toBe('1000')
    expect(c.time - t0).toBe(13)
    const trace = c.sim.getWaveforms().find((w) => w.probeId === 'ps3')!
    expect(trace.samples.filter((s) => s.t > t0)).toEqual([{ t: t0 + 13, v: ONE }])
    const s0 = c.sim.getWaveforms().find((w) => w.probeId === 'ps0')!
    expect(s0.samples.filter((s) => s.t > t0)).toEqual([{ t: t0 + 4, v: ZERO }])
  })

  it('FULL_ADDER delay 3: a top-stage-only change settles in 1 + 3 = 4 ns', () => {
    const { c, sums } = build(3)
    c.setMany({ ...numSwitches('x', 0b0110, 4), ...numSwitches('y', 0b0001, 4) })
    const t0 = c.time
    c.set('x3', ONE)
    expect(vecOf(c, sums)).toBe('1111')
    expect(c.time - t0).toBe(4)
  })

  it('settle time from reset: initial operands are present at t=0 with no events pending', () => {
    const { c, sums } = build(1)
    expect(c.time).toBe(0)
    expect(vecOf(c, sums)).toBe('0000')
    // Setting operands that produce no carry chain settles in switch + one stage.
    c.setMany({ ...numSwitches('x', 0b0101, 4), ...numSwitches('y', 0b1010, 4) })
    expect(vecOf(c, sums)).toBe('1111')
    expect(c.time).toBe(2)
  })

  it('N_ADDER(4) settles in a single part delay regardless of the carry chain', () => {
    const b = new CircuitBuilder()
    const xs = addSwitchVec(b, 'x', 4)
    const ys = addSwitchVec(b, 'y', 4)
    b.switch('cin', ZERO)
    const nadd = addNAdder(b, 'add', 4, xs, ys, p('cin', 'out'))
    const c = b.build()
    c.setMany({ ...numSwitches('x', 0b0110, 4), ...numSwitches('y', 0b0001, 4) })
    const t0 = c.time
    c.set('x0', ONE)
    expect(vecOf(c, nadd.sums)).toBe('1000')
    expect(c.time - t0).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// (7) Mixed delays: operand paths with different delays still settle correctly
// ---------------------------------------------------------------------------

describe('mixed delays on operand paths (inertial delay, decision 2)', () => {
  /**
   * XOR2 (delay `xorDelay`) with `x` direct and `y` through two NOT gates (2 ns
   * extra). Toggling both switches together makes the XOR see (x', y) for 2 ns
   * before (x', y') arrives.
   */
  function buildSkewedXor(xorDelay: number): Circuit {
    const b = new CircuitBuilder().switch('x', ZERO).switch('y', ZERO)
    b.add('n1', NOT).add('n2', NOT).add('xor', XOR2, { delay: xorDelay }).probe('ps')
    b.wire(p('y', 'out'), p('n1', 'in1')).wire(p('n1', 'out'), p('n2', 'in1'))
    b.wire(p('x', 'out'), p('xor', 'in1')).wire(p('n2', 'out'), p('xor', 'in2'))
    b.wire(p('xor', 'out'), p('ps', 'in'))
    return b.build()
  }

  it('XOR delay 3 > 2 ns skew: the transient (x\',y) never reaches the output', () => {
    const c = buildSkewedXor(3)
    expect(c.pin(p('xor', 'out'))).toBe(ZERO)
    c.setMany({ x: ONE, y: ONE })
    expect(c.pin(p('xor', 'out'))).toBe(ZERO)
    const trace = c.sim.getWaveforms().find((w) => w.probeId === 'ps')!
    expect(trace.samples).toEqual([{ t: 0, v: ZERO }])
  })

  it('XOR delay 2 = skew: the transient appears as a 2 ns pulse', () => {
    const c = buildSkewedXor(2)
    c.setMany({ x: ONE, y: ONE })
    expect(c.pin(p('xor', 'out'))).toBe(ZERO)
    const trace = c.sim.getWaveforms().find((w) => w.probeId === 'ps')!
    // x arrives at 1 -> XOR schedules 1 at 3; y' arrives at 3 -> XOR schedules 0 at 5.
    expect(trace.samples).toEqual([
      { t: 0, v: ZERO },
      { t: 3, v: ONE },
      { t: 5, v: ZERO }
    ])
    expect(c.time).toBe(5)
  })

  it('XOR delay 1 < skew: the transient appears as a 2 ns pulse', () => {
    const c = buildSkewedXor(1)
    c.setMany({ x: ONE, y: ONE })
    expect(c.pin(p('xor', 'out'))).toBe(ZERO)
    const trace = c.sim.getWaveforms().find((w) => w.probeId === 'ps')!
    expect(trace.samples).toEqual([
      { t: 0, v: ZERO },
      { t: 2, v: ONE },
      { t: 4, v: ZERO }
    ])
  })

  it('skewed XOR: final value is always x xor y through every transition', () => {
    for (const d of [1, 2, 3, 5]) {
      const c = buildSkewedXor(d)
      const seq: [LogicValue, LogicValue][] = [
        [ONE, ONE],
        [ZERO, ONE],
        [ONE, ZERO],
        [ZERO, ZERO],
        [ONE, ONE],
        [ZERO, ZERO]
      ]
      for (const [x, y] of seq) {
        c.setMany({ x, y })
        expect(c.pin(p('xor', 'out'))).toBe(x === y ? ZERO : ONE)
        expect(c.oscillated).toBe(false)
      }
    }
  })

  function buildSkewedGateAdder(d: GateDelays): { c: Circuit; sums: PinId[]; cout: PinId } {
    const b = new CircuitBuilder()
    const xs = addSwitchVec(b, 'x', 2)
    const ys = addSwitchVec(b, 'y', 2)
    b.switch('cin', ZERO)
    // Y operands are delayed by a double inverter (2 ns); X operands direct.
    const yDelayed: PinId[] = []
    for (let i = 0; i < 2; i++) {
      b.add(`ya${i}`, NOT).add(`yb${i}`, NOT)
      b.wire(ys[i], p(`ya${i}`, 'in1')).wire(p(`ya${i}`, 'out'), p(`yb${i}`, 'in1'))
      yDelayed.push(p(`yb${i}`, 'out'))
    }
    const fa0 = addGateFullAdder(b, 'g0', xs[0], yDelayed[0], p('cin', 'out'), d)
    const fa1 = addGateFullAdder(b, 'g1', xs[1], yDelayed[1], fa0.cout, d)
    return { c: b.build(), sums: [fa0.sum, fa1.sum], cout: fa1.cout }
  }

  const delaySets: [string, GateDelays][] = [
    ['xor=3 and=1 or=1', { xor: 3, and: 1, or: 1 }],
    ['xor=1 and=3 or=2', { xor: 1, and: 3, or: 2 }],
    ['xor=2 and=2 or=5', { xor: 2, and: 2, or: 5 }],
    ['xor=4 and=1 or=4', { xor: 4, and: 1, or: 4 }]
  ]

  describe.each(delaySets)('2-bit gate adder with skewed Y and delays %s', (_name, d) => {
    it('settles to the correct sum for every combination applied in sequence', () => {
      const { c, sums, cout } = buildSkewedGateAdder(d)
      for (const [xb, yb, cin, sum, co] of adderRows(2)) {
        applyOperands(c, xb, yb, cin)
        expect(vecOf(c, sums)).toBe(sum)
        expect(c.pin(cout)).toBe(co)
        expect(c.oscillated).toBe(false)
      }
    })

    it('settles to the correct sum when every operand bit flips at once (00+00 <-> 11+11)', () => {
      const { c, sums, cout } = buildSkewedGateAdder(d)
      for (let k = 0; k < 4; k++) {
        c.setMany({ x0: ONE, x1: ONE, y0: ONE, y1: ONE, cin: ONE })
        expect(vecOf(c, sums)).toBe('11') // 3 + 3 + 1 = 7 = 111
        expect(c.pin(cout)).toBe(ONE)
        c.setMany({ x0: ZERO, x1: ZERO, y0: ZERO, y1: ZERO, cin: ZERO })
        expect(vecOf(c, sums)).toBe('00')
        expect(c.pin(cout)).toBe(ZERO)
      }
    })
  })

  it('FULL_ADDER ripple with unequal per-stage delays gives correct results for all 512 combos', () => {
    const b = new CircuitBuilder()
    const xs = addSwitchVec(b, 'x', 4)
    const ys = addSwitchVec(b, 'y', 4)
    b.switch('cin', ZERO)
    const ripple = addPartRipple(b, 'fa', xs, ys, p('cin', 'out'), [1, 4, 2, 3])
    const c = b.build()
    for (const [xb, yb, cin, sum, cout] of adderRows(4)) {
      applyOperands(c, xb, yb, cin)
      expect(vecOf(c, ripple.sums)).toBe(sum)
      expect(c.pin(ripple.cout)).toBe(cout)
      expect(c.oscillated).toBe(false)
    }
  })

  it('FULL_ADDER ripple with unequal delays: carry chain settle time is the sum of stage delays + 1', () => {
    const b = new CircuitBuilder()
    const xs = addSwitchVec(b, 'x', 4)
    const ys = addSwitchVec(b, 'y', 4)
    b.switch('cin', ZERO)
    const ripple = addPartRipple(b, 'fa', xs, ys, p('cin', 'out'), [1, 4, 2, 3])
    const c = b.build()
    c.setMany({ ...numSwitches('x', 0b0110, 4), ...numSwitches('y', 0b0001, 4) })
    const t0 = c.time
    c.set('x0', ONE)
    expect(vecOf(c, ripple.sums)).toBe('1000')
    expect(c.time - t0).toBe(1 + 1 + 4 + 2 + 3)
  })

  it('operands with unequal path delays into the FULL_ADDER part still settle correctly', () => {
    // X via 3 NOTs (odd -> inverted, 3 ns), Y via 1 NOT (1 ns), so the part sees
    // a transient where only one operand has flipped.
    const b = new CircuitBuilder().switch('x', ZERO).switch('y', ZERO).switch('cin', ZERO)
    b.add('xa', NOT).add('xb', NOT).add('xc', NOT).add('yn', NOT)
    b.wire(p('x', 'out'), p('xa', 'in1')).wire(p('xa', 'out'), p('xb', 'in1')).wire(p('xb', 'out'), p('xc', 'in1'))
    b.wire(p('y', 'out'), p('yn', 'in1'))
    const fa = addPartFullAdder(b, 'fa', p('xc', 'out'), p('yn', 'out'), p('cin', 'out'), 2)
    b.probe('ps').wire(fa.sum, p('ps', 'in'))
    const c = b.build()
    // effective inputs: X' = not x, Y' = not y
    for (const [x, y, cin] of [
      [ONE, ONE, ZERO],
      [ZERO, ZERO, ONE],
      [ONE, ZERO, ONE],
      [ZERO, ONE, ZERO],
      [ONE, ONE, ONE],
      [ZERO, ZERO, ZERO]
    ] as LogicValue[][]) {
      c.setMany({ x, y, cin })
      const ex = x === ONE ? 0 : 1
      const ey = y === ONE ? 0 : 1
      const total = ex + ey + (cin === ONE ? 1 : 0)
      expect(c.pin(fa.sum)).toBe(total % 2 ? ONE : ZERO)
      expect(c.pin(fa.cout)).toBe(total >= 2 ? ONE : ZERO)
      expect(c.oscillated).toBe(false)
    }
  })

  it('FULL_ADDER delay 3 with x and y flipping 2 ns apart shows no glitch on Sum', () => {
    // x direct (1 ns), y through two NOTs (3 ns). Sum = x^y^cin: after both flip
    // the sum is unchanged, and the 2 ns transient is shorter than the 3 ns delay.
    const b = new CircuitBuilder().switch('x', ZERO).switch('y', ZERO).switch('cin', ZERO)
    b.add('ya', NOT).add('yb', NOT)
    b.wire(p('y', 'out'), p('ya', 'in1')).wire(p('ya', 'out'), p('yb', 'in1'))
    const fa = addPartFullAdder(b, 'fa', p('x', 'out'), p('yb', 'out'), p('cin', 'out'), 3)
    b.probe('ps').wire(fa.sum, p('ps', 'in')).probe('pc').wire(fa.cout, p('pc', 'in'))
    const c = b.build()
    c.setMany({ x: ONE, y: ONE })
    expect(c.pin(fa.sum)).toBe(ZERO)
    expect(c.pin(fa.cout)).toBe(ONE)
    const sumTrace = c.sim.getWaveforms().find((w) => w.probeId === 'ps')!
    expect(sumTrace.samples).toEqual([{ t: 0, v: ZERO }])
    const coutTrace = c.sim.getWaveforms().find((w) => w.probeId === 'pc')!
    // Cout 0 -> 1 is scheduled when y' arrives at t=3, landing at t=6.
    expect(coutTrace.samples).toEqual([
      { t: 0, v: ZERO },
      { t: 6, v: ONE }
    ])
  })

  it('FULL_ADDER delay 1 with x and y flipping 2 ns apart shows the Sum glitch', () => {
    const b = new CircuitBuilder().switch('x', ZERO).switch('y', ZERO).switch('cin', ZERO)
    b.add('ya', NOT).add('yb', NOT)
    b.wire(p('y', 'out'), p('ya', 'in1')).wire(p('ya', 'out'), p('yb', 'in1'))
    const fa = addPartFullAdder(b, 'fa', p('x', 'out'), p('yb', 'out'), p('cin', 'out'), 1)
    b.probe('ps').wire(fa.sum, p('ps', 'in'))
    const c = b.build()
    c.setMany({ x: ONE, y: ONE })
    expect(c.pin(fa.sum)).toBe(ZERO)
    const sumTrace = c.sim.getWaveforms().find((w) => w.probeId === 'ps')!
    expect(sumTrace.samples).toEqual([
      { t: 0, v: ZERO },
      { t: 2, v: ONE },
      { t: 4, v: ZERO }
    ])
  })
})
