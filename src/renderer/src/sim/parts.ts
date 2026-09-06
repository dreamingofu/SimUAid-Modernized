// Pure behavior of the non-gate parts (reference manual Appendix A). Every function
// maps input logic values to output logic values with no simulator state, so the
// engine only reads pins, calls these, and schedules the results. Vectors are
// LSB-first; select inputs are listed MSB-first (A is the most significant).

import { ComponentType, LogicValue } from '../model/types'
import { termsMatch, type CompiledSmRow } from './stateMachine'
import { clean, complement, known, knownVec, numToVec, vecToNum, xVec, zVec } from './values'

const { ZERO, ONE, X } = LogicValue

export type PinReader = (pinName: string) => LogicValue

/** Select pin names, MSB first: decoders use A,B(,C); muxes use A(,B,C). */
export const SELECT_PIN_NAMES = ['A', 'B', 'C'] as const

const SELECT_COUNT: Partial<Record<ComponentType, number>> = {
  [ComponentType.DECODER_2TO4]: 2,
  [ComponentType.DECODER_3TO8]: 3,
  [ComponentType.MUX_2]: 1,
  [ComponentType.MUX_4]: 2,
  [ComponentType.MUX_8]: 3
}

/** Names of the select pins a decoder/mux type reads, MSB first. */
export function selectPinsOf(type: ComponentType): string[] {
  return SELECT_PIN_NAMES.slice(0, SELECT_COUNT[type] ?? 0)
}

/** MSB-first select bits -> index, or null when any bit is undetermined. */
export function selectIndex(bits: LogicValue[]): number | null {
  let index = 0
  for (const v of bits) {
    if (!clean(v)) return null
    index = index * 2 + (v === ONE ? 1 : 0)
  }
  return index
}

/** One-hot decode: output `index` is 1, the rest 0; any bad select -> all X. */
export function evalDecoder(selects: LogicValue[]): LogicValue[] {
  const outputs = 1 << selects.length
  const index = selectIndex(selects)
  if (index === null) return xVec(outputs)
  const out: LogicValue[] = []
  for (let i = 0; i < outputs; i++) out.push(i === index ? ONE : ZERO)
  return out
}

/** Routes input `index` to the output; bad select or undetermined input -> X. */
export function evalMux(selects: LogicValue[], input: (index: number) => LogicValue): LogicValue {
  const index = selectIndex(selects)
  return index === null ? X : known(input(index))
}

/** ctl=1 passes the inputs, ctl=0 releases every output (Z), otherwise X. */
export function evalTristate(ctl: LogicValue, inputs: LogicValue[]): LogicValue[] {
  if (ctl === ZERO) return zVec(inputs.length)
  if (ctl === ONE) return knownVec(inputs)
  return xVec(inputs.length)
}

/** x + y + cin over n bits (n = 1 is the full adder); any undetermined input -> all X. */
export function evalAdder(x: LogicValue[], y: LogicValue[], cin: LogicValue): { sum: LogicValue[]; cout: LogicValue } {
  const n = x.length
  const xn = vecToNum(x)
  const yn = vecToNum(y)
  if (xn === null || yn === null || !clean(cin)) return { sum: xVec(n), cout: X }
  const total = xn + yn + (cin === ONE ? 1 : 0)
  return { sum: numToVec(total, n), cout: total >> n ? ONE : ZERO }
}

/** S=0 selects the left set (x), S=1 the right set (y); S undetermined -> all X. */
export function evalMux2to1(s: LogicValue, x: LogicValue[], y: LogicValue[]): LogicValue[] {
  if (s === ZERO) return knownVec(x)
  if (s === ONE) return knownVec(y)
  return xVec(x.length)
}

/** en=1 -> bitwise complement, en=0 -> pass-through, otherwise all X. */
export function evalComplementer(en: LogicValue, vec: LogicValue[]): LogicValue[] {
  if (en === ONE) return vec.map((v) => (clean(v) ? complement(v) : X))
  if (en === ZERO) return vec
  return xVec(vec.length)
}

/**
 * Bits [tapStart, tapStart + bits) of a bus. An unconnected tap (null) drives Z;
 * bits beyond the bus width are X.
 */
export function evalBusTap(bus: LogicValue[] | null, tapStart: number, bits: number): LogicValue[] {
  if (bus === null) return zVec(bits)
  const slice: LogicValue[] = []
  for (let i = 0; i < bits; i++) {
    const idx = tapStart + i
    slice.push(idx < bus.length ? bus[idx] : X)
  }
  return slice
}

/** Counter K output: 1 when every bit is 1, X when the state is undetermined. */
export function counterCarry(state: LogicValue[]): LogicValue {
  const num = vecToNum(state)
  if (num === null) return X
  return num === (1 << state.length) - 1 ? ONE : ZERO
}

function increment(state: LogicValue[]): LogicValue[] {
  const num = vecToNum(state)
  return num === null ? xVec(state.length) : numToVec(num + 1, state.length)
}

/**
 * State after a rising clock edge for the clocked N-bit parts (Appendix A).
 * Controls are evaluated in priority order and an undetermined control that
 * would decide the outcome makes the whole state X; lower-priority controls are
 * not consulted, so X/Z on them is harmless.
 *   Counter:          CLR=0 clears, else En=1 increments (CLR, Ld active low).
 *   Loadable counter: CLR=0 clears, else Ld=0 loads D, else En=1 increments.
 *   Register:         CLR=1 clears, else Ld=1 loads D, else holds (active high).
 *   Shift registers:  CLR=1 clears, else Ld=1 loads, else LS=1 shifts left
 *                     (Rin -> bit 0), else RS=1 shifts right (Lin -> bit n-1).
 */
export function nextRegisterState(
  type: ComponentType,
  state: LogicValue[],
  pin: PinReader,
  readD: () => LogicValue[]
): LogicValue[] {
  const n = state.length
  const load = (): LogicValue[] => knownVec(readD())

  switch (type) {
    case ComponentType.N_COUNTER:
    case ComponentType.N_LOADABLE_COUNTER: {
      const clr = pin('CLR')
      if (!clean(clr)) return xVec(n)
      if (clr === ZERO) return numToVec(0, n)
      if (type === ComponentType.N_LOADABLE_COUNTER) {
        const ld = pin('Ld')
        if (!clean(ld)) return xVec(n)
        if (ld === ZERO) return load()
      }
      const en = pin('En')
      if (!clean(en)) return xVec(n)
      return en === ONE ? increment(state) : state
    }

    case ComponentType.N_REGISTER:
    case ComponentType.N_SHIFT_LEFT:
    case ComponentType.N_SHIFT_RIGHT:
    case ComponentType.N_SHIFT_BIDIR: {
      const clr = pin('CLR')
      if (!clean(clr)) return xVec(n)
      if (clr === ONE) return numToVec(0, n)
      const ld = pin('Ld')
      if (!clean(ld)) return xVec(n)
      if (ld === ONE) return load()
      if (type === ComponentType.N_REGISTER) return state

      if (type !== ComponentType.N_SHIFT_RIGHT) {
        const ls = pin('LS')
        if (!clean(ls)) return xVec(n)
        if (ls === ONE) return [known(pin('Rin')), ...state.slice(0, n - 1)]
      }
      if (type !== ComponentType.N_SHIFT_LEFT) {
        const rs = pin('RS')
        if (!clean(rs)) return xVec(n)
        if (rs === ONE) return [...state.slice(1), known(pin('Lin'))]
      }
      return state
    }

    default:
      return state
  }
}

/** The state a state machine starts in: its first table row's present state. */
export function initialSmState(rows: CompiledSmRow[]): number {
  return rows.length > 0 ? rows[0].present : 0
}

/**
 * Active row for `state` given the current inputs: the first matching row in
 * table order; null when a row's inputs are undetermined and no earlier row
 * matched; undefined when no row matches.
 */
export function activeSmRow(
  rows: CompiledSmRow[],
  state: number,
  readPin: PinReader
): CompiledSmRow | null | undefined {
  let sawUnresolved = false
  for (const row of rows) {
    if (row.present !== state) continue
    const match = termsMatch(row.terms, readPin)
    if (match === true) return row
    if (match === null) sawUnresolved = true
  }
  return sawUnresolved ? null : undefined
}

/** Mealy outputs: the active row's listed outputs are 1, the rest 0; no active row -> X. */
export function smOutputValue(active: CompiledSmRow | null | undefined, pinName: string): LogicValue {
  if (!active) return X
  return active.highOutputs.includes(pinName) ? ONE : ZERO
}
