// Part-definition registry. Fixed-width parts are static entries; N-bit parts are
// built per-instance from `Component.bits` via defOf(). All geometry is grid-
// aligned (GRID = 10, data-pin pitch 20) so pins land on grid intersections.

import { ComponentType, type Component } from './types'

export type PinRole = 'input' | 'output' | 'clock' | 'preset' | 'clear'

export interface PinDef {
  name: string
  role: PinRole
  dx: number
  dy: number
  /** Bus pins carry this many bits; absent means a single-bit (net) pin. */
  width?: number
}

export interface PartDefinition {
  pins: PinDef[]
  width: number
  height: number
  defaultLabelPrefix: string
  /** Title text rendered inside box-style symbols. */
  title?: string
}

export const MIN_BITS = 2
export const MAX_BITS = 16
export const MAX_BUS_BITS = 32
export const DEFAULT_BITS = 4

const GATE_WIDTH = 60
const PITCH = 20

function gate(arity: number, prefix = 'U'): PartDefinition {
  const height = (arity + 1) * PITCH
  const pins: PinDef[] = []
  for (let i = 0; i < arity; i++) {
    pins.push({ name: `in${i + 1}`, role: 'input', dx: 0, dy: (i + 1) * PITCH })
  }
  pins.push({ name: 'out', role: 'output', dx: GATE_WIDTH, dy: height / 2 })
  return { pins, width: GATE_WIDTH, height, defaultLabelPrefix: prefix }
}

function source(prefix: string): PartDefinition {
  return {
    width: 40,
    height: 40,
    defaultLabelPrefix: prefix,
    pins: [{ name: 'out', role: 'output', dx: 40, dy: 20 }]
  }
}

function sink(prefix: string): PartDefinition {
  return {
    width: 40,
    height: 40,
    defaultLabelPrefix: prefix,
    pins: [{ name: 'in', role: 'input', dx: 0, dy: 20 }]
  }
}

function dFlipFlop(): PartDefinition {
  return {
    width: 60,
    height: 80,
    defaultLabelPrefix: 'FF',
    pins: [
      { name: 'D', role: 'input', dx: 0, dy: 20 },
      { name: 'CLK', role: 'clock', dx: 0, dy: 60 },
      { name: 'S', role: 'preset', dx: 30, dy: 0 },
      { name: 'R', role: 'clear', dx: 30, dy: 80 },
      { name: 'Q', role: 'output', dx: 60, dy: 20 },
      { name: "Q'", role: 'output', dx: 60, dy: 60 }
    ]
  }
}

function jkFlipFlop(): PartDefinition {
  return {
    width: 60,
    height: 80,
    defaultLabelPrefix: 'FF',
    pins: [
      { name: 'J', role: 'input', dx: 0, dy: 20 },
      { name: 'CLK', role: 'clock', dx: 0, dy: 40 },
      { name: 'K', role: 'input', dx: 0, dy: 60 },
      { name: 'S', role: 'preset', dx: 30, dy: 0 },
      { name: 'R', role: 'clear', dx: 30, dy: 80 },
      { name: 'Q', role: 'output', dx: 60, dy: 20 },
      { name: "Q'", role: 'output', dx: 60, dy: 60 }
    ]
  }
}

function fullAdder(): PartDefinition {
  return {
    width: 80,
    height: 60,
    defaultLabelPrefix: 'FA',
    title: 'F A',
    pins: [
      { name: 'X', role: 'input', dx: 20, dy: 60 },
      { name: 'Y', role: 'input', dx: 60, dy: 60 },
      { name: 'Cin', role: 'input', dx: 80, dy: 30 },
      { name: 'Cout', role: 'output', dx: 0, dy: 30 },
      { name: 'Sum', role: 'output', dx: 40, dy: 0 }
    ]
  }
}

function decoder(selects: number): PartDefinition {
  const outputs = 1 << selects
  const height = (outputs + 1) * PITCH
  const pins: PinDef[] = []
  const selNames = ['A', 'B', 'C']
  for (let i = 0; i < selects; i++) {
    pins.push({ name: selNames[i], role: 'input', dx: 0, dy: (i + 1) * PITCH })
  }
  for (let i = 0; i < outputs; i++) {
    pins.push({ name: `out${i}`, role: 'output', dx: 80, dy: (i + 1) * PITCH })
  }
  return { pins, width: 80, height, defaultLabelPrefix: 'DEC', title: 'Decoder' }
}

function mux(inputs: number): PartDefinition {
  const selects = Math.log2(inputs)
  const height = (inputs + 1) * PITCH
  const width = 80
  const pins: PinDef[] = []
  for (let i = 0; i < inputs; i++) {
    pins.push({ name: `in${i}`, role: 'input', dx: 0, dy: (i + 1) * PITCH })
  }
  const selNames = ['A', 'B', 'C']
  for (let i = 0; i < selects; i++) {
    pins.push({ name: selNames[i], role: 'input', dx: (i + 1) * PITCH + 20, dy: height })
  }
  pins.push({ name: 'Z', role: 'output', dx: width, dy: height / 2 })
  return { pins, width, height, defaultLabelPrefix: 'MUX', title: 'Mux' }
}

function sevenSegment(): PartDefinition {
  const pins: PinDef[] = []
  for (let i = 1; i <= 7; i++) {
    pins.push({ name: String(i), role: 'input', dx: 0, dy: i * PITCH })
  }
  return { pins, width: 80, height: 160, defaultLabelPrefix: 'SEG' }
}

function tristate(orientation: 'right' | 'left' | 'up' | 'down'): PartDefinition {
  const pins: PinDef[] =
    orientation === 'right'
      ? [
          { name: 'in', role: 'input', dx: 0, dy: 20 },
          { name: 'ctl', role: 'input', dx: 20, dy: 0 },
          { name: 'out', role: 'output', dx: 40, dy: 20 }
        ]
      : orientation === 'left'
        ? [
            { name: 'in', role: 'input', dx: 40, dy: 20 },
            { name: 'ctl', role: 'input', dx: 20, dy: 0 },
            { name: 'out', role: 'output', dx: 0, dy: 20 }
          ]
        : orientation === 'up'
          ? [
              { name: 'in', role: 'input', dx: 20, dy: 40 },
              { name: 'ctl', role: 'input', dx: 0, dy: 20 },
              { name: 'out', role: 'output', dx: 20, dy: 0 }
            ]
          : [
              { name: 'in', role: 'input', dx: 20, dy: 0 },
              { name: 'ctl', role: 'input', dx: 0, dy: 20 },
              { name: 'out', role: 'output', dx: 20, dy: 40 }
            ]
  return { pins, width: 40, height: 40, defaultLabelPrefix: 'TS' }
}

// --- N-bit builders. Data pin i sits at dx = (i+1)*PITCH; bit 0 is the LSB. ---

function row(prefix: string, n: number, role: PinRole, dy: number, offset = 0): PinDef[] {
  const pins: PinDef[] = []
  for (let i = 0; i < n; i++) {
    pins.push({ name: `${prefix}${i}`, role, dx: (offset + i + 1) * PITCH, dy })
  }
  return pins
}

function nAdder(n: number): PartDefinition {
  const width = (2 * n + 2) * PITCH
  const height = 80
  return {
    width,
    height,
    defaultLabelPrefix: 'ADD',
    title: `Adder ${n}`,
    pins: [
      ...row('X', n, 'input', height),
      ...row('Y', n, 'input', height, n),
      ...row('S', n, 'output', 0),
      { name: 'Cout', role: 'output', dx: 0, dy: 40 },
      { name: 'Cin', role: 'input', dx: width, dy: 40 }
    ]
  }
}

function nCounter(n: number, loadable: boolean): PartDefinition {
  const width = Math.max((n + 1) * PITCH, 120)
  const height = loadable ? 100 : 80
  const pins: PinDef[] = [
    ...row('Q', n, 'output', 0),
    { name: 'K', role: 'output', dx: width, dy: 20 },
    { name: 'En', role: 'input', dx: width, dy: 40 },
    { name: 'CLK', role: 'clock', dx: 0, dy: height - 20 }
  ]
  if (loadable) {
    pins.push(
      ...row('D', n, 'input', height),
      { name: 'Ld', role: 'input', dx: width, dy: 60 },
      { name: 'CLR', role: 'input', dx: width, dy: 80 }
    )
  } else {
    pins.push({ name: 'CLR', role: 'input', dx: width, dy: 60 })
  }
  return {
    width,
    height,
    defaultLabelPrefix: 'CTR',
    title: `Counter ${n}`,
    pins
  }
}

function nRegister(n: number): PartDefinition {
  const width = Math.max((n + 1) * PITCH, 120)
  const height = 80
  return {
    width,
    height,
    defaultLabelPrefix: 'REG',
    title: `Register ${n}`,
    pins: [
      ...row('D', n, 'input', height),
      ...row('Q', n, 'output', 0),
      { name: 'Ld', role: 'input', dx: width, dy: 20 },
      { name: 'CLR', role: 'input', dx: width, dy: 40 },
      { name: 'CLK', role: 'clock', dx: 0, dy: height - 20 }
    ]
  }
}

function nShift(n: number, kind: 'left' | 'right' | 'bidir'): PartDefinition {
  const width = Math.max((n + 1) * PITCH, 140)
  const height = 100
  const title = kind === 'left' ? `Left SR ${n}` : kind === 'right' ? `Right SR ${n}` : `Bidir SR ${n}`
  const pins: PinDef[] = [
    ...row('D', n, 'input', height),
    ...row('Q', n, 'output', 0),
    { name: 'Ld', role: 'input', dx: 0, dy: 20 },
    { name: 'CLR', role: 'input', dx: 0, dy: 40 },
    { name: 'CLK', role: 'clock', dx: 0, dy: height - 20 }
  ]
  if (kind === 'left' || kind === 'bidir') {
    pins.push({ name: 'LS', role: 'input', dx: 0, dy: 60 })
    pins.push({ name: 'Rin', role: 'input', dx: width, dy: 40 })
  }
  if (kind === 'right' || kind === 'bidir') {
    pins.push({ name: 'RS', role: 'input', dx: width, dy: 60 })
    pins.push({ name: 'Lin', role: 'input', dx: kind === 'bidir' ? 0 : 0, dy: 80 })
  }
  if (kind === 'right') {
    // Right SR keeps Ld/CLR on the right edge per the manual.
    for (const p of pins) {
      if (p.name === 'Ld' || p.name === 'CLR') p.dx = width
    }
  }
  return { width, height, defaultLabelPrefix: 'SR', title, pins }
}

function nMux2to1(n: number): PartDefinition {
  const width = (2 * n + 2) * PITCH
  const height = 60
  return {
    width,
    height,
    defaultLabelPrefix: 'MUX',
    title: `2-to-1 Mux ${n}`,
    pins: [
      ...row('X', n, 'input', height),
      ...row('Y', n, 'input', height, n),
      ...row('Z', n, 'output', 0),
      { name: 'S', role: 'input', dx: 0, dy: 20 }
    ]
  }
}

function nTristate(n: number): PartDefinition {
  const width = Math.max((n + 1) * PITCH, 100)
  return {
    width,
    height: 60,
    defaultLabelPrefix: 'TS',
    title: `Tristate ${n}`,
    pins: [
      ...row('in', n, 'input', 60),
      ...row('out', n, 'output', 0),
      { name: 'ctl', role: 'input', dx: 0, dy: 20 }
    ]
  }
}

// --- Bus parts: a single pin carries the whole n-bit vector. ---

function busInput(n: number): PartDefinition {
  return {
    width: 60,
    height: 40,
    defaultLabelPrefix: 'BI',
    pins: [{ name: 'out', role: 'output', dx: 60, dy: 20, width: n }]
  }
}

function busProbe(n: number): PartDefinition {
  return {
    width: 60,
    height: 40,
    defaultLabelPrefix: 'BP',
    pins: [{ name: 'in', role: 'input', dx: 0, dy: 20, width: n }]
  }
}

function splitter(n: number): PartDefinition {
  const width = (n + 1) * PITCH
  return {
    width,
    height: 20,
    defaultLabelPrefix: 'SPL',
    pins: [
      ...row('out', n, 'output', 0),
      { name: 'in', role: 'input', dx: Math.round(width / 2 / 10) * 10, dy: 20, width: n }
    ]
  }
}

function merger(n: number): PartDefinition {
  const width = (n + 1) * PITCH
  return {
    width,
    height: 20,
    defaultLabelPrefix: 'MRG',
    pins: [
      ...row('in', n, 'input', 20),
      { name: 'out', role: 'output', dx: Math.round(width / 2 / 10) * 10, dy: 0, width: n }
    ]
  }
}

function stateMachine(nIn: number, nOut: number): PartDefinition {
  const height = (nIn + nOut + 2) * PITCH
  const width = 140
  const pins: PinDef[] = []
  for (let i = 1; i <= nOut; i++) {
    pins.push({ name: `out${i}`, role: 'output', dx: 0, dy: i * PITCH })
  }
  for (let i = 1; i <= nIn; i++) {
    pins.push({ name: `in${i}`, role: 'input', dx: 0, dy: (nOut + 1 + i) * PITCH })
  }
  pins.push({ name: 'CLK', role: 'clock', dx: width, dy: height - PITCH })
  return { pins, width, height, defaultLabelPrefix: 'SM', title: 'State Machine' }
}

function checker(): PartDefinition {
  return {
    width: 100,
    height: 60,
    defaultLabelPrefix: 'CHK',
    title: 'Checker',
    pins: [
      { name: 'in', role: 'input', dx: 0, dy: 30 },
      { name: 'out', role: 'output', dx: 100, dy: 30 }
    ]
  }
}

function busTap(n: number): PartDefinition {
  return {
    width: 40,
    height: 20,
    defaultLabelPrefix: 'TAP',
    pins: [
      { name: 'in', role: 'input', dx: 20, dy: 20 },
      { name: 'out', role: 'output', dx: 20, dy: 0, ...(n > 1 ? { width: n } : {}) }
    ]
  }
}

function complementer(n: number): PartDefinition {
  return {
    width: 120,
    height: 60,
    defaultLabelPrefix: 'CMP',
    title: `Complementer ${n}`,
    pins: [
      { name: 'in', role: 'input', dx: 60, dy: 60, width: n },
      { name: 'out', role: 'output', dx: 60, dy: 0, width: n },
      { name: 'en', role: 'input', dx: 0, dy: 30 }
    ]
  }
}

const FIXED: Partial<Record<ComponentType, PartDefinition>> = {
  [ComponentType.AND2]: gate(2),
  [ComponentType.AND3]: gate(3),
  [ComponentType.AND4]: gate(4),
  [ComponentType.AND5]: gate(5),
  [ComponentType.OR2]: gate(2),
  [ComponentType.OR3]: gate(3),
  [ComponentType.OR4]: gate(4),
  [ComponentType.OR5]: gate(5),
  [ComponentType.NAND2]: gate(2),
  [ComponentType.NAND3]: gate(3),
  [ComponentType.NAND4]: gate(4),
  [ComponentType.NAND5]: gate(5),
  [ComponentType.NOR2]: gate(2),
  [ComponentType.NOR3]: gate(3),
  [ComponentType.NOR4]: gate(4),
  [ComponentType.NOR5]: gate(5),
  [ComponentType.XOR2]: gate(2),
  [ComponentType.XNOR2]: gate(2),
  [ComponentType.NOT]: gate(1),
  [ComponentType.SWITCH]: source('SW'),
  [ComponentType.PROBE]: sink('P'),
  [ComponentType.D_FLIPFLOP]: dFlipFlop(),
  [ComponentType.JK_FLIPFLOP]: jkFlipFlop(),
  [ComponentType.CLOCK]: source('CLK'),
  [ComponentType.INPUT_SIGNAL]: source('IN'),
  [ComponentType.FULL_ADDER]: fullAdder(),
  [ComponentType.DECODER_2TO4]: decoder(2),
  [ComponentType.DECODER_3TO8]: decoder(3),
  [ComponentType.MUX_2]: mux(2),
  [ComponentType.MUX_4]: mux(4),
  [ComponentType.MUX_8]: mux(8),
  [ComponentType.SEVEN_SEGMENT]: sevenSegment(),
  [ComponentType.TRISTATE_RIGHT]: tristate('right'),
  [ComponentType.TRISTATE_LEFT]: tristate('left'),
  [ComponentType.TRISTATE_UP]: tristate('up'),
  [ComponentType.TRISTATE_DOWN]: tristate('down'),
  [ComponentType.VCC]: source('V'),
  [ComponentType.GROUND]: source('GND'),
  [ComponentType.CHECKER]: checker()
}

const N_BIT_BUILDERS: Partial<Record<ComponentType, (n: number) => PartDefinition>> = {
  [ComponentType.N_ADDER]: nAdder,
  [ComponentType.N_COUNTER]: (n) => nCounter(n, false),
  [ComponentType.N_LOADABLE_COUNTER]: (n) => nCounter(n, true),
  [ComponentType.N_REGISTER]: nRegister,
  [ComponentType.N_SHIFT_LEFT]: (n) => nShift(n, 'left'),
  [ComponentType.N_SHIFT_RIGHT]: (n) => nShift(n, 'right'),
  [ComponentType.N_SHIFT_BIDIR]: (n) => nShift(n, 'bidir'),
  [ComponentType.N_MUX_2TO1]: nMux2to1,
  [ComponentType.N_TRISTATE]: nTristate
}

const BUS_BUILDERS: Partial<Record<ComponentType, (n: number) => PartDefinition>> = {
  [ComponentType.BUS_INPUT]: busInput,
  [ComponentType.BUS_PROBE]: busProbe,
  [ComponentType.SPLITTER]: splitter,
  [ComponentType.MERGER]: merger,
  [ComponentType.COMPLEMENTER]: complementer,
  [ComponentType.BUS_TAP]: busTap
}

// Parameterized definitions are cached per (type, bits) since builders are pure.
const nBitCache = new Map<string, PartDefinition>()

export function isNBitType(type: ComponentType): boolean {
  return type in N_BIT_BUILDERS
}

export function isBusType(type: ComponentType): boolean {
  return type in BUS_BUILDERS
}

export function maxBitsFor(type: ComponentType): number {
  return isBusType(type) ? MAX_BUS_BITS : MAX_BITS
}

export function getPartDefinition(type: ComponentType, bits?: number): PartDefinition {
  if (type === ComponentType.STATE_MACHINE) {
    return defOf({ type, smInputs: undefined, smOutputs: undefined })
  }
  const builder = N_BIT_BUILDERS[type] ?? BUS_BUILDERS[type]
  if (builder) {
    const minBits = type === ComponentType.BUS_TAP ? 1 : MIN_BITS
    const n = Math.min(maxBitsFor(type), Math.max(minBits, bits ?? DEFAULT_BITS))
    const key = `${type}:${n}`
    let def = nBitCache.get(key)
    if (!def) {
      def = builder(n)
      nBitCache.set(key, def)
    }
    return def
  }
  return FIXED[type]!
}

export function defOf(c: Pick<Component, 'type' | 'bits' | 'smInputs' | 'smOutputs'>): PartDefinition {
  if (c.type === ComponentType.STATE_MACHINE) {
    const nIn = Math.min(8, Math.max(1, c.smInputs ?? 4))
    const nOut = Math.min(8, Math.max(1, c.smOutputs ?? 4))
    const key = `SM:${nIn}:${nOut}`
    let def = nBitCache.get(key)
    if (!def) {
      def = stateMachine(nIn, nOut)
      nBitCache.set(key, def)
    }
    return def
  }
  return getPartDefinition(c.type, c.bits)
}
