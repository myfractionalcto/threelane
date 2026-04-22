import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { net } from 'electron';

/**
 * Public wildcard cert for `*.local-ip.sh`.
 *
 * The local-ip.sh project (https://local-ip.sh) runs a public DNS zone that
 * resolves `a-b-c-d.local-ip.sh` → `a.b.c.d`, AND publishes a Let's Encrypt
 * wildcard cert + key for `*.local-ip.sh` with the private key deliberately
 * public. That lets a local HTTPS server serve a cert that any phone browser
 * trusts out of the box — no CA profile install, no SSL warning — so long
 * as the phone resolved the hostname first (see the caveats below).
 *
 * Why shipping a "public" private key is acceptable here: the hostname only
 * resolves to private/LAN IPs, so an attacker who holds the key can only
 * MITM a connection to a LAN IP — which requires being on the victim's LAN
 * already, where ARP/DNS spoofing was trivially possible anyway. Security
 * posture matches plain-LAN.
 *
 * Caveats the caller should handle:
 *  - First resolution on the phone needs internet. After that, the media
 *    connection is pure LAN and survives losing the uplink.
 *  - Some resolvers (Pi-hole, UniFi with DNS rebinding protection, AdGuard
 *    Home, some enterprise WiFi) strip private-IP answers from public DNS.
 *    Those networks fall through to the local-CA flow we already ship.
 *  - Cert rotates ~every 60 days. We fetch on every boot and cache; if
 *    refresh fails we keep using the stale cert until it actually expires
 *    (still serves fine for 30+ days of grace).
 */

const CERT_URL = 'https://local-ip.sh/server.pem';
const KEY_URL = 'https://local-ip.sh/server.key';
const CACHE_FILE = 'local-ip-cert.json';
/** Re-fetch if the cached copy is older than this. LE certs renew ~monthly;
 *  a day is plenty of slack and keeps us from hammering the service. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface PublicCert {
  cert: string;
  key: string;
  fetchedAtMs: number;
}

function cachePath(): string {
  return path.join(app.getPath('userData'), CACHE_FILE);
}

async function readCache(): Promise<PublicCert | null> {
  try {
    const raw = await fs.readFile(cachePath(), 'utf8');
    const parsed = JSON.parse(raw) as PublicCert;
    if (!parsed.cert || !parsed.key) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(c: PublicCert): Promise<void> {
  await fs.writeFile(cachePath(), JSON.stringify(c), 'utf8');
}

/** Fetch a URL as text using Electron's `net` module (honors proxy, works
 *  before `app.ready` fires, no dep on global fetch polyfills). */
async function fetchText(url: string, timeoutMs = 10_000): Promise<string> {
  const res = await Promise.race([
    net.fetch(url),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`fetch ${url} timed out`)), timeoutMs),
    ),
  ]);
  if (!res.ok) throw new Error(`fetch ${url} → HTTP ${res.status}`);
  return res.text();
}

/**
 * Get a usable public cert, preferring fresh-from-network but falling back
 * to a cached copy (even stale) if the network fails. Returns null when we
 * have nothing at all — the caller then falls back to the local CA.
 */
export async function getPublicCert(): Promise<PublicCert | null> {
  const cached = await readCache();
  const isFresh = cached && Date.now() - cached.fetchedAtMs < STALE_AFTER_MS;
  if (isFresh) return cached;

  try {
    const [cert, key] = await Promise.all([fetchText(CERT_URL), fetchText(KEY_URL)]);
    // Light sanity check so we don't write a 404 page into the cache.
    if (!cert.includes('BEGIN CERTIFICATE') || !key.includes('PRIVATE KEY')) {
      throw new Error('downloaded payload does not look like PEM');
    }
    const fresh: PublicCert = { cert, key, fetchedAtMs: Date.now() };
    await writeCache(fresh);
    return fresh;
  } catch (e) {
    if (cached) {
      console.warn(
        `[public-cert] refresh failed, using cached copy from ${new Date(cached.fetchedAtMs).toISOString()}:`,
        e instanceof Error ? e.message : e,
      );
      return cached;
    }
    console.warn('[public-cert] fetch failed and no cache available:', e);
    return null;
  }
}

/**
 * Encode a LAN IPv4 into the local-ip.sh hostname form.
 * `192.168.1.23` → `192-168-1-23.local-ip.sh`
 *
 * The wildcard cert only covers one DNS label (`*.local-ip.sh`), so dots
 * in the IP must be replaced with dashes — `192.168.1.23.local-ip.sh`
 * would not match.
 */
export function hostnameForIp(ip: string): string {
  return `${ip.replace(/\./g, '-')}.local-ip.sh`;
}
