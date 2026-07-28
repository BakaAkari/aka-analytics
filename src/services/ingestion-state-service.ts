import { Context, Logger } from 'koishi'
import type { IngestionStateRecord, IngestionStatus } from '../types'

const HISTORICAL_KEY = 'historical'
const EPOCH = new Date(0)

export interface IngestionStatePatch {
  status?: IngestionStatus
  cursorFileName?: string
  processedFilesDelta?: number
  processedBytesDelta?: number
  importedAiRecordsDelta?: number
  importedImageRecordsDelta?: number
  startedAt?: Date
  completedAt?: Date
  failedAt?: Date
  nextRetryAt?: Date
  consecutiveFailures?: number
  lastError?: string
}

/**
 * Persistent ingestion state machine. Replaces the previous "offset table
 * is non-empty ⇒ historical import is done" check, which was ambiguous
 * (any single row would mark all history complete, partial failures were
 * indistinguishable from success, and clearing the offset table caused an
 * unbounded re-import of ~350k files).
 *
 * The state row is keyed by a stable identifier so future subsystems (per-
 * source, per-directory) can register their own progress cursors without
 * colliding with the historical importer's record.
 */
export class IngestionStateService {
  private ctx: Context
  private logger: Logger

  constructor(ctx: Context, logger: Logger) {
    this.ctx = ctx
    this.logger = logger
  }

  async getHistorical(): Promise<IngestionStateRecord> {
    return this.get(HISTORICAL_KEY)
  }

  async get(key: string): Promise<IngestionStateRecord> {
    const rows = await this.ctx.database.get('analytics.log_import_state' as any, { key }) as any[]
    if (rows?.length) {
      const row = rows[0]
      return {
        key,
        status: (row.status as IngestionStatus) ?? 'idle',
        cursorFileName: row.cursorFileName ?? '',
        processedFiles: row.processedFiles ?? 0,
        processedBytes: row.processedBytes ?? 0,
        importedAiRecords: row.importedAiRecords ?? 0,
        importedImageRecords: row.importedImageRecords ?? 0,
        startedAt: row.startedAt ?? EPOCH,
        updatedAt: row.updatedAt ?? EPOCH,
        completedAt: row.completedAt ?? EPOCH,
        failedAt: row.failedAt ?? EPOCH,
        nextRetryAt: row.nextRetryAt ?? EPOCH,
        consecutiveFailures: row.consecutiveFailures ?? 0,
        lastError: row.lastError ?? '',
      }
    }
    return {
      key,
      status: 'idle',
      cursorFileName: '',
      processedFiles: 0,
      processedBytes: 0,
      importedAiRecords: 0,
      importedImageRecords: 0,
      startedAt: EPOCH,
      updatedAt: EPOCH,
      completedAt: EPOCH,
      failedAt: EPOCH,
      nextRetryAt: EPOCH,
      consecutiveFailures: 0,
      lastError: '',
    }
  }

  async patchHistorical(patch: IngestionStatePatch): Promise<IngestionStateRecord> {
    return this.patch(HISTORICAL_KEY, patch)
  }

  async patch(key: string, patch: IngestionStatePatch): Promise<IngestionStateRecord> {
    const current = await this.get(key)
    const next: IngestionStateRecord = {
      ...current,
      status: patch.status ?? current.status,
      cursorFileName: patch.cursorFileName ?? current.cursorFileName,
      processedFiles: current.processedFiles + (patch.processedFilesDelta ?? 0),
      processedBytes: current.processedBytes + (patch.processedBytesDelta ?? 0),
      importedAiRecords: current.importedAiRecords + (patch.importedAiRecordsDelta ?? 0),
      importedImageRecords: current.importedImageRecords + (patch.importedImageRecordsDelta ?? 0),
      startedAt: patch.startedAt ?? current.startedAt,
      completedAt: patch.completedAt ?? current.completedAt,
      failedAt: patch.failedAt ?? current.failedAt,
      nextRetryAt: patch.nextRetryAt ?? current.nextRetryAt,
      consecutiveFailures: patch.consecutiveFailures ?? current.consecutiveFailures,
      updatedAt: new Date(),
      lastError: patch.lastError ?? current.lastError,
    }
    await this.ctx.database.upsert('analytics.log_import_state' as any, [next as any])
    return next
  }

  /** Force-reset (used when the operator wants to re-run historical import). */
  async resetHistorical(): Promise<void> {
    await this.ctx.database.upsert('analytics.log_import_state' as any, [{
      key: HISTORICAL_KEY,
      status: 'idle',
      cursorFileName: '',
      processedFiles: 0,
      processedBytes: 0,
      importedAiRecords: 0,
      importedImageRecords: 0,
      startedAt: EPOCH,
      updatedAt: new Date(),
      completedAt: EPOCH,
      failedAt: EPOCH,
      nextRetryAt: EPOCH,
      consecutiveFailures: 0,
      lastError: '',
    } as any])
  }
}

export { HISTORICAL_KEY as HISTORICAL_STATE_KEY }
