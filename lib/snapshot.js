// Builds one JSON snapshot of an NHC tropical cyclone from the public NHC feeds.
// Uses only fetch, so it runs both in Node (server.js) and in a Cloudflare Pages Function.

// The ATCF id stays the same when the depression is named (Twenty-E -> Simon).
export const DEFAULT_STORM_ID = 'ep202026';
export const SNAPSHOT_TTL_SECONDS = 300;

const NHC = 'https://www.nhc.noaa.gov';
const MAPSERVER =
  'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer';

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'tracker-huracanes (personal dashboard)' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

const fetchJson = async (url) => JSON.parse(await fetchText(url));

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

// NHC text products are .shtml pages with the bulletin inside a <pre> block.
async function fetchProduct(url) {
  const html = await fetchText(url);
  const m = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  if (!m) throw new Error(`no <pre> block in ${url}`);
  return decodeEntities(m[1]).replace(/\r/g, '').trim();
}

// Bulletins give times as day/hour only ("08/0000Z"); anchor them to the issuance.
export function resolveDayHour(baseMs, day, hour, minute = 0) {
  const base = new Date(baseMs);
  let t = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), day, hour, minute);
  if (t < baseMs - 5 * 86400000) {
    t = Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, day, hour, minute);
  }
  return t;
}

export function parseForecastAdvisory(text, issuanceMs) {
  const out = { points: [], gustKt: null, nextAdvisory: null, forecaster: null };

  const gust = text.match(/MAX SUSTAINED WINDS\s+(\d+) KT WITH GUSTS TO\s+(\d+) KT/);
  if (gust) out.gustKt = Number(gust[2]);

  const next = text.match(/NEXT ADVISORY AT (\d{2})\/(\d{2})(\d{2})Z/);
  if (next) {
    out.nextAdvisory = new Date(
      resolveDayHour(issuanceMs, Number(next[1]), Number(next[2]), Number(next[3]))
    ).toISOString();
  }

  const who = text.match(/FORECASTER (.+)/);
  if (who) out.forecaster = who[1].trim();

  const blocks = text.split(/\n(?=(?:FORECAST|OUTLOOK) VALID )/).slice(1);
  for (const block of blocks) {
    const head = block.match(
      /^(?:FORECAST|OUTLOOK) VALID (\d{2})\/(\d{2})(\d{2})Z(?:\s+(\d+\.\d)([NS])\s+(\d+\.\d)([EW]))?(?:\.\.\.(.+))?/
    );
    if (!head) continue;
    const validMs = resolveDayHour(issuanceMs, Number(head[1]), Number(head[2]), Number(head[3]));
    const wind = block.match(/MAX WIND\s+(\d+) KT\.\.\.GUSTS\s+(\d+) KT/);
    out.points.push({
      valid: new Date(validMs).toISOString(),
      tau: Math.round((validMs - issuanceMs) / 3600000),
      lat: head[4] ? Number(head[4]) * (head[5] === 'S' ? -1 : 1) : null,
      lon: head[6] ? Number(head[6]) * (head[7] === 'W' ? -1 : 1) : null,
      windKt: wind ? Number(wind[1]) : null,
      gustKt: wind ? Number(wind[2]) : null,
      // e.g. INLAND, POST-TROP/REMNT LOW, DISSIPATED
      status: head[8] ? head[8].trim() : null,
    });
  }
  return out;
}

// Splits a public advisory into its dash-underlined sections.
export function parsePublicAdvisory(text) {
  const lines = text.split('\n');
  const sections = [];
  let current = null;
  const headline = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^-{5,}\s*$/.test(lines[i + 1] || '')) {
      current = { title: line.trim(), body: [] };
      sections.push(current);
      i++;
      continue;
    }
    if (/^\$\$/.test(line)) break;
    if (current) current.body.push(line);
    else if (/^\.\.\./.test(line)) headline.push(line.replace(/\.\.\./g, ' ').trim());
  }
  return {
    headline: headline.join(' · '),
    sections: sections.map((s) => ({ title: s.title, body: s.body.join('\n').trim() })),
  };
}

// ATCF b-deck: one CSV row per synoptic time and wind radius.
export function parseBestTrack(text) {
  const byTime = new Map();
  for (const line of text.split('\n')) {
    const c = line.split(',').map((s) => s.trim());
    if (c.length < 11 || !/^\d{10}$/.test(c[2])) continue;
    const t = c[2];
    const lat = (Number(c[6].slice(0, -1)) / 10) * (c[6].endsWith('S') ? -1 : 1);
    const lon = (Number(c[7].slice(0, -1)) / 10) * (c[7].endsWith('W') ? -1 : 1);
    byTime.set(t, {
      time: new Date(
        Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8), +t.slice(8, 10))
      ).toISOString(),
      lat,
      lon,
      windKt: Number(c[8]) || null,
      pressureMb: Number(c[9]) || null,
      type: c[10],
      name: c[27] || null,
    });
  }
  return [...byTime.values()].sort((a, b) => a.time.localeCompare(b.time));
}

let layerIndex = null;
async function layerId(name) {
  if (!layerIndex) {
    const info = await fetchJson(`${MAPSERVER}?f=json`);
    layerIndex = new Map(info.layers.map((l) => [l.name, l.id]));
  }
  const id = layerIndex.get(name);
  if (id === undefined) throw new Error(`map layer not found: ${name}`);
  return id;
}

async function fetchLayer(name) {
  const id = await layerId(name);
  return fetchJson(
    `${MAPSERVER}/${id}/query?where=1%3D1&outFields=*&f=geojson&geometryPrecision=3`
  );
}

export async function buildSnapshot(stormId = DEFAULT_STORM_ID) {
  const id = stormId.toLowerCase();
  const snapshot = {
    stormId: id,
    fetchedAt: new Date().toISOString(),
    active: false,
    errors: [],
  };

  const feed = await fetchJson(`${NHC}/CurrentStorms.json`);
  const storms = feed.activeStorms || [];
  snapshot.otherStorms = storms
    .filter((s) => s.id !== id)
    .map((s) => ({ id: s.id, name: s.name, classification: s.classification }));

  const basin = id.slice(0, 2);
  const tasks = {
    history: () =>
      fetchText(`https://ftp.nhc.noaa.gov/atcf/btk/b${id}.dat`).then(parseBestTrack),
  };

  const storm = storms.find((s) => s.id === id);
  if (storm) {
    snapshot.active = true;
    snapshot.current = {
      name: storm.name,
      classification: storm.classification,
      windKt: Number(storm.intensity),
      pressureMb: Number(storm.pressure),
      lat: storm.latitudeNumeric,
      lon: storm.longitudeNumeric,
      movementDir: storm.movementDir,
      movementKt: storm.movementSpeed,
      lastUpdate: storm.lastUpdate,
      advisoryNumber: storm.publicAdvisory && storm.publicAdvisory.advNum,
      advisoryIssued: storm.publicAdvisory && storm.publicAdvisory.issuance,
    };
    snapshot.links = {
      publicAdvisory: storm.publicAdvisory && storm.publicAdvisory.url,
      forecastAdvisory: storm.forecastAdvisory && storm.forecastAdvisory.url,
      discussion: storm.forecastDiscussion && storm.forecastDiscussion.url,
      graphics: storm.forecastGraphics && storm.forecastGraphics.url,
    };

    const bin = storm.binNumber;
    if (storm.forecastAdvisory) {
      const issued = Date.parse(storm.forecastAdvisory.issuance);
      tasks.forecast = async () => ({
        advisoryNumber: storm.forecastAdvisory.advNum,
        issued: storm.forecastAdvisory.issuance,
        ...parseForecastAdvisory(await fetchProduct(storm.forecastAdvisory.url), issued),
      });
    }
    if (storm.publicAdvisory) {
      const url = storm.publicAdvisory.url;
      tasks.advisory = async () => {
        const text = await fetchProduct(url);
        return { text, ...parsePublicAdvisory(text) };
      };
      // Spanish translation of the public advisory (TCP -> TAS product).
      // It is published a while after the English one, so skip it while it is still the previous advisory.
      tasks.advisoryEs = async () => {
        const text = await fetchProduct(url.replace('TCP', 'TAS'));
        const number = text.match(/Advertencia N[uú]mero\s+(\d+[A-Za-z]?)/i);
        const current = String(storm.publicAdvisory.advNum).replace(/^0+/, '');
        if (!number || number[1].toLowerCase() !== current.toLowerCase()) return null;
        return { text, ...parsePublicAdvisory(text) };
      };
    }
    if (storm.forecastDiscussion) {
      tasks.discussion = () => fetchProduct(storm.forecastDiscussion.url);
    }
    tasks.cone = () => fetchLayer(`${bin} Forecast Cone`);
    tasks.watchesWarnings = () => fetchLayer(`${bin} Watch-Warning`);
  }

  const names = Object.keys(tasks);
  const results = await Promise.allSettled(names.map((n) => tasks[n]()));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') snapshot[names[i]] = r.value;
    else snapshot.errors.push(`${names[i]}: ${r.reason.message}`);
  });
  snapshot.basin = basin;
  return snapshot;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
export const ARCHIVE_TTL_SECONDS = 600;
// Stays under the 50-subrequest limit of a Cloudflare Pages Function.
const MAX_ARCHIVED_ADVISORIES = 45;

// Header line of a forecast advisory, e.g. "1500 UTC WED OCT 07 2026".
export function parseIssuance(text) {
  const m = text.match(/^(\d{2})(\d{2}) UTC \w{3} (\w{3}) (\d{2}) (\d{4})/m);
  if (!m) return null;
  const month = MONTHS.indexOf(m[3]);
  if (month < 0) return null;
  return Date.UTC(Number(m[5]), month, Number(m[4]), Number(m[1]), Number(m[2]));
}

// Every forecast advisory NHC has issued for the storm, read from its public
// archive, so past forecasts can be verified against the observed track.
export async function buildForecastArchive(stormId = DEFAULT_STORM_ID) {
  const id = stormId.toLowerCase();
  const dir = `${NHC}/archive/${id.slice(4)}/${id.slice(0, 4)}`;

  let latest = MAX_ARCHIVED_ADVISORIES;
  try {
    const feed = await fetchJson(`${NHC}/CurrentStorms.json`);
    const storm = (feed.activeStorms || []).find((s) => s.id === id);
    const n = storm && storm.forecastAdvisory && Number.parseInt(storm.forecastAdvisory.advNum, 10);
    if (n) latest = Math.min(n, MAX_ARCHIVED_ADVISORIES);
  } catch {
    // Without the feed, probe every advisory number; missing ones just 404.
  }

  const numbers = Array.from({ length: latest }, (_, i) => i + 1);
  const results = await Promise.allSettled(
    numbers.map(async (n) => {
      const text = await fetchProduct(`${dir}/${id}.fstadv.${String(n).padStart(3, '0')}.shtml`);
      const issuedMs = parseIssuance(text);
      if (issuedMs === null) throw new Error(`no issuance time in advisory ${n}`);
      const { points } = parseForecastAdvisory(text, issuedMs);
      return { advisoryNumber: n, issued: new Date(issuedMs).toISOString(), points };
    })
  );
  return {
    stormId: id,
    fetchedAt: new Date().toISOString(),
    advisories: results.filter((r) => r.status === 'fulfilled').map((r) => r.value),
  };
}
