import { cachedJson } from '../../lib/edge.js';
import { buildForecastArchive, DEFAULT_STORM_ID, ARCHIVE_TTL_SECONDS } from '../../lib/snapshot.js';

// GET /api/forecasts: every archived forecast advisory, for forecast verification.
export const onRequestGet = (context) =>
  cachedJson(context, ARCHIVE_TTL_SECONDS, () =>
    buildForecastArchive(context.env.STORM_ID || DEFAULT_STORM_ID));
