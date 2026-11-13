import type { Bridge, Calls, Method, Notice } from '../shared/api'
import { cachedLanguage, translation, type Translate } from './locale'
import './preview.css'

document.documentElement.lang = cachedLanguage()
const t: Translate = (...text) => translation(document.documentElement.lang === 'en' ? 'en' : 'zh-CN')(...text)
document.title = t('TSManager · 本机工作区', 'TSManager · Local workspace')

const storage = 'tsmanager.web-session'
const supplied = new URLSearchParams(location.hash.slice(1)).get('session')
if (supplied) history.replaceState(null, '', location.pathname + location.search)
const key = supplied ?? localStorage.getItem(storage) ?? ''
const listeners = new Set<(notice: Notice) => void>()
let streamConnected = false
let keyboard = Promise.resolve()

function showMessage(message: string) {
  const panel = document.createElement('main')
  panel.className = 'web-connection'
  const title = document.createElement('h1')
  title.textContent = 'TSManager'
  const text = document.createElement('p')
  text.textContent = message
  panel.append(title, text)
  document.getElementById('root')?.replaceChildren(panel)
}

function emit(notice: Notice) { listeners.forEach((listener) => listener(notice)) }

function connectEvents() {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  return fetch('/_tsmanager/events', {
    method: 'POST', headers: { Authorization: 'Bearer ' + key }, signal: controller.signal,
  }).finally(() => clearTimeout(timeout))
}

async function consume(response: Response) {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
  let pending = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return
      const lines = (pending + chunk.value).split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) if (line) emit(JSON.parse(line) as Notice)
    }
  } finally { await reader.cancel().catch(() => {}) }
}

async function follow(response: Response) {
  for (;;) {
    try { await consume(response) } catch {}
    streamConnected = false
    emit({ type: 'connection', online: false })
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1200))
      const next = await connectEvents().catch(() => undefined)
      if (next?.status === 401) {
        location.reload()
        return
      }
      if (next?.ok && next.body) {
        response = next
        streamConnected = true
        emit({ type: 'connection', online: true })
        break
      }
    }
  }
}

async function remote<M extends Method>(method: M, input: Calls[M][0]): Promise<Calls[M][1]> {
  if (!streamConnected) throw new Error(t('本机后台正在重新连接', 'Reconnecting to the local service'))
  const response = await fetch('/_tsmanager/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ method, input }),
  })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error ?? t('本机后台请求失败', 'The local service request failed'))
  return body.result
}

const bridge: Bridge = {
  async call<M extends Method>(method: M, input: Calls[M][0]): Promise<Calls[M][1]> {
    switch (method) {
      case 'chooseDirectory':
        throw new Error(t('请在项目目录栏填写本机文件夹的完整路径', 'Enter the full path of a local folder in the project directory field'))
      case 'openFolder':
        throw new Error(t('请在文件管理器中打开项目目录', 'Open the project folder in File Explorer'))
      case 'openPort': {
        const { port } = input as Calls['openPort'][0]
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(t('端口无效', 'Invalid port'))
        window.open('http://localhost:' + port, '_blank', 'noopener,noreferrer')
        return undefined as Calls[M][1]
      }
      case 'fullscreen': {
        const { value } = input as Calls['fullscreen'][0]
        if (value && !document.fullscreenElement) await document.documentElement.requestFullscreen().catch(() => {})
        if (!value && document.fullscreenElement) await document.exitFullscreen().catch(() => {})
        return undefined as Calls[M][1]
      }
      case 'previewTheme':
        return undefined as Calls[M][1]
      case 'write':
      case 'interrupt': {
        const next = keyboard.then(() => remote(method, input))
        keyboard = next.then(() => {}, () => {})
        return next
      }
      default:
        return remote(method, input)
    }
  },
  onNotice(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}

async function launch() {
  if (!/^[a-f0-9]{64}$/.test(key)) {
    showMessage(t('运行 npm run preview:web 以打开已连接本机后台的网页。', 'Run npm run preview:web to open the workspace connected to your local service.'))
    return
  }
  showMessage(t('正在连接本机后台…', 'Connecting to the local service…'))
  const response = await connectEvents().catch(() => undefined)
  if (!response?.ok || !response.body) {
    if (response?.status === 401 && localStorage.getItem(storage) === key) localStorage.removeItem(storage)
    showMessage(t('网页会话无法连接。运行 npm run preview:web 重新打开。', 'Could not connect this web session. Run npm run preview:web to reopen it.'))
    return
  }
  localStorage.setItem(storage, key)
  streamConnected = true
  window.tsmanager = bridge
  void follow(response)
  await import('./main')
}

void launch()
