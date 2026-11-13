import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('TSManager 网页工作区需要 Windows x64')
const root = fileURLToPath(new URL('../', import.meta.url))
const folder = resolve(process.env.TSMANAGER_DATA_DIR || join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'TSManager'))
const port = Number(process.env.TSMANAGER_WEB_PORT || '5178')
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('网页端口无效')
const keyFile = join(folder, 'web-' + port + '.key')
const origin = 'http://127.0.0.1:' + port
const page = origin + '/preview.html'

function openBrowser(key) {
  if (process.argv.includes('--no-open')) return
  const explorer = join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe')
  const browser = spawn(explorer, [page + '#session=' + key], { detached: true, stdio: 'ignore', windowsHide: true })
  browser.on('error', () => console.error('无法打开默认浏览器'))
  browser.unref()
}

async function existingSession() {
  try {
    const key = readFileSync(keyFile, 'utf8')
    if (!/^[a-f0-9]{64}$/.test(key)) return
    const response = await fetch(origin + '/_tsmanager/events', {
      method: 'POST', headers: { Origin: origin, Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(1500),
    })
    await response.body?.cancel()
    if (response.ok && response.headers.get('Content-Type')?.startsWith('application/x-ndjson')) return key
  } catch {}
}

async function main() {
  const existing = await existingSession()
  if (existing) {
    console.log('TSManager 本机网页正在运行 ' + page)
    openBrowser(existing)
    return
  }
  if (process.argv.includes('--build')) {
    const npm = process.env.npm_execpath
    if (!npm) throw new Error('请使用 npm run preview:web 启动')
    const build = spawn(process.execPath, [npm, 'run', 'build:web'], { cwd: root, stdio: 'inherit' })
    const [code] = await once(build, 'exit')
    if (code !== 0) { process.exitCode = code ?? 1; return }
  }

  const { default: gateway } = await import('../build/web.cjs')
  const key = randomBytes(32).toString('hex')
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  // Keep the running site's asset names and files together while Vite rebuilds.
  const assets = mkdtempSync(join(tmpdir(), 'TSManager web-'))
  process.once('exit', () => rmSync(assets, { recursive: true, force: true }))
  cpSync(join(root, 'web-dist'), assets, { recursive: true })
  const web = gateway.createWebServer({
    folder, electron, port, key,
    worker: join(root, 'build', 'worker.cjs'),
    web: assets,
    icon: join(root, 'assets', 'icon.ico'),
  })
  await new Promise((resolve, reject) => {
    web.server.once('error', reject)
    web.server.listen(port, '127.0.0.1', resolve)
  })
  try { writeFileSync(keyFile, key, { mode: 0o600 }) }
  catch (error) { await web.close(); throw error }
  console.log('TSManager 本机网页已启动 ' + page)
  openBrowser(key)

  let closing = false
  async function close() {
    if (closing) return
    closing = true
    try {
      if (readFileSync(keyFile, 'utf8') === key) rmSync(keyFile)
    } catch {}
    await web.close()
  }
  process.on('SIGINT', () => void close())
  process.on('SIGTERM', () => void close())
}

await main()
