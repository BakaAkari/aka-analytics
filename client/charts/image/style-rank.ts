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
        const styleRank = store.analytics.imageStats?.styleRank
        if (!styleRank?.length) return null
        const data = styleRank.map(item => ({
          name: item.styleName,
          value: item.totalImages,
          count: item.count,
        })).reverse()
        const option: echarts.EChartsOption = {
          tooltip: Tooltip.item(({ data }) => {
            const output = [data.name]
            output.push(`次数: ${data.count}`)
            output.push(`图片数: ${data.value}`)
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
            h('span', { class: 'left' }, ['图像风格排行']),
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
