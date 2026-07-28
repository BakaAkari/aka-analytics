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

    // [聊天模型] [modelId]
    const chatModelMatch = /^\[聊天模型\] \[(?<model>[^\]]+)\]/.exec(name)
    if (chatModelMatch) {
      return this.parseChatModel(chatModelMatch.groups.model, content, timestamp, log)
    }

    // [请求执行器]...
    const executorMatch = /^\[请求执行器\]\[chat\]:\[(?<model>[^\]]+)\]/.exec(name)
    if (executorMatch) {
      return this.parseExecutor(executorMatch.groups.model, content, timestamp)
    }

    // [心跳处理器] Token 消耗 lines duplicate the
    // per-model 传输完成 finish line (same invocation logged twice from
    // a different subsystem). Skip them: the finish line already carries
    // latency and is authoritative. 0.5.0 stance — do NOT re-enable
    // heartbeat parsing without also gating the finish-line branch off,
    // or every request will be counted twice. The lastModelId /
    // parseHeartbeatToken pair that previously lived here was
    // unreachable dead code and has been removed.
    if (name.startsWith('[心跳处理器]')) {
      return null
    }

    return null
  }

  private parseChatModel(modelId: string, content: string, timestamp: number, log: any): ParsedLogLine | null {
    // Use modelId as the pending key because Koishi log lines do not carry a
    // stable request identifier. This preserves latency/first-token data from
    // the start line to the finish line for the same model invocation.
    const pendingKey = modelId

    // 🚀 [请求开始] [流式] 模型: modelId
    if (content.includes('请求开始')) {
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

    // 🌊 流式传输已开始 | 延迟: Nms
    const startMatch = /🌊 流式传输已开始 \| 延迟: (?<latency>\d+)ms/.exec(content)
    if (startMatch) {
      const req = this.pendingRequests.get(pendingKey)
      if (req) req.firstTokenLatencyMs = Number(startMatch.groups.latency)
      return null
    }

    // 🏁 [流式] 传输完成 | 总耗时: Nms | 输入: N | 输出: N
    const finishMatch = /🏁 \[(?<stream>流式)\] 传输完成 \| 总耗时: (?<duration>\d+)ms \| 输入: (?<prompt>\d+) \| 输出: (?<completion>\d+)/.exec(content)
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

    // 💬 [流式] 模型未输出有效内容
    if (content.includes('模型未输出有效内容') || content.includes('OUTPUT_EMPTY_CONTENT')) {
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
    if (!content.includes('请求失败')) return null

    const errorMatch = /错误: (?<error>.+)$/.exec(content)
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
