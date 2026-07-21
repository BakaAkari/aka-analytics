import { Context, Logger, Time, Disposable } from 'koishi'
import { LogReader } from '../utils/log-reader'
import { AiRequestService } from './ai-request-service'
import { ImageGenerationService } from './image-generation-service'
import { LogOffsetService } from './log-offset-service'
import { YesimbotParser } from '../parsers/yesimbot'
import { ChatlunaParser } from '../parsers/chatluna'
import { ImageGeneratorParser } from '../parsers/image-generator'
import type { Config } from '../config'
import type { ParsedLogLine } from '../types'
import { inferSource } from '../types'

export class LogWatcher {
  private ctx: Context
  private config: Config
  private logger: Logger
  private reader: LogReader
  private offset: LogOffsetService
  private aiService: AiRequestService
  private imageService: ImageGenerationService
  private interval: Disposable

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

    this.interval = ctx.setInterval(() => this.scan(), config.logWatchInterval)
    ctx.on('ready', () => this.scan())
  }

  private async scan() {
    const { resolve } = await import('path')
    const logDirectory = resolve(this.ctx.baseDir, this.config.logDirectory)

    try {
      const files = await this.reader.listLogFiles(logDirectory)
      files.sort((a, b) => a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0)

      for (const file of files) {
        const lastOffset = await this.offset.get(file.fileName)
        const { offset: newOffset, lines } = await this.reader.readNewLines(file.fullPath, lastOffset)

        const aiRequests: any[] = []
        const imageGenerations: any[] = []

        for (const line of lines) {
          const parsed = this.parseLine(line, file.fileName)
          if (!parsed) continue
          if (parsed.type === 'ai-request') aiRequests.push(parsed.record)
          else imageGenerations.push(parsed.record)
        }

        if (aiRequests.length) await this.aiService.record(aiRequests)
        if (imageGenerations.length) await this.imageService.record(imageGenerations)

        if (newOffset !== lastOffset) {
          await this.offset.update(file.fileName, file.size, newOffset)
        }
      }
      await this.aiService.flush()
    } catch (err) {
      this.logger.warn('log scan failed', err)
      try { await this.aiService.flush() } catch {}
    }
  }

  private parseLine(line: string, fileName: string): ParsedLogLine | null {
    let log: any
    try {
      log = JSON.parse(line)
    } catch {
      return null
    }
    if (!log || typeof log !== 'object') return null

    const source = inferSource(log.name)
    if (!source) return null
    if (!this.config.trackedSources?.[source]) return null

    if (source === 'yesimbot' && this.config.enableAiStats) {
      // [世界状态] command-invocation lines also feed the image parser's
      // command-context tracking (user/style attribution).
      if ((log.name as string)?.startsWith('[\u4e16\u754c\u72b6\u6001]')) {
        this.imageGeneratorParser.parse(log)
      }
      return this.yesimbotParser.parse(log)
    }
    if (source === 'chat-luna' && this.config.enableAiStats) {
      return this.chatlunaParser.parse(log)
    }
    if (source === 'image-generator' && this.config.enableImageStats) {
      return this.imageGeneratorParser.parse(log)
    }

    return null
  }

  dispose() {
    this.interval?.()
  }
}
