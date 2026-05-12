import { supabase } from '../../database/supabaseClient.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Rows fetched from Supabase in a single request before JS-side filtering.
 * Skin temperature is sampled every 10 min → 144 rows/day.
 * 10 000 rows covers ~70 days of data without pagination.
 */
const FETCH_LIMIT = 10_000;

/**
 * Maximum data points returned in a trend response.
 * Keeps the JSON payload manageable for the frontend chart.
 */
const TREND_MAX_POINTS = 200;

/**
 * Skin temperature above which a reading is classified as "elevated".
 * Normal skin temperature is roughly 32–35 °C depending on ambient conditions;
 * 37.5 °C correlates with early-stage fever on the skin surface.
 */
const ELEVATED_TEMP_THRESHOLD_C = 37.5;

/**
 * A rise in skin_temp_c larger than this value compared to the previous
 * reading is classified as a "temp_spike" event.
 */
const SPIKE_DELTA_C = 0.5;

// ── Public helpers ────────────────────────────────────────────────────────────

/**
 * Resolve the TEXT `user_id` stored in `profiles` from the Supabase auth UUID.
 *
 * All sensor tables store a TEXT user_id that is distinct from the UUID primary
 * key in `profiles`.  We need one extra lookup so subsequent queries work.
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
 * Fetch the single most recent skin-temperature reading for a user.
 *
 * Used by: GET /api/temperature/latest
 *
 * @param {string} userId  – profiles.user_id (text)
 * @returns {Promise<{
 *   skin_temp: number,
 *   ambient_temp: number,
 *   delta: number,
 *   status: "normal"|"elevated",
 *   timestamp: string
 * } | null>}
 */
export async function fetchLatestTemperature(userId) {
  const { data, error } = await supabase
    .from('skin_temperature')
    .select('timestamp, skin_temp_c, ambient_temp_c, temp_delta_c')
    .eq('user_id', userId)
    .order('timestamp', { ascending: false })
    .limit(1)
    .single();

  if (error || !data) return null;

  return {
    skin_temp:    round2(data.skin_temp_c),
    ambient_temp: round2(data.ambient_temp_c),
    delta:        round2(data.temp_delta_c),
    status:       data.skin_temp_c >= ELEVATED_TEMP_THRESHOLD_C ? 'elevated' : 'normal',
    timestamp:    data.timestamp,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch a time-series of skin temperature readings for trend visualisation.
 *
 * Steps:
 *   1. Pull up to FETCH_LIMIT rows for the user (newest-first).
 *   2. Reverse to ascending chronological order.
 *   3. Slice to the requested time window using rangeMs.
 *   4. Downsample to at most TREND_MAX_POINTS for chart performance.
 *
 * Used by: GET /api/temperature/trend?range=24h
 *
 * @param {string} userId   – profiles.user_id (text)
 * @param {number} rangeMs  – time window in milliseconds
 * @returns {Promise<Array<{ timestamp: string, skin_temp: number, delta: number }>>}
 */
export async function fetchTemperatureTrend(userId, rangeMs) {
  const rows = await fetchAllRows(userId);

  const windowed = applyTimeWindow(rows, rangeMs);
  const sampled  = downsample(windowed, TREND_MAX_POINTS);

  return sampled.map((r) => ({
    timestamp: r.timestamp,
    skin_temp: round2(r.skin_temp_c),
    delta:     round2(r.temp_delta_c),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute aggregate skin-temperature statistics for a given time window.
 *
 * Statistics (all computed in JS — no custom SQL needed for the prototype):
 *   - avg_skin_temp  – mean skin_temp_c over the window
 *   - min_skin_temp  – lowest skin_temp_c
 *   - max_skin_temp  – highest skin_temp_c
 *   - avg_delta      – mean temp_delta_c (skin vs ambient)
 *
 * Used by: GET /api/temperature/summary?range=24h
 *
 * @param {string} userId   – profiles.user_id (text)
 * @param {number} rangeMs  – time window in milliseconds
 * @returns {Promise<{
 *   avg_skin_temp: number,
 *   min_skin_temp: number,
 *   max_skin_temp: number,
 *   avg_delta: number
 * } | null>}
 */
export async function fetchTemperatureSummary(userId, rangeMs) {
  const rows     = await fetchAllRows(userId);
  const windowed = applyTimeWindow(rows, rangeMs);

  if (windowed.length === 0) return null;

  const temps  = windowed.map((r) => r.skin_temp_c);
  const deltas = windowed.map((r) => r.temp_delta_c);

  return {
    avg_skin_temp: round2(avg(temps)),
    min_skin_temp: round2(Math.min(...temps)),
    max_skin_temp: round2(Math.max(...temps)),
    avg_delta:     round2(avg(deltas)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the average skin temperature split by circadian phase (day / night).
 *
 * Groups windowed rows by their `circadian_phase` column, then computes
 * the mean skin_temp_c for "day" and "night" groups independently.
 *
 * Used by: GET /api/temperature/circadian?range=24h
 *
 * @param {string} userId   – profiles.user_id (text)
 * @param {number} rangeMs  – time window in milliseconds
 * @returns {Promise<{
 *   day_avg_temp: number,
 *   night_avg_temp: number,
 *   difference: number
 * } | null>}
 */
export async function fetchCircadianSplit(userId, rangeMs) {
  const rows     = await fetchAllRows(userId);
  const windowed = applyTimeWindow(rows, rangeMs);

  if (windowed.length === 0) return null;

  // Normalise the phase string so minor casing differences don't break the grouping.
  const dayRows   = windowed.filter((r) => (r.circadian_phase ?? '').toLowerCase() === 'day');
  const nightRows = windowed.filter((r) => (r.circadian_phase ?? '').toLowerCase() === 'night');

  const dayAvg   = round2(avg(dayRows.map((r) => r.skin_temp_c)));
  const nightAvg = round2(avg(nightRows.map((r) => r.skin_temp_c)));

  return {
    day_avg_temp:   dayAvg,
    night_avg_temp: nightAvg,
    // Positive value means daytime temp is higher than night-time, which is typical.
    difference:     round2(dayAvg - nightAvg),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect notable temperature events in a given time window.
 *
 * Two event types are detected (all in JS — no extra SQL):
 *   1. fever_flag = true        → type "fever"
 *   2. skin_temp_c rose > SPIKE_DELTA_C compared to previous reading
 *                               → type "temp_spike"
 *
 * Events are sorted ascending by timestamp for chronological display.
 *
 * Used by: GET /api/temperature/events?range=24h
 *
 * @param {string} userId   – profiles.user_id (text)
 * @param {number} rangeMs  – time window in milliseconds
 * @returns {Promise<Array<{ type: string, timestamp: string, value: number }>>}
 */
export async function fetchTemperatureEvents(userId, rangeMs) {
  const rows     = await fetchAllRows(userId);
  const windowed = applyTimeWindow(rows, rangeMs);

  const events = [];

  for (let i = 0; i < windowed.length; i++) {
    const row = windowed[i];

    // ── 1. Fever flag ─────────────────────────────────────────────────────────
    if (row.fever_flag === true) {
      events.push({
        type:      'fever',
        timestamp: row.timestamp,
        value:     round2(row.skin_temp_c),
      });
    }

    // ── 2. Temperature spike ──────────────────────────────────────────────────
    // Compare to the previous row in the window (skip for the very first row).
    if (i > 0) {
      const prev  = windowed[i - 1];
      const rise  = row.skin_temp_c - prev.skin_temp_c;
      if (rise > SPIKE_DELTA_C) {
        events.push({
          type:      'temp_spike',
          timestamp: row.timestamp,
          value:     round2(row.skin_temp_c),
        });
      }
    }
  }

  // Already in ascending order since windowed is ascending-sorted.
  return events;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Pull all skin_temperature rows for a user from Supabase, sorted ascending.
 *
 * Fetches newest-first (efficient index use) then reverses for time-window
 * slicing. Only selects the columns required by all five endpoints.
 *
 * @param {string} userId  – profiles.user_id (text)
 * @returns {Promise<object[]>} rows sorted ascending by timestamp
 */
async function fetchAllRows(userId) {
  const { data, error } = await supabase
    .from('skin_temperature')
    .select('timestamp, skin_temp_c, ambient_temp_c, temp_delta_c, circadian_phase, fever_flag')
    .eq('user_id', userId)
    .order('timestamp', { ascending: false })
    .limit(FETCH_LIMIT);

  if (error) throw error;

  // Reverse to ascending order (oldest → newest) for time-window slicing.
  return (data ?? []).reverse();
}

/**
 * Slice an ascending-sorted array to only rows within the last `rangeMs`
 * milliseconds, anchored to the most recent row's timestamp.
 *
 * Anchoring to the newest row (not `Date.now()`) ensures the prototype works
 * correctly with static / historical datasets where rows might not fall in
 * the "real" last 24 h.
 *
 * @param {object[]} rows     – ascending sorted rows with a `timestamp` field
 * @param {number}   rangeMs  – window width in milliseconds
 * @returns {object[]}
 */
function applyTimeWindow(rows, rangeMs) {
  if (rows.length === 0) return [];

  const newestMs = new Date(rows[rows.length - 1].timestamp).getTime();
  const cutoffMs = newestMs - rangeMs;

  return rows.filter((r) => new Date(r.timestamp).getTime() >= cutoffMs);
}

/**
 * Evenly downsample an array to at most `maxPoints` elements.
 * Uses every-Kth-row sampling so the overall trend shape is preserved.
 *
 * @param {any[]}  arr       – source array (ascending order)
 * @param {number} maxPoints – maximum output length
 * @returns {any[]}
 */
function downsample(arr, maxPoints) {
  if (arr.length <= maxPoints) return arr;
  const step = Math.ceil(arr.length / maxPoints);
  return arr.filter((_, i) => i % step === 0);
}

/**
 * Arithmetic mean of an array of numbers.
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
 *
 * @param {number} n
 * @returns {number}
 */
function round2(n) {
  return Math.round(n * 100) / 100;
}
