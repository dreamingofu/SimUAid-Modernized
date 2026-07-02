// Shared menu descriptor — the single source of truth for menus + accelerators.
//
// It is imported by BOTH:
//   - the Electron main process, which builds the native Menu that owns the real
//     keyboard accelerators (Electron `accelerator` fields only work on native
//     MenuItems, not on React/HTML elements), and
//   - the React `MenuBar`, which renders the visible, styled dropdowns.
//
// Keeping the structure here guarantees the two never drift apart. Both paths
// dispatch the same `MenuCommandId` to the renderer's command dispatcher.
//
// This module is intentionally pure data (no Electron/DOM imports) so it can be
// bundled into either process.

export type MenuCommandId =
  // File
  | 'file.new'
  | 'file.open'
  | 'file.save'
  | 'file.saveAs'
  | 'file.saveVhdl'
  | 'file.print'
  | 'file.printPreview'
  | 'file.printSetup'
  | 'file.exit'
  // Edit
  | 'edit.delete'
  | 'edit.select'
  | 'edit.selectAll'
  | 'edit.wire'
  | 'edit.label'
  | 'edit.move'
  | 'edit.delay'
  | 'edit.defaultDelay'
  | 'edit.comment'
  // View
  | 'view.toolbar'
  | 'view.statusBar'
  | 'view.showIo'
  | 'view.redraw'
  | 'view.defaultSize'
  | 'view.fit'
  | 'view.setScaling'
  | 'view.graphicsMode'
  // Parts
  | 'parts.and2'
  | 'parts.and3'
  | 'parts.and4'
  | 'parts.and5'
  | 'parts.or2'
  | 'parts.or3'
  | 'parts.or4'
  | 'parts.or5'
  | 'parts.nand2'
  | 'parts.nand3'
  | 'parts.nand4'
  | 'parts.nand5'
  | 'parts.nor2'
  | 'parts.nor3'
  | 'parts.nor4'
  | 'parts.nor5'
  | 'parts.xor2'
  | 'parts.xnor2'
  | 'parts.not'
  | 'parts.switch'
  | 'parts.probe'
  | 'parts.dFlipFlop'
  | 'parts.jkFlipFlop'
  | 'parts.clock'
  | 'parts.inputSignal'
  | 'parts.fullAdder'
  | 'parts.decoder2'
  | 'parts.decoder3'
  | 'parts.mux2to1'
  | 'parts.mux4to1'
  | 'parts.mux8to1'
  | 'parts.sevenSeg'
  | 'parts.tristateRight'
  | 'parts.tristateLeft'
  | 'parts.tristateUp'
  | 'parts.tristateDown'
  | 'parts.vcc'
  | 'parts.ground'
  | 'parts.nAdder'
  | 'parts.nCounter'
  | 'parts.nLoadCounter'
  | 'parts.nRegister'
  | 'parts.nShiftLeft'
  | 'parts.nShiftRight'
  | 'parts.nShiftBidir'
  | 'parts.nMux'
  | 'parts.nTristate'
  | 'parts.busProbe'
  | 'parts.busInput'
  | 'parts.splitter'
  | 'parts.merger'
  | 'parts.complementer'
  | 'parts.checker'
  | 'parts.stateMachine'
  // Simulate
  | 'sim.go'
  | 'sim.stop'
  | 'sim.step'
  | 'sim.change'
  | 'sim.reset'
  | 'sim.changeMode'
  | 'sim.options'
  // Window
  | 'window.cascade'
  | 'window.tile'
  | 'window.arrangeIcons'
  | 'window.timingDiagram'
  // Help
  | 'help.index'
  | 'help.usingHelp'
  | 'help.about'
  | 'help.context'

export interface MenuItemSpec {
  id?: MenuCommandId
  label?: string
  /** Electron accelerator string, e.g. 'CmdOrCtrl+N'. */
  accelerator?: string
  type?: 'normal' | 'separator'
  submenu?: MenuItemSpec[]
}

export interface MenuSpec {
  label: string
  items: MenuItemSpec[]
}

const sep: MenuItemSpec = { type: 'separator' }

export const MENU_STRUCTURE: MenuSpec[] = [
  {
    label: 'File',
    items: [
      { id: 'file.new', label: 'New', accelerator: 'CmdOrCtrl+N' },
      { id: 'file.open', label: 'Open…', accelerator: 'CmdOrCtrl+O' },
      { id: 'file.save', label: 'Save', accelerator: 'CmdOrCtrl+S' },
      { id: 'file.saveAs', label: 'Save As…' },
      { id: 'file.saveVhdl', label: 'Save VHDL…' },
      sep,
      { id: 'file.print', label: 'Print…', accelerator: 'CmdOrCtrl+P' },
      { id: 'file.printPreview', label: 'Print Preview' },
      { id: 'file.printSetup', label: 'Print Setup…' },
      sep,
      { id: 'file.exit', label: 'Exit' }
    ]
  },
  {
    label: 'Edit',
    items: [
      { id: 'edit.delete', label: 'Delete', accelerator: 'Delete' },
      sep,
      { id: 'edit.select', label: 'Select', accelerator: 'CmdOrCtrl+E' },
      { id: 'edit.selectAll', label: 'Select All', accelerator: 'CmdOrCtrl+A' },
      { id: 'edit.wire', label: 'Wire', accelerator: 'CmdOrCtrl+W' },
      { id: 'edit.label', label: 'Label', accelerator: 'CmdOrCtrl+L' },
      { id: 'edit.move', label: 'Move', accelerator: 'CmdOrCtrl+M' },
      { id: 'edit.delay', label: 'Delay', accelerator: 'CmdOrCtrl+D' },
      { id: 'edit.defaultDelay', label: 'Default Delay…' },
      sep,
      { id: 'edit.comment', label: 'Comment' }
    ]
  },
  {
    label: 'View',
    items: [
      { id: 'view.toolbar', label: 'Toolbar' },
      { id: 'view.statusBar', label: 'Status Bar' },
      { id: 'view.showIo', label: 'Show/Hide I/O Values', accelerator: 'CmdOrCtrl+I' },
      sep,
      { id: 'view.redraw', label: 'Redraw Window' },
      { id: 'view.defaultSize', label: 'Default Size', accelerator: 'CmdOrCtrl+V' },
      { id: 'view.fit', label: 'Fit To Window', accelerator: 'CmdOrCtrl+F' },
      { id: 'view.setScaling', label: 'Set Scaling Factor…' },
      sep,
      { id: 'view.graphicsMode', label: 'Change Graphics Mode' }
    ]
  },
  {
    label: 'Parts',
    items: [
      { id: 'parts.and2', label: 'AND (2)' },
      { id: 'parts.and3', label: 'AND (3)' },
      { id: 'parts.and4', label: 'AND (4)' },
      { id: 'parts.and5', label: 'AND (5)' },
      sep,
      { id: 'parts.or2', label: 'OR (2)' },
      { id: 'parts.or3', label: 'OR (3)' },
      { id: 'parts.or4', label: 'OR (4)' },
      { id: 'parts.or5', label: 'OR (5)' },
      sep,
      { id: 'parts.nand2', label: 'NAND (2)' },
      { id: 'parts.nand3', label: 'NAND (3)' },
      { id: 'parts.nand4', label: 'NAND (4)' },
      { id: 'parts.nand5', label: 'NAND (5)' },
      sep,
      { id: 'parts.nor2', label: 'NOR (2)' },
      { id: 'parts.nor3', label: 'NOR (3)' },
      { id: 'parts.nor4', label: 'NOR (4)' },
      { id: 'parts.nor5', label: 'NOR (5)' },
      sep,
      { id: 'parts.xor2', label: 'XOR (2)' },
      { id: 'parts.xnor2', label: 'XNOR (2)' },
      { id: 'parts.not', label: 'NOT' },
      sep,
      { id: 'parts.switch', label: 'Switch' },
      { id: 'parts.probe', label: 'Probe' },
      sep,
      { id: 'parts.dFlipFlop', label: 'D Flip-Flop' },
      { id: 'parts.jkFlipFlop', label: 'J-K Flip-Flop' },
      sep,
      { id: 'parts.clock', label: 'Clock' },
      { id: 'parts.inputSignal', label: 'Input Signal' },
      sep,
      {
        label: 'N-Bit Parts',
        submenu: [
          { id: 'parts.nAdder', label: 'Adder…' },
          { id: 'parts.nCounter', label: 'Counter…' },
          { id: 'parts.nLoadCounter', label: 'Loadable Counter…' },
          { id: 'parts.nRegister', label: 'Register…' },
          { id: 'parts.nShiftLeft', label: 'Left Shift Register…' },
          { id: 'parts.nShiftRight', label: 'Right Shift Register…' },
          { id: 'parts.nShiftBidir', label: 'Bidirectional Shift Register…' },
          { id: 'parts.nMux', label: 'N-Wide 2-to-1 Mux…' },
          { id: 'parts.nTristate', label: 'Tristate Buffer…' }
        ]
      },
      {
        label: 'Bus Parts',
        submenu: [
          { id: 'parts.busProbe', label: 'Bus Probe' },
          { id: 'parts.busInput', label: 'Bus Input' },
          { id: 'parts.splitter', label: 'Splitter' },
          { id: 'parts.merger', label: 'Merger' },
          { id: 'parts.complementer', label: 'Complementer' }
        ]
      },
      {
        label: 'Other Parts',
        submenu: [
          { id: 'parts.fullAdder', label: 'Full Adder' },
          { id: 'parts.decoder2', label: 'Decoder 2-to-4' },
          { id: 'parts.decoder3', label: 'Decoder 3-to-8' },
          { id: 'parts.mux2to1', label: 'Mux 2-to-1' },
          { id: 'parts.mux4to1', label: 'Mux 4-to-1' },
          { id: 'parts.mux8to1', label: 'Mux 8-to-1' },
          { id: 'parts.sevenSeg', label: '7-Segment Display' },
          sep,
          { id: 'parts.tristateRight', label: 'Tristate Buffer (Right)' },
          { id: 'parts.tristateLeft', label: 'Tristate Buffer (Left)' },
          { id: 'parts.tristateUp', label: 'Tristate Buffer (Up)' },
          { id: 'parts.tristateDown', label: 'Tristate Buffer (Down)' },
          sep,
          { id: 'parts.vcc', label: '+V (Logic 1)' },
          { id: 'parts.ground', label: 'Ground (Logic 0)' },
          sep,
          { id: 'parts.stateMachine', label: 'State Machine…' }
        ]
      },
      sep,
      { id: 'parts.checker', label: 'Checker…' }
    ]
  },
  {
    label: 'Simulate',
    items: [
      { id: 'sim.go', label: 'Go', accelerator: 'CmdOrCtrl+G' },
      { id: 'sim.stop', label: 'Stop', accelerator: 'CmdOrCtrl+Z' },
      { id: 'sim.step', label: 'Step', accelerator: 'CmdOrCtrl+T' },
      { id: 'sim.change', label: 'Change', accelerator: 'CmdOrCtrl+C' },
      { id: 'sim.reset', label: 'Reset', accelerator: 'CmdOrCtrl+R' },
      sep,
      { id: 'sim.changeMode', label: 'CHANGE Mode' },
      { id: 'sim.options', label: 'Options…' }
    ]
  },
  {
    label: 'Window',
    items: [
      { id: 'window.cascade', label: 'Cascade' },
      { id: 'window.tile', label: 'Tile' },
      { id: 'window.arrangeIcons', label: 'Arrange Icons' },
      sep,
      { id: 'window.timingDiagram', label: 'Open/Close Timing Diagram' }
    ]
  },
  {
    label: 'Help',
    items: [
      { id: 'help.index', label: 'SimUaid Help Index' },
      { id: 'help.usingHelp', label: 'Using Help' },
      { id: 'help.context', label: 'Context Sensitive Help' },
      sep,
      { id: 'help.about', label: 'About SimUaid' }
    ]
  }
]

/** Flat lookup of command id -> human label, built from MENU_STRUCTURE. */
const LABELS: Partial<Record<MenuCommandId, string>> = (() => {
  const map: Partial<Record<MenuCommandId, string>> = {}
  const walk = (items: MenuItemSpec[]): void => {
    for (const item of items) {
      if (item.id && item.label) map[item.id] = item.label
      if (item.submenu) walk(item.submenu)
    }
  }
  for (const menu of MENU_STRUCTURE) walk(menu.items)
  return map
})()

/** Returns the display label for a command id (falls back to the id itself). */
export function menuCommandLabel(id: MenuCommandId): string {
  return LABELS[id] ?? id
}
