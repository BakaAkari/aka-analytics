<template>
  <div class="analytics-number-grid" v-if="store.analytics">
    <numeric title="AI 调用" :value="aiRequests" icon="history"/>
    <numeric title="输入 token" :value="promptTokens" icon="heart"/>
    <numeric title="输出 token" :value="completionTokens" icon="heart"/>
    <numeric title="Token 总计" :value="aiTokens" icon="history"/>
    <numeric title="AI 成功率" :value="aiSuccessRate" unit="%" icon="user"/>
    <numeric title="平均延迟" :value="avgLatency" unit="ms" icon="user"/>
    <numeric title="图像生成" :value="imageGenerations" icon="guild"/>
    <numeric title="生成张数" :value="imageCount" icon="guild"/>
  </div>
</template>

<script lang="ts" setup>
import { computed } from 'vue'
import { store } from '@koishijs/client'
import Numeric from './numeric.vue'

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
</script>

<style lang="scss" scoped>
.analytics-number-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1rem;

  @media screen and (max-width: 1280px) {
    grid-template-columns: repeat(2, 1fr);
  }

  @media screen and (max-width: 768px) {
    grid-template-columns: 1fr;
  }
}
</style>
