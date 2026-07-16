import { Context } from '@koishijs/client'
import CommandChart from './command'
import BotChart from './bot'
import HistoryChart from './history'
import HourChart from './hour'
import ModelShare from './ai/model-share'
import TokenTrend from './ai/token-trend'
import FailureRate from './ai/failure-rate'
import AiUserRank from './ai/user-rank'
import ImageStyleRank from './image/style-rank'

export default (ctx: Context) => {
  // 用户数量增长 频道数量增长
  // 消息数量 (收/发) 每小时 QPS (收/发)
  // 指令调用频率 用户用量排行

  ctx.plugin(HistoryChart)
  ctx.plugin(HourChart)
  ctx.plugin(BotChart)
  ctx.plugin(CommandChart)
  ctx.plugin(ModelShare)
  ctx.plugin(TokenTrend)
  ctx.plugin(FailureRate)
  ctx.plugin(AiUserRank)
  ctx.plugin(ImageStyleRank)
}
