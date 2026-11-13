# 数据库结构

数据库为 `%APPDATA%\TSManager\tsmanager.sqlite3`，启用 WAL 和外键约束。若需复制整个工作区数据，先关闭 TSManager，并等待后台退出后再复制数据目录。`worker.key` 是后台连接的本机认证密钥。

覆盖安装和重装共用这个数据路径。1.0.3 首次打开旧版数据库时，在一个事务中补齐表结构并将 `PRAGMA user_version` 设为 1。原有项目、分组、设置、运行历史、日志和加密环境变量继续从同一数据库读取。

| 表 | 主要字段与约束 |
| --- | --- |
| `groups` | `id`、`name`、`sort_order`、`created_at`、`updated_at`。固定 ID `default` 的默认分组始终存在。 |
| `projects` | `id`、`group_id`、`name`、`path`、`start_command`、`port`、`shell`、`env`、`env_keys`、`sort_order`、`created_at`、`updated_at`。`group_id` 指向分组，名称在同组内大小写不敏感唯一，`port` 可空。 |
| `run_history` | `id`、`project_id`、`project_name`、`command`、`pid`、`started_at`、`stopped_at`、`exit_code`、`status`、`error`。项目名及启动命令记录运行时快照。 |
| `logs` | `id`、`project_id`、`run_id`、`log_type`、`content`、`size`、`created_at`。按项目和运行记录索引，项目或记录删除时级联清理关联日志。 |
| `settings` | 单行 JSON，固定 `id = 1`，保存常规、终端、进程与日志设置。 |

时间字段保存 UTC ISO 8601 字符串。`env` 为当前 Windows 账号 DPAPI 加密后的 Base64 数据，`env_keys` 保存用于脱敏列表的变量名。

项目实时状态与进程树保存在后台内存中。`run_history.pid` 仅用于历史显示。新后台打开数据库时，会将没有停止时间的旧记录标记为异常退出。重开窗口时，如果原后台仍在，则直接读取它的真实状态。

日志包括终端合并输出、系统事件和运行错误。ConPTY 将标准输出和标准错误合并到同一终端流。持久化日志移除 ANSI 控制序列，应用对常见敏感变量名对应的原始值进行替换。项目命令主动输出的数据仍可出现在实时终端里。每项目持久化日志默认 256 KiB、最多 2,000 段，运行历史通常保留最近 500 条。后台也按单项目上限缓存终端输出，用于切换或重新打开窗口时回放。

删除分组时，项目迁移和分组移除在同一事务内完成。删除项目时保留运行历史和本地项目目录，清理关联日志。
