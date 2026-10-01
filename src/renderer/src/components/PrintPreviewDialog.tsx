import Modal from './Modal'
import { useCircuitStore } from '../store/circuitStore'
import styles from '../styles/Modal.module.css'

export default function PrintPreviewDialog(): React.JSX.Element | null {
  const job = useCircuitStore((s) => s.printJob)
  const closeDialog = useCircuitStore((s) => s.closeDialog)
  const setPrintJob = useCircuitStore((s) => s.setPrintJob)

  if (!job) return null

  function print(): void {
    closeDialog()
    // Let the modal unmount first; the print root stays mounted for the print.
    requestAnimationFrame(() => {
      window.print()
      setPrintJob(null)
    })
  }

  return (
    <Modal title={`Print Preview — ${job.title}`} onClose={closeDialog}>
      <div className={styles.printPreview}>
        {job.imageUrl && <img src={job.imageUrl} alt="print preview" />}
        {job.notes && job.notes.length > 0 && (
          <div className={styles.printNotes}>
            {job.notes.map((line, i) => <p key={i}>{line}</p>)}
          </div>
        )}
        {job.table && (
          <table className={styles.reportTable}>
            <thead>
              <tr>{job.table.columns.map((c, i) => <th key={i}>{c}</th>)}</tr>
            </thead>
            <tbody>
              {job.table.rows.map((row, i) => (
                <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>
              ))}
            </tbody>
          </table>
        )}
        {job.smRows && job.smRows.length > 0 && (
          <p className={styles.note}>+ state table ({job.smRows.length} row(s)) printed below the circuit</p>
        )}
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          onClick={() => {
            closeDialog()
            setPrintJob(null)
          }}
        >
          Cancel
        </button>
        <button type="button" className={styles.primary} onClick={print}>
          Print…
        </button>
      </div>
    </Modal>
  )
}
