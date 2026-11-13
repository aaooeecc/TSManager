import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openWorkerFromPipe } from './windows'

export async function retireLegacyWorker(folder: string, pipe: string, verify: () => Promise<void>) {
  const worker = openWorkerFromPipe(pipe)
  try {
    // Recheck the authenticated connection after obtaining the server's process handle.
    await verify()
    const db = new DatabaseSync(join(folder, 'tsmanager.sqlite3'))
    try {
      db.exec('PRAGMA busy_timeout = 400; BEGIN IMMEDIATE')
      try {
        // The old worker must insert a run record before it can launch a project.
        if (db.prepare('SELECT 1 FROM run_history WHERE stopped_at IS NULL LIMIT 1').get()) {
          throw new Error('旧版后台有项目正在启动或运行，请稍后重试。')
        }
        await worker.retire()
      } finally { db.exec('ROLLBACK') }
    } finally { db.close() }
  } finally { worker.close() }
}
