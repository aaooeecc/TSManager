import { Cable, ExternalLink, History, Plus, RefreshCw, Search, Square, TerminalSquare } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { Log, Port, Project, Run, Theme } from '../shared/api'
import { localizeMessage } from '../shared/messages'
import { Confirm, SettingsForm } from './forms'
import { useTranslation } from './i18n'
import { api, dateTime, duration, errorMessage, statusLabel, useDesk } from './store'
import { Button, Empty, Modal, Select, StatusBadge } from './ui'

type Task = (action: () => Promise<unknown>, success?: string) => void

function Page({ title, description, actions, children }: { title: string; description: string; actions?: ReactNode; children: ReactNode }) {
  return <main className="page">
    <header className="page-header"><div><h1>{title}</h1><p>{description}</p></div>{actions && <div className="page-actions">{actions}</div>}</header>
    {children}
  </main>
}

function useRuns() {
  const [runs, setRuns] = useState<Run[]>([])
  const [error, setError] = useState('')
  const online = useDesk((state) => state.online)
  useEffect(() => {
    if (!online) return
    let alive = true
    async function load() {
      try {
        const data = await api().call('history', null)
        if (alive) { setRuns(data); setError('') }
      } catch (error) { if (alive) setError(errorMessage(error)) }
    }
    void load()
    const remove = api().onNotice((notice) => {
      if (notice.type === 'changed' || notice.type === 'status') void load()
    })
    return () => { alive = false; remove() }
  }, [online])
  return { runs, error }
}

type PortRow = { key: string; port: number; owner?: Port; project?: Project }

export function PortsPage({ initial, task, go }: { initial: string; task: Task; go: (project: Project) => void }) {
  const t = useTranslation()
  const { projects, settings, online } = useDesk()
  const [ports, setPorts] = useState<Port[]>([])
  const [query, setQuery] = useState(initial)
  const [filter, setFilter] = useState('all')
  const [selected, setSelected] = useState<PortRow | null>(null)
  const [stopping, setStopping] = useState<Port | null>(null)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [scanned, setScanned] = useState('')
  const apply = (rows: Port[]) => { setPorts(rows); setError(''); setLoaded(true); setScanned(new Date().toISOString()) }

  useEffect(() => {
    if (!online) return
    let live = true
    async function scan() {
      try {
        const rows = await api().call('ports', null)
        if (live) apply(rows)
      } catch (error) { if (live) setError(errorMessage(error)) }
    }
    void scan()
    const timer = setInterval(() => void scan(), settings.pollInterval)
    return () => { live = false; clearInterval(timer) }
  }, [online, settings.pollInterval])

  const rows: PortRow[] = ports.map((owner, index) => ({
    key: owner.port + '-' + owner.pid + '-' + index, port: owner.port, owner,
    project: projects.find((project) => project.id === owner.projectId),
  }))
  for (const project of projects) {
    if (!project.port || rows.some((row) => row.port === project.port && row.project?.id === project.id)) continue
    const owner = ports.find((row) => row.port === project.port)
    rows.push({ key: project.id, port: project.port, project, owner })
  }
  const needle = query.trim().toLowerCase().replace(/^:/, '')
  const visible = rows.sort((a, b) => a.port - b.port).filter((row) => {
    const match = [row.port, row.owner?.pid, row.owner?.name, row.owner?.address, row.project?.name].join(' ').toLowerCase().includes(needle)
    return match && (filter === 'all' || (filter === 'configured' && row.project?.port === row.port) || (filter === 'external' && row.owner && !row.owner.projectId))
  })
  const reload = async () => { apply(await api().call('ports', null)) }
  const stateText = (row: PortRow) => !row.owner ? t('空闲', 'Available') : row.owner.projectId === row.project?.id && row.owner.projectId
    ? t('项目运行中', 'Project running') : row.owner.projectId ? t('其他项目占用', 'Used by another project') : t('外部占用', 'Used by an external process')

  return <Page title={t('端口', 'Ports')} description={t('查看本机 TCP 监听端口、项目归属与占用进程。', 'See local TCP ports and the projects or processes using them.')}
    actions={<Button onClick={() => task(reload)}><RefreshCw size={15} />{t('刷新', 'Refresh')}</Button>}>
    <div className="table-controls">
      <label className="search-field"><Search size={16} /><input aria-label={t('搜索端口', 'Search ports')} placeholder={t('搜索端口、PID 或项目…', 'Search by port, PID or project…')} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <Select aria-label={t('端口筛选', 'Filter ports')} value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">{t('所有端口', 'All ports')}</option><option value="configured">{t('已配置端口', 'Configured ports')}</option><option value="external">{t('外部占用', 'External processes')}</option></Select>
      {scanned && <span className="muted table-timestamp">{t('更新于', 'Updated')} {dateTime(scanned, settings.language)}</span>}
    </div>
    {error && <div className="form-error">{error}</div>}
    <div className="surface table-surface">
      <table>
        <thead><tr><th>{t('端口', 'Port')}</th><th>{t('状态', 'Status')}</th><th>{t('项目', 'Project')}</th><th>{t('进程', 'Process')}</th><th>PID</th><th>{t('操作', 'Actions')}</th></tr></thead>
        <tbody>{visible.map((row) => <tr key={row.key}>
          <td><button className="inline-link mono" onClick={() => task(() => api().call('openPort', { port: row.port }))}>:{row.port} <ExternalLink size={12} /></button></td>
          <td><span className={'pill ' + (row.owner ? row.owner.projectId ? 'green' : 'amber' : '')}>{stateText(row)}</span></td>
          <td>{row.project ? <button className="inline-link" onClick={() => go(row.project!)}>{row.project.name}</button> : '—'}</td>
          <td>{row.owner?.name || '—'}</td><td className="mono">{row.owner?.pid ?? '—'}</td>
          <td><Button className="quiet" onClick={() => setSelected(row)}>{t('详情', 'Details')}</Button></td>
        </tr>)}</tbody>
      </table>
      {!visible.length && <Empty icon={<Cable size={24} />} title={loaded ? t('没有匹配的端口', 'No matching ports') : t('正在扫描端口…', 'Scanning ports…')} />}
    </div>
    {selected && !stopping && <Modal title={t(`端口 :${selected.port}`, `Port ${selected.port}`)} onClose={() => setSelected(null)}>
      <div className="form-body"><dl className="info-grid">
        <dt>{t('状态', 'Status')}</dt><dd>{stateText(selected)}</dd><dt>{t('监听地址', 'Listen address')}</dt><dd><code>{selected.owner?.address ?? '—'}</code></dd>
        <dt>{t('项目', 'Project')}</dt><dd>{selected.project?.name ?? '—'}</dd><dt>{t('进程', 'Process')}</dt><dd>{selected.owner?.name || '—'}</dd>
        <dt>PID</dt><dd><code>{selected.owner?.pid ?? '—'}</code></dd>
      </dl></div>
      <div className="dialog-footer">
        {selected.owner?.terminable && <Button className="danger" onClick={() => setStopping(selected.owner!)}><Square size={13} />{t('终止外部进程', 'Stop external process')}</Button>}
        <Button onClick={() => task(() => api().call('openPort', { port: selected.port }))}><ExternalLink size={14} />{t('在浏览器打开', 'Open in browser')}</Button>
      </div>
    </Modal>}
    {stopping && <Confirm title={t('终止外部进程', 'Stop external process')}
      text={t(`确定终止 ${stopping.name}（PID ${stopping.pid}）？该程序可能正在处理其他任务。`, `Stop ${stopping.name} (PID ${stopping.pid})? It may be handling other tasks.`)}
      confirm={t('确认终止', 'Stop process')}
      onClose={() => { setStopping(null); setSelected(null) }} action={async () => {
        await api().call('stopPort', { port: stopping.port, pid: stopping.pid, started: stopping.started })
        await reload()
      }} />}
  </Page>
}

function RunDialog({ run, onClose }: { run: Run; onClose: () => void }) {
  const t = useTranslation()
  const language = useDesk((state) => state.settings.language)
  const projectExists = useDesk((state) => state.projects.some((project) => project.id === run.projectId))
  const [logs, setLogs] = useState<Log[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    if (!projectExists) return
    let live = true
    void api().call('logs', { id: run.projectId, runId: run.id }).then((logs) => { if (live) setLogs(logs) })
      .catch((error) => { if (live) setError(errorMessage(error)) })
    return () => { live = false }
  }, [run.id, run.projectId, projectExists])
  return <Modal title={run.projectName} description={t('运行记录', 'Run details')} onClose={onClose}>
    <div className="form-body">
      <dl className="info-grid">
        <dt>{t('状态', 'Status')}</dt><dd><StatusBadge status={run.status} /></dd><dt>{t('命令', 'Command')}</dt><dd><code>{run.command}</code></dd>
        <dt>{t('开始 / 结束', 'Start / end')}</dt><dd>{dateTime(run.startedAt, language)} / {dateTime(run.stoppedAt, language)}</dd>
        <dt>{t('退出码', 'Exit code')}</dt><dd>{run.exitCode ?? '—'}</dd>
      </dl>
      {run.error && <div className="form-error">{localizeMessage(language, run.error)}</div>}
      {error && <div className="form-error">{error}</div>}
      {logs.length ? <pre className="history-log mono">{logs.map((log) => log.text).join('')}</pre> : <span className="muted">{t('没有保留的日志。', 'No logs were retained.')}</span>}
    </div>
    <div className="dialog-footer"><Button onClick={onClose}>{t('关闭', 'Close')}</Button></div>
  </Modal>
}

export function HistoryPage() {
  const t = useTranslation()
  const language = useDesk((state) => state.settings.language)
  const { runs, error } = useRuns()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Run | null>(null)
  const needle = query.trim().toLowerCase()
  const shown = runs.filter((run) =>
    [run.projectName, run.command, statusLabel(run.status, t), localizeMessage(language, run.error ?? '')].join(' ').toLowerCase().includes(needle))
  return <Page title={t('运行历史', 'Run history')} description={t('查看本地项目的运行记录、退出码与日志。', 'See past runs, exit codes and logs for local projects.')}>
    <div className="table-controls"><label className="search-field"><Search size={16} /><input aria-label={t('搜索运行记录', 'Search run history')} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('搜索项目或命令…', 'Search by project or command…')} /></label></div>
    {error && <div className="form-error">{error}</div>}
    <div className="surface table-surface">
      <table><thead><tr><th>{t('项目', 'Project')}</th><th>{t('状态', 'Status')}</th><th>{t('开始时间', 'Started')}</th><th>{t('运行时长', 'Duration')}</th><th>{t('退出码', 'Exit code')}</th><th>{t('操作', 'Actions')}</th></tr></thead>
        <tbody>{shown.map((run) => <tr key={run.id}><td><strong>{run.projectName}</strong></td>
          <td><StatusBadge status={run.status} /></td><td>{dateTime(run.startedAt, language)}</td>
          <td className="mono">{duration(run.startedAt, run.stoppedAt ? Date.parse(run.stoppedAt) : undefined)}</td><td className="mono">{run.exitCode ?? '—'}</td>
          <td><Button className="quiet" onClick={() => setSelected(run)}>{t('详情', 'Details')}</Button></td></tr>)}</tbody>
      </table>
      {!shown.length && <Empty icon={<History size={24} />} title={t('没有匹配的运行记录', 'No matching runs')} />}
    </div>
    {selected && <RunDialog run={selected} onClose={() => setSelected(null)} />}
  </Page>
}

export function SettingsPage({ task, onThemePreview }: { task: Task; onThemePreview: (theme: Theme | null) => void }) {
  const t = useTranslation()
  const desktop = !document.body.classList.contains('preview-page')
  return <Page title={t('设置', 'Settings')} description={t('配置语言、外观、默认 Shell 与项目退出行为。', 'Set the workspace language, appearance, default shell and quit behavior.')}
    actions={desktop && <Button onClick={() => task(() => api().call('openWeb', null))}><ExternalLink size={15} />{t('打开网页工作区', 'Open web workspace')}</Button>}>
    <SettingsForm onThemePreview={onThemePreview} />
  </Page>
}

export function NoProject({ add, hasProjects }: { add: () => void; hasProjects: boolean }) {
  const t = useTranslation()
  return <section className="welcome">
    <div className="welcome-icon" aria-hidden="true"><TerminalSquare size={32} /></div>
    <h1>{hasProjects ? t('选择一个项目', 'Select a project') : t('启动你的第一个项目', 'Run your first project')}</h1>
    <p>{hasProjects ? t('选择项目以查看终端和项目信息。', 'Select a project to view its terminal and details.') : t('添加本地目录和启动命令，在同一个工作区管理开发服务。', 'Add a local folder and startup command to manage your development services here.')}</p>
    {!hasProjects && <Button className="primary" onClick={add}><Plus size={16} />{t('添加项目', 'Add project')}</Button>}
  </section>
}
