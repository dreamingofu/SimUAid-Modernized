import { useState } from 'react'
import Modal from './Modal'
import { ComponentType } from '../model/types'
import {
  DEFAULT_BITS,
  MIN_BITS,
  getPartDefinition,
  isBusType,
  maxBitsFor
} from '../model/partDefinitions'
import { useCircuitStore } from '../store/circuitStore'
import styles from '../styles/Modal.module.css'

interface NBitDialogProps {
  componentType: ComponentType
}

const BUS_TITLES: Partial<Record<ComponentType, string>> = {
  [ComponentType.BUS_INPUT]: 'Bus Input',
  [ComponentType.BUS_PROBE]: 'Bus Probe',
  [ComponentType.SPLITTER]: 'Splitter',
  [ComponentType.MERGER]: 'Merger'
}

export default function NBitDialog({ componentType }: NBitDialogProps): React.JSX.Element {
  const setActiveTool = useCircuitStore((s) => s.setActiveTool)
  const closeDialog = useCircuitStore((s) => s.closeDialog)
  const [bits, setBits] = useState(DEFAULT_BITS)

  const maxBits = maxBitsFor(componentType)
  const title =
    BUS_TITLES[componentType] ??
    (getPartDefinition(componentType, bits).title ?? 'N-Bit Part').replace(/ \d+$/, '')

  function submit(): void {
    closeDialog()
    setActiveTool({ kind: 'place', componentType, bits })
  }

  return (
    <Modal title={title} onClose={closeDialog}>
      <label className={styles.field}>
        <span>Number of bits ({MIN_BITS}–{maxBits})</span>
        <select value={bits} autoFocus onChange={(e) => setBits(Number(e.target.value))}>
          {Array.from({ length: maxBits - MIN_BITS + 1 }, (_, i) => MIN_BITS + i).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      {!isBusType(componentType) && (
        <p className={styles.note}>
          Bus variants are not implemented yet; this places the net (per-wire) version.
        </p>
      )}
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
