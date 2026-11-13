import { isAbsolute } from 'node:path'
import { statSync } from 'node:fs'
import type { Language, ProjectInput, Shell, WorkerSettings } from '../shared/api'

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('参数格式无效')
  return value as Record<string, unknown>
}

export function string(value: unknown, label: string, max: number, trim = true): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error(label + '无效')
  return trim ? value.trim() : value
}

export function required(value: unknown, label: string, max: number): string {
  const result = string(value, label, max)
  if (!result) throw new Error('请填写' + label)
  return result
}

export function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(label + '必须为 ' + min + '–' + max + ' 之间的整数')
  }
  return value
}

export function port(value: unknown) { return integer(value, '端口', 1, 65535) }

export function id(value: unknown): string {
  const result = required(value, '记录 ID', 36)
  if (!/^(default|[a-f0-9-]{36})$/.test(result)) throw new Error('记录 ID 无效')
  return result
}

function option<T extends string>(value: unknown, label: string, choices: readonly T[]): T {
  if (!choices.includes(value as T)) throw new Error(label + '无效')
  return value as T
}

export function directory(value: unknown): string {
  const path = required(value, '项目路径', 2048)
  if (!isAbsolute(path) || !statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('请选择存在的本地项目目录')
  }
  return path
}

export function discoveredSelection(value: unknown) {
  const args = record(value)
  const path = directory(args.path)
  if (!Array.isArray(args.processes) || !args.processes.length) throw new Error('请选择要结束的进程')
  const processes = args.processes.map((item) => {
    const entry = record(item)
    const pid = integer(entry.pid, 'PID', 1, 0xffffffff)
    const started = required(entry.started, '启动时间', 20)
    if (!/^\d+$/.test(started)) throw new Error('进程启动时间无效')
    return { pid, started }
  })
  if (new Set(processes.map((item) => item.pid)).size !== processes.length) throw new Error('进程列表包含重复 PID')
  return { path, processes }
}

export function projectInput(value: unknown): ProjectInput {
  const input = record(value)
  const env: Record<string, string> = Object.create(null)
  const keys = new Set<string>()
  if (input.env !== undefined) {
    const entries = Object.entries(record(input.env))
    if (entries.length > 100) throw new Error('最多可配置 100 个环境变量')
    for (const [key, value] of entries) {
      if (!/^[a-z_][a-z0-9_]{0,127}$/i.test(key) || keys.has(key.toLowerCase())) {
        throw new Error('环境变量名称无效或重复')
      }
      keys.add(key.toLowerCase())
      env[key] = string(value, '环境变量值', 8192, false)
    }
  }
  return {
    name: required(input.name, '项目名称', 100),
    path: directory(input.path),
    command: required(input.command, '启动命令', 12000),
    groupId: id(input.groupId),
    port: input.port === null ? null : port(input.port),
    shell: option<Shell>(input.shell, 'Shell', ['powershell', 'cmd']),
    env: input.env === undefined ? undefined : env,
  }
}

export function language(value: unknown): Language {
  return option(value, '界面语言', ['zh-CN', 'en'])
}

export function settings(value: unknown): WorkerSettings {
  const input = record(value)
  const path = string(input.directory, '默认项目目录', 2048)
  return {
    shell: option(input.shell, 'Shell', ['powershell', 'cmd']),
    directory: path ? directory(path) : '',
    startup: option(input.startup, '启动页面', ['projects', 'last']),
    exit: option(input.exit, '退出行为', ['stop', 'keep']),
    font: required(input.font, '终端字体', 100),
    fontSize: integer(input.fontSize, '字体大小', 10, 28),
    theme: option(input.theme, '主题', ['dark', 'light']),
    cursor: option(input.cursor, '光标', ['block', 'bar', 'underline']),
    stopTimeout: integer(input.stopTimeout, '停止超时', 500, 15000),
    pollInterval: integer(input.pollInterval, '扫描间隔', 1000, 60000),
    logLimit: integer(input.logLimit, '日志上限', 32, 2048),
  }
}
