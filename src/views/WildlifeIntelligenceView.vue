<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import LineIcon from '../components/LineIcon.vue'
import { getCurrentUser } from '../utils/auth'

/*
  Wildlife Intelligence View Responsibilities
  - Resolves postcode/suburb input through the same Victorian suburb lookup pattern as the other search pages.
  - Does not auto-analyze on mount; the user must type a postcode/suburb and click Analyze before numeric results render.
  - Loads numeric wildlife data from /api/wildlife-intelligence after Analyze: record counts, 5km distance values, nearest reserve distances, and hotspot severity.
  - Keeps Wikipedia image lookup as a visual enhancement only; images are not used for any score, count, percentage, distance, or database decision.
  - Presents database-backed prediction cards and activity hotspots from species_cache, suburb_demographics, and reserves.
  - Keeps the historical-data note visible by default, while avoiding a hard-coded postcode/suburb until the user analyzes an entered location.
  - Epic 10 UI contract:
    1) User-triggered analysis only: no silent default location analysis.
    2) Predictions and hotspots are treated as backend model outputs and rendered as-is.
    3) Visual assets (images, labels, decorative map dots) must not alter numeric risk outcomes.
*/

const user = ref(getCurrentUser())

// View state: predictions/hotspots are hidden until payload is populated by an explicit Analyze request.
const activeTab = ref('predictions')
const loading = ref(false)
const feedError = ref('')
const payload = ref(null)

// Search state mirrors the Risk Map style: no default input text, suggestions come from suburb_demographics.
const postcodeInput = ref('')
const activePostcode = ref(String(user.value?.postcode || '').trim())
const selectedLocation = ref(null)
const suburbSuggestions = ref([])
const suburbLoading = ref(false)

// Visual-only image cache. These URLs never drive numeric wildlife intelligence values.
const cardImageUrls = ref({})

let suburbTimer = null

const predictionItems = computed(() => payload.value?.predictions || [])
const hotspotItems = computed(() => payload.value?.hotspots || [])

// The analyzed user/location object comes from the API after suburb_demographics resolves the searched postcode.
const feedUser = computed(() => payload.value?.user || user.value || {})
const hasAnalyzed = computed(() => Boolean(payload.value?.user?.postcode))

// Match the other page search inputs: postcode searches display postcode + suburb; suburb searches can display just the suburb.
const shouldDisplayPostcode = (value) => /^\s*\d/.test(String(value || ''))

const suburbLabel = (item, includePostcode = shouldDisplayPostcode(postcodeInput.value)) => {
  const postcode = String(item?.postcode || '').trim()
  const name = String(item?.name || '').trim()
  if (!postcode) return name
  if (!name || name.toLowerCase() === postcode.toLowerCase()) return postcode
  if (includePostcode) return `${postcode} ${name}`
  return name
}

const suggestionLabel = (item) => suburbLabel(item, true)

const displayLocation = computed(() => {
  const postcode = String(feedUser.value?.postcode || activePostcode.value || '').trim()
  const suburb = String(feedUser.value?.suburbName || '').trim()
  if (!postcode) return 'your area'
  return suburb ? `${suburb} ${postcode}` : `postcode ${postcode}`
})

// The UI week label is presentation-only; prediction scores are calculated by the API from species_cache dates.
const weekRange = computed(() => {
  const start = new Date()
  const end = new Date()
  end.setDate(start.getDate() + 6)
  const formatter = new Intl.DateTimeFormat('en-AU', { month: 'short', day: 'numeric', year: 'numeric' })
  return `${formatter.format(start)} - ${formatter.format(end)}`
})

// Convert API prey type strings into the compact card categories used by the Figma layout.
const normalizeCategory = (preyType) => {
  const text = String(preyType || '').toLowerCase()
  if (text.includes('bird')) return 'Bird'
  if (text.includes('reptile')) return 'Reptile'
  if (text.includes('mammal')) return 'Mammal'
  if (text.includes('amphibian')) return 'Amphibian'
  if (text.includes('insect')) return 'Insect'
  return 'Native Species'
}

const formatKm = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? `${n.toFixed(1)} km` : 'Database pending'
}

// Wikipedia image helpers are intentionally isolated from all numeric analysis logic.
const toWikiTitle = (value) => String(value || '').trim().replace(/\s+/g, '_')

const fetchSpeciesImage = async (card) => {
  const titles = [toWikiTitle(card.scientificName), toWikiTitle(card.commonName)].filter(Boolean)
  for (const title of titles) {
    try {
      const response = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`)
      if (!response.ok) continue
      const data = await response.json()
      const imageUrl = data?.thumbnail?.source || data?.originalimage?.source || ''
      if (imageUrl) return imageUrl
    } catch {
      // Ignore and try the next title.
    }
  }
  return ''
}

const loadPredictionImages = async () => {
  const cards = predictionCards.value || []
  const updates = {}
  await Promise.all(
    cards.map(async (card) => {
      const key = card.id
      if (!key || cardImageUrls.value[key] !== undefined) return
      updates[key] = await fetchSpeciesImage(card)
    }),
  )
  if (Object.keys(updates).length) {
    cardImageUrls.value = { ...cardImageUrls.value, ...updates }
  }
}

// Prediction cards use API rows only.
const predictionCards = computed(() => {
  return predictionItems.value.map((item) => {
    const category = normalizeCategory(item.category)
    const level = String(item.activityLevel || 'Low')
    return {
      ...item,
      category,
      risk: {
        label: level,
        className: level === 'High' ? 'risk-high' : level === 'Medium' ? 'risk-medium' : 'risk-low',
      },
      imageClass: `image-${category.toLowerCase().replace(/\s+/g, '-')}`,
    }
  })
})

// Hotspot rows are API-derived from species_cache grid buckets.
const hotspotRows = computed(() => {
  return hotspotItems.value.map((row) => ({
    category: normalizeCategory(row.dominantCategory),
    count: Number(row.recordCount || 0),
    averageDistance: Number(row.distanceKm),
    level: String(row.severityLevel || 'Low'),
    lat: Number(row.lat),
    lng: Number(row.lng),
    risk:
      row.severityLevel === 'High'
        ? 'risk-high'
        : row.severityLevel === 'Medium'
          ? 'risk-medium'
          : 'risk-low',
  }))
})

// Plot database hotspot coordinates into a simple Figma-style map without introducing any new numeric source.
const hotspotDots = computed(() => {
  const geoRows = hotspotRows.value.filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lng))
  if (geoRows.length) {
    const baseLat = Number(feedUser.value?.lat)
    const baseLng = Number(feedUser.value?.lng)
    const allLats = Number.isFinite(baseLat) ? [baseLat, ...geoRows.map((row) => row.lat)] : geoRows.map((row) => row.lat)
    const allLngs = Number.isFinite(baseLng) ? [baseLng, ...geoRows.map((row) => row.lng)] : geoRows.map((row) => row.lng)
    const minLat = Math.min(...allLats)
    const maxLat = Math.max(...allLats)
    const minLng = Math.min(...allLngs)
    const maxLng = Math.max(...allLngs)
    const latSpan = Math.max(maxLat - minLat, 0.01)
    const lngSpan = Math.max(maxLng - minLng, 0.01)

    return geoRows.map((row) => {
      const left = 10 + ((row.lng - minLng) / lngSpan) * 80
      const top = 90 - ((row.lat - minLat) / latSpan) * 80
      return {
        ...row,
        left: Number.isFinite(left) ? left : 50,
        top: Number.isFinite(top) ? top : 50,
        size: row.level === 'High' ? 140 : row.level === 'Medium' ? 108 : 78,
      }
    })
  }

  const positions = [
    { left: 35, top: 44, size: 138 },
    { left: 67, top: 30, size: 142 },
    { left: 77, top: 68, size: 112 },
    { left: 25, top: 73, size: 74 },
  ]
  return hotspotRows.value.map((row, index) => ({
    ...row,
    ...(positions[index] || positions[positions.length - 1]),
  }))
})

// Data-science visualizations reuse prediction and hotspot sources without changing numeric outcomes.
const summaryStats = computed(() => {
  const cards = predictionCards.value
  const hotspots = hotspotRows.value

  const totalSpecies = cards.length

  return {
    totalSpecies,
    hotspotCount: hotspots.length,
  }
})

const likelihoodRanking = computed(() => {
  const items = predictionItems.value
  if (!items.length) return []
  const max = Math.max(...items.map((i) => Number(i.likelihoodScore) || 0), 1)
  return items
    .slice()
    .sort((a, b) => (Number(b.likelihoodScore) || 0) - (Number(a.likelihoodScore) || 0))
    .slice(0, 6)
    .map((item) => {
      const score = Number(item.likelihoodScore) || 0
      const level = String(item.activityLevel || 'Low')
      return {
        id: item.id || `${item.commonName}`,
        name: item.commonName,
        score,
        pct: Math.max(3, (score / max) * 100),
        level,
        levelClass: level === 'High' ? 'risk-high' : level === 'Medium' ? 'risk-medium' : 'risk-low',
      }
    })
})

const CATEGORY_PALETTE = {
  Bird: '#2563eb',
  Reptile: '#059669',
  Mammal: '#d97706',
  Amphibian: '#0891b2',
  Insect: '#9333ea',
  'Native Species': '#64748b',
}

const categoryBreakdown = computed(() => {
  const counts = new Map()
  for (const card of predictionCards.value) {
    counts.set(card.category, (counts.get(card.category) || 0) + 1)
  }
  const total = Array.from(counts.values()).reduce((a, b) => a + b, 0)
  if (!total) return []
  return Array.from(counts.entries())
    .map(([category, count]) => ({
      category,
      count,
      pct: (count / total) * 100,
      color: CATEGORY_PALETTE[category] || '#64748b',
    }))
    .sort((a, b) => b.count - a.count)
})

const SEVERITY_PALETTE = { High: '#ef4444', Medium: '#f97316', Low: '#eab308' }

const severityDistribution = computed(() => {
  const buckets = { High: 0, Medium: 0, Low: 0 }
  for (const h of hotspotRows.value) {
    if (buckets[h.level] === undefined) buckets[h.level] = 0
    buckets[h.level] += 1
  }
  const total = Object.values(buckets).reduce((a, b) => a + b, 0)
  if (!total) return []
  return Object.entries(buckets)
    .filter(([, count]) => count > 0)
    .map(([level, count]) => ({
      level,
      count,
      pct: (count / total) * 100,
      color: SEVERITY_PALETTE[level] || '#94a3b8',
    }))
})

// Build SVG donut segments with cumulative stroke-dashoffset; r=15.9155 keeps the circumference at 100 so pct values can be used directly.
const buildDonutSegments = (rows) => {
  let offset = 0
  return rows.map((row) => {
    const segment = {
      ...row,
      dashArray: `${row.pct} ${100 - row.pct}`,
      dashOffset: -offset,
    }
    offset += row.pct
    return segment
  })
}

const categoryDonut = computed(() => buildDonutSegments(categoryBreakdown.value))
const severityDonut = computed(() => buildDonutSegments(severityDistribution.value))

// Suburb autocomplete uses the same /api/wildlife-intelligence?action=suburbs endpoint pattern as the other search pages.
const fetchSuburbs = async (query, limit = 12) => {
  const response = await fetch(`/api/wildlife-intelligence?action=suburbs&q=${encodeURIComponent(query)}&limit=${limit}`)
  const data = await response.json()
  if (!response.ok) throw new Error(data?.error || 'Suburb lookup failed.')
  return data?.results || []
}

const loadSuburbSuggestions = async () => {
  const q = postcodeInput.value.trim()
  if (q.length < 2) {
    suburbSuggestions.value = []
    return
  }
  suburbLoading.value = true
  try {
    suburbSuggestions.value = await fetchSuburbs(q, 12)
  } catch {
    suburbSuggestions.value = []
  } finally {
    suburbLoading.value = false
  }
}

const chooseSuburb = (item) => {
  selectedLocation.value = item
  postcodeInput.value = suburbLabel(item, shouldDisplayPostcode(postcodeInput.value))
  suburbSuggestions.value = []
}

// Resolve typed text into a Victorian postcode before any feed/prediction/hotspot query is allowed.
const resolvePostcode = async () => {
  const q = postcodeInput.value.trim()
  if (
    selectedLocation.value?.postcode &&
    [suburbLabel(selectedLocation.value, true), suburbLabel(selectedLocation.value, false), selectedLocation.value.displayQuery]
      .filter(Boolean)
      .includes(q)
  ) {
    return selectedLocation.value.postcode
  }

  const direct = q.match(/\b(\d{4})\b/)?.[1] || ''
  if (direct) return direct
  if (!q) throw new Error('Please enter a Victorian postcode or suburb.')

  const [match] = await fetchSuburbs(q, 1)
  if (!match?.postcode) throw new Error('Please select a Victorian suburb or enter a valid 4-digit postcode.')
  selectedLocation.value = match
  postcodeInput.value = suburbLabel(match, shouldDisplayPostcode(q))
  return match.postcode
}

// Load the numeric analysis sections in one API call: predictions and hotspots.
const loadFeed = async (postcode = activePostcode.value) => {
  loading.value = true
  feedError.value = ''
  try {
    const params = new URLSearchParams({ action: 'feed' })
    if (user.value?.id) params.set('userId', user.value.id)
    if (postcode) params.set('postcode', postcode)
    const response = await fetch(`/api/wildlife-intelligence?${params.toString()}`)
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || 'Unable to load wildlife intelligence.')
    payload.value = data
    activePostcode.value = data.user?.postcode || postcode
    if (data.user?.postcode && postcodeInput.value.trim()) {
      selectedLocation.value = {
        postcode: data.user.postcode,
        name: data.user.suburbName,
      }
    }
  } catch (err) {
    feedError.value = err?.message || 'Unable to load wildlife intelligence.'
  } finally {
    loading.value = false
  }
}

// Analyze button handler; keeps results hidden until this succeeds, matching the Risk Map search behavior.
const submitLocation = async () => {
  feedError.value = ''
  try {
    const postcode = await resolvePostcode()
    await loadFeed(postcode)
    activeTab.value = 'predictions'
  } catch (err) {
    feedError.value = err?.message || 'Please enter a valid Victorian postcode or suburb.'
  }
}

watch(postcodeInput, () => {
  if (
    selectedLocation.value?.postcode &&
    [suburbLabel(selectedLocation.value, true), suburbLabel(selectedLocation.value, false), selectedLocation.value.displayQuery]
      .filter(Boolean)
      .includes(postcodeInput.value.trim())
  ) {
    suburbSuggestions.value = []
    return
  }
  selectedLocation.value = null
  if (suburbTimer) clearTimeout(suburbTimer)
  suburbTimer = setTimeout(loadSuburbSuggestions, 180)
})

watch(predictionCards, () => {
  loadPredictionImages()
})

// Mount only hydrates auth context; numeric intelligence still waits for Analyze.
onMounted(async () => {
  user.value = getCurrentUser()
  activePostcode.value = String(user.value?.postcode || '').trim()
  await loadPredictionImages()
})
</script>

<template>
  <main class="wildlife-page">
    <!-- Header: static feature title; no location-specific data is shown before the user analyzes a search. -->
    <section class="intelligence-header">
      <div class="header-title">
        <span class="header-icon">
          <LineIcon name="brain" />
        </span>
        <div>
          <h1>Community Wildlife Intelligence</h1>
          <p>Data-driven wildlife awareness powered by biodiversity insights</p>
        </div>
      </div>
    </section>

    <div class="wildlife-wrap">
      <!-- Search: manual postcode/suburb entry, matching Risk Map behavior with no default auto-filled query. -->
      <section class="search-card">
        <div class="search-copy">
          <span class="pin-icon">
            <LineIcon name="map-pin" />
          </span>
          <div>
            <h2>Enter Your Victorian Postcode or Suburb</h2>
            <p>Discover which threatened species are most likely to be active in your area this week</p>
          </div>
        </div>

        <form class="search-row" @submit.prevent="submitLocation">
          <label class="postcode-field">
            <span>Postcode or Suburb</span>
            <input
              v-model="postcodeInput"
              type="search"
              inputmode="search"
              autocomplete="off"
              placeholder="Postcode or Suburb"
            />
            <ul v-if="suburbSuggestions.length" class="suggestions">
              <li v-for="item in suburbSuggestions" :key="item.id" @click="chooseSuburb(item)">
                {{ suggestionLabel(item) }}
              </li>
            </ul>
            <small v-if="suburbLoading">Searching...</small>
          </label>

          <button type="submit" class="analyze-button" :disabled="loading">
            {{ loading ? 'Analyzing...' : 'Analyze' }}
          </button>
        </form>

        <p v-if="feedError" class="error-line">{{ feedError }}</p>
      </section>

      <!-- Data note: always visible, generic provenance text with no hard-coded postcode/suburb. -->
      <section class="data-note">
        <span>
          <LineIcon name="trend" />
        </span>
        <div>
          <h3>Analysis Based On Historical Data</h3>
          <p>
            Predictions use species_cache biodiversity records, seasonal observation patterns,
            and reserve proximity within the searched 5km area.
            Updated from the live database.
          </p>
        </div>
      </section>

      <!-- Analysis results: hidden until /api/wildlife-intelligence returns a payload for the searched postcode. -->
      <template v-if="hasAnalyzed">
        <!-- Summary stats: at-a-glance numeric overview derived from the existing API payload; does not replace any prior section. -->
        <section class="insights-overview">
          <div class="overview-card">
            <span class="overview-label">Species Tracked</span>
            <strong class="overview-value">{{ summaryStats.totalSpecies }}</strong>
            <small>Predicted active near {{ displayLocation }}</small>
          </div>
          <div class="overview-card">
            <span class="overview-label">Detected Hotspots</span>
            <strong class="overview-value">{{ summaryStats.hotspotCount }}</strong>
            <small>Spatial clusters within 5 km</small>
          </div>
        </section>

        <!-- Tabs switch between the two database-derived summary views. -->
        <div class="tab-switch" role="tablist" aria-label="Wildlife intelligence sections">
          <button
            type="button"
            :class="{ active: activeTab === 'predictions' }"
            @click="activeTab = 'predictions'"
          >
            Wildlife Predictions
          </button>
          <button
            type="button"
            :class="{ active: activeTab === 'hotspots' }"
            @click="activeTab = 'hotspots'"
          >
            Activity Hotspots
          </button>
        </div>

        <!-- Predictions: species_cache records scored by count, seasonality, and distance in the API. -->
        <section v-if="activeTab === 'predictions'" class="content-panel prediction-panel">
          <div class="panel-head">
            <h2>Predicted Threatened Species Activity</h2>
            <p>
              Species most likely to be active near {{ displayLocation }} this week
              ({{ weekRange }})
            </p>
          </div>

          <p v-if="loading && !predictionCards.length" class="status-line">Loading wildlife intelligence...</p>

          <!-- New visualizations: likelihood score ranking + category breakdown donut. Both read from existing API payload. -->
          <div v-if="likelihoodRanking.length || categoryBreakdown.length" class="insights-grid">
            <article v-if="likelihoodRanking.length" class="insight-card">
              <header>
                <h3>Likelihood Score Ranking</h3>
                <p>Weighted from local record count, seasonal alignment, and proximity</p>
              </header>
              <ul class="ranking-list">
                <li v-for="(row, index) in likelihoodRanking" :key="row.id" class="ranking-row">
                  <span class="ranking-index">{{ index + 1 }}</span>
                  <div class="ranking-meter">
                    <div class="ranking-meter-head">
                      <strong>{{ row.name }}</strong>
                      <span class="risk-badge" :class="row.levelClass">{{ row.level }}</span>
                    </div>
                    <div class="meter-track">
                      <span class="meter-fill" :class="row.levelClass" :style="{ width: `${row.pct}%` }"></span>
                    </div>
                  </div>
                  <span class="ranking-value">{{ row.score.toFixed(1) }}</span>
                </li>
              </ul>
            </article>

            <article v-if="categoryBreakdown.length" class="insight-card">
              <header>
                <h3>Species Category Mix</h3>
                <p>Share of predicted species by taxonomic group</p>
              </header>
              <div class="donut-wrap">
                <svg viewBox="0 0 42 42" class="donut" role="img" aria-label="Species category donut chart">
                  <circle class="donut-track" cx="21" cy="21" r="15.91549430918954" />
                  <circle
                    v-for="seg in categoryDonut"
                    :key="seg.category"
                    class="donut-segment"
                    cx="21"
                    cy="21"
                    r="15.91549430918954"
                    :stroke="seg.color"
                    :stroke-dasharray="seg.dashArray"
                    :stroke-dashoffset="seg.dashOffset"
                  />
                  <text class="donut-center" x="21" y="21" text-anchor="middle" dominant-baseline="central">
                    {{ summaryStats.totalSpecies }}
                  </text>
                </svg>
                <ul class="legend-list">
                  <li v-for="seg in categoryBreakdown" :key="seg.category">
                    <span class="legend-swatch" :style="{ background: seg.color }"></span>
                    <span>{{ seg.category }}</span>
                    <strong>{{ seg.count }}</strong>
                    <small>{{ seg.pct.toFixed(0) }}%</small>
                  </li>
                </ul>
              </div>
            </article>
          </div>

          <div v-if="predictionCards.length" class="prediction-grid">
            <article v-for="card in predictionCards" :key="card.id" class="prediction-card">
              <div class="species-photo" :class="card.imageClass">
                <!-- Visual-only Wikipedia image; the card's numeric/status text still comes from the database API. -->
                <img
                  v-if="cardImageUrls[card.id]"
                  :src="cardImageUrls[card.id]"
                  :alt="card.commonName"
                  class="species-image"
                  loading="lazy"
                />
                <span>{{ card.category }}</span>
              </div>
              <div class="prediction-body">
                <div class="prediction-title">
                  <div>
                    <h3>{{ card.commonName }}</h3>
                  </div>
                  <span class="risk-badge" :class="card.risk.className">
                    {{ card.risk.label }}
                  </span>
                </div>
                <p><strong>Status:</strong> {{ card.conservationStatus }}</p>
                <p><strong>Category:</strong> {{ card.category }}</p>
                <p><strong>Nearest Reserve:</strong> {{ formatKm(card.nearestReserveKm) }}</p>
                <small v-if="card.nearestReserveName">{{ card.nearestReserveName }}</small>
              </div>
            </article>
          </div>

          <article v-else-if="!loading" class="empty-feed">
            <h3>No nearby threatened activity found</h3>
            <p>
              The database has no threatened species records within 5km of this postcode in the
              current analysis.
            </p>
          </article>
        </section>

        <!-- Hotspots: API grid buckets from nearby species_cache observations, rendered as a simple Figma-style map. -->
        <section v-else class="content-panel hotspot-panel">
          <div class="panel-head">
            <h2>Wildlife Activity Hotspots</h2>
            <p>Spatial clusters based on historical threatened species records</p>
          </div>

          <!-- New visualization: hotspot severity donut chart and category stack. Reuses the existing hotspotRows source. -->
          <div v-if="severityDistribution.length || hotspotRows.length" class="insights-grid">
            <article v-if="severityDistribution.length" class="insight-card">
              <header>
                <h3>Hotspot Severity Mix</h3>
                <p>How detected clusters distribute across activity levels</p>
              </header>
              <div class="donut-wrap">
                <svg viewBox="0 0 42 42" class="donut" role="img" aria-label="Hotspot severity donut chart">
                  <circle class="donut-track" cx="21" cy="21" r="15.91549430918954" />
                  <circle
                    v-for="seg in severityDonut"
                    :key="seg.level"
                    class="donut-segment"
                    cx="21"
                    cy="21"
                    r="15.91549430918954"
                    :stroke="seg.color"
                    :stroke-dasharray="seg.dashArray"
                    :stroke-dashoffset="seg.dashOffset"
                  />
                  <text class="donut-center" x="21" y="21" text-anchor="middle" dominant-baseline="central">
                    {{ summaryStats.hotspotCount }}
                  </text>
                </svg>
                <ul class="legend-list">
                  <li v-for="seg in severityDistribution" :key="seg.level">
                    <span class="legend-swatch" :style="{ background: seg.color }"></span>
                    <span>{{ seg.level }} activity</span>
                    <strong>{{ seg.count }}</strong>
                    <small>{{ seg.pct.toFixed(0) }}%</small>
                  </li>
                </ul>
              </div>
            </article>

            <article v-if="hotspotRows.length" class="insight-card">
              <header>
                <h3>Hotspot Records by Category</h3>
                <p>Number of threatened-species records per dominant category</p>
              </header>
              <ul class="ranking-list">
                <li v-for="row in hotspotRows" :key="row.category" class="ranking-row">
                  <span class="ranking-index" :style="{ background: CATEGORY_PALETTE[row.category] || '#64748b' }">
                    {{ row.category.charAt(0) }}
                  </span>
                  <div class="ranking-meter">
                    <div class="ranking-meter-head">
                      <strong>{{ row.category }}</strong>
                      <span class="risk-badge" :class="row.risk">{{ row.level }}</span>
                    </div>
                    <div class="meter-track">
                      <span
                        class="meter-fill"
                        :style="{
                          width: `${Math.min(100, (row.count / Math.max(1, Math.max(...hotspotRows.map((r) => r.count)))) * 100)}%`,
                          background: CATEGORY_PALETTE[row.category] || '#64748b',
                        }"
                      ></span>
                    </div>
                  </div>
                  <span class="ranking-value">{{ row.count }}</span>
                </li>
              </ul>
            </article>
          </div>

          <div class="hotspot-map" aria-label="Activity hotspot map">
            <span class="map-grid"></span>
            <span class="home-dot">You</span>
            <span
              v-for="dot in hotspotDots"
              :key="dot.category"
              class="activity-dot"
              :class="dot.risk"
              :style="{ left: `${dot.left}%`, top: `${dot.top}%`, '--bubble-size': `${dot.size}px` }"
            ></span>
          </div>

          <div class="map-legend">
            <span><i class="home-key"></i>Your Location</span>
            <span><i class="risk-high"></i>High Activity</span>
            <span><i class="risk-medium"></i>Medium Activity</span>
            <span><i class="risk-low"></i>Low Activity</span>
          </div>

          <div class="hotspot-list">
            <h3>Detected Hotspots</h3>
            <article v-for="row in hotspotRows" :key="row.category" class="hotspot-row">
              <div>
                <span class="risk-badge" :class="row.risk">{{ row.level }}</span>
                <strong>{{ row.category }} Species</strong>
                <p>{{ row.count }} threatened species records</p>
              </div>
              <span>{{ formatKm(row.averageDistance) }}<small>from you</small></span>
            </article>
          </div>
        </section>

      </template>
    </div>
  </main>
</template>

<style scoped>
/* Page shell: green/blue Catwatcher background shared with the new Hunter Profile page. */
.wildlife-page {
  min-height: calc(100dvh - 101px);
  background:
    radial-gradient(circle at 10% 10%, rgba(187, 247, 208, 0.48), transparent 28%),
    radial-gradient(circle at 90% 20%, rgba(219, 234, 254, 0.7), transparent 34%),
    linear-gradient(135deg, #f1fff7 0%, #edfff8 42%, #edf7ff 100%);
  color: #0b0f19;
}

/* Header: desktop-first feature identity area with the line-icon brain mark. */
.intelligence-header {
  min-height: 170px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 28px;
  background: #ffffff;
  border-bottom: 1px solid #e5e7eb;
  box-shadow: 0 2px 12px rgba(15, 23, 42, 0.08);
  padding: 30px clamp(20px, 4vw, 78px);
}

.header-title {
  display: grid;
  grid-template-columns: 58px 1fr;
  gap: 24px;
  align-items: center;
}

.header-icon {
  width: 48px;
  height: 48px;
  display: grid;
  place-items: center;
  color: #08a84e;
}

.header-icon :deep(.line-icon) {
  width: 48px;
  height: 48px;
}

.header-title h1 {
  margin: 0;
  color: #101626;
  font-size: clamp(2.2rem, 3.6vw, 4.1rem);
  line-height: 1.03;
  font-weight: 950;
}

.header-title p {
  margin: 14px 0 0;
  color: #5d6678;
  font-size: clamp(1rem, 1.45vw, 1.55rem);
  font-weight: 750;
}

.feature-switch {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}

.feature-switch a {
  min-height: 66px;
  border: 1px solid #dfe3e8;
  border-radius: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 28px;
  color: #111827;
  background: #ffffff;
  box-shadow: 0 12px 28px rgba(15, 23, 42, 0.08);
  text-decoration: none;
  font-size: 1.2rem;
  font-weight: 950;
}

.feature-switch a.active {
  color: #ffffff;
  background: #030414;
  border-color: #030414;
}

.wildlife-wrap {
  width: min(100%, 1860px);
  margin: 0 auto;
  padding: 60px 16px 78px;
}

/* Cards: shared white panels for search and result sections. */
.search-card,
.content-panel {
  border: 1px solid #dfe3e8;
  border-radius: 22px;
  background: #ffffff;
  box-shadow: 0 18px 40px rgba(51, 65, 85, 0.08);
  padding: 46px;
}

/* Search form: manual postcode/suburb lookup before any numeric database result is shown. */
.search-copy {
  display: grid;
  grid-template-columns: 40px 1fr;
  gap: 20px;
  align-items: start;
}

.pin-icon {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  color: #0b0f19;
}

.pin-icon :deep(.line-icon),
.data-note span :deep(.line-icon) {
  width: 34px;
  height: 34px;
}

.search-copy h2,
.panel-head h2,
.formula-title h2 {
  margin: 0;
  color: #0b0f19;
  font-size: clamp(1.5rem, 2vw, 2.1rem);
  line-height: 1.15;
  font-weight: 950;
}

.search-copy p,
.panel-head p,
.data-note p {
  margin: 16px 0 0;
  color: #6f7282;
  font-size: clamp(1rem, 1.35vw, 1.45rem);
  line-height: 1.48;
  font-weight: 750;
}

.search-row {
  margin-top: 46px;
  display: grid;
  grid-template-columns: minmax(260px, 640px) 180px;
  gap: 22px;
  align-items: end;
}

.postcode-field {
  position: relative;
  display: grid;
  gap: 10px;
}

.postcode-field span {
  color: #374151;
  font-weight: 950;
}

.postcode-field input {
  width: 100%;
  min-height: 66px;
  border: 1px solid #eef0f4;
  border-radius: 10px;
  background: #f4f4f6;
  color: #0b0f19;
  padding: 0 24px;
  font: inherit;
  font-size: 1.1rem;
  font-weight: 850;
}

.postcode-field input::placeholder {
  color: #8b90a0;
}

.analyze-button {
  min-height: 66px;
  border: 1px solid transparent;
  border-radius: 10px;
  padding: 0 24px;
  font-family: inherit;
  font-size: 1.05rem;
  font-weight: 950;
  cursor: pointer;
}

.analyze-button {
  color: #ffffff;
  background: #030414;
}

.analyze-button:disabled {
  cursor: not-allowed;
  opacity: 0.64;
}

.suggestions {
  position: absolute;
  z-index: 30;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  max-height: 260px;
  overflow: auto;
  margin: 0;
  padding: 8px;
  list-style: none;
  border: 1px solid #dfe3e8;
  border-radius: 12px;
  background: #ffffff;
  box-shadow: 0 18px 35px rgba(15, 23, 42, 0.14);
}

.suggestions li {
  border-radius: 8px;
  padding: 12px 14px;
  color: #334155;
  font-weight: 850;
  cursor: pointer;
}

.suggestions li:hover {
  color: #047857;
  background: #ecfdf5;
}

.postcode-field small {
  color: #6f7282;
  font-weight: 750;
}

.error-line,
.success-line,
.status-line {
  margin: 18px 0 0;
  font-weight: 850;
}

.error-line {
  color: #b91c1c;
}

.success-line {
  color: #047857;
}

.status-line {
  color: #6f7282;
}

.data-note {
  margin-top: 58px;
  border: 2px solid #bfdbfe;
  border-radius: 16px;
  display: grid;
  grid-template-columns: 34px 1fr;
  gap: 18px;
  background: #eef6ff;
  padding: 26px 30px;
}

.data-note span {
  color: #0b0f19;
  font-size: 1.2rem;
  font-weight: 950;
}

.data-note h3 {
  margin: 0;
  color: #0b0f19;
  font-size: 1.25rem;
  font-weight: 950;
}

.data-note p {
  font-size: clamp(0.98rem, 1.3vw, 1.25rem);
}

/* Data-driven visualizations: summary stats strip, ranking bars, donut charts, histogram, and stacked bar. All are additive to the existing layout. */
.insights-overview {
  margin-top: 58px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 22px;
}

.overview-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 130px;
  border: 1px solid #dfe3e8;
  border-radius: 16px;
  background: #ffffff;
  padding: 22px 24px;
  box-shadow: 0 12px 26px rgba(15, 23, 42, 0.06);
}

.overview-label {
  color: #6f7282;
  font-size: 0.95rem;
  font-weight: 850;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.overview-value {
  color: #0b0f19;
  font-size: 2.4rem;
  font-weight: 950;
  line-height: 1;
}

.overview-card small {
  color: #6f7282;
  font-weight: 750;
}

.insights-grid {
  margin-top: 36px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 28px;
}

.insight-card {
  border: 1px solid #dfe3e8;
  border-radius: 18px;
  background: #ffffff;
  padding: 26px 28px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.insight-card header h3 {
  margin: 0;
  color: #0b0f19;
  font-size: 1.25rem;
  font-weight: 950;
}

.insight-card header p {
  margin: 6px 0 0;
  color: #6f7282;
  font-weight: 750;
}

.ranking-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 14px;
}

.ranking-row {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) 60px;
  gap: 14px;
  align-items: center;
}

.ranking-index {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border-radius: 999px;
  background: #f1f5f9;
  color: #0b0f19;
  font-weight: 950;
}

.ranking-meter {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ranking-meter-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.ranking-meter-head strong {
  color: #0b0f19;
  font-size: 1rem;
  font-weight: 950;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ranking-meter-head .risk-badge {
  padding: 4px 10px;
  font-size: 0.78rem;
}

.meter-track {
  position: relative;
  height: 10px;
  border-radius: 999px;
  background: #f1f5f9;
  overflow: hidden;
}

.meter-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: #2563eb;
  transition: width 280ms ease;
}

.meter-fill.risk-high {
  background: #ef4444;
}

.meter-fill.risk-medium {
  background: #f97316;
}

.meter-fill.risk-low {
  background: #eab308;
}

.ranking-value {
  color: #0b0f19;
  font-weight: 950;
  text-align: right;
}

.donut-wrap {
  display: grid;
  grid-template-columns: 180px minmax(0, 1fr);
  gap: 26px;
  align-items: center;
}

.donut {
  width: 100%;
  max-width: 180px;
  height: auto;
}

.donut .donut-track {
  fill: transparent;
  stroke: #f1f5f9;
  stroke-width: 5;
}

.donut .donut-segment {
  fill: transparent;
  stroke-width: 5;
  transition: stroke-dasharray 280ms ease;
  transform-origin: center;
  transform: rotate(-90deg);
}

.donut .donut-center {
  font-size: 9px;
  font-weight: 950;
  fill: #0b0f19;
}

.legend-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 10px;
}

.legend-list li {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
  color: #0b0f19;
  font-weight: 850;
}

.legend-list li small {
  color: #6f7282;
  font-weight: 750;
}

.legend-swatch {
  width: 14px;
  height: 14px;
  border-radius: 4px;
  display: inline-block;
}

@media (max-width: 1180px) {
  .insights-overview {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .insights-grid {
    grid-template-columns: 1fr;
  }

  .donut-wrap {
    grid-template-columns: 160px minmax(0, 1fr);
  }
}

@media (max-width: 760px) {
  .insights-overview {
    grid-template-columns: 1fr;
  }

  .donut-wrap {
    grid-template-columns: 1fr;
    justify-items: center;
    text-align: center;
  }

  .ranking-row {
    grid-template-columns: 28px minmax(0, 1fr) 48px;
  }
}

/* Result navigation: hidden before Analyze, then switches between DB prediction and hotspot summaries. */
.tab-switch {
  width: min(100%, 860px);
  min-height: 74px;
  margin: 58px auto;
  display: grid;
  grid-template-columns: 1fr 1fr;
  border-radius: 999px;
  background: #e8e8ed;
  padding: 8px;
}

.tab-switch button {
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: #0b0f19;
  font: inherit;
  font-size: clamp(1rem, 1.35vw, 1.4rem);
  font-weight: 950;
  cursor: pointer;
}

.tab-switch button.active {
  background: #ffffff;
  box-shadow: 0 3px 12px rgba(15, 23, 42, 0.08);
}

.content-panel {
  margin-top: 0;
}

.prediction-grid {
  margin-top: 48px;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 46px;
}

/* Prediction cards: species text and numeric fields come from the API; image blocks are visual enhancement only. */
.prediction-card {
  overflow: hidden;
  border: 1px solid #dfe3e8;
  border-radius: 22px;
  background: #ffffff;
  box-shadow: 0 16px 30px rgba(15, 23, 42, 0.08);
}

.species-photo {
  position: relative;
  height: 300px;
  display: flex;
  align-items: flex-start;
  justify-content: flex-start;
  padding: 22px;
  color: rgba(15, 23, 42, 0.82);
  font-size: 1.5rem;
  font-weight: 950;
  background:
    radial-gradient(circle at 26% 30%, rgba(255, 255, 255, 0.85), transparent 18%),
    linear-gradient(135deg, #d7fff0, #d9ecff);
}

.species-image {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  object-position: center;
  background: linear-gradient(135deg, #dff3ea, #dbeafe);
}

.species-photo span {
  position: relative;
  z-index: 1;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.78);
}

.image-bird {
  background:
    radial-gradient(circle at 72% 26%, rgba(255, 214, 88, 0.75), transparent 16%),
    linear-gradient(135deg, #dffbe7 0%, #167346 100%);
}

.image-mammal {
  background:
    radial-gradient(circle at 22% 70%, rgba(255, 255, 255, 0.7), transparent 20%),
    linear-gradient(135deg, #d9fff0 0%, #dbeafe 100%);
}

.image-reptile {
  background:
    radial-gradient(circle at 28% 40%, rgba(22, 163, 74, 0.58), transparent 20%),
    linear-gradient(135deg, #f2ffe8 0%, #c8eadb 55%, #9ed1ff 100%);
}

.image-amphibian,
.image-insect,
.image-native-species {
  background:
    radial-gradient(circle at 70% 24%, rgba(255, 255, 255, 0.75), transparent 18%),
    linear-gradient(135deg, #f0fff7, #e0f2fe);
}

.prediction-body {
  padding: 40px 48px 54px;
}

.prediction-title {
  min-height: 82px;
  display: flex;
  justify-content: space-between;
  gap: 18px;
  align-items: start;
}

.prediction-title > div {
  display: flex;
  align-items: center;
}

.prediction-title h3 {
  margin: 0;
  color: #0b0f19;
  font-size: clamp(1.25rem, 1.6vw, 1.75rem);
  line-height: 1.05;
  font-weight: 950;
}

.prediction-body p {
  margin: 24px 0 0;
  color: #0b0f19;
  font-size: clamp(1rem, 1.25vw, 1.3rem);
}

.prediction-body small {
  display: block;
  margin-top: 8px;
  color: #6f7282;
  font-weight: 750;
}

.risk-badge {
  flex: 0 0 auto;
  border-radius: 12px;
  padding: 10px 18px;
  color: #ffffff;
  font-size: 1rem;
  font-weight: 950;
}

.risk-high {
  background: #ff3045;
}

.risk-medium {
  background: #ff6b00;
}

.risk-low {
  background: #efb400;
}

.hotspot-map {
  position: relative;
  min-height: 690px;
  margin-top: 48px;
  overflow: hidden;
  border: 2px solid #d8e3e6;
  border-radius: 18px;
  background:
    linear-gradient(90deg, rgba(148, 163, 184, 0.22) 1px, transparent 1px),
    linear-gradient(0deg, rgba(148, 163, 184, 0.22) 1px, transparent 1px),
    linear-gradient(135deg, #f1fff6, #ecf7ff);
  background-size: 25% 33.33%, 25% 33.33%, auto;
}

.home-dot,
.activity-dot {
  position: absolute;
  transform: translate(-50%, -50%);
  border-radius: 999px;
}

.home-dot {
  left: 50%;
  top: 50%;
  width: 58px;
  height: 58px;
  display: grid;
  place-items: center;
  color: transparent;
  background: #2f7df6;
  border: 8px solid #ffffff;
  box-shadow: 0 6px 16px rgba(47, 125, 246, 0.28);
}

.activity-dot {
  width: 34px;
  height: 34px;
}

.activity-dot::before {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  width: var(--bubble-size);
  height: var(--bubble-size);
  transform: translate(-50%, -50%);
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.12);
  filter: blur(1px);
}

.activity-dot::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: inherit;
}

.map-legend {
  margin-top: 32px;
  display: flex;
  justify-content: center;
  gap: 36px;
  flex-wrap: wrap;
  color: #0b0f19;
  font-size: 1.25rem;
  font-weight: 850;
}

.map-legend span {
  display: inline-flex;
  align-items: center;
  gap: 12px;
}

.map-legend i {
  width: 30px;
  height: 30px;
  border-radius: 999px;
  display: inline-block;
}

.home-key {
  background: #2f7df6;
}

.hotspot-list {
  margin-top: 48px;
}

.hotspot-list h3 {
  margin: 0 0 24px;
  color: #0b0f19;
  font-size: 1.5rem;
  font-weight: 950;
}

.hotspot-row {
  min-height: 110px;
  border: 1px solid #dfe3e8;
  border-radius: 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 20px 24px;
}

.hotspot-row + .hotspot-row {
  margin-top: 22px;
}

.hotspot-row > div {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
}

.hotspot-row strong {
  font-size: 1.45rem;
  font-weight: 950;
}

.hotspot-row p {
  flex-basis: 100%;
  margin: 0;
  color: #6f7282;
  font-size: 1.15rem;
  font-weight: 750;
}

.hotspot-row > span {
  display: grid;
  justify-items: end;
  color: #0b0f19;
  font-size: 1.3rem;
  font-weight: 950;
}

.hotspot-row small {
  color: #6f7282;
  font-size: 0.95rem;
  font-weight: 750;
}

.formula-card {
  margin-top: 58px;
  border: 1px solid #d7d9f0;
  border-radius: 22px;
  background: linear-gradient(90deg, #fff7ff 0%, #f1f8ff 100%);
  padding: 46px;
}

.formula-title {
  display: flex;
  align-items: center;
  gap: 18px;
}

.formula-title span {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  color: #a012f1;
  border: 3px solid currentColor;
  border-radius: 999px;
  font-weight: 950;
}

.formula-grid {
  margin-top: 52px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 70px;
}

.formula-grid h3 {
  margin: 0 0 20px;
  font-size: 1.45rem;
  font-weight: 950;
}

.formula-grid ul {
  margin: 0;
  padding-left: 22px;
  color: #6f7282;
  font-size: clamp(1rem, 1.25vw, 1.25rem);
  line-height: 1.65;
  font-weight: 750;
}

.empty-feed {
  margin-top: 34px;
  border: 1px dashed #cbd5e1;
  border-radius: 14px;
  background: #f8fafc;
  padding: 28px;
  text-align: center;
}

.empty-feed h3 {
  margin: 0;
  font-size: 1.3rem;
}

.empty-feed p {
  margin: 12px auto 0;
  max-width: 720px;
  color: #6f7282;
}

.page-kicker {
  margin: 0 0 8px;
  font-size: 0.8rem;
  font-weight: 950;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

@media (max-width: 1180px) {
  .intelligence-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .search-row,
  .prediction-grid,
  .formula-grid {
    grid-template-columns: 1fr;
  }

  .prediction-card {
    max-width: 760px;
  }
}

@media (max-width: 760px) {
  .wildlife-wrap {
    padding-inline: 12px;
  }

  .search-card,
  .content-panel,
  .formula-card {
    padding: 24px;
  }

  .header-title,
  .search-copy,
  .data-note {
    grid-template-columns: 1fr;
  }

  .tab-switch {
    grid-template-columns: 1fr;
    border-radius: 18px;
  }

  .hotspot-map {
    min-height: 440px;
  }
}
</style>
