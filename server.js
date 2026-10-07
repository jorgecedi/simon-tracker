#!/usr/bin/env node
// Local server for the dashboard. Zero dependencies (Node 18+).
// In production the same snapshot is served by the Cloudflare Pages Function
// in functions/api/storm.js.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildSnapshot, DEFAULT_STORM_ID, SNAPSHOT_TTL_SECONDS } from './lib/snapshot.js';

const PORT = Number(process.env.PORT || 8790);
const STORM_ID = process.env.STORM_ID || DEFAULT_STORM_ID;

let cached = null;
let cachedAt = 0;
let inFlight = null;

async function getSnapshot() {
  if (cached && Date.now() - cachedAt < SNAPSHOT_TTL_SECONDS * 1000) return cached;
  if (!inFlight) {
    inFlight = buildSnapshot(STORM_ID)
      .then((s) => {
        cached = s;
        cachedAt = Date.now();
        return s;
      })
      .catch((err) => {
        // Keep serving the last good snapshot if NHC is unreachable.
        if (cached) return { ...cached, stale: true, errors: [`feed: ${err.message}`] };
        throw err;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

const INDEX = fileURLToPath(new URL('./public/index.html', import.meta.url));

const handler = async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/api/storm') {
    try {
      const body = JSON.stringify(await getSnapshot());
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  if (pathname === '/' || pathname === '/index.html') {
    fs.readFile(INDEX, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('index.html missing');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(data);
    });
    return;
  }
  res.writeHead(404);
  res.end('not found');
};

// Tailscale addresses live in the CGNAT range 100.64.0.0/10.
function tailscaleAddress() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs) {
      const [first, second] = a.address.split('.').map(Number);
      if (a.family === 'IPv4' && first === 100 && second >= 64 && second <= 127) return a.address;
    }
  }
  return null;
}

http.createServer(handler).listen(PORT, '127.0.0.1', () => {
  console.log(`Tracking ${STORM_ID} at http://localhost:${PORT}`);
});
// Also reachable from the tailnet, without opening the port to the LAN.
const tailnet = tailscaleAddress();
if (tailnet) {
  http.createServer(handler).listen(PORT, tailnet, () => {
    console.log(`Tailscale: http://${tailnet}:${PORT}`);
  });
}
