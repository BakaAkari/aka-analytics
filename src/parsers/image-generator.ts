import { Logger, Time } from 'koishi'
import type { ParsedLogLine, ImageGenerationRecord } from '../types'

/**
 * Parses aka-ai-image-generator logs. The plugin emits structured event lines:
 *
 *   aka-ai-image-generator       requestProviderImages 调用 { provider, modelId, numImages, ... }
 *   aka-ai-image-generator:openai provider=openai event=create_success current=1 total=1
 *   aka-ai-image-generator:openai provider=openai event=edit_success current=1 total=1
 *   aka-ai-image-generator:openai provider=openai event=generate_failed ...
 *   [世界状态]                    记录指令调用 | 用户: X | 指令: 图生图 | 频道: onebot:N
 *
 * Success/failure events carry no model info, so we track the most recent
 * requestProviderImages call per provider and attribute the outcome to it.
 */
export class ImageGeneratorParser {
  private logger: Logger
  /** provider -> pending request context */
  private pending = new Map<string, Partial<ImageGenerationRecord>>()
  private lastUser: string | undefined
  private lastPlatform: string | undefined
  private lastCommand: string | undefined
  private lastCommandTs = 0

  constructor(logger: Logger) {
    this.logger = logger
  }

  parse(log: any): ParsedLogLine | null {
    const name = log.name as string | undefined
    const content = log.content as string | undefined
    const timestamp = log.timestamp as number | undefined
    if (!name || !content || !timestamp) return null

    const clean = content.replace(/\u001b\[[0-9;]*m/g, '')

    // [世界状态] 记录指令调用 | 用户: X | 指令: Y | 频道: platform:N
    if (name.startsWith('[\u4e16\u754c\u72b6\u6001]')) {
      const m = /\u8bb0\u5f55\u6307\u4ee4\u8c03\u7528 \| \u7528\u6237: (?<user>[^|]+) \| \u6307\u4ee4: (?<cmd>[^|]+) \| \u9891\u9053: (?<platform>[a-z]+):/.exec(clean)
      if (m?.groups) {
        this.lastUser = m.groups.user.trim()
        this.lastCommand = m.groups.cmd.trim()
        this.lastPlatform = m.groups.platform.trim()
        this.lastCommandTs = timestamp
      }
      return null
    }

    if (!name.startsWith('aka-ai-image-generator')) return null

    // requestProviderImages 调用 { provider: 'openai', modelId: 'gpt-image-2', numImages: 1, ... }
    if (clean.includes('requestProviderImages \u8c03\u7528')) {
      const provider = /provider: '(?<p>[^']+)'/.exec(clean)?.groups?.p || 'unknown'
      const modelId = /modelId: '(?<m>[^']+)'/.exec(clean)?.groups?.m
      const numImages = Number(/numImages: (?<n>\d+)/.exec(clean)?.groups?.n || 1)
      this.pending.set(provider, {
        provider,
        modelId,
        numImages,
        timestamp: new Date(timestamp),
        date: Time.getDateNumber(new Date(timestamp)),
        hour: new Date(timestamp).getHours(),
      })
      return null
    }

    // provider=X event=create_success / edit_success / generate_failed
    const ev = /provider=(?<provider>\S+) event=(?<event>\S+)/.exec(clean)
    if (!ev?.groups) return null
    const { provider, event } = ev.groups

    if (event === 'create_success' || event === 'edit_success' || event === 'generate_success') {
      return this.buildRecord(provider, timestamp, true)
    }
    if (event === 'generate_failed' || event === 'create_failed' || event === 'edit_failed') {
      return this.buildRecord(provider, timestamp, false, clean.slice(0, 100))
    }
    return null
  }

  private buildRecord(provider: string, timestamp: number, success: boolean, error?: string): ParsedLogLine {
    const pending = this.pending.get(provider) || {}
    // Only attach command context if it happened within the last 2 minutes
    const fresh = timestamp - this.lastCommandTs < 120_000
    const record: ImageGenerationRecord = {
      id: `img-${timestamp}-${provider}-${success ? 'ok' : 'fail'}`,
      timestamp: new Date(timestamp),
      date: Time.getDateNumber(new Date(timestamp)),
      hour: new Date(timestamp).getHours(),
      userId: fresh ? this.lastUser : undefined,
      platform: fresh ? this.lastPlatform : undefined,
      commandName: fresh ? this.lastCommand : undefined,
      styleName: fresh ? this.lastCommand : undefined,
      modelId: pending.modelId,
      provider,
      numImages: pending.numImages || 1,
      success,
      freeUsed: 0,
      purchasedUsed: 0,
      consumptionType: 'unknown',
      errorCode: error,
    } as ImageGenerationRecord
    if (success) this.pending.delete(provider)
    return { type: 'image-generation', record }
  }
}
