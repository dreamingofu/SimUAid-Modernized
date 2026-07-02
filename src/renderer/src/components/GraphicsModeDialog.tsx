import Modal from './Modal'
import { useCircuitStore } from '../store/circuitStore'
import styles from '../styles/Modal.module.css'

export default function GraphicsModeDialog(): React.JSX.Element {
  const mode = useCircuitStore((s) => s.graphicsMode)
  const setGraphicsMode = useCircuitStore((s) => s.setGraphicsMode)
  const closeDialog = useCircuitStore((s) => s.closeDialog)

  return (
    <Modal title="Change Graphics Mode" onClose={closeDialog}>
      <label className={styles.field}>
        <span>Rendering</span>
        <select
          value={mode}
          autoFocus
          onChange={(e) => setGraphicsMode(e.target.value as 'dpi' | 'fixed')}
        >
          <option value="dpi">Same component size (DPI-scaled, crisp on high-DPI displays)</option>
          <option value="fixed">Change component size (fixed 1:1 pixels, legacy look)</option>
        </select>
      </label>
      <p className={styles.note}>The preference is saved and applies immediately.</p>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={closeDialog}>
          OK
        </button>
      </div>
    </Modal>
  )
}
