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
        const failureRate = store.analytics.aiStats?.failureRate
        if (!failureRate?.length) return null
        const data = failureRate.map(item => ({
          name: item.modelId,
          value: +(item.failRate * 100).toFixed(2),
          requestCount: item.requestCount,
          failCount: item.failCount,
        })).sort((a, b) => b.value - a.value)
        const option: echarts.EChartsOption = {
          tooltip: Tooltip.item(({ data }) => {
            const output = [data.name]
            output.push(`请求数: ${data.requestCount}`)
            output.push(`失败数: ${data.failCount}`)
            output.push(`失败率: ${data.value}%`)
            return output.join('<br>')
          }),
          xAxis: {
            type: 'category',
            data: data.map(item => item.name),
          },
          yAxis: {
            type: 'value',
            name: '%',
            max: 100,
          },
          series: [{
            type: 'bar',
            data: data.map(item => item.value),
            itemStyle: {
              color: '#ee6666',
            },
          }],
        }
        return h(resolveComponent('k-card'), { class: 'frameless analytic-chart' }, {
          header: () => [
            h('span', { class: 'left' }, ['AI 调用失败率']),
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
