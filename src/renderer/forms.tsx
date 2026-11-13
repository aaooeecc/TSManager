import { Eye, EyeOff, FolderOpen, Plus, Trash2 } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { DEFAULT_GROUP, defaults, type DiscoveredProject, type Group, type Project, type Settings, type Shell } from '../shared/api'
import { useTranslation, type Translate } from './i18n'
import { active, api, errorMessage, groupName, refresh, useDesk } from './store'
import { Button, IconButton, Modal, Select } from './ui'

type EnvRow = { id: number; key: string; value: string; visible?: boolean }
let rowId = 0
const rowsFrom = (env: Record<string, string>) => Object.entries(env).map(([key, value]) => ({ id: ++rowId, key, value }))

function values(rows: EnvRow[], t: Translate) {
  const keys = new Set<string>()
  const env: Record<string, string> = Object.create(null)
  for (const row of rows) {
    const key = row.key.trim()
    if (!key && !row.value) continue
    if (!key || keys.has(key.toLowerCase())) throw new Error(t('环境变量名称不能为空或重复', 'Environment variable names must be nonempty and unique.'))
    keys.add(key.toLowerCase())
    env[key] = row.value
  }
  return env
}

function EnvRows({ rows, change }: { rows: EnvRow[]; change: (rows: EnvRow[]) => void }) {
  const t = useTranslation()
  const patch = (id: number, value: Partial<EnvRow>) => change(rows.map((row) => row.id === id ? { ...row, ...value } : row))
  return <div className="env-editor">
    {rows.map((row, i) => <div className="env-row" key={row.id}>
      <input aria-label={t('变量名', 'Variable name') + ' ' + (i + 1)} placeholder="VARIABLE_NAME" value={row.key} onChange={(e) => patch(row.id, { key: e.target.value })} />
      <input aria-label={t('变量值', 'Variable value') + ' ' + (i + 1)} placeholder={t('变量值', 'Value')} autoComplete="off" type={row.visible ? 'text' : 'password'} value={row.value} onChange={(e) => patch(row.id, { value: e.target.value })} />
      <IconButton label={row.visible ? t('隐藏变量值', 'Hide variable value') : t('显示变量值', 'Show variable value')} onClick={() => patch(row.id, { visible: !row.visible })}>{row.visible ? <EyeOff size={15} /> : <Eye size={15} />}</IconButton>
      <IconButton label={t('删除变量', 'Remove variable')} onClick={() => change(rows.filter((item) => item.id !== row.id))}><Trash2 size={15} /></IconButton>
    </div>)}
    <Button className="quiet" onClick={() => change([...rows, { id: ++rowId, key: '', value: '' }])}><Plus size={15} />{t('添加变量', 'Add variable')}</Button>
  </div>
}

export function ProjectForm({ project, groupId, discovered, onSaved, onClose }: {
  project?: Project; groupId?: string; discovered?: DiscoveredProject; onSaved: (project: Project) => void; onClose: () => void
}) {
  const t = useTranslation()
  const portDescription = useId()
  const { groups, settings, runtime } = useDesk()
  const locked = active(project ? runtime[project.id]?.status : undefined)
  const [name, setName] = useState(project?.name ?? discovered?.name ?? '')
  const [path, setPath] = useState(project?.path ?? discovered?.path ?? settings.directory)
  const [group, setGroup] = useState(project?.groupId ?? groupId ?? DEFAULT_GROUP)
  const [command, setCommand] = useState(project?.command ?? discovered?.command ?? 'npm run dev')
  const [port, setPort] = useState(project?.port?.toString() ?? (discovered?.ports.length === 1 ? String(discovered.ports[0]) : ''))
  const [shell, setShell] = useState<Shell>(project?.shell ?? settings.shell)
  const [rows, setRows] = useState<EnvRow[]>([])
  const [envOpen, setEnvOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  async function editEnv() {
    try {
      if (project) setRows(rowsFrom(await api().call('projectEnv', { id: project.id })))
      setEnvOpen(true)
    } catch (error) { setError(errorMessage(error)) }
  }

  async function save() {
    setPending(true); setError('')
    try {
      const result = await api().call('saveProject', {
        id: project?.id, project: { name, path, groupId: group, command, port: port ? Number(port) : null, shell, env: envOpen ? values(rows, t) : undefined },
      })
      await refresh()
      onSaved(result)
      onClose()
    } catch (error) { setError(errorMessage(error)) }
    finally { setPending(false) }
  }

  const title = project ? t('编辑项目', 'Edit project') : discovered ? t('加入管理', 'Import project') : t('添加项目', 'Add project')
  const description = discovered
    ? t('确认检测到的目录和启动配置。', 'Review the detected folder and startup settings.')
    : project
      ? t('更新项目配置与运行方式。', 'Update the project settings and how it runs.')
      : t('从本地目录添加一个项目，配置它的启动方式。', 'Add a project from a local folder and configure its startup command.')
  return <Modal title={title} description={description} onClose={onClose}>
    <form onSubmit={(event) => { event.preventDefault(); void save() }}>
      <div className="form-body">
        {locked && <div className="form-note">{t('项目运行中。停止后可修改启动配置。', 'Stop the project before editing its startup settings.')}</div>}
        {discovered && <div className="form-note">{t('当前实例仍由原工具控制。改由 TSManager 启动前，请先停止当前实例。', 'Stop the existing instance in the tool that started it before running the project from TSManager.')}</div>}
        <label>{t('项目名称', 'Project name')}<input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t('例如 my-app', 'e.g. my-app')} required maxLength={100} /></label>
        <label>{t('本地目录', 'Local folder')}<span className="input-action"><input value={path} disabled={locked} onChange={(e) => setPath(e.target.value)} placeholder="C:\Projects\my-app" required />
          <Button disabled={locked} onClick={() => void api().call('chooseDirectory', { path }).then((folder) => { if (folder) setPath(folder) }).catch((error) => setError(errorMessage(error)))}><FolderOpen size={15} />{t('浏览', 'Browse')}</Button>
        </span></label>
        <div className="field-grid">
          <label>{t('所属分组', 'Group')}<Select value={group} onChange={(e) => setGroup(e.target.value)}>{groups.map((item) => <option key={item.id} value={item.id}>{groupName(item, t)}</option>)}</Select></label>
          <label>Shell<Select value={shell} disabled={locked} onChange={(e) => setShell(e.target.value as Shell)}><option value="powershell">PowerShell</option><option value="cmd">CMD</option></Select></label>
        </div>
        <label>{t('启动命令', 'Startup command')}<textarea className="mono" rows={2} value={command} onChange={(e) => setCommand(e.target.value)} disabled={locked} required /></label>
        <div className="port-field">
          <label>{t('端口', 'Port')} <span className="optional">{t('可选', 'Optional')}</span><input type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)}
            disabled={locked} placeholder={t('例如 3000', 'e.g. 3000')} aria-describedby={portDescription} /></label>
          <div id={portDescription} className="muted">
            {discovered && discovered.ports.length > 1 && <div>{t('检测到 ' + discovered.ports.join('、'), 'Detected ports ' + discovered.ports.join(', '))}</div>}
            <div>{t('常见 Vite 启动命令会使用此端口。自定义命令可读取 PORT。', 'Standard Vite startup commands use this port. Custom commands can read PORT.')}</div>
          </div>
        </div>
        <div className="field-label">{t('环境变量', 'Environment variables')} <span className="optional">{t('可选', 'Optional')}</span></div>
        {envOpen ? <EnvRows rows={rows} change={setRows} /> : <Button className="quiet" disabled={locked} onClick={() => void editEnv()}><Plus size={15} />{project?.envKeys.length ? t('编辑环境变量', 'Edit environment variables') : t('配置环境变量', 'Configure environment variables')}</Button>}
        {error && <div className="form-error" role="alert">{error}</div>}
      </div>
      <footer className="dialog-footer"><Button onClick={onClose}>{t('取消', 'Cancel')}</Button><Button type="submit" className="primary" disabled={pending}>{pending ? t('保存中…', 'Saving…') : project ? t('保存修改', 'Save changes') : title}</Button></footer>
    </form>
  </Modal>
}

export function GroupForm({ group, onClose }: { group?: Group; onClose: () => void }) {
  const t = useTranslation()
  const [name, setName] = useState<string>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return <Modal title={group ? t('重命名分组', 'Rename group') : t('新建分组', 'New group')} onClose={onClose}>
    <form onSubmit={(event) => {
      event.preventDefault(); setBusy(true)
      void api().call('saveGroup', { id: group?.id, name: name ?? group?.name ?? '' }).then(refresh).then(onClose)
        .catch((error) => setError(errorMessage(error))).finally(() => setBusy(false))
    }}>
      <div className="form-body"><label>{t('分组名称', 'Group name')}<input autoFocus value={name ?? (group ? groupName(group, t) : '')} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder={t('例如 前端项目', 'e.g. Frontend projects')} required /></label>
        {error && <div className="form-error" role="alert">{error}</div>}
      </div>
      <footer className="dialog-footer"><Button onClick={onClose}>{t('取消', 'Cancel')}</Button><Button type="submit" className="primary" disabled={busy}>{t('保存分组', 'Save group')}</Button></footer>
    </form>
  </Modal>
}

export function Confirm({ title, text, confirm, onClose, action, children }: {
  title: string; text: string; confirm: string; onClose: () => void; action: () => Promise<void>; children?: React.ReactNode
}) {
  const t = useTranslation()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return <Modal title={title} description={text} onClose={() => { if (!busy) onClose() }}>
    <div className="form-body">{children}{error && <div className="form-error" role="alert">{error}</div>}</div>
    <footer className="dialog-footer">
      <Button onClick={onClose} disabled={busy}>{t('取消', 'Cancel')}</Button>
      <Button className="danger" disabled={busy} onClick={() => {
        setBusy(true)
        void action().then(onClose).catch((error) => setError(errorMessage(error))).finally(() => setBusy(false))
      }}>{busy ? t('处理中…', 'Working…') : confirm}</Button>
    </footer>
  </Modal>
}

export function DeleteGroup({ group, onClose }: { group: Group; onClose: () => void }) {
  const t = useTranslation()
  const groups = useDesk((state) => state.groups)
  const [targetId, setTarget] = useState(DEFAULT_GROUP)
  return <Confirm title={t('删除分组', 'Delete group')} text={t(`删除「${group.name}」，并将其中的项目移至目标分组。`, `Delete “${group.name}” and move its projects to the selected group.`)} confirm={t('删除分组', 'Delete group')} onClose={onClose}
    action={() => api().call('deleteGroup', { id: group.id, targetId }).then(refresh)}>
    <label>{t('移动到', 'Move to')}<Select value={targetId} onChange={(event) => setTarget(event.target.value)}>{groups.filter((item) => item.id !== group.id).map((item) => <option key={item.id} value={item.id}>{groupName(item, t)}</option>)}</Select></label>
  </Confirm>
}

const terminalFonts = [defaults.font, 'Consolas', 'Lucida Console', 'Courier New']

export function SettingsForm({ onThemePreview }: { onThemePreview: (theme: Settings['theme'] | null) => void }) {
  const t = useTranslation()
  const current = useDesk((state) => state.settings)
  const [settings, setSettings] = useState(current)
  const [customFont, setCustomFont] = useState(!terminalFonts.includes(current.font))
  const [notice, setNotice] = useState<'saved' | { error: string } | null>(null)
  const [pending, setPending] = useState(false)
  useEffect(() => {
    setSettings(current)
    setCustomFont(!terminalFonts.includes(current.font))
    onThemePreview(null)
  }, [current, onThemePreview])
  const change = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setNotice(null)
    setSettings((prev) => ({ ...prev, [key]: value }))
  }
  const showError = (error: unknown) => setNotice({ error: errorMessage(error) })
  const numberField = (label: string, key: 'fontSize' | 'stopTimeout' | 'pollInterval' | 'logLimit', min: number, max: number) =>
    <label>{label}<input type="number" value={settings[key] || ''} min={min} max={max} required onChange={(e) => change(key, Number(e.target.value))} /></label>

  return <form className="settings-form" onSubmit={(event) => {
    event.preventDefault()
    if (pending) return
    setPending(true)
    setNotice(null)
    void api().call('settings', settings).then(() => setNotice('saved')).catch(showError).finally(() => setPending(false))
  }}>
    <section className="surface settings-section">
      <h3>{t('常规', 'General')}</h3>
      <div className="field-grid">
        <label>{t('语言', 'Language')}<Select value={settings.language} onChange={(e) => change('language', e.target.value as Settings['language'])}>
          <option value="zh-CN" lang="zh-CN">简体中文</option>
          <option value="en" lang="en">English</option>
        </Select></label>
        <label>{t('主题', 'Theme')}<Select value={settings.theme} disabled={pending} onChange={(e) => {
          const theme = e.target.value as Settings['theme']
          change('theme', theme)
          onThemePreview(theme === current.theme ? null : theme)
        }}>
          <option value="light">{t('浅色', 'Light')}</option>
          <option value="dark">{t('深色', 'Dark')}</option>
          <option value="classic">{t('经典', 'Classic')}</option>
        </Select></label>
        <label>{t('默认 Shell', 'Default shell')}<Select value={settings.shell} onChange={(e) => change('shell', e.target.value as Settings['shell'])}><option value="powershell">PowerShell</option><option value="cmd">CMD</option></Select></label>
        <label>{t('启动页面', 'Start page')}<Select value={settings.startup} onChange={(e) => change('startup', e.target.value as Settings['startup'])}><option value="projects">{t('项目', 'Projects')}</option><option value="last">{t('上次打开的页面', 'Last open page')}</option></Select></label>
        <label className="full-field">{t('默认项目目录', 'Default project folder')}<span className="input-action"><input value={settings.directory} onChange={(e) => change('directory', e.target.value)} placeholder={t('未设置', 'Not set')} /><Button onClick={() => void api().call('chooseDirectory', { path: settings.directory }).then((path) => { if (path) change('directory', path) }).catch(showError)}><FolderOpen size={15} />{t('浏览', 'Browse')}</Button></span></label>
        <label className="full-field">{t('退出 TSManager 时', 'When quitting TSManager')}<Select value={settings.exit} onChange={(e) => change('exit', e.target.value as Settings['exit'])}><option value="stop">{t('停止所有项目', 'Stop all projects')}</option><option value="keep">{t('保留后台项目', 'Keep projects running')}</option></Select></label>
      </div>
    </section>
    <section className="surface settings-section">
      <h3>{t('终端', 'Terminal')}</h3>
      <div className="field-grid">
        <label>{t('终端字体', 'Terminal font')}<Select value={customFont ? '' : settings.font} onChange={(e) => {
          const font = e.target.value
          setCustomFont(font === '')
          change('font', font || (terminalFonts.includes(current.font) ? '' : current.font))
        }}>
          {terminalFonts.map((font) => <option key={font} value={font}>{font}</option>)}
          <option value="">{t('自定义字体', 'Custom font')}</option>
        </Select></label>
        {numberField(t('字号（px）', 'Font size (px)'), 'fontSize', 10, 28)}
        {customFont && <label className="full-field">{t('自定义字体名称', 'Custom font name')}<input value={settings.font} onChange={(e) => change('font', e.target.value)} maxLength={100} required /></label>}
        <label>{t('光标', 'Cursor')}<Select value={settings.cursor} onChange={(e) => change('cursor', e.target.value as Settings['cursor'])}><option value="bar">{t('竖线', 'Bar')}</option><option value="block">{t('方块', 'Block')}</option><option value="underline">{t('下划线', 'Underline')}</option></Select></label>
      </div>
    </section>
    <section className="surface settings-section">
      <h3>{t('进程与日志', 'Processes and logs')}</h3>
      <div className="field-grid">
        {numberField(t('停止超时（毫秒）', 'Stop timeout (ms)'), 'stopTimeout', 500, 15000)}
        {numberField(t('端口扫描间隔（毫秒）', 'Port scan interval (ms)'), 'pollInterval', 1000, 60000)}
        {numberField(t('单项目日志上限（KiB）', 'Log limit per project (KiB)'), 'logLimit', 32, 2048)}
      </div>
    </section>
    <div className="form-actions"><Button className="primary" type="submit" disabled={pending}>{t('保存设置', 'Save settings')}</Button>
      {notice === 'saved' ? <span role="status" className="muted">{t('设置已保存', 'Settings saved')}</span>
        : notice && <span role="alert" className="error-text">{notice.error}</span>}
    </div>
  </form>
}
