<template>
  <section class="analytics-section" :class="{ divided }">
    <div class="section-header" v-if="title || $slots.actions">
      <h3 class="section-title" v-if="title">{{ title }}</h3>
      <div class="section-actions" v-if="$slots.actions">
        <slot name="actions"></slot>
      </div>
    </div>
    <div class="section-content" :class="[layout]">
      <slot></slot>
    </div>
  </section>
</template>

<script lang="ts" setup>
withDefaults(defineProps<{
  title?: string
  layout?: 'numbers' | 'charts' | 'list' | 'column'
  divided?: boolean
}>(), {
  layout: 'charts',
  divided: true,
})
</script>

<style lang="scss" scoped>
.analytics-section {
  padding: 1rem var(--section-padding, 1.5rem);

  &.divided + &.divided {
    border-top: 1px solid var(--k-card-border);
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;

    .section-title {
      margin: 0;
      font-size: 1.125rem;
      font-weight: 500;
    }

    .section-actions {
      display: flex;
      gap: 0.5rem;
    }
  }

  .section-content {
    display: grid;
    gap: 1rem;

    &.charts {
      grid-template-columns: repeat(auto-fit, minmax(520px, 1fr));
    }

    &.numbers {
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    }

    &.list {
      grid-template-columns: 1fr;
    }

    &.column {
      display: flex;
      flex-direction: column;
    }
  }
}
</style>
