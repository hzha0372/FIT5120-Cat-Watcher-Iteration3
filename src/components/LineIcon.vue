<script setup>
/*
  Line Icon Component
  - Provides the small stroke icons used by the new Hunter Profile and Wildlife Intelligence pages.
  - Keeps these page-specific icons in one component so templates can stay readable and visual updates remain consistent.
  - Icons are presentational only: they do not carry data values and are hidden from screen readers with aria-hidden.
*/

defineProps({
  name: {
    type: String,
    required: true,
  },
})
</script>

<template>
  <svg
    class="line-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2.4"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <template v-if="name === 'target'">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.8" />
    </template>

    <template v-else-if="name === 'brain'">
      <path d="M9.5 2A2.5 2.5 0 0 0 7 4.5v.2A3 3 0 0 0 4.7 9a3.5 3.5 0 0 0 .8 6.8A3 3 0 0 0 9 21a2.5 2.5 0 0 0 2.5-2.5v-14A2.5 2.5 0 0 0 9.5 2Z" />
      <path d="M14.5 2A2.5 2.5 0 0 1 17 4.5v.2A3 3 0 0 1 19.3 9a3.5 3.5 0 0 1-.8 6.8A3 3 0 0 1 15 21a2.5 2.5 0 0 1-2.5-2.5v-14A2.5 2.5 0 0 1 14.5 2Z" />
      <path d="M7 7.5h1.5A2.5 2.5 0 0 1 11 10" />
      <path d="M17 7.5h-1.5A2.5 2.5 0 0 0 13 10" />
      <path d="M8 14a3 3 0 0 0 3 3" />
      <path d="M16 14a3 3 0 0 1-3 3" />
    </template>

    <template v-else-if="name === 'alert'">
      <path d="M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </template>

    <template v-else-if="name === 'shield'">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
    </template>

    <template v-else-if="name === 'paw'">
      <circle cx="5" cy="8" r="2" />
      <circle cx="10" cy="5" r="2" />
      <circle cx="15" cy="5" r="2" />
      <circle cx="19" cy="8" r="2" />
      <path d="M8.8 12.8a4.6 4.6 0 0 1 6.4 0l2.3 2.3a3.2 3.2 0 0 1-2.3 5.5h-6.4a3.2 3.2 0 0 1-2.3-5.5l2.3-2.3Z" />
    </template>

    <template v-else-if="name === 'map-pin'">
      <path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </template>

    <template v-else-if="name === 'trend'">
      <path d="M3 17 9 11l4 4 7-7" />
      <path d="M14 8h6v6" />
    </template>

    <template v-else-if="name === 'lightbulb'">
      <path d="M9 18h6" />
      <path d="M10 22h4" />
      <path d="M8.5 14.5A6 6 0 1 1 15.5 14c-.9.7-1.5 1.8-1.5 3h-4c0-1.1-.5-2-1.5-2.5Z" />
    </template>

    <template v-else-if="name === 'rotate-ccw'">
      <path d="M4 4v6h6" />
      <path d="M4.6 10A8 8 0 1 0 7 5.2" />
    </template>

    <template v-else-if="name === 'chevron-right'">
      <path d="m9 18 6-6-6-6" />
    </template>
  </svg>
</template>
