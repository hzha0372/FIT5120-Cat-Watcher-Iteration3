<script setup>
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'

/*
  Home View Responsibilities
  - Presents the landing experience and primary feature entry points.
  - Loads high-level mission coverage metrics from /api/about-us for dashboard context.
  - Renders icon-backed feature cards and gracefully falls back when an icon asset fails.
*/

const loading = ref(false)
const error = ref('')
const missionStats = ref(null)
const failedIcons = ref({})

const formatCount = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return '--'
  return n.toLocaleString()
}

// Home summary numbers are a direct projection of About Us page JS coverage counts.
const stats = computed(() => {
  const coverage = missionStats.value?.coverage || {}
  return [
    { value: formatCount(coverage.usersTracked), label: 'Users Tracked' },
    { value: formatCount(coverage.speciesCached), label: 'Species Records Cached' },
    { value: formatCount(coverage.reservesMapped), label: 'Reserves Mapped' },
    { value: formatCount(coverage.roamingLogs), label: 'Roaming Logs' },
  ]
})

const tools = [
  {
    title: 'Interactive Risk Map',
    description: 'Explore geographic data showing cat impact zones across different regions',
    to: '/risk-map',
    icon: 'Map',
    iconSrc: '/images/risk-map-icon.svg',
    tone: 'cw-icon-blue',
  },
  {
    title: 'Impact Score Calculator',
    description: 'Calculate and understand the environmental impact score for your area',
    to: '/impact-score',
    icon: 'Impact',
    iconSrc: '/images/impact-score-icon.svg',
    tone: 'cw-icon-purple',
  },
  {
    title: 'Cat Scoreboard',
    description: 'View rankings and compare impact metrics across different regions',
    to: '/cat-scoreboard',
    icon: 'Score',
    iconSrc: '/images/scoreboard-icon.svg',
    tone: 'cw-icon-orange',
  },
  {
    title: 'Photo Identifier',
    description: 'Upload a wildlife photo, check supported species, and view database sighting history',
    to: '/photo-identifier',
    icon: 'Photo',
    iconSrc: '/images/photo-identifier-icon.svg',
    tone: 'cw-icon-emerald',
  },
  {
    title: 'Hunter Profile',
    description: "Answer five behaviour questions and reveal your cat's local wildlife risk profile",
    to: '/hunter-profile',
    icon: 'Quiz',
    iconSrc: '',
    tone: 'cw-icon-violet',
  },
  {
    title: 'Wildlife Intelligence',
    description: 'View nearby threatened species alerts and report sightings without a photo',
    to: '/wildlife-intelligence',
    icon: 'Feed',
    iconSrc: '/images/wildlife-intelligence-icon.svg',
    tone: 'cw-icon-pink',
  },
  {
    title: 'About Catwatcher',
    description: 'Learn about our vision to protect wildlife and promote responsible pet ownership',
    to: '/about',
    icon: 'About',
    iconSrc: '/images/about-icon.svg',
    tone: 'cw-icon-blue',
  },
]

// Fetch once on page load so Home always reflects the current database counts owned by the About Us page JS.
const fetchMissionStats = async () => {
  loading.value = true
  error.value = ''
  try {
    const response = await fetch('/api/about-us')
    const payload = await response.json()
    if (!response.ok) throw new Error(payload?.error || 'Failed to load database stats.')
    missionStats.value = payload
  } catch (err) {
    error.value = 'Unable to load database stats right now.'
  } finally {
    loading.value = false
  }
}

onMounted(fetchMissionStats)

const markIconFailed = (title) => {
  failedIcons.value[title] = true
}
</script>

<template>
  <main class="home-prototype cw-page-white">
    <section class="home-hero">
      <div class="cw-container cw-text-center">
        <span class="cw-pill">Environmental Impact Tracking</span>
        <h1>
          <span class="title-line title-dark">Understanding Cat Impact</span>
          <span class="title-line title-green">On Wildlife &amp; Environment</span>
        </h1>
        <p>
          Comprehensive data analysis and visualization platform helping communities make
          informed decisions about cat management and wildlife conservation.
        </p>
        <div class="hero-actions">
          <RouterLink class="cw-button cw-button-primary" to="/risk-map">
            Explore Risk Map
          </RouterLink>
          <RouterLink class="cw-button cw-button-secondary" to="/impact-score">
            Calculate Impact
          </RouterLink>
        </div>
      </div>
    </section>

    <section class="tools-section">
      <div class="cw-container">
        <div class="cw-text-center section-heading">
          <h2 class="cw-section-title">Powerful Tools for Impact Analysis</h2>
          <p class="cw-section-subtitle">
            Comprehensive suite of tools to monitor, analyze, and understand environmental impact
          </p>
        </div>

        <div class="tool-grid">
          <RouterLink
            v-for="tool in tools"
            :key="tool.title"
            class="tool-card cw-card"
            :to="tool.to"
          >
            <span class="cw-icon-tile" :class="tool.tone">
              <img
                v-if="tool.iconSrc && !failedIcons[tool.title]"
                :src="tool.iconSrc"
                :alt="`${tool.title} icon`"
                class="cw-icon-image"
                @error="markIconFailed(tool.title)"
              />
              <template v-else>{{ tool.icon }}</template>
            </span>
            <h3>{{ tool.title }}</h3>
            <p>{{ tool.description }}</p>
            <strong>Explore <span>→</span></strong>
          </RouterLink>
        </div>
      </div>
    </section>

    <section class="cta-section">
      <div class="cta-panel">
        <h2>Ready to Get Started?</h2>
        <p>Check your area's impact score and discover how you can make a difference</p>
        <RouterLink to="/impact-score">Calculate Impact Score</RouterLink>
      </div>
    </section>
  </main>
</template>

<style scoped>
.home-prototype {
  min-height: calc(100dvh - 101px);
  color: var(--cw-text);
}

.home-hero {
  padding: 42px 16px 48px;
}

.home-hero h1 {
  margin: 20px auto 0;
  max-width: 1280px;
  color: var(--cw-text);
  font-size: clamp(2.75rem, 4.9vw, 4.25rem);
  line-height: 1.08;
  font-weight: 900;
}

.title-line {
  display: block;
}

.title-dark {
  white-space: nowrap;
}

.title-green {
  color: var(--cw-emerald);
  white-space: nowrap;
}

.home-hero p {
  max-width: 850px;
  margin: 20px auto 0;
  color: var(--cw-muted);
  font-size: clamp(1.05rem, 1.8vw, 1.24rem);
  line-height: 1.45;
}

.hero-actions {
  margin-top: 26px;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 16px;
}

.stats-band {
  background: #ffffff;
  padding: 34px 16px;
}

.stat-item {
  text-align: center;
}

.stat-item strong {
  display: block;
  color: var(--cw-emerald);
  font-size: clamp(1.85rem, 3vw, 2.45rem);
  line-height: 1;
  font-weight: 900;
}

.stat-item span {
  display: block;
  margin-top: 8px;
  color: var(--cw-muted);
  font-size: 1rem;
}

.status-line,
.error-line {
  margin: 0 0 18px;
  text-align: center;
  font-weight: 750;
}

.status-line {
  color: var(--cw-muted);
}

.error-line {
  color: #b91c1c;
}

.tools-section {
  padding: 48px 16px;
  background: #f9fafb;
}

.section-heading {
  margin-bottom: 34px;
}

.tool-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 22px;
}

.tool-card {
  min-height: 210px;
  padding: 24px;
  color: inherit;
  text-decoration: none;
  transition:
    border-color 180ms ease,
    box-shadow 180ms ease,
    transform 180ms ease;
}

.tool-card:hover {
  border-color: #a7f3d0;
  box-shadow: 0 20px 35px rgba(17, 24, 39, 0.12);
  transform: translateY(-2px);
}

.tool-card h3 {
  margin: 18px 0 0;
  color: var(--cw-text);
  font-size: 1.38rem;
  line-height: 1.2;
  font-weight: 850;
}

.tool-card p {
  margin: 12px 0 0;
  color: var(--cw-muted);
  font-size: 1.02rem;
  line-height: 1.48;
}

.tool-card strong {
  display: inline-flex;
  gap: 8px;
  margin-top: 18px;
  color: var(--cw-emerald);
  font-size: 1.05rem;
}

.cw-icon-image {
  width: 34px;
  height: 34px;
  object-fit: contain;
  display: block;
}

.cta-section {
  padding: 48px 16px;
  background: #f9fafb;
}

.cta-panel {
  width: min(100%, 1024px);
  margin: 0 auto;
  border-radius: 24px;
  padding: 34px;
  text-align: center;
  color: #ffffff;
  background: linear-gradient(90deg, var(--cw-emerald), var(--cw-teal));
}

.cta-panel h2 {
  margin: 0;
  font-size: clamp(2rem, 4vw, 2.6rem);
  line-height: 1.15;
  font-weight: 900;
}

.cta-panel p {
  margin: 14px 0 0;
  font-size: 1.12rem;
}

.cta-panel a {
  display: inline-flex;
  min-height: 50px;
  align-items: center;
  justify-content: center;
  margin-top: 24px;
  border-radius: 12px;
  background: #ffffff;
  color: var(--cw-emerald);
  padding: 0 32px;
  text-decoration: none;
  font-weight: 800;
}

@media (max-width: 980px) {
  .home-hero {
    padding-top: 44px;
  }

  .tool-grid {
    grid-template-columns: 1fr;
  }

  .title-dark,
  .title-green {
    white-space: normal;
  }

  .cta-panel {
    padding: 36px 22px;
  }
}
</style>
