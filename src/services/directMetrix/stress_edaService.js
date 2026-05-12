import { supabase } from '../../database/supabaseClient.js';
import { resolveUserId } from './activityAcclerometerService.js';

const FETCH_LIMIT = 50_000;
const CURRENT_WINDOW_S = 5; // 5 seconds
const TREND_MAX_POINTS = 200;

function applyTimeWindow(rows, rangeS) {
  if (rows.length === 0) return [];
  const newestS = rows[rows.length - 1].timestamp_s;
  const cutoffS = newestS - rangeS;
  return rows.filter((r) => r.timestamp_s >= cutoffS);
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
    .from('gsr_eda')
    .select(
      'timestamp_s, eda_microsiemens, scl_microsiemens, scr_amplitude_microsiemens, scr_detected, skin_conductance_category'
    )
    .eq('user_id', userId)
    .order('timestamp_s', { ascending: false })
    .limit(FETCH_LIMIT);

  if (error) throw error;
  return (data ?? []).reverse(); // Oldest to newest
}

function classifyStress(eda) {
  if (eda < 4) return 'relaxed';
  if (eda <= 5) return 'normal';
  return 'elevated';
}

export async function fetchCurrentStress(userId) {
  const rows = await fetchAllRows(userId);
  const windowed = applyTimeWindow(rows, CURRENT_WINDOW_S);
  if (windowed.length === 0) return null;

  const avgEda = avg(windowed.map(r => r.eda_microsiemens));
  const latest = windowed[windowed.length - 1];
  const status = classifyStress(avgEda);

  return {
    stress_level: status, // using status classification as stress_level too, as requested
    eda: round2(avgEda),
    status,
    timestamp: new Date(latest.timestamp_s * 1000).toISOString()
  };
}

export async function fetchStressTrend(userId, rangeS) {
  const rows = await fetchAllRows(userId);
  const windowed = applyTimeWindow(rows, rangeS);
  if (windowed.length === 0) return [];

  // Group into 1-2 second buckets. Let's use 1 second (approx 4 rows since frequency is 0.25s)
  const chunkSize = 4;
  const result = [];
  const SAMPLE_INTERVAL_S = 1;

  for (let i = 0; i < windowed.length; i += chunkSize) {
    const chunk = windowed.slice(i, i + chunkSize);
    const bucketIndex = Math.floor(i / chunkSize);
    const syntheticS = bucketIndex * chunkSize * SAMPLE_INTERVAL_S;
    
    const avgEda = avg(chunk.map(r => r.eda_microsiemens));
    
    result.push({
      timestamp: new Date(syntheticS * 1000).toISOString(),
      eda: round2(avgEda),
      level: classifyStress(avgEda)
    });
  }

  return downsample(result, TREND_MAX_POINTS);
}

export async function fetchStressSummary(userId, rangeS) {
  const rows = await fetchAllRows(userId);
  const windowed = applyTimeWindow(rows, rangeS);
  if (windowed.length === 0) return null;

  const values = windowed.map(r => r.eda_microsiemens);
  const avgEda = avg(values);
  const minEda = Math.min(...values);
  const maxEda = Math.max(...values);

  return {
    avg_eda: round2(avgEda),
    min_eda: round2(minEda),
    max_eda: round2(maxEda),
    stress_state: classifyStress(avgEda)
  };
}

export async function fetchStressEvents(userId, rangeS) {
  const rows = await fetchAllRows(userId);
  const windowed = applyTimeWindow(rows, rangeS);
  if (windowed.length === 0) return [];

  const events = [];
  for (let i = 1; i < windowed.length; i++) {
    const prev = windowed[i - 1];
    const curr = windowed[i];
    
    const diff = curr.eda_microsiemens - prev.eda_microsiemens;
    if (diff > 0.5 || curr.skin_conductance_category === 'elevated') {
      let severity = 'low';
      if (diff > 1.0) severity = 'high';
      else if (diff > 0.7) severity = 'medium';

      events.push({
        type: 'stress_spike',
        timestamp: new Date(curr.timestamp_s * 1000).toISOString(),
        value: round2(curr.eda_microsiemens),
        severity
      });
    }
  }

  // To avoid hundreds of events, debounce
  const filteredEvents = [];
  let lastEventS = 0;
  for (const ev of events) {
    const tS = new Date(ev.timestamp).getTime() / 1000;
    if (tS - lastEventS > 2) { // debounce by 2 seconds
      filteredEvents.push(ev);
      lastEventS = tS;
    }
  }

  return filteredEvents;
}

export async function fetchStressDistribution(userId, rangeS) {
  const rows = await fetchAllRows(userId);
  const windowed = applyTimeWindow(rows, rangeS);
  if (windowed.length === 0) {
    return { relaxed: 0, normal: 0, elevated: 0 };
  }

  let relaxed = 0;
  let normal = 0;
  let elevated = 0;

  for (const row of windowed) {
    const status = classifyStress(row.eda_microsiemens);
    if (status === 'relaxed') relaxed++;
    else if (status === 'normal') normal++;
    else if (status === 'elevated') elevated++;
  }

  const total = windowed.length;
  return {
    relaxed: round2((relaxed / total) * 100),
    normal: round2((normal / total) * 100),
    elevated: round2((elevated / total) * 100)
  };
}

export async function fetchStressReactivity(userId, rangeS) {
  // Uses the same event logic as fetchStressEvents
  const events = await fetchStressEvents(userId, rangeS);
  const spikeCount = events.length;

  let reactivityLevel = 'low';
  if (spikeCount > 7) reactivityLevel = 'high';
  else if (spikeCount >= 3) reactivityLevel = 'moderate';

  return {
    spike_count: spikeCount,
    reactivity_level: reactivityLevel
  };
}
