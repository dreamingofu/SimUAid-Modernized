import { app, BrowserWindow, Menu, dialog, ipcMain } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { dirname, join } from 'path'
import { readFile, writeFile } from 'fs/promises'
import { MENU_STRUCTURE, type MenuItemSpec } from '../shared/menu'
import type { ConfirmOptions } from '../shared/dialog'

let mainWindow: BrowserWindow | null = null

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
      sandbox: false
    }
  })

  // Register the native menu (for accelerators) but keep the bar hidden so the
  // window shows only the styled React MenuBar.
  Menu.setApplicationMenu(buildMenu(mainWindow))
  mainWindow.setMenuBarVisibility(false)

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// --- File IPC: the renderer owns no fs access; it asks the main process. -----

ipcMain.handle('dialog:openCkt', async () => {
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
  const contents = await readFile(path, 'utf-8')
  return { path, contents }
})

ipcMain.handle(
  'dialog:saveCktAs',
  async (_event, contents: string, defaultName?: string) => {
    if (!mainWindow) return null
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Circuit As',
      defaultPath: defaultName ?? 'Untitled.ckt',
      filters: [{ name: 'SimUaid Circuit', extensions: ['ckt'] }]
    })
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, contents, 'utf-8')
    return result.filePath
  }
)

ipcMain.handle('file:saveCkt', async (_event, path: string, contents: string) => {
  await writeFile(path, contents, 'utf-8')
  return true
})

ipcMain.handle('dialog:openChk', async () => {
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
  const contents = await readFile(path, 'utf-8')
  return { path, contents }
})

ipcMain.handle(
  'dialog:saveVhdl',
  async (_event, defaultName: string, files: { name: string; contents: string }[]) => {
    if (!mainWindow) return null
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save VHDL',
      defaultPath: defaultName,
      filters: [{ name: 'VHDL', extensions: ['vhd'] }]
    })
    if (result.canceled || !result.filePath) return null
    const dir = dirname(result.filePath)
    await writeFile(result.filePath, files[0].contents, 'utf-8')
    for (const extra of files.slice(1)) {
      await writeFile(join(dir, extra.name), extra.contents, 'utf-8')
    }
    return result.filePath
  }
)

ipcMain.handle('dialog:confirm', async (_event, options: ConfirmOptions) => {
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
