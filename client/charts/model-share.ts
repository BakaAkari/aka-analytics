import { Context } from '@koishijs/client'
import { createChart, Tooltip } from './utils'

export default (ctx: Context) => {
  ctx.slot({
    type: 'analytic-chart',
    component: createChart({
      title: 'AI 模型占比',
      fields: ['analytics'],
      showPeriod: true,
      options({ analytics }, _tab, period) {
        const share = analytics.periods?.[period]?.aiStats?.modelShare
        if (!share?.length) return

        return {
          tooltip: Tooltip.item(({ data }: any) => {
            const lines = [data.name]
            if (data.provider) lines.push(`provider: ${data.provider}`)
            lines.push(`token: ${Number(data.value).toLocaleString()}`)
            lines.push(`占比: ${(data.percent * 100).toFixed(1)}%`)
            return lines.join('<br>')
          }),
          series: [{
            type: 'pie',
            radius: ['35%', '65%'],
            minShowLabelAngle: 3,
            data: share.map(item => ({
              name: item.modelId,
              value: item.tokenCount,
              provider: item.provider,
              percent: item.percentage,
            })),
          }],
        }
      },
    }),
  })
}
