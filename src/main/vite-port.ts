import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Project } from '../shared/api'

type Word = { value: string; start: number }

function simpleWords(source: string): Word[] {
  if (/[\r\n]/.test(source)) return []
  const words: Word[] = []
  let end = 0
  for (const match of source.matchAll(/"([^"]*)"|'([^']*)'|([^\s"';&|<>^#()\x60]+)/g)) {
    const start = match.index
    if (source.slice(end, start).trim() || (words.length > 0 && start === end)) return []
    words.push({ value: match[1] ?? match[2] ?? match[3], start })
    end = start + match[0].length
  }
  return source.slice(end).trim() ? [] : words
}

const executable = (word?: Word) => basename(word?.value ?? '').replace(/\.(?:cmd|bat|exe|ps1)$/i, '').toLowerCase()

function viteArgs(words: Word[]): Word[] | undefined {
  const command = executable(words[0])
  if (command === 'vite') return words.slice(1)
  if (command === 'node' && /(?:^|[\\/])vite[\\/]bin[\\/]vite\.[cm]?js$/i.test(words[1]?.value ?? '')) return words.slice(2)
  if (command === 'cross-env') {
    const index = words.findIndex((word, index) => index > 0 && !/^[a-z_]\w*=/i.test(word.value))
    if (index > 0) return viteArgs(words.slice(index))
  }
}

function servesVite(args: Word[]) {
  if (args.some(({ value }) => /^(?:--help|-h|--version|-v)$/.test(value))) return false
  const valueOptions = new Set(['-c', '--config', '--base', '-l', '--logLevel', '--configLoader',
    '-d', '--debug', '-f', '--filter', '-m', '--mode', '--host', '--port', '--open', '--outDir'])
  for (let index = 0; index < args.length; index++) {
    const { value } = args[index]
    if (!value.startsWith('-')) return !/^(?:build|optimize|inspect)$/.test(value)
    if (valueOptions.has(value) && args[index + 1] && !args[index + 1].value.startsWith('-')) index++
  }
  return true
}

function hasConfiguredPort(args: Word[], port: number) {
  let selected: string | undefined
  let strict = false
  for (let index = 0; index < args.length; index++) {
    const { value } = args[index]
    if (value === '--port') selected = args[++index]?.value
    else if (value.startsWith('--port=')) selected = value.slice('--port='.length)
    if (value === '--strictPort' || value === '--strictPort=true') strict = true
    else if (value === '--no-strictPort' || value === '--strictPort=false') strict = false
  }
  return selected === String(port) && strict
}

function packageScript(path: string, name: string): Word[] {
  try {
    const source = readFileSync(join(path, 'package.json'), 'utf8').replace(/^\uFEFF/, '')
    const value: unknown = JSON.parse(source)?.scripts?.[name]
    return typeof value === 'string' ? simpleWords(value) : []
  } catch { return [] }
}

export function vitePortCommand(project: Pick<Project, 'command' | 'path' | 'port'>): string {
  const { command, path, port } = project
  if (port === null) return command
  const words = simpleWords(command)
  const manager = executable(words[0])
  const action = words[1]?.value
  let invocation = viteArgs(words)
  let forwarded: Word[] = []
  let separator = ''

  if (!invocation && manager === 'npx') invocation = viteArgs(words.slice(1))
  if (!invocation && ['npm', 'pnpm', 'yarn', 'bun'].includes(manager)) {
    const subcommand = action === 'run' || (manager === 'npm' && action === 'run-script')
    if (action === 'exec') {
      const index = words[2]?.value === '--' ? 3 : manager === 'npm' ? -1 : 2
      if (index >= 0) invocation = viteArgs(words.slice(index))
    } else if (subcommand || manager !== 'npm' || action === 'start') {
      const scriptIndex = subcommand ? 2 : 1
      const script = words[scriptIndex]?.value
      if (script && !script.startsWith('-')) {
        invocation = viteArgs(packageScript(path, script))
        if (invocation) {
          if (invocation.some(({ value }) => value === '--')) return command
          forwarded = words.slice(scriptIndex + 1)
          if (manager === 'npm') {
            const delimiter = forwarded.findIndex(({ value }) => value === '--')
            if (delimiter === -1) {
              forwarded = []
              separator = ' --'
            } else {
              forwarded = forwarded.slice(delimiter + 1)
            }
          }
        } else if (!subcommand && manager !== 'npm') {
          invocation = viteArgs(words.slice(1))
        }
      }
    }
  }

  if (!invocation) return command
  const args = [...invocation, ...forwarded]
  const delimiter = args.findIndex(({ value }) => value === '--')
  const options = delimiter < 0 ? args : args.slice(0, delimiter)
  if (!servesVite(options) || hasConfiguredPort(options, port)) return command
  const split = delimiter < 0 ? command.length : args[delimiter].start
  const prefix = command.slice(0, split).trimEnd()
  const suffix = command.slice(split)
  return prefix + separator + ' --port ' + port + ' --strictPort' + (suffix ? ' ' + suffix : '')
}
