<template>
  <analytics-card title="AI 调用失败率" v-if="hasData">
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
const hasData = computed(() => aiStats.value?.failureRate?.length > 0)

const option = computed<EChartsOption>(() => {
  const data = aiStats.value?.failureRate?.map(item => ({
    name: item.modelId,
    value: +(item.failRate * 100).toFixed(2),
    requestCount: item.requestCount,
    failCount: item.failCount,
  })).sort((a, b) => b.value - a.value) || []

  return {
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
})
</script>
