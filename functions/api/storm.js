import { cachedJson } from '../../lib/edge.js';
import { buildSnapshot, DEFAULT_STORM_ID, SNAPSHOT_TTL_SECONDS } from '../../lib/snapshot.js';

// GET /api/storm: the merged snapshot of the current advisory.
export const onRequestGet = (context) =>
  cachedJson(context, SNAPSHOT_TTL_SECONDS, () =>
    buildSnapshot(context.env.STORM_ID || DEFAULT_STORM_ID));
