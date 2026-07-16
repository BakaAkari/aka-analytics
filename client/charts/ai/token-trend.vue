<template>
  <analytics-card title="Token 消耗趋势" v-if="hasData">
    <template #actions>
      <span
        v-for="p in periods"
        :key="p.value"
        class="tab-item"
        :class="{ active: period === p.value }"
        @click="period = p.value"
      >{{ p.label }}</span>
    </template>
    <v-chart :option="option" autoresize/>
  </analytics-card>
</template>

<script lang="ts" setup>
import { computed, ref } from 'vue'
import { store } from '@koishijs/client'
import type { EChartsOption } from 'echarts'
import AnalyticsCard from '../../components/analytics-card.vue'
import VChart from '../echarts'
import { Tooltip } from '../utils'

type PeriodTab = 7 | 30 | 90
const period = ref<PeriodTab>(7)
const periods = [
  { value: 7, label: '七日' },
  { value: 30, label: '三十日' },
  { value: 90, label: '九十日' },
]

const aiStats = computed(() => store.analytics?.periods?.[period.value]?.aiStats)
const hasData = computed(() => aiStats.value?.tokenTrend?.length > 0)

const option = computed<EChartsOption>(() => {
  const trend = aiStats.value?.tokenTrend || []
  return {
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
})
</script>
