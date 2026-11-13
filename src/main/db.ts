import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { DEFAULT_GROUP, workerDefaults, type Group, type Log, type Project, type ProjectInput, type Run, type Status, type WorkerSettings } from '../shared/api'
import { decryptEnv, encryptEnv } from './windows'

type StoredProject = Omit<Project, 'envKeys'> & { envKeys: string }
const projectFields = 'id, group_id AS groupId, name, path, start_command AS command, port, shell, env_keys AS envKeys, sort_order AS "order"'
const runFields = 'id, project_id AS projectId, project_name AS projectName, command, pid, started_at AS startedAt, stopped_at AS stoppedAt, exit_code AS exitCode, status, error'
const time = () => new Date().toISOString()
const schemaVersion = 1

export class Store {
  private db: DatabaseSync
  settings: WorkerSettings

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    try {
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON')
      this.migrate()
      this.db.prepare('INSERT OR IGNORE INTO groups VALUES (?, ?, 0, ?, ?)').run(DEFAULT_GROUP, '默认分组', time(), time())
      this.db.prepare(`UPDATE run_history SET status = 'error', stopped_at = ?, error = '上次后台进程意外退出'
        WHERE stopped_at IS NULL`).run(time())
      const saved = this.db.prepare('SELECT data FROM settings WHERE id = 1').get()?.data as string | undefined
      const preferences = saved ? JSON.parse(saved) : {}
      this.settings = { ...workerDefaults, ...preferences, startup: preferences.startup === 'last' ? 'last' : workerDefaults.startup }
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  private migrate() {
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version)
    if (version > schemaVersion) throw new Error('本地数据库需要更新版本的 TSManager')
    if (version === schemaVersion) return
    // Earlier releases have the same tables and left user_version at zero.
    this.transaction(() => this.db.exec(`
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_order INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id),
        name TEXT NOT NULL, path TEXT NOT NULL, start_command TEXT NOT NULL,
        port INTEGER CHECK (port BETWEEN 1 AND 65535), shell TEXT NOT NULL CHECK (shell IN ('cmd', 'powershell')),
        env TEXT NOT NULL, env_keys TEXT NOT NULL, sort_order INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_history (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, project_name TEXT NOT NULL, command TEXT NOT NULL,
        pid INTEGER, started_at TEXT NOT NULL, stopped_at TEXT, exit_code INTEGER, status TEXT NOT NULL, error TEXT
      );
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES run_history(id) ON DELETE CASCADE, log_type TEXT NOT NULL,
        content TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS logs_project ON logs(project_id, id DESC);
      CREATE INDEX IF NOT EXISTS logs_run ON logs(run_id, id DESC);
      CREATE INDEX IF NOT EXISTS history_started ON run_history(started_at DESC);
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);
      PRAGMA user_version = ${schemaVersion};
    `))
  }

  close() { this.db.close() }

  private transaction(action: () => void) {
    this.db.exec('BEGIN IMMEDIATE')
    try { action(); this.db.exec('COMMIT') }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  private parseProject(row: StoredProject): Project { return { ...row, envKeys: JSON.parse(row.envKeys) } }

  projects() {
    const rows = this.db.prepare('SELECT ' + projectFields + ' FROM projects ORDER BY sort_order, created_at').all() as StoredProject[]
    return rows.map((row) => this.parseProject(row))
  }

  project(id: string) {
    const row = this.db.prepare('SELECT ' + projectFields + ' FROM projects WHERE id = ?').get(id) as StoredProject | undefined
    if (!row) throw new Error('项目不存在')
    return this.parseProject(row)
  }

  env(id: string) {
    const row = this.db.prepare('SELECT env FROM projects WHERE id = ?').get(id)
    if (!row) throw new Error('项目不存在')
    return decryptEnv(row.env as string)
  }

  groups() {
    return this.db.prepare('SELECT id, name, sort_order AS "order" FROM groups ORDER BY sort_order').all() as Group[]
  }

  private group(id: string) {
    const group = this.db.prepare('SELECT id, name, sort_order AS "order" FROM groups WHERE id = ?').get(id) as Group | undefined
    if (!group) throw new Error('分组不存在')
    return group
  }

  saveGroup(name: string, id?: string) {
    if (this.groups().some((group) => group.id !== id && group.name.toLowerCase() === name.toLowerCase())) {
      throw new Error('分组名称已存在')
    }
    if (id) {
      this.group(id)
      this.db.prepare('UPDATE groups SET name = ?, updated_at = ? WHERE id = ?').run(name, time(), id)
      return this.group(id)
    }
    id = randomUUID()
    this.db.prepare(`INSERT INTO groups VALUES (?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM groups), ?, ?)`)
      .run(id, name, time(), time())
    return this.group(id)
  }

  deleteGroup(id: string, targetId: string) {
    if (id === DEFAULT_GROUP || id === targetId) throw new Error('请选择其他目标分组。默认分组必须保留')
    this.group(id)
    this.group(targetId)
    const current = this.projects()
    const names = new Set(current.filter((item) => item.groupId === targetId).map((item) => item.name.toLowerCase()))
    if (current.some((item) => item.groupId === id && names.has(item.name.toLowerCase()))) {
      throw new Error('目标分组中有同名项目，请先重命名')
    }
    this.transaction(() => {
      this.db.prepare('UPDATE projects SET group_id = ?, updated_at = ? WHERE group_id = ?').run(targetId, time(), id)
      this.db.prepare('DELETE FROM groups WHERE id = ?').run(id)
    })
  }

  saveProject(input: ProjectInput, id?: string) {
    this.group(input.groupId)
    if (this.projects().some((item) => item.id !== id && item.groupId === input.groupId && item.name.toLowerCase() === input.name.toLowerCase())) {
      throw new Error('此分组已有同名项目')
    }
    const fields = [input.groupId, input.name, input.path, input.command, input.port, input.shell] as const
    const envKeys = input.env ? JSON.stringify(Object.keys(input.env)) : null
    const env = input.env && Object.keys(input.env).length ? encryptEnv(input.env) : input.env ? '' : null
    if (id) {
      this.project(id)
      this.db.prepare(`UPDATE projects SET group_id = ?, name = ?, path = ?, start_command = ?, port = ?, shell = ?,
        env = COALESCE(?, env), env_keys = COALESCE(?, env_keys), updated_at = ? WHERE id = ?`)
        .run(...fields, env, envKeys, time(), id)
      return this.project(id)
    }
    id = randomUUID()
    this.db.prepare(`INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,
      (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM projects), ?, ?)`)
      .run(id, ...fields, env ?? '', envKeys ?? '[]', time(), time())
    return this.project(id)
  }

  deleteProject(id: string) {
    this.project(id)
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  }

  reorder(ids: string[]) {
    const items = this.projects()
    const unique = new Set(ids)
    if (unique.size !== items.length || ids.length !== items.length || items.some((item) => !unique.has(item.id))) {
      throw new Error('项目列表已更新，请刷新后重试')
    }
    const update = this.db.prepare('UPDATE projects SET sort_order = ?, updated_at = ? WHERE id = ?')
    this.transaction(() => ids.forEach((id, index) => update.run(index + 1, time(), id)))
  }

  beginRun(project: Project, id: string, started: string) {
    this.db.prepare(`INSERT INTO run_history (id, project_id, project_name, command, started_at, status)
      VALUES (?, ?, ?, ?, ?, 'starting')`).run(id, project.id, project.name, project.command, started)
    this.db.exec(`DELETE FROM run_history WHERE stopped_at IS NOT NULL AND id IN (
      SELECT id FROM run_history ORDER BY started_at DESC LIMIT -1 OFFSET 500
    )`)
  }

  runPid(id: string, pid: number) {
    this.db.prepare("UPDATE run_history SET pid = ?, status = 'running' WHERE id = ?").run(pid, id)
  }

  finishRun(id: string, status: Status, exitCode: number | null, error?: string) {
    this.db.prepare('UPDATE run_history SET status = ?, exit_code = ?, stopped_at = ?, error = ? WHERE id = ?')
      .run(status, exitCode, time(), error ?? null, id)
  }

  history() {
    return this.db.prepare('SELECT ' + runFields + ' FROM run_history ORDER BY started_at DESC LIMIT 500').all() as Run[]
  }

  appendLog(projectId: string, runId: string, type: Log['type'], text: string) {
    if (!text) return
    const limit = this.settings.logLimit * 1024
    const bytes = Buffer.from(text, 'utf8')
    const content = bytes.length > limit ? bytes.subarray(bytes.length - limit + 4).toString('utf8') : text
    this.transaction(() => {
      this.db.prepare(`INSERT INTO logs (project_id, run_id, log_type, content, size, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(projectId, runId, type, content, Buffer.byteLength(content), time())
      this.pruneLogs(projectId)
    })
  }

  private pruneLogs(id: string) {
    this.db.prepare(`DELETE FROM logs WHERE id IN (
      SELECT id FROM (SELECT id, SUM(size) OVER (ORDER BY id DESC) AS total,
        ROW_NUMBER() OVER (ORDER BY id DESC) AS position FROM logs WHERE project_id = ?)
      WHERE (total > ? AND position > 1) OR position > 2000
    )`).run(id, this.settings.logLimit * 1024)
  }

  logs(id: string, runId?: string) {
    const rows = runId
      ? this.db.prepare('SELECT created_at AS time, content AS text, log_type AS type FROM logs WHERE project_id = ? AND run_id = ? ORDER BY id').all(id, runId)
      : this.db.prepare('SELECT created_at AS time, content AS text, log_type AS type FROM logs WHERE project_id = ? ORDER BY id').all(id)
    return rows as Log[]
  }

  clearLogs(id: string) { this.db.prepare('DELETE FROM logs WHERE project_id = ?').run(id) }

  saveSettings(next: WorkerSettings) {
    this.transaction(() => {
      this.db.prepare('INSERT INTO settings VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(JSON.stringify(next))
      if (next.logLimit < this.settings.logLimit) {
        this.db.prepare('DELETE FROM logs WHERE size > ?').run(next.logLimit * 1024)
        this.settings = next
        this.projects().forEach((project) => this.pruneLogs(project.id))
      }
    })
    this.settings = next
    return next
  }
}
