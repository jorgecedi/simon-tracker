# simon-tracker

Live dashboard for Tropical Depression Twenty-E / Simon (East Pacific, 2026), built on
public [National Hurricane Center](https://www.nhc.noaa.gov/) data. The UI is in Spanish.

It shows the forecast track and cone, current intensity, the intensity forecast, the
closest approach of the forecast center to cities on Mexico's Pacific coast, and the
public advisory. It refreshes every 10 minutes.

Informational only. For safety decisions follow the NHC, SMN/CONAGUA and Protección Civil.

## How it works

- `public/index.html` is the whole frontend (Leaflet map, hand-rolled SVG chart).
- `lib/snapshot.js` fetches the NHC feeds and merges them into one JSON snapshot.
  NHC text products do not send CORS headers, so this has to run server-side.
- `functions/api/storm.js` serves that snapshot as a Cloudflare Pages Function.
- `server.js` serves the same thing locally with no dependencies.

The storm is tracked by its ATCF id (`ep202026`), which does not change when it is named.
Set `STORM_ID` to follow a different system.

## Run locally

```sh
node server.js          # http://localhost:8790
```

## Deploy

```sh
npx wrangler pages deploy
```
