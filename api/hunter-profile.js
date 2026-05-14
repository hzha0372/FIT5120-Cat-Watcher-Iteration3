import { Pool } from 'pg'

// Hunter Profile page JS.
// Owns quiz scoring, user/cat lookup, prey encounter estimates, and local threatened species results.
// Vercel entry: /api/hunter-profile.
/*
  Module Notes
  - Calculates the profile from submitted answers instead of trusting frontend labels or cached browser state.
  - Reads cat name/postcode from users, suburb display fields from suburb_demographics, prey rate from cats_behaviour_stats, and species risk rows from species_cache.
  - Returns every displayed numeric result used by HunterProfileView.vue: score, roamingHours, preyRatePerDay, recordCount, and monthlyEncounters.
  - Keeps profile descriptions/actions as deterministic rule copy because the database screenshots do not include a profile-copy table.
  - Infers prey category from species names because species_cache does not expose a taxon_type column.
*/
/* eslint-env node */
/* global process, Buffer */

const DEFAULT_DB_CONFIG = {
  host: '130.162.194.202',
  port: 5432,
  user: 'postgres',
  password: 'bbd4ba1eb45b2b5308e993832030699301d9dc49b2b935d747759502bc8e055a',
  database: 'echoes_of_earth',
}

const PREY_RATE_FALLBACK = 0.0667

let pool = null

// Numeric coercion helpers keep API responses stable when PostgreSQL numeric columns arrive as strings.
const toNum = (value, fallback = 0) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

const toInt = (value, fallback = 0) => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n) : fallback
}

const cleanText = (value) => String(value || '').trim()

// Reuse one connection pool across serverless/Vite requests and prefer environment variables when provided.
const getPool = () => {
  if (pool) return pool

  const hasUrl = Boolean(process.env.DATABASE_URL)
  const hasPgVars = Boolean(
    process.env.PGHOST ||
      process.env.PGPORT ||
      process.env.PGUSER ||
      process.env.PGPASSWORD ||
      process.env.PGDATABASE,
  )
  const config = hasUrl && !hasPgVars
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: process.env.PGHOST || DEFAULT_DB_CONFIG.host,
        port: toInt(process.env.PGPORT, DEFAULT_DB_CONFIG.port),
        user: process.env.PGUSER || DEFAULT_DB_CONFIG.user,
        password: process.env.PGPASSWORD || DEFAULT_DB_CONFIG.password,
        database: process.env.PGDATABASE || DEFAULT_DB_CONFIG.database,
      }

  if (process.env.NODE_ENV === 'production' && hasUrl && !hasPgVars) {
    config.ssl = { rejectUnauthorized: false }
  }

  pool = new Pool(config)
  return pool
}

// Local Vite middleware and Vercel serverless functions expose JSON bodies differently, so both shapes are supported.
const readJsonBody = async (req) => {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}')

  const chunks = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

// Weighted scoring model for AC9.1. The frontend sends only answer keys; this table owns the score and display labels.
const answerWeights = {
  timing: {
    duskDawn: { score: 4, label: 'Dusk and dawn' },
    daytime: { score: 1, label: 'Daytime' },
    lateNight: { score: 2, label: 'Late night' },
    allTimes: { score: 3, label: 'All times equally' },
  },
  stalking: {
    often: { score: 4, label: 'Often' },
    sometimes: { score: 2, label: 'Sometimes' },
    rarely: { score: 1, label: 'Rarely' },
    never: { score: 0, label: 'Never' },
  },
  preyHistory: {
    regularly: { score: 4, label: 'Yes, regularly' },
    occasionally: { score: 3, label: 'Yes, occasionally' },
    once: { score: 1, label: 'Only once' },
    never: { score: 0, label: 'Never' },
  },
  roamingHours: {
    less2: { score: 1, hours: 1, label: 'Less than 2 hours' },
    twoToFour: { score: 2, hours: 3, label: '2-4 hours' },
    fourToSix: { score: 3, hours: 5, label: '4-6 hours' },
    moreThanSix: { score: 4, hours: 7, label: 'More than 6 hours' },
  },
  habitat: {
    dense: { score: 4, label: 'Near dense gardens or bushland' },
    open: { score: 2, label: 'On open grass or footpaths' },
    sheltered: { score: 3, label: 'Under the house or in sheltered spots' },
    varies: { score: 3, label: 'Varies widely' },
  },
}

// Static profile copy returned with the calculated key. Numeric risk values are still database-derived below.
const profileText = {
  opportunistic: {
    type: 'Opportunistic Hunter',
    shortType: 'Opportunistic Hunter',
    primaryPreyCategory: 'Mixed',
    description: [
      'This profile fits cats that do not hunt constantly, but will take chances when wildlife crosses their path.',
      'They may roam at different times and switch between birds, reptiles, insects, or small mammals depending on what is nearby.',
      'The risk is real because chance encounters add up when roaming happens around gardens, paths, and shared neighbourhood spaces.',
    ],
    action: 'Start by shortening outdoor roaming windows around dawn and dusk.',
    citation: 'Cat Tracker SA reported a measurable daily prey encounter rate for outdoor cats, so reducing time outside directly reduces encounter opportunity.',
  },
  lowRisk: {
    type: 'Low-Risk Homebody',
    shortType: 'Low-Risk',
    primaryPreyCategory: 'Mixed',
    description: [
      'This profile fits cats that show little stalking behaviour and have no meaningful prey history.',
      'They usually spend less time roaming and are less likely to turn outdoor time into hunting time.',
      'The safest next step is to keep that low-risk pattern stable instead of letting outdoor access slowly expand.',
    ],
    action: 'Keep the current low-roaming routine and add supervised outdoor time before any longer free-roam periods.',
    citation: 'Cat Tracker SA found many owners underestimate hunting, so preserving low exposure is a practical prevention step.',
  },
  activeStalker: {
    type: 'Active Stalker',
    shortType: 'Active Stalker',
    primaryPreyCategory: 'Bird',
    description: [
      'This profile fits cats that notice movement quickly and are willing to stalk or chase when birds, lizards, or insects move nearby.',
      'They are most risky in open spaces and edge habitats where moving wildlife is visible.',
      'Their risk rises with longer roaming hours because every extra hour gives more chances to detect and pursue prey.',
    ],
    action: 'Use supervised outdoor sessions or a cat enclosure for the most active roaming window first.',
    citation: 'Cat Tracker SA prey rates scale with outdoor exposure, so controlling the highest-activity window cuts the most opportunity.',
  },
  ambushPredator: {
    type: 'Ambush Predator',
    shortType: 'Ambush Predator',
    primaryPreyCategory: 'Reptile',
    description: [
      'This profile fits cats that combine long roaming time, confirmed prey history, and sheltered or vegetation-heavy hunting spots.',
      'They may wait near dense cover, garden edges, or hidden paths where small wildlife passes close by.',
      'That style is especially concerning for threatened species because a quiet ambush often happens before owners notice hunting at all.',
    ],
    action: 'Fit a bell collar as the first step, then pair it with shorter roaming periods near dense gardens or bushland.',
    citation: 'Research cited in the brief reports bell collars reduce successful ambush strikes by 41%, making them especially relevant for this profile.',
  },
}

// All five questions must match the known answerWeights keys before any profile calculation or database query happens.
const validateAnswers = (answers) => {
  const required = ['timing', 'stalking', 'preyHistory', 'roamingHours', 'habitat']
  for (const key of required) {
    if (!answerWeights[key]?.[answers?.[key]]) {
      throw new Error('Please complete all five Hunter Profile quiz questions.')
    }
  }
}

// Calculate the score/profile server-side so a manipulated browser payload cannot choose its own Hunter Profile.
const calculateProfile = (answers) => {
  validateAnswers(answers)

  const score =
    answerWeights.timing[answers.timing].score +
    answerWeights.stalking[answers.stalking].score +
    answerWeights.preyHistory[answers.preyHistory].score +
    answerWeights.roamingHours[answers.roamingHours].score +
    answerWeights.habitat[answers.habitat].score

  const lowRiskAnswers =
    ['rarely', 'never'].includes(answers.stalking) &&
    ['once', 'never'].includes(answers.preyHistory)

  let key = 'opportunistic'
  if (score <= 6 && lowRiskAnswers) key = 'lowRisk'
  else if (score >= 15) key = 'ambushPredator'
  else if (score >= 9) key = 'activeStalker'

  const roamingHours = answerWeights.roamingHours[answers.roamingHours].hours
  return {
    key,
    score,
    roamingHours,
    labels: {
      timing: answerWeights.timing[answers.timing].label,
      stalking: answerWeights.stalking[answers.stalking].label,
      preyHistory: answerWeights.preyHistory[answers.preyHistory].label,
      roamingHours: answerWeights.roamingHours[answers.roamingHours].label,
      habitat: answerWeights.habitat[answers.habitat].label,
    },
    ...profileText[key],
  }
}

// Load the logged-in cat owner from users. userId is preferred; postcode is only a fallback for older/local payloads.
const getUser = async (db, { userId, postcode }) => {
  const result = await db.query(
    `SELECT id,
            name,
            cat_name,
            TRIM(postcode) AS postcode
     FROM users
     WHERE ($1::int IS NULL OR id = $1::int)
       AND ($2::text IS NULL OR TRIM(postcode) = TRIM($2::text))
     ORDER BY id ASC
     LIMIT 1`,
    [userId || null, postcode || null],
  )

  return result.rows?.[0] || null
}

// Get the Victorian suburb/LGA name for the user's postcode from suburb_demographics.
const getLocation = async (db, postcode) => {
  const result = await db.query(
    `SELECT TRIM(postcode) AS postcode,
            suburb_name,
            lga_name
     FROM suburb_demographics
     WHERE state = 'VIC'
       AND TRIM(postcode) = $1
     ORDER BY population DESC NULLS LAST, suburb_name ASC
     LIMIT 1`,
    [postcode],
  )

  return result.rows?.[0] || null
}

// Build SQL conditions that approximate the profile's prey category from species_cache names because no taxon_type column exists.
const preyCategorySql = (category) => {
  if (category === 'Bird') {
    return `(vernacular_name ~* '(bird|duck|parrot|cockatoo|lorikeet|rosella|owl|eagle|hawk|falcon|goshawk|wren|finch|honeyeater|swallow|teal|dove|pigeon|raven|magpie|wagtail|warbler|gull|swan|coot|snipe|quail|rail|heron|ibis|egret|bittern|tern|sandpiper|greenshank|goose)'
      OR scientific_name ~* '(aves|passer|platycercus|trichoglossus|gymnorhina|rhipidura|anas|cygnus|fulica|rostratula)')`
  }

  if (category === 'Reptile') {
    return `(vernacular_name ~* '(lizard|skink|gecko|snake|python|turtle|dragon|reptile)'
      OR scientific_name ~* '(reptilia|scinc|pogona|varanus|notechis|pseudonaja|morelia)')`
  }

  if (category === 'Small Mammal') {
    return `(vernacular_name ~* '(possum|bandicoot|dunnart|antechinus|rat|mouse|mammal|bat)'
      OR scientific_name ~* '(mammalia|trichosurus|petaurus|perameles|rattus|pseudomys)')`
  }

  return 'TRUE'
}

// Return the top three FFG-listed species for the user's postcode, ordered by conservation severity and local record count.
const getLocalThreatenedSpecies = async (db, postcode, category) => {
  const baseParams = [postcode]
  const categoryCondition = preyCategorySql(category)
  const runQuery = (condition) =>
    db.query(
      `WITH grouped AS (
         SELECT
           TRIM(vernacular_name) AS common_name,
           TRIM(scientific_name) AS scientific_name,
           COALESCE(NULLIF(TRIM(state_conservation), ''), 'Not listed') AS conservation_status,
           COUNT(*)::int AS record_count,
           MAX(cached_at) AS latest_cached_at
         FROM species_cache
         WHERE TRIM(postcode) = $1
           AND vernacular_name IS NOT NULL
           AND scientific_name IS NOT NULL
           AND COALESCE(NULLIF(TRIM(state_conservation), ''), 'Not listed') <> 'Not listed'
           AND ${condition}
         GROUP BY
           TRIM(vernacular_name),
           TRIM(scientific_name),
           COALESCE(NULLIF(TRIM(state_conservation), ''), 'Not listed')
       )
       SELECT *
       FROM grouped
       ORDER BY
         CASE
           WHEN LOWER(conservation_status) LIKE '%critical%' THEN 0
           WHEN LOWER(conservation_status) LIKE '%endangered%' THEN 1
           WHEN LOWER(conservation_status) LIKE '%vulnerable%' THEN 2
           ELSE 3
         END,
         record_count DESC,
         common_name ASC
       LIMIT 3`,
      baseParams,
    )

  let result = await runQuery(categoryCondition)

  // Keep the postcode requirement, but relax prey category if the selected hunting style has no exact category match in species_cache.
  if (!result.rows?.length && categoryCondition !== 'TRUE') {
    result = await runQuery('TRUE')
  }

  return (result.rows || []).map((row) => ({
    commonName: cleanText(row.common_name),
    scientificName: cleanText(row.scientific_name),
    conservationStatus: cleanText(row.conservation_status),
    recordCount: toInt(row.record_count),
    latestCachedAt: row.latest_cached_at ? new Date(row.latest_cached_at).toISOString() : null,
  }))
}

// Cat Tracker SA prey rate is stored in cats_behaviour_stats as prey_per_day; fallback only protects old DB snapshots.
const getPreyRate = async (db) => {
  const result = await db.query(
    `SELECT stat_value, source, notes
     FROM cats_behaviour_stats
     WHERE stat_name = 'prey_per_day'
     LIMIT 1`,
  )

  const row = result.rows?.[0] || null
  return {
    value: toNum(row?.stat_value, PREY_RATE_FALLBACK),
    source: cleanText(row?.source) || 'Cat Tracker SA prey rate',
    notes: cleanText(row?.notes),
  }
}

// Main endpoint: validates answers, reads all required DB rows, calculates the AC9.1 encounter estimate, and returns one view model.
export default async function hunterProfileHandler(req, res) {
  try {
    if ((req.method || 'POST').toUpperCase() !== 'POST') {
      res.status(405).json({ error: 'Only POST is supported.' })
      return
    }

    const body = await readJsonBody(req)
    const answers = body.answers || {}
    const userId = body.userId ? toInt(body.userId, null) : null
    const fallbackPostcode = cleanText(body.postcode)
    const profile = calculateProfile(answers)
    const db = getPool()

    // User identity and postcode come from the database, not from editable frontend display text.
    const user = userId
      ? await getUser(db, { userId, postcode: null })
      : await getUser(db, { userId: null, postcode: fallbackPostcode || null })
    if (!user) {
      res.status(404).json({ error: 'No logged-in user row was found for this Hunter Profile.' })
      return
    }

    const postcode = cleanText(user.postcode)
    // Independent DB reads can run in parallel: location label, prey-rate statistic, and local species risk rows.
    const [location, preyRate, species] = await Promise.all([
      getLocation(db, postcode),
      getPreyRate(db),
      getLocalThreatenedSpecies(db, postcode, profile.primaryPreyCategory),
    ])

    // AC9.1 formula: Cat Tracker SA prey_per_day x user answer roaming_hours / 24 x 30 days.
    const monthlyEncounters = Number((preyRate.value * (profile.roamingHours / 24) * 30).toFixed(2))

    res.status(200).json({
      user: {
        id: toInt(user.id),
        name: cleanText(user.name) || 'Cat owner',
        catName: cleanText(user.cat_name) || 'Your cat',
        postcode,
        suburbName: cleanText(location?.suburb_name),
        lgaName: cleanText(location?.lga_name),
      },
      profile: {
        key: profile.key,
        type: profile.type,
        shortType: profile.shortType,
        score: profile.score,
        primaryPreyCategory: profile.primaryPreyCategory,
        roamingHours: profile.roamingHours,
        answerLabels: profile.labels,
        description: profile.description,
        recommendedAction: profile.action,
        citation: profile.citation,
      },
      threatenedSpecies: species,
      estimate: {
        preyRatePerDay: preyRate.value,
        preyRateSource: preyRate.source,
        preyRateNotes: preyRate.notes,
        formula: 'prey_per_day * (roaming_hours / 24) * 30',
        monthlyEncounters,
      },
      updatedAt: new Date().toISOString(),
    })
  } catch (error) {
    res.status(400).json({ error: error?.message || 'Unable to build Hunter Profile.' })
  }
}
