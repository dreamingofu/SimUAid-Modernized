// Unit verification of the fixed-width parts against the SimUaid manual (Appendix A,
// §1.9): FULL_ADDER, DECODER_2TO4/3TO8, MUX_2/4/8, the four single-bit tristates,
// VCC, GROUND, SWITCH, PROBE and SEVEN_SEGMENT. Every assertion states the
// spec-correct value; a failing case is evidence of an engine bug.

import { describe, expect, it } from 'vitest'
import { ComponentType, LogicValue, type PinId } from '../../model/types'
import { getPartDefinition } from '../../model/partDefinitions'
import { buildSimGraph } from '../graph'
import { clean } from '../values'
import { CircuitBuilder, Circuit, allCombos, p } from './harness'

const { ZERO, ONE, X, Z } = LogicValue

// ---------------------------------------------------------------------------
// Local helpers (the harness has no way to inject X or a driven Z, so we build
// them from parts whose behavior the manual pins down: a NOT gate with an
// unconnected input outputs X (§1.9), and a tristate with ctl=0 outputs Z).
// ---------------------------------------------------------------------------

/** How a test feeds a pin: a switch position, an X source, a driven Z, or nothing at all. */
type Feed = LogicValue | 'open'

const BAD_FEEDS: Feed[] = [X, Z, 'open']

function feedName(f: Feed): string {
  if (f === 'open') return 'unconnected'
  if (f === Z) return 'driven Z'
  if (f === X) return 'X'
  return `switch ${f}`
}

const NAMED_BAD_FEEDS: [string, Feed][] = BAD_FEEDS.map((f) => [feedName(f), f])

/**
 * Connects `target` to a source of `value`. 0/1 use a switch named `id` (so a test
 * can flip it later); X comes from a NOT gate with an unconnected input; Z comes
 * from a disabled tristate (ctl tied to Ground); 'open' leaves the pin alone.
 */
function feed(b: CircuitBuilder, id: string, target: PinId, value: Feed): void {
  if (value === 'open') return
  if (value === ZERO || value === ONE) {
    b.switch(id, value).wire(p(id, 'out'), target)
  } else if (value === X) {
    b.add(id, ComponentType.NOT).wire(p(id, 'out'), target)
  } else {
    b.add(id, ComponentType.TRISTATE_RIGHT)
      .add(`${id}_gnd`, ComponentType.GROUND)
      .wire(p(`${id}_gnd`, 'out'), p(id, 'ctl'))
      .wire(p(id, 'out'), target)
  }
}

/** One part `u` of `type` with each named pin fed as requested; switches are named `s_<pin>`. */
function partWith(
  type: ComponentType,
  feeds: Record<string, Feed>,
  opts: { delay?: number } = {}
): Circuit {
  const b = new CircuitBuilder().add('u', type, opts)
  for (const [pin, f] of Object.entries(feeds)) feed(b, `s_${pin}`, p('u', pin), f)
  return b.build()
}

/** The switch-value map (`s_<pin>` -> value) for the clean entries of a feed map. */
function switchesOf(feeds: Record<string, Feed>): Record<string, LogicValue> {
  const out: Record<string, LogicValue> = {}
  for (const [pin, f] of Object.entries(feeds)) {
    if (f === ZERO || f === ONE) out[`s_${pin}`] = f
  }
  return out
}

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i)
const bit = (v: LogicValue): number => (v === ONE ? 1 : 0)
const lv = (n: number): LogicValue => (n ? ONE : ZERO)
const not = (v: LogicValue): LogicValue => (v === ONE ? ZERO : ONE)

/** Select-pin feeds for a decoded index; selects[0] (A) is the MSB per Appendix A. */
function selectFeeds(selects: string[], index: number): Record<string, Feed> {
  const n = selects.length
  const out: Record<string, Feed> = {}
  selects.forEach((name, k) => {
    out[name] = lv((index >> (n - 1 - k)) & 1)
  })
  return out
}

function trace(c: Circuit, probeId: string): { t: number; v: LogicValue }[] {
  const w = c.sim.getWaveforms().find((t) => t.probeId === probeId)
  if (!w) throw new Error(`no waveform for ${probeId}`)
  return w.samples.map(({ t, v }) => ({ t, v }))
}

// ---------------------------------------------------------------------------
// values.ts: the one pure helper these parts rely on
// ---------------------------------------------------------------------------

describe('values.clean', () => {
  it('accepts 0 and 1', () => {
    expect(clean(ZERO)).toBe(true)
    expect(clean(ONE)).toBe(true)
  })
  it('rejects X and Z', () => {
    expect(clean(X)).toBe(false)
    expect(clean(Z)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// FULL_ADDER — Sum = X xor Y xor Cin, Cout = majority(X, Y, Cin)
// ---------------------------------------------------------------------------

describe('FULL_ADDER', () => {
  const FA = ComponentType.FULL_ADDER

  it.each(allCombos(3))('X=%s Y=%s Cin=%s gives the arithmetic sum and carry', (x, y, cin) => {
    const c = partWith(FA, { X: x, Y: y, Cin: cin })
    const total = bit(x) + bit(y) + bit(cin)
    expect(c.pin(p('u', 'Sum'))).toBe(lv(total % 2))
    expect(c.pin(p('u', 'Cout'))).toBe(lv(total >= 2 ? 1 : 0))
  })

  it('tracks live switch changes through all 8 combinations in sequence', () => {
    const c = partWith(FA, { X: ZERO, Y: ZERO, Cin: ZERO })
    for (const [x, y, cin] of allCombos(3)) {
      c.setMany({ s_X: x, s_Y: y, s_Cin: cin })
      const total = bit(x) + bit(y) + bit(cin)
      expect(c.pin(p('u', 'Sum')), `Sum for ${x}${y}${cin}`).toBe(lv(total % 2))
      expect(c.pin(p('u', 'Cout')), `Cout for ${x}${y}${cin}`).toBe(lv(total >= 2 ? 1 : 0))
    }
    expect(c.oscillated).toBe(false)
  })

  describe.each(['X', 'Y', 'Cin'])('with %s undetermined', (badPin) => {
    const others = ['X', 'Y', 'Cin'].filter((n) => n !== badPin)
    const cases: [string, Feed, LogicValue, LogicValue][] = []
    for (const [name, f] of NAMED_BAD_FEEDS) {
      for (const [a, b] of allCombos(2)) cases.push([name, f, a, b])
    }
    it.each(cases)(
      `%s on ${badPin} with ${others[0]}=%s ${others[1]}=%s -> Sum X and Cout X`,
      (_name, f, a, b) => {
        const c = partWith(FA, { [badPin]: f, [others[0]]: a, [others[1]]: b })
        expect(c.pin(p('u', 'Sum'))).toBe(X)
        expect(c.pin(p('u', 'Cout'))).toBe(X)
      }
    )
  })

  it('outputs X on both pins when every input is unconnected', () => {
    const c = partWith(FA, {})
    expect(c.pin(p('u', 'X'))).toBe(Z)
    expect(c.pin(p('u', 'Sum'))).toBe(X)
    expect(c.pin(p('u', 'Cout'))).toBe(X)
  })

  it('recovers clean outputs once an undetermined input is replaced by a driven one', () => {
    // Cin comes from a tristate we can enable: disabled -> Z -> outputs X; enabled -> clean.
    const c = new CircuitBuilder()
      .add('u', FA)
      .switch('x', ONE)
      .switch('y', ONE)
      .switch('cin', ONE)
      .switch('en', ZERO)
      .add('ts', ComponentType.TRISTATE_RIGHT)
      .wire(p('x', 'out'), p('u', 'X'))
      .wire(p('y', 'out'), p('u', 'Y'))
      .wire(p('cin', 'out'), p('ts', 'in'))
      .wire(p('en', 'out'), p('ts', 'ctl'))
      .wire(p('ts', 'out'), p('u', 'Cin'))
      .build()
    expect(c.pin(p('u', 'Sum'))).toBe(X)
    expect(c.pin(p('u', 'Cout'))).toBe(X)
    c.set('en', ONE)
    expect(c.pin(p('u', 'Sum'))).toBe(ONE)
    expect(c.pin(p('u', 'Cout'))).toBe(ONE)
    c.set('en', ZERO)
    expect(c.pin(p('u', 'Sum'))).toBe(X)
    expect(c.pin(p('u', 'Cout'))).toBe(X)
  })
})

// ---------------------------------------------------------------------------
// DECODER_2TO4 / DECODER_3TO8 — A is the MSB; exactly one output high
// ---------------------------------------------------------------------------

describe.each([
  { type: ComponentType.DECODER_2TO4, selects: ['A', 'B'] },
  { type: ComponentType.DECODER_3TO8, selects: ['A', 'B', 'C'] }
])('$type', ({ type, selects }) => {
  const outputs = 1 << selects.length

  it.each(range(outputs))('select value %i drives only out%i high', (index) => {
    const c = partWith(type, selectFeeds(selects, index))
    for (const i of range(outputs)) {
      expect(c.pin(p('u', `out${i}`)), `out${i}`).toBe(lv(i === index ? 1 : 0))
    }
  })

  it('walks every select value live with switches, always exactly one output high', () => {
    const c = partWith(type, selectFeeds(selects, 0))
    for (const index of range(outputs)) {
      c.setMany(switchesOf(selectFeeds(selects, index)))
      const vec = range(outputs).map((i) => c.pin(p('u', `out${i}`)))
      expect(vec.filter((v) => v === ONE).length, `one-hot for ${index}`).toBe(1)
      expect(vec[index], `out${index} for ${index}`).toBe(ONE)
      expect(vec.every((v) => v === ZERO || v === ONE)).toBe(true)
    }
    expect(c.oscillated).toBe(false)
  })

  it('treats A as the most significant select (AB=10 -> out2, not out1)', () => {
    if (selects.length === 2) {
      const c = partWith(type, { A: ONE, B: ZERO })
      expect(c.pin(p('u', 'out2'))).toBe(ONE)
      expect(c.pin(p('u', 'out1'))).toBe(ZERO)
    } else {
      const c = partWith(type, { A: ONE, B: ZERO, C: ZERO })
      expect(c.pin(p('u', 'out4'))).toBe(ONE)
      expect(c.pin(p('u', 'out1'))).toBe(ZERO)
    }
  })

  describe.each(selects)('with select %s undetermined', (badSel) => {
    const others = selects.filter((s) => s !== badSel)
    const cases: [string, Feed, number][] = []
    for (const [name, f] of NAMED_BAD_FEEDS) {
      for (const otherIdx of range(1 << others.length)) cases.push([name, f, otherIdx])
    }
    it.each(cases)(`%s on ${badSel} (others = %i) -> every output X`, (_name, f, otherIdx) => {
      const feeds: Record<string, Feed> = { ...selectFeeds(others, otherIdx), [badSel]: f }
      const c = partWith(type, feeds)
      for (const i of range(outputs)) expect(c.pin(p('u', `out${i}`)), `out${i}`).toBe(X)
    })
  })

  it('outputs X everywhere when no select is connected', () => {
    const c = partWith(type, {})
    for (const i of range(outputs)) expect(c.pin(p('u', `out${i}`))).toBe(X)
  })
})

// ---------------------------------------------------------------------------
// MUX_2 / MUX_4 / MUX_8 — A is the MSB select; only the selected input matters
// ---------------------------------------------------------------------------

describe.each([
  { type: ComponentType.MUX_2, selects: ['A'] },
  { type: ComponentType.MUX_4, selects: ['A', 'B'] },
  { type: ComponentType.MUX_8, selects: ['A', 'B', 'C'] }
])('$type', ({ type, selects }) => {
  const inputs = 1 << selects.length

  /** Feeds with in<idx> = v and every other input = !v, so a wrong select is visible. */
  function inputFeeds(idx: number, v: LogicValue): Record<string, Feed> {
    const out: Record<string, Feed> = {}
    for (const i of range(inputs)) out[`in${i}`] = i === idx ? v : not(v)
    return out
  }

  const selectCases: [number, LogicValue][] = []
  for (const idx of range(inputs)) for (const v of [ZERO, ONE]) selectCases.push([idx, v])

  it.each(selectCases)('select %i routes in%i=%s to Z', (idx, v) => {
    const c = partWith(type, { ...selectFeeds(selects, idx), ...inputFeeds(idx, v) })
    expect(c.pin(p('u', 'Z'))).toBe(v)
  })

  it('walks all select values live; Z follows the selected input only', () => {
    const c = partWith(type, { ...selectFeeds(selects, 0), ...inputFeeds(0, ONE) })
    for (const idx of range(inputs)) {
      for (const v of [ZERO, ONE]) {
        c.setMany({ ...switchesOf(selectFeeds(selects, idx)), ...switchesOf(inputFeeds(idx, v)) })
        expect(c.pin(p('u', 'Z')), `select ${idx}, in${idx}=${v}`).toBe(v)
      }
    }
    expect(c.oscillated).toBe(false)
  })

  it('changing an unselected input does not change Z', () => {
    const c = partWith(type, { ...selectFeeds(selects, 0), ...inputFeeds(0, ONE) })
    expect(c.pin(p('u', 'Z'))).toBe(ONE)
    const other = inputs - 1
    c.set(`s_in${other}`, ONE)
    expect(c.pin(p('u', 'Z'))).toBe(ONE)
    c.set(`s_in${other}`, ZERO)
    expect(c.pin(p('u', 'Z'))).toBe(ONE)
  })

  if (selects.length > 1) {
    it('treats A as the most significant select', () => {
      // A=1, all others 0 -> index inputs/2
      const idx = inputs >> 1
      const c = partWith(type, { ...selectFeeds(selects, idx), ...inputFeeds(idx, ONE) })
      expect(c.pin(p('u', 'Z'))).toBe(ONE)
      expect(c.pin(p('u', 'A'))).toBe(ONE)
      // and with the mirror-image select (B..=1, A=0) the output must be the other input
      const mirror = idx >> (selects.length - 1) // == 1 here: select value 1
      const c2 = partWith(type, { ...selectFeeds(selects, mirror), ...inputFeeds(idx, ONE) })
      expect(c2.pin(p('u', 'Z'))).toBe(ZERO)
    })
  }

  const badSelectedCases: [string, Feed, number][] = []
  for (const [name, f] of NAMED_BAD_FEEDS) for (const idx of range(inputs)) badSelectedCases.push([name, f, idx])

  it.each(badSelectedCases)('%s on the selected input in%i -> Z is X', (_name, f, idx) => {
    const feeds: Record<string, Feed> = { ...selectFeeds(selects, idx), ...inputFeeds(idx, ONE), [`in${idx}`]: f }
    const c = partWith(type, feeds)
    expect(c.pin(p('u', 'Z'))).toBe(X)
  })

  const badUnselectedCases: [string, Feed, number, LogicValue][] = []
  for (const [name, f] of NAMED_BAD_FEEDS) {
    for (const idx of range(inputs)) for (const v of [ZERO, ONE]) badUnselectedCases.push([name, f, idx, v])
  }

  it.each(badUnselectedCases)(
    '%s on an unselected input is ignored (select %i, selected=%s)',
    (_name, f, idx, v) => {
      const other = (idx + 1) % inputs
      const feeds: Record<string, Feed> = { ...selectFeeds(selects, idx), ...inputFeeds(idx, v), [`in${other}`]: f }
      const c = partWith(type, feeds)
      expect(c.pin(p('u', 'Z'))).toBe(v)
    }
  )

  describe.each(selects)('with select %s undetermined', (badSel) => {
    const others = selects.filter((s) => s !== badSel)
    const cases: [string, Feed, number][] = []
    for (const [name, f] of NAMED_BAD_FEEDS) {
      for (const otherIdx of range(1 << others.length)) cases.push([name, f, otherIdx])
    }
    it.each(cases)(`%s on ${badSel} (others = %i), inputs differ -> Z is X`, (_name, f, otherIdx) => {
      const feeds: Record<string, Feed> = { ...selectFeeds(others, otherIdx), [badSel]: f, ...inputFeeds(0, ONE) }
      const c = partWith(type, feeds)
      expect(c.pin(p('u', 'Z'))).toBe(X)
    })
    it.each(NAMED_BAD_FEEDS)(`%s on ${badSel}, all inputs 1 -> Z is X (bad select => X)`, (_name, f) => {
      const feeds: Record<string, Feed> = { ...selectFeeds(others, 0), [badSel]: f }
      for (const i of range(inputs)) feeds[`in${i}`] = ONE
      const c = partWith(type, feeds)
      expect(c.pin(p('u', 'Z'))).toBe(X)
    })
  })

  it('outputs X when nothing is connected', () => {
    const c = partWith(type, {})
    expect(c.pin(p('u', 'Z'))).toBe(X)
  })

  it('outputs X when selects are clean but no input is connected', () => {
    const c = partWith(type, selectFeeds(selects, 0))
    expect(c.pin(p('u', 'Z'))).toBe(X)
  })
})

// ---------------------------------------------------------------------------
// Single-bit tristates (4 orientations) — ctl=1 pass, ctl=0 Z, ctl X/Z -> X
// ---------------------------------------------------------------------------

const TRISTATES = [
  ComponentType.TRISTATE_RIGHT,
  ComponentType.TRISTATE_LEFT,
  ComponentType.TRISTATE_UP,
  ComponentType.TRISTATE_DOWN
]

describe.each(TRISTATES)('%s', (type) => {
  it.each([ZERO, ONE])('ctl=1 passes in=%s', (v) => {
    const c = partWith(type, { ctl: ONE, in: v })
    expect(c.pin(p('u', 'out'))).toBe(v)
  })

  it.each(NAMED_BAD_FEEDS)('ctl=1 with %s on in -> out X', (_name, f) => {
    const c = partWith(type, { ctl: ONE, in: f })
    expect(c.pin(p('u', 'out'))).toBe(X)
  })

  it.each([ZERO, ONE])('ctl=0 with in=%s -> out Z', (v) => {
    const c = partWith(type, { ctl: ZERO, in: v })
    expect(c.pin(p('u', 'out'))).toBe(Z)
  })

  it.each(NAMED_BAD_FEEDS)('ctl=0 with %s on in -> out Z', (_name, f) => {
    const c = partWith(type, { ctl: ZERO, in: f })
    expect(c.pin(p('u', 'out'))).toBe(Z)
  })

  const badCtl: [string, Feed, LogicValue][] = []
  for (const [name, f] of NAMED_BAD_FEEDS) for (const v of [ZERO, ONE]) badCtl.push([name, f, v])

  it.each(badCtl)('%s on ctl with in=%s -> out X', (_name, f, v) => {
    const c = partWith(type, { ctl: f, in: v })
    expect(c.pin(p('u', 'out'))).toBe(X)
  })

  it('ctl and in both unconnected -> out X', () => {
    const c = partWith(type, {})
    expect(c.pin(p('u', 'out'))).toBe(X)
  })

  it('follows ctl and in live: enable, pass changes, disable, re-enable with the new value', () => {
    const c = partWith(type, { ctl: ZERO, in: ZERO })
    expect(c.pin(p('u', 'out'))).toBe(Z)
    c.set('s_ctl', ONE)
    expect(c.pin(p('u', 'out'))).toBe(ZERO)
    c.set('s_in', ONE)
    expect(c.pin(p('u', 'out'))).toBe(ONE)
    c.set('s_ctl', ZERO)
    expect(c.pin(p('u', 'out'))).toBe(Z)
    c.set('s_in', ZERO) // change while disabled must not leak
    expect(c.pin(p('u', 'out'))).toBe(Z)
    c.set('s_ctl', ONE)
    expect(c.pin(p('u', 'out'))).toBe(ZERO)
    expect(c.oscillated).toBe(false)
  })

  it('a disabled tristate feeding a gate makes the gate output X (Z input)', () => {
    const c = new CircuitBuilder()
      .add('u', type)
      .switch('in', ONE)
      .switch('ctl', ZERO)
      .add('inv', ComponentType.NOT)
      .wire(p('in', 'out'), p('u', 'in'))
      .wire(p('ctl', 'out'), p('u', 'ctl'))
      .wire(p('u', 'out'), p('inv', 'in1'))
      .build()
    expect(c.pin(p('inv', 'in1'))).toBe(Z)
    expect(c.pin(p('inv', 'out'))).toBe(X)
    c.set('ctl', ONE)
    expect(c.pin(p('inv', 'out'))).toBe(ZERO)
  })
})

describe('two tristates sharing one net', () => {
  /**
   * a (right) and b (left) both drive `bus`; the net also feeds a NOT, an AND2
   * (other input = switch `other`) and a probe. Initially a is enabled with 1,
   * b disabled with 0.
   */
  function sharedNet(): Circuit {
    return new CircuitBuilder()
      .add('a', ComponentType.TRISTATE_RIGHT)
      .add('b', ComponentType.TRISTATE_LEFT)
      .switch('a_in', ONE)
      .switch('b_in', ZERO)
      .switch('a_ctl', ONE)
      .switch('b_ctl', ZERO)
      .switch('other', ONE)
      .probe('bus')
      .add('inv', ComponentType.NOT)
      .add('and', ComponentType.AND2)
      .wire(p('a_in', 'out'), p('a', 'in'))
      .wire(p('b_in', 'out'), p('b', 'in'))
      .wire(p('a_ctl', 'out'), p('a', 'ctl'))
      .wire(p('b_ctl', 'out'), p('b', 'ctl'))
      .connect(p('bus', 'in'), p('a', 'out'), p('b', 'out'), p('inv', 'in1'), p('and', 'in1'))
      .wire(p('other', 'out'), p('and', 'in2'))
      .build()
  }
  const bus = p('bus', 'in')

  it('the net follows whichever tristate is enabled', () => {
    const c = sharedNet()
    expect(c.pin(bus)).toBe(ONE) // a enabled, a_in = 1
    c.set('a_in', ZERO)
    expect(c.pin(bus)).toBe(ZERO)
    c.set('b_in', ONE) // b is disabled: no effect
    expect(c.pin(bus)).toBe(ZERO)
    c.setMany({ a_ctl: ZERO, b_ctl: ONE }) // hand over to b
    expect(c.pin(bus)).toBe(ONE)
    c.set('b_in', ZERO)
    expect(c.pin(bus)).toBe(ZERO)
    c.set('a_in', ONE) // a is disabled: no effect
    expect(c.pin(bus)).toBe(ZERO)
    c.setMany({ a_ctl: ONE, b_ctl: ZERO }) // hand back to a
    expect(c.pin(bus)).toBe(ONE)
    expect(c.oscillated).toBe(false)
  })

  it('both disabled -> the net is Z', () => {
    const c = sharedNet()
    c.set('a_ctl', ZERO)
    expect(c.pin(bus)).toBe(Z)
    expect(c.pin(p('a', 'out'))).toBe(Z)
    expect(c.pin(p('b', 'out'))).toBe(Z)
  })

  it('both enabled with different values -> the net is X', () => {
    const c = sharedNet()
    c.set('b_ctl', ONE) // a_in=1, b_in=0
    expect(c.pin(bus)).toBe(X)
    c.setMany({ a_in: ZERO, b_in: ONE })
    expect(c.pin(bus)).toBe(X)
  })

  it.each([ZERO, ONE])(
    'both enabled driving the same value %s -> the net carries that value (standard wired-bus resolution; see observations)',
    (v) => {
      const c = sharedNet()
      c.setMany({ a_in: v, b_in: v, a_ctl: ONE, b_ctl: ONE })
      expect(c.pin(bus)).toBe(v)
    }
  )

  it('a Z net into NOT gives X; into AND2 gives X unless the other input is a controlling 0', () => {
    const c = sharedNet()
    c.set('a_ctl', ZERO) // both disabled -> Z
    expect(c.pin(bus)).toBe(Z)
    expect(c.pin(p('inv', 'out'))).toBe(X)
    expect(c.pin(p('and', 'out'))).toBe(X) // other = 1
    c.set('other', ZERO)
    expect(c.pin(p('and', 'out'))).toBe(ZERO)
  })

  it('an X net (contention) into NOT and AND2 behaves like any X input', () => {
    const c = sharedNet()
    c.set('b_ctl', ONE) // contention 1 vs 0 -> X
    expect(c.pin(p('inv', 'out'))).toBe(X)
    expect(c.pin(p('and', 'out'))).toBe(X)
    c.set('other', ZERO)
    expect(c.pin(p('and', 'out'))).toBe(ZERO)
  })

  it('a resolved net drives the readers with the enabled value', () => {
    const c = sharedNet()
    expect(c.pin(p('inv', 'out'))).toBe(ZERO)
    expect(c.pin(p('and', 'out'))).toBe(ONE)
    c.set('a_in', ZERO)
    expect(c.pin(p('inv', 'out'))).toBe(ONE)
    expect(c.pin(p('and', 'out'))).toBe(ZERO)
  })

  it('the probe on the shared net records Z and X transitions as changes', () => {
    const c = sharedNet()
    const t0 = trace(c, 'bus')
    expect(t0).toEqual([{ t: 0, v: ONE }])
    c.set('a_ctl', ZERO) // -> Z
    c.set('b_ctl', ONE) // -> 0 (b_in)
    c.set('a_ctl', ONE) // -> X (1 vs 0)
    const vals = trace(c, 'bus').map((s) => s.v)
    expect(vals).toEqual([ONE, Z, ZERO, X])
    const times = trace(c, 'bus').map((s) => s.t)
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1])
  })

  it('an X-driving tristate (ctl undetermined) forces the shared net to X even when the other driver is clean', () => {
    // decision 3: any X driver gives X. a's ctl comes from a NOT with an open input (-> X).
    const c = new CircuitBuilder()
      .add('a', ComponentType.TRISTATE_RIGHT)
      .add('b', ComponentType.TRISTATE_LEFT)
      .add('xsrc', ComponentType.NOT)
      .switch('a_in', ONE)
      .switch('b_in', ONE)
      .switch('b_ctl', ONE)
      .probe('bus')
      .wire(p('xsrc', 'out'), p('a', 'ctl'))
      .wire(p('a_in', 'out'), p('a', 'in'))
      .wire(p('b_in', 'out'), p('b', 'in'))
      .wire(p('b_ctl', 'out'), p('b', 'ctl'))
      .connect(p('bus', 'in'), p('a', 'out'), p('b', 'out'))
      .build()
    expect(c.pin(p('a', 'out'))).toBe(X)
    expect(c.pin(p('bus', 'in'))).toBe(X)
    c.set('b_in', ZERO)
    expect(c.pin(p('bus', 'in'))).toBe(X)
    c.set('b_ctl', ZERO) // b releases: only the X driver remains
    expect(c.pin(p('bus', 'in'))).toBe(X)
  })

  it('a plain gate output shares a net with a tristate: released -> gate value, agreeing -> value, disagreeing -> X', () => {
    const c = new CircuitBuilder()
      .switch('g_in', ONE)
      .add('buf', ComponentType.AND2)
      .add('ts', ComponentType.TRISTATE_UP)
      .switch('ts_in', ONE)
      .switch('ts_ctl', ZERO)
      .probe('net')
      .wire(p('g_in', 'out'), p('buf', 'in1'))
      .wire(p('g_in', 'out'), p('buf', 'in2'))
      .wire(p('ts_in', 'out'), p('ts', 'in'))
      .wire(p('ts_ctl', 'out'), p('ts', 'ctl'))
      .connect(p('net', 'in'), p('buf', 'out'), p('ts', 'out'))
      .build()
    expect(c.pin(p('net', 'in'))).toBe(ONE) // tristate off: the AND drives alone
    c.set('g_in', ZERO)
    expect(c.pin(p('net', 'in'))).toBe(ZERO)
    c.set('ts_ctl', ONE) // ts drives 1, AND drives 0 -> contention
    expect(c.pin(p('net', 'in'))).toBe(X)
    c.set('ts_in', ZERO) // both 0
    expect(c.pin(p('net', 'in'))).toBe(ZERO)
    c.set('g_in', ONE) // AND 1 vs ts 0
    expect(c.pin(p('net', 'in'))).toBe(X)
    c.set('ts_ctl', ZERO) // released again
    expect(c.pin(p('net', 'in'))).toBe(ONE)
    expect(c.oscillated).toBe(false)
  })

  it('two switches wired together: agreeing positions keep the value, disagreeing positions give X', () => {
    const c = new CircuitBuilder()
      .switch('s1', ZERO)
      .switch('s2', ZERO)
      .probe('net')
      .add('inv', ComponentType.NOT)
      .connect(p('net', 'in'), p('s1', 'out'), p('s2', 'out'), p('inv', 'in1'))
      .build()
    expect(c.pin(p('net', 'in'))).toBe(ZERO)
    expect(c.pin(p('inv', 'out'))).toBe(ONE)
    c.set('s1', ONE)
    expect(c.pin(p('net', 'in'))).toBe(X)
    expect(c.pin(p('inv', 'out'))).toBe(X)
    c.set('s2', ONE)
    expect(c.pin(p('net', 'in'))).toBe(ONE)
    expect(c.pin(p('inv', 'out'))).toBe(ZERO)
  })

  it.each([ZERO, ONE])(
    'a simultaneous handover (a off, b on in the same instant) with both inputs %s leaves the probe trace unchanged',
    (v) => {
      // Both drivers change at the same instant; the resolved net value never differs
      // from v, so a timing diagram must not show a zero-width Z or X at that instant.
      const c = sharedNet()
      c.setMany({ a_in: v, b_in: v })
      const before = trace(c, 'bus')
      expect(before.at(-1)!.v).toBe(v)
      c.setMany({ a_ctl: ZERO, b_ctl: ONE })
      expect(c.pin(bus)).toBe(v)
      const after = trace(c, 'bus')
      expect(after.map((s) => s.v).every((x) => x === ZERO || x === ONE)).toBe(true)
      expect(after).toEqual(before)
    }
  )

  it('a simultaneous handover between different values records exactly one sample, at a strictly later time', () => {
    const c = sharedNet() // a on with 1, b off with 0
    const before = trace(c, 'bus')
    const tBefore = c.time
    c.setMany({ a_ctl: ZERO, b_ctl: ONE })
    expect(c.pin(bus)).toBe(ZERO)
    const after = trace(c, 'bus')
    expect(after).toHaveLength(before.length + 1)
    expect(after.at(-1)).toEqual({ t: tBefore + 2, v: ZERO }) // switch delay 1 + tristate delay 1
    for (let i = 1; i < after.length; i++) expect(after[i].t).toBeGreaterThan(after[i - 1].t)
  })

  it('a Z tristate net selected by a mux yields X on the mux output', () => {
    const c = new CircuitBuilder()
      .add('ts', ComponentType.TRISTATE_DOWN)
      .switch('in', ONE)
      .switch('ctl', ZERO)
      .switch('sel', ZERO)
      .switch('one', ONE)
      .add('m', ComponentType.MUX_2)
      .wire(p('in', 'out'), p('ts', 'in'))
      .wire(p('ctl', 'out'), p('ts', 'ctl'))
      .wire(p('ts', 'out'), p('m', 'in0'))
      .wire(p('one', 'out'), p('m', 'in1'))
      .wire(p('sel', 'out'), p('m', 'A'))
      .build()
    expect(c.pin(p('m', 'Z'))).toBe(X)
    c.set('sel', ONE) // in1 selected: the Z on in0 is ignored
    expect(c.pin(p('m', 'Z'))).toBe(ONE)
    c.set('sel', ZERO)
    c.set('ctl', ONE)
    expect(c.pin(p('m', 'Z'))).toBe(ONE)
  })
})

// ---------------------------------------------------------------------------
// VCC / GROUND
// ---------------------------------------------------------------------------

describe('VCC and GROUND', () => {
  it('VCC drives a constant 1 and GROUND a constant 0', () => {
    const c = new CircuitBuilder().add('v', ComponentType.VCC).add('g', ComponentType.GROUND).build()
    expect(c.pin(p('v', 'out'))).toBe(ONE)
    expect(c.pin(p('g', 'out'))).toBe(ZERO)
  })

  it('feed gates like ordinary 1/0 inputs', () => {
    const c = new CircuitBuilder()
      .add('v', ComponentType.VCC)
      .add('g', ComponentType.GROUND)
      .add('nv', ComponentType.NOT)
      .add('ng', ComponentType.NOT)
      .add('and', ComponentType.AND2)
      .add('or', ComponentType.OR2)
      .switch('s', ZERO)
      .wire(p('v', 'out'), p('nv', 'in1'))
      .wire(p('g', 'out'), p('ng', 'in1'))
      .wire(p('v', 'out'), p('and', 'in1'))
      .wire(p('s', 'out'), p('and', 'in2'))
      .wire(p('g', 'out'), p('or', 'in1'))
      .wire(p('s', 'out'), p('or', 'in2'))
      .build()
    expect(c.pin(p('nv', 'out'))).toBe(ZERO)
    expect(c.pin(p('ng', 'out'))).toBe(ONE)
    expect(c.pin(p('and', 'out'))).toBe(ZERO)
    expect(c.pin(p('or', 'out'))).toBe(ZERO)
    c.set('s', ONE)
    expect(c.pin(p('and', 'out'))).toBe(ONE)
    expect(c.pin(p('or', 'out'))).toBe(ONE)
  })

  it('are recorded by probes as a constant from t=0 and survive reset', () => {
    const c = new CircuitBuilder()
      .add('v', ComponentType.VCC)
      .add('g', ComponentType.GROUND)
      .probe('pv')
      .probe('pg')
      .wire(p('v', 'out'), p('pv', 'in'))
      .wire(p('g', 'out'), p('pg', 'in'))
      .build()
    expect(trace(c, 'pv')).toEqual([{ t: 0, v: ONE }])
    expect(trace(c, 'pg')).toEqual([{ t: 0, v: ZERO }])
    c.reset()
    expect(c.pin(p('v', 'out'))).toBe(ONE)
    expect(c.pin(p('g', 'out'))).toBe(ZERO)
    expect(trace(c, 'pv')).toEqual([{ t: 0, v: ONE }])
  })

  it('VCC through an enabled tristate is 1, GROUND through it is 0', () => {
    const c = new CircuitBuilder()
      .add('v', ComponentType.VCC)
      .add('g', ComponentType.GROUND)
      .add('tv', ComponentType.TRISTATE_UP)
      .add('tg', ComponentType.TRISTATE_LEFT)
      .wire(p('v', 'out'), p('tv', 'in'))
      .wire(p('v', 'out'), p('tv', 'ctl'))
      .wire(p('g', 'out'), p('tg', 'in'))
      .wire(p('v', 'out'), p('tg', 'ctl'))
      .build()
    expect(c.pin(p('tv', 'out'))).toBe(ONE)
    expect(c.pin(p('tg', 'out'))).toBe(ZERO)
  })
})

// ---------------------------------------------------------------------------
// SWITCH
// ---------------------------------------------------------------------------

describe('SWITCH', () => {
  it.each([ZERO, ONE])('starts at the position given in switchValues (%s)', (v) => {
    const c = new CircuitBuilder().switch('s', v).build()
    expect(c.pin(p('s', 'out'))).toBe(v)
  })

  it('defaults to 0 when absent from switchValues', () => {
    const c = new CircuitBuilder().add('s', ComponentType.SWITCH).build()
    expect(c.pin(p('s', 'out'))).toBe(ZERO)
    expect(c.sim.toggle('s')).toBe(ONE)
    expect(c.pin(p('s', 'out'))).toBe(ONE)
  })

  it('toggle returns the new position and the output follows', () => {
    const c = new CircuitBuilder().switch('s', ZERO).build()
    expect(c.sim.toggle('s')).toBe(ONE)
    expect(c.pin(p('s', 'out'))).toBe(ONE)
    expect(c.sim.toggle('s')).toBe(ZERO)
    expect(c.pin(p('s', 'out'))).toBe(ZERO)
    expect(c.sim.toggle('s')).toBe(ONE)
    expect(c.pin(p('s', 'out'))).toBe(ONE)
  })

  it('toggle(id, false) defers propagation until drain()', () => {
    const c = new CircuitBuilder().switch('s', ZERO).build()
    expect(c.sim.toggle('s', false)).toBe(ONE)
    expect(c.pin(p('s', 'out'))).toBe(ZERO)
    c.sim.drain()
    expect(c.pin(p('s', 'out'))).toBe(ONE)
  })

  it('keeps its position across reset()', () => {
    const c = new CircuitBuilder().switch('s', ZERO).add('n', ComponentType.NOT).wire(p('s', 'out'), p('n', 'in1')).build()
    c.toggle('s')
    expect(c.pin(p('n', 'out'))).toBe(ZERO)
    c.reset()
    expect(c.pin(p('s', 'out'))).toBe(ONE)
    expect(c.pin(p('n', 'out'))).toBe(ZERO)
  })

  it('a switch fans out to several inputs at once', () => {
    const c = new CircuitBuilder()
      .switch('s', ZERO)
      .add('n1', ComponentType.NOT)
      .add('n2', ComponentType.NOT)
      .probe('pr')
      .connect(p('s', 'out'), p('n1', 'in1'), p('n2', 'in1'), p('pr', 'in'))
      .build()
    expect(c.pin(p('n1', 'out'))).toBe(ONE)
    expect(c.pin(p('n2', 'out'))).toBe(ONE)
    expect(c.pin(p('pr', 'in'))).toBe(ZERO)
    c.set('s', ONE)
    expect(c.pin(p('n1', 'out'))).toBe(ZERO)
    expect(c.pin(p('n2', 'out'))).toBe(ZERO)
    expect(c.pin(p('pr', 'in'))).toBe(ONE)
  })
})

// ---------------------------------------------------------------------------
// PROBE — timing-diagram samples at t=0 and on every change of its net
// ---------------------------------------------------------------------------

describe('PROBE', () => {
  function switchToProbe(initial: LogicValue): Circuit {
    return new CircuitBuilder().switch('s', initial).probe('pr').wire(p('s', 'out'), p('pr', 'in')).build()
  }

  it.each([ZERO, ONE])('records the settled value at t=0 (initial %s)', (v) => {
    const c = switchToProbe(v)
    expect(c.pin(p('pr', 'in'))).toBe(v)
    expect(trace(c, 'pr')).toEqual([{ t: 0, v }])
  })

  it('records one sample per change with the new value and strictly increasing time', () => {
    const c = switchToProbe(ZERO)
    c.set('s', ONE)
    c.set('s', ZERO)
    c.set('s', ONE)
    const s = trace(c, 'pr')
    expect(s.map((x) => x.v)).toEqual([ZERO, ONE, ZERO, ONE])
    for (let i = 1; i < s.length; i++) expect(s[i].t).toBeGreaterThan(s[i - 1].t)
  })

  it('a change lands one default delay (1 ns) after the toggle', () => {
    const c = switchToProbe(ZERO)
    const t0 = c.time
    c.set('s', ONE)
    const s = trace(c, 'pr')
    expect(s).toHaveLength(2)
    expect(s[1].t).toBe(t0 + 1)
    expect(c.time).toBe(t0 + 1)
  })

  it('records no sample when the probed net does not change', () => {
    const c = new CircuitBuilder()
      .switch('sel', ZERO)
      .switch('i0', ONE)
      .switch('i1', ZERO)
      .add('m', ComponentType.MUX_2)
      .probe('pr')
      .wire(p('sel', 'out'), p('m', 'A'))
      .wire(p('i0', 'out'), p('m', 'in0'))
      .wire(p('i1', 'out'), p('m', 'in1'))
      .wire(p('m', 'Z'), p('pr', 'in'))
      .build()
    expect(trace(c, 'pr')).toEqual([{ t: 0, v: ONE }])
    c.set('i1', ONE) // unselected input: Z unchanged
    expect(trace(c, 'pr')).toHaveLength(1)
    c.set('sel', ONE) // now selects in1 = 1: still unchanged
    expect(trace(c, 'pr')).toHaveLength(1)
    c.set('i1', ZERO) // selected input changes
    expect(trace(c, 'pr')).toHaveLength(2)
    expect(trace(c, 'pr')[1].v).toBe(ZERO)
  })

  it('an unconnected probe reads Z and records Z at t=0', () => {
    const c = new CircuitBuilder().probe('pr').build()
    expect(c.pin(p('pr', 'in'))).toBe(Z)
    expect(trace(c, 'pr')).toEqual([{ t: 0, v: Z }])
  })

  it('a probe on a gate fed by Z records X', () => {
    const c = new CircuitBuilder().add('n', ComponentType.NOT).probe('pr').wire(p('n', 'out'), p('pr', 'in')).build()
    expect(trace(c, 'pr')).toEqual([{ t: 0, v: X }])
  })

  it.each([1, 5, 37])('a part with delay %i ns shows up %i ns after its input changed', (delay) => {
    const c = new CircuitBuilder()
      .switch('x', ZERO)
      .switch('y', ZERO)
      .switch('cin', ZERO)
      .add('fa', ComponentType.FULL_ADDER, { delay })
      .probe('px')
      .probe('psum')
      .probe('pcout')
      .wire(p('x', 'out'), p('fa', 'X'))
      .wire(p('y', 'out'), p('fa', 'Y'))
      .wire(p('cin', 'out'), p('fa', 'Cin'))
      .wire(p('x', 'out'), p('px', 'in'))
      .wire(p('fa', 'Sum'), p('psum', 'in'))
      .wire(p('fa', 'Cout'), p('pcout', 'in'))
      .build()
    expect(trace(c, 'psum')).toEqual([{ t: 0, v: ZERO }])
    c.set('x', ONE)
    const px = trace(c, 'px')
    const ps = trace(c, 'psum')
    expect(px).toHaveLength(2)
    expect(ps).toHaveLength(2)
    expect(ps[1].v).toBe(ONE)
    expect(ps[1].t - px[1].t).toBe(delay)
    expect(trace(c, 'pcout')).toHaveLength(1) // Cout stayed 0
    c.set('y', ONE)
    const pc = trace(c, 'pcout')
    expect(pc).toHaveLength(2)
    expect(pc[1].v).toBe(ONE)
    expect(trace(c, 'psum').at(-1)).toEqual({ t: pc[1].t, v: ZERO })
  })

  it('reset() restarts the trace with a single t=0 sample of the current value', () => {
    const c = switchToProbe(ZERO)
    c.set('s', ONE)
    expect(trace(c, 'pr')).toHaveLength(2)
    c.reset()
    expect(c.time).toBe(0)
    expect(trace(c, 'pr')).toEqual([{ t: 0, v: ONE }])
  })

  it('getWaveforms lists probes in placement order, each as a non-bus trace', () => {
    const c = new CircuitBuilder()
      .probe('second')
      .switch('s', ONE)
      .probe('first')
      .wire(p('s', 'out'), p('first', 'in'))
      .build()
    const w = c.sim.getWaveforms()
    expect(w.map((t) => t.probeId)).toEqual(['second', 'first'])
    expect(w.every((t) => t.bus === false)).toBe(true)
    expect(w[0].samples).toEqual([{ t: 0, v: Z }])
    expect(w[1].samples).toEqual([{ t: 0, v: ONE }])
  })

  it('two probes on the same net record the same samples', () => {
    const c = new CircuitBuilder()
      .switch('s', ZERO)
      .probe('p1')
      .probe('p2')
      .connect(p('s', 'out'), p('p1', 'in'), p('p2', 'in'))
      .build()
    c.set('s', ONE)
    c.set('s', ZERO)
    expect(trace(c, 'p2')).toEqual(trace(c, 'p1'))
    expect(trace(c, 'p1').map((x) => x.v)).toEqual([ZERO, ONE, ZERO])
  })
})

// ---------------------------------------------------------------------------
// SEVEN_SEGMENT — pure sink, inputs 1..7 read from their nets, no outputs
// ---------------------------------------------------------------------------

describe('SEVEN_SEGMENT', () => {
  it('has seven input pins named 1..7 and no outputs', () => {
    const pins = getPartDefinition(ComponentType.SEVEN_SEGMENT).pins
    expect(pins.map((q) => q.name).sort()).toEqual(['1', '2', '3', '4', '5', '6', '7'])
    expect(pins.every((q) => q.role === 'input')).toBe(true)
  })

  it('reads each input from its net (0, 1, X, Z) and tolerates toggling without error', () => {
    const b = new CircuitBuilder().add('seg', ComponentType.SEVEN_SEGMENT)
    feed(b, 'f1', p('seg', '1'), ONE)
    feed(b, 'f2', p('seg', '2'), ZERO)
    feed(b, 'f3', p('seg', '3'), X)
    feed(b, 'f4', p('seg', '4'), Z)
    // pin 5 left unconnected
    feed(b, 'f6', p('seg', '6'), ONE)
    feed(b, 'f7', p('seg', '7'), ZERO)
    const c = b.build()
    expect(c.pin(p('seg', '1'))).toBe(ONE)
    expect(c.pin(p('seg', '2'))).toBe(ZERO)
    expect(c.pin(p('seg', '3'))).toBe(X)
    expect(c.pin(p('seg', '4'))).toBe(Z)
    expect(c.pin(p('seg', '5'))).toBe(Z)
    expect(c.pin(p('seg', '6'))).toBe(ONE)
    expect(c.pin(p('seg', '7'))).toBe(ZERO)
    c.setMany({ f1: ZERO, f2: ONE, f6: ZERO, f7: ONE })
    expect(c.pin(p('seg', '1'))).toBe(ZERO)
    expect(c.pin(p('seg', '2'))).toBe(ONE)
    expect(c.pin(p('seg', '6'))).toBe(ZERO)
    expect(c.pin(p('seg', '7'))).toBe(ONE)
    expect(c.oscillated).toBe(false)
  })

  it('is a pure reader: the sim graph gives it no output pins and one reader entry per net', () => {
    const b = new CircuitBuilder().add('seg', ComponentType.SEVEN_SEGMENT).switch('s', ONE)
    b.connect(p('s', 'out'), p('seg', '1'), p('seg', '2'))
    const g = buildSimGraph(b.netlist)
    const seg = g.components.get('seg')!
    expect(seg.outputPinNames).toEqual([])
    expect([...seg.inputPinNames].sort()).toEqual(['1', '2', '3', '4', '5', '6', '7'])
    const net = g.pinToNet.get(p('s', 'out'))!
    expect(g.readers.get(net)).toEqual(['seg'])
  })
})

// ---------------------------------------------------------------------------
// Pin definitions vs. what the engine reads
// ---------------------------------------------------------------------------

describe('pin definitions', () => {
  const EXPECTED: [ComponentType, string[], string[]][] = [
    [ComponentType.FULL_ADDER, ['X', 'Y', 'Cin'], ['Sum', 'Cout']],
    [ComponentType.DECODER_2TO4, ['A', 'B'], range(4).map((i) => `out${i}`)],
    [ComponentType.DECODER_3TO8, ['A', 'B', 'C'], range(8).map((i) => `out${i}`)],
    [ComponentType.MUX_2, [...range(2).map((i) => `in${i}`), 'A'], ['Z']],
    [ComponentType.MUX_4, [...range(4).map((i) => `in${i}`), 'A', 'B'], ['Z']],
    [ComponentType.MUX_8, [...range(8).map((i) => `in${i}`), 'A', 'B', 'C'], ['Z']],
    [ComponentType.TRISTATE_RIGHT, ['in', 'ctl'], ['out']],
    [ComponentType.TRISTATE_LEFT, ['in', 'ctl'], ['out']],
    [ComponentType.TRISTATE_UP, ['in', 'ctl'], ['out']],
    [ComponentType.TRISTATE_DOWN, ['in', 'ctl'], ['out']],
    [ComponentType.VCC, [], ['out']],
    [ComponentType.GROUND, [], ['out']],
    [ComponentType.SWITCH, [], ['out']],
    [ComponentType.PROBE, ['in'], []],
    [ComponentType.SEVEN_SEGMENT, range(7).map((i) => String(i + 1)), []]
  ]

  it.each(EXPECTED)('%s declares exactly the pins the engine reads/writes', (type, inputs, outputs) => {
    const pins = getPartDefinition(type).pins
    const ins = pins.filter((q) => q.role === 'input').map((q) => q.name)
    const outs = pins.filter((q) => q.role === 'output').map((q) => q.name)
    expect([...ins].sort()).toEqual([...inputs].sort())
    expect([...outs].sort()).toEqual([...outputs].sort())
    expect(pins.every((q) => q.role === 'input' || q.role === 'output')).toBe(true)
    // all single-bit pins
    expect(pins.every((q) => q.width === undefined)).toBe(true)
    // no two pins share a coordinate, or the net resolver would short them
    const coords = new Set(pins.map((q) => `${q.dx},${q.dy}`))
    expect(coords.size).toBe(pins.length)
  })

  it.each(EXPECTED)('%s: the sim graph classifies its pins the same way', (type, inputs, outputs) => {
    const b = new CircuitBuilder().add('u', type)
    const g = buildSimGraph(b.netlist)
    const comp = g.components.get('u')!
    expect([...comp.inputPinNames].sort()).toEqual([...inputs].sort())
    expect([...comp.outputPinNames].sort()).toEqual([...outputs].sort())
    for (const name of [...inputs, ...outputs]) expect(comp.pinNet[name]).toBeDefined()
  })

  it('an isolated part reports Z on every input pin (nothing drives it)', () => {
    for (const [type, inputs] of EXPECTED) {
      const c = new CircuitBuilder().add('u', type).build()
      for (const name of inputs) expect(c.pin(p('u', name)), `${type}#${name}`).toBe(Z)
    }
  })
})

// ---------------------------------------------------------------------------
// Propagation delay of the fixed combinational parts (default 1 ns, range 1..999)
// ---------------------------------------------------------------------------

describe('propagation delay', () => {
  const DELAYS = [1, 3, 12, 999]

  it.each(DELAYS)('DECODER_2TO4 with delay %i: every output moves exactly that long after the select, together', (delay) => {
    const b = new CircuitBuilder()
      .switch('A', ZERO)
      .switch('B', ZERO)
      .add('dec', ComponentType.DECODER_2TO4, { delay })
      .probe('pB')
      .wire(p('A', 'out'), p('dec', 'A'))
      .wire(p('B', 'out'), p('dec', 'B'))
      .wire(p('B', 'out'), p('pB', 'in'))
    for (const i of range(4)) b.probe(`p${i}`).wire(p('dec', `out${i}`), p(`p${i}`, 'in'))
    const c = b.build()
    c.set('B', ONE)
    const tB = trace(c, 'pB')[1].t
    expect(tB).toBe(1)
    expect(trace(c, 'p0')).toEqual([{ t: 0, v: ONE }, { t: tB + delay, v: ZERO }])
    expect(trace(c, 'p1')).toEqual([{ t: 0, v: ZERO }, { t: tB + delay, v: ONE }])
    expect(trace(c, 'p2')).toEqual([{ t: 0, v: ZERO }])
    expect(trace(c, 'p3')).toEqual([{ t: 0, v: ZERO }])
    expect(c.time).toBe(tB + delay)
  })

  it.each(DELAYS)('DECODER_3TO8 with delay %i: the one-hot moves exactly that long after C changes', (delay) => {
    const b = new CircuitBuilder()
      .switch('A', ONE)
      .switch('B', ZERO)
      .switch('C', ZERO)
      .add('dec', ComponentType.DECODER_3TO8, { delay })
      .wire(p('A', 'out'), p('dec', 'A'))
      .wire(p('B', 'out'), p('dec', 'B'))
      .wire(p('C', 'out'), p('dec', 'C'))
    for (const i of range(8)) b.probe(`p${i}`).wire(p('dec', `out${i}`), p(`p${i}`, 'in'))
    const c = b.build()
    c.set('C', ONE) // 100 -> 101: out4 falls, out5 rises
    expect(trace(c, 'p4')).toEqual([{ t: 0, v: ONE }, { t: 1 + delay, v: ZERO }])
    expect(trace(c, 'p5')).toEqual([{ t: 0, v: ZERO }, { t: 1 + delay, v: ONE }])
    for (const i of [0, 1, 2, 3, 6, 7]) expect(trace(c, `p${i}`), `p${i}`).toEqual([{ t: 0, v: ZERO }])
  })

  it.each(DELAYS)('MUX_2 with delay %i: Z moves exactly that long after the select or the selected input', (delay) => {
    const c = new CircuitBuilder()
      .switch('A', ZERO)
      .switch('i0', ZERO)
      .switch('i1', ONE)
      .add('m', ComponentType.MUX_2, { delay })
      .probe('pz')
      .wire(p('A', 'out'), p('m', 'A'))
      .wire(p('i0', 'out'), p('m', 'in0'))
      .wire(p('i1', 'out'), p('m', 'in1'))
      .wire(p('m', 'Z'), p('pz', 'in'))
      .build()
    c.set('A', ONE) // select change
    expect(trace(c, 'pz')).toEqual([{ t: 0, v: ZERO }, { t: 1 + delay, v: ONE }])
    const t1 = c.time
    c.set('i1', ZERO) // selected-input change
    expect(trace(c, 'pz').at(-1)).toEqual({ t: t1 + 1 + delay, v: ZERO })
    const t2 = c.time
    c.set('i0', ONE) // unselected-input change: nothing, and no time passes beyond the switch itself
    expect(trace(c, 'pz')).toHaveLength(3)
    expect(c.time).toBe(t2 + 1)
  })

  it.each(DELAYS)('MUX_8 with delay %i: Z moves exactly that long after C changes', (delay) => {
    const b = new CircuitBuilder()
      .switch('A', ONE)
      .switch('B', ONE)
      .switch('C', ZERO)
      .add('m', ComponentType.MUX_8, { delay })
      .probe('pz')
      .wire(p('A', 'out'), p('m', 'A'))
      .wire(p('B', 'out'), p('m', 'B'))
      .wire(p('C', 'out'), p('m', 'C'))
      .wire(p('m', 'Z'), p('pz', 'in'))
    for (const i of range(8)) b.switch(`i${i}`, i === 7 ? ONE : ZERO).wire(p(`i${i}`, 'out'), p('m', `in${i}`))
    const c = b.build()
    expect(c.pin(p('m', 'Z'))).toBe(ZERO) // ABC=110 -> in6 = 0
    c.set('C', ONE) // -> in7 = 1
    expect(trace(c, 'pz')).toEqual([{ t: 0, v: ZERO }, { t: 1 + delay, v: ONE }])
  })

  it.each(TRISTATES.flatMap((t) => DELAYS.map((d) => [t, d] as [ComponentType, number])))(
    '%s with delay %i: enable, data and disable each take exactly that long',
    (type, delay) => {
      const c = new CircuitBuilder()
        .switch('in', ONE)
        .switch('ctl', ZERO)
        .add('u', type, { delay })
        .probe('po')
        .wire(p('in', 'out'), p('u', 'in'))
        .wire(p('ctl', 'out'), p('u', 'ctl'))
        .wire(p('u', 'out'), p('po', 'in'))
        .build()
      expect(trace(c, 'po')).toEqual([{ t: 0, v: Z }])
      c.set('ctl', ONE)
      expect(trace(c, 'po').at(-1)).toEqual({ t: 1 + delay, v: ONE })
      const t1 = c.time
      c.set('in', ZERO)
      expect(trace(c, 'po').at(-1)).toEqual({ t: t1 + 1 + delay, v: ZERO })
      const t2 = c.time
      c.set('ctl', ZERO)
      expect(trace(c, 'po').at(-1)).toEqual({ t: t2 + 1 + delay, v: Z })
      expect(trace(c, 'po')).toHaveLength(4)
    }
  )

  it.each(DELAYS)('FULL_ADDER with delay %i: Sum and Cout change together exactly that long after the inputs', (delay) => {
    const c = new CircuitBuilder()
      .switch('x', ONE)
      .switch('y', ZERO)
      .switch('cin', ZERO)
      .add('fa', ComponentType.FULL_ADDER, { delay })
      .probe('ps')
      .probe('pc')
      .wire(p('x', 'out'), p('fa', 'X'))
      .wire(p('y', 'out'), p('fa', 'Y'))
      .wire(p('cin', 'out'), p('fa', 'Cin'))
      .wire(p('fa', 'Sum'), p('ps', 'in'))
      .wire(p('fa', 'Cout'), p('pc', 'in'))
      .build()
    c.set('y', ONE) // 1+1 = 10: Sum 1->0, Cout 0->1 at the same instant
    expect(trace(c, 'ps')).toEqual([{ t: 0, v: ONE }, { t: 1 + delay, v: ZERO }])
    expect(trace(c, 'pc')).toEqual([{ t: 0, v: ZERO }, { t: 1 + delay, v: ONE }])
  })
})

// ---------------------------------------------------------------------------
// Inertial delay (implementation decision 2) seen through a MUX_2
// ---------------------------------------------------------------------------

describe('inertial delay on a MUX_2', () => {
  /**
   * A = s, in0 = s, in1 = NOT s (NOT delay 1). Flipping s 0->1 makes the mux see
   * A=1 with the stale in1=1 for one nanosecond before in1 falls to 0, so the
   * final Z is 0 but the mux is asked for 1 for exactly 1 ns.
   */
  function glitchMux(delay: number): Circuit {
    return new CircuitBuilder()
      .switch('s', ZERO)
      .add('inv', ComponentType.NOT)
      .add('m', ComponentType.MUX_2, { delay })
      .probe('pz')
      .connect(p('s', 'out'), p('m', 'A'), p('m', 'in0'), p('inv', 'in1'))
      .wire(p('inv', 'out'), p('m', 'in1'))
      .wire(p('m', 'Z'), p('pz', 'in'))
      .build()
  }

  it('a 1 ns request pulse equal to the mux delay (1) appears as a 1 ns glitch on Z', () => {
    const c = glitchMux(1)
    expect(c.pin(p('m', 'Z'))).toBe(ZERO)
    c.set('s', ONE)
    // s rises at 1; mux sees A=1,in1=1 -> Z=1 at 2; NOT falls at 2 -> Z=0 at 3
    expect(trace(c, 'pz')).toEqual([{ t: 0, v: ZERO }, { t: 2, v: ONE }, { t: 3, v: ZERO }])
    expect(c.pin(p('m', 'Z'))).toBe(ZERO)
  })

  it.each([2, 3, 10])('a 1 ns request pulse shorter than the mux delay (%i) never reaches Z', (delay) => {
    const c = glitchMux(delay)
    c.set('s', ONE)
    expect(trace(c, 'pz')).toEqual([{ t: 0, v: ZERO }])
    expect(c.pin(p('m', 'Z'))).toBe(ZERO)
    c.set('s', ZERO) // back: A=0 selects in0=0 immediately; in1 irrelevant
    expect(trace(c, 'pz')).toEqual([{ t: 0, v: ZERO }])
  })

  it('the steady state is always the function of the settled inputs', () => {
    for (const delay of [1, 2, 5]) {
      const c = glitchMux(delay)
      for (const v of [ONE, ZERO, ONE]) {
        c.set('s', v)
        expect(c.pin(p('m', 'Z')), `delay ${delay}, s=${v}`).toBe(ZERO) // Z = s ? NOT s : s = 0 always
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Live clean -> undetermined -> clean transitions on selects
// ---------------------------------------------------------------------------

describe('live select transitions through Z', () => {
  it('DECODER_2TO4: A through a tristate; disabling it makes every output X and re-enabling restores the one-hot', () => {
    const c = new CircuitBuilder()
      .switch('a', ONE)
      .switch('b', ONE)
      .switch('en', ONE)
      .add('ts', ComponentType.TRISTATE_RIGHT)
      .add('dec', ComponentType.DECODER_2TO4)
      .wire(p('a', 'out'), p('ts', 'in'))
      .wire(p('en', 'out'), p('ts', 'ctl'))
      .wire(p('ts', 'out'), p('dec', 'A'))
      .wire(p('b', 'out'), p('dec', 'B'))
      .build()
    expect(c.vec('dec', 'out', 4)).toBe('1000') // AB=11 -> out3
    c.set('en', ZERO)
    expect(c.vec('dec', 'out', 4)).toBe('XXXX')
    c.set('a', ZERO) // change while undetermined must not leak
    expect(c.vec('dec', 'out', 4)).toBe('XXXX')
    c.set('en', ONE)
    expect(c.vec('dec', 'out', 4)).toBe('0010') // AB=01 -> out1
    expect(c.oscillated).toBe(false)
  })

  it('MUX_4: B through a tristate; Z is X while the select floats and recovers afterwards', () => {
    const b = new CircuitBuilder()
      .switch('a', ZERO)
      .switch('b', ONE)
      .switch('en', ONE)
      .add('ts', ComponentType.TRISTATE_LEFT)
      .add('m', ComponentType.MUX_4)
      .wire(p('b', 'out'), p('ts', 'in'))
      .wire(p('en', 'out'), p('ts', 'ctl'))
      .wire(p('ts', 'out'), p('m', 'B'))
      .wire(p('a', 'out'), p('m', 'A'))
    for (const i of range(4)) b.switch(`i${i}`, i === 1 ? ONE : ZERO).wire(p(`i${i}`, 'out'), p('m', `in${i}`))
    const c = b.build()
    expect(c.pin(p('m', 'Z'))).toBe(ONE) // AB=01 -> in1 = 1
    c.set('en', ZERO)
    expect(c.pin(p('m', 'Z'))).toBe(X)
    c.set('i1', ZERO)
    c.set('i0', ONE)
    expect(c.pin(p('m', 'Z'))).toBe(X)
    c.set('en', ONE)
    expect(c.pin(p('m', 'Z'))).toBe(ZERO) // in1 is now 0
    c.set('b', ZERO)
    expect(c.pin(p('m', 'Z'))).toBe(ONE) // AB=00 -> in0 = 1
  })
})

// ---------------------------------------------------------------------------
// Composed circuits — the parts must agree with each other
// ---------------------------------------------------------------------------

describe('composition', () => {
  it('two FULL_ADDERs ripple into a correct 2-bit adder for all 32 inputs', () => {
    const c = new CircuitBuilder()
      .switch('x0')
      .switch('x1')
      .switch('y0')
      .switch('y1')
      .switch('cin')
      .add('fa0', ComponentType.FULL_ADDER)
      .add('fa1', ComponentType.FULL_ADDER)
      .wire(p('x0', 'out'), p('fa0', 'X'))
      .wire(p('y0', 'out'), p('fa0', 'Y'))
      .wire(p('cin', 'out'), p('fa0', 'Cin'))
      .wire(p('x1', 'out'), p('fa1', 'X'))
      .wire(p('y1', 'out'), p('fa1', 'Y'))
      .wire(p('fa0', 'Cout'), p('fa1', 'Cin'))
      .build()
    for (const [x0, x1, y0, y1, cin] of allCombos(5)) {
      c.setMany({ x0, x1, y0, y1, cin })
      const total = bit(x0) + 2 * bit(x1) + bit(y0) + 2 * bit(y1) + bit(cin)
      const label = `${bit(x1)}${bit(x0)}+${bit(y1)}${bit(y0)}+${bit(cin)}`
      expect(c.pin(p('fa0', 'Sum')), `S0 ${label}`).toBe(lv(total & 1))
      expect(c.pin(p('fa1', 'Sum')), `S1 ${label}`).toBe(lv((total >> 1) & 1))
      expect(c.pin(p('fa1', 'Cout')), `C2 ${label}`).toBe(lv((total >> 2) & 1))
    }
    expect(c.oscillated).toBe(false)
  })

  it('DECODER_2TO4 into MUX_4 with the same selects always yields 1 (index conventions agree)', () => {
    const c = new CircuitBuilder()
      .switch('A')
      .switch('B')
      .add('dec', ComponentType.DECODER_2TO4)
      .add('mux', ComponentType.MUX_4)
      .connect(p('A', 'out'), p('dec', 'A'), p('mux', 'A'))
      .connect(p('B', 'out'), p('dec', 'B'), p('mux', 'B'))
      .wire(p('dec', 'out0'), p('mux', 'in0'))
      .wire(p('dec', 'out1'), p('mux', 'in1'))
      .wire(p('dec', 'out2'), p('mux', 'in2'))
      .wire(p('dec', 'out3'), p('mux', 'in3'))
      .build()
    for (const [a, b] of allCombos(2)) {
      c.setMany({ A: a, B: b })
      expect(c.pin(p('mux', 'Z')), `AB=${a}${b}`).toBe(ONE)
    }
  })

  it('DECODER_2TO4 into MUX_4 with swapped selects yields 1 only when A == B', () => {
    const c = new CircuitBuilder()
      .switch('A')
      .switch('B')
      .add('dec', ComponentType.DECODER_2TO4)
      .add('mux', ComponentType.MUX_4)
      .connect(p('A', 'out'), p('dec', 'A'), p('mux', 'B'))
      .connect(p('B', 'out'), p('dec', 'B'), p('mux', 'A'))
      .wire(p('dec', 'out0'), p('mux', 'in0'))
      .wire(p('dec', 'out1'), p('mux', 'in1'))
      .wire(p('dec', 'out2'), p('mux', 'in2'))
      .wire(p('dec', 'out3'), p('mux', 'in3'))
      .build()
    for (const [a, b] of allCombos(2)) {
      c.setMany({ A: a, B: b })
      expect(c.pin(p('mux', 'Z')), `AB=${a}${b}`).toBe(a === b ? ONE : ZERO)
    }
  })

  it('DECODER_3TO8 into MUX_8 with the same selects always yields 1', () => {
    const b = new CircuitBuilder()
      .switch('A')
      .switch('B')
      .switch('C')
      .add('dec', ComponentType.DECODER_3TO8)
      .add('mux', ComponentType.MUX_8)
      .connect(p('A', 'out'), p('dec', 'A'), p('mux', 'A'))
      .connect(p('B', 'out'), p('dec', 'B'), p('mux', 'B'))
      .connect(p('C', 'out'), p('dec', 'C'), p('mux', 'C'))
    for (const i of range(8)) b.wire(p('dec', `out${i}`), p('mux', `in${i}`))
    const c = b.build()
    for (const [a, bb, cc] of allCombos(3)) {
      c.setMany({ A: a, B: bb, C: cc })
      expect(c.pin(p('mux', 'Z')), `ABC=${a}${bb}${cc}`).toBe(ONE)
    }
  })

  it('a MUX_8 equals a tree of two MUX_4 and one MUX_2 (A on the MUX_2, B/C on the MUX_4s)', () => {
    const b = new CircuitBuilder()
      .switch('A')
      .switch('B')
      .switch('C')
      .add('m8', ComponentType.MUX_8)
      .add('lo', ComponentType.MUX_4)
      .add('hi', ComponentType.MUX_4)
      .add('m2', ComponentType.MUX_2)
      .connect(p('A', 'out'), p('m8', 'A'), p('m2', 'A'))
      .connect(p('B', 'out'), p('m8', 'B'), p('lo', 'A'), p('hi', 'A'))
      .connect(p('C', 'out'), p('m8', 'C'), p('lo', 'B'), p('hi', 'B'))
      .wire(p('lo', 'Z'), p('m2', 'in0'))
      .wire(p('hi', 'Z'), p('m2', 'in1'))
    for (const i of range(8)) {
      b.switch(`i${i}`)
      b.connect(p(`i${i}`, 'out'), p('m8', `in${i}`), i < 4 ? p('lo', `in${i}`) : p('hi', `in${i - 4}`))
    }
    const c = b.build()
    for (const idx of range(8)) {
      for (const v of [ZERO, ONE]) {
        const sw: Record<string, LogicValue> = { A: lv((idx >> 2) & 1), B: lv((idx >> 1) & 1), C: lv(idx & 1) }
        for (const i of range(8)) sw[`i${i}`] = i === idx ? v : not(v)
        c.setMany(sw)
        expect(c.pin(p('m8', 'Z')), `m8 idx ${idx} v ${v}`).toBe(v)
        expect(c.pin(p('m2', 'Z')), `tree idx ${idx} v ${v}`).toBe(v)
      }
    }
    expect(c.oscillated).toBe(false)
  })

  it('a tristate bus with three drivers selected by a DECODER_2TO4 carries the selected source', () => {
    // out1..out3 of the decoder enable drivers d1..d3; out0 enables nothing -> bus Z.
    const b = new CircuitBuilder()
      .switch('A')
      .switch('B')
      .add('dec', ComponentType.DECODER_2TO4)
      .wire(p('A', 'out'), p('dec', 'A'))
      .wire(p('B', 'out'), p('dec', 'B'))
      .probe('bus')
    const values: LogicValue[] = [ZERO, ONE, ONE, ZERO]
    for (const i of [1, 2, 3]) {
      b.add(`d${i}`, ComponentType.TRISTATE_RIGHT)
        .switch(`v${i}`, values[i])
        .wire(p(`v${i}`, 'out'), p(`d${i}`, 'in'))
        .wire(p('dec', `out${i}`), p(`d${i}`, 'ctl'))
        .wire(p(`d${i}`, 'out'), p('bus', 'in'))
    }
    const c = b.build()
    expect(c.pin(p('bus', 'in'))).toBe(Z) // AB=00 -> no driver
    for (const i of [1, 2, 3]) {
      c.setMany({ A: lv(i >> 1), B: lv(i & 1) })
      expect(c.pin(p('bus', 'in')), `driver ${i}`).toBe(values[i])
    }
    c.set(`v3`, ONE) // still selecting driver 3
    expect(c.pin(p('bus', 'in'))).toBe(ONE)
    c.setMany({ A: ZERO, B: ZERO })
    expect(c.pin(p('bus', 'in'))).toBe(Z)
    expect(c.oscillated).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Wired-net resolution with more than two drivers (implementation decision 3)
// ---------------------------------------------------------------------------

describe('three tristates sharing one net', () => {
  /** d0..d2 (each with its own in/ctl switch) drive `bus`; all start enabled with 1. */
  function threeDrivers(): Circuit {
    const b = new CircuitBuilder().probe('bus')
    for (const i of range(3)) {
      b.add(`d${i}`, ComponentType.TRISTATE_RIGHT)
        .switch(`in${i}`, ONE)
        .switch(`ctl${i}`, ONE)
        .wire(p(`in${i}`, 'out'), p(`d${i}`, 'in'))
        .wire(p(`ctl${i}`, 'out'), p(`d${i}`, 'ctl'))
        .wire(p(`d${i}`, 'out'), p('bus', 'in'))
    }
    return b.build()
  }
  const bus = p('bus', 'in')

  it.each([ZERO, ONE])('all three enabled and agreeing on %s -> that value', (v) => {
    const c = threeDrivers()
    c.setMany({ in0: v, in1: v, in2: v })
    expect(c.pin(bus)).toBe(v)
  })

  it.each([ZERO, ONE])('two enabled agreeing on %s and the third released -> that value', (v) => {
    const c = threeDrivers()
    c.setMany({ in0: v, in1: v, in2: not(v), ctl2: ZERO })
    expect(c.pin(bus)).toBe(v)
  })

  it('two agree and the third disagrees -> X regardless of which one dissents', () => {
    const c = threeDrivers()
    for (const dissenter of range(3)) {
      const sw: Record<string, LogicValue> = { in0: ONE, in1: ONE, in2: ONE }
      sw[`in${dissenter}`] = ZERO
      c.setMany(sw)
      expect(c.pin(bus), `dissenter d${dissenter}`).toBe(X)
    }
  })

  it('only one enabled -> its value; none enabled -> Z', () => {
    const c = threeDrivers()
    c.setMany({ in0: ZERO, in1: ONE, in2: ONE, ctl0: ONE, ctl1: ZERO, ctl2: ZERO })
    expect(c.pin(bus)).toBe(ZERO)
    c.setMany({ ctl0: ZERO, ctl1: ONE })
    expect(c.pin(bus)).toBe(ONE)
    c.set('ctl1', ZERO)
    expect(c.pin(bus)).toBe(Z)
    expect(c.oscillated).toBe(false)
  })

  it('an X driver (ctl undetermined) poisons the net even when the other two agree', () => {
    const b = new CircuitBuilder().probe('bus').add('xsrc', ComponentType.NOT)
    for (const i of range(3)) {
      b.add(`d${i}`, ComponentType.TRISTATE_RIGHT)
        .switch(`in${i}`, ONE)
        .wire(p(`in${i}`, 'out'), p(`d${i}`, 'in'))
        .wire(p(`d${i}`, 'out'), p('bus', 'in'))
    }
    b.switch('ctl0', ONE).wire(p('ctl0', 'out'), p('d0', 'ctl'))
    b.switch('ctl1', ONE).wire(p('ctl1', 'out'), p('d1', 'ctl'))
    b.wire(p('xsrc', 'out'), p('d2', 'ctl'))
    const c = b.build()
    expect(c.pin(p('d2', 'out'))).toBe(X)
    expect(c.pin(bus)).toBe(X)
    c.setMany({ ctl0: ZERO, ctl1: ZERO })
    expect(c.pin(bus)).toBe(X)
  })
})

describe('constant sources sharing a net', () => {
  it('VCC and GROUND wired together -> X (disagreeing drivers)', () => {
    const c = new CircuitBuilder()
      .add('v', ComponentType.VCC)
      .add('g', ComponentType.GROUND)
      .probe('net')
      .add('inv', ComponentType.NOT)
      .connect(p('net', 'in'), p('v', 'out'), p('g', 'out'), p('inv', 'in1'))
      .build()
    expect(c.pin(p('net', 'in'))).toBe(X)
    expect(c.pin(p('inv', 'out'))).toBe(X)
    expect(trace(c, 'net')).toEqual([{ t: 0, v: X }])
  })

  it('two VCCs on one net -> 1, two GROUNDs -> 0', () => {
    const c = new CircuitBuilder()
      .add('v1', ComponentType.VCC)
      .add('v2', ComponentType.VCC)
      .add('g1', ComponentType.GROUND)
      .add('g2', ComponentType.GROUND)
      .probe('pv')
      .probe('pg')
      .connect(p('pv', 'in'), p('v1', 'out'), p('v2', 'out'))
      .connect(p('pg', 'in'), p('g1', 'out'), p('g2', 'out'))
      .build()
    expect(c.pin(p('pv', 'in'))).toBe(ONE)
    expect(c.pin(p('pg', 'in'))).toBe(ZERO)
  })

  it('a switch against GROUND: 0 agrees, 1 contends -> X', () => {
    const c = new CircuitBuilder()
      .switch('s', ZERO)
      .add('g', ComponentType.GROUND)
      .probe('net')
      .connect(p('net', 'in'), p('s', 'out'), p('g', 'out'))
      .build()
    expect(c.pin(p('net', 'in'))).toBe(ZERO)
    c.set('s', ONE)
    expect(c.pin(p('net', 'in'))).toBe(X)
    c.set('s', ZERO)
    expect(c.pin(p('net', 'in'))).toBe(ZERO)
    expect(trace(c, 'net').map((x) => x.v)).toEqual([ZERO, X, ZERO])
  })

  it('a disabled tristate on the same net as VCC leaves the net at 1; enabled with 0 it contends', () => {
    const c = new CircuitBuilder()
      .add('v', ComponentType.VCC)
      .add('g', ComponentType.GROUND)
      .add('ts', ComponentType.TRISTATE_DOWN)
      .switch('ctl', ZERO)
      .probe('net')
      .wire(p('g', 'out'), p('ts', 'in'))
      .wire(p('ctl', 'out'), p('ts', 'ctl'))
      .connect(p('net', 'in'), p('v', 'out'), p('ts', 'out'))
      .build()
    expect(c.pin(p('net', 'in'))).toBe(ONE)
    c.set('ctl', ONE)
    expect(c.pin(p('net', 'in'))).toBe(X)
    c.set('ctl', ZERO)
    expect(c.pin(p('net', 'in'))).toBe(ONE)
  })
})

// ---------------------------------------------------------------------------
// SWITCH / PROBE under same-instant and inertial rules (decisions 1, 2, 4, 12)
// ---------------------------------------------------------------------------

describe('SWITCH and PROBE event semantics', () => {
  it('toggling a switch twice before drain() cancels the pending change (inertial delay) and records nothing', () => {
    const c = new CircuitBuilder().switch('s', ZERO).probe('pr').wire(p('s', 'out'), p('pr', 'in')).build()
    expect(c.sim.toggle('s', false)).toBe(ONE)
    expect(c.sim.toggle('s', false)).toBe(ZERO)
    c.sim.drain()
    expect(c.pin(p('s', 'out'))).toBe(ZERO)
    expect(trace(c, 'pr')).toEqual([{ t: 0, v: ZERO }])
  })

  it('toggling a switch three times before drain() lands on the odd value with exactly one sample', () => {
    const c = new CircuitBuilder().switch('s', ZERO).probe('pr').wire(p('s', 'out'), p('pr', 'in')).build()
    c.sim.toggle('s', false)
    c.sim.toggle('s', false)
    expect(c.sim.toggle('s', false)).toBe(ONE)
    c.sim.drain()
    expect(c.pin(p('s', 'out'))).toBe(ONE)
    expect(trace(c, 'pr')).toEqual([
      { t: 0, v: ZERO },
      { t: 1, v: ONE }
    ])
  })

  it('a probe on a net that only settles during reset shows the settled value as its single t=0 sample', () => {
    // switch -> NOT -> NOT -> probe: two delays of settling happen inside reset, yet the
    // trace starts at t=0 with the final value and no intermediate X samples.
    const c = new CircuitBuilder()
      .switch('s', ONE)
      .add('n1', ComponentType.NOT)
      .add('n2', ComponentType.NOT)
      .probe('pr')
      .wire(p('s', 'out'), p('n1', 'in1'))
      .wire(p('n1', 'out'), p('n2', 'in1'))
      .wire(p('n2', 'out'), p('pr', 'in'))
      .build()
    expect(c.time).toBe(0)
    expect(trace(c, 'pr')).toEqual([{ t: 0, v: ONE }])
    c.set('s', ZERO)
    expect(trace(c, 'pr')).toEqual([
      { t: 0, v: ONE },
      { t: 3, v: ZERO }
    ])
  })

  it('two switches toggled in one setMany reach a FULL_ADDER in the same instant: one output sample each', () => {
    const c = new CircuitBuilder()
      .switch('x', ZERO)
      .switch('y', ZERO)
      .switch('cin', ZERO)
      .add('fa', ComponentType.FULL_ADDER)
      .probe('ps')
      .probe('pc')
      .wire(p('x', 'out'), p('fa', 'X'))
      .wire(p('y', 'out'), p('fa', 'Y'))
      .wire(p('cin', 'out'), p('fa', 'Cin'))
      .wire(p('fa', 'Sum'), p('ps', 'in'))
      .wire(p('fa', 'Cout'), p('pc', 'in'))
      .build()
    c.setMany({ x: ONE, y: ONE }) // 0+0 -> 1+1: Sum stays 0, Cout 0 -> 1
    expect(trace(c, 'ps')).toEqual([{ t: 0, v: ZERO }])
    expect(trace(c, 'pc')).toEqual([
      { t: 0, v: ZERO },
      { t: 2, v: ONE }
    ])
    expect(c.time).toBe(2)
  })

  it('toggle() on a switch whose id was absent from switchValues alternates 1, 0, 1', () => {
    const c = new CircuitBuilder().add('s', ComponentType.SWITCH).probe('pr').wire(p('s', 'out'), p('pr', 'in')).build()
    expect(trace(c, 'pr')).toEqual([{ t: 0, v: ZERO }])
    expect(c.sim.toggle('s')).toBe(ONE)
    expect(c.sim.toggle('s')).toBe(ZERO)
    expect(c.sim.toggle('s')).toBe(ONE)
    expect(trace(c, 'pr').map((x) => x.v)).toEqual([ZERO, ONE, ZERO, ONE])
  })
})
