<template>
  <k-card class="k-analytic-number">
    <k-icon :name="icon"/>
    <div class="content">
      <p class="title">{{ title }}</p>
      <p class="value"><slot>{{ formatted }}</slot></p>
    </div>
    <template #footer v-if="$slots['footer-left']">
      <span class="left"><slot name="footer-left"></slot></span>
      <span class="right"><slot name="footer-right">-</slot></span>
    </template>
  </k-card>
</template>

<script lang="ts" setup>

import { computed } from 'vue'

const props = defineProps<{
  title: string
  icon: string
  value?: number | string
  unit?: string
}>()

const formatted = computed(() => {
  if (props.value === undefined || props.value === null) return '-'
  const v = typeof props.value === 'number' ? props.value.toLocaleString() : props.value
  return props.unit ? `${v} ${props.unit}` : v
})

</script>

<style lang="scss">

.k-analytic-number .k-card-body {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 1rem 0;

  .k-icon {
    height: 2.5rem;
    width: 3rem;
    color: var(--k-text-normal);
    transition: color 0.3s ease;

    @media screen and (max-width: 768px) {
      height: 2.25rem;
    }
  }

  .content {
    float: right;
    text-align: right;
    height: 3rem;
    display: flex;
    flex-direction: column;
    justify-content: space-around;
  }

  p {
    margin: 0;
    font-size: 0.9375rem;
  }

  .value {
    font-size: 1rem;
  }

  @media (max-width: 768px) {
    margin: 0.5rem 0;
    padding: 0 1rem;
  }
}

.k-analytic-number footer {
  font-size: 0.9em;
  border-top: 1px solid var(--k-card-border);
  padding-top: 0.75rem;
  margin-bottom: 0.75rem;
  display: flex;
  justify-content: space-between;

  @media (max-width: 768px) {
    margin: 0.5rem 0;
    padding: 0.5rem 1rem 0;
  }
}

</style>
