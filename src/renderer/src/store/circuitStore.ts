// Zustand store: the single source of truth for editor runtime state — the
// netlist document, viewport, selection, transient interaction (wire drafts,
// inline edits), dialogs, and the published simulation snapshot. The simulator
// itself lives outside the store (see the engine cache below).

import { create } from 'zustand'
import {
  ComponentType,
  LogicValue,
  SimMode,
  type Component,
  type Netlist,
  type PinId,
  type SimulationOptions,
  type SmRow,
  type Wire
} from '../model/types'
import { busWidthOfWire } from '../geometry/pins'
import {
  confirmDiscardIfDirty,
  hasTimedSource,
  netlistForSave,
  recallSmTable,
  rememberSmTables,
  stampNetIds,
  touch
} from './netlistOps'
import { DEFAULT_BITS, defOf, getPartDefinition } from '../model/partDefinitions'
import { SimulationLimitError, Simulator, type WaveformTrace } from '../sim/engine'
import { hexToVec } from '../sim/values'
import {
  createEmptyNetlist,
  deserializeNetlist,
  serializeNetlist
} from '../serialization/ckt'
import {
  clampScale,
  fitToBounds,
  screenToWorld,
  snapToGrid,
  GRID,
  type Point,
  type Viewport
} from '../geometry/coords'
import { componentsBounds } from '../geometry/hitTest'
import { pointsToSegments, reattachEndpoint, routeOrthogonal, segmentsToPoints } from '../geometry/wireRouting'
import { findNetContaining, resolveNets } from '../netlist/nets'

/** The active editing tool (discriminated union; `place` carries the part type). */
export type ActiveTool =
  | { kind: 'select' }
  | { kind: 'wire' }
  | { kind: 'label' }
  | { kind: 'move' }
  | { kind: 'erase' }
  | { kind: 'delay' }
  | { kind: 'place'; componentType: ComponentType; bits?: number; extra?: Partial<Component> }

export interface Selection {
  componentIds: string[]
  wireIds: string[]
  labelOnlyComponentId: string | null
}

export interface NetHighlight {
  wireIds: string[]
  pinIds: PinId[]
}

export interface WireDraft {
  fromPinId: PinId | null
  points: Point[]
}

export interface InlineEditTarget {
  kind: 'device' | 'pin'
  componentId: string
  pinName: string | null
  value: string
  /** Window (client) coordinates of the click, for positioning the editor. */
  screenX: number
  screenY: number
}

export interface InteractionState {
  wireDraft: WireDraft | null
  cursor: Point | null
  inlineEdit: InlineEditTarget | null
}

export type DialogState =
  | { kind: 'delay'; componentId: string }
  | { kind: 'scaling' }
  | { kind: 'options' }
  | { kind: 'defaultDelay' }
  | { kind: 'inputSignal'; componentId: string }
  | { kind: 'placeNBit'; componentType: ComponentType }
  | { kind: 'placeSM' }
  | { kind: 'vhdl' }
  | { kind: 'busTap'; wireId: string; x: number; y: number }
  | { kind: 'graphicsMode' }
  | { kind: 'printPreview' }
  | null

const EMPTY_SELECTION: Selection = {
  componentIds: [],
  wireIds: [],
  labelOnlyComponentId: null
}

const EMPTY_INTERACTION: InteractionState = {
  wireDraft: null,
  cursor: null,
  inlineEdit: null
}

interface CircuitState {
  netlist: Netlist
  currentFilePath: string | null
  dirty: boolean
  simMode: SimMode
  activeTool: ActiveTool
  showIoValues: boolean
  timingPanelVisible: boolean
  gridEnabled: boolean
  selection: Selection
  highlight: NetHighlight | null
  interaction: InteractionState
  dialog: DialogState
  viewport: Viewport
  canvasSize: { w: number; h: number }
  simTimeNs: number
  simRunning: boolean
  pinValues: Record<PinId, LogicValue>
  busPinValues: Record<PinId, string>
  switchValues: Record<string, LogicValue>
  waveforms: WaveformTrace[]
  smActive: Record<string, number | null>
  smEditorOpen: boolean
  /** 'dpi' renders DPI-crisp; 'fixed' renders at 1:1 CSS pixels (legacy look). */
  graphicsMode: 'dpi' | 'fixed'
  printJob: { title: string; imageUrl: string; smRows: SmRow[] | null } | null
  timingScaleNs: number
  timingCursorNs: number | null
  statusMessage: string
  redrawNonce: number

  // Document lifecycle
  newCircuit: () => void
  requestNew: () => Promise<void>
  loadNetlist: (netlist: Netlist, path: string | null) => void

  // Component / wire editing
  addComponent: (component: Component) => void
  addComponentAt: (type: ComponentType, worldPt: Point, bits?: number, extra?: Partial<Component>) => void
  placeBusTap: (wireId: string, at: Point, bits: number, msb: boolean) => void
  setSmEditorOpen: (open: boolean) => void
  setGraphicsMode: (mode: 'dpi' | 'fixed') => void
  setPrintJob: (job: CircuitState['printJob']) => void
  updateComponent: (id: string, patch: Partial<Component>) => void
  moveComponentTo: (id: string, x: number, y: number) => void
  nudgeSelection: (dx: number, dy: number) => void
  addWire: (wire: Wire) => void

  // Wire drafting
  beginWire: (fromPinId: PinId | null, startPoint: Point) => void
  addWirePoint: (point: Point, hFirst: boolean) => void
  finishWire: (point: Point, toPinId: PinId | null, hFirst: boolean) => boolean
  setWireCursor: (point: Point | null) => void
  cancelWire: () => void

  // Inline label editing
  beginInlineEdit: (target: InlineEditTarget) => void
  setInlineEditValue: (value: string) => void
  commitInlineEdit: () => void
  cancelInlineEdit: () => void

  // Selection
  selectComponent: (id: string) => void
  selectWire: (id: string) => void
  selectLabelOnly: (id: string) => void
  selectAll: () => void
  clearSelection: () => void
  highlightNetByWire: (wireId: string) => void
  clearHighlight: () => void

  // Deletion
  deleteSelected: () => number
  deleteWires: (ids: string[]) => void
  deleteComponentAndWires: (id: string) => void

  // Dialogs
  openDialog: (dialog: NonNullable<DialogState>) => void
  closeDialog: () => void

  // View / viewport
  setCanvasSize: (w: number, h: number) => void
  setViewport: (viewport: Viewport) => void
  resetViewport: () => void
  fitToWindow: () => void
  setScale: (factor: number) => void
  zoomAt: (screenPt: Point, factor: number) => void
  panBy: (dx: number, dy: number) => void

  // UI / sim toggles
  setActiveTool: (tool: ActiveTool) => void
  setSimMode: (mode: SimMode) => void
  toggleIoValues: () => void
  toggleTimingPanel: () => void
  toggleGrid: () => void
  setStatusMessage: (message: string) => void
  requestRedraw: () => void

  // Simulation
  simReset: () => void
  simSettle: () => void
  simToggleSwitch: (id: string) => void
  simStep: () => void
  simGo: () => void
  simStop: () => void
  simChangeStep: () => void
  enterChangeMode: () => void
  setSimulationOptions: (patch: Partial<SimulationOptions>) => void
  setDefaultDelay: (ns: number) => void
  setTimingScale: (ns: number) => void
  setTimingCursor: (ns: number | null) => void

  // File operations
  open: () => Promise<void>
  save: () => Promise<boolean>
  saveAs: () => Promise<boolean>
}

const uid = (): string => crypto.randomUUID()

// The simulator holds heavy mutable state (event queue, net/FF maps) so it lives
// outside the store. It is cached against the netlist's object identity: a
// structural edit produces a new netlist and forces a rebuild (resetting FF
// state); switch toggles leave the netlist untouched and reuse the engine.
let engine: Simulator | null = null
let documentGeneration = 0
let saveInFlight: Promise<boolean> | null = null

function ensureEngine(get: () => CircuitState): Simulator {
  const s = get()
  if (!engine || engine.sourceNetlist !== s.netlist) {
    engine = new Simulator(s.netlist, s.netlist.metadata.simulation, s.switchValues)
  }
  return engine
}

function publishSim(get: () => CircuitState, set: (partial: Partial<CircuitState>) => void): void {
  if (!engine) return
  const s = get()
  let statusMessage = s.statusMessage
  if (engine.oscillated) {
    statusMessage = 'Simulation stopped: event limit reached (possible oscillation).'
  } else if (s.showIoValues && engine.hasXZ()) {
    statusMessage = 'Warning: X or Z values detected — check connections.'
  }
  set({
    pinValues: engine.getPinValues(),
    busPinValues: { ...engine.getBusPinValues(), ...engine.getSmDisplays() },
    waveforms: engine.getWaveforms(),
    smActive: engine.getSmActive(),
    simTimeNs: engine.time,
    statusMessage
  })
}

function runSimulation(action: () => void, set: (partial: Partial<CircuitState>) => void): boolean {
  try {
    action()
    return true
  } catch (error) {
    if (!(error instanceof SimulationLimitError)) throw error
    set({ simRunning: false, statusMessage: error.message })
    return false
  }
}


export const useCircuitStore = create<CircuitState>((set, get) => ({
  netlist: createEmptyNetlist(),
  currentFilePath: null,
  dirty: false,
  simMode: SimMode.LIVE,
  activeTool: { kind: 'select' },
  showIoValues: false,
  timingPanelVisible: false,
  gridEnabled: true,
  selection: EMPTY_SELECTION,
  highlight: null,
  interaction: EMPTY_INTERACTION,
  dialog: null,
  viewport: { scale: 1, offsetX: 40, offsetY: 40 },
  canvasSize: { w: 800, h: 600 },
  simTimeNs: 0,
  simRunning: false,
  pinValues: {},
  busPinValues: {},
  switchValues: {},
  waveforms: [],
  smActive: {},
  smEditorOpen: false,
  graphicsMode:
    ((typeof localStorage !== 'undefined' &&
      localStorage.getItem('simuaid.graphicsMode')) as 'dpi' | 'fixed') || 'dpi',
  printJob: null,
  timingScaleNs: 5,
  timingCursorNs: null,
  statusMessage: 'Ready',
  redrawNonce: 0,

  newCircuit: () => {
    documentGeneration += 1
    engine = null
    set({
      netlist: createEmptyNetlist(),
      currentFilePath: null,
      dirty: false,
      selection: EMPTY_SELECTION,
      highlight: null,
      interaction: EMPTY_INTERACTION,
      simMode: SimMode.LIVE,
      simRunning: false,
      simTimeNs: 0,
      pinValues: {},
      busPinValues: {},
      switchValues: {},
      waveforms: [],
      smActive: {},
      smEditorOpen: false,
      dialog: null,
      printJob: null,
      activeTool: { kind: 'select' },
      timingCursorNs: null,
      statusMessage: 'New circuit'
    })
  },

  requestNew: async () => {
    if (!(await confirmDiscardIfDirty(get))) return
    get().newCircuit()
  },

  loadNetlist: (netlist, path) => {
    // Resolve first: a rejected document must not alter the current session.
    const loadedNetlist = stampNetIds(netlist)
    documentGeneration += 1
    engine = null
    set({
      netlist: loadedNetlist,
      currentFilePath: path,
      dirty: false,
      selection: EMPTY_SELECTION,
      highlight: null,
      interaction: EMPTY_INTERACTION,
      simMode: SimMode.LIVE,
      simRunning: false,
      simTimeNs: 0,
      pinValues: {},
      busPinValues: {},
      switchValues: netlist.metadata.switchValues ?? {},
      waveforms: [],
      smActive: {},
      smEditorOpen: false,
      dialog: null,
      printJob: null,
      activeTool: { kind: 'select' },
      timingCursorNs: null,
      viewport: { scale: netlist.metadata.scalingFactor || 1, offsetX: 40, offsetY: 40 },
      statusMessage: path ? `Opened ${path}` : 'Loaded circuit'
    })
  },

  addComponent: (component) =>
    set((s) => ({
      netlist: touch({ ...s.netlist, components: [...s.netlist.components, component] }),
      dirty: true
    })),

  addComponentAt: (type, worldPt, bits, extra) => {
    // The manual allows only one Clock and one State Machine per circuit.
    const singleton =
      (type === ComponentType.CLOCK && 'Clock') ||
      (type === ComponentType.STATE_MACHINE && 'State Machine') ||
      (type === ComponentType.CHECKER && 'Checker') ||
      null
    if (singleton && get().netlist.components.some((c) => c.type === type)) {
      set({ statusMessage: `Only one ${singleton} is allowed per circuit` })
      return
    }
    if (type === ComponentType.STATE_MACHINE) {
      extra = { smTable: recallSmTable() ?? [], ...extra }
    }
    const def =
      type === ComponentType.STATE_MACHINE
        ? defOf({ type, smInputs: extra?.smInputs, smOutputs: extra?.smOutputs })
        : getPartDefinition(type, bits)
    let x = snapToGrid(worldPt.x)
    let y = snapToGrid(worldPt.y)
    const boxes = get().netlist.components.map((c) => {
      const d = defOf(c)
      return { x: c.x, y: c.y, w: d.width, h: d.height }
    })
    const overlaps = (px: number, py: number): boolean =>
      boxes.some(
        (b) => px < b.x + b.w && px + def.width > b.x && py < b.y + b.h && py + def.height > b.y
      )
    let guard = 0
    while (overlaps(x, y) && guard++ < 1000) {
      x += GRID
      y += GRID
    }
    get().addComponent({
      id: uid(),
      type,
      x,
      y,
      rotation: 0,
      label: '',
      pinLabels: {},
      delay: get().netlist.metadata.defaultDelay,
      ...(bits !== undefined ? { bits } : {}),
      ...extra
    })
  },

  setSmEditorOpen: (open) => set({ smEditorOpen: open }),

  setGraphicsMode: (mode) => {
    if (typeof localStorage !== 'undefined') localStorage.setItem('simuaid.graphicsMode', mode)
    set({ graphicsMode: mode, statusMessage: `Graphics mode: ${mode === 'dpi' ? 'DPI-scaled' : 'fixed pixel'}` })
  },

  setPrintJob: (job) => set({ printJob: job }),

  placeBusTap: (wireId, at, bits, msb) =>
    set((s) => {
      const wire = s.netlist.wires.find((w) => w.id === wireId)
      if (!wire) return {}
      const width = busWidthOfWire(s.netlist, wire)
      const n = Math.min(bits, width)
      const tapStart = msb ? width - n : 0

      // Snap the tap point onto the nearest wire segment and split it there, so
      // the tap pin's coordinate becomes part of the net.
      let best: { seg: number; p: Point; d: number } | null = null
      const pts = segmentsToPoints(wire.segments)
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i]
        const b = pts[i + 1]
        const p =
          a.y === b.y
            ? { x: Math.min(Math.max(at.x, Math.min(a.x, b.x)), Math.max(a.x, b.x)), y: a.y }
            : { x: a.x, y: Math.min(Math.max(at.y, Math.min(a.y, b.y)), Math.max(a.y, b.y)) }
        const d = Math.hypot(p.x - at.x, p.y - at.y)
        if (!best || d < best.d) best = { seg: i, p, d }
      }
      if (!best) return {}
      const tapPt = { x: snapToGrid(best.p.x), y: snapToGrid(best.p.y) }
      const newPts = pts.slice()
      newPts.splice(best.seg + 1, 0, tapPt)

      const tap: Component = {
        id: uid(),
        type: ComponentType.BUS_TAP,
        x: tapPt.x - 20,
        y: tapPt.y - 20,
        rotation: 0,
        label: n === width ? `${width - 1}:0` : msb ? `${width - 1}:${width - n}` : `${n - 1}:0`,
        pinLabels: {},
        delay: s.netlist.metadata.defaultDelay,
        bits: n,
        tapStart
      }

      return {
        netlist: stampNetIds(
          touch({
            ...s.netlist,
            components: [...s.netlist.components, tap],
            wires: s.netlist.wires.map((w) =>
              w.id === wireId ? { ...w, segments: pointsToSegments(newPts) } : w
            )
          })
        ),
        dirty: true,
        statusMessage: `Bus tap ${tap.label} placed`
      }
    }),

  updateComponent: (id, patch) =>
    set((s) => ({
      netlist: touch({
        ...s.netlist,
        components: s.netlist.components.map((c) => (c.id === id ? { ...c, ...patch } : c))
      }),
      dirty: true
    })),

  moveComponentTo: (id, x, y) =>
    set((s) => {
      const comp = s.netlist.components.find((c) => c.id === id)
      if (!comp) return {}
      const def = defOf(comp)
      const pinDeltas = def.pins.map((p) => ({
        ox: comp.x + p.dx,
        oy: comp.y + p.dy,
        nx: x + p.dx,
        ny: y + p.dy
      }))
      const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.5

      const wires = s.netlist.wires.map((w) => {
        let pts = segmentsToPoints(w.segments)
        if (pts.length < 2) return w
        let changed = false
        // Start endpoint.
        for (const pin of pinDeltas) {
          if (near(pts[0].x, pin.ox) && near(pts[0].y, pin.oy)) {
            pts = reattachEndpoint(pts, true, { x: pin.nx, y: pin.ny })
            changed = true
            break
          }
        }
        // End endpoint (recompute index after a possible corner insertion).
        const lastIdx = pts.length - 1
        for (const pin of pinDeltas) {
          if (near(pts[lastIdx].x, pin.ox) && near(pts[lastIdx].y, pin.oy)) {
            pts = reattachEndpoint(pts, false, { x: pin.nx, y: pin.ny })
            changed = true
            break
          }
        }
        return changed ? { ...w, segments: pointsToSegments(pts) } : w
      })

      const components = s.netlist.components.map((c) => (c.id === id ? { ...c, x, y } : c))
      return { netlist: touch({ ...s.netlist, components, wires }), dirty: true }
    }),

  nudgeSelection: (dx, dy) => {
    const { selection } = get()
    for (const id of selection.componentIds) {
      const c = get().netlist.components.find((comp) => comp.id === id)
      if (c) get().moveComponentTo(id, c.x + dx, c.y + dy)
    }
  },

  addWire: (wire) =>
    set((s) => ({
      netlist: stampNetIds(touch({ ...s.netlist, wires: [...s.netlist.wires, wire] })),
      dirty: true
    })),

  beginWire: (fromPinId, startPoint) =>
    set((s) => ({
      interaction: { ...s.interaction, wireDraft: { fromPinId, points: [startPoint] }, cursor: startPoint }
    })),

  addWirePoint: (point, hFirst) =>
    set((s) => {
      const draft = s.interaction.wireDraft
      if (!draft) return {}
      const last = draft.points[draft.points.length - 1]
      const route = routeOrthogonal(last, point, hFirst).slice(1)
      return {
        interaction: {
          ...s.interaction,
          wireDraft: { ...draft, points: [...draft.points, ...route] }
        }
      }
    }),

  finishWire: (point, toPinId, hFirst) => {
    const draft = get().interaction.wireDraft
    if (!draft) return false
    const last = draft.points[draft.points.length - 1]
    const route = routeOrthogonal(last, point, hFirst).slice(1)
    const points = [...draft.points, ...route]
    if (points.length < 2) {
      get().cancelWire()
      return false
    }
    const wire: Wire = {
      id: uid(),
      segments: pointsToSegments(points),
      fromPinId: draft.fromPinId,
      toPinId,
      netId: ''
    }
    set((s) => ({
      netlist: stampNetIds(touch({ ...s.netlist, wires: [...s.netlist.wires, wire] })),
      dirty: true,
      interaction: { ...s.interaction, wireDraft: null, cursor: null }
    }))
    return true
  },

  setWireCursor: (point) =>
    set((s) => (s.interaction.wireDraft ? { interaction: { ...s.interaction, cursor: point } } : {})),

  cancelWire: () =>
    set((s) => ({ interaction: { ...s.interaction, wireDraft: null, cursor: null } })),

  beginInlineEdit: (target) =>
    set((s) => ({ interaction: { ...s.interaction, inlineEdit: target } })),

  setInlineEditValue: (value) =>
    set((s) =>
      s.interaction.inlineEdit
        ? { interaction: { ...s.interaction, inlineEdit: { ...s.interaction.inlineEdit, value } } }
        : {}
    ),

  commitInlineEdit: () => {
    const edit = get().interaction.inlineEdit
    if (!edit) return
    const comp = get().netlist.components.find((c) => c.id === edit.componentId)
    if (comp) {
      const value = edit.value.trim()
      const isInputSignal = comp.type === ComponentType.INPUT_SIGNAL
      if (comp.type === ComponentType.BUS_INPUT) {
        // The hex string is the device label; no separate pin labels allowed.
        const bits = comp.bits ?? DEFAULT_BITS
        const valid = value === '' || hexToVec(value, bits) !== null
        get().updateComponent(comp.id, { label: value })
        set((s) => ({
          interaction: { ...s.interaction, inlineEdit: null },
          statusMessage: valid
            ? `Bus input set to ${value || '(empty)'}`
            : `"${value}" is not a valid ${bits}-bit hex value — output will be X`
        }))
        return
      }
      if (edit.kind === 'device') {
        // Input Signal: device label and pin label must match.
        if (isInputSignal) {
          const pinName = defOf(comp).pins[0]?.name
          const pinLabels = pinName ? { ...comp.pinLabels, [pinName]: value } : comp.pinLabels
          get().updateComponent(comp.id, { label: value, pinLabels })
        } else {
          get().updateComponent(comp.id, { label: value })
        }
      } else if (edit.pinName) {
        const pinLabels = { ...comp.pinLabels }
        if (value) pinLabels[edit.pinName] = value
        else delete pinLabels[edit.pinName]
        const patch: Partial<Component> = { pinLabels }
        if (isInputSignal) patch.label = value
        get().updateComponent(comp.id, patch)
      }
    }
    set((s) => ({ interaction: { ...s.interaction, inlineEdit: null } }))
  },

  cancelInlineEdit: () =>
    set((s) => ({ interaction: { ...s.interaction, inlineEdit: null } })),

  selectComponent: (id) =>
    set({
      selection: { componentIds: [id], wireIds: [], labelOnlyComponentId: null },
      highlight: null
    }),

  selectWire: (id) =>
    set({
      selection: { componentIds: [], wireIds: [id], labelOnlyComponentId: null },
      highlight: null
    }),

  selectLabelOnly: (id) =>
    set({
      selection: { componentIds: [], wireIds: [], labelOnlyComponentId: id },
      highlight: null
    }),

  selectAll: () =>
    set((s) => ({
      selection: {
        componentIds: s.netlist.components.map((c) => c.id),
        wireIds: s.netlist.wires.map((w) => w.id),
        labelOnlyComponentId: null
      },
      highlight: null,
      statusMessage: 'Selected all'
    })),

  clearSelection: () => set({ selection: EMPTY_SELECTION, highlight: null }),

  highlightNetByWire: (wireId) =>
    set((s) => {
      const nets = resolveNets(s.netlist)
      const net = findNetContaining(nets, { wireId })
      if (!net) return {}
      return {
        highlight: { wireIds: net.wireIds, pinIds: net.pinIds },
        selection: EMPTY_SELECTION,
        statusMessage: `Net highlighted (${net.wireIds.length} wire(s))`
      }
    }),

  clearHighlight: () => set({ highlight: null }),

  deleteSelected: () => {
    const { selection } = get()
    const compSet = new Set(selection.componentIds)
    const wireSet = new Set(selection.wireIds)
    const count = compSet.size + wireSet.size
    if (count === 0) {
      set({ statusMessage: 'Nothing selected to delete' })
      return 0
    }
    rememberSmTables(get().netlist, compSet)
    set((s) => ({
      netlist: stampNetIds(
        touch({
          ...s.netlist,
          components: s.netlist.components.filter((c) => !compSet.has(c.id)),
          wires: s.netlist.wires.filter((w) => !wireSet.has(w.id))
        })
      ),
      selection: EMPTY_SELECTION,
      highlight: null,
      dirty: true,
      statusMessage: `Deleted ${count} item(s)`
    }))
    return count
  },

  deleteWires: (ids) => {
    const wireSet = new Set(ids)
    set((s) => ({
      netlist: stampNetIds(
        touch({ ...s.netlist, wires: s.netlist.wires.filter((w) => !wireSet.has(w.id)) })
      ),
      selection: EMPTY_SELECTION,
      highlight: null,
      dirty: true,
      statusMessage: `Deleted ${wireSet.size} wire(s)`
    }))
  },

  deleteComponentAndWires: (id) =>
    set((s) => {
      rememberSmTables(s.netlist, new Set([id]))
      return {
        netlist: stampNetIds(
          touch({ ...s.netlist, components: s.netlist.components.filter((c) => c.id !== id) })
        ),
        selection: EMPTY_SELECTION,
        highlight: null,
        dirty: true,
        statusMessage: 'Deleted component'
      }
    }),

  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null }),

  setCanvasSize: (w, h) => set({ canvasSize: { w, h } }),
  setViewport: (viewport) => set({ viewport }),

  resetViewport: () => get().setScale(1),

  fitToWindow: () =>
    set((s) => {
      const bounds = componentsBounds(s.netlist)
      const vp = fitToBounds(bounds, s.canvasSize.w, s.canvasSize.h)
      return {
        viewport: vp,
        netlist: { ...s.netlist, metadata: { ...s.netlist.metadata, scalingFactor: vp.scale } },
        statusMessage: 'Fit to window'
      }
    }),

  setScale: (factor) =>
    set((s) => {
      const scale = clampScale(factor)
      const center = { x: s.canvasSize.w / 2, y: s.canvasSize.h / 2 }
      const worldCenter = screenToWorld(center, s.viewport)
      return {
        viewport: {
          scale,
          offsetX: center.x - worldCenter.x * scale,
          offsetY: center.y - worldCenter.y * scale
        },
        netlist: { ...s.netlist, metadata: { ...s.netlist.metadata, scalingFactor: scale } },
        statusMessage: `Scaling: ${Math.round(scale * 100)}%`
      }
    }),

  zoomAt: (screenPt, factor) =>
    set((s) => {
      const scale = clampScale(s.viewport.scale * factor)
      const world = screenToWorld(screenPt, s.viewport)
      return {
        viewport: {
          scale,
          offsetX: screenPt.x - world.x * scale,
          offsetY: screenPt.y - world.y * scale
        }
      }
    }),

  panBy: (dx, dy) =>
    set((s) => ({
      viewport: { ...s.viewport, offsetX: s.viewport.offsetX + dx, offsetY: s.viewport.offsetY + dy }
    })),

  setActiveTool: (tool) =>
    set({
      activeTool: tool,
      interaction: { wireDraft: null, cursor: null, inlineEdit: null },
      statusMessage:
        tool.kind === 'place'
          ? `Place: ${tool.componentType}`
          : `${tool.kind[0].toUpperCase()}${tool.kind.slice(1)} tool`
    }),

  setSimMode: (mode) => set({ simMode: mode, statusMessage: `Mode: ${mode}` }),

  toggleIoValues: () =>
    set((s) => ({
      showIoValues: !s.showIoValues,
      statusMessage: `I/O values ${!s.showIoValues ? 'shown' : 'hidden'}`
    })),

  toggleTimingPanel: () => set((s) => ({ timingPanelVisible: !s.timingPanelVisible })),

  toggleGrid: () => set((s) => ({ gridEnabled: !s.gridEnabled })),

  setStatusMessage: (message) => set({ statusMessage: message }),

  requestRedraw: () => set((s) => ({ redrawNonce: s.redrawNonce + 1 })),

  simReset: () => {
    engine = null
    ensureEngine(get) // constructor settles initial state
    const hasClock = get().netlist.components.some((c) => c.type === ComponentType.CLOCK)
    set({
      simMode: hasClock ? SimMode.CLOCK : SimMode.LIVE,
      simRunning: false,
      simTimeNs: 0,
      timingCursorNs: null,
      statusMessage: 'Simulation reset'
    })
    publishSim(get, set)
  },

  simSettle: () => {
    ensureEngine(get)
    publishSim(get, set)
  },

  simToggleSwitch: (id) => {
    const manual = get().simMode === SimMode.CHANGE
    const next = ensureEngine(get).toggle(id, !manual)
    set((s) => ({ switchValues: { ...s.switchValues, [id]: next }, dirty: true }))
    publishSim(get, set)
    if (manual) set({ statusMessage: 'Change mode: click Change to advance one event' })
  },

  simStep: () => {
    if (!hasTimedSource(get().netlist)) {
      set({ statusMessage: 'Step needs a Clock or Input Signal' })
      return
    }
    if (!runSimulation(() => ensureEngine(get).step(), set)) return
    if (get().netlist.components.some((c) => c.type === ComponentType.CLOCK)) {
      set({ simMode: SimMode.CLOCK })
    }
    publishSim(get, set)
  },

  simGo: () => {
    const s = get()
    if (s.simMode === SimMode.CHANGE) {
      ensureEngine(get).drain()
      publishSim(get, set)
      return
    }
    if (!hasTimedSource(s.netlist)) {
      set({ statusMessage: 'Go needs a Clock or Input Signal' })
      return
    }
    set({ simRunning: true })
    if (!runSimulation(() => ensureEngine(get).go(), set)) return
    set({ simRunning: false })
    if (s.netlist.components.some((c) => c.type === ComponentType.CLOCK)) {
      set({ simMode: SimMode.CLOCK })
    }
    publishSim(get, set)
  },

  simStop: () => set({ simRunning: false }),

  simChangeStep: () => {
    const more = ensureEngine(get).changeStep()
    publishSim(get, set)
    set({ statusMessage: more ? 'Change: applied one event' : 'Change: no pending events' })
  },

  enterChangeMode: () => {
    const s = get()
    if (s.netlist.components.some((c) => c.type === ComponentType.CLOCK)) {
      set({ statusMessage: 'Change Mode is unavailable when a Clock is present' })
      return
    }
    if (s.simMode === SimMode.CHANGE) {
      set({ simMode: SimMode.LIVE, statusMessage: 'Change Mode off' })
      return
    }
    set({ simMode: SimMode.CHANGE, statusMessage: 'Change Mode: toggle a switch, then click Change' })
  },

  setSimulationOptions: (patch) => {
    const options = { ...get().netlist.metadata.simulation, ...patch }
    if (!Number.isFinite(options.simTimeNs) || options.simTimeNs < 1 ||
        !Number.isFinite(options.clockPeriodNs) || options.clockPeriodNs < 2 ||
        (options.clockInitialValue !== LogicValue.ZERO && options.clockInitialValue !== LogicValue.ONE)) {
      set({ statusMessage: 'Invalid simulation options: enter finite times (simulation at least 1 ns, clock period at least 2 ns).' })
      return
    }
    set((s) => ({
      netlist: touch({
        ...s.netlist,
        metadata: {
          ...s.netlist.metadata,
          simulation: options
        }
      }),
      dirty: true
    }))
  },

  setDefaultDelay: (ns) =>
    set((s) => ({
      netlist: touch({
        ...s.netlist,
        metadata: { ...s.netlist.metadata, defaultDelay: Math.min(99, Math.max(1, Math.round(ns))) }
      }),
      dirty: true
    })),

  setTimingScale: (ns) => set({ timingScaleNs: Math.min(100, Math.max(1, ns)) }),

  setTimingCursor: (ns) => set({ timingCursorNs: ns }),

  open: async () => {
    try {
      if (!(await confirmDiscardIfDirty(get))) return
      const previous = get()
      const generation = documentGeneration
      const result = await window.api.openCkt()
      if (!result) return
      const netlist = deserializeNetlist(result.contents)
      // File reads finish asynchronously. Never overwrite another document or
      // edits made after the discard/save decision while the read was pending.
      if (generation !== documentGeneration || previous.netlist !== get().netlist ||
          previous.switchValues !== get().switchValues) {
        set({ statusMessage: 'Open cancelled: the current circuit changed while the file was being read.' })
        return
      }
      get().loadNetlist(netlist, result.path)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      window.alert(`Could not open circuit:\n${message}`)
    }
  },

  save: () => saveDocument(false),

  saveAs: () => saveDocument(true)
}))

/** Coalesce overlapping save commands so older writes cannot replace newer ones. */
function saveDocument(saveAs: boolean): Promise<boolean> {
  if (saveInFlight) return saveInFlight
  saveInFlight = (async () => {
    const { netlist, switchValues, currentFilePath } = useCircuitStore.getState()
    const generation = documentGeneration
    try {
      const contents = serializeNetlist(netlistForSave(netlist, switchValues))
      let path = currentFilePath
      if (saveAs || !path) {
        path = await window.api.saveCktAs(contents, `${netlist.metadata.name || 'Untitled'}.ckt`)
        if (!path) return false
      } else {
        await window.api.saveCkt(path, contents)
      }
      if (generation !== documentGeneration) return false
      const current = useCircuitStore.getState()
      const unchanged = current.netlist === netlist && current.switchValues === switchValues
      useCircuitStore.setState({
        currentFilePath: path,
        dirty: !unchanged,
        statusMessage: unchanged ? `Saved ${path}` : `Saved ${path}; newer changes still need saving.`
      })
      // Save-before-close/new/open must stop if unsaved edits arrived in flight.
      return unchanged
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      useCircuitStore.setState({ statusMessage: 'Save failed. Your changes are still open.' })
      window.alert(`Could not save circuit:\n${message}`)
      return false
    }
  })().finally(() => { saveInFlight = null })
  return saveInFlight
}
