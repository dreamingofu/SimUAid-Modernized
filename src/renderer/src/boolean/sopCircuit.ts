// Builds an editable two-level gate circuit (NOT → AND → OR) for a minimum SOP,
// with one INPUT_SIGNAL per input that walks through every input combination
// (100 ns per row, first input = MSB) and probes for each input and the output.
//
// Layout, left to right: input sources stacked in rows; a vertical rail per
// literal (true rails for every input, complement rails behind a NOT only where a
// term needs them); a column of AND gates tapping the rails; the OR tree; the
// output probe. True rails continue below the gates and step out to the input
// probes, so every connection is a drawn wire (no named-net shortcuts).

import { ComponentType, LogicValue, makePinId, type Component, type Netlist, type SignalRow, type Wire } from '../model/types'
import { createEmptyNetlist } from '../serialization/ckt'
import { formatTerm, type BooleanAnalysis, type Implicant } from './expression'

export const STIMULUS_INTERVAL_NS = 100

type Point = { x: number; y: number }

const SOURCE_X = 40
const TOP = 40
const ROW_PITCH = 60
const RAIL_GAP = 40
const PITCH = 20
const GATE_W = 60
const GATE_GAP = 20

const AND_BY_ARITY: Record<number, ComponentType> = {
  2: ComponentType.AND2, 3: ComponentType.AND3, 4: ComponentType.AND4, 5: ComponentType.AND5
}
const OR_BY_ARITY: Record<number, ComponentType> = {
  2: ComponentType.OR2, 3: ComponentType.OR3, 4: ComponentType.OR4, 5: ComponentType.OR5
}

/** Change points of input `index` when `count` inputs count up from 0 every interval. */
export function stimulusRows(index: number, count: number): SignalRow[] {
  const rows: SignalRow[] = []
  let previous = -1
  for (let r = 0; r < 1 << count; r++) {
    const bit = (r >> (count - 1 - index)) & 1
    if (bit !== previous) rows.push({ timeNs: r * STIMULUS_INTERVAL_NS, value: bit ? LogicValue.ONE : LogicValue.ZERO })
    previous = bit
  }
  return rows
}

export interface SopCircuitOptions {
  name?: string
  /** Fixed ISO timestamp for reproducible files; defaults to now. */
  timestamp?: string
}

export function buildSopCircuit(analysis: BooleanAnalysis, options: SopCircuitOptions = {}): Netlist {
  const { variables, terms, outputName } = analysis
  const n = variables.length
  const bitOf = (i: number): number => 1 << (n - 1 - i)
  const netlist = createEmptyNetlist(options.name ?? `${outputName}-sop`)
  if (options.timestamp) {
    netlist.metadata.createdAt = options.timestamp
    netlist.metadata.modifiedAt = options.timestamp
  }
  const components: Component[] = []
  const wires: Wire[] = []
  const probes: Component[] = []
  const part = (id: string, type: ComponentType, x: number, y: number, label: string, extra: Partial<Component> = {}): Component => {
    const c: Component = { id, type, x, y, rotation: 0, label, pinLabels: {}, delay: netlist.metadata.defaultDelay, ...extra }
    ;(type === ComponentType.PROBE ? probes : components).push(c)
    return c
  }
  const wire = (id: string, path: Point[], from: string | null = null, to: string | null = null): void => {
    const points = path.filter((p, i) => i === 0 || p.x !== path[i - 1].x || p.y !== path[i - 1].y)
    const segments = []
    for (let i = 0; i + 1 < points.length; i++) {
      segments.push({ x1: points[i].x, y1: points[i].y, x2: points[i + 1].x, y2: points[i + 1].y })
    }
    wires.push({ id, segments, fromPinId: from, toPinId: to, netId: '' })
  }

  // Input rows and their literal rails. The last input's rails are leftmost so
  // no row wire crosses a rail on its way in.
  const rowY = variables.map((_, i) => TOP + PITCH + i * ROW_PITCH)
  const needsComplement = variables.map((_, i) =>
    terms.some((t) => (t.mask & bitOf(i)) !== 0 && (t.bits & bitOf(i)) === 0))
  const trueRail: number[] = []
  const notRail: (number | null)[] = []
  let x = SOURCE_X + 80
  for (let i = n - 1; i >= 0; i--) {
    trueRail[i] = x
    if (needsComplement[i]) {
      notRail[i] = x + 100
      x += 100 + RAIL_GAP
    } else {
      notRail[i] = null
      x += RAIL_GAP
    }
  }
  const lastRail = x - RAIL_GAP
  const gateX = lastRail + 80

  variables.forEach((v, i) => {
    const y = rowY[i]
    const src = part(`in-${v}`, ComponentType.INPUT_SIGNAL, SOURCE_X, y - PITCH, v, {
      pinLabels: { out: v },
      signal: stimulusRows(i, n)
    })
    const srcPin = makePinId(src.id, 'out')
    const railX = trueRail[i]
    const notX = notRail[i]
    if (notX !== null) {
      const inv = part(`not-${v}`, ComponentType.NOT, railX + PITCH, y - PITCH, `${v}'`)
      wire(`w-row-${v}`, [{ x: SOURCE_X + 40, y }, { x: railX, y }, { x: railX + PITCH, y }], srcPin, makePinId(inv.id, 'in1'))
    } else {
      wire(`w-row-${v}`, [{ x: SOURCE_X + 40, y }, { x: railX, y }], srcPin, null)
    }
  })

  // Product terms: an AND gate per multi-literal term; a single literal passes
  // straight through the gate column on its own wire.
  const taps = new Map<string, number[]>()
  const tap = (rail: string, y: number): void => {
    taps.set(rail, [...(taps.get(rail) ?? []), y])
  }
  const railX = (i: number, positive: boolean): number => (positive ? trueRail[i] : notRail[i]!)
  const railKey = (i: number, positive: boolean): string => `${positive ? 'T' : 'N'}${i}`

  // Gates sit beside the input rows once their rails exist: a tap must be at or
  // below its rail's row, and clear of the NOT gate in that row.
  const minTapY = (i: number, positive: boolean): number =>
    rowY[i] + (positive && needsComplement[i] ? 2 * PITCH : 0)
  let gy = TOP
  const termOutputs: Point[] = []
  const literalsOf = (t: Implicant): { i: number; positive: boolean }[] =>
    variables.flatMap((_, i) => (t.mask & bitOf(i)) ? [{ i, positive: (t.bits & bitOf(i)) !== 0 }] : [])

  const isConstant = terms.length === 0 || (terms.length === 1 && terms[0].mask === 0)
  if (isConstant) {
    const one = terms.length === 1
    part(`const-${outputName}`, one ? ComponentType.VCC : ComponentType.GROUND, gateX, gy, one ? '1' : '0')
    termOutputs.push({ x: gateX + 40, y: gy + PITCH })
    gy += 2 * PITCH + GATE_GAP
  } else {
    terms.forEach((t, k) => {
      const lits = literalsOf(t)
      gy = Math.max(gy, ...lits.map(({ i, positive }, m) => minTapY(i, positive) - (m + 1) * PITCH))
      if (lits.length === 1) {
        const y = gy + PITCH
        const { i, positive } = lits[0]
        tap(railKey(i, positive), y)
        wire(`w-term-${k + 1}`, [{ x: railX(i, positive), y }, { x: gateX + GATE_W, y }])
        termOutputs.push({ x: gateX + GATE_W, y })
        gy += 2 * PITCH
        return
      }
      const gate = part(`and-${k + 1}`, AND_BY_ARITY[lits.length], gateX, gy, formatTerm(t, variables))
      lits.forEach(({ i, positive }, m) => {
        const y = gy + (m + 1) * PITCH
        tap(railKey(i, positive), y)
        wire(`w-and-${k + 1}-${m + 1}`, [{ x: railX(i, positive), y }, { x: gateX, y }], null, makePinId(gate.id, `in${m + 1}`))
      })
      const height = (lits.length + 1) * PITCH
      termOutputs.push({ x: gateX + GATE_W, y: gy + height / 2 })
      gy += height + GATE_GAP
    })
  }
  const gatesBottom = Math.max(gy, rowY[n - 1] + 3 * PITCH)

  // Complement rails: NOT output, then down through their taps.
  variables.forEach((v, i) => {
    const notX = notRail[i]
    if (notX === null) return
    const ys = [...(taps.get(railKey(i, false)) ?? [])].sort((a, b) => a - b)
    const start = { x: trueRail[i] + PITCH + GATE_W, y: rowY[i] }
    wire(`w-rail-${v}'`, [start, { x: notX, y: rowY[i] }, ...ys.map((y) => ({ x: notX, y }))], makePinId(`not-${v}`, 'out'))
  })

  // True rails run past the gates and step out to the input probes; the first
  // input (rightmost rail) turns out highest so the steps never cross a rail.
  const probeX = gateX
  variables.forEach((v, i) => {
    const ys = [...(taps.get(railKey(i, true)) ?? [])].sort((a, b) => a - b)
    const stepY = gatesBottom + 2 * PITCH + i * ROW_PITCH
    const probe = part(`probe-${v}`, ComponentType.PROBE, probeX, stepY - PITCH, v)
    wire(`w-rail-${v}`, [
      { x: trueRail[i], y: rowY[i] },
      ...ys.map((y) => ({ x: trueRail[i], y })),
      { x: trueRail[i], y: stepY },
      { x: probeX, y: stepY }
    ], null, makePinId(probe.id, 'in'))
  })

  // OR tree (OR5 is the widest gate; more terms use a second level).
  let orCount = 0
  const combine = (sources: Point[], x0: number): Point => {
    if (sources.length === 1) return sources[0]
    if (sources.length > 5) {
      const half = Math.ceil(sources.length / 2)
      const outs = [combine(sources.slice(0, half), x0), combine(sources.slice(half), x0)]
      return combine(outs, Math.max(...outs.map((p) => p.x)))
    }
    const k = sources.length
    const id = `or-${++orCount}`
    const height = (k + 1) * PITCH
    const mid = (sources[0].y + sources[k - 1].y) / 2
    const oy = Math.max(TOP, Math.round((mid - height / 2) / 10) * 10)
    const pinY = sources.map((_, m) => oy + (m + 1) * PITCH)
    const down = sources.map((_, m) => m).filter((m) => pinY[m] > sources[m].y)
    const up = sources.map((_, m) => m).filter((m) => pinY[m] < sources[m].y)
    const channel = new Map<number, number>()
    down.forEach((m, j) => channel.set(m, down.length - 1 - j))
    up.forEach((m, j) => channel.set(m, j))
    const channels = Math.max(down.length, up.length)
    const orX = x0 + 2 * PITCH + channels * PITCH
    const gate = part(id, OR_BY_ARITY[k], orX, oy, 'OR')
    sources.forEach((s, m) => {
      const to = makePinId(gate.id, `in${m + 1}`)
      const ch = channel.get(m)
      if (ch === undefined) {
        wire(`w-${id}-${m + 1}`, [s, { x: orX, y: s.y }], null, to)
      } else {
        const cx = x0 + PITCH + ch * PITCH
        wire(`w-${id}-${m + 1}`, [s, { x: cx, y: s.y }, { x: cx, y: pinY[m] }, { x: orX, y: pinY[m] }], null, to)
      }
    })
    return { x: orX + GATE_W, y: oy + height / 2 }
  }
  const out = combine(termOutputs, gateX + GATE_W)
  const outProbe = part(`probe-${outputName}`, ComponentType.PROBE, out.x + 2 * PITCH, out.y - PITCH, outputName)
  wire(`w-out-${outputName}`, [out, { x: out.x + 2 * PITCH, y: out.y }], null, makePinId(outProbe.id, 'in'))

  netlist.components = [...components, ...probes]
  netlist.wires = wires
  netlist.metadata.simulation = {
    ...netlist.metadata.simulation,
    simTimeNs: (1 << n) * STIMULUS_INTERVAL_NS
  }
  netlist.metadata.comment =
    `${outputName} = ${analysis.expression}; minimum SOP ${outputName} = ${analysis.minimumSop}. ` +
    `Inputs ${variables.join(', ')} (first is MSB) count from 0 every ${STIMULUS_INTERVAL_NS} ns.`
  return netlist
}
