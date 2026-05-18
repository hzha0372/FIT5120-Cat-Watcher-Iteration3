<script setup>
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import LineIcon from '../components/LineIcon.vue'
import { getCurrentUser } from '../utils/auth'

/*
  Hunter Profile View Responsibilities
  - Renders the Figma-designed Hunter Profile landing, five-question quiz, and result states.
  - Keeps the quiz wording and intro cards in the frontend because they are product copy, not measured data.
  - Sends the five behaviour answers to /api/hunter-profile; the server recalculates score/profile type instead of trusting a frontend result.
  - Displays numeric result data only from the API payload: profile score, roaming hours, prey rate, adjusted encounter estimate, and local species record rows.
  - Shows species names/statuses returned from species_cache for the logged-in user's postcode, with localStorage used only as a "latest result" cache.
  - Explains the Cat Tracker SA formula beside the database-backed threatened species result so the displayed number can be traced.
  - Epic 9 UI contract:
    1) Frontend collects answers and renders copy, but backend owns all final numbers.
    2) Result cards must remain explainable (formula text + source labels + API evidence).
    3) Local cache improves continuity after refresh, but never replaces server truth when new responses arrive.
*/

const user = ref(getCurrentUser())

// Page state: intro is the landing view, quiz collects the five answers, result renders the latest API-backed profile.
const viewMode = ref('intro')
const loading = ref(false)
const error = ref('')
const result = ref(null)

// These five answer keys match the accepted API contract in api/hunter-profile.js.
const answers = ref({
  timing: '',
  stalking: '',
  preyHistory: '',
  roamingHours: '',
  habitat: '',
})

// Static quiz copy. Scoring is intentionally duplicated on the server, so these labels only drive the UI.
const questions = [
  {
    key: 'timing',
    number: '01',
    title: 'When does your cat prefer to roam?',
    options: [
      { value: 'duskDawn', label: 'Dusk and dawn' },
      { value: 'daytime', label: 'Daytime' },
      { value: 'lateNight', label: 'Late night' },
      { value: 'allTimes', label: 'All times equally' },
    ],
  },
  {
    key: 'stalking',
    number: '02',
    title: 'Does your cat stalk and chase moving objects outside?',
    options: [
      { value: 'often', label: 'Often' },
      { value: 'sometimes', label: 'Sometimes' },
      { value: 'rarely', label: 'Rarely' },
      { value: 'never', label: 'Never' },
    ],
  },
  {
    key: 'preyHistory',
    number: '03',
    title: 'Has your cat ever brought prey home, even once?',
    options: [
      { value: 'regularly', label: 'Yes, regularly' },
      { value: 'occasionally', label: 'Yes, occasionally' },
      { value: 'once', label: 'Only once' },
      { value: 'never', label: 'Never' },
    ],
  },
  {
    key: 'roamingHours',
    number: '04',
    title: 'How many hours per day does your cat typically roam outside?',
    options: [
      { value: 'less2', label: 'Less than 2 hours' },
      { value: 'twoToFour', label: '2-4 hours' },
      { value: 'fourToSix', label: '4-6 hours' },
      { value: 'moreThanSix', label: 'More than 6 hours' },
    ],
  },
  {
    key: 'habitat',
    number: '05',
    title: 'Where does your cat spend most outdoor time?',
    options: [
      { value: 'dense', label: 'Near dense gardens or bushland' },
      { value: 'open', label: 'On open grass or footpaths' },
      { value: 'sheltered', label: 'Under the house or in sheltered spots' },
      { value: 'varies', label: 'Varies widely' },
    ],
  },
]

// Intro cards explain the four possible server profile types before the user starts the assessment.
const profileTypes = [
  {
    label: 'Low-Risk Homebody',
    text: 'Minimal hunting behaviour, prefers supervised outdoor time, lowest wildlife risk',
    tone: 'profile-low',
    icon: 'shield',
  },
  {
    label: 'Opportunistic Hunter',
    text: 'Occasional hunting when prey is readily available, sporadic rather than systematic',
    tone: 'profile-opportunistic',
    icon: 'paw',
  },
  {
    label: 'Active Stalker',
    text: 'Deliberate stalking and pursuit, active seeking behavior, systematic territory patrol',
    tone: 'profile-stalker',
    icon: 'target',
  },
  {
    label: 'Ambush Predator',
    text: 'Sophisticated ambush tactics, strategic positioning, highest hunting success rate',
    tone: 'profile-ambush',
    icon: 'alert',
  },
]

// Landing-page discovery items are explanatory copy; the actual numeric values appear only after /api/hunter-profile returns.
const discoverItems = [
  {
    label: 'Hunter Profile Type',
    text: "One of four scientifically classified hunting behavior patterns based on your cat's specific habits",
    tone: 'discover-violet',
    icon: 'target',
  },
  {
    label: 'Local Threatened Species at Risk',
    text: "FFG Act species in your postcode most vulnerable to your cat's hunting style",
    tone: 'discover-amber',
    icon: 'alert',
  },
  {
    label: 'Estimated Monthly Encounters',
    text: "Calculated using Cat Tracker SA's 0.0667 prey/day baseline scaled to your cat's roaming hours",
    tone: 'discover-blue',
    icon: 'brain',
  },
  {
    label: 'Tailored Recommended Action',
    text: 'One specific, evidence-based first step with research citation and effectiveness data',
    tone: 'discover-green',
    icon: 'shield',
  },
]

// The API returns the recommended action title/citation; these fallback details fill out the visual card if older cached payloads omit optional text.
const actionFallbacks = {
  activeStalker: {
    title: 'Use a Brightly Colored Collar with Bell',
    detail:
      'Fit your cat with a reflective, brightly colored collar and bell to alert wildlife before a chase begins.',
    effectiveness: 41,
  },
  ambushPredator: {
    title: 'Use a Bell Collar as the First Step',
    detail:
      'A bell collar gives nearby wildlife an audible warning before hidden ambush strikes can succeed.',
    effectiveness: 41,
  },
  opportunistic: {
    title: 'Shift Roaming Away from Dusk and Dawn',
    detail:
      'Keep outdoor time away from peak wildlife movement windows so chance encounters become less likely.',
    effectiveness: 34,
  },
  lowRisk: {
    title: 'Keep Supervised Outdoor Time Consistent',
    detail:
      'Maintain the low-risk pattern with short, supervised outdoor sessions and avoid unsupervised roaming spikes.',
    effectiveness: 30,
  },
}

const storageKey = computed(() => `catwatch_hunter_profile_result_v1_${user.value?.id || 'guest'}`)

// Quiz completeness drives button validation before a POST request is sent.
const answeredCount = computed(() => Object.values(answers.value).filter(Boolean).length)
const allAnswered = computed(() => answeredCount.value === questions.length)

// User/cat display names come from the auth cache or the API response loaded from the users table.
const catName = computed(() => result.value?.user?.catName || user.value?.catName || 'Your cat')
const currentProfile = computed(() => result.value?.profile || {})
const currentEstimate = computed(() => result.value?.estimate || {})

// Profile descriptions are returned as an array by the API so each sentence can keep the Figma result spacing.
const profileDescriptions = computed(() => {
  const lines = currentProfile.value.description
  return Array.isArray(lines) ? lines : [lines].filter(Boolean)
})

// Numeric encounter fields are rendered from the API payload. The server reads prey_per_day from cats_behaviour_stats.
const preyRate = computed(() => Number(currentEstimate.value.preyRatePerDay || 0.0667))
const roamingHours = computed(() => Number(currentProfile.value.roamingHours || 0))
const adjustedRate = computed(() => preyRate.value * (roamingHours.value / 24))
const monthlyEncounters = computed(() => {
  const value = Number(currentEstimate.value.monthlyEncounters)
  if (Number.isFinite(value)) return value.toFixed(1)
  return (adjustedRate.value * 30).toFixed(1)
})

// The methodology box mirrors the acceptance-criteria formula using the same API-backed values shown in the headline number.
const methodologyLines = computed(() => [
  `Base prey rate: ${preyRate.value.toFixed(4)} encounters/day`,
  `Your cat's roaming time: ${roamingHours.value} hours/day`,
  `Adjusted rate: ${adjustedRate.value.toFixed(4)} encounters/day`,
  'Monthly projection: adjusted rate x 30 days',
])

// Action evidence comes from the API citation; the percent is parsed only for the progress meter visual.
const actionDetails = computed(() => {
  const key = currentProfile.value.key || 'opportunistic'
  const fallback = actionFallbacks[key] || actionFallbacks.opportunistic
  const citation = currentProfile.value.citation || ''
  const citedPercent = Number(String(citation).match(/(\d+)%/)?.[1])

  return {
    title: currentProfile.value.recommendedAction || fallback.title,
    detail: fallback.detail,
    evidence: citation || 'Cat Tracker SA behaviour research supports matching the intervention to the cat profile.',
    effectiveness: Number.isFinite(citedPercent) ? citedPercent : fallback.effectiveness,
  }
})

// Result tone and icon are derived from the server profile key so visual styling stays coupled to the calculated type.
const profileClass = computed(() => {
  const key = currentProfile.value.key || ''
  if (key === 'ambushPredator') return 'result-ambush'
  if (key === 'activeStalker') return 'result-stalker'
  if (key === 'lowRisk') return 'result-low'
  return 'result-opportunistic'
})

const profileMark = computed(() => {
  const key = currentProfile.value.key || ''
  if (key === 'ambushPredator') return 'alert'
  if (key === 'activeStalker') return 'target'
  if (key === 'lowRisk') return 'shield'
  return 'paw'
})

// Location is read from the API's users/suburb_demographics lookup and is shown only after a result exists.
const locationLine = computed(() => {
  if (!result.value?.user) return ''
  const postcode = result.value.user.postcode || ''
  const suburb = result.value.user.suburbName || ''
  return suburb ? `${postcode} ${suburb}` : postcode
})

// Risk chips are visual labels layered on top of the database conservation status; they do not replace the source status text.
const riskMeta = (species, index = 0) => {
  const text = String(species?.conservationStatus || '').toLowerCase()
  const highProfile = ['activeStalker', 'ambushPredator'].includes(currentProfile.value.key)
  if (text.includes('critical') || text.includes('endangered') || (text.includes('vulnerable') && highProfile && index < 2)) {
    return { label: 'High Risk', className: 'risk-high' }
  }
  if (text.includes('vulnerable')) return { label: 'Medium Risk', className: 'risk-medium' }
  return { label: 'Low Risk', className: 'risk-low' }
}

// Start the quiz from either landing CTA without mutating any saved profile.
const startQuiz = () => {
  error.value = ''
  viewMode.value = 'quiz'
  requestAnimationFrame(() => document.querySelector('.quiz-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
}

// Reopen the cached/latest profile when the user navigates back from the quiz.
const showResult = () => {
  if (result.value) {
    viewMode.value = 'result'
    requestAnimationFrame(() => document.querySelector('.result-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }
}

// Retake clears the local cache and answer state; the next result will come from a fresh API request.
const resetQuiz = () => {
  answers.value = {
    timing: '',
    stalking: '',
    preyHistory: '',
    roamingHours: '',
    habitat: '',
  }
  error.value = ''
  result.value = null
  localStorage.removeItem(storageKey.value)
  viewMode.value = 'quiz'
}

// Build Cat's Profile posts only raw answers/user context; all scoring, species lookup, and numeric calculation happen in the API.
const buildProfile = async () => {
  error.value = ''
  if (!allAnswered.value) {
    error.value = 'Please answer all five questions before building the profile.'
    return
  }

  loading.value = true
  try {
    const response = await fetch('/api/hunter-profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: user.value?.id,
        postcode: user.value?.postcode,
        answers: answers.value,
      }),
    })
    const payload = await response.json()
    if (!response.ok) throw new Error(payload?.error || 'Unable to build Hunter Profile.')
    result.value = payload
    localStorage.setItem(storageKey.value, JSON.stringify(payload))
    viewMode.value = 'result'
    requestAnimationFrame(() => document.querySelector('.result-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  } catch (err) {
    error.value = err?.message || 'Unable to build Hunter Profile.'
  } finally {
    loading.value = false
  }
}

// Restore the latest API payload for the current user so returning to /hunter-profile does not require a retake.
onMounted(() => {
  user.value = getCurrentUser()
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey.value) || 'null')
    if (saved?.profile?.type) {
      result.value = saved
      viewMode.value = 'result'
    }
  } catch {
    localStorage.removeItem(storageKey.value)
  }
})
</script>

<template>
  <main class="hunter-page">
    <div class="hunter-wrap">
      <!-- Hero: green Catwatcher entry panel; text is static page copy and the CTA only changes view state. -->
      <section class="hunter-hero">
        <p class="page-kicker">Cat's Hunter Profile</p>
        <h1>Understand Your Cat's Hunting Behavior</h1>
        <p>
          Answer five short behaviour questions to reveal how {{ catName }} roams, which local
          threatened species are most exposed, and the one first action that fits that pattern.
        </p>
        <div class="hero-actions">
          <button type="button" class="hero-primary" @click="startQuiz">
            {{ result ? 'Retake Quiz' : 'Start 5-Question Assessment' }}
            <span aria-hidden="true">&rarr;</span>
          </button>
        </div>
      </section>

      <template v-if="viewMode === 'intro'">
        <!-- Discovery overview: explains which database-backed result sections will appear after a completed quiz. -->
        <section class="info-card discover-card">
          <div class="section-copy">
            <h2>What You'll Discover</h2>
            <p>Your personalized profile includes research-backed insights specific to your cat</p>
          </div>
          <div class="discover-grid">
            <article v-for="item in discoverItems" :key="item.label" class="discover-item">
              <span class="discover-icon" :class="item.tone">
                <LineIcon :name="item.icon" />
              </span>
              <div>
                <h3>{{ item.label }}</h3>
                <p>{{ item.text }}</p>
              </div>
            </article>
          </div>
        </section>

        <!-- Profile type summary: mirrors the four server-side classification buckets from api/hunter-profile.js. -->
        <section class="info-card profile-types-card">
          <div class="section-copy">
            <h2>Four Hunter Profile Types</h2>
            <p>Based on Cat Tracker SA national prey behavior data and weighted behavioral scoring</p>
          </div>
          <div class="profile-type-grid">
            <article v-for="item in profileTypes" :key="item.label" class="profile-type" :class="item.tone">
              <span class="type-icon">
                <LineIcon :name="item.icon" />
              </span>
              <div>
                <h3>{{ item.label }}</h3>
                <p>{{ item.text }}</p>
              </div>
            </article>
          </div>
        </section>

        <div class="begin-row">
          <button type="button" class="begin-assessment" @click="startQuiz">
            Begin Assessment
            <span aria-hidden="true">&rarr;</span>
          </button>
        </div>
      </template>

      <!-- Quiz form: collects the five raw answers but does not calculate the final score in the browser. -->
      <section v-if="viewMode === 'quiz'" class="info-card quiz-panel">
        <div class="quiz-head">
          <div>
            <p class="page-kicker">Five-question quiz</p>
            <h2>Build Cat's Profile</h2>
          </div>
          <span>{{ answeredCount }} / {{ questions.length }} answered</span>
        </div>

        <div class="question-stack">
          <fieldset v-for="question in questions" :key="question.key" class="question-block">
            <legend>
              <span>{{ question.number }}</span>
              {{ question.title }}
            </legend>
            <div class="option-grid">
              <label
                v-for="option in question.options"
                :key="option.value"
                class="option-card"
                :class="{ selected: answers[question.key] === option.value }"
              >
                <input
                  v-model="answers[question.key]"
                  type="radio"
                  :name="question.key"
                  :value="option.value"
                />
                <span>{{ option.label }}</span>
              </label>
            </div>
          </fieldset>
        </div>

        <p v-if="error" class="form-error">{{ error }}</p>
        <div class="quiz-actions">
          <button type="button" class="secondary-action" @click="viewMode = result ? 'result' : 'intro'">
            {{ result ? 'Back to result' : 'Back to overview' }}
          </button>
          <button type="button" class="primary-action" :disabled="loading" @click="buildProfile">
            {{ loading ? 'Building...' : "Build Cat's Profile" }}
            <LineIcon v-if="!loading" name="chevron-right" />
          </button>
        </div>
      </section>

      <!-- Result state: renders the latest /api/hunter-profile payload, either freshly posted or restored from localStorage. -->
      <section v-if="viewMode === 'result' && result" class="result-panel">
        <!-- Profile banner: score, type, and location all come from the API response. -->
        <article class="profile-banner" :class="profileClass">
          <span class="result-icon">
            <LineIcon :name="profileMark" />
          </span>
          <div class="profile-copy">
            <h2>{{ result.profile.type }}</h2>
            <p v-for="line in profileDescriptions" :key="line">{{ line }}</p>
            <small v-if="locationLine">{{ result.user.catName }} &middot; {{ locationLine }}</small>
          </div>
          <strong class="score-pill">Score: {{ result.profile.score }}/20</strong>
        </article>

        <div class="result-grid">
          <!-- Local threatened species: species_cache rows for the user's postcode, filtered/ranked by the API. -->
          <section class="analysis-card species-risk-card">
            <div class="card-title">
              <span class="warning-icon">!</span>
              <div>
                <h3>Local Threatened Species at Risk</h3>
                <p>
                  FFG Act threatened species in postcode {{ result.user.postcode }} most vulnerable
                  to {{ result.profile.type }} hunting behavior
                </p>
              </div>
            </div>

            <div class="species-risk-list">
              <article
                v-for="(species, index) in result.threatenedSpecies"
                :key="species.scientificName || species.commonName"
                class="species-risk-row"
              >
                <div>
                  <h4>{{ species.commonName }}</h4>
                  <p>Conservation: {{ species.conservationStatus }}</p>
                </div>
                <span class="risk-pill" :class="riskMeta(species, index).className">
                  {{ riskMeta(species, index).label }}
                </span>
              </article>
              <p v-if="!result.threatenedSpecies.length" class="empty-copy">
                No FFG-listed species were found in this postcode in species_cache.
              </p>
            </div>
          </section>

          <!-- Encounter estimate: uses the API prey rate and roaming-hours output with the AC9.1 formula. -->
          <section class="analysis-card encounter-card">
            <div class="card-title">
              <span class="trend-icon">&#8599;</span>
              <div>
                <h3>Estimated Monthly Prey Encounters</h3>
                <p>Based on Cat Tracker SA national data ({{ preyRate.toFixed(4) }} prey/day baseline)</p>
              </div>
            </div>
            <div class="encounter-number">
              <strong>{{ monthlyEncounters }}</strong>
              <span>potential wildlife encounters per month</span>
            </div>
            <div class="methodology-box">
              <h4>Calculation Methodology:</h4>
              <ul>
                <li v-for="line in methodologyLines" :key="line">{{ line }}</li>
              </ul>
              <p>
                Formula: {{ preyRate.toFixed(4) }} &times; ({{ roamingHours }} / 24) &times; 30 =
                {{ monthlyEncounters }} encounters/month.
              </p>
            </div>
          </section>
        </div>

        <!-- Recommended first action: API title/citation plus frontend presentation of the evidence meter. -->
        <section class="recommended-card" :style="{ '--effectiveness': `${actionDetails.effectiveness}%` }">
          <div class="recommended-head">
            <span class="light-icon">
              <LineIcon name="lightbulb" />
            </span>
            <div>
              <h2>Recommended First Action</h2>
              <p>Evidence-based intervention tailored to {{ result.profile.type }} behavior pattern</p>
            </div>
          </div>

          <h3>{{ actionDetails.title }}</h3>
          <p class="action-copy">{{ actionDetails.detail }}</p>

          <div class="evidence-box">
            <strong>Research Evidence</strong>
            <p>{{ actionDetails.evidence }}</p>
          </div>

          <div class="effectiveness-row">
            <span>Expected Effectiveness</span>
            <strong>{{ actionDetails.effectiveness }}% reduction</strong>
          </div>
          <div class="effectiveness-track" aria-hidden="true">
            <span></span>
          </div>

        </section>

        <div class="result-actions">
          <button type="button" class="retake-button" @click="resetQuiz">
            Retake Quiz
          </button>
          <RouterLink class="wildlife-button" to="/wildlife-intelligence">
            View Wildlife Intelligence
          </RouterLink>
        </div>
      </section>
    </div>
  </main>
</template>

<style scoped>
/* Page shell: green/teal background shared with the newer Catwatcher feature pages. */
.hunter-page {
  min-height: calc(100dvh - 101px);
  background:
    radial-gradient(circle at 12% 10%, rgba(187, 247, 208, 0.55), transparent 28%),
    radial-gradient(circle at 88% 18%, rgba(219, 234, 254, 0.62), transparent 30%),
    linear-gradient(135deg, #f4fff8 0%, #eefdf5 48%, #edf7ff 100%);
  color: #111827;
  padding: 38px 16px 72px;
}

.hunter-wrap {
  width: min(100%, 1780px);
  margin: 0 auto;
}

/* Hero: full-width Figma-style launch panel with the updated green gradient. */
.hunter-hero {
  min-height: 520px;
  border-radius: 14px;
  background: linear-gradient(135deg, #047857 0%, #059669 46%, #0d9488 100%);
  color: #ffffff;
  display: grid;
  place-items: center;
  text-align: center;
  padding: 70px 48px;
  box-shadow: 0 24px 52px rgba(5, 150, 105, 0.2);
}

.page-kicker {
  margin: 0 0 12px;
  font-size: 1rem;
  font-weight: 950;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.hunter-hero h1 {
  max-width: 1280px;
  margin: 0;
  font-size: clamp(3rem, 5.7vw, 6.1rem);
  line-height: 1.02;
  font-weight: 950;
}

.hunter-hero p {
  max-width: 980px;
  margin: 32px auto 0;
  color: rgba(255, 255, 255, 0.9);
  font-size: clamp(1.2rem, 1.7vw, 1.7rem);
  line-height: 1.45;
}

.hero-actions,
.quiz-actions {
  margin-top: 42px;
  display: flex;
  justify-content: center;
  gap: 16px;
  flex-wrap: wrap;
}

/* Shared buttons: keeps CTAs visually consistent across intro, quiz, and result states. */
.hero-primary,
.hero-secondary,
.primary-action,
.secondary-action,
.begin-assessment,
.recommended-actions button,
.recommended-actions a,
.retake-button,
.wildlife-button {
  min-height: 58px;
  border-radius: 8px;
  border: 1px solid transparent;
  padding: 0 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 18px;
  font-family: inherit;
  font-size: 1rem;
  font-weight: 950;
  text-decoration: none;
  cursor: pointer;
}

.hero-primary {
  min-width: 360px;
  min-height: 72px;
  background: #ffffff;
  color: #047857;
  box-shadow: 0 14px 30px rgba(30, 41, 59, 0.18);
}

.hero-primary span,
.begin-assessment span {
  font-size: 1.6rem;
  line-height: 1;
}

.hero-secondary {
  color: #ffffff;
  background: rgba(255, 255, 255, 0.14);
  border-color: rgba(255, 255, 255, 0.35);
}

/* Overview cards: "What You'll Discover" and "Four Hunter Profile Types" sections on the landing state. */
.info-card,
.analysis-card {
  margin-top: 34px;
  border: 1px solid #e2e8e3;
  border-radius: 14px;
  background: #ffffff;
  box-shadow: 0 18px 38px rgba(51, 65, 85, 0.08);
  padding: 48px;
}

.section-copy h2,
.quiz-head h2,
.analysis-card h3,
.recommended-card h2 {
  margin: 0;
  color: #0b0f19;
  font-size: clamp(1.8rem, 2.4vw, 2.8rem);
  line-height: 1.15;
  font-weight: 950;
}

.section-copy p,
.analysis-card p,
.recommended-card p {
  margin: 16px 0 0;
  color: #6f7282;
  font-size: clamp(1rem, 1.4vw, 1.45rem);
  line-height: 1.5;
}

.profile-type-grid {
  margin-top: 48px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 32px;
}

.profile-type {
  min-height: 176px;
  display: grid;
  grid-template-columns: 54px 1fr;
  gap: 24px;
  align-items: start;
  border: 3px solid transparent;
  border-radius: 14px;
  padding: 38px 36px;
}

.profile-type h3 {
  margin: 0;
  font-size: clamp(1.35rem, 2vw, 2.05rem);
  line-height: 1.2;
  font-weight: 950;
}

.profile-type p {
  margin: 24px 0 0;
  color: #354155;
  font-size: clamp(1rem, 1.35vw, 1.45rem);
  line-height: 1.45;
}

.type-icon {
  width: 48px;
  height: 48px;
  display: grid;
  place-items: center;
  border: 4px solid currentColor;
  border-radius: 999px;
  font-size: 1.3rem;
  font-weight: 950;
}

.profile-low {
  color: #07883e;
  background: #edfff5;
  border-color: #abefc1;
}

.profile-opportunistic {
  color: #a86800;
  background: #fffdeb;
  border-color: #f5dd55;
}

.profile-stalker {
  color: #d63a00;
  background: #fff5e8;
  border-color: #ffd29b;
}

.profile-ambush {
  color: #d00212;
  background: #fff2f2;
  border-color: #ffc7c7;
}

.begin-row {
  display: flex;
  justify-content: center;
  margin: 72px 0 0;
}

.begin-assessment {
  min-width: 420px;
  min-height: 76px;
  color: #ffffff;
  background: linear-gradient(90deg, #047857, #08a84e);
  font-size: 1.55rem;
  box-shadow: 0 20px 34px rgba(5, 150, 105, 0.2);
}

.discover-card {
  margin-top: 72px;
}

.discover-grid {
  margin-top: 48px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 58px 76px;
}

.discover-item {
  display: grid;
  grid-template-columns: 96px 1fr;
  gap: 34px;
  align-items: start;
}

.discover-icon {
  width: 86px;
  height: 86px;
  display: grid;
  place-items: center;
  border-radius: 999px;
  font-size: 2rem;
  font-weight: 950;
}

.discover-icon :deep(.line-icon),
.type-icon :deep(.line-icon),
.result-icon :deep(.line-icon),
.light-icon :deep(.line-icon),
.primary-action :deep(.line-icon) {
  width: 1em;
  height: 1em;
}

.discover-violet {
  color: #9717f0;
  background: #f1ddff;
}

.discover-amber {
  color: #f35b00;
  background: #ffecd2;
}

.discover-blue {
  color: #2563eb;
  background: #dcecff;
}

.discover-green {
  color: #069a4a;
  background: #d8fae4;
}

.discover-item h3 {
  margin: 8px 0 0;
  color: #0b0f19;
  font-size: clamp(1.35rem, 1.9vw, 2rem);
  line-height: 1.2;
  font-weight: 950;
}

.discover-item p {
  margin: 16px 0 0;
  color: #6f7282;
  font-size: clamp(1rem, 1.3vw, 1.35rem);
  line-height: 1.48;
}

.quiz-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
}

.quiz-head span {
  flex: 0 0 auto;
  border-radius: 999px;
  background: #ecfdf5;
  color: #047857;
  padding: 10px 16px;
  font-weight: 900;
}

/* Quiz controls: browser state only; submitted values are revalidated and rescored by the API. */
.question-stack {
  margin-top: 34px;
  display: grid;
  gap: 20px;
}

.question-block {
  margin: 0;
  border: 1px solid #dfe8e2;
  border-radius: 12px;
  padding: 22px;
}

.question-block legend {
  padding: 0 8px;
  color: #111827;
  font-weight: 950;
}

.question-block legend span {
  color: #8b1fe6;
  margin-right: 10px;
}

.option-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.option-card {
  min-height: 56px;
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid #dfe8e2;
  border-radius: 8px;
  background: #fbfffc;
  padding: 0 14px;
  color: #374151;
  font-weight: 850;
  cursor: pointer;
}

.option-card.selected {
  color: #047857;
  border-color: #10b981;
  background: #ecfdf5;
}

.option-card input {
  accent-color: #047857;
}

.primary-action {
  color: #ffffff;
  background: #08ac4f;
}

.primary-action:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.secondary-action,
.retake-button {
  color: #111827;
  background: #ffffff;
  border-color: #d8dce2;
}

.form-error,
.empty-copy {
  margin: 18px 0 0;
  color: #b91c1c;
  font-weight: 850;
}

.result-panel {
  margin-top: 34px;
}

/* Result summary: profile color and icon are tied to the calculated server profile key. */
.profile-banner {
  min-height: 210px;
  border: 3px solid transparent;
  border-radius: 24px;
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr) auto;
  gap: 34px;
  align-items: start;
  padding: 46px 52px;
}

.profile-banner h2 {
  margin: 0;
  color: #0b0f19;
  font-size: clamp(2.3rem, 3.8vw, 4.25rem);
  line-height: 1;
  font-weight: 950;
}

.profile-banner p {
  margin: 24px 0 0;
  max-width: 1240px;
  color: #334155;
  font-size: clamp(1.2rem, 1.7vw, 1.75rem);
  line-height: 1.45;
}

.profile-banner small {
  display: inline-block;
  margin-top: 18px;
  color: #475569;
  font-size: 1rem;
  font-weight: 850;
}

.result-icon {
  width: 72px;
  height: 72px;
  display: grid;
  place-items: center;
  border: 6px solid currentColor;
  border-radius: 999px;
  color: currentColor;
  font-size: 2rem;
  font-weight: 950;
}

.score-pill {
  min-width: 220px;
  min-height: 82px;
  border: 1px solid rgba(15, 23, 42, 0.14);
  border-radius: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #0b0f19;
  background: rgba(255, 255, 255, 0.54);
  font-size: clamp(1.4rem, 2vw, 2rem);
  font-weight: 950;
}

.result-low {
  color: #07883e;
  background: #edfff5;
  border-color: #abefc1;
}

.result-opportunistic {
  color: #a86800;
  background: #fffdeb;
  border-color: #f5dd55;
}

.result-stalker {
  color: #d63a00;
  background: #fff5e8;
  border-color: #ffd29b;
}

.result-ambush {
  color: #d00212;
  background: #fff2f2;
  border-color: #ffc7c7;
}

.result-grid {
  margin-top: 46px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 46px;
}

/* Analysis cards: local species and encounter math use fields returned by /api/hunter-profile. */
.analysis-card {
  margin-top: 0;
  padding: 42px;
}

.card-title {
  display: grid;
  grid-template-columns: 40px 1fr;
  gap: 18px;
  align-items: start;
}

.card-title h3 {
  font-size: clamp(1.35rem, 1.8vw, 2rem);
}

.warning-icon,
.trend-icon,
.light-icon {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  color: #fb4d00;
  font-size: 1.35rem;
  font-weight: 950;
}

.trend-icon {
  color: #2563eb;
}

.species-risk-list {
  margin-top: 54px;
  display: grid;
  gap: 30px;
}

.species-risk-row {
  min-height: 148px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 24px;
  border: 1px solid #dfe3e8;
  border-radius: 14px;
  background: #ffffff;
  padding: 32px;
}

.species-risk-row h4 {
  margin: 0;
  color: #0b0f19;
  font-size: clamp(1.25rem, 1.6vw, 1.75rem);
  line-height: 1.15;
  font-weight: 950;
}

.species-risk-row p {
  margin: 14px 0 0;
  color: #6f7282;
  font-size: clamp(1rem, 1.3vw, 1.4rem);
  font-weight: 700;
}

.risk-pill {
  flex: 0 0 auto;
  border-radius: 12px;
  padding: 12px 18px;
  color: #ffffff;
  font-size: 1.05rem;
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

.encounter-number {
  min-height: 290px;
  display: grid;
  place-items: center;
  align-content: center;
  text-align: center;
}

.encounter-number strong {
  color: #2563eb;
  font-size: clamp(4.4rem, 7vw, 7rem);
  line-height: 0.95;
  font-weight: 950;
}

.encounter-number span {
  margin-top: 24px;
  color: #6f7282;
  font-size: clamp(1rem, 1.35vw, 1.45rem);
  font-weight: 850;
}

.methodology-box {
  border-radius: 14px;
  background: #eef6ff;
  padding: 30px 34px;
}

.methodology-box h4 {
  margin: 0 0 18px;
  color: #0b0f19;
  font-size: 1.35rem;
  font-weight: 950;
}

.methodology-box ul {
  margin: 0;
  padding-left: 24px;
  color: #6f7282;
  font-size: clamp(1rem, 1.25vw, 1.35rem);
  line-height: 1.65;
  font-weight: 750;
}

.methodology-box p {
  margin-top: 18px;
  font-size: 1rem;
  font-weight: 850;
}

.recommended-card {
  margin-top: 46px;
  border: 3px solid #b7f7c7;
  border-radius: 22px;
  background: linear-gradient(135deg, #f0fff7 0%, #ecfff5 62%, #f9fffb 100%);
  box-shadow: 0 18px 38px rgba(47, 96, 72, 0.08);
  padding: 48px;
}

.recommended-head {
  display: grid;
  grid-template-columns: 46px 1fr;
  gap: 18px;
  align-items: start;
}

.light-icon {
  color: #07a24c;
}

.recommended-card h3 {
  margin: 54px 0 0;
  color: #07883e;
  font-size: clamp(1.6rem, 2.5vw, 2.5rem);
  line-height: 1.15;
  font-weight: 950;
}

.recommended-card .action-copy {
  color: #334155;
  max-width: 1480px;
}

.evidence-box {
  margin-top: 48px;
  border: 2px solid #61e98d;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.72);
  padding: 28px 34px;
}

.evidence-box strong {
  color: #0b0f19;
  font-size: 1.25rem;
  font-weight: 950;
}

.evidence-box p {
  margin-top: 12px;
  font-size: clamp(1rem, 1.25vw, 1.25rem);
}

.effectiveness-row {
  margin-top: 50px;
  display: flex;
  justify-content: space-between;
  gap: 20px;
  color: #0b0f19;
  font-size: clamp(1rem, 1.4vw, 1.35rem);
  font-weight: 950;
}

.effectiveness-row strong {
  color: #04a84f;
}

.effectiveness-track {
  height: 24px;
  margin-top: 20px;
  border-radius: 999px;
  background: #c7d2cc;
  overflow: hidden;
}

.effectiveness-track span {
  display: block;
  width: var(--effectiveness);
  max-width: 100%;
  height: 100%;
  border-radius: inherit;
  background: #030414;
}

.recommended-actions {
  margin-top: 72px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
}

.recommended-actions button {
  color: #ffffff;
  background: #08ac4f;
}

.recommended-actions a {
  color: #111827;
  background: #ffffff;
  border-color: #d7dde2;
}

.result-actions {
  margin-top: 76px;
  display: flex;
  justify-content: center;
  gap: 34px;
  flex-wrap: wrap;
}

.wildlife-button {
  min-width: 360px;
  color: #ffffff;
  background: #2563eb;
}

@media (max-width: 980px) {
  .hunter-hero,
  .info-card,
  .analysis-card,
  .recommended-card,
  .profile-banner {
    padding: 26px;
  }

  .hunter-hero {
    min-height: 420px;
  }

  .profile-type-grid,
  .discover-grid,
  .option-grid,
  .result-grid,
  .recommended-actions {
    grid-template-columns: 1fr;
  }

  .profile-banner {
    grid-template-columns: 1fr;
  }

  .score-pill {
    min-width: 0;
    width: 100%;
  }

  .species-risk-row {
    align-items: flex-start;
    flex-direction: column;
  }
}

@media (max-width: 640px) {
  .hunter-page {
    padding-inline: 12px;
  }

  .hero-primary,
  .begin-assessment,
  .wildlife-button {
    min-width: 0;
    width: 100%;
  }

  .profile-type,
  .discover-item {
    grid-template-columns: 1fr;
  }
}
</style>
