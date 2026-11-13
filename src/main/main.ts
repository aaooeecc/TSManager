import { app, BrowserWindow, dialog, ipcMain, Menu, shell, Tray, type IpcMainInvokeEvent } from 'electron'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { defaults, workerMethods, type Language, type Method, type Settings, type Snapshot, type WorkerMethod } from '../shared/api'
import { localizeMessage } from '../shared/messages'
import { Client } from './client'
import { nonce } from './transport'
import * as valid from './validation'
import { createWebServer } from './web'

app.setName('TSManager')
const data = resolve(process.env.TSMANAGER_DATA_DIR || join(app.getPath('appData'), 'TSManager'))
app.setPath('userData', data)
app.setAppUserModelId('local.tsmanager.desktop')

let window: BrowserWindow | undefined
let tray: Tray | undefined
let client: Client
let quit = false
let closing = false
let exit: Settings['exit'] = 'stop'
let theme = defaults.theme
let themePreview: Settings['theme'] | null = null
let language = defaults.language
const titleBarColors = {
  light: { color: '#ffffff', symbolColor: '#191919' },
  dark: { color: '#05060f', symbolColor: '#f4f2fb' },
  classic: { color: '#f5f6fa', symbolColor: '#222631' },
}
const nativeText = {
  'zh-CN': {
    show: '显示 TSManager', quit: '退出 TSManager', chooseDirectory: '选择项目目录',
    unsupported: 'TSManager 需要 Windows 10 1809 或更新版本（x64）。',
    startFailed: 'TSManager 启动失败', stopFailed: '无法确认所有项目均已退出。',
  },
  en: {
    show: 'Show TSManager', quit: 'Quit TSManager', chooseDirectory: 'Choose Project Folder',
    unsupported: 'TSManager requires Windows 10 version 1809 or later (x64).',
    startFailed: 'TSManager could not start', stopFailed: 'Unable to confirm that all projects stopped.',
  },
}
let webWorkspace: Promise<{ close: () => Promise<void>; address: string }> | undefined
const page = join(app.getAppPath(), 'renderer-dist', 'index.html')
const icon = join(app.getAppPath(), 'assets', 'icon.ico')
const devUrl = !app.isPackaged ? process.env.TSMANAGER_DEV_URL : undefined
const url = devUrl ? new URL(devUrl).href : pathToFileURL(page).href

async function startWebWorkspace() {
  const key = nonce()
  const web = createWebServer({
    folder: data, key, port: 0, electron: process.execPath,
    worker: join(__dirname, 'worker.cjs'),
    web: join(app.getAppPath(), 'web-dist'),
    icon, language: () => language,
  })
  await new Promise<void>((resolve, reject) => {
    web.server.once('error', reject)
    web.server.listen(0, '127.0.0.1', resolve)
  })
  return { close: web.close, address: web.origin + '/preview.html#session=' + key }
}

async function openWebWorkspace() {
  if (closing) throw new Error('TSManager 正在退出')
  webWorkspace ??= startWebWorkspace().catch((error) => { webWorkspace = undefined; throw error })
  const { address } = await webWorkspace
  if (!closing) await shell.openExternal(address)
}

async function shutdown() {
  const web = await webWorkspace?.catch(() => undefined)
  await web?.close()
  const current = await client.call('snapshot', null).catch(() => undefined)
  if ((current?.settings.exit ?? exit) === 'stop') await client.call('stopAll', null)
}

function updateTray() {
  const text = nativeText[language]
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: text.show, click: showWindow },
    { type: 'separator' },
    { label: text.quit, click: () => app.quit() },
  ]))
}

function applyLanguage(value: Language) {
  if (language === value) return
  language = value
  updateTray()
}

function applyWindowTheme(value: Settings['theme']) {
  const colors = titleBarColors[value]
  window?.setTitleBarOverlay(colors)
  window?.setBackgroundColor(colors.color)
}

function setThemePreview(value: Settings['theme'] | null) {
  const previous = themePreview ?? theme
  themePreview = value
  const next = themePreview ?? theme
  if (previous !== next) applyWindowTheme(next)
}

function applySettings(settings: Settings) {
  exit = settings.exit
  applyLanguage(settings.language)
  if (theme === settings.theme) return
  theme = settings.theme
  if (themePreview === null) applyWindowTheme(theme)
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1430, height: 900, minWidth: 860, minHeight: 550,
    title: 'TSManager', icon, backgroundColor: titleBarColors[theme].color, autoHideMenuBar: true,
    titleBarStyle: 'hidden', titleBarOverlay: { ...titleBarColors[theme], height: 34 },
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  })
  window = mainWindow
  mainWindow.removeMenu()
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  mainWindow.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument && details.url === url) setThemePreview(null)
  })
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  mainWindow.webContents.session.setPermissionCheckHandler(() => false)
  mainWindow.on('close', (event) => {
    if (quit) return
    event.preventDefault()
    mainWindow.hide()
  })
  mainWindow.on('query-session-end', () => {
    // Windows ends both processes and closes the worker's Job handles at sign-out.
    if (exit === 'stop') void client.call('stopAll', null).catch(() => {})
  })
  mainWindow.on('closed', () => { window = undefined; themePreview = null })
  if (devUrl) void mainWindow.loadURL(url)
  else void mainWindow.loadFile(page)
  return mainWindow
}

function showWindow() {
  if (closing || quit) return
  const mainWindow = window ?? createWindow()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
}

async function handleCall(event: IpcMainInvokeEvent, method: Method, input: unknown) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame?.url !== url) {
    throw new Error('请求来自未授权页面')
  }
  if (workerMethods.includes(method as WorkerMethod)) {
    const result = await client.call(method as WorkerMethod, input as never)
    if (method === 'settings') applySettings(result as Settings)
    if (method === 'snapshot') applySettings((result as Snapshot).settings)
    return result
  }
  if (method === 'openWeb' && input === null) return openWebWorkspace()
  const args = valid.record(input)
  switch (method) {
    case 'chooseDirectory': {
      const defaultPath = args.path === undefined ? undefined : valid.string(args.path, '目录', 2048)
      const result = await dialog.showOpenDialog(window, { title: nativeText[language].chooseDirectory, defaultPath: defaultPath || undefined, properties: ['openDirectory'] })
      return result.canceled ? null : result.filePaths[0]
    }
    case 'openPort': return shell.openExternal('http://localhost:' + valid.port(args.port))
    case 'openFolder': {
      const id = valid.id(args.id)
      const project = (await client.call('snapshot', null)).projects.find((item) => item.id === id)
      if (!project) throw new Error('项目不存在')
      const error = await shell.openPath(valid.directory(project.path))
      if (error) throw new Error(error)
      return
    }
    case 'fullscreen':
      if (typeof args.value !== 'boolean') throw new Error('全屏参数无效')
      window.setFullScreen(args.value)
      return
    case 'previewTheme':
      if (args.theme !== null && args.theme !== 'light' && args.theme !== 'dark' && args.theme !== 'classic') throw new Error('主题无效')
      setThemePreview(args.theme)
      return
    default: throw new Error('未知的操作')
  }
}

if (!app.requestSingleInstanceLock()) {
  quit = true
  app.quit()
} else {
  void app.whenReady().then(() => {
    if (process.platform !== 'win32' || process.arch !== 'x64') {
      dialog.showErrorBox('TSManager', nativeText[language].unsupported)
      quit = true
      app.quit()
      return
    }
    mkdirSync(data, { recursive: true, mode: 0o700 })
    client = new Client(data, join(__dirname, 'worker.cjs'), (notice) => {
      if (notice.type === 'changed') applyLanguage(client.language)
      window?.webContents.send('tsmanager:notice', notice)
    })
    language = client.language
    ipcMain.handle('tsmanager:call', (event, method: Method, input: unknown) =>
      handleCall(event, method, input).catch((error) => {
        throw new Error(localizeMessage(language, error instanceof Error ? error.message : String(error)))
      }))
    tray = new Tray(icon)
    app.once('will-quit', () => { tray?.destroy(); client.close() })
    tray.setToolTip('TSManager')
    updateTray()
    tray.on('click', showWindow)
    app.on('second-instance', showWindow)
    createWindow()
  }).catch((error) => {
    dialog.showErrorBox(nativeText[language].startFailed, localizeMessage(language, error instanceof Error ? error.message : String(error)))
    quit = true
    app.quit()
  })
  app.on('window-all-closed', () => {
    // Keep the tray available if the main window is destroyed.
  })
  app.on('before-quit', (event) => {
    if (quit || !client) return
    event.preventDefault()
    if (closing) return
    closing = true
    void shutdown().catch((error) => {
      dialog.showErrorBox('TSManager', nativeText[language].stopFailed + '\n' + localizeMessage(language, error.message))
    }).finally(() => { quit = true; app.quit() })
  })
}
