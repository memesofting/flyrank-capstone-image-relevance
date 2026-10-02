/**
 * Health controller: HTTP orchestration only.
 */

import { SERVICE_VERSION } from '../config/constants.js';
import * as healthService from '../services/health.service.js';

/** GET /health */
export function getLiveness(_req, res) {
  res.status(200).json({
    ...healthService.liveness(),
    version: SERVICE_VERSION,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
}

/** GET /health/ready */
export async function getReadiness(_req, res) {
  const readiness = await healthService.readiness();
  res.status(readiness.status === 'ok' ? 200 : 503).json(readiness);
}
