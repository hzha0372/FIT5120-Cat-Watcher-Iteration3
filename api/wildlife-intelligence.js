import { Pool } from 'pg'

// Wildlife Intelligence page JS.
// Owns prediction/hotspot analysis data and postcode/suburb lookup.
// Vercel entry: /api/wildlife-intelligence, with action=feed or action=suburbs.
/*
  Module Notes
  - Uses species_cache for FFG-listed biodiversity records.
  - Uses suburb_demographics to resolve the searched Victorian postcode centroid before any 5km calculation runs.
  - Uses reserves boundary geometry to calculate nearest-reserve distances with PostGIS geography.
  - Returns every numeric value rendered by WildlifeIntelligenceView.vue: nearestReserveKm, likelihoodScore, recordCount, distanceKm, and radiusMetres.
  - Does not use hard-coded demo rows for displayed counts, percentages, dates, or distances; the frontend only reshapes these database/API values.
*/
/* eslint-env node */
/* global process */

const DEFAULT_DB_CONFIG = {
  host: '130.162.194.202',
  port: 5432,
  user: 'postgres',
  password: 'bbd4ba1eb45b2b5308e993832030699301d9dc49b2b935d747759502bc8e055a',
  database: 'echoes_of_earth',
}

let pool = null

// Shared sanitizers. PostgreSQL numeric columns are strings in node-postgres, so response values are normalized before JSON output.
const cleanText = (value) => String(value || '').trim()

const toInt = (value, fallback = 0) => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n) : fallback
}

const toNum = (value, fallback = 0) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

// Reuse one PostgreSQL pool and support both local defaults and deployment DATABASE_URL/PG* environment variables.
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

// species_cache does not expose a taxon_type column, so prey category is inferred consistently from common/scientific names.
const inferPreyType = (commonName = '', scientificName = '') => {
  const text = `${commonName} ${scientificName}`.toLowerCase()
  if (/(bird|duck|parrot|cockatoo|lorikeet|rosella|owl|eagle|hawk|falcon|goshawk|wren|finch|honeyeater|swallow|teal|dove|pigeon|raven|magpie|wagtail|warbler|gull|swan|coot|snipe|quail|rail|heron|ibis|egret|bittern|tern|sandpiper|greenshank|goose|aves|passer|platycercus|trichoglossus|gymnorhina|rostratula)/.test(text)) {
    return 'Bird'
  }
  if (/(lizard|skink|gecko|snake|python|turtle|dragon|reptile|scinc|pogona|varanus|notechis|pseudonaja|morelia)/.test(text)) {
    return 'Reptile'
  }
  if (/(possum|bandicoot|dunnart|antechinus|rat|mouse|mammal|bat|trichosurus|petaurus|perameles|rattus|pseudomys)/.test(text)) {
    return 'Small Mammal'
  }
  if (/(frog|toad|amphib)/.test(text)) return 'Amphibian'
  if (/(butterfly|moth|beetle|insect|bee|wasp|dragonfly)/.test(text)) return 'Insect'
  return 'Native Species'
}

// Resolve an existing CatWatcher user when userId is provided; postcode-only lookup supports direct searches.
const getUser = async (db, { userId, postcode }) => {
  const result = await db.query(
    `SELECT id,
            name,
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

// Look up the searched postcode centroid from suburb_demographics; every distance query depends on these coordinates.
const getPostcodeLocation = async (db, postcode) => {
  const result = await db.query(
    `SELECT TRIM(postcode) AS postcode,
            suburb_name,
            lga_name,
            centroid_lat,
            centroid_lng
     FROM suburb_demographics
     WHERE state = 'VIC'
       AND TRIM(postcode) = $1
     ORDER BY population DESC NULLS LAST, suburb_name ASC
     LIMIT 1`,
    [postcode],
  )

  return result.rows?.[0] || null
}

// Shape prediction rows and preserve the API likelihood score even if the current card UI only displays High/Medium/Low.
const normalizePredictionRow = (row) => {
  const commonName = cleanText(row.common_name)
  const scientificName = cleanText(row.scientific_name)
  const preyType = inferPreyType(commonName, scientificName)
  const category = preyType === 'Small Mammal' ? 'Mammal' : preyType
  const likelihoodScore = toNum(row.likelihood_score, 0)
  const activityLevel = cleanText(row.activity_level) || 'Low'
  return {
    id: `${scientificName || commonName}`.toLowerCase(),
    commonName,
    scientificName,
    conservationStatus: cleanText(row.conservation_status) || 'Not listed',
    category,
    nearestReserveName: cleanText(row.nearest_reserve_name),
    nearestReserveKm: toNum(row.nearest_reserve_km, null),
    likelihoodScore,
    activityLevel,
  }
}

// Shape hotspot buckets; recordCount and distanceKm are direct SQL outputs from the species_cache grid query.
const normalizeHotspotRow = (row) => ({
  hotspotId: cleanText(row.hotspot_id),
  severityLevel: cleanText(row.severity_level) || 'Low',
  recordCount: toInt(row.record_count, 0),
  dominantCategory: cleanText(row.dominant_category) || 'Native Species',
  distanceKm: toNum(row.distance_km, null),
  lat: toNum(row.hotspot_lat, null),
  lng: toNum(row.hotspot_lng, null),
})

// Main feed endpoint: resolves the searched location and loads the numeric analysis sections from database queries.
// Main Epic 10 read path.
// Input: userId and/or postcode.
// Output: one cohesive payload containing prediction cards, hotspot rows, and resolved user/suburb context.
const wildlifeFeedHandler = async (req, res) => {
  try {
    const db = getPool()

    const userId = req?.query?.userId ? toInt(req.query.userId, null) : null
    const requestedPostcode = cleanText(req?.query?.postcode)
    const user = userId
      ? await getUser(db, { userId, postcode: null })
      : await getUser(db, { userId: null, postcode: requestedPostcode || null })
    const searchPostcode = requestedPostcode || cleanText(user?.postcode)

    if (!user && !searchPostcode) {
      res.status(404).json({ error: 'No logged-in user row or postcode was found for Wildlife Intelligence.' })
      return
    }

    const location = await getPostcodeLocation(db, searchPostcode)
    const homeLat = toNum(location?.centroid_lat, null)
    const homeLng = toNum(location?.centroid_lng, null)

    if (!Number.isFinite(homeLat) || !Number.isFinite(homeLng)) {
      res.status(404).json({ error: 'No postcode centroid was found for this search.' })
      return
    }

    // Predictions are scored only from nearby species_cache records: volume, seasonal week match, and distance from the searched centroid.
    // Prediction model (explainable weighted scoring):
    // frequency_weight(45%) + seasonal_weight(35%) + distance_weight(20%)
    // then bucketed to High/Medium/Low thresholds for UI labels.
    const predictionsResult = await db.query(
      `WITH home AS (
         SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography AS geom
       ),
       records AS (
         SELECT
           TRIM(sc.vernacular_name) AS common_name,
           TRIM(sc.scientific_name) AS scientific_name,
           COALESCE(NULLIF(TRIM(sc.state_conservation), ''), 'Not listed') AS conservation_status,
           sc.cached_at,
           sc.lat,
           sc.lng,
           EXTRACT(WEEK FROM sc.cached_at)::int AS week_no
         FROM species_cache sc
         CROSS JOIN home
         WHERE sc.lat IS NOT NULL
           AND sc.lng IS NOT NULL
           AND sc.cached_at IS NOT NULL
           AND COALESCE(NULLIF(TRIM(sc.state_conservation), ''), 'Not listed') <> 'Not listed'
           AND ST_DWithin(
             ST_SetSRID(ST_MakePoint(sc.lng::float, sc.lat::float), 4326)::geography,
             home.geom,
             5000
           )
       ),
       scored AS (
         SELECT
           common_name,
           scientific_name,
           conservation_status,
           COUNT(*)::numeric AS total_count,
           SUM(
             CASE
               WHEN ABS(week_no - EXTRACT(WEEK FROM CURRENT_DATE)::int) <= 2 THEN 1
               ELSE 0
             END
           )::numeric AS seasonal_count,
           MAX(cached_at) AS latest_seen_at,
           AVG(
             ST_Distance(
               ST_SetSRID(ST_MakePoint(lng::float, lat::float), 4326)::geography,
               home.geom
             )
           ) AS avg_distance_m
         FROM records
         CROSS JOIN home
         GROUP BY common_name, scientific_name, conservation_status
       ),
       with_reserve AS (
         SELECT
           s.*,
           nearest.reserve_name AS nearest_reserve_name,
           nearest.nearest_reserve_km
         FROM scored s
         LEFT JOIN LATERAL (
           SELECT
             reserve_name,
             ROUND((
               ST_Distance(
                 ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
                 boundary::geography
               ) / 1000
             )::numeric, 1) AS nearest_reserve_km
           FROM reserves
           WHERE boundary IS NOT NULL
           ORDER BY boundary <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
           LIMIT 1
         ) nearest ON TRUE
       ),
       weighted AS (
         SELECT
           *,
           (
             LEAST(total_count / 12.0, 1.0) * 0.45
             + LEAST(seasonal_count / NULLIF(total_count, 0), 1.0) * 0.35
             + GREATEST(0.0, 1.0 - LEAST(COALESCE(avg_distance_m, 5000) / 5000.0, 1.0)) * 0.20
           ) * 100.0 AS likelihood_score
         FROM with_reserve
       )
       SELECT
         common_name,
         scientific_name,
         conservation_status,
         nearest_reserve_name,
         nearest_reserve_km,
         ROUND(likelihood_score::numeric, 1) AS likelihood_score,
         CASE
           WHEN likelihood_score >= 68 THEN 'High'
           WHEN likelihood_score >= 40 THEN 'Medium'
           ELSE 'Low'
         END AS activity_level
       FROM weighted
       ORDER BY likelihood_score DESC, latest_seen_at DESC
       LIMIT 6`,
      [homeLng, homeLat],
    )

    // Hotspots bucket nearby species_cache coordinates into small grid cells; counts/severity/distance are all SQL-derived.
    // Hotspot model:
    // spatially bucket threatened points on a fixed grid,
    // count density per bucket,
    // infer dominant category,
    // assign severity level by count thresholds.
    const hotspotsResult = await db.query(
      `WITH home AS (
         SELECT
           ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography AS geom,
           ST_SetSRID(ST_MakePoint($1, $2), 4326) AS geom4326
       ),
       source AS (
         SELECT
           TRIM(sc.vernacular_name) AS common_name,
           TRIM(sc.scientific_name) AS scientific_name,
           COALESCE(NULLIF(TRIM(sc.state_conservation), ''), 'Not listed') AS conservation_status,
           ST_SetSRID(ST_MakePoint(sc.lng::float, sc.lat::float), 4326) AS geom
         FROM species_cache sc
         CROSS JOIN home
         WHERE sc.lat IS NOT NULL
           AND sc.lng IS NOT NULL
           AND COALESCE(NULLIF(TRIM(sc.state_conservation), ''), 'Not listed') <> 'Not listed'
           AND ST_DWithin(
             ST_SetSRID(ST_MakePoint(sc.lng::float, sc.lat::float), 4326)::geography,
             home.geom,
             5000
           )
       ),
       gridded AS (
         SELECT
           ST_SnapToGrid(geom, 0.01, 0.01) AS grid_geom,
           common_name,
           scientific_name
         FROM source
       ),
       bucketed AS (
         SELECT
           ST_AsText(grid_geom) AS hotspot_id,
           ST_Y(ST_Centroid(grid_geom)) AS hotspot_lat,
           ST_X(ST_Centroid(grid_geom)) AS hotspot_lng,
           COUNT(*)::int AS record_count,
           SUM(CASE WHEN (LOWER(common_name) ~ '(bird|duck|parrot|cockatoo|lorikeet|rosella|owl|eagle|hawk|falcon|goshawk|wren|finch|honeyeater|swallow|teal|dove|pigeon|raven|magpie|wagtail|warbler|gull|swan|coot|snipe|quail|rail|heron|ibis|egret|bittern|tern|sandpiper|greenshank|goose)') THEN 1 ELSE 0 END) AS bird_count,
           SUM(CASE WHEN (LOWER(common_name) ~ '(lizard|skink|gecko|snake|python|turtle|dragon|reptile)') THEN 1 ELSE 0 END) AS reptile_count,
           SUM(CASE WHEN (LOWER(common_name) ~ '(possum|bandicoot|dunnart|antechinus|rat|mouse|mammal|bat)') THEN 1 ELSE 0 END) AS mammal_count
         FROM gridded
         GROUP BY grid_geom
         HAVING COUNT(*) >= 2
       )
       SELECT
         hotspot_id,
         hotspot_lat,
         hotspot_lng,
         record_count,
         CASE
           WHEN bird_count >= reptile_count AND bird_count >= mammal_count THEN 'Bird'
           WHEN reptile_count >= mammal_count THEN 'Reptile'
           ELSE 'Mammal'
         END AS dominant_category,
         CASE
           WHEN record_count >= 8 THEN 'High'
           WHEN record_count >= 4 THEN 'Medium'
           ELSE 'Low'
         END AS severity_level,
         ROUND((
           ST_Distance(
             ST_SetSRID(ST_MakePoint(hotspot_lng, hotspot_lat), 4326)::geography,
             home.geom
           ) / 1000
         )::numeric, 2) AS distance_km
       FROM bucketed
       CROSS JOIN home
       ORDER BY record_count DESC, distance_km ASC
       LIMIT 8`,
      [homeLng, homeLat],
    )

    res.status(200).json({
      user: {
        id: user?.id ? toInt(user.id) : null,
        name: cleanText(user?.name),
        postcode: cleanText(location?.postcode || searchPostcode),
        suburbName: cleanText(location?.suburb_name),
        lgaName: cleanText(location?.lga_name),
        lat: homeLat,
        lng: homeLng,
      },
      radiusMetres: 5000,
      predictions: (predictionsResult.rows || []).map(normalizePredictionRow),
      hotspots: (hotspotsResult.rows || []).map(normalizeHotspotRow),
      updatedAt: new Date().toISOString(),
    })
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Unable to load wildlife intelligence.' })
  }
}

// Suburb autocomplete follows the same Victorian suburb_demographics lookup pattern used by Risk Map and Photo Identifier.
// Shared VIC suburb/postcode autocomplete endpoint.
// Used by the Analyze search.
const wildlifeSuburbsHandler = async (req, res) => {
  try {
    const q = cleanText(req.query?.q)
    const limit = Math.max(1, Math.min(80, Number(req.query?.limit) || 20))
    if (!q) {
      res.status(200).json({ results: [] })
      return
    }

    const query = q.toLowerCase()
    const postcodePrefix = query.match(/^(\d{1,4})/)?.[1] || ''
    const isPostcode = Boolean(postcodePrefix)
    const db = getPool()
    // Match the existing suburb/postcode autocomplete behavior used by the other search pages.
    const result = await db.query(
      `SELECT TRIM(postcode) AS postcode,
              suburb_name,
              centroid_lat,
              centroid_lng,
              population
       FROM suburb_demographics
       WHERE state = 'VIC'
         AND (
           suburb_name ILIKE $1
           OR CAST(TRIM(postcode) AS TEXT) LIKE $2
         )
       ORDER BY
         CASE
           WHEN CAST(TRIM(postcode) AS TEXT) = $3 THEN 0
           WHEN suburb_name ILIKE $4 AND LOWER(TRIM(suburb_name)) <> LOWER(TRIM(postcode)) THEN 0
           ELSE 1
         END,
         CASE
           WHEN LOWER(TRIM(suburb_name)) = LOWER(TRIM(postcode)) THEN 1
           ELSE 0
         END,
         population DESC NULLS LAST,
         suburb_name ASC
       LIMIT $5`,
      [`%${q}%`, `${isPostcode ? postcodePrefix : query}%`, isPostcode ? postcodePrefix : '', `${q}%`, limit * 3],
    )

    const dedup = new Map()
    for (const row of result.rows || []) {
      const postcode = cleanText(row.postcode)
      const name = cleanText(row.suburb_name)
      if (!postcode || !name) continue
      const hasRealName = name.toLowerCase() !== postcode.toLowerCase()
      const label = isPostcode && hasRealName ? `${postcode} · ${name}` : hasRealName ? name : postcode
      const displayQuery = hasRealName ? `${postcode} ${name}` : postcode
      const key = `${postcode}-${name.toLowerCase()}`
      if (!dedup.has(key)) {
        dedup.set(key, {
          id: `${postcode}-${name}`,
          postcode,
          name,
          lat: toNum(row.centroid_lat, null),
          lng: toNum(row.centroid_lng, null),
          label,
          displayQuery,
        })
      }
    }

    res.status(200).json({
      results: Array.from(dedup.values()).slice(0, limit),
    })
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Suburb lookup failed.', results: [] })
  }
}

// Router for Vercel/Vite middleware action values.
export default async function wildlifeIntelligenceHandler(req, res) {
  const action = String(req.query?.action || req.featureAction || 'feed')
  if (action === 'suburbs') return wildlifeSuburbsHandler(req, res)
  return wildlifeFeedHandler(req, res)
}
