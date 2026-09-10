import { useRef, useState } from 'react'
import Modal from './Modal'
import { useCircuitStore } from '../store/circuitStore'
import { generateVhdl, isVhdlIdentifier, validateForVhdl, type VhdlMode } from '../vhdl/export'
import styles from '../styles/Modal.module.css'

export default function VhdlDialog(): React.JSX.Element {
  const netlist = useCircuitStore((s) => s.netlist)
  const closeDialog = useCircuitStore((s) => s.closeDialog)
  const setStatusMessage = useCircuitStore((s) => s.setStatusMessage)
  const [mode, setMode] = useState<VhdlMode>('synth')
  const [entity, setEntity] = useState(
    () => {
      const name = netlist.metadata.name.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
      return isVhdlIdentifier(name) ? name : 'circuit'
    }
  )
  const pending = useRef(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  function close(): void {
    if (!pending.current) closeDialog()
  }

  async function submit(): Promise<void> {
    // A ref also blocks a second click before React renders disabled controls.
    if (pending.current) return
    pending.current = true
    setSaving(true)
    setSaveError('')
    try {
      const errors = validateForVhdl(netlist, entity)
      if (errors.length > 0) {
        setSaveError(errors.slice(0, 12).join('\n') + (errors.length > 12 ? `\n… ${errors.length - 12} more` : ''))
        setStatusMessage('VHDL export failed validation')
        return
      }
      const files = generateVhdl(netlist, entity, mode)
      const path = await window.api.saveVhdl(files.entityFileName, [
        { name: files.entityFileName, contents: files.entity },
        ...files.packages.map((p) => ({ name: p.name, contents: p.contents }))
      ])
      if (!path) return
      setStatusMessage(`VHDL saved to ${path}`)
      closeDialog()
    } catch (error) {
      const message = `VHDL export failed: ${error instanceof Error ? error.message : String(error)}`
      setSaveError(message)
      setStatusMessage(message)
    } finally {
      pending.current = false
      setSaving(false)
    }
  }

  return (
    <Modal title="Save VHDL structural template" onClose={close}>
      <p>
        Exports wiring and component declarations. External component implementations are required
        before simulation or synthesis. Clock and input waveforms must be supplied separately.
        N-bit parts, buses, state machines, and checkers are not supported.
      </p>
      {saveError && <p role="alert" style={{ whiteSpace: 'pre-line' }}>{saveError}</p>}
      <label className={styles.field}>
        <span>Entity name</span>
        <input value={entity} disabled={saving} autoFocus onChange={(e) => setEntity(e.target.value)} />
      </label>
      <label className={styles.field}>
        <span>Output type</span>
        <select value={mode} disabled={saving} onChange={(e) => setMode(e.target.value as VhdlMode)}>
          <option value="synth">Structural template without delay generics</option>
          <option value="sim">Structural template with delay generics</option>
        </select>
      </label>
      <div className={styles.actions}>
        <button type="button" disabled={saving} onClick={close}>
          Cancel
        </button>
        <button type="button" disabled={saving} className={styles.primary} onClick={() => void submit()}>
          {saving ? 'Saving…' : 'Save…'}
        </button>
      </div>
    </Modal>
  )
}
