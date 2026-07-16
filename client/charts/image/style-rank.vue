<template>
  <analytics-card title="图像风格排行" v-if="hasData">
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

const imageStats = computed(() => store.analytics?.periods?.[period.value]?.imageStats)
const hasData = computed(() => imageStats.value?.styleRank?.length > 0)

const option = computed<EChartsOption>(() => {
  const data = imageStats.value?.styleRank?.map(item => ({
    name: item.styleName,
    value: item.totalImages,
    count: item.count,
  })).reverse() || []

  return {
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
})
</script>
