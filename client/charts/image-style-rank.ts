import { Context } from '@koishijs/client'
import { createChart, Tooltip } from './utils'

export default (ctx: Context) => {
  ctx.slot({
    type: 'analytic-chart',
    component: createChart({
      title: '图像生成风格排行',
      fields: ['analytics'],
      showPeriod: true,
      options({ analytics }, _tab, period) {
        const rank = analytics.periods?.[period]?.imageStats?.styleRank
        if (!rank?.length) return

        const sorted = [...rank].sort((a, b) => a.totalImages - b.totalImages)
        return {
          tooltip: Tooltip.item(({ data }: any) => {
            const s = sorted[data.dataIndex]
            return [
              s.styleName,
              `生成次数: ${s.count}`,
              `生成张数: ${s.totalImages}`,
            ].join('<br>')
          }),
          grid: { left: 8, right: 24, containLabel: true },
          xAxis: { type: 'value' },
          yAxis: {
            type: 'category',
            data: sorted.map(s => s.styleName),
          },
          series: [{
            type: 'bar',
            data: sorted.map(s => s.totalImages),
          }],
        }
      },
    }),
  })
}
