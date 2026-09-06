// Integration verification of data flowing through BUSSES and N-bit parts:
// BUS_INPUT / SPLITTER / MERGER / BUS_TAP / COMPLEMENTER / BUS_PROBE composed with
// gates, N_ADDER, N_MUX_2TO1, N_TRISTATE and N_REGISTER (SimUaid User's Guide §4
// "Using Busses and Bus Parts", Reference Manual §1.4.3.3 and Appendix A).
//
// Conventions used throughout this file:
//   * bit 0 is the LSB; `Circuit.vec()` returns MSB-first strings ("0101" == 5),
//   * a bus reads back as ceil(width/4) uppercase hex digits, MSB first; a bus
//     whose bits are all Z displays as a 'Z' fill and any other non-clean bus as
//     an 'X' fill (busParts.test.ts pins that display convention down),
//   * every part has the default 1 ns delay unless stated, so a SWITCH change
//     reaches the next part at now+1,
//   * expected values are computed here from plain arithmetic (never from
//     values.ts) so the test is an independent oracle,
//   * an "X source" is a NOT gate with an unconnected input (Z in -> X out); a
//     "Z source" is a TRISTATE_RIGHT whose ctl is 0.
//
// Decisions asserted (see the spec's IMPLEMENTATION DECISIONS):
//   3  — wired-net resolution, bit by bit, and a narrow driver leaving the
//        missing high bits X,
//   4  — time is 0 after reset and probe traces start with one sample at t=0,
//   12 — one net resolution per instant: a hand-over between two drivers of the
//        same value produces no new bus-probe sample.

import { describe, expect, it } from 'vitest'
import { ComponentType, LogicValue, type SignalRow } from '../../model/types'
import { CircuitBuilder, bitsToSwitches, p, type Circuit } from './harness'

const { ZERO, ONE, X, Z } = LogicValue

// ---------------------------------------------------------------------------
// Local helpers. The shared harness has no bus rig, so the value oracles and the
// circuit builders used by several sections live here.
// ---------------------------------------------------------------------------

const bit = (b: number): LogicValue => (b ? ONE : ZERO)

/** Bit i of v, LSB-first; exact for the full 32-bit range (no `>>`). */
const bitAt = (v: number, i: number): number => Math.floor(v / 2 ** i) % 2

const mask = (n: number): number => 2 ** n - 1

/** MSB-first binary string of `v` in `n` bits, matching Circuit.vec(). */
function binOf(v: number, n: number): string {
  let s = ''
  for (let i = n - 1; i >= 0; i--) s += bitAt(v, i)
  return s
}

/** SimUaid bus display: ceil(n/4) uppercase hex digits, MSB first. */
function hexOf(v: number, n: number): string {
  const digits = Math.ceil(n / 4)
  let s = ''
  for (let d = digits - 1; d >= 0; d--) {
    let nibble = 0
    for (let b = 3; b >= 0; b--) {
      const i = d * 4 + b
      nibble = nibble * 2 + (i < n ? bitAt(v, i) : 0)
    }
    s += nibble.toString(16).toUpperCase()
  }
  return s
}

/** An all-X ('X') or all-Z ('Z') bus display of the given width. */
const fillOf = (ch: 'X' | 'Z', n: number): string => ch.repeat(Math.ceil(n / 4))

/** Hex display of an LSB-first bit vector (Z fill / X fill / clean value). */
function hexOfBits(bits: LogicValue[]): string {
  const n = bits.length
  if (bits.every((v) => v === Z)) return fillOf('Z', n)
  if (!bits.every((v) => v === ZERO || v === ONE)) return fillOf('X', n)
  let v = 0
  for (let i = 0; i < n; i++) if (bits[i] === ONE) v += 2 ** i
  return hexOf(v, n)
}

/** BUS_INPUT label: bare lowercase hex, no prefix. */
const labelOf = (v: number): string => v.toString(16)

/** Bitwise op over n bits without 32-bit `&`/`|`/`^` overflow. */
function bitwise(n: number, a: number, b: number, f: (x: number, y: number) => number): number {
  let out = 0
  for (let i = 0; i < n; i++) out += f(bitAt(a, i), bitAt(b, i)) * 2 ** i
  return out
}

/** Wired resolution (decision 3) of one bit position over a set of drivers. */
function resolveBit(drivers: (number | null)[], i: number): LogicValue {
  let v: LogicValue = Z
  for (const d of drivers) {
    if (d === null) continue // released (tristate off)
    const b = bit(bitAt(d, i))
    v = v === Z ? b : v === b ? v : X
  }
  return v
}

/** Wired resolution of a whole n-bit bus. */
const resolveBus = (drivers: (number | null)[], n: number): LogicValue[] =>
  Array.from({ length: n }, (_, i) => resolveBit(drivers, i))

const busTrace = (c: Circuit, probeId: string): [number, string][] =>
  c.sim
    .getWaveforms()
    .find((w) => w.probeId === probeId)!
    .samples.map((s) => [s.t, s.hex!])

const netTrace = (c: Circuit, probeId: string): [number, LogicValue][] =>
  c.sim
    .getWaveforms()
    .find((w) => w.probeId === probeId)!
    .samples.map((s) => [s.t, s.v])

const row = (timeNs: number, value: LogicValue): SignalRow => ({ timeNs, value })

/** Distinct sample values for an n-bit bus: 0, 1, all ones, 0101…, 1010…, a third. */
function sampleValues(n: number): number[] {
  const m = mask(n)
  let alt = 0
  for (let i = 0; i < n; i += 2) alt += 2 ** i
  return [...new Set([0, 1, m, alt, m - alt, Math.floor(m / 3)])]
}

/** [hex label, value] rows so `it.each` titles show the hex the circuit displays. */
const hexRows = (n: number): [string, number][] => sampleValues(n).map((v) => [hexOf(v, n), v])

/** Adds a BUS_INPUT + SPLITTER pair; `out{i}` of the splitter carries bit i. */
function addBusSource(b: CircuitBuilder, id: string, n: number, value: number): CircuitBuilder {
  return b
    .add(`${id}bi`, ComponentType.BUS_INPUT, { bits: n, label: labelOf(value) })
    .add(id, ComponentType.SPLITTER, { bits: n })
    .wire(p(`${id}bi`, 'out'), p(id, 'in'))
}

/** Adds a MERGER feeding a BUS_PROBE; single-bit nets go to `${id}#in{i}`. */
function addBusSink(b: CircuitBuilder, id: string, n: number): CircuitBuilder {
  return b
    .add(id, ComponentType.MERGER, { bits: n })
    .add(`${id}bp`, ComponentType.BUS_PROBE, { bits: n })
    .wire(p(id, 'out'), p(`${id}bp`, 'in'))
}

// ===========================================================================
// 1. Round trips: BUS_INPUT -> SPLITTER -> gates -> MERGER -> BUS_PROBE
// ===========================================================================

const WIDTHS = [2, 3, 4, 5, 6, 7, 8, 9, 13, 16, 32]

/** BUS_INPUT -> SPLITTER -> per-bit NOT -> MERGER -> BUS_PROBE. */
function notArray(n: number, value: number): Circuit {
  const b = new CircuitBuilder()
  addBusSource(b, 'sp', n, value)
  addBusSink(b, 'mg', n)
  for (let i = 0; i < n; i++) {
    b.add(`g${i}`, ComponentType.NOT)
      .wire(p('sp', `out${i}`), p(`g${i}`, 'in1'))
      .wire(p(`g${i}`, 'out'), p('mg', `in${i}`))
  }
  return b.build()
}

describe.each(WIDTHS)('%i-bit round trip BUS_INPUT -> SPLITTER -> NOT array -> MERGER -> BUS_PROBE', (n) => {
  it.each(hexRows(n))('value %s: bus input, split bits, merged bus and probe all agree', (_hex, v) => {
    const c = notArray(n, v)
    const inverted = mask(n) - v
    expect(c.bus(p('spbi', 'out'))).toBe(hexOf(v, n))
    expect(c.bus(p('sp', 'in'))).toBe(hexOf(v, n))
    expect(c.vec('sp', 'out', n)).toBe(binOf(v, n))
    expect(c.vec('mg', 'in', n)).toBe(binOf(inverted, n))
    expect(c.bus(p('mg', 'out'))).toBe(hexOf(inverted, n))
    expect(c.bus(p('mgbp', 'in'))).toBe(hexOf(inverted, n))
  })

  it(`t = 0 after reset and the ${n}-bit probe trace holds exactly one settled sample`, () => {
    const v = sampleValues(n)[5] ?? 1
    const c = notArray(n, v)
    expect(c.time).toBe(0)
    expect(busTrace(c, 'mgbp')).toEqual([[0, hexOf(mask(n) - v, n)]])
  })
})

/** Two operand busses -> per-bit two-input gate -> merged bus. */
function gateArray(n: number, a: number, bVal: number, gate: ComponentType): Circuit {
  const b = new CircuitBuilder()
  addBusSource(b, 'spa', n, a)
  addBusSource(b, 'spb', n, bVal)
  addBusSink(b, 'mg', n)
  for (let i = 0; i < n; i++) {
    b.add(`g${i}`, gate)
      .wire(p('spa', `out${i}`), p(`g${i}`, 'in1'))
      .wire(p('spb', `out${i}`), p(`g${i}`, 'in2'))
      .wire(p(`g${i}`, 'out'), p('mg', `in${i}`))
  }
  return b.build()
}

const PAIR_WIDTHS = [2, 4, 5, 8, 16, 32]

const GATE_OPS: [string, ComponentType, (x: number, y: number) => number][] = [
  ['AND2', ComponentType.AND2, (x, y) => (x && y ? 1 : 0)],
  ['OR2', ComponentType.OR2, (x, y) => (x || y ? 1 : 0)],
  ['XOR2', ComponentType.XOR2, (x, y) => x ^ y],
  ['NAND2', ComponentType.NAND2, (x, y) => (x && y ? 0 : 1)]
]

describe.each(PAIR_WIDTHS)('%i-bit two-operand bus round trip through a gate array', (n) => {
  const pairs: [number, number][] = [
    [0, mask(n)],
    [mask(n), mask(n)],
    [1, mask(n) - 1],
    [Math.floor(mask(n) / 3), Math.floor(mask(n) / 5)]
  ]
  for (const [name, type, op] of GATE_OPS) {
    it.each(pairs)(`${name}: 0x%s op 0x%s merges to the bitwise result`, (a, bVal) => {
      const c = gateArray(n, a, bVal, type)
      const expected = bitwise(n, a, bVal, op)
      expect(c.bus(p('spa', 'in'))).toBe(hexOf(a, n))
      expect(c.bus(p('spb', 'in'))).toBe(hexOf(bVal, n))
      expect(c.vec('spa', 'out', n)).toBe(binOf(a, n))
      expect(c.vec('spb', 'out', n)).toBe(binOf(bVal, n))
      expect(c.bus(p('mgbp', 'in'))).toBe(hexOf(expected, n))
      expect(busTrace(c, 'mgbp')).toEqual([[0, hexOf(expected, n)]])
    })
  }
})

describe('two-stage bus round trips', () => {
  const widths = [2, 5, 8, 13, 32]

  /** BUS_INPUT -> split -> NOT -> merge -> split -> NOT -> merge -> probe. */
  function doubleInvert(n: number, v: number): Circuit {
    const b = new CircuitBuilder()
    addBusSource(b, 'sp1', n, v)
    addBusSink(b, 'mg1', n)
    addBusSink(b, 'mg2', n)
    b.add('sp2', ComponentType.SPLITTER, { bits: n }).wire(p('mg1', 'out'), p('sp2', 'in'))
    for (let i = 0; i < n; i++) {
      b.add(`a${i}`, ComponentType.NOT)
        .wire(p('sp1', `out${i}`), p(`a${i}`, 'in1'))
        .wire(p(`a${i}`, 'out'), p('mg1', `in${i}`))
        .add(`b${i}`, ComponentType.NOT)
        .wire(p('sp2', `out${i}`), p(`b${i}`, 'in1'))
        .wire(p(`b${i}`, 'out'), p('mg2', `in${i}`))
    }
    return b.build()
  }

  it.each(widths)('%i bits: the middle bus is the complement and the final bus is the original', (n) => {
    for (const v of sampleValues(n)) {
      const c = doubleInvert(n, v)
      expect(c.bus(p('mg1bp', 'in'))).toBe(hexOf(mask(n) - v, n))
      expect(c.bus(p('mg2bp', 'in'))).toBe(hexOf(v, n))
      expect(c.vec('sp2', 'out', n)).toBe(binOf(mask(n) - v, n))
    }
  })
})

describe('MERGER -> bus -> SPLITTER identity (switch driven)', () => {
  const widths = [2, 3, 4, 5, 7, 8, 16, 32]

  function loop(n: number): Circuit {
    const b = new CircuitBuilder()
    addBusSink(b, 'mg', n)
    b.add('sp', ComponentType.SPLITTER, { bits: n }).wire(p('mg', 'out'), p('sp', 'in'))
    for (let i = 0; i < n; i++) b.switch(`s${i}`, ZERO).wire(p(`s${i}`, 'out'), p('mg', `in${i}`))
    // Every split bit must terminate somewhere readable; a probe per bit is fine.
    for (let i = 0; i < n; i++) b.probe(`pr${i}`).wire(p('sp', `out${i}`), p(`pr${i}`, 'in'))
    return b.build()
  }

  it.each(widths)('%i bits: every sample value survives merge -> bus -> split', (n) => {
    const c = loop(n)
    for (const v of sampleValues(n)) {
      c.setMany(bitsToSwitches('s', binOf(v, n)))
      expect(c.bus(p('mgbp', 'in'))).toBe(hexOf(v, n))
      expect(c.vec('sp', 'out', n)).toBe(binOf(v, n))
      for (let i = 0; i < n; i++) expect(c.pin(p(`pr${i}`, 'in'))).toBe(bit(bitAt(v, i)))
    }
  })
})

describe('a single undetermined bit poisons the hex display but not its neighbours', () => {
  /** 8-bit NOT array whose bit 3 gate has an unconnected second input (AND2). */
  function holed(): Circuit {
    const b = new CircuitBuilder()
    addBusSource(b, 'sp', 8, 0x5a)
    addBusSink(b, 'mg', 8)
    b.add('sp2', ComponentType.SPLITTER, { bits: 8 }).wire(p('mg', 'out'), p('sp2', 'in'))
    for (let i = 0; i < 8; i++) {
      if (i === 3) {
        // AND2 with in2 unconnected (Z): no controlling 0 on in1 when bit 3 is 1 -> X.
        b.add('g3', ComponentType.AND2)
          .wire(p('sp', 'out3'), p('g3', 'in1'))
          .wire(p('g3', 'out'), p('mg', 'in3'))
      } else {
        b.add(`g${i}`, ComponentType.NOT)
          .wire(p('sp', `out${i}`), p(`g${i}`, 'in1'))
          .wire(p(`g${i}`, 'out'), p('mg', `in${i}`))
      }
    }
    return b.build()
  }

  it('the merged bus shows an X fill', () => {
    expect(holed().bus(p('mgbp', 'in'))).toBe('XX')
  })

  it('re-splitting that bus shows X only on bit 3; the other bits are the complement of 5A', () => {
    const c = holed()
    for (let i = 0; i < 8; i++) {
      expect(c.pin(p('sp2', `out${i}`))).toBe(i === 3 ? X : bit(1 - bitAt(0x5a, i)))
    }
  })
})

// ===========================================================================
// 2. COMPLEMENTER vs a NOT-gate array
// ===========================================================================

type EnFeed = 'one' | 'zero' | 'open' | 'x' | 'tristateZ'

/** COMPLEMENTER and an equivalent NOT array on the same BUS_INPUT. */
function complementerVsNots(n: number, v: number, en: EnFeed): Circuit {
  const b = new CircuitBuilder()
  addBusSource(b, 'sp', n, v)
  addBusSink(b, 'mg', n)
  b.add('cp', ComponentType.COMPLEMENTER, { bits: n })
    .add('cbp', ComponentType.BUS_PROBE, { bits: n })
    .wire(p('spbi', 'out'), p('cp', 'in'))
    .wire(p('cp', 'out'), p('cbp', 'in'))
  for (let i = 0; i < n; i++) {
    b.add(`g${i}`, ComponentType.NOT)
      .wire(p('sp', `out${i}`), p(`g${i}`, 'in1'))
      .wire(p(`g${i}`, 'out'), p('mg', `in${i}`))
  }
  if (en === 'one' || en === 'zero') {
    b.switch('en', en === 'one' ? ONE : ZERO).wire(p('en', 'out'), p('cp', 'en'))
  } else if (en === 'x') {
    b.add('xs', ComponentType.NOT).wire(p('xs', 'out'), p('cp', 'en'))
  } else if (en === 'tristateZ') {
    b.add('ts', ComponentType.TRISTATE_RIGHT)
      .switch('ctl', ZERO)
      .switch('d', ONE)
      .wire(p('d', 'out'), p('ts', 'in'))
      .wire(p('ctl', 'out'), p('ts', 'ctl'))
      .wire(p('ts', 'out'), p('cp', 'en'))
  }
  return b.build()
}

const CMP_WIDTHS = [2, 4, 5, 8, 16, 32]

describe.each(CMP_WIDTHS)('COMPLEMENTER (%i bits) against a NOT-gate array', (n) => {
  it.each(hexRows(n))('en = 1, value %s: both paths give the 1s complement', (_hex, v) => {
    const c = complementerVsNots(n, v, 'one')
    expect(c.bus(p('cbp', 'in'))).toBe(hexOf(mask(n) - v, n))
    expect(c.bus(p('mgbp', 'in'))).toBe(hexOf(mask(n) - v, n))
  })

  it.each(hexRows(n))('en = 0, value %s: the complementer passes through, the NOT array still inverts', (_hex, v) => {
    const c = complementerVsNots(n, v, 'zero')
    expect(c.bus(p('cbp', 'in'))).toBe(hexOf(v, n))
    expect(c.bus(p('mgbp', 'in'))).toBe(hexOf(mask(n) - v, n))
  })

  it('toggling en switches between complement and pass-through, and the trace records both', () => {
    const v = sampleValues(n)[5] ?? 1
    const c = complementerVsNots(n, v, 'one')
    expect(c.bus(p('cbp', 'in'))).toBe(hexOf(mask(n) - v, n))
    c.set('en', ZERO)
    expect(c.bus(p('cbp', 'in'))).toBe(hexOf(v, n))
    c.set('en', ONE)
    expect(c.bus(p('cbp', 'in'))).toBe(hexOf(mask(n) - v, n))
    expect(busTrace(c, 'cbp').map(([, h]) => h)).toEqual([
      hexOf(mask(n) - v, n),
      hexOf(v, n),
      hexOf(mask(n) - v, n)
    ])
  })

  it.each<[EnFeed, string]>([
    ['open', 'unconnected'],
    ['x', 'driven X'],
    ['tristateZ', 'driven Z by a disabled tristate']
  ])('en %s (%s) makes every output bit X while the NOT array is unaffected', (feed) => {
    const v = sampleValues(n)[2]
    const c = complementerVsNots(n, v, feed)
    expect(c.bus(p('cbp', 'in'))).toBe(fillOf('X', n))
    expect(c.bus(p('mgbp', 'in'))).toBe(hexOf(mask(n) - v, n))
  })
})

describe('COMPLEMENTER composed with splitters and other complementers', () => {
  it.each([
    [4, 0x5],
    [8, 0xa5],
    [16, 0xbeef]
  ])('%i bits: complementing 0x%s twice returns the original value', (n, v) => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: n, label: labelOf(v) })
      .add('c1', ComponentType.COMPLEMENTER, { bits: n })
      .add('c2', ComponentType.COMPLEMENTER, { bits: n })
      .add('bp1', ComponentType.BUS_PROBE, { bits: n })
      .add('bp2', ComponentType.BUS_PROBE, { bits: n })
      .add('vcc', ComponentType.VCC)
      .wire(p('bi', 'out'), p('c1', 'in'))
      .wire(p('c1', 'out'), p('bp1', 'in'))
      .wire(p('c1', 'out'), p('c2', 'in'))
      .wire(p('c2', 'out'), p('bp2', 'in'))
      .wire(p('vcc', 'out'), p('c1', 'en'))
      .wire(p('vcc', 'out'), p('c2', 'en'))
      .build()
    expect(c.bus(p('bp1', 'in'))).toBe(hexOf(mask(n) - v, n))
    expect(c.bus(p('bp2', 'in'))).toBe(hexOf(v, n))
  })

  it('a complementer output split into single bits inverts every bit of A5 (8 bits)', () => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 8, label: 'a5' })
      .add('cp', ComponentType.COMPLEMENTER, { bits: 8 })
      .add('sp', ComponentType.SPLITTER, { bits: 8 })
      .switch('en', ONE)
      .wire(p('bi', 'out'), p('cp', 'in'))
      .wire(p('cp', 'out'), p('sp', 'in'))
      .wire(p('en', 'out'), p('cp', 'en'))
      .build()
    for (let i = 0; i < 8; i++) expect(c.pin(p('sp', `out${i}`))).toBe(bit(1 - bitAt(0xa5, i)))
    c.set('en', ZERO)
    for (let i = 0; i < 8; i++) expect(c.pin(p('sp', `out${i}`))).toBe(bit(bitAt(0xa5, i)))
  })

  it('en = 1 over an unconnected input bus gives an all-X bus (complement of Z is X)', () => {
    const c = new CircuitBuilder()
      .add('cp', ComponentType.COMPLEMENTER, { bits: 8 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 8 })
      .add('vcc', ComponentType.VCC)
      .wire(p('cp', 'out'), p('bp', 'in'))
      .wire(p('vcc', 'out'), p('cp', 'en'))
      .build()
    expect(c.bus(p('bp', 'in'))).toBe('XX')
  })

  it('a complementer fed by a MERGER of switches follows the switches', () => {
    const b = new CircuitBuilder()
      .add('cp', ComponentType.COMPLEMENTER, { bits: 4 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
      .add('vcc', ComponentType.VCC)
      .wire(p('vcc', 'out'), p('cp', 'en'))
      .wire(p('cp', 'out'), p('bp', 'in'))
    addBusSink(b, 'mg', 4)
    b.wire(p('mg', 'out'), p('cp', 'in'))
    for (let i = 0; i < 4; i++) b.switch(`s${i}`, ZERO).wire(p(`s${i}`, 'out'), p('mg', `in${i}`))
    const c = b.build()
    for (let v = 0; v < 16; v++) {
      c.setMany(bitsToSwitches('s', binOf(v, 4)))
      expect(c.bus(p('mgbp', 'in'))).toBe(hexOf(v, 4))
      expect(c.bus(p('bp', 'in'))).toBe(hexOf(15 - v, 4))
    }
  })
})

// ===========================================================================
// 3. BUS_TAP slices
// ===========================================================================

/** BUS_INPUT -> {SPLITTER, BUS_TAP -> probe}; the tap output is `tap#out`. */
function tapCircuit(busBits: number, value: number, tapStart: number, bits: number): Circuit {
  const b = new CircuitBuilder()
    .add('bi', ComponentType.BUS_INPUT, { bits: busBits, label: labelOf(value) })
    .add('sp', ComponentType.SPLITTER, { bits: busBits })
    .add('tap', ComponentType.BUS_TAP, { bits, tapStart })
    .wire(p('bi', 'out'), p('sp', 'in'))
    .wire(p('bi', 'out'), p('tap', 'in'))
  if (bits > 1) b.add('bp', ComponentType.BUS_PROBE, { bits }).wire(p('tap', 'out'), p('bp', 'in'))
  else b.probe('bp').wire(p('tap', 'out'), p('bp', 'in'))
  return b.build()
}

/** Every (tapStart, bits) with tapStart + bits <= busBits. */
function allSlices(busBits: number): [number, number][] {
  const out: [number, number][] = []
  for (let start = 0; start < busBits; start++) {
    for (let bits = 1; bits + start <= busBits; bits++) out.push([start, bits])
  }
  return out
}

const sliceOf = (value: number, start: number, bits: number): number =>
  Math.floor(value / 2 ** start) % 2 ** bits

describe.each([0x5a, 0xb3])('BUS_TAP: every slice of the 8-bit bus 0x%s', (value) => {
  it.each(allSlices(8))('tap at bit %i, %i bits matches the splitter bits and the hex slice', (start, bits) => {
    const c = tapCircuit(8, value, start, bits)
    const expected = sliceOf(value, start, bits)
    for (let i = 0; i < bits; i++) {
      expect(c.pin(p('sp', `out${start + i}`))).toBe(bit(bitAt(value, start + i)))
    }
    if (bits > 1) {
      expect(c.bus(p('tap', 'out'))).toBe(hexOf(expected, bits))
      expect(c.bus(p('bp', 'in'))).toBe(hexOf(expected, bits))
      expect(busTrace(c, 'bp')).toEqual([[0, hexOf(expected, bits)]])
    } else {
      expect(c.pin(p('tap', 'out'))).toBe(bit(expected))
      expect(netTrace(c, 'bp')).toEqual([[0, bit(expected)]])
    }
  })
})

describe('BUS_TAP: every slice of the 16-bit bus 0xBEEF', () => {
  it.each(allSlices(16))('tap at bit %i, %i bits matches the splitter bits and the hex slice', (start, bits) => {
    const c = tapCircuit(16, 0xbeef, start, bits)
    const expected = sliceOf(0xbeef, start, bits)
    for (let i = 0; i < bits; i++) {
      expect(c.pin(p('sp', `out${start + i}`))).toBe(bit(bitAt(0xbeef, start + i)))
    }
    if (bits > 1) expect(c.bus(p('tap', 'out'))).toBe(hexOf(expected, bits))
    else expect(c.pin(p('tap', 'out'))).toBe(bit(expected))
  })
})

describe('BUS_TAP: 1-bit taps feed ordinary gates', () => {
  it.each([0, 1, 2, 3, 4, 5, 6, 7])('bit %i of 0x5A through a NOT gate', (k) => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 8, label: '5a' })
      .add('tap', ComponentType.BUS_TAP, { bits: 1, tapStart: k })
      .add('n', ComponentType.NOT)
      .probe('y')
      .wire(p('bi', 'out'), p('tap', 'in'))
      .wire(p('tap', 'out'), p('n', 'in1'))
      .wire(p('n', 'out'), p('y', 'in'))
      .build()
    expect(c.pin(p('tap', 'out'))).toBe(bit(bitAt(0x5a, k)))
    expect(c.pin(p('y', 'in'))).toBe(bit(1 - bitAt(0x5a, k)))
  })

  it.each([0, 1, 2, 3, 4, 5, 6, 7])('bit %i of 0x5A ANDed with a switch', (k) => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 8, label: '5a' })
      .add('tap', ComponentType.BUS_TAP, { bits: 1, tapStart: k })
      .add('g', ComponentType.AND2)
      .switch('s', ZERO)
      .probe('y')
      .wire(p('bi', 'out'), p('tap', 'in'))
      .wire(p('tap', 'out'), p('g', 'in1'))
      .wire(p('s', 'out'), p('g', 'in2'))
      .wire(p('g', 'out'), p('y', 'in'))
      .build()
    expect(c.pin(p('y', 'in'))).toBe(ZERO)
    c.set('s', ONE)
    expect(c.pin(p('y', 'in'))).toBe(bit(bitAt(0x5a, k)))
  })
})

describe('BUS_TAP: ranges that run past the end of the bus fill with X', () => {
  const cases: [number, number, string][] = [
    [6, 4, 'bits 6,7 in range; 8,9 past the end'],
    [7, 2, 'bit 7 in range; bit 8 past the end'],
    [5, 8, 'bits 5..7 in range; 8..12 past the end'],
    [8, 2, 'entirely past the end']
  ]

  it.each(cases)('tap at bit %i, %i bits (%s) displays an X fill', (start, bits) => {
    const c = tapCircuit(8, 0x5a, start, bits)
    expect(c.bus(p('bp', 'in'))).toBe(fillOf('X', bits))
  })

  it.each(cases)('tap at bit %i, %i bits (%s): in-range bits keep their value when re-split', (start, bits) => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 8, label: '5a' })
      .add('tap', ComponentType.BUS_TAP, { bits, tapStart: start })
      .add('sp', ComponentType.SPLITTER, { bits })
      .wire(p('bi', 'out'), p('tap', 'in'))
      .wire(p('tap', 'out'), p('sp', 'in'))
      .build()
    for (let i = 0; i < bits; i++) {
      const idx = start + i
      expect(c.pin(p('sp', `out${i}`))).toBe(idx < 8 ? bit(bitAt(0x5a, idx)) : X)
    }
  })

  it('a fully out-of-range 1-bit tap reads X', () => {
    const c = tapCircuit(8, 0x5a, 9, 1)
    expect(c.pin(p('tap', 'out'))).toBe(X)
  })
})

describe('BUS_TAP: unconnected input drives Z (decision: an unconnected tap releases its net)', () => {
  it.each([2, 3, 4, 8])('a %i-bit tap with no bus attached shows a Z fill on its probe', (bits) => {
    const c = new CircuitBuilder()
      .add('tap', ComponentType.BUS_TAP, { bits, tapStart: 0 })
      .add('bp', ComponentType.BUS_PROBE, { bits })
      .wire(p('tap', 'out'), p('bp', 'in'))
      .build()
    expect(c.bus(p('bp', 'in'))).toBe(fillOf('Z', bits))
    expect(busTrace(c, 'bp')).toEqual([[0, fillOf('Z', bits)]])
  })

  it('a 1-bit tap with no bus attached leaves its net at Z, not X', () => {
    const c = new CircuitBuilder()
      .add('tap', ComponentType.BUS_TAP, { bits: 1, tapStart: 3 })
      .probe('y')
      .wire(p('tap', 'out'), p('y', 'in'))
      .build()
    expect(c.pin(p('y', 'in'))).toBe(Z)
    expect(netTrace(c, 'y')).toEqual([[0, Z]])
  })

  it('an unconnected tap does not disturb another driver on the same net', () => {
    // The tap releases the net (Z), so the switch alone determines its value.
    const c = new CircuitBuilder()
      .add('tap', ComponentType.BUS_TAP, { bits: 1, tapStart: 0 })
      .switch('s', ONE)
      .probe('y')
      .wire(p('tap', 'out'), p('y', 'in'))
      .wire(p('s', 'out'), p('y', 'in'))
      .build()
    expect(c.pin(p('y', 'in'))).toBe(ONE)
    c.set('s', ZERO)
    expect(c.pin(p('y', 'in'))).toBe(ZERO)
  })
})

describe('BUS_TAP: several taps on one bus', () => {
  it('the low and high nibbles of 0x5A tap to A and 5 and re-merge to 5A', () => {
    const b = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 8, label: '5a' })
      .add('lo', ComponentType.BUS_TAP, { bits: 4, tapStart: 0 })
      .add('hi', ComponentType.BUS_TAP, { bits: 4, tapStart: 4 })
      .add('splo', ComponentType.SPLITTER, { bits: 4 })
      .add('sphi', ComponentType.SPLITTER, { bits: 4 })
      .wire(p('bi', 'out'), p('lo', 'in'))
      .wire(p('bi', 'out'), p('hi', 'in'))
      .wire(p('lo', 'out'), p('splo', 'in'))
      .wire(p('hi', 'out'), p('sphi', 'in'))
    addBusSink(b, 'mg', 8)
    for (let i = 0; i < 4; i++) {
      b.wire(p('splo', `out${i}`), p('mg', `in${i}`)).wire(p('sphi', `out${i}`), p('mg', `in${i + 4}`))
    }
    const c = b.build()
    expect(c.bus(p('lo', 'out'))).toBe('A')
    expect(c.bus(p('hi', 'out'))).toBe('5')
    expect(c.bus(p('mgbp', 'in'))).toBe('5A')
  })

  it.each([
    [0x5a, 0xf],
    [0xff, 0x1e],
    [0x00, 0x0],
    [0x99, 0x12],
    [0x87, 0xf],
    [0x1f, 0x10]
  ])('the two nibbles of 0x%s added by an N_ADDER(4) give 0x%s', (value, sum) => {
    const b = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 8, label: labelOf(value) })
      .add('lo', ComponentType.BUS_TAP, { bits: 4, tapStart: 0 })
      .add('hi', ComponentType.BUS_TAP, { bits: 4, tapStart: 4 })
      .add('splo', ComponentType.SPLITTER, { bits: 4 })
      .add('sphi', ComponentType.SPLITTER, { bits: 4 })
      .add('add', ComponentType.N_ADDER, { bits: 4 })
      .add('gnd', ComponentType.GROUND)
      .wire(p('bi', 'out'), p('lo', 'in'))
      .wire(p('bi', 'out'), p('hi', 'in'))
      .wire(p('lo', 'out'), p('splo', 'in'))
      .wire(p('hi', 'out'), p('sphi', 'in'))
      .wire(p('gnd', 'out'), p('add', 'Cin'))
    addBusSink(b, 'mg', 4)
    for (let i = 0; i < 4; i++) {
      b.wire(p('splo', `out${i}`), p('add', `X${i}`))
        .wire(p('sphi', `out${i}`), p('add', `Y${i}`))
        .wire(p('add', `S${i}`), p('mg', `in${i}`))
    }
    const c = b.build()
    const total = (value % 16) + Math.floor(value / 16)
    expect(total).toBe(sum) // the table is self-checking
    expect(c.bus(p('mgbp', 'in'))).toBe(hexOf(total % 16, 4))
    expect(c.pin(p('add', 'Cout'))).toBe(bit(total >= 16 ? 1 : 0))
  })

  it('taps follow a merger-driven bus when a switch toggles', () => {
    const b = new CircuitBuilder()
      .add('tapLo', ComponentType.BUS_TAP, { bits: 2, tapStart: 0 })
      .add('tapHi', ComponentType.BUS_TAP, { bits: 2, tapStart: 2 })
      .add('tap1', ComponentType.BUS_TAP, { bits: 1, tapStart: 3 })
      .probe('y')
    addBusSink(b, 'mg', 4)
    b.wire(p('mg', 'out'), p('tapLo', 'in'))
      .wire(p('mg', 'out'), p('tapHi', 'in'))
      .wire(p('mg', 'out'), p('tap1', 'in'))
      .wire(p('tap1', 'out'), p('y', 'in'))
    for (let i = 0; i < 4; i++) b.switch(`s${i}`, ZERO).wire(p(`s${i}`, 'out'), p('mg', `in${i}`))
    const c = b.build()
    for (let v = 0; v < 16; v++) {
      c.setMany(bitsToSwitches('s', binOf(v, 4)))
      expect(c.bus(p('tapLo', 'out'))).toBe(hexOf(v % 4, 2))
      expect(c.bus(p('tapHi', 'out'))).toBe(hexOf(Math.floor(v / 4), 2))
      expect(c.pin(p('y', 'in'))).toBe(bit(bitAt(v, 3)))
    }
  })

  it('taps of a contended bus are X only where the drivers disagree (decision 3)', () => {
    // 0x5A and 0x5B differ in bit 0 only.
    const c = new CircuitBuilder()
      .add('bia', ComponentType.BUS_INPUT, { bits: 8, label: '5a' })
      .add('bib', ComponentType.BUS_INPUT, { bits: 8, label: '5b' })
      .add('t0', ComponentType.BUS_TAP, { bits: 1, tapStart: 0 })
      .add('t1', ComponentType.BUS_TAP, { bits: 1, tapStart: 1 })
      .add('t13', ComponentType.BUS_TAP, { bits: 3, tapStart: 1 })
      .add('t04', ComponentType.BUS_TAP, { bits: 4, tapStart: 0 })
      .add('t47', ComponentType.BUS_TAP, { bits: 4, tapStart: 4 })
      .wire(p('bia', 'out'), p('bib', 'out'))
      .wire(p('bia', 'out'), p('t0', 'in'))
      .wire(p('bia', 'out'), p('t1', 'in'))
      .wire(p('bia', 'out'), p('t13', 'in'))
      .wire(p('bia', 'out'), p('t04', 'in'))
      .wire(p('bia', 'out'), p('t47', 'in'))
      .build()
    expect(c.pin(p('t0', 'out'))).toBe(X)
    expect(c.pin(p('t1', 'out'))).toBe(ONE)
    expect(c.bus(p('t13', 'out'))).toBe(hexOf(0b101, 3))
    expect(c.bus(p('t04', 'out'))).toBe('X')
    expect(c.bus(p('t47', 'out'))).toBe('5')
  })
})

// ===========================================================================
// 4. Arithmetic over busses
// ===========================================================================

/** BUS_INPUT/SPLITTER operands -> N_ADDER -> MERGER -> BUS_PROBE, Cin from a switch. */
function busAdder(n: number, xv: number, yv: number, cin: number): Circuit {
  const b = new CircuitBuilder()
  addBusSource(b, 'spx', n, xv)
  addBusSource(b, 'spy', n, yv)
  addBusSink(b, 'mg', n)
  b.add('add', ComponentType.N_ADDER, { bits: n })
    .switch('cin', cin ? ONE : ZERO)
    .probe('cout')
    .wire(p('cin', 'out'), p('add', 'Cin'))
    .wire(p('add', 'Cout'), p('cout', 'in'))
  for (let i = 0; i < n; i++) {
    b.wire(p('spx', `out${i}`), p('add', `X${i}`))
      .wire(p('spy', `out${i}`), p('add', `Y${i}`))
      .wire(p('add', `S${i}`), p('mg', `in${i}`))
  }
  return b.build()
}

const ADD_TABLES: Record<number, [number, number][]> = {
  4: [
    [0, 0],
    [1, 1],
    [7, 8],
    [8, 8],
    [15, 15],
    [15, 1],
    [9, 7],
    [5, 10],
    [12, 3],
    [6, 6],
    [14, 2],
    [3, 13]
  ],
  8: [
    [0, 0],
    [1, 255],
    [255, 255],
    [128, 128],
    [170, 85],
    [15, 240],
    [99, 100],
    [200, 55],
    [127, 1],
    [64, 192]
  ],
  16: [
    [0, 0],
    [1, 65535],
    [65535, 65535],
    [0x1234, 0x4321],
    [0xaaaa, 0x5555],
    [0x8000, 0x8000],
    [0xffff, 1],
    [0x00ff, 0xff00]
  ]
}

describe.each([4, 8, 16])('N_ADDER(%i) fed through splitters from bus inputs', (n) => {
  for (const cin of [0, 1]) {
    it.each(ADD_TABLES[n])(`Cin = ${cin}: %i + %i matches plain arithmetic on every stage`, (xv, yv) => {
      const c = busAdder(n, xv, yv, cin)
      const total = xv + yv + cin
      const sum = total % 2 ** n
      expect(c.bus(p('spx', 'in'))).toBe(hexOf(xv, n))
      expect(c.bus(p('spy', 'in'))).toBe(hexOf(yv, n))
      expect(c.vec('add', 'S', n)).toBe(binOf(sum, n))
      expect(c.bus(p('mg', 'out'))).toBe(hexOf(sum, n))
      expect(c.bus(p('mgbp', 'in'))).toBe(hexOf(sum, n))
      expect(c.pin(p('cout', 'in'))).toBe(bit(total >= 2 ** n ? 1 : 0))
    })
  }

  it(`Cin toggles live: all ones + all ones wraps and Cout stays 1 (${n} bits)`, () => {
    const c = busAdder(n, mask(n), mask(n), 0)
    expect(c.bus(p('mgbp', 'in'))).toBe(hexOf(mask(n) - 1, n))
    expect(c.pin(p('cout', 'in'))).toBe(ONE)
    c.set('cin', ONE)
    expect(c.bus(p('mgbp', 'in'))).toBe(hexOf(mask(n), n))
    expect(c.pin(p('cout', 'in'))).toBe(ONE)
  })

  it(`zero + zero with Cin toggling produces 0 then 1 (${n} bits)`, () => {
    const c = busAdder(n, 0, 0, 0)
    expect(c.bus(p('mgbp', 'in'))).toBe(hexOf(0, n))
    expect(c.pin(p('cout', 'in'))).toBe(ZERO)
    c.set('cin', ONE)
    expect(c.bus(p('mgbp', 'in'))).toBe(hexOf(1, n))
    expect(c.pin(p('cout', 'in'))).toBe(ZERO)
  })
})

/** X - Y over busses: Y through an enabled COMPLEMENTER, Cin = 1. */
function busSubtractor(n: number, xv: number, yv: number): Circuit {
  const b = new CircuitBuilder()
  addBusSource(b, 'spx', n, xv)
  addBusSink(b, 'mg', n)
  b.add('biy', ComponentType.BUS_INPUT, { bits: n, label: labelOf(yv) })
    .add('cp', ComponentType.COMPLEMENTER, { bits: n })
    .add('spy', ComponentType.SPLITTER, { bits: n })
    .add('add', ComponentType.N_ADDER, { bits: n })
    .add('vcc', ComponentType.VCC)
    .probe('cout')
    .wire(p('biy', 'out'), p('cp', 'in'))
    .wire(p('vcc', 'out'), p('cp', 'en'))
    .wire(p('cp', 'out'), p('spy', 'in'))
    .wire(p('vcc', 'out'), p('add', 'Cin'))
    .wire(p('add', 'Cout'), p('cout', 'in'))
  for (let i = 0; i < n; i++) {
    b.wire(p('spx', `out${i}`), p('add', `X${i}`))
      .wire(p('spy', `out${i}`), p('add', `Y${i}`))
      .wire(p('add', `S${i}`), p('mg', `in${i}`))
  }
  return b.build()
}

const SUB_TABLES: Record<number, [number, number][]> = {
  8: [
    [0, 0],
    [0, 1],
    [255, 255],
    [128, 1],
    [1, 128],
    [200, 100],
    [100, 200],
    [17, 17],
    [255, 0],
    [0, 255],
    [170, 85],
    [85, 170]
  ],
  16: [
    [0, 0],
    [0, 1],
    [0xffff, 0xffff],
    [0x8000, 1],
    [0x1234, 0x1234],
    [0xbeef, 0xdead],
    [0xdead, 0xbeef],
    [0xffff, 0x0001]
  ]
}

describe.each([8, 16])("two's complement subtractor over busses (%i bits)", (n) => {
  it.each(SUB_TABLES[n])('%i - %i wraps modulo 2^n and Cout is the not-borrow flag', (xv, yv) => {
    const c = busSubtractor(n, xv, yv)
    const diff = (xv - yv + 2 ** n) % 2 ** n
    expect(c.bus(p('cp', 'out'))).toBe(hexOf(mask(n) - yv, n))
    expect(c.bus(p('mgbp', 'in'))).toBe(hexOf(diff, n))
    expect(c.pin(p('cout', 'in'))).toBe(bit(xv >= yv ? 1 : 0))
  })
})

describe('multi-word add: 4-bit N_ADDERs chained through Cout -> Cin', () => {
  /** `words` 4-bit adders forming a 4*words-bit adder over two bus inputs. */
  function chained(words: number, xv: number, yv: number, cin: number): Circuit {
    const n = 4 * words
    const b = new CircuitBuilder()
      .add('bix', ComponentType.BUS_INPUT, { bits: n, label: labelOf(xv) })
      .add('biy', ComponentType.BUS_INPUT, { bits: n, label: labelOf(yv) })
      .switch('cin', cin ? ONE : ZERO)
      .probe('cout')
    addBusSink(b, 'mg', n)
    for (let w = 0; w < words; w++) {
      b.add(`tx${w}`, ComponentType.BUS_TAP, { bits: 4, tapStart: 4 * w })
        .add(`ty${w}`, ComponentType.BUS_TAP, { bits: 4, tapStart: 4 * w })
        .add(`sx${w}`, ComponentType.SPLITTER, { bits: 4 })
        .add(`sy${w}`, ComponentType.SPLITTER, { bits: 4 })
        .add(`add${w}`, ComponentType.N_ADDER, { bits: 4 })
        .wire(p('bix', 'out'), p(`tx${w}`, 'in'))
        .wire(p('biy', 'out'), p(`ty${w}`, 'in'))
        .wire(p(`tx${w}`, 'out'), p(`sx${w}`, 'in'))
        .wire(p(`ty${w}`, 'out'), p(`sy${w}`, 'in'))
        .wire(w === 0 ? p('cin', 'out') : p(`add${w - 1}`, 'Cout'), p(`add${w}`, 'Cin'))
      for (let i = 0; i < 4; i++) {
        b.wire(p(`sx${w}`, `out${i}`), p(`add${w}`, `X${i}`))
          .wire(p(`sy${w}`, `out${i}`), p(`add${w}`, `Y${i}`))
          .wire(p(`add${w}`, `S${i}`), p('mg', `in${4 * w + i}`))
      }
    }
    b.wire(p(`add${words - 1}`, 'Cout'), p('cout', 'in'))
    return b.build()
  }

  const pairs8: [number, number][] = [
    [0x00, 0x00],
    [0x0f, 0x01],
    [0xff, 0x01],
    [0x5a, 0xa5],
    [0x7f, 0x7f],
    [0x80, 0x80],
    [0xab, 0xcd],
    [0xff, 0xff],
    [0x12, 0x34],
    [0xf0, 0x10]
  ]

  for (const cin of [0, 1]) {
    it.each(pairs8)(`two words, Cin = ${cin}: 0x%s + 0x%s equals the 8-bit sum`, (xv, yv) => {
      const c = chained(2, xv, yv, cin)
      const total = xv + yv + cin
      expect(c.bus(p('mgbp', 'in'))).toBe(hexOf(total % 256, 8))
      expect(c.pin(p('cout', 'in'))).toBe(bit(total >= 256 ? 1 : 0))
      // The carry between words must equal the carry out of the low nibble.
      const lowTotal = (xv % 16) + (yv % 16) + cin
      expect(c.pin(p('add0', 'Cout'))).toBe(bit(lowTotal >= 16 ? 1 : 0))
    })
  }

  it.each([
    [0x000, 0x000],
    [0xfff, 0x001],
    [0x123, 0x456],
    [0xfff, 0xfff],
    [0x800, 0x800],
    [0x0ff, 0xf01]
  ])('three words: 0x%s + 0x%s equals the 12-bit sum', (xv, yv) => {
    const c = chained(3, xv, yv, 0)
    const total = xv + yv
    expect(c.bus(p('mgbp', 'in'))).toBe(hexOf(total % 4096, 12))
    expect(c.pin(p('cout', 'in'))).toBe(bit(total >= 4096 ? 1 : 0))
  })

  it('the carry ripples through all three words: FFF + 001 = 000 with Cout = 1', () => {
    const c = chained(3, 0xfff, 0x001, 0)
    expect(c.pin(p('add0', 'Cout'))).toBe(ONE)
    expect(c.pin(p('add1', 'Cout'))).toBe(ONE)
    expect(c.pin(p('add2', 'Cout'))).toBe(ONE)
    expect(c.bus(p('mgbp', 'in'))).toBe('000')
  })
})

// ===========================================================================
// 5. Shared busses: several drivers on one net
// ===========================================================================

/** `values.length` N_TRISTATEs (n bits) with their outputs tied together, then merged. */
function sharedNets(n: number, values: number[], enables: LogicValue[]): Circuit {
  const b = new CircuitBuilder()
  addBusSink(b, 'mg', n)
  values.forEach((v, d) => {
    addBusSource(b, `sp${d}`, n, v)
    b.add(`ts${d}`, ComponentType.N_TRISTATE, { bits: n })
      .switch(`oe${d}`, enables[d])
      .wire(p(`oe${d}`, 'out'), p(`ts${d}`, 'ctl'))
    for (let i = 0; i < n; i++) {
      b.wire(p(`sp${d}`, `out${i}`), p(`ts${d}`, `in${i}`)).wire(p(`ts${d}`, `out${i}`), p('mg', `in${i}`))
    }
  })
  return b.build()
}

/** `values.length` MERGERs whose bus outputs are tied to one bus probe. */
function sharedBus(n: number, values: number[], enables: LogicValue[]): Circuit {
  const b = new CircuitBuilder().add('bp', ComponentType.BUS_PROBE, { bits: n })
  values.forEach((v, d) => {
    addBusSource(b, `sp${d}`, n, v)
    b.add(`ts${d}`, ComponentType.N_TRISTATE, { bits: n })
      .add(`mg${d}`, ComponentType.MERGER, { bits: n })
      .switch(`oe${d}`, enables[d])
      .wire(p(`oe${d}`, 'out'), p(`ts${d}`, 'ctl'))
      .wire(p(`mg${d}`, 'out'), p('bp', 'in'))
    for (let i = 0; i < n; i++) {
      b.wire(p(`sp${d}`, `out${i}`), p(`ts${d}`, `in${i}`)).wire(p(`ts${d}`, `out${i}`), p(`mg${d}`, `in${i}`))
    }
  })
  return b.build()
}

const ENABLE_SETS: [string, LogicValue[]][] = [
  ['none enabled', [ZERO, ZERO]],
  ['only the first enabled', [ONE, ZERO]],
  ['only the second enabled', [ZERO, ONE]],
  ['both enabled', [ONE, ONE]]
]

describe.each([
  [4, 0x5, 0x3],
  [4, 0xf, 0xf],
  [8, 0xa5, 0xa5],
  [8, 0xf0, 0x0f],
  [16, 0xbeef, 0xbeed]
])('two %i-bit tristate drivers on one bus (0x%s and 0x%s)', (n, va, vb) => {
  it.each(ENABLE_SETS)('%s: every bit resolves per decision 3', (_name, enables) => {
    const c = sharedNets(n, [va, vb], enables)
    const drivers = [enables[0] === ONE ? va : null, enables[1] === ONE ? vb : null]
    for (let i = 0; i < n; i++) expect(c.pin(p('ts0', `out${i}`))).toBe(resolveBit(drivers, i))
    expect(c.bus(p('mgbp', 'in'))).toBe(hexOfBits(resolveBus(drivers, n)))
  })

  it.each(ENABLE_SETS)('%s: MERGER outputs tied together resolve the same way', (_name, enables) => {
    const c = sharedBus(n, [va, vb], enables)
    const drivers = [enables[0] === ONE ? va : null, enables[1] === ONE ? vb : null]
    expect(c.bus(p('bp', 'in'))).toBe(hexOfBits(resolveBus(drivers, n)))
  })
})

describe('three tristate drivers on one 4-bit bus', () => {
  const values = [0x5, 0x3, 0x5]
  const combos: LogicValue[][] = []
  for (let m = 0; m < 8; m++) {
    combos.push([bit((m >> 2) & 1), bit((m >> 1) & 1), bit(m & 1)])
  }

  it.each(combos.map((e) => [e.join(''), e] as [string, LogicValue[]]))(
    'enables %s: per-bit resolution over drivers 5, 3, 5',
    (_name, enables) => {
      const c = sharedNets(4, values, enables)
      const drivers = values.map((v, d) => (enables[d] === ONE ? v : null))
      for (let i = 0; i < 4; i++) expect(c.pin(p('ts0', `out${i}`))).toBe(resolveBit(drivers, i))
      expect(c.bus(p('mgbp', 'in'))).toBe(hexOfBits(resolveBus(drivers, 4)))
    }
  )

  it('two agreeing drivers (5 and 5) keep the value; adding the third (3) makes the mismatched bits X', () => {
    const c = sharedNets(4, values, [ONE, ZERO, ONE])
    expect(c.bus(p('mgbp', 'in'))).toBe('5')
    c.set('oe1', ONE)
    expect(c.bus(p('mgbp', 'in'))).toBe('X')
    c.setMany({ oe0: ZERO, oe2: ZERO })
    expect(c.bus(p('mgbp', 'in'))).toBe('3')
    c.set('oe1', ZERO)
    expect(c.bus(p('mgbp', 'in'))).toBe('Z')
  })
})

describe('hand-over between two drivers of the same value (decision 12)', () => {
  it('swapping enables in one instant leaves the shared nets and the probe trace untouched', () => {
    const c = sharedNets(4, [0x7, 0x7], [ONE, ZERO])
    expect(c.bus(p('mgbp', 'in'))).toBe('7')
    expect(busTrace(c, 'mgbp')).toEqual([[0, '7']])
    c.setMany({ oe0: ZERO, oe1: ONE })
    expect(c.bus(p('mgbp', 'in'))).toBe('7')
    expect(busTrace(c, 'mgbp')).toEqual([[0, '7']])
  })

  it('the same hand-over between two MERGER drivers on one bus leaves the trace untouched', () => {
    const c = sharedBus(4, [0x7, 0x7], [ONE, ZERO])
    expect(busTrace(c, 'bp')).toEqual([[0, '7']])
    c.setMany({ oe0: ZERO, oe1: ONE })
    expect(c.bus(p('bp', 'in'))).toBe('7')
    expect(busTrace(c, 'bp')).toEqual([[0, '7']])
  })

  it('a hand-over between drivers of different values does record the change', () => {
    const c = sharedNets(4, [0x7, 0x8], [ONE, ZERO])
    c.setMany({ oe0: ZERO, oe1: ONE })
    expect(c.bus(p('mgbp', 'in'))).toBe('8')
    expect(busTrace(c, 'mgbp').map(([, h]) => h)).toEqual(['7', '8'])
  })
})

describe('a driver narrower than the bus leaves the missing high bits X (decision 3)', () => {
  it('a 4-bit BUS_INPUT on an 8-bit bus: low nibble clean, high nibble X', () => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 4, label: 'a' })
      .add('sp', ComponentType.SPLITTER, { bits: 8 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 8 })
      .wire(p('bi', 'out'), p('sp', 'in'))
      .wire(p('bi', 'out'), p('bp', 'in'))
      .build()
    expect(c.bus(p('bp', 'in'))).toBe('XX')
    for (let i = 0; i < 8; i++) expect(c.pin(p('sp', `out${i}`))).toBe(i < 4 ? bit(bitAt(0xa, i)) : X)
  })

  it('a 4-bit MERGER on an 8-bit bus drives only bits 0..3', () => {
    const b = new CircuitBuilder()
      .add('mg', ComponentType.MERGER, { bits: 4 })
      .add('sp', ComponentType.SPLITTER, { bits: 8 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 8 })
      .wire(p('mg', 'out'), p('sp', 'in'))
      .wire(p('mg', 'out'), p('bp', 'in'))
    for (let i = 0; i < 4; i++) b.switch(`s${i}`, ZERO).wire(p(`s${i}`, 'out'), p('mg', `in${i}`))
    const c = b.build()
    for (const v of [0, 5, 10, 15]) {
      c.setMany(bitsToSwitches('s', binOf(v, 4)))
      expect(c.bus(p('bp', 'in'))).toBe('XX')
      for (let i = 0; i < 8; i++) expect(c.pin(p('sp', `out${i}`))).toBe(i < 4 ? bit(bitAt(v, i)) : X)
    }
  })

  it('a wide driver and a narrow driver together: the narrow one only contends over its own bits', () => {
    // 8-bit 0x5A and 4-bit 0xA agree on bits 0..3; bits 4..7 are X because the
    // narrow driver contributes X there.
    const c = new CircuitBuilder()
      .add('wide', ComponentType.BUS_INPUT, { bits: 8, label: '5a' })
      .add('narrow', ComponentType.BUS_INPUT, { bits: 4, label: 'a' })
      .add('sp', ComponentType.SPLITTER, { bits: 8 })
      .wire(p('wide', 'out'), p('narrow', 'out'))
      .wire(p('wide', 'out'), p('sp', 'in'))
      .build()
    for (let i = 0; i < 8; i++) expect(c.pin(p('sp', `out${i}`))).toBe(i < 4 ? bit(bitAt(0x5a, i)) : X)
  })
})

// ===========================================================================
// 6. N_MUX_2TO1 against an array of MUX_2 parts
// ===========================================================================

type SelFeed = 'switch' | 'open' | 'x'

/** N_MUX_2TO1 and a MUX_2 array selecting between the same two busses. */
function muxPair(n: number, xv: number, yv: number, sel: SelFeed): Circuit {
  const b = new CircuitBuilder()
  addBusSource(b, 'spx', n, xv)
  addBusSource(b, 'spy', n, yv)
  addBusSink(b, 'mgn', n)
  addBusSink(b, 'mgm', n)
  b.add('nm', ComponentType.N_MUX_2TO1, { bits: n })
  if (sel === 'switch') b.switch('s', ZERO).wire(p('s', 'out'), p('nm', 'S'))
  else if (sel === 'x') b.add('xs', ComponentType.NOT).wire(p('xs', 'out'), p('nm', 'S'))
  for (let i = 0; i < n; i++) {
    b.add(`m${i}`, ComponentType.MUX_2)
      .wire(p('spx', `out${i}`), p('nm', `X${i}`))
      .wire(p('spy', `out${i}`), p('nm', `Y${i}`))
      .wire(p('nm', `Z${i}`), p('mgn', `in${i}`))
      .wire(p('spx', `out${i}`), p(`m${i}`, 'in0'))
      .wire(p('spy', `out${i}`), p(`m${i}`, 'in1'))
      .wire(p(`m${i}`, 'Z'), p('mgm', `in${i}`))
    if (sel === 'switch') b.wire(p('s', 'out'), p(`m${i}`, 'A'))
    else if (sel === 'x') b.wire(p('xs', 'out'), p(`m${i}`, 'A'))
  }
  return b.build()
}

const MUX_PAIRS: Record<number, [number, number][]> = {
  2: [
    [0, 3],
    [1, 2],
    [3, 3],
    [2, 0]
  ],
  4: [
    [0x0, 0xf],
    [0x5, 0xa],
    [0x3, 0xc],
    [0x9, 0x6],
    [0xf, 0xf],
    [0x1, 0x8]
  ],
  8: [
    [0x00, 0xff],
    [0x5a, 0xa5],
    [0x0f, 0xf0],
    [0x81, 0x18],
    [0xff, 0xff],
    [0x01, 0x80]
  ],
  16: [
    [0x0000, 0xffff],
    [0xbeef, 0xdead],
    [0x00ff, 0xff00],
    [0x1234, 0x4321],
    [0xaaaa, 0x5555]
  ]
}

describe.each([2, 4, 8, 16])('N_MUX_2TO1(%i) against a bitwise MUX_2 array', (n) => {
  it.each(MUX_PAIRS[n])('X = 0x%s, Y = 0x%s: S = 0 selects X and S = 1 selects Y on both', (xv, yv) => {
    const c = muxPair(n, xv, yv, 'switch')
    expect(c.bus(p('mgn', 'out'))).toBe(hexOf(xv, n))
    expect(c.bus(p('mgm', 'out'))).toBe(hexOf(xv, n))
    expect(c.vec('nm', 'Z', n)).toBe(binOf(xv, n))
    c.set('s', ONE)
    expect(c.bus(p('mgn', 'out'))).toBe(hexOf(yv, n))
    expect(c.bus(p('mgm', 'out'))).toBe(hexOf(yv, n))
    expect(c.vec('nm', 'Z', n)).toBe(binOf(yv, n))
    c.set('s', ZERO)
    expect(c.bus(p('mgn', 'out'))).toBe(hexOf(xv, n))
    expect(c.bus(p('mgm', 'out'))).toBe(hexOf(xv, n))
  })

  it('an unconnected select makes every output bit X on both implementations', () => {
    const c = muxPair(n, mask(n), 0, 'open')
    expect(c.bus(p('mgnbp', 'in'))).toBe(fillOf('X', n))
    expect(c.bus(p('mgmbp', 'in'))).toBe(fillOf('X', n))
  })

  it('an X select makes every output bit X on both implementations', () => {
    const c = muxPair(n, mask(n), 0, 'x')
    expect(c.bus(p('mgnbp', 'in'))).toBe(fillOf('X', n))
    expect(c.bus(p('mgmbp', 'in'))).toBe(fillOf('X', n))
  })
})

describe('N_MUX_2TO1(4) vs MUX_2 array over the full 16 x 16 data space', () => {
  /** Switch-driven operands so all 256 pairs run on one circuit. */
  function sweeper(): Circuit {
    const b = new CircuitBuilder()
      .add('nm', ComponentType.N_MUX_2TO1, { bits: 4 })
      .switch('s', ZERO)
      .wire(p('s', 'out'), p('nm', 'S'))
    addBusSink(b, 'mgx', 4)
    addBusSink(b, 'mgy', 4)
    addBusSink(b, 'mgn', 4)
    addBusSink(b, 'mgm', 4)
    b.add('spx', ComponentType.SPLITTER, { bits: 4 })
      .add('spy', ComponentType.SPLITTER, { bits: 4 })
      .wire(p('mgx', 'out'), p('spx', 'in'))
      .wire(p('mgy', 'out'), p('spy', 'in'))
    for (let i = 0; i < 4; i++) {
      b.switch(`x${i}`, ZERO)
        .switch(`y${i}`, ZERO)
        .wire(p(`x${i}`, 'out'), p('mgx', `in${i}`))
        .wire(p(`y${i}`, 'out'), p('mgy', `in${i}`))
        .add(`m${i}`, ComponentType.MUX_2)
        .wire(p('spx', `out${i}`), p('nm', `X${i}`))
        .wire(p('spy', `out${i}`), p('nm', `Y${i}`))
        .wire(p('nm', `Z${i}`), p('mgn', `in${i}`))
        .wire(p('spx', `out${i}`), p(`m${i}`, 'in0'))
        .wire(p('spy', `out${i}`), p(`m${i}`, 'in1'))
        .wire(p('s', 'out'), p(`m${i}`, 'A'))
        .wire(p(`m${i}`, 'Z'), p('mgm', `in${i}`))
    }
    return b.build()
  }

  it.each([ZERO, ONE])('S = %s: both implementations agree for all 256 (X, Y) pairs', (s) => {
    const c = sweeper()
    c.set('s', s)
    for (let xv = 0; xv < 16; xv++) {
      for (let yv = 0; yv < 16; yv++) {
        c.setMany({ ...bitsToSwitches('x', binOf(xv, 4)), ...bitsToSwitches('y', binOf(yv, 4)) })
        const expected = hexOf(s === ZERO ? xv : yv, 4)
        expect(c.bus(p('mgn', 'out'))).toBe(expected)
        expect(c.bus(p('mgm', 'out'))).toBe(expected)
      }
    }
  })
})

describe('N_MUX_2TO1 and MUX_2 agree on undetermined data bits', () => {
  it('an X on the selected side propagates; the same X on the unselected side does not', () => {
    // X0 is driven X (NOT with an open input); Y0 comes from a switch.
    const b = new CircuitBuilder()
      .add('nm', ComponentType.N_MUX_2TO1, { bits: 4 })
      .add('m0', ComponentType.MUX_2)
      .add('xs', ComponentType.NOT)
      .switch('s', ZERO)
      .switch('y0', ONE)
      .add('gnd', ComponentType.GROUND)
      .wire(p('s', 'out'), p('nm', 'S'))
      .wire(p('s', 'out'), p('m0', 'A'))
      .wire(p('xs', 'out'), p('nm', 'X0'))
      .wire(p('xs', 'out'), p('m0', 'in0'))
      .wire(p('y0', 'out'), p('nm', 'Y0'))
      .wire(p('y0', 'out'), p('m0', 'in1'))
    for (let i = 1; i < 4; i++) {
      b.wire(p('gnd', 'out'), p('nm', `X${i}`)).wire(p('gnd', 'out'), p('nm', `Y${i}`))
    }
    const c = b.build()
    expect(c.pin(p('nm', 'Z0'))).toBe(X)
    expect(c.pin(p('m0', 'Z'))).toBe(X)
    c.set('s', ONE)
    expect(c.pin(p('nm', 'Z0'))).toBe(ONE)
    expect(c.pin(p('m0', 'Z'))).toBe(ONE)
  })

  it('an unconnected selected input reads X on both parts', () => {
    const b = new CircuitBuilder()
      .add('nm', ComponentType.N_MUX_2TO1, { bits: 2 })
      .add('m0', ComponentType.MUX_2)
      .switch('s', ZERO)
      .add('gnd', ComponentType.GROUND)
      .wire(p('s', 'out'), p('nm', 'S'))
      .wire(p('s', 'out'), p('m0', 'A'))
      .wire(p('gnd', 'out'), p('nm', 'X1'))
      .wire(p('gnd', 'out'), p('nm', 'Y0'))
      .wire(p('gnd', 'out'), p('nm', 'Y1'))
      .wire(p('gnd', 'out'), p('m0', 'in1'))
    const c = b.build()
    expect(c.pin(p('nm', 'Z0'))).toBe(X)
    expect(c.pin(p('m0', 'Z'))).toBe(X)
    c.set('s', ONE)
    expect(c.pin(p('nm', 'Z0'))).toBe(ZERO)
    expect(c.pin(p('m0', 'Z'))).toBe(ZERO)
  })
})

// ===========================================================================
// 7. A bus-based register-file slice under the CLOCK part
// ===========================================================================

/**
 * Two 4-bit registers loaded from two bus inputs, read back onto one shared bus
 * through three N_TRISTATEs (ts0 and ts2 both read r0, so they agree), merged
 * into a BUS_PROBE. Controls come from INPUT_SIGNALs so every event sits on the
 * clock grid: rows change a quarter period after an active edge, testbench style.
 */
function registerFile(): Circuit {
  const b = new CircuitBuilder()
    .add('clk', ComponentType.CLOCK)
    .add('gnd', ComponentType.GROUND)
    .add('r0', ComponentType.N_REGISTER, { bits: 4 })
    .add('r1', ComponentType.N_REGISTER, { bits: 4 })
    .add('ts0', ComponentType.N_TRISTATE, { bits: 4 })
    .add('ts1', ComponentType.N_TRISTATE, { bits: 4 })
    .add('ts2', ComponentType.N_TRISTATE, { bits: 4 })
    .add('ld0', ComponentType.INPUT_SIGNAL, { signal: [row(0, ZERO), row(5, ONE), row(25, ZERO)] })
    .add('ld1', ComponentType.INPUT_SIGNAL, { signal: [row(0, ZERO), row(25, ONE), row(45, ZERO)] })
    .add('oe0', ComponentType.INPUT_SIGNAL, {
      signal: [row(0, ZERO), row(45, ONE), row(85, ZERO), row(125, ONE), row(145, ZERO)]
    })
    .add('oe1', ComponentType.INPUT_SIGNAL, { signal: [row(0, ZERO), row(65, ONE), row(105, ZERO)] })
    .add('oe2', ComponentType.INPUT_SIGNAL, { signal: [row(0, ZERO), row(125, ONE), row(165, ZERO)] })
    .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 200 })
  addBusSource(b, 'spa', 4, 0x5)
  addBusSource(b, 'spb', 4, 0xa)
  addBusSink(b, 'mg', 4)
  b.wire(p('clk', 'out'), p('r0', 'CLK'))
    .wire(p('clk', 'out'), p('r1', 'CLK'))
    .wire(p('gnd', 'out'), p('r0', 'CLR'))
    .wire(p('gnd', 'out'), p('r1', 'CLR'))
    .wire(p('ld0', 'out'), p('r0', 'Ld'))
    .wire(p('ld1', 'out'), p('r1', 'Ld'))
    .wire(p('oe0', 'out'), p('ts0', 'ctl'))
    .wire(p('oe1', 'out'), p('ts1', 'ctl'))
    .wire(p('oe2', 'out'), p('ts2', 'ctl'))
  for (let i = 0; i < 4; i++) {
    b.wire(p('spa', `out${i}`), p('r0', `D${i}`))
      .wire(p('spb', `out${i}`), p('r1', `D${i}`))
      .wire(p('r0', `Q${i}`), p('ts0', `in${i}`))
      .wire(p('r1', `Q${i}`), p('ts1', `in${i}`))
      .wire(p('r0', `Q${i}`), p('ts2', `in${i}`))
      .wire(p('ts0', `out${i}`), p('ts1', `out${i}`))
      .wire(p('ts0', `out${i}`), p('ts2', `out${i}`))
      .wire(p('ts0', `out${i}`), p('mg', `in${i}`))
  }
  return b.build()
}

describe('register file slice: two registers reading onto one bus through tristates', () => {
  it('nothing drives the bus at t = 0 and both registers are unknown', () => {
    const c = registerFile()
    expect(c.time).toBe(0)
    expect(c.bus(p('mgbp', 'in'))).toBe('Z')
    expect(c.vec('r0', 'Q', 4)).toBe('XXXX')
    expect(c.vec('r1', 'Q', 4)).toBe('XXXX')
  })

  it('steps through the whole write/read sequence one clock period at a time', () => {
    const c = registerFile()
    const expected: [number, string, string, string][] = [
      // [time after the step, bus hex, r0 Q, r1 Q]
      [15, 'Z', 'XXXX', 'XXXX'], // no edge yet
      [35, 'Z', '0101', 'XXXX'], // edge 20 loaded r0 (Ld0 = 1)
      [55, '5', '0101', '1010'], // edge 40 loaded r1; oe0 rose at 45
      [75, 'X', '0101', '1010'], // oe1 rose at 65: 0101 against 1010 on every bit
      [95, 'A', '0101', '1010'], // oe0 fell at 85: r1 alone
      [115, 'Z', '0101', '1010'], // oe1 fell at 105: nobody drives
      [135, '5', '0101', '1010'], // oe0 and oe2 rose together at 125, both read r0
      [155, '5', '0101', '1010'], // oe0 fell at 145: ts2 keeps the same value
      [175, 'Z', '0101', '1010'] // oe2 fell at 165
    ]
    for (const [t, hex, q0, q1] of expected) {
      c.step()
      expect(c.time).toBe(t)
      expect(c.bus(p('mgbp', 'in'))).toBe(hex)
      expect(c.vec('r0', 'Q', 4)).toBe(q0)
      expect(c.vec('r1', 'Q', 4)).toBe(q1)
    }
  })

  it('the BUS_PROBE trace records one sample per real change, and none for the hand-over at 145', () => {
    const c = registerFile()
    c.go()
    expect(c.time).toBe(195)
    expect(busTrace(c, 'mgbp')).toEqual([
      [0, 'Z'],
      [47, '5'], // oe0 at 45 -> tristate 46 -> merger 47
      [67, 'X'], // oe1 at 65 -> both drivers disagree on every bit
      [87, 'A'], // oe0 released at 85
      [107, 'Z'], // oe1 released at 105
      [127, '5'], // oe0 and oe2 enabled together at 125
      [167, 'Z'] // oe2 released at 165 (the 145 hand-over changed nothing)
    ])
  })

  it('the shared single-bit nets carry the resolved bits while both registers drive', () => {
    const c = registerFile()
    for (let i = 0; i < 4; i++) c.step() // to 75: ts0 (0101) and ts1 (1010) both enabled
    expect(c.time).toBe(75)
    for (let i = 0; i < 4; i++) expect(c.pin(p('ts0', `out${i}`))).toBe(X)
    // Step is not capped by simTimeNs (decision 5): eight more periods reach 235.
    for (let i = 0; i < 8; i++) c.step() // past 165: everything released
    expect(c.time).toBe(235)
    for (let i = 0; i < 4; i++) expect(c.pin(p('ts0', `out${i}`))).toBe(Z)
  })

  it('a reset puts time back to 0, clears the registers to X and releases the bus', () => {
    const c = registerFile()
    c.go()
    c.reset()
    expect(c.time).toBe(0)
    expect(c.vec('r0', 'Q', 4)).toBe('XXXX')
    expect(c.bus(p('mgbp', 'in'))).toBe('Z')
    expect(busTrace(c, 'mgbp')).toEqual([[0, 'Z']])
  })
})

// ===========================================================================
// 8. An 8-bit accumulator over many clocks
// ===========================================================================

/** N_REGISTER(n) + N_ADDER(n) accumulating `addend` (from a bus input) each edge. */
function accumulator(n: number, addend: number, cin: LogicValue): Circuit {
  const b = new CircuitBuilder()
    .add('clk', ComponentType.CLOCK)
    .add('vcc', ComponentType.VCC)
    .switch('clr', ONE)
    .add('reg', ComponentType.N_REGISTER, { bits: n })
    .add('add', ComponentType.N_ADDER, { bits: n })
    .probe('cout')
    .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 400 })
  addBusSource(b, 'spy', n, addend)
  addBusSink(b, 'mg', n)
  b.wire(p('clk', 'out'), p('reg', 'CLK'))
    .wire(p('vcc', 'out'), p('reg', 'Ld'))
    .wire(p('clr', 'out'), p('reg', 'CLR'))
    .wire(p('add', 'Cout'), p('cout', 'in'))
  if (cin === ONE) b.wire(p('vcc', 'out'), p('add', 'Cin'))
  else b.add('gnd', ComponentType.GROUND).wire(p('gnd', 'out'), p('add', 'Cin'))
  for (let i = 0; i < n; i++) {
    b.wire(p('spy', `out${i}`), p('add', `Y${i}`))
      .wire(p('reg', `Q${i}`), p('add', `X${i}`))
      .wire(p('add', `S${i}`), p('reg', `D${i}`))
      .wire(p('reg', `Q${i}`), p('mg', `in${i}`))
  }
  return b.build()
}

describe('8-bit accumulator on a bus (register + adder under the CLOCK part)', () => {
  it.each([1, 0x0d, 0x37, 0x80, 0xff, 0x55])('accumulates 0x%s for 12 clocks, hex checked each step', (addend) => {
    const c = accumulator(8, addend, ZERO)
    c.step() // to 15: no active edge yet
    c.step() // edge at 20 with CLR = 1 clears the register
    expect(c.bus(p('mgbp', 'in'))).toBe('00')
    c.set('clr', ZERO)
    for (let k = 1; k <= 12; k++) {
      c.step()
      expect(c.bus(p('mgbp', 'in'))).toBe(hexOf((k * addend) % 256, 8))
      expect(c.vec('reg', 'Q', 8)).toBe(binOf((k * addend) % 256, 8))
    }
  })

  it('Cout of the accumulating adder marks every wrap past 255 (addend 0x37)', () => {
    const c = accumulator(8, 0x37, ZERO)
    c.step()
    c.step()
    c.set('clr', ZERO)
    for (let k = 1; k <= 12; k++) {
      c.step()
      // Cout reflects the SUM being fed back, i.e. the (k+1)-th total.
      const next = (k * 0x37) % 256 + 0x37
      expect(c.pin(p('cout', 'in'))).toBe(bit(next >= 256 ? 1 : 0))
    }
  })

  it('with Cin tied high the accumulator adds addend + 1 each clock', () => {
    const c = accumulator(8, 0x0f, ONE)
    c.step()
    c.step()
    c.set('clr', ZERO)
    for (let k = 1; k <= 10; k++) {
      c.step()
      expect(c.bus(p('mgbp', 'in'))).toBe(hexOf((k * 0x10) % 256, 8))
    }
  })

  it('the BUS_PROBE trace of the accumulator shows X before the clear and then one sample per clock', () => {
    const c = accumulator(8, 0x0d, ZERO)
    c.step()
    c.step()
    c.set('clr', ZERO)
    for (let k = 1; k <= 5; k++) c.step()
    expect(busTrace(c, 'mgbp')).toEqual([
      [0, 'XX'], // the register powers up unknown
      [22, '00'], // edge 20 cleared it (Q at 21, merger at 22)
      [42, '0D'],
      [62, '1A'],
      [82, '27'],
      [102, '34'],
      [122, '41']
    ])
  })

  it('a 16-bit accumulator takes its addend from bits 7:0 of a 16-bit bus through a BUS_TAP', () => {
    const b = new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .add('vcc', ComponentType.VCC)
      .add('gnd', ComponentType.GROUND)
      .switch('clr', ONE)
      .add('reg', ComponentType.N_REGISTER, { bits: 16 })
      .add('add', ComponentType.N_ADDER, { bits: 16 })
      .add('bi', ComponentType.BUS_INPUT, { bits: 16, label: 'ab34' })
      .add('tap', ComponentType.BUS_TAP, { bits: 8, tapStart: 0 })
      .add('spy', ComponentType.SPLITTER, { bits: 8 })
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 400 })
      .wire(p('bi', 'out'), p('tap', 'in'))
      .wire(p('tap', 'out'), p('spy', 'in'))
      .wire(p('clk', 'out'), p('reg', 'CLK'))
      .wire(p('vcc', 'out'), p('reg', 'Ld'))
      .wire(p('clr', 'out'), p('reg', 'CLR'))
      .wire(p('gnd', 'out'), p('add', 'Cin'))
    addBusSink(b, 'mg', 16)
    for (let i = 0; i < 16; i++) {
      b.wire(p('reg', `Q${i}`), p('add', `X${i}`))
        .wire(p('add', `S${i}`), p('reg', `D${i}`))
        .wire(p('reg', `Q${i}`), p('mg', `in${i}`))
      if (i < 8) b.wire(p('spy', `out${i}`), p('add', `Y${i}`))
      else b.wire(p('gnd', 'out'), p('add', `Y${i}`))
    }
    const c = b.build()
    expect(c.bus(p('tap', 'out'))).toBe('34')
    c.step()
    c.step()
    expect(c.bus(p('mgbp', 'in'))).toBe('0000')
    c.set('clr', ZERO)
    for (let k = 1; k <= 8; k++) {
      c.step()
      expect(c.bus(p('mgbp', 'in'))).toBe(hexOf(k * 0x34, 16))
    }
  })
})

// ===========================================================================
// 9. Pin-value partitioning and bus-probe waveform samples
// ===========================================================================

/** One circuit mixing every pin flavour: bus pins, single-bit pins, a 1-bit tap. */
function mixedCircuit(): Circuit {
  const b = new CircuitBuilder()
    .add('bi', ComponentType.BUS_INPUT, { bits: 8, label: '5a' })
    .add('sp', ComponentType.SPLITTER, { bits: 8 })
    .add('tap1', ComponentType.BUS_TAP, { bits: 1, tapStart: 2 })
    .add('tap4', ComponentType.BUS_TAP, { bits: 4, tapStart: 4 })
    .add('cp', ComponentType.COMPLEMENTER, { bits: 8 })
    .add('cbp', ComponentType.BUS_PROBE, { bits: 8 })
    .add('tbp', ComponentType.BUS_PROBE, { bits: 4 })
    .add('n', ComponentType.NOT)
    .probe('y')
    .switch('en', ONE)
    .wire(p('bi', 'out'), p('sp', 'in'))
    .wire(p('bi', 'out'), p('tap1', 'in'))
    .wire(p('bi', 'out'), p('tap4', 'in'))
    .wire(p('bi', 'out'), p('cp', 'in'))
    .wire(p('en', 'out'), p('cp', 'en'))
    .wire(p('cp', 'out'), p('cbp', 'in'))
    .wire(p('tap4', 'out'), p('tbp', 'in'))
    .wire(p('tap1', 'out'), p('n', 'in1'))
    .wire(p('n', 'out'), p('y', 'in'))
  addBusSink(b, 'mg', 8)
  for (let i = 0; i < 8; i++) b.wire(p('sp', `out${i}`), p('mg', `in${i}`))
  return b.build()
}

describe('getPinValues / getBusPinValues partition every pin by NET width', () => {
  const c = mixedCircuit()
  const netPins = c.sim.getPinValues()
  const busPins = c.sim.getBusPinValues()

  it('no pin appears in both maps', () => {
    const both = Object.keys(netPins).filter((k) => k in busPins)
    expect(both).toEqual([])
  })

  it.each([
    p('bi', 'out'),
    p('sp', 'in'),
    p('cp', 'in'),
    p('cp', 'out'),
    p('cbp', 'in'),
    p('tap4', 'out'),
    p('tbp', 'in'),
    p('mg', 'out'),
    p('mgbp', 'in'),
    // The BUS_TAP input pin declares no width of its own, but it sits on an
    // 8-bit net, so it is classified as a bus pin like every other pin there.
    p('tap1', 'in'),
    p('tap4', 'in')
  ])('%s is a bus pin', (pinId) => {
    expect(pinId in busPins).toBe(true)
    expect(pinId in netPins).toBe(false)
  })

  it.each([
    p('sp', 'out0'),
    p('sp', 'out7'),
    p('mg', 'in0'),
    p('cp', 'en'),
    p('tap1', 'out'),
    p('n', 'in1'),
    p('n', 'out'),
    p('y', 'in'),
    p('en', 'out')
  ])('%s is a single-bit pin', (pinId) => {
    expect(pinId in netPins).toBe(true)
    expect(pinId in busPins).toBe(false)
  })

  it('a 1-bit BUS_TAP output is a NET, not a bus: it reads as a plain logic value', () => {
    expect(netPins[p('tap1', 'out')]).toBe(bit(bitAt(0x5a, 2)))
    expect(c.pin(p('tap1', 'out'))).toBe(bit(bitAt(0x5a, 2)))
    expect(() => c.bus(p('tap1', 'out'))).toThrow()
  })

  it('a bus pin cannot be read as a single net value', () => {
    expect(() => c.pin(p('bi', 'out'))).toThrow()
  })

  it('every pin on one bus net reports the same hex', () => {
    expect(busPins[p('bi', 'out')]).toBe('5A')
    expect(busPins[p('sp', 'in')]).toBe('5A')
    expect(busPins[p('cp', 'in')]).toBe('5A')
    expect(busPins[p('tap4', 'out')]).toBe('5')
    expect(busPins[p('tbp', 'in')]).toBe('5')
    expect(busPins[p('cbp', 'in')]).toBe('A5')
    expect(busPins[p('mgbp', 'in')]).toBe('5A')
  })

  it('single-bit pin values match the split bus bits', () => {
    for (let i = 0; i < 8; i++) expect(netPins[p('sp', `out${i}`)]).toBe(bit(bitAt(0x5a, i)))
    expect(netPins[p('y', 'in')]).toBe(bit(1 - bitAt(0x5a, 2)))
  })

  it('an unconnected bus pin reads as a Z fill and an unconnected net pin as Z', () => {
    const lone = new CircuitBuilder()
      .add('bp', ComponentType.BUS_PROBE, { bits: 8 })
      .add('g', ComponentType.AND2)
      .build()
    expect(lone.sim.getBusPinValues()[p('bp', 'in')]).toBe('ZZ')
    expect(lone.sim.getPinValues()[p('g', 'in1')]).toBe(Z)
  })
})

describe('BUS_PROBE waveform samples', () => {
  it('bus traces are flagged bus, carry hex and use X for the (meaningless) single-bit value', () => {
    const c = mixedCircuit()
    const trace = c.sim.getWaveforms().find((w) => w.probeId === 'cbp')!
    expect(trace.bus).toBe(true)
    expect(trace.samples).toHaveLength(1)
    expect(trace.samples[0]).toEqual({ t: 0, v: X, hex: 'A5' })
  })

  it('single-bit probe traces are not bus traces and carry no hex', () => {
    const c = mixedCircuit()
    const trace = c.sim.getWaveforms().find((w) => w.probeId === 'y')!
    expect(trace.bus).toBe(false)
    expect(trace.samples[0].hex).toBeUndefined()
    expect(trace.samples[0]).toEqual({ t: 0, v: bit(1 - bitAt(0x5a, 2)) })
  })

  it('every bus probe in the circuit gets its own trace', () => {
    const c = mixedCircuit()
    const ids = c.sim.getWaveforms().map((w) => w.probeId)
    expect(ids).toContain('cbp')
    expect(ids).toContain('tbp')
    expect(ids).toContain('mgbp')
    expect(ids).toContain('y')
    expect(c.sim.getWaveforms().filter((w) => w.bus).map((w) => w.probeId).sort()).toEqual([
      'cbp',
      'mgbp',
      'tbp'
    ])
  })

  it('bus samples across a run are non-decreasing in time and never repeat a value', () => {
    const c = accumulator(8, 0x3f, ZERO)
    c.step()
    c.step()
    c.set('clr', ZERO)
    for (let k = 1; k <= 10; k++) c.step()
    const samples = busTrace(c, 'mgbp')
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i][0]).toBeGreaterThan(samples[i - 1][0])
      expect(samples[i][1]).not.toBe(samples[i - 1][1])
    }
    expect(samples.map(([, h]) => h)).toEqual([
      'XX',
      '00',
      '3F',
      '7E',
      'BD',
      'FC',
      '3B',
      '7A',
      'B9',
      'F8',
      '37',
      '76'
    ])
  })

  it('a bus probe on a shared bus records the Z / value / X phases in order', () => {
    const c = sharedNets(4, [0x9, 0x6], [ZERO, ZERO])
    expect(c.bus(p('mgbp', 'in'))).toBe('Z')
    c.set('oe0', ONE)
    expect(c.bus(p('mgbp', 'in'))).toBe('9')
    c.set('oe1', ONE)
    expect(c.bus(p('mgbp', 'in'))).toBe('X')
    c.set('oe0', ZERO)
    expect(c.bus(p('mgbp', 'in'))).toBe('6')
    c.set('oe1', ZERO)
    expect(c.bus(p('mgbp', 'in'))).toBe('Z')
    expect(busTrace(c, 'mgbp').map(([, h]) => h)).toEqual(['Z', '9', 'X', '6', 'Z'])
  })
})

// ===========================================================================
// 10. Timing along a bus pipeline (delays, inertial cancellation)
// ===========================================================================

/**
 * switches -> MERGER(dm) -> bus -> BUS_TAP(dt) -> bus -> SPLITTER(ds) -> probes.
 * Every stage has its own probe so the arrival time of each stage is observable.
 */
function busPipeline(dm: number, dt: number, ds: number): Circuit {
  const b = new CircuitBuilder()
    .add('mg', ComponentType.MERGER, { bits: 4, delay: dm })
    .add('bp1', ComponentType.BUS_PROBE, { bits: 4 })
    .add('tap', ComponentType.BUS_TAP, { bits: 2, tapStart: 1, delay: dt })
    .add('bp2', ComponentType.BUS_PROBE, { bits: 2 })
    .add('sp', ComponentType.SPLITTER, { bits: 2, delay: ds })
    .probe('py0')
    .probe('py1')
    .wire(p('mg', 'out'), p('bp1', 'in'))
    .wire(p('mg', 'out'), p('tap', 'in'))
    .wire(p('tap', 'out'), p('bp2', 'in'))
    .wire(p('tap', 'out'), p('sp', 'in'))
    .wire(p('sp', 'out0'), p('py0', 'in'))
    .wire(p('sp', 'out1'), p('py1', 'in'))
  for (let i = 0; i < 4; i++) b.switch(`s${i}`, ZERO).wire(p(`s${i}`, 'out'), p('mg', `in${i}`))
  return b.build()
}

describe('a bus pipeline propagates one part delay at a time', () => {
  it.each([
    [1, 1, 1],
    [2, 3, 4],
    [5, 1, 2],
    [1, 7, 1]
  ])('MERGER delay %i, BUS_TAP delay %i, SPLITTER delay %i', (dm, dt, ds) => {
    const c = busPipeline(dm, dt, ds)
    expect(c.time).toBe(0)
    expect(busTrace(c, 'bp1')).toEqual([[0, '0']])
    expect(busTrace(c, 'bp2')).toEqual([[0, '0']])

    c.set('s1', ONE) // bit 1 of the merged bus goes high
    // switch 1 ns + merger + tap + splitter, each stage strictly after the last.
    expect(busTrace(c, 'bp1')).toEqual([
      [0, '0'],
      [1 + dm, '2']
    ])
    expect(busTrace(c, 'bp2')).toEqual([
      [0, '0'],
      [1 + dm + dt, '1']
    ])
    expect(netTrace(c, 'py0')).toEqual([
      [0, ZERO],
      [1 + dm + dt + ds, ONE]
    ])
    expect(netTrace(c, 'py1')).toEqual([[0, ZERO]])
    expect(c.time).toBe(1 + dm + dt + ds)
  })

  it('a bit outside the tapped range moves the source bus but never the tap output', () => {
    const c = busPipeline(1, 1, 1) // tap covers bits 2:1
    c.set('s3', ONE)
    expect(c.time).toBe(2) // switch 1 + merger 1; the tap plans no change
    c.set('s3', ZERO)
    expect(busTrace(c, 'bp1')).toEqual([
      [0, '0'],
      [2, '8'],
      [4, '0']
    ])
    expect(busTrace(c, 'bp2')).toEqual([[0, '0']])
    expect(netTrace(c, 'py0')).toEqual([[0, ZERO]])
  })

  it('a bit inside the tapped range moves every stage, each one delay later', () => {
    const c = busPipeline(1, 1, 1)
    c.set('s2', ONE) // bit 2 is the high bit of the 2:1 tap
    expect(c.time).toBe(4) // switch 1 + merger 1 + tap 1 + splitter 1
    c.set('s2', ZERO)
    expect(busTrace(c, 'bp1')).toEqual([
      [0, '0'],
      [2, '4'],
      [6, '0']
    ])
    expect(busTrace(c, 'bp2')).toEqual([
      [0, '0'],
      [3, '2'],
      [7, '0']
    ])
    expect(netTrace(c, 'py1')).toEqual([
      [0, ZERO],
      [4, ONE],
      [8, ZERO]
    ])
  })
})

describe('inertial delay on a bus output (decision 2)', () => {
  /** AND(CLK, NOT CLK) glitches for 1 ns after each rising edge; it feeds bit 0. */
  function glitchToBus(mergerDelay: number, andDelay: number): Circuit {
    const b = new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .add('gnd', ComponentType.GROUND)
      .add('n', ComponentType.NOT, { delay: 1 })
      .add('g', ComponentType.AND2, { delay: andDelay })
      .add('mg', ComponentType.MERGER, { bits: 4, delay: mergerDelay })
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
      .wire(p('clk', 'out'), p('n', 'in1'))
      .wire(p('clk', 'out'), p('g', 'in1'))
      .wire(p('n', 'out'), p('g', 'in2'))
      .wire(p('g', 'out'), p('mg', 'in0'))
      .wire(p('mg', 'out'), p('bp', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 100 })
    for (let i = 1; i < 4; i++) b.wire(p('gnd', 'out'), p('mg', `in${i}`))
    return b.build()
  }

  it('a 1 ns glitch reaches the bus when the merger delay is 1 ns', () => {
    const c = glitchToBus(1, 1)
    c.go()
    expect(busTrace(c, 'bp')).toEqual([
      [0, '0'],
      [22, '1'],
      [23, '0'],
      [42, '1'],
      [43, '0'],
      [62, '1'],
      [63, '0'],
      [82, '1'],
      [83, '0']
    ])
  })

  it('the same glitch never reaches the bus through a 2 ns merger', () => {
    const c = glitchToBus(2, 1)
    c.go()
    expect(busTrace(c, 'bp')).toEqual([[0, '0']])
  })

  it('the same glitch never reaches the bus through a 3 ns merger', () => {
    const c = glitchToBus(3, 1)
    c.go()
    expect(busTrace(c, 'bp')).toEqual([[0, '0']])
  })

  it('no glitch exists at all when the AND is slower than the skew', () => {
    const c = glitchToBus(1, 2)
    c.go()
    expect(busTrace(c, 'bp')).toEqual([[0, '0']])
  })

  it('a BUS_TAP downstream of a fast merger passes the glitch on, one tap delay later', () => {
    const c = new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .add('gnd', ComponentType.GROUND)
      .add('n', ComponentType.NOT)
      .add('g', ComponentType.AND2)
      .add('mg', ComponentType.MERGER, { bits: 4 })
      .add('tap', ComponentType.BUS_TAP, { bits: 1, tapStart: 0, delay: 1 })
      .probe('y')
      .wire(p('clk', 'out'), p('n', 'in1'))
      .wire(p('clk', 'out'), p('g', 'in1'))
      .wire(p('n', 'out'), p('g', 'in2'))
      .wire(p('g', 'out'), p('mg', 'in0'))
      .wire(p('gnd', 'out'), p('mg', 'in1'))
      .wire(p('gnd', 'out'), p('mg', 'in2'))
      .wire(p('gnd', 'out'), p('mg', 'in3'))
      .wire(p('mg', 'out'), p('tap', 'in'))
      .wire(p('tap', 'out'), p('y', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 60 })
      .build()
    c.go()
    expect(netTrace(c, 'y')).toEqual([
      [0, ZERO],
      [23, ONE],
      [24, ZERO],
      [43, ONE],
      [44, ZERO]
    ])
  })

  it('a slow BUS_TAP swallows the glitch that reached its bus', () => {
    const c = new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .add('gnd', ComponentType.GROUND)
      .add('n', ComponentType.NOT)
      .add('g', ComponentType.AND2)
      .add('mg', ComponentType.MERGER, { bits: 4 })
      .add('tap', ComponentType.BUS_TAP, { bits: 1, tapStart: 0, delay: 2 })
      .probe('y')
      .wire(p('clk', 'out'), p('n', 'in1'))
      .wire(p('clk', 'out'), p('g', 'in1'))
      .wire(p('n', 'out'), p('g', 'in2'))
      .wire(p('g', 'out'), p('mg', 'in0'))
      .wire(p('gnd', 'out'), p('mg', 'in1'))
      .wire(p('gnd', 'out'), p('mg', 'in2'))
      .wire(p('gnd', 'out'), p('mg', 'in3'))
      .wire(p('mg', 'out'), p('tap', 'in'))
      .wire(p('tap', 'out'), p('y', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 60 })
      .build()
    c.go()
    expect(netTrace(c, 'y')).toEqual([[0, ZERO]])
  })
})

describe('contention phases on a shared bus appear in order (INPUT_SIGNAL driven)', () => {
  function contended(): Circuit {
    const b = new CircuitBuilder()
      .add('oea', ComponentType.INPUT_SIGNAL, { signal: [row(0, ZERO), row(10, ONE), row(50, ZERO)] })
      .add('oeb', ComponentType.INPUT_SIGNAL, { signal: [row(0, ZERO), row(30, ONE), row(70, ZERO)] })
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 100 })
    addBusSource(b, 'spa', 4, 0x5)
    addBusSource(b, 'spb', 4, 0x3)
    addBusSink(b, 'mg', 4)
    b.add('tsa', ComponentType.N_TRISTATE, { bits: 4 })
      .add('tsb', ComponentType.N_TRISTATE, { bits: 4 })
      .wire(p('oea', 'out'), p('tsa', 'ctl'))
      .wire(p('oeb', 'out'), p('tsb', 'ctl'))
    for (let i = 0; i < 4; i++) {
      b.wire(p('spa', `out${i}`), p('tsa', `in${i}`))
        .wire(p('spb', `out${i}`), p('tsb', `in${i}`))
        .wire(p('tsa', `out${i}`), p('tsb', `out${i}`))
        .wire(p('tsa', `out${i}`), p('mg', `in${i}`))
    }
    return b.build()
  }

  it('Z -> 5 -> X -> 3 -> Z with one tristate delay and one merger delay per phase', () => {
    const c = contended()
    c.go()
    expect(c.time).toBe(100)
    expect(busTrace(c, 'mgbp')).toEqual([
      [0, 'Z'],
      [12, '5'], // A enabled at 10
      [32, 'X'], // B joins at 30: bits 1 and 2 disagree
      [52, '3'], // A released at 50
      [72, 'Z'] // B released at 70
    ])
  })

  it('with no CLOCK part, Step advances to the next queued change (decision 5) and the shared nets lead the bus by one merger delay', () => {
    const c = contended()
    // [time after the step, shared-net bits (LSB first), bus hex]
    const expected: [number, LogicValue[], string][] = [
      [10, [Z, Z, Z, Z], 'Z'], // A's enable applied; its outputs are still in flight
      [11, [ONE, ZERO, ONE, ZERO], 'Z'], // nets took A's value; the merger has not caught up
      [12, [ONE, ZERO, ONE, ZERO], '5'],
      [30, [ONE, ZERO, ONE, ZERO], '5'], // B's enable applied
      [31, [ONE, X, X, ZERO], '5'], // both drive: bits 1 and 2 disagree
      [32, [ONE, X, X, ZERO], 'X'],
      [50, [ONE, X, X, ZERO], 'X'], // A's release applied
      [51, [ONE, ONE, ZERO, ZERO], 'X'], // B alone: 0011
      [52, [ONE, ONE, ZERO, ZERO], '3'],
      [70, [ONE, ONE, ZERO, ZERO], '3'],
      [71, [Z, Z, Z, Z], '3'],
      [72, [Z, Z, Z, Z], 'Z']
    ]
    for (const [t, bits, hex] of expected) {
      c.step()
      expect(c.time).toBe(t)
      for (let i = 0; i < 4; i++) expect(c.pin(p('tsa', `out${i}`))).toBe(bits[i])
      expect(c.bus(p('mgbp', 'in'))).toBe(hex)
    }
  })
})

describe('an N_TRISTATE with an undetermined control poisons the whole shared bus', () => {
  function ctlX(): Circuit {
    const b = new CircuitBuilder().add('xs', ComponentType.NOT) // open input -> X
    addBusSource(b, 'spa', 4, 0x5)
    addBusSource(b, 'spb', 4, 0x5)
    addBusSink(b, 'mg', 4)
    b.add('tsa', ComponentType.N_TRISTATE, { bits: 4 })
      .add('tsb', ComponentType.N_TRISTATE, { bits: 4 })
      .switch('oea', ONE)
      .wire(p('oea', 'out'), p('tsa', 'ctl'))
      .wire(p('xs', 'out'), p('tsb', 'ctl'))
    for (let i = 0; i < 4; i++) {
      b.wire(p('spa', `out${i}`), p('tsa', `in${i}`))
        .wire(p('spb', `out${i}`), p('tsb', `in${i}`))
        .wire(p('tsa', `out${i}`), p('tsb', `out${i}`))
        .wire(p('tsa', `out${i}`), p('mg', `in${i}`))
    }
    return b.build()
  }

  it('every bit is X even though the other driver agrees with the buffered value', () => {
    const c = ctlX()
    for (let i = 0; i < 4; i++) expect(c.pin(p('tsa', `out${i}`))).toBe(X)
    expect(c.bus(p('mgbp', 'in'))).toBe('X')
  })

  it('disabling the good driver leaves the bus X (the X driver still holds it)', () => {
    const c = ctlX()
    c.set('oea', ZERO)
    expect(c.bus(p('mgbp', 'in'))).toBe('X')
  })
})

describe('a bus probe records a change of the underlying vector even when the hex is still X', () => {
  it('two mergers contending: moving a bit from "agree" to "disagree" adds a sample', () => {
    const b = new CircuitBuilder()
      .add('mga', ComponentType.MERGER, { bits: 4 })
      .add('mgb', ComponentType.MERGER, { bits: 4 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
      .add('vcc', ComponentType.VCC)
      .add('gnd', ComponentType.GROUND)
      .wire(p('mga', 'out'), p('mgb', 'out'))
      .wire(p('mga', 'out'), p('bp', 'in'))
    for (let i = 0; i < 4; i++) {
      b.switch(`s${i}`, bitAt(0x5, i) ? ONE : ZERO).wire(p(`s${i}`, 'out'), p('mga', `in${i}`))
      b.wire(bitAt(0x3, i) ? p('vcc', 'out') : p('gnd', 'out'), p('mgb', `in${i}`))
    }
    const c = b.build()
    expect(c.bus(p('bp', 'in'))).toBe('X') // [1, X, X, 0]
    c.set('s0', ZERO) // bit 0 now disagrees as well: [X, X, X, 0]
    expect(c.bus(p('bp', 'in'))).toBe('X')
    expect(busTrace(c, 'bp').map(([, h]) => h)).toEqual(['X', 'X'])
    c.set('s3', ONE) // bit 3 disagrees too, still X on the display
    expect(busTrace(c, 'bp')).toHaveLength(3)
  })
})

// ===========================================================================
// 11. Wide arithmetic assembled from taps, splitters and mergers
// ===========================================================================

describe('32-bit addition assembled from two 16-bit N_ADDERs', () => {
  function wideAdder(xv: number, yv: number): Circuit {
    const b = new CircuitBuilder()
      .add('bix', ComponentType.BUS_INPUT, { bits: 32, label: labelOf(xv) })
      .add('biy', ComponentType.BUS_INPUT, { bits: 32, label: labelOf(yv) })
      .add('gnd', ComponentType.GROUND)
      .probe('cout')
    addBusSink(b, 'mg', 32)
    for (let w = 0; w < 2; w++) {
      b.add(`tx${w}`, ComponentType.BUS_TAP, { bits: 16, tapStart: 16 * w })
        .add(`ty${w}`, ComponentType.BUS_TAP, { bits: 16, tapStart: 16 * w })
        .add(`sx${w}`, ComponentType.SPLITTER, { bits: 16 })
        .add(`sy${w}`, ComponentType.SPLITTER, { bits: 16 })
        .add(`add${w}`, ComponentType.N_ADDER, { bits: 16 })
        .wire(p('bix', 'out'), p(`tx${w}`, 'in'))
        .wire(p('biy', 'out'), p(`ty${w}`, 'in'))
        .wire(p(`tx${w}`, 'out'), p(`sx${w}`, 'in'))
        .wire(p(`ty${w}`, 'out'), p(`sy${w}`, 'in'))
        .wire(w === 0 ? p('gnd', 'out') : p('add0', 'Cout'), p(`add${w}`, 'Cin'))
      for (let i = 0; i < 16; i++) {
        b.wire(p(`sx${w}`, `out${i}`), p(`add${w}`, `X${i}`))
          .wire(p(`sy${w}`, `out${i}`), p(`add${w}`, `Y${i}`))
          .wire(p(`add${w}`, `S${i}`), p('mg', `in${16 * w + i}`))
      }
    }
    b.wire(p('add1', 'Cout'), p('cout', 'in'))
    return b.build()
  }

  it.each([
    [0x00000000, 0x00000000],
    [0xffffffff, 0x00000001],
    [0xdeadbeef, 0x12345678],
    [0xffff0000, 0x0000ffff],
    [0x80000000, 0x80000000],
    [0xaaaaaaaa, 0x55555555],
    [0x0000ffff, 0x00000001],
    [0xffffffff, 0xffffffff]
  ])('0x%s + 0x%s over 32 bits', (xv, yv) => {
    const c = wideAdder(xv, yv)
    const total = xv + yv
    expect(c.bus(p('tx0', 'out'))).toBe(hexOf(xv % 65536, 16))
    expect(c.bus(p('tx1', 'out'))).toBe(hexOf(Math.floor(xv / 65536), 16))
    expect(c.bus(p('mgbp', 'in'))).toBe(hexOf(total % 2 ** 32, 32))
    expect(c.pin(p('cout', 'in'))).toBe(bit(total >= 2 ** 32 ? 1 : 0))
  })
})

describe('undetermined bits poison bus arithmetic entirely (Appendix A: any X/Z -> all X)', () => {
  /** X operand comes from a bus contended in a single bit. */
  function poisoned(labelA: string, labelB: string | null): Circuit {
    const b = new CircuitBuilder()
      .add('bia', ComponentType.BUS_INPUT, { bits: 8, label: labelA })
      .add('sp', ComponentType.SPLITTER, { bits: 8 })
      .add('add', ComponentType.N_ADDER, { bits: 8 })
      .add('gnd', ComponentType.GROUND)
      .probe('cout')
      .wire(p('bia', 'out'), p('sp', 'in'))
      .wire(p('gnd', 'out'), p('add', 'Cin'))
      .wire(p('add', 'Cout'), p('cout', 'in'))
    if (labelB !== null) {
      b.add('bib', ComponentType.BUS_INPUT, { bits: 8, label: labelB }).wire(p('bia', 'out'), p('bib', 'out'))
    }
    addBusSource(b, 'spy', 8, 0x0f)
    addBusSink(b, 'mg', 8)
    for (let i = 0; i < 8; i++) {
      b.wire(p('sp', `out${i}`), p('add', `X${i}`))
        .wire(p('spy', `out${i}`), p('add', `Y${i}`))
        .wire(p('add', `S${i}`), p('mg', `in${i}`))
    }
    return b.build()
  }

  it('one contended bit on the X bus makes every sum bit and Cout X', () => {
    const c = poisoned('5a', '5b')
    expect(c.pin(p('sp', 'out0'))).toBe(X)
    expect(c.pin(p('sp', 'out1'))).toBe(ONE)
    expect(c.bus(p('mgbp', 'in'))).toBe('XX')
    expect(c.pin(p('cout', 'in'))).toBe(X)
  })

  it('a BUS_INPUT label that does not fit the width poisons the whole adder', () => {
    const c = poisoned('1ff', null) // 0x1FF needs 9 bits
    expect(c.bus(p('bia', 'out'))).toBe('XX')
    expect(c.bus(p('mgbp', 'in'))).toBe('XX')
    expect(c.pin(p('cout', 'in'))).toBe(X)
  })

  it('a non-hex BUS_INPUT label poisons the whole adder', () => {
    const c = poisoned('zz', null)
    expect(c.bus(p('mgbp', 'in'))).toBe('XX')
    expect(c.pin(p('cout', 'in'))).toBe(X)
  })

  it('an unconnected splitter input feeds Z into the adder, which is also all X', () => {
    const b = new CircuitBuilder()
      .add('sp', ComponentType.SPLITTER, { bits: 8 })
      .add('add', ComponentType.N_ADDER, { bits: 8 })
      .add('gnd', ComponentType.GROUND)
      .probe('cout')
      .wire(p('gnd', 'out'), p('add', 'Cin'))
      .wire(p('add', 'Cout'), p('cout', 'in'))
    addBusSource(b, 'spy', 8, 0x0f)
    addBusSink(b, 'mg', 8)
    for (let i = 0; i < 8; i++) {
      b.wire(p('sp', `out${i}`), p('add', `X${i}`))
        .wire(p('spy', `out${i}`), p('add', `Y${i}`))
        .wire(p('add', `S${i}`), p('mg', `in${i}`))
    }
    const c = b.build()
    for (let i = 0; i < 8; i++) expect(c.pin(p('sp', `out${i}`))).toBe(Z)
    expect(c.bus(p('mgbp', 'in'))).toBe('XX')
    expect(c.pin(p('cout', 'in'))).toBe(X)
  })
})

// ===========================================================================
// 12. Composition of bus parts with each other
// ===========================================================================

describe('a BUS_TAP of a BUS_TAP selects the composed slice', () => {
  it.each([
    [0xb3, 4, 4, 2, 1],
    [0x5a, 4, 0, 2, 2],
    [0xff, 8, 0, 3, 5],
    [0x81, 8, 0, 1, 7]
  ])('0x%s: tap %i bits from %i, then %i bits from %i', (value, outerBits, outerStart, innerBits, innerStart) => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 8, label: labelOf(value) })
      .add('t1', ComponentType.BUS_TAP, { bits: outerBits, tapStart: outerStart })
      .add('t2', ComponentType.BUS_TAP, { bits: innerBits, tapStart: innerStart })
      .wire(p('bi', 'out'), p('t1', 'in'))
      .wire(p('t1', 'out'), p('t2', 'in'))
      .build()
    const outer = sliceOf(value, outerStart, outerBits)
    const inner = sliceOf(outer, innerStart, innerBits)
    expect(c.bus(p('t1', 'out'))).toBe(hexOf(outer, outerBits))
    if (innerBits > 1) expect(c.bus(p('t2', 'out'))).toBe(hexOf(inner, innerBits))
    else expect(c.pin(p('t2', 'out'))).toBe(bit(inner))
    // The composed slice is the same slice taken directly from the source bus.
    expect(inner).toBe(sliceOf(value, outerStart + innerStart, innerBits))
  })
})

describe('BUS_TAP and COMPLEMENTER compose in either order', () => {
  it('complement then tap equals tap then complement (8-bit bus 0xA5, bits 5:2)', () => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 8, label: 'a5' })
      .add('vcc', ComponentType.VCC)
      .add('cp1', ComponentType.COMPLEMENTER, { bits: 8 })
      .add('tapAfter', ComponentType.BUS_TAP, { bits: 4, tapStart: 2 })
      .add('tapFirst', ComponentType.BUS_TAP, { bits: 4, tapStart: 2 })
      .add('cp2', ComponentType.COMPLEMENTER, { bits: 4 })
      .wire(p('vcc', 'out'), p('cp1', 'en'))
      .wire(p('vcc', 'out'), p('cp2', 'en'))
      .wire(p('bi', 'out'), p('cp1', 'in'))
      .wire(p('cp1', 'out'), p('tapAfter', 'in'))
      .wire(p('bi', 'out'), p('tapFirst', 'in'))
      .wire(p('tapFirst', 'out'), p('cp2', 'in'))
      .build()
    const slice = sliceOf(0xa5, 2, 4)
    expect(c.bus(p('tapFirst', 'out'))).toBe(hexOf(slice, 4))
    expect(c.bus(p('cp2', 'out'))).toBe(hexOf(15 - slice, 4))
    expect(c.bus(p('tapAfter', 'out'))).toBe(hexOf(15 - slice, 4))
  })
})

describe('a released bus stays Z through taps, splitters and complementers', () => {
  /** A 4-bit bus driven only by a MERGER whose inputs come from one N_TRISTATE. */
  function releasable(): Circuit {
    const b = new CircuitBuilder()
      .add('tap', ComponentType.BUS_TAP, { bits: 2, tapStart: 1 })
      .add('tbp', ComponentType.BUS_PROBE, { bits: 2 })
      .add('sp', ComponentType.SPLITTER, { bits: 4 })
      .add('ts', ComponentType.N_TRISTATE, { bits: 4 })
      .switch('oe', ZERO)
      .wire(p('oe', 'out'), p('ts', 'ctl'))
      .wire(p('tap', 'out'), p('tbp', 'in'))
    addBusSource(b, 'src', 4, 0x6)
    addBusSink(b, 'mg', 4)
    b.wire(p('mg', 'out'), p('tap', 'in')).wire(p('mg', 'out'), p('sp', 'in'))
    for (let i = 0; i < 4; i++) {
      b.wire(p('src', `out${i}`), p('ts', `in${i}`)).wire(p('ts', `out${i}`), p('mg', `in${i}`))
    }
    return b.build()
  }

  it('all-Z merger output taps and splits to Z, then follows the value once enabled', () => {
    const c = releasable()
    expect(c.bus(p('mgbp', 'in'))).toBe('Z')
    expect(c.bus(p('tbp', 'in'))).toBe('Z')
    for (let i = 0; i < 4; i++) expect(c.pin(p('sp', `out${i}`))).toBe(Z)
    c.set('oe', ONE)
    expect(c.bus(p('mgbp', 'in'))).toBe('6')
    expect(c.bus(p('tbp', 'in'))).toBe(hexOf(sliceOf(0x6, 1, 2), 2))
    for (let i = 0; i < 4; i++) expect(c.pin(p('sp', `out${i}`))).toBe(bit(bitAt(0x6, i)))
    c.set('oe', ZERO)
    expect(c.bus(p('mgbp', 'in'))).toBe('Z')
    expect(busTrace(c, 'mgbp').map(([, h]) => h)).toEqual(['Z', '6', 'Z'])
  })
})

describe('mixed bus widths on one net (the manual only defines equal widths)', () => {
  it('a 4-bit SPLITTER on an 8-bit bus reads the four low bits', () => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 8, label: '5a' })
      .add('sp', ComponentType.SPLITTER, { bits: 4 })
      .wire(p('bi', 'out'), p('sp', 'in'))
      .build()
    for (let i = 0; i < 4; i++) expect(c.pin(p('sp', `out${i}`))).toBe(bit(bitAt(0x5a, i)))
  })

  it('a 4-bit COMPLEMENTER reading an 8-bit bus complements the low nibble only', () => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 8, label: '5a' })
      .add('tap', ComponentType.BUS_TAP, { bits: 8, tapStart: 0 })
      .add('cp', ComponentType.COMPLEMENTER, { bits: 4 })
      .add('sp', ComponentType.SPLITTER, { bits: 4 })
      .add('vcc', ComponentType.VCC)
      .wire(p('bi', 'out'), p('tap', 'in'))
      .wire(p('tap', 'out'), p('cp', 'in'))
      .wire(p('vcc', 'out'), p('cp', 'en'))
      .wire(p('cp', 'out'), p('sp', 'in'))
      .build()
    for (let i = 0; i < 4; i++) expect(c.pin(p('sp', `out${i}`))).toBe(bit(1 - bitAt(0x5a, i)))
  })
})

// ===========================================================================
// 13. Bus feedback around a clocked part
// ===========================================================================

describe('an accumulator whose feedback runs through a MERGER/SPLITTER bus round trip', () => {
  /** reg -> MERGER(dm) -> bus -> SPLITTER(ds) -> adder -> reg. */
  function busAccumulator(dm: number, ds: number, addend: number): Circuit {
    const b = new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .add('vcc', ComponentType.VCC)
      .add('gnd', ComponentType.GROUND)
      .switch('clr', ONE)
      .add('reg', ComponentType.N_REGISTER, { bits: 4 })
      .add('add', ComponentType.N_ADDER, { bits: 4 })
      .add('mg', ComponentType.MERGER, { bits: 4, delay: dm })
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
      .add('sp', ComponentType.SPLITTER, { bits: 4, delay: ds })
      .wire(p('clk', 'out'), p('reg', 'CLK'))
      .wire(p('vcc', 'out'), p('reg', 'Ld'))
      .wire(p('clr', 'out'), p('reg', 'CLR'))
      .wire(p('gnd', 'out'), p('add', 'Cin'))
      .wire(p('mg', 'out'), p('bp', 'in'))
      .wire(p('mg', 'out'), p('sp', 'in'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 400 })
    addBusSource(b, 'spy', 4, addend)
    for (let i = 0; i < 4; i++) {
      b.wire(p('reg', `Q${i}`), p('mg', `in${i}`))
        .wire(p('sp', `out${i}`), p('add', `X${i}`))
        .wire(p('spy', `out${i}`), p('add', `Y${i}`))
        .wire(p('add', `S${i}`), p('reg', `D${i}`))
    }
    return b.build()
  }

  it.each([
    [1, 1, 3],
    [3, 4, 3],
    [2, 2, 5],
    [1, 1, 7]
  ])('MERGER delay %i, SPLITTER delay %i, addend %i: accumulates correctly for 8 clocks', (dm, ds, addend) => {
    const c = busAccumulator(dm, ds, addend)
    c.step()
    c.step() // edge at 20 clears the register
    expect(c.bus(p('bp', 'in'))).toBe('0')
    c.set('clr', ZERO)
    for (let k = 1; k <= 8; k++) {
      c.step()
      expect(c.bus(p('bp', 'in'))).toBe(hexOf((k * addend) % 16, 4))
    }
  })

  it('the bus samples land one register delay plus one merger delay after each edge', () => {
    const c = busAccumulator(3, 4, 3)
    c.step()
    c.step()
    c.set('clr', ZERO)
    for (let k = 1; k <= 4; k++) c.step()
    expect(busTrace(c, 'bp')).toEqual([
      [0, 'X'],
      [24, '0'], // edge 20 -> Q at 21 -> merger (delay 3) at 24
      [44, '3'],
      [64, '6'],
      [84, '9'],
      [104, 'C']
    ])
  })
})

// ===========================================================================
// 14. Two BUS_TAPs driving one net
// ===========================================================================

describe('two BUS_TAP outputs tied to one net resolve bit by bit', () => {
  it.each([
    [0x33, 'both nibbles equal'],
    [0x5a, 'every bit disagrees'],
    [0x35, 'two bits agree, two disagree'],
    [0xff, 'all ones'],
    [0x00, 'all zeros']
  ])('0x%s (%s)', (value) => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 8, label: labelOf(value) })
      .add('lo', ComponentType.BUS_TAP, { bits: 4, tapStart: 0 })
      .add('hi', ComponentType.BUS_TAP, { bits: 4, tapStart: 4 })
      .add('sp', ComponentType.SPLITTER, { bits: 4 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
      .wire(p('bi', 'out'), p('lo', 'in'))
      .wire(p('bi', 'out'), p('hi', 'in'))
      .wire(p('lo', 'out'), p('hi', 'out'))
      .wire(p('lo', 'out'), p('sp', 'in'))
      .wire(p('lo', 'out'), p('bp', 'in'))
      .build()
    const drivers = [value % 16, Math.floor(value / 16)]
    for (let i = 0; i < 4; i++) expect(c.pin(p('sp', `out${i}`))).toBe(resolveBit(drivers, i))
    expect(c.bus(p('bp', 'in'))).toBe(hexOfBits(resolveBus(drivers, 4)))
  })
})

// ===========================================================================
// 15. A bus multiplexer built from a DECODER and N_TRISTATEs
// ===========================================================================

describe('4-to-1 bus mux: DECODER_2TO4 enables one of four N_TRISTATE drivers', () => {
  const values = [0x1, 0x2, 0x4, 0x8]

  function busMux(selX: boolean): Circuit {
    const b = new CircuitBuilder()
      .add('dec', ComponentType.DECODER_2TO4)
      .switch('a', ZERO)
      .switch('bb', ZERO)
    addBusSink(b, 'mg', 4)
    if (selX) b.add('xs', ComponentType.NOT).wire(p('xs', 'out'), p('dec', 'A'))
    else b.wire(p('a', 'out'), p('dec', 'A'))
    b.wire(p('bb', 'out'), p('dec', 'B'))
    values.forEach((v, d) => {
      addBusSource(b, `sp${d}`, 4, v)
      b.add(`ts${d}`, ComponentType.N_TRISTATE, { bits: 4 }).wire(p('dec', `out${d}`), p(`ts${d}`, 'ctl'))
      for (let i = 0; i < 4; i++) {
        b.wire(p(`sp${d}`, `out${i}`), p(`ts${d}`, `in${i}`)).wire(p(`ts${d}`, `out${i}`), p('mg', `in${i}`))
      }
    })
    return b.build()
  }

  it.each([
    [ZERO, ZERO, 0],
    [ZERO, ONE, 1],
    [ONE, ZERO, 2],
    [ONE, ONE, 3]
  ])('A = %s, B = %s selects driver %i', (a, bb, index) => {
    const c = busMux(false)
    c.setMany({ a, bb })
    expect(c.bus(p('mgbp', 'in'))).toBe(hexOf(values[index], 4))
    // Exactly one driver is on; the others have released the bus.
    for (let d = 0; d < 4; d++) expect(c.pin(p('dec', `out${d}`))).toBe(bit(d === index ? 1 : 0))
  })

  it('walking the select through all four inputs records one bus sample per change', () => {
    const c = busMux(false)
    c.setMany({ a: ZERO, bb: ONE })
    c.setMany({ a: ONE, bb: ZERO })
    c.setMany({ a: ONE, bb: ONE })
    c.setMany({ a: ZERO, bb: ZERO })
    expect(busTrace(c, 'mgbp').map(([, h]) => h)).toEqual(['1', '2', '4', '8', '1'])
  })

  it('an undetermined select turns every driver on undecidedly, so the bus is X', () => {
    const c = busMux(true)
    for (let d = 0; d < 4; d++) expect(c.pin(p('dec', `out${d}`))).toBe(X)
    expect(c.bus(p('mgbp', 'in'))).toBe('X')
  })
})

// ===========================================================================
// 16. A DECODER driven by a slice of a bus
// ===========================================================================

describe('DECODER_2TO4 selected by a 2-bit BUS_TAP of an 8-bit bus', () => {
  it.each([0, 1, 2, 3, 4, 5, 6])('tap at bit %i of 0x5A decodes one-hot', (start) => {
    const b = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 8, label: '5a' })
      .add('tap', ComponentType.BUS_TAP, { bits: 2, tapStart: start })
      .add('sp', ComponentType.SPLITTER, { bits: 2 })
      .add('dec', ComponentType.DECODER_2TO4)
      .wire(p('bi', 'out'), p('tap', 'in'))
      .wire(p('tap', 'out'), p('sp', 'in'))
      .wire(p('sp', 'out1'), p('dec', 'A')) // A is the MSB of the slice
      .wire(p('sp', 'out0'), p('dec', 'B'))
    addBusSink(b, 'mg', 4)
    for (let i = 0; i < 4; i++) b.wire(p('dec', `out${i}`), p('mg', `in${i}`))
    const c = b.build()
    const index = sliceOf(0x5a, start, 2)
    for (let i = 0; i < 4; i++) expect(c.pin(p('dec', `out${i}`))).toBe(bit(i === index ? 1 : 0))
    expect(c.bus(p('mgbp', 'in'))).toBe(hexOf(2 ** index, 4))
  })
})

// ===========================================================================
// 17. A bus-wide equality comparator from XNOR gates
// ===========================================================================

describe('8-bit bus comparator: XNOR array reduced by AND gates', () => {
  function comparator(a: number, bVal: number): Circuit {
    const b = new CircuitBuilder()
      .add('r1', ComponentType.AND4)
      .add('r2', ComponentType.AND4)
      .add('eq', ComponentType.AND2)
      .probe('y')
      .wire(p('r1', 'out'), p('eq', 'in1'))
      .wire(p('r2', 'out'), p('eq', 'in2'))
      .wire(p('eq', 'out'), p('y', 'in'))
    addBusSource(b, 'spa', 8, a)
    addBusSource(b, 'spb', 8, bVal)
    for (let i = 0; i < 8; i++) {
      b.add(`x${i}`, ComponentType.XNOR2)
        .wire(p('spa', `out${i}`), p(`x${i}`, 'in1'))
        .wire(p('spb', `out${i}`), p(`x${i}`, 'in2'))
        .wire(p(`x${i}`, 'out'), p(i < 4 ? 'r1' : 'r2', `in${(i % 4) + 1}`))
    }
    return b.build()
  }

  it.each([
    [0x00, 0x00],
    [0xff, 0xff],
    [0x5a, 0x5a],
    [0x5a, 0x5b],
    [0x5a, 0xa5],
    [0x01, 0x00],
    [0x80, 0x00],
    [0x7f, 0xff],
    [0x12, 0x12],
    [0x12, 0x13]
  ])('0x%s vs 0x%s', (a, bVal) => {
    const c = comparator(a, bVal)
    expect(c.pin(p('y', 'in'))).toBe(bit(a === bVal ? 1 : 0))
    for (let i = 0; i < 8; i++) {
      expect(c.pin(p(`x${i}`, 'out'))).toBe(bit(bitAt(a, i) === bitAt(bVal, i) ? 1 : 0))
    }
  })
})

// ===========================================================================
// 18. Shift registers loaded from and read back onto busses
// ===========================================================================

describe('N_SHIFT_RIGHT(8) loaded from a bus and read back through a merger', () => {
  function shifter(value: number, lin: LogicValue): Circuit {
    const b = new CircuitBuilder()
      .add('sr', ComponentType.N_SHIFT_RIGHT, { bits: 8 })
      .switch('clk', ZERO)
      .switch('ld', ONE)
      .add('gnd', ComponentType.GROUND)
      .add('vcc', ComponentType.VCC)
      .wire(p('clk', 'out'), p('sr', 'CLK'))
      .wire(p('ld', 'out'), p('sr', 'Ld'))
      .wire(p('gnd', 'out'), p('sr', 'CLR'))
      .wire(p('vcc', 'out'), p('sr', 'RS'))
      .wire(lin === ONE ? p('vcc', 'out') : p('gnd', 'out'), p('sr', 'Lin'))
    addBusSource(b, 'spd', 8, value)
    addBusSink(b, 'mg', 8)
    for (let i = 0; i < 8; i++) {
      b.wire(p('spd', `out${i}`), p('sr', `D${i}`)).wire(p('sr', `Q${i}`), p('mg', `in${i}`))
    }
    return b.build()
  }

  it.each([0xb4, 0xff, 0x01, 0x80, 0x00])('0x%s shifts right with Lin = 0 until the bus reads 00', (value) => {
    const c = shifter(value, ZERO)
    c.pulse('clk')
    expect(c.bus(p('mgbp', 'in'))).toBe(hexOf(value, 8))
    c.set('ld', ZERO)
    let v = value
    for (let k = 0; k < 8; k++) {
      c.pulse('clk')
      v = Math.floor(v / 2)
      expect(c.bus(p('mgbp', 'in'))).toBe(hexOf(v, 8))
    }
    expect(c.bus(p('mgbp', 'in'))).toBe('00')
  })

  it.each([0xb4, 0x00, 0x7f])('0x%s shifts right with Lin = 1 until the bus reads FF', (value) => {
    const c = shifter(value, ONE)
    c.pulse('clk')
    c.set('ld', ZERO)
    let v = value
    for (let k = 0; k < 8; k++) {
      c.pulse('clk')
      v = Math.floor(v / 2) + 128
      expect(c.bus(p('mgbp', 'in'))).toBe(hexOf(v, 8))
    }
    expect(c.bus(p('mgbp', 'in'))).toBe('FF')
  })
})

describe('a bus rotator: N_SHIFT_LEFT whose Rin comes from a BUS_TAP of its own output bus', () => {
  function rotator(n: number, value: number): Circuit {
    const b = new CircuitBuilder()
      .add('sr', ComponentType.N_SHIFT_LEFT, { bits: n })
      .add('tap', ComponentType.BUS_TAP, { bits: 1, tapStart: n - 1 })
      .switch('clk', ZERO)
      .switch('ld', ONE)
      .add('gnd', ComponentType.GROUND)
      .add('vcc', ComponentType.VCC)
      .wire(p('clk', 'out'), p('sr', 'CLK'))
      .wire(p('ld', 'out'), p('sr', 'Ld'))
      .wire(p('gnd', 'out'), p('sr', 'CLR'))
      .wire(p('vcc', 'out'), p('sr', 'LS'))
    addBusSource(b, 'spd', n, value)
    addBusSink(b, 'mg', n)
    b.wire(p('mg', 'out'), p('tap', 'in')).wire(p('tap', 'out'), p('sr', 'Rin'))
    for (let i = 0; i < n; i++) {
      b.wire(p('spd', `out${i}`), p('sr', `D${i}`)).wire(p('sr', `Q${i}`), p('mg', `in${i}`))
    }
    return b.build()
  }

  it.each([
    [4, 0x9],
    [4, 0x1],
    [8, 0xb4],
    [8, 0x01],
    [8, 0xff],
    [8, 0x00]
  ])('%i bits, 0x%s: every clock rotates left and the value returns after n clocks', (n, value) => {
    const c = rotator(n, value)
    c.pulse('clk') // Ld = 1: load the bus value
    expect(c.bus(p('mgbp', 'in'))).toBe(hexOf(value, n))
    c.set('ld', ZERO)
    let v = value
    for (let k = 1; k <= n; k++) {
      c.pulse('clk')
      v = ((v * 2) % 2 ** n) + bitAt(v, n - 1)
      expect(c.bus(p('mgbp', 'in'))).toBe(hexOf(v, n))
    }
    expect(c.bus(p('mgbp', 'in'))).toBe(hexOf(value, n)) // full turn
  })
})

describe('N_SHIFT_BIDIR driven from a bus: LS wins over RS (decision 11)', () => {
  function bidir(value: number): Circuit {
    const b = new CircuitBuilder()
      .add('sr', ComponentType.N_SHIFT_BIDIR, { bits: 8 })
      .switch('clk', ZERO)
      .switch('ld', ONE)
      .switch('ls', ZERO)
      .switch('rs', ZERO)
      .add('gnd', ComponentType.GROUND)
      .wire(p('clk', 'out'), p('sr', 'CLK'))
      .wire(p('ld', 'out'), p('sr', 'Ld'))
      .wire(p('ls', 'out'), p('sr', 'LS'))
      .wire(p('rs', 'out'), p('sr', 'RS'))
      .wire(p('gnd', 'out'), p('sr', 'CLR'))
      .wire(p('gnd', 'out'), p('sr', 'Rin'))
      .wire(p('gnd', 'out'), p('sr', 'Lin'))
    addBusSource(b, 'spd', 8, value)
    addBusSink(b, 'mg', 8)
    for (let i = 0; i < 8; i++) {
      b.wire(p('spd', `out${i}`), p('sr', `D${i}`)).wire(p('sr', `Q${i}`), p('mg', `in${i}`))
    }
    return b.build()
  }

  it('LS = 1 shifts the bus value left; RS = 1 shifts it right; both = 1 shifts left', () => {
    const c = bidir(0x24)
    c.pulse('clk')
    expect(c.bus(p('mgbp', 'in'))).toBe('24')
    c.set('ld', ZERO)
    c.set('ls', ONE)
    c.pulse('clk')
    expect(c.bus(p('mgbp', 'in'))).toBe('48')
    c.setMany({ ls: ZERO, rs: ONE })
    c.pulse('clk')
    expect(c.bus(p('mgbp', 'in'))).toBe('24')
    c.setMany({ ls: ONE, rs: ONE }) // LS wins
    c.pulse('clk')
    expect(c.bus(p('mgbp', 'in'))).toBe('48')
  })

  it('holding (LS = RS = 0) leaves the bus value untouched over several clocks', () => {
    const c = bidir(0x24)
    c.pulse('clk')
    c.set('ld', ZERO)
    for (let k = 0; k < 4; k++) {
      c.pulse('clk')
      expect(c.bus(p('mgbp', 'in'))).toBe('24')
    }
    expect(busTrace(c, 'mgbp').map(([, h]) => h)).toEqual(['XX', '24'])
  })
})

// ===========================================================================
// 19. The manual's §4 N-bit adder + register exercise (Figure 10 / Figure 11)
// ===========================================================================

describe("manual §4 exercise: an adder feeding a register that is not an accumulator", () => {
  /** X and Y from switches, S -> register D, register Q on a bus probe. */
  function figure10(): Circuit {
    const b = new CircuitBuilder()
      .add('add', ComponentType.N_ADDER, { bits: 4 })
      .add('reg', ComponentType.N_REGISTER, { bits: 4 })
      .switch('clk', ZERO)
      .switch('ld', ONE)
      .switch('clr', ZERO)
      .switch('cin', ZERO)
      .wire(p('clk', 'out'), p('reg', 'CLK'))
      .wire(p('ld', 'out'), p('reg', 'Ld'))
      .wire(p('clr', 'out'), p('reg', 'CLR'))
      .wire(p('cin', 'out'), p('add', 'Cin'))
    addBusSink(b, 'sum', 4) // adder output on its own bus probe
    addBusSink(b, 'out', 4) // register output on its own bus probe
    for (let i = 0; i < 4; i++) {
      b.switch(`x${i}`, ZERO)
        .switch(`y${i}`, ZERO)
        .wire(p(`x${i}`, 'out'), p('add', `X${i}`))
        .wire(p(`y${i}`, 'out'), p('add', `Y${i}`))
        .wire(p('add', `S${i}`), p('sum', `in${i}`))
        .wire(p('add', `S${i}`), p('reg', `D${i}`))
        .wire(p('reg', `Q${i}`), p('out', `in${i}`))
    }
    return b.build()
  }

  const setOperands = (c: Circuit, xv: number, yv: number): void => {
    c.setMany({ ...bitsToSwitches('x', binOf(xv, 4)), ...bitsToSwitches('y', binOf(yv, 4)) })
  }

  it('step d: flipping X and Y changes the adder output but not the register output', () => {
    const c = figure10()
    expect(c.bus(p('outbp', 'in'))).toBe('X') // register powers up unknown
    setOperands(c, 3, 5)
    expect(c.bus(p('sumbp', 'in'))).toBe('8')
    expect(c.bus(p('outbp', 'in'))).toBe('X')
    setOperands(c, 9, 6)
    expect(c.bus(p('sumbp', 'in'))).toBe('F')
    expect(c.bus(p('outbp', 'in'))).toBe('X')
  })

  it('step e: one clock loads the sum, and further clocks never change it', () => {
    const c = figure10()
    setOperands(c, 3, 5)
    c.pulse('clk')
    expect(c.bus(p('outbp', 'in'))).toBe('8')
    for (let k = 0; k < 5; k++) {
      c.pulse('clk')
      expect(c.bus(p('outbp', 'in'))).toBe('8')
    }
    expect(busTrace(c, 'outbp').map(([, h]) => h)).toEqual(['X', '8'])
  })

  it('step f: Cin = 1 adds one, and CLR = 1 clears the register on the next clock', () => {
    const c = figure10()
    setOperands(c, 3, 5)
    c.set('cin', ONE)
    expect(c.bus(p('sumbp', 'in'))).toBe('9')
    c.pulse('clk')
    expect(c.bus(p('outbp', 'in'))).toBe('9')
    c.set('clr', ONE)
    expect(c.bus(p('outbp', 'in'))).toBe('9') // CLR is synchronous
    c.pulse('clk')
    expect(c.bus(p('outbp', 'in'))).toBe('0')
  })

  it('Ld = 0 holds the register no matter how the operands move', () => {
    const c = figure10()
    setOperands(c, 3, 5)
    c.pulse('clk')
    c.set('ld', ZERO)
    for (const [xv, yv] of [
      [1, 1],
      [15, 15],
      [7, 8],
      [0, 0]
    ]) {
      setOperands(c, xv, yv)
      c.pulse('clk')
      expect(c.bus(p('outbp', 'in'))).toBe('8')
    }
  })

  it.each([
    [0, 0, 0],
    [3, 5, 0],
    [9, 6, 1],
    [15, 15, 1],
    [8, 8, 0],
    [1, 14, 1]
  ])('X = %i, Y = %i, Cin = %i loads the right sum on the clock', (xv, yv, cin) => {
    const c = figure10()
    setOperands(c, xv, yv)
    if (cin === 1) c.set('cin', ONE)
    const total = xv + yv + cin
    expect(c.bus(p('sumbp', 'in'))).toBe(hexOf(total % 16, 4))
    c.pulse('clk')
    expect(c.bus(p('outbp', 'in'))).toBe(hexOf(total % 16, 4))
  })
})

// ===========================================================================
// 20. Same-instant arrival on a bus-fed register (decision 1)
// ===========================================================================

describe('a register whose D bus changes at the very instant of the clock edge', () => {
  /** sig -> MERGER(1) -> bus -> SPLITTER(1) -> register D; edge at 20. */
  function busFedRegister(changeAt: number): Circuit {
    const b = new CircuitBuilder()
      .add('clk', ComponentType.CLOCK)
      .add('sig', ComponentType.INPUT_SIGNAL, { signal: [row(0, ZERO), row(changeAt, ONE)] })
      .add('gnd', ComponentType.GROUND)
      .add('vcc', ComponentType.VCC)
      .add('mg', ComponentType.MERGER, { bits: 4 })
      .add('sp', ComponentType.SPLITTER, { bits: 4 })
      .add('reg', ComponentType.N_REGISTER, { bits: 4 })
      .wire(p('sig', 'out'), p('mg', 'in0'))
      .wire(p('mg', 'out'), p('sp', 'in'))
      .wire(p('clk', 'out'), p('reg', 'CLK'))
      .wire(p('vcc', 'out'), p('reg', 'Ld'))
      .wire(p('gnd', 'out'), p('reg', 'CLR'))
      .setSimulation({ clockPeriodNs: 20, clockInitialValue: ONE, simTimeNs: 200 })
    for (let i = 1; i < 4; i++) b.wire(p('gnd', 'out'), p('mg', `in${i}`))
    for (let i = 0; i < 4; i++) b.wire(p('sp', `out${i}`), p('reg', `D${i}`))
    return b.build()
  }

  it('D arriving exactly at the edge (change at 18 + merger 1 + splitter 1 = 20) is captured', () => {
    const c = busFedRegister(18)
    c.step()
    c.step() // through the rising edge at 20
    expect(c.time).toBe(35)
    expect(c.vec('reg', 'Q', 4)).toBe('0001')
  })

  it('D arriving one nanosecond after the edge is captured only by the next edge', () => {
    const c = busFedRegister(19)
    c.step()
    c.step()
    expect(c.vec('reg', 'Q', 4)).toBe('0000')
    c.step() // edge at 40
    expect(c.vec('reg', 'Q', 4)).toBe('0001')
  })

  it('D arriving one nanosecond before the edge is captured by that edge', () => {
    const c = busFedRegister(17)
    c.step()
    c.step()
    expect(c.vec('reg', 'Q', 4)).toBe('0001')
  })
})

// ===========================================================================
// 21. CHANGE mode over a bus pipeline (Reference Manual, Appendix B)
// ===========================================================================

describe('CHANGE mode releases one pending output change at a time along a bus', () => {
  it('walks the switch, merger, tap and splitter changes one click at a time', () => {
    const c = busPipeline(1, 1, 1)
    c.sim.toggle('s1', false) // queue the switch change without propagating
    expect(c.time).toBe(0)
    expect(c.bus(p('mg', 'out'))).toBe('0')

    expect(c.sim.changeStep()).toBe(true) // the switch output changes
    expect(c.time).toBe(1)
    expect(c.pin(p('s1', 'out'))).toBe(ONE)
    expect(c.bus(p('mg', 'out'))).toBe('0')

    expect(c.sim.changeStep()).toBe(true) // the merger output changes
    expect(c.time).toBe(2)
    expect(c.bus(p('mg', 'out'))).toBe('2')
    expect(c.bus(p('tap', 'out'))).toBe('0')

    expect(c.sim.changeStep()).toBe(true) // the tap output changes
    expect(c.time).toBe(3)
    expect(c.bus(p('tap', 'out'))).toBe('1')
    expect(c.pin(p('sp', 'out0'))).toBe(ZERO)

    expect(c.sim.changeStep()).toBe(true) // the splitter output changes
    expect(c.time).toBe(4)
    expect(c.pin(p('sp', 'out0'))).toBe(ONE)

    expect(c.sim.changeStep()).toBe(false) // nothing pending
    expect(c.time).toBe(4)
  })

  it('a queued change that is undone before it is released never reaches the bus', () => {
    const c = busPipeline(3, 1, 1) // the merger is slower than the pulse
    c.sim.toggle('s1', false)
    c.sim.changeStep() // switch goes high at 1; the merger schedules a change for 4
    c.sim.toggle('s1', false) // back low at once
    while (c.sim.changeStep()) {
      /* drain */
    }
    expect(c.bus(p('mg', 'out'))).toBe('0')
    expect(busTrace(c, 'bp1')).toEqual([[0, '0']])
  })
})

// ===========================================================================
// 22. Whole-circuit readouts over busses
// ===========================================================================

describe('hasXZ() sees bus nets as well as single-bit nets', () => {
  it('is false for a fully driven, fully determined bus circuit', () => {
    expect(notArray(8, 0x5a).sim.hasXZ()).toBe(false)
  })

  it('is true while a tristate keeps the shared bus released', () => {
    const c = sharedNets(4, [0x5, 0x5], [ZERO, ZERO])
    expect(c.sim.hasXZ()).toBe(true)
    c.set('oe0', ONE)
    expect(c.sim.hasXZ()).toBe(false)
    c.set('oe1', ONE) // agreeing drivers keep the bus clean
    expect(c.sim.hasXZ()).toBe(false)
  })

  it('is true when a single bus bit is X', () => {
    const c = new CircuitBuilder()
      .add('bia', ComponentType.BUS_INPUT, { bits: 8, label: '5a' })
      .add('bib', ComponentType.BUS_INPUT, { bits: 8, label: '5b' })
      .add('bp', ComponentType.BUS_PROBE, { bits: 8 })
      .wire(p('bia', 'out'), p('bib', 'out'))
      .wire(p('bia', 'out'), p('bp', 'in'))
      .build()
    expect(c.sim.hasXZ()).toBe(true)
  })
})

describe('a combinational loop closed through a bus terminates instead of hanging', () => {
  it('a MERGER -> SPLITTER -> NOT ring settles at X from reset (X is a fixed point of NOT)', () => {
    const b = new CircuitBuilder()
      .add('mg', ComponentType.MERGER, { bits: 4 })
      .add('sp', ComponentType.SPLITTER, { bits: 4 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
      .wire(p('mg', 'out'), p('sp', 'in'))
      .wire(p('mg', 'out'), p('bp', 'in'))
    for (let i = 0; i < 4; i++) {
      b.add(`n${i}`, ComponentType.NOT)
        .wire(p('sp', `out${i}`), p(`n${i}`, 'in1'))
        .wire(p(`n${i}`, 'out'), p('mg', `in${i}`))
    }
    const c = b.build()
    expect(c.oscillated).toBe(false)
    expect(c.bus(p('bp', 'in'))).toBe('X')
    expect(busTrace(c, 'bp')).toEqual([[0, 'X']])
  })

  it('a NAND ring around a bus is stable while the enable is 0 and oscillates once it is 1', () => {
    const b = new CircuitBuilder()
      .add('mg', ComponentType.MERGER, { bits: 4 })
      .add('sp', ComponentType.SPLITTER, { bits: 4 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
      .switch('en', ZERO)
      .wire(p('mg', 'out'), p('sp', 'in'))
      .wire(p('mg', 'out'), p('bp', 'in'))
    for (let i = 0; i < 4; i++) {
      b.add(`g${i}`, ComponentType.NAND2)
        .wire(p('sp', `out${i}`), p(`g${i}`, 'in1'))
        .wire(p('en', 'out'), p(`g${i}`, 'in2'))
        .wire(p(`g${i}`, 'out'), p('mg', `in${i}`))
    }
    const c = b.build()
    // en = 0 forces every NAND high, so the ring is broken and the bus reads F.
    expect(c.oscillated).toBe(false)
    expect(c.bus(p('bp', 'in'))).toBe('F')
    c.set('en', ONE) // closes the inverting ring
    expect(c.oscillated).toBe(true)
    // The manual has no oscillation semantics (SimUaid simply runs out its time
    // limit), so only termination and the flag are asserted; the frozen value is
    // whatever the halted queue left behind.
    expect(['X', 'Z', '0', 'F']).toContain(c.bus(p('bp', 'in')))
  })
})

// ===========================================================================
// 23. Bus flows wired virtually (pin labels instead of drawn wires)
// ===========================================================================

describe('a bus round trip made entirely of pin labels behaves like the wired one', () => {
  /** Same topology as notArray(), but every connection is a shared pin label. */
  function labelled(n: number, value: number): Circuit {
    const b = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: n, label: labelOf(value) })
      .add('sp', ComponentType.SPLITTER, { bits: n })
      .add('mg', ComponentType.MERGER, { bits: n })
      .add('bp', ComponentType.BUS_PROBE, { bits: n })
      .label(p('bi', 'out'), 'DATA')
      .label(p('sp', 'in'), 'DATA')
      .label(p('mg', 'out'), 'RESULT')
      .label(p('bp', 'in'), 'RESULT')
    for (let i = 0; i < n; i++) {
      b.add(`g${i}`, ComponentType.NOT)
        .label(p('sp', `out${i}`), `S${i}`)
        .label(p(`g${i}`, 'in1'), `S${i}`)
        .label(p(`g${i}`, 'out'), `N${i}`)
        .label(p('mg', `in${i}`), `N${i}`)
    }
    return b.build()
  }

  it.each([2, 4, 5, 8, 16, 32])('%i bits: labels carry both the bus and the single-bit nets', (n) => {
    for (const v of sampleValues(n)) {
      const c = labelled(n, v)
      expect(c.bus(p('sp', 'in'))).toBe(hexOf(v, n))
      expect(c.vec('sp', 'out', n)).toBe(binOf(v, n))
      expect(c.bus(p('bp', 'in'))).toBe(hexOf(mask(n) - v, n))
      expect(busTrace(c, 'bp')).toEqual([[0, hexOf(mask(n) - v, n)]])
    }
  })
})

describe('labels and wires mix on the same bus', () => {
  it('a labelled bus feeds a wired tap, a wired splitter and two probes', () => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 8, label: 'c3' })
      .add('sp', ComponentType.SPLITTER, { bits: 8 })
      .add('tap', ComponentType.BUS_TAP, { bits: 4, tapStart: 4 })
      .add('bp1', ComponentType.BUS_PROBE, { bits: 8 })
      .add('bp2', ComponentType.BUS_PROBE, { bits: 8 })
      .add('tbp', ComponentType.BUS_PROBE, { bits: 4 })
      .label(p('bi', 'out'), 'B')
      .label(p('bp1', 'in'), 'B')
      .label(p('bp2', 'in'), 'B')
      .label(p('sp', 'in'), 'B')
      .wire(p('bp1', 'in'), p('tap', 'in')) // a drawn wire joins the labelled net
      .wire(p('tap', 'out'), p('tbp', 'in'))
      .build()
    expect(c.bus(p('bp1', 'in'))).toBe('C3')
    expect(c.bus(p('bp2', 'in'))).toBe('C3')
    expect(c.bus(p('tbp', 'in'))).toBe('C')
    for (let i = 0; i < 8; i++) expect(c.pin(p('sp', `out${i}`))).toBe(bit(bitAt(0xc3, i)))
    expect(busTrace(c, 'bp1')).toEqual([[0, 'C3']])
    expect(busTrace(c, 'bp2')).toEqual([[0, 'C3']])
  })

  it('two bus drivers joined only by a shared label contend exactly like wired ones', () => {
    const c = new CircuitBuilder()
      .add('bia', ComponentType.BUS_INPUT, { bits: 4, label: '5' })
      .add('bib', ComponentType.BUS_INPUT, { bits: 4, label: '3' })
      .add('sp', ComponentType.SPLITTER, { bits: 4 })
      .label(p('bia', 'out'), 'SHARED')
      .label(p('bib', 'out'), 'SHARED')
      .label(p('sp', 'in'), 'SHARED')
      .build()
    for (let i = 0; i < 4; i++) expect(c.pin(p('sp', `out${i}`))).toBe(resolveBit([0x5, 0x3], i))
  })

  it('an N-bit part reached through per-bit labels adds like the wired version', () => {
    const b = new CircuitBuilder()
      .add('bix', ComponentType.BUS_INPUT, { bits: 4, label: '9' })
      .add('biy', ComponentType.BUS_INPUT, { bits: 4, label: '7' })
      .add('spx', ComponentType.SPLITTER, { bits: 4 })
      .add('spy', ComponentType.SPLITTER, { bits: 4 })
      .add('add', ComponentType.N_ADDER, { bits: 4 })
      .add('mg', ComponentType.MERGER, { bits: 4 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
      .add('gnd', ComponentType.GROUND)
      .probe('cout')
      .label(p('bix', 'out'), 'X')
      .label(p('spx', 'in'), 'X')
      .label(p('biy', 'out'), 'Y')
      .label(p('spy', 'in'), 'Y')
      .label(p('mg', 'out'), 'S')
      .label(p('bp', 'in'), 'S')
      .label(p('gnd', 'out'), 'CIN')
      .label(p('add', 'Cin'), 'CIN')
      .label(p('add', 'Cout'), 'COUT')
      .label(p('cout', 'in'), 'COUT')
    for (let i = 0; i < 4; i++) {
      b.label(p('spx', `out${i}`), `XB${i}`)
        .label(p('add', `X${i}`), `XB${i}`)
        .label(p('spy', `out${i}`), `YB${i}`)
        .label(p('add', `Y${i}`), `YB${i}`)
        .label(p('add', `S${i}`), `SB${i}`)
        .label(p('mg', `in${i}`), `SB${i}`)
    }
    const c = b.build()
    expect(c.bus(p('bp', 'in'))).toBe('0')
    expect(c.pin(p('cout', 'in'))).toBe(ONE) // 9 + 7 = 16
  })
})

// ===========================================================================
// 24. Exhaustive 4-bit sweeps over a switch-driven bus
// ===========================================================================

/** switches -> MERGER -> bus -> SPLITTER for each of two operands. */
function twoOperandBus(b: CircuitBuilder): void {
  for (const name of ['x', 'y']) {
    addBusSink(b, `mg${name}`, 4)
    b.add(`sp${name}`, ComponentType.SPLITTER, { bits: 4 }).wire(p(`mg${name}`, 'out'), p(`sp${name}`, 'in'))
    for (let i = 0; i < 4; i++) {
      b.switch(`${name}${i}`, ZERO).wire(p(`${name}${i}`, 'out'), p(`mg${name}`, `in${i}`))
    }
  }
}

const setOperandBusses = (c: Circuit, xv: number, yv: number): void => {
  c.setMany({ ...bitsToSwitches('x', binOf(xv, 4)), ...bitsToSwitches('y', binOf(yv, 4)) })
}

describe('every 4-bit operand pair through a bus, a gate array and back to a bus', () => {
  for (const [name, type, op] of GATE_OPS) {
    it(`${name} array agrees with the bitwise result for all 256 pairs`, () => {
      const b = new CircuitBuilder()
      twoOperandBus(b)
      addBusSink(b, 'mgz', 4)
      for (let i = 0; i < 4; i++) {
        b.add(`g${i}`, type)
          .wire(p('spx', `out${i}`), p(`g${i}`, 'in1'))
          .wire(p('spy', `out${i}`), p(`g${i}`, 'in2'))
          .wire(p(`g${i}`, 'out'), p('mgz', `in${i}`))
      }
      const c = b.build()
      for (let xv = 0; xv < 16; xv++) {
        for (let yv = 0; yv < 16; yv++) {
          setOperandBusses(c, xv, yv)
          expect(c.bus(p('mgxbp', 'in'))).toBe(hexOf(xv, 4))
          expect(c.bus(p('mgybp', 'in'))).toBe(hexOf(yv, 4))
          expect(c.bus(p('mgzbp', 'in'))).toBe(hexOf(bitwise(4, xv, yv, op), 4))
        }
      }
    })
  }
})

describe('every 4-bit addition over a bus (all 256 pairs x both carries)', () => {
  function adderRig(): Circuit {
    const b = new CircuitBuilder()
      .add('add', ComponentType.N_ADDER, { bits: 4 })
      .switch('cin', ZERO)
      .probe('cout')
      .wire(p('cin', 'out'), p('add', 'Cin'))
      .wire(p('add', 'Cout'), p('cout', 'in'))
    twoOperandBus(b)
    addBusSink(b, 'mgs', 4)
    for (let i = 0; i < 4; i++) {
      b.wire(p('spx', `out${i}`), p('add', `X${i}`))
        .wire(p('spy', `out${i}`), p('add', `Y${i}`))
        .wire(p('add', `S${i}`), p('mgs', `in${i}`))
    }
    return b.build()
  }

  it.each([ZERO, ONE])('Cin = %s: the merged sum and Cout are right for every pair', (cin) => {
    const c = adderRig()
    c.set('cin', cin)
    const carry = cin === ONE ? 1 : 0
    for (let xv = 0; xv < 16; xv++) {
      for (let yv = 0; yv < 16; yv++) {
        setOperandBusses(c, xv, yv)
        const total = xv + yv + carry
        expect(c.bus(p('mgsbp', 'in'))).toBe(hexOf(total % 16, 4))
        expect(c.pin(p('cout', 'in'))).toBe(bit(total >= 16 ? 1 : 0))
      }
    }
  })

  it('toggling Cin alone flips the sum by one for a sample of operand pairs', () => {
    const c = adderRig()
    for (const [xv, yv] of [
      [0, 0],
      [7, 8],
      [15, 15],
      [3, 4],
      [15, 0]
    ]) {
      setOperandBusses(c, xv, yv)
      c.set('cin', ZERO)
      expect(c.bus(p('mgsbp', 'in'))).toBe(hexOf((xv + yv) % 16, 4))
      c.set('cin', ONE)
      expect(c.bus(p('mgsbp', 'in'))).toBe(hexOf((xv + yv + 1) % 16, 4))
    }
  })
})
