export type AiSource = 'yesimbot' | 'chatluna' | 'image-generator' | 'unknown'

export interface AiRequestRecord {
  id: string
  timestamp: Date
  date: number
  hour: number
  source: AiSource
  provider?: string
  modelId: string
  userId?: string
  platform?: string
  channelId?: string
  guildId?: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  latencyMs?: number
  firstTokenLatencyMs?: number
  success: boolean
  errorCode?: string
  fallbackFrom?: string
}

export interface AiModelDailyRecord {
  date: number
  source: string
  provider?: string
  modelId: string
  requestCount: number
  successCount: number
  failCount: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  totalLatencyMs: number
}

export interface ImageGenerationRecord {
  id: string
  timestamp: Date
  date: number
  hour: number
  userId?: string
  platform?: string
  commandName?: string
  styleName?: string
  modelId?: string
  provider?: string
  numImages: number
  success: boolean
  freeUsed?: number
  purchasedUsed?: number
  consumptionType?: 'free' | 'purchased' | 'mixed'
}

export interface LogOffsetRecord {
  fileName: string
  size: number
  lastOffset: number
  updatedAt: Date
}

export interface ParsedLogLine {
  type: 'ai-request' | 'image-generation'
  record: AiRequestRecord | ImageGenerationRecord
}

export interface YesimbotRequestStart {
  id: string
  modelId: string
  stream: boolean
  timestamp: number
}

export interface YesimbotRequestFinish {
  id: string
  modelId: string
  durationMs: number
  firstTokenLatencyMs?: number
  promptTokens: number
  completionTokens: number
  success: boolean
  errorCode?: string
}
