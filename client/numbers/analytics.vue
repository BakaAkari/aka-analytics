<template>
  <div class="card-grid numeric-grid" v-if="store.analytics">
    <numeric icon="analytic:history" title="AI 调用">
      <template #default>{{ fmt(aiRequests) }}</template>
      <template #footer-left>近 {{ recentDays }} 天</template>
      <template #footer-right>成功率 {{ aiSuccessRate }}%</template>
    </numeric>
    <numeric icon="analytic:heart" title="输入 Token">
      <template #default>{{ fmt(promptTokens) }}</template>
      <template #footer-left>输出 Token</template>
      <template #footer-right>{{ fmt(completionTokens) }}</template>
    </numeric>
    <numeric icon="analytic:heart" title="Token 总计">
      <template #default>{{ fmt(aiTokens) }}</template>
      <template #footer-left>平均延迟</template>
      <template #footer-right>{{ avgLatency }} ms</template>
    </numeric>
    <numeric icon="analytic:guild" title="图像生成">
      <template #default>{{ fmt(imageGenerations) }}</template>
      <template #footer-left>生成张数</template>
      <template #footer-right>{{ fmt(imageCount) }}</template>
    </numeric>
  </div>
</template>

<script lang="ts" setup>
import { computed } from 'vue'
import { store } from '@koishijs/client'
import Numeric from './numeric.vue'

const recentDays = computed(() => Object.keys(store.analytics?.periods ?? { 7: 1 })[0] ?? 7)

const aiStats = computed(() => store.analytics?.aiStats?.overview)
const imageStats = computed(() => store.analytics?.imageStats?.overview)

const aiRequests = computed(() => aiStats.value?.totalRequests ?? 0)
const promptTokens = computed(() => aiStats.value?.totalPromptTokens ?? 0)
const completionTokens = computed(() => aiStats.value?.totalCompletionTokens ?? 0)
const aiTokens = computed(() => aiStats.value?.totalTokens ?? 0)
const aiSuccessRate = computed(() => aiStats.value?.totalRequests ? +(aiStats.value.successRate * 100).toFixed(1) : 0)
const avgLatency = computed(() => aiStats.value?.totalRequests ? Math.round(aiStats.value.avgLatencyMs) : 0)
const imageGenerations = computed(() => imageStats.value?.totalGenerations ?? 0)
const imageCount = computed(() => imageStats.value?.totalImages ?? 0)

const fmt = (n: number) => n.toLocaleString()
</script>

<style lang="scss" scoped>
.numeric-grid {
  grid-template-columns: repeat(4, 1fr);

  @media screen and (max-width: 1280px) {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
