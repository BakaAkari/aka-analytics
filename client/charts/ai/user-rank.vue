<template>
  <analytics-card title="用户 AI 用量排行" v-if="hasData">
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
const hasData = computed(() => aiStats.value?.userRank?.length > 0)

const option = computed<EChartsOption>(() => {
  const data = aiStats.value?.userRank?.map(item => ({
    name: item.userName || `用户 ${item.userId}`,
    value: item.totalTokens,
    requestCount: item.requestCount,
  })).reverse() || []

  return {
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
})
</script>
