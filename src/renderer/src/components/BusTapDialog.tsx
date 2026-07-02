import { useState } from 'react'
import Modal from './Modal'
import { busWidthOfWire, useCircuitStore } from '../store/circuitStore'
import styles from '../styles/Modal.module.css'

interface BusTapDialogProps {
  wireId: string
  x: number
  y: number
}

export default function BusTapDialog({ wireId, x, y }: BusTapDialogProps): React.JSX.Element | null {
  const netlist = useCircuitStore((s) => s.netlist)
  const placeBusTap = useCircuitStore((s) => s.placeBusTap)
  const closeDialog = useCircuitStore((s) => s.closeDialog)
  const [bits, setBits] = useState(1)
  const [end, setEnd] = useState<'msb' | 'lsb'>('lsb')

  const wire = netlist.wires.find((w) => w.id === wireId)
  if (!wire) return null
  const width = busWidthOfWire(netlist, wire)

  function submit(): void {
    closeDialog()
    placeBusTap(wireId, { x, y }, bits, end === 'msb')
  }

  return (
    <Modal title={`Bus Tap (${width}-bit bus)`} onClose={closeDialog}>
      <label className={styles.field}>
        <span>Number of bits</span>
        <select value={bits} autoFocus onChange={(e) => setBits(Number(e.target.value))}>
          {Array.from({ length: width }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <label className={styles.field}>
        <span>Tap from</span>
        <select value={end} onChange={(e) => setEnd(e.target.value as 'msb' | 'lsb')}>
          <option value="msb">MSB end</option>
          <option value="lsb">LSB end</option>
        </select>
      </label>
      <div className={styles.actions}>
        <button type="button" onClick={closeDialog}>
          Cancel
        </button>
        <button type="button" className={styles.primary} onClick={submit}>
          Place Tap
        </button>
      </div>
    </Modal>
  )
}
