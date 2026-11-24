import { app, BrowserWindow, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { SqliteStore } from '@storage/index'
import { AdapterRegistry } from '@adapters/index'
import { Orchestrator } from '@orchestrator/index'
import { ElectronCredentialStore } from './credentials'
import { registerIpc } from './ipc'

let mainWindow: BrowserWindow | undefined
let activeRegistry: AdapterRegistry | undefined
let activeStore: SqliteStore | undefined

app.whenReady().then(() => {
  const userDataPath = app.getPath('userData')
  const store = new SqliteStore(join(userDataPath, 'agent-team.db'))
  const credentials = new ElectronCredentialStore(userDataPath)
  const registry = new AdapterRegistry(store, credentials)
  const orchestrator = new Orchestrator(store, registry)
  activeRegistry = registry
  activeStore = store

  const preloadCandidates = ['../preload/index.mjs', '../preload/index.js'].map((name) => join(__dirname, name))
  const preloadPath = preloadCandidates.find((path) => existsSync(path)) ?? preloadCandidates[0]

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  registerIpc(store, registry, orchestrator, credentials, () => mainWindow?.webContents, userDataPath)

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void activeRegistry?.disconnectAll()
  activeStore?.close()
})
