import { defineAsyncComponent, defineComponent, h, ref, resolveComponent } from 'vue'
import { Store, store } from '@koishijs/client'
import type * as echarts from 'echarts'
import './index.scss'

const VChart = defineAsyncComponent(() => import('./echarts'))

export type MessageTab = 'send' | 'receive'
export type PeriodTab = 7 | 30 | 90

export interface ChartOptions {
  title: string
  fields?: (keyof Store)[]
  showTab?: boolean
  showPeriod?: boolean
  options: (store: Store, tab: MessageTab, period: PeriodTab) => echarts.EChartsOption
}

const tabValue = ref<MessageTab>('send')
const periodValue = ref<PeriodTab>(7)
const periodOptions: [PeriodTab, string][] = [[7, '七日'], [30, '三十日'], [90, '九十日']]

export function createChart({ title, fields, showTab, showPeriod, options }: ChartOptions) {
  return defineComponent({
    render: () => {
      if (!fields.every(key => store[key])) return null
      const option = options(store, tabValue.value, periodValue.value)
      if (!option) return
      return h(resolveComponent('k-card'), { class: 'frameless analytic-chart' }, {
        header: () => [
          h('span', { class: 'left' }, [title]),
          h('span', { class: 'right' }, [
            ...showPeriod ? periodOptions.map(([value, label]) => h('span', {
              class: 'tab-item' + (periodValue.value === value ? ' active' : ''),
              onClick: () => periodValue.value = value,
            }, [label])) : [],
            ...showTab ? [
              h('span', { class: 'tab-divider' }),
              h('span', {
                class: 'tab-item' + (tabValue.value === 'send' ? ' active' : ''),
                onClick: () => tabValue.value = 'send',
              }, ['发送']),
              h('span', {
                class: 'tab-item' + (tabValue.value === 'receive' ? ' active' : ''),
                onClick: () => tabValue.value = 'receive',
              }, ['接收']),
            ] : [],
          ]),
        ],
        default: () => {
          return h(VChart, { option, autoresize: true })
        },
      })
    },
  })
}

interface CommonData {
  name: string
  value: number
  children?: CommonData
}

export namespace Tooltip {
  type FormatterCallback<T> = (params: T) => string
  type FormatterCallbackParams<T> = Omit<echarts.DefaultLabelFormatterCallbackParams, 'data'> & { data: T }

  export const item = <T = CommonData>(formatter: FormatterCallback<FormatterCallbackParams<T>>) => ({
    trigger: 'item',
    formatter,
  } as echarts.TooltipComponentOption)

  export const axis = <T = CommonData>(formatter: FormatterCallback<FormatterCallbackParams<T>[]>) => ({
    trigger: 'axis',
    axisPointer: {
      type: 'cross',
    },
    formatter,
  } as echarts.TooltipComponentOption)
}
