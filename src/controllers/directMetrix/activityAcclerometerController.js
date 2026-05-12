import {
  resolveUserId,
  fetchCurrentActivity,
  fetchActivitySummary,
  fetchActivityTrend,
  fetchStepCount,
  fetchIntensity,
  fetchActivityDistribution,
} from '../../services/directMetrix/activityAcclerometerService.js';

// ── Duration parsing helper ───────────────────────────────────────────────────

/**
 * Parse a human-readable duration string into milliseconds.
 *
 * Supported units:
 *   s  → seconds   (e.g. "30s")
 *   m  → minutes   (e.g. "5m")
 *   h  → hours     (e.g. "1h", "24h")
 *   d  → days      (e.g. "7d")
 *
 * @param {string} str   – duration string like "1h" or "24h"
 * @returns {number|null} milliseconds, or null for unrecognised formats
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
 * GET /api/activity/current
 *
 * Returns the user's current activity state derived from the last ~10 seconds
 * of accelerometer data.
 *
 * Response shape:
 *   {
 *     "activity":       string,              ← dominant activity_label
 *     "movement_level": "low"|"medium"|"high",
 *     "steps":          number,              ← steps detected in the window
 *     "timestamp":      number               ← timestamp_ms of the latest row
 *   }
 */
export const getCurrentActivity = async (req, res) => {
  try {
    const userId  = await resolveUserId(req.user.id);
    const current = await fetchCurrentActivity(userId);

    if (!current) {
      return res.status(404).json({ error: 'No recent accelerometer data found.' });
    }

    return res.status(200).json(current);

  } catch (err) {
    const status = err.statusCode ?? 500;
    return res.status(status).json({ error: err.message || 'Internal server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/activity/summary?range=1h
 *
 * Returns aggregate activity statistics for the requested time window.
 *
 * Query params:
 *   range  – duration string, e.g. "1h", "24h"  (default: "1h")
 *
 * Response shape:
 *   {
 *     "total_steps":       number,
 *     "active_minutes":    number,
 *     "sedentary_minutes": number,
 *     "dominant_activity": string
 *   }
 */
export const getActivitySummary = async (req, res) => {
  try {
    const rangeStr = req.query.range ?? '1h';
    const rangeMs  = parseDurationMs(rangeStr);

    if (!rangeMs || rangeMs <= 0) {
      return res.status(400).json({
        error: `Invalid range "${rangeStr}". Use a format like "1h", "24h".`,
      });
    }

    const userId  = await resolveUserId(req.user.id);
    const summary = await fetchActivitySummary(userId, rangeMs);

    if (!summary) {
      return res.status(404).json({ error: 'No activity data for the requested range.' });
    }

    return res.status(200).json(summary);

  } catch (err) {
    const status = err.statusCode ?? 500;
    return res.status(status).json({ error: err.message || 'Internal server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/activity/trend?range=1h
 *
 * Returns accelerometer data bucketed into 1-minute intervals for trend charts.
 * Each bucket includes avg dynamic_acc_g (movement) and total step count.
 * Output is sorted ascending and capped at 300 points.
 *
 * Query params:
 *   range  – duration string, e.g. "1h", "24h"  (default: "1h")
 *
 * Response shape:
 *   [{ "timestamp": string, "movement": number, "steps": number }, ...]
 */
export const getActivityTrend = async (req, res) => {
  try {
    const rangeStr = req.query.range ?? '1h';
    const rangeMs  = parseDurationMs(rangeStr);

    if (!rangeMs || rangeMs <= 0) {
      return res.status(400).json({
        error: `Invalid range "${rangeStr}". Use a format like "1h", "24h".`,
      });
    }

    const userId = await resolveUserId(req.user.id);
    const trend  = await fetchActivityTrend(userId, rangeMs);

    return res.status(200).json(trend);

  } catch (err) {
    const status = err.statusCode ?? 500;
    return res.status(status).json({ error: err.message || 'Internal server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/activity/steps?range=24h
 *
 * Counts the total number of steps detected in the requested time window.
 *
 * Query params:
 *   range  – duration string, e.g. "1h", "24h"  (default: "24h")
 *
 * Response shape:
 *   { "total_steps": number }
 */
export const getStepCount = async (req, res) => {
  try {
    const rangeStr = req.query.range ?? '24h';
    const rangeMs  = parseDurationMs(rangeStr);

    if (!rangeMs || rangeMs <= 0) {
      return res.status(400).json({
        error: `Invalid range "${rangeStr}". Use a format like "24h", "7d".`,
      });
    }

    const userId = await resolveUserId(req.user.id);
    const result = await fetchStepCount(userId, rangeMs);

    return res.status(200).json(result);

  } catch (err) {
    const status = err.statusCode ?? 500;
    return res.status(status).json({ error: err.message || 'Internal server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/activity/intensity?range=1h
 *
 * Returns movement intensity statistics for the requested time window.
 *
 * Query params:
 *   range  – duration string, e.g. "1h", "24h"  (default: "1h")
 *
 * Response shape:
 *   {
 *     "avg_intensity": number,             ← avg dynamic_acc_g
 *     "max_intensity": number,             ← peak dynamic_acc_g
 *     "level":         "low"|"medium"|"high"
 *   }
 */
export const getIntensity = async (req, res) => {
  try {
    const rangeStr = req.query.range ?? '1h';
    const rangeMs  = parseDurationMs(rangeStr);

    if (!rangeMs || rangeMs <= 0) {
      return res.status(400).json({
        error: `Invalid range "${rangeStr}". Use a format like "1h", "24h".`,
      });
    }

    const userId    = await resolveUserId(req.user.id);
    const intensity = await fetchIntensity(userId, rangeMs);

    if (!intensity) {
      return res.status(404).json({ error: 'No activity data for the requested range.' });
    }

    return res.status(200).json(intensity);

  } catch (err) {
    const status = err.statusCode ?? 500;
    return res.status(status).json({ error: err.message || 'Internal server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/activity/distribution?range=24h
 *
 * Computes the percentage of time spent in each activity_label within the
 * requested time window.  Labels not present in the dataset will not appear
 * in the response object.
 *
 * Query params:
 *   range  – duration string, e.g. "1h", "24h"  (default: "24h")
 *
 * Response shape:
 *   { "sitting": number, "walking": number, "running": number, ... }
 *   (percentages, sum ≈ 100)
 */
export const getActivityDistribution = async (req, res) => {
  try {
    const rangeStr = req.query.range ?? '24h';
    const rangeMs  = parseDurationMs(rangeStr);

    if (!rangeMs || rangeMs <= 0) {
      return res.status(400).json({
        error: `Invalid range "${rangeStr}". Use a format like "24h", "7d".`,
      });
    }

    const userId       = await resolveUserId(req.user.id);
    const distribution = await fetchActivityDistribution(userId, rangeMs);

    if (!distribution) {
      return res.status(404).json({ error: 'No activity data for the requested range.' });
    }

    return res.status(200).json(distribution);

  } catch (err) {
    const status = err.statusCode ?? 500;
    return res.status(status).json({ error: err.message || 'Internal server error' });
  }
};
