import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Socket } from 'node:net'

export function pipeName(folder: string) {
  return '\\\\.\\pipe\\tsmanager-' + createHash('sha256').update(folder.toLowerCase()).digest('hex').slice(0, 32)
}

export const nonce = () => randomBytes(32).toString('hex')
export const isNonce = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export function proof(key: string, role: 'client' | 'worker', server: string, client: string) {
  return createHmac('sha256', key).update(role).update(server).update(client).digest('hex')
}
export function matches(expected: string, supplied: unknown) {
  return isNonce(supplied) && timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(supplied, 'hex'))
}

export function send(socket: Socket, value: unknown) {
  if (socket.destroyed) return
  if (socket.writableLength > 8 * 1024 * 1024) { socket.destroy(); return }
  socket.write(JSON.stringify(value) + '\n')
}

export function receive(socket: Socket, handler: (message: any) => void) {
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', (data: string) => {
    buffer += data
    if (buffer.length > 16 * 1024 * 1024) { socket.destroy(); return }
    let index: number
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      try { handler(JSON.parse(line)) }
      catch { socket.destroy(); return }
    }
  })
}
