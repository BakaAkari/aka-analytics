import { Context, Logger, Time } from 'koishi'
import type { Config } from '../config'
import type { AiModelDailyRecord, AiRequestRecord, ImageGenerationRecord } from '../types'

export interface AiOverview {
  totalRequests: number
  totalPromptTokens: number
  totalCompletionTokens: number
  totalTokens: number
  successRate: number
  avgLatencyMs: number
}

export interface ModelShare {
  modelId: string
  provider?: string
  requestCount: number
  tokenCount: number
  percentage: number
}

export interface TokenTrendPoint {
  date: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface FailureRatePoint {
  modelId: string
  requestCount: number
  failCount: number
  failRate: number
}

export interface UserAiUsage {
  userId: string
  userName?: string
  totalTokens: number
  requestCount: number
}

export interface ImageOverview {
  totalGenerations: number
  totalImages: number
  successCount: number
  freeUsed: number
  purchasedUsed: number
}

export interface StyleRank {
  styleName: string
  count: number
  totalImages: number
}

export interface AiStats {
  overview: AiOverview
  modelShare: ModelShare[]
  tokenTrend: TokenTrendPoint[]
  failureRate: FailureRatePoint[]
  userRank: UserAiUsage[]
}

export interface ImageStats {
  overview: ImageOverview
  styleRank: StyleRank[]
}

export class AggregationService {
  private ctx: Context
  private config: Config
  private logger: Logger

  constructor(ctx: Context, config: Config, logger: Logger) {
    this.ctx = ctx
    this.config = config
    this.logger = logger
  }

  async getAiStats(days: number): Promise<AiStats> {
    const [dailyRecords, recentRequests] = await Promise.all([
      (this.ctx.database.select('analytics.ai_model_daily' as any, {
        date: { $gte: Time.getDateNumber() - days },
      }).execute() as Promise<AiModelDailyRecord[]>),
      (this.ctx.database.select('analytics.ai_request' as any, {
        date: { $gte: Time.getDateNumber() - days },
      }).orderBy('timestamp' as any, 'desc').limit(5000).execute() as Promise<AiRequestRecord[]>),
    ])

    return this.aggregateAiStats(dailyRecords, recentRequests, days)
  }

  private aggregateAiStats(daily: AiModelDailyRecord[], requests: AiRequestRecord[], days: number): AiStats {
    const overview: AiOverview = {
      totalRequests: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      successRate: 0,
      avgLatencyMs: 0,
    }

    const modelMap = new Map<string, ModelShare>()
    const failureMap = new Map<string, FailureRatePoint>()
    const trendMap = new Map<number, TokenTrendPoint>()
    const userMap = new Map<string, UserAiUsage>()

    let totalLatency = 0
    let latenciesCount = 0

    for (const row of daily) {
      overview.totalRequests += row.requestCount
      overview.totalPromptTokens += row.promptTokens
      overview.totalCompletionTokens += row.completionTokens
      overview.totalTokens += row.totalTokens
      totalLatency += row.totalLatencyMs
      latenciesCount += row.requestCount

      const key = `${row.modelId}|${row.provider || ''}`
      let model = modelMap.get(key)
      if (!model) {
        model = {
          modelId: row.modelId,
          provider: row.provider,
          requestCount: 0,
          tokenCount: 0,
          percentage: 0,
        }
        modelMap.set(key, model)
      }
      model.requestCount += row.requestCount
      model.tokenCount += row.totalTokens

      let failure = failureMap.get(row.modelId)
      if (!failure) {
        failure = {
          modelId: row.modelId,
          requestCount: 0,
          failCount: 0,
          failRate: 0,
        }
        failureMap.set(row.modelId, failure)
      }
      failure.requestCount += row.requestCount
      failure.failCount += row.failCount

      let trend = trendMap.get(row.date)
      if (!trend) {
        trend = {
          date: this.formatDate(row.date),
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
        }
        trendMap.set(row.date, trend)
      }
      trend.promptTokens += row.promptTokens
      trend.completionTokens += row.completionTokens
      trend.totalTokens += row.totalTokens
    }

    for (const req of requests) {
      if (!req.userId) continue
      const userKey = String(req.userId)
      let user = userMap.get(userKey)
      if (!user) {
        user = {
          userId: userKey,
          totalTokens: 0,
          requestCount: 0,
        }
        userMap.set(userKey, user)
      }
      user.totalTokens += req.totalTokens
      user.requestCount += 1
    }

    if (overview.totalRequests > 0) {
      overview.successRate = (overview.totalRequests - daily.reduce((sum, r) => sum + r.failCount, 0)) / overview.totalRequests
      overview.avgLatencyMs = latenciesCount > 0 ? totalLatency / latenciesCount : 0
    }

    const modelShare = Array.from(modelMap.values())
    for (const m of modelShare) {
      m.percentage = overview.totalTokens > 0 ? m.tokenCount / overview.totalTokens : 0
    }

    const failureRate = Array.from(failureMap.values()).map(f => ({
      ...f,
      failRate: f.requestCount > 0 ? f.failCount / f.requestCount : 0,
    }))

    const tokenTrend = Array.from(trendMap.values()).sort((a, b) => a.date.localeCompare(b.date))
    const userRank = Array.from(userMap.values())
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .slice(0, 10)

    return {
      overview,
      modelShare: modelShare.sort((a, b) => b.tokenCount - a.tokenCount),
      tokenTrend,
      failureRate,
      userRank,
    }
  }

  async getImageStats(days: number): Promise<ImageStats> {
    const records = await this.ctx.database.select('analytics.image_generation' as any, {
      date: { $gte: Time.getDateNumber() - days },
    }).execute() as unknown as ImageGenerationRecord[]

    const overview: ImageOverview = {
      totalGenerations: 0,
      totalImages: 0,
      successCount: 0,
      freeUsed: 0,
      purchasedUsed: 0,
    }

    const styleMap = new Map<string, StyleRank>()

    for (const r of records) {
      overview.totalGenerations += 1
      overview.totalImages += r.numImages
      if (r.success) overview.successCount += 1
      overview.freeUsed += r.freeUsed || 0
      overview.purchasedUsed += r.purchasedUsed || 0

      const key = r.styleName || r.commandName || 'unknown'
      let style = styleMap.get(key)
      if (!style) {
        style = {
          styleName: key,
          count: 0,
          totalImages: 0,
        }
        styleMap.set(key, style)
      }
      style.count += 1
      style.totalImages += r.numImages
    }

    return {
      overview,
      styleRank: Array.from(styleMap.values())
        .sort((a, b) => b.totalImages - a.totalImages)
        .slice(0, 10),
    }
  }

  private formatDate(dateNumber: number): string {
    const year = Math.floor(dateNumber / 10000)
    const month = Math.floor((dateNumber % 10000) / 100)
    const day = dateNumber % 100
    return `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`
  }
}
