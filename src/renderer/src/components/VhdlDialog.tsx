import { useState } from 'react'
import Modal from './Modal'
import { useCircuitStore } from '../store/circuitStore'
import { generateVhdl, validateForVhdl, type VhdlMode } from '../vhdl/export'
import styles from '../styles/Modal.module.css'

export default function VhdlDialog(): React.JSX.Element {
  const netlist = useCircuitStore((s) => s.netlist)
  const closeDialog = useCircuitStore((s) => s.closeDialog)
  const setStatusMessage = useCircuitStore((s) => s.setStatusMessage)
  const [mode, setMode] = useState<VhdlMode>('synth')
  const [entity, setEntity] = useState(
    () => netlist.metadata.name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^([^a-zA-Z])/, 'e$1') || 'circuit'
  )

  async function submit(): Promise<void> {
    const errors = validateForVhdl(netlist)
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(entity)) {
      errors.unshift(`"${entity}" is not a valid VHDL entity name`)
    }
    if (errors.length > 0) {
      await window.api.confirm({
        type: 'error',
        message: 'VHDL export failed validation',
        detail: errors.slice(0, 12).join('\n') + (errors.length > 12 ? `\n… ${errors.length - 12} more` : ''),
        buttons: ['OK'],
        defaultId: 0,
        cancelId: 0
      })
      return
    }
    const files = generateVhdl(netlist, entity, mode)
    const path = await window.api.saveVhdl(files.entityFileName, [
      { name: files.entityFileName, contents: files.entity },
      ...files.packages.map((p) => ({ name: p.name, contents: p.contents }))
    ])
    closeDialog()
    if (!path) return
    setStatusMessage(`VHDL saved to ${path}`)
    await window.api.confirm({
      type: 'info',
      message: 'Success in saving of VHDL file',
      detail: `${path}\n(The component package was written alongside it.)`,
      buttons: ['OK'],
      defaultId: 0,
      cancelId: 0
    })
  }

  return (
    <Modal title="Save VHDL" onClose={closeDialog}>
      <label className={styles.field}>
        <span>Entity name</span>
        <input value={entity} autoFocus onChange={(e) => setEntity(e.target.value)} />
      </label>
      <label className={styles.field}>
        <span>Output type</span>
        <select value={mode} onChange={(e) => setMode(e.target.value as VhdlMode)}>
          <option value="synth">Synthesizable VHDL</option>
          <option value="sim">VHDL for Simulation Only (preserves delays)</option>
        </select>
      </label>
      <div className={styles.actions}>
        <button type="button" onClick={closeDialog}>
          Cancel
        </button>
        <button type="button" className={styles.primary} onClick={() => void submit()}>
          Save…
        </button>
      </div>
    </Modal>
  )
}
