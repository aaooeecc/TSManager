import { createServer, type Socket } from 'node:net'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { workerMethods, type Notice, type WorkerMethod } from '../shared/api'
import { Store } from './db'
import { discoverProjects, stopDiscoveredProject } from './discovery'
import { Projects } from './projects'
import { isNonce, matches, nonce, pipeName, proof, receive, send } from './transport'
import * as valid from './validation'

const folder = process.argv[2]
if (process.platform !== 'win32' || process.arch !== 'x64' || !folder) process.exit(1)
const token = readFileSync(join(folder, 'worker.key'), 'utf8')
const runsFolder = join(folder, 'pty-runs')
let store: Store
let projects: Projects
let idle: ReturnType<typeof setTimeout> | undefined
const clients = new Map<Socket, number | undefined>()
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

function broadcast(notice: Notice) {
  for (const socket of clients.keys()) send(socket, { notice })
  if (notice.type === 'status' && !clients.size) scheduleIdle()
}

function scheduleIdle() {
  clearTimeout(idle)
  idle = setTimeout(async () => {
    if (clients.size) return
    if (projects.busy && store.settings.exit === 'stop') {
      try { await projects.stopAll() } catch { process.exit(1) }
    }
    if (!clients.size && !projects.busy) {
      store.close()
      process.exit(0)
    }
  }, 4000)
}

function protectedPids() {
  const pids = new Set(projects.ownedPids().keys())
  pids.add(process.pid)
  for (const pid of clients.values()) if (pid) pids.add(pid)
  return pids
}

async function call(method: WorkerMethod, value: unknown) {
  if (method === 'snapshot') return { projects: store.projects(), groups: store.groups(), settings: store.settings, runtime: Object.fromEntries(projects.runtime) }
  if (method === 'history') return store.history()
  if (method === 'ports') return projects.ports()
  if (method === 'discoverProjects') return discoverProjects(store.projects(), protectedPids())
  if (method === 'stopAll') return projects.stopAll()
  const args = valid.record(value)
  if (method === 'settings') {
    const settings = store.saveSettings(valid.settings(args))
    broadcast({ type: 'changed' })
    return settings
  }
  if (method === 'checkPort') return projects.ports(valid.port(args.port))
  if (method === 'stopPort') return projects.stopPort(valid.port(args.port), valid.integer(args.pid, 'PID', 1, 0xffffffff), valid.required(args.started, '启动时间', 24))
  if (method === 'stopDiscoveredProject') {
    const { path, processes } = valid.discoveredSelection(args)
    return stopDiscoveredProject(store.projects(), protectedPids, path, processes)
  }
  if (method === 'saveGroup') {
    const group = store.saveGroup(valid.required(args.name, '分组名称', 100), args.id === undefined ? undefined : valid.id(args.id))
    broadcast({ type: 'changed' })
    return group
  }
  if (method === 'deleteGroup') {
    store.deleteGroup(valid.id(args.id), valid.id(args.targetId))
    broadcast({ type: 'changed' })
    return
  }
  if (method === 'reorderProjects') {
    if (!Array.isArray(args.ids)) throw new Error('项目顺序无效')
    store.reorder(args.ids.map(valid.id))
    broadcast({ type: 'changed' })
    return
  }
  if (method === 'saveProject') {
    const input = valid.projectInput(args.project)
    const id = args.id === undefined ? undefined : valid.id(args.id)
    if (id && projects.isActive(id)) {
      const existing = store.project(id)
      const changed = (['command', 'path', 'port', 'shell'] as const).some((key) => input[key] !== existing[key])
      const sameEnv = input.env === undefined || (
        Object.keys(input.env).length === existing.envKeys.length &&
        Object.entries(store.env(id)).every(([key, value]) => input.env?.[key] === value)
      )
      if (changed || !sameEnv) throw new Error('请先停止项目，再修改路径、命令、端口、Shell 或环境变量')
    }
    const project = store.saveProject(input, id)
    broadcast({ type: 'changed' })
    return project
  }
  const id = valid.id(args.id)
  store.project(id)
  switch (method) {
    case 'deleteProject':
      if (projects.isActive(id)) throw new Error('请先停止项目')
      store.deleteProject(id)
      projects.forget(id)
      broadcast({ type: 'changed' })
      return
    case 'projectEnv': return store.env(id)
    case 'start':
    case 'restart': {
      const cols = args.cols === undefined ? undefined : valid.integer(args.cols, '终端列数', 2, 500)
      const rows = args.rows === undefined ? undefined : valid.integer(args.rows, '终端行数', 2, 300)
      return projects[method](id, cols, rows)
    }
    case 'stop': return projects.stop(id)
    case 'terminal': return projects.terminal(id)
    case 'write': return projects.write(id, valid.string(args.data, '终端输入', 65536, false))
    case 'resize': return projects.resize(id, valid.integer(args.cols, '终端列数', 2, 500), valid.integer(args.rows, '终端行数', 2, 300))
    case 'interrupt': return projects.write(id, '\x03')
    case 'clearTerminal': return projects.clear(id)
    case 'logs': return store.logs(id, args.runId === undefined ? undefined : valid.id(args.runId))
    case 'clearLogs': return projects.clearLogs(id)
    default: throw new Error('未知的后台操作')
  }
}

const server = createServer((socket) => {
  socket.on('error', () => socket.destroy())
  const serverNonce = nonce()
  const handshake = setTimeout(() => socket.destroy(), 1500)
  socket.on('close', () => {
    clearTimeout(handshake)
    if (clients.delete(socket) && !clients.size) scheduleIdle()
  })
  receive(socket, (message) => {
    if (!clients.has(socket)) {
      const clientNonce = message?.nonce
      if (!isNonce(clientNonce) || !matches(proof(token, 'client', serverNonce, clientNonce), message.proof)) {
        socket.destroy()
        return
      }
      clearTimeout(handshake)
      clearTimeout(idle)
      const pid = message.pid
      clients.set(socket, Number.isInteger(pid) && pid > 0 && pid <= 0xffffffff ? pid : undefined)
      send(socket, { ready: true, proof: proof(token, 'worker', serverNonce, clientNonce), methods: workerMethods, vitePort: true })
      return
    }
    const { request, method, input } = message
    if (!Number.isSafeInteger(request) || !workerMethods.includes(method)) { socket.destroy(); return }
    void call(method, input).then(
      (value) => send(socket, { request, value }),
      (error) => send(socket, { request, error: errorText(error) }),
    )
  })
  send(socket, { nonce: serverNonce })
})
server.on('error', (error) => {
  if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') console.error(errorText(error))
  process.exit(1)
})
server.listen(pipeName(folder), () => {
  // Only the instance holding the listener may touch the database or temporary files.
  rmSync(runsFolder, { recursive: true, force: true })
  store = new Store(join(folder, 'tsmanager.sqlite3'))
  projects = new Projects(store, runsFolder, broadcast)
  scheduleIdle()
})
