import { Logger, Time } from 'koishi'
import type { Config } from '../config'
import type { ParsedLogLine, AiRequestRecord } from '../types'

export class ChatlunaParser {
  private config: Config
  private logger: Logger
  private lastModelId: string | null = null
  private lastModelTimestamp: number = 0
  private readonly modelTTL: number = 5 * 60 * 1000 // 5 minutes

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

    const cleanContent = content.replace(/\u001b\[[0-9;]*m/g, '')
    // Track the most recent model mention from search-service or adapter logs.
    const modelMatch = /(?:Create summary model|\u4f7f\u7528\u6a21\u578b|model)\s*[:\uff1a]\s*(?<model>[^\n\r,]+)/i.exec(cleanContent)
    if (modelMatch?.groups?.model) {
      this.lastModelId = modelMatch.groups.model.trim()
      this.lastModelTimestamp = timestamp
      return null
    }

    // Also capture adapter-specific model selections if present.
    const adapterModelMatch = /(?:currentModel|selected model|modelId)\s*[:=]\s*(?<model>[A-Za-z0-9_./:-]+)/i.exec(cleanContent)
    if (adapterModelMatch?.groups?.model) {
      this.lastModelId = adapterModelMatch.groups.model.trim()
      this.lastModelTimestamp = timestamp
      return null
    }

    // Real ChatLuna usage line: "Token usage from API: input=N output=N total=N"
    const usageMatch = /Token usage from API:\s*input\s*=\s*(?<input>\d+)\s+output\s*=\s*(?<output>\d+)\s+total\s*=\s*(?<total>\d+)/i.exec(cleanContent)
    if (usageMatch && usageMatch.groups) {
      const { input, output, total } = usageMatch.groups as { input: string; output: string; total: string }
      return this.buildRecord(timestamp, input, output, total)
    }

    return null
  }

  private buildRecord(timestamp: number, input: string, output: string, total: string): ParsedLogLine {
    const modelId = this.resolveModelId(timestamp)
    const promptTokens = Number(input)
    const completionTokens = Number(output)
    const totalTokens = Number(total)
    const id = `cl-${timestamp}-${modelId}-${promptTokens}-${completionTokens}`
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
        totalTokens,
        success: true,
      },
    }
  }

  private resolveModelId(timestamp: number): string {
    if (this.lastModelId && timestamp - this.lastModelTimestamp < this.modelTTL) {
      return this.lastModelId
    }
    return this.config.chatlunaDefaultModel || 'unknown'
  }

  private normalizeModelId(modelId: string): string {
    if (modelId.includes('/')) return modelId.split('/').pop() || modelId
    return modelId
  }

  private inferProvider(modelId: string): string | undefined {
    if (modelId.includes('deepseek')) return 'deepseek'
    if (modelId.includes('yunwu') || modelId.includes('gemini')) return 'yunwu'
    if (modelId.includes('ollama')) return 'ollama'
    if (modelId.includes('openai')) return 'openai'
    return undefined
  }
}
