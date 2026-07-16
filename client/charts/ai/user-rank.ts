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
        const userRank = store.analytics.aiStats?.userRank
        if (!userRank?.length) return null
        const data = userRank.map(item => ({
          name: item.userName || `用户 ${item.userId}`,
          value: item.totalTokens,
          requestCount: item.requestCount,
        })).reverse()
        const option: echarts.EChartsOption = {
          tooltip: Tooltip.item(({ data }) => {
            const output = [data.name]
            output.push(`总token: ${data.value}`)
            output.push(`请求数: ${data.requestCount}`)
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
        return h(resolveComponent('k-card'), { class: 'frameless analytic-chart' }, {
          header: () => [
            h('span', { class: 'left' }, ['用户 AI 用量排行']),
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
