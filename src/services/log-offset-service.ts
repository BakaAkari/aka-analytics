import { Context, Logger } from 'koishi'
import type { LogOffsetRecord } from '../types'

/**
 * Persistent per-file byte offset. Errors from update() propagate so the
 * coordinator can refuse to advance downstream state on a failed commit
 * (records already written but offset not persisted would replay next
 * cycle; original tables must remain idempotent for that to be safe).
 *
 * Compatibility with 0.4.6 / 0.5.0 databases:
 *
 *   - The legacy `analytics.log_offset_v2` table (4 int columns, no
 *     mtimeMs) is preserved AS-IS by the model definition in
 *     `src/index.ts`. Existing installs must not force a Minato temp-
 *     table rebuild — that rebuild is `INSERT INTO ..._temp SELECT
 *     fileName,size,lastOffset,updatedAt FROM ...` and would fail with
 *     a column-count mismatch if the model changed the shape.
 *   - A new `analytics.log_offset_v3` table carries the wider `double`
 *     columns and the additional `mtimeMs` field. All writes go here.
 *   - Reads consult v3 first. Files that only have a v2 row (because
 *     they were seen before the upgrade) fall back to v2 with
 *     `mtimeMs=0`. The next successful commit for that file promotes
 *     the record to v3, so v2 rows drain organically as files are
 *     revisited — we do NOT batch-copy the entire v2 table at startup
 *     (that could churn hundreds of thousands of rows on the target
 *     NAS deployment).
 *   - A v2 read that throws is degraded to "no offset" and logged as a
 *     warning; the file will be re-read from offset 0 that cycle but
 *     downstream tables are idempotent, so no data is duplicated. v3
 *     write failures continue to propagate — losing a v3 commit would
 *     silently strand progress.
 */
export class LogOffsetService {
  private ctx: Context
  private logger: Logger

  constructor(ctx: Context, logger: Logger) {
    this.ctx = ctx
    this.logger = logger
  }

  async get(fileName: string): Promise<LogOffsetRecord | null> {
    const v3Rows = await this.ctx.database.get('analytics.log_offset_v3' as any, { fileName }) as any[]
    if (v3Rows?.length) return normalizeV3(v3Rows[0])
    const legacy = await this.readV2Safe({ fileName })
    if (legacy.length) return normalizeV2(legacy[0])
    return null
  }

  async getMany(fileNames: string[]): Promise<Map<string, LogOffsetRecord>> {
    const map = new Map<string, LogOffsetRecord>()
    if (!fileNames.length) return map

    const v3Rows = await this.ctx.database.get('analytics.log_offset_v3' as any, {
      fileName: { $in: fileNames },
    } as any) as any[]
    for (const row of v3Rows ?? []) map.set(row.fileName, normalizeV3(row))

    // Only look up v2 for names we did NOT find in v3. Splitting the
    // query keeps the fallback lookup cheap on installs where v3 has
    // fully absorbed the working set.
    const missing = fileNames.filter(name => !map.has(name))
    if (!missing.length) return map

    const legacy = await this.readV2Safe({ fileName: { $in: missing } } as any)
    for (const row of legacy ?? []) {
      if (map.has(row.fileName)) continue
      map.set(row.fileName, normalizeV2(row))
    }
    return map
  }

  async update(record: {
    fileName: string
    size: number
    lastOffset: number
    mtimeMs: number
  }): Promise<void> {
    await this.ctx.database.upsert('analytics.log_offset_v3' as any, [{
      fileName: record.fileName,
      size: record.size,
      lastOffset: record.lastOffset,
      mtimeMs: record.mtimeMs,
      updatedAt: new Date(),
    } as any])
  }

  /**
   * Read from the legacy v2 table with defensive error handling. A
   * throw here means we cannot determine whether an old-format row
   * exists — we degrade to "no offset" (the caller will re-read from
   * offset 0, and raw upserts are idempotent) rather than propagate
   * the failure and stall the whole ingestion cycle.
   */
  private async readV2Safe(filter: Record<string, unknown>): Promise<any[]> {
    try {
      const rows = await this.ctx.database.get('analytics.log_offset_v2' as any, filter as any) as any[]
      return rows ?? []
    } catch (err) {
      this.logger.warn(`log_offset v2_fallback_read_failed error=${(err as Error)?.message ?? err}`)
      return []
    }
  }
}

function normalizeV3(row: any): LogOffsetRecord {
  return {
    fileName: row.fileName,
    size: row.size ?? 0,
    lastOffset: row.lastOffset ?? 0,
    mtimeMs: row.mtimeMs ?? 0,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt ?? Date.now()),
  }
}

function normalizeV2(row: any): LogOffsetRecord {
  return {
    fileName: row.fileName,
    size: row.size ?? 0,
    lastOffset: row.lastOffset ?? 0,
    mtimeMs: 0,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt ?? Date.now()),
  }
}
