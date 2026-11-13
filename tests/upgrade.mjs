import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as wait } from 'node:timers/promises'
import electron from 'electron'
import gateway from '../build/web.cjs'

assert.ok(process.env.TSMANAGER_TEST_LEGACY_WORKER, 'Set TSMANAGER_TEST_LEGACY_WORKER to the 1.0.1 app.asar\\build\\worker.cjs')
const legacyWorker = resolve(process.env.TSMANAGER_TEST_LEGACY_WORKER)
const folder = await mkdtemp(join(tmpdir(), 'TSManager upgrade '))
const key = randomBytes(32).toString('hex')
const env = { UPGRADE_VALUE: randomBytes(16).toString('hex') }
const bin = join(folder, 'node_modules', '.bin')
let legacy, legacyExit, stream

const web = gateway.createWebServer({
  folder, port: 0, key, electron: process.env.TSMANAGER_TEST_EXE || electron,
  worker: resolve(process.env.TSMANAGER_TEST_WORKER || 'build/worker.cjs'),
  web: resolve('web-dist'), icon: resolve('assets/icon.ico'),
})

async function call(method, input = null) {
  const response = await fetch(web.origin + '/_tsmanager/call', {
    method: 'POST',
    headers: { Origin: web.origin, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, input }),
  })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error)
  return body.result
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function eventually(callback) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const result = await callback()
    if (result) return result
    await wait(100)
  }
  assert.fail('Timed out: ' + callback)
}

function schemaVersion() {
  const db = new DatabaseSync(join(folder, 'tsmanager.sqlite3'), { readOnly: true })
  try { return db.prepare('PRAGMA user_version').get().user_version }
  finally { db.close() }
}

try {
  const port = await freePort()
  const scriptPort = port === 3000 ? 3001 : 3000
  await mkdir(bin, { recursive: true })
  await Promise.all([
    writeFile(join(folder, 'worker.key'), randomBytes(32).toString('hex')),
    writeFile(join(folder, 'package.json'), JSON.stringify({ name: 'upgrade-fixture', scripts: { dev: 'vite dev --host 127.0.0.1 --port ' + scriptPort } })),
    writeFile(join(bin, 'vite.cmd'), '@echo off\r\nnode "' + resolve('node_modules/vite/bin/vite.js') + '" %*\r\n'),
    writeFile(join(folder, 'fixture.ts'), 'export const marker: string = "UPGRADE_VITE_READY";'),
    writeFile(join(folder, 'timer.cjs'), 'console.log("OLD_WORKER_LOG"); setInterval(() => {}, 1000)'),
  ])
  legacy = spawn(electron, [legacyWorker, folder], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'ignore', 'inherit'],
  })
  legacyExit = once(legacy, 'exit')
  await eventually(async () => {
    assert.equal(legacy.exitCode, null, 'The legacy worker exited before creating its database')
    try { return schemaVersion() === 0 } catch { return false }
  })
  await new Promise((resolve, reject) => web.server.once('error', reject).listen(0, '127.0.0.1', resolve))
  stream = await fetch(web.origin + '/_tsmanager/events', {
    method: 'POST', headers: { Origin: web.origin, Authorization: 'Bearer ' + key },
  })
  assert.ok(stream.ok)
  const group = await call('saveGroup', { name: '升级测试分组' })
  const project = { groupId: group.id, path: folder, shell: 'cmd' }
  const vite = await call('saveProject', { project: { ...project, name: '升级 Vite', command: 'pnpm run dev', port, env } })
  const other = await call('saveProject', { project: { ...project, name: '现有项目', command: 'node timer.cjs', port: null } })
  const settings = await call('settings', { ...(await call('snapshot')).settings, theme: 'light', stopTimeout: 500 })

  await call('start', { id: other.id })
  const active = await eventually(async () => {
    const run = (await call('snapshot')).runtime[other.id]
    return run?.status === 'running' && run
  })
  await eventually(async () => (await call('logs', { id: other.id })).some((log) => log.text.includes('OLD_WORKER_LOG')))
  await assert.rejects(call('start', { id: vite.id }), /旧版后台仍有项目在运行/)
  assert.equal(legacy.exitCode, null)
  assert.deepEqual((await call('snapshot')).runtime[other.id], active)
  await call('stop', { id: other.id })
  const oldRun = (await call('history')).find((run) => run.projectId === other.id)
  const oldLogs = await call('logs', { id: other.id })
  assert.ok(oldRun.stoppedAt)
  assert.equal(schemaVersion(), 0)

  await call('start', { id: vite.id })
  assert.deepEqual(await legacyExit, [1, null])
  await eventually(async () => (await call('checkPort', { port })).some((row) => row.projectId === vite.id))
  const module = await fetch('http://127.0.0.1:' + port + '/fixture.ts')
  assert.ok(module.ok)
  assert.match(await module.text(), /UPGRADE_VITE_READY/)
  assert.equal(schemaVersion(), 1)
  const updated = await call('snapshot')
  assert.deepEqual(updated.projects, [vite, other])
  assert.deepEqual(updated.groups.find((item) => item.id === group.id), group)
  assert.deepEqual(updated.settings, settings)
  assert.deepEqual(await call('projectEnv', { id: vite.id }), env)
  assert.deepEqual((await call('history')).find((run) => run.id === oldRun.id), oldRun)
  assert.deepEqual(await call('logs', { id: other.id }), oldLogs)
  console.log('PASS: 1.0.1 backend is replaced after its projects stop, the new start uses the configured Vite port, and SQLite records survive')
} finally {
  if (stream?.ok) await call('stopAll').catch(() => {})
  await stream?.body?.cancel().catch(() => {})
  await web.close()
  if (legacy && legacy.exitCode === null && !legacy.signalCode) legacy.kill()
  await legacyExit
  await rm(folder, { recursive: true, force: true, maxRetries: 30, retryDelay: 150 })
}
