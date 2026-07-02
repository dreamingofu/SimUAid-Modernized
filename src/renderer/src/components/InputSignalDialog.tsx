import { useState } from 'react'
import Modal from './Modal'
import { LogicValue, type SignalRow, type SignalValue } from '../model/types'
import { useCircuitStore } from '../store/circuitStore'
import styles from '../styles/Modal.module.css'

interface InputSignalDialogProps {
  componentId: string
}

const VALUE_OPTIONS: SignalValue[] = [LogicValue.ZERO, LogicValue.ONE, LogicValue.X, LogicValue.Z, 'R']

function sortRows(rows: SignalRow[]): SignalRow[] {
  return [...rows].sort((a, b) => a.timeNs - b.timeNs)
}

export default function InputSignalDialog({
  componentId
}: InputSignalDialogProps): React.JSX.Element | null {
  const component = useCircuitStore((s) => s.netlist.components.find((c) => c.id === componentId))
  const updateComponent = useCircuitStore((s) => s.updateComponent)
  const closeDialog = useCircuitStore((s) => s.closeDialog)

  const [time, setTime] = useState('0')
  const [value, setValue] = useState<SignalValue>(LogicValue.ONE)

  if (!component) return null
  const rows = component.signal ?? []

  function save(next: SignalRow[]): void {
    updateComponent(componentId, { signal: sortRows(next) })
  }

  function addOrModify(): void {
    const t = Math.max(0, Math.round(Number(time)))
    if (!Number.isFinite(t)) return
    const next = rows.filter((r) => r.timeNs !== t)
    next.push({ timeNs: t, value })
    save(next)
  }

  function remove(timeNs: number): void {
    save(rows.filter((r) => r.timeNs !== timeNs))
  }

  return (
    <Modal title={`Input Signal${component.label ? ` — ${component.label}` : ''}`} onClose={closeDialog}>
      <div className={styles.signalList}>
        {rows.length === 0 ? (
          <div className={styles.signalEmpty}>No entries yet.</div>
        ) : (
          rows.map((row) => (
            <div key={row.timeNs} className={styles.signalRow}>
              <button
                type="button"
                className={styles.signalRowMain}
                onClick={() => {
                  setTime(String(row.timeNs))
                  setValue(row.value)
                }}
              >
                <span>{row.timeNs} ns</span>
                <span>{row.value}</span>
              </button>
              <button type="button" className={styles.signalDelete} onClick={() => remove(row.timeNs)}>
                ✕
              </button>
            </div>
          ))
        )}
      </div>

      <div className={styles.signalEntry}>
        <label className={styles.field}>
          <span>Time (ns)</span>
          <input type="number" min={0} value={time} onChange={(e) => setTime(e.target.value)} />
        </label>
        <label className={styles.field}>
          <span>Value</span>
          <select value={value} onChange={(e) => setValue(e.target.value as SignalValue)}>
            {VALUE_OPTIONS.map((v) => (
              <option key={v} value={v}>
                {v === 'R' ? 'R (repeat)' : v}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className={styles.primary} onClick={addOrModify}>
          Add / Modify
        </button>
      </div>

      <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={closeDialog}>
          Close
        </button>
      </div>
    </Modal>
  )
}
