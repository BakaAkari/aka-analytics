import { Context, Logger } from 'koishi'
import type { LogOffsetRecord } from '../types'

export class LogOffsetService {
  private ctx: Context
  private logger: Logger

  constructor(ctx: Context, logger: Logger) {
    this.ctx = ctx
    this.logger = logger
  }

  async get(fileName: string): Promise<number> {
    try {
      const rows = await this.ctx.database.get('analytics.log_offset_v2' as any, { fileName })
      if (rows?.length) return (rows[0] as any).lastOffset
    } catch (err) {
      this.logger.warn('failed to read log offset for %s', fileName, err)
    }
    return 0
  }

  async update(fileName: string, size: number, lastOffset: number) {
    try {
      await this.ctx.database.upsert('analytics.log_offset_v2' as any, [{
        fileName,
        size,
        lastOffset,
        updatedAt: new Date(),
      } as any])
    } catch (err) {
      this.logger.warn('failed to update log offset for %s', fileName, err)
    }
  }
}
