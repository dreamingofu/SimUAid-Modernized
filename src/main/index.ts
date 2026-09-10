import { app, BrowserWindow, Menu, dialog, ipcMain } from 'electron'
import type { MenuItemConstructorOptions, IpcMainInvokeEvent } from 'electron'
import { dirname, join } from 'path'
import { stat } from 'fs/promises'
import { randomUUID } from 'crypto'
import { readDocument, writeDocument, validateText, validateExportFiles } from './files'
import { MENU_STRUCTURE, type MenuItemSpec } from '../shared/menu'
import type { ConfirmOptions } from '../shared/dialog'

let mainWindow: BrowserWindow | null = null
const editablePaths = new Set<string>()
let rendererReady = false
let pendingClose: string | null = null
let closeApproved = false
let rendererUnavailable = false
let closePromptOpen = false
let activeRequests = 0
let closeTimer: ReturnType<typeof setTimeout> | undefined

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents
    || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('Untrusted IPC sender.')
  }
}

function handle<Args extends unknown[]>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: Args) => unknown): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedSender(event)
    if (channel.startsWith('window:')) return listener(event, ...args as Args)
    activeRequests++
    return Promise.resolve().then(() => listener(event, ...args as Args)).finally(() => { activeRequests-- })
  })
}

function watchCloseResponse(): void {
  clearTimeout(closeTimer)
  closeTimer = setTimeout(() => {
    if (!pendingClose) return
    // Never compete with an open Save/Cancel dialog or an in-flight disk write.
    if (activeRequests) watchCloseResponse()
    else void confirmUnavailableClose()
  }, 5000)
  closeTimer.unref()
}

async function confirmUnavailableClose(): Promise<void> {
  const win = mainWindow
  if (!win || closePromptOpen) return
  pendingClose = null
  clearTimeout(closeTimer)
  closePromptOpen = true
  try {
    const result = await dialog.showMessageBox(win, {
      type: 'warning', message: 'The editor is not responding.',
      detail: 'Unsaved changes cannot be saved right now. Close without saving?',
      buttons: ['Cancel', 'Close without saving'], defaultId: 0, cancelId: 0
    })
    if (result.response === 1) {
      closeApproved = true
      win.destroy()
    }
  } finally {
    closePromptOpen = false
  }
}

/**
 * Builds the native application menu from the shared descriptor. This menu is the
 * real owner of the keyboard accelerators (Table 1 of the reference manual).
 * Activating any item — by click or accelerator — forwards its command id to the
 * renderer, where the single command dispatcher handles it. The bar itself is
 * hidden (see createWindow) so it does not duplicate the in-app React MenuBar;
 * the accelerators keep working regardless.
 */
function buildMenu(win: BrowserWindow): Menu {
  const buildItems = (items: MenuItemSpec[]): MenuItemConstructorOptions[] =>
    items.map((item): MenuItemConstructorOptions => {
      if (item.type === 'separator') return { type: 'separator' }
      if (item.submenu) return { label: item.label, submenu: buildItems(item.submenu) }
      return {
        label: item.label,
        accelerator: item.accelerator,
        click: () => {
          if (item.id) win.webContents.send('menu:command', item.id)
        }
      }
    })
  const template: MenuItemConstructorOptions[] = MENU_STRUCTURE.map((menu) => ({
    label: menu.label,
    submenu: buildItems(menu.items)
  }))
  return Menu.buildFromTemplate(template)
}

function createWindow(): void {
  rendererReady = false
  rendererUnavailable = false
  closePromptOpen = false
  closeApproved = false
  pendingClose = null
  editablePaths.clear()
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'SimUaid',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // Register the native menu (for accelerators) but keep the bar hidden so the
  // window shows only the styled React MenuBar.
  Menu.setApplicationMenu(buildMenu(mainWindow))
  mainWindow.setMenuBarVisibility(false)

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  mainWindow.webContents.session.setPermissionCheckHandler(() => false)

  const editorUnavailable = (): void => {
    rendererUnavailable = true
    if (pendingClose) void confirmUnavailableClose()
  }
  mainWindow.webContents.on('render-process-gone', editorUnavailable)
  mainWindow.on('unresponsive', editorUnavailable)
  mainWindow.on('responsive', () => { rendererUnavailable = false })
  mainWindow.on('close', (event) => {
    if (closeApproved || !rendererReady) return
    event.preventDefault()
    if (rendererUnavailable) {
      void confirmUnavailableClose()
      return
    }
    if (pendingClose) return
    pendingClose = randomUUID()
    mainWindow?.webContents.send('window:confirmClose', pendingClose)
    watchCloseResponse()
  })
  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    clearTimeout(closeTimer)
    mainWindow = null
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// --- File IPC: the renderer owns no fs access; it asks the main process. -----

handle('dialog:openCkt', async () => {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Circuit',
    filters: [
      { name: 'SimUaid Circuit', extensions: ['ckt'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const path = result.filePaths[0]
  const contents = await readDocument(path)
  editablePaths.add(path)
  return { path, contents }
})

handle(
  'dialog:saveCktAs',
  async (_event, contents: string, defaultName?: string) => {
    validateText(contents)
    if (defaultName !== undefined && typeof defaultName !== 'string') throw new Error('Invalid filename.')
    if (!mainWindow) return null
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Circuit As',
      defaultPath: defaultName ?? 'Untitled.ckt',
      filters: [{ name: 'SimUaid Circuit', extensions: ['ckt'] }]
    })
    if (result.canceled || !result.filePath) return null
    await writeDocument(result.filePath, contents)
    editablePaths.add(result.filePath)
    return result.filePath
  }
)

handle('file:saveCkt', async (_event, path: string, contents: string) => {
  if (typeof path !== 'string' || !editablePaths.has(path)) throw new Error('Use Open or Save As to choose this file first.')
  await writeDocument(path, contents)
  return true
})

handle('dialog:openChk', async () => {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Checker File',
    filters: [
      { name: 'Checker File', extensions: ['chk'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const path = result.filePaths[0]
  const contents = await readDocument(path)
  return { path, contents }
})

handle(
  'dialog:saveVhdl',
  async (_event, defaultName: string, files: { name: string; contents: string }[]) => {
    validateExportFiles(files)
    if (typeof defaultName !== 'string') throw new Error('Invalid filename.')
    if (!mainWindow) return null
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save VHDL',
      defaultPath: defaultName,
      filters: [{ name: 'VHDL', extensions: ['vhd'] }]
    })
    if (result.canceled || !result.filePath) return null
    const dir = dirname(result.filePath)
    const destinations = [result.filePath, ...files.slice(1).map(file => join(dir, file.name))]
    if (new Set(destinations.map(path => path.toLowerCase())).size !== destinations.length) {
      throw new Error('Export filenames conflict with the chosen filename.')
    }
    const existing = []
    for (const path of destinations.slice(1)) {
      if (await stat(path).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return false
      })) existing.push(path)
    }
    if (existing.length) {
      const response = await dialog.showMessageBox(mainWindow, {
        type: 'warning', message: 'Replace existing VHDL files?', detail: existing.join('\n'),
        buttons: ['Cancel', 'Replace'], defaultId: 0, cancelId: 0
      })
      if (response.response !== 1) return null
    }
    for (let i = 0; i < files.length; i++) await writeDocument(destinations[i], files[i].contents)
    return result.filePath
  }
)

handle('dialog:confirm', async (_event, options: ConfirmOptions) => {
  if (!options || typeof options.message !== 'string' || !Array.isArray(options.buttons)
    || !options.buttons.length || options.buttons.length > 10 || options.buttons.some(value => typeof value !== 'string')) {
    throw new Error('Invalid confirmation request.')
  }
  const fallback = options.cancelId ?? 0
  if (!mainWindow) return fallback
  const result = await dialog.showMessageBox(mainWindow, {
    type: options.type ?? 'question',
    message: options.message,
    detail: options.detail,
    buttons: options.buttons,
    defaultId: options.defaultId ?? 0,
    cancelId: options.cancelId ?? 0,
    noLink: true
  })
  return result.response
})

handle('window:ready', () => { rendererReady = true })
handle('window:completeClose', (_event, request: unknown, approved: unknown) => {
  if (typeof request !== 'string' || request !== pendingClose || typeof approved !== 'boolean') return
  pendingClose = null
  clearTimeout(closeTimer)
  if (approved) {
    closeApproved = true
    mainWindow?.close()
  }
})

// --- App lifecycle -----------------------------------------------------------

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
