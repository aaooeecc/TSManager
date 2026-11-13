import { createReadStream, readdirSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join } from 'node:path'
import { defaults, workerMethods, type DiscoveredProject, type Language, type Notice, type Port, type WorkerMethod } from '../shared/api'
import { localizeMessage } from '../shared/messages'
import { Client } from './client'
import { matches } from './transport'

type Options = {
  folder: string; worker: string; electron: string; web: string; icon: string; port: number; key: string
  language?: () => Language
}
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readCall(req: IncomingMessage) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const data of req) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data)
    size += chunk.length
    if (size > 6 * 1024 * 1024) throw new Error('请求过大')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as { method?: WorkerMethod; input?: unknown } | null
}

export function createWebServer(options: Options) {
  const page = join(options.web, 'preview.html')
  const files = new Map([['/', page], ['/preview.html', page], ['/favicon.ico', options.icon]])
  for (const name of readdirSync(join(options.web, 'assets'))) files.set('/assets/' + name, join(options.web, 'assets', name))
  const streams = new Set<ServerResponse>()
  let client: Client | undefined
  let online = false
  let calls = 0
  let closing = false

  function fail(res: ServerResponse, status: number, message: string) {
    const language = client?.language ?? options.language?.() ?? defaults.language
    json(res, status, { error: localizeMessage(language, message) })
  }

  function localHost() {
    const address = server.address()
    return '127.0.0.1:' + (address && typeof address === 'object' ? address.port : options.port)
  }

  function publish(notice: Notice) {
    if (notice.type === 'connection') online = notice.online
    const line = JSON.stringify(notice) + '\n'
    for (const stream of streams) {
      if (stream.writableLength > 2 * 1024 * 1024) stream.destroy()
      else stream.write(line)
    }
  }
  function release() {
    if (!closing && (streams.size || calls)) return
    client?.close()
    client = undefined
    online = false
  }
  function events(res: ServerResponse) {
    streams.add(res)
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' })
    res.write(JSON.stringify({ type: 'connection', online }) + '\n')
    res.once('close', () => { streams.delete(res); release() })
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'")
    const host = localHost()
    if (req.headers.host !== host || req.socket.remoteAddress !== '127.0.0.1') {
      fail(res, 403, '仅接受本机地址的请求')
      return
    }
    if (closing) { fail(res, 503, '网页服务正在关闭'); return }
    const path = req.url?.split('?', 1)[0]
    if (path === '/_tsmanager/call' || path === '/_tsmanager/events') {
      if (req.method !== 'POST' || req.headers.origin !== 'http://' + host) {
        fail(res, 403, '请求来源无效')
        return
      }
      const authorization = req.headers.authorization
      if (!authorization?.startsWith('Bearer ') || !matches(options.key, authorization.slice(7))) {
        fail(res, 401, '网页会话已失效')
        return
      }
      if (path === '/_tsmanager/events') { events(res); return }

      let request
      try { request = await readCall(req) }
      catch { fail(res, 400, '请求格式无效'); return }
      const method = request?.method
      if (!method || !workerMethods.includes(method)) {
        fail(res, 400, '未知的后台操作')
        return
      }
      calls++
      try {
        if (method === 'stopPort' && (request?.input as { pid?: unknown } | null)?.pid === process.pid) {
          throw new Error('该进程正在提供 TSManager 网页服务')
        }
        if (!client) {
          const connected = new Client(options.folder, options.worker, (notice) => {
            if (client === connected) publish(notice)
          }, options.electron)
          client = connected
        }
        let result = await client.call(method, request?.input as never)
        if (method === 'ports' || method === 'checkPort') {
          result = (result as Port[]).map((port) => port.pid === process.pid ? { ...port, terminable: false } : port)
        }
        if (method === 'discoverProjects') {
          result = (result as DiscoveredProject[]).filter((project) => !project.pids.includes(process.pid))
        }
        json(res, 200, { result })
      } catch (error) {
        fail(res, 422, error instanceof Error ? error.message : String(error))
      } finally {
        calls--
        release()
      }
      return
    }

    const file = path && files.get(path)
    if (!file || (req.method !== 'GET' && req.method !== 'HEAD')) {
      fail(res, 404, '页面不存在')
      return
    }
    const type = mime[extname(file)] ?? 'application/octet-stream'
    res.setHeader('Content-Type', type)
    res.setHeader('Cache-Control', file === page ? 'no-store' : 'public, max-age=3600')
    if (req.method === 'HEAD') { res.end(); return }
    const stream = createReadStream(file)
    stream.on('error', () => {
      if (res.headersSent) res.destroy()
      else fail(res, 404, '页面资源不存在')
    })
    res.once('close', () => stream.destroy())
    stream.pipe(res)
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (res.headersSent || res.destroyed) res.destroy()
      else fail(res, 500, '网页服务请求失败')
    })
  })

  return {
    server,
    get origin() { return 'http://' + localHost() },
    close: () => {
      closing = true
      for (const stream of streams) stream.end()
      release()
      return new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    },
  }
}
