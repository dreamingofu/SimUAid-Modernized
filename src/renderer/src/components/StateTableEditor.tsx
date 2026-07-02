import { useRef, useState } from 'react'
import { ComponentType, type SmRow } from '../model/types'
import { checkCell, compileTable } from '../sim/stateMachine'
import { useCircuitStore } from '../store/circuitStore'
import styles from '../styles/StateTableEditor.module.css'

const COLUMNS: { key: keyof SmRow; label: string }[] = [
  { key: 'present', label: 'Present State' },
  { key: 'input', label: 'Input' },
  { key: 'output', label: 'Output' },
  { key: 'next', label: 'Next State' }
]

const EMPTY_ROW: SmRow = { present: '', input: '', output: '', next: '' }

/**
 * Floating, always-on-top state-table editor. Per the manual it cannot be
 * closed while a state machine exists — only minimized. Draggable by its
 * title bar. The active row (current state + matching input) is blue; other
 * valid rows are green; cells with syntax errors are outlined red.
 */
export default function StateTableEditor(): React.JSX.Element | null {
  const sm = useCircuitStore((s) =>
    s.netlist.components.find((c) => c.type === ComponentType.STATE_MACHINE)
  )
  const open = useCircuitStore((s) => s.smEditorOpen)
  const activeRow = useCircuitStore((s) => (sm ? (s.smActive[sm.id] ?? null) : null))
  const updateComponent = useCircuitStore((s) => s.updateComponent)
  const setStatusMessage = useCircuitStore((s) => s.setStatusMessage)

  const [minimized, setMinimized] = useState(false)
  const [pos, setPos] = useState({ x: 80, y: 120 })
  const [selected, setSelected] = useState(0)
  const [errors, setErrors] = useState<Map<string, string>>(new Map())
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)

  if (!sm || !open) return null

  const rows: SmRow[] = sm.smTable?.length ? sm.smTable : [EMPTY_ROW]

  function save(next: SmRow[]): void {
    updateComponent(sm!.id, { smTable: next })
  }

  function setCell(rowIndex: number, column: keyof SmRow, value: string): void {
    const next = rows.map((r, i) => (i === rowIndex ? { ...r, [column]: value } : r))
    save(next)
  }

  function checkOne(rowIndex: number, column: keyof SmRow): void {
    const key = `${rowIndex}:${column}`
    const message = checkCell(sm!, rows[rowIndex], column)
    setErrors((prev) => {
      const next = new Map(prev)
      if (message) next.set(key, message)
      else next.delete(key)
      return next
    })
    if (message) setStatusMessage(`State table: ${message}`)
  }

  function checkAll(): void {
    const compiled = compileTable(sm!)
    const next = new Map<string, string>()
    for (const err of compiled.errors) next.set(`${err.row}:${err.column}`, err.message)
    setErrors(next)
    setStatusMessage(
      compiled.errors.length === 0
        ? `State table OK (${compiled.rows.length} row(s))`
        : `State table: ${compiled.errors.length} error(s)`
    )
  }

  function insertRow(): void {
    const next = rows.slice()
    next.splice(selected, 0, { ...EMPTY_ROW })
    save(next)
    setErrors(new Map())
  }

  function deleteRow(): void {
    if (rows.length === 0) return
    const next = rows.filter((_, i) => i !== selected)
    save(next.length ? next : [{ ...EMPTY_ROW }])
    setSelected((s) => Math.max(0, Math.min(s, next.length - 1)))
    setErrors(new Map())
  }

  function clearTable(): void {
    save([{ ...EMPTY_ROW }])
    setErrors(new Map())
    setStatusMessage('State table cleared')
  }

  function onTitleDown(e: React.PointerEvent): void {
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }

  function onTitleMove(e: React.PointerEvent): void {
    if (!dragRef.current) return
    setPos({ x: e.clientX - dragRef.current.dx, y: e.clientY - dragRef.current.dy })
  }

  return (
    <div className={styles.panel} style={{ left: pos.x, top: pos.y }}>
      <div
        className={styles.titlebar}
        onPointerDown={onTitleDown}
        onPointerMove={onTitleMove}
        onPointerUp={() => (dragRef.current = null)}
      >
        <span>State Table{sm.label ? ` — ${sm.label}` : ''}</span>
        <button
          type="button"
          className={styles.minBtn}
          title={minimized ? 'Restore' : 'Minimize'}
          onClick={() => setMinimized((m) => !m)}
        >
          {minimized ? '▢' : '—'}
        </button>
      </div>

      {!minimized && (
        <>
          <div className={styles.toolbar}>
            <button type="button" onClick={insertRow}>
              Insert Row
            </button>
            <button type="button" onClick={deleteRow}>
              Delete Row
            </button>
            <button type="button" onClick={checkAll}>
              Check Syntax
            </button>
            <button type="button" onClick={clearTable}>
              Clear Table
            </button>
          </div>

          <table className={styles.table}>
            <thead>
              <tr>
                {COLUMNS.map((c) => (
                  <th key={c.key}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => {
                const isActive = rowIndex === activeRow
                return (
                  <tr
                    key={rowIndex}
                    className={isActive ? styles.activeRow : styles.idleRow}
                    onClick={() => setSelected(rowIndex)}
                    data-selected={rowIndex === selected || undefined}
                  >
                    {COLUMNS.map((c) => {
                      const err = errors.get(`${rowIndex}:${c.key}`)
                      return (
                        <td key={c.key}>
                          <input
                            className={err ? styles.errCell : undefined}
                            title={err}
                            value={row[c.key]}
                            onFocus={() => setSelected(rowIndex)}
                            onChange={(e) => setCell(rowIndex, c.key, e.target.value)}
                            onBlur={() => checkOne(rowIndex, c.key)}
                          />
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>

          <div className={styles.legend}>
            Blue row = active (present state + matching input) · green = idle ·{' '}
            <span className={styles.errText}>red cell = syntax error</span> · Reset before running
            after edits
          </div>
        </>
      )}
    </div>
  )
}
