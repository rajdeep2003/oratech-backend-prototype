import { supabase } from '../../database/supabaseClient.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum raw rows returned for the 24h range (most recent N rows). */
const RAW_ROW_LIMIT = 500;

/**
 * Passed as p_since to the RPC when no time-window filter is desired.
 * Effectively means "include all historical data".
 */
const EPOCH_START = '1970-01-01T00:00:00.000Z';

/**
 * Target number of data points to aim for when computing dynamic resolution.
 * Used by resolveIntervalHours() for the bonus dynamic-resolution feature.
 */
const TARGET_POINTS = 300;

// ── Public service functions ──────────────────────────────────────────────────

/**
 * Resolve a `profiles.user_id` (TEXT) from the Supabase auth UUID.
 *
 * heart_rate_logs.user_id  →  profiles.user_id  (TEXT, unique)
 * req.user.id              →  profiles.id        (UUID)
 *
 * We therefore need one lightweight lookup before any metrics query.
 *
 * @param {string} authUuid  – req.user.id from Supabase JWT
 * @returns {Promise<string>} profiles.user_id text value
 * @throws  {Error} if profile not found
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

// ── Range handlers ────────────────────────────────────────────────────────────

/**
 * Fetch the most recent RAW_ROW_LIMIT heart_rate_logs rows for the user.
 * No time-window filter is applied — works correctly with mock/static datasets.
 * Rows are fetched newest-first then reversed so the response is ascending.
 *
 * @param {string} userId  – profiles.user_id (text)
 * @returns {Promise<{ resolution: string, data: object[] }>}
 */
export async function fetchRaw24h(userId) {
  const { data, error } = await supabase
    .from('heart_rate_logs')
    .select('id, timestamp, hr_bpm, hr_smoothed_bpm, activity_state, signal_quality')
    .eq('user_id', userId)
    .order('timestamp', { ascending: false })   // newest first → grab top N
    .limit(RAW_ROW_LIMIT);

  if (error) throw error;

  // Reverse to chronological (ascending) order for charting consumers.
  const sorted = (data ?? []).reverse();

  return { resolution: 'raw', data: sorted };
}

/**
 * Fetch hourly aggregated heart rate data across ALL available data.
 * No time-window filter — works correctly with mock/static datasets.
 * Aggregation (AVG/MIN/MAX/COUNT) is performed entirely inside PostgreSQL.
 *
 * @param {string} userId  – profiles.user_id (text)
 * @returns {Promise<{ resolution: string, data: object[] }>}
 */
export async function fetchAggregated7d(userId) {
  const data = await callAggregateRpc(userId, EPOCH_START, 1);  // 1-hour buckets
  return { resolution: 'hourly', data };
}

/**
 * Fetch 2-hour-block aggregated heart rate data across ALL available data.
 * No time-window filter — works correctly with mock/static datasets.
 * Aggregation (AVG/MIN/MAX/COUNT) is performed entirely inside PostgreSQL.
 *
 * @param {string} userId  – profiles.user_id (text)
 * @returns {Promise<{ resolution: string, data: object[] }>}
 */
export async function fetchAggregated30d(userId) {
  const data = await callAggregateRpc(userId, EPOCH_START, 2);  // 2-hour buckets
  return { resolution: '2h_blocks', data };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Call the `get_hr_aggregated` Postgres function via Supabase RPC.
 * All aggregation (AVG / MIN / MAX / COUNT, bucketing) happens in the DB.
 *
 * @param {string} userId          – profiles.user_id (text)
 * @param {string} since           – ISO timestamp string (window start)
 * @param {number} intervalHours   – bucket width in whole hours (≥ 1)
 * @returns {Promise<object[]>}    – normalised bucket rows
 */
async function callAggregateRpc(userId, since, intervalHours) {
  const { data, error } = await supabase.rpc('get_hr_aggregated', {
    p_user_id:        userId,
    p_since:          since,
    p_interval_hours: intervalHours,
  });

  if (error) throw error;

  // Normalise column names returned by Postgres to the documented API shape.
  return (data ?? []).map((row) => ({
    bucket_start:         row.bucket_start,
    hr_bpm_avg:           row.hr_bpm_avg,
    hr_bpm_min:           row.hr_bpm_min,
    hr_bpm_max:           row.hr_bpm_max,
    hr_smoothed_bpm_avg:  row.hr_smoothed_bpm_avg,
    sample_count:         Number(row.sample_count),   // bigint → JS number
  }));
}


