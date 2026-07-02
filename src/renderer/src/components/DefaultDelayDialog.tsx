import { useState } from 'react'
import Modal from './Modal'
import { useCircuitStore } from '../store/circuitStore'
import styles from '../styles/Modal.module.css'

export default function DefaultDelayDialog(): React.JSX.Element {
  const defaultDelay = useCircuitStore((s) => s.netlist.metadata.defaultDelay)
  const setDefaultDelay = useCircuitStore((s) => s.setDefaultDelay)
  const closeDialog = useCircuitStore((s) => s.closeDialog)
  const [value, setValue] = useState(() => String(defaultDelay))

  function submit(): void {
    const n = Math.round(Number(value))
    if (Number.isFinite(n)) setDefaultDelay(n)
    closeDialog()
  }

  return (
    <Modal title="Default Delay" onClose={closeDialog}>
      <p className={styles.note}>Applies to parts placed from now on; existing parts keep their delay.</p>
      <label className={styles.field}>
        <span>Default propagation delay (ns)</span>
        <input
          type="number"
          min={1}
          max={99}
          value={value}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />
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
