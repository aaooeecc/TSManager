import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ITheme } from '@xterm/xterm'
import { ExternalLink, Folder, FolderOpen, Info, Maximize2, Minimize2, Play, Plus, RotateCw, Send, Square, Terminal as TerminalIcon, TerminalSquare, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { DiscoveredProject, Output, Project, Theme } from '../shared/api'
import { localizeMessage } from '../shared/messages'
import { useTranslation } from './i18n'
import { active, api, dateTime, duration, errorMessage, openProjectPort, projectListeningPorts, useDesk } from './store'
import { Button, IconButton, StatusBadge } from './ui'

const tabNames = [
  { id: 'terminal', label: ['终端', 'Terminal'], icon: Folder },
  { id: 'info', label: ['信息', 'Details'], icon: Info },
] as const
export type Tab = typeof tabNames[number]['id']
export type RunAction = (project: Project, action: 'start' | 'stop' | 'restart') => void
type Task = (action: () => Promise<unknown>, success?: string) => void

const terminalThemes: Record<Theme, ITheme> = {
  light: {
    background: '#fcfcfc', foreground: '#191919', cursor: '#191919', selectionBackground: '#e8e3f8',
  },
  dark: {
    background: '#080911', foreground: '#f4f2fb', cursor: '#b9aaff', selectionBackground: '#392d5b',
    brightBlack: '#aab2c2', green: '#43df72', cyan: '#38e3ef', red: '#ff7888',
  },
  classic: {
    background: '#f4f6fa', foreground: '#1d2636', cursor: '#1456f6', selectionBackground: '#cddcff',
  },
}

function TerminalView({ project, visible, fitRef, task }: {
  project: Project; visible: boolean; fitRef: React.MutableRefObject<(() => void) | undefined>; task: Task
}) {
  const settings = useDesk((state) => state.settings)
  const online = useDesk((state) => state.online)
  const element = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const state = useDesk((state) => state.runtime[project.id]?.status)
  const running = active(state)

  useEffect(() => {
    const host = element.current
    if (!host || !online) return
    let disposed = false
    const terminal = new Terminal({ allowProposedApi: false, scrollback: 3000, cursorBlink: true, convertEol: false })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)
    term.current = terminal
    let seq = -1
    let pending: Output[] | null = []
    function render(output: Output) {
      if (output.seq <= seq) return
      seq = output.seq
      if (output.reset) terminal.reset()
      if (output.data) terminal.write(output.data)
    }
    const unsubscribe = api().onNotice((notice) => {
      if (notice.type !== 'output' || notice.output.id !== project.id) return
      if (pending) pending.push(notice.output)
      else render(notice.output)
    })
    void api().call('terminal', { id: project.id }).then((output) => {
      if (disposed) return
      render(output)
      for (const chunk of pending ?? []) render(chunk)
      pending = null
    }).catch((error) => { if (!disposed) terminal.writeln(errorMessage(error)) })

    function resize() {
      if (disposed || !host?.clientHeight || !host.clientWidth) return
      fit.fit()
      const { cols, rows } = terminal
      if (cols >= 2 && cols <= 500 && rows >= 2 && rows <= 300) {
        void api().call('resize', { id: project.id, cols, rows }).catch(() => {})
      }
    }
    fitRef.current = resize
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    const input = terminal.onData((data) => {
      if (active(useDesk.getState().runtime[project.id]?.status)) {
        task(async () => {
          for (let offset = 0; offset < data.length; offset += 65536) {
            await api().call('write', { id: project.id, data: data.slice(offset, offset + 65536) })
          }
        })
      }
    })
    void document.fonts.ready.then(resize)
    return () => {
      disposed = true
      fitRef.current = undefined
      term.current = null
      observer.disconnect()
      input.dispose()
      unsubscribe()
      terminal.dispose()
    }
  }, [project.id, online, fitRef, task])

  useEffect(() => {
    if (!term.current) return
    term.current.options = {
      fontFamily: '"' + settings.font.replaceAll('"', '') + '", Consolas, "Microsoft YaHei UI", monospace',
      fontSize: settings.fontSize, lineHeight: 1.22, cursorStyle: settings.cursor,
      theme: terminalThemes[settings.theme],
    }
    if (visible) fitRef.current?.()
  }, [settings, visible, fitRef, running, online])

  return <div className={'terminal-surface ' + settings.theme} hidden={!visible}>
    <div className="terminal-viewport" ref={element} />
  </div>
}

function InfoPanel({ project, task }: { project: Project; task: Task }) {
  const runtime = useDesk((state) => state.runtime[project.id])
  const interval = useDesk((state) => state.settings.pollInterval)
  const language = useDesk((state) => state.settings.language)
  const t = useTranslation()
  const running = active(runtime?.status)
  const [listening, setListening] = useState<number[] | null>(null)
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  useEffect(() => {
    setListening(null)
    if (!running) return
    let mounted = true
    const scan = () => void projectListeningPorts(project.id).then((ports) => {
      if (mounted) setListening(ports)
    }).catch(() => { if (mounted) setListening(null) })
    scan()
    const timer = setInterval(scan, interval)
    return () => { mounted = false; clearInterval(timer) }
  }, [project.id, runtime?.runId, running, interval])
  return <div className="detail-content">
    <h3>{t('项目信息', 'Project details')}</h3>
    <dl className="info-grid">
      <dt>{t('本地路径', 'Local path')}</dt><dd><code>{project.path}</code><IconButton label={t('打开项目目录', 'Open project folder')} onClick={() => task(() => api().call('openFolder', { id: project.id }))}><FolderOpen size={15} /></IconButton></dd>
      <dt>{t('启动命令', 'Start command')}</dt><dd><code>{project.command}</code></dd>
      <dt>Shell</dt><dd>{project.shell === 'powershell' ? 'PowerShell' : 'CMD'}</dd>
      <dt>{t('配置端口', 'Configured port')}</dt><dd>{project.port ?? '—'}</dd>
      <dt>{t('实际监听', 'Listening on')}</dt><dd>{!running || listening === null ? '—' : listening.join(t('、', ', ')) || t('未监听', 'Not listening')}</dd>
      <dt>{t('进程 PID', 'Process ID')}</dt><dd>{runtime?.pid ?? '—'}</dd>
      <dt>{t('启动时间', 'Started at')}</dt><dd>{dateTime(runtime?.startedAt, language)}</dd>
      <dt>{t('运行时长', 'Uptime')}</dt><dd>{duration(runtime?.startedAt, now)}</dd>
    </dl>
  </div>
}

function ProjectHeading({ project, badge }: { project: Pick<Project, 'name' | 'path'>; badge: ReactNode }) {
  return <div className="project-heading">
    <div className="project-symbol"><Folder size={30} /></div>
    <div className="heading-text">
      <div className="name-line"><h1 title={project.name}>{project.name}</h1>{badge}</div>
      <div className="path" title={project.path}>{project.path}</div>
    </div>
  </div>
}

export function DiscoveredDetail({ project, onImport, task }: { project: DiscoveredProject; onImport: () => void; task: Task }) {
  const t = useTranslation()
  const preview = t('网页预览', 'Web preview')
  return <section className="detail">
    <header className="project-header">
      <ProjectHeading project={project} badge={<span className="status-badge">{t('外部项目', 'External project')}</span>} />
      <div className="header-actions">
        <Button className="primary" onClick={onImport}><Plus size={16} />{t('加入管理', 'Import project')}</Button>
      </div>
    </header>
    <div className="detail-view">
      <div className="detail-content">
        <h3>{t('项目信息', 'Project details')}</h3>
        <dl className="info-grid">
          <dt>{t('进程 PID', 'Process ID')}</dt><dd className="mono">{project.pids.join(t('、', ', '))}</dd>
          <dt>{preview}</dt><dd className="discovered-ports">{project.ports.length ? project.ports.map((port) => (
            <Button key={port} className="row-port mono" aria-label={preview + ' :' + port}
              onClick={() => task(() => api().call('openPort', { port }))}>:{port}<ExternalLink size={13} /></Button>
          )) : t('未监听端口', 'No listening ports')}</dd>
        </dl>
        <div className="discovered-terminal">
          <h3>{t('终端', 'Terminal')}</h3>
          <p className="muted">{t('通过 TSManager 运行项目时会创建实时终端。加入管理后，请在原工具中停止当前实例，再点击「运行」。', 'TSManager creates a live terminal when it runs a project. After importing, stop the current instance in the tool that started it, then select Run.')}</p>
        </div>
      </div>
    </div>
  </section>
}

export function ProjectDetail({ project, tab, setTab, full, setFull, run, task, viewPort }: {
  project: Project; tab: Tab; setTab: (tab: Tab) => void; full: boolean; setFull: (full: boolean) => void
  run: RunAction; task: Task; viewPort: (port: number) => void
}) {
  const runtime = useDesk((state) => state.runtime[project.id])
  const language = useDesk((state) => state.settings.language)
  const t = useTranslation()
  const [command, setCommand] = useState('')
  const fitRef = useRef<(() => void) | undefined>(undefined)
  const busy = runtime?.status === 'starting' || runtime?.status === 'stopping'
  const running = runtime?.status === 'running'
  const sessionStatus = running ? t('会话已连接', 'Session connected') : t('本地会话', 'Local session')
  const session = (project.shell === 'powershell' ? 'PowerShell' : 'CMD') + ' · ' + sessionStatus
  const launch = () => run(project, running ? 'stop' : 'start')
  const onSend = () => {
    if (!running || !command.trim()) return
    task(() => api().call('write', { id: project.id, data: command + '\r' }))
    setCommand('')
  }

  return <section className="detail">
    <header className="project-header">
      <ProjectHeading project={project} badge={<StatusBadge status={runtime?.status} />} />
      <div className="header-actions">
        {project.port && <Button className="preview-button" title={t('打开 localhost:', 'Open localhost:') + project.port} aria-label={t('网页预览', 'Web preview')} onClick={() => task(() => openProjectPort(project))}><ExternalLink size={19} /><span>{t('网页预览', 'Web preview')}</span></Button>}
        <IconButton label={t('重启项目', 'Restart project')} disabled={busy} onClick={() => run(project, 'restart')}><RotateCw size={20} /></IconButton>
        <Button className={running ? 'stop-button' : 'primary'} disabled={busy} onClick={launch}>
          {running ? <Square size={14} fill="currentColor" /> : <Play size={16} />}
          {running ? t('停止', 'Stop') : busy ? (runtime.status === 'starting' ? t('启动中', 'Starting') : t('停止中', 'Stopping')) : t('运行', 'Run')}
        </Button>
      </div>
    </header>
    {runtime?.error && <div className="error-banner" role="alert"><span>{localizeMessage(language, runtime.error)}</span>{project.port && <Button className="quiet" onClick={() => viewPort(project.port!)}>{t('查看端口', 'View port')}</Button>}</div>}
    <div className="tab-strip">
      <div className="tabs" role="group" aria-label={t('项目视图', 'Project view')}>
        {tabNames.map(({ id, label, icon: Icon }) => <button key={id} className={tab === id ? 'chosen' : ''} aria-pressed={tab === id} onClick={() => setTab(id)}>
          <Icon size={20} />{t(label[0], label[1])}
        </button>)}
      </div>
      <div className="tab-actions">
        {tab === 'terminal' && <IconButton label={t('清屏', 'Clear terminal')} onClick={() => task(() => api().call('clearTerminal', { id: project.id }))}><Trash2 size={15} /></IconButton>}
        <IconButton label={full ? t('退出全屏', 'Exit fullscreen') : t('全屏终端', 'Fullscreen terminal')} onClick={() => { setTab('terminal'); setFull(!full) }}>{full ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</IconButton>
      </div>
    </div>
    <div className={'detail-view' + (tab === 'terminal' ? ' terminal-view' : '')}>
      <TerminalView project={project} visible={tab === 'terminal'} fitRef={fitRef} task={task} />
      {tab === 'terminal' && !runtime?.runId && <div className="terminal-idle"><TerminalSquare size={18} /><span>{t('项目已停止。点击 ', 'Project stopped. Select ')}<b>{t('运行', 'Run')}</b>{t(' 启动终端。', ' to start the terminal.')}</span></div>}
      {tab === 'info' && <InfoPanel project={project} task={task} />}
    </div>
    {tab === 'terminal' && <form className="command-bar" onSubmit={(event) => { event.preventDefault(); onSend() }}>
      <TerminalIcon size={20} />
      <input aria-label={t('发送终端命令', 'Terminal command')} value={command} onChange={(event) => setCommand(event.target.value)}
        placeholder={running ? t('输入命令并按 Enter 执行…', 'Enter a command…') : t('启动项目后可发送命令', 'Run the project to send commands')} disabled={!running} />
      <IconButton type="submit" label={t('发送命令', 'Send command')} disabled={!running || !command.trim()}><Send size={15} /></IconButton>
      <Button className="interrupt" aria-label={t('中断 (Ctrl+C)', 'Interrupt (Ctrl+C)')} title={t('中断 (Ctrl+C)', 'Interrupt (Ctrl+C)')} disabled={!running} onClick={() => task(() => api().call('interrupt', { id: project.id }))}><kbd>Ctrl+C</kbd></Button>
      <span className="command-meta" title={session}>UTF-8{runtime?.pid && <span>PID {runtime.pid}</span>}</span>
      <span className="sr-only" role="status">{sessionStatus}</span>
    </form>}
  </section>
}
