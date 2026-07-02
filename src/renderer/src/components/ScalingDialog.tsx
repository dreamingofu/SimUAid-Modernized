import { useState } from 'react'
import Modal from './Modal'
import { useCircuitStore } from '../store/circuitStore'
import styles from '../styles/Modal.module.css'

const SCALES = [50, 75, 100, 125, 150, 175, 200]

export default function ScalingDialog(): React.JSX.Element {
  const currentScale = useCircuitStore((s) => s.viewport.scale)
  const setScale = useCircuitStore((s) => s.setScale)
  const closeDialog = useCircuitStore((s) => s.closeDialog)
  const [percent, setPercent] = useState(() => String(Math.round(currentScale * 100)))

  function submit(): void {
    const n = Number(percent)
    if (Number.isFinite(n)) setScale(Math.min(200, Math.max(50, n)) / 100)
    closeDialog()
  }

  return (
    <Modal title="Set Scaling Factor" onClose={closeDialog}>
      <label className={styles.field}>
        <span>Scale</span>
        <select value={percent} onChange={(e) => setPercent(e.target.value)} autoFocus>
          {SCALES.map((s) => (
            <option key={s} value={s}>
              {s}%
            </option>
          ))}
        </select>
      </label>
      <div className={styles.actions}>
        <button type="button" onClick={closeDialog}>
          Cancel
        </button>
        <button type="button" className={styles.primary} onClick={submit}>
          OK
        </button>
      </div>
    </Modal>
  )
}
