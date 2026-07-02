import { useEffect } from 'react'
import MenuBar from './components/MenuBar'
import Toolbar from './components/Toolbar'
import Canvas from './components/Canvas'
import StatusBar from './components/StatusBar'
import TimingPanel from './components/TimingPanel'
import DialogHost from './components/DialogHost'
import InlineLabelEditor from './components/InlineLabelEditor'
import StateTableEditor from './components/StateTableEditor'
import PrintRoot from './components/PrintRoot'
import { dispatchCommand } from './commands'
import { useCircuitStore } from './store/circuitStore'
import styles from './styles/App.module.css'

export default function App(): React.JSX.Element {
  const timingPanelVisible = useCircuitStore((s) => s.timingPanelVisible)
  const fileName = useCircuitStore((s) => s.netlist.metadata.name)
  const dirty = useCircuitStore((s) => s.dirty)

  // Route native-menu / accelerator commands into the shared dispatcher.
  useEffect(() => {
    const unsubscribe = window.api.onMenuCommand((id) => {
      void dispatchCommand(id)
    })
    return unsubscribe
  }, [])

  // Reflect the current file + dirty state in the window title.
  useEffect(() => {
    document.title = `${dirty ? '• ' : ''}${fileName} — SimUaid`
  }, [fileName, dirty])

  // Keep Show I/O values current: re-settle when the circuit changes or when the
  // display is turned on. Switch toggles publish their own values, so they leave
  // netlist/showIoValues unchanged and don't re-trigger here.
  useEffect(() => {
    return useCircuitStore.subscribe((s, prev) => {
      if (!s.showIoValues) return
      if (s.netlist !== prev.netlist || s.showIoValues !== prev.showIoValues) {
        useCircuitStore.getState().simSettle()
      }
    })
  }, [])

  return (
    <div className={styles.app}>
      <MenuBar />
      <Toolbar />
      <div className={styles.main}>
        <Canvas />
        {timingPanelVisible && <TimingPanel />}
      </div>
      <StatusBar />
      <DialogHost />
      <InlineLabelEditor />
      <StateTableEditor />
      <PrintRoot />
    </div>
  )
}
