import { Logger } from 'koishi'
import { YesimbotParser } from '../parsers/yesimbot'
import { ChatlunaParser } from '../parsers/chatluna'
import { ImageGeneratorParser } from '../parsers/image-generator'
import type { Config } from '../config'
import type { AiRequestRecord, ImageGenerationRecord, ParsedLogLine } from '../types'
import { inferSource } from '../types'

export interface ProcessBatchResult {
  aiRecords: AiRequestRecord[]
  imageRecords: ImageGenerationRecord[]
  invalidJson: number
  ignored: number
}

/**
 * Single canonical JSON parse + source dispatch + parser routing. Both the
 * live scanner and the historical importer feed lines through this one
 * class so watcher/importer no longer maintain separate copies of parseLine
 * that can drift (previously the watcher fed [世界状态] into the image
 * parser as context and the importer did not).
 *
 * The processor is stateful because underlying parsers carry per-instance
 * context (yesimbot pending requests, image parser last-command tracking,
 * chatluna last-model tracking). One processor per coordinator is fine;
 * do NOT share a single processor between concurrent scans.
 */
export class LogRecordProcessor {
  private readonly config: Config
  private readonly logger: Logger
  private readonly yesimbotParser: YesimbotParser
  private readonly chatlunaParser: ChatlunaParser
  private readonly imageGeneratorParser: ImageGeneratorParser

  constructor(config: Config, logger: Logger) {
    this.config = config
    this.logger = logger
    this.yesimbotParser = new YesimbotParser(config, logger)
    this.chatlunaParser = new ChatlunaParser(config, logger)
    this.imageGeneratorParser = new ImageGeneratorParser(logger)
  }

  processBatch(lines: string[]): ProcessBatchResult {
    const aiRecords: AiRequestRecord[] = []
    const imageRecords: ImageGenerationRecord[] = []
    let invalidJson = 0
    let ignored = 0

    for (const line of lines) {
      const parsed = this.parseLine(line)
      if (parsed === 'invalid') { invalidJson++; continue }
      if (parsed === null) { ignored++; continue }
      if (parsed.type === 'ai-request') aiRecords.push(parsed.record as AiRequestRecord)
      else imageRecords.push(parsed.record as ImageGenerationRecord)
    }

    return { aiRecords, imageRecords, invalidJson, ignored }
  }

  private parseLine(line: string): ParsedLogLine | null | 'invalid' {
    let log: any
    try {
      log = JSON.parse(line)
    } catch {
      return 'invalid'
    }
    if (!log || typeof log !== 'object') return null

    const name = log.name
    const source = inferSource(name)
    if (!source) return null
    if (!this.config.trackedSources?.[source]) return null

    if (source === 'yesimbot' && this.config.enableAiStats) {
      // [世界状态] command-invocation lines feed the image parser's
      // command-context tracking (user / style attribution). This is the
      // ONLY place the coupling is applied so live + historical behave
      // identically.
      if (typeof name === 'string' && name.startsWith('[世界状态]')) {
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
}
