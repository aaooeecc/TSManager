import '@fontsource-variable/inter'
import '@fontsource/ibm-plex-mono/400.css'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { Activity, Cable, ChevronDown, ChevronRight, CircleAlert, Folder, FolderOpen, FolderPlus, History, MoreHorizontal, Pencil, Play, Plus, RotateCw, Search, Settings, Square, Terminal, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { DEFAULT_GROUP, type DiscoveredProject, type Group, type Project, type Status, type Theme } from '../shared/api'
import { DiscoveredDetail, ProjectDetail, type RunAction, type Tab } from './detail'
import { Confirm, DeleteGroup, GroupForm, ProjectForm } from './forms'
import { useTranslation } from './i18n'
import { HistoryPage, NoProject, PortsPage, SettingsPage } from './pages'
import { active, api, errorMessage, groupName, listen, openProjectPort, refresh, statusLabel, statuses, useDesk, type Screen } from './store'
import { Button, IconButton, Select, StatusBadge } from './ui'

type Editor =
  | { kind: 'project'; project?: Project; groupId?: string; discovered?: DiscoveredProject }
  | { kind: 'group'; group?: Group }
  | { kind: 'deleteProject'; project: Project }
  | { kind: 'deleteGroup'; group: Group }
  | { kind: 'stopDiscovered'; discovered: DiscoveredProject }
type Task = (action: () => Promise<unknown>, success?: string) => void
const navigationItems = [
  { screen: 'projects', label: ['项目', 'Projects'], icon: Folder },
  { screen: 'ports', label: ['端口', 'Ports'], icon: Cable },
  { screen: 'history', label: ['运行历史', 'Run history'], icon: History },
  { screen: 'settings', label: ['设置', 'Settings'], icon: Settings },
] as const
const webWorkspace = document.body.classList.contains('preview-page')

function Navigation({ onNavigate }: { onNavigate: (screen: Screen) => void }) {
  const { screen, ready, online } = useDesk()
  const t = useTranslation()
  const connection = online ? t('后台已连接', 'Service connected')
    : ready ? t('后台已断开', 'Service disconnected') : t('正在连接后台', 'Connecting…')
  return <aside className="navigation">
    <div className="brand">
      <span className="brand-icon"><Terminal size={25} /></span>
      <div className="brand-text"><strong>TSManager</strong><span>{t('项目管理平台', 'Project workspace')}</span></div>
    </div>
    <nav aria-label={t('工作区', 'Workspace')}>
      {navigationItems.map(({ screen: target, label, icon: Icon }) => {
        const name = t(label[0], label[1])
        return <button key={target} title={name} aria-label={name}
          aria-current={screen === target ? 'page' : undefined} onClick={() => onNavigate(target)}>
          <Icon size={22} /><span className="nav-text">{name}</span>
        </button>
      })}
    </nav>
    <div className="local-status" role="status" title={connection}><i className={'status-dot ' + (online ? 'running' : 'stopped')} /><span>{connection}</span></div>
  </aside>
}

function Menu({ label, children }: { label: string; children: ReactNode }) {
  return <details className="row-menu" onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node)) event.currentTarget.open = false
  }} onKeyDown={(event) => {
    if (event.key === 'Escape') {
      event.currentTarget.open = false
      event.currentTarget.querySelector('summary')?.focus()
    }
  }}>
    <summary title={label} aria-label={label} onClick={(event) => event.stopPropagation()}><MoreHorizontal size={16} /></summary>
    <div className="menu-items" onClick={(event) => {
      event.stopPropagation()
      if ((event.target as HTMLElement).closest('button')) event.currentTarget.closest('details')!.open = false
    }}>{children}</div>
  </details>
}

function ProjectRow({ project, selected, choose, run, edit, task, index, count, shift }: {
  project: Project; selected: boolean; choose: (project: Project) => void; run: RunAction; edit: (editor: Editor) => void
  task: Task; index: number; count: number; shift: (project: Project, direction: number) => void
}) {
  const runtime = useDesk((state) => state.runtime[project.id])
  const status = runtime?.status ?? 'stopped'
  const t = useTranslation()
  const label = statusLabel(status, t)
  const busy = status === 'starting' || status === 'stopping'
  const running = status === 'running'
  return <div className={'project-row ' + (selected ? 'selected' : '')}>
    <button className="project-select" aria-label={project.name} aria-description={label} aria-pressed={selected} onClick={() => choose(project)}>
      <span className={'status-dot ' + status} title={label} /><span className="project-row-name" title={project.name}>{project.name}</span>
    </button>
    {project.port && <button className="row-port mono" title={t('在浏览器打开 localhost:', 'Open in browser at localhost:') + project.port} onClick={() => task(() => openProjectPort(project))}>:{project.port}</button>}
    <span className="row-pid" title={runtime?.pid ? 'PID ' + runtime.pid : t('无进程 PID', 'No process PID')}>PID {runtime?.pid ?? '–'}</span>
    <StatusBadge status={status} showDot={false} />
    <div className="row-actions">
      <IconButton label={(running ? t('停止 ', 'Stop ') : t('运行 ', 'Run ')) + project.name} className={'row-run' + (running ? ' row-stop' : '')} disabled={busy} onClick={() => run(project, running ? 'stop' : 'start')}>
        {running ? <Square size={13} fill="currentColor" /> : <Play size={16} />}
      </IconButton>
      <IconButton label={t('重启 ', 'Restart ') + project.name} disabled={busy} onClick={() => run(project, 'restart')}><RotateCw size={16} /></IconButton>
      <Menu label={t(project.name + ' 的更多操作', 'More actions for ' + project.name)}>
        <button onClick={() => edit({ kind: 'project', project })}><Pencil size={14} />{t('编辑项目', 'Edit project')}</button>
        <button onClick={() => task(() => api().call('openFolder', { id: project.id }))}><FolderOpen size={14} />{t('打开目录', 'Open folder')}</button>
        {index > 0 && <button onClick={() => shift(project, -1)}>{t('上移项目', 'Move project up')}</button>}
        {index < count - 1 && <button onClick={() => shift(project, 1)}>{t('下移项目', 'Move project down')}</button>}
        <button className="error-text" onClick={() => edit({ kind: 'deleteProject', project })}><Trash2 size={14} />{t('删除项目', 'Delete project')}</button>
      </Menu>
    </div>
  </div>
}

function useDiscoveredProjects(projects: Project[], enabled: boolean, interval: number) {
  const [result, setResult] = useState<{ items: DiscoveredProject[]; error: string }>({ items: [], error: '' })
  useEffect(() => {
    if (!enabled) return
    let current = true
    let timer: ReturnType<typeof setTimeout>
    async function scan() {
      try {
        const items = await api().call('discoverProjects', null)
        if (current) setResult({ items, error: '' })
      } catch (error) {
        if (current) setResult({ items: [], error: errorMessage(error) })
      } finally {
        if (current) timer = setTimeout(() => void scan(), interval)
      }
    }
    void scan()
    return () => { current = false; clearTimeout(timer) }
  }, [projects, enabled, interval])
  if (!enabled) return { items: [], error: '' }
  const registered = new Set(projects.map((project) => project.path.toLowerCase()))
  return { ...result, items: result.items.filter((item) => !registered.has(item.path.toLowerCase())) }
}

function DiscoveredRow({ item, selected, choose, edit }: {
  item: DiscoveredProject; selected: boolean; choose: (item: DiscoveredProject) => void; edit: (editor: Editor) => void
}) {
  const t = useTranslation()
  const ports = item.ports.map((port) => ':' + port).join(' ')
  const label = ports ? t('外部运行', 'External') : t('未监听', 'Not listening')
  return <div className={'project-row discovered-row' + (ports ? '' : ' no-listener') + (selected ? ' selected' : '')}>
    <button className="discovered-info" aria-label={item.name} aria-description={label} aria-pressed={selected} onClick={() => choose(item)}>
      <span className="discovered-name"><i className={'status-dot ' + (ports ? 'running' : 'no-listener')} /><strong title={item.name}>{item.name}</strong><span>{label}</span></span>
      <span className="discovered-path mono" title={item.path}>{item.path}</span>
      <span className="discovered-meta mono" title={'PID ' + item.pids.join(', ') + (ports ? ' · ' + ports : '')}>
        {ports && ports + ' · '}PID {item.pids[0]}{item.pids.length > 1 ? ' +' + (item.pids.length - 1) : ''}
      </span>
    </button>
    <Button className="discovered-add" aria-label={t('加入管理 ' + item.name, 'Add ' + item.name + ' to TSManager')} onClick={() => edit({ kind: 'project', groupId: DEFAULT_GROUP, discovered: item })}><Plus size={14} />{t('加入管理', 'Add')}</Button>
    <Button className="discovered-stop danger" aria-label={t('结束进程 ', 'End process for ') + item.name}
      disabled={!item.processes?.length} title={item.processes?.length ? t('结束进程', 'End process') : t('等待重新识别进程', 'Waiting for the next process scan')}
      onClick={() => edit({ kind: 'stopDiscovered', discovered: item })}>{t('结束进程', 'End process')}</Button>
  </div>
}

function ProjectList({ search, setSearch, searchRef, run, choose, discoveries, discoveryError, discovered, chooseDiscovered, edit, task }: {
  search: string; setSearch: (query: string) => void; searchRef: React.RefObject<HTMLInputElement | null>
  discoveries: DiscoveredProject[]; discoveryError: string; discovered?: DiscoveredProject; chooseDiscovered: (item: DiscoveredProject) => void
  run: RunAction; choose: (project: Project) => void; edit: (editor: Editor) => void; task: Task
}) {
  const { groups, projects, selected, runtime } = useDesk()
  const t = useTranslation()
  const [filter, setFilter] = useState<Status | 'all'>('all')
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('tsmanager.collapsed') ?? '[]') } catch { return [] }
  })
  const query = search.trim().toLowerCase()
  const filtered = projects.filter((project) => {
    const group = groups.find((item) => item.id === project.groupId)
    return [project.name, project.path, project.port, group && groupName(group, t)].join(' ').toLowerCase().includes(query)
      && (filter === 'all' || (runtime[project.id]?.status ?? 'stopped') === filter)
  })
  const filtering = Boolean(query || filter !== 'all')
  const defaultGroup = groups.find((item) => item.id === DEFAULT_GROUP)
  const defaultName = defaultGroup ? groupName(defaultGroup, t) : ''
  const detected = discoveries.filter((item) =>
    (filter === 'all' || (filter === 'running' && item.ports.length > 0)) &&
    [item.name, item.path, ...item.ports, ...item.pids, defaultName].join(' ').toLowerCase().includes(query))

  function toggle(id: string) {
    const next = collapsed.includes(id) ? collapsed.filter((item) => item !== id) : [...collapsed, id]
    setCollapsed(next)
    localStorage.setItem('tsmanager.collapsed', JSON.stringify(next))
  }

  function shift(project: Project, direction: number) {
    const ids = projects.map((item) => item.id)
    const siblings = projects.filter((item) => item.groupId === project.groupId)
    const target = siblings[siblings.findIndex((item) => item.id === project.id) + direction]
    if (!target) return
    const from = ids.indexOf(project.id)
    const to = ids.indexOf(target.id)
    ids[from] = target.id
    ids[to] = project.id
    task(() => api().call('reorderProjects', { ids }))
  }

  return <aside className="projects">
    <div className="project-list-top">
      <div className="section-heading"><div><h1>{t('项目', 'Projects')}</h1><span className="count">{projects.length}</span></div>
        <Button className="primary" onClick={() => edit({ kind: 'project' })}><Plus size={16} />{t('添加项目', 'Add project')}</Button>
      </div>
      <div className="list-controls">
        <label className="search-field"><Search size={16} /><input ref={searchRef} aria-label={t('搜索项目', 'Search projects')} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('搜索项目…', 'Search projects…')} />
          {search && <IconButton label={t('清除搜索', 'Clear search')} onClick={() => setSearch('')}><X size={13} /></IconButton>}
        </label>
        <Select aria-label={t('筛选状态', 'Filter by status')} value={filter} onChange={(event) => setFilter(event.target.value as Status | 'all')}>
          <option value="all">{t('全部状态', 'All statuses')}</option>{statuses.map((status) => <option key={status} value={status}>{statusLabel(status, t)}</option>)}
        </Select>
      </div>
    </div>
    <div className="group-top"><span>{t('分组', 'Groups')}</span><Button className="quiet" onClick={() => edit({ kind: 'group' })}><FolderPlus size={15} />{t('新建分组', 'New group')}</Button></div>
    <div className="group-list">
      {groups.toSorted((a, b) => Number(a.id === DEFAULT_GROUP) - Number(b.id === DEFAULT_GROUP)).map((group) => {
        const all = projects.filter((project) => project.groupId === group.id)
        const items = filtered.filter((project) => project.groupId === group.id)
        const outside = group.id === DEFAULT_GROUP ? detected : []
        if (filtering && !items.length && !outside.length) return null
        const hidden = !filtering && collapsed.includes(group.id)
        const name = groupName(group, t)
        return <section className="group" key={group.id}>
          <div className="group-header">
            <button className="group-toggle" aria-expanded={!hidden} onClick={() => toggle(group.id)}>
              {hidden ? <ChevronRight size={15} /> : <ChevronDown size={15} />}<Folder size={20} /><span>{name}</span><span className="group-count">{all.length + (group.id === DEFAULT_GROUP ? discoveries.length : 0)}</span>
            </button>
            <Menu label={t(name + ' 的分组操作', 'Group actions for ' + name)}>
              <button onClick={() => edit({ kind: 'project', groupId: group.id })}><Plus size={14} />{t('添加项目', 'Add project')}</button>
              <button onClick={() => edit({ kind: 'group', group })}><Pencil size={14} />{t('重命名分组', 'Rename group')}</button>
              {group.id !== DEFAULT_GROUP && <button className="error-text" onClick={() => edit({ kind: 'deleteGroup', group })}><Trash2 size={14} />{t('删除分组', 'Delete group')}</button>}
            </Menu>
          </div>
          {!hidden && <div className="group-items">
            {items.map((project) => <ProjectRow key={project.id} project={project} selected={!discovered && selected === project.id} choose={choose} run={run} edit={edit} task={task}
              index={all.findIndex((item) => item.id === project.id)} count={all.length} shift={shift} />)}
            {outside.map((item) => <DiscoveredRow key={item.path} item={item} selected={discovered?.path === item.path} choose={chooseDiscovered} edit={edit} />)}
            {!filtering && group.id === DEFAULT_GROUP && discoveryError && <div className="discovery-error">{discoveryError}</div>}
          </div>}
        </section>
      })}
      {filtering && !filtered.length && !detected.length && <div className="list-empty"><Search size={18} />{t('没有匹配的项目', 'No matching projects')}</div>}
    </div>
  </aside>
}

function App() {
  const { screen, projects, selected, ready, online, settings, navigate, choose } = useDesk()
  const t = useTranslation()
  const project = projects.find((item) => item.id === selected)
  const discoveryEnabled = ready && online && screen === 'projects'
  const { items: discoveries, error: discoveryError } = useDiscoveredProjects(projects, discoveryEnabled, settings.pollInterval)
  const [discoveredPath, setDiscoveredPath] = useState<string | null>(null)
  const discovered = discoveries.find((item) => item.path.toLowerCase() === discoveredPath)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [tab, setTab] = useState<Tab>('terminal')
  const [search, setSearch] = useState('')
  const [portQuery, setPortQuery] = useState('')
  const [full, setFull] = useState(false)
  const [themePreview, setThemePreview] = useState<Theme | null>(null)
  const [width, setWidth] = useState(() => Number(localStorage.getItem('tsmanager.width')) || undefined)
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null)
  const [startupError, setStartupError] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const visiblePreview = screen === 'settings' ? themePreview : null
  const theme = visiblePreview ?? settings.theme

  const task = useCallback<Task>((action, success) => {
    void Promise.resolve().then(action).then(() => {
      if (success) setToast({ text: success, error: false })
    }).catch((error) => setToast({ text: errorMessage(error), error: true }))
  }, [])

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.lang = settings.language
    if (webWorkspace) document.title = t('TSManager · 本机工作区', 'TSManager · Local workspace')
  }, [theme, settings.language, t])

  useLayoutEffect(() => {
    if (!webWorkspace) task(() => api().call('previewTheme', { theme: visiblePreview }))
  }, [visiblePreview, task])

  useEffect(() => {
    if (screen !== 'settings') setThemePreview(null)
  }, [screen])
  useEffect(() => {
    if (discoveryEnabled && discoveredPath && !discovered) setDiscoveredPath(null)
  }, [discoveryEnabled, discoveredPath, discovered])
  useEffect(() => api().onNotice(listen), [])
  useEffect(() => {
    if (online && ready) return
    let alive = true
    const load = () => void refresh().then(() => { if (alive) setStartupError('') }).catch((error) => { if (alive) setStartupError(errorMessage(error)) })
    load()
    const timer = setInterval(load, 6000)
    return () => { alive = false; clearInterval(timer) }
  }, [online, ready])
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), toast.error ? 7500 : 3500)
    return () => clearTimeout(timer)
  }, [toast])

  const toggleFull = useCallback((value: boolean) => {
    task(async () => { await api().call('fullscreen', { value }); setFull(value) })
  }, [task])
  const focusSearch = useCallback(() => {
    if (full) toggleFull(false)
    navigate('projects')
    requestAnimationFrame(() => searchRef.current?.focus())
  }, [full, navigate, toggleFull])

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === 'k') { event.preventDefault(); focusSearch() }
      if (full && event.key === 'Escape') { event.preventDefault(); toggleFull(false) }
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [focusSearch, full, toggleFull])

  function chooseProject(item: Project) {
    if (item.id !== selected || discoveredPath) setTab('terminal')
    setDiscoveredPath(null)
    choose(item.id)
    navigate('projects')
  }

  const run: RunAction = (item, action) => {
    if (action !== 'stop') { chooseProject(item); setTab('terminal') }
    task(() => api().call(action, { id: item.id }))
  }

  function setListWidth(value: number) {
    const next = Math.max(280, Math.min(520, Math.round(value)))
    setWidth(next)
    localStorage.setItem('tsmanager.width', String(next))
  }

  const add = () => setEditor({ kind: 'project' })
  const close = () => setEditor(null)
  const deleting = editor?.kind === 'deleteProject' ? editor.project : undefined
  const deleteRunning = useDesk((state) => deleting ? active(state.runtime[deleting.id]?.status) : false)

  return <div className={'app ' + (full ? 'terminal-full' : '')}>
    <div className="title-bar" aria-hidden="true" />
    {webWorkspace && <div className="preview-label">{t('本机工作区', 'Local workspace')}</div>}
    <div className="workspace">
      <Navigation onNavigate={(next) => { if (next === 'ports') setPortQuery(''); navigate(next) }} />
      {!ready ? <div className="loading"><Activity size={23} /><h2>{startupError || t('正在连接本地后台…', 'Connecting to the local service…')}</h2>{startupError && <Button onClick={() => task(refresh)}>{t('重试', 'Retry')}</Button>}</div> :
        screen === 'projects' ? <main className="project-workspace" style={width ? { '--list-width': width + 'px' } as React.CSSProperties : undefined}>
          <ProjectList search={search} setSearch={setSearch} searchRef={searchRef} run={run} choose={chooseProject} edit={setEditor} task={task}
            discoveries={discoveries} discoveryError={discoveryError} discovered={discovered} chooseDiscovered={(item) => setDiscoveredPath(item.path.toLowerCase())} />
          <div className="splitter" role="separator" tabIndex={0} aria-label={t('调整项目列表宽度', 'Resize project list')} aria-orientation="vertical"
            aria-valuenow={width ?? Math.max(280, Math.min(520, Math.round(window.innerWidth * (theme === 'classic' ? .2915 : .38))))}
            aria-valuemin={280} aria-valuemax={520}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId)
              event.preventDefault()
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
              setListWidth(event.clientX - (event.currentTarget.parentElement?.getBoundingClientRect().left ?? 0))
            }}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
              event.preventDefault()
              const current = event.currentTarget.previousElementSibling?.getBoundingClientRect().width ?? 280
              setListWidth(current + (event.key === 'ArrowLeft' ? -10 : 10))
            }} />
          {discovered ? <DiscoveredDetail project={discovered} task={task} onImport={() => setEditor({ kind: 'project', groupId: DEFAULT_GROUP, discovered })} /> :
            project ? <ProjectDetail key={project.id} project={project} tab={tab} setTab={setTab} full={full} setFull={toggleFull} run={run} task={task}
            viewPort={(port) => { setPortQuery(String(port)); navigate('ports') }} /> : <NoProject add={add} hasProjects={projects.length > 0} />}
        </main> :
          screen === 'ports' ? <PortsPage key={portQuery} initial={portQuery} task={task} go={chooseProject} /> :
          screen === 'settings' ? <SettingsPage task={task} onThemePreview={setThemePreview} /> :
          <HistoryPage />}
    </div>
    {editor?.kind === 'project' && <ProjectForm project={editor.project} groupId={editor.groupId} discovered={editor.discovered} onSaved={chooseProject} onClose={close} />}
    {editor?.kind === 'group' && <GroupForm group={editor.group} onClose={close} />}
    {editor?.kind === 'deleteGroup' && <DeleteGroup group={editor.group} onClose={close} />}
    {editor?.kind === 'stopDiscovered' && <Confirm title={t('结束进程', 'End process')}
      text={t('结束「' + editor.discovered.name + '」当前检测到的 Node.js 进程？', 'End the detected Node.js processes for “' + editor.discovered.name + '”?')}
      confirm={t('结束进程', 'End process')} onClose={close} action={async () => {
        const { path, processes = [] } = editor.discovered
        const result = await api().call('stopDiscoveredProject', { path, processes })
        await refresh().catch(() => {})
        const messages: string[] = []
        if (result.stopped.length) {
          const count = result.stopped.length
          messages.push(t('已结束 ' + count + ' 个进程。', 'Ended ' + count + (count === 1 ? ' process.' : ' processes.')))
        }
        if (result.changed.length) messages.push(t('PID ' + result.changed.join('、') + ' 已退出或归属已变化。', 'These process IDs exited or changed owners: ' + result.changed.join(', ') + '.'))
        if (result.failed.length) messages.push(t('未能结束 PID ' + result.failed.join('、') + '。', 'Could not end PID ' + result.failed.join(', ') + '.'))
        setToast({ text: messages.join(t('', ' ')), error: result.failed.length > 0 })
      }}>
      <div className="mono muted">{editor.discovered.path}</div>
      <div className="mono">PID {editor.discovered.pids.join(t('、', ', '))}</div>
    </Confirm>}
    {deleting && <Confirm title={t('删除项目', 'Delete project')}
      text={t('从 TSManager 移除「' + deleting.name + '」。本地项目文件会保留。', 'Remove “' + deleting.name + '” from TSManager? Your local project files will be kept.')}
      confirm={deleteRunning ? t('停止并删除', 'Stop and delete') : t('删除项目', 'Delete project')} onClose={close} action={async () => {
      if (deleteRunning) await api().call('stop', { id: deleting.id })
      await api().call('deleteProject', { id: deleting.id })
      await refresh()
    }} />}
    {toast && <div className={'toast ' + (toast.error ? 'toast-error' : '')} role={toast.error ? 'alert' : 'status'}>
      {toast.error ? <CircleAlert size={17} /> : <Activity size={17} />}<span>{toast.text}</span><IconButton label={t('关闭提示', 'Dismiss notification')} onClick={() => setToast(null)}><X size={15} /></IconButton>
    </div>}
  </div>
}

createRoot(document.getElementById('root')!).render(<App />)
