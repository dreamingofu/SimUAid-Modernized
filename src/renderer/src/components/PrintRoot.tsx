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
      <img src={job.imageUrl} alt={job.title} />
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
