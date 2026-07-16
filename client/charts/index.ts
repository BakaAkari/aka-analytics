import { Context } from '@koishijs/client'
import CommandChart from './command'
import BotChart from './bot'
import HistoryChart from './history'
import HourChart from './hour'

export default (ctx: Context) => {
  // 首页图表：历史消息数量 / 每小时 QPS / 机器人占比 / 指令调用频率
  ctx.plugin(HistoryChart)
  ctx.plugin(HourChart)
  ctx.plugin(BotChart)
  ctx.plugin(CommandChart)
}
