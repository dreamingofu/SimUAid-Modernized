import { useCircuitStore } from '../store/circuitStore'
import DelayDialog from './DelayDialog'
import ScalingDialog from './ScalingDialog'
import OptionsDialog from './OptionsDialog'
import DefaultDelayDialog from './DefaultDelayDialog'
import InputSignalDialog from './InputSignalDialog'
import NBitDialog from './NBitDialog'
import StateMachineDialog from './StateMachineDialog'
import VhdlDialog from './VhdlDialog'
import BusTapDialog from './BusTapDialog'
import GraphicsModeDialog from './GraphicsModeDialog'
import PrintPreviewDialog from './PrintPreviewDialog'

/** Mounts whichever React modal the store currently requests. */
export default function DialogHost(): React.JSX.Element | null {
  const dialog = useCircuitStore((s) => s.dialog)
  if (!dialog) return null
  switch (dialog.kind) {
    case 'delay':
      return <DelayDialog componentId={dialog.componentId} />
    case 'scaling':
      return <ScalingDialog />
    case 'options':
      return <OptionsDialog />
    case 'defaultDelay':
      return <DefaultDelayDialog />
    case 'inputSignal':
      return <InputSignalDialog componentId={dialog.componentId} />
    case 'placeNBit':
      return <NBitDialog componentType={dialog.componentType} />
    case 'placeSM':
      return <StateMachineDialog />
    case 'vhdl':
      return <VhdlDialog />
    case 'busTap':
      return <BusTapDialog wireId={dialog.wireId} x={dialog.x} y={dialog.y} />
    case 'graphicsMode':
      return <GraphicsModeDialog />
    case 'printPreview':
      return <PrintPreviewDialog />
    default:
      return null
  }
}
