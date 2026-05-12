import { supabase } from '../../database/supabaseClient.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Minimum beat_quality_score to include a row in any computation. */
const MIN_QUALITY_SCORE = 80;

/** Maximum data points returned for the /window endpoint. */
const WINDOW_MAX_POINTS = 300;

/** Maximum data points returned for the /trend endpoint. */
const TREND_MAX_POINTS = 300;

// ── Public helpers ────────────────────────────────────────────────────────────

/**
 * Resolve a profiles.user_id (TEXT) from the Supabase auth UUID.
 *
 * The `ibi` table references profiles.user_id (TEXT), while JWT gives us
 * profiles.id (UUID), so we need this one lightweight lookup first.
 *
 * @param {string} authUuid  – req.user.id from the Supabase JWT
 * @returns {Promise<string>} profiles.user_id text value
 * @throws  {Error} statusCode 404 if the profile row is missing
 */
export async function resolveUserId(authUuid) {
  const { data, error } = await supabase
    .from('profiles')
    .select('user_id')
    .eq('id', authUuid)
    .single();

  if (error || !data) {
    throw Object.assign(new Error('Profile not found'), { statusCode: 404 });
  }

  return data.user_id;
}

// ── Service: latest metrics ───────────────────────────────────────────────────

/**
 * Fetch the last ~50 IBI rows and compute aggregated scalar metrics.
 *
 * Filters applied:
 *   – beat_quality_score >= MIN_QUALITY_SCORE (80)
 *
 * Computed metrics:
 *   – hr_bpm        : average of running_hr_bpm across fetched rows
 *   – rmssd         : average of rmssd_local_ms
 *   – ibi_ms        : average of ibi_ms
 *   – activity_state: from the most recent row
 *   – timestamp     : timestamp_ms from the most recent row
 *
 * @param {string} userId  – profiles.user_id (text)
 * @returns {Promise<object>} aggregated metric object
 */
export async function fetchLatestMetrics(userId) {
  // Fetch newest 50 rows (DESC) so we grab the latest window quickly.
  const { data, error } = await supabase
    .from('ibi')
    .select(
      'timestamp_ms, ibi_ms, rmssd_local_ms, running_hr_bpm, beat_quality_score, activity_state'
    )
    .eq('user_id', userId)
    .gte('beat_quality_score', MIN_QUALITY_SCORE)
    .order('timestamp_ms', { ascending: false })
    .limit(50);

  if (error) throw error;

  const rows = data ?? [];

  // Guard: handle empty dataset without divide-by-zero
  if (rows.length === 0) {
    return {
      hr_bpm: null,
      rmssd: null,
      ibi_ms: null,
      activity_state: null,
      timestamp: null,
    };
  }

  const avg = (key) => rows.reduce((sum, r) => sum + (r[key] ?? 0), 0) / rows.length;

  // rows[0] is the most recent because we fetched DESC
  return {
    hr_bpm:         +avg('running_hr_bpm').toFixed(2),
    rmssd:          +avg('rmssd_local_ms').toFixed(2),
    ibi_ms:         +avg('ibi_ms').toFixed(2),
    activity_state: rows[0].activity_state ?? null,
    timestamp:      rows[0].timestamp_ms  ?? null,
  };
}

// ── Service: sliding time window ──────────────────────────────────────────────

// Approximate beats-per-second for a resting heart rate (1 beat ≈ 800 ms).
// Used to convert a requested duration into an equivalent row count so that
// mock static datasets (which have fixed historical timestamps) still return
// meaningful data rather than an empty array.
const BEATS_PER_MS = 1 / 800;

/**
 * Fetch IBI rows equivalent to the last N minutes and return a downsampled
 * series suitable for a real-time chart.
 *
 * ── Mock-data note ────────────────────────────────────────────────────────────
 * Static datasets have fixed timestamps so filtering by `Date.now() - duration`
 * always returns zero rows. Instead we convert the requested duration into an
 * approximate row count (beats-per-ms × durationMs) and slice the newest rows
 * from the full dataset. The duration param still controls the visible window
 * width — just in row-count space rather than wall-clock space.
 *
 * Downsampling: take every Kth row so that ≤ WINDOW_MAX_POINTS are returned.
 *
 * @param {string} userId       – profiles.user_id (text)
 * @param {number} durationMs   – window size in milliseconds
 * @returns {Promise<Array<{
 *   timestamp:        number,
 *   hr:               number,
 *   ibi_ms:           number,
 *   rmssd:            number,
 *   successive_diff:  number,
 *   beat_quality:     number,
 *   activity_state:   string|null
 * }>>}
 */
export async function fetchWindowData(userId, durationMs) {
  // Convert duration → approximate row count (min 20, max 5000)
  const rowLimit = Math.min(5000, Math.max(20, Math.round(BEATS_PER_MS * durationMs)));

  // Fetch newest `rowLimit` clean rows (DESC), then reverse to ascending order
  const { data, error } = await supabase
    .from('ibi')
    .select(
      'timestamp_ms, running_hr_bpm, ibi_ms, rmssd_local_ms, successive_diff_ms, beat_quality_score, activity_state'
    )
    .eq('user_id', userId)
    .gte('beat_quality_score', MIN_QUALITY_SCORE)
    .order('timestamp_ms', { ascending: false })
    .limit(rowLimit);

  if (error) throw error;

  const rows = (data ?? []).reverse(); // back to chronological order

  if (rows.length === 0) return [];

  // Downsample: keep every Kth row so output ≤ WINDOW_MAX_POINTS
  const step = Math.ceil(rows.length / WINDOW_MAX_POINTS);

  return rows
    .filter((_, idx) => idx % step === 0)
    .map((r) => ({
      timestamp:       r.timestamp_ms,
      hr:              +(r.running_hr_bpm    ?? 0).toFixed(2),
      ibi_ms:          +(r.ibi_ms            ?? 0).toFixed(2),
      rmssd:           +(r.rmssd_local_ms    ?? 0).toFixed(2),
      successive_diff: +(r.successive_diff_ms ?? 0).toFixed(2),
      beat_quality:    +(r.beat_quality_score ?? 0).toFixed(1),
      activity_state:  r.activity_state ?? null,
    }));
}

// ── Service: summary statistics ───────────────────────────────────────────────

/**
 * Compute summary statistics (avg / min / max) for RMSSD and HR
 * across the requested time range.
 *
 * Filters applied: beat_quality_score >= 80.
 * All arithmetic is done in JS (no SQL aggregation needed for a prototype).
 *
 * ── Mock-data note ────────────────────────────────────────────────────────────
 * Static datasets have fixed timestamps so we convert rangeMs → row count
 * and slice the newest N rows instead of filtering by wall-clock time.
 *
 * @param {string} userId     – profiles.user_id (text)
 * @param {number} rangeMs    – time range in milliseconds (e.g. 3600_000 for 1h)
 * @returns {Promise<object>} summary object with avg/min/max for rmssd and hr
 */
export async function fetchSummary(userId, rangeMs) {
  // Convert range → approximate row count (min 20, max 10000)
  const rowLimit = Math.min(10000, Math.max(20, Math.round(BEATS_PER_MS * rangeMs)));

  const { data, error } = await supabase
    .from('ibi')
    .select('timestamp_ms, rmssd_local_ms, running_hr_bpm, beat_quality_score')
    .eq('user_id', userId)
    .gte('beat_quality_score', MIN_QUALITY_SCORE)
    .order('timestamp_ms', { ascending: false })
    .limit(rowLimit);

  if (error) throw error;

  const rows = data ?? [];

  // Guard: return nulls if no usable data exists
  if (rows.length === 0) {
    return {
      rmssd_avg: null, rmssd_min: null, rmssd_max: null,
      hr_avg:    null, hr_min:    null, hr_max:    null,
    };
  }

  const rmssdVals = rows.map((r) => r.rmssd_local_ms ?? 0);
  const hrVals    = rows.map((r) => r.running_hr_bpm  ?? 0);

  const mathAvg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;

  return {
    rmssd_avg: +mathAvg(rmssdVals).toFixed(2),
    rmssd_min: +Math.min(...rmssdVals).toFixed(2),
    rmssd_max: +Math.max(...rmssdVals).toFixed(2),
    hr_avg:    +mathAvg(hrVals).toFixed(2),
    hr_min:    +Math.min(...hrVals).toFixed(2),
    hr_max:    +Math.max(...hrVals).toFixed(2),
  };
}

// ── Service: bucketed trend ───────────────────────────────────────────────────

/**
 * Aggregate IBI data into fixed-size time buckets for trend visualization.
 *
 * Bucket sizes (chosen automatically by requested range):
 *   – range ≤ 1h  → 1-minute buckets  (~60 buckets)
 *   – range  > 1h → 5-minute buckets  (~288 buckets for 24h)
 *
 * Rows are bucketed in JS using Math.floor on timestamp_ms.
 * Empty buckets are omitted (sparse series is fine for charts).
 * Output is capped at TREND_MAX_POINTS.
 *
 * ── Mock-data note ────────────────────────────────────────────────────────────
 * Static datasets have fixed timestamps so we convert rangeMs → row count
 * and fetch the newest N clean rows instead of filtering by wall-clock time.
 * Bucketing still uses the actual timestamp_ms values from the dataset, so
 * the chart shape reflects the true structure of the mock data.
 *
 * @param {string} userId     – profiles.user_id (text)
 * @param {number} rangeMs    – time range in milliseconds
 * @returns {Promise<Array<{ timestamp: number, rmssd: number, hr: number }>>}
 */
export async function fetchTrend(userId, rangeMs) {
  // Convert range → approximate row count (min 60, max 20000)
  const rowLimit = Math.min(20000, Math.max(60, Math.round(BEATS_PER_MS * rangeMs)));

  const { data, error } = await supabase
    .from('ibi')
    .select('timestamp_ms, rmssd_local_ms, running_hr_bpm, beat_quality_score')
    .eq('user_id', userId)
    .gte('beat_quality_score', MIN_QUALITY_SCORE)
    .order('timestamp_ms', { ascending: false })
    .limit(rowLimit);

  if (error) throw error;

  const rows = (data ?? []).reverse(); // restore chronological order for bucketing

  if (rows.length === 0) return [];

  // Choose bucket width based on requested range
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const bucketMs = rangeMs <= ONE_HOUR_MS
    ? 60_000        // 1-minute buckets for ≤ 1h ranges
    : 5 * 60_000;   // 5-minute buckets for longer ranges

  // Group rows into buckets using a Map keyed by bucket start time
  const bucketMap = new Map(); // bucketStart (number) → { rmssdSum, hrSum, count }

  for (const row of rows) {
    const bucketStart = Math.floor(row.timestamp_ms / bucketMs) * bucketMs;

    if (!bucketMap.has(bucketStart)) {
      bucketMap.set(bucketStart, { rmssdSum: 0, hrSum: 0, count: 0 });
    }

    const bucket = bucketMap.get(bucketStart);
    bucket.rmssdSum += row.rmssd_local_ms ?? 0;
    bucket.hrSum    += row.running_hr_bpm  ?? 0;
    bucket.count    += 1;
  }

  // Build sorted output array
  const trend = Array.from(bucketMap.entries())
    .sort(([a], [b]) => a - b)          // ascending by bucket start
    .map(([timestamp, { rmssdSum, hrSum, count }]) => ({
      timestamp,
      rmssd: +(rmssdSum / count).toFixed(2),
      hr:    +(hrSum    / count).toFixed(2),
    }));

  // Cap output at TREND_MAX_POINTS (trim oldest if over limit)
  return trend.slice(-TREND_MAX_POINTS);
}
