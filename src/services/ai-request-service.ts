import { $, Context, Logger, Time } from 'koishi'
import type { AiRequestRecord, AiModelDailyRecord } from '../types'

export class AiRequestService {
  private ctx: Context
  private logger: Logger

  constructor(ctx: Context, logger: Logger) {
    this.ctx = ctx
    this.logger = logger
  }

  private scanState: { date: number; buffer: AiRequestRecord[] } | null = null

  async record(requests: AiRequestRecord[]) {
    if (!requests.length) return

    const normalized = requests.map(r => ({
      ...r,
      timestamp: r.timestamp instanceof Date ? r.timestamp : new Date(r.timestamp),
    }))

    await this.ctx.database.upsert('analytics.ai_request' as any, normalized as any)
    await this.bufferDaily(normalized)
  }

  /**
   * Buffer records per date. Aggregation only happens when the scan moves
   * to a newer date or when the watcher's scan cycle ends (flush()).
   * This guarantees each historical date is aggregated exactly once with
   * the full day's records, eliminating read-modify-write races against
   * partially-written days.
   */
  private async bufferDaily(requests: AiRequestRecord[]) {
    for (const req of requests) {
      if (!this.scanState || this.scanState.date !== req.date) {
        await this.flush()
        this.scanState = { date: req.date, buffer: [] }
      }
      this.scanState.buffer.push(req)
    }
  }

  async flush() {
    if (!this.scanState || !this.scanState.buffer.length) {
      this.scanState = null
      return
    }
    const buffer = this.scanState.buffer
    this.scanState = null
    try {
      await this.aggregateDaily(buffer)
    } catch (err) {
      this.logger.warn('aggregateDaily failed', err)
    }
  }

  private async aggregateDaily(requests: AiRequestRecord[]) {
    const groups = new Map<string, AiModelDailyRecord>()

    for (const req of requests) {
      const provider = req.provider || ''
      const key = `${req.date}|${req.source}|${provider}|${req.modelId}`
      let entry = groups.get(key)
      if (!entry) {
        entry = {
          date: req.date,
          source: req.source,
          provider,
          modelId: req.modelId,
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
      if (req.success) entry.successCount += 1
      else entry.failCount += 1
      entry.promptTokens += req.promptTokens
      entry.completionTokens += req.completionTokens
      entry.totalTokens += req.totalTokens
      if (req.latencyMs) entry.totalLatencyMs += req.latencyMs
    }

    const records = Array.from(groups.values())
    for (const record of records) {
      const existing = await this.ctx.database.get('analytics.ai_model_daily' as any, {
        date: record.date,
        source: record.source,
        provider: record.provider,
        modelId: record.modelId,
      } as any) as any[]
      if (existing.length > 0) {
        await this.ctx.database.set('analytics.ai_model_daily' as any, {
          date: record.date,
          source: record.source,
          provider: record.provider,
          modelId: record.modelId,
        } as any, {
          requestCount: existing[0].requestCount + record.requestCount,
          successCount: existing[0].successCount + record.successCount,
          failCount: existing[0].failCount + record.failCount,
          promptTokens: existing[0].promptTokens + record.promptTokens,
          completionTokens: existing[0].completionTokens + record.completionTokens,
          totalTokens: existing[0].totalTokens + record.totalTokens,
          totalLatencyMs: existing[0].totalLatencyMs + record.totalLatencyMs,
        } as any)
      } else {
        await this.ctx.database.create('analytics.ai_model_daily' as any, record as any)
      }
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
