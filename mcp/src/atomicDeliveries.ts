import { createHash } from 'node:crypto'
import { access, rename, rm } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'

export interface StagedDelivery {
  finalPath: string
  stagedPath: string
}

function compactDeliveryId(finalPath: string, token: string): string {
  return createHash('sha256')
    .update(token)
    .update('\0')
    .update(finalPath)
    .digest('hex')
    .slice(0, 20)
}

export function stagedDeliveryPath(finalPath: string, token: string): string {
  const id = compactDeliveryId(finalPath, token)
  return join(dirname(finalPath), `.stemstudio-${id}.partial${extname(finalPath)}`)
}

function backupDeliveryPath(finalPath: string, token: string): string {
  const id = compactDeliveryId(finalPath, token)
  return join(dirname(finalPath), `.stemstudio-${id}.backup${extname(finalPath)}`)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function promoteStagedDeliveries(
  deliveries: StagedDelivery[],
  token: string,
  checkCancelled: () => void = () => {}
): Promise<void> {
  const backups: Array<{ finalPath: string; backupPath: string }> = []
  const promoted: string[] = []
  let complete = false
  try {
    for (const delivery of deliveries) {
      checkCancelled()
      const backupPath = backupDeliveryPath(delivery.finalPath, token)
      await rm(backupPath, { force: true })
      if (await exists(delivery.finalPath)) {
        await rename(delivery.finalPath, backupPath)
        backups.push({ finalPath: delivery.finalPath, backupPath })
      }
      await rename(delivery.stagedPath, delivery.finalPath)
      promoted.push(delivery.finalPath)
    }
    checkCancelled()
    complete = true
  } finally {
    if (!complete) {
      for (const finalPath of promoted.reverse()) {
        await rm(finalPath, { force: true }).catch(() => {})
      }
      for (const backup of backups.reverse()) {
        if (await exists(backup.backupPath)) {
          await rename(backup.backupPath, backup.finalPath).catch(() => {})
        }
      }
    } else {
      await Promise.all(backups.map(({ backupPath }) => rm(backupPath, { force: true }).catch(() => {})))
    }
  }
}

export async function cleanupStagedDeliveries(deliveries: StagedDelivery[]): Promise<void> {
  await Promise.all(deliveries.map(({ stagedPath }) => rm(stagedPath, { force: true })))
}
