// Unit verification of the bus-part family: values.ts conversions and BUS_INPUT,
// BUS_PROBE, SPLITTER, MERGER, BUS_TAP, COMPLEMENTER through the Simulator.
// Tests assert manual/spec behavior (bit 0 is the LSB, hex display MSB-first,
// one active driver wins, contention -> X, no driver -> Z). Vectors are LSB-first;
// Circuit.vec() returns MSB-first strings.

import { describe, expect, it } from 'vitest'
import { ComponentType, LogicValue, makePinId, type PinId } from '../../model/types'
import { defOf } from '../../model/partDefinitions'
import { hexToVec, numToVec, vecToHex, vecToNum, xVec, zVec } from '../values'
import { CircuitBuilder, allCombos, bitsToSwitches, p, type Circuit } from './harness'

const { ZERO, ONE, X, Z } = LogicValue

// ---------------------------------------------------------------------------
// Local helpers (the harness has no hex/number formatting helpers).
// ---------------------------------------------------------------------------

/** Inclusive integer range. */
function range(from: number, to: number): number[] {
  const out: number[] = []
  for (let i = from; i <= to; i++) out.push(i)
  return out
}

/** Low `width` bits of a non-negative integer (width <= 32, no BigInt). */
function low(n: number, width: number): number {
  return n % 2 ** width
}

/** Uppercase hex, zero-padded to ceil(width/4) digits. */
function hexOf(n: number, width: number): string {
  return n.toString(16).toUpperCase().padStart(Math.ceil(width / 4), '0')
}

/** MSB-first binary string of `width` bits. */
function binStr(n: number, width: number): string {
  return n.toString(2).padStart(width, '0')
}

const digitsFor = (width: number): number => Math.ceil(width / 4)
const NON_CLEAN = /^[XZ]+$/
const isClean = (v: LogicValue): boolean => v === ZERO || v === ONE

const ALL_ONES = 0xffffffff
const ALT_A = 0xaaaaaaaa // 1010...
const ALT_5 = 0x55555555 // 0101...
const GOLDEN = 0x9e3779b9

/** BUS_INPUT `bi` (label) wired straight into BUS_PROBE `bp`. */
function busInputToProbe(width: number, label: string, probeWidth = width): Circuit {
  return new CircuitBuilder()
    .add('bi', ComponentType.BUS_INPUT, { bits: width, label })
    .add('bp', ComponentType.BUS_PROBE, { bits: probeWidth })
    .wire(p('bi', 'out'), p('bp', 'in'))
    .build()
}

/** BUS_INPUT `bi` -> SPLITTER `spl` (splitterWidth defaults to the input width). */
function busInputToSplitter(width: number, label: string, splitterWidth = width): Circuit {
  return new CircuitBuilder()
    .add('bi', ComponentType.BUS_INPUT, { bits: width, label })
    .add('spl', ComponentType.SPLITTER, { bits: splitterWidth })
    .wire(p('bi', 'out'), p('spl', 'in'))
    .build()
}

/** Switches s0..s{n-1} (all ZERO) -> MERGER `m` -> BUS_PROBE `bp`. */
function switchesToMerger(n: number): Circuit {
  const b = new CircuitBuilder()
  for (let i = 0; i < n; i++) b.switch(`s${i}`, ZERO)
  b.add('m', ComponentType.MERGER, { bits: n }).add('bp', ComponentType.BUS_PROBE, { bits: n })
  for (let i = 0; i < n; i++) b.wire(p(`s${i}`, 'out'), p('m', `in${i}`))
  b.wire(p('m', 'out'), p('bp', 'in'))
  return b.build()
}

/** BUS_INPUT `bi` -> COMPLEMENTER `cmp` (en from switch `en`) -> BUS_PROBE `bp`. */
function complementerCircuit(width: number, label: string, en: LogicValue): Circuit {
  return new CircuitBuilder()
    .add('bi', ComponentType.BUS_INPUT, { bits: width, label })
    .add('cmp', ComponentType.COMPLEMENTER, { bits: width })
    .add('bp', ComponentType.BUS_PROBE, { bits: width })
    .switch('en', en)
    .wire(p('bi', 'out'), p('cmp', 'in'))
    .wire(p('cmp', 'out'), p('bp', 'in'))
    .wire(p('en', 'out'), p('cmp', 'en'))
    .build()
}

/** 8-bit BUS_INPUT `bi` = 0x5A plus one BUS_TAP `tap` -> BUS_PROBE `bp` (or PROBE `pb` when 1 bit). */
function tapCircuit(bits: number, tapStart: number, label = '5A'): Circuit {
  const b = new CircuitBuilder()
    .add('bi', ComponentType.BUS_INPUT, { bits: 8, label })
    .add('tap', ComponentType.BUS_TAP, { bits, tapStart })
    .wire(p('bi', 'out'), p('tap', 'in'))
  if (bits === 1) {
    b.probe('pb').wire(p('tap', 'out'), p('pb', 'in'))
  } else {
    b.add('bp', ComponentType.BUS_PROBE, { bits }).wire(p('tap', 'out'), p('bp', 'in'))
  }
  return b.build()
}

// ===========================================================================
// values.ts — pure conversions
// ===========================================================================

describe('values.ts: vector <-> number <-> hex', () => {
  describe.each(range(1, 32))('width %i', (w) => {
    const digits = digitsFor(w)
    const samples = [
      0,
      1,
      low(ALL_ONES, w),
      low(ALT_A, w),
      low(ALT_5, w),
      low(GOLDEN, w),
      2 ** (w - 1) // MSB only
    ]

    it('numToVec -> vecToNum round-trips', () => {
      for (const v of samples) expect(vecToNum(numToVec(v, w))).toBe(v)
    })

    it('numToVec produces exactly `width` bits', () => {
      for (const v of samples) expect(numToVec(v, w)).toHaveLength(w)
    })

    it('vecToHex(numToVec(v)) is zero-padded uppercase hex of ceil(w/4) digits', () => {
      for (const v of samples) {
        const h = vecToHex(numToVec(v, w))
        expect(h).toBe(hexOf(v, w))
        expect(h).toHaveLength(digits)
      }
    })

    it('hexToVec accepts upper and lower case and matches numToVec', () => {
      for (const v of samples) {
        const h = hexOf(v, w)
        expect(hexToVec(h, w)).toEqual(numToVec(v, w))
        expect(hexToVec(h.toLowerCase(), w)).toEqual(numToVec(v, w))
      }
    })

    it('vecToHex(hexToVec(h)) === h', () => {
      for (const v of samples) {
        const h = hexOf(v, w)
        expect(vecToHex(hexToVec(h, w)!)).toBe(h)
      }
    })

    it('all-Z vector renders as one Z per hex digit', () => {
      expect(vecToHex(zVec(w))).toBe('Z'.repeat(digits))
    })

    it('all-X vector renders as one X per hex digit', () => {
      expect(vecToHex(xVec(w))).toBe('X'.repeat(digits))
    })

    it('a single X in any bit position renders as an X fill', () => {
      for (let i = 0; i < w; i++) {
        const vec = numToVec(low(ALT_A, w), w)
        vec[i] = X
        expect(vecToHex(vec)).toBe('X'.repeat(digits))
      }
    })

    it('vecToNum is null when any single bit is X or Z', () => {
      for (let i = 0; i < w; i++) {
        const vx = numToVec(low(ALT_5, w), w)
        vx[i] = X
        expect(vecToNum(vx)).toBeNull()
        const vz = numToVec(low(ALT_5, w), w)
        vz[i] = Z
        expect(vecToNum(vz)).toBeNull()
      }
    })
  })

  it('numToVec is LSB-first: index 0 is bit 0', () => {
    expect(numToVec(2, 4)).toEqual([ZERO, ONE, ZERO, ZERO])
    expect(numToVec(8, 4)).toEqual([ZERO, ZERO, ZERO, ONE])
    // 0x5A = 0101 1010 -> bits 1,3,4,6 set
    expect(numToVec(0x5a, 8)).toEqual([ZERO, ONE, ZERO, ONE, ONE, ZERO, ONE, ZERO])
  })

  it('vecToNum weights index i as 2^i', () => {
    expect(vecToNum([ONE, ZERO, ZERO, ZERO])).toBe(1)
    expect(vecToNum([ZERO, ZERO, ZERO, ONE])).toBe(8)
    expect(vecToNum([ZERO, ONE, ZERO, ONE, ONE, ZERO, ONE, ZERO])).toBe(0x5a)
    expect(vecToNum([])).toBe(0)
  })

  it('hexToVec is LSB-first: "A" -> [0,1,0,1]', () => {
    expect(hexToVec('A', 4)).toEqual([ZERO, ONE, ZERO, ONE])
    expect(hexToVec('5A', 8)).toEqual([ZERO, ONE, ZERO, ONE, ONE, ZERO, ONE, ZERO])
  })

  it('vecToHex renders the LSB-first vector MSB-first', () => {
    expect(vecToHex([ZERO, ONE, ZERO, ONE])).toBe('A')
    expect(vecToHex([ONE, ZERO, ONE, ZERO])).toBe('5')
    expect(vecToHex([ZERO, ONE, ZERO, ONE, ONE, ZERO, ONE, ZERO])).toBe('5A')
  })

  it('a mix of Z and clean bits is not a clean hex digit', () => {
    const vec = numToVec(5, 4)
    vec[3] = Z
    expect(vecToHex(vec)).toMatch(NON_CLEAN)
    expect(vecToHex(vec)).toHaveLength(1)
  })

  describe('hexToVec parsing', () => {
    it.each(['', 'G', '0x1F', 'x1F', '1 F', '-1', '1.5', 'Z', 'X', 'XX', 'ZZ', '#F', 'F,A', 'ÿ'])(
      'rejects %j with null',
      (s) => {
        expect(hexToVec(s, 8)).toBeNull()
      }
    )

    it('accepts every hex digit in both cases', () => {
      expect(hexToVec('0123456789abcdef', 64)).toEqual(hexToVec('0123456789ABCDEF', 64))
      expect(hexToVec('0123456789abcdef', 64)).not.toBeNull()
    })

    it('zero-extends a short hex string', () => {
      expect(hexToVec('F', 8)).toEqual(numToVec(0x0f, 8))
      expect(vecToHex(hexToVec('f', 8)!)).toBe('0F')
      expect(vecToHex(hexToVec('1', 32)!)).toBe('00000001')
    })

    it('accepts leading zeros beyond the width (value still fits)', () => {
      expect(hexToVec('00F', 4)).toEqual(numToVec(15, 4))
      expect(hexToVec('0005A', 8)).toEqual(numToVec(0x5a, 8))
    })

    it('handles odd widths (5 bits "1F", 3 bits "5", 9 bits "1FF")', () => {
      expect(hexToVec('1F', 5)).toEqual([ONE, ONE, ONE, ONE, ONE])
      expect(hexToVec('5', 3)).toEqual([ONE, ZERO, ONE])
      expect(vecToHex(hexToVec('1FF', 9)!)).toBe('1FF')
      expect(vecToHex(numToVec(3, 5))).toBe('03')
      expect(vecToHex(numToVec(1, 9))).toBe('001')
    })

    it('32-bit extremes survive the round trip', () => {
      expect(vecToNum(hexToVec('FFFFFFFF', 32)!)).toBe(0xffffffff)
      expect(vecToNum(hexToVec('80000000', 32)!)).toBe(0x80000000)
      expect(vecToHex(numToVec(0x80000000, 32))).toBe('80000000')
      expect(vecToHex(numToVec(0xdeadbeef, 32))).toBe('DEADBEEF')
    })

    // Decision 10: a value that does not fit in `bits` is invalid (null), not truncated.
    it.each<[string, number]>([
      ['1F', 4],
      ['10', 4],
      ['3F', 5],
      ['20', 5],
      ['100', 8],
      ['1FF', 8],
      ['200', 9],
      ['10000', 16],
      ['100000000', 32],
      ['FFFFFFFFF', 32],
      ['2', 1],
      ['4', 2],
      ['8', 3]
    ])('hexToVec(%j, %i) is null because the value does not fit (decision 10)', (h, bits) => {
      expect(hexToVec(h, bits)).toBeNull()
    })

    it.each<[string, number]>([
      ['F', 4],
      ['1F', 5],
      ['FF', 8],
      ['1FF', 9],
      ['FFFF', 16],
      ['FFFFFFFF', 32],
      ['1', 1],
      ['3', 2],
      ['7', 3]
    ])('hexToVec(%j, %i) is the all-ones vector (largest value that fits)', (h, bits) => {
      expect(hexToVec(h, bits)).toEqual(numToVec(low(ALL_ONES, bits), bits))
    })

    it.each(range(1, 32))('width %i: the smallest non-fitting value 2^w is null and 2^w - 1 fits', (w) => {
      const max = low(ALL_ONES, w)
      expect(hexToVec(max.toString(16), w)).toEqual(numToVec(max, w))
      expect(hexToVec((2 ** w).toString(16), w)).toBeNull()
    })
  })

  describe('vecToHex fills', () => {
    it('a vector mixing Z and X (no clean bits) is an X fill, not a Z fill', () => {
      const vec = zVec(8)
      vec[3] = X
      expect(vecToHex(vec)).toBe('XX')
    })

    it('a vector mixing Z, X and clean bits is an X fill', () => {
      const vec = numToVec(0x5a, 8)
      vec[0] = Z
      vec[7] = X
      expect(vecToHex(vec)).toBe('XX')
    })

    it('a single Z among clean bits is a fill (never a clean digit), one char per nibble', () => {
      const vec = numToVec(0x5a, 8)
      vec[5] = Z
      expect(vecToHex(vec)).toHaveLength(2)
      expect(vecToHex(vec)).toMatch(NON_CLEAN)
    })

    it('numToVec of a value wider than `bits` keeps only the low bits', () => {
      expect(numToVec(0x1f, 4)).toEqual(numToVec(0xf, 4))
      expect(numToVec(0x100, 8)).toEqual(numToVec(0, 8))
    })
  })
})

// ===========================================================================
// BUS_INPUT
// ===========================================================================

describe('BUS_INPUT: label parsed as hex and driven onto its bus', () => {
  describe.each(range(2, 32))('width %i', (w) => {
    it('all-ones label reads back on a probe', () => {
      const h = hexOf(low(ALL_ONES, w), w)
      expect(busInputToProbe(w, h).bus(p('bp', 'in'))).toBe(h)
    })

    it('alternating 1010... label reads back on a probe', () => {
      const h = hexOf(low(ALT_A, w), w)
      expect(busInputToProbe(w, h).bus(p('bp', 'in'))).toBe(h)
    })

    it('zero label reads back as zero-padded hex', () => {
      const h = hexOf(0, w)
      expect(busInputToProbe(w, '0').bus(p('bp', 'in'))).toBe(h)
    })

    it('MSB-only label reads back and splits with the 1 on out{w-1}', () => {
      const v = 2 ** (w - 1)
      const c = busInputToSplitter(w, hexOf(v, w))
      expect(c.pin(p('spl', `out${w - 1}`))).toBe(ONE)
      expect(c.pin(p('spl', 'out0'))).toBe(ZERO)
    })
  })

  it('the value is visible on the BUS_INPUT own out pin', () => {
    const c = new CircuitBuilder().add('bi', ComponentType.BUS_INPUT, { bits: 8, label: '3C' }).build()
    expect(c.bus(p('bi', 'out'))).toBe('3C')
  })

  it('lowercase label displays as the same value', () => {
    expect(busInputToProbe(8, '5a').bus(p('bp', 'in'))).toBe('5A')
    expect(busInputToProbe(8, 'fF').bus(p('bp', 'in'))).toBe('FF')
  })

  it('short label zero-extends to the bus width', () => {
    expect(busInputToProbe(8, '5').bus(p('bp', 'in'))).toBe('05')
    expect(busInputToProbe(16, 'A').bus(p('bp', 'in'))).toBe('000A')
  })

  it('leading zeros are accepted when the value fits', () => {
    expect(busInputToProbe(4, '00f').bus(p('bp', 'in'))).toBe('F')
    expect(busInputToProbe(8, '005A').bus(p('bp', 'in'))).toBe('5A')
  })

  it.each(['G5', '0x5A', 'x5A', '5 A', '-5', '5.0', 'ZZ', 'XX', 'hello'])(
    'invalid label %j drives an X vector (probe shows X fill)',
    (label) => {
      expect(busInputToProbe(8, label).bus(p('bp', 'in'))).toBe('XX')
    }
  )

  it('empty label drives an X vector', () => {
    expect(busInputToProbe(8, '').bus(p('bp', 'in'))).toBe('XX')
    expect(busInputToProbe(4, '').bus(p('bp', 'in'))).toBe('X')
  })

  it('invalid label splits into X on every bit', () => {
    const c = busInputToSplitter(4, 'G')
    expect(c.vec('spl', 'out', 4)).toBe('XXXX')
  })

  // The manual says "ensure that [the hex string] is of the proper length"; the editor
  // warns `"<v>" is not a valid N-bit hex value — output will be X` for values >= 2^N.
  it('over-range label (value >= 2^bits) is invalid -> X vector, not silently truncated', () => {
    expect(busInputToProbe(4, '1F').bus(p('bp', 'in'))).toBe('X')
    expect(busInputToProbe(4, '10').bus(p('bp', 'in'))).toBe('X')
    expect(busInputToProbe(5, '3F').bus(p('bp', 'in'))).toBe('XX')
    expect(busInputToProbe(5, '20').bus(p('bp', 'in'))).toBe('XX')
    expect(busInputToProbe(8, '1FF').bus(p('bp', 'in'))).toBe('XX')
    expect(busInputToProbe(8, '100').bus(p('bp', 'in'))).toBe('XX')
    expect(busInputToProbe(32, '100000000').bus(p('bp', 'in'))).toBe('XXXXXXXX')
    expect(busInputToProbe(32, 'FFFFFFFFF').bus(p('bp', 'in'))).toBe('XXXXXXXX')
  })

  it('the largest value that fits is valid for every width 2..32 and 2^w is X', () => {
    for (const w of range(2, 32)) {
      const max = low(ALL_ONES, w)
      expect(busInputToProbe(w, max.toString(16)).bus(p('bp', 'in'))).toBe(hexOf(max, w))
      expect(busInputToProbe(w, (2 ** w).toString(16)).bus(p('bp', 'in'))).toBe('X'.repeat(digitsFor(w)))
    }
  })

  // Decision 10: the simulator uses the same clamped width as the drawn part (1..32
  // for bus parts, BUS_INPUT min is 2), so an out-of-range `bits` behaves as the clamp.
  describe('bits clamping (decision 10)', () => {
    it('bits: 64 clamps to 32: an 8-digit label is valid and a 9-digit one is X', () => {
      expect(busInputToProbe(64, 'DEADBEEF').bus(p('bp', 'in'))).toBe('DEADBEEF')
      expect(busInputToProbe(64, '1DEADBEEF').bus(p('bp', 'in'))).toBe('XXXXXXXX')
    })

    it('bits: 33 clamps to 32 and splits into 32 bits', () => {
      const c = busInputToSplitter(33, 'FFFFFFFF', 33)
      expect(c.vec('spl', 'out', 32)).toBe('1'.repeat(32))
      expect(() => c.pin(p('spl', 'out32'))).toThrow()
    })

    it('bits: 1 clamps to 2: label "3" fits, label "4" is X', () => {
      expect(busInputToProbe(1, '3').bus(p('bp', 'in'))).toBe('3')
      expect(busInputToProbe(1, '4').bus(p('bp', 'in'))).toBe('X')
    })

    it('bits: 0 clamps to 2', () => {
      expect(busInputToProbe(0, '2').bus(p('bp', 'in'))).toBe('2')
      expect(busInputToProbe(0, '4').bus(p('bp', 'in'))).toBe('X')
    })

    it('a clamped BUS_INPUT and a clamped SPLITTER (both bits: 40 -> 32) agree on width', () => {
      const c = busInputToSplitter(40, '80000001', 40)
      expect(c.pin(p('spl', 'out31'))).toBe(ONE)
      expect(c.pin(p('spl', 'out0'))).toBe(ONE)
      expect(c.pin(p('spl', 'out15'))).toBe(ZERO)
    })
  })

  // A .ckt file may omit `bits`; the part definition then uses DEFAULT_BITS (4-bit pin),
  // so the driven vector must be the same width as the pin.
  it('BUS_INPUT and BUS_PROBE without explicit bits agree on the default width', () => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { label: '5' })
      .add('bp', ComponentType.BUS_PROBE)
      .wire(p('bi', 'out'), p('bp', 'in'))
      .build()
    expect(c.bus(p('bp', 'in'))).toBe('5')
  })

  it('connects to a probe through matching pin labels (virtual bus)', () => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 8, label: 'C3' })
      .add('bp', ComponentType.BUS_PROBE, { bits: 8 })
      .label(p('bi', 'out'), 'DATA')
      .label(p('bp', 'in'), 'DATA')
      .build()
    expect(c.bus(p('bp', 'in'))).toBe('C3')
  })

  it('reset() re-drives the label value', () => {
    const c = busInputToProbe(8, '7E')
    c.reset()
    expect(c.bus(p('bp', 'in'))).toBe('7E')
  })
})

// ===========================================================================
// BUS_PROBE
// ===========================================================================

describe('BUS_PROBE: hex display and timing-diagram trace', () => {
  it.each([2, 4, 5, 8, 12, 16, 17, 32])('lone %i-bit probe shows a Z fill (no driver)', (w) => {
    const c = new CircuitBuilder().add('bp', ComponentType.BUS_PROBE, { bits: w }).build()
    expect(c.bus(p('bp', 'in'))).toBe('Z'.repeat(digitsFor(w)))
  })

  it('non-multiple-of-4 widths display ceil(w/4) zero-padded digits', () => {
    expect(busInputToProbe(5, '3').bus(p('bp', 'in'))).toBe('03')
    expect(busInputToProbe(9, '1').bus(p('bp', 'in'))).toBe('001')
    expect(busInputToProbe(5, '1F').bus(p('bp', 'in'))).toBe('1F')
  })

  it('has a waveform trace flagged as bus whose first sample carries the hex at t=0', () => {
    const c = busInputToProbe(8, '5A')
    const traces = c.sim.getWaveforms()
    expect(traces).toHaveLength(1)
    expect(traces[0].probeId).toBe('bp')
    expect(traces[0].bus).toBe(true)
    expect(traces[0].samples.length).toBeGreaterThanOrEqual(1)
    expect(traces[0].samples[0].t).toBe(0)
    expect(traces[0].samples[0].hex).toBe('5A')
  })

  it('single-bit PROBE traces are not bus traces and carry no hex', () => {
    const c = new CircuitBuilder()
      .switch('s', ONE)
      .probe('pb')
      .wire(p('s', 'out'), p('pb', 'in'))
      .build()
    const tr = c.sim.getWaveforms()[0]
    expect(tr.probeId).toBe('pb')
    expect(tr.bus).toBe(false)
    expect(tr.samples.at(-1)!.v).toBe(ONE)
    expect(tr.samples.at(-1)!.hex).toBeUndefined()
  })

  it('appends a sample with the new hex whenever the bus value changes', () => {
    const c = switchesToMerger(4)
    expect(c.bus(p('bp', 'in'))).toBe('0')
    const before = c.sim.getWaveforms()[0].samples.length
    c.set('s1', ONE) // 0010
    c.set('s3', ONE) // 1010
    const tr = c.sim.getWaveforms()[0]
    expect(tr.bus).toBe(true)
    expect(tr.samples.length).toBe(before + 2)
    expect(tr.samples.at(-2)!.hex).toBe('2')
    expect(tr.samples.at(-1)!.hex).toBe('A')
    expect(tr.samples.at(-1)!.t).toBeGreaterThan(tr.samples.at(-2)!.t)
  })

  it('bus-probe sample time is exactly one merger delay after its input net changed', () => {
    const c = new CircuitBuilder()
      .switch('s', ZERO)
      .add('g', ComponentType.GROUND)
      .add('m', ComponentType.MERGER, { bits: 4, delay: 3 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
      .probe('pb')
      .wire(p('s', 'out'), p('m', 'in0'))
      .wire(p('s', 'out'), p('pb', 'in'))
      .connect(p('g', 'out'), p('m', 'in1'), p('m', 'in2'), p('m', 'in3'))
      .wire(p('m', 'out'), p('bp', 'in'))
      .build()
    expect(c.bus(p('bp', 'in'))).toBe('0')
    c.set('s', ONE)
    expect(c.bus(p('bp', 'in'))).toBe('1')
    const traces = c.sim.getWaveforms()
    const bit = traces.find((t) => t.probeId === 'pb')!.samples.at(-1)!
    const bus = traces.find((t) => t.probeId === 'bp')!.samples.at(-1)!
    expect(bit.v).toBe(ONE)
    expect(bus.hex).toBe('1')
    expect(bus.t - bit.t).toBe(3)
  })

  it('two probes on one bus both show the value and both get traces', () => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 8, label: '42' })
      .add('bp1', ComponentType.BUS_PROBE, { bits: 8 })
      .add('bp2', ComponentType.BUS_PROBE, { bits: 8 })
      .wire(p('bi', 'out'), p('bp1', 'in'))
      .wire(p('bi', 'out'), p('bp2', 'in'))
      .build()
    expect(c.bus(p('bp1', 'in'))).toBe('42')
    expect(c.bus(p('bp2', 'in'))).toBe('42')
    expect(c.sim.getWaveforms().map((t) => t.probeId)).toEqual(['bp1', 'bp2'])
  })
})

// ===========================================================================
// SPLITTER
// ===========================================================================

describe('SPLITTER: bus -> single-bit nets, out0 is the LSB', () => {
  it.each([2, 3, 4, 5, 8, 12, 16, 17, 31, 32])('width %i: alternating pattern splits MSB-first as vec()', (w) => {
    const v = low(ALT_A, w)
    const c = busInputToSplitter(w, hexOf(v, w))
    expect(c.vec('spl', 'out', w)).toBe(binStr(v, w))
  })

  it.each([2, 3, 4, 5, 8, 16, 32])('width %i: 0101... pattern splits correctly', (w) => {
    const v = low(ALT_5, w)
    const c = busInputToSplitter(w, hexOf(v, w))
    expect(c.vec('spl', 'out', w)).toBe(binStr(v, w))
  })

  it.each(range(0, 7))('8-bit one-hot value 1<<%i lands only on out%i', (i) => {
    const c = busInputToSplitter(8, hexOf(1 << i, 8))
    for (let k = 0; k < 8; k++) {
      expect(c.pin(p('spl', `out${k}`))).toBe(k === i ? ONE : ZERO)
    }
  })

  it('5A splits to out7..out0 = 01011010', () => {
    const c = busInputToSplitter(8, '5A')
    expect(c.vec('spl', 'out', 8)).toBe('01011010')
    expect(c.pin(p('spl', 'out0'))).toBe(ZERO)
    expect(c.pin(p('spl', 'out1'))).toBe(ONE)
    expect(c.pin(p('spl', 'out7'))).toBe(ZERO)
    expect(c.pin(p('spl', 'out6'))).toBe(ONE)
  })

  it('32-bit DEADBEEF splits correctly', () => {
    const c = busInputToSplitter(32, 'DEADBEEF')
    expect(c.vec('spl', 'out', 32)).toBe(binStr(0xdeadbeef, 32))
  })

  it('a splitter output drives a gate like any net', () => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 4, label: '5' })
      .add('spl', ComponentType.SPLITTER, { bits: 4 })
      .add('n0', ComponentType.NOT)
      .add('n1', ComponentType.NOT)
      .add('a', ComponentType.AND2)
      .wire(p('bi', 'out'), p('spl', 'in'))
      .wire(p('spl', 'out0'), p('n0', 'in1'))
      .wire(p('spl', 'out1'), p('n1', 'in1'))
      .wire(p('spl', 'out0'), p('a', 'in1'))
      .wire(p('spl', 'out2'), p('a', 'in2'))
      .build()
    expect(c.pin(p('n0', 'out'))).toBe(ZERO) // bit0 = 1
    expect(c.pin(p('n1', 'out'))).toBe(ONE) // bit1 = 0
    expect(c.pin(p('a', 'out'))).toBe(ONE) // bit0 & bit2 = 1 & 1
  })

  it('unconnected splitter input yields non-clean (X/Z) outputs, and a gate fed by one outputs X', () => {
    const c = new CircuitBuilder()
      .add('spl', ComponentType.SPLITTER, { bits: 4 })
      .add('n', ComponentType.NOT)
      .wire(p('spl', 'out0'), p('n', 'in1'))
      .build()
    for (let i = 0; i < 4; i++) expect(isClean(c.pin(p('spl', `out${i}`)))).toBe(false)
    expect(c.pin(p('n', 'out'))).toBe(X)
  })

  it('splitter on an X-driven bus outputs X on every bit', () => {
    const c = busInputToSplitter(8, 'zz')
    expect(c.vec('spl', 'out', 8)).toBe('XXXXXXXX')
  })

  it('SPLITTER without explicit bits has DEFAULT_BITS (4) outputs', () => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { label: '9' })
      .add('spl', ComponentType.SPLITTER)
      .wire(p('bi', 'out'), p('spl', 'in'))
      .build()
    expect(c.vec('spl', 'out', 4)).toBe('1001')
    expect(() => c.pin(p('spl', 'out4'))).toThrow()
  })

  it('splitter outputs change exactly one splitter delay after the bus changes', () => {
    const b = new CircuitBuilder()
    for (let i = 0; i < 4; i++) b.switch(`s${i}`, ZERO)
    b.add('m', ComponentType.MERGER, { bits: 4, delay: 1 })
      .add('spl', ComponentType.SPLITTER, { bits: 4, delay: 4 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
      .probe('pb')
    for (let i = 0; i < 4; i++) b.wire(p(`s${i}`, 'out'), p('m', `in${i}`))
    b.wire(p('m', 'out'), p('spl', 'in')).wire(p('m', 'out'), p('bp', 'in')).wire(p('spl', 'out2'), p('pb', 'in'))
    const c = b.build()
    c.set('s2', ONE)
    expect(c.pin(p('pb', 'in'))).toBe(ONE)
    const traces = c.sim.getWaveforms()
    const bus = traces.find((t) => t.probeId === 'bp')!.samples.at(-1)!
    const bit = traces.find((t) => t.probeId === 'pb')!.samples.at(-1)!
    expect(bus.hex).toBe('4')
    expect(bit.v).toBe(ONE)
    expect(bit.t - bus.t).toBe(4)
    expect(bus.t).toBe(2) // switch out changes at 1, merger out (the bus) at 2
    expect(bit.t).toBe(6)
  })

  it('splitter outputs follow a merger-driven bus when switches toggle', () => {
    const b = new CircuitBuilder()
    for (let i = 0; i < 4; i++) b.switch(`s${i}`, ZERO)
    b.add('m', ComponentType.MERGER, { bits: 4 }).add('spl', ComponentType.SPLITTER, { bits: 4 })
    for (let i = 0; i < 4; i++) b.wire(p(`s${i}`, 'out'), p('m', `in${i}`))
    b.wire(p('m', 'out'), p('spl', 'in'))
    const c = b.build()
    expect(c.vec('spl', 'out', 4)).toBe('0000')
    c.set('s2', ONE)
    expect(c.vec('spl', 'out', 4)).toBe('0100')
    c.setMany(bitsToSwitches('s', '1011'))
    expect(c.vec('spl', 'out', 4)).toBe('1011')
  })
})

// ===========================================================================
// MERGER
// ===========================================================================

describe('MERGER: single-bit nets -> bus, in0 is the LSB', () => {
  it.each(range(0, 15).map((n) => ({ n, bin: binStr(n, 4), hex: hexOf(n, 4) })))(
    '4-bit: in3..in0 = $bin -> hex $hex',
    ({ bin, hex }) => {
      const c = switchesToMerger(4)
      c.setMany(bitsToSwitches('s', bin))
      expect(c.bus(p('bp', 'in'))).toBe(hex)
      expect(c.bus(p('m', 'out'))).toBe(hex)
    }
  )

  it.each(range(0, 7))('8-bit: only in%i high -> hex of 1<<%i', (i) => {
    const c = switchesToMerger(8)
    c.set(`s${i}`, ONE)
    expect(c.bus(p('bp', 'in'))).toBe(hexOf(1 << i, 8))
  })

  it('allCombos(4) all agree with vecToHex of the LSB-first switch vector', () => {
    const c = switchesToMerger(4)
    for (const combo of allCombos(4)) {
      c.setMany({ s0: combo[0], s1: combo[1], s2: combo[2], s3: combo[3] })
      expect(c.bus(p('bp', 'in'))).toBe(vecToHex(combo))
    }
  })

  it('16-bit merger from VCC/GROUND pattern 0xF0F0', () => {
    const b = new CircuitBuilder().add('v', ComponentType.VCC).add('g', ComponentType.GROUND)
    b.add('m', ComponentType.MERGER, { bits: 16 }).add('bp', ComponentType.BUS_PROBE, { bits: 16 })
    for (let i = 0; i < 16; i++) {
      const bit = (0xf0f0 >> i) & 1
      b.wire(p(bit ? 'v' : 'g', 'out'), p('m', `in${i}`))
    }
    b.wire(p('m', 'out'), p('bp', 'in'))
    expect(b.build().bus(p('bp', 'in'))).toBe('F0F0')
  })

  it('an unconnected input bit makes the hex a non-clean (X/Z) fill', () => {
    const b = new CircuitBuilder()
    for (let i = 0; i < 3; i++) b.switch(`s${i}`, ONE)
    b.add('m', ComponentType.MERGER, { bits: 4 }).add('bp', ComponentType.BUS_PROBE, { bits: 4 })
    for (let i = 0; i < 3; i++) b.wire(p(`s${i}`, 'out'), p('m', `in${i}`))
    b.wire(p('m', 'out'), p('bp', 'in'))
    const c = b.build()
    const hex = c.bus(p('bp', 'in'))
    expect(hex).toHaveLength(1)
    expect(hex).toMatch(NON_CLEAN)
  })

  it('an unconnected input bit shows up as a non-clean bit when re-split', () => {
    const b = new CircuitBuilder()
    for (let i = 0; i < 3; i++) b.switch(`s${i}`, ONE)
    b.add('m', ComponentType.MERGER, { bits: 4 }).add('spl', ComponentType.SPLITTER, { bits: 4 })
    for (let i = 0; i < 3; i++) b.wire(p(`s${i}`, 'out'), p('m', `in${i}`))
    b.wire(p('m', 'out'), p('spl', 'in'))
    const c = b.build()
    expect(c.pin(p('spl', 'out0'))).toBe(ONE)
    expect(c.pin(p('spl', 'out1'))).toBe(ONE)
    expect(c.pin(p('spl', 'out2'))).toBe(ONE)
    expect(isClean(c.pin(p('spl', 'out3')))).toBe(false)
  })

  it('an X input bit (gate with unconnected input) makes the hex an X fill', () => {
    const b = new CircuitBuilder().add('v', ComponentType.VCC).add('nx', ComponentType.NOT)
    b.add('m', ComponentType.MERGER, { bits: 4 }).add('bp', ComponentType.BUS_PROBE, { bits: 4 })
    b.connect(p('v', 'out'), p('m', 'in0'), p('m', 'in1'), p('m', 'in2'))
    b.wire(p('nx', 'out'), p('m', 'in3'))
    b.wire(p('m', 'out'), p('bp', 'in'))
    expect(b.build().bus(p('bp', 'in'))).toBe('X')
  })

  it('a merger with every input unconnected leaves the bus non-clean', () => {
    const c = new CircuitBuilder()
      .add('m', ComponentType.MERGER, { bits: 8 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 8 })
      .wire(p('m', 'out'), p('bp', 'in'))
      .build()
    expect(c.bus(p('bp', 'in'))).toMatch(/^[XZ]{2}$/)
  })

  it('MERGER without explicit bits has DEFAULT_BITS (4) inputs and a 4-bit out', () => {
    const b = new CircuitBuilder().add('v', ComponentType.VCC)
    b.add('m', ComponentType.MERGER).add('bp', ComponentType.BUS_PROBE)
    b.connect(p('v', 'out'), p('m', 'in0'), p('m', 'in1'), p('m', 'in2'), p('m', 'in3'))
    b.wire(p('m', 'out'), p('bp', 'in'))
    const c = b.build()
    expect(c.bus(p('bp', 'in'))).toBe('F')
    expect(() => c.pin(p('m', 'in4'))).toThrow()
  })

  it('a merger input driven Z by a disabled tristate reads as a Z bit (X fill), and clears when enabled', () => {
    const b = new CircuitBuilder().add('v', ComponentType.VCC).switch('ctl', ZERO).switch('d', ONE)
    b.add('ts', ComponentType.TRISTATE_RIGHT)
      .add('m', ComponentType.MERGER, { bits: 4 })
      .add('spl', ComponentType.SPLITTER, { bits: 4 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
    b.connect(p('v', 'out'), p('m', 'in0'), p('m', 'in1'), p('m', 'in2'))
    b.wire(p('d', 'out'), p('ts', 'in')).wire(p('ctl', 'out'), p('ts', 'ctl')).wire(p('ts', 'out'), p('m', 'in3'))
    b.wire(p('m', 'out'), p('spl', 'in')).wire(p('m', 'out'), p('bp', 'in'))
    const c = b.build()
    expect(c.pin(p('spl', 'out3'))).toBe(Z)
    expect(c.bus(p('bp', 'in'))).toMatch(NON_CLEAN)
    c.set('ctl', ONE)
    expect(c.bus(p('bp', 'in'))).toBe('F')
    c.set('d', ZERO)
    expect(c.bus(p('bp', 'in'))).toBe('7')
  })

  it('bus follows every switch change (toggle sequence)', () => {
    const c = switchesToMerger(4)
    c.toggle('s0')
    expect(c.bus(p('bp', 'in'))).toBe('1')
    c.toggle('s3')
    expect(c.bus(p('bp', 'in'))).toBe('9')
    c.toggle('s0')
    expect(c.bus(p('bp', 'in'))).toBe('8')
    c.toggle('s3')
    expect(c.bus(p('bp', 'in'))).toBe('0')
  })
})

// ===========================================================================
// BUS_TAP
// ===========================================================================

describe('BUS_TAP: contiguous slice of a wider bus (tapStart = lowest bit)', () => {
  // 0x5A = 0101 1010 (bit7..bit0)
  it('"7:5" (3 bits from 5) of 5A = 010 -> 2 (manual Figure 5)', () => {
    expect(tapCircuit(3, 5).bus(p('bp', 'in'))).toBe('2')
  })

  it('"1:0" (2 bits from 0) of 5A = 10 -> 2 (manual Figure 5)', () => {
    expect(tapCircuit(2, 0).bus(p('bp', 'in'))).toBe('2')
  })

  it('"4:2" of 5A = 110 -> 6', () => {
    expect(tapCircuit(3, 2).bus(p('bp', 'in'))).toBe('6')
  })

  it('"7:3" (5 bits) of 5A = 01011 -> 0B', () => {
    expect(tapCircuit(5, 3).bus(p('bp', 'in'))).toBe('0B')
  })

  it('"3:0" of 5A -> A and "7:4" of 5A -> 5', () => {
    expect(tapCircuit(4, 0).bus(p('bp', 'in'))).toBe('A')
    expect(tapCircuit(4, 4).bus(p('bp', 'in'))).toBe('5')
  })

  it('full-width tap "7:0" reproduces the bus', () => {
    expect(tapCircuit(8, 0).bus(p('bp', 'in'))).toBe('5A')
  })

  it.each(range(0, 7))('1-bit tap of bit %i drives a single-bit net carrying that bit of 5A', (i) => {
    const c = tapCircuit(1, i)
    const expected = (0x5a >> i) & 1 ? ONE : ZERO
    expect(c.pin(p('pb', 'in'))).toBe(expected)
    expect(c.pin(p('tap', 'out'))).toBe(expected)
  })

  it('1-bit tap output feeds a NOT gate', () => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 8, label: '5A' })
      .add('t1', ComponentType.BUS_TAP, { bits: 1, tapStart: 1 })
      .add('t0', ComponentType.BUS_TAP, { bits: 1, tapStart: 0 })
      .add('n1', ComponentType.NOT)
      .add('n0', ComponentType.NOT)
      .wire(p('bi', 'out'), p('t1', 'in'))
      .wire(p('bi', 'out'), p('t0', 'in'))
      .wire(p('t1', 'out'), p('n1', 'in1'))
      .wire(p('t0', 'out'), p('n0', 'in1'))
      .build()
    expect(c.pin(p('n1', 'out'))).toBe(ZERO) // bit1 = 1
    expect(c.pin(p('n0', 'out'))).toBe(ONE) // bit0 = 0
  })

  it('1-bit tap output ANDs with a switch', () => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 8, label: '5A' })
      .add('t', ComponentType.BUS_TAP, { bits: 1, tapStart: 6 })
      .switch('s', ZERO)
      .add('a', ComponentType.AND2)
      .wire(p('bi', 'out'), p('t', 'in'))
      .wire(p('t', 'out'), p('a', 'in1'))
      .wire(p('s', 'out'), p('a', 'in2'))
      .build()
    expect(c.pin(p('a', 'out'))).toBe(ZERO)
    c.set('s', ONE)
    expect(c.pin(p('a', 'out'))).toBe(ONE) // bit6 of 5A = 1
  })

  it('out-of-range bits are X: "9:6" on an 8-bit bus -> X fill', () => {
    expect(tapCircuit(4, 6).bus(p('bp', 'in'))).toBe('X')
  })

  it('out-of-range bits are X even when the in-range part is clean (re-split)', () => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 8, label: 'FF' })
      .add('tap', ComponentType.BUS_TAP, { bits: 4, tapStart: 6 })
      .add('spl', ComponentType.SPLITTER, { bits: 4 })
      .wire(p('bi', 'out'), p('tap', 'in'))
      .wire(p('tap', 'out'), p('spl', 'in'))
      .build()
    expect(c.pin(p('spl', 'out0'))).toBe(ONE) // bit6
    expect(c.pin(p('spl', 'out1'))).toBe(ONE) // bit7
    expect(c.pin(p('spl', 'out2'))).toBe(X) // bit8: beyond the bus
    expect(c.pin(p('spl', 'out3'))).toBe(X) // bit9
  })

  it('fully out-of-range 1-bit tap (bit 8 of an 8-bit bus) -> X', () => {
    expect(tapCircuit(1, 8).pin(p('pb', 'in'))).toBe(X)
  })

  it('a tap of an X-driven bus is X', () => {
    expect(tapCircuit(3, 5, 'GG').bus(p('bp', 'in'))).toBe('X')
    expect(tapCircuit(1, 0, 'GG').pin(p('pb', 'in'))).toBe(X)
  })

  it('multiple taps on one bus each see their own slice', () => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 8, label: '5A' })
      .add('hi', ComponentType.BUS_TAP, { bits: 3, tapStart: 5 })
      .add('mid', ComponentType.BUS_TAP, { bits: 3, tapStart: 2 })
      .add('lo', ComponentType.BUS_TAP, { bits: 2, tapStart: 0 })
      .add('bhi', ComponentType.BUS_PROBE, { bits: 3 })
      .add('bmid', ComponentType.BUS_PROBE, { bits: 3 })
      .add('blo', ComponentType.BUS_PROBE, { bits: 2 })
      .wire(p('bi', 'out'), p('hi', 'in'))
      .wire(p('bi', 'out'), p('mid', 'in'))
      .wire(p('bi', 'out'), p('lo', 'in'))
      .wire(p('hi', 'out'), p('bhi', 'in'))
      .wire(p('mid', 'out'), p('bmid', 'in'))
      .wire(p('lo', 'out'), p('blo', 'in'))
      .build()
    expect(c.bus(p('bhi', 'in'))).toBe('2')
    expect(c.bus(p('bmid', 'in'))).toBe('6')
    expect(c.bus(p('blo', 'in'))).toBe('2')
  })

  it('32-bit bus: tap "31:28" of DEADBEEF -> D, "3:0" -> F, "15:8" -> BE', () => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 32, label: 'DEADBEEF' })
      .add('t1', ComponentType.BUS_TAP, { bits: 4, tapStart: 28 })
      .add('t2', ComponentType.BUS_TAP, { bits: 4, tapStart: 0 })
      .add('t3', ComponentType.BUS_TAP, { bits: 8, tapStart: 8 })
      .add('b1', ComponentType.BUS_PROBE, { bits: 4 })
      .add('b2', ComponentType.BUS_PROBE, { bits: 4 })
      .add('b3', ComponentType.BUS_PROBE, { bits: 8 })
      .wire(p('bi', 'out'), p('t1', 'in'))
      .wire(p('bi', 'out'), p('t2', 'in'))
      .wire(p('bi', 'out'), p('t3', 'in'))
      .wire(p('t1', 'out'), p('b1', 'in'))
      .wire(p('t2', 'out'), p('b2', 'in'))
      .wire(p('t3', 'out'), p('b3', 'in'))
      .build()
    expect(c.bus(p('b1', 'in'))).toBe('D')
    expect(c.bus(p('b2', 'in'))).toBe('F')
    expect(c.bus(p('b3', 'in'))).toBe('BE')
  })

  it('tap follows a merger-driven bus when a switch toggles (bus and 1-bit taps)', () => {
    const b = new CircuitBuilder()
    for (let i = 0; i < 4; i++) b.switch(`s${i}`, ZERO)
    b.add('m', ComponentType.MERGER, { bits: 4 })
      .add('t2', ComponentType.BUS_TAP, { bits: 2, tapStart: 2 })
      .add('t1', ComponentType.BUS_TAP, { bits: 1, tapStart: 3 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 2 })
      .probe('pb')
    for (let i = 0; i < 4; i++) b.wire(p(`s${i}`, 'out'), p('m', `in${i}`))
    b.wire(p('m', 'out'), p('t2', 'in'))
      .wire(p('m', 'out'), p('t1', 'in'))
      .wire(p('t2', 'out'), p('bp', 'in'))
      .wire(p('t1', 'out'), p('pb', 'in'))
    const c = b.build()
    expect(c.bus(p('bp', 'in'))).toBe('0')
    expect(c.pin(p('pb', 'in'))).toBe(ZERO)
    c.set('s3', ONE) // 1000 -> bits 3..2 = 10
    expect(c.bus(p('bp', 'in'))).toBe('2')
    expect(c.pin(p('pb', 'in'))).toBe(ONE)
    c.set('s2', ONE) // 1100 -> 11
    expect(c.bus(p('bp', 'in'))).toBe('3')
    c.set('s3', ZERO) // 0100 -> 01
    expect(c.bus(p('bp', 'in'))).toBe('1')
    expect(c.pin(p('pb', 'in'))).toBe(ZERO)
  })

  it('BUS_TAP without explicit bits taps DEFAULT_BITS (4) bits from tapStart', () => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 8, label: '5A' })
      .add('tap', ComponentType.BUS_TAP, { tapStart: 4 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
      .wire(p('bi', 'out'), p('tap', 'in'))
      .wire(p('tap', 'out'), p('bp', 'in'))
      .build()
    expect(c.bus(p('bp', 'in'))).toBe('5')
  })

  it('BUS_TAP without tapStart starts at bit 0', () => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 8, label: '5A' })
      .add('tap', ComponentType.BUS_TAP, { bits: 4 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
      .wire(p('bi', 'out'), p('tap', 'in'))
      .wire(p('tap', 'out'), p('bp', 'in'))
      .build()
    expect(c.bus(p('bp', 'in'))).toBe('A')
  })

  it('a tap with an unconnected input drives nothing clean (Z/X)', () => {
    const c = new CircuitBuilder()
      .add('tap', ComponentType.BUS_TAP, { bits: 1, tapStart: 0 })
      .add('t4', ComponentType.BUS_TAP, { bits: 4, tapStart: 0 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
      .probe('pb')
      .wire(p('tap', 'out'), p('pb', 'in'))
      .wire(p('t4', 'out'), p('bp', 'in'))
      .build()
    expect(isClean(c.pin(p('pb', 'in')))).toBe(false)
    expect(c.bus(p('bp', 'in'))).toMatch(NON_CLEAN)
  })

  it('tap outputs change exactly one tap delay after the bus changes (bus and 1-bit taps)', () => {
    const b = new CircuitBuilder()
    for (let i = 0; i < 4; i++) b.switch(`s${i}`, ZERO)
    b.add('m', ComponentType.MERGER, { bits: 4, delay: 1 })
      .add('t2', ComponentType.BUS_TAP, { bits: 2, tapStart: 2, delay: 3 })
      .add('t1', ComponentType.BUS_TAP, { bits: 1, tapStart: 3, delay: 6 })
      .add('bm', ComponentType.BUS_PROBE, { bits: 4 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 2 })
      .probe('pb')
    for (let i = 0; i < 4; i++) b.wire(p(`s${i}`, 'out'), p('m', `in${i}`))
    b.wire(p('m', 'out'), p('bm', 'in'))
      .wire(p('m', 'out'), p('t2', 'in'))
      .wire(p('m', 'out'), p('t1', 'in'))
      .wire(p('t2', 'out'), p('bp', 'in'))
      .wire(p('t1', 'out'), p('pb', 'in'))
    const c = b.build()
    c.set('s3', ONE)
    const traces = c.sim.getWaveforms()
    const bus = traces.find((t) => t.probeId === 'bm')!.samples.at(-1)!
    const tap2 = traces.find((t) => t.probeId === 'bp')!.samples.at(-1)!
    const tap1 = traces.find((t) => t.probeId === 'pb')!.samples.at(-1)!
    expect(bus.hex).toBe('8')
    expect(tap2.hex).toBe('2')
    expect(tap1.v).toBe(ONE)
    expect(tap2.t - bus.t).toBe(3)
    expect(tap1.t - bus.t).toBe(6)
  })

  it('tap of a contended bus is X', () => {
    const c = new CircuitBuilder()
      .add('a', ComponentType.BUS_INPUT, { bits: 8, label: '00' })
      .add('b', ComponentType.BUS_INPUT, { bits: 8, label: 'FF' })
      .add('tap', ComponentType.BUS_TAP, { bits: 1, tapStart: 0 })
      .probe('pb')
      .wire(p('a', 'out'), p('tap', 'in'))
      .wire(p('b', 'out'), p('tap', 'in'))
      .wire(p('tap', 'out'), p('pb', 'in'))
      .build()
    expect(c.pin(p('pb', 'in'))).toBe(X)
  })
})

// ===========================================================================
// COMPLEMENTER
// ===========================================================================

describe('COMPLEMENTER: en=1 bitwise complement, en=0 pass-through, en X/Z -> all X', () => {
  const table: [number, string, string][] = [
    [4, '5', 'A'],
    [4, '0', 'F'],
    [4, 'F', '0'],
    [4, '9', '6'],
    [3, '5', '2'],
    [5, '15', '0A'],
    [8, '5A', 'A5'],
    [8, '00', 'FF'],
    [8, 'FF', '00'],
    [16, '1234', 'EDCB'],
    [17, '1AAAA', '05555'],
    [32, 'FFFFFFFF', '00000000'],
    [32, '00000000', 'FFFFFFFF'],
    [32, 'DEADBEEF', '21524110']
  ]

  it.each(table)('%i-bit: en=1 complements %s -> %s', (w, input, expected) => {
    expect(complementerCircuit(w, input, ONE).bus(p('bp', 'in'))).toBe(expected)
  })

  it.each(table)('%i-bit: en=0 passes %s through unchanged', (w, input) => {
    expect(complementerCircuit(w, input, ZERO).bus(p('bp', 'in'))).toBe(input)
  })

  it('toggling en switches between complement and pass-through', () => {
    const c = complementerCircuit(8, '5A', ZERO)
    expect(c.bus(p('bp', 'in'))).toBe('5A')
    c.set('en', ONE)
    expect(c.bus(p('bp', 'in'))).toBe('A5')
    c.set('en', ZERO)
    expect(c.bus(p('bp', 'in'))).toBe('5A')
    c.set('en', ONE)
    expect(c.bus(p('bp', 'in'))).toBe('A5')
  })

  it('complemented bits verified through a splitter (5 -> 1010)', () => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 4, label: '5' })
      .add('cmp', ComponentType.COMPLEMENTER, { bits: 4 })
      .add('spl', ComponentType.SPLITTER, { bits: 4 })
      .add('v', ComponentType.VCC)
      .wire(p('bi', 'out'), p('cmp', 'in'))
      .wire(p('cmp', 'out'), p('spl', 'in'))
      .wire(p('v', 'out'), p('cmp', 'en'))
      .build()
    expect(c.vec('spl', 'out', 4)).toBe('1010')
  })

  it('en unconnected (Z) -> all X', () => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 8, label: '5A' })
      .add('cmp', ComponentType.COMPLEMENTER, { bits: 8 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 8 })
      .wire(p('bi', 'out'), p('cmp', 'in'))
      .wire(p('cmp', 'out'), p('bp', 'in'))
      .build()
    expect(c.pin(p('cmp', 'en'))).toBe(Z)
    expect(c.bus(p('bp', 'in'))).toBe('XX')
  })

  it('en driven Z by a disabled tristate -> all X; enabling the tristate restores the function', () => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 4, label: '5' })
      .add('cmp', ComponentType.COMPLEMENTER, { bits: 4 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
      .add('ts', ComponentType.TRISTATE_RIGHT)
      .switch('d', ONE)
      .switch('ctl', ZERO)
      .wire(p('bi', 'out'), p('cmp', 'in'))
      .wire(p('cmp', 'out'), p('bp', 'in'))
      .wire(p('d', 'out'), p('ts', 'in'))
      .wire(p('ctl', 'out'), p('ts', 'ctl'))
      .wire(p('ts', 'out'), p('cmp', 'en'))
      .build()
    expect(c.pin(p('cmp', 'en'))).toBe(Z)
    expect(c.bus(p('bp', 'in'))).toBe('X')
    c.set('ctl', ONE) // en = 1
    expect(c.bus(p('bp', 'in'))).toBe('A')
    c.set('d', ZERO) // en = 0
    expect(c.bus(p('bp', 'in'))).toBe('5')
    c.set('ctl', ZERO) // en = Z again
    expect(c.bus(p('bp', 'in'))).toBe('X')
  })

  it('en = X (NOT gate with unconnected input) -> all X', () => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 4, label: '5' })
      .add('cmp', ComponentType.COMPLEMENTER, { bits: 4 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
      .add('nx', ComponentType.NOT)
      .wire(p('bi', 'out'), p('cmp', 'in'))
      .wire(p('cmp', 'out'), p('bp', 'in'))
      .wire(p('nx', 'out'), p('cmp', 'en'))
      .build()
    expect(c.pin(p('cmp', 'en'))).toBe(X)
    expect(c.bus(p('bp', 'in'))).toBe('X')
  })

  it('en=1 with an X/Z input bit: that bit is X, clean bits are complemented', () => {
    const b = new CircuitBuilder().switch('s0', ONE).switch('s1', ZERO).switch('s2', ONE).add('v', ComponentType.VCC)
    b.add('m', ComponentType.MERGER, { bits: 4 })
      .add('cmp', ComponentType.COMPLEMENTER, { bits: 4 })
      .add('spl', ComponentType.SPLITTER, { bits: 4 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
    b.wire(p('s0', 'out'), p('m', 'in0'))
      .wire(p('s1', 'out'), p('m', 'in1'))
      .wire(p('s2', 'out'), p('m', 'in2')) // in3 unconnected
      .wire(p('m', 'out'), p('cmp', 'in'))
      .wire(p('v', 'out'), p('cmp', 'en'))
      .wire(p('cmp', 'out'), p('spl', 'in'))
      .wire(p('cmp', 'out'), p('bp', 'in'))
    const c = b.build()
    expect(c.pin(p('spl', 'out0'))).toBe(ZERO)
    expect(c.pin(p('spl', 'out1'))).toBe(ONE)
    expect(c.pin(p('spl', 'out2'))).toBe(ZERO)
    expect(c.pin(p('spl', 'out3'))).toBe(X)
    expect(c.bus(p('bp', 'in'))).toBe('X')
  })

  it('en=1 with an X-driven input bus -> all X', () => {
    expect(complementerCircuit(8, 'GG', ONE).bus(p('bp', 'in'))).toBe('XX')
  })

  it('en=0 with an X-driven input bus -> all X (pass-through of X)', () => {
    expect(complementerCircuit(8, 'GG', ZERO).bus(p('bp', 'in'))).toBe('XX')
  })

  it('unconnected input bus: output is non-clean for en=1 and en=0', () => {
    for (const en of [ONE, ZERO]) {
      const c = new CircuitBuilder()
        .add('cmp', ComponentType.COMPLEMENTER, { bits: 4 })
        .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
        .switch('en', en)
        .wire(p('cmp', 'out'), p('bp', 'in'))
        .wire(p('en', 'out'), p('cmp', 'en'))
        .build()
      expect(c.bus(p('bp', 'in'))).toMatch(NON_CLEAN)
    }
  })

  it('manual recipe: nets -> MERGER -> COMPLEMENTER complements a set of net signals', () => {
    const b = new CircuitBuilder()
    for (let i = 0; i < 4; i++) b.switch(`s${i}`, ZERO)
    b.add('v', ComponentType.VCC)
      .add('m', ComponentType.MERGER, { bits: 4 })
      .add('cmp', ComponentType.COMPLEMENTER, { bits: 4 })
      .add('spl', ComponentType.SPLITTER, { bits: 4 })
    for (let i = 0; i < 4; i++) b.wire(p(`s${i}`, 'out'), p('m', `in${i}`))
    b.wire(p('m', 'out'), p('cmp', 'in')).wire(p('v', 'out'), p('cmp', 'en')).wire(p('cmp', 'out'), p('spl', 'in'))
    const c = b.build()
    for (let n = 0; n < 16; n++) {
      c.setMany(bitsToSwitches('s', binStr(n, 4)))
      expect(c.vec('spl', 'out', 4)).toBe(binStr(15 - n, 4))
    }
  })

  it('en=0 passes clean bits through and leaves an unconnected (Z) input bit non-clean', () => {
    const b = new CircuitBuilder().switch('s0', ONE).switch('s1', ZERO).switch('s2', ONE).add('g', ComponentType.GROUND)
    b.add('m', ComponentType.MERGER, { bits: 4 })
      .add('cmp', ComponentType.COMPLEMENTER, { bits: 4 })
      .add('spl', ComponentType.SPLITTER, { bits: 4 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
    b.wire(p('s0', 'out'), p('m', 'in0'))
      .wire(p('s1', 'out'), p('m', 'in1'))
      .wire(p('s2', 'out'), p('m', 'in2')) // in3 unconnected
      .wire(p('m', 'out'), p('cmp', 'in'))
      .wire(p('g', 'out'), p('cmp', 'en'))
      .wire(p('cmp', 'out'), p('spl', 'in'))
      .wire(p('cmp', 'out'), p('bp', 'in'))
    const c = b.build()
    expect(c.pin(p('spl', 'out0'))).toBe(ONE)
    expect(c.pin(p('spl', 'out1'))).toBe(ZERO)
    expect(c.pin(p('spl', 'out2'))).toBe(ONE)
    expect(isClean(c.pin(p('spl', 'out3')))).toBe(false)
    expect(c.bus(p('bp', 'in'))).toMatch(NON_CLEAN)
  })

  it('COMPLEMENTER without explicit bits is 4 bits wide', () => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { label: '6' })
      .add('cmp', ComponentType.COMPLEMENTER)
      .add('bp', ComponentType.BUS_PROBE)
      .add('v', ComponentType.VCC)
      .wire(p('bi', 'out'), p('cmp', 'in'))
      .wire(p('v', 'out'), p('cmp', 'en'))
      .wire(p('cmp', 'out'), p('bp', 'in'))
      .build()
    expect(c.bus(p('bp', 'in'))).toBe('9')
  })

  // Decision 2 (inertial delay) applied to a bus output. A 2 ns pulse on the input
  // bus of a complementer with delay 5 must never reach the output; the same pulse
  // through a complementer with delay 2 appears as a 2 ns pulse.
  function pulseIntoComplementer(cmpDelay: number): Circuit {
    const b = new CircuitBuilder().switch('s0', ZERO).add('g', ComponentType.GROUND).add('v', ComponentType.VCC)
    b.add('m', ComponentType.MERGER, { bits: 4, delay: 1 })
      .add('cmp', ComponentType.COMPLEMENTER, { bits: 4, delay: cmpDelay })
      .add('bm', ComponentType.BUS_PROBE, { bits: 4 })
      .add('bc', ComponentType.BUS_PROBE, { bits: 4 })
    b.wire(p('s0', 'out'), p('m', 'in0'))
    b.connect(p('g', 'out'), p('m', 'in1'), p('m', 'in2'), p('m', 'in3'))
    b.wire(p('m', 'out'), p('cmp', 'in')).wire(p('m', 'out'), p('bm', 'in'))
    b.wire(p('v', 'out'), p('cmp', 'en')).wire(p('cmp', 'out'), p('bc', 'in'))
    const c = b.build()
    expect(c.bus(p('bc', 'in'))).toBe('F')
    // Rising edge of the pulse: switch out changes at 1, merger out at 2.
    c.sim.toggle('s0', false)
    expect(c.sim.changeStep()).toBe(true)
    expect(c.time).toBe(1)
    expect(c.sim.changeStep()).toBe(true)
    expect(c.time).toBe(2)
    expect(c.bus(p('bm', 'in'))).toBe('1')
    // Falling edge at t=2: switch out back at 3, merger out back at 4 (2 ns pulse).
    c.sim.toggle('s0', false)
    c.sim.drain()
    return c
  }

  it('a 2 ns input pulse shorter than the complementer delay (5) never reaches the output', () => {
    const c = pulseIntoComplementer(5)
    expect(c.bus(p('bm', 'in'))).toBe('0')
    expect(c.bus(p('bc', 'in'))).toBe('F')
    const traces = c.sim.getWaveforms()
    const inSamples = traces.find((t) => t.probeId === 'bm')!.samples
    const outSamples = traces.find((t) => t.probeId === 'bc')!.samples
    expect(inSamples.map((s) => [s.t, s.hex])).toEqual([
      [0, '0'],
      [2, '1'],
      [4, '0']
    ])
    expect(outSamples.map((s) => [s.t, s.hex])).toEqual([[0, 'F']])
  })

  it('a 2 ns input pulse equal to the complementer delay (2) appears as a 2 ns output pulse', () => {
    const c = pulseIntoComplementer(2)
    expect(c.bus(p('bc', 'in'))).toBe('F')
    const outSamples = c.sim.getWaveforms().find((t) => t.probeId === 'bc')!.samples
    expect(outSamples.map((s) => [s.t, s.hex])).toEqual([
      [0, 'F'],
      [4, 'E'],
      [6, 'F']
    ])
  })

  it('output follows input changes after the complementer delay', () => {
    const b = new CircuitBuilder()
    for (let i = 0; i < 4; i++) b.switch(`s${i}`, ZERO)
    b.add('v', ComponentType.VCC)
      .add('m', ComponentType.MERGER, { bits: 4, delay: 1 })
      .add('cmp', ComponentType.COMPLEMENTER, { bits: 4, delay: 5 })
      .add('bm', ComponentType.BUS_PROBE, { bits: 4 })
      .add('bc', ComponentType.BUS_PROBE, { bits: 4 })
    for (let i = 0; i < 4; i++) b.wire(p(`s${i}`, 'out'), p('m', `in${i}`))
    b.wire(p('m', 'out'), p('cmp', 'in'))
      .wire(p('m', 'out'), p('bm', 'in'))
      .wire(p('v', 'out'), p('cmp', 'en'))
      .wire(p('cmp', 'out'), p('bc', 'in'))
    const c = b.build()
    expect(c.bus(p('bc', 'in'))).toBe('F')
    c.set('s0', ONE)
    expect(c.bus(p('bc', 'in'))).toBe('E')
    const traces = c.sim.getWaveforms()
    const inSample = traces.find((t) => t.probeId === 'bm')!.samples.at(-1)!
    const outSample = traces.find((t) => t.probeId === 'bc')!.samples.at(-1)!
    expect(inSample.hex).toBe('1')
    expect(outSample.hex).toBe('E')
    expect(outSample.t - inSample.t).toBe(5)
  })
})

// ===========================================================================
// Bus contention
// ===========================================================================

describe('bus contention', () => {
  it('two BUS_INPUTs with different values on one bus -> X fill', () => {
    const c = new CircuitBuilder()
      .add('a', ComponentType.BUS_INPUT, { bits: 4, label: 'A' })
      .add('b', ComponentType.BUS_INPUT, { bits: 4, label: '5' })
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
      .wire(p('a', 'out'), p('bp', 'in'))
      .wire(p('b', 'out'), p('bp', 'in'))
      .build()
    expect(c.bus(p('bp', 'in'))).toBe('X')
  })

  // Decision 3 (std_logic style): drivers that agree keep their value.
  it('two BUS_INPUTs with identical values agree -> that value (decision 3)', () => {
    const c = new CircuitBuilder()
      .add('a', ComponentType.BUS_INPUT, { bits: 8, label: '5A' })
      .add('b', ComponentType.BUS_INPUT, { bits: 8, label: '5A' })
      .add('bp', ComponentType.BUS_PROBE, { bits: 8 })
      .wire(p('a', 'out'), p('bp', 'in'))
      .wire(p('b', 'out'), p('bp', 'in'))
      .build()
    expect(c.bus(p('bp', 'in'))).toBe('5A')
  })

  it('three BUS_INPUTs: two agree, one differs -> X fill', () => {
    const c = new CircuitBuilder()
      .add('a', ComponentType.BUS_INPUT, { bits: 4, label: '5' })
      .add('b', ComponentType.BUS_INPUT, { bits: 4, label: '5' })
      .add('d', ComponentType.BUS_INPUT, { bits: 4, label: '4' })
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
      .wire(p('a', 'out'), p('bp', 'in'))
      .wire(p('b', 'out'), p('bp', 'in'))
      .wire(p('d', 'out'), p('bp', 'in'))
      .build()
    expect(c.bus(p('bp', 'in'))).toBe('X')
  })

  it('resolution is per bit: disagreeing bits are X, agreeing and released bits keep their value', () => {
    // a = 0011. Merger m drives bit0 = 1 (agrees), bit1 = Z (released), bit2 = 1
    // (disagrees with 0), bit3 = Z. Expected net (bit3..bit0) = 0 X 1 1.
    const c = new CircuitBuilder()
      .add('a', ComponentType.BUS_INPUT, { bits: 4, label: '3' })
      .add('v', ComponentType.VCC)
      .add('m', ComponentType.MERGER, { bits: 4 })
      .add('spl', ComponentType.SPLITTER, { bits: 4 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
      .wire(p('v', 'out'), p('m', 'in0'))
      .wire(p('v', 'out'), p('m', 'in2'))
      .wire(p('a', 'out'), p('spl', 'in'))
      .wire(p('m', 'out'), p('spl', 'in'))
      .wire(p('bp', 'in'), p('spl', 'in'))
      .build()
    expect(c.pin(p('spl', 'out0'))).toBe(ONE)
    expect(c.pin(p('spl', 'out1'))).toBe(ONE)
    expect(c.pin(p('spl', 'out2'))).toBe(X)
    expect(c.pin(p('spl', 'out3'))).toBe(ZERO)
    expect(c.bus(p('bp', 'in'))).toBe('X')
  })

  it('per-bit resolution: a partial driver that only agrees leaves the bus clean', () => {
    // a = 0011; merger drives bit0 = 1 and bit1 = 1, releases bits 2 and 3.
    const c = new CircuitBuilder()
      .add('a', ComponentType.BUS_INPUT, { bits: 4, label: '3' })
      .add('v', ComponentType.VCC)
      .add('m', ComponentType.MERGER, { bits: 4 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
      .wire(p('v', 'out'), p('m', 'in0'))
      .wire(p('v', 'out'), p('m', 'in1'))
      .wire(p('a', 'out'), p('bp', 'in'))
      .wire(p('m', 'out'), p('bp', 'in'))
      .build()
    expect(c.bus(p('bp', 'in'))).toBe('3')
  })

  it('per-bit resolution follows a switch: agree -> value, disagree -> X, release is impossible for a switch', () => {
    // a = 0001; merger bit0 comes from switch s (bits 1..3 released).
    const c = new CircuitBuilder()
      .add('a', ComponentType.BUS_INPUT, { bits: 4, label: '1' })
      .switch('s', ONE)
      .add('m', ComponentType.MERGER, { bits: 4 })
      .add('spl', ComponentType.SPLITTER, { bits: 4 })
      .wire(p('s', 'out'), p('m', 'in0'))
      .wire(p('a', 'out'), p('spl', 'in'))
      .wire(p('m', 'out'), p('spl', 'in'))
      .build()
    expect(c.vec('spl', 'out', 4)).toBe('0001')
    c.set('s', ZERO)
    expect(c.vec('spl', 'out', 4)).toBe('000X')
    c.set('s', ONE)
    expect(c.vec('spl', 'out', 4)).toBe('0001')
  })

  it('contention through label-connected buses -> X fill', () => {
    const c = new CircuitBuilder()
      .add('a', ComponentType.BUS_INPUT, { bits: 4, label: '3' })
      .add('b', ComponentType.BUS_INPUT, { bits: 4, label: 'C' })
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
      .label(p('a', 'out'), 'BUS')
      .label(p('b', 'out'), 'BUS')
      .label(p('bp', 'in'), 'BUS')
      .build()
    expect(c.bus(p('bp', 'in'))).toBe('X')
  })

  it('one active BUS_INPUT + one all-Z driver (merger with unconnected inputs) -> the active value', () => {
    const c = new CircuitBuilder()
      .add('a', ComponentType.BUS_INPUT, { bits: 4, label: 'A' })
      .add('m', ComponentType.MERGER, { bits: 4 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
      .wire(p('a', 'out'), p('bp', 'in'))
      .wire(p('m', 'out'), p('bp', 'in'))
      .build()
    expect(c.bus(p('bp', 'in'))).toBe('A')
  })

  it('one active BUS_INPUT + a pass-through complementer with an unconnected input -> the active value', () => {
    const c = new CircuitBuilder()
      .add('a', ComponentType.BUS_INPUT, { bits: 8, label: '3C' })
      .add('cmp', ComponentType.COMPLEMENTER, { bits: 8 })
      .add('g', ComponentType.GROUND)
      .add('bp', ComponentType.BUS_PROBE, { bits: 8 })
      .wire(p('g', 'out'), p('cmp', 'en'))
      .wire(p('a', 'out'), p('bp', 'in'))
      .wire(p('cmp', 'out'), p('bp', 'in'))
      .build()
    expect(c.bus(p('bp', 'in'))).toBe('3C')
  })

  it('no drivers -> Z fill (probe + splitter input only)', () => {
    const c = new CircuitBuilder()
      .add('bp', ComponentType.BUS_PROBE, { bits: 8 })
      .add('spl', ComponentType.SPLITTER, { bits: 8 })
      .wire(p('bp', 'in'), p('spl', 'in'))
      .build()
    expect(c.bus(p('bp', 'in'))).toBe('ZZ')
    expect(c.bus(p('spl', 'in'))).toBe('ZZ')
  })

  it('two active mergers driving the same value on one bus agree -> that value (decision 3)', () => {
    const b = new CircuitBuilder().add('v', ComponentType.VCC)
    b.add('m1', ComponentType.MERGER, { bits: 2 }).add('m2', ComponentType.MERGER, { bits: 2 })
    b.add('bp', ComponentType.BUS_PROBE, { bits: 2 })
    b.connect(p('v', 'out'), p('m1', 'in0'), p('m1', 'in1'), p('m2', 'in0'), p('m2', 'in1'))
    b.wire(p('m1', 'out'), p('bp', 'in')).wire(p('m2', 'out'), p('bp', 'in'))
    expect(b.build().bus(p('bp', 'in'))).toBe('3')
  })

  it('two active mergers driving different values on one bus -> X fill', () => {
    const b = new CircuitBuilder().add('v', ComponentType.VCC).add('g', ComponentType.GROUND)
    b.add('m1', ComponentType.MERGER, { bits: 2 }).add('m2', ComponentType.MERGER, { bits: 2 })
    b.add('bp', ComponentType.BUS_PROBE, { bits: 2 })
    b.connect(p('v', 'out'), p('m1', 'in0'), p('m1', 'in1'), p('m2', 'in0'))
    b.wire(p('g', 'out'), p('m2', 'in1'))
    b.wire(p('m1', 'out'), p('bp', 'in')).wire(p('m2', 'out'), p('bp', 'in'))
    expect(b.build().bus(p('bp', 'in'))).toBe('X')
  })

  it('contention appears and clears as a switch-driven merger agrees/disagrees with a BUS_INPUT', () => {
    const b = new CircuitBuilder().add('a', ComponentType.BUS_INPUT, { bits: 4, label: 'A' })
    for (let i = 0; i < 4; i++) b.switch(`s${i}`, ZERO)
    b.add('m', ComponentType.MERGER, { bits: 4 }).add('bp', ComponentType.BUS_PROBE, { bits: 4 })
    for (let i = 0; i < 4; i++) b.wire(p(`s${i}`, 'out'), p('m', `in${i}`))
    b.wire(p('a', 'out'), p('bp', 'in')).wire(p('m', 'out'), p('bp', 'in'))
    const c = b.build()
    expect(c.bus(p('bp', 'in'))).toBe('X') // 1010 vs 0000
    c.setMany(bitsToSwitches('s', '1010'))
    expect(c.bus(p('bp', 'in'))).toBe('A') // agreement
    c.set('s0', ONE)
    expect(c.bus(p('bp', 'in'))).toBe('X') // 1010 vs 1011
  })

  it('a splitter on a contended bus outputs X on every bit', () => {
    const c = new CircuitBuilder()
      .add('a', ComponentType.BUS_INPUT, { bits: 4, label: 'A' })
      .add('b', ComponentType.BUS_INPUT, { bits: 4, label: '5' })
      .add('spl', ComponentType.SPLITTER, { bits: 4 })
      .wire(p('a', 'out'), p('spl', 'in'))
      .wire(p('b', 'out'), p('spl', 'in'))
      .build()
    expect(c.vec('spl', 'out', 4)).toBe('XXXX')
  })

  it('an X-driving BUS_INPUT (invalid label) is an active driver: contention with a valid one -> X', () => {
    const c = new CircuitBuilder()
      .add('a', ComponentType.BUS_INPUT, { bits: 4, label: 'A' })
      .add('b', ComponentType.BUS_INPUT, { bits: 4, label: 'G' })
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
      .wire(p('a', 'out'), p('bp', 'in'))
      .wire(p('b', 'out'), p('bp', 'in'))
      .build()
    expect(c.bus(p('bp', 'in'))).toBe('X')
  })
})

// ===========================================================================
// Width mismatch (the manual only allows connecting buses of the same width, so
// this documents behavior rather than a spec requirement).
// ===========================================================================

describe('width mismatch between bus pins (wiring error per manual; decision 3: missing high bits are X)', () => {
  it('4-bit BUS_INPUT F -> 8-bit SPLITTER: low nibble survives, missing upper bits are X', () => {
    const c = busInputToSplitter(4, 'F', 8)
    for (let i = 0; i < 4; i++) expect(c.pin(p('spl', `out${i}`))).toBe(ONE)
    for (let i = 4; i < 8; i++) expect(c.pin(p('spl', `out${i}`))).toBe(X)
  })

  it('4-bit BUS_INPUT F -> 8-bit BUS_PROBE: display is an X fill, never a fabricated clean value', () => {
    expect(busInputToProbe(4, 'F', 8).bus(p('bp', 'in'))).toBe('XX')
  })

  it('a narrow driver on a wide bus does not turn the missing bits Z (they are X, not released)', () => {
    // 4-bit BUS_INPUT 'F' + 8-bit merger whose upper inputs are 1 and lower inputs unconnected:
    // bits 0..3 = F from the input (merger releases them), bits 4..7 = resolve(X, 1) = X.
    const b = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 4, label: 'F' })
      .add('v', ComponentType.VCC)
      .add('m', ComponentType.MERGER, { bits: 8 })
      .add('spl', ComponentType.SPLITTER, { bits: 8 })
    for (let i = 4; i < 8; i++) b.wire(p('v', 'out'), p('m', `in${i}`))
    b.wire(p('bi', 'out'), p('spl', 'in')).wire(p('m', 'out'), p('spl', 'in'))
    const c = b.build()
    for (let i = 0; i < 4; i++) expect(c.pin(p('spl', `out${i}`))).toBe(ONE)
    for (let i = 4; i < 8; i++) expect(c.pin(p('spl', `out${i}`))).toBe(X)
  })

  it('8-bit BUS_INPUT 5A -> 4-bit SPLITTER: outputs are the low nibble (A = 1010)', () => {
    const c = busInputToSplitter(8, '5A', 4)
    expect(c.vec('spl', 'out', 4)).toBe('1010')
  })

  it('8-bit BUS_INPUT 5A -> 4-bit BUS_PROBE: shows the low nibble or the whole net, never garbage', () => {
    // Either reading is defensible: the probe's own 4 bits (A) or the net it sits on (5A).
    expect(busInputToProbe(8, '5A', 4).bus(p('bp', 'in'))).toMatch(/^(5A|A)$/)
  })

  it('4-bit BUS_INPUT 5 -> 8-bit COMPLEMENTER (en=1) -> 8-bit SPLITTER: low nibble complemented, upper bits X', () => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 4, label: '5' })
      .add('cmp', ComponentType.COMPLEMENTER, { bits: 8 })
      .add('spl', ComponentType.SPLITTER, { bits: 8 })
      .add('v', ComponentType.VCC)
      .wire(p('bi', 'out'), p('cmp', 'in'))
      .wire(p('v', 'out'), p('cmp', 'en'))
      .wire(p('cmp', 'out'), p('spl', 'in'))
      .build()
    expect(c.vec('spl', 'out', 4)).toBe('1010')
    for (let i = 4; i < 8; i++) expect(c.pin(p('spl', `out${i}`))).toBe(X)
  })

  it('a 1-bit tap still reads a correct low bit from a width-mismatched bus', () => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 4, label: '5' })
      .add('bp', ComponentType.BUS_PROBE, { bits: 8 })
      .add('tap', ComponentType.BUS_TAP, { bits: 1, tapStart: 0 })
      .probe('pb')
      .wire(p('bi', 'out'), p('bp', 'in'))
      .wire(p('bi', 'out'), p('tap', 'in'))
      .wire(p('tap', 'out'), p('pb', 'in'))
      .build()
    expect(c.pin(p('pb', 'in'))).toBe(ONE)
  })
})

// ===========================================================================
// Composition: SPLITTER -> NOT -> MERGER round trip
// ===========================================================================

describe('SPLITTER -> NOT gates -> MERGER round trip', () => {
  function invertViaGates(width: number, label: string): Circuit {
    const b = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: width, label })
      .add('spl', ComponentType.SPLITTER, { bits: width })
      .add('m', ComponentType.MERGER, { bits: width })
      .add('bp', ComponentType.BUS_PROBE, { bits: width })
      .add('cmp', ComponentType.COMPLEMENTER, { bits: width })
      .add('bc', ComponentType.BUS_PROBE, { bits: width })
      .add('v', ComponentType.VCC)
      .wire(p('bi', 'out'), p('spl', 'in'))
      .wire(p('m', 'out'), p('bp', 'in'))
      .wire(p('bi', 'out'), p('cmp', 'in'))
      .wire(p('v', 'out'), p('cmp', 'en'))
      .wire(p('cmp', 'out'), p('bc', 'in'))
    for (let i = 0; i < width; i++) {
      b.add(`n${i}`, ComponentType.NOT)
        .wire(p('spl', `out${i}`), p(`n${i}`, 'in1'))
        .wire(p(`n${i}`, 'out'), p('m', `in${i}`))
    }
    return b.build()
  }

  it.each(['5A', '00', 'FF', 'A5', '0F', 'F0', '3C', '81'])(
    '8-bit %s: gate-inverted bus equals the bitwise complement and the COMPLEMENTER result',
    (label) => {
      const c = invertViaGates(8, label)
      const expected = hexOf(0xff - parseInt(label, 16), 8)
      expect(c.bus(p('bp', 'in'))).toBe(expected)
      expect(c.bus(p('bc', 'in'))).toBe(expected)
    }
  )

  it.each([2, 3, 5, 16, 32])('%i-bit alternating pattern inverts to its complement', (w) => {
    const v = low(ALT_A, w)
    const c = invertViaGates(w, hexOf(v, w))
    const expected = hexOf(low(ALL_ONES, w) - v, w)
    expect(c.bus(p('bp', 'in'))).toBe(expected)
    expect(c.bus(p('bc', 'in'))).toBe(expected)
  })

  it('identity: SPLITTER -> MERGER passes 5A unchanged', () => {
    const b = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 8, label: '5A' })
      .add('spl', ComponentType.SPLITTER, { bits: 8 })
      .add('m', ComponentType.MERGER, { bits: 8 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 8 })
      .wire(p('bi', 'out'), p('spl', 'in'))
      .wire(p('m', 'out'), p('bp', 'in'))
    for (let i = 0; i < 8; i++) b.wire(p('spl', `out${i}`), p('m', `in${i}`))
    expect(b.build().bus(p('bp', 'in'))).toBe('5A')
  })

  it('switches -> MERGER -> SPLITTER returns the same bits for every 4-bit combo', () => {
    const b = new CircuitBuilder()
    for (let i = 0; i < 4; i++) b.switch(`s${i}`, ZERO)
    b.add('m', ComponentType.MERGER, { bits: 4 }).add('spl', ComponentType.SPLITTER, { bits: 4 })
    for (let i = 0; i < 4; i++) b.wire(p(`s${i}`, 'out'), p('m', `in${i}`))
    b.wire(p('m', 'out'), p('spl', 'in'))
    const c = b.build()
    for (let n = 0; n < 16; n++) {
      c.setMany(bitsToSwitches('s', binStr(n, 4)))
      expect(c.vec('spl', 'out', 4)).toBe(binStr(n, 4))
    }
  })

  it('crossed wiring (out_i -> in_{n-1-i}) reverses the bit order', () => {
    const b = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 8, label: '01' })
      .add('spl', ComponentType.SPLITTER, { bits: 8 })
      .add('m', ComponentType.MERGER, { bits: 8 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 8 })
      .wire(p('bi', 'out'), p('spl', 'in'))
      .wire(p('m', 'out'), p('bp', 'in'))
    for (let i = 0; i < 8; i++) b.wire(p('spl', `out${i}`), p('m', `in${7 - i}`))
    expect(b.build().bus(p('bp', 'in'))).toBe('80')
  })
})

// ===========================================================================
// getPinValues / getBusPinValues partition
// ===========================================================================

describe('getPinValues / getBusPinValues partition', () => {
  function mixedCircuit(): Circuit {
    const b = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 8, label: '5A' })
      .add('spl', ComponentType.SPLITTER, { bits: 8 })
      .add('m', ComponentType.MERGER, { bits: 8 })
      .add('cmp', ComponentType.COMPLEMENTER, { bits: 8 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 8 })
      .add('tap1', ComponentType.BUS_TAP, { bits: 1, tapStart: 3 })
      .add('tap4', ComponentType.BUS_TAP, { bits: 4, tapStart: 4 })
      .add('tp', ComponentType.BUS_PROBE, { bits: 4 })
      .probe('pb')
      .switch('en', ONE)
      .add('lone', ComponentType.BUS_PROBE, { bits: 4 })
      .wire(p('bi', 'out'), p('spl', 'in'))
      .wire(p('bi', 'out'), p('tap1', 'in'))
      .wire(p('bi', 'out'), p('tap4', 'in'))
      .wire(p('tap1', 'out'), p('pb', 'in'))
      .wire(p('tap4', 'out'), p('tp', 'in'))
      .wire(p('m', 'out'), p('cmp', 'in'))
      .wire(p('en', 'out'), p('cmp', 'en'))
      .wire(p('cmp', 'out'), p('bp', 'in'))
    for (let i = 0; i < 8; i++) b.wire(p('spl', `out${i}`), p('m', `in${i}`))
    return b.build()
  }

  function allPinIds(c: Circuit): { pinId: PinId; busDef: boolean }[] {
    const out: { pinId: PinId; busDef: boolean }[] = []
    for (const comp of c.sim.sourceNetlist.components) {
      for (const pin of defOf(comp).pins) {
        out.push({ pinId: makePinId(comp.id, pin.name), busDef: (pin.width ?? 1) > 1 })
      }
    }
    return out
  }

  it('the two maps are disjoint and together cover every pin exactly once', () => {
    const c = mixedCircuit()
    const single = c.sim.getPinValues()
    const bus = c.sim.getBusPinValues()
    const pins = allPinIds(c)
    expect(pins.length).toBeGreaterThan(20)
    for (const { pinId } of pins) {
      const inSingle = pinId in single
      const inBus = pinId in bus
      expect(inSingle !== inBus, `${pinId} must be in exactly one map`).toBe(true)
    }
    expect(Object.keys(single).length + Object.keys(bus).length).toBe(pins.length)
  })

  it('every pin whose definition has width > 1 is in getBusPinValues and never in getPinValues', () => {
    const c = mixedCircuit()
    const single = c.sim.getPinValues()
    const bus = c.sim.getBusPinValues()
    const busPins = allPinIds(c).filter((x) => x.busDef)
    expect(busPins.length).toBeGreaterThan(5)
    for (const { pinId } of busPins) {
      expect(pinId in bus, `${pinId} should be a bus pin`).toBe(true)
      expect(pinId in single, `${pinId} must not be in getPinValues`).toBe(false)
    }
  })

  it('bus values are hex strings, single values are LogicValues', () => {
    const c = mixedCircuit()
    for (const v of Object.values(c.sim.getBusPinValues())) expect(v).toMatch(/^[0-9A-FXZ]+$/)
    for (const v of Object.values(c.sim.getPinValues())) expect([ZERO, ONE, X, Z]).toContain(v)
  })

  it('BUS_TAP in pin attached to a bus is a bus pin; a 1-bit tap out pin is single-bit; a 4-bit tap out is a bus pin', () => {
    const c = mixedCircuit()
    const single = c.sim.getPinValues()
    const bus = c.sim.getBusPinValues()
    expect(bus[p('tap1', 'in')]).toBe('5A')
    expect(bus[p('tap4', 'in')]).toBe('5A')
    expect(p('tap1', 'in') in single).toBe(false)
    expect(single[p('tap1', 'out')]).toBe(ONE) // bit 3 of 5A
    expect(p('tap1', 'out') in bus).toBe(false)
    expect(bus[p('tap4', 'out')]).toBe('5')
    expect(p('tap4', 'out') in single).toBe(false)
  })

  it('COMPLEMENTER en pin is single-bit while in/out are bus pins', () => {
    const c = mixedCircuit()
    const single = c.sim.getPinValues()
    const bus = c.sim.getBusPinValues()
    expect(single[p('cmp', 'en')]).toBe(ONE)
    expect(bus[p('cmp', 'in')]).toBe('5A')
    expect(bus[p('cmp', 'out')]).toBe('A5')
    expect(p('cmp', 'in') in single).toBe(false)
    expect(p('cmp', 'out') in single).toBe(false)
  })

  it('an unconnected bus pin still appears in getBusPinValues with a Z fill', () => {
    const c = mixedCircuit()
    expect(c.sim.getBusPinValues()[p('lone', 'in')]).toBe('Z')
    expect(p('lone', 'in') in c.sim.getPinValues()).toBe(false)
  })

  it('Circuit.pin throws on a bus pin and Circuit.bus throws on a single-bit pin', () => {
    const c = mixedCircuit()
    expect(() => c.pin(p('bi', 'out'))).toThrow()
    expect(() => c.bus(p('spl', 'out0'))).toThrow()
    expect(() => c.bus(p('cmp', 'en'))).toThrow()
  })

  it('hasXZ() reflects bus contents: false when every bus is clean, true with an X bus', () => {
    const clean = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 8, label: '5A' })
      .add('bp', ComponentType.BUS_PROBE, { bits: 8 })
      .wire(p('bi', 'out'), p('bp', 'in'))
      .build()
    expect(clean.sim.hasXZ()).toBe(false)
    expect(busInputToProbe(8, 'GG').sim.hasXZ()).toBe(true)
    const lone = new CircuitBuilder().add('bp', ComponentType.BUS_PROBE, { bits: 8 }).build()
    expect(lone.sim.hasXZ()).toBe(true)
  })
})

// ===========================================================================
// Bus probe sampling (decision 12: one resolution per instant, no sample when
// the resolved value is unchanged) and Z-fill through the simulator.
// ===========================================================================

describe('BUS_PROBE sampling per decision 12 and Z fill through the simulator', () => {
  it('toggling two merger inputs in the same instant records exactly one sample with the combined hex', () => {
    const c = switchesToMerger(4)
    const before = c.sim.getWaveforms()[0].samples.length
    c.setMany({ s0: ONE, s2: ONE }) // 0101
    const tr = c.sim.getWaveforms()[0]
    expect(tr.samples.length).toBe(before + 1)
    expect(tr.samples.at(-1)!.hex).toBe('5')
    expect(tr.samples.at(-1)!.t).toBe(2) // switch out at 1, merger out at 2
    expect(c.bus(p('bp', 'in'))).toBe('5')
  })

  it('a driver change that leaves every resolved bit unchanged records no new sample', () => {
    // a = 0001. Merger bit0 = AND(s, X): 0 while s=0 (contends with 1 -> X), X when s=1
    // (X driver -> X). Bits 1..3 are grounded and agree with a. The resolved vector is
    // [X,0,0,0] before and after, so the bus probe must not record a sample; the merger's
    // own drive did change, so a single-bit probe on the AND output does record one.
    const c = new CircuitBuilder()
      .add('a', ComponentType.BUS_INPUT, { bits: 4, label: '1' })
      .add('g', ComponentType.GROUND)
      .add('nx', ComponentType.NOT)
      .switch('s', ZERO)
      .add('and', ComponentType.AND2)
      .add('m', ComponentType.MERGER, { bits: 4 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
      .add('spl', ComponentType.SPLITTER, { bits: 4 })
      .probe('pa')
      .wire(p('s', 'out'), p('and', 'in1'))
      .wire(p('nx', 'out'), p('and', 'in2'))
      .wire(p('and', 'out'), p('m', 'in0'))
      .wire(p('and', 'out'), p('pa', 'in'))
      .connect(p('g', 'out'), p('m', 'in1'), p('m', 'in2'), p('m', 'in3'))
      .wire(p('a', 'out'), p('bp', 'in'))
      .wire(p('m', 'out'), p('bp', 'in'))
      .wire(p('m', 'out'), p('spl', 'in'))
      .build()
    expect(c.pin(p('and', 'out'))).toBe(ZERO)
    expect(c.vec('spl', 'out', 4)).toBe('000X')
    const busBefore = c.sim.getWaveforms().find((t) => t.probeId === 'bp')!.samples.length
    const bitBefore = c.sim.getWaveforms().find((t) => t.probeId === 'pa')!.samples.length
    c.set('s', ONE)
    expect(c.pin(p('and', 'out'))).toBe(X)
    expect(c.vec('spl', 'out', 4)).toBe('000X')
    expect(c.sim.getWaveforms().find((t) => t.probeId === 'pa')!.samples.length).toBe(bitBefore + 1)
    expect(c.sim.getWaveforms().find((t) => t.probeId === 'bp')!.samples.length).toBe(busBefore)
  })

  it('a change of contended bits that keeps the hex display "X" still records a sample (resolved vector changed)', () => {
    // a = 1010 vs merger 0000 -> [0,X,0,X]; s1 = 1 -> [0,1,0,X]: still an X fill, but a real change.
    const b = new CircuitBuilder().add('a', ComponentType.BUS_INPUT, { bits: 4, label: 'A' })
    for (let i = 0; i < 4; i++) b.switch(`s${i}`, ZERO)
    b.add('m', ComponentType.MERGER, { bits: 4 }).add('bp', ComponentType.BUS_PROBE, { bits: 4 })
    for (let i = 0; i < 4; i++) b.wire(p(`s${i}`, 'out'), p('m', `in${i}`))
    b.wire(p('a', 'out'), p('bp', 'in')).wire(p('m', 'out'), p('bp', 'in'))
    const c = b.build()
    expect(c.bus(p('bp', 'in'))).toBe('X')
    const before = c.sim.getWaveforms()[0].samples.length
    c.set('s1', ONE)
    expect(c.bus(p('bp', 'in'))).toBe('X')
    expect(c.sim.getWaveforms()[0].samples.length).toBe(before + 1)
    c.set('s3', ONE) // agreement: 1010
    expect(c.bus(p('bp', 'in'))).toBe('A')
    expect(c.sim.getWaveforms()[0].samples.length).toBe(before + 2)
    expect(c.sim.getWaveforms()[0].samples.at(-1)!.hex).toBe('A')
  })

  it('a bus released to all Z (tristates -> merger) shows a Z fill and the trace records "Z"', () => {
    // Four tristates share one ctl; their outputs feed a 4-bit merger -> probe.
    const b = new CircuitBuilder().switch('ctl', ONE).add('v', ComponentType.VCC).add('g', ComponentType.GROUND)
    b.add('m', ComponentType.MERGER, { bits: 4 }).add('bp', ComponentType.BUS_PROBE, { bits: 4 })
    for (let i = 0; i < 4; i++) {
      b.add(`ts${i}`, ComponentType.TRISTATE_RIGHT)
        .wire(p(i % 2 ? 'v' : 'g', 'out'), p(`ts${i}`, 'in')) // 1010 -> A
        .wire(p('ctl', 'out'), p(`ts${i}`, 'ctl'))
        .wire(p(`ts${i}`, 'out'), p('m', `in${i}`))
    }
    b.wire(p('m', 'out'), p('bp', 'in'))
    const c = b.build()
    expect(c.bus(p('bp', 'in'))).toBe('A')
    c.set('ctl', ZERO)
    expect(c.bus(p('bp', 'in'))).toBe('Z')
    expect(c.sim.getWaveforms()[0].samples.map((s) => s.hex)).toEqual(['A', 'Z'])
    c.set('ctl', ONE)
    expect(c.bus(p('bp', 'in'))).toBe('A')
    expect(c.sim.getWaveforms()[0].samples.map((s) => s.hex)).toEqual(['A', 'Z', 'A'])
  })

  it('an all-Z bus (merger with unconnected inputs) is a Z fill, not an X fill, on probe and splitter', () => {
    const c = new CircuitBuilder()
      .add('m', ComponentType.MERGER, { bits: 8 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 8 })
      .add('spl', ComponentType.SPLITTER, { bits: 8 })
      .wire(p('m', 'out'), p('bp', 'in'))
      .wire(p('m', 'out'), p('spl', 'in'))
      .build()
    expect(c.bus(p('bp', 'in'))).toBe('ZZ')
    expect(c.vec('spl', 'out', 8)).toBe('ZZZZZZZZ')
  })
})

// ===========================================================================
// BUS_TAP: more range handling and Z-driving taps in resolution
// ===========================================================================

describe('BUS_TAP range and resolution extras', () => {
  it('a tap wider than its bus (8-bit tap from 0 on a 4-bit bus) gives the low nibble and X above', () => {
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 4, label: '9' })
      .add('tap', ComponentType.BUS_TAP, { bits: 8, tapStart: 0 })
      .add('spl', ComponentType.SPLITTER, { bits: 8 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 8 })
      .wire(p('bi', 'out'), p('tap', 'in'))
      .wire(p('tap', 'out'), p('spl', 'in'))
      .wire(p('tap', 'out'), p('bp', 'in'))
      .build()
    expect(c.vec('spl', 'out', 4)).toBe('1001')
    for (let i = 4; i < 8; i++) expect(c.pin(p('spl', `out${i}`))).toBe(X)
    expect(c.bus(p('bp', 'in'))).toBe('XX')
  })

  it('a tap starting exactly at the bus width is entirely X', () => {
    expect(tapCircuit(4, 8).bus(p('bp', 'in'))).toBe('X')
    expect(tapCircuit(2, 8).bus(p('bp', 'in'))).toBe('X')
  })

  it('a tap whose slice ends exactly at the top bit is clean ("7:4" of 5A -> 5, "7:7" -> 0)', () => {
    expect(tapCircuit(4, 4).bus(p('bp', 'in'))).toBe('5')
    expect(tapCircuit(1, 7).pin(p('pb', 'in'))).toBe(ZERO)
    expect(tapCircuit(1, 6).pin(p('pb', 'in'))).toBe(ONE)
  })

  // An unconnected input terminal is Z (manual §1.9); SPLITTER and COMPLEMENTER pass an
  // unconnected bus through as all Z, so a tap must too (every bit, not just bit 0).
  it('a multi-bit tap with an unconnected input drives every bit Z (splits to ZZZZ)', () => {
    const c = new CircuitBuilder()
      .add('tap', ComponentType.BUS_TAP, { bits: 4, tapStart: 0 })
      .add('spl', ComponentType.SPLITTER, { bits: 4 })
      .wire(p('tap', 'out'), p('spl', 'in'))
      .build()
    expect(c.vec('spl', 'out', 4)).toBe('ZZZZ')
  })

  it('a multi-bit tap with an unconnected input drives all Z: an active BUS_INPUT on the same bus wins', () => {
    const c = new CircuitBuilder()
      .add('tap', ComponentType.BUS_TAP, { bits: 4, tapStart: 0 })
      .add('a', ComponentType.BUS_INPUT, { bits: 4, label: '6' })
      .add('bp', ComponentType.BUS_PROBE, { bits: 4 })
      .wire(p('tap', 'out'), p('bp', 'in'))
      .wire(p('a', 'out'), p('bp', 'in'))
      .build()
    expect(c.bus(p('bp', 'in'))).toBe('6')
  })

  it('a 1-bit tap with an unconnected input drives Z: a switch on the same net wins', () => {
    const c = new CircuitBuilder()
      .add('tap', ComponentType.BUS_TAP, { bits: 1, tapStart: 0 })
      .switch('s', ONE)
      .probe('pb')
      .wire(p('tap', 'out'), p('pb', 'in'))
      .wire(p('s', 'out'), p('pb', 'in'))
      .build()
    expect(c.pin(p('pb', 'in'))).toBe(ONE)
    c.set('s', ZERO)
    expect(c.pin(p('pb', 'in'))).toBe(ZERO)
  })

  it('1-bit taps of every bit re-merged reproduce the bus (tap i -> merger in i)', () => {
    const b = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 8, label: 'C3' })
      .add('m', ComponentType.MERGER, { bits: 8 })
      .add('bp', ComponentType.BUS_PROBE, { bits: 8 })
      .wire(p('m', 'out'), p('bp', 'in'))
    for (let i = 0; i < 8; i++) {
      b.add(`t${i}`, ComponentType.BUS_TAP, { bits: 1, tapStart: i })
        .wire(p('bi', 'out'), p(`t${i}`, 'in'))
        .wire(p(`t${i}`, 'out'), p('m', `in${i}`))
    }
    expect(b.build().bus(p('bp', 'in'))).toBe('C3')
  })

  it('a tap of a tap slices relative to the inner tap (bits "6:3" of 5A, then "2:1" of that -> 01 = 1)', () => {
    // 5A = 0101 1010; bits 6..3 = 1011 (LSB-first [1,1,0,1]); bits 2..1 of that = 01 -> 1.
    const c = new CircuitBuilder()
      .add('bi', ComponentType.BUS_INPUT, { bits: 8, label: '5A' })
      .add('t1', ComponentType.BUS_TAP, { bits: 4, tapStart: 3 })
      .add('t2', ComponentType.BUS_TAP, { bits: 2, tapStart: 1 })
      .add('b1', ComponentType.BUS_PROBE, { bits: 4 })
      .add('b2', ComponentType.BUS_PROBE, { bits: 2 })
      .wire(p('bi', 'out'), p('t1', 'in'))
      .wire(p('t1', 'out'), p('b1', 'in'))
      .wire(p('t1', 'out'), p('t2', 'in'))
      .wire(p('t2', 'out'), p('b2', 'in'))
      .build()
    expect(c.bus(p('b1', 'in'))).toBe('B')
    expect(c.bus(p('b2', 'in'))).toBe('1')
  })
})

// ===========================================================================
// SPLITTER / MERGER extras: X and Z on each input in turn
// ===========================================================================

describe('MERGER: X and Z on each input bit in turn', () => {
  it.each(range(0, 3))('4-bit merger with only in%i unconnected (Z): that split bit is Z, others clean', (i) => {
    const b = new CircuitBuilder().add('v', ComponentType.VCC)
    b.add('m', ComponentType.MERGER, { bits: 4 }).add('spl', ComponentType.SPLITTER, { bits: 4 })
    for (let k = 0; k < 4; k++) if (k !== i) b.wire(p('v', 'out'), p('m', `in${k}`))
    b.wire(p('m', 'out'), p('spl', 'in'))
    const c = b.build()
    for (let k = 0; k < 4; k++) expect(c.pin(p('spl', `out${k}`))).toBe(k === i ? Z : ONE)
    expect(vecToHex(range(0, 3).map((k) => c.pin(p('spl', `out${k}`))))).toBe('X')
  })

  it.each(range(0, 3))('4-bit merger with only in%i driven X: that split bit is X, others clean', (i) => {
    const b = new CircuitBuilder().add('v', ComponentType.VCC).add('nx', ComponentType.NOT)
    b.add('m', ComponentType.MERGER, { bits: 4 }).add('spl', ComponentType.SPLITTER, { bits: 4 })
    for (let k = 0; k < 4; k++) b.wire(p(k === i ? 'nx' : 'v', 'out'), p('m', `in${k}`))
    b.wire(p('m', 'out'), p('spl', 'in'))
    const c = b.build()
    for (let k = 0; k < 4; k++) expect(c.pin(p('spl', `out${k}`))).toBe(k === i ? X : ONE)
  })

  it('a merger input bit driven Z by a disabled tristate resolves the bus bit to Z (released), not X', () => {
    const c = new CircuitBuilder()
      .add('v', ComponentType.VCC)
      .switch('ctl', ZERO)
      .add('ts', ComponentType.TRISTATE_RIGHT)
      .add('m', ComponentType.MERGER, { bits: 2 })
      .add('spl', ComponentType.SPLITTER, { bits: 2 })
      .wire(p('v', 'out'), p('ts', 'in'))
      .wire(p('ctl', 'out'), p('ts', 'ctl'))
      .wire(p('ts', 'out'), p('m', 'in1'))
      .wire(p('v', 'out'), p('m', 'in0'))
      .wire(p('m', 'out'), p('spl', 'in'))
      .build()
    expect(c.pin(p('spl', 'out0'))).toBe(ONE)
    expect(c.pin(p('spl', 'out1'))).toBe(Z)
    c.set('ctl', ONE)
    expect(c.pin(p('spl', 'out1'))).toBe(ONE)
  })
})
