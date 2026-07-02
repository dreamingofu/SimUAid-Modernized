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
import { evalGate, gateFamily, nextFlipFlopQ, type FlipFlopKind } from './logic'
import { compileTable, termsMatch, type CompiledSmRow } from './stateMachine'

const { ZERO, ONE, X, Z } = LogicValue

export const MAX_EVENTS_PER_RUN = 100_000

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

type SimEvent =
  | { time: number; seq: number; kind: 'drive'; pinId: PinId; value: LogicValue }
  | { time: number; seq: number; kind: 'busdrive'; pinId: PinId; value: LogicValue[] }
  | { time: number; seq: number; kind: 'eval'; componentId: string }
  | { time: number; seq: number; kind: 'softreset' }
  | { time: number; seq: number; kind: 'sample'; slot: number }

class EventHeap {
  private items: SimEvent[] = []

  get size(): number {
    return this.items.length
  }

  peek(): SimEvent | undefined {
    return this.items[0]
  }

  values(): readonly SimEvent[] {
    return this.items
  }

  clear(): void {
    this.items = []
  }

  push(e: SimEvent): void {
    const items = this.items
    items.push(e)
    let i = items.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.before(items[i], items[parent])) {
        ;[items[i], items[parent]] = [items[parent], items[i]]
        i = parent
      } else break
    }
  }

  pop(): SimEvent | undefined {
    const items = this.items
    const top = items[0]
    const last = items.pop()
    if (last !== undefined && items.length > 0) {
      items[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let smallest = i
        if (l < items.length && this.before(items[l], items[smallest])) smallest = l
        if (r < items.length && this.before(items[r], items[smallest])) smallest = r
        if (smallest === i) break
        ;[items[i], items[smallest]] = [items[smallest], items[i]]
        i = smallest
      }
    }
    return top
  }

  private before(a: SimEvent, b: SimEvent): boolean {
    return a.time !== b.time ? a.time < b.time : a.seq < b.seq
  }
}

interface InputSource {
  pinId: PinId
  rows: SignalRow[]
  cycleNs: number
  initial: LogicValue
}

const CONSTANT_SOURCES = new Set([ComponentType.VCC, ComponentType.GROUND])

const CLOCKED_NBIT = new Set([
  ComponentType.N_COUNTER,
  ComponentType.N_LOADABLE_COUNTER,
  ComponentType.N_REGISTER,
  ComponentType.N_SHIFT_LEFT,
  ComponentType.N_SHIFT_RIGHT,
  ComponentType.N_SHIFT_BIDIR
])

function isFlipFlop(type: ComponentType): boolean {
  return type === ComponentType.D_FLIPFLOP || type === ComponentType.JK_FLIPFLOP
}

function complement(v: LogicValue): LogicValue {
  if (v === ZERO) return ONE
  if (v === ONE) return ZERO
  return X
}

const clean = (v: LogicValue): boolean => v === ZERO || v === ONE

function vecToNum(vec: LogicValue[]): number | null {
  let n = 0
  for (let i = vec.length - 1; i >= 0; i--) {
    if (!clean(vec[i])) return null
    n = n * 2 + (vec[i] === ONE ? 1 : 0)
  }
  return n
}

function numToVec(n: number, bits: number): LogicValue[] {
  const vec: LogicValue[] = []
  for (let i = 0; i < bits; i++) vec.push((n >> i) & 1 ? ONE : ZERO)
  return vec
}

const xVec = (bits: number): LogicValue[] => new Array<LogicValue>(bits).fill(X)
const zVec = (bits: number): LogicValue[] => new Array<LogicValue>(bits).fill(Z)

function vecEqual(a: LogicValue[] | undefined, b: LogicValue[]): boolean {
  if (!a || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** LSB-first vector -> uppercase hex; 'X'/'Z' fills when bits are not clean. */
export function vecToHex(vec: LogicValue[]): string {
  const digits = Math.ceil(vec.length / 4)
  if (vec.every((v) => v === Z)) return 'Z'.repeat(digits)
  if (!vec.every(clean)) return 'X'.repeat(digits)
  let out = ''
  for (let d = 0; d < digits; d++) {
    let nibble = 0
    for (let b = 3; b >= 0; b--) {
      const i = d * 4 + b
      nibble = nibble * 2 + (i < vec.length && vec[i] === ONE ? 1 : 0)
    }
    out = nibble.toString(16).toUpperCase() + out
  }
  return out
}

/** Hex string (no prefix) -> LSB-first vector, or null when not valid hex. */
export function hexToVec(hex: string, bits: number): LogicValue[] | null {
  const s = hex.trim()
  if (!/^[0-9a-fA-F]+$/.test(s)) return null
  const vec = zVec(bits).fill(ZERO)
  for (let d = 0; d < s.length; d++) {
    const nibble = parseInt(s[s.length - 1 - d], 16)
    for (let b = 0; b < 4; b++) {
      const i = d * 4 + b
      if (i < bits) vec[i] = (nibble >> b) & 1 ? ONE : ZERO
    }
  }
  return vec
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

export class Simulator {
  private graph: SimGraph
  private pinDrive = new Map<PinId, LogicValue>()
  private netValue = new Map<string, LogicValue>()
  private busDrive = new Map<PinId, LogicValue[]>()
  private busValue = new Map<string, LogicValue[]>()
  private busProbeIds = new Set<string>()
  private ffState = new Map<string, { q: LogicValue; lastClk: LogicValue }>()
  private regState = new Map<string, { state: LogicValue[]; lastClk: LogicValue }>()
  private smTables = new Map<string, CompiledSmRow[]>()
  private smState = new Map<string, { state: number | null; lastClk: LogicValue }>()
  private smActive = new Map<string, number | null>()
  private checker: {
    compId: string
    outPinId: PinId
    input: string
    output: string
    step: number
  } | null = null
  private checkerFailures: { slot: number; expected: string; actual: LogicValue }[] = []
  private checkerSampled = 0
  private queue = new EventHeap()
  private seq = 0
  private switchValues: Record<string, LogicValue>

  private clockPinId: PinId | null = null
  private halfPeriod = 0
  private inputs: InputSource[] = []
  private probeNets = new Map<string, string[]>()
  private probeOrder: string[] = []
  private waveforms = new Map<string, WaveformSample[]>()
  private scheduledUpTo = 0

  time = 0
  oscillated = false

  constructor(
    private netlist: Netlist,
    private options: SimulationOptions,
    switchValues: Record<string, LogicValue>
  ) {
    this.graph = buildSimGraph(netlist)
    this.switchValues = { ...switchValues }
    this.halfPeriod = Math.max(1, Math.round(options.clockPeriodNs / 2))

    for (const comp of netlist.components) {
      const sim = this.graph.components.get(comp.id)
      if (!sim) continue
      if (comp.type === ComponentType.CLOCK) {
        this.clockPinId = makePinId(comp.id, 'out')
      } else if (comp.type === ComponentType.INPUT_SIGNAL) {
        this.inputs.push(this.makeInputSource(makePinId(comp.id, 'out'), comp.signal ?? []))
      } else if (comp.type === ComponentType.STATE_MACHINE) {
        this.smTables.set(comp.id, compileTable(comp).rows)
      } else if (comp.type === ComponentType.CHECKER && comp.chk) {
        this.checker = {
          compId: comp.id,
          outPinId: makePinId(comp.id, 'out'),
          input: comp.chk.input,
          output: comp.chk.output,
          step: Math.max(1, options.clockPeriodNs)
        }
      } else if (comp.type === ComponentType.PROBE || comp.type === ComponentType.BUS_PROBE) {
        const netId = sim.pinNet['in']
        if (netId !== undefined) {
          this.probeOrder.push(comp.id)
          const list = this.probeNets.get(netId) ?? []
          list.push(comp.id)
          this.probeNets.set(netId, list)
          if (comp.type === ComponentType.BUS_PROBE) this.busProbeIds.add(comp.id)
        }
      }
    }

    this.reset()
  }

  get sourceNetlist(): Netlist {
    return this.netlist
  }

  reset(): void {
    this.time = 0
    this.oscillated = false
    this.scheduledUpTo = 0
    this.pinDrive.clear()
    this.netValue.clear()
    this.busDrive.clear()
    this.busValue.clear()
    this.ffState.clear()
    this.regState.clear()
    this.smState.clear()
    this.smActive.clear()
    this.queue.clear()
    this.waveforms.clear()

    for (const comp of this.netlist.components) {
      if (comp.type === ComponentType.BUS_INPUT) {
        const bits = comp.bits ?? 2
        this.busDrive.set(makePinId(comp.id, 'out'), hexToVec(comp.label, bits) ?? xVec(bits))
      }
    }

    for (const comp of this.graph.components.values()) {
      switch (comp.type) {
        case ComponentType.SWITCH:
          this.pinDrive.set(makePinId(comp.id, 'out'), this.switchValues[comp.id] ?? ZERO)
          break
        case ComponentType.VCC:
          this.pinDrive.set(makePinId(comp.id, 'out'), ONE)
          break
        case ComponentType.GROUND:
          this.pinDrive.set(makePinId(comp.id, 'out'), ZERO)
          break
        case ComponentType.CLOCK:
          this.pinDrive.set(makePinId(comp.id, 'out'), this.options.clockInitialValue)
          break
        default:
          break
      }
    }
    for (const src of this.inputs) this.pinDrive.set(src.pinId, src.initial)

    this.checkerFailures = []
    this.checkerSampled = 0
    if (this.checker) {
      this.pinDrive.set(this.checker.outPinId, checkerDrive(this.checker.input[0]))
    }

    for (const net of this.graph.nets.values()) {
      if (net.width > 1) this.busValue.set(net.id, this.resolveBusNet(net))
      else this.netValue.set(net.id, this.resolveNet(net))
    }

    for (const comp of this.graph.components.values()) {
      if (isFlipFlop(comp.type)) {
        this.ffState.set(comp.id, { q: X, lastClk: this.readNet(comp.pinNet['CLK']) })
      } else if (CLOCKED_NBIT.has(comp.type)) {
        this.regState.set(comp.id, {
          state: xVec(comp.bits || 1),
          lastClk: this.readNet(comp.pinNet['CLK'])
        })
      } else if (comp.type === ComponentType.STATE_MACHINE) {
        const rows = this.smTables.get(comp.id) ?? []
        this.smState.set(comp.id, {
          state: rows.length > 0 ? rows[0].present : 0,
          lastClk: this.readNet(comp.pinNet['CLK'])
        })
      }
    }
    for (const comp of this.graph.components.values()) this.enqueueEval(0, comp.id)
    this.process(Infinity)

    for (const probeId of this.probeOrder) this.waveforms.set(probeId, [])
    for (const [netId, ids] of this.probeNets) {
      const net = this.graph.nets.get(netId)
      const isBus = (net?.width ?? 1) > 1
      const v = isBus ? X : this.readNet(netId)
      const hex = isBus ? vecToHex(this.busValue.get(netId) ?? xVec(net!.width)) : undefined
      for (const id of ids) {
        this.waveforms.get(id)!.push(hex !== undefined ? { t: 0, v, hex } : { t: 0, v })
      }
    }
  }

  toggle(switchId: string, autoProcess = true): LogicValue {
    const next = this.switchValues[switchId] === ONE ? ZERO : ONE
    this.switchValues[switchId] = next
    this.enqueueEval(this.time, switchId)
    if (autoProcess) this.process(Infinity)
    return next
  }

  step(): void {
    const limit = this.options.simTimeNs
    if (this.clockPinId !== null) {
      const period = Math.max(1, this.options.clockPeriodNs)
      const quarter = period / 4
      const target = Math.min(limit, (Math.floor((this.time + quarter) / period) + 1) * period - quarter)
      this.scheduleStimulus(target)
      this.process(target)
    } else if (this.inputs.length > 0) {
      this.scheduleStimulus(limit)
      const next = this.queue.peek()
      this.process(next ? Math.min(next.time, limit) : limit)
    }
  }

  go(): void {
    const limit = this.options.simTimeNs
    let target = limit
    if (this.clockPinId !== null) {
      const period = Math.max(1, this.options.clockPeriodNs)
      const quarter = period / 4
      target = Math.floor((limit + quarter) / period) * period - quarter
      if (target <= 0) target = limit
    }
    this.scheduleStimulus(limit)
    this.process(target)
  }

  changeStep(): boolean {
    const ev = this.queue.pop()
    if (!ev) return false
    this.time = ev.time
    this.dispatch(ev)
    return true
  }

  private dispatch(ev: SimEvent): void {
    if (ev.kind === 'drive') this.applyDrive(ev)
    else if (ev.kind === 'busdrive') this.applyBusDrive(ev)
    else if (ev.kind === 'softreset') this.softReset(ev.time)
    else if (ev.kind === 'sample') this.sampleChecker(ev.slot)
    else this.applyEval(ev)
  }

  drain(): void {
    this.process(Infinity)
  }

  getPinValues(): Record<PinId, LogicValue> {
    const out: Record<PinId, LogicValue> = {}
    for (const [pinId, netId] of this.graph.pinToNet) {
      const net = this.graph.nets.get(netId)
      if (net && net.width > 1) continue // bus pins publish via getBusPinValues
      out[pinId] = this.readNet(netId)
    }
    return out
  }

  getBusPinValues(): Record<PinId, string> {
    const out: Record<PinId, string> = {}
    for (const [pinId, netId] of this.graph.pinToNet) {
      const net = this.graph.nets.get(netId)
      if (!net || net.width <= 1) continue
      out[pinId] = vecToHex(this.busValue.get(netId) ?? zVec(net.width))
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

  hasXZ(): boolean {
    for (const netId of this.graph.pinToNet.values()) {
      const net = this.graph.nets.get(netId)
      if (net && net.width > 1) {
        const vec = this.busValue.get(netId)
        if (!vec || vec.some((v) => v === X || v === Z)) return true
        continue
      }
      const v = this.readNet(netId)
      if (v === X || v === Z) return true
    }
    return false
  }

  private makeInputSource(pinId: PinId, signal: SignalRow[]): InputSource {
    const sorted = [...signal].sort((a, b) => a.timeNs - b.timeNs)
    const repeat = sorted.find((r) => r.value === 'R')
    const rows = sorted.filter((r) => r.value !== 'R')
    const source: InputSource = { pinId, rows, cycleNs: repeat ? repeat.timeNs : 0, initial: Z }
    source.initial = inputValueAt(source, 0)
    return source
  }

  private scheduleStimulus(target: number): void {
    if (target <= this.scheduledUpTo) return
    const from = this.scheduledUpTo

    if (this.clockPinId !== null) {
      const initial = this.options.clockInitialValue
      let k = Math.floor(from / this.halfPeriod) + 1
      for (; k * this.halfPeriod <= target; k++) {
        this.queue.push({
          time: k * this.halfPeriod,
          seq: this.seq++,
          kind: 'drive',
          pinId: this.clockPinId,
          value: k % 2 === 1 ? complement(initial) : initial
        })
      }
    }

    for (const src of this.inputs) {
      if (src.rows.length === 0) continue
      if (src.cycleNs > 0) {
        for (let cycle = Math.floor(from / src.cycleNs); cycle * src.cycleNs <= target; cycle++) {
          const base = cycle * src.cycleNs
          for (const row of src.rows) {
            const at = base + row.timeNs
            if (at > from && at <= target) {
              this.queue.push({ time: at, seq: this.seq++, kind: 'drive', pinId: src.pinId, value: row.value as LogicValue })
            }
          }
        }
      } else {
        for (const row of src.rows) {
          if (row.timeNs > from && row.timeNs <= target) {
            this.queue.push({ time: row.timeNs, seq: this.seq++, kind: 'drive', pinId: src.pinId, value: row.value as LogicValue })
          }
        }
      }
    }

    if (this.checker) {
      const { step, input, output, outPinId } = this.checker
      for (let slot = 0; slot < input.length; slot++) {
        const driveAt = slot * step
        const sampleAt = driveAt + step * 0.75
        if (driveAt > from && driveAt <= target) {
          this.queue.push({
            time: driveAt,
            seq: this.seq++,
            kind: 'drive',
            pinId: outPinId,
            value: checkerDrive(input[slot])
          })
          if (input[slot] === 'R') {
            this.queue.push({ time: driveAt, seq: this.seq++, kind: 'softreset' })
          }
        }
        if (sampleAt > from && sampleAt <= target && output[slot] !== 'X' && output[slot] !== 'R') {
          this.queue.push({ time: sampleAt, seq: this.seq++, kind: 'sample', slot })
        }
      }
    }

    this.scheduledUpTo = target
  }

  /** Checker 'R': clear all sequential state without disturbing time or waveforms. */
  private softReset(time: number): void {
    for (const [id, ff] of this.ffState) {
      this.ffState.set(id, { q: X, lastClk: ff.lastClk })
      this.enqueueEval(time, id)
    }
    for (const [id, reg] of this.regState) {
      this.regState.set(id, { state: xVec(reg.state.length), lastClk: reg.lastClk })
      this.enqueueEval(time, id)
    }
    for (const [id, sm] of this.smState) {
      const rows = this.smTables.get(id) ?? []
      this.smState.set(id, { state: rows.length > 0 ? rows[0].present : 0, lastClk: sm.lastClk })
      this.enqueueEval(time, id)
    }
  }

  private sampleChecker(slot: number): void {
    if (!this.checker) return
    const comp = this.graph.components.get(this.checker.compId)
    if (!comp) return
    const actual = this.readNet(comp.pinNet['in'])
    const expected = this.checker.output[slot]
    this.checkerSampled++
    const matches =
      (expected === '0' && actual === ZERO) || (expected === '1' && actual === ONE)
    if (!matches) this.checkerFailures.push({ slot, expected, actual })
  }

  getCheckerResult(): { total: number; sampled: number; failures: number } | null {
    if (!this.checker) return null
    const total = [...this.checker.output].filter((c) => c === '0' || c === '1').length
    return { total, sampled: this.checkerSampled, failures: this.checkerFailures.length }
  }

  /** Buses allow a single active driver; no drivers -> Z-fill; contention -> X-fill. */
  private resolveBusNet(net: SimNet): LogicValue[] {
    if (net.driverPinIds.length === 0) return zVec(net.width)
    let value: LogicValue[] | null = null
    for (const pinId of net.driverPinIds) {
      const drive = this.busDrive.get(pinId)
      if (!drive || drive.every((v) => v === Z)) continue
      if (value !== null) return xVec(net.width)
      value = drive
    }
    if (value === null) return zVec(net.width)
    if (value.length === net.width) return value
    const padded = xVec(net.width)
    for (let i = 0; i < Math.min(value.length, net.width); i++) padded[i] = value[i]
    return padded
  }

  private readBus(comp: SimComponent, pinName: string, n: number): LogicValue[] {
    const netId = comp.pinNet[pinName]
    if (netId === undefined) return zVec(n)
    const vec = this.busValue.get(netId)
    if (!vec) return zVec(n)
    if (vec.length === n) return vec
    const out = xVec(n)
    for (let i = 0; i < Math.min(vec.length, n); i++) out[i] = vec[i]
    return out
  }

  private scheduleBusOutput(comp: SimComponent, pinName: string, value: LogicValue[], time: number): void {
    if (!(pinName in comp.pinNet)) return
    const pinId = makePinId(comp.id, pinName)
    if (vecEqual(this.busDrive.get(pinId), value)) return
    this.queue.push({ time: time + comp.delay, seq: this.seq++, kind: 'busdrive', pinId, value })
  }

  private applyBusDrive(ev: Extract<SimEvent, { kind: 'busdrive' }>): void {
    if (vecEqual(this.busDrive.get(ev.pinId), ev.value)) return
    this.busDrive.set(ev.pinId, ev.value)
    const netId = this.graph.pinToNet.get(ev.pinId)
    if (netId === undefined) return
    const net = this.graph.nets.get(netId)
    if (!net) return
    const resolved = this.resolveBusNet(net)
    if (vecEqual(this.busValue.get(netId), resolved)) return
    this.busValue.set(netId, resolved)
    const probes = this.probeNets.get(netId)
    if (probes) {
      const hex = vecToHex(resolved)
      for (const id of probes) this.waveforms.get(id)?.push({ t: ev.time, v: X, hex })
    }
    for (const readerId of this.graph.readers.get(netId) ?? []) {
      this.enqueueEval(ev.time, readerId)
    }
  }

  /** Z drives release the net; one active driver wins; contention is X. */
  private resolveNet(net: SimNet): LogicValue {
    if (net.driverPinIds.length === 0) return Z
    let value: LogicValue | null = null
    for (const pinId of net.driverPinIds) {
      const drive = this.pinDrive.get(pinId) ?? X
      if (drive === Z) continue
      if (value !== null) return X
      value = drive
    }
    return value ?? Z
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

  private enqueueEval(time: number, componentId: string): void {
    this.queue.push({ time, seq: this.seq++, kind: 'eval', componentId })
  }

  private scheduleOutput(comp: SimComponent, pinName: string, value: LogicValue, time: number): void {
    if (!(pinName in comp.pinNet)) return
    const pinId = makePinId(comp.id, pinName)
    if (this.pinDrive.get(pinId) === value) return
    this.queue.push({ time: time + comp.delay, seq: this.seq++, kind: 'drive', pinId, value })
  }

  private scheduleVec(comp: SimComponent, prefix: string, values: LogicValue[], time: number): void {
    for (let i = 0; i < values.length; i++) this.scheduleOutput(comp, `${prefix}${i}`, values[i], time)
  }

  private process(limit: number): void {
    this.oscillated = false
    let count = 0
    while (this.queue.size > 0) {
      const next = this.queue.peek()!
      if (next.time > limit) break
      if (count >= MAX_EVENTS_PER_RUN) {
        this.haltOscillation()
        return
      }
      const ev = this.queue.pop()!
      count++
      this.time = ev.time
      this.dispatch(ev)
    }
    this.time = Number.isFinite(limit) ? Math.max(this.time, limit) : this.time
  }

  private haltOscillation(): void {
    const affected = new Set<string>()
    for (const ev of this.queue.values()) {
      if (ev.kind === 'drive' || ev.kind === 'busdrive') {
        const netId = this.graph.pinToNet.get(ev.pinId)
        if (netId !== undefined) affected.add(netId)
      } else if (ev.kind === 'eval') {
        const comp = this.graph.components.get(ev.componentId)
        if (comp) for (const out of comp.outputPinNames) affected.add(comp.pinNet[out])
      }
    }
    for (const netId of affected) {
      const net = this.graph.nets.get(netId)
      if (net && net.width > 1) this.busValue.set(netId, xVec(net.width))
      else this.netValue.set(netId, X)
    }
    this.queue.clear()
    this.oscillated = true
  }

  private applyDrive(ev: Extract<SimEvent, { kind: 'drive' }>): void {
    if (this.pinDrive.get(ev.pinId) === ev.value) return
    this.pinDrive.set(ev.pinId, ev.value)
    const netId = this.graph.pinToNet.get(ev.pinId)
    if (netId === undefined) return
    const net = this.graph.nets.get(netId)
    if (!net) return
    const resolved = this.resolveNet(net)
    if (this.netValue.get(netId) === resolved) return
    this.netValue.set(netId, resolved)
    const probes = this.probeNets.get(netId)
    if (probes) {
      for (const id of probes) this.waveforms.get(id)?.push({ t: ev.time, v: resolved })
    }
    for (const readerId of this.graph.readers.get(netId) ?? []) {
      this.enqueueEval(ev.time, readerId)
    }
  }

  private applyEval(ev: Extract<SimEvent, { kind: 'eval' }>): void {
    const comp = this.graph.components.get(ev.componentId)
    if (!comp) return
    const t = ev.time

    if (comp.type === ComponentType.SWITCH) {
      this.scheduleOutput(comp, 'out', this.switchValues[comp.id] ?? ZERO, t)
      return
    }
    if (
      CONSTANT_SOURCES.has(comp.type) ||
      comp.type === ComponentType.CLOCK ||
      comp.type === ComponentType.INPUT_SIGNAL ||
      comp.type === ComponentType.PROBE ||
      comp.type === ComponentType.SEVEN_SEGMENT ||
      comp.type === ComponentType.BUS_INPUT ||
      comp.type === ComponentType.BUS_PROBE ||
      comp.type === ComponentType.CHECKER
    ) {
      return
    }

    if (isFlipFlop(comp.type)) {
      this.evalFlipFlop(comp, t)
      return
    }
    if (comp.type === ComponentType.STATE_MACHINE) {
      this.evalStateMachine(comp, t)
      return
    }
    if (CLOCKED_NBIT.has(comp.type)) {
      this.evalClockedNBit(comp, t)
      return
    }

    const family = gateFamily(comp.type)
    if (family) {
      const inputs = comp.inputPinNames.map((name) => this.readNet(comp.pinNet[name]))
      this.scheduleOutput(comp, 'out', evalGate(family, inputs), t)
      return
    }

    this.evalCombinational(comp, t)
  }

  private evalCombinational(comp: SimComponent, t: number): void {
    switch (comp.type) {
      case ComponentType.FULL_ADDER: {
        const x = this.readPin(comp, 'X')
        const y = this.readPin(comp, 'Y')
        const cin = this.readPin(comp, 'Cin')
        if (clean(x) && clean(y) && clean(cin)) {
          const total = (x === ONE ? 1 : 0) + (y === ONE ? 1 : 0) + (cin === ONE ? 1 : 0)
          this.scheduleOutput(comp, 'Sum', total % 2 ? ONE : ZERO, t)
          this.scheduleOutput(comp, 'Cout', total >= 2 ? ONE : ZERO, t)
        } else {
          this.scheduleOutput(comp, 'Sum', X, t)
          this.scheduleOutput(comp, 'Cout', X, t)
        }
        return
      }

      case ComponentType.DECODER_2TO4:
      case ComponentType.DECODER_3TO8: {
        const selects = comp.type === ComponentType.DECODER_2TO4 ? ['A', 'B'] : ['A', 'B', 'C']
        const outputs = 1 << selects.length
        const vals = selects.map((s) => this.readPin(comp, s))
        if (vals.every(clean)) {
          let index = 0
          for (const v of vals) index = index * 2 + (v === ONE ? 1 : 0)
          for (let i = 0; i < outputs; i++) {
            this.scheduleOutput(comp, `out${i}`, i === index ? ONE : ZERO, t)
          }
        } else {
          for (let i = 0; i < outputs; i++) this.scheduleOutput(comp, `out${i}`, X, t)
        }
        return
      }

      case ComponentType.MUX_2:
      case ComponentType.MUX_4:
      case ComponentType.MUX_8: {
        const selects =
          comp.type === ComponentType.MUX_2 ? ['A'] : comp.type === ComponentType.MUX_4 ? ['A', 'B'] : ['A', 'B', 'C']
        const vals = selects.map((s) => this.readPin(comp, s))
        if (vals.every(clean)) {
          let index = 0
          for (const v of vals) index = index * 2 + (v === ONE ? 1 : 0)
          const input = this.readPin(comp, `in${index}`)
          this.scheduleOutput(comp, 'Z', clean(input) ? input : X, t)
        } else {
          this.scheduleOutput(comp, 'Z', X, t)
        }
        return
      }

      case ComponentType.TRISTATE_RIGHT:
      case ComponentType.TRISTATE_LEFT:
      case ComponentType.TRISTATE_UP:
      case ComponentType.TRISTATE_DOWN: {
        const ctl = this.readPin(comp, 'ctl')
        const input = this.readPin(comp, 'in')
        const out = ctl === ZERO ? Z : ctl === ONE ? (clean(input) ? input : X) : X
        this.scheduleOutput(comp, 'out', out, t)
        return
      }

      case ComponentType.N_ADDER: {
        const n = comp.bits
        const x = this.readVec(comp, 'X', n)
        const y = this.readVec(comp, 'Y', n)
        const cin = this.readPin(comp, 'Cin')
        const xn = vecToNum(x)
        const yn = vecToNum(y)
        if (xn !== null && yn !== null && clean(cin)) {
          const total = xn + yn + (cin === ONE ? 1 : 0)
          this.scheduleVec(comp, 'S', numToVec(total, n), t)
          this.scheduleOutput(comp, 'Cout', total >> n ? ONE : ZERO, t)
        } else {
          this.scheduleVec(comp, 'S', xVec(n), t)
          this.scheduleOutput(comp, 'Cout', X, t)
        }
        return
      }

      case ComponentType.N_MUX_2TO1: {
        const n = comp.bits
        const s = this.readPin(comp, 'S')
        if (clean(s)) {
          const vec = this.readVec(comp, s === ZERO ? 'X' : 'Y', n)
          this.scheduleVec(comp, 'Z', vec.map((v) => (clean(v) ? v : X)), t)
        } else {
          this.scheduleVec(comp, 'Z', xVec(n), t)
        }
        return
      }

      case ComponentType.N_TRISTATE: {
        const n = comp.bits
        const ctl = this.readPin(comp, 'ctl')
        if (ctl === ZERO) {
          this.scheduleVec(comp, 'out', zVec(n), t)
        } else if (ctl === ONE) {
          const vec = this.readVec(comp, 'in', n)
          this.scheduleVec(comp, 'out', vec.map((v) => (clean(v) ? v : X)), t)
        } else {
          this.scheduleVec(comp, 'out', xVec(n), t)
        }
        return
      }

      case ComponentType.SPLITTER: {
        const vec = this.readBus(comp, 'in', comp.bits)
        this.scheduleVec(comp, 'out', vec, t)
        return
      }

      case ComponentType.MERGER: {
        this.scheduleBusOutput(comp, 'out', this.readVec(comp, 'in', comp.bits), t)
        return
      }

      case ComponentType.BUS_TAP: {
        const netId = comp.pinNet['in']
        const width = netId !== undefined ? (this.graph.nets.get(netId)?.width ?? 1) : 1
        const vec = this.readBus(comp, 'in', width)
        const slice: LogicValue[] = []
        for (let i = 0; i < comp.bits; i++) {
          const idx = comp.tapStart + i
          slice.push(idx < vec.length ? vec[idx] : X)
        }
        if (comp.bits === 1) this.scheduleOutput(comp, 'out', slice[0], t)
        else this.scheduleBusOutput(comp, 'out', slice, t)
        return
      }

      case ComponentType.COMPLEMENTER: {
        const n = comp.bits
        const en = this.readPin(comp, 'en')
        const vec = this.readBus(comp, 'in', n)
        if (en === ONE) {
          this.scheduleBusOutput(comp, 'out', vec.map((v) => (clean(v) ? (v === ONE ? ZERO : ONE) : X)), t)
        } else if (en === ZERO) {
          this.scheduleBusOutput(comp, 'out', vec, t)
        } else {
          this.scheduleBusOutput(comp, 'out', xVec(n), t)
        }
        return
      }

      default:
        return
    }
  }

  private evalClockedNBit(comp: SimComponent, t: number): void {
    const n = comp.bits
    const reg = this.regState.get(comp.id) ?? { state: xVec(n), lastClk: Z }
    const clk = this.readPin(comp, 'CLK')
    const rising = reg.lastClk === ZERO && clk === ONE
    reg.lastClk = clk

    if (rising) {
      reg.state = this.nextRegState(comp, reg.state)
    }
    this.regState.set(comp.id, reg)

    this.scheduleVec(comp, 'Q', reg.state, t)
    if (comp.type === ComponentType.N_COUNTER || comp.type === ComponentType.N_LOADABLE_COUNTER) {
      const num = vecToNum(reg.state)
      const k = num === null ? X : num === (1 << n) - 1 ? ONE : ZERO
      this.scheduleOutput(comp, 'K', k, t)
    }
  }

  private nextRegState(comp: SimComponent, state: LogicValue[]): LogicValue[] {
    const n = comp.bits
    const pin = (name: string): LogicValue => this.readPin(comp, name)

    switch (comp.type) {
      case ComponentType.N_COUNTER: {
        const clr = pin('CLR') // active low
        const en = pin('En')
        if (!clean(clr)) return xVec(n)
        if (clr === ZERO) return numToVec(0, n)
        if (!clean(en)) return xVec(n)
        if (en === ZERO) return state
        const num = vecToNum(state)
        return num === null ? xVec(n) : numToVec(num + 1, n)
      }

      case ComponentType.N_LOADABLE_COUNTER: {
        const clr = pin('CLR') // active low
        const ld = pin('Ld') // active low
        const en = pin('En')
        if (!clean(clr)) return xVec(n)
        if (clr === ZERO) return numToVec(0, n)
        if (!clean(ld)) return xVec(n)
        if (ld === ZERO) return this.readVec(comp, 'D', n).map((v) => (clean(v) ? v : X))
        if (!clean(en)) return xVec(n)
        if (en === ZERO) return state
        const num = vecToNum(state)
        return num === null ? xVec(n) : numToVec(num + 1, n)
      }

      case ComponentType.N_REGISTER: {
        const clr = pin('CLR') // active high
        const ld = pin('Ld')
        if (!clean(clr)) return xVec(n)
        if (clr === ONE) return numToVec(0, n)
        if (!clean(ld)) return xVec(n)
        if (ld === ONE) return this.readVec(comp, 'D', n).map((v) => (clean(v) ? v : X))
        return state
      }

      case ComponentType.N_SHIFT_LEFT:
      case ComponentType.N_SHIFT_RIGHT:
      case ComponentType.N_SHIFT_BIDIR: {
        const clr = pin('CLR')
        const ld = pin('Ld')
        if (!clean(clr)) return xVec(n)
        if (clr === ONE) return numToVec(0, n)
        if (!clean(ld)) return xVec(n)
        if (ld === ONE) return this.readVec(comp, 'D', n).map((v) => (clean(v) ? v : X))

        const canLeft = comp.type !== ComponentType.N_SHIFT_RIGHT
        const canRight = comp.type !== ComponentType.N_SHIFT_LEFT
        const ls = canLeft ? pin('LS') : ZERO
        const rs = canRight ? pin('RS') : ZERO
        if ((canLeft && !clean(ls)) || (canRight && !clean(rs))) return xVec(n)

        // LS wins when both are asserted (bidirectional rule).
        if (canLeft && ls === ONE) {
          const rin = pin('Rin')
          const next = xVec(n)
          for (let i = n - 1; i > 0; i--) next[i] = state[i - 1]
          next[0] = clean(rin) ? rin : X
          return next
        }
        if (canRight && rs === ONE) {
          const lin = pin('Lin')
          const next = xVec(n)
          for (let i = 0; i < n - 1; i++) next[i] = state[i + 1]
          next[n - 1] = clean(lin) ? lin : X
          return next
        }
        return state
      }

      default:
        return state
    }
  }

  /** Outputs follow the active row immediately; state advances on rising CLK. */
  private evalStateMachine(comp: SimComponent, t: number): void {
    const rows = this.smTables.get(comp.id) ?? []
    const sm = this.smState.get(comp.id) ?? { state: null, lastClk: Z }
    const clk = this.readPin(comp, 'CLK')
    const rising = sm.lastClk === ZERO && clk === ONE
    sm.lastClk = clk

    const readPin = (pinName: string): LogicValue => this.readPin(comp, pinName)
    const findActive = (): CompiledSmRow | null | undefined => {
      // undefined = no row matches; null = inputs unresolved (X/Z).
      if (sm.state === null) return undefined
      let sawUnresolved = false
      for (const row of rows) {
        if (row.present !== sm.state) continue
        const match = termsMatch(row.terms, readPin)
        if (match === true) return row
        if (match === null) sawUnresolved = true
      }
      return sawUnresolved ? null : undefined
    }

    let active = findActive()
    if (rising && active) {
      sm.state = active.next
      active = findActive()
    }
    this.smState.set(comp.id, sm)
    this.smActive.set(comp.id, active ? active.index : null)

    for (const out of comp.outputPinNames) {
      const value = active ? (active.highOutputs.includes(out) ? ONE : ZERO) : X
      this.scheduleOutput(comp, out, value, t)
    }
  }

  getSmDisplays(): Record<PinId, string> {
    const out: Record<PinId, string> = {}
    for (const [compId, sm] of this.smState) {
      out[makePinId(compId, 'state')] = sm.state === null ? '?' : String(sm.state)
    }
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

  private evalFlipFlop(comp: SimComponent, time: number): void {
    const kind: FlipFlopKind = comp.type === ComponentType.D_FLIPFLOP ? 'd' : 'jk'
    const clk = this.readNet(comp.pinNet['CLK'])
    const state = this.ffState.get(comp.id) ?? { q: X, lastClk: clk }
    const q = nextFlipFlopQ(
      kind,
      {
        clk,
        s: this.readNet(comp.pinNet['S']),
        r: this.readNet(comp.pinNet['R']),
        d: this.readNet(comp.pinNet['D']),
        j: this.readNet(comp.pinNet['J']),
        k: this.readNet(comp.pinNet['K'])
      },
      state.q,
      state.lastClk
    )
    this.ffState.set(comp.id, { q, lastClk: clk })
    this.scheduleOutput(comp, 'Q', q, time)
    this.scheduleOutput(comp, "Q'", complement(q), time)
  }
}
