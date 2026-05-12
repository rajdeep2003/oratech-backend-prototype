-- =============================================================================
-- Heart-rate aggregation RPC
--
-- Run once in the Supabase SQL Editor (or include in your migration tool).
--
-- Function: get_hr_aggregated
--   Buckets heart_rate_logs rows into equal-width time intervals entirely
--   inside PostgreSQL, so Node.js never loads raw rows for aggregated ranges.
--
-- Parameters
--   p_user_id        TEXT         – the profiles.user_id value (text PK)
--   p_since          TIMESTAMPTZ  – start of the window (exclusive: >= p_since)
--   p_interval_hours INT          – bucket width in hours (e.g. 1 or 2)
--
-- Returns one row per non-empty bucket:
--   bucket_start          TIMESTAMPTZ
--   hr_bpm_avg            FLOAT8
--   hr_bpm_min            FLOAT8
--   hr_bpm_max            FLOAT8
--   hr_smoothed_bpm_avg   FLOAT8
--   sample_count          BIGINT
-- =============================================================================

CREATE OR REPLACE FUNCTION get_hr_aggregated(
  p_user_id        TEXT,
  p_since          TIMESTAMPTZ,
  p_interval_hours INT
)
RETURNS TABLE (
  bucket_start          TIMESTAMPTZ,
  hr_bpm_avg            FLOAT8,
  hr_bpm_min            FLOAT8,
  hr_bpm_max            FLOAT8,
  hr_smoothed_bpm_avg   FLOAT8,
  sample_count          BIGINT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    -- Epoch-based bucket: floor the Unix timestamp to the nearest interval boundary.
    -- Works correctly regardless of timezone and avoids DST edge cases.
    to_timestamp(
      floor(
        extract(epoch FROM timestamp) / (p_interval_hours * 3600)
      ) * (p_interval_hours * 3600)
    ) AS bucket_start,

    ROUND( AVG(hr_bpm)::NUMERIC,          2 )::FLOAT8 AS hr_bpm_avg,
    MIN(hr_bpm)::FLOAT8                               AS hr_bpm_min,
    MAX(hr_bpm)::FLOAT8                               AS hr_bpm_max,
    ROUND( AVG(hr_smoothed_bpm)::NUMERIC,  2 )::FLOAT8 AS hr_smoothed_bpm_avg,
    COUNT(*)                                           AS sample_count

  FROM  heart_rate_logs
  WHERE user_id  = p_user_id
    AND timestamp >= p_since
    AND hr_bpm    IS NOT NULL          -- guard against nulls before aggregating

  GROUP BY 1
  HAVING COUNT(*) > 0                  -- never emit empty buckets
  ORDER BY bucket_start ASC;
$$;

-- Grant execute to the authenticated role used by Supabase PostgREST
GRANT EXECUTE ON FUNCTION get_hr_aggregated(TEXT, TIMESTAMPTZ, INT)
  TO authenticated;
