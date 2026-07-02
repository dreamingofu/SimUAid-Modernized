import { useCircuitStore } from '../store/circuitStore'
import type { ActiveTool } from '../store/circuitStore'
import styles from '../styles/StatusBar.module.css'

function toolLabel(tool: ActiveTool): string {
  switch (tool.kind) {
    case 'place':
      return `Place ${tool.componentType}`
    default:
      return `${tool.kind[0].toUpperCase()}${tool.kind.slice(1)}`
  }
}

export default function StatusBar(): React.JSX.Element {
  const statusMessage = useCircuitStore((s) => s.statusMessage)
  const activeTool = useCircuitStore((s) => s.activeTool)
  const simMode = useCircuitStore((s) => s.simMode)
  const simTimeNs = useCircuitStore((s) => s.simTimeNs)

  return (
    <div className={styles.statusbar}>
      <span className={styles.message}>{statusMessage || 'Ready'}</span>
      <span className={styles.spacer} />
      <span className={styles.field}>Tool: {toolLabel(activeTool)}</span>
      <span className={styles.field}>Mode: {simMode}</span>
      <span className={styles.field}>Time: {simTimeNs} ns</span>
    </div>
  )
}
