import { supabase } from '../../database/supabaseClient.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Rows fetched from Supabase in one go.
 * Accelerometer data is sampled at ~100 ms → ~36 000 rows/hour.
 * 50 000 rows covers ~83 minutes of continuous recording and is sufficient
 * for the prototype's static dataset without pagination complexity.
 */
const FETCH_LIMIT = 50_000;

/**
 * Maximum data points allowed in a trend response.
 * Keeps the JSON payload manageable for the frontend chart.
 */
const TREND_MAX_POINTS = 300;

/**
 * Number of milliseconds to look back when computing "current" activity.
 * 10 seconds at 100 ms sampling = up to ~100 rows of context.
 */
const CURRENT_WINDOW_MS = 10_000;

/**
 * dynamic_acc_g thresholds for movement-level classification.
 *   < LOW_THRESHOLD          → "low"
 *   LOW_THRESHOLD – HIGH_THRESHOLD → "medium"
 *   > HIGH_THRESHOLD         → "high"
 */
const LOW_THRESHOLD  = 0.005;
const HIGH_THRESHOLD = 0.02;

// ── Public helpers ────────────────────────────────────────────────────────────

/**
 * Resolve the TEXT `user_id` stored in `profiles` from the Supabase auth UUID.
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
 * Determine the user's current activity state from the last ~10 seconds of data.
 *
 * Steps:
 *   1. Fetch the most recent rows (newest-first, up to FETCH_LIMIT).
 *   2. Anchor the window to the newest row's timestamp (not Date.now()).
 *   3. Slice to the last CURRENT_WINDOW_MS.
 *   4. Compute avg dynamic_acc_g, step count, and dominant activity_label.
 *   5. Classify movement_level from avg dynamic_acc_g thresholds.
 *
 * Used by: GET /api/activity/current
 *
 * @param {string} userId – profiles.user_id (text)
 * @returns {Promise<{ activity: string, movement_level: string, steps: number, timestamp: string } | null>}
 */
export async function fetchCurrentActivity(userId) {
  const rows = await fetchAllRows(userId);
  if (rows.length === 0) return null;

  // Anchor to the newest row so this works with static datasets.
  const window = applyTimeWindow(rows, CURRENT_WINDOW_MS);
  if (window.length === 0) return null;

  const avgDynamic = avg(window.map((r) => r.dynamic_acc_g));
  const steps      = window.filter((r) => r.step_detected === true).length;
  const activity   = dominantLabel(window.map((r) => r.activity_label));

  return {
    activity:       activity ?? 'unknown',
    movement_level: classifyMovement(avgDynamic),
    steps,
    timestamp:      window[window.length - 1].timestamp_ms,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute an activity summary (steps, active vs sedentary minutes, dominant
 * activity) for the requested time window.
 *
 * "Active" is defined as a row whose activity_label is NOT "sitting" or
 * "lying" and whose dynamic_acc_g >= LOW_THRESHOLD.
 *
 * Minutes are approximated by dividing the row count by the expected ~10 rows
 * per second → ~600 rows/minute.  For a prototype dataset this is fine.
 *
 * Used by: GET /api/activity/summary?range=1h
 *
 * @param {string} userId   – profiles.user_id (text)
 * @param {number} rangeMs  – time window in milliseconds
 * @returns {Promise<{ total_steps: number, active_minutes: number, sedentary_minutes: number, dominant_activity: string } | null>}
 */
export async function fetchActivitySummary(userId, rangeMs) {
  const rows    = await fetchAllRows(userId);
  const windowed = applyTimeWindow(rows, rangeMs);

  if (windowed.length === 0) return null;

  const totalSteps = windowed.filter((r) => r.step_detected === true).length;

  const SEDENTARY_LABELS = new Set(['sitting', 'lying', 'sedentary', 'idle']);
  const activeRows      = windowed.filter(
    (r) => !SEDENTARY_LABELS.has((r.activity_label ?? '').toLowerCase())
         && r.dynamic_acc_g >= LOW_THRESHOLD,
  );
  const sedentaryRows = windowed.filter(
    (r) =>  SEDENTARY_LABELS.has((r.activity_label ?? '').toLowerCase())
         || r.dynamic_acc_g < LOW_THRESHOLD,
  );

  // Each row represents ~100 ms; 600 rows ≈ 1 minute.
  const rowsPerMinute = 600;
  const activeMinutes    = Math.round(activeRows.length    / rowsPerMinute);
  const sedentaryMinutes = Math.round(sedentaryRows.length / rowsPerMinute);

  return {
    total_steps:       totalSteps,
    active_minutes:    activeMinutes,
    sedentary_minutes: sedentaryMinutes,
    dominant_activity: dominantLabel(windowed.map((r) => r.activity_label)) ?? 'unknown',
  };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bucket accelerometer data into equal-sized row-count chunks and compute
 * per-bucket avg dynamic_acc_g and step count.
 *
 * WHY row-count-based, not wall-clock:
 *   The static mock dataset stores `timestamp_ms` as elapsed ms from the
 *   start of each recording session.  Multiple sessions all start from
 *   timestamp_ms = 0, so grouping by time produces interleaved duplicate
 *   timestamps and a single bucket.  Row-count bucketing is session-agnostic
 *   and always produces a meaningful number of distinct output points.
 *
 * WHY synthetic sequential timestamps on the x-axis:
 *   Using chunk[0].timestamp_ms directly repeats the same value when rows
 *   from different sessions share the same session-relative elapsed time.
 *   Instead we synthesise a monotonically-increasing offset:
 *     bucketIndex × chunkSize × SAMPLE_INTERVAL_MS
 *   This keeps the x-axis unique, evenly spaced, and chart-friendly while
 *   still expressing time in milliseconds (interpretable as "elapsed time").
 *
 * Bucketing logic:
 *   - Aim for TARGET_BUCKETS output points (default 60).
 *   - chunkSize = ceil(totalRows / TARGET_BUCKETS).
 *   - Synthetic timestamp = bucketIndex × chunkSize × 100 ms.
 *
 * Used by: GET /api/activity/trend?range=1h
 *
 * @param {string} userId   – profiles.user_id (text)
 * @param {number} rangeMs  – time window in milliseconds
 * @returns {Promise<Array<{ timestamp: string, movement: number, steps: number }>>}
 */
export async function fetchActivityTrend(userId, rangeMs) {
  const rows     = await fetchAllRows(userId);
  const windowed = applyTimeWindow(rows, rangeMs);

  if (windowed.length === 0) return [];

  // Each raw row represents ~100 ms of recording time.
  const SAMPLE_INTERVAL_MS = 100;

  // Aim for 60 output buckets; fall back gracefully for tiny datasets.
  const TARGET_BUCKETS = Math.min(60, windowed.length);
  const chunkSize      = Math.ceil(windowed.length / TARGET_BUCKETS);

  const result = [];

  for (let i = 0; i < windowed.length; i += chunkSize) {
    const chunk       = windowed.slice(i, i + chunkSize);
    const bucketIndex = Math.floor(i / chunkSize);

    // Synthetic offset: bucketIndex × rows-per-bucket × 100 ms/row.
    // Guarantees unique, evenly-spaced x-axis values regardless of the
    // session-relative timestamps stored in the DB.
    const syntheticMs = bucketIndex * chunkSize * SAMPLE_INTERVAL_MS;

    result.push({
      timestamp: new Date(syntheticMs).toISOString(),
      movement:  round4(avg(chunk.map((r) => r.dynamic_acc_g))),
      steps:     chunk.filter((r) => r.step_detected === true).length,
    });
  }

  // Safety cap — result is already ≤ TARGET_BUCKETS.
  return downsample(result, TREND_MAX_POINTS);
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Count total steps detected in the requested time window.
 *
 * Used by: GET /api/activity/steps?range=24h
 *
 * @param {string} userId   – profiles.user_id (text)
 * @param {number} rangeMs  – time window in milliseconds
 * @returns {Promise<{ total_steps: number }>}
 */
export async function fetchStepCount(userId, rangeMs) {
  const rows     = await fetchAllRows(userId);
  const windowed = applyTimeWindow(rows, rangeMs);

  const totalSteps = windowed.filter((r) => r.step_detected === true).length;
  return { total_steps: totalSteps };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute movement intensity statistics for the requested time window.
 *
 * Thresholds:
 *   avg < 0.005  → "low"
 *   avg 0.005–0.02 → "medium"
 *   avg > 0.02   → "high"
 *
 * Used by: GET /api/activity/intensity?range=1h
 *
 * @param {string} userId   – profiles.user_id (text)
 * @param {number} rangeMs  – time window in milliseconds
 * @returns {Promise<{ avg_intensity: number, max_intensity: number, level: string } | null>}
 */
export async function fetchIntensity(userId, rangeMs) {
  const rows     = await fetchAllRows(userId);
  const windowed = applyTimeWindow(rows, rangeMs);

  if (windowed.length === 0) return null;

  const dynamics   = windowed.map((r) => r.dynamic_acc_g);
  const avgIntensity = avg(dynamics);
  const maxIntensity = Math.max(...dynamics);

  return {
    avg_intensity: round4(avgIntensity),
    max_intensity: round4(maxIntensity),
    level:         classifyMovement(avgIntensity),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the percentage of time spent in each activity_label within the
 * requested time window.
 *
 * Each row represents ~100 ms of recording time; percentage is
 * (label_count / total_count) * 100.  Labels are normalised to lowercase.
 * Only the top activity labels (sitting, walking, running) are guaranteed
 * to appear in the response; any other labels are grouped under "other".
 *
 * Used by: GET /api/activity/distribution?range=24h
 *
 * @param {string} userId   – profiles.user_id (text)
 * @param {number} rangeMs  – time window in milliseconds
 * @returns {Promise<Record<string, number> | null>}
 */
export async function fetchActivityDistribution(userId, rangeMs) {
  const rows     = await fetchAllRows(userId);
  const windowed = applyTimeWindow(rows, rangeMs);

  if (windowed.length === 0) return null;

  const total = windowed.length;

  // Count rows per label.
  const labelCounts = {};
  for (const row of windowed) {
    const label = (row.activity_label ?? 'unknown').toLowerCase();
    labelCounts[label] = (labelCounts[label] ?? 0) + 1;
  }

  // Compute percentages, rounded to 1 decimal.
  const distribution = {};
  for (const [label, count] of Object.entries(labelCounts)) {
    distribution[label] = round1((count / total) * 100);
  }

  return distribution;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Pull all accelerometer rows for a user from Supabase, ordered descending
 * by timestamp_ms, then reversed to ascending order.
 *
 * We select only the columns needed by all six endpoints.
 *
 * @param {string} userId  – profiles.user_id (text)
 * @returns {Promise<object[]>} rows sorted ascending by timestamp_ms
 */
async function fetchAllRows(userId) {
  const { data, error } = await supabase
    .from('acclerometer')
    .select(
      'timestamp_ms, ax_g, ay_g, az_g, svm_g, dynamic_acc_g, dominant_freq_hz, step_detected, activity_label',
    )
    .eq('user_id', userId)
    .order('timestamp_ms', { ascending: false })
    .limit(FETCH_LIMIT);

  if (error) throw error;

  // Reverse to ascending (oldest → newest) for time-window slicing.
  return (data ?? []).reverse();
}

/**
 * Slice an ascending-sorted array of rows to only those within the last
 * `rangeMs` milliseconds relative to the most recent row's timestamp_ms.
 *
 * Anchors to the newest available row (not Date.now()) so the prototype
 * works correctly with static / historical datasets.
 *
 * @param {object[]} rows     – ascending sorted rows with a `timestamp_ms` field
 * @param {number}   rangeMs  – window width in milliseconds
 * @returns {object[]} rows within the window
 */
function applyTimeWindow(rows, rangeMs) {
  if (rows.length === 0) return [];

  const newestMs = rows[rows.length - 1].timestamp_ms;
  const cutoffMs = newestMs - rangeMs;

  return rows.filter((r) => r.timestamp_ms >= cutoffMs);
}

/**
 * Evenly downsample an array to at most `maxPoints` elements.
 * Uses systematic (every Kth) sampling so the trend shape is preserved.
 *
 * @param {any[]}  arr       – source array
 * @param {number} maxPoints – maximum output length
 * @returns {any[]}
 */
function downsample(arr, maxPoints) {
  if (arr.length <= maxPoints) return arr;
  const step = Math.ceil(arr.length / maxPoints);
  return arr.filter((_, i) => i % step === 0);
}

/**
 * Compute the arithmetic mean of a numeric array.
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
 * Return the most frequently occurring non-null string in an array.
 * Returns null when the array is empty.
 *
 * @param {(string|null|undefined)[]} labels
 * @returns {string|null}
 */
function dominantLabel(labels) {
  const counts = {};
  for (const label of labels) {
    if (!label) continue;
    const key  = label.toLowerCase();
    counts[key] = (counts[key] ?? 0) + 1;
  }

  let best = null;
  let max  = 0;
  for (const [key, count] of Object.entries(counts)) {
    if (count > max) { max = count; best = key; }
  }

  return best;
}

/**
 * Classify a dynamic_acc_g value into a movement level string.
 *
 * @param {number} dynAcc
 * @returns {"low" | "medium" | "high"}
 */
function classifyMovement(dynAcc) {
  if (dynAcc < LOW_THRESHOLD)  return 'low';
  if (dynAcc < HIGH_THRESHOLD) return 'medium';
  return 'high';
}

/**
 * Round a number to 4 decimal places.
 * Keeps accelerometer values readable without excessive floating-point noise.
 *
 * @param {number} n
 * @returns {number}
 */
function round4(n) {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * Round a number to 1 decimal place (used for percentages).
 *
 * @param {number} n
 * @returns {number}
 */
function round1(n) {
  return Math.round(n * 10) / 10;
}
