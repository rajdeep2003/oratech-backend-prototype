import {
  resolveUserId,
  fetchCurrentPPG,
  fetchSignalTrend,
  fetchWearDetection,
  fetchQualitySummary,
  fetchArtifacts,
  fetchReliabilityScore
} from '../../services/directMetrix/ppg_Skin_contact_Service.js';

function parseRangeMs(rangeStr, defaultHours = 1) {
  if (!rangeStr) return defaultHours * 60 * 60 * 1000;
  const match = rangeStr.match(/^(\d+)([mhd])$/);
  if (!match) return defaultHours * 60 * 60 * 1000;
  
  const val = parseInt(match[1], 10);
  const unit = match[2];
  
  if (unit === 'm') return val * 60 * 1000;
  if (unit === 'h') return val * 60 * 60 * 1000;
  if (unit === 'd') return val * 24 * 60 * 60 * 1000;
  
  return defaultHours * 60 * 60 * 1000;
}

export async function getCurrentPPG(req, res) {
  try {
    const userId = await resolveUserId(req.user.id);
    const data = await fetchCurrentPPG(userId);
    res.json(data);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
}

export async function getSignalTrend(req, res) {
  try {
    const userId = await resolveUserId(req.user.id);
    const rangeMs = parseRangeMs(req.query.range, 1); // default 1h
    const data = await fetchSignalTrend(userId, rangeMs);
    res.json(data);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
}

export async function getWearDetection(req, res) {
  try {
    const userId = await resolveUserId(req.user.id);
    const rangeMs = parseRangeMs(req.query.range, 24); // default 24h
    const data = await fetchWearDetection(userId, rangeMs);
    res.json(data);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
}

export async function getQualitySummary(req, res) {
  try {
    const userId = await resolveUserId(req.user.id);
    const rangeMs = parseRangeMs(req.query.range, 24); // default 24h
    const data = await fetchQualitySummary(userId, rangeMs);
    res.json(data);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
}

export async function getArtifacts(req, res) {
  try {
    const userId = await resolveUserId(req.user.id);
    const rangeMs = parseRangeMs(req.query.range, 1); // default 1h
    const data = await fetchArtifacts(userId, rangeMs);
    res.json({ count: data.length, events: data });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
}

export async function getReliabilityScore(req, res) {
  try {
    const userId = await resolveUserId(req.user.id);
    const rangeMs = parseRangeMs(req.query.range, 24); // default 24h
    const data = await fetchReliabilityScore(userId, rangeMs);
    res.json(data);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
}
