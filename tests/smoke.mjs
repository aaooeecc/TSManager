import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import electron from 'electron'

const folder = await mkdtemp(join(tmpdir(), 'TSManager smoke 项目 '))
const executable = process.env.TSMANAGER_TEST_EXE || electron
const script = process.env.TSMANAGER_TEST_WORKER || resolve('build/worker.cjs')
const token = randomBytes(32).toString('hex')
await writeFile(join(folder, 'worker.key'), token)
const address = '\\\\.\\pipe\\tsmanager-' + createHash('sha256').update(folder.toLowerCase()).digest('hex').slice(0, 32)
let worker, socket, external, background
let count = 0
const replies = new Map()

async function eventually(action, timeout = 12000) {
  const until = Date.now() + timeout
  let value
  do {
    value = await action()
    if (value) return value
    await wait(100)
  } while (Date.now() < until)
  throw new Error('Timed out waiting for ' + action.toString())
}

function workerStart() {
  worker = spawn(executable, [script, folder], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: 'inherit',
  })
}

async function connect() {
  socket = await eventually(() => new Promise((resolve) => {
    const next = createConnection(address)
    next.once('error', () => { next.destroy(); resolve(false) })
    next.once('connect', () => resolve(next))
  }))
  let buffer = ''
  const nonce = randomBytes(32).toString('hex')
  let serverNonce = ''
  const proof = (role) => createHmac('sha256', token).update(role).update(serverNonce).update(nonce).digest('hex')
  const ready = new Promise((resolve) => replies.set('ready', { resolve }))
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    buffer += chunk
    for (let index = buffer.indexOf('\n'); index !== -1; index = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, index))
      buffer = buffer.slice(index + 1)
      if (message.nonce) {
        serverNonce = message.nonce
        socket.write(JSON.stringify({ nonce, proof: proof('client') }) + '\n')
        continue
      }
      if (message.ready) assert.equal(message.proof, proof('worker'))
      const key = message.ready ? 'ready' : message.request
      const pending = replies.get(key)
      if (!pending) continue
      replies.delete(key)
      if (message.error) pending.reject(new Error(message.error))
      else pending.resolve(message.value)
    }
  })
  await ready
}

function call(method, input = null) {
  return new Promise((resolve, reject) => {
    const request = ++count
    const timeout = setTimeout(() => {
      replies.delete(request)
      reject(new Error('RPC timed out: ' + method))
    }, 30000)
    replies.set(request, {
      resolve: (value) => { clearTimeout(timeout); resolve(value) },
      reject: (error) => { clearTimeout(timeout); reject(error) },
    })
    socket.write(JSON.stringify({ request, method, input }) + '\n')
  })
}

async function server() {
  const listener = createServer()
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve))
  return listener
}

async function freePort() {
  const listener = await server()
  const { port } = listener.address()
  await new Promise((resolve) => listener.close(resolve))
  return port
}

const state = async (id) => (await call('snapshot')).runtime[id]?.status
const output = async (id) => (await call('terminal', { id })).data
const owners = (port) => call('checkPort', { port })

try {
  workerStart()
  await connect()
  const snapshot = await call('snapshot')
  assert.equal(snapshot.groups.length, 1)
  const group = await call('saveGroup', { name: '开发服务' })
  const port = await freePort()
  const port2 = await freePort()
  const port3 = await freePort()
  await writeFile(join(folder, 'package.json'), JSON.stringify({ scripts: { dev: 'node fixture.cjs' } }))
  await writeFile(join(folder, 'fixture.cjs'), `
const net = require('node:net')
const port = Number(process.env.PORT)
net.createServer().listen(port, '127.0.0.1', () => console.log('\\x1b[32mREADY:' + port + '\\x1b[0m'))
if (process.env.TSMANAGER_TEST_PRIVATE_TOKEN?.startsWith('private-fixture-')) console.log(process.env.TSMANAGER_TEST_PRIVATE_TOKEN)
process.stdin.setEncoding('utf8').on('data', (data) => console.log('INPUT:' + data.trim()))
process.on('SIGINT', () => {})
`)
  await writeFile(join(folder, 'fixture.py'), `
import os, socket, time
s = socket.socket()
s.bind(('127.0.0.1', int(os.environ['PORT'])))
s.listen()
print('PYTHON_READY', flush=True)
while True:
    time.sleep(0.2)
`)
  const create = (name, command, port, shell = 'powershell', env, groupId = group.id) => call('saveProject', {
    project: { groupId, name, path: folder, command, port, shell, env },
  })
  const npm = await create('npm 项目', 'npm run dev', port, 'powershell', { PORT: '1', TSMANAGER_TEST_PRIVATE_TOKEN: 'private-fixture-value' })
  const pnpm = await create('pnpm 项目', 'pnpm dev', port2, 'cmd')
  const python = await create('Python 项目', 'python fixture.py', port3)
  assert.deepEqual(await call('projectEnv', { id: npm.id }), { PORT: '1', TSMANAGER_TEST_PRIVATE_TOKEN: 'private-fixture-value' })
  const db = await readFile(join(folder, 'tsmanager.sqlite3-wal'))
  assert.equal(db.includes('private-fixture-value'), false)
  const ids = [npm.id, pnpm.id, python.id]
  console.log('Starting three real projects on TCP ports', port, port2, port3)
  await Promise.all(ids.map((id) => call('start', { id })))
  try {
    for (const [item, value, mark] of [[npm, port, 'READY'], [pnpm, port2, 'READY'], [python, port3, 'PYTHON_READY']]) {
      await eventually(async () => (await owners(value)).find((owner) => owner.projectId === item.id))
      await eventually(async () => (await output(item.id)).includes(mark))
      await eventually(async () => await state(item.id) === 'running')
    }
  } catch (error) {
    for (const id of ids) console.error(id, await state(id), await output(id))
    throw error
  }
  assert.match(await output(npm.id), /\x1b\[/)
  assert.ok(!(await call('discoverProjects')).some((item) => item.path === folder))
  assert.match(await output(npm.id), /private-fixture-value/)
  await call('resize', { id: npm.id, cols: 92, rows: 25 })
  await call('write', { id: npm.id, data: 'hello-terminal\r' })
  await eventually(async () => (await output(npm.id)).includes('INPUT:hello-terminal'))
  assert.doesNotMatch(await output(pnpm.id), /INPUT:hello-terminal/)
  const occupied = await create('冲突项目', 'npm run dev', port)
  await assert.rejects(call('start', { id: occupied.id }), /PID/)
  const managed = (await owners(port))[0]
  await assert.rejects(call('stopPort', { port, pid: managed.pid, started: managed.started }), /TSManager/)
  assert.deepEqual(await call('stopDiscoveredProject', {
    path: folder, processes: [{ pid: managed.pid, started: managed.started }],
  }), { stopped: [], changed: [managed.pid], failed: [] })
  const pid = (await owners(port))[0].pid
  console.log('Restarting npm project from listener PID', pid)
  await call('restart', { id: npm.id })
  const restarted = await eventually(async () => (await owners(port)).find((owner) => owner.projectId === npm.id))
  assert.notEqual(restarted.pid, pid)
  await call('interrupt', { id: python.id })
  await eventually(async () => await state(python.id) === 'stopped')
  assert.equal((await owners(port3)).length, 0)
  await call('stop', { id: npm.id })
  assert.equal((await owners(port)).length, 0)
  assert.equal((await owners(port2))[0].projectId, pnpm.id)
  const logText = (await call('logs', { id: npm.id })).map((line) => line.text).join('')
  assert.match(logText, /READY/)
  assert.doesNotMatch(logText, /private-fixture-value/)
  await call('clearTerminal', { id: npm.id })
  assert.equal(await output(npm.id), '')
  const settings = { ...(await call('snapshot')).settings, exit: 'keep', stopTimeout: 500 }
  await call('settings', settings)
  socket.destroy()
  await wait(4500)
  await connect()
  assert.equal((await owners(port2))[0].projectId, pnpm.id)
  assert.equal(await state(pnpm.id), 'running')
  await call('settings', { ...settings, exit: 'stop' })
  socket.destroy()
  await eventually(() => worker.exitCode === 0, 20000)
  workerStart()
  await connect()
  assert.equal((await owners(port2)).length, 0)
  assert.equal(await state(pnpm.id), undefined)
  assert.ok((await call('history')).length >= 5)
  await call('deleteGroup', { id: group.id, targetId: 'default' })
  assert.ok((await call('snapshot')).projects.every((item) => item.groupId === 'default'))
  await call('deleteProject', { id: occupied.id })
  assert.ok(await readFile(join(folder, 'fixture.cjs'), 'utf8'))
  const fail = await createError()
  await call('start', { id: fail.id })
  await eventually(async () => await state(fail.id) === 'error')
  const externalPort = await freePort()
  const externalDir = join(folder, '外部应用')
  const backgroundDir = join(folder, '外部任务')
  await Promise.all([mkdir(externalDir), mkdir(backgroundDir)])
  await Promise.all([
    writeFile(join(externalDir, 'package.json'), JSON.stringify({ name: 'discovered-app', packageManager: 'pnpm@10.0.0', scripts: { dev: 'node server.cjs' } })),
    writeFile(join(externalDir, 'server.cjs'), await readFile(join(folder, 'fixture.cjs'))),
    writeFile(join(backgroundDir, 'package.json'), JSON.stringify({ name: 'background-job', scripts: { start: 'node worker.cjs' } })),
    writeFile(join(backgroundDir, 'worker.cjs'), 'setInterval(() => {}, 1000)'),
  ])
  external = spawn(process.execPath, ['server.cjs'], {
    cwd: externalDir, env: { ...process.env, PORT: String(externalPort) }, windowsHide: true, stdio: 'ignore',
  })
  background = spawn(process.execPath, ['worker.cjs'], { cwd: backgroundDir, windowsHide: true, stdio: 'ignore' })
  const owner = await eventually(async () => (await owners(externalPort)).find((row) => row.pid === external.pid))
  const discovered = await eventually(async () => (await call('discoverProjects')).find((item) => item.path === externalDir))
  assert.deepEqual(discovered, {
    name: 'discovered-app', path: externalDir, command: 'pnpm run dev', ports: [externalPort],
    pids: [external.pid], processes: [{ pid: external.pid, started: owner.started }],
  })
  const withoutPort = await eventually(async () => (await call('discoverProjects')).find((item) => item.path === backgroundDir))
  assert.equal(withoutPort.name, 'background-job')
  assert.equal(withoutPort.command, 'npm start')
  assert.deepEqual(withoutPort.ports, [])
  assert.deepEqual(withoutPort.pids, [background.pid])
  assert.match(withoutPort.processes[0].started, /^\d+$/)
  const registered = await call('saveProject', {
    project: { groupId: 'default', name: discovered.name, path: discovered.path, command: discovered.command, port: externalPort, shell: 'powershell' },
  })
  assert.ok(!(await call('discoverProjects')).some((item) => item.path === externalDir))
  assert.equal((await owners(externalPort))[0].pid, external.pid)
  assert.deepEqual(await call('stopDiscoveredProject', { path: externalDir, processes: discovered.processes }), {
    stopped: [], changed: [external.pid], failed: [],
  })
  await call('deleteProject', { id: registered.id })
  assert.ok((await call('discoverProjects')).some((item) => item.path === externalDir))
  const externalConflict = await create('外部端口冲突', 'npm run dev', externalPort, 'powershell', undefined, 'default')
  await assert.rejects(call('start', { id: externalConflict.id }), /PID/)
  assert.equal((await owners(externalPort))[0].pid, external.pid)
  await assert.rejects(call('stopPort', { port: externalPort, pid: owner.pid, started: '1' }), /已变化/)
  assert.deepEqual(await call('stopDiscoveredProject', {
    path: backgroundDir, processes: [{ pid: background.pid, started: '1' }],
  }), { stopped: [], changed: [background.pid], failed: [] })
  assert.deepEqual(await call('stopDiscoveredProject', {
    path: backgroundDir, processes: discovered.processes,
  }), { stopped: [], changed: [external.pid], failed: [] })
  const backgroundExit = once(background, 'exit')
  assert.deepEqual(await call('stopDiscoveredProject', { path: backgroundDir, processes: withoutPort.processes }), {
    stopped: [background.pid], changed: [], failed: [],
  })
  await backgroundExit
  assert.equal((await owners(externalPort))[0].pid, external.pid)
  const externalExit = once(external, 'exit')
  assert.deepEqual(await call('stopDiscoveredProject', { path: externalDir, processes: discovered.processes }), {
    stopped: [external.pid], changed: [], failed: [],
  })
  await externalExit
  await eventually(async () => !(await owners(externalPort)).length)
  assert.ok(!(await call('discoverProjects')).some((item) => item.path === externalDir))
  external = spawn(process.execPath, ['server.cjs'], {
    cwd: externalDir, env: { ...process.env, PORT: String(externalPort) }, windowsHide: true, stdio: 'ignore',
  })
  const nextOwner = await eventually(async () => (await owners(externalPort)).find((row) => row.pid === external.pid))
  assert.deepEqual(await call('stopDiscoveredProject', { path: externalDir, processes: discovered.processes }), {
    stopped: [], changed: [owner.pid], failed: [],
  })
  const portExit = once(external, 'exit')
  await call('stopPort', { port: externalPort, pid: nextOwner.pid, started: nextOwner.started })
  await portExit
  await eventually(async () => !(await owners(externalPort)).length)
  await call('start', { id: pnpm.id })
  await eventually(async () => (await owners(port2)).find((owner) => owner.projectId === pnpm.id))
  socket.destroy()
  const crashed = once(worker, 'exit')
  worker.kill()
  await crashed
  workerStart()
  await connect()
  await eventually(async () => !(await owners(port2)).length)
  const recovered = (await call('history')).find((run) => run.projectId === pnpm.id)
  assert.equal(recovered.status, 'error')
  assert.match(recovered.error, /意外退出/)
  const vitePath = join(folder, 'Vite 端口项目')
  const bin = join(vitePath, 'node_modules', '.bin')
  const viteCli = process.env.TSMANAGER_TEST_VITE || resolve('node_modules/vite/bin/vite.js')
  const hardcodedPort = await freePort()
  const manifest = JSON.stringify({ name: 'vite-port-fixture', scripts: { dev: 'vite dev --host 127.0.0.1 --port ' + hardcodedPort } })
  await mkdir(bin, { recursive: true })
  await Promise.all([
    writeFile(join(bin, 'vite.cmd'), '@echo off\r\nnode "' + viteCli + '" %*\r\n'),
    writeFile(join(vitePath, 'package.json'), manifest),
    writeFile(join(vitePath, 'index.html'), '<!doctype html><script type="module" src="/fixture.ts"></script>'),
    writeFile(join(vitePath, 'fixture.ts'), 'export const text: string = "VITE_TS_FIXTURE";'),
  ])
  for (const [command, shell] of [['pnpm run dev', 'powershell'], ['npm run dev', 'cmd']]) {
    const vitePort = await freePort()
    const vite = await call('saveProject', {
      project: { name: 'Vite ' + command, path: vitePath, command, port: vitePort, groupId: 'default', shell },
    })
    await call('start', { id: vite.id })
    await eventually(async () => (await owners(vitePort)).find((row) => row.projectId === vite.id))
    assert.ok(!(await owners(hardcodedPort)).some((row) => row.projectId === vite.id))
    const transformed = await fetch('http://127.0.0.1:' + vitePort + '/fixture.ts').then((response) => response.text())
    assert.match(transformed, /VITE_TS_FIXTURE/)
    assert.doesNotMatch(transformed, /text: string/)
    assert.match(await output(vite.id), new RegExp('已向 Vite 传入配置端口 ' + vitePort))
    await call('stop', { id: vite.id })
    await eventually(async () => !(await owners(vitePort)).length)
  }
  assert.equal(await readFile(join(vitePath, 'package.json'), 'utf8'), manifest)
  await call('settings', { ...(await call('snapshot')).settings, logLimit: 32 })
  await writeFile(join(folder, 'bulk.cjs'), "for (let i = 0; i < 800; i++) console.log('0123456789'.repeat(12)); console.log('BURST_DONE')")
  const bulk = await create('大输出项目', 'node bulk.cjs', null, 'cmd', undefined, 'default')
  await call('start', { id: bulk.id })
  await eventually(async () => await state(bulk.id) === 'stopped')
  const bulkLog = (await call('logs', { id: bulk.id })).map((line) => line.text).join('')
  assert.match(bulkLog, /BURST_DONE/)
  assert.ok(Buffer.byteLength(bulkLog) <= 32 * 1024)
  assert.ok(Buffer.byteLength(await output(bulk.id)) <= 32 * 1024)
  console.log('PASS: SQLite, DPAPI, real PTYs, npm/pnpm/Python, configured ports override Vite scripts, input, Ctrl+C, ports, external process termination, restart, keep-running and crash recovery')
} finally {
  if (background && background.exitCode === null && !background.signalCode) {
    const closed = once(background, 'exit')
    background.kill()
    await closed
  }
  if (external && external.exitCode === null && !external.signalCode) external.kill()
  if (socket && !socket.destroyed) {
    await call('stopAll').catch(() => {})
    socket.destroy()
  }
  if (worker && worker.exitCode === null) await eventually(() => worker.exitCode !== null, 12000).catch(() => worker.kill())
  await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 })
}

function createError() {
  return call('saveProject', {
    project: { groupId: 'default', name: '异常退出', path: folder, command: 'exit 27', port: null, shell: 'cmd' },
  })
}
