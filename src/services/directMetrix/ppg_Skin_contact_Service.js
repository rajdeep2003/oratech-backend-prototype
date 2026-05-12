import { supabase } from '../../database/supabaseClient.js';

const FETCH_LIMIT = 10000;
const MAX_TREND_POINTS = 200;

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

async function fetchAllRows(userId) {
  const { data, error } = await supabase
    .from('skin_contact')
    .select('*')
    .eq('user_id', userId)
    .order('timestamp', { ascending: false })
    .limit(FETCH_LIMIT);

  if (error) throw error;
  return (data || []).reverse(); // oldest to newest
}

function applyTimeWindow(rows, rangeMs) {
  if (!rows || rows.length === 0) return [];
  const newestMs = new Date(rows[rows.length - 1].timestamp).getTime();
  const cutoffMs = newestMs - rangeMs;
  return rows.filter((r) => new Date(r.timestamp).getTime() >= cutoffMs);
}

function determineSignalQuality(row) {
  if (row.wearing_status === 'OFF_WRIST' || row.contact_detected === false) {
    return 'off';
  }
  const conf = row.contact_confidence ?? 0;
  if (conf > 90 && row.motion_artifact !== true) {
    return 'good';
  } else if (conf >= 70 && conf <= 90) {
    return 'medium';
  } else if (conf < 70) {
    return 'poor';
  }
  return 'poor';
}

function isValid(row, excludeMotionArtifact = false) {
  if (row.contact_detected === false) return false;
  if (row.wearing_status === 'OFF_WRIST') return false;
  if ((row.contact_confidence ?? 0) < 50) return false;
  if (excludeMotionArtifact && row.motion_artifact === true) return false;
  return true;
}

export async function fetchCurrentPPG(userId) {
  const rows = await fetchAllRows(userId);
  const windowed = applyTimeWindow(rows, 5 * 60 * 1000); // 5 minutes
  const validRows = windowed.filter(r => isValid(r, true)); // motion_artifact excluded for metrics

  if (validRows.length === 0) {
    return {
      wearing: false,
      signal_quality: 'no_signal',
      confidence: 0,
      perfusion_index: 0,
      status: 'no_signal',
      timestamp: windowed.length > 0 ? windowed[windowed.length - 1].timestamp : new Date().toISOString()
    };
  }

  const latest = validRows[validRows.length - 1];
  const confs = validRows.map(r => r.contact_confidence || 0);
  const avgConf = confs.reduce((a, b) => a + b, 0) / confs.length;
  
  const pis = validRows.map(r => r.perfusion_index || 0);
  const avgPi = pis.reduce((a, b) => a + b, 0) / pis.length;

  const signalQuality = determineSignalQuality(latest);
  let status = 'unstable';
  if (signalQuality === 'good' && avgConf > 90) {
    status = 'reliable';
  } else if (signalQuality === 'off') {
    status = 'no_signal';
  }

  return {
    wearing: latest.wearing_status === 'ON_WRIST',
    signal_quality: signalQuality,
    confidence: Math.round(avgConf * 100) / 100,
    perfusion_index: Math.round(avgPi * 100) / 100,
    status,
    timestamp: latest.timestamp
  };
}

export async function fetchSignalTrend(userId, rangeMs) {
  const rows = await fetchAllRows(userId);
  const windowed = applyTimeWindow(rows, rangeMs);
  const validRows = windowed.filter(r => isValid(r, true)); // Exclude motion for metrics

  // Bucket into 5-minute intervals
  const buckets = new Map();
  for (const row of validRows) {
    const timeMs = new Date(row.timestamp).getTime();
    const bucketTime = Math.floor(timeMs / (5 * 60 * 1000)) * (5 * 60 * 1000);
    if (!buckets.has(bucketTime)) {
      buckets.set(bucketTime, []);
    }
    buckets.get(bucketTime).push(row);
  }

  const trend = [];
  for (const [timeMs, bucketRows] of buckets.entries()) {
    const pis = bucketRows.map(r => r.perfusion_index || 0);
    const avgPi = pis.reduce((a, b) => a + b, 0) / pis.length;
    const lastRow = bucketRows[bucketRows.length - 1];
    
    trend.push({
      timestamp: new Date(timeMs).toISOString(),
      perfusion_index: Math.round(avgPi * 100) / 100,
      signal_quality: determineSignalQuality(lastRow)
    });
  }

  trend.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  if (trend.length <= MAX_TREND_POINTS) {
    return trend;
  }
  const step = Math.ceil(trend.length / MAX_TREND_POINTS);
  return trend.filter((_, i) => i % step === 0);
}

export async function fetchWearDetection(userId, rangeMs) {
  const rows = await fetchAllRows(userId);
  const windowed = applyTimeWindow(rows, rangeMs);

  let onWristRows = 0;
  let offWristRows = 0;

  for (const row of windowed) {
    if (row.wearing_status === 'ON_WRIST') {
      onWristRows++;
    } else {
      offWristRows++;
    }
  }

  const totalRows = windowed.length;
  const wearCompliance = totalRows > 0 ? (onWristRows / totalRows) * 100 : 0;

  return {
    total_on_wrist_duration_min: onWristRows * 5,
    total_off_wrist_duration_min: offWristRows * 5,
    wear_compliance_percent: Math.round(wearCompliance * 100) / 100
  };
}

export async function fetchQualitySummary(userId, rangeMs) {
  const rows = await fetchAllRows(userId);
  const windowed = applyTimeWindow(rows, rangeMs);
  const validRows = windowed.filter(r => isValid(r, false)); // use valid data

  let good = 0;
  let medium = 0;
  let poor = 0;

  for (const row of validRows) {
    const quality = determineSignalQuality(row);
    if (quality === 'good') good++;
    else if (quality === 'medium') medium++;
    else if (quality === 'poor') poor++;
  }

  const total = good + medium + poor;
  if (total === 0) return { good: 0, medium: 0, poor: 0 };

  return {
    good: Math.round((good / total) * 100 * 100) / 100,
    medium: Math.round((medium / total) * 100 * 100) / 100,
    poor: Math.round((poor / total) * 100 * 100) / 100
  };
}

export async function fetchArtifacts(userId, rangeMs) {
  const rows = await fetchAllRows(userId);
  const windowed = applyTimeWindow(rows, rangeMs);

  const events = [];
  let lastEventMs = 0;
  const DEBOUNCE_MS = 2 * 60 * 1000;

  for (const row of windowed) {
    if (row.motion_artifact === true) {
      const currentMs = new Date(row.timestamp).getTime();
      if (currentMs - lastEventMs >= DEBOUNCE_MS) {
        events.push({ timestamp: row.timestamp, type: 'motion_artifact' });
        lastEventMs = currentMs;
      }
    }
  }

  return events;
}

export async function fetchReliabilityScore(userId, rangeMs) {
  const rows = await fetchAllRows(userId);
  const windowed = applyTimeWindow(rows, rangeMs);
  
  if (windowed.length === 0) {
    return { score: 0, level: 'low', message: 'No data available' };
  }

  const validRows = windowed.filter(r => isValid(r, false));
  const validRatio = validRows.length / windowed.length;

  const confs = windowed.map(r => r.contact_confidence ?? 0);
  const avgConf = confs.reduce((a, b) => a + b, 0) / (confs.length || 1);
  const normalizedConf = avgConf / 100;

  const onWristRows = windowed.filter(r => r.wearing_status === 'ON_WRIST').length;
  const wearRatio = onWristRows / windowed.length;

  const score = (validRatio * 40) + (normalizedConf * 30) + (wearRatio * 30);
  const roundedScore = Math.round(score * 100) / 100;

  let level = 'low';
  let message = 'Signal reliability is low. Please adjust the device fit.';
  if (roundedScore > 75) {
    level = 'high';
    message = 'Signal reliability is high. Excellent device fit.';
  } else if (roundedScore >= 50) {
    level = 'medium';
    message = 'Signal reliability is acceptable. Ensure the device is snug.';
  }

  return {
    score: roundedScore,
    level,
    message,
    metrics: {
      valid_ratio: Math.round(validRatio * 100) / 100,
      avg_confidence: Math.round(avgConf * 100) / 100,
      wear_ratio: Math.round(wearRatio * 100) / 100
    }
  };
}
