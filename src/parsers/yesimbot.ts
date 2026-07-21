import { Logger, Time } from 'koishi'
import type { Config } from '../config'
import type { ParsedLogLine, AiRequestRecord } from '../types'

export class YesimbotParser {
  private config: Config
  private logger: Logger
  private pendingRequests = new Map<string, Partial<AiRequestRecord>>()

  constructor(config: Config, logger: Logger) {
    this.config = config
    this.logger = logger
  }

  parse(log: any): ParsedLogLine | null {
    const name = log.name as string | undefined
    const content = log.content as string | undefined
    const timestamp = log.timestamp as number | undefined

    if (!name || !content || !timestamp) return null

    // [\u804a\u5929\u6a21\u578b] [modelId]
    const chatModelMatch = /^\[\u804a\u5929\u6a21\u578b\] \[(?<model>[^\]]+)\]/.exec(name)
    if (chatModelMatch) {
      return this.parseChatModel(chatModelMatch.groups.model, content, timestamp, log)
    }

    // [\u8bf7\u6c42\u6267\u884c\u5668]...
    const executorMatch = /^\[\u8bf7\u6c42\u6267\u884c\u5668\]\[chat\]:\[(?<model>[^\]]+)\]/.exec(name)
    if (executorMatch) {
      return this.parseExecutor(executorMatch.groups.model, content, timestamp)
    }

    return null
  }

  private parseChatModel(modelId: string, content: string, timestamp: number, log: any): ParsedLogLine | null {
    // Use modelId as the pending key because Koishi log lines do not carry a
    // stable request identifier. This preserves latency/first-token data from
    // the start line to the finish line for the same model invocation.
    const pendingKey = modelId

    // \uD83D\uDE80 [\u8bf7\u6c42\u5f00\u59cb] [\u6d41\u5f0f] \u6a21\u578b: modelId
    if (content.includes('\u8bf7\u6c42\u5f00\u59cb')) {
      this.pendingRequests.set(pendingKey, {
        id: this.buildId(timestamp, modelId, content),
        timestamp: new Date(timestamp),
        date: Time.getDateNumber(new Date(timestamp)),
        hour: new Date(timestamp).getHours(),
        source: 'yesimbot',
        modelId,
        provider: this.inferProvider(modelId),
        success: true,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      })
      return null
    }

    // \uD83C\uDF0A \u6d41\u5f0f\u4f20\u8f93\u5df2\u5f00\u59cb | \u5ef6\u8fdf: Nms
    const startMatch = /\uD83C\uDF0A \u6d41\u5f0f\u4f20\u8f93\u5df2\u5f00\u59cb \| \u5ef6\u8fdf: (?<latency>\d+)ms/.exec(content)
    if (startMatch) {
      const req = this.pendingRequests.get(pendingKey)
      if (req) req.firstTokenLatencyMs = Number(startMatch.groups.latency)
      return null
    }

    // \uD83C\uDFC1 [\u6d41\u5f0f] \u4f20\u8f93\u5b8c\u6210 | \u603b\u8017\u65f6: Nms | \u8f93\u5165: N | \u8f93\u51fa: N
    const finishMatch = /\uD83C\uDFC1 \[(?<stream>\u6d41\u5f0f)\] \u4f20\u8f93\u5b8c\u6210 \| \u603b\u8017\u65f6: (?<duration>\d+)ms \| \u8f93\u5165: (?<prompt>\d+) \| \u8f93\u51fa: (?<completion>\d+)/.exec(content)
    if (finishMatch) {
      const req = this.pendingRequests.get(pendingKey)
      const record: AiRequestRecord = {
        ...(req || {
          id: this.buildId(timestamp, modelId, content),
          timestamp: new Date(timestamp),
          date: Time.getDateNumber(new Date(timestamp)),
          hour: new Date(timestamp).getHours(),
          source: 'yesimbot',
        } as AiRequestRecord),
        modelId,
        provider: this.inferProvider(modelId),
        latencyMs: Number(finishMatch.groups.duration),
        promptTokens: Number(finishMatch.groups.prompt),
        completionTokens: Number(finishMatch.groups.completion),
        totalTokens: Number(finishMatch.groups.prompt) + Number(finishMatch.groups.completion),
        success: true,
      } as AiRequestRecord
      this.pendingRequests.delete(pendingKey)
      return { type: 'ai-request', record }
    }

    // \uD83D\uDCAC [\u6d41\u5f0f] \u6a21\u578b\u672a\u8f93\u51fa\u6709\u6548\u5185\u5bb9
    if (content.includes('\u6a21\u578b\u672a\u8f93\u51fa\u6709\u6548\u5185\u5bb9') || content.includes('OUTPUT_EMPTY_CONTENT')) {
      const req = this.pendingRequests.get(pendingKey)
      const record: AiRequestRecord = {
        ...(req || {
          id: this.buildId(timestamp, modelId, content),
          timestamp: new Date(timestamp),
          date: Time.getDateNumber(new Date(timestamp)),
          hour: new Date(timestamp).getHours(),
          source: 'yesimbot',
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
        } as AiRequestRecord),
        modelId,
        provider: this.inferProvider(modelId),
        success: false,
        errorCode: 'OUTPUT_EMPTY_CONTENT',
      } as AiRequestRecord
      this.pendingRequests.delete(pendingKey)
      return { type: 'ai-request', record }
    }

    return null
  }

  private parseExecutor(modelId: string, content: string, timestamp: number): ParsedLogLine | null {
    if (!content.includes('\u8bf7\u6c42\u5931\u8d25')) return null

    const errorMatch = /\u9519\u8bef: (?<error>.+)$/.exec(content)
    const id = this.buildId(timestamp, modelId, content)
    const record: AiRequestRecord = {
      id,
      timestamp: new Date(timestamp),
      date: Time.getDateNumber(new Date(timestamp)),
      hour: new Date(timestamp).getHours(),
      source: 'yesimbot',
      modelId,
      provider: this.inferProvider(modelId),
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      success: false,
      errorCode: errorMatch ? errorMatch.groups.error.trim().slice(0, 100) : 'UNKNOWN',
    }

    return { type: 'ai-request', record }
  }

  private inferProvider(modelId: string): string | undefined {
    if (modelId.includes('kimi') || modelId.includes('gpt')) return 'cpa'
    if (modelId.includes('deepseek')) return 'deepseek'
    if (modelId.includes('gemini')) return 'yunwu'
    return undefined
  }

  private buildId(timestamp: number, modelId: string, content: string): string {
    return `yes-${timestamp}-${modelId}-${content.length}`
  }
}
