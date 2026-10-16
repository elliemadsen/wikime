// Shared helpers for the build: cached HTTP, concurrency, Wikipedia title handling.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const CACHE_DIR = path.join(ROOT, 'cache');

const UA = 'Wikime/0.1 (https://github.com/elliemadsen/wikime; personal research map)';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchWithRetry(url, { type = 'json', tries = 5 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': UA, 'Api-User-Agent': UA } });
    } catch (err) {
      if (attempt >= tries) throw err;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.status === 404) return null;
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= tries) throw new Error(`${res.status} for ${url}`);
      const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt;
      await sleep(retryAfter * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} for ${url}`);
    return type === 'json' ? res.json() : res.text();
  }
}

// Disk cache for derived results, keyed by an arbitrary string.
export async function cached(namespace, key, compute) {
  const hash = crypto.createHash('sha1').update(key).digest('hex');
  const file = path.join(CACHE_DIR, namespace, `${hash}.json`);
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {}
  const value = await compute();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value));
  return value;
}

// Run `fn` over `items` with at most `limit` in flight; returns results in order.
export async function pool(items, limit, fn, label) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
      done++;
      if (label && (done % 50 === 0 || done === items.length)) {
        process.stdout.write(`\r  ${label}: ${done}/${items.length}`);
        if (done === items.length) process.stdout.write('\n');
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

// English Wikipedia titles: spaces not underscores, first letter uppercase.
export function normTitle(t) {
  t = t.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function titleFromUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!/(^|\.)wikipedia\.org$/.test(url.hostname)) return null;
  const lang = url.hostname.split('.')[0];
  if (lang !== 'en' && lang !== 'm') return null;
  let t = null;
  if (url.pathname.startsWith('/wiki/')) t = url.pathname.slice(6);
  else if (url.searchParams.get('title')) t = url.searchParams.get('title');
  if (!t) return null;
  try {
    t = decodeURIComponent(t);
  } catch {}
  return normTitle(t);
}

export const wikiPath = (title) => encodeURIComponent(title.replace(/ /g, '_'));
