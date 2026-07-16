<template>
  <k-layout main="page-analytics">
    <template #header>AI 分析</template>
    <el-scrollbar>
      <div class="analytics-page">
        <analytics-section title="概览" layout="numbers">
          <analytics-numbers/>
        </analytics-section>

        <analytics-section title="AI 调用趋势" layout="charts">
          <token-trend-chart/>
          <model-share-chart/>
        </analytics-section>

        <analytics-section title="模型与稳定性" layout="charts">
          <failure-rate-chart/>
          <ai-user-rank-chart/>
        </analytics-section>

        <analytics-section title="图像生成" layout="charts">
          <image-style-rank-chart/>
        </analytics-section>
      </div>
    </el-scrollbar>
  </k-layout>
</template>

<script lang="ts" setup>
import AnalyticsSection from '../components/analytics-section.vue'
import AnalyticsNumbers from '../numbers/analytics.vue'
import TokenTrendChart from '../charts/ai/token-trend.vue'
import ModelShareChart from '../charts/ai/model-share.vue'
import FailureRateChart from '../charts/ai/failure-rate.vue'
import AiUserRankChart from '../charts/ai/user-rank.vue'
import ImageStyleRankChart from '../charts/image/style-rank.vue'
</script>

<style lang="scss">
.page-analytics .layout-main {
  overflow: hidden;
}

.analytics-page {
  padding: 1rem 0;
  max-width: 1600px;
  margin: 0 auto;
}
</style>
