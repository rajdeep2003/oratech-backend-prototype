import {
  resolveUserId,
  fetchLatestTemperature,
  fetchTemperatureTrend,
  fetchTemperatureSummary,
  fetchCircadianSplit,
  fetchTemperatureEvents,
} from '../../services/directMetrix/skin_temperatureService.js';

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
 * GET /api/temperature/latest
 *
 * Returns the single most recent skin-temperature reading for the authenticated
 * user along with a simple "normal" | "elevated" status flag.
 *
 * "Elevated" is defined as skin_temp_c >= 37.5 °C (early-fever threshold on
 * the skin surface).
 *
 * Response shape:
 *   {
 *     "skin_temp":    number,
 *     "ambient_temp": number,
 *     "delta":        number,
 *     "status":       "normal" | "elevated",
 *     "timestamp":    string (ISO 8601)
 *   }
 */
export const getLatestTemperature = async (req, res) => {
  try {
    const userId = await resolveUserId(req.user.id);
    const latest = await fetchLatestTemperature(userId);

    if (!latest) {
      return res.status(404).json({ error: 'No skin temperature readings found.' });
    }

    return res.status(200).json(latest);

  } catch (err) {
    const status = err.statusCode ?? 500;
    return res.status(status).json({ error: err.message || 'Internal server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/temperature/trend?range=24h
 *
 * Returns a time-ordered array of skin temperature readings for chart
 * visualisation.  Output is capped at 200 data points.
 *
 * Query params:
 *   range – duration string, e.g. "1h", "24h", "7d"  (default: "24h")
 *
 * Response shape:
 *   [
 *     { "timestamp": string, "skin_temp": number, "delta": number },
 *     ...
 *   ]
 */
export const getTemperatureTrend = async (req, res) => {
  try {
    const rangeStr = req.query.range ?? '24h';
    const rangeMs  = parseDurationMs(rangeStr);

    if (!rangeMs || rangeMs <= 0) {
      return res.status(400).json({
        error: `Invalid range "${rangeStr}". Use a format like "1h", "24h", "7d".`,
      });
    }

    const userId = await resolveUserId(req.user.id);
    const trend  = await fetchTemperatureTrend(userId, rangeMs);

    return res.status(200).json(trend);

  } catch (err) {
    const status = err.statusCode ?? 500;
    return res.status(status).json({ error: err.message || 'Internal server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/temperature/summary?range=24h
 *
 * Returns aggregate skin-temperature statistics for the requested time window.
 *
 * Query params:
 *   range – duration string, e.g. "24h", "7d"  (default: "24h")
 *
 * Response shape:
 *   {
 *     "avg_skin_temp": number,
 *     "min_skin_temp": number,
 *     "max_skin_temp": number,
 *     "avg_delta":     number
 *   }
 */
export const getTemperatureSummary = async (req, res) => {
  try {
    const rangeStr = req.query.range ?? '24h';
    const rangeMs  = parseDurationMs(rangeStr);

    if (!rangeMs || rangeMs <= 0) {
      return res.status(400).json({
        error: `Invalid range "${rangeStr}". Use a format like "24h", "7d".`,
      });
    }

    const userId  = await resolveUserId(req.user.id);
    const summary = await fetchTemperatureSummary(userId, rangeMs);

    if (!summary) {
      return res.status(404).json({ error: 'No skin temperature data for the requested range.' });
    }

    return res.status(200).json(summary);

  } catch (err) {
    const status = err.statusCode ?? 500;
    return res.status(status).json({ error: err.message || 'Internal server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/temperature/circadian?range=24h
 *
 * Returns average skin temperature grouped by circadian phase (day / night).
 *
 * Query params:
 *   range – duration string, e.g. "24h", "7d"  (default: "24h")
 *
 * Response shape:
 *   {
 *     "day_avg_temp":   number,
 *     "night_avg_temp": number,
 *     "difference":     number   ← day_avg − night_avg
 *   }
 */
export const getCircadianSplit = async (req, res) => {
  try {
    const rangeStr = req.query.range ?? '24h';
    const rangeMs  = parseDurationMs(rangeStr);

    if (!rangeMs || rangeMs <= 0) {
      return res.status(400).json({
        error: `Invalid range "${rangeStr}". Use a format like "24h", "7d".`,
      });
    }

    const userId = await resolveUserId(req.user.id);
    const split  = await fetchCircadianSplit(userId, rangeMs);

    if (!split) {
      return res.status(404).json({ error: 'No skin temperature data for the requested range.' });
    }

    return res.status(200).json(split);

  } catch (err) {
    const status = err.statusCode ?? 500;
    return res.status(status).json({ error: err.message || 'Internal server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/temperature/events?range=24h
 *
 * Detects and returns notable temperature events in the requested time window:
 *   - fever_flag = true           → type "fever"
 *   - rise > 0.5 °C vs prev row  → type "temp_spike"
 *
 * Returns an empty array (not 404) when no events exist — that's a healthy result.
 *
 * Query params:
 *   range – duration string, e.g. "24h", "7d"  (default: "24h")
 *
 * Response shape:
 *   [
 *     { "type": "fever"|"temp_spike", "timestamp": string, "value": number },
 *     ...
 *   ]
 */
export const getTemperatureEvents = async (req, res) => {
  try {
    const rangeStr = req.query.range ?? '24h';
    const rangeMs  = parseDurationMs(rangeStr);

    if (!rangeMs || rangeMs <= 0) {
      return res.status(400).json({
        error: `Invalid range "${rangeStr}". Use a format like "24h", "7d".`,
      });
    }

    const userId = await resolveUserId(req.user.id);
    const events = await fetchTemperatureEvents(userId, rangeMs);

    return res.status(200).json(events);

  } catch (err) {
    const status = err.statusCode ?? 500;
    return res.status(status).json({ error: err.message || 'Internal server error' });
  }
};
