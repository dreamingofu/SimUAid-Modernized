import { useState } from 'react'
import Modal from './Modal'
import { ComponentType } from '../model/types'
import { useCircuitStore } from '../store/circuitStore'
import styles from '../styles/Modal.module.css'

interface DelayDialogProps {
  componentId: string
}

export default function DelayDialog({ componentId }: DelayDialogProps): React.JSX.Element | null {
  const component = useCircuitStore((s) => s.netlist.components.find((c) => c.id === componentId))
  const clockPeriodNs = useCircuitStore((s) => s.netlist.metadata.simulation.clockPeriodNs)
  const updateComponent = useCircuitStore((s) => s.updateComponent)
  const setSimulationOptions = useCircuitStore((s) => s.setSimulationOptions)
  const closeDialog = useCircuitStore((s) => s.closeDialog)

  const isClock = component?.type === ComponentType.CLOCK
  const [value, setValue] = useState(() => String(isClock ? clockPeriodNs : (component?.delay ?? 1)))

  if (!component) return null

  function submit(): void {
    const n = Math.round(Number(value))
    if (Number.isFinite(n)) {
      if (isClock) setSimulationOptions({ clockPeriodNs: Math.min(9999, Math.max(2, n)) })
      else updateComponent(componentId, { delay: Math.min(999, Math.max(1, n)) })
    }
    closeDialog()
  }

  return (
    <Modal title={isClock ? 'Clock Period' : 'Propagation Delay'} onClose={closeDialog}>
      <label className={styles.field}>
        <span>{isClock ? 'Clock period (ns)' : 'Propagation delay (ns)'}</span>
        <input
          type="number"
          min={isClock ? 2 : 1}
          max={isClock ? 9999 : 999}
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
