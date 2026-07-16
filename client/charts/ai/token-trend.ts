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
        const trend = store.analytics.aiStats?.tokenTrend
        if (!trend?.length) return null
        const option: echarts.EChartsOption = {
          tooltip: Tooltip.axis(params => {
            const p = params[0]
            return `${p.name}<br>输入: ${p.data.promptTokens}<br>输出: ${p.data.completionTokens}<br>总计: ${p.data.totalTokens}`
          }),
          legend: {
            data: ['输入 token', '输出 token'],
          },
          xAxis: {
            type: 'category',
            data: trend.map(t => t.date),
          },
          yAxis: {
            type: 'value',
          },
          series: [
            {
              name: '输入 token',
              type: 'line',
              smooth: true,
              stack: 'total',
              areaStyle: {},
              data: trend.map(t => ({ value: t.promptTokens, promptTokens: t.promptTokens, completionTokens: t.completionTokens, totalTokens: t.totalTokens })),
            },
            {
              name: '输出 token',
              type: 'line',
              smooth: true,
              stack: 'total',
              areaStyle: {},
              data: trend.map(t => ({ value: t.completionTokens, promptTokens: t.promptTokens, completionTokens: t.completionTokens, totalTokens: t.totalTokens })),
            },
          ],
        }
        return h(resolveComponent('k-card'), { class: 'frameless analytic-chart' }, {
          header: () => [
            h('span', { class: 'left' }, ['Token 消耗趋势']),
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
