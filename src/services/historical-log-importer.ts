import { Context, Logger, Time } from 'koishi'
import { LogReader } from '../utils/log-reader'
import { AiRequestService } from './ai-request-service'
import { ImageGenerationService } from './image-generation-service'
import { LogOffsetService } from './log-offset-service'
import { YesimbotParser } from '../parsers/yesimbot'
import { ChatlunaParser } from '../parsers/chatluna'
import { ImageGeneratorParser } from '../parsers/image-generator'
import type { Config } from '../config'
import type { ParsedLogLine } from '../types'

export class HistoricalLogImporter {
  private ctx: Context
  private config: Config
  private logger: Logger
  private reader: LogReader
  private offset: LogOffsetService
  private aiService: AiRequestService
  private imageService: ImageGenerationService

  private yesimbotParser: YesimbotParser
  private chatlunaParser: ChatlunaParser
  private imageGeneratorParser: ImageGeneratorParser

  constructor(
    ctx: Context,
    config: Config,
    logger: Logger,
    aiService: AiRequestService,
    imageService: ImageGenerationService,
  ) {
    this.ctx = ctx
    this.config = config
    this.logger = logger
    this.reader = new LogReader(logger)
    this.offset = new LogOffsetService(ctx, logger)
    this.aiService = aiService
    this.imageService = imageService

    this.yesimbotParser = new YesimbotParser(config, logger)
    this.chatlunaParser = new ChatlunaParser(config, logger)
    this.imageGeneratorParser = new ImageGeneratorParser(logger)
  }

  async runIfNeeded(): Promise<boolean> {
    try {
      const rows = await this.ctx.database.select('analytics.log_offset' as any).limit(1).execute() as any[]
      if (rows?.length > 0) {
        this.logger.debug('historical log import already done, skip')
        return false
      }

      this.logger.info('starting historical log import...')
      await this.importAll()
      this.logger.info('historical log import done')
      return true
    } catch (err) {
      this.logger.warn('historical log import failed', err)
      return false
    }
  }

  private async importAll() {
    const { resolve } = await import('path')
    const logDirectory = resolve(this.ctx.baseDir, this.config.logDirectory)

    const files = await this.reader.listLogFiles(logDirectory)
    if (!files.length) {
      this.logger.info('no log files found for historical import')
      return
    }

    // Sort by filename to import chronologically
    files.sort((a, b) => a.fileName.localeCompare(b.fileName))

    const BATCH_SIZE = 500
    let aiBuffer: any[] = []
    let imageBuffer: any[] = []
    let totalAi = 0
    let totalImage = 0

    for (const file of files) {
      this.logger.info('importing historical log file: %s', file.fileName)
      const { offset: newOffset, lines } = await this.reader.readNewLines(file.fullPath, 0)

      for (const line of lines) {
        const parsed = this.parseLine(line)
        if (!parsed) continue
        if (parsed.type === 'ai-request') {
          aiBuffer.push(parsed.record)
          totalAi++
        } else {
          imageBuffer.push(parsed.record)
          totalImage++
        }

        if (aiBuffer.length >= BATCH_SIZE) {
          await this.aiService.record(aiBuffer)
          aiBuffer = []
        }
        if (imageBuffer.length >= BATCH_SIZE) {
          await this.imageService.record(imageBuffer)
          imageBuffer = []
        }
      }

      // Mark entire file as consumed
      await this.offset.update(file.fileName, file.inode, file.size, newOffset)
    }

    if (aiBuffer.length) await this.aiService.record(aiBuffer)
    if (imageBuffer.length) await this.imageService.record(imageBuffer)

    this.logger.info('historical import summary: ai=%d, image=%d', totalAi, totalImage)
  }

  private parseLine(line: string): ParsedLogLine | null {
    let log: any
    try {
      log = JSON.parse(line)
    } catch {
      return null
    }

    if (!log || typeof log !== 'object') return null

    if (this.config.enableAiStats) {
      const yesimbot = this.yesimbotParser.parse(log)
      if (yesimbot) return yesimbot

      const chatluna = this.chatlunaParser.parse(log)
      if (chatluna) return chatluna
    }

    if (this.config.enableImageStats) {
      const image = this.imageGeneratorParser.parse(log)
      if (image) return image
    }

    return null
  }
}
