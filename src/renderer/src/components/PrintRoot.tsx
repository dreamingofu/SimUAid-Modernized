import { useCircuitStore } from '../store/circuitStore'

/**
 * Print-only DOM. Hidden on screen; @media print hides the app and shows this
 * (see index.css). The state table prints below the circuit per the manual.
 */
export default function PrintRoot(): React.JSX.Element | null {
  const job = useCircuitStore((s) => s.printJob)
  if (!job) return null

  return (
    <div className="printRoot">
      <h3>{job.title}</h3>
      {job.imageUrl && <img src={job.imageUrl} alt={job.title} />}
      {job.notes && job.notes.length > 0 && (
        <div className="printNotes">
          {job.notes.map((line, i) => <p key={i}>{line}</p>)}
        </div>
      )}
      {job.table && (
        <table className="printTable">
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
        <table className="printTable">
          <thead>
            <tr>
              <th>Present State</th>
              <th>Input</th>
              <th>Output</th>
              <th>Next State</th>
            </tr>
          </thead>
          <tbody>
            {job.smRows.map((row, i) => (
              <tr key={i}>
                <td>{row.present}</td>
                <td>{row.input}</td>
                <td>{row.output}</td>
                <td>{row.next}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
