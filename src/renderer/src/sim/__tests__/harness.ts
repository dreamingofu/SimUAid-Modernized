// Test harness for the simulator: builds netlists programmatically and drives the
// Simulator without any UI. Components are placed far apart so no two pins ever
// share a coordinate by accident; connections are made with explicit wires (the
// same path the editor uses) or with pin labels (virtual connections).

import {
  ComponentType,
  LogicValue,
  makePinId,
  type Component,
  type Netlist,
  type PinId,
  type SimulationOptions
} from '../../model/types'
import { createEmptyNetlist } from '../../serialization/ckt'
import { getAbsolutePins } from '../../geometry/pins'
import { Simulator } from '../engine'

const { ZERO, ONE } = LogicValue

const SPACING = 1000

export interface AddOptions extends Partial<Omit<Component, 'id' | 'type'>> {}

export class CircuitBuilder {
  readonly netlist: Netlist
  readonly switchValues: Record<string, LogicValue> = {}
  private count = 0
  private wireCount = 0

  constructor(name = 'test') {
    this.netlist = createEmptyNetlist(name)
  }

  /** Places a component on its own grid cell. Default delay is 1 ns. */
  add(id: string, type: ComponentType, opts: AddOptions = {}): this {
    const i = this.count++
    const comp: Component = {
      id,
      type,
      x: (i % 8) * SPACING,
      y: Math.floor(i / 8) * SPACING,
      rotation: 0,
      label: '',
      pinLabels: {},
      delay: 1,
      ...opts
    }
    this.netlist.components.push(comp)
    return this
  }

  /** Adds a SWITCH whose initial position is `value`. */
  switch(id: string, value: LogicValue = ZERO, opts: AddOptions = {}): this {
    this.add(id, ComponentType.SWITCH, opts)
    this.switchValues[id] = value
    return this
  }

  probe(id: string, opts: AddOptions = {}): this {
    return this.add(id, ComponentType.PROBE, opts)
  }

  /** Draws a single-segment wire between two pins (pin ids are `comp#pin`). */
  wire(from: PinId, to: PinId): this {
    const a = this.pinPoint(from)
    const b = this.pinPoint(to)
    this.netlist.wires.push({
      id: `w${this.wireCount++}`,
      segments: [{ x1: a.x, y1: a.y, x2: b.x, y2: b.y }],
      fromPinId: from,
      toPinId: to,
      netId: ''
    })
    return this
  }

  /** Wires the first pin to every other pin listed. */
  connect(first: PinId, ...rest: PinId[]): this {
    for (const p of rest) this.wire(first, p)
    return this
  }

  /** Assigns a pin label; pins sharing a label are virtually connected. */
  label(pinId: PinId, label: string): this {
    const [compId, pinName] = split(pinId)
    const comp = this.comp(compId)
    comp.pinLabels = { ...comp.pinLabels, [pinName]: label }
    return this
  }

  setSimulation(opts: Partial<SimulationOptions>): this {
    this.netlist.metadata.simulation = { ...this.netlist.metadata.simulation, ...opts }
    return this
  }

  build(): Circuit {
    return new Circuit(this.netlist, this.switchValues)
  }

  private comp(id: string): Component {
    const comp = this.netlist.components.find((c) => c.id === id)
    if (!comp) throw new Error(`no component ${id}`)
    return comp
  }

  private pinPoint(pinId: PinId): { x: number; y: number } {
    const [compId, pinName] = split(pinId)
    const pin = getAbsolutePins(this.comp(compId)).find((p) => p.name === pinName)
    if (!pin) throw new Error(`no pin ${pinId}`)
    return { x: pin.x, y: pin.y }
  }
}

function split(pinId: PinId): [string, string] {
  const i = pinId.indexOf('#')
  if (i < 0) throw new Error(`bad pin id ${pinId}`)
  return [pinId.slice(0, i), pinId.slice(i + 1)]
}

/** A built circuit plus convenience accessors around the Simulator. */
export class Circuit {
  readonly sim: Simulator
  private switches: Record<string, LogicValue>

  constructor(netlist: Netlist, switchValues: Record<string, LogicValue>) {
    this.switches = { ...switchValues }
    this.sim = new Simulator(netlist, netlist.metadata.simulation, switchValues)
  }

  /** Current logic value on the net attached to a pin (`comp#pin`). */
  pin(pinId: PinId): LogicValue {
    const v = this.sim.getPinValues()[pinId]
    if (v === undefined) throw new Error(`pin ${pinId} is not a single-bit pin (or does not exist)`)
    return v
  }

  /** Hex string on a bus pin. */
  bus(pinId: PinId): string {
    const v = this.sim.getBusPinValues()[pinId]
    if (v === undefined) throw new Error(`pin ${pinId} is not a bus pin (or does not exist)`)
    return v
  }

  /** Values of `prefix0..prefix{n-1}` pins as a string, MSB first (e.g. "0101"). */
  vec(compId: string, prefix: string, n: number): string {
    let s = ''
    for (let i = n - 1; i >= 0; i--) s += this.pin(makePinId(compId, `${prefix}${i}`))
    return s
  }

  /** Sets a switch to a value (toggling only if needed) and settles the circuit. */
  set(switchId: string, value: LogicValue): this {
    if (!(switchId in this.switches)) throw new Error(`no switch ${switchId}`)
    if (this.switches[switchId] !== value) {
      this.switches[switchId] = this.sim.toggle(switchId)
    }
    return this
  }

  /** Sets several switches at once (all toggled before settling). */
  setMany(values: Record<string, LogicValue>): this {
    let dirty = false
    for (const [id, v] of Object.entries(values)) {
      if (this.switches[id] !== v) {
        this.switches[id] = this.sim.toggle(id, false)
        dirty = true
      }
    }
    if (dirty) this.sim.drain()
    return this
  }

  toggle(switchId: string): this {
    this.switches[switchId] = this.sim.toggle(switchId)
    return this
  }

  /** One full pulse on a switch used as a manual clock: 0→1→0 (settled after each). */
  pulse(switchId: string): this {
    this.set(switchId, ONE)
    this.set(switchId, ZERO)
    return this
  }

  /** Rising edge only (assumes the switch is currently 0). */
  rise(switchId: string): this {
    return this.set(switchId, ONE)
  }

  /** Falling edge only (assumes the switch is currently 1). */
  fall(switchId: string): this {
    return this.set(switchId, ZERO)
  }

  step(): this {
    this.sim.step()
    return this
  }

  go(): this {
    this.sim.go()
    return this
  }

  reset(): this {
    this.sim.reset()
    return this
  }

  get time(): number {
    return this.sim.time
  }

  get oscillated(): boolean {
    return this.sim.oscillated
  }
}

/** Shorthand for `comp#pin`. */
export const p = makePinId

/** Parses "0101" (MSB first) into a switch-value map for `prefix{n-1}..prefix0`. */
export function bitsToSwitches(prefix: string, bits: string): Record<string, LogicValue> {
  const out: Record<string, LogicValue> = {}
  const n = bits.length
  for (let i = 0; i < n; i++) {
    out[`${prefix}${n - 1 - i}`] = bits[i] === '1' ? ONE : ZERO
  }
  return out
}

/** All 2^n input combinations as arrays of LogicValue, LSB-first index order. */
export function allCombos(n: number): LogicValue[][] {
  const out: LogicValue[][] = []
  for (let i = 0; i < 1 << n; i++) {
    const row: LogicValue[] = []
    for (let b = 0; b < n; b++) row.push((i >> b) & 1 ? ONE : ZERO)
    out.push(row)
  }
  return out
}
