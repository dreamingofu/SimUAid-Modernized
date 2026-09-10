import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { createEmptyNetlist } from '../serialization/ckt'
import VhdlDialog from './VhdlDialog'

// Exercise the real async click handlers without adding a browser/DOM test
// dependency. Hook cells persist between explicit renders, as React state does.
const harness = vi.hoisted(() => ({
  cells: [] as unknown[],
  index: 0,
  state: {
    netlist: {} as ReturnType<typeof createEmptyNetlist>,
    closeDialog: vi.fn(),
    setStatusMessage: vi.fn()
  },
  saveVhdl: vi.fn()
}))

vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = harness.index++
    if (!(index in harness.cells)) harness.cells[index] = typeof initial === 'function' ? initial() : initial
    return [harness.cells[index], (value: unknown) => { harness.cells[index] = value }]
  },
  useRef: (initial: unknown) => {
    const index = harness.index++
    if (!(index in harness.cells)) harness.cells[index] = { current: initial }
    return harness.cells[index]
  }
}))
vi.mock('../store/circuitStore', () => ({
  useCircuitStore: (select: (state: typeof harness.state) => unknown) => select(harness.state)
}))

interface Props {
  children?: ReactNode
  onClick?: () => void
  onClose?: () => void
  disabled?: boolean
  role?: string
}

function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<Props>(node)) return []
  return [node, ...elements(node.props.children)]
}

function render(): ReactElement<Props> {
  harness.index = 0
  return VhdlDialog()
}

function button(view: ReactNode, text: string): ReactElement<Props> {
  const found = elements(view).find((el) => el.type === 'button' && el.props.children === text)
  if (!found) throw new Error(`Missing button: ${text}`)
  return found
}

beforeEach(() => {
  harness.cells = []
  harness.index = 0
  harness.state.netlist = createEmptyNetlist('circuit')
  harness.state.closeDialog.mockReset()
  harness.state.setStatusMessage.mockReset()
  harness.saveVhdl.mockReset()
  vi.stubGlobal('window', { api: { saveVhdl: harness.saveVhdl } })
})

afterEach(() => vi.unstubAllGlobals())

describe('VHDL dialog save handling', () => {
  it('shows a rejected-save error, keeps the dialog open, and allows retry', async () => {
    harness.saveVhdl.mockRejectedValueOnce(new Error('Permission denied')).mockResolvedValueOnce('/tmp/circuit.vhd')
    button(render(), 'Save…').props.onClick!()
    await vi.waitFor(() => expect(harness.state.setStatusMessage).toHaveBeenCalledWith('VHDL export failed: Permission denied'))
    expect(harness.state.closeDialog).not.toHaveBeenCalled()
    const retryView = render()
    expect(elements(retryView).find((el) => el.props.role === 'alert')?.props.children)
      .toBe('VHDL export failed: Permission denied')
    expect(button(retryView, 'Save…').props.disabled).toBe(false)
    button(retryView, 'Save…').props.onClick!()
    await vi.waitFor(() => expect(harness.state.closeDialog).toHaveBeenCalledOnce())
    expect(harness.state.setStatusMessage).toHaveBeenLastCalledWith('VHDL saved to /tmp/circuit.vhd')
  })

  it('blocks duplicate clicks and dismissal while a save is pending', async () => {
    let finish!: (path: string | null) => void
    harness.saveVhdl.mockImplementation(() => new Promise<string | null>((resolve) => { finish = resolve }))
    const view = render()
    const save = button(view, 'Save…').props.onClick!
    save()
    save() // second event before React has rendered the disabled button
    expect(harness.saveVhdl).toHaveBeenCalledOnce()
    const pending = render()
    expect(button(pending, 'Saving…').props.disabled).toBe(true)
    expect(button(pending, 'Cancel').props.disabled).toBe(true)
    pending.props.onClose!()
    expect(harness.state.closeDialog).not.toHaveBeenCalled()
    finish(null)
    await vi.waitFor(() => expect(button(render(), 'Save…').props.disabled).toBe(false))
    expect(harness.state.closeDialog).not.toHaveBeenCalled()
    expect(harness.state.setStatusMessage).not.toHaveBeenCalled()
  })

  it('shows validation errors without attempting a file write', () => {
    harness.state.netlist.metadata.name = 'std_logic'
    button(render(), 'Save…').props.onClick!()
    expect(harness.saveVhdl).not.toHaveBeenCalled()
    expect(harness.state.closeDialog).not.toHaveBeenCalled()
    expect(elements(render()).find((el) => el.props.role === 'alert')?.props.children).toContain('conflicts')
    expect(button(render(), 'Save…').props.disabled).toBe(false)
  })
})
