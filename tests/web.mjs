import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import electron from 'electron'
import gateway from '../build/web.cjs'

const folder = await mkdtemp(join(tmpdir(), 'TSManager web test '))
const probe = createServer()
await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
const { port } = probe.address()
await new Promise((resolve) => probe.close(resolve))
const key = randomBytes(32).toString('hex')
const marker = randomBytes(8).toString('hex')
await writeFile(join(folder, 'fixture.cjs'), `
  const readline = require('node:readline')
  const input = readline.createInterface({ input: process.stdin })
  console.log('NODE_STARTED:' + process.env.FIXTURE_MARKER)
  input.on('line', (line) => console.log('NODE_READ:' + line))
  const interrupt = () => {
    console.log('NODE_INTERRUPTED:' + process.env.FIXTURE_MARKER)
    setTimeout(() => process.exit(0), 40)
  }
  input.on('SIGINT', interrupt)
  process.on('SIGINT', interrupt)
`)
const web = gateway.createWebServer({
  folder, port, electron, key,
  worker: resolve('build/worker.cjs'), web: resolve('web-dist'), icon: resolve('assets/icon.ico'),
})
const headers = { Origin: web.origin, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }
let controller, project
const events = []

async function call(method, input = null) {
  const response = await fetch(web.origin + '/_tsmanager/call', {
    method: 'POST', headers, body: JSON.stringify({ method, input }),
  })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error)
  return body.result
}

async function eventually(callback) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const value = await callback()
    if (value) return value
    await wait(100)
  }
  throw new Error('Timed out: ' + callback)
}

async function connectEvents() {
  controller = new AbortController()
  const response = await fetch(web.origin + '/_tsmanager/events', { method: 'POST', headers, signal: controller.signal })
  assert.ok(response.ok)
  const stream = response.body.pipeThrough(new TextDecoderStream())
  void (async () => {
    let pending = ''
    try {
      for await (const chunk of stream) {
        const lines = (pending + chunk).split('\n')
        pending = lines.pop()
        for (const line of lines) if (line) events.push(JSON.parse(line))
      }
    } catch (error) {
      if (error.name !== 'AbortError') throw error
    }
  })()
}

const output = () => events.filter((event) => event.output?.id === project.id).map((event) => event.output.data).join('')

try {
  await new Promise((resolve, reject) => web.server.once('error', reject).listen(port, '127.0.0.1', resolve))
  const page = await fetch(web.origin + '/preview.html')
  assert.equal(page.status, 200)
  assert.match(await page.text(), /本机工作区/)
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  const request = { method: 'POST', body: JSON.stringify({ method: 'snapshot', input: null }) }
  assert.equal((await fetch(web.origin + '/_tsmanager/call', { ...request, headers: { Origin: web.origin } })).status, 401)
  assert.equal((await fetch(web.origin + '/_tsmanager/call', { ...request, headers: { ...headers, Origin: 'https://other.example' } })).status, 403)
  await assert.rejects(call('arbitraryCommand'), /未知的后台操作/)
  await connectEvents()
  project = await call('saveProject', { project: {
    groupId: 'default', name: 'live-web-test', path: folder, command: 'node fixture.cjs',
    port: null, shell: 'powershell', env: { FIXTURE_MARKER: marker },
  } })
  await call('start', { id: project.id })
  await eventually(() => output().includes('NODE_STARTED:' + marker))
  await call('write', { id: project.id, data: 'browser-input-' + marker + '\r' })
  await eventually(() => output().includes('NODE_READ:browser-input-' + marker))
  controller.abort()
  await connectEvents()
  const replay = await call('terminal', { id: project.id })
  assert.match(replay.data, new RegExp('NODE_READ:browser-input-' + marker))
  await call('interrupt', { id: project.id })
  await eventually(() => output().includes('NODE_INTERRUPTED:' + marker))
  await eventually(async () => (await call('snapshot')).runtime[project.id].status === 'stopped')
  console.log('PASS: authenticated loopback API, real Node PTY output and input, reconnect replay and Ctrl+C')
} finally {
  if (project) await call('stop', { id: project.id }).catch(() => {})
  controller?.abort()
  await web.close()
  await wait(4500)
  await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 })
}
