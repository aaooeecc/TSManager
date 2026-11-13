import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import electron from 'electron'
import gateway from '../build/web.cjs'

const folder = await mkdtemp(join(tmpdir(), 'TSManager legacy web '))
const workerKey = randomBytes(32).toString('hex')
const key = randomBytes(32).toString('hex')
await writeFile(join(folder, 'worker.key'), workerKey)
await writeFile(join(folder, 'package.json'), '{"name":"legacy-node-fixture","scripts":{"dev":"vite dev --port 3000"}}')
await writeFile(join(folder, 'timer.cjs'), 'setInterval(() => {}, 1000)')
const fixture = spawn(process.execPath, ['timer.cjs'], { cwd: folder, windowsHide: true, stdio: 'ignore' })
const exited = once(fixture, 'exit')

const pipe = '\\\\.\\pipe\\tsmanager-' + createHash('sha256').update(folder.toLowerCase()).digest('hex').slice(0, 32)
const sockets = new Set()
let advertised = true
const legacy = createServer((socket) => {
  sockets.add(socket)
  socket.once('close', () => sockets.delete(socket))
  socket.on('error', () => socket.destroy())
  const serverNonce = randomBytes(32).toString('hex')
  const send = (message) => socket.write(JSON.stringify(message) + '\n')
  send({ nonce: serverNonce })
  let pending = ''
  let authenticated = false
  socket.setEncoding('utf8').on('data', (chunk) => {
    const lines = (pending + chunk).split('\n')
    pending = lines.pop()
    for (const line of lines) {
      if (!line) continue
      const message = JSON.parse(line)
      if (!authenticated) {
        const proof = (role) => createHmac('sha256', workerKey).update(role).update(serverNonce).update(message.nonce).digest('hex')
        assert.equal(message.proof, proof('client'))
        authenticated = true
        send({ ready: true, proof: proof('worker'), methods: ['discoverProjects', 'snapshot', 'start'] })
        continue
      }
      if (message.method === 'snapshot') {
        send({ request: message.request, value: { projects: [{ id: 'vite-fixture', path: folder, command: 'pnpm run dev', port: 3010 }] } })
        continue
      }
      assert.equal(message.method, 'discoverProjects')
      send({
        request: message.request,
        value: advertised ? [{ name: 'legacy-node-fixture', path: folder, command: '', ports: [], pids: [fixture.pid] }] : [],
      })
    }
  })
})
const web = gateway.createWebServer({
  folder, port: 0, key, electron, worker: resolve('build/worker.cjs'), web: resolve('web-dist'), icon: resolve('assets/icon.ico'),
})
let stream
async function call(method, input) {
  const response = await fetch(web.origin + '/_tsmanager/call', {
    method: 'POST',
    headers: { Origin: web.origin, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, input }),
  })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error)
  return body.result
}

try {
  await new Promise((resolve, reject) => legacy.once('error', reject).listen(pipe, resolve))
  await new Promise((resolve, reject) => web.server.once('error', reject).listen(0, '127.0.0.1', resolve))
  stream = await fetch(web.origin + '/_tsmanager/events', {
    method: 'POST', headers: { Origin: web.origin, Authorization: 'Bearer ' + key },
  })
  assert.equal(stream.status, 200)
  await assert.rejects(call('start', { id: 'vite-fixture' }), /旧版后台/)
  const [project] = await call('discoverProjects', null)
  assert.equal(project.processes[0].pid, fixture.pid)
  assert.match(project.processes[0].started, /^\d+$/)

  advertised = false
  const selection = { path: folder, processes: project.processes }
  assert.deepEqual(await call('stopDiscoveredProject', selection), {
    stopped: [], changed: [fixture.pid], failed: [],
  })
  assert.equal(fixture.exitCode, null)

  advertised = true
  assert.deepEqual(await call('stopDiscoveredProject', selection), {
    stopped: [fixture.pid], changed: [], failed: [],
  })
  await exited
  console.log('PASS: legacy worker discovery exposes real identities and only terminates a still-reported external process')
} finally {
  await stream?.body?.cancel().catch(() => {})
  await web.close()
  for (const socket of sockets) socket.destroy()
  await new Promise((resolve) => legacy.close(resolve))
  if (fixture.exitCode === null && !fixture.signalCode) fixture.kill()
  await exited
  await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 })
}
