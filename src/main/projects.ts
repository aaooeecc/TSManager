import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { stripVTControlCharacters } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { spawn, type IPty } from 'node-pty'
import type { Log, Notice, Output, Port, Project, Runtime } from '../shared/api'
import { Store } from './db'
import { directory } from './validation'
import { vitePortCommand } from './vite-port'
import { Job, listPorts, stopExternalPort } from './windows'

type Live = {
  project: Project; runId: string; startedAt: string; pty?: IPty; job?: Job; folder?: string
  ended: Promise<void>; resolve: () => void; stopping: boolean; interruptedAt: number
  pending: string; flushTimer?: ReturnType<typeof setTimeout>; secrets: string[]
  stoppingPids?: Set<number>; cleanupError?: string
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const sensitive = /key|token|secret|password|credential|passphrase|cookie|auth/i

function bounded(text: string, bytes: number) {
  if (Buffer.byteLength(text) <= bytes) return text
  return Buffer.from(text).subarray(-bytes).toString('utf8')
}

function waitFor(promise: Promise<void>, ms: number) {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    promise.then(() => { clearTimeout(timer); resolve(true) })
  })
}

function conflict(owner: Port) {
  return '端口 ' + owner.port + ' 已被 ' + (owner.name || '其他进程') + ' 占用（PID ' + owner.pid + '）'
}

function probe(port: number) {
  return new Promise<void>((resolve, reject) => {
    const server = createServer()
    let host = '::'
    function onError(error: NodeJS.ErrnoException) {
      if (host === '::' && (error.code === 'EAFNOSUPPORT' || error.code === 'EADDRNOTAVAIL')) {
        host = '0.0.0.0'
        listen()
        return
      }
      try {
        const owner = listPorts(port)[0]
        reject(new Error(owner ? conflict(owner) : '端口 ' + port + ' 无法监听（' + (error.code ?? '未知错误') + '）'))
      } catch (cause) { reject(cause) }
    }
    function listen() {
      server.listen({ port, host, exclusive: true }, () => {
        server.removeListener('error', onError)
        server.close(() => resolve())
      })
    }
    server.on('error', onError)
    listen()
  })
}

function shellCommand(project: Project, command: string, folder: string): { shell: string; args: string[] | string } {
  const root = process.env.SystemRoot || 'C:\\Windows'
  if (project.shell === 'powershell') {
    const file = join(folder, 'command.txt')
    writeFileSync(file, command, 'utf8')
    const script = `
      $ErrorActionPreference = 'Stop'
      try {
        $path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__FILE__'))
        $ready = [IO.Path]::Combine([IO.Path]::GetDirectoryName($path), 'ready')
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        while (![IO.File]::Exists($ready)) {
          if ([DateTime]::UtcNow -ge $deadline) { exit 1 }
          Start-Sleep -Milliseconds 30
        }
        $source = [IO.File]::ReadAllText($path)
        & ([ScriptBlock]::Create($source))
        $success = $?
        if (!$success) { if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1 }
        if ($LASTEXITCODE) { exit $LASTEXITCODE }
        exit 0
      } catch {
        Write-Host $_ -ForegroundColor Red
        exit 1
      }
    `.replace('__FILE__', Buffer.from(file, 'utf8').toString('base64'))
    return {
      shell: join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    }
  }
  const bootstrap = join(folder, 'run.cmd')
  writeFileSync(bootstrap, [
    '@echo off',
    'for /l %%i in (1,1,30000) do if exist "%~dp0ready" goto run',
    'exit /b 1',
    ':run',
    'chcp 65001>nul',
    '"%~dp0command.cmd"',
    '',
  ].join('\r\n'))
  writeFileSync(join(folder, 'command.cmd'), '@echo off\r\n' + command.replace(/\r?\n/g, '\r\n') + '\r\n')
  return { shell: join(root, 'System32', 'cmd.exe'), args: '/d /q /s /c ""' + bootstrap + '""' }
}

export class Projects {
  readonly runtime = new Map<string, Runtime>()
  private active = new Map<string, Live>()
  private operations = new Map<string, Promise<void>>()
  private output = new Map<string, Output>()
  private stoppingAll?: Promise<void>

  constructor(private store: Store, private folder: string, private emit: (notice: Notice) => void) {}

  get busy() { return this.active.size > 0 || this.operations.size > 0 }
  isActive(id: string) { return this.active.has(id) || this.operations.has(id) }

  private status(id: string, runtime: Runtime) {
    this.runtime.set(id, runtime)
    this.emit({ type: 'status', id, runtime })
  }

  forget(id: string) {
    this.runtime.delete(id)
    this.output.delete(id)
  }

  terminal(id: string) { return this.output.get(id) ?? { id, seq: 0, data: '' } }

  clear(id: string) {
    const output = { id, seq: this.terminal(id).seq + 1, data: '', reset: true }
    this.output.set(id, output)
    this.emit({ type: 'output', output })
  }

  private publish(id: string, data: string) {
    const previous = this.terminal(id)
    const seq = previous.seq + 1
    this.output.set(id, { id, seq, data: bounded(previous.data + data, this.store.settings.logLimit * 1024) })
    this.emit({ type: 'output', output: { id, seq, data } })
  }

  private log(run: Live, type: Log['type'], text: string) {
    this.store.appendLog(run.project.id, run.runId, type, text)
  }

  private flush(run: Live, ending = false) {
    clearTimeout(run.flushTimer)
    run.flushTimer = undefined
    let text = run.pending
    for (const secret of run.secrets) text = text.replaceAll(secret, '••••••')
    // Keep a partial match at the end for the next chunk.
    let hold = ''
    if (!ending) {
      for (const secret of run.secrets) {
        for (let size = Math.min(secret.length - 1, text.length); size > hold.length; size--) {
          if (text.endsWith(secret.slice(0, size))) { hold = text.slice(-size); break }
        }
      }
    }
    run.pending = hold
    if (hold) text = text.slice(0, -hold.length)
    const plain = stripVTControlCharacters(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    this.log(run, 'terminal', plain)
  }

  private data(run: Live, data: string) {
    this.publish(run.project.id, data)
    run.pending = bounded(run.pending + data, this.store.settings.logLimit * 1024)
    if (!run.flushTimer) run.flushTimer = setTimeout(() => this.flush(run), 100)
  }

  clearLogs(id: string) {
    const run = this.active.get(id)
    if (run) { clearTimeout(run.flushTimer); run.flushTimer = undefined; run.pending = '' }
    this.store.clearLogs(id)
  }

  private operation(id: string, action: () => Promise<void>) {
    const next = (this.operations.get(id) ?? Promise.resolve()).catch(() => {}).then(action)
    this.operations.set(id, next)
    return next.finally(() => { if (this.operations.get(id) === next) this.operations.delete(id) })
  }

  start(id: string, cols = 100, rows = 24) {
    if (this.stoppingAll) throw new Error('正在停止所有项目')
    return this.operation(id, () => this.launch(id, cols, rows))
  }

  restart(id: string, cols = 100, rows = 24) {
    if (this.stoppingAll) throw new Error('正在停止所有项目')
    return this.operation(id, async () => { await this.stopRun(id); await this.launch(id, cols, rows) })
  }

  stop(id: string) { return this.operation(id, () => this.stopRun(id)) }

  stopAll() {
    if (!this.stoppingAll) {
      this.stoppingAll = Promise.allSettled([...new Set([...this.active.keys(), ...this.operations.keys()])].map((id) => this.stop(id)))
        .then((results) => {
          const failures = results.flatMap((result) => result.status === 'rejected' ? [message(result.reason)] : [])
          if (failures.length) throw new Error(failures.join('\n'))
        }).finally(() => { this.stoppingAll = undefined })
    }
    return this.stoppingAll
  }

  private async launch(id: string, cols: number, rows: number) {
    if (this.active.has(id)) throw new Error('项目已经在运行')
    const project = this.store.project(id)
    let resolve!: () => void
    const ended = new Promise<void>((done) => { resolve = done })
    const run: Live = {
      project, runId: randomUUID(), startedAt: new Date().toISOString(), ended, resolve,
      stopping: false, interruptedAt: 0, pending: '', secrets: [],
    }
    this.store.beginRun(project, run.runId, run.startedAt)
    this.active.set(id, run)
    this.clear(id)
    this.status(id, { status: 'starting', runId: run.runId, startedAt: run.startedAt })
    try {
      directory(project.path)
      if (project.port) {
        const owner = listPorts(project.port)[0]
        if (owner) throw new Error(conflict(owner))
        const reserved = [...this.active.values()].find((other) => other !== run && other.project.port === project.port)
        if (reserved) throw new Error('端口 ' + project.port + ' 已由项目 ' + reserved.project.name + ' 预留')
        await probe(project.port)
      }
      const custom = this.store.env(id)
      run.secrets = Object.entries(custom).filter(([key, value]) => sensitive.test(key) && value.length > 0)
        .map(([, value]) => value).sort((a, b) => b.length - a.length)
      const env = new Map(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/^electron_run_as_node$/i.test(key))
        .map(([key, value]) => [key.toUpperCase(), value!]))
      for (const [key, value] of Object.entries(custom)) env.set(key.toUpperCase(), value)
      if (project.port) env.set('PORT', String(project.port))
      env.set('TERM', 'xterm-256color')
      run.job = new Job()
      run.folder = join(this.folder, run.runId)
      mkdirSync(run.folder, { recursive: true })
      const command = vitePortCommand(project)
      const { shell, args } = shellCommand(project, command, run.folder)
      // The shell waits for the start file until its Job association has succeeded.
      const pty = spawn(shell, args, { cwd: project.path, env: Object.fromEntries(env), name: 'xterm-256color', cols, rows })
      run.pty = pty
      const output = pty.onData((data) => { if (this.active.get(id) === run) this.data(run, data) })
      const exit = pty.onExit(({ exitCode }) => {
        output.dispose()
        exit.dispose()
        void this.finish(run, exitCode).catch((error) => console.error(message(error)))
      })
      run.job.add(pty.pid)
      this.store.runPid(run.runId, pty.pid)
      this.log(run, 'system', '已启动 · PID ' + pty.pid + '\n')
      if (command !== project.command) {
        const note = '已向 Vite 传入配置端口 ' + project.port + '。'
        this.log(run, 'system', note + '\n')
        this.publish(id, '\x1b[90m' + note + '\x1b[0m\r\n')
      }
      writeFileSync(join(run.folder, 'ready'), '')
      setTimeout(() => {
        if (this.active.get(id) === run && this.runtime.get(id)?.status === 'starting') {
          this.status(id, { status: 'running', pid: pty.pid, runId: run.runId, startedAt: run.startedAt })
        }
      }, 450).unref()
    } catch (error) {
      const reason = message(error)
      // An unassigned shell is still waiting on the start gate.
      try { run.pty?.kill() } catch {}
      await this.finish(run, null, reason)
      throw new Error(reason)
    }
  }

  private async finish(run: Live, code: number | null, launchError?: string) {
    const { id } = run.project
    if (this.active.get(id) !== run || run.interruptedAt === -1) return
    const interrupted = Date.now() - run.interruptedAt < 3000 || code === 3221225786 || code === -1073741510
    run.interruptedAt = -1
    let error = launchError ?? (!run.stopping && !interrupted && code !== 0 ? '进程退出，退出码 ' + code : undefined)
    try {
      const { port } = run.project
      const pids = new Set([...run.stoppingPids ?? [], ...run.job?.pids() ?? []])
      await run.job?.drain()
      if (port && pids.size) {
        // Windows can retain a listener briefly after its process has exited.
        const stillListening = () => listPorts(port).some((owner) => pids.has(owner.pid))
        for (let attempt = 0; attempt < 30 && stillListening(); attempt++) await delay(50)
        if (stillListening()) throw new Error('项目进程已退出，但端口 ' + port + ' 尚未释放')
      }
    } catch (cause) {
      run.cleanupError = message(cause)
      error = run.cleanupError
    }
    finally {
      run.job?.close()
      this.active.delete(id)
      if (run.folder) {
        try { rmSync(run.folder, { recursive: true, force: true }) } catch {}
      }
    }
    try {
      this.flush(run, true)
      const status = error ? 'error' : 'stopped'
      this.store.finishRun(run.runId, status, code, error)
      const line = error ?? '进程已退出' + (code === null ? '' : ' · 退出码 ' + code)
      this.log(run, error ? 'error' : 'system', line + '\n')
      this.publish(id, '\r\n\x1b[' + (error ? '31' : '90') + 'm' + line + '\x1b[0m\r\n')
      this.status(id, { status, error, runId: run.runId })
      this.emit({ type: 'changed' })
    } finally { run.resolve() }
  }

  private async stopRun(id: string) {
    const run = this.active.get(id)
    if (!run) return
    run.stoppingPids = new Set(run.job?.pids())
    run.stopping = true
    this.status(id, { status: 'stopping', pid: run.pty?.pid, runId: run.runId, startedAt: run.startedAt })
    try { run.pty?.write('\x03') } catch {}
    if (!await waitFor(run.ended, this.store.settings.stopTimeout)) {
      run.job?.terminate()
      if (!await waitFor(run.ended, 10000)) throw new Error('等待终端退出超时')
    }
    if (run.cleanupError) throw new Error(run.cleanupError)
  }

  write(id: string, data: string) {
    const run = this.active.get(id)
    if (!run?.pty || run.stopping) return
    if (data.includes('\x03')) run.interruptedAt = Date.now()
    run.pty.write(data)
  }

  resize(id: string, cols: number, rows: number) {
    const run = this.active.get(id)
    if (run?.pty && !run.stopping && (run.pty.cols !== cols || run.pty.rows !== rows)) run.pty.resize(cols, rows)
  }

  ownedPids() {
    const owned = new Map<number, string>()
    for (const [id, run] of this.active) {
      for (const pid of run.job?.pids() ?? []) owned.set(pid, id)
    }
    return owned
  }

  ports(port?: number) {
    const owned = this.ownedPids()
    return listPorts(port).map((row) => ({ ...row, projectId: owned.get(row.pid), terminable: row.terminable && !owned.has(row.pid) }))
  }

  stopPort(port: number, pid: number, started: string) {
    const owner = this.ports(port).find((row) => row.pid === pid && row.started === started)
    if (!owner || !owner.terminable || pid === process.pid) throw new Error('端口进程已变化或属于 TSManager 管理')
    stopExternalPort(port, pid, started)
  }
}
