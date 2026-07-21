import { Context } from '@koishijs/client'
import CommandChart from './command'
import BotChart from './bot'
import HistoryChart from './history'
import HourChart from './hour'
import TokenTrendChart from './token-trend'
import ModelShareChart from './model-share'
import FailureRateChart from './failure-rate'
import UserRankChart from './user-rank'
import ImageStyleRankChart from './image-style-rank'

export default (ctx: Context) => {
  // 首页图表：历史消息数量 / 每小时 QPS / 机器人占比 / 指令调用频率
  ctx.plugin(HistoryChart)
  ctx.plugin(HourChart)
  ctx.plugin(BotChart)
  ctx.plugin(CommandChart)
  // AI 分析图表：token 趋势 / 模型占比 / 失败率 / 用户排行 / 图像风格排行
  ctx.plugin(TokenTrendChart)
  ctx.plugin(ModelShareChart)
  ctx.plugin(FailureRateChart)
  ctx.plugin(UserRankChart)
  ctx.plugin(ImageStyleRankChart)
}
