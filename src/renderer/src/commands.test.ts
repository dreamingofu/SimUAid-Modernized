import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchCommand, subscribeCommandContext } from './commands'
import { ComponentType } from './model/types'
import { useCircuitStore } from './store/circuitStore'

class ElementStub { isContentEditable = false }
class InputStub extends ElementStub {}
class TextareaStub extends ElementStub {}
class SelectStub extends ElementStub {}
const api = { editText: vi.fn(), setCommandContext: vi.fn(), confirm: vi.fn() }
let documentStub: { activeElement: ElementStub | null; body: ElementStub; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> }
let listeners: Record<string, (event: { target?: ElementStub; relatedTarget?: ElementStub | null }) => void>
let mutated: () => void
const state = () => useCircuitStore.getState()

beforeEach(() => {
  vi.resetAllMocks()
  api.editText.mockResolvedValue(undefined)
  api.setCommandContext.mockResolvedValue(undefined)
  api.confirm.mockResolvedValue(0)
  listeners = {}
  documentStub = {
    activeElement: null,
    body: new ElementStub(),
    addEventListener: vi.fn((name, callback) => { listeners[name] = callback }),
    removeEventListener: vi.fn()
  }
  vi.stubGlobal('document', documentStub)
  vi.stubGlobal('window', { api })
  vi.stubGlobal('HTMLElement', ElementStub)
  vi.stubGlobal('HTMLInputElement', InputStub)
  vi.stubGlobal('HTMLTextAreaElement', TextareaStub)
  vi.stubGlobal('HTMLSelectElement', SelectStub)
  vi.stubGlobal('MutationObserver', class {
    constructor(callback: () => void) { mutated = callback }
    observe = vi.fn()
    disconnect = vi.fn()
  })
  state().newCircuit()
  state().addComponent({ id: 'part', type: ComponentType.NOT, x: 0, y: 0, rotation: 0, label: '', pinLabels: {}, delay: 1 })
})
afterEach(() => vi.unstubAllGlobals())

describe('command focus ownership', () => {
  it.each([InputStub, TextareaStub, SelectStub])('routes Select All and Delete to focused %s', async (Element) => {
    documentStub.activeElement = new Element()
    const netlist = state().netlist
    await dispatchCommand('edit.selectAll')
    await dispatchCommand('edit.delete')
    expect(api.editText.mock.calls).toEqual([['selectAll'], ['delete']])
    expect(state().selection.componentIds).toEqual([])
    expect(state().netlist).toBe(netlist)
  })

  it('protects contenteditable text from circuit shortcuts', async () => {
    documentStub.activeElement = Object.assign(new ElementStub(), { isContentEditable: true })
    await dispatchCommand('edit.selectAll')
    await dispatchCommand('parts.and2')
    await dispatchCommand('sim.change')
    expect(api.editText).toHaveBeenCalledWith('selectAll')
    expect(state().activeTool).toEqual({ kind: 'select' })
    expect(state().simTimeNs).toBe(0)
  })

  it('keeps canvas selection working when focus is not a text editor', async () => {
    documentStub.activeElement = new ElementStub()
    await dispatchCommand('edit.selectAll')
    expect(state().selection.componentIds).toEqual(['part'])
    expect(api.editText).not.toHaveBeenCalled()
  })

  it('blocks circuit commands while a dialog is open, even with button focus', async () => {
    state().openDialog({ kind: 'defaultDelay' })
    documentStub.activeElement = new ElementStub()
    const netlist = state().netlist
    await dispatchCommand('edit.selectAll')
    await dispatchCommand('edit.delete')
    await dispatchCommand('parts.and2')
    await dispatchCommand('file.new')
    expect(state().netlist).toBe(netlist)
    expect(state().selection.componentIds).toEqual([])
    expect(state().activeTool).toEqual({ kind: 'select' })
    expect(api.confirm).not.toHaveBeenCalled()
  })

  it('preserves circuit commands while the nonmodal state table is open', async () => {
    state().setSmEditorOpen(true)
    await dispatchCommand('edit.selectAll')
    expect(state().selection.componentIds).toEqual(['part'])
    const stop = subscribeCommandContext()
    expect(api.setCommandContext).toHaveBeenLastCalledWith(false, false)
    stop()
  })

  it('tracks editing focus and modal state and restores accelerators on cleanup', () => {
    const stop = subscribeCommandContext()
    expect(api.setCommandContext).toHaveBeenLastCalledWith(false, false)
    const input = new InputStub()
    listeners.focusin({ target: input })
    expect(api.setCommandContext).toHaveBeenLastCalledWith(true, false)
    state().openDialog({ kind: 'options' })
    expect(api.setCommandContext).toHaveBeenLastCalledWith(true, true)
    listeners.focusout({ relatedTarget: null })
    expect(api.setCommandContext).toHaveBeenLastCalledWith(false, true)
    state().closeDialog()
    expect(api.setCommandContext).toHaveBeenLastCalledWith(false, false)
    stop()
    expect(documentStub.removeEventListener).toHaveBeenCalledTimes(2)
    expect(api.setCommandContext).toHaveBeenLastCalledWith(false, false)
  })

  it('restores circuit accelerators when a focused dialog input unmounts without focusout', () => {
    documentStub.activeElement = new InputStub()
    state().openDialog({ kind: 'defaultDelay' })
    const stop = subscribeCommandContext()
    expect(api.setCommandContext).toHaveBeenLastCalledWith(true, true)
    state().closeDialog()
    documentStub.activeElement = documentStub.body
    mutated()
    expect(api.setCommandContext).toHaveBeenLastCalledWith(false, false)
    stop()
  })
})
