import {
  resolveUserId,
  fetchRaw24h,
  fetchAggregated7d,
  fetchAggregated30d,
} from '../../services/directMetrix/heart_rate_service.js';

// ── Supported ranges config ───────────────────────────────────────────────────

const RANGE_HANDLERS = {
  '24h': fetchRaw24h,
  '7d':  fetchAggregated7d,
  '30d': fetchAggregated30d,
};

const VALID_RANGES = Object.keys(RANGE_HANDLERS);

// ── Controller ────────────────────────────────────────────────────────────────

/**
 * GET /api/metrics/heart_rate?range=24h|7d|30d
 *
 * Returns heart-rate data for the authenticated user scoped to the requested
 * time window. Aggregation for 7d and 30d is performed entirely in PostgreSQL.
 *
 * Query params:
 *   range  – "24h" | "7d" | "30d"  (default: "24h")
 *
 * Response shape:
 *   {
 *     range:      string,
 *     resolution: string,
 *     count:      number,
 *     data:       HeartRateRow[]
 *   }
 */
export const getHeartRateMetrics = async (req, res) => {
  try {
    const range = (req.query.range ?? '24h').trim();

    // ── Validate range ────────────────────────────────────────────────────────
    if (!VALID_RANGES.includes(range)) {
      return res.status(400).json({
        error: `Invalid range "${range}". Accepted values: ${VALID_RANGES.join(', ')}.`,
      });
    }

    // ── Resolve the text user_id used in heart_rate_logs ─────────────────────
    // req.user.id  →  profiles.id (UUID)
    // heart_rate_logs.user_id  →  profiles.user_id (TEXT)
    const userId = await resolveUserId(req.user.id);

    // ── Delegate to the appropriate service function ──────────────────────────
    const handler = RANGE_HANDLERS[range];
    const { resolution, data } = await handler(userId);

    return res.status(200).json({
      range,
      resolution,
      count: data.length,
      data,
    });

  } catch (err) {
    const status = err.statusCode ?? 500;
    return res.status(status).json({
      error: err.message || 'Internal server error',
    });
  }
};
