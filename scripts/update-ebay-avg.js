#!/usr/bin/env node
/**
 * update-ebay-avg.js
 *
 * Writes: data/ebay-avg.json
 *
 * - Dual marketplaces: EBAY_US + EBAY_CA
 * - Buy It Now only (FIXED_PRICE) for active listings
 * - Query includes athlete name + sport for accuracy
 * - Skips an athlete if we cannot verify a Player/Athlete match by inspecting actual item aspects
 *   (refinement facets are incomplete and may omit low-frequency names)
 * - Attempts sold averages via Marketplace Insights if the app has access; otherwise sold fields are null
 *
 * Required env:
 *   EBAY_CLIENT_ID
 *   EBAY_CLIENT_SECRET
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

const ATHLETES_PATH = path.join(ROOT, "data", "athletes.json");
const OUTPUT_PATH = path.join(ROOT, "data", "ebay-avg.json");

const EBAY_OAUTH_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const EBAY_BROWSE_SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";
const EBAY_BROWSE_ITEM_URL = "https://api.ebay.com/buy/browse/v1/item/"; // + {item_id}

// Optional (may require special access/approval for your app)
const EBAY_INSIGHTS_SOLD_URL =
  "https://api.ebay.com/buy/marketplace_insights/v1_beta/item_sales/search";

// Trading Card Singles
const CATEGORY_ID = "261328";

// Marketplaces requested
const MARKETPLACES = ["EBAY_US", "EBAY_CA"];

// Tuning
const ACTIVE_PAGES_TO_SCAN = 2; // 2 pages * 50 = up to 100 active listings
const SOLD_PAGES_TO_SCAN = 2; // best-effort
const PAGE_SIZE = 50;

const VALIDATION_ITEM_SAMPLE_SIZE = 6; // how many item IDs to inspect for Player/Athlete aspect
const FETCH_TIMEOUT_MS = 25000;
const MAX_RETRIES = 3;

function readAthletes() {
  const raw = fs.readFileSync(ATHLETES_PATH, "utf8");
  return JSON.parse(raw);
}

function stripDiacritics(s) {
  return (s ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();
}

function norm(s) {
  return stripDiacritics(s).toLowerCase();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url, options = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(t);

      // Retry some transient statuses
      if ([429, 500, 502, 503, 504].includes(res.status) && attempt < MAX_RETRIES) {
        const backoff = 400 * attempt + Math.floor(Math.random() * 300);
        await sleep(backoff);
        continue;
      }

      return res;
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      if (attempt < MAX_RETRIES) {
        const backoff = 400 * attempt + Math.floor(Math.random() * 300);
        await sleep(backoff);
        continue;
      }
    }
  }
  throw lastErr ?? new Error("fetchWithRetry failed");
}

async function getAppToken() {
  const id = process.env.EBAY_CLIENT_ID;
  const secret = process.env.EBAY_CLIENT_SECRET;

  if (!id || !secret) {
    throw new Error(
      "Missing EBAY_CLIENT_ID / EBAY_CLIENT_SECRET env vars. Add them as GitHub Actions secrets."
    );
  }

  const creds = Buffer.from(`${id}:${secret}`).toString("base64");

  const res = await fetchWithRetry(EBAY_OAUTH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${creds}`,
    },
    body: "grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope",
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Failed to get eBay token (${res.status}). ${txt}`);
  }

  const data = await res.json();
  if (!data?.access_token) throw new Error("Failed to get eBay token (no access_token in response)");
  return data.access_token;
}

function buildQuery(name, sport) {
  // Keep it simple and consistent. Sport helps reduce wrong-player results.
  // Example: "Jose Altuve baseball card"
  return `${name} ${sport} card`;
}

/**
 * Validate the athlete by inspecting real item aspects.
 * This solves the issue where the Player/Athlete facet list does NOT include the athlete,
 * even though results contain the athlete (facet lists are truncated).
 */
async function validateByItemAspects({
  token,
  marketplaceId,
  name,
  sport,
  itemIds,
}) {
  const wantName = norm(name);
  const wantSport = norm(sport);

  let sawSportAspect = false;

  for (const itemId of itemIds.slice(0, VALIDATION_ITEM_SAMPLE_SIZE)) {
    const url = `${EBAY_BROWSE_ITEM_URL}${encodeURIComponent(itemId)}`;

    const res = await fetchWithRetry(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": marketplaceId,
      },
    });

    if (!res.ok) {
      // If some items fail, keep trying others
      continue;
    }

    const data = await res.json();

    // eBay returns aspects in a couple possible shapes; handle common ones.
    // Typical: data.localizedAspects = [{ name: "Player/Athlete", value: "..." }, ...]
    const localizedAspects = Array.isArray(data?.localizedAspects) ? data.localizedAspects : [];

    const getAspectValues = (aspectName) => {
      const vals = [];
      for (const a of localizedAspects) {
        const n = a?.name ?? a?.localizedName ?? a?.aspectName;
        const v = a?.value ?? a?.localizedValue ?? a?.aspectValue;
        if (n && v && norm(n) === norm(aspectName)) vals.push(String(v));
      }
      return vals;
    };

    const players = getAspectValues("Player/Athlete").map(norm);
    const sports = getAspectValues("Sport").map(norm);

    if (sports.length) sawSportAspect = true;

    const nameMatch = players.some((p) => p === wantName);
    // If sport aspect exists on this item, require it to match; otherwise don't block.
    const sportMatch = !sports.length ? true : sports.some((s) => s === wantSport);

    if (nameMatch && sportMatch) return { ok: true, sawSportAspect };
  }

  // If we saw sport aspects at all during validation and none matched, it's likely wrong sport.
  // Still treat as failed validation (skip) because user requested accuracy.
  return { ok: false, sawSportAspect };
}

async function fetchActiveListingAvg({ token, name, sport, marketplaceId }) {
  const prices = [];
  const sampleItemIds = [];

  for (let page = 0; page < ACTIVE_PAGES_TO_SCAN; page++) {
    const url = new URL(EBAY_BROWSE_SEARCH_URL);
    url.searchParams.set("q", buildQuery(name, sport));
    url.searchParams.set("category_ids", CATEGORY_ID);
    url.searchParams.set("limit", String(PAGE_SIZE));
    url.searchParams.set("offset", String(page * PAGE_SIZE));

    // Buy It Now only; exclude auctions
    url.searchParams.set("filter", "buyingOptions:{FIXED_PRICE}");

    const res = await fetchWithRetry(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": marketplaceId,
      },
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Browse search error ${res.status} (${marketplaceId}): ${txt}`);
    }

    const data = await res.json();
    const items = Array.isArray(data?.itemSummaries) ? data.itemSummaries : [];

    for (const item of items) {
      const p = Number(item?.price?.value);
      if (Number.isFinite(p)) prices.push(p);

      // Collect a few item IDs for validation
      if (sampleItemIds.length < VALIDATION_ITEM_SAMPLE_SIZE * 2) {
        const id = item?.itemId;
        if (id) sampleItemIds.push(id);
      }
    }

    if (!data?.next) break;
  }

  // Validate identity using item aspects (not facet lists)
  const validation = await validateByItemAspects({
    token,
    marketplaceId,
    name,
    sport,
    itemIds: sampleItemIds,
  });

  if (!validation.ok) {
    return {
      passed: false,
      avg: null,
      count: 0,
    };
  }

  if (!prices.length) {
    return {
      passed: true,
      avg: null,
      count: 0,
    };
  }

  const avg = prices.reduce((s, v) => s + v, 0) / prices.length;
  return {
    passed: true,
    avg,
    count: prices.length,
  };
}

async function fetchSoldAvgBestEffort({ token, name, sport, marketplaceId }) {
  // Best effort: many apps don't have Marketplace Insights access.
  // If forbidden, return nulls without failing the script.
  try {
    const prices = [];
    const sampleItemIds = [];

    for (let page = 0; page < SOLD_PAGES_TO_SCAN; page++) {
      const url = new URL(EBAY_INSIGHTS_SOLD_URL);
      url.searchParams.set("q", buildQuery(name, sport));
      url.searchParams.set("category_ids", CATEGORY_ID);
      url.searchParams.set("limit", String(PAGE_SIZE));
      url.searchParams.set("offset", String(page * PAGE_SIZE));

      // The insights API also supports filter, but support varies; keep it minimal.
      // We still validate via item aspects on a sample of returned items if possible.
      const res = await fetchWithRetry(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-EBAY-C-MARKETPLACE-ID": marketplaceId,
        },
      });

      if (res.status === 401 || res.status === 403) {
        // No access — do not fail workflow
        return { supported: false, avg: null, count: 0 };
      }

      if (!res.ok) {
        // Other errors: also avoid failing the workflow, but note it's supported.
        return { supported: true, avg: null, count: 0 };
      }

      const data = await res.json();
      const items = Array.isArray(data?.itemSales) ? data.itemSales : Array.isArray(data?.itemSummaries) ? data.itemSummaries : [];

      for (const item of items) {
        // Marketplace Insights commonly returns price in item.price.value, but handle a few shapes.
        const p =
          Number(item?.price?.value) ||
          Number(item?.transactionPrice?.value) ||
          Number(item?.salePrice?.value);

        if (Number.isFinite(p)) prices.push(p);

        if (sampleItemIds.length < VALIDATION_ITEM_SAMPLE_SIZE * 2) {
          const id = item?.itemId;
          if (id) sampleItemIds.push(id);
        }
      }

      if (!data?.next) break;
    }

    // If we got itemIds, validate identity like we do for active listings
    if (sampleItemIds.length) {
      const validation = await validateByItemAspects({
        token,
        marketplaceId,
        name,
        sport,
        itemIds: sampleItemIds,
      });
      if (!validation.ok) return { supported: true, avg: null, count: 0 };
    }

    if (!prices.length) return { supported: true, avg: null, count: 0 };

    const avg = prices.reduce((s, v) => s + v, 0) / prices.length;
    return { supported: true, avg, count: prices.length };
  } catch {
    return { supported: false, avg: null, count: 0 };
  }
}

async function main() {
  const athletes = readAthletes();
  const token = await getAppToken();

  const out = {};
  const asOf = new Date().toISOString();

  for (let i = 0; i < athletes.length; i++) {
    const athlete = athletes[i] ?? {};
    const name = athlete.name;
    const sport = athlete.sport;

    if (!name || !sport) continue;

    console.log(`[${i + 1}/${athletes.length}] ${name}`);

    const active = {};
    const sold = {};
    let passedAnyMarketplace = false;

    for (const marketplaceId of MARKETPLACES) {
      // Active listing avg (Buy It Now only)
      const a = await fetchActiveListingAvg({ token, name, sport, marketplaceId });

      active[marketplaceId] = {
        avg: a.avg,
        count: a.count,
      };

      // Sold avg (best effort)
      const s = await fetchSoldAvgBestEffort({ token, name, sport, marketplaceId });
      sold[marketplaceId] = {
        avg: s.avg,
        count: s.count,
        supported: s.supported,
      };

      if (a.passed) passedAnyMarketplace = true;
    }

    // If we cannot validate Player/Athlete for BOTH marketplaces, skip (per your rule)
    if (!passedAnyMarketplace) {
      console.log(`${name}: SKIPPED (no Player/Athlete match via item aspects)`);
      continue;
    }

    out[name] = {
      sport,
      asOf,
      query: buildQuery(name, sport),
      activeListing: active,
      sold: sold,
      method: {
        activeListing: "mean(FIXED_PRICE only)",
        sold: "mean(marketplace_insights best-effort)",
        validation: "Player/Athlete match via /buy/browse/v1/item/{id} localizedAspects",
      },
    };
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
