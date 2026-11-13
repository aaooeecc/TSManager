import { spawn } from 'node:child_process'
import electron from 'electron'
import { createServer } from 'vite'

const vite = await createServer()
await vite.listen()
const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, TSMANAGER_DEV_URL: 'http://127.0.0.1:5178' },
})
child.on('exit', async (code) => {
  await vite.close()
  process.exitCode = code ?? 1
})
