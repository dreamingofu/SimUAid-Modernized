import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComponentType, LogicValue, type Component } from '../model/types'
import { createEmptyNetlist, serializeNetlist } from '../serialization/ckt'
import { useCircuitStore } from './circuitStore'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function component(id = 'switch'): Component {
  return { id, type: ComponentType.SWITCH, x: 0, y: 0, rotation: 0, label: '', pinLabels: {}, delay: 1 }
}

const api = {
  saveCkt: vi.fn(),
  saveCktAs: vi.fn(),
  openCkt: vi.fn(),
  confirm: vi.fn()
}
const alert = vi.fn()
const state = () => useCircuitStore.getState()

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('window', { api, alert })
  state().newCircuit()
  api.confirm.mockResolvedValue(2)
})

afterEach(() => vi.unstubAllGlobals())

describe('saving circuits without data loss', () => {
  it('keeps failed saves dirty and reports the filesystem error', async () => {
    state().loadNetlist(createEmptyNetlist(), '/work/circuit.ckt')
    state().addComponent(component())
    const document = state().netlist
    api.saveCkt.mockRejectedValue(new Error('Disk is full'))
    expect(await state().save()).toBe(false)
    expect(state().netlist).toBe(document)
    expect(state().dirty).toBe(true)
    expect(alert).toHaveBeenCalledWith(expect.stringContaining('Disk is full'))
  })

  it('does not discard a document when Save-before-New fails', async () => {
    state().addComponent(component())
    const document = state().netlist
    api.confirm.mockResolvedValue(0)
    api.saveCktAs.mockRejectedValue(new Error('Access denied'))
    await state().requestNew()
    expect(state().netlist).toBe(document)
    expect(state().dirty).toBe(true)
  })

  it('keeps edits made while a save is in flight dirty', async () => {
    state().loadNetlist(createEmptyNetlist(), '/work/circuit.ckt')
    state().addComponent(component())
    const write = deferred<void>()
    api.saveCkt.mockReturnValue(write.promise)
    const saving = state().save()
    state().updateComponent('switch', { label: 'Unsaved change' })
    write.resolve(undefined)
    expect(await saving).toBe(false)
    expect(state().dirty).toBe(true)
    expect(JSON.parse(api.saveCkt.mock.calls[0][1]).netlist.components[0].label).toBe('')
    expect(state().netlist.components[0].label).toBe('Unsaved change')
  })

  it('coalesces overlapping saves, then allows saving the new revision', async () => {
    state().loadNetlist(createEmptyNetlist(), '/work/circuit.ckt')
    state().addComponent(component())
    const write = deferred<void>()
    api.saveCkt.mockReturnValueOnce(write.promise).mockResolvedValue(undefined)
    const first = state().save()
    state().updateComponent('switch', { label: 'Latest' })
    const second = state().save()
    expect(second).toBe(first)
    expect(api.saveCkt).toHaveBeenCalledTimes(1)
    write.resolve(undefined)
    expect(await first).toBe(false)
    expect(await state().save()).toBe(true)
    expect(state().dirty).toBe(false)
    expect(JSON.parse(api.saveCkt.mock.calls[1][1]).netlist.components[0].label).toBe('Latest')
  })

  it('never attaches an old Save As result to a newly opened document', async () => {
    state().addComponent(component())
    const write = deferred<string | null>()
    api.saveCktAs.mockReturnValue(write.promise)
    const saving = state().saveAs()
    state().loadNetlist(createEmptyNetlist('Different document'), '/work/different.ckt')
    const document = state().netlist
    write.resolve('/work/old-document.ckt')
    expect(await saving).toBe(false)
    expect(state().netlist).toBe(document)
    expect(state().currentFilePath).toBe('/work/different.ckt')
  })

  it('treats Save As cancellation as unsaved', async () => {
    state().addComponent(component())
    api.saveCktAs.mockResolvedValue(null)
    expect(await state().saveAs()).toBe(false)
    expect(state().dirty).toBe(true)
    expect(state().currentFilePath).toBeNull()
  })

  it('marks persisted switch changes dirty and saves their current values', async () => {
    const netlist = createEmptyNetlist()
    netlist.components.push(component())
    state().loadNetlist(netlist, '/work/switch.ckt')
    state().simToggleSwitch('switch')
    expect(state().dirty).toBe(true)
    api.saveCkt.mockResolvedValue(undefined)
    expect(await state().save()).toBe(true)
    expect(JSON.parse(api.saveCkt.mock.calls[0][1]).netlist.metadata.switchValues.switch).toBe(LogicValue.ONE)
  })

  it('does not clear a switch change that arrives during a save', async () => {
    const netlist = createEmptyNetlist()
    netlist.components.push(component())
    state().loadNetlist(netlist, '/work/switch.ckt')
    const write = deferred<void>()
    api.saveCkt.mockReturnValue(write.promise)
    const saving = state().save()
    state().simToggleSwitch('switch')
    write.resolve(undefined)
    expect(await saving).toBe(false)
    expect(state().dirty).toBe(true)
  })
})

describe('opening circuits without destroying the current session', () => {
  it('reports read failures while preserving the current document', async () => {
    const document = state().netlist
    api.openCkt.mockRejectedValue(new Error('File is unreadable'))
    await state().open()
    expect(state().netlist).toBe(document)
    expect(alert).toHaveBeenCalledWith(expect.stringContaining('File is unreadable'))
  })

  it('rejects malformed files without replacing the current document', async () => {
    const document = state().netlist
    api.openCkt.mockResolvedValue({ path: '/work/bad.ckt', contents: '{"format":"simuaid-ckt","version":1,"netlist":{"components":[null],"wires":[],"metadata":{}}}' })
    await state().open()
    expect(state().netlist).toBe(document)
    expect(alert).toHaveBeenCalledWith(expect.stringContaining('Invalid circuit data'))
  })

  it('keeps edits made while a file read was pending', async () => {
    const read = deferred<{ path: string; contents: string }>()
    api.openCkt.mockReturnValue(read.promise)
    const opening = state().open()
    await vi.waitFor(() => expect(api.openCkt).toHaveBeenCalled())
    state().addComponent(component())
    const edited = state().netlist
    read.resolve({ path: '/work/other.ckt', contents: serializeNetlist(createEmptyNetlist('Other')) })
    await opening
    expect(state().netlist).toBe(edited)
    expect(state().dirty).toBe(true)
    expect(state().statusMessage).toContain('Open cancelled')
  })

  it.each(['new', 'load'])('clears stale editors and simulation state on %s', (action) => {
    useCircuitStore.setState({
      dialog: { kind: 'options' }, smEditorOpen: true, smActive: { old: 1 }, simRunning: true,
      printJob: { title: 'Old', imageUrl: 'data:old', smRows: null },
      activeTool: { kind: 'place', componentType: ComponentType.STATE_MACHINE }
    })
    if (action === 'new') state().newCircuit()
    else state().loadNetlist(createEmptyNetlist(), '/work/new.ckt')
    expect(state()).toMatchObject({
      dialog: null, smEditorOpen: false, smActive: {}, simRunning: false,
      printJob: null, activeTool: { kind: 'select' }
    })
  })

  it.each([Infinity, -Infinity, NaN, -1, 0])('rejects unsafe simulation time %s', (simTimeNs) => {
    const document = state().netlist
    state().setSimulationOptions({ simTimeNs })
    expect(state().netlist).toBe(document)
    expect(state().dirty).toBe(false)
  })

  it('rejects non-finite clock periods without corrupting saved options', () => {
    const document = state().netlist
    state().setSimulationOptions({ clockPeriodNs: Infinity })
    expect(state().netlist).toBe(document)
    expect(state().statusMessage).toContain('Invalid simulation options')
  })

  it('reports excessive simulation requests without leaving Go running', () => {
    const netlist = createEmptyNetlist()
    netlist.components.push({ ...component('clock'), type: ComponentType.CLOCK })
    netlist.metadata.simulation.simTimeNs = 1e12
    state().loadNetlist(netlist, null)
    expect(() => state().simGo()).not.toThrow()
    expect(state().simRunning).toBe(false)
    expect(state().simTimeNs).toBe(0)
    expect(state().statusMessage).toMatch(/limit|large|100,000/i)
  })
})
