import { $, Context, deepEqual, Dict, Logger, pick, Query, Row, Schema, Session, Time } from 'koishi'
import { DataService } from '@koishijs/console'
import { resolve } from 'path'
import { Config } from './config'
import { LogWatcher } from './services/log-watcher'
import { AiRequestService } from './services/ai-request-service'
import { ImageGenerationService } from './services/image-generation-service'
import { AggregationService } from './services/aggregation-service'
import { HistoricalLogImporter } from './services/historical-log-importer'
import type { AiStats, ImageStats } from './services/aggregation-service'

declare module 'koishi' {
  interface Tables {
    'analytics.message': Analytics.Message
    'analytics.command': Analytics.Command
    'analytics.user': Analytics.User
    'analytics.ai_request': Analytics.AiRequest
    'analytics.ai_model_daily': Analytics.AiModelDaily
    'analytics.image_generation': Analytics.ImageGeneration
    'analytics.log_offset_v2': Analytics.LogOffset
  }
}

declare module '@koishijs/console' {
  namespace Console {
    interface Services {
      analytics: Analytics
    }
  }
}

export interface MessageStats {
  send: number
  receive: number
}

const logger = new Logger('aka-analytics')
const periods = [7, 30, 90] as const

namespace Analytics {
  export interface Index {
    id?: number
    date: number
    hour: number
    selfId: string
    platform: string
  }

  export interface Audit extends Index {
    count: number
  }

  export interface Message extends Index {
    type: string
    count: number
  }

  export interface Command extends Index {
    name: string
    userId: number
    channelId: string
    count: number
  }

  export interface User {
    userId: number
    platform: string
    platformUserId: string
    userName: string
    updatedAt: Date
  }

  export interface AiRequest {
    id: string
    timestamp: Date
    date: number
    hour: number
    source: string
    provider: string
    modelId: string
    userId: string
    platform: string
    channelId: string
    guildId: string
    promptTokens: number
    completionTokens: number
    totalTokens: number
    latencyMs: number
    firstTokenLatencyMs: number
    success: boolean
    errorCode: string
    fallbackFrom: string
  }

  export interface AiModelDaily {
    date: number
    source: string
    provider: string
    modelId: string
    requestCount: number
    successCount: number
    failCount: number
    promptTokens: number
    completionTokens: number
    totalTokens: number
    totalLatencyMs: number
  }

  export interface ImageGeneration {
    id: string
    timestamp: Date
    date: number
    hour: number
    userId: string
    platform: string
    commandName: string
    styleName: string
    modelId: string
    provider: string
    numImages: number
    success: boolean
    freeUsed: number
    purchasedUsed: number
    consumptionType: string
  }

  export interface LogOffset {
    fileName: string
    size: number
    lastOffset: number
    updatedAt: Date
  }

  export type Period = typeof periods[number]

  export interface PeriodStats {
    commandRate: Dict<number>
    userUsageRank: UserUsage[]
    messageByHour: MessageStats[]
    aiStats: AiStats
    imageStats: ImageStats
  }

  export interface Payload {
    userCount: number
    userIncrement: number
    guildCount: number
    guildIncrement: number
    dauHistory: number[]
    commandRate: Dict<number>
    userUsageRank: UserUsage[]
    messageByDate: MessageStats[]
    messageByHour: MessageStats[]
    periods: Record<Period, PeriodStats>
    aiStats: AiStats
    imageStats: ImageStats
  }

  export interface UserUsage {
    userId: number
    userName?: string
    count: number
    dailyAverage: number
    topCommand?: string
  }
}
class Analytics extends DataService<Analytics.Payload> {
  static Config = Config
  static inject = ['database', 'console']

  lastUpdate = new Date()
  updateHour = this.lastUpdate.getHours()
  cachedDate: number
  cachedData: Promise<Analytics.Payload>

  private messages: Analytics.Message[] = []
  private commands: Analytics.Command[] = []
  private users: Analytics.User[] = []

  private aiRequestService: AiRequestService
  private imageGenerationService: ImageGenerationService
  private aggregationService: AggregationService
  private logWatcher: LogWatcher
  private historicalImporter: HistoricalLogImporter

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'analytics')

    this.extendModels(ctx)

    ctx.on('exit', () => this.upload(true))

    ctx.on('dispose', async () => {
      await this.upload(true)
    })

    ctx.on('message', (session) => {
      this.addAudit(this.messages, {
        ...this.createIndex(session),
        type: 'receive',
      })
      this.upload()
    })

    ctx.on('send', (session) => {
      this.addAudit(this.messages, {
        ...this.createIndex(session),
        type: 'send',
      })
      this.upload()
    })

    ctx.any().before('command/execute', ({ command, session }) => {
      const userId = session.user['id'] || 0
      this.addAudit(this.commands, {
        ...this.createIndex(session),
        name: command.name,
        userId,
        channelId: session.channelId,
      })
      this.addUserProfile(session, userId)
      this.upload()
    })

    this.aiRequestService = new AiRequestService(ctx, logger)
    this.imageGenerationService = new ImageGenerationService(ctx, logger)
    this.aggregationService = new AggregationService(ctx, config, logger)
    this.logWatcher = new LogWatcher(ctx, config, logger, this.aiRequestService, this.imageGenerationService)
    this.historicalImporter = new HistoricalLogImporter(ctx, config, logger, this.aiRequestService, this.imageGenerationService)

    ctx.on('ready', async () => {
      await this.historicalImporter.runIfNeeded()
    })

    ctx.console.addEntry({
      dev: resolve(__dirname, '../client/index.ts'),
      prod: resolve(__dirname, '../dist'),
    })
  }

  private extendModels(ctx: Context) {
    ctx.model.extend('analytics.message', {
      date: 'integer',
      hour: 'integer',
      type: 'string(63)',
      selfId: 'string(63)',
      platform: 'string(63)',
      count: 'integer',
    }, {
      primary: ['date', 'hour', 'type', 'selfId', 'platform'],
    })

    ctx.model.extend('analytics.command', {
      date: 'integer',
      hour: 'integer',
      name: 'string(63)',
      selfId: 'string(63)',
      userId: 'integer',
      channelId: 'string(63)',
      platform: 'string(63)',
      count: 'integer',
    }, {
      primary: ['date', 'hour', 'name', 'selfId', 'userId', 'channelId', 'platform'],
    })

    ctx.model.extend('analytics.user', {
      userId: 'integer',
      platform: 'string(63)',
      platformUserId: 'string(255)',
      userName: 'string(255)',
      updatedAt: 'timestamp',
    }, {
      primary: ['userId'],
    })

    ctx.model.extend('analytics.ai_request', {
      id: 'string(255)',
      timestamp: 'timestamp',
      date: 'integer',
      hour: 'integer',
      source: 'string(63)',
      provider: 'string(63)',
      modelId: 'string(127)',
      userId: 'string(127)',
      platform: 'string(63)',
      channelId: 'string(127)',
      guildId: 'string(127)',
      promptTokens: 'integer',
      completionTokens: 'integer',
      totalTokens: 'integer',
      latencyMs: 'integer',
      firstTokenLatencyMs: 'integer',
      success: 'boolean',
      errorCode: 'string(255)',
      fallbackFrom: 'string(127)',
    }, {
      primary: 'id',
    })

    ctx.model.extend('analytics.ai_model_daily', {
      date: 'integer',
      source: 'string(63)',
      provider: 'string(63)',
      modelId: 'string(127)',
      requestCount: 'integer',
      successCount: 'integer',
      failCount: 'integer',
      promptTokens: 'integer',
      completionTokens: 'integer',
      totalTokens: 'integer',
      totalLatencyMs: 'integer',
    }, {
      primary: ['date', 'source', 'provider', 'modelId'],
    })

    ctx.model.extend('analytics.image_generation', {
      id: 'string(255)',
      timestamp: 'timestamp',
      date: 'integer',
      hour: 'integer',
      userId: 'string(127)',
      platform: 'string(63)',
      commandName: 'string(127)',
      styleName: 'string(127)',
      modelId: 'string(127)',
      provider: 'string(63)',
      numImages: 'integer',
      success: 'boolean',
      freeUsed: 'integer',
      purchasedUsed: 'integer',
      consumptionType: 'string(63)',
    }, {
      primary: 'id',
    })

    ctx.model.extend('analytics.log_offset_v2', {
      fileName: 'string(255)',
      size: 'integer',
      lastOffset: 'integer',
      updatedAt: 'timestamp',
    }, {
      primary: 'fileName',
    })
  }

  private createIndex(session: Session): Analytics.Index {
    return {
      selfId: session.selfId,
      platform: session.platform,
      date: Time.getDateNumber(),
      hour: new Date().getHours(),
    }
  }

  private getSessionUserName(session: Session) {
    const event = session.event as any
    const candidates = [
      event.member?.name,
      event.member?.nick,
      event.user?.name,
      (session as any).username,
      (session as any).author?.name,
      (session as any).author?.nickname,
      (session.user as any)?.name,
    ]
    return candidates.find(value => typeof value === 'string' && value.trim())?.trim()
  }

  private addAudit<T extends Analytics.Audit>(buffer: T[], index: Omit<T, 'count'>) {
    const audit = buffer.find(data => deepEqual(pick(data, Object.keys(index) as (keyof T)[]), index))
    if (audit) {
      audit.count += 1
    } else {
      buffer.push({ ...index, count: 1 } as T)
    }
  }

  private addUserProfile(session: Session, userId: number) {
    if (!userId) return
    const userName = this.getSessionUserName(session)
    if (!userName) return
    const user = {
      userId,
      platform: session.platform,
      platformUserId: session.userId,
      userName,
      updatedAt: new Date(),
    }
    const index = this.users.findIndex(item => item.userId === userId)
    if (index >= 0) {
      this.users[index] = user
    } else {
      this.users.push(user)
    }
  }

  private async uploadAudit(table: string, buffer: Analytics.Audit[]) {
    if (!buffer.length) return
    await this.ctx.database.upsert(table as any, (row: Row<Analytics.Audit>) => buffer.map((audit) => ({
      ...audit,
      count: $.add($.ifNull(row.count, 0), audit.count),
    })))
    buffer.splice(0)
  }

  private async uploadUsers() {
    if (!this.users.length) return
    await this.ctx.database.upsert('analytics.user', this.users)
    this.users.splice(0)
  }

  async upload(forced = false) {
    const date = new Date()
    const dateHour = date.getHours()
    if (forced || +date - +this.lastUpdate > this.config.statsInterval || dateHour !== this.updateHour) {
      this.lastUpdate = date
      this.updateHour = dateHour
      await Promise.all([
        this.uploadAudit('analytics.message', this.messages),
        this.uploadAudit('analytics.command', this.commands),
        this.uploadUsers(),
      ])
      logger.debug('analytics updated')
    }
  }

  private queryRecent(days = this.config.recentDayCount): Query.FieldExpr<number> {
    return {
      $gte: Time.getDateNumber() - days,
      $lt: Time.getDateNumber(),
    }
  }

  private async getCommandRate(days: number) {
    const data = await this.ctx.database
      .select('analytics.command', {
        date: this.queryRecent(days),
      })
      .groupBy(['name'], {
        count: row => $.sum(row.count),
      })
      .execute()
    const result = {} as Dict<number>
    data.forEach((stat) => {
      result[stat.name] = stat.count / days
    })
    return result
  }

  private async getDauHistory() {
    const data = await this.ctx.database
      .select('analytics.command', {
        date: { $gte: Time.getDateNumber() - this.config.recentDayCount },
        userId: { $gt: 0 },
      })
      .groupBy(['date'], {
        count: row => $.count(row.userId),
      })
      .execute()
    const result: number[] = new Array(this.config.recentDayCount + 1).fill(0)
    const today = Time.getDateNumber()
    data.forEach((stat) => {
      result[today - stat.date] = stat.count
    })
    return result
  }

  private async getUserUsageRank(days: number) {
    const [usageData, commandData, users, koishiUsers] = await Promise.all([
      this.ctx.database
        .select('analytics.command', {
          date: this.queryRecent(days),
          userId: { $gt: 0 },
        })
        .groupBy(['userId'], {
          count: row => $.sum(row.count),
        })
        .execute(),
      this.ctx.database
        .select('analytics.command', {
          date: this.queryRecent(days),
          userId: { $gt: 0 },
        })
        .groupBy(['userId', 'name'], {
          count: row => $.sum(row.count),
        })
        .execute(),
      this.ctx.database.select('analytics.user').execute(),
      this.ctx.database.select('user').execute(),
    ])

    const topCommands = {} as Dict<{ name: string, count: number }>
    commandData.forEach((stat) => {
      const current = topCommands[stat.userId]
      if (!current || stat.count > current.count) {
        topCommands[stat.userId] = { name: stat.name, count: stat.count }
      }
    })

    const userNames = {} as Dict<string>
    koishiUsers.forEach((user) => {
      if (user.name) userNames[user.id] = user.name
    })
    users.forEach((user) => {
      if (user.userName) userNames[user.userId] = user.userName
    })

    return usageData
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .map(stat => ({
        userId: stat.userId,
        userName: userNames[stat.userId],
        count: stat.count,
        dailyAverage: stat.count / days,
        topCommand: topCommands[stat.userId]?.name,
      }))
  }

  private async getMessageByDate(days = Math.max(...periods)) {
    const data = await this.ctx.database
      .select('analytics.message', {
        date: this.queryRecent(days),
      })
      .groupBy(['type', 'date'], {
        count: row => $.sum(row.count),
      })
      .orderBy('date', 'desc')
      .execute()
    const today = Time.getDateNumber()
    const result: MessageStats[] = []
    data.forEach((stat) => {
      const entry = result[today - stat.date] ||= { send: 0, receive: 0 }
      entry[stat.type] = stat.count
    })
    for (let i = 0; i < result.length; i++) {
      result[i] ||= { send: 0, receive: 0 }
    }
    return result
  }

  private async getMessageByHour(days: number) {
    const data = await this.ctx.database
      .select('analytics.message', {
        date: this.queryRecent(days),
      })
      .groupBy(['type', 'hour'], {
        count: row => $.sum(row.count),
      })
      .execute()
    const result = new Array(24).fill(null).map(() => ({ send: 0, receive: 0 }))
    data.forEach((stat) => {
      result[stat.hour][stat.type] = stat.count / days
    })
    return result
  }

  private async getPeriodStats(days: Analytics.Period): Promise<Analytics.PeriodStats> {
    const [commandRate, userUsageRank, messageByHour, aiStats, imageStats] = await Promise.all([
      this.getCommandRate(days),
      this.getUserUsageRank(days),
      this.getMessageByHour(days),
      this.aggregationService.getAiStats(days),
      this.aggregationService.getImageStats(days),
    ])
    return { commandRate, userUsageRank, messageByHour, aiStats, imageStats }
  }

  async download(): Promise<Analytics.Payload> {
    try {
      const result = await this.downloadInner()
      return result
    } catch (err) {
      logger.error('analytics download failed', err)
      throw err
    }
  }

  private async downloadInner(): Promise<Analytics.Payload> {
    const messageByDateTask = this.getMessageByDate()
    const periodStatsTask = Promise.all(periods.map(async (days) => {
      return [days, await this.getPeriodStats(days)] as const
    }))
    const [
      userCount,
      userIncrement,
      guildCount,
      guildIncrement,
      dauHistory,
      messageByDate,
      periodEntries,
    ] = await Promise.all([
      this.ctx.database.eval('user', row => $.count(row.id)),
      this.ctx.database.eval('user', row => $.count(row.id), {
        createdAt: {
          $gte: Time.fromDateNumber(Time.getDateNumber() - 1),
          $lt: Time.fromDateNumber(Time.getDateNumber()),
        },
      }),
      this.ctx.database.eval('channel', row => $.sum(1), row => $.eq(row.id, row.guildId)),
      this.ctx.database.eval('channel', row => $.sum(1), row => $.and(
        $.eq(row.id, row.guildId),
        $.gte(row.createdAt, Time.fromDateNumber(Time.getDateNumber() - 1)),
        $.lt(row.createdAt, Time.fromDateNumber(Time.getDateNumber())),
      )),
      this.getDauHistory(),
      messageByDateTask,
      periodStatsTask,
    ])
    const periodStats = Object.fromEntries(periodEntries) as Record<Analytics.Period, Analytics.PeriodStats>
    const defaultPeriod = periods.includes(this.config.recentDayCount as any)
      ? this.config.recentDayCount as Analytics.Period
      : 90
    const defaultStats = periodStats[defaultPeriod] || periodStats[90]
    return {
      userCount,
      userIncrement,
      guildCount,
      guildIncrement,
      dauHistory,
      commandRate: defaultStats.commandRate,
      userUsageRank: defaultStats.userUsageRank,
      messageByDate,
      messageByHour: defaultStats.messageByHour,
      periods: periodStats,
      aiStats: defaultStats.aiStats,
      imageStats: defaultStats.imageStats,
    }
  }

  async get() {
    const date = new Date()
    const dateNumber = Time.getDateNumber(date, date.getTimezoneOffset())
    if (dateNumber !== this.cachedDate) {
      this.cachedData = this.download()
      this.cachedDate = dateNumber
    }
    return this.cachedData
  }
}


export default Analytics
export { Config } from './config'
