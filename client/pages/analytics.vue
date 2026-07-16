<template>
  <k-layout>
    <template #header>
      <span>AI 分析</span>
    </template>
    <analytics-numbers/>
    <div class="card-grid chart-grid"><k-slot name="analytic-chart"></k-slot></div>
  </k-layout>
</template>

<script lang="ts" setup>
import AnalyticsNumbers from '../numbers/analytics.vue'
</script>
