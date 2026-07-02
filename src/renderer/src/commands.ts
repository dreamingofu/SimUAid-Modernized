// Single command dispatcher. Both the native menu/accelerators (via the
// `menu:command` IPC channel) and the React MenuBar (via onClick) call
// `dispatchCommand`, so there is exactly one place that maps a MenuCommandId to
// behavior and no separate keydown handling anywhere.

import { APP_VERSION } from './serialization/ckt'
import { ComponentType } from './model/types'
import { parseChk } from './sim/checker'
import { renderCircuitImage } from './printing/print'
import { useCircuitStore } from './store/circuitStore'
import { menuCommandLabel, type MenuCommandId } from '../../shared/menu'

/** Parts menu commands -> the component type they place. */
const PLACE_BY_ID: Partial<Record<MenuCommandId, ComponentType>> = {
  'parts.and2': ComponentType.AND2,
  'parts.and3': ComponentType.AND3,
  'parts.and4': ComponentType.AND4,
  'parts.and5': ComponentType.AND5,
  'parts.or2': ComponentType.OR2,
  'parts.or3': ComponentType.OR3,
  'parts.or4': ComponentType.OR4,
  'parts.or5': ComponentType.OR5,
  'parts.nand2': ComponentType.NAND2,
  'parts.nand3': ComponentType.NAND3,
  'parts.nand4': ComponentType.NAND4,
  'parts.nand5': ComponentType.NAND5,
  'parts.nor2': ComponentType.NOR2,
  'parts.nor3': ComponentType.NOR3,
  'parts.nor4': ComponentType.NOR4,
  'parts.nor5': ComponentType.NOR5,
  'parts.xor2': ComponentType.XOR2,
  'parts.xnor2': ComponentType.XNOR2,
  'parts.not': ComponentType.NOT,
  'parts.switch': ComponentType.SWITCH,
  'parts.probe': ComponentType.PROBE,
  'parts.dFlipFlop': ComponentType.D_FLIPFLOP,
  'parts.jkFlipFlop': ComponentType.JK_FLIPFLOP,
  'parts.clock': ComponentType.CLOCK,
  'parts.inputSignal': ComponentType.INPUT_SIGNAL,
  'parts.fullAdder': ComponentType.FULL_ADDER,
  'parts.decoder2': ComponentType.DECODER_2TO4,
  'parts.decoder3': ComponentType.DECODER_3TO8,
  'parts.mux2to1': ComponentType.MUX_2,
  'parts.mux4to1': ComponentType.MUX_4,
  'parts.mux8to1': ComponentType.MUX_8,
  'parts.sevenSeg': ComponentType.SEVEN_SEGMENT,
  'parts.tristateRight': ComponentType.TRISTATE_RIGHT,
  'parts.tristateLeft': ComponentType.TRISTATE_LEFT,
  'parts.tristateUp': ComponentType.TRISTATE_UP,
  'parts.tristateDown': ComponentType.TRISTATE_DOWN,
  'parts.vcc': ComponentType.VCC,
  'parts.ground': ComponentType.GROUND
}

/** Parameterized parts prompt for a bit width before entering placement mode. */
const N_BIT_BY_ID: Partial<Record<MenuCommandId, ComponentType>> = {
  'parts.nAdder': ComponentType.N_ADDER,
  'parts.nCounter': ComponentType.N_COUNTER,
  'parts.nLoadCounter': ComponentType.N_LOADABLE_COUNTER,
  'parts.nRegister': ComponentType.N_REGISTER,
  'parts.nShiftLeft': ComponentType.N_SHIFT_LEFT,
  'parts.nShiftRight': ComponentType.N_SHIFT_RIGHT,
  'parts.nShiftBidir': ComponentType.N_SHIFT_BIDIR,
  'parts.nMux': ComponentType.N_MUX_2TO1,
  'parts.nTristate': ComponentType.N_TRISTATE,
  'parts.busInput': ComponentType.BUS_INPUT,
  'parts.busProbe': ComponentType.BUS_PROBE,
  'parts.splitter': ComponentType.SPLITTER,
  'parts.merger': ComponentType.MERGER,
  'parts.complementer': ComponentType.COMPLEMENTER
}

function showAbout(): void {
  window.alert(
    `SimUaid (Modernized)\nVersion ${APP_VERSION}\n\n` +
      'A modern reimplementation of SimUaid, a logic-simulation tool\n' +
      'originally by Charles H. Roth, Jr., University of Texas at Austin.'
  )
}

/** Delete with the spec's warnings for whole-net and whole-circuit removals. */
async function confirmAndDelete(): Promise<void> {
  const store = useCircuitStore.getState()

  // A highlighted net (Shift+click) deletes the entire net.
  const highlight = store.highlight
  if (highlight && highlight.wireIds.length > 0) {
    const choice = await window.api.confirm({
      type: 'warning',
      message: 'Delete this entire net?',
      detail: `${highlight.wireIds.length} wire(s) will be removed.`,
      buttons: ['Delete', 'Cancel'],
      defaultId: 0,
      cancelId: 1
    })
    if (choice === 0) store.deleteWires(highlight.wireIds)
    return
  }

  const { selection, netlist } = store
  const selCount = selection.componentIds.length + selection.wireIds.length
  if (selCount === 0) {
    store.setStatusMessage('Nothing selected to delete')
    return
  }

  const total = netlist.components.length + netlist.wires.length
  if (total > 0 && selCount === total) {
    const choice = await window.api.confirm({
      type: 'warning',
      message: 'Delete the entire circuit?',
      detail: 'All components and wires will be removed.',
      buttons: ['Delete All', 'Cancel'],
      defaultId: 1,
      cancelId: 1
    })
    if (choice === 0) store.deleteSelected()
    return
  }

  store.deleteSelected()
}

export async function dispatchCommand(id: MenuCommandId): Promise<void> {
  const store = useCircuitStore.getState()

  // Native accelerators fire even while typing in an input/dialog; don't let the
  // destructive canvas commands hijack the keystroke in that case.
  const el = document.activeElement
  const typing =
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  if (typing && (id === 'edit.delete' || id === 'edit.selectAll')) return

  switch (id) {
    // File
    case 'file.new':
      await store.requestNew()
      return
    case 'file.open':
      await store.open()
      return
    case 'file.save':
      await store.save()
      return
    case 'file.saveAs':
      await store.saveAs()
      return
    case 'file.saveVhdl':
      store.openDialog({ kind: 'vhdl' })
      return
    case 'file.print':
    case 'file.printPreview': {
      const image = renderCircuitImage(store.netlist, store.pinValues, store.busPinValues)
      if (!image) {
        store.setStatusMessage('Nothing to print — the circuit is empty')
        return
      }
      const sm = store.netlist.components.find((c) => c.type === ComponentType.STATE_MACHINE)
      store.setPrintJob({
        title: store.netlist.metadata.name || 'Untitled',
        imageUrl: image,
        smRows: sm?.smTable?.filter((r) => r.present || r.input || r.output || r.next) ?? null
      })
      store.openDialog({ kind: 'printPreview' })
      return
    }
    case 'file.printSetup':
      store.setStatusMessage('Printer, orientation and paper size are chosen in the system print dialog')
      return
    case 'file.exit':
      window.close()
      return

    // Edit — tool switches
    case 'edit.select':
      store.setActiveTool({ kind: 'select' })
      return
    case 'edit.wire':
      store.setActiveTool({ kind: 'wire' })
      return
    case 'edit.label':
      store.setActiveTool({ kind: 'label' })
      return
    case 'edit.move':
      store.setActiveTool({ kind: 'move' })
      return
    case 'edit.delay':
      store.setActiveTool({ kind: 'delay' })
      return
    case 'edit.defaultDelay':
      store.openDialog({ kind: 'defaultDelay' })
      return
    case 'edit.selectAll':
      store.selectAll()
      return
    case 'edit.delete':
      await confirmAndDelete()
      return

    // View
    case 'view.showIo':
      store.toggleIoValues()
      return
    case 'view.defaultSize':
      store.resetViewport()
      return
    case 'view.fit':
      store.fitToWindow()
      return
    case 'view.setScaling':
      store.openDialog({ kind: 'scaling' })
      return
    case 'view.redraw':
      store.requestRedraw()
      return
    case 'view.graphicsMode':
      store.openDialog({ kind: 'graphicsMode' })
      return

    // Simulate
    case 'sim.go':
      store.simGo()
      return
    case 'sim.step':
      store.simStep()
      return
    case 'sim.stop':
      store.simStop()
      return
    case 'sim.change':
      store.simChangeStep()
      return
    case 'sim.reset':
      store.simReset()
      return
    case 'sim.changeMode':
      store.enterChangeMode()
      return
    case 'sim.options':
      store.openDialog({ kind: 'options' })
      return

    // Parts with dedicated placement flows
    case 'parts.checker': {
      if (store.netlist.components.some((c) => c.type === ComponentType.CHECKER)) {
        store.setStatusMessage('Only one Checker is allowed per circuit')
        return
      }
      const file = await window.api.openChk()
      if (!file) return
      const parsed = parseChk(file.contents)
      if (typeof parsed === 'string') {
        await window.api.confirm({
          type: 'error',
          message: 'Invalid checker file',
          detail: parsed,
          buttons: ['OK'],
          defaultId: 0,
          cancelId: 0
        })
        return
      }
      store.setActiveTool({
        kind: 'place',
        componentType: ComponentType.CHECKER,
        extra: { chk: parsed }
      })
      return
    }

    case 'parts.stateMachine':
      if (store.netlist.components.some((c) => c.type === ComponentType.STATE_MACHINE)) {
        store.setStatusMessage('Only one State Machine is allowed per circuit')
        return
      }
      store.openDialog({ kind: 'placeSM' })
      return

    // Window
    case 'window.timingDiagram':
      store.toggleTimingPanel()
      return

    // Help
    case 'help.about':
      showAbout()
      return

    default: {
      const placeType = PLACE_BY_ID[id]
      if (placeType) {
        store.setActiveTool({ kind: 'place', componentType: placeType })
        return
      }
      const nBitType = N_BIT_BY_ID[id]
      if (nBitType) {
        store.openDialog({ kind: 'placeNBit', componentType: nBitType })
        return
      }
      store.setStatusMessage(`${menuCommandLabel(id)}: not implemented yet`)
      return
    }
  }
}
