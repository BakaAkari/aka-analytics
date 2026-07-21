import { Context } from '@koishijs/client'
import { createChart, Tooltip } from './utils'

export default (ctx: Context) => {
  ctx.slot({
    type: 'analytic-chart',
    component: createChart({
      title: 'Token 用量趋势',
      fields: ['analytics'],
      showPeriod: true,
      options({ analytics }, _tab, period) {
        const trend = analytics.periods?.[period]?.aiStats?.tokenTrend
        if (!trend?.length) return

        return {
          tooltip: Tooltip.axis((items) => {
            const [first] = items
            const lines = [first.name]
            for (const item of items) {
              lines.push(`${item.marker}${item.seriesName}: ${Number(item.value).toLocaleString()}`)
            }
            return lines.join('<br>')
          }),
          legend: { data: ['输入', '输出', '总计'] },
          xAxis: {
            type: 'category',
            data: trend.map(p => p.date),
          },
          yAxis: { type: 'value' },
          series: [
            { name: '输入', type: 'line', smooth: true, data: trend.map(p => p.promptTokens) },
            { name: '输出', type: 'line', smooth: true, data: trend.map(p => p.completionTokens) },
            { name: '总计', type: 'line', smooth: true, data: trend.map(p => p.totalTokens) },
          ],
        }
      },
    }),
  })
}
