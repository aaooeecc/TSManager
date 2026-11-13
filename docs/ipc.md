# IPC 接口

在渲染进程使用 `window.tsmanager.call(method, input)` 和 `window.tsmanager.onNotice(callback)`。类型定义见 `src/shared/api.ts`。无参数方法传入 `null`。返回值均为 Promise，失败时以可显示的错误消息拒绝。

| 方法 | 参数 | 结果 |
| --- | --- | --- |
| `snapshot` | `null` | 项目、分组、运行状态和设置 |
| `saveProject` | `{ id?, project }` | 新建或更新的项目。`env` 省略时保留原变量。 |
| `deleteProject` | `{ id }` | 删除已停止项目的管理记录 |
| `reorderProjects` | `{ ids }` | 保存完整项目 ID 顺序 |
| `saveGroup` | `{ id?, name }` | 新建或更新后的分组 |
| `deleteGroup` | `{ id, targetId }` | 将项目迁移到目标分组并删除原分组 |
| `projectEnv` | `{ id }` | 供环境变量编辑使用的键值 |
| `start`、`restart` | `{ id, cols?, rows? }` | 创建或重启项目终端 |
| `stop` | `{ id }` | 等待项目退出及进程树清理 |
| `stopAll` | `null` | 等待所有受管理项目停止 |
| `terminal` | `{ id }` | 最近终端数据及递增序号 |
| `write`、`resize` | `{ id, data }` 或 `{ id, cols, rows }` | 输入终端数据或调整真实 PTY 尺寸 |
| `interrupt`、`clearTerminal` | `{ id }` | 发送 Ctrl+C 或清空终端回放 |
| `logs`、`clearLogs` | `{ id, runId? }` 或 `{ id }` | 读取项目或指定运行的日志，或者清空项目日志 |
| `history` | `null` | 最近运行记录 |
| `ports`、`checkPort` | `null` 或 `{ port }` | TCP 监听地址、PID、进程名、可确认的项目归属 |
| `discoverProjects` | `null` | 当前 Windows 会话内尚未登记的 Node.js 项目目录、建议启动命令、PID 与 TCP 监听端口 |
| `stopDiscoveredProject` | `{ path, processes: [{ pid, started }] }` | 复核目录、PID、启动时间和归属后终止所选外部 Node 进程，返回已结束、已变化及失败的 PID |
| `stopPort` | `{ port, pid, started }` | 重新核对端口、PID 和进程创建时间，终止确认的外部进程 |
| `settings` | 完整 `Settings` | 验证并保存后的设置 |
| `chooseDirectory` | `{ path? }` | 文件夹路径或 `null` |
| `openPort` | `{ port }` | 在默认浏览器打开 `http://localhost:<port>` |
| `openFolder` | `{ id }` | 在文件管理器打开项目目录 |
| `openWeb` | `null` | 在默认浏览器打开已授权的本机网页工作区 |
| `fullscreen` | `{ value }` | 切换终端全屏 |

订阅事件会返回解除订阅函数。

- `changed` 表示配置或历史有更新，可重新读取快照。
- `status` 携带项目 ID、状态、PID 和运行记录 ID。终止后的状态为已停止或异常。
- `output` 携带项目 ID、序号、输出文本和可选的 `reset`。先订阅，再取得 `terminal` 回放，通过序号去重。
- `connection` 表示主进程与本机后台的连接状态。

主进程校验请求来自当前受信任窗口的主 frame，并只分派白名单方法。后台校验参数、项目 ID、活跃实例和端口进程归属。命名管道使用随机挑战及 HMAC 双向认证。
