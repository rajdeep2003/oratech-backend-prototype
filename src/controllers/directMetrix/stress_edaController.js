import { resolveUserId } from '../../services/directMetrix/activityAcclerometerService.js';
import * as stressEdaService from '../../services/directMetrix/stress_edaService.js';

function parseRange(rangeStr, defaultS = 300) {
  if (!rangeStr) return defaultS;
  const match = rangeStr.match(/^(\d+)([mhd])$/);
  if (!match) return defaultS;
  const val = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === 'm') return val * 60;
  if (unit === 'h') return val * 60 * 60;
  if (unit === 'd') return val * 24 * 60 * 60;
  return defaultS;
}

export async function getCurrentStress(req, res, next) {
  try {
    const userId = await resolveUserId(req.user.id);
    const data = await stressEdaService.fetchCurrentStress(userId);
    if (!data) return res.status(404).json({ message: 'No stress data found' });
    res.json(data);
  } catch (error) {
    next(error);
  }
}

export async function getStressTrend(req, res, next) {
  try {
    const userId = await resolveUserId(req.user.id);
    const rangeS = parseRange(req.query.range, 5 * 60); // default 5m
    const data = await stressEdaService.fetchStressTrend(userId, rangeS);
    res.json(data);
  } catch (error) {
    next(error);
  }
}

export async function getStressSummary(req, res, next) {
  try {
    const userId = await resolveUserId(req.user.id);
    const rangeS = parseRange(req.query.range, 5 * 60); // default 5m
    const data = await stressEdaService.fetchStressSummary(userId, rangeS);
    if (!data) return res.status(404).json({ message: 'No stress data found' });
    res.json(data);
  } catch (error) {
    next(error);
  }
}

export async function getStressEvents(req, res, next) {
  try {
    const userId = await resolveUserId(req.user.id);
    const rangeS = parseRange(req.query.range, 5 * 60); // default 5m
    const data = await stressEdaService.fetchStressEvents(userId, rangeS);
    res.json(data);
  } catch (error) {
    next(error);
  }
}

export async function getStressDistribution(req, res, next) {
  try {
    const userId = await resolveUserId(req.user.id);
    const rangeS = parseRange(req.query.range, 5 * 60); // default 5m
    const data = await stressEdaService.fetchStressDistribution(userId, rangeS);
    res.json(data);
  } catch (error) {
    next(error);
  }
}

export async function getStressReactivity(req, res, next) {
  try {
    const userId = await resolveUserId(req.user.id);
    const rangeS = parseRange(req.query.range, 5 * 60); // default 5m
    const data = await stressEdaService.fetchStressReactivity(userId, rangeS);
    res.json(data);
  } catch (error) {
    next(error);
  }
}
