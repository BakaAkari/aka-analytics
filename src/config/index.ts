import { Schema, Time } from 'koishi'

export interface Config {
  statsInterval?: number
  recentDayCount?: number
  logWatchInterval?: number
  logDirectory?: string
  enableAiStats?: boolean
  enableImageStats?: boolean
  chatlunaDefaultModel?: string
  chatlunaTokenPerChar?: number
}

export const Config = Schema.object({
  statsInterval: Schema.natural().role('ms').description('统计数据推送的时间间隔。').default(Time.minute * 10),
  recentDayCount: Schema.natural().description('统计最近几天的数据。').default(90),
  logWatchInterval: Schema.natural().role('ms').description('日志监控轮询间隔。').default(10 * 1000),
  logDirectory: Schema.string().description('Koishi 日志目录路径，相对于 Koishi 根目录。').default('data/logs'),
  enableAiStats: Schema.boolean().description('是否启用 AI 调用统计。').default(true),
  enableImageStats: Schema.boolean().description('是否启用图像生成统计。').default(true),
  chatlunaDefaultModel: Schema.string().description('ChatLuna 默认模型，用于日志中未给出模型时的回退。').default('deepseek/deepseek-v4-flash-high-thinking'),
  chatlunaTokenPerChar: Schema.number().description('ChatLuna 字符到 token 的估算系数。').default(0.25),
})
