import koffi from 'koffi'
import { basename, resolve } from 'node:path'
import type { Port, ProcessIdentity } from '../shared/api'

const kernel = koffi.load('kernel32.dll')
const ip = koffi.load('iphlpapi.dll')
const crypt = koffi.load('crypt32.dll')
const createJob = kernel.func('void *CreateJobObjectW(void *attributes, void *name)')
const setJob = kernel.func('int SetInformationJobObject(void *job, int kind, void *info, uint32_t size)')
const assign = kernel.func('int AssignProcessToJobObject(void *job, void *process)')
const queryJob = kernel.func('int QueryInformationJobObject(void *job, int kind, void *info, uint32_t size, void *written)')
const killJob = kernel.func('int TerminateJobObject(void *job, uint32_t code)')
const open = kernel.func('void *OpenProcess(uint32_t access, int inherit, uint32_t pid)')
const close = kernel.func('int CloseHandle(void *handle)')
const terminate = kernel.func('int TerminateProcess(void *handle, uint32_t code)')
const waitForExit = kernel.func('uint32_t WaitForSingleObject(void *handle, uint32_t milliseconds)')
const lastError = kernel.func('uint32_t GetLastError()')
const imageName = kernel.func('int QueryFullProcessImageNameW(void *handle, uint32_t flags, void *name, void *size)')
const processTimes = kernel.func('int GetProcessTimes(void *handle, void *created, void *exit, void *kernelTime, void *userTime)')
const snapshotProcesses = kernel.func('void *CreateToolhelp32Snapshot(uint32_t flags, uint32_t pid)')
const firstProcess = kernel.func('int Process32FirstW(void *snapshot, void *entry)')
const nextProcess = kernel.func('int Process32NextW(void *snapshot, void *entry)')
const processSession = kernel.func('int ProcessIdToSessionId(uint32_t pid, void *session)')
const readMemory = kernel.func('int ReadProcessMemory(void *process, uintptr_t address, void *data, size_t size, void *bytesRead)')
const openFile = kernel.func('void *CreateFileW(void *name, uint32_t access, uint32_t sharing, void *security, uint32_t disposition, uint32_t flags, void *templateFile)')
const pipeServerPid = kernel.func('int GetNamedPipeServerProcessId(void *pipe, void *pid)')
const critical = kernel.func('int IsProcessCritical(void *handle, void *isCritical)')
const tcpTable = ip.func('uint32_t GetExtendedTcpTable(void *table, void *size, int order, uint32_t family, int kind, uint32_t reserved)')
const blob = koffi.struct('DataBlob', { size: 'uint32_t', data: 'void *' })
const protect = crypt.func('int CryptProtectData(DataBlob *input, void *description, void *entropy, void *reserved, void *prompt, uint32_t flags, _Out_ DataBlob *output)')
const unprotect = crypt.func('int CryptUnprotectData(DataBlob *input, void *description, void *entropy, void *reserved, void *prompt, uint32_t flags, _Out_ DataBlob *output)')
const localFree = kernel.func('void *LocalFree(void *address)')
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
type Handle = NonNullable<ReturnType<typeof open>>

function winError(message: string) { return new Error(message + '（Windows ' + lastError() + '）') }

export class Job {
  private handle: Handle | null

  constructor() {
    const job = createJob(null, null)
    if (!job) throw winError('创建项目进程组失败')
    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION, x64. LimitFlags follows two LARGE_INTEGERs.
    const limits = Buffer.alloc(144)
    limits.writeUInt32LE(0x2000, 16) // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (!setJob(job, 9, limits, limits.length)) {
      const error = winError('设置进程组清理策略失败')
      close(job)
      throw error
    }
    this.handle = job
  }

  add(pid: number) {
    // PROCESS_TERMINATE | PROCESS_SET_QUOTA, required by AssignProcessToJobObject.
    const handle = open(0x101, 0, pid)
    if (!handle) throw winError('无法取得终端进程句柄')
    try {
      if (!assign(this.handle, handle)) throw winError('无法隔离项目进程树')
    } finally { close(handle) }
  }

  pids(): number[] {
    if (!this.handle) return []
    let size = 32
    while (size <= 8 + 65536 * 8) {
      const data = Buffer.alloc(8 + size * 8)
      if (queryJob(this.handle, 3, data, data.length, null)) {
        return Array.from({ length: data.readUInt32LE(4) }, (_, index) => Number(data.readBigUInt64LE(8 + index * 8)))
      }
      if (lastError() !== 234) throw winError('无法读取项目进程树')
      size *= 2
    }
    throw new Error('项目进程树超过查询上限')
  }

  terminate() {
    if (this.handle && !killJob(this.handle, 1)) throw winError('无法终止项目进程树')
  }

  async drain() {
    if (!this.pids().length) return
    this.terminate()
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!this.pids().length) return
      await delay(30)
    }
    throw new Error('项目进程尚未全部退出')
  }

  close() {
    if (this.handle) close(this.handle)
    this.handle = null
  }
}

function dpapi(value: Buffer, encrypt: boolean) {
  const output: { data?: Handle; size?: number } = {}
  const success = (encrypt ? protect : unprotect)({ size: value.length, data: value }, null, null, null, null, 1, output)
  if (!success || !output.data || output.size === undefined) throw winError('无法访问当前 Windows 账号的加密数据')
  try { return Buffer.from(koffi.decode(output.data, 'uint8_t', output.size)) }
  finally { localFree(output.data) }
}
export function encryptEnv(value: Record<string, string>) {
  return dpapi(Buffer.from(JSON.stringify(value), 'utf8'), true).toString('base64')
}
export function decryptEnv(value: string): Record<string, string> {
  return value ? JSON.parse(dpapi(Buffer.from(value, 'base64'), false).toString('utf8')) : {}
}

function processName(handle: Handle) {
  const pathBuffer = Buffer.alloc(32768 * 2)
  const chars = Buffer.alloc(4)
  chars.writeUInt32LE(32768)
  return imageName(handle, 0, pathBuffer, chars)
    ? basename(pathBuffer.toString('utf16le', 0, chars.readUInt32LE() * 2))
    : ''
}

function startedAt(handle: Handle) {
  const times = Buffer.alloc(32)
  return processTimes(handle, times.subarray(0, 8), times.subarray(8, 16), times.subarray(16, 24), times.subarray(24))
    ? times.readBigUInt64LE(0).toString() : ''
}

function identity(handle: Handle) {
  const name = processName(handle)
  const started = startedAt(handle)
  const flag = Buffer.alloc(4)
  const terminable = Boolean(name && started && critical(handle, flag) && !flag.readUInt32LE() && !/^(tsmanager|electron)\.exe$/i.test(name))
  return { name, started, terminable }
}

export function openWorkerFromPipe(pipe: string) {
  // Open a client handle to the authenticated TSManager endpoint and keep its process handle.
  const connection = openFile(Buffer.from(pipe + '\0', 'utf16le'), 0xc0000000, 0, null, 3, 0, null)
  if (!connection || koffi.address(connection) === 0xffffffffffffffffn) {
    throw winError('无法验证旧版后台')
  }
  const pidBuffer = Buffer.alloc(4)
  try {
    if (!pipeServerPid(connection, pidBuffer)) throw winError('无法识别旧版后台进程')
  } finally { close(connection) }

  const pid = pidBuffer.readUInt32LE()
  const handle = pid !== process.pid && open(0x101001, 0, pid) // SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE
  if (!handle) throw winError('无法访问旧版后台进程')
  const flag = Buffer.alloc(4)
  if (!/^(electron|tsmanager)\.exe$/i.test(processName(handle)) || !critical(handle, flag) || flag.readUInt32LE()) {
    close(handle)
    throw new Error('无法安全更新旧版后台')
  }
  return {
    async retire() {
      if (waitForExit(handle, 0) === 0) return
      if (!terminate(handle, 1) && waitForExit(handle, 0) !== 0) throw winError('无法更新旧版后台')
      for (let attempt = 0; attempt < 100; attempt++) {
        const status = waitForExit(handle, 0)
        if (status === 0) return
        if (status !== 258) throw winError('无法确认旧版后台已退出')
        await delay(50)
      }
      throw new Error('等待旧版后台退出超时')
    },
    close: () => close(handle),
  }
}

function loadProcessQuery() {
  try {
    return koffi.load('ntdll.dll').func('int NtQueryInformationProcess(void *process, int kind, void *data, uint32_t size, void *written)')
  } catch {
    return undefined
  }
}
const queryProcess = loadProcessQuery()
const nodeExe = /^node\.exe$/i
export type NodeProcess = ProcessIdentity & { path: string }

function readRemote(handle: Handle, address: bigint, size: number) {
  if (!address) return
  const data = Buffer.alloc(size)
  if (readMemory(handle, address, data, data.length, null)) return data
}

function processDirectory(handle: Handle) {
  if (!queryProcess) return
  const wow64 = Buffer.alloc(8)
  if (queryProcess(handle, 26, wow64, wow64.length, null) !== 0) return
  const peb32 = wow64.readBigUInt64LE()
  const pointer = (data: Buffer, offset = 0) => peb32 ? BigInt(data.readUInt32LE(offset)) : data.readBigUInt64LE(offset)
  let peb = peb32
  if (!peb) {
    const basic = Buffer.alloc(48)
    if (queryProcess(handle, 0, basic, basic.length, null) !== 0) return
    peb = basic.readBigUInt64LE(8)
  }
  // PEB.ProcessParameters and RTL_USER_PROCESS_PARAMETERS.CurrentDirectory.DosPath.
  // These offsets differ for native x64 and WOW64 processes.
  const parameters = readRemote(handle, peb + BigInt(peb32 ? 0x10 : 0x20), peb32 ? 4 : 8)
  if (!parameters) return
  const current = readRemote(handle, pointer(parameters) + BigInt(peb32 ? 0x24 : 0x38), peb32 ? 8 : 16)
  if (!current) return
  const length = current.readUInt16LE()
  if (!length || length > 4096 || length % 2 || length > current.readUInt16LE(2)) return
  const path = readRemote(handle, pointer(current, peb32 ? 4 : 8), length)?.toString('utf16le')
  if (path && !path.includes('\0') && /^[a-z]:\\/i.test(path)) return path
}

export function nodeDirectories(excluded: ReadonlySet<number>, included?: ReadonlySet<number>) {
  const session = Buffer.alloc(4)
  if (!processSession(process.pid, session)) throw winError('无法识别当前 Windows 会话')
  const sessionId = session.readUInt32LE()
  const snapshot = snapshotProcesses(2, 0) // TH32CS_SNAPPROCESS
  if (!snapshot || koffi.address(snapshot) === 0xffffffffffffffffn) throw winError('无法扫描本机进程')
  const result: NodeProcess[] = []
  try {
    // PROCESSENTRY32W on x64. szExeFile follows dwFlags at byte 44.
    const entry = Buffer.alloc(568)
    entry.writeUInt32LE(entry.length)
    if (!firstProcess(snapshot, entry)) throw winError('无法读取本机进程列表')
    do {
      const pid = entry.readUInt32LE(8)
      const name = entry.toString('utf16le', 44, 564).split('\0', 1)[0]
      if (excluded.has(pid) || (included && !included.has(pid)) || !nodeExe.test(name) ||
        !processSession(pid, session) || session.readUInt32LE() !== sessionId) continue
      const handle = open(0x410, 0, pid) // PROCESS_QUERY_INFORMATION | PROCESS_VM_READ
      if (!handle) continue
      try {
        if (!nodeExe.test(processName(handle))) continue
        const path = processDirectory(handle)
        const started = startedAt(handle)
        if (path && started) result.push({ pid, path, started })
      } finally { close(handle) }
    } while (nextProcess(snapshot, entry))
  } finally { close(snapshot) }
  return result
}

export async function stopNodeProcess(target: NodeProcess): Promise<'stopped' | 'changed' | 'failed'> {
  // SYNCHRONIZE | PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | PROCESS_TERMINATE
  const handle = open(0x100411, 0, target.pid)
  if (!handle) return lastError() === 87 ? 'changed' : 'failed'
  try {
    if (waitForExit(handle, 0) === 0) return 'changed'
    const current = identity(handle)
    if (current.started !== target.started || !nodeExe.test(current.name)) return 'changed'
    if (!current.terminable) return 'failed'
    const directory = processDirectory(handle)
    if (!directory || resolve(directory).toLowerCase() !== resolve(target.path).toLowerCase()) return 'changed'
    if (!terminate(handle, 1)) return waitForExit(handle, 0) === 0 ? 'changed' : 'failed'
    for (let attempt = 0; attempt < 60; attempt++) {
      const status = waitForExit(handle, 0)
      if (status === 0) return 'stopped'
      if (status !== 258) break // WAIT_TIMEOUT
      await delay(35)
    }
    return 'failed'
  } finally { close(handle) }
}

function lookup(pid: number) {
  const handle = open(0x1000, 0, pid) // PROCESS_QUERY_LIMITED_INFORMATION
  if (!handle) return { name: '', started: '', terminable: false }
  try { return identity(handle) } finally { close(handle) }
}

function listeners() {
  const result: Pick<Port, 'port' | 'pid' | 'address'>[] = []
  for (const family of [2, 23]) {
    const size = Buffer.alloc(4)
    tcpTable(null, size, 0, family, 3, 0) // TCP_TABLE_OWNER_PID_LISTENER
    let data = Buffer.alloc(size.readUInt32LE())
    let code = tcpTable(data, size, 0, family, 3, 0)
    for (let retry = 0; retry < 3 && code === 122; retry++) {
      data = Buffer.alloc(size.readUInt32LE())
      code = tcpTable(data, size, 0, family, 3, 0)
    }
    if (family === 23 && code === 50) continue
    if (code !== 0) throw new Error('读取 TCP 监听端口失败（Windows ' + code + '）')
    const ipv4 = family === 2
    const rowSize = ipv4 ? 24 : 56
    for (let index = 0; index < data.readUInt32LE(); index++) {
      const row = data.subarray(4 + index * rowSize)
      const port = row.readUInt16BE(ipv4 ? 8 : 20)
      const pid = row.readUInt32LE(ipv4 ? 20 : 52)
      const address = ipv4 ? [...row.subarray(4, 8)].join('.') :
        row.subarray(0, 16).every((byte) => byte === 0) ? '::' :
        Array.from({ length: 8 }, (_, i) => row.readUInt16BE(i * 2).toString(16)).join(':')
      result.push({ port, pid, address })
    }
  }
  return result
}

export function listPorts(port?: number): Port[] {
  const identities = new Map<number, ReturnType<typeof lookup>>()
  return listeners().filter((row) => !port || row.port === port).map((row) => {
    if (!identities.has(row.pid)) identities.set(row.pid, lookup(row.pid))
    return { ...row, ...identities.get(row.pid)! }
  }).sort((a, b) => a.port - b.port || a.pid - b.pid)
}

export function stopExternalPort(port: number, pid: number, started: string) {
  const handle = open(0x1001, 0, pid)
  if (!handle) throw winError('没有权限终止该进程，或该进程已退出')
  try {
    const current = identity(handle)
    if (!current.terminable || current.started !== started || !listeners().some((row) => row.port === port && row.pid === pid)) {
      throw new Error('端口占用进程已变化或属于受保护进程，请刷新后重试')
    }
    if (!terminate(handle, 1)) throw winError('终止进程失败')
  } finally { close(handle) }
}
