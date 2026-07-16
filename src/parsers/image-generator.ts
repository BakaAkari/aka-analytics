import { Logger, Time } from 'koishi'
import type { ParsedLogLine, ImageGenerationRecord } from '../types'

export class ImageGeneratorParser {
  private logger: Logger

  constructor(logger: Logger) {
    this.logger = logger
  }

  parse(log: any): ParsedLogLine | null {
    const name = log.name as string | undefined
    const content = log.content as string | undefined
    const timestamp = log.timestamp as number | undefined

    if (!name || !content || !timestamp) return null
    if (!name.includes('UsageReporter') && !name.includes('ImageGeneration')) return null

    // Only parse the "\u7528\u6237\u8c03\u7528\u8bb0\u5f55" log entry which contains complete info
    if (!content.startsWith('\u7528\u6237\u8c03\u7528\u8bb0\u5f55')) return null

    const commandMatch = /commandName\s*[:\uff1a]\s*[\'\"]?(?<command>[^,}\s\'\"]+)/.exec(content)
    const numMatch = /numImages\s*[:\uff1a]\s*(?<num>\d+)/.exec(content)
    const typeMatch = /consumptionType\s*[:\uff1a]\s*[\'\"]?(?<type>[^,}\s\'\"]+)/.exec(content)
    const freeMatch = /freeUsed\s*[:\uff1a]\s*(?<free>\d+)/.exec(content)
    const purchasedMatch = /purchasedUsed\s*[:\uff1a]\s*(?<purchased>\d+)/.exec(content)
    const userMatch = /userId\s*[:\uff1a]\s*[\'\"]?(?<user>[^,}\s\'\"]+)/.exec(content)
    const platformMatch = /platform\s*[:\uff1a]\s*[\'\"]?(?<platform>[^,}\s\'\"]+)/.exec(content)

    const record: ImageGenerationRecord = {
      id: `img-${timestamp}-${commandMatch?.groups?.command || 'unknown'}`,
      timestamp: new Date(timestamp),
      date: Time.getDateNumber(new Date(timestamp)),
      hour: new Date(timestamp).getHours(),
      userId: userMatch?.groups?.user,
      platform: platformMatch?.groups?.platform,
      commandName: commandMatch?.groups?.command,
      numImages: numMatch ? Number(numMatch.groups.num) : 1,
      success: true,
      freeUsed: freeMatch ? Number(freeMatch.groups.free) : 0,
      purchasedUsed: purchasedMatch ? Number(purchasedMatch.groups.purchased) : 0,
      consumptionType: typeMatch?.groups?.type as any || 'free',
    }

    return { type: 'image-generation', record }
  }
}
