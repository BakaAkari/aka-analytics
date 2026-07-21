import { Context } from '@koishijs/client'
import { createChart, Tooltip } from './utils'

export default (ctx: Context) => {
  ctx.slot({
    type: 'analytic-chart',
    component: createChart({
      title: '模型失败率',
      fields: ['analytics'],
      showPeriod: true,
      options({ analytics }, _tab, period) {
        const rates = analytics.periods?.[period]?.aiStats?.failureRate
        if (!rates?.length) return

        const sorted = [...rates].sort((a, b) => b.failRate - a.failRate)
        return {
          tooltip: Tooltip.axis((items) => {
            const [first] = items
            const rate = sorted.find(r => r.modelId === first.name)
            return [
              first.name,
              `失败率: ${((rate?.failRate ?? 0) * 100).toFixed(1)}%`,
              `失败/调用: ${rate?.failCount ?? 0}/${rate?.requestCount ?? 0}`,
            ].join('<br>')
          }),
          xAxis: {
            type: 'category',
            data: sorted.map(r => r.modelId),
            axisLabel: { rotate: 20 },
          },
          yAxis: {
            type: 'value',
            axisLabel: { formatter: (v: number) => `${(v * 100).toFixed(0)}%` },
          },
          series: [{
            type: 'bar',
            data: sorted.map(r => +(r.failRate).toFixed(4)),
          }],
        }
      },
    }),
  })
}
