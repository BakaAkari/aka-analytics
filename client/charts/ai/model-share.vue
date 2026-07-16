<template>
  <analytics-card title="AI 模型占比" v-if="hasData">
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
const hasData = computed(() => aiStats.value?.modelShare?.length > 0)

const option = computed<EChartsOption>(() => {
  const data = aiStats.value?.modelShare?.map(item => ({
    name: item.modelId,
    value: item.tokenCount,
    provider: item.provider,
  })) || []

  return {
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
})
</script>
