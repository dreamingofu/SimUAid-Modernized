// Event-driven simulator. Parts' behavior lives in logic.ts / parts.ts; this file
// owns time, the event queue, net resolution, stimulus (clock, input signals,
// checker) and sequential state.
//
// Semantics (see the decisions recorded in the test suite):
//  - Every part output has an inertial delay >= 1 ns: a later evaluation
//    supersedes a change still in flight, so pulses shorter than the delay never
//    reach the output.
//  - All events at one instant are applied first, affected nets are resolved
//    once, then affected components are evaluated once. Same-instant changes are
//    seen together and results never depend on queue order.
//  - Nets resolve std_logic style: Z releases, agreeing drivers keep the value,
//    disagreement or an X driver gives X.

import {
  ComponentType,
  LogicValue,
  makePinId,
  type Netlist,
  type PinId,
  type SignalRow,
  type SimulationOptions
} from '../model/types'
import { buildSimGraph, type SimComponent, type SimGraph, type SimNet } from './graph'
import { evalGate, gateFamily, isRisingEdge, nextFlipFlopQ, type FlipFlopKind } from './logic'
import {
  activeSmRow,
  counterCarry,
  evalAdder,
  evalBusTap,
  evalComplementer,
  evalDecoder,
  evalMux,
  evalMux2to1,
  evalTristate,
  initialSmState,
  nextRegisterState,
  selectPinsOf,
  smOutputValue
} from './parts'
import { compileTable, type CompiledSmRow } from './stateMachine'
import { EventHeap, type SimEvent } from './eventHeap'
import { complement, fitVec, hexToVec, resolveDrivers, vecEqual, vecToHex, xVec, zVec } from './values'

export { vecToHex, hexToVec } from './values'

const { ZERO, ONE, X, Z } = LogicValue

export const MAX_EVENTS_PER_RUN = 100_000

export class SimulationLimitError extends Error {
  constructor(message = 'Simulation requires more than 100,000 queued events. Shorten the simulation time or increase clock/waveform periods.') {
    super(message)
    this.name = 'SimulationLimitError'
  }
}

export interface WaveformSample {
  t: number
  v: LogicValue
  /** Present on bus-probe traces: the bus value formatted as hex. */
  hex?: string
}

export interface WaveformTrace {
  probeId: string
  bus: boolean
  samples: WaveformSample[]
}

interface InputSource {
  pinId: PinId
  rows: SignalRow[]
  cycleNs: number
  initial: LogicValue
}

interface Checker {
  compId: string
  outPinId: PinId
  input: string
  output: string
}

/** A SimEvent without its ordering fields (distributes over the union). */
type EventBody = SimEvent extends infer E ? (E extends SimEvent ? Omit<E, 'time' | 'seq'> : never) : never

/** Parts that only source or sink signals; nothing to evaluate. */
const PASSIVE = new Set([
  ComponentType.VCC,
  ComponentType.GROUND,
  ComponentType.CLOCK,
  ComponentType.INPUT_SIGNAL,
  ComponentType.PROBE,
  ComponentType.SEVEN_SEGMENT,
  ComponentType.BUS_INPUT,
  ComponentType.BUS_PROBE,
  ComponentType.CHECKER
])

const CLOCKED_NBIT = new Set([
  ComponentType.N_COUNTER,
  ComponentType.N_LOADABLE_COUNTER,
  ComponentType.N_REGISTER,
  ComponentType.N_SHIFT_LEFT,
  ComponentType.N_SHIFT_RIGHT,
  ComponentType.N_SHIFT_BIDIR
])

const TRISTATES = new Set([
  ComponentType.TRISTATE_RIGHT,
  ComponentType.TRISTATE_LEFT,
  ComponentType.TRISTATE_UP,
  ComponentType.TRISTATE_DOWN
])

function isFlipFlop(type: ComponentType): boolean {
  return type === ComponentType.D_FLIPFLOP || type === ComponentType.JK_FLIPFLOP
}

function checkerDrive(ch: string | undefined): LogicValue {
  if (ch === '0') return ZERO
  if (ch === '1') return ONE
  return X // X slots and R (reset) slots drive X
}

function inputValueAt(source: InputSource, t: number): LogicValue {
  const tt = source.cycleNs > 0 ? ((t % source.cycleNs) + source.cycleNs) % source.cycleNs : t
  let v: LogicValue = Z
  for (const row of source.rows) {
    if (row.timeNs <= tt) v = row.value as LogicValue
    else break
  }
  return v
}

/**
 * The value each output pin drives, plus inertial-delay bookkeeping: the change
 * still in flight for a pin (if any) and a version stamped on its event so a
 * superseded event is recognised and skipped when it comes up.
 */
class DriveChannel<T> {
  readonly current = new Map<PinId, T>()
  private pending = new Map<PinId, T>()
  private version = new Map<PinId, number>()

  constructor(private equals: (a: T | undefined, b: T) => boolean) {}

  clear(): void {
    this.current.clear()
    this.clearPending()
  }

  clearPending(): void {
    this.pending.clear()
  }

  /**
   * Decides whether a new output value needs an event. Returns the version to
   * stamp on it, or null when the pin is already going to have that value or the
   * change merely cancels a pending one (a pulse shorter than the delay).
   */
  plan(pinId: PinId, value: T): number | null {
    const pending = this.pending.get(pinId)
    if (this.equals(pending ?? this.current.get(pinId), value)) return null
    const version = (this.version.get(pinId) ?? 0) + 1
    this.version.set(pinId, version)
    this.pending.delete(pinId)
    if (this.equals(this.current.get(pinId), value)) return null
    this.pending.set(pinId, value)
    return version
  }

  /** Applies a queued drive; false when it was superseded or changes nothing. */
  apply(pinId: PinId, value: T, version: number | undefined): boolean {
    if (version !== undefined) {
      if (version !== this.version.get(pinId)) return false
      this.pending.delete(pinId)
    }
    if (this.equals(this.current.get(pinId), value)) return false
    this.current.set(pinId, value)
    return true
  }
}

export class Simulator {
  private graph: SimGraph
  private drives = new DriveChannel<LogicValue>((a, b) => a === b)
  private busDrives = new DriveChannel<LogicValue[]>(vecEqual)
  private netValue = new Map<string, LogicValue>()
  private busValue = new Map<string, LogicValue[]>()
  /** Nets whose drivers changed during the current instant; resolved once by commitNets(). */
  private dirtyNets = new Set<string>()
  /** How many times each net's resolved value changed during the current run; drives the oscillation halt. */
  private changeCount = new Map<string, number>()

  private ffState = new Map<string, { q: LogicValue; lastClk: LogicValue }>()
  private regState = new Map<string, { state: LogicValue[]; lastClk: LogicValue }>()
  private smTables = new Map<string, CompiledSmRow[]>()
  private smState = new Map<string, { state: number; lastClk: LogicValue }>()
  private smActive = new Map<string, number | null>()

  private checker: Checker | null = null
  private checkerFailures: { slot: number; expected: string; actual: LogicValue }[] = []
  private checkerSampled = 0

  private queue = new EventHeap()
  private seq = 0
  /** Components whose inputs changed and that must be re-evaluated now (FIFO). */
  private evalQueue: string[] = []
  private evalQueued = new Set<string>()

  private switchValues: Record<string, LogicValue>
  private clockPinId: PinId | null = null
  private period = 1
  private quarter = 1
  /** Upper bound on how long a circuit that settles can take; see settleLimit(). */
  private settleBudget = 0
  private inputs: InputSource[] = []
  private scheduledUpTo = 0

  private busProbeIds = new Set<string>()
  private probeNets = new Map<string, string[]>()
  private probeOrder: string[] = []
  private waveforms = new Map<string, WaveformSample[]>()

  time = 0
  oscillated = false

  constructor(
    private netlist: Netlist,
    private options: SimulationOptions,
    switchValues: Record<string, LogicValue>
  ) {
    this.graph = buildSimGraph(netlist)
    this.switchValues = { ...switchValues }
    this.period = Math.max(1, options.clockPeriodNs)
    this.quarter = Math.max(1, Math.round(this.period / 4))
    // Every part can contribute its delay at most once along any settling path,
    // so the sum over all parts is a safe over-approximation of the longest time
    // a circuit that settles can need.
    for (const comp of this.graph.components.values()) this.settleBudget += comp.delay

    for (const comp of netlist.components) {
      const sim = this.graph.components.get(comp.id)
      if (!sim) continue
      if (comp.type === ComponentType.CLOCK) {
        this.clockPinId = makePinId(comp.id, 'out')
      } else if (comp.type === ComponentType.INPUT_SIGNAL) {
        this.inputs.push(makeInputSource(makePinId(comp.id, 'out'), comp.signal ?? []))
      } else if (comp.type === ComponentType.STATE_MACHINE) {
        this.smTables.set(comp.id, compileTable(comp).rows)
      } else if (comp.type === ComponentType.CHECKER && comp.chk) {
        this.checker = {
          compId: comp.id,
          outPinId: makePinId(comp.id, 'out'),
          input: comp.chk.input,
          output: comp.chk.output
        }
      } else if (comp.type === ComponentType.PROBE || comp.type === ComponentType.BUS_PROBE) {
        const netId = sim.pinNet['in']
        if (netId !== undefined) {
          this.probeOrder.push(comp.id)
          this.probeNets.set(netId, [...(this.probeNets.get(netId) ?? []), comp.id])
          if (comp.type === ComponentType.BUS_PROBE) this.busProbeIds.add(comp.id)
        }
      }
    }

    this.reset()
  }

  get sourceNetlist(): Netlist {
    return this.netlist
  }

  // ---------------------------------------------------------------- control

  /** Back to time 0 with every device in its default state (manual §1.5.5). */
  reset(): void {
    this.time = 0
    this.oscillated = false
    this.scheduledUpTo = 0
    this.drives.clear()
    this.busDrives.clear()
    this.netValue.clear()
    this.busValue.clear()
    this.dirtyNets.clear()
    this.ffState.clear()
    this.regState.clear()
    this.smState.clear()
    this.smActive.clear()
    this.queue.clear()
    this.evalQueue = []
    this.evalQueued.clear()
    this.waveforms.clear()
    this.checkerFailures = []
    this.checkerSampled = 0

    // Sources drive their initial values before anything is evaluated.
    for (const comp of this.netlist.components) {
      if (comp.type === ComponentType.BUS_INPUT) {
        const bits = this.graph.components.get(comp.id)!.bits
        this.busDrives.current.set(makePinId(comp.id, 'out'), hexToVec(comp.label, bits) ?? xVec(bits))
      }
    }
    for (const comp of this.graph.components.values()) {
      const out = makePinId(comp.id, 'out')
      if (comp.type === ComponentType.SWITCH) this.drives.current.set(out, this.switchValues[comp.id] ?? ZERO)
      else if (comp.type === ComponentType.VCC) this.drives.current.set(out, ONE)
      else if (comp.type === ComponentType.GROUND) this.drives.current.set(out, ZERO)
      else if (comp.type === ComponentType.CLOCK) this.drives.current.set(out, this.options.clockInitialValue)
    }
    for (const src of this.inputs) this.drives.current.set(src.pinId, src.initial)
    if (this.checker) this.drives.current.set(this.checker.outPinId, checkerDrive(this.checker.input[0]))

    for (const net of this.graph.nets.values()) {
      if (net.width > 1) this.busValue.set(net.id, this.resolveBusNet(net))
      else this.netValue.set(net.id, this.resolveNet(net))
    }
    for (const comp of this.graph.components.values()) {
      this.seedSequentialState(comp, this.readPin(comp, 'CLK'))
    }

    // Settle every output, then present the settled circuit as the state at t=0.
    for (const comp of this.graph.components.values()) this.enqueueEval(comp.id)
    this.settle()
    this.time = 0

    for (const probeId of this.probeOrder) this.waveforms.set(probeId, [])
    for (const [netId, ids] of this.probeNets) {
      const sample = this.sampleOf(netId)
      for (const id of ids) this.waveforms.get(id)!.push(sample)
    }
  }

  /** Flips a switch. LIVE mode propagates immediately; CHANGE mode leaves the event queued. */
  toggle(switchId: string, autoProcess = true): LogicValue {
    const next = this.switchValues[switchId] === ONE ? ZERO : ONE
    this.switchValues[switchId] = next
    this.enqueueEval(switchId)
    this.flushEvals()
    if (autoProcess) this.settle()
    return next
  }

  /** Runs one clock period: to a quarter period before the next active edge (Appendix B). */
  step(): void {
    if (this.clockPinId !== null) {
      const target = this.quarterBeforeEdge(this.time + this.period, this.time)
      this.scheduleStimulus(target)
      this.process(target)
    } else if (this.inputs.length > 0) {
      const horizon = this.time + this.options.simTimeNs
      this.scheduleStimulus(horizon)
      const next = this.queue.peek()
      this.process(next ? Math.min(next.time, horizon) : horizon)
    }
  }

  /** Runs for the simulation time limit, stopping a quarter period before an active edge. */
  go(): void {
    const horizon = this.time + this.options.simTimeNs
    const target = this.clockPinId !== null ? this.quarterBeforeEdge(horizon, this.time) : horizon
    this.scheduleStimulus(horizon)
    this.process(target)
  }

  /** CHANGE mode: applies one queued output change and everything it triggers at that instant. */
  changeStep(): boolean {
    const ev = this.queue.pop()
    if (!ev) return false
    this.time = ev.time
    this.applyInstant([ev])
    return true
  }

  drain(): void {
    this.settle()
  }

  // ---------------------------------------------------------------- readout

  getPinValues(): Record<PinId, LogicValue> {
    const out: Record<PinId, LogicValue> = {}
    for (const [pinId, netId] of this.graph.pinToNet) {
      if (this.widthOf(netId) === 1) out[pinId] = this.readNet(netId)
    }
    return out
  }

  getBusPinValues(): Record<PinId, string> {
    const out: Record<PinId, string> = {}
    for (const [pinId, netId] of this.graph.pinToNet) {
      const width = this.widthOf(netId)
      if (width > 1) out[pinId] = vecToHex(this.busValue.get(netId) ?? zVec(width))
    }
    return out
  }

  getWaveforms(): WaveformTrace[] {
    return this.probeOrder.map((probeId) => ({
      probeId,
      bus: this.busProbeIds.has(probeId),
      samples: this.waveforms.get(probeId) ?? []
    }))
  }

  /** True when any pin in the circuit reads X or Z. */
  hasXZ(): boolean {
    const bad = (v: LogicValue): boolean => v === X || v === Z
    for (const net of this.graph.nets.values()) {
      if (net.width > 1) {
        const vec = this.busValue.get(net.id)
        if (!vec || vec.some(bad)) return true
      } else if (bad(this.readNet(net.id))) {
        return true
      }
    }
    return false
  }

  getCheckerResult(): { total: number; sampled: number; failures: number } | null {
    if (!this.checker) return null
    const total = [...this.checker.output].filter((c) => c === '0' || c === '1').length
    return { total, sampled: this.checkerSampled, failures: this.checkerFailures.length }
  }

  /** Text shown inside parts: the state machine's state and the checker's verdict. */
  getSmDisplays(): Record<PinId, string> {
    const out: Record<PinId, string> = {}
    for (const [compId, sm] of this.smState) out[makePinId(compId, 'state')] = String(sm.state)
    const chk = this.getCheckerResult()
    if (chk && this.checker) {
      out[makePinId(this.checker.compId, 'result')] =
        chk.sampled === 0
          ? 'READY'
          : chk.sampled < chk.total
            ? `${chk.sampled}/${chk.total}`
            : chk.failures > 0
              ? 'FAIL'
              : 'PASS'
    }
    return out
  }

  getSmActive(): Record<string, number | null> {
    const out: Record<string, number | null> = {}
    for (const [compId, index] of this.smActive) out[compId] = index
    return out
  }

  // ---------------------------------------------------------------- clock / stimulus

  /**
   * Time of the k-th clock toggle. Toggles alternate floor/ceil of a half period
   * so active edges (even k) land on exact multiples of the period even when the
   * period is odd.
   */
  private clockToggleTime(k: number): number {
    return Math.floor((k * this.period) / 2)
  }

  /**
   * Largest time <= `t` that is a quarter period before an active clock edge
   * (edges sit on multiples of the period), or `t` itself when none lies after `now`.
   */
  private quarterBeforeEdge(t: number, now: number): number {
    const aligned = Math.floor((t + this.quarter) / this.period) * this.period - this.quarter
    return aligned > now ? aligned : t
  }

  /**
   * Queues clock toggles, input-signal rows and checker slots in (from, target].
   * Stimulus never runs in LIVE mode, so nothing is queued at or before the
   * current time: a clock left idle while switches were toggled resumes on its
   * absolute grid from the next toggle after `now`, never replaying the past.
   */
  private scheduleStimulus(target: number): void {
    // Check the complete scheduling operation before touching the event queue.
    // A large requested horizon must not allocate billions of events before
    // process() gets a chance to enforce MAX_EVENTS_PER_RUN.
    if (!Number.isFinite(target) || target > Number.MAX_SAFE_INTEGER / 4) {
      throw new SimulationLimitError('Simulation time exceeds the supported numeric range. Shorten the simulation time or reset the circuit.')
    }
    let count = this.queue.size
    this.visitStimulus(target, () => {
      if (++count > MAX_EVENTS_PER_RUN) throw new SimulationLimitError()
    })
    this.visitStimulus(target, (at, event) => this.push(at, event))
    this.scheduledUpTo = Math.max(this.scheduledUpTo, target)
  }

  /** Visits proposed events; the first pass counts them without mutating state. */
  private visitStimulus(target: number, push: (at: number, event: EventBody) => void): void {
    const from = Math.max(this.scheduledUpTo, this.time)
    if (target <= from) return

    if (this.clockPinId !== null) {
      const initial = this.options.clockInitialValue
      let k = Math.max(1, Math.floor((2 * from) / this.period))
      while (this.clockToggleTime(k) <= from) k++
      for (; this.clockToggleTime(k) <= target; k++) {
        push(this.clockToggleTime(k), {
          kind: 'drive',
          pinId: this.clockPinId,
          value: k % 2 === 1 ? complement(initial) : initial
        })
      }
    }

    for (const src of this.inputs) {
      if (src.rows.length === 0) continue
      const drive = (at: number, value: LogicValue): void => {
        if (at > from && at <= target) push(at, { kind: 'drive', pinId: src.pinId, value })
      }
      if (src.cycleNs > 0) {
        const restartsCycle = src.rows[0].timeNs !== 0
        const firstCycle = Math.floor(from / src.cycleNs)
        if (!Number.isSafeInteger(firstCycle) || !Number.isSafeInteger(Math.floor(target / src.cycleNs))) {
          throw new SimulationLimitError('Input waveform repeat count exceeds the supported numeric range. Increase the waveform repeat period.')
        }
        for (let cycle = firstCycle; cycle * src.cycleNs <= target; cycle++) {
          const base = cycle * src.cycleNs
          // Each repeat starts from the waveform's t=0 value (Z when no row is at 0).
          if (restartsCycle) drive(base, src.initial)
          for (const row of src.rows) drive(base + row.timeNs, row.value as LogicValue)
        }
      } else {
        for (const row of src.rows) drive(row.timeNs, row.value as LogicValue)
      }
    }

    // Checker slot k occupies [k*period, (k+1)*period). Its input value is applied
    // a quarter period into the slot (just after the active clock edge that starts
    // it, so the circuit under test samples it at the NEXT edge, like a testbench)
    // and the output is compared a quarter period before the slot ends. Slot 0's
    // value is already present from reset().
    if (this.checker) {
      const { input, output, outPinId } = this.checker
      for (let slot = 0; slot < input.length; slot++) {
        const driveAt = slot * this.period + (slot === 0 ? 0 : this.quarter)
        const sampleAt = (slot + 1) * this.period - this.quarter
        if (driveAt > from && driveAt <= target) {
          push(driveAt, { kind: 'drive', pinId: outPinId, value: checkerDrive(input[slot]) })
          if (input[slot] === 'R') push(driveAt, { kind: 'softreset' })
        }
        if (sampleAt > from && sampleAt <= target && (output[slot] === '0' || output[slot] === '1')) {
          push(sampleAt, { kind: 'sample', slot })
        }
      }
    }
  }

  private push(time: number, ev: EventBody): void {
    this.queue.push({ ...ev, time, seq: this.seq++ } as SimEvent)
  }

  // ---------------------------------------------------------------- sequential state

  /** Default state of a clocked part: unknown, with the clock level it currently sees. */
  private seedSequentialState(comp: SimComponent, lastClk: LogicValue): void {
    if (isFlipFlop(comp.type)) {
      this.ffState.set(comp.id, { q: X, lastClk })
    } else if (CLOCKED_NBIT.has(comp.type)) {
      this.regState.set(comp.id, { state: xVec(comp.bits), lastClk })
    } else if (comp.type === ComponentType.STATE_MACHINE) {
      this.smState.set(comp.id, { state: initialSmState(this.smTables.get(comp.id) ?? []), lastClk })
    }
  }

  /** Checker 'R': clear all sequential state without disturbing time or waveforms. */
  private softReset(): void {
    for (const comp of this.graph.components.values()) {
      const last = this.ffState.get(comp.id) ?? this.regState.get(comp.id) ?? this.smState.get(comp.id)
      if (!last) continue
      this.seedSequentialState(comp, last.lastClk)
      this.enqueueEval(comp.id)
    }
  }

  private sampleChecker(slot: number): void {
    if (!this.checker) return
    const comp = this.graph.components.get(this.checker.compId)
    if (!comp) return
    const actual = this.readPin(comp, 'in')
    const expected = this.checker.output[slot]
    this.checkerSampled++
    const matches = (expected === '0' && actual === ZERO) || (expected === '1' && actual === ONE)
    if (!matches) this.checkerFailures.push({ slot, expected, actual })
  }

  // ---------------------------------------------------------------- nets

  private widthOf(netId: string): number {
    return this.graph.nets.get(netId)?.width ?? 1
  }

  /**
   * Wired resolution of every output on the net: Z drivers release it, agreeing
   * drivers keep their value, and disagreement (or an X driver) is X. An output
   * that has never been evaluated drives X.
   */
  private resolveNet(net: SimNet): LogicValue {
    let value = Z
    for (const pinId of net.driverPinIds) value = resolveDrivers(value, this.drives.current.get(pinId) ?? X)
    return value
  }

  /** Bus nets resolve bit by bit; a driver narrower than the net leaves its missing high bits X. */
  private resolveBusNet(net: SimNet): LogicValue[] {
    const result = zVec(net.width)
    for (const pinId of net.driverPinIds) {
      const drive = this.busDrives.current.get(pinId)
      if (!drive) continue
      for (let i = 0; i < net.width; i++) {
        result[i] = resolveDrivers(result[i], i < drive.length ? drive[i] : X)
      }
    }
    return result
  }

  private sampleOf(netId: string): WaveformSample {
    if (this.widthOf(netId) > 1) {
      return { t: this.time, v: X, hex: vecToHex(this.busValue.get(netId) ?? xVec(this.widthOf(netId))) }
    }
    return { t: this.time, v: this.readNet(netId) }
  }

  /**
   * Re-resolves every net whose drivers changed during the current instant.
   * Resolving once per instant (not once per driver event) means probes record
   * at most one sample per instant and readers see only the final value.
   */
  private commitNets(): void {
    for (const netId of this.dirtyNets) {
      const net = this.graph.nets.get(netId)
      if (!net) continue
      let changed: boolean
      if (net.width > 1) {
        const resolved = this.resolveBusNet(net)
        changed = !vecEqual(this.busValue.get(netId), resolved)
        if (changed) this.busValue.set(netId, resolved)
      } else {
        const resolved = this.resolveNet(net)
        changed = this.netValue.get(netId) !== resolved
        if (changed) this.netValue.set(netId, resolved)
      }
      if (!changed) continue
      this.changeCount.set(netId, (this.changeCount.get(netId) ?? 0) + 1)
      const probes = this.probeNets.get(netId)
      if (probes) {
        const sample = this.sampleOf(netId)
        for (const id of probes) this.waveforms.get(id)?.push(sample)
      }
      for (const readerId of this.graph.readers.get(netId) ?? []) this.enqueueEval(readerId)
    }
    this.dirtyNets.clear()
  }

  private readNet(netId: string | undefined): LogicValue {
    if (netId === undefined) return Z
    return this.netValue.get(netId) ?? Z
  }

  private readPin(comp: SimComponent, name: string): LogicValue {
    return this.readNet(comp.pinNet[name])
  }

  private readVec(comp: SimComponent, prefix: string, n: number): LogicValue[] {
    const vec: LogicValue[] = []
    for (let i = 0; i < n; i++) vec.push(this.readPin(comp, `${prefix}${i}`))
    return vec
  }

  /** The vector on a bus pin's net, or null when nothing drives that net (unconnected). */
  private readBusOrNull(comp: SimComponent, pinName: string): LogicValue[] | null {
    const netId = comp.pinNet[pinName]
    const net = netId === undefined ? undefined : this.graph.nets.get(netId)
    if (!net || net.driverPinIds.length === 0) return null
    if (net.width === 1) return [this.readNet(net.id)]
    return (this.busValue.get(net.id) ?? zVec(net.width)).slice()
  }

  /** The vector on a bus pin as an n-bit part sees it (unconnected -> Z, mismatch -> X fill). */
  private readBus(comp: SimComponent, pinName: string, n: number): LogicValue[] {
    const vec = this.readBusOrNull(comp, pinName)
    if (vec === null) return zVec(n)
    return vec.length === n ? vec : fitVec(vec, n)
  }

  // ---------------------------------------------------------------- event loop

  /** Marks a component for re-evaluation at the current time (deduplicated). */
  private enqueueEval(componentId: string): void {
    if (this.evalQueued.has(componentId)) return
    this.evalQueued.add(componentId)
    this.evalQueue.push(componentId)
  }

  /** Evaluates every queued component now. Evaluations only queue future changes, so this terminates. */
  private flushEvals(): void {
    while (this.evalQueue.length > 0) {
      const id = this.evalQueue.shift()!
      this.evalQueued.delete(id)
      this.applyEval(id)
    }
  }

  /**
   * Applies a batch of events that all carry the current time, then resolves the
   * nets they touched, takes the checker samples and evaluates affected parts.
   */
  private applyInstant(events: SimEvent[]): void {
    const samples: number[] = []
    for (const ev of events) {
      if (ev.kind === 'drive') {
        if (this.drives.apply(ev.pinId, ev.value, ev.version)) this.markDirty(ev.pinId)
      } else if (ev.kind === 'busdrive') {
        if (this.busDrives.apply(ev.pinId, ev.value, ev.version)) this.markDirty(ev.pinId)
      } else if (ev.kind === 'softreset') {
        this.softReset()
      } else {
        samples.push(ev.slot)
      }
    }
    this.commitNets()
    for (const slot of samples) this.sampleChecker(slot)
    this.flushEvals()
  }

  private markDirty(pinId: PinId): void {
    const netId = this.graph.pinToNet.get(pinId)
    if (netId !== undefined) this.dirtyNets.add(netId)
  }

  /**
   * The bound for a free-running settle (a LIVE switch toggle, a CHANGE-mode Go,
   * or Reset). The manual stops LIVE propagation at "no further output changes
   * ... or the simulation time limit", but a single part may legally carry a
   * 999 ns delay while the limit defaults to 100 ns, so the raw limit would
   * declare an ordinary slow gate an oscillation. Taking whichever of the two is
   * larger keeps every circuit that can settle running to quiescence while still
   * cutting a runaway loop off near the limit instead of at 100,000 events.
   */
  private settleLimit(): number {
    return this.time + Math.max(this.options.simTimeNs, this.settleBudget)
  }

  /**
   * Runs queued events up to and including `limit`.
   *
   * `advanceTime` moves the clock to `limit` once the queue drains — right for
   * Step/Go, which run a defined window, but wrong for a settle, where the clock
   * must stop at the last event that actually happened. `haltOnLimit` treats
   * "reached the bound with events still pending" as a circuit that never
   * settles, which is the case for a settle but normal for Step/Go (their
   * leftovers belong to the next window).
   */
  private process(limit: number, advanceTime = true, haltOnLimit = false): void {
    this.oscillated = false
    this.changeCount.clear()
    let count = 0
    this.flushEvals()
    while (this.queue.size > 0) {
      const t = this.queue.peek()!.time
      if (t > limit) {
        // Step/Go leave later events for the next window; a settle that still
        // has work pending at its bound is a circuit that never settles.
        if (haltOnLimit) this.haltOscillation()
        break
      }
      this.time = t
      const batch: SimEvent[] = []
      while (this.queue.size > 0 && this.queue.peek()!.time === t) {
        if (++count > MAX_EVENTS_PER_RUN) {
          this.haltOscillation()
          return
        }
        batch.push(this.queue.pop()!)
      }
      this.applyInstant(batch)
    }
    if (advanceTime && Number.isFinite(limit)) this.time = Math.max(this.time, limit)
  }

  /** Propagates until the circuit is quiet, or abandons it as oscillating. */
  private settle(): void {
    this.process(this.settleLimit(), false, true)
  }

  /**
   * The run was abandoned without settling: every net that kept switching is
   * undetermined, so force those to X and drop the queue.
   *
   * The set comes from how often each net actually changed this run, not from
   * whichever events happened to be in flight at the cut-off — a ring carries
   * one event at a time, so the queue names only one of its nets and the rest
   * would keep stale levels that contradict their own inputs. A net that
   * changed once or twice settled (an ordinary transition or a glitch) and
   * keeps its value.
   *
   * The X is written to the driving pins and committed through commitNets(), not
   * poked into netValue directly: that records the probe sample, and it means a
   * later evaluation that drives a definite value differs from what the pin
   * holds and therefore schedules an event. Writing netValue alone would leave
   * the drivers holding their pre-halt level, so the net could never be revived
   * and the circuit would stay wrong until Reset.
   */
  private haltOscillation(): void {
    for (const [netId, count] of this.changeCount) {
      if (count <= 2) continue
      const net = this.graph.nets.get(netId)
      if (!net) continue
      const width = net.width
      for (const pinId of net.driverPinIds) {
        if (width > 1) this.busDrives.current.set(pinId, xVec(width))
        else this.drives.current.set(pinId, X)
      }
      // Leave the net value alone: commitNets() below re-resolves it from those
      // drivers, which is what records the probe sample.
      this.dirtyNets.add(netId)
    }
    // Record the forced values on the probes, then discard everything the commit
    // queued: the halt is terminal and must not restart the oscillation.
    this.commitNets()
    this.queue.clear()
    this.drives.clearPending()
    this.busDrives.clearPending()
    this.dirtyNets.clear()
    this.evalQueue = []
    this.evalQueued.clear()
    this.oscillated = true
  }

  // ---------------------------------------------------------------- outputs

  /** Queues a single-bit output change `delay` after now (inertial; see DriveChannel.plan). */
  private scheduleOutput(comp: SimComponent, pinName: string, value: LogicValue): void {
    if (!(pinName in comp.pinNet)) return
    const pinId = makePinId(comp.id, pinName)
    const version = this.drives.plan(pinId, value)
    if (version !== null) this.push(this.time + comp.delay, { kind: 'drive', pinId, value, version })
  }

  private scheduleBusOutput(comp: SimComponent, pinName: string, value: LogicValue[]): void {
    if (!(pinName in comp.pinNet)) return
    const pinId = makePinId(comp.id, pinName)
    const version = this.busDrives.plan(pinId, value)
    if (version !== null) this.push(this.time + comp.delay, { kind: 'busdrive', pinId, value, version })
  }

  private scheduleVec(comp: SimComponent, prefix: string, values: LogicValue[]): void {
    for (let i = 0; i < values.length; i++) this.scheduleOutput(comp, `${prefix}${i}`, values[i])
  }

  // ---------------------------------------------------------------- part evaluation

  private applyEval(componentId: string): void {
    const comp = this.graph.components.get(componentId)
    if (!comp || PASSIVE.has(comp.type)) return

    if (comp.type === ComponentType.SWITCH) {
      this.scheduleOutput(comp, 'out', this.switchValues[comp.id] ?? ZERO)
      return
    }
    if (isFlipFlop(comp.type)) return this.evalFlipFlop(comp)
    if (comp.type === ComponentType.STATE_MACHINE) return this.evalStateMachine(comp)
    if (CLOCKED_NBIT.has(comp.type)) return this.evalClockedNBit(comp)

    const family = gateFamily(comp.type)
    if (family) {
      this.scheduleOutput(comp, 'out', evalGate(family, comp.inputPinNames.map((name) => this.readPin(comp, name))))
      return
    }
    this.evalCombinational(comp)
  }

  private evalCombinational(comp: SimComponent): void {
    const n = comp.bits
    const pin = (name: string): LogicValue => this.readPin(comp, name)

    if (TRISTATES.has(comp.type)) {
      this.scheduleOutput(comp, 'out', evalTristate(pin('ctl'), [pin('in')])[0])
      return
    }

    switch (comp.type) {
      case ComponentType.FULL_ADDER: {
        const { sum, cout } = evalAdder([pin('X')], [pin('Y')], pin('Cin'))
        this.scheduleOutput(comp, 'Sum', sum[0])
        this.scheduleOutput(comp, 'Cout', cout)
        return
      }
      case ComponentType.DECODER_2TO4:
      case ComponentType.DECODER_3TO8:
        this.scheduleVec(comp, 'out', evalDecoder(selectPinsOf(comp.type).map(pin)))
        return
      case ComponentType.MUX_2:
      case ComponentType.MUX_4:
      case ComponentType.MUX_8:
        this.scheduleOutput(comp, 'Z', evalMux(selectPinsOf(comp.type).map(pin), (i) => pin(`in${i}`)))
        return
      case ComponentType.N_ADDER: {
        const { sum, cout } = evalAdder(this.readVec(comp, 'X', n), this.readVec(comp, 'Y', n), pin('Cin'))
        this.scheduleVec(comp, 'S', sum)
        this.scheduleOutput(comp, 'Cout', cout)
        return
      }
      case ComponentType.N_MUX_2TO1:
        this.scheduleVec(comp, 'Z', evalMux2to1(pin('S'), this.readVec(comp, 'X', n), this.readVec(comp, 'Y', n)))
        return
      case ComponentType.N_TRISTATE:
        this.scheduleVec(comp, 'out', evalTristate(pin('ctl'), this.readVec(comp, 'in', n)))
        return
      case ComponentType.SPLITTER:
        this.scheduleVec(comp, 'out', this.readBus(comp, 'in', n))
        return
      case ComponentType.MERGER:
        this.scheduleBusOutput(comp, 'out', this.readVec(comp, 'in', n))
        return
      case ComponentType.COMPLEMENTER:
        this.scheduleBusOutput(comp, 'out', evalComplementer(pin('en'), this.readBus(comp, 'in', n)))
        return
      case ComponentType.BUS_TAP: {
        const slice = evalBusTap(this.readBusOrNull(comp, 'in'), comp.tapStart, n)
        if (n === 1) this.scheduleOutput(comp, 'out', slice[0])
        else this.scheduleBusOutput(comp, 'out', slice)
        return
      }
      default:
        return
    }
  }

  private evalFlipFlop(comp: SimComponent): void {
    const kind: FlipFlopKind = comp.type === ComponentType.D_FLIPFLOP ? 'd' : 'jk'
    const pin = (name: string): LogicValue => this.readPin(comp, name)
    const clk = pin('CLK')
    const state = this.ffState.get(comp.id)!
    const q = nextFlipFlopQ(
      kind,
      { clk, s: pin('S'), r: pin('R'), d: pin('D'), j: pin('J'), k: pin('K') },
      state.q,
      state.lastClk
    )
    this.ffState.set(comp.id, { q, lastClk: clk })
    this.scheduleOutput(comp, 'Q', q)
    this.scheduleOutput(comp, "Q'", complement(q))
  }

  /** Fully synchronous parts: state changes only on the rising edge; outputs follow the state. */
  private evalClockedNBit(comp: SimComponent): void {
    const reg = this.regState.get(comp.id)!
    const clk = this.readPin(comp, 'CLK')
    if (isRisingEdge(reg.lastClk, clk)) {
      reg.state = nextRegisterState(
        comp.type,
        reg.state,
        (name) => this.readPin(comp, name),
        () => this.readVec(comp, 'D', comp.bits)
      )
    }
    reg.lastClk = clk

    this.scheduleVec(comp, 'Q', reg.state)
    if (comp.type === ComponentType.N_COUNTER || comp.type === ComponentType.N_LOADABLE_COUNTER) {
      this.scheduleOutput(comp, 'K', counterCarry(reg.state))
    }
  }

  /** Mealy machine: outputs follow the active row immediately; the state advances on rising CLK. */
  private evalStateMachine(comp: SimComponent): void {
    const rows = this.smTables.get(comp.id) ?? []
    const sm = this.smState.get(comp.id)!
    const clk = this.readPin(comp, 'CLK')
    const readPin = (name: string): LogicValue => this.readPin(comp, name)

    let active = activeSmRow(rows, sm.state, readPin)
    if (isRisingEdge(sm.lastClk, clk) && active) {
      sm.state = active.next
      active = activeSmRow(rows, sm.state, readPin)
    }
    sm.lastClk = clk
    this.smActive.set(comp.id, active ? active.index : null)

    for (const out of comp.outputPinNames) this.scheduleOutput(comp, out, smOutputValue(active, out))
  }
}

/**
 * 'R' at time T repeats the waveform from 0 with period T: rows at or after T
 * can never be reached and are dropped. Negative times are ignored.
 */
function makeInputSource(pinId: PinId, signal: SignalRow[]): InputSource {
  const sorted = [...signal].filter((r) => r.timeNs >= 0).sort((a, b) => a.timeNs - b.timeNs)
  const repeat = sorted.find((r) => r.value === 'R' && r.timeNs > 0)
  const cycleNs = repeat ? repeat.timeNs : 0
  const rows = sorted.filter((r) => r.value !== 'R' && (cycleNs === 0 || r.timeNs < cycleNs))
  const source: InputSource = { pinId, rows, cycleNs, initial: Z }
  source.initial = inputValueAt(source, 0)
  return source
}
