import {
  resolveUserId,
  fetchLatestMetrics,
  fetchWindowData,
  fetchSummary,
  fetchTrend,
} from '../../services/directMetrix/ibiService.js';

// ── Duration parsing helper ───────────────────────────────────────────────────

/**
 * Parse a human-readable duration string into milliseconds.
 *
 * Supported units:
 *   s  → seconds  (e.g. "30s")
 *   m  → minutes  (e.g. "5m")
 *   h  → hours    (e.g. "1h")
 *   d  → days     (e.g. "7d")
 *
 * @param {string} str   – duration string like "5m", "1h", "24h"
 * @returns {number|null} milliseconds, or null if the format is unrecognised
 */
function parseDurationMs(str) {
  const match = String(str).trim().match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit  = match[2].toLowerCase();

  const multipliers = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return value * multipliers[unit];
}

// ── Controllers ───────────────────────────────────────────────────────────────

/**
 * GET /api/ibi/metrics/latest
 *
 * Returns a single aggregated snapshot of the user's most recent IBI activity.
 * Internally fetches the last 50 clean beats (artifact_flag=false,
 * beat_quality_score ≥ 80) and averages running_hr_bpm, rmssd_local_ms,
 * and ibi_ms to produce scalar metrics the frontend can display directly.
 *
 * Response:
 *   {
 *     "hr_bpm":         number | null,
 *     "rmssd":          number | null,
 *     "ibi_ms":         number | null,
 *     "activity_state": string | null,
 *     "timestamp":      number | null   ← latest timestamp_ms
 *   }
 */
export const getLatestMetrics = async (req, res) => {
  try {
    const userId = await resolveUserId(req.user.id);
    const metrics = await fetchLatestMetrics(userId);

    return res.status(200).json(metrics);

  } catch (err) {
    const status = err.statusCode ?? 500;
    return res.status(status).json({ error: err.message || 'Internal server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/ibi/window?duration=5m
 *
 * Returns a downsampled time-series of HR values from the last N minutes,
 * capped at 300 points to keep the payload light for real-time charts.
 *
 * Query params:
 *   duration  – e.g. "5m", "10m", "1h"  (default: "5m")
 *
 * Response:
 *   [{ "timestamp": number, "hr": number }, ...]
 */
export const getWindowData = async (req, res) => {
  try {
    const durationStr = req.query.duration ?? '5m';
    const durationMs  = parseDurationMs(durationStr);

    if (!durationMs || durationMs <= 0) {
      return res.status(400).json({
        error: `Invalid duration "${durationStr}". Use a format like "5m", "30s", "1h".`,
      });
    }

    const userId = await resolveUserId(req.user.id);
    const series = await fetchWindowData(userId, durationMs);

    return res.status(200).json(series);

  } catch (err) {
    const status = err.statusCode ?? 500;
    return res.status(status).json({ error: err.message || 'Internal server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/ibi/summary?range=1h
 *
 * Returns aggregate statistics (avg / min / max) for RMSSD and heart rate
 * over the specified time window. Dirty beats (artifact_flag or low quality)
 * are excluded before computing stats.
 *
 * Query params:
 *   range  – e.g. "1h", "6h", "24h"  (default: "1h")
 *
 * Response:
 *   {
 *     "rmssd_avg": number | null,
 *     "rmssd_min": number | null,
 *     "rmssd_max": number | null,
 *     "hr_avg":    number | null,
 *     "hr_min":    number | null,
 *     "hr_max":    number | null
 *   }
 */
export const getSummary = async (req, res) => {
  try {
    const rangeStr = req.query.range ?? '1h';
    const rangeMs  = parseDurationMs(rangeStr);

    if (!rangeMs || rangeMs <= 0) {
      return res.status(400).json({
        error: `Invalid range "${rangeStr}". Use a format like "1h", "6h", "24h".`,
      });
    }

    const userId  = await resolveUserId(req.user.id);
    const summary = await fetchSummary(userId, rangeMs);

    return res.status(200).json(summary);

  } catch (err) {
    const status = err.statusCode ?? 500;
    return res.status(status).json({ error: err.message || 'Internal server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/ibi/trend?range=24h
 *
 * Returns IBI data bucketed into fixed-size time intervals, suitable for
 * rendering a smooth trend line on a chart.
 *
 * Bucket granularity is chosen automatically based on the requested range:
 *   – range ≤ 1h  → 1-minute buckets
 *   – range > 1h  → 5-minute buckets
 *
 * Output is capped at 300 buckets. Each bucket contains the average RMSSD
 * and average HR for all clean beats that fell within that interval.
 *
 * Query params:
 *   range  – e.g. "1h", "24h", "7d"  (default: "24h")
 *
 * Response:
 *   [{ "timestamp": number, "rmssd": number, "hr": number }, ...]
 */
export const getTrend = async (req, res) => {
  try {
    const rangeStr = req.query.range ?? '24h';
    const rangeMs  = parseDurationMs(rangeStr);

    if (!rangeMs || rangeMs <= 0) {
      return res.status(400).json({
        error: `Invalid range "${rangeStr}". Use a format like "1h", "24h", "7d".`,
      });
    }

    const userId = await resolveUserId(req.user.id);
    const trend  = await fetchTrend(userId, rangeMs);

    return res.status(200).json(trend);

  } catch (err) {
    const status = err.statusCode ?? 500;
    return res.status(status).json({ error: err.message || 'Internal server error' });
  }
};
