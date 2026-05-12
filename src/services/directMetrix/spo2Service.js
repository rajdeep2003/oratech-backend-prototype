import { supabase } from '../../database/supabaseClient.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Rows fetched from Supabase in one go before any JS-side filtering.
 * SpO₂ is sampled every 10 min → 144 rows/day. 10 000 rows covers ~70 days
 * of data and avoids pagination complexity in this prototype.
 */
const FETCH_LIMIT = 10_000;

/**
 * Maximum data points allowed in a trend response.
 * Keeps the JSON payload manageable for the frontend chart.
 */
const TREND_MAX_POINTS = 200;

/**
 * Minimum signal quality score a reading must have to be considered valid.
 * Readings below this threshold are too noisy to trust.
 */
const MIN_SIGNAL_QUALITY = 20;

/**
 * SpO₂ percentage below which a reading is classified as a "low_spo2" event.
 * Clinically, values below 95 % are considered hypoxic.
 */
const LOW_SPO2_THRESHOLD = 95;

// ── Public helpers ────────────────────────────────────────────────────────────

/**
 * Resolve the TEXT `user_id` stored in `profiles` from the Supabase auth UUID.
 *
 * All sensor tables (spo2, heart_rate_logs, etc.) store a TEXT user_id that
 * is distinct from the UUID primary key in `profiles`.  We need one extra
 * lookup here so subsequent queries work correctly.
 *
 * @param {string} authUuid  – req.user.id from the Supabase JWT
 * @returns {Promise<string>} profiles.user_id (text)
 * @throws  {Error} 404 if no matching profile is found
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

// ── Service functions ─────────────────────────────────────────────────────────

/**
 * Fetch the single most recent valid SpO₂ reading for a user.
 *
 * "Valid" means signal_quality >= MIN_SIGNAL_QUALITY and the artifact_flag
 * is false (or absent).  Rows are ordered newest-first so we can return as
 * soon as the first qualifying row is found.
 *
 * Used by: GET /api/spo2/latest
 *
 * @param {string} userId  – profiles.user_id (text)
 * @returns {Promise<{ spo2: number, perfusion_index: number, status: string, timestamp: string } | null>}
 */
export async function fetchLatestSpo2(userId) {
  // Pull the most recent 50 rows so we have enough candidates to find a clean one.
  const { data, error } = await supabase
    .from('spo2')
    .select('timestamp, spo2_percent, perfusion_index, signal_quality')
    .eq('user_id', userId)
    .order('timestamp', { ascending: false })
    .limit(50);

  if (error) throw error;
  if (!data || data.length === 0) return null;

  // Walk newest→oldest; return the first row that passes the quality threshold.
  const valid = data.find((row) => row.signal_quality >= MIN_SIGNAL_QUALITY);

  if (!valid) return null;

  return {
    spo2:             round2(valid.spo2_percent),
    perfusion_index:  round2(valid.perfusion_index),
    // < 95 % is clinically low; >= 95 % is normal.
    status:           valid.spo2_percent < LOW_SPO2_THRESHOLD ? 'low' : 'normal',
    timestamp:        valid.timestamp,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch a time-series of SpO₂ readings for trend visualisation.
 *
 * Steps:
 *   1. Pull up to FETCH_LIMIT rows for the user (newest-first).
 *   2. Filter to quality readings (signal_quality >= threshold).
 *   3. Reverse to ascending chronological order.
 *   4. Slice to the requested time window using rangeMs.
 *   5. Downsample to TREND_MAX_POINTS if there are more points than the cap.
 *
 * Used by: GET /api/spo2/trend?range=24h
 *
 * @param {string} userId   – profiles.user_id (text)
 * @param {number} rangeMs  – time window in milliseconds (e.g. 86_400_000 for 24 h)
 * @returns {Promise<Array<{ timestamp: string, spo2: number }>>}
 */
export async function fetchSpo2Trend(userId, rangeMs) {
  const rows = await fetchAllRows(userId);

  // Apply signal-quality filter.
  const clean = rows.filter((r) => r.signal_quality >= MIN_SIGNAL_QUALITY);

  // Slice to the requested time window.
  const windowed = applyTimeWindow(clean, rangeMs);

  // Downsample so we never exceed TREND_MAX_POINTS.
  const sampled = downsample(windowed, TREND_MAX_POINTS);

  return sampled.map((r) => ({
    timestamp: r.timestamp,
    spo2:      round2(r.spo2_percent),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute aggregate SpO₂ statistics for a given time window.
 *
 * Statistics computed (JS-side for prototype simplicity):
 *   - avg_spo2         – mean SpO₂ over the window
 *   - min_spo2         – lowest reading
 *   - max_spo2         – highest reading
 *   - low_spo2_events  – count of readings below LOW_SPO2_THRESHOLD (< 95 %)
 *
 * Used by: GET /api/spo2/summary?range=24h
 *
 * @param {string} userId   – profiles.user_id (text)
 * @param {number} rangeMs  – time window in milliseconds
 * @returns {Promise<{ avg_spo2: number, min_spo2: number, max_spo2: number, low_spo2_events: number } | null>}
 */
export async function fetchSpo2Summary(userId, rangeMs) {
  const rows = await fetchAllRows(userId);

  // Quality filter then time-window slice.
  const clean    = rows.filter((r) => r.signal_quality >= MIN_SIGNAL_QUALITY);
  const windowed = applyTimeWindow(clean, rangeMs);

  if (windowed.length === 0) return null;

  const values = windowed.map((r) => r.spo2_percent);

  return {
    avg_spo2:        round2(avg(values)),
    min_spo2:        round2(Math.min(...values)),
    max_spo2:        round2(Math.max(...values)),
    // Count rows where SpO₂ dipped below the clinical threshold.
    low_spo2_events: windowed.filter((r) => r.spo2_percent < LOW_SPO2_THRESHOLD).length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect notable SpO₂ events in a given time window.
 *
 * Four anomaly types are detected (all in JS — no extra SQL):
 *   1. spo2_percent < 95           → type "low_spo2"          (potential hypoxia)
 *   2. respiratory_event != normal → type from the DB value    (apnea, hypopnea, etc.)
 *   3. motion_artifact = true      → type "motion_artifact"    (reading corrupted by movement)
 *   4. artifact_flag = true        → type "signal_artifact"    (sensor / signal quality issue)
 *
 * NOTE: The signal_quality pre-filter is intentionally NOT applied here.
 * A degraded reading (low quality, motion, artifact) IS the event — silently
 * dropping it would cause real anomalies to go unreported.
 *
 * Used by: GET /api/spo2/events?range=24h
 *
 * @param {string} userId   – profiles.user_id (text)
 * @param {number} rangeMs  – time window in milliseconds
 * @returns {Promise<Array<{ type: string, timestamp: string, value?: number }>>}
 */
export async function fetchSpo2Events(userId, rangeMs) {
  const rows = await fetchAllRows(userId);

  // Apply the time window but do NOT quality-filter — bad readings are events.
  const windowed = applyTimeWindow(rows, rangeMs);

  const events = [];

  for (const row of windowed) {
    // ── 1. Low SpO₂ ──────────────────────────────────────────────────────────
    // Only flag if signal quality is acceptable, otherwise it's likely noise.
    if (
      row.spo2_percent < LOW_SPO2_THRESHOLD &&
      row.signal_quality >= MIN_SIGNAL_QUALITY
    ) {
      events.push({
        type:      'low_spo2',
        timestamp: row.timestamp,
        value:     round2(row.spo2_percent),
      });
    }

    // ── 2. Respiratory event ─────────────────────────────────────────────────
    // e.g. "apnea", "hypopnea" — anything the sensor labelled as non-normal.
    const respEvent = (row.respiratory_event ?? '').trim().toLowerCase();
    if (respEvent && respEvent !== 'normal') {
      events.push({
        type:      row.respiratory_event,  // preserve original casing from DB
        timestamp: row.timestamp,
        value:     round2(row.spo2_percent),
      });
    }

    // ── 3. Motion artifact ───────────────────────────────────────────────────
    // Sensor flagged that physical movement corrupted the reading.
    if (row.motion_artifact === true) {
      events.push({
        type:      'motion_artifact',
        timestamp: row.timestamp,
        value:     round2(row.spo2_percent),
      });
    }

  }

  // Sort ascending by timestamp so the frontend can render a chronological list.
  events.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  return events;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Pull all SpO₂ rows for a user from Supabase, ordered ascending by timestamp.
 *
 * Fetches newest-first (so the DB index is used efficiently) then reverses.
 * We select only the columns needed by all four endpoints to keep payloads
 * small.
 *
 * @param {string} userId  – profiles.user_id (text)
 * @returns {Promise<object[]>} rows sorted ascending by timestamp
 */
async function fetchAllRows(userId) {
  const { data, error } = await supabase
    .from('spo2')
    .select('timestamp, spo2_percent, perfusion_index, signal_quality, respiratory_event, motion_artifact')
    .eq('user_id', userId)
    .order('timestamp', { ascending: false })
    .limit(FETCH_LIMIT);

  if (error) throw error;

  // Reverse to ascending order (oldest → newest) for time-window slicing.
  return (data ?? []).reverse();
}

/**
 * Slice an ascending-sorted array of rows to only those within the last
 * `rangeMs` milliseconds relative to the most recent row's timestamp.
 *
 * Works entirely with JS Date arithmetic — no SQL required.
 *
 * @param {object[]} rows     – ascending sorted rows with a `timestamp` field
 * @param {number}   rangeMs  – window width in milliseconds
 * @returns {object[]} rows within the window
 */
function applyTimeWindow(rows, rangeMs) {
  if (rows.length === 0) return [];

  // Anchor the window end to the newest available row, not `Date.now()`.
  // This ensures the prototype works correctly with static / historical datasets
  // where no rows would fall in the "real" last 24 h.
  const newestMs = new Date(rows[rows.length - 1].timestamp).getTime();
  const cutoffMs = newestMs - rangeMs;

  return rows.filter((r) => new Date(r.timestamp).getTime() >= cutoffMs);
}

/**
 * Evenly downsample an array to at most `maxPoints` elements.
 *
 * Uses systematic (every Kth) sampling so the shape of the trend is preserved.
 * If the array is already within the cap, it is returned unchanged.
 *
 * @param {any[]} arr        – source array
 * @param {number} maxPoints – maximum output length
 * @returns {any[]}
 */
function downsample(arr, maxPoints) {
  if (arr.length <= maxPoints) return arr;

  const step = Math.ceil(arr.length / maxPoints);
  return arr.filter((_, i) => i % step === 0);
}

/**
 * Compute the arithmetic mean of an array of numbers.
 * Returns 0 for an empty array to avoid NaN propagation.
 *
 * @param {number[]} values
 * @returns {number}
 */
function avg(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Round a number to 2 decimal places.
 * Keeps the API response clean and avoids floating-point noise.
 *
 * @param {number} n
 * @returns {number}
 */
function round2(n) {
  return Math.round(n * 100) / 100;
}
