<template>
  <div class="card-grid number-grid">
    <numeric title="AI 调用" :value="aiRequests" icon="heart"/>
    <numeric title="Token 总计" :value="aiTokens" icon="history"/>
    <numeric title="AI 成功率" :value="aiSuccessRate" unit="%" icon="user"/>
    <numeric title="图像生成" :value="imageGenerations" icon="guild"/>
  </div>
</template>

<script lang="ts" setup>
import { computed } from 'vue'
import { store } from '@koishijs/client'
import Numeric from './numeric.vue'

const aiRequests = computed(() => store.analytics?.aiStats?.overview?.totalRequests ?? 0)
const aiTokens = computed(() => store.analytics?.aiStats?.overview?.totalTokens ?? 0)
const aiSuccessRate = computed(() => {
  const overview = store.analytics?.aiStats?.overview
  if (!overview?.totalRequests) return 0
  return +(overview.successRate * 100).toFixed(1)
})
const imageGenerations = computed(() => store.analytics?.imageStats?.overview?.totalGenerations ?? 0)
</script>

<style lang="scss">
.number-grid {
  grid-template-columns: repeat(4, 1fr);
}
</style>
