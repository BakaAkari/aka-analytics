import { Context } from '@koishijs/client'
import { defineComponent, h, ref, resolveComponent } from 'vue'
import { store } from '@koishijs/client'
import type * as echarts from 'echarts'
import { Tooltip } from '../utils'
import VChart from '../echarts'

type PeriodTab = 7 | 30 | 90
const periodValue = ref<PeriodTab>(7)
const periodOptions: [PeriodTab, string][] = [[7, '七日'], [30, '三十日'], [90, '九十日']]

export default (ctx: Context) => {
  ctx.slot({
    type: 'analytic-chart',
    component: defineComponent({
      render: () => {
        if (!store.analytics) return null
        const aiStats = store.analytics.aiStats
        if (!aiStats?.modelShare?.length) return null
        const data = aiStats.modelShare.map(item => ({
          name: item.modelId,
          value: item.tokenCount,
          provider: item.provider,
        }))
        const option: echarts.EChartsOption = {
          tooltip: Tooltip.item(({ data }) => {
            const output = [data.name]
            if (data.provider) output.push(`provider: ${data.provider}`)
            output.push(`token: ${data.value}`)
            return output.join('<br>')
          }),
          series: [{
            type: 'pie',
            data,
            radius: ['35%', '65%'],
            minShowLabelAngle: 3,
          }],
        }
        return h(resolveComponent('k-card'), { class: 'frameless analytic-chart' }, {
          header: () => [
            h('span', { class: 'left' }, ['AI 模型占比']),
            h('span', { class: 'right' }, periodOptions.map(([value, label]) => h('span', {
              class: 'tab-item' + (periodValue.value === value ? ' active' : ''),
              onClick: () => periodValue.value = value,
            }, [label]))),
          ],
          default: () => h(VChart, { option, autoresize: true }),
        })
      },
    }),
  })
}
