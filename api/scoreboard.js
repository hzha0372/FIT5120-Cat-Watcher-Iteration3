import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto'
import { Pool } from 'pg'

// Scoreboard page JS.
// Owns personal scoreboard metrics, guardian leaderboard, roaming logs, and protected-page auth.
// Vercel entry: /api/scoreboard, with action=leaderboard, action=log, or action=auth for supporting sections.
/*
  Module Notes
  - Centralizes multiple scoreboard-related actions behind one API contract.
  - Includes authentication handlers plus community analytics reads/writes.
  - Keeps auth hashing and scoreboard calculations in the same service boundary for consistency.
  - Epic 9 intent:
    1) Provide personal containment performance metrics for the logged-in user.
    2) Provide suburb/community leaderboard rankings from real roaming_log data.
    3) Accept log writes that update future scoreboard calculations.
    4) Keep authentication and score computation in one service so protected pages stay consistent.
*/
let scoreboardDataHandler
{
/* eslint-env node */
/* global process */

const DEFAULT_DB_CONFIG = {
  host: '130.162.194.202',
  port: 5432,
  user: 'postgres',
  password: 'bbd4ba1eb45b2b5308e993832030699301d9dc49b2b935d747759502bc8e055a',
  database: 'echoes_of_earth',
}

const PREY_RATE_FALLBACK = 0.0667

let pool = null

const toInt = (v, fallback = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n) : fallback
}

const toNum = (v, fallback = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

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

const monthStartUtc = () => {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10)
}

const toIsoDate = (value) => {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

const diffDays = (laterIso, earlierIso) => {
  const later = new Date(`${laterIso}T00:00:00Z`).getTime()
  const earlier = new Date(`${earlierIso}T00:00:00Z`).getTime()
  return Math.round((later - earlier) / 86400000)
}

const getMilestones = (streakDays) => {
  const defs = [
    { days: 3, icon: 'seedling', label: '3 days' },
    { days: 7, icon: 'star', label: '7 days' },
    { days: 14, icon: 'medal', label: '14 days' },
    { days: 30, icon: 'trophy', label: '30 days' },
    { days: 60, icon: 'diamond', label: '60 days' },
  ]

  return defs.map((item) => ({
    ...item,
    unlocked: streakDays >= item.days,
  }))
}

const getScoreboardData = async (options = {}) => {
  const db = getPool()
  const monthStart = monthStartUtc()

  // Read prey rate data used for prevented encounter estimates.
  const preyRateResult = await db.query(
    `SELECT stat_value
     FROM cats_behaviour_stats
     WHERE stat_name = 'prey_per_day'
     LIMIT 1`,
  )
  const preyPerDay = toNum(preyRateResult.rows?.[0]?.stat_value, PREY_RATE_FALLBACK)

  // Resolve the signed in user from id/postcode.
  const resolvedUser =
    options.userId || options.postcode
      ? (
          await db.query(
            `SELECT id, name, cat_name, TRIM(postcode) AS postcode
             FROM users
             WHERE ($1::int IS NULL OR id = $1::int)
               AND ($2::text IS NULL OR TRIM(postcode) = TRIM($2::text))
             ORDER BY id ASC
             LIMIT 1`,
            [options.userId || null, options.postcode || null],
          )
        ).rows?.[0]
      : (
          await db.query(
            `SELECT id, name, cat_name, TRIM(postcode) AS postcode
             FROM users
             ORDER BY id ASC
             LIMIT 1`,
          )
        ).rows?.[0]

  if (!resolvedUser?.id) {
    throw new Error('No user row found to calculate Cat Scoreboard metrics.')
  }

  // Load personal logs and suburb metadata in parallel.
  const todayIsoResult = await db.query(`SELECT CURRENT_DATE::text AS today_iso`)
  const todayIso = todayIsoResult.rows?.[0]?.today_iso

  const [userIndoorDaysResult, userMonthResult, suburbResult] = await Promise.all([
    db.query(
      `SELECT DISTINCT rl.log_date::date AS day
       FROM roaming_log rl
       WHERE rl.user_id = $1
         AND LOWER(TRIM(rl.status)) LIKE '%indoor%'
       ORDER BY day DESC`,
      [resolvedUser.id],
    ),
    db.query(
      `SELECT COUNT(*) FILTER (WHERE LOWER(TRIM(status)) LIKE '%indoor%')::int AS indoor_count,
              COUNT(*) FILTER (WHERE LOWER(TRIM(status)) LIKE '%roam%')::int AS roaming_count
       FROM roaming_log
       WHERE user_id = $1
         AND log_date::date >= $2::date`,
      [resolvedUser.id, monthStart],
    ),
    db.query(
      `SELECT suburb_name, lga_name
       FROM suburb_demographics
       WHERE TRIM(postcode) = $1
       LIMIT 1`,
      [String(resolvedUser.postcode || '').trim()],
    ),
  ])

  const indoorDays = (userIndoorDaysResult.rows || []).map((r) => toIsoDate(r.day)).filter(Boolean)
  let currentStreak = 0
  let streakBroken = false

  if (indoorDays.length > 0 && indoorDays[0] === todayIso) {
    currentStreak = 1
    for (let i = 1; i < indoorDays.length; i += 1) {
      if (diffDays(indoorDays[i - 1], indoorDays[i]) === 1) {
        currentStreak += 1
      } else {
        break
      }
    }
  } else if (indoorDays.length > 0) {
    streakBroken = true
  }

  let bestStreak = 0
  let run = 0
  for (let i = indoorDays.length - 1; i >= 0; i -= 1) {
    if (i === indoorDays.length - 1) {
      run = 1
      bestStreak = 1
      continue
    }
    if (diffDays(indoorDays[i + 1], indoorDays[i]) === 1) {
      run += 1
    } else {
      run = 1
    }
    bestStreak = Math.max(bestStreak, run)
  }

  const userMonth = userMonthResult.rows?.[0] || {}
  const userContainedMonth = toInt(userMonth.indoor_count, 0)
  const userRoamingMonth = toInt(userMonth.roaming_count, 0)

  const userPostcode = String(resolvedUser.postcode || '').trim()
  const suburbMeta = suburbResult.rows?.[0] || {}

  // Build the live suburb ranking from real roaming_log rows.
  const leaderboardResult = await db.query(
    `WITH monthly AS (
       SELECT TRIM(u.postcode) AS postcode,
              COUNT(*) FILTER (WHERE LOWER(TRIM(rl.status)) LIKE '%indoor%')::int AS total_contained_evenings,
              COUNT(DISTINCT rl.user_id)::int AS active_guardian_count
       FROM roaming_log rl
       JOIN users u ON u.id = rl.user_id
       WHERE rl.log_date::date >= $1::date
         AND TRIM(COALESCE(u.postcode, '')) <> ''
       GROUP BY TRIM(u.postcode)
     ),
     enriched AS (
       SELECT TRIM(sd.postcode) AS postcode,
              sd.suburb_name,
              sd.lga_name,
              COALESCE(m.total_contained_evenings, 0)::int AS total_contained_evenings,
              COALESCE(m.active_guardian_count, 0)::int AS active_guardian_count,
              CASE
                WHEN COALESCE(m.active_guardian_count, 0) > 0
                THEN (
                  COALESCE(m.total_contained_evenings, 0)::numeric /
                  (
                    COALESCE(m.active_guardian_count, 0)::numeric *
                    EXTRACT(DAY FROM (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month - 1 day'))::numeric
                  )
                )
                ELSE 0
              END AS containment_rate,
              (COALESCE(m.total_contained_evenings, 0)::numeric * $2::numeric) AS encounters_prevented
       FROM suburb_demographics sd
       LEFT JOIN monthly m ON m.postcode = TRIM(sd.postcode)
       WHERE sd.state = 'VIC'
         AND TRIM(COALESCE(sd.postcode, '')) <> ''
     ),
     ranked AS (
       SELECT e.*,
              PERCENT_RANK() OVER (ORDER BY e.containment_rate DESC, e.postcode ASC) AS percentile_rank,
              ROW_NUMBER() OVER (ORDER BY e.containment_rate DESC, e.postcode ASC) AS rank_position,
              COUNT(*) OVER ()::int AS total_regions
       FROM enriched e
     )
     SELECT *
     FROM ranked
     ORDER BY rank_position ASC`,
    [monthStart, preyPerDay],
  )

  const allRankedRows = leaderboardResult.rows || []
  const topTen = allRankedRows.slice(0, 10)
  const userRow = allRankedRows.find((row) => String(row.postcode || '').trim() === userPostcode) || null

  const ranking = [...topTen]
  if (userRow && !topTen.some((r) => String(r.postcode || '').trim() === userPostcode)) {
    ranking.push(userRow)
  }

  let rankingRows = ranking.map((row) => {
    const ratePct = Number((toNum(row.containment_rate, 0) * 100).toFixed(2))
    const percentileTop = Math.max(1, Math.round((1 - toNum(row.percentile_rank, 0)) * 100))
    const isUserSuburb = String(row.postcode || '').trim() === userPostcode
    return {
      rank: toInt(row.rank_position),
      suburbName: String(row.suburb_name || row.postcode || '').trim(),
      postcode: String(row.postcode || '').trim(),
      lgaName: String(row.lga_name || '').trim(),
      activeGuardianCount: toInt(row.active_guardian_count, 0),
      hasLowSample: toInt(row.active_guardian_count, 0) < 3,
      containedEvenings: toInt(row.total_contained_evenings, 0),
      containmentRatePct: ratePct,
      encountersPrevented: Number(toNum(row.encounters_prevented, 0).toFixed(2)),
      topPercent: percentileTop,
      isUserSuburb,
    }
  })

  // Keep leaderboard strictly formula based from guardian containment data only.

  // Use the user's own suburb for the community summary card.
  const communityBase = userRow ||
    (
      await db.query(
        `WITH monthly AS (
           SELECT TRIM(u.postcode) AS postcode,
                  COUNT(*) FILTER (WHERE LOWER(TRIM(rl.status)) LIKE '%indoor%')::int AS total_contained_evenings,
                  COUNT(DISTINCT rl.user_id)::int AS active_guardian_count
           FROM roaming_log rl
           JOIN users u ON u.id = rl.user_id
           WHERE rl.log_date::date >= $1::date
             AND TRIM(COALESCE(u.postcode, '')) <> ''
           GROUP BY TRIM(u.postcode)
         )
         SELECT m.postcode,
                sd.suburb_name,
                sd.lga_name,
                m.total_contained_evenings,
                m.active_guardian_count
         FROM monthly m
         LEFT JOIN suburb_demographics sd ON TRIM(sd.postcode) = m.postcode
         WHERE m.postcode = $2
         LIMIT 1`,
        [monthStart, userPostcode],
      )
    ).rows?.[0]

  const communityContained = toInt(communityBase?.total_contained_evenings, 0)
  const communityActive = toInt(communityBase?.active_guardian_count, 0)
  const communityEncounter = Number((communityContained * preyPerDay).toFixed(2))
  const userEncounter = Number((userContainedMonth * preyPerDay).toFixed(2))

  const summaryResult = await db.query(
    `SELECT COUNT(*)::int AS participating_regions,
            COALESCE(SUM(total_contained_evenings), 0)::int AS total_contained_evenings,
            COALESCE(SUM(active_guardian_count), 0)::int AS active_guardians
     FROM (
       SELECT TRIM(u.postcode) AS postcode,
              COUNT(*) FILTER (WHERE LOWER(TRIM(rl.status)) LIKE '%indoor%')::int AS total_contained_evenings,
              COUNT(DISTINCT rl.user_id)::int AS active_guardian_count
       FROM roaming_log rl
       JOIN users u ON u.id = rl.user_id
       WHERE rl.log_date::date >= $1::date
         AND TRIM(COALESCE(u.postcode, '')) <> ''
       GROUP BY TRIM(u.postcode)
     ) s`,
    [monthStart],
  )

  const summary = summaryResult.rows?.[0] || {}

  // Return one payload for all scoreboard sections.
  return {
    scope: {
      label: 'Victoria',
      source: 'roaming_log + users + suburb_demographics + cats_behaviour_stats',
    },
    summary: {
      participatingRegions: toInt(summary.participating_regions, 0),
      totalContainedEvenings: toInt(summary.total_contained_evenings, 0),
      activeGuardians: toInt(summary.active_guardians, 0),
      preyRatePerDay: preyPerDay,
    },
    personal: {
      userId: toInt(resolvedUser.id),
      userName: String(resolvedUser.name || '').trim() || 'Cat owner',
      catName: String(resolvedUser.cat_name || '').trim() || 'Cat',
      currentStreak,
      bestStreak,
      containedThisMonth: userContainedMonth,
      roamingThisMonth: userRoamingMonth,
      encountersPrevented: Number((currentStreak * preyPerDay).toFixed(2)),
      milestones: getMilestones(currentStreak),
      streakBroken,
      hasAnyIndoorLog: indoorDays.length > 0,
      lastIndoorLogDate: indoorDays[0] || null,
    },
    guardian: {
      suburbName: String(communityBase?.suburb_name || suburbMeta.suburb_name || userPostcode).trim(),
      postcode: userPostcode,
      lgaName: String(communityBase?.lga_name || suburbMeta.lga_name || '').trim(),
      totalContainedEvenings: communityContained,
      activeGuardianCount: communityActive,
      encountersPrevented: communityEncounter,
      userContributionEvenings: userContainedMonth,
      userContributionEncounters: userEncounter,
      isFirstGuardian: communityActive <= 1,
      userTopPercent: userRow ? Math.max(1, Math.round((1 - toNum(userRow.percentile_rank, 0)) * 100)) : null,
      userRankPosition: userRow ? toInt(userRow.rank_position) : null,
      rankedRegionCount: userRow ? toInt(userRow.total_regions) : toInt(allRankedRows.length, 0),
    },
    ranking: rankingRows,
    distribution: rankingRows,
    criteria: [
      { label: 'Containment Rate', weightPct: 100 },
    ],
    leaderboardMeta: {
      threshold: 3,
      monthStart,
      updatedNote: 'Rankings updated every Monday morning.',
    },
    updatedAt: new Date().toISOString(),
  }
}

scoreboardDataHandler = async function(req, res) {
  try {
    const userId = req?.query?.userId ? toInt(req.query.userId, null) : null
    const postcode = req?.query?.postcode ? String(req.query.postcode).trim() : null
    const data = await getScoreboardData({ userId, postcode })
    res.status(200).json(data)
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Unable to load Cat Scoreboard.' })
  }
}

}

let scoreboardLeaderboardHandler
{
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

const toInt = (v, fallback = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n) : fallback
}

const toNum = (v, fallback = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

// Reuse one PostgreSQL connection pool.
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

const monthStartUtc = () => {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10)
}

// Resolve the user row used to highlight "you live here".
async function loadResolvedUser(db, userId, postcode) {
  if (userId || postcode) {
    const r = await db.query(
      `SELECT id, TRIM(postcode) AS postcode
       FROM users
       WHERE ($1::int IS NULL OR id = $1::int)
         AND ($2::text IS NULL OR TRIM(postcode) = TRIM($2::text))
       ORDER BY id ASC
       LIMIT 1`,
      [userId || null, postcode || null],
    )
    return r.rows?.[0] || null
  }

  const r = await db.query(
    `SELECT id, TRIM(postcode) AS postcode
     FROM users
     ORDER BY id ASC
     LIMIT 1`,
  )
  return r.rows?.[0] || null
}

// Build the community leaderboard from database rows.
async function getLeaderboardData({ userId = null, postcode = null } = {}) {
  const db = getPool()
  const monthStart = monthStartUtc()
  const user = await loadResolvedUser(db, userId, postcode)
  const userPostcode = String(postcode || user?.postcode || '').trim()

  const hasCommunityTable = await db.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'containment_community_stats'
     ) AS ok`,
  )

  let rows = []

  if (hasCommunityTable.rows?.[0]?.ok) {
    // Prefer precomputed community stats when the table exists.
    const r = await db.query(
      `WITH base AS (
         SELECT TRIM(sd.postcode) AS postcode,
                COALESCE(cs.total_contained_evenings, 0)::int AS total_contained_evenings,
                COALESCE(cs.active_guardian_count, 0)::int AS active_guardian_count,
                COALESCE(cs.encounters_prevented, 0)::numeric AS encounters_prevented,
                CASE WHEN COALESCE(cs.active_guardian_count, 0) > 0
                  THEN (
                    COALESCE(cs.total_contained_evenings, 0)::numeric /
                    (
                      COALESCE(cs.active_guardian_count, 0)::numeric *
                      EXTRACT(DAY FROM (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month - 1 day'))::numeric
                    )
                  )
                  ELSE 0
                END AS containment_rate,
                sd.suburb_name,
                sd.lga_name
         FROM suburb_demographics sd
         LEFT JOIN containment_community_stats cs
           ON TRIM(cs.postcode) = TRIM(sd.postcode)
          AND cs.month_start = $1::date
         WHERE sd.state = 'VIC'
           AND TRIM(COALESCE(sd.postcode, '')) <> ''
       ),
       ranked AS (
         SELECT b.*,
                PERCENT_RANK() OVER (ORDER BY b.containment_rate DESC, b.postcode ASC) AS percentile_rank,
                ROW_NUMBER() OVER (ORDER BY b.containment_rate DESC, b.postcode ASC) AS rank_position,
                COUNT(*) OVER ()::int AS total_regions
         FROM base b
       )
       SELECT *
       FROM ranked
       ORDER BY rank_position ASC`,
      [monthStart],
    )
    rows = r.rows || []
  } else {
    // Fall back to live roaming_log aggregation.
    const r = await db.query(
      `WITH monthly AS (
         SELECT TRIM(u.postcode) AS postcode,
                COUNT(*) FILTER (WHERE LOWER(TRIM(rl.status)) LIKE '%indoor%')::int AS total_contained_evenings,
                COUNT(DISTINCT rl.user_id)::int AS active_guardian_count
         FROM roaming_log rl
         JOIN users u ON u.id = rl.user_id
         WHERE rl.log_date::date >= $1::date
           AND TRIM(COALESCE(u.postcode, '')) <> ''
         GROUP BY TRIM(u.postcode)
       ),
       base AS (
         SELECT TRIM(sd.postcode) AS postcode,
                COALESCE(m.total_contained_evenings, 0)::int AS total_contained_evenings,
                COALESCE(m.active_guardian_count, 0)::int AS active_guardian_count,
                (COALESCE(m.total_contained_evenings, 0)::numeric * 0.0667::numeric) AS encounters_prevented,
                CASE WHEN COALESCE(m.active_guardian_count, 0) > 0
                  THEN (
                    COALESCE(m.total_contained_evenings, 0)::numeric /
                    (
                      COALESCE(m.active_guardian_count, 0)::numeric *
                      EXTRACT(DAY FROM (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month - 1 day'))::numeric
                    )
                  )
                  ELSE 0
                END AS containment_rate,
                sd.suburb_name,
                sd.lga_name
         FROM suburb_demographics sd
         LEFT JOIN monthly m ON m.postcode = TRIM(sd.postcode)
         WHERE sd.state = 'VIC'
           AND TRIM(COALESCE(sd.postcode, '')) <> ''
       ),
       ranked AS (
         SELECT b.*,
                PERCENT_RANK() OVER (ORDER BY b.containment_rate DESC, b.postcode ASC) AS percentile_rank,
                ROW_NUMBER() OVER (ORDER BY b.containment_rate DESC, b.postcode ASC) AS rank_position,
                COUNT(*) OVER ()::int AS total_regions
         FROM base b
       )
       SELECT * FROM ranked ORDER BY rank_position ASC`,
      [monthStart],
    )
    rows = r.rows || []
  }

  // Normalize ranking rows for the frontend.
  const normalized = rows.map((row) => {
    const topPercent = Math.max(1, Math.round((1 - toNum(row.percentile_rank, 0)) * 100))
    const code = String(row.postcode || '').trim()
    return {
      rank: toInt(row.rank_position, 0),
      suburbName: String(row.suburb_name || code).trim(),
      postcode: code,
      containmentRatePct: Number((toNum(row.containment_rate, 0) * 100).toFixed(2)),
      encountersPrevented: Number(toNum(row.encounters_prevented, 0).toFixed(2)),
      topPercent,
      totalRegions: toInt(row.total_regions, 0),
      isUserSuburb: code === userPostcode,
    }
  })

  const topTen = normalized.slice(0, 10)
  const userRow = normalized.find((row) => row.postcode === userPostcode) || null

  return {
    monthStart,
    updatedNote: 'Rankings updated every Monday morning.',
    topTen,
    userRow,
    totalRows: normalized.length,
    percentileLabel: userRow
      ? `${userRow.suburbName} is in the top ${userRow.topPercent}% most active wildlife-protecting communities in Victoria this month.`
      : null,
  }
}

// API entry point for the community leaderboard.
scoreboardLeaderboardHandler = async function(req, res) {
  try {
    const userId = req?.query?.userId ? toInt(req.query.userId, null) : null
    const postcode = req?.query?.postcode ? String(req.query.postcode).trim() : null
    const payload = await getLeaderboardData({ userId, postcode })
    res.status(200).json(payload)
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Unable to load guardian leaderboard.' })
  }
}

}

let scoreboardRoamingLogHandler
{
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

const toInt = (v, fallback = null) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n) : fallback
}

// Reuse one PostgreSQL connection pool.
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

// Insert today's indoor log for the signed-in user.
scoreboardRoamingLogHandler = async function(req, res) {
  try {
    if ((req.method || 'POST').toUpperCase() !== 'POST') {
      return res.status(405).json({ error: 'Only POST is supported.' })
    }

    const userId = toInt(req?.body?.userId ?? req?.query?.userId, null)
    if (!userId) {
      return res.status(400).json({ error: 'A valid userId is required.' })
    }

    const db = getPool()
    // Confirm the user exists before writing a log row.
    const userCheck = await db.query('SELECT id FROM users WHERE id = $1 LIMIT 1', [userId])
    if (!userCheck.rows?.length) {
      return res.status(404).json({ error: `User ${userId} was not found.` })
    }

    // Avoid duplicate indoor logs for the same user and date.
    await db.query(
      `INSERT INTO roaming_log (user_id, log_date, status, source, created_at)
       SELECT $1, CURRENT_DATE, 'indoors', 'catwatch_log_now', NOW()
       WHERE NOT EXISTS (
         SELECT 1
         FROM roaming_log
         WHERE user_id = $1
           AND log_date = CURRENT_DATE
           AND LOWER(TRIM(status)) LIKE '%indoor%'
       )`,
      [userId],
    )

    return res.status(200).json({ ok: true })
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Unable to write roaming_log entry.' })
  }
}

}

let scoreboardAuthHandler
{
/* eslint-env node */
/* global process, Buffer */

const DEFAULT_DB_CONFIG = {
  host: '130.162.194.202',
  port: 5432,
  user: 'postgres',
  password: 'bbd4ba1eb45b2b5308e993832030699301d9dc49b2b935d747759502bc8e055a',
  database: 'echoes_of_earth',
}

const PASSWORD_ITERATIONS = 100000
const PASSWORD_KEY_LENGTH = 64
const PASSWORD_DIGEST = 'sha256'

let pool = null

// Clean form text while preserving email casing exactly as entered.
const cleanText = (value) => String(value || '').trim()
const cleanEmail = (value) => cleanText(value)

// Read JSON bodies from Vite middleware or serverless requests.
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

const getPool = () => {
  if (pool) return pool

  // Connect to PostgreSQL using deployment env vars or the project database.
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
        port: Number(process.env.PGPORT || DEFAULT_DB_CONFIG.port),
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

const hashPassword = (password, salt = randomBytes(16).toString('hex')) => {
  // Hash passwords before saving them.
  const hash = pbkdf2Sync(
    String(password),
    salt,
    PASSWORD_ITERATIONS,
    PASSWORD_KEY_LENGTH,
    PASSWORD_DIGEST,
  ).toString('hex')

  return { salt, hash }
}

const verifyPassword = (password, salt, expectedHash) => {
  const { hash } = hashPassword(password, salt)
  const actual = Buffer.from(hash, 'hex')
  const expected = Buffer.from(String(expectedHash || ''), 'hex')
  if (actual.length !== expected.length) return false

  // Compare password hashes safely.
  return timingSafeEqual(actual, expected)
}

// Create the credential table linked to the original users table.
const ensureAuthTable = async (db) => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS catwatch_auth_accounts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email VARCHAR(200) NOT NULL UNIQUE,
      password_hash VARCHAR(128) NOT NULL,
      password_salt VARCHAR(64) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `)
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_catwatch_auth_accounts_user_id
    ON catwatch_auth_accounts (user_id)
  `)
}

const findVictorianPostcode = async (db, postcode) => {
  // Check the postcode exists in suburb_demographics.
  const result = await db.query(
    `SELECT TRIM(postcode) AS postcode, suburb_name
     FROM suburb_demographics
     WHERE state = 'VIC'
       AND TRIM(postcode) = $1
     ORDER BY population DESC NULLS LAST, suburb_name ASC
     LIMIT 1`,
    [postcode],
  )

  return result.rows?.[0] || null
}

const normalizeUserRow = (row) => ({
  // Return only safe profile fields to the frontend.
  id: Number(row.id),
  name: cleanText(row.name),
  email: cleanText(row.email),
  postcode: cleanText(row.postcode),
  suburbName: cleanText(row.suburb_name),
})

const findUserByEmail = async (db, email) => {
  const result = await db.query(
    `SELECT id, name, email, TRIM(postcode) AS postcode
     FROM users
     WHERE TRIM(email) = $1
     ORDER BY id ASC
     LIMIT 1`,
    [email],
  )

  return result.rows?.[0] || null
}

const createUserProfile = async (db, { name, email, postcode }) => {
  const existing = await findUserByEmail(db, email)
  if (existing) return existing

  // Save the user's profile in the original users table.
  const result = await db.query(
    `INSERT INTO users (email, name, postcode, created_at)
     VALUES ($1, $2, $3, NOW())
     RETURNING id, name, email, TRIM(postcode) AS postcode`,
    [email, name, postcode],
  )

  return result.rows[0]
}

const attachSuburbName = async (db, user) => {
  const postcode = cleanText(user?.postcode)
  if (!postcode) return { ...user, suburb_name: '' }
  const suburb = await findVictorianPostcode(db, postcode)
  return {
    ...user,
    suburb_name: suburb?.suburb_name || '',
  }
}

const register = async (db, body) => {
  // Validate registration details and create the database account.
  const name = cleanText(body.name)
  const email = cleanEmail(body.email)
  const password = cleanText(body.password)
  const postcode = cleanText(body.postcode)

  if (!name || !email || !password || !postcode) {
    return { status: 400, payload: { error: 'Name, email, password, and postcode are required.' } }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { status: 400, payload: { error: 'Please enter a valid email address.' } }
  }
  if (!/^\d{4}$/.test(postcode)) {
    return { status: 400, payload: { error: 'Please enter a valid 4-digit Victorian postcode.' } }
  }

  const postcodeRow = await findVictorianPostcode(db, postcode)
  if (!postcodeRow) {
    return { status: 400, payload: { error: 'This postcode was not found in the Victorian suburb database.' } }
  }

  // Prevent duplicate email registrations.
  const existingAuth = await db.query(
    `SELECT id
     FROM catwatch_auth_accounts
     WHERE email = $1
     LIMIT 1`,
    [email],
  )
  if (existingAuth.rows?.length) {
    return { status: 409, payload: { error: 'This email is already registered. Please sign in.' } }
  }

  const user = await createUserProfile(db, { name, email, postcode })
  const { hash, salt } = hashPassword(password)

  // Store password credentials separately from the profile row.
  await db.query(
    `INSERT INTO catwatch_auth_accounts (user_id, email, password_hash, password_salt, updated_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [user.id, email, hash, salt],
  )

  const enrichedUser = await attachSuburbName(db, user)
  return {
    status: 201,
    payload: {
      authenticated: true,
      user: normalizeUserRow(enrichedUser),
    },
  }
}

const login = async (db, body) => {
  // Verify login credentials against the database.
  const email = cleanEmail(body.email || body.username)
  const password = cleanText(body.password)

  if (!email || !password) {
    return { status: 400, payload: { error: 'Email and password are required.' } }
  }

  const result = await db.query(
    // Join credentials to profile data for the returned session.
    `SELECT a.password_hash,
            a.password_salt,
            u.id,
            u.name,
            u.email,
            TRIM(u.postcode) AS postcode
     FROM catwatch_auth_accounts a
     JOIN users u ON u.id = a.user_id
     WHERE a.email = $1
     LIMIT 1`,
    [email],
  )

  const row = result.rows?.[0]
  if (!row || !verifyPassword(password, row.password_salt, row.password_hash)) {
    return { status: 401, payload: { error: 'Email or password is incorrect.' } }
  }

  const enrichedUser = await attachSuburbName(db, row)
  return {
    status: 200,
    payload: {
      authenticated: true,
      user: normalizeUserRow(enrichedUser),
    },
  }
}

scoreboardAuthHandler = async function(req, res) {
  try {
    // Route login and register actions through one auth endpoint.
    if ((req.method || 'POST').toUpperCase() !== 'POST') {
      res.status(405).json({ error: 'Only POST is supported.' })
      return
    }

    const body = await readJsonBody(req)
    const action = cleanText(body.action || 'login').toLowerCase()
    const db = getPool()
    await ensureAuthTable(db)

    const result = action === 'register' ? await register(db, body) : await login(db, body)
    res.status(result.status).json(result.payload)
  } catch (error) {
    console.error('Scoreboard auth API failed:', {
      message: error?.message,
      code: error?.code,
      detail: error?.detail,
    })
    res.status(500).json({
      error: error?.message || 'Authentication failed.',
      code: error?.code || null,
    })
  }
}

}

export default async function scoreboardHandler(req, res) {
  const action = String(req.query?.action || req.featureAction || 'data')
  if (action === 'leaderboard') return scoreboardLeaderboardHandler(req, res)
  if (action === 'log') return scoreboardRoamingLogHandler(req, res)
  if (action === 'auth') return scoreboardAuthHandler(req, res)
  return scoreboardDataHandler(req, res)
}
