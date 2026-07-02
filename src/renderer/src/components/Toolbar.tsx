import {
  FilePlus,
  FolderOpen,
  Save,
  Scissors,
  MousePointer2,
  Spline,
  Tag,
  Move,
  Timer,
  Eye,
  Maximize2,
  Scaling,
  Play,
  Square,
  StepForward,
  FastForward,
  RotateCcw,
  Printer,
  type LucideIcon
} from 'lucide-react'
import { dispatchCommand } from '../commands'
import { ComponentType } from '../model/types'
import { useCircuitStore } from '../store/circuitStore'
import type { MenuCommandId } from '../../../shared/menu'
import type { ActiveTool } from '../store/circuitStore'
import styles from '../styles/Toolbar.module.css'

interface ToolButton {
  id: MenuCommandId
  Icon: LucideIcon
  title: string
  /** Tool this button activates, if it is a mode switch (for highlighting). */
  toolKind?: ActiveTool['kind']
}

type ToolbarEntry = ToolButton | 'separator'

const ENTRIES: ToolbarEntry[] = [
  { id: 'file.new', Icon: FilePlus, title: 'New' },
  { id: 'file.open', Icon: FolderOpen, title: 'Open' },
  { id: 'file.save', Icon: Save, title: 'Save' },
  'separator',
  { id: 'edit.delete', Icon: Scissors, title: 'Erase' },
  { id: 'edit.select', Icon: MousePointer2, title: 'Select', toolKind: 'select' },
  { id: 'edit.wire', Icon: Spline, title: 'Wire', toolKind: 'wire' },
  { id: 'edit.label', Icon: Tag, title: 'Label', toolKind: 'label' },
  { id: 'edit.move', Icon: Move, title: 'Move', toolKind: 'move' },
  { id: 'edit.delay', Icon: Timer, title: 'Delay' },
  'separator',
  { id: 'view.showIo', Icon: Eye, title: 'Show/Hide I/O' },
  { id: 'view.defaultSize', Icon: Maximize2, title: 'Default Size' },
  { id: 'view.fit', Icon: Scaling, title: 'Fit' },
  'separator',
  { id: 'sim.go', Icon: Play, title: 'Go' },
  { id: 'sim.stop', Icon: Square, title: 'Stop' },
  { id: 'sim.step', Icon: StepForward, title: 'Step' },
  { id: 'sim.change', Icon: FastForward, title: 'Change' },
  { id: 'sim.reset', Icon: RotateCcw, title: 'Reset' },
  'separator',
  { id: 'file.print', Icon: Printer, title: 'Print' }
]

// Go/Step/Change require timed stimulus (a Clock or Input Signal); they are
// disabled in Live mode when none is present.
const AUTO_RUN_COMMANDS: ReadonlySet<MenuCommandId> = new Set([
  'sim.go',
  'sim.step',
  'sim.change'
])

export default function Toolbar(): React.JSX.Element {
  const activeTool = useCircuitStore((s) => s.activeTool)
  const showIoValues = useCircuitStore((s) => s.showIoValues)
  const hasTimedSource = useCircuitStore((s) =>
    s.netlist.components.some(
      (c) =>
        c.type === ComponentType.CLOCK ||
        c.type === ComponentType.INPUT_SIGNAL ||
        c.type === ComponentType.CHECKER
    )
  )

  function isActive(button: ToolButton): boolean {
    if (button.toolKind) return activeTool.kind === button.toolKind
    if (button.id === 'view.showIo') return showIoValues
    return false
  }

  return (
    <div className={styles.toolbar}>
      {ENTRIES.map((entry, index) =>
        entry === 'separator' ? (
          <div key={`sep-${index}`} className={styles.separator} />
        ) : (
          <button
            key={entry.id}
            type="button"
            className={`${styles.button} ${isActive(entry) ? styles.active : ''}`}
            title={entry.title}
            aria-label={entry.title}
            aria-pressed={isActive(entry)}
            disabled={AUTO_RUN_COMMANDS.has(entry.id) && !hasTimedSource}
            onClick={() => void dispatchCommand(entry.id)}
          >
            <entry.Icon size={18} strokeWidth={1.75} />
          </button>
        )
      )}
    </div>
  )
}
