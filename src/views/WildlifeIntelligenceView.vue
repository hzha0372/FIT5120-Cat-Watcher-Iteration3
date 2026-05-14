<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { getCurrentUser } from '../utils/auth'

/*
  Wildlife Intelligence View Responsibilities
  - Resolves postcode/suburb input through the same Victorian suburb lookup pattern as the other search pages.
  - Loads nearby verified and self-reported threatened species data from /api/wildlife-intelligence.
  - Presents database-backed prediction cards, activity hotspots, alert feed cards, and no-photo report submission.
  - Keeps formula notes visible so users can see how species_cache, species_sightings, and reserves data drive the page.
*/

const user = ref(getCurrentUser())
const activeTab = ref('predictions')
const loading = ref(false)
const feedError = ref('')
const reportError = ref('')
const reportSuccess = ref('')
const payload = ref(null)

const postcodeInput = ref('')
const activePostcode = ref(String(user.value?.postcode || '').trim())
const selectedLocation = ref(null)
const suburbSuggestions = ref([])
const suburbLoading = ref(false)

const reportOpen = ref(false)
const speciesOptions = ref([])
const speciesLoading = ref(false)
const speciesSearch = ref('')
const selectedSpeciesKey = ref('')
const sightingDate = ref(new Date().toISOString().slice(0, 10))
const reportLocationInput = ref('')
const selectedReportLocation = ref(null)
const reportSuggestions = ref([])
const reportLocationLoading = ref(false)

let suburbTimer = null
let speciesTimer = null
let reportLocationTimer = null

const sightings = computed(() => payload.value?.sightings || [])
const feedUser = computed(() => payload.value?.user || user.value || {})
const hasAnalyzed = computed(() => Boolean(payload.value?.user?.postcode))
const selectedSpecies = computed(
  () => speciesOptions.value.find((item) => item.id === selectedSpeciesKey.value) || null,
)

const todayIso = () => new Date().toISOString().slice(0, 10)

const shouldDisplayPostcode = (value) => /^\s*\d/.test(String(value || ''))

const suburbLabel = (item, includePostcode = shouldDisplayPostcode(postcodeInput.value)) => {
  const postcode = String(item?.postcode || '').trim()
  const name = String(item?.name || '').trim()
  if (!postcode) return name
  if (!name || name.toLowerCase() === postcode.toLowerCase()) return postcode
  if (includePostcode) return item?.label || `${postcode} ${name}`
  return name
}

const suggestionLabel = (item) => item?.label || suburbLabel(item, true)

const displayLocation = computed(() => {
  const postcode = String(feedUser.value?.postcode || activePostcode.value || '').trim()
  const suburb = String(feedUser.value?.suburbName || '').trim()
  if (!postcode) return 'your area'
  return suburb ? `${suburb} ${postcode}` : `postcode ${postcode}`
})

const weekRange = computed(() => {
  const start = new Date()
  const end = new Date()
  end.setDate(start.getDate() + 6)
  const formatter = new Intl.DateTimeFormat('en-AU', { month: 'short', day: 'numeric', year: 'numeric' })
  return `${formatter.format(start)} - ${formatter.format(end)}`
})

const normalizeCategory = (preyType) => {
  const text = String(preyType || '').toLowerCase()
  if (text.includes('bird')) return 'Bird'
  if (text.includes('reptile')) return 'Reptile'
  if (text.includes('mammal')) return 'Mammal'
  if (text.includes('amphibian')) return 'Amphibian'
  if (text.includes('insect')) return 'Insect'
  return 'Native Species'
}

const riskMeta = (status, index = 0) => {
  const text = String(status || '').toLowerCase()
  if (text.includes('critical') || text.includes('endangered')) return { label: 'High', className: 'risk-high' }
  if (text.includes('vulnerable') && index < 3) return { label: 'Medium', className: 'risk-medium' }
  if (text.includes('vulnerable')) return { label: 'Low', className: 'risk-low' }
  return { label: 'Low', className: 'risk-low' }
}

const sourceClass = (source) => {
  const text = String(source || '').toLowerCase()
  if (text.includes('self')) return 'source-self'
  if (text.includes('database') || text.includes('verified')) return 'source-verified'
  return 'source-ai'
}

const preyClass = (preyType) => {
  const category = normalizeCategory(preyType).toLowerCase().replace(/\s+/g, '-')
  return `prey-${category}`
}

const daysAgo = (createdAt) => {
  const created = new Date(createdAt)
  if (Number.isNaN(created.getTime())) return 'Recently'
  const diffMs = Date.now() - created.getTime()
  if (diffMs < 60_000) return 'Less than a minute ago'
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

const distancePhrase = (metres) => {
  const value = Number(metres)
  if (!Number.isFinite(value)) return 'Spotted nearby'
  return `Spotted approximately ${Math.round(value).toLocaleString()} metres from your home`
}

const formatKm = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? `${n.toFixed(1)} km` : 'Database pending'
}

const predictionCards = computed(() => {
  const seen = new Set()
  const cards = []
  for (const sighting of sightings.value) {
    const key = String(sighting.scientificName || sighting.commonName || '').toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    const index = cards.length
    const category = normalizeCategory(sighting.preyType)
    cards.push({
      ...sighting,
      category,
      risk: riskMeta(sighting.conservationStatus, index),
      imageClass: `image-${category.toLowerCase().replace(/\s+/g, '-')}`,
    })
    if (cards.length >= 6) break
  }
  return cards
})

const hotspotRows = computed(() => {
  const groups = new Map()
  for (const sighting of sightings.value) {
    const category = normalizeCategory(sighting.preyType)
    const current = groups.get(category) || {
      category,
      count: 0,
      distanceTotal: 0,
      distanceCount: 0,
      highCount: 0,
    }
    current.count += 1
    const distanceKm = Number(sighting.distanceMetres) / 1000
    if (Number.isFinite(distanceKm)) {
      current.distanceTotal += distanceKm
      current.distanceCount += 1
    }
    if (riskMeta(sighting.conservationStatus).label === 'High') current.highCount += 1
    groups.set(category, current)
  }

  return Array.from(groups.values())
    .map((row) => {
      const averageDistance = row.distanceCount ? row.distanceTotal / row.distanceCount : null
      const level = row.highCount >= 2 || row.count >= 8 ? 'High' : row.count >= 3 ? 'Medium' : 'Low'
      return {
        ...row,
        averageDistance,
        level,
        risk: level === 'High' ? 'risk-high' : level === 'Medium' ? 'risk-medium' : 'risk-low',
      }
    })
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category))
    .slice(0, 4)
})

const hotspotDots = computed(() => {
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

const submitLocation = async () => {
  feedError.value = ''
  reportSuccess.value = ''
  try {
    const postcode = await resolvePostcode()
    await loadFeed(postcode)
    activeTab.value = 'predictions'
  } catch (err) {
    feedError.value = err?.message || 'Please enter a valid Victorian postcode or suburb.'
  }
}

const loadSpeciesOptions = async () => {
  speciesLoading.value = true
  try {
    const q = speciesSearch.value.trim()
    const response = await fetch(`/api/wildlife-intelligence?action=species-options&q=${encodeURIComponent(q)}&limit=120`)
    const data = await response.json()
    speciesOptions.value = data?.results || []
  } catch {
    speciesOptions.value = []
  } finally {
    speciesLoading.value = false
  }
}

const loadReportSuggestions = async () => {
  const q = reportLocationInput.value.trim()
  if (q.length < 2) {
    reportSuggestions.value = []
    return
  }
  reportLocationLoading.value = true
  try {
    reportSuggestions.value = await fetchSuburbs(q, 12)
  } catch {
    reportSuggestions.value = []
  } finally {
    reportLocationLoading.value = false
  }
}

const chooseReportLocation = (item) => {
  selectedReportLocation.value = item
  reportLocationInput.value = suburbLabel(item, true)
  reportSuggestions.value = []
}

const openReport = () => {
  reportOpen.value = true
  reportError.value = ''
  reportSuccess.value = ''
  sightingDate.value = todayIso()
  if (!reportLocationInput.value && feedUser.value?.postcode) {
    selectedReportLocation.value = {
      postcode: feedUser.value.postcode,
      name: feedUser.value.suburbName,
    }
    reportLocationInput.value = suburbLabel(selectedReportLocation.value, true)
  }
  requestAnimationFrame(() => document.querySelector('.report-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
}

const resolveReportLocation = async () => {
  const q = reportLocationInput.value.trim()
  if (selectedReportLocation.value?.postcode && q === suburbLabel(selectedReportLocation.value, true)) {
    return selectedReportLocation.value
  }
  const direct = q.match(/\b(\d{4})\b/)?.[1] || ''
  if (direct) return { postcode: direct, name: q }
  if (!q) throw new Error('Please enter the suburb where you spotted it.')
  const [match] = await fetchSuburbs(q, 1)
  if (!match?.postcode) throw new Error('Please select a Victorian suburb or enter a valid postcode.')
  selectedReportLocation.value = match
  reportLocationInput.value = suburbLabel(match, true)
  return match
}

const submitReport = async () => {
  reportError.value = ''
  reportSuccess.value = ''

  if (!selectedSpecies.value) {
    reportError.value = 'Please select a threatened species.'
    return
  }

  if (!sightingDate.value) {
    reportError.value = 'Please enter the sighting date.'
    return
  }

  if (new Date(`${sightingDate.value}T00:00:00`).getTime() > new Date(`${todayIso()}T00:00:00`).getTime()) {
    reportError.value = 'Future dates cannot be reported.'
    return
  }

  loading.value = true
  try {
    const reportLocation = await resolveReportLocation()
    const response = await fetch('/api/wildlife-intelligence?action=report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scientificName: selectedSpecies.value.scientificName,
        commonName: selectedSpecies.value.commonName,
        sightingDate: sightingDate.value,
        postcode: reportLocation.postcode,
        suburbName: reportLocation.name,
      }),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || 'Unable to save sighting.')
    reportSuccess.value = 'Self-reported sighting saved.'
    selectedSpeciesKey.value = ''
    sightingDate.value = todayIso()
    reportOpen.value = false
    await loadFeed(activePostcode.value || reportLocation.postcode)
  } catch (err) {
    reportError.value = err?.message || 'Unable to save sighting.'
  } finally {
    loading.value = false
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

watch(speciesSearch, () => {
  if (speciesTimer) clearTimeout(speciesTimer)
  speciesTimer = setTimeout(loadSpeciesOptions, 180)
})

watch(reportLocationInput, () => {
  if (
    selectedReportLocation.value?.postcode &&
    reportLocationInput.value.trim() === suburbLabel(selectedReportLocation.value, true)
  ) {
    reportSuggestions.value = []
    return
  }
  selectedReportLocation.value = null
  if (reportLocationTimer) clearTimeout(reportLocationTimer)
  reportLocationTimer = setTimeout(loadReportSuggestions, 180)
})

onMounted(async () => {
  user.value = getCurrentUser()
  activePostcode.value = String(user.value?.postcode || '').trim()
  await loadSpeciesOptions()
})
</script>

<template>
  <main class="wildlife-page">
    <section class="intelligence-header">
      <div class="header-title">
        <span class="header-icon">B</span>
        <div>
          <h1>Community Wildlife Intelligence</h1>
          <p>Data-driven wildlife awareness powered by biodiversity insights</p>
        </div>
      </div>
    </section>

    <div class="wildlife-wrap">
      <section class="search-card">
        <div class="search-copy">
          <span class="pin-icon">O</span>
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
        <p v-if="reportSuccess" class="success-line">{{ reportSuccess }}</p>
      </section>

      <template v-if="hasAnalyzed">
        <section class="data-note">
          <span>&#8599;</span>
          <div>
            <h3>Analysis Based On Historical Data</h3>
            <p>
              Predictions use species_cache biodiversity records, species_sightings community reports,
              seasonal observation patterns, and reserve proximity within the searched 5km area.
              Updated from the live database.
            </p>
          </div>
        </section>

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

        <section v-if="activeTab === 'predictions'" class="content-panel prediction-panel">
          <div class="panel-head">
            <h2>Predicted Threatened Species Activity</h2>
            <p>
              Species most likely to be active near {{ displayLocation }} this week
              ({{ weekRange }})
            </p>
          </div>

          <p v-if="loading && !predictionCards.length" class="status-line">Loading wildlife intelligence...</p>

          <div v-if="predictionCards.length" class="prediction-grid">
            <article v-for="(card, index) in predictionCards" :key="card.id" class="prediction-card">
              <div class="species-photo" :class="card.imageClass">
                <span>{{ card.category }}</span>
              </div>
              <div class="prediction-body">
                <div class="prediction-title">
                  <div>
                    <span class="category-mark">{{ card.category.slice(0, 1) }}</span>
                    <h3>{{ card.commonName }}</h3>
                  </div>
                  <span class="risk-badge" :class="riskMeta(card.conservationStatus, index).className">
                    {{ riskMeta(card.conservationStatus, index).label }}
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
              current 30-day window.
            </p>
          </article>
        </section>

        <section v-else class="content-panel hotspot-panel">
          <div class="panel-head">
            <h2>Wildlife Activity Hotspots</h2>
            <p>Spatial clusters based on historical threatened species records</p>
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

        <section class="alert-feed">
          <div class="panel-head">
            <h2>Neighbour Wildlife Alert Feed</h2>
            <p>Verified and self-reported sightings within 5km of {{ displayLocation }} from the past 30 days</p>
          </div>

          <div v-if="sightings.length" class="feed-list">
            <article
              v-for="sighting in sightings.slice(0, 8)"
              :key="sighting.id"
              class="feed-card"
              :class="{ self: sighting.selfReported }"
            >
              <div>
                <div class="feed-card-head">
                  <h3>{{ sighting.commonName }}</h3>
                  <span class="status-badge">{{ sighting.conservationStatus }}</span>
                </div>
                <p>{{ distancePhrase(sighting.distanceMetres) }}</p>
                <div class="badge-row">
                  <span class="source-badge" :class="sourceClass(sighting.source)">
                    {{ sighting.source }}
                  </span>
                  <span v-if="sighting.selfReported" class="source-badge source-self">Self-reported</span>
                  <span class="prey-badge" :class="preyClass(sighting.preyType)">
                    {{ sighting.preyType }}
                  </span>
                  <span class="predation-badge">{{ Number(sighting.predationPct || 0).toFixed(1) }}% predation share</span>
                </div>
              </div>
              <time>{{ daysAgo(sighting.createdAt) }}</time>
            </article>
          </div>
        </section>
      </template>
    </div>
  </main>
</template>

<style scoped>
.wildlife-page {
  min-height: calc(100dvh - 101px);
  background:
    radial-gradient(circle at 10% 10%, rgba(187, 247, 208, 0.48), transparent 28%),
    radial-gradient(circle at 90% 20%, rgba(219, 234, 254, 0.7), transparent 34%),
    linear-gradient(135deg, #f1fff7 0%, #edfff8 42%, #edf7ff 100%);
  color: #0b0f19;
}

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
  grid-template-columns: 64px 1fr;
  gap: 22px;
  align-items: center;
}

.header-icon {
  width: 56px;
  height: 56px;
  display: grid;
  place-items: center;
  border: 5px solid #08a84e;
  border-radius: 18px;
  color: #08a84e;
  font-size: 1.8rem;
  font-weight: 950;
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

.search-card,
.content-panel,
.alert-feed,
.report-panel {
  border: 1px solid #dfe3e8;
  border-radius: 22px;
  background: #ffffff;
  box-shadow: 0 18px 40px rgba(51, 65, 85, 0.08);
  padding: 46px;
}

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
  border: 4px solid #0b0f19;
  border-radius: 999px;
  font-size: 1rem;
  font-weight: 950;
}

.search-copy h2,
.panel-head h2,
.formula-title h2,
.report-head h2 {
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

.postcode-field,
.report-form label {
  position: relative;
  display: grid;
  gap: 10px;
}

.postcode-field span,
.report-form label span {
  color: #374151;
  font-weight: 950;
}

.postcode-field input,
.report-form input,
.report-form select {
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

.postcode-field input::placeholder,
.report-form input::placeholder {
  color: #8b90a0;
}

.analyze-button,
.report-button,
.report-form button,
.report-head button {
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

.report-button {
  color: #111827;
  background: #ffffff;
  border-color: #dfe3e8;
}

.analyze-button:disabled,
.report-form button:disabled {
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

.postcode-field small,
.report-form small {
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

.content-panel,
.alert-feed,
.report-panel {
  margin-top: 0;
}

.prediction-grid {
  margin-top: 48px;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 46px;
}

.prediction-card {
  overflow: hidden;
  border: 1px solid #dfe3e8;
  border-radius: 22px;
  background: #ffffff;
  box-shadow: 0 16px 30px rgba(15, 23, 42, 0.08);
}

.species-photo {
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
  display: grid;
  grid-template-columns: 34px 1fr;
  gap: 18px;
  align-items: center;
}

.category-mark {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  color: #047857;
  border: 3px solid currentColor;
  border-radius: 999px;
  font-size: 0.95rem;
  font-weight: 950;
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

.alert-feed {
  margin-top: 58px;
}

.feed-list {
  margin-top: 34px;
  display: grid;
  gap: 18px;
}

.feed-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 150px;
  gap: 24px;
  align-items: start;
  border: 1px solid #dfe3e8;
  border-radius: 14px;
  background: #ffffff;
  padding: 24px;
}

.feed-card.self {
  border-color: #a7f3d0;
  background: #f0fdf4;
}

.feed-card-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}

.feed-card h3 {
  margin: 0;
  color: #0b0f19;
  font-size: 1.25rem;
  font-weight: 950;
}

.feed-card p {
  margin: 10px 0 0;
  color: #334155;
  font-weight: 850;
}

.feed-card time {
  color: #6f7282;
  font-weight: 850;
  text-align: right;
}

.status-badge,
.source-badge,
.prey-badge,
.predation-badge {
  display: inline-flex;
  align-items: center;
  min-height: 30px;
  border-radius: 999px;
  padding: 0 12px;
  font-size: 0.82rem;
  font-weight: 950;
}

.status-badge {
  color: #991b1b;
  background: #fee2e2;
}

.source-self {
  color: #047857;
  background: #d1fae5;
}

.source-verified {
  color: #5b21b6;
  background: #ede9fe;
}

.source-ai {
  color: #1d4ed8;
  background: #dbeafe;
}

.prey-bird {
  color: #1d4ed8;
  background: #dbeafe;
}

.prey-reptile,
.prey-amphibian {
  color: #047857;
  background: #d1fae5;
}

.prey-mammal {
  color: #92400e;
  background: #fef3c7;
}

.prey-insect,
.prey-native-species,
.predation-badge {
  color: #374151;
  background: #f3f4f6;
}

.badge-row {
  margin-top: 16px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
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

.report-panel {
  margin-top: 58px;
}

.page-kicker {
  margin: 0 0 8px;
  font-size: 0.8rem;
  font-weight: 950;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.report-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  border-radius: 14px;
  background: linear-gradient(135deg, #030414, #065f46);
  color: #ffffff;
  padding: 26px;
}

.report-head h2 {
  color: #ffffff;
}

.report-head button {
  color: #111827;
  background: #ffffff;
}

.report-form {
  margin-top: 28px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
}

.report-location-field,
.report-form button,
.report-form .error-line {
  grid-column: span 2;
}

.report-form button {
  color: #ffffff;
  background: #08a84e;
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
  .alert-feed,
  .report-panel,
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

  .feed-card,
  .report-form {
    grid-template-columns: 1fr;
  }

  .feed-card time {
    text-align: left;
  }

  .report-location-field,
  .report-form button,
  .report-form .error-line {
    grid-column: auto;
  }

  .hotspot-map {
    min-height: 440px;
  }
}
</style>
