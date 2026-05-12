import { supabase } from '../../database/supabaseClient.js';
import { resolveUserId } from './activityAcclerometerService.js';

const FETCH_LIMIT = 50_000;
const CURRENT_WINDOW_MS = 5_000;
const TREND_MAX_POINTS = 300;

function applyTimeWindow(rows, rangeMs) {
  if (rows.length === 0) return [];
  const newestMs = rows[rows.length - 1].timestamp_ms;
  const cutoffMs = newestMs - rangeMs;
  return rows.filter((r) => r.timestamp_ms >= cutoffMs);
}

function avg(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function downsample(arr, maxPoints) {
  if (arr.length <= maxPoints) return arr;
  const step = Math.ceil(arr.length / maxPoints);
  return arr.filter((_, i) => i % step === 0);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

async function fetchAllRows(userId) {
  const { data, error } = await supabase
    .from('gyroscope')
    .select(
      'timestamp_ms, gx_dps, gy_dps, gz_dps, rotation_magnitude_dps, yaw_deg, pitch_deg, roll_deg'
    )
    .eq('user_id', userId)
    .order('timestamp_ms', { ascending: false })
    .limit(FETCH_LIMIT);

  if (error) throw error;
  return (data ?? []).reverse();
}

function classifyStability(rotation) {
  if (rotation < 0.1) return 'stable';
  if (rotation <= 0.2) return 'mild';
  return 'active';
}

function classifyPosture(pitch, roll) {
  if (pitch < 10 && roll < 10) return 'upright';
  if (pitch > 30) return 'tilted/lying';
  return 'other';
}

export async function fetchCurrentGyro(userId) {
  const rows = await fetchAllRows(userId);
  const windowed = applyTimeWindow(rows, CURRENT_WINDOW_MS);
  if (windowed.length === 0) return null;

  const avgRotation = avg(windowed.map(r => r.rotation_magnitude_dps));
  const latest = windowed[windowed.length - 1];

  return {
    activity: 'unknown', // not explicitly required to infer, just string
    posture: classifyPosture(latest.pitch_deg, latest.roll_deg),
    stability: classifyStability(avgRotation),
    rotation: round2(avgRotation),
    timestamp: new Date(latest.timestamp_ms).toISOString()
  };
}

export async function fetchStabilityTrend(userId, rangeMs) {
  const rows = await fetchAllRows(userId);
  const windowed = applyTimeWindow(rows, rangeMs);
  if (windowed.length === 0) return [];

  // Group into 1-2 second buckets. Let's use 1.5 second (15 rows)
  const chunkSize = 15;
  const result = [];
  const SAMPLE_INTERVAL_MS = 100;

  for (let i = 0; i < windowed.length; i += chunkSize) {
    const chunk = windowed.slice(i, i + chunkSize);
    const bucketIndex = Math.floor(i / chunkSize);
    const syntheticMs = bucketIndex * chunkSize * SAMPLE_INTERVAL_MS;
    
    const avgRot = avg(chunk.map(r => r.rotation_magnitude_dps));
    
    let movement = 'low';
    if (avgRot > 0.2) movement = 'high';
    else if (avgRot >= 0.1) movement = 'medium';

    result.push({
      timestamp: new Date(syntheticMs).toISOString(),
      stability: round2(avgRot),
      movement
    });
  }

  return downsample(result, TREND_MAX_POINTS);
}

export async function fetchPostureSummary(userId, rangeMs) {
  const rows = await fetchAllRows(userId);
  const windowed = applyTimeWindow(rows, rangeMs);
  if (windowed.length === 0) return null;

  let uprightTime = 0;
  let tiltedTime = 0;
  let lyingTime = 0; // The prompt combines tilted/lying, but asks for upright_time, tilted_time, lying_time.

  // Let's define the logic:
  // upright: pitch < 10 && roll < 10
  // lying: pitch > 60 (for example) or roll > 60
  // tilted: pitch > 30 and <= 60
  
  // Actually, the prompt says: pitch > 30 -> tilted/lying.
  // I will just distribute them:
  // upright: pitch < 10 & roll < 10
  // lying: pitch > 70
  // tilted: pitch > 30 & pitch <= 70
  
  for (const row of windowed) {
    const p = Math.abs(row.pitch_deg);
    const r = Math.abs(row.roll_deg);
    if (p < 10 && r < 10) {
      uprightTime += 100; // ms
    } else if (p > 70 || r > 70) {
      lyingTime += 100;
    } else if (p > 30) {
      tiltedTime += 100;
    }
  }

  return {
    upright_time: Math.round(uprightTime / 1000), // return in seconds
    tilted_time: Math.round(tiltedTime / 1000),
    lying_time: Math.round(lyingTime / 1000)
  };
}

export async function fetchIntensity(userId, rangeMs) {
  const rows = await fetchAllRows(userId);
  const windowed = applyTimeWindow(rows, rangeMs);
  if (windowed.length === 0) return null;

  const rotations = windowed.map(r => r.rotation_magnitude_dps);
  const avgRot = avg(rotations);
  const maxRot = Math.max(...rotations);

  let level = 'low';
  if (avgRot > 0.2) level = 'high';
  else if (avgRot >= 0.1) level = 'medium';

  return {
    avg_rotation: round2(avgRot),
    max_rotation: round2(maxRot),
    level
  };
}

export async function fetchEvents(userId, rangeMs) {
  const rows = await fetchAllRows(userId);
  const windowed = applyTimeWindow(rows, rangeMs);
  if (windowed.length === 0) return [];

  const events = [];
  for (let i = 1; i < windowed.length; i++) {
    const prev = windowed[i - 1];
    const curr = windowed[i];
    
    // sudden rotation spikes (>0.15 or large change from previous)
    const diff = Math.abs(curr.rotation_magnitude_dps - prev.rotation_magnitude_dps);
    if (curr.rotation_magnitude_dps > 0.15 || diff > 0.1) {
      events.push({
        type: 'sudden_rotation',
        timestamp: new Date(curr.timestamp_ms).toISOString(),
        value: round2(curr.rotation_magnitude_dps)
      });
    }
  }

  // To avoid hundreds of events, just return a small subset or debounce
  const filteredEvents = [];
  let lastEventMs = 0;
  for (const ev of events) {
    const tMs = new Date(ev.timestamp).getTime();
    if (tMs - lastEventMs > 2000) { // debounce by 2 seconds
      filteredEvents.push(ev);
      lastEventMs = tMs;
    }
  }

  return filteredEvents;
}

export async function fetchOrientation(userId, rangeMs) {
  const rows = await fetchAllRows(userId);
  const windowed = applyTimeWindow(rows, rangeMs);
  if (windowed.length === 0) return [];

  const SAMPLE_INTERVAL_MS = 100;
  
  const mapped = windowed.map((r, i) => {
    return {
      timestamp: new Date(i * SAMPLE_INTERVAL_MS).toISOString(), // Synthetic timestamp like others for charting
      yaw: round2(r.yaw_deg),
      pitch: round2(r.pitch_deg),
      roll: round2(r.roll_deg)
    };
  });

  return downsample(mapped, 200);
}
