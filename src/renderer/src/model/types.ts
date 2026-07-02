// Core data model for SimUaid. Phase 1 defines the types only — no simulation
// logic. The set of component types is the Phase 1 subset; the part-definition
// registry (see partDefinitions.ts) is structured so the full catalog from the
// reference manual (N-bit parts, buses, state machines, …) can be added later
// without changing these interfaces.

export enum ComponentType {
  AND2 = 'AND2',
  AND3 = 'AND3',
  AND4 = 'AND4',
  AND5 = 'AND5',
  OR2 = 'OR2',
  OR3 = 'OR3',
  OR4 = 'OR4',
  OR5 = 'OR5',
  NAND2 = 'NAND2',
  NAND3 = 'NAND3',
  NAND4 = 'NAND4',
  NAND5 = 'NAND5',
  NOR2 = 'NOR2',
  NOR3 = 'NOR3',
  NOR4 = 'NOR4',
  NOR5 = 'NOR5',
  XOR2 = 'XOR2',
  XNOR2 = 'XNOR2',
  NOT = 'NOT',
  SWITCH = 'SWITCH',
  PROBE = 'PROBE',
  D_FLIPFLOP = 'D_FLIPFLOP',
  JK_FLIPFLOP = 'JK_FLIPFLOP',
  CLOCK = 'CLOCK',
  INPUT_SIGNAL = 'INPUT_SIGNAL',
  FULL_ADDER = 'FULL_ADDER',
  DECODER_2TO4 = 'DECODER_2TO4',
  DECODER_3TO8 = 'DECODER_3TO8',
  MUX_2 = 'MUX_2',
  MUX_4 = 'MUX_4',
  MUX_8 = 'MUX_8',
  SEVEN_SEGMENT = 'SEVEN_SEGMENT',
  TRISTATE_RIGHT = 'TRISTATE_RIGHT',
  TRISTATE_LEFT = 'TRISTATE_LEFT',
  TRISTATE_UP = 'TRISTATE_UP',
  TRISTATE_DOWN = 'TRISTATE_DOWN',
  VCC = 'VCC',
  GROUND = 'GROUND',
  N_ADDER = 'N_ADDER',
  N_COUNTER = 'N_COUNTER',
  N_LOADABLE_COUNTER = 'N_LOADABLE_COUNTER',
  N_REGISTER = 'N_REGISTER',
  N_SHIFT_LEFT = 'N_SHIFT_LEFT',
  N_SHIFT_RIGHT = 'N_SHIFT_RIGHT',
  N_SHIFT_BIDIR = 'N_SHIFT_BIDIR',
  N_MUX_2TO1 = 'N_MUX_2TO1',
  N_TRISTATE = 'N_TRISTATE',
  BUS_INPUT = 'BUS_INPUT',
  BUS_PROBE = 'BUS_PROBE',
  SPLITTER = 'SPLITTER',
  MERGER = 'MERGER',
  COMPLEMENTER = 'COMPLEMENTER',
  BUS_TAP = 'BUS_TAP',
  STATE_MACHINE = 'STATE_MACHINE',
  CHECKER = 'CHECKER'
}

/** The four logic values a signal can carry (reference manual §1.9). */
export enum LogicValue {
  ZERO = '0',
  ONE = '1',
  /** High-impedance: terminal has no connection. */
  Z = 'Z',
  /** Undetermined: an input was undetermined or not connected. */
  X = 'X'
}

/** Simulator modes (reference manual Appendix B). */
export enum SimMode {
  LIVE = 'LIVE',
  CLOCK = 'CLOCK',
  CHANGE = 'CHANGE'
}

/**
 * Stable identifier for a single pin on a placed component, of the form
 * `${componentId}#${pinName}`. Wires reference pins by this id.
 */
export type PinId = string

export function makePinId(componentId: string, pinName: string): PinId {
  return `${componentId}#${pinName}`
}

/** Splits a PinId back into its component id and pin name. */
export function parsePinId(pinId: PinId): { componentId: string; pinName: string } {
  const i = pinId.indexOf('#')
  return { componentId: pinId.slice(0, i), pinName: pinId.slice(i + 1) }
}

/**
 * Resolves the current logic value at a pin. Phase 2 always returns Z (no
 * simulation); Phase 3 will supply a real resolver backed by the simulator.
 */
export type PinValueResolver = (pinId: PinId) => LogicValue

/** 'R' repeats the waveform from time 0; otherwise a driven logic level. */
export type SignalValue = LogicValue | 'R'

export interface SignalRow {
  timeNs: number
  value: SignalValue
}

/** One state-table row, kept as the user's raw text; compiled by the simulator. */
export interface SmRow {
  present: string
  input: string
  output: string
  next: string
}

export interface Component {
  id: string
  type: ComponentType
  x: number
  y: number
  /** Rotation in degrees; default 0. */
  rotation: number
  /** Device label (e.g. "Gate1"); empty string if unlabeled. */
  label: string
  /** Custom labels per pin name (overrides the default pin name when set). */
  pinLabels: Record<string, string>
  /** Propagation delay in nanoseconds; default 1. */
  delay: number
  /** Pre-programmed waveform for INPUT_SIGNAL parts. */
  signal?: SignalRow[]
  /** Data width for N-bit parts (2–16); absent on fixed-width parts. */
  bits?: number
  /** STATE_MACHINE: pin counts (1–8 each) and the state table. */
  smInputs?: number
  smOutputs?: number
  smTable?: SmRow[]
  /** CHECKER: raw .chk sequences (input drives the circuit, output is expected). */
  chk?: { input: string; output: string }
  /** BUS_TAP: index of the lowest tapped bit (bits = tap width). */
  tapStart?: number
}

export interface WireSegment {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface Wire {
  id: string
  segments: WireSegment[]
  /** Pin this wire originates from, or null if dangling. */
  fromPinId: PinId | null
  /** Pin this wire terminates at, or null if dangling. */
  toPinId: PinId | null
  /** Net this wire belongs to (a group of electrically-connected wires). */
  netId: string
}

export interface SimulationOptions {
  /** Total simulation time limit, in ns. */
  simTimeNs: number
  /** Clock period, in ns. */
  clockPeriodNs: number
  /** Clock's initial value (rising-edge clock ⇒ ONE, falling-edge ⇒ ZERO). */
  clockInitialValue: LogicValue
}

export interface NetlistMetadata {
  name: string
  createdAt: string
  modifiedAt: string
  appVersion: string
  comment: string
  /** Default propagation delay applied to newly placed parts, in ns. */
  defaultDelay: number
  simulation: SimulationOptions
  /** View scaling factor (1 = 100%). */
  scalingFactor: number
  /** Persisted switch positions, keyed by component id. */
  switchValues?: Record<string, LogicValue>
}

export interface Netlist {
  components: Component[]
  wires: Wire[]
  metadata: NetlistMetadata
}
