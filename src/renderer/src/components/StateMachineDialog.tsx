import { useState } from 'react'
import Modal from './Modal'
import { ComponentType } from '../model/types'
import { useCircuitStore } from '../store/circuitStore'
import styles from '../styles/Modal.module.css'

const COUNTS = [1, 2, 3, 4, 5, 6, 7, 8]

export default function StateMachineDialog(): React.JSX.Element {
  const setActiveTool = useCircuitStore((s) => s.setActiveTool)
  const closeDialog = useCircuitStore((s) => s.closeDialog)
  const [inputs, setInputs] = useState(2)
  const [outputs, setOutputs] = useState(2)

  function submit(): void {
    closeDialog()
    setActiveTool({
      kind: 'place',
      componentType: ComponentType.STATE_MACHINE,
      extra: { smInputs: inputs, smOutputs: outputs }
    })
  }

  return (
    <Modal title="State Machine" onClose={closeDialog}>
      <label className={styles.field}>
        <span>Inputs (1–8)</span>
        <select value={inputs} autoFocus onChange={(e) => setInputs(Number(e.target.value))}>
          {COUNTS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <label className={styles.field}>
        <span>Outputs (1–8)</span>
        <select value={outputs} onChange={(e) => setOutputs(Number(e.target.value))}>
          {COUNTS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <p className={styles.note}>
        Label the pins, then right-click the placed state machine to open its state table.
      </p>
      <div className={styles.actions}>
        <button type="button" onClick={closeDialog}>
          Cancel
        </button>
        <button type="button" className={styles.primary} onClick={submit}>
          Place
        </button>
      </div>
    </Modal>
  )
}
