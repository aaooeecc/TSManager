import type { Language } from './api'

const englishMessages = new Map([
  ['参数格式无效', 'Invalid request parameters'],
  ['后台连接已关闭', 'The backend connection is closed'],
  ['后台连接已断开', 'Disconnected from the backend'],
  ['无法连接 TSManager 后台，请重新启动应用', 'Unable to connect to the TSManager backend. Restart the app and try again.'],
  ['旧版后台仍有项目在运行。停止这些项目后可自动切换新版后台。', 'An older backend still has running projects. The backend will upgrade after these projects stop.'],
  ['旧版后台连接已断开，请重试', 'Disconnected from the older backend. Try again.'],
  ['另一个旧版窗口重新启动了后台，请关闭该窗口后重试', 'Another window using an older version restarted the backend. Close that window and try again.'],
  ['当前后台版本暂不支持项目识别', 'This backend version does not support project discovery'],
  ['后台操作超时', 'The backend operation timed out'],
  ['上次后台进程意外退出', 'The backend process exited unexpectedly'],
  ['本地数据库需要更新版本的 TSManager', 'The local database requires a newer version of TSManager'],
  ['项目不存在', 'Project not found'],
  ['分组不存在', 'Group not found'],
  ['分组名称已存在', 'A group with that name already exists'],
  ['请选择其他目标分组。默认分组必须保留', 'Choose a different destination group. The default group must be kept.'],
  ['目标分组中有同名项目，请先重命名', 'A project in the destination group already uses that name. Rename it first.'],
  ['此分组已有同名项目', 'A project with that name already exists in this group'],
  ['项目列表已更新，请刷新后重试', 'The project list changed. Refresh and try again.'],
  ['TSManager 正在退出', 'TSManager is shutting down'],
  ['请求来自未授权页面', 'The request came from an unauthorized page'],
  ['全屏参数无效', 'Invalid fullscreen setting'],
  ['未知的操作', 'Unknown operation'],
  ['请选择存在的本地项目目录', 'Choose an existing local project folder'],
  ['请选择要结束的进程', 'Choose a process to end'],
  ['进程启动时间无效', 'Invalid process start time'],
  ['进程列表包含重复 PID', 'The process list contains duplicate PIDs'],
  ['最多可配置 100 个环境变量', 'You can configure up to 100 environment variables'],
  ['环境变量名称无效或重复', 'Invalid or duplicate environment variable name'],
  ['项目顺序无效', 'Invalid project order'],
  ['请先停止项目，再修改路径、命令、端口、Shell 或环境变量', 'Stop the project before changing its folder, command, port, shell, or environment variables.'],
  ['请先停止项目', 'Stop the project first'],
  ['未知的后台操作', 'Unknown backend operation'],
  ['旧版后台有项目正在启动或运行，请稍后重试。', 'An older backend has projects starting or running. Try again later.'],
  ['正在停止所有项目', 'Stopping all projects'],
  ['项目已经在运行', 'The project is already running'],
  ['等待终端退出超时', 'Timed out waiting for the terminal to exit'],
  ['端口进程已变化或属于 TSManager 管理', 'The process using this port has changed or is managed by TSManager'],
  ['仅接受本机地址的请求', 'Only requests from this computer are accepted'],
  ['网页服务正在关闭', 'The web workspace is shutting down'],
  ['请求来源无效', 'Invalid request origin'],
  ['网页会话已失效', 'The web session has expired'],
  ['请求格式无效', 'Invalid request format'],
  ['该进程正在提供 TSManager 网页服务', 'This process hosts the TSManager web workspace'],
  ['页面不存在', 'Page not found'],
  ['页面资源不存在', 'Page asset not found'],
  ['网页服务请求失败', 'Web workspace request failed'],
  ['创建项目进程组失败', 'Unable to create the project process group'],
  ['设置进程组清理策略失败', 'Unable to configure process group cleanup'],
  ['无法取得终端进程句柄', 'Unable to open a handle to the terminal process'],
  ['无法隔离项目进程树', 'Unable to isolate the project process tree'],
  ['无法读取项目进程树', 'Unable to read the project process tree'],
  ['项目进程树超过查询上限', 'The project process tree is too large to query'],
  ['无法终止项目进程树', 'Unable to end the project process tree'],
  ['项目进程尚未全部退出', 'Some project processes are still running'],
  ['无法访问当前 Windows 账号的加密数据', 'Unable to access encrypted data for the current Windows account'],
  ['无法验证旧版后台', 'Unable to verify the older backend'],
  ['无法识别旧版后台进程', 'Unable to identify the older backend process'],
  ['无法访问旧版后台进程', 'Unable to access the older backend process'],
  ['无法安全更新旧版后台', 'Unable to safely update the older backend'],
  ['无法更新旧版后台', 'Unable to update the older backend'],
  ['无法确认旧版后台已退出', 'Unable to verify that the older backend exited'],
  ['等待旧版后台退出超时', 'Timed out waiting for the older backend to exit'],
  ['无法识别当前 Windows 会话', 'Unable to identify the current Windows session'],
  ['无法扫描本机进程', 'Unable to scan local processes'],
  ['无法读取本机进程列表', 'Unable to read the local process list'],
  ['读取 TCP 监听端口失败', 'Unable to read listening TCP ports'],
  ['没有权限终止该进程，或该进程已退出', 'Permission denied or the process has already exited'],
  ['端口占用进程已变化或属于受保护进程，请刷新后重试', 'The process using this port has changed or is protected. Refresh and try again.'],
  ['终止进程失败', 'Unable to end the process'],
])

const englishFields = new Map([
  ['记录 ID', 'record ID'], ['项目路径', 'project folder'], ['PID', 'PID'], ['端口', 'port'],
  ['环境变量值', 'environment variable value'], ['项目名称', 'project name'], ['启动命令', 'start command'],
  ['启动时间', 'start time'], ['分组名称', 'group name'], ['默认项目目录', 'default project folder'],
  ['目录', 'folder'], ['Shell', 'shell'], ['启动页面', 'startup page'], ['退出行为', 'exit behavior'],
  ['界面语言', 'interface language'], ['终端字体', 'terminal font'], ['字体大小', 'font size'], ['主题', 'theme'],
  ['光标', 'cursor'], ['停止超时', 'stop timeout'], ['扫描间隔', 'scan interval'], ['日志上限', 'log limit'],
  ['终端列数', 'terminal column count'], ['终端行数', 'terminal row count'], ['终端输入', 'terminal input'],
])

// Older workers and stored run history use the original Chinese messages.
export function localizeMessage(language: Language, message: string): string {
  if (language !== 'en') return message
  const translated = englishMessages.get(message)
  if (translated) return translated

  const windows = /^(.*)（Windows (\d+)）$/.exec(message)
  if (windows && englishMessages.has(windows[1])) return englishMessages.get(windows[1]) + ' (Windows ' + windows[2] + ')'

  const invalid = /^(.*?)\s*无效$/.exec(message)
  const invalidField = invalid && englishFields.get(invalid[1])
  if (invalidField) return 'Invalid ' + invalidField
  const missing = /^请填写(.+)$/.exec(message)
  const missingField = missing && englishFields.get(missing[1])
  if (missingField) return 'Enter a value for ' + missingField
  const range = /^(.+)必须为 (\d+)–(\d+) 之间的整数$/.exec(message)
  const rangeField = range && englishFields.get(range[1])
  if (range && rangeField) return 'Enter a whole number from ' + range[2] + ' to ' + range[3] + ' for ' + rangeField

  const conflict = /^端口 (\d+) 已被 (.*) 占用（PID (\d+)）$/.exec(message)
  if (conflict) return 'Port ' + conflict[1] + ' is in use by ' + (conflict[2] === '其他进程' ? 'another process' : conflict[2]) + ' (PID ' + conflict[3] + ')'
  const unavailable = /^端口 (\d+) 无法监听（(.*)）$/.exec(message)
  if (unavailable) return 'Unable to listen on port ' + unavailable[1] + ' (' + (unavailable[2] === '未知错误' ? 'unknown error' : unavailable[2]) + ')'
  const reserved = /^端口 (\d+) 已由项目 (.*) 预留$/.exec(message)
  if (reserved) return 'Port ' + reserved[1] + ' is reserved by project ' + reserved[2]
  const listening = /^项目进程已退出，但端口 (\d+) 尚未释放$/.exec(message)
  if (listening) return 'The project process exited, but port ' + listening[1] + ' is still in use'
  const exited = /^进程退出，退出码 (-?\d+)$/.exec(message)
  if (exited) return 'Process exited with code ' + exited[1]
  return message
}
