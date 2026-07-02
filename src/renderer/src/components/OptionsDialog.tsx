import { useState } from 'react'
import Modal from './Modal'
import { ComponentType, LogicValue } from '../model/types'
import { useCircuitStore } from '../store/circuitStore'
import styles from '../styles/Modal.module.css'

export default function OptionsDialog(): React.JSX.Element {
  const sim = useCircuitStore((s) => s.netlist.metadata.simulation)
  const hasClock = useCircuitStore((s) =>
    s.netlist.components.some((c) => c.type === ComponentType.CLOCK)
  )
  const setSimulationOptions = useCircuitStore((s) => s.setSimulationOptions)
  const closeDialog = useCircuitStore((s) => s.closeDialog)

  const [simTime, setSimTime] = useState(() => String(sim.simTimeNs))
  const [period, setPeriod] = useState(() => String(sim.clockPeriodNs))
  const [edge, setEdge] = useState<'rising' | 'falling'>(
    sim.clockInitialValue === LogicValue.ONE ? 'rising' : 'falling'
  )

  function submit(): void {
    const simTimeNs = Math.max(1, Math.round(Number(simTime)) || sim.simTimeNs)
    const clockPeriodNs = Math.max(2, Math.round(Number(period)) || sim.clockPeriodNs)
    setSimulationOptions({
      simTimeNs,
      clockPeriodNs,
      clockInitialValue: edge === 'rising' ? LogicValue.ONE : LogicValue.ZERO
    })
    closeDialog()
  }

  return (
    <Modal title="Simulation Options" onClose={closeDialog}>
      <label className={styles.field}>
        <span>Simulation time (ns)</span>
        <input
          type="number"
          min={1}
          value={simTime}
          autoFocus
          onChange={(e) => setSimTime(e.target.value)}
        />
      </label>
      <label className={styles.field}>
        <span>Clock period (ns)</span>
        <input
          type="number"
          min={2}
          value={period}
          disabled={!hasClock}
          onChange={(e) => setPeriod(e.target.value)}
        />
      </label>
      <label className={styles.field}>
        <span>Active clock edge</span>
        <select value={edge} onChange={(e) => setEdge(e.target.value as 'rising' | 'falling')}>
          <option value="rising">Rising edge (initial value 1)</option>
          <option value="falling">Falling edge (initial value 0)</option>
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
