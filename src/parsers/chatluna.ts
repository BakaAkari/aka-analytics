import { Logger, Time } from 'koishi'
import type { Config } from '../config'
import type { ParsedLogLine, AiRequestRecord } from '../types'

export class ChatlunaParser {
  private config: Config
  private logger: Logger

  constructor(config: Config, logger: Logger) {
    this.config = config
    this.logger = logger
  }

  parse(log: any): ParsedLogLine | null {
    const name = log.name as string | undefined
    const content = log.content as string | undefined
    const timestamp = log.timestamp as number | undefined

    if (!name || !content || !timestamp) return null
    if (!name.startsWith('chatluna') && !name.includes('chatluna')) return null

    // chatluna search service summary model usage
    const searchMatch = /\u4f7f\u7528\u6a21\u578b\s*[:\uff1a]\s*(?<model>[^\n\r]+)/.exec(content)
    if (searchMatch) {
      return this.buildRecord(timestamp, searchMatch.groups.model.trim(), 'search', 0, 0)
    }

    // ChatLuna agent tool usage / model calls are harder to extract from logs.
    // For now, we only track explicit model mentions in chatluna logs.
    const modelMatch = /model\s*[:\uff1a]\s*(?<model>[^\n\r,]+)/i.exec(content)
    if (modelMatch) {
      return this.buildRecord(timestamp, modelMatch.groups.model.trim(), 'agent', 0, 0)
    }

    return null
  }

  private buildRecord(timestamp: number, modelId: string, taskType: string, promptTokens: number, completionTokens: number): ParsedLogLine {
    const id = `cl-${timestamp}-${modelId}-${taskType}`
    return {
      type: 'ai-request',
      record: {
        id,
        timestamp: new Date(timestamp),
        date: Time.getDateNumber(new Date(timestamp)),
        hour: new Date(timestamp).getHours(),
        source: 'chatluna',
        modelId: this.normalizeModelId(modelId),
        provider: this.inferProvider(modelId),
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        success: true,
      },
    }
  }

  private normalizeModelId(modelId: string): string {
    if (modelId.includes('/')) return modelId.split('/').pop() || modelId
    return modelId
  }

  private inferProvider(modelId: string): string | undefined {
    if (modelId.includes('deepseek')) return 'deepseek'
    if (modelId.includes('yunwu') || modelId.includes('gemini')) return 'yunwu'
    if (modelId.includes('ollama')) return 'ollama'
    return undefined
  }
}
