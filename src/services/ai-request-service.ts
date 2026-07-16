import { $, Context, Logger, Time } from 'koishi'
import type { AiRequestRecord, AiModelDailyRecord } from '../types'

export class AiRequestService {
  private ctx: Context
  private logger: Logger

  constructor(ctx: Context, logger: Logger) {
    this.ctx = ctx
    this.logger = logger
  }

  async record(requests: AiRequestRecord[]) {
    if (!requests.length) return

    const normalized = requests.map(r => ({
      ...r,
      timestamp: r.timestamp instanceof Date ? r.timestamp : new Date(r.timestamp),
    }))

    await this.ctx.database.upsert('analytics.ai_request' as any, normalized as any)
    await this.aggregateDaily(normalized)
  }

  private async aggregateDaily(requests: AiRequestRecord[]) {
    const groups = new Map<string, AiModelDailyRecord>()

    for (const req of requests) {
      const key = `${req.date}|${req.source}|${req.provider || ''}|${req.modelId}`
      let entry = groups.get(key)
      if (!entry) {
        entry = {
          date: req.date,
          source: req.source,
          provider: req.provider,
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
      await this.ctx.database.upsert('analytics.ai_model_daily' as any, [record as any], {
        override: (row: any) => ({
          requestCount: $.add(row.requestCount, record.requestCount),
          successCount: $.add(row.successCount, record.successCount),
          failCount: $.add(row.failCount, record.failCount),
          promptTokens: $.add(row.promptTokens, record.promptTokens),
          completionTokens: $.add(row.completionTokens, record.completionTokens),
          totalTokens: $.add(row.totalTokens, record.totalTokens),
          totalLatencyMs: $.add(row.totalLatencyMs, record.totalLatencyMs),
        }),
      } as any)
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
