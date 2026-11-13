import { spawn } from 'node:child_process'
import { existsSync, readFileSync, renameSync, unlinkSync, unwatchFile, watchFile, writeFileSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { join } from 'node:path'
import { defaults, type Calls, type Language, type Notice, type Settings, type WorkerCalls, type WorkerMethod, type WorkerSettings } from '../shared/api'
import { isNonce, matches, nonce, pipeName, proof, receive, send } from './transport'
import { discoveredSelection, language, record } from './validation'
import { vitePortCommand } from './vite-port'

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
const preferenceObservers = new Map<string, Set<() => void>>()

function readPreference(file: string) {
  try { return readFileSync(file, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return undefined
  }
}

function writePreference(file: string, value: string) {
  const temporary = file + '.' + nonce()
  writeFileSync(temporary, value, { flag: 'wx', mode: 0o600 })
  try { renameSync(temporary, file) }
  catch (error) {
    try { unlinkSync(temporary) } catch {}
    throw error
  }
}

export class Client {
  private socket?: Socket
  private connecting?: Promise<Socket>
  private upgrading?: Promise<Socket>
  private pending = new Map<number, Pending>()
  private counter = 0
  private methods = new Set<WorkerMethod>()
  private supportsVitePort = false
  private closed = false
  private token: string
  private pipe: string
  private languageFile: string
  private themeFile: string
  private currentLanguage: Language
  private classicBaseTheme?: WorkerSettings['theme']

  constructor(private folder: string, private script: string, private notice: (notice: Notice) => void, private executable = process.execPath) {
    const file = join(folder, 'worker.key')
    if (!existsSync(file)) {
      try { writeFileSync(file, nonce(), { flag: 'wx', mode: 0o600 }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    this.token = readFileSync(file, 'utf8')
    this.pipe = pipeName(folder)
    this.languageFile = join(folder, 'ui-language')
    this.themeFile = join(folder, 'ui-theme')
    this.currentLanguage = this.readLanguage()
    this.classicBaseTheme = this.readClassicBaseTheme()
    const observers = preferenceObservers.get(this.pipe) ?? new Set()
    observers.add(this.preferencesChanged)
    preferenceObservers.set(this.pipe, observers)
    const polling = { persistent: false, interval: 250 }
    watchFile(this.languageFile, polling, this.preferencesChanged)
    watchFile(this.themeFile, polling, this.preferencesChanged)
  }

  get language() { return this.currentLanguage }

  private readLanguage(): Language {
    return readPreference(this.languageFile) === 'en' ? 'en' : defaults.language
  }

  private readClassicBaseTheme(): WorkerSettings['theme'] | undefined {
    const marker = readPreference(this.themeFile)
    if (marker === 'classic-light') return 'light'
    // Version 1.0.7 used Dark as the worker-compatible base for Classic.
    if (marker === 'classic') return 'dark'
  }

  private withPreferences(settings: WorkerSettings): Settings {
    const theme = settings?.theme
    return {
      ...settings,
      language: this.readLanguage(),
      theme: theme && theme === this.readClassicBaseTheme() ? 'classic' : theme ?? defaults.theme,
    }
  }

  private preferencesChanged = () => {
    let language: Language
    let classicBaseTheme: WorkerSettings['theme'] | undefined
    try {
      language = this.readLanguage()
      classicBaseTheme = this.readClassicBaseTheme()
    } catch { return }
    if (language === this.currentLanguage && classicBaseTheme === this.classicBaseTheme) return
    this.currentLanguage = language
    this.classicBaseTheme = classicBaseTheme
    this.notice({ type: 'changed' })
  }

  private savePreferences(language: Language | undefined, classicTheme: boolean) {
    try {
      if (language && language !== this.readLanguage()) writePreference(this.languageFile, language)
      const classicBaseTheme = classicTheme ? 'light' : undefined
      if (classicBaseTheme !== this.readClassicBaseTheme()) writePreference(this.themeFile, classicTheme ? 'classic-light' : 'standard')
    } finally {
      // Notify desktop and bundled web clients after the commit, independent of file polling.
      for (const notify of preferenceObservers.get(this.pipe) ?? []) notify()
    }
  }

  private attach() {
    return new Promise<Socket>((resolve, reject) => {
      if (this.closed) { reject(new Error('后台连接已关闭')); return }
      const socket = createConnection(this.pipe)
      const handshake = setTimeout(() => socket.destroy(), 1000)
      const clientNonce = nonce()
      let serverNonce = ''
      socket.on('error', () => socket.destroy())
      socket.on('close', () => {
        clearTimeout(handshake)
        reject(new Error('后台连接已断开'))
        if (this.socket !== socket) return
        this.socket = undefined
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer)
          pending.reject(new Error('后台连接已断开'))
        }
        this.pending.clear()
        this.notice({ type: 'connection', online: false })
      })
      receive(socket, (message) => {
        if (this.closed) { socket.destroy(); return }
        if (this.socket !== socket) {
          if (!serverNonce && isNonce(message?.nonce)) {
            serverNonce = message.nonce
            send(socket, { nonce: clientNonce, proof: proof(this.token, 'client', serverNonce, clientNonce), pid: process.pid })
            return
          }
          if (!serverNonce || message?.ready !== true || !matches(proof(this.token, 'worker', serverNonce, clientNonce), message.proof)) {
            socket.destroy()
            return
          }
          clearTimeout(handshake)
          this.methods = new Set(Array.isArray(message.methods) ? message.methods : [])
          this.supportsVitePort = message.vitePort === true
          this.socket = socket
          resolve(socket)
          this.notice({ type: 'connection', online: true })
        } else if (message.notice) {
          this.notice(message.notice)
        } else {
          const pending = this.pending.get(message.request)
          if (!pending) return
          this.pending.delete(message.request)
          clearTimeout(pending.timer)
          if (typeof message.error === 'string') pending.reject(new Error(message.error))
          else pending.resolve(message.value)
        }
      })
    })
  }

  private connect() {
    if (this.upgrading) return this.upgrading
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket)
    if (!this.connecting) this.connecting = this.connectWorker().finally(() => { this.connecting = undefined })
    return this.connecting
  }

  private async connectWorker(preferNew = false) {
    if (!preferNew) {
      try { return await this.attach() } catch {}
    }
    if (this.closed) throw new Error('后台连接已关闭')
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    const options = { detached: true, stdio: 'ignore' as const, windowsHide: true, env }
    const child = spawn(this.executable, [this.script, this.folder], options)
    child.on('error', () => {})
    child.unref()
    for (let attempt = 0; attempt < 45 && !this.closed; attempt++) {
      await sleep(100)
      try { return await this.attach() } catch {}
    }
    throw new Error('无法连接 TSManager 后台，请重新启动应用')
  }

  close() {
    this.closed = true
    unwatchFile(this.languageFile, this.preferencesChanged)
    unwatchFile(this.themeFile, this.preferencesChanged)
    const observers = preferenceObservers.get(this.pipe)
    observers?.delete(this.preferencesChanged)
    if (!observers?.size) preferenceObservers.delete(this.pipe)
    this.socket?.destroy()
  }

  private upgradeLegacy(socket: Socket, method: 'start' | 'restart', id: string) {
    this.upgrading ??= this.replaceLegacy(socket, method, id).finally(() => { this.upgrading = undefined })
    return this.upgrading
  }

  private async replaceLegacy(socket: Socket, method: 'start' | 'restart', id: string) {
    const { retireLegacyWorker } = await import('./worker-upgrade')
    await retireLegacyWorker(this.folder, this.pipe, async () => {
      const { runtime } = await this.request(socket, 'snapshot', null)
      const active = Object.entries(runtime).filter(([, run]) => ['starting', 'running', 'stopping'].includes(run.status))
      if (active.some(([projectId]) => method === 'start' || projectId !== id)) {
        throw new Error('旧版后台仍有项目在运行。停止这些项目后可自动切换新版后台。')
      }
      if (method === 'restart' && active.length) await this.request(socket, 'stop', { id })
      if (this.closed || socket.destroyed || this.socket !== socket) throw new Error('旧版后台连接已断开，请重试')
    })
    socket.destroy()
    const updated = await this.connectWorker(true)
    if (!this.supportsVitePort) throw new Error('另一个旧版窗口重新启动了后台，请关闭该窗口后重试')
    return updated
  }

  async call<M extends WorkerMethod>(method: M, input: Calls[M][0]): Promise<Calls[M][1]> {
    let socket = await this.connect()
    if (method === 'snapshot') {
      const snapshot = await this.request(socket, 'snapshot', null)
      return { ...snapshot, settings: this.withPreferences(snapshot.settings) } as Calls[M][1]
    }
    if (method === 'settings') {
      // Workers on earlier releases can still use the Light setting when Classic is selected.
      const { language: value, theme, ...settings } = record(input)
      const nextLanguage = value === undefined ? undefined : language(value)
      const classicTheme = theme === 'classic'
      const saved = await this.request(socket, 'settings', { ...settings, theme: classicTheme ? 'light' : theme } as WorkerSettings)
      this.savePreferences(nextLanguage, classicTheme)
      return this.withPreferences(saved) as Calls[M][1]
    }
    if ((method === 'discoverProjects' || method === 'stopDiscoveredProject') && !this.methods.has('stopDiscoveredProject')) {
      if (!this.methods.has('discoverProjects')) throw new Error('当前后台版本暂不支持项目识别')
      const { addLegacyProcessIdentities, stopLegacyDiscoveredProject } = await import('./discovery')
      const projects = await this.request(socket, 'discoverProjects', null)
      if (method === 'discoverProjects') return await addLegacyProcessIdentities(projects) as Calls[M][1]
      const { path, processes } = discoveredSelection(input)
      return await stopLegacyDiscoveredProject(projects, path, processes) as Calls[M][1]
    }
    if ((method === 'start' || method === 'restart') && !this.supportsVitePort) {
      const { id } = input as Calls['start'][0]
      const project = (await this.request(socket, 'snapshot', null)).projects.find((item) => item.id === id)
      if (project && vitePortCommand(project) !== project.command) {
        socket = await this.upgradeLegacy(socket, method, id)
      }
    }
    return this.request(socket, method, input as WorkerCalls[M][0]) as Promise<Calls[M][1]>
  }

  private request<M extends WorkerMethod>(socket: Socket, method: M, input: WorkerCalls[M][0]): Promise<WorkerCalls[M][1]> {
    if (socket.destroyed || this.socket !== socket) return Promise.reject(new Error('后台连接已断开'))
    const request = ++this.counter
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request)
        reject(new Error('后台操作超时'))
      }, 30000)
      this.pending.set(request, { resolve, reject, timer })
      send(socket, { request, method, input })
    })
  }
}
