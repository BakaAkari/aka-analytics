import { Context } from '@koishijs/client'
import { createChart, Tooltip } from './utils'

export default (ctx: Context) => {
  ctx.slot({
    type: 'analytic-chart',
    component: createChart({
      title: '用户 Token 排行',
      fields: ['analytics'],
      showPeriod: true,
      options({ analytics }, _tab, period) {
        const rank = analytics.periods?.[period]?.aiStats?.userRank
        if (!rank?.length) return

        const sorted = [...rank].sort((a, b) => a.totalTokens - b.totalTokens)
        return {
          tooltip: Tooltip.item(({ data }: any) => {
            const u = sorted[data.dataIndex]
            return [
              u.userName || u.userId,
              `token: ${u.totalTokens.toLocaleString()}`,
              `调用: ${u.requestCount} 次`,
            ].join('<br>')
          }),
          grid: { left: 8, right: 24, containLabel: true },
          xAxis: { type: 'value' },
          yAxis: {
            type: 'category',
            data: sorted.map(u => u.userName || u.userId),
          },
          series: [{
            type: 'bar',
            data: sorted.map(u => u.totalTokens),
          }],
        }
      },
    }),
  })
}
