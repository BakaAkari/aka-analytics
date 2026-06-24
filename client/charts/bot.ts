import { Context } from '@koishijs/client'
import { createChart, Tooltip } from './utils'

export default (ctx: Context) => {
  ctx.slot({
    type: 'analytic-chart',
    component: createChart({
      title: '用户用量排行',
      fields: ['analytics'],
      options({ analytics }) {
        const data = analytics.userUsageRank
          .map(item => ({
            name: item.userName || `用户 ${item.userId}`,
            value: item.dailyAverage,
            count: item.count,
            userId: item.userId,
            topCommand: item.topCommand,
          }))
          .reverse()
        if (!data.length) return

        return {
          tooltip: Tooltip.item<typeof data[number]>(({ data }) => {
            const output = [data.name]
            output.push(`用户 ID：${data.userId}`)
            output.push(`最近调用：${data.count}`)
            output.push(`日均调用：${+data.value.toFixed(1)}`)
            if (data.topCommand) output.push(`常用指令：${data.topCommand}`)
            return output.join('<br>')
          }),
          xAxis: {
            type: 'value',
          },
          yAxis: {
            type: 'category',
            data: data.map(item => item.name),
          },
          series: [{
            type: 'bar',
            data,
          }],
        }
      },
    }),
  })
}
