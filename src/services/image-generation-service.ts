import { Context, Logger, Time } from 'koishi'
import type { ImageGenerationRecord } from '../types'

export class ImageGenerationService {
  private ctx: Context
  private logger: Logger

  constructor(ctx: Context, logger: Logger) {
    this.ctx = ctx
    this.logger = logger
  }

  async record(records: ImageGenerationRecord[]) {
    if (!records.length) return

    const normalized = records.map(r => ({
      ...r,
      timestamp: r.timestamp instanceof Date ? r.timestamp : new Date(r.timestamp),
    }))

    await this.ctx.database.upsert('analytics.image_generation' as any, normalized as any)
  }

  async queryRecent(days: number): Promise<ImageGenerationRecord[]> {
    return this.ctx.database
      .select('analytics.image_generation' as any, {
        date: { $gte: Time.getDateNumber() - days },
      })
      .orderBy('timestamp' as any, 'desc')
      .limit(10000)
      .execute() as any
  }
}
