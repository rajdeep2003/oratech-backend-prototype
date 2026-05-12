import {
  resolveUserId,
  fetchLatestSpo2,
  fetchSpo2Trend,
  fetchSpo2Summary,
  fetchSpo2Events,
} from '../../services/directMetrix/spo2Service.js';

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
 * @param {string} str   – duration string like "24h" or "7d"
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
 * GET /api/spo2/latest
 *
 * Returns the single most recent valid SpO₂ reading for the authenticated user.
 *
 * "Valid" means:
 *   - signal_quality >= 20  (noisy readings are unreliable)
 *   - artifact_flag is false (motion artifact not detected)
 *
 * The `status` field gives the frontend a quick health signal:
 *   "normal"  → spo2 >= 95 %
 *   "low"     → spo2 < 95 %  (clinically significant)
 *
 * Response shape:
 *   {
 *     "spo2":            number,
 *     "perfusion_index": number,
 *     "status":          "normal" | "low",
 *     "timestamp":       string (ISO 8601)
 *   }
 */
export const getLatestSpo2 = async (req, res) => {
  try {
    const userId = await resolveUserId(req.user.id);
    const latest = await fetchLatestSpo2(userId);

    if (!latest) {
      // No valid readings exist for this user yet.
      return res.status(404).json({ error: 'No valid SpO₂ readings found.' });
    }

    return res.status(200).json(latest);

  } catch (err) {
    const status = err.statusCode ?? 500;
    return res.status(status).json({ error: err.message || 'Internal server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/spo2/trend?range=24h
 *
 * Returns a time-ordered array of SpO₂ readings suitable for plotting a trend
 * line on the frontend dashboard.
 *
 * Query params:
 *   range  – duration string, e.g. "1h", "24h", "7d"  (default: "24h")
 *            Defines how far back from the most recent reading to look.
 *
 * Processing pipeline (all in JS, no extra SQL):
 *   1. Fetch up to 10 000 rows from Supabase (covers months of 10-min data).
 *   2. Filter out low-quality readings (signal_quality < 20).
 *   3. Apply the time window anchored to the newest row.
 *   4. Downsample to a maximum of 200 points for chart performance.
 *
 * Response shape:
 *   [
 *     { "timestamp": string, "spo2": number },
 *     ...
 *   ]
 */
export const getSpo2Trend = async (req, res) => {
  try {
    const rangeStr = req.query.range ?? '24h';
    const rangeMs  = parseDurationMs(rangeStr);

    if (!rangeMs || rangeMs <= 0) {
      return res.status(400).json({
        error: `Invalid range "${rangeStr}". Use a format like "1h", "24h", "7d".`,
      });
    }

    const userId = await resolveUserId(req.user.id);
    const trend  = await fetchSpo2Trend(userId, rangeMs);

    return res.status(200).json(trend);

  } catch (err) {
    const status = err.statusCode ?? 500;
    return res.status(status).json({ error: err.message || 'Internal server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/spo2/summary?range=24h
 *
 * Returns aggregate SpO₂ statistics for the requested time window.
 * All computation happens in JavaScript — straightforward for a prototype and
 * avoids the need for custom SQL functions.
 *
 * Query params:
 *   range  – duration string, e.g. "24h", "7d"  (default: "24h")
 *
 * Response shape:
 *   {
 *     "avg_spo2":        number,   ← mean SpO₂ over the window
 *     "min_spo2":        number,   ← lowest reading
 *     "max_spo2":        number,   ← highest reading
 *     "low_spo2_events": number    ← count of readings below 95 %
 *   }
 */
export const getSpo2Summary = async (req, res) => {
  try {
    const rangeStr = req.query.range ?? '24h';
    const rangeMs  = parseDurationMs(rangeStr);

    if (!rangeMs || rangeMs <= 0) {
      return res.status(400).json({
        error: `Invalid range "${rangeStr}". Use a format like "24h", "7d".`,
      });
    }

    const userId  = await resolveUserId(req.user.id);
    const summary = await fetchSpo2Summary(userId, rangeMs);

    if (!summary) {
      // The window returned zero valid rows — nothing to summarise.
      return res.status(404).json({ error: 'No valid SpO₂ data for the requested range.' });
    }

    return res.status(200).json(summary);

  } catch (err) {
    const status = err.statusCode ?? 500;
    return res.status(status).json({ error: err.message || 'Internal server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/spo2/events?range=24h
 *
 * Detects and returns notable SpO₂ events within the requested time window.
 *
 * An event is flagged when either:
 *   - spo2_percent < 95  → type "low_spo2"  (potential hypoxia)
 *   - respiratory_event is present and != "normal"  → the raw event type from DB
 *     (e.g. "apnea", "hypopnea")
 *
 * Low-quality readings (signal_quality < 20) are excluded to avoid noise
 * being mistakenly reported as clinical events.
 *
 * Query params:
 *   range  – duration string, e.g. "24h", "7d"  (default: "24h")
 *
 * Response shape:
 *   [
 *     {
 *       "type":      string,           ← "low_spo2" or respiratory event label
 *       "timestamp": string,           ← ISO 8601
 *       "value":     number (optional) ← SpO₂ reading at event time
 *     },
 *     ...
 *   ]
 */
export const getSpo2Events = async (req, res) => {
  try {
    const rangeStr = req.query.range ?? '24h';
    const rangeMs  = parseDurationMs(rangeStr);

    if (!rangeMs || rangeMs <= 0) {
      return res.status(400).json({
        error: `Invalid range "${rangeStr}". Use a format like "24h", "7d".`,
      });
    }

    const userId = await resolveUserId(req.user.id);
    const events = await fetchSpo2Events(userId, rangeMs);

    // Return an empty array (not 404) when no events exist — that's a valid
    // and actually desirable result (user is healthy in that window).
    return res.status(200).json(events);

  } catch (err) {
    const status = err.statusCode ?? 500;
    return res.status(status).json({ error: err.message || 'Internal server error' });
  }
};
