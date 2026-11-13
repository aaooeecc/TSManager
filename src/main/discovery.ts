import { access, readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { DiscoveredProject, ProcessIdentity, Project, StopDiscoveredResult } from '../shared/api'
import { listPorts, nodeDirectories, stopNodeProcess, type NodeProcess } from './windows'

type Manifest = { path: string; name?: string; packageManager?: string; scripts?: Record<string, unknown> }
const key = (path: string) => resolve(path).toLowerCase()

async function findProject(directory: string): Promise<Manifest | undefined> {
  let path = await realpath(directory).catch(() => '')
  if (!/^[a-z]:\\/i.test(path) || /(?:^|\\)node_modules(?:\\|$)/i.test(path)) return
  for (;;) {
    const file = join(path, 'package.json')
    try {
      const info = await stat(file)
      if (info.isFile() && info.size < 1024 * 1024) {
        const data = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')) as Partial<Manifest> | null
        if (data && typeof data === 'object' && !Array.isArray(data)) return { ...data, path }
      }
    } catch {}
    const parent = dirname(path)
    if (path === parent) return
    path = parent
  }
}

async function launchCommand(manifest: Manifest) {
  const script = ['dev', 'start', 'serve'].find((name) => typeof manifest.scripts?.[name] === 'string')
  if (!script) return ''
  const has = (file: string) => access(join(manifest.path, file)).then(() => true, () => false)
  let manager = typeof manifest.packageManager === 'string' ? /^(npm|pnpm|yarn)@/.exec(manifest.packageManager)?.[1] : undefined
  if (!manager) manager = await has('pnpm-lock.yaml') ? 'pnpm' : await has('yarn.lock') ? 'yarn' : 'npm'
  return manager + (manager === 'npm' && script === 'start' ? ' ' : ' run ') + script
}

async function findRunningProjects(projects: Project[], excluded: ReadonlySet<number>, included?: ReadonlySet<number>) {
  const nodes = nodeDirectories(excluded, included)
  const found = new Map<string, { manifest: Manifest; processes: NodeProcess[] }>()
  if (!nodes.length) return found
  const manifests = new Map<string, Promise<Manifest | undefined>>()
  function manifest(directory: string) {
    const id = key(directory)
    if (!manifests.has(id)) manifests.set(id, findProject(directory))
    return manifests.get(id)!
  }

  const registered = new Set(projects.map((project) => key(project.path)))
  const registeredRoots = await Promise.all(projects.map((project) => manifest(project.path)))
  for (const root of registeredRoots) if (root) registered.add(key(root.path))

  const nodePaths = await Promise.all(nodes.map(async (process) => ({ process, root: await manifest(process.path) })))
  for (const { process, root } of nodePaths) {
    if (!root || registered.has(key(root.path)) || registered.has(key(process.path))) continue
    const id = key(root.path)
    if (!found.has(id)) found.set(id, { manifest: root, processes: [] })
    found.get(id)!.processes.push(process)
  }
  return found
}

export async function discoverProjects(projects: Project[], excluded: ReadonlySet<number>): Promise<DiscoveredProject[]> {
  const found = await findRunningProjects(projects, excluded)
  if (!found.size) return []
  const owners = listPorts()
  const results = await Promise.all([...found.values()].map(async ({ manifest, processes }) => {
    const identities = processes.map(({ pid, started }) => ({ pid, started })).sort((a, b) => a.pid - b.pid)
    const ports = owners.filter((owner) => identities.some((process) => owner.pid === process.pid && owner.started === process.started))
    return {
      name: (typeof manifest.name === 'string' ? manifest.name.trim() : '').slice(0, 100) || basename(manifest.path).slice(0, 100),
      path: manifest.path,
      command: await launchCommand(manifest),
      ports: [...new Set(ports.map((owner) => owner.port))].sort((a, b) => a - b),
      pids: identities.map((process) => process.pid),
      processes: identities,
    }
  }))
  return results.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
}

export async function stopDiscoveredProject(
  projects: Project[], excluded: () => ReadonlySet<number>, path: string, confirmed: ProcessIdentity[],
): Promise<StopDiscoveredResult> {
  const current = (await findRunningProjects(projects, excluded())).get(key(path))
  const protectedPids = excluded()
  return stopSelectedProcesses(confirmed, current?.processes.filter((process) => !protectedPids.has(process.pid)) ?? [])
}

async function stopSelectedProcesses(confirmed: ProcessIdentity[], available: NodeProcess[]): Promise<StopDiscoveredResult> {
  const byPid = new Map(available.map((process) => [process.pid, process]))
  const result: StopDiscoveredResult = { stopped: [], changed: [], failed: [] }
  const outcomes = await Promise.all(confirmed.map(async ({ pid, started }) => {
    const target = byPid.get(pid)
    const status = target && target.started === started ? await stopNodeProcess(target) : 'changed'
    return { pid, status }
  }))
  for (const { pid, status } of outcomes) result[status].push(pid)
  return result
}

async function matchReportedProcesses(projects: DiscoveredProject[]) {
  const included = new Set(projects.flatMap(({ pids }) => pids))
  if (!included.size) return new Map<string, NodeProcess[]>()
  // The connected worker classifies external projects. Resolve only its reported PIDs.
  const current = await findRunningProjects([], new Set([process.pid]), included)
  return new Map(projects.map(({ path, pids }) => {
    const project = current.get(key(path))
    return [key(path), project?.processes.filter(({ pid }) => pids.includes(pid)) ?? []]
  }))
}

export async function addLegacyProcessIdentities(projects: DiscoveredProject[]): Promise<DiscoveredProject[]> {
  const reported = await matchReportedProcesses(projects)
  return projects.map((project) => ({
    ...project,
    processes: reported.get(key(project.path))?.map(({ pid, started }) => ({ pid, started })) ?? [],
  }))
}

export async function stopLegacyDiscoveredProject(
  projects: DiscoveredProject[], path: string, confirmed: ProcessIdentity[],
): Promise<StopDiscoveredResult> {
  const selected = projects.filter((project) => key(project.path) === key(path))
  const reported = await matchReportedProcesses(selected)
  return stopSelectedProcesses(confirmed, reported.get(key(path)) ?? [])
}
