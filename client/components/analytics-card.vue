<template>
  <k-card class="frameless analytic-card" :body-style="{ padding: 0 }">
    <template #header v-if="title">
      <div class="card-header">
        <span class="title">{{ title }}</span>
        <span class="actions" v-if="$slots.actions">
          <slot name="actions"></slot>
        </span>
      </div>
    </template>
    <div class="card-body" :class="{ compact }">
      <slot></slot>
    </div>
  </k-card>
</template>

<script lang="ts" setup>
defineProps<{
  title?: string
  compact?: boolean
}>()
</script>

<style lang="scss" scoped>
.analytic-card {
  display: flex;
  flex-direction: column;
  min-height: 0;

  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;

    .title {
      font-weight: 500;
    }

    .actions {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      font-weight: normal;
    }
  }

  .card-body {
    padding: 0.5rem;
    flex: 1 1 auto;
    min-height: 0;

    &.compact {
      padding: 0.25rem;
    }
  }
}
</style>
