import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { MenuCommandId } from '../shared/menu'
import type { ConfirmOptions } from '../shared/dialog'

/** Result of a successful Open dialog. */
export interface OpenCktResult {
  path: string
  contents: string
}

/**
 * The safe API exposed to the renderer via contextBridge. The renderer has no
 * direct Node/fs access; everything goes through these channels.
 */
const api = {
  openCkt: (): Promise<OpenCktResult | null> => ipcRenderer.invoke('dialog:openCkt'),
  saveCktAs: (contents: string, defaultName?: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:saveCktAs', contents, defaultName),
  saveCkt: (path: string, contents: string): Promise<boolean> =>
    ipcRenderer.invoke('file:saveCkt', path, contents),
  /** Shows a native message box; resolves to the index of the clicked button. */
  confirm: (options: ConfirmOptions): Promise<number> =>
    ipcRenderer.invoke('dialog:confirm', options),
  openChk: (): Promise<OpenCktResult | null> => ipcRenderer.invoke('dialog:openChk'),
  /** files[0] goes to the chosen path; the rest are written beside it. */
  saveVhdl: (defaultName: string, files: { name: string; contents: string }[]): Promise<string | null> =>
    ipcRenderer.invoke('dialog:saveVhdl', defaultName, files),
  /**
   * Subscribes to native-menu / accelerator commands. Returns an unsubscribe
   * function so React effects can clean up.
   */
  onMenuCommand: (callback: (id: MenuCommandId) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, id: MenuCommandId): void => callback(id)
    ipcRenderer.on('menu:command', listener)
    return () => ipcRenderer.removeListener('menu:command', listener)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
