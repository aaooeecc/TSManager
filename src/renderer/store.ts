import { create } from 'zustand'
import { DEFAULT_GROUP, defaults, type Group, type Language, type Notice, type Project, type Snapshot, type Status } from '../shared/api'
import { cachedLanguage, rememberLanguage, translation, type Translate } from './locale'

const screens = ['projects', 'ports', 'history', 'settings'] as const
export type Screen = typeof screens[number]
const savedScreen = localStorage.getItem('tsmanager.screen')
const firstScreen = (settings: Snapshot['settings']): Screen =>
  (settings.startup === 'last' && screens.find((screen) => screen === savedScreen)) || 'projects'

type State = Snapshot & {
  ready: boolean; online: boolean; selected: string | null; screen: Screen
  choose: (id: string | null) => void; navigate: (screen: Screen) => void
}

export const useDesk = create<State>((set) => ({
  projects: [], groups: [], settings: { ...defaults, language: cachedLanguage() }, runtime: {}, ready: false, online: false,
  selected: localStorage.getItem('tsmanager.selection'), screen: 'projects',
  choose: (id) => {
    if (id) localStorage.setItem('tsmanager.selection', id)
    else localStorage.removeItem('tsmanager.selection')
    set({ selected: id })
  },
  navigate: (screen) => { localStorage.setItem('tsmanager.screen', screen); set({ screen }) },
}))

export const api = () => window.tsmanager
export async function projectListeningPorts(id: string) {
  const ports = await api().call('ports', null)
  return [...new Set(ports.filter((owner) => owner.projectId === id).map((owner) => owner.port))]
}

export async function openProjectPort(project: Project) {
  const { id, port } = project
  if (port === null) return
  const listening = await projectListeningPorts(id)
  if (!listening.includes(port)) {
    const t = translation(useDesk.getState().settings.language)
    const detail = listening.length ? t('，当前监听 ' + listening.join('、'), '. Listening on ' + listening.join(', ')) : ''
    throw new Error(t('项目尚未监听配置端口 ' + port, 'The project is not listening on port ' + port) + detail + t('。', '.'))
  }
  await api().call('openPort', { port })
}

export const active = (status?: string) => status === 'running' || status === 'starting' || status === 'stopping'
export const statuses = ['stopped', 'running', 'starting', 'stopping', 'error'] as const
export function statusLabel(status: Status, t: Translate) {
  switch (status) {
    case 'stopped': return t('已停止', 'Stopped')
    case 'running': return t('运行中', 'Running')
    case 'starting': return t('启动中', 'Starting')
    case 'stopping': return t('停止中', 'Stopping')
    case 'error': return t('异常', 'Error')
  }
}
export const groupName = (group: Group, t: Translate) =>
  group.id === DEFAULT_GROUP && group.name === '默认分组' ? t('默认分组', 'Default group') : group.name
export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))
  .replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

let revision = 0
export async function refresh() {
  const request = ++revision
  const snapshot = await api().call('snapshot', null)
  if (request !== revision) return
  rememberLanguage(snapshot.settings.language)
  useDesk.setState((state) => ({
    ...snapshot, online: true, ready: true,
    settings: JSON.stringify(snapshot.settings) === JSON.stringify(state.settings) ? state.settings : snapshot.settings,
    selected: snapshot.projects.some((item) => item.id === state.selected) ? state.selected : snapshot.projects[0]?.id ?? null,
    screen: state.ready ? state.screen : firstScreen(snapshot.settings),
  }))
}

export function listen(notice: Notice) {
  if (notice.type === 'changed') void refresh().catch(() => {})
  if (notice.type === 'connection') {
    useDesk.setState({ online: notice.online })
    if (notice.online) void refresh().catch(() => {})
  }
  if (notice.type === 'status') useDesk.setState((state) => ({
    runtime: { ...state.runtime, [notice.id]: notice.runtime },
  }))
}

export const dateTime = (value?: string | null, language: Language = defaults.language) => value
  ? new Intl.DateTimeFormat(language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
  : '—'
export function duration(start?: string, end = Date.now()) {
  if (!start) return '—'
  const seconds = Math.max(0, Math.floor((end - Date.parse(start)) / 1000))
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map((value) => String(value).padStart(2, '0')).join(':')
}
