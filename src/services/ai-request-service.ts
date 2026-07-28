import { $, Context, Logger, Time } from 'koishi'
import type { AiModelDailyRecord, AiRequestRecord } from '../types'

/**
 * Persistence layer for AI-request events.
 *
 * Two guarantees:
 *
 *  1. Replay-safe daily aggregates. `record()` upserts raw rows and marks
 *     the affected dates dirty. `recomputeAffectedDates()` rebuilds the
 *     `analytics.ai_model_daily` rows from raw for each dirty date. Because
 *     recompute reads canonical raw data, replaying the same lines never
 *     double-counts.
 *
 *  2. Crash-safe pending recompute. Dirty dates are persisted to
 *     `analytics.ai_daily_dirty` inside `record()` (before the caller
 *     commits the file offset). A per-date row is removed ONLY after that
 *     date's recompute completes successfully. On failure, the row stays;
 *     the next cycle merges the on-disk dirty set with the in-memory set
 *     and retries, even if no new raw records were written.
 *
 * A process crash between raw upsert and next recompute leaves the dirty
 * markers on disk. `recomputeAffectedDates()` at next startup picks them
 * up. Order inside `record()` is raw upsert → dirty upsert: if raw fails,
 * no marker is written and the offset does not advance (caller replays);
 * if dirty upsert fails, raw is idempotent under replay via primary-key
 * upsert.
 */
const DIRTY_TABLE = 'analytics.ai_daily_dirty'

export class AiRequestService {
  private ctx: Context
  private logger: Logger
  /**
   * In-memory shadow of dirty dates. Kept in sync with the persistent
   * table: `record()` adds and upserts; a successful `recomputeDate`
   * removes both the in-memory entry and the on-disk row. If the caller
   * queries in-memory `hasPendingDates()`, the answer matches the on-disk
   * state modulo transient windows around the two operations.
   */
  private affectedDates: Set<number> = new Set()

  constructor(ctx: Context, logger: Logger) {
    this.ctx = ctx
    this.logger = logger
  }

  async record(requests: AiRequestRecord[]): Promise<void> {
    if (!requests.length) return

    const normalized = requests.map(r => ({
      ...r,
      provider: r.provider ?? '',
      timestamp: r.timestamp instanceof Date ? r.timestamp : new Date(r.timestamp),
    }))

    await this.ctx.database.upsert('analytics.ai_request' as any, normalized as any)

    // Persist the dirty-date markers for every date touched in this call.
    // Order is: raw upsert first, dirty markers second. If dirty upsert
    // throws, raw is already durable and idempotent under replay; the
    // caller MUST refuse to advance the offset so the next cycle re-runs
    // record() and re-marks the date.
    const datesInBatch = new Set<number>()
    for (const r of normalized) datesInBatch.add(r.date)
    const dirtyRows = Array.from(datesInBatch).map(date => ({ date, updatedAt: new Date() }))
    await this.ctx.database.upsert(DIRTY_TABLE as any, dirtyRows as any)

    for (const date of datesInBatch) this.affectedDates.add(date)
  }

  /**
   * Recompute daily aggregates for every dirty date (in-memory + on-disk).
   * A date is removed from both stores only after its recompute succeeds.
   * On failure the date stays pending and will be retried on the next
   * cycle even if no new raw records arrive.
   *
   * Never throws. Returns per-date counts and the list of dates that still
   * remain pending after this call so callers can surface pending state in
   * their cycle summary logs.
   */
  async recomputeAffectedDates(): Promise<{
    dates: number[]
    rowsWritten: number
    rowsDeleted: number
    failedDates: number[]
    pendingAfter: number
    /**
     * True when the on-disk dirty table could not be read after the
     * per-date passes. `pendingAfter` in that case is a conservative
     * best-effort union of the in-memory shadow and `failedDates`.
     * Callers surfacing pending state should mention this flag so an
     * operator knows the number is not authoritative.
     */
    pendingStateUnknown?: boolean
  }> {
    // Merge in-memory pending set with the on-disk dirty rows so a fresh
    // process (or a previous failure) still recomputes.
    let persisted: any[] = []
    try {
      persisted = await this.ctx.database.get(DIRTY_TABLE as any, {}) as any[]
    } catch (err) {
      this.logger.warn('ai_daily_dirty read failed: %s', (err as Error)?.message ?? err)
    }
    const merged = new Set<number>(this.affectedDates)
    for (const p of persisted ?? []) {
      if (typeof p?.date === 'number') merged.add(p.date)
    }

    const dates = Array.from(merged).sort((a, b) => a - b)
    const failedDates: number[] = []
    let rowsWritten = 0
    let rowsDeleted = 0

    for (const date of dates) {
      try {
        const [written, deleted] = await this.recomputeDate(date)
        rowsWritten += written
        rowsDeleted += deleted
        // Only clear the pending markers after a successful rebuild.
        try {
          await this.ctx.database.remove(DIRTY_TABLE as any, { date } as any)
        } catch (err) {
          // If we cannot delete the dirty marker but the recompute
          // succeeded, keep the in-memory copy present as well so the
          // next cycle retries — leaving the on-disk marker forces a
          // no-op re-run, which is safe.
          this.logger.warn(`ai_daily_dirty clear_failed date=${date} error=${(err as Error)?.message ?? err}`)
          continue
        }
        this.affectedDates.delete(date)
      } catch (err) {
        failedDates.push(date)
        this.logger.warn(`ai_model_daily recompute_failed date=${date} error=${(err as Error)?.message ?? err}`)
      }
    }

    // pendingAfter must reflect the REAL residual pending set, not just
    // the recompute-failed count. A date whose recompute succeeded but
    // whose dirty-marker delete failed is still pending and MUST be
    // retried next cycle — reporting `pendingAfter = failedDates.length`
    // in that case would silently under-report retry work. Prefer the
    // authoritative on-disk row count; fall back to the in-memory
    // shadow if the dirty table read throws (e.g. transient DB error).
    let pendingAfter = failedDates.length
    let pendingStateUnknown = false
    try {
      const remaining = await this.ctx.database.get(DIRTY_TABLE as any, {}) as any[]
      pendingAfter = remaining?.length ?? 0
    } catch (err) {
      // Cannot read on-disk state. The in-memory shadow is a
      // conservative lower bound (record() adds to it on every raw
      // write; delete-on-success removes it). Merge with failedDates
      // so a caller can't be told pendingAfter=0 while retries are
      // clearly required.
      pendingStateUnknown = true
      const conservative = new Set<number>(this.affectedDates)
      for (const d of failedDates) conservative.add(d)
      pendingAfter = conservative.size
      this.logger.warn(`ai_daily_dirty pending_state_unknown error=${(err as Error)?.message ?? err}`)
    }

    return { dates, rowsWritten, rowsDeleted, failedDates, pendingAfter, pendingStateUnknown }
  }

  private async recomputeDate(date: number): Promise<[number, number]> {
    const rawRows = await this.ctx.database.get('analytics.ai_request' as any, { date } as any) as any[]

    const groups = new Map<string, AiModelDailyRecord>()
    for (const r of rawRows) {
      const source = r.source ?? ''
      const provider = r.provider ?? ''
      const modelId = r.modelId ?? ''
      const key = `${source}|${provider}|${modelId}`
      let entry = groups.get(key)
      if (!entry) {
        entry = {
          date,
          source,
          provider,
          modelId,
          requestCount: 0,
          successCount: 0,
          failCount: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          totalLatencyMs: 0,
        }
        groups.set(key, entry)
      }
      entry.requestCount += 1
      if (r.success) entry.successCount += 1
      else entry.failCount += 1
      entry.promptTokens += Number(r.promptTokens) || 0
      entry.completionTokens += Number(r.completionTokens) || 0
      entry.totalTokens += Number(r.totalTokens) || 0
      if (r.latencyMs) entry.totalLatencyMs += Number(r.latencyMs) || 0
    }

    const freshKeys = new Set(groups.keys())
    const existingRows = await this.ctx.database.get('analytics.ai_model_daily' as any, { date } as any) as any[]
    const staleRows = (existingRows ?? []).filter(r => {
      const key = `${r.source ?? ''}|${r.provider ?? ''}|${r.modelId ?? ''}`
      return !freshKeys.has(key)
    })

    for (const stale of staleRows) {
      await this.ctx.database.remove('analytics.ai_model_daily' as any, {
        date,
        source: stale.source ?? '',
        provider: stale.provider ?? '',
        modelId: stale.modelId ?? '',
      } as any)
    }

    const rows = Array.from(groups.values())
    if (rows.length) {
      await this.ctx.database.upsert('analytics.ai_model_daily' as any, rows as any)
    }

    return [rows.length, staleRows.length]
  }

  clearAffectedDates(): void {
    this.affectedDates.clear()
  }

  hasPendingDates(): boolean {
    return this.affectedDates.size > 0
  }

  async hasPersistentPendingDates(): Promise<boolean> {
    try {
      const rows = await this.ctx.database.get(DIRTY_TABLE as any, {}) as any[]
      return (rows?.length ?? 0) > 0
    } catch {
      return false
    }
  }

  async queryRecent(days: number): Promise<AiRequestRecord[]> {
    return this.ctx.database
      .select('analytics.ai_request' as any, {
        date: { $gte: Time.getDateNumber() - days },
      })
      .orderBy('timestamp' as any, 'desc')
      .limit(10000)
      .execute() as any
  }

  async queryModelDaily(days: number): Promise<AiModelDailyRecord[]> {
    return this.ctx.database
      .select('analytics.ai_model_daily' as any, {
        date: { $gte: Time.getDateNumber() - days },
      })
      .execute() as any
  }
}
