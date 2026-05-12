import { resolveUserId } from '../../services/directMetrix/activityAcclerometerService.js';
import * as gyroService from '../../services/directMetrix/gyroService.js';

function parseRange(rangeStr, defaultMs = 300_000) {
  if (!rangeStr) return defaultMs;
  const match = rangeStr.match(/^(\d+)([mhd])$/);
  if (!match) return defaultMs;
  const val = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === 'm') return val * 60 * 1000;
  if (unit === 'h') return val * 60 * 60 * 1000;
  if (unit === 'd') return val * 24 * 60 * 60 * 1000;
  return defaultMs;
}

export async function getCurrentGyro(req, res, next) {
  try {
    const userId = await resolveUserId(req.user.id);
    const data = await gyroService.fetchCurrentGyro(userId);
    if (!data) return res.status(404).json({ message: 'No gyroscope data found' });
    res.json(data);
  } catch (error) {
    next(error);
  }
}

export async function getStability(req, res, next) {
  try {
    const userId = await resolveUserId(req.user.id);
    const rangeMs = parseRange(req.query.range, 5 * 60 * 1000); // default 5m
    const data = await gyroService.fetchStabilityTrend(userId, rangeMs);
    res.json(data);
  } catch (error) {
    next(error);
  }
}

export async function getPostureSummary(req, res, next) {
  try {
    const userId = await resolveUserId(req.user.id);
    const rangeMs = parseRange(req.query.range, 60 * 60 * 1000); // default 1h
    const data = await gyroService.fetchPostureSummary(userId, rangeMs);
    if (!data) return res.status(404).json({ message: 'No gyroscope data found' });
    res.json(data);
  } catch (error) {
    next(error);
  }
}

export async function getIntensity(req, res, next) {
  try {
    const userId = await resolveUserId(req.user.id);
    const rangeMs = parseRange(req.query.range, 60 * 60 * 1000); // default 1h
    const data = await gyroService.fetchIntensity(userId, rangeMs);
    if (!data) return res.status(404).json({ message: 'No gyroscope data found' });
    res.json(data);
  } catch (error) {
    next(error);
  }
}

export async function getEvents(req, res, next) {
  try {
    const userId = await resolveUserId(req.user.id);
    const rangeMs = parseRange(req.query.range, 5 * 60 * 1000); // default 5m
    const data = await gyroService.fetchEvents(userId, rangeMs);
    res.json(data);
  } catch (error) {
    next(error);
  }
}

export async function getOrientation(req, res, next) {
  try {
    const userId = await resolveUserId(req.user.id);
    const rangeMs = parseRange(req.query.range, 5 * 60 * 1000); // default 5m
    const data = await gyroService.fetchOrientation(userId, rangeMs);
    res.json(data);
  } catch (error) {
    next(error);
  }
}
