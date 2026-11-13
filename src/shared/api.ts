export type Status = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
export type Shell = 'powershell' | 'cmd'
export type Group = { id: string; name: string; order: number }
export type Project = {
  id: string; groupId: string; name: string; path: string; command: string
  port: number | null; shell: Shell; envKeys: string[]; order: number
}
export type ProjectInput = Omit<Project, 'id' | 'order' | 'envKeys'> & { env?: Record<string, string> }
export type Runtime = { status: Status; pid?: number; startedAt?: string; error?: string; runId?: string }
export type Run = {
  id: string; projectId: string; projectName: string; command: string; pid: number | null
  startedAt: string; stoppedAt: string | null; exitCode: number | null; status: Status; error: string | null
}
export type Log = { time: string; text: string; type: 'terminal' | 'system' | 'error' }
export type Port = { port: number; pid: number; name: string; address: string; started: string; projectId?: string; terminable: boolean }
export type ProcessIdentity = { pid: number; started: string }
export type DiscoveredProject = {
  name: string; path: string; command: string; ports: number[]; pids: number[]
  processes?: ProcessIdentity[]
}
export type StopDiscoveredResult = { stopped: number[]; changed: number[]; failed: number[] }
export type Language = 'zh-CN' | 'en'
export type Theme = 'light' | 'dark' | 'classic'
export type WorkerSettings = {
  shell: Shell; directory: string; startup: 'projects' | 'last'; exit: 'stop' | 'keep'
  font: string; fontSize: number; theme: 'dark' | 'light'; cursor: 'block' | 'bar' | 'underline'
  stopTimeout: number; pollInterval: number; logLimit: number
}
export type Settings = Omit<WorkerSettings, 'theme'> & { language: Language; theme: Theme }
export const workerDefaults: WorkerSettings = {
  shell: 'powershell', directory: '', startup: 'projects', exit: 'stop',
  font: 'IBM Plex Mono', fontSize: 16, theme: 'light', cursor: 'bar',
  stopTimeout: 3000, pollInterval: 3000, logLimit: 256,
}
export const defaults: Settings = { ...workerDefaults, language: 'zh-CN' }
export const DEFAULT_GROUP = 'default'

export type Snapshot = { projects: Project[]; groups: Group[]; runtime: Record<string, Runtime>; settings: Settings }
export type Output = { id: string; seq: number; data: string; reset?: boolean }
export type Notice =
  | { type: 'changed' }
  | { type: 'status'; id: string; runtime: Runtime }
  | { type: 'output'; output: Output }
  | { type: 'connection'; online: boolean }

export interface Calls {
  snapshot: [null, Snapshot]
  saveProject: [{ id?: string; project: ProjectInput }, Project]
  deleteProject: [{ id: string }, void]
  reorderProjects: [{ ids: string[] }, void]
  saveGroup: [{ id?: string; name: string }, Group]
  deleteGroup: [{ id: string; targetId: string }, void]
  projectEnv: [{ id: string }, Record<string, string>]
  start: [{ id: string; cols?: number; rows?: number }, void]
  stop: [{ id: string }, void]
  restart: [{ id: string; cols?: number; rows?: number }, void]
  stopAll: [null, void]
  terminal: [{ id: string }, Output]
  write: [{ id: string; data: string }, void]
  resize: [{ id: string; cols: number; rows: number }, void]
  interrupt: [{ id: string }, void]
  clearTerminal: [{ id: string }, void]
  logs: [{ id: string; runId?: string }, Log[]]
  clearLogs: [{ id: string }, void]
  history: [null, Run[]]
  ports: [null, Port[]]
  discoverProjects: [null, DiscoveredProject[]]
  stopDiscoveredProject: [{ path: string; processes: ProcessIdentity[] }, StopDiscoveredResult]
  checkPort: [{ port: number }, Port[]]
  stopPort: [{ port: number; pid: number; started: string }, void]
  settings: [Settings, Settings]
  chooseDirectory: [{ path?: string }, string | null]
  openPort: [{ port: number }, void]
  openFolder: [{ id: string }, void]
  openWeb: [null, void]
  fullscreen: [{ value: boolean }, void]
  previewTheme: [{ theme: Settings['theme'] | null }, void]
}
export type Method = keyof Calls
export type WorkerMethod = Exclude<Method, 'chooseDirectory' | 'openPort' | 'openFolder' | 'openWeb' | 'fullscreen' | 'previewTheme'>
export type WorkerCalls = Omit<Pick<Calls, WorkerMethod>, 'snapshot' | 'settings'> & {
  snapshot: [null, Omit<Snapshot, 'settings'> & { settings: WorkerSettings }]
  settings: [WorkerSettings, WorkerSettings]
}
export const workerMethods = [
  'snapshot', 'saveProject', 'deleteProject', 'reorderProjects', 'saveGroup', 'deleteGroup', 'projectEnv',
  'start', 'stop', 'restart', 'stopAll', 'terminal', 'write', 'resize', 'interrupt', 'clearTerminal',
  'logs', 'clearLogs', 'history', 'ports', 'discoverProjects', 'stopDiscoveredProject', 'checkPort', 'stopPort', 'settings',
] as const satisfies readonly WorkerMethod[]
export interface Bridge {
  call<M extends Method>(method: M, input: Calls[M][0]): Promise<Calls[M][1]>
  onNotice(callback: (notice: Notice) => void): () => void
}
declare global {
  interface Window { tsmanager: Bridge }
}
