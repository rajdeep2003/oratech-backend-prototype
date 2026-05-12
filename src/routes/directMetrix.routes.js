import { Router } from 'express';
import { requireAuth } from '../middleware/authMiddleware.js';
import { getHeartRateMetrics } from '../controllers/directMetrix/heart_rate_controllers.js';
import {
  getLatestMetrics,
  getWindowData,
  getSummary,
  getTrend,
} from '../controllers/directMetrix/ibiControllers.js';
import {
  getLatestSpo2,
  getSpo2Trend,
  getSpo2Summary,
  getSpo2Events,
} from '../controllers/directMetrix/spo2Controllers.js';
import {
  getLatestTemperature,
  getTemperatureTrend,
  getTemperatureSummary,
  getCircadianSplit,
  getTemperatureEvents,
} from '../controllers/directMetrix/skin_temperatureControllers.js';
import {
  getCurrentActivity,
  getActivitySummary,
  getActivityTrend,
  getStepCount,
  getIntensity,
  getActivityDistribution,
} from '../controllers/directMetrix/activityAcclerometerController.js';
import {
  getCurrentGyro,
  getStability,
  getPostureSummary,
  getIntensity as getGyroIntensity,
  getEvents as getGyroEvents,
  getOrientation
} from '../controllers/directMetrix/gyroscopeController.js';
import {
  getCurrentStress,
  getStressTrend,
  getStressSummary,
  getStressEvents,
  getStressDistribution,
  getStressReactivity
} from '../controllers/directMetrix/stress_edaController.js';
import {
  getCurrentPPG,
  getSignalTrend,
  getWearDetection,
  getQualitySummary,
  getArtifacts,
  getReliabilityScore
} from '../controllers/directMetrix/ppg_Skin_contact_Controller.js';

const router = Router();

// ── Heart Rate ────────────────────────────────────────────────────────────────

/**
 * GET /api/metrics/heart_rate?range=24h|7d|30d
 *
 * Returns heart-rate logs for the authenticated user.
 *   24h → raw rows (capped at 500)
 *   7d  → hourly aggregates via PostgreSQL RPC
 *   30d → 2-hour-block aggregates via PostgreSQL RPC
 */
router.get('/heart_rate', requireAuth, getHeartRateMetrics);

// ── IBI (Inter-Beat Interval / HRV) ──────────────────────────────────────────

/**
 * GET /api/metrics/ibi/metrics/latest
 *
 * Returns a single aggregated snapshot built from the last ~50 clean beats.
 * Dirty beats (artifact_flag=true or beat_quality_score < 80) are excluded.
 * Ideal for a "current status" card on the dashboard.
 *
 * Response: { hr_bpm, rmssd, ibi_ms, activity_state, timestamp }
 */
router.get('/ibi/metrics/latest', requireAuth, getLatestMetrics);

/**
 * GET /api/metrics/ibi/window?duration=5m
 *
 * Returns a downsampled HR time-series for the last N minutes (default 5m).
 * Output is capped at 300 points; every Kth row is kept when downsampling.
 * Designed for a real-time sparkline or scrolling HR chart.
 *
 * Response: [{ timestamp, hr }, ...]
 */
router.get('/ibi/window', requireAuth, getWindowData);

/**
 * GET /api/metrics/ibi/summary?range=1h
 *
 * Returns avg / min / max statistics for RMSSD and HR over the given window
 * (default 1h). Only clean beats are included in the computation.
 * Useful for an HRV summary panel.
 *
 * Response: { rmssd_avg, rmssd_min, rmssd_max, hr_avg, hr_min, hr_max }
 */
router.get('/ibi/summary', requireAuth, getSummary);

/**
 * GET /api/metrics/ibi/trend?range=24h
 *
 * Returns IBI data bucketed into time intervals for trend charts (default 24h).
 *   range ≤ 1h → 1-minute buckets
 *   range > 1h → 5-minute buckets
 * Output is capped at 300 buckets.
 *
 * Response: [{ timestamp, rmssd, hr }, ...]
 */
router.get('/ibi/trend', requireAuth, getTrend);

// ── SpO₂ (Blood Oxygen Saturation) ───────────────────────────────────────────

/**
 * GET /api/metrics/spo2/latest
 *
 * Returns the single most recent valid SpO₂ reading for the authenticated user.
 * Filters out low-quality (signal_quality < 20) and motion-artifact readings.
 *
 * Response: { spo2, perfusion_index, status: "normal"|"low", timestamp }
 */
router.get('/spo2/latest', requireAuth, getLatestSpo2);

/**
 * GET /api/metrics/spo2/trend?range=24h
 *
 * Returns a downsampled time-series of SpO₂ readings for chart visualisation.
 * Quality-filtered and capped at 200 data points.
 *
 * Query params:
 *   range – e.g. "1h", "24h", "7d"  (default: "24h")
 *
 * Response: [{ timestamp, spo2 }, ...]
 */
router.get('/spo2/trend', requireAuth, getSpo2Trend);

/**
 * GET /api/metrics/spo2/summary?range=24h
 *
 * Returns aggregate statistics (avg / min / max SpO₂, low-event count)
 * for the requested time window.
 *
 * Query params:
 *   range – e.g. "24h", "7d"  (default: "24h")
 *
 * Response: { avg_spo2, min_spo2, max_spo2, low_spo2_events }
 */
router.get('/spo2/summary', requireAuth, getSpo2Summary);

/**
 * GET /api/metrics/spo2/events?range=24h
 *
 * Detects notable SpO₂ events in the time window:
 *   - spo2 < 95 %          → type "low_spo2"
 *   - respiratory_event != "normal"  → raw event label from DB
 *
 * Query params:
 *   range – e.g. "24h", "7d"  (default: "24h")
 *
 * Response: [{ type, timestamp, value? }, ...]
 */
router.get('/spo2/events', requireAuth, getSpo2Events);

// ── Skin Temperature ──────────────────────────────────────────────────────────

/**
 * GET /api/metrics/temperature/latest
 *
 * Returns the single most recent skin-temperature reading.
 * Includes a "normal" | "elevated" status flag (threshold: 37.5 °C).
 *
 * Response: { skin_temp, ambient_temp, delta, status, timestamp }
 */
router.get('/temperature/latest', requireAuth, getLatestTemperature);

/**
 * GET /api/metrics/temperature/trend?range=24h
 *
 * Returns a time-series of skin temperature readings for chart visualisation.
 * Capped at 200 data points.  Anchored to the newest available row so the
 * prototype works correctly with a static dataset.
 *
 * Query params:
 *   range – e.g. "1h", "24h", "7d"  (default: "24h")
 *
 * Response: [{ timestamp, skin_temp, delta }, ...]
 */
router.get('/temperature/trend', requireAuth, getTemperatureTrend);

/**
 * GET /api/metrics/temperature/summary?range=24h
 *
 * Returns aggregate statistics: avg / min / max skin_temp_c and avg delta.
 *
 * Query params:
 *   range – e.g. "24h", "7d"  (default: "24h")
 *
 * Response: { avg_skin_temp, min_skin_temp, max_skin_temp, avg_delta }
 */
router.get('/temperature/summary', requireAuth, getTemperatureSummary);

/**
 * GET /api/metrics/temperature/circadian?range=24h
 *
 * Groups readings by circadian_phase ("day" / "night") and returns the
 * average skin temperature for each group plus the difference.
 *
 * Query params:
 *   range – e.g. "24h", "7d"  (default: "24h")
 *
 * Response: { day_avg_temp, night_avg_temp, difference }
 */
router.get('/temperature/circadian', requireAuth, getCircadianSplit);

/**
 * GET /api/metrics/temperature/events?range=24h
 *
 * Detects fever events (fever_flag=true) and temperature spikes
 * (rise > 0.5 °C vs the previous reading) within the time window.
 * Returns an empty array when no events exist.
 *
 * Query params:
 *   range – e.g. "24h", "7d"  (default: "24h")
 *
 * Response: [{ type: "fever"|"temp_spike", timestamp, value }, ...]
 */
router.get('/temperature/events', requireAuth, getTemperatureEvents);

// ── Activity / Accelerometer ─────────────────────────────────────────────────

/**
 * GET /api/metrics/activity/current
 *
 * Returns the user's current activity state inferred from the last ~10 seconds
 * of accelerometer data (anchored to the newest row in the dataset).
 *
 * Response: { activity, movement_level: "low"|"medium"|"high", steps, timestamp }
 */
router.get('/activity/current', requireAuth, getCurrentActivity);

/**
 * GET /api/metrics/activity/summary?range=1h
 *
 * Aggregate activity stats for the requested window.
 * Classifies rows as active vs sedentary, counts steps, finds dominant label.
 *
 * Query params:
 *   range – e.g. "1h", "24h"  (default: "1h")
 *
 * Response: { total_steps, active_minutes, sedentary_minutes, dominant_activity }
 */
router.get('/activity/summary', requireAuth, getActivitySummary);

/**
 * GET /api/metrics/activity/trend?range=1h
 *
 * Buckets accelerometer data into 1-minute intervals.
 * Each bucket exposes avg dynamic_acc_g (movement) and step count.
 * Output sorted ascending and capped at 300 points.
 *
 * Query params:
 *   range – e.g. "1h", "24h"  (default: "1h")
 *
 * Response: [{ timestamp, movement, steps }, ...]
 */
router.get('/activity/trend', requireAuth, getActivityTrend);

/**
 * GET /api/metrics/activity/steps?range=24h
 *
 * Counts steps (step_detected = true) in the requested window.
 *
 * Query params:
 *   range – e.g. "24h", "7d"  (default: "24h")
 *
 * Response: { total_steps }
 */
router.get('/activity/steps', requireAuth, getStepCount);

/**
 * GET /api/metrics/activity/intensity?range=1h
 *
 * Returns avg and max dynamic_acc_g plus a level classification:
 *   < 0.005  → "low"
 *   0.005–0.02 → "medium"
 *   > 0.02   → "high"
 *
 * Query params:
 *   range – e.g. "1h", "24h"  (default: "1h")
 *
 * Response: { avg_intensity, max_intensity, level }
 */
router.get('/activity/intensity', requireAuth, getIntensity);

/**
 * GET /api/metrics/activity/distribution?range=24h
 *
 * Computes the percentage of time spent in each activity_label.
 * Labels not present in the dataset will not appear in the response.
 *
 * Query params:
 *   range – e.g. "24h", "7d"  (default: "24h")
 *
 * Response: { sitting: %, walking: %, running: %, ... }
 */
router.get('/activity/distribution', requireAuth, getActivityDistribution);

// ── Gyroscope / Motion Tracking ──────────────────────────────────────────────

/**
 * GET /api/metrics/gyro/current
 *
 * Fetch last ~5 seconds of data and compute stability and posture.
 */
router.get('/gyro/current', requireAuth, getCurrentGyro);

/**
 * GET /api/metrics/gyro/stability?range=5m
 *
 * Group data into 1-2 second buckets and compute average rotation per bucket.
 */
router.get('/gyro/stability', requireAuth, getStability);

/**
 * GET /api/metrics/gyro/posture-summary?range=1h
 *
 * Compute total time spent in upright, tilted, and lying postures.
 */
router.get('/gyro/posture-summary', requireAuth, getPostureSummary);

/**
 * GET /api/metrics/gyro/intensity?range=1h
 *
 * Compute average and maximum rotation magnitude and classify level.
 */
router.get('/gyro/intensity', requireAuth, getGyroIntensity);

/**
 * GET /api/metrics/gyro/events?range=5m
 *
 * Detect sudden rotation spikes (>0.15 or large change from previous).
 */
router.get('/gyro/events', requireAuth, getGyroEvents);

/**
 * GET /api/metrics/gyro/orientation?range=5m
 *
 * Return simplified, downsampled orientation data for charting.
 */
router.get('/gyro/orientation', requireAuth, getOrientation);

// ── Stress / EDA ─────────────────────────────────────────────────────────────

/**
 * GET /api/metrics/stress/current
 *
 * Fetch last few seconds of data, compute avg eda_microsiemens and classify stress.
 */
router.get('/stress/current', requireAuth, getCurrentStress);

/**
 * GET /api/metrics/stress/trend?range=5m
 *
 * Fetch data within range and downsample to max ~200 points.
 */
router.get('/stress/trend', requireAuth, getStressTrend);

/**
 * GET /api/metrics/stress/summary?range=5m
 *
 * Compute avg, min, max eda and classify overall state.
 */
router.get('/stress/summary', requireAuth, getStressSummary);

/**
 * GET /api/metrics/stress/events?range=5m
 *
 * Detect stress spikes based on eda increases or skin_conductance_category.
 */
router.get('/stress/events', requireAuth, getStressEvents);

/**
 * GET /api/metrics/stress/distribution?range=5m
 *
 * Compute % time spent in relaxed, normal, and elevated states.
 */
router.get('/stress/distribution', requireAuth, getStressDistribution);

/**
 * GET /api/metrics/stress/reactivity?range=5m
 *
 * Count number of spikes and classify reactivity level.
 */
router.get('/stress/reactivity', requireAuth, getStressReactivity);

// ── PPG Skin Contact ─────────────────────────────────────────────────────────

/**
 * GET /api/metrics/ppg/current
 *
 * Returns the current wearing status and signal quality based on the last 5 minutes of valid data.
 */
router.get('/ppg/current', requireAuth, getCurrentPPG);

/**
 * GET /api/metrics/ppg/signal-trend?range=1h
 *
 * Returns a 5-minute bucketed trend of perfusion index and signal quality.
 */
router.get('/ppg/signal-trend', requireAuth, getSignalTrend);

/**
 * GET /api/metrics/ppg/wear-detection?range=24h
 *
 * Computes wear compliance based on ON_WRIST vs OFF_WRIST states.
 */
router.get('/ppg/wear-detection', requireAuth, getWearDetection);

/**
 * GET /api/metrics/ppg/quality-summary?range=24h
 *
 * Classifies signal quality into good, medium, poor and returns distribution.
 */
router.get('/ppg/quality-summary', requireAuth, getQualitySummary);

/**
 * GET /api/metrics/ppg/artifacts?range=1h
 *
 * Returns motion artifacts with a 2-minute debounce.
 */
router.get('/ppg/artifacts', requireAuth, getArtifacts);

/**
 * GET /api/metrics/ppg/reliability-score?range=24h
 *
 * Computes a weighted signal reliability score based on valid data, confidence, and wear ratio.
 */
router.get('/ppg/reliability-score', requireAuth, getReliabilityScore);

export default router;
