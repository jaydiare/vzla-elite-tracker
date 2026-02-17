#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const ATHLETES_PATH = path.join(ROOT, "data", "athletes.json");
const OUTPUT_PATH = path.join(ROOT, "data", "ebay-avg.json");

const EBAY_OAUTH_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const EBAY_BROWSE_SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";

// Trading Card Singles (your previous script used 261328)
const CATEGORY_ID = "261328";

// Marketplaces requested
const MARKETPLACES = ["EBAY_US", "EBAY_CA"];

// ---- Helpers ----
function readAthletes() {
  return JSON.parse(fs.readFileSync(ATHLETES_PATH, "utf8"));
}

function normalize(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ") // remove punctuation
    .replace(/\s+/g, " ")
    .trim();
}

function approxNameVariants(name) {
  // Keep it conservative: just handle diacritics/punctuation + common suffix punctuation,
  // not fuzzy guessing (since user wants to skip if no real match).
  const base = normalize(name);
  const variants = new Set([base]);

  // Jr / Sr variants (Ronald Acuña Jr. type)
  variants.add(base.replace(/\bjr\b/g, "jr."));
  variants.add(base.replace(/\bjr\.\b/g, "jr"));
  variants.add(base.replace(/\bsr\b/g, "sr."));
  variants.add(base.replace(/\bsr\.\b/g, "sr"));

  return [...variants].filter(Boolean);
}

function aspectContains(refinement, aspectName, expectedValue) {
  const expectedVariants = approxNameVariants(expectedValue);
  const targetAspect = normalize(aspectName);

  const distributions = refinement?.aspectDistributions || [];
  for (const ad of distributions) {
    if (normalize(ad.localizedAspectName) !== targetAspect) continue;

    for (const vd of ad.aspectValueDistributions || []) {
      const v = normalize(vd.localizedAspectValue);
      if (!v) continue;

      // Require an exact normalized match against one of the expected variants
      if (expectedVariants.includes(v)) return true;
    }
  }
  return false;
}

function hasAspect(refinement, aspectName) {
  const target = normalize(aspectName);
  return (refinement?.aspectDistributions || []).some(
    (a) => normalize(a.localizedAspectName) === target
  );
}

async function getAppToken() {
  const id = process.env.EBAY_CLIENT_ID;
  const secret = process.env.EBAY_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error(
      "Missing EBAY_CLIENT_ID / EBAY_CLIENT_SECRET environment variables."
    );
  }

  const creds = Buffer.from(`${id}:${secret}`).toString("base64");

  // Keep scope broad-enough for Browse; if you later add other endpoints, expand here.
  const scope = "https://api.ebay.com/oauth/api_scope";

  const res = await fetch(EBAY_OAUTH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${creds}`,
    },
    body: `grant_type=client_credentials&scope=${encodeURIComponent(scope)}`,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Failed to get eBay token (${res.status}): ${txt}`);
  }

  const data = await res.json();
  if (!data?.access_token) throw new Error("Failed to get eBay token (no access_token).");
  return data.access_token;
}

async function ebayBrowseSearch({
  token,
  marketplaceId,
  q,
  filter,
  limit = 50,
  offset = 0,
  fieldgroups = "ASPECT_REFINEMENTS",
}) {
  const url = new URL(EBAY_BROWSE_SEARCH_URL);
  url.searchParams.set("q", q);
  url.searchParams.set("category_ids", CATEGORY_ID);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  if (filter) url.searchParams.set("filter", filter);
  if (fieldgroups) url.searchParams.set("fieldgroups", fieldgroups);

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": marketplaceId,
    },
  });

  // We intentionally return status for fallback handling
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // leave json null
  }

  return { ok: res.ok, status: res.status, json, raw: text };
}

/**
 * Ensures "Player/Athlete" matches name exactly (diacritics-insensitive).
 * Also checks Sport aspect if present.
 */
async function passesAspectGate({ token, name, sport, marketplaceId, q }) {
  const filter = "buyingOptions:{FIXED_PRICE}";

  const r = await ebayBrowseSearch({
    token,
    marketplaceId,
    q,
    filter,
    limit: 50,
    offset: 0,
    fieldgroups: "ASPECT_REFINEMENTS",
  });

  if (!r.ok) {
    throw new Error(`Browse error ${r.status} (${marketplaceId})`);
  }

  const refinement = r.json?.refinement || {};

  const playerOk = aspectContains(refinement, "Player/Athlete", name);

  // If "Sport" aspect exists, require it; if not present, don't block.
  let sportOk = true;
  if (hasAspect(refinement, "Sport")) {
    sportOk = aspectContains(refinement, "Sport", sport);
  }

  return playerOk && sportOk;
}

function mean(nums) {
  if (!nums.length) return null;
  const s = nums.reduce((a, b) => a + b, 0);
  return s / nums.length;
}

/**
 * Active listings avg (Buy Now only): fixed price only
 */
async function fetchActiveListingAvg({ token, name, sport, marketplaceId }) {
  const q = `${name} ${sport} card`;

  const passed = await passesAspectGate({ token, name, sport, marketplaceId, q });
  if (!passed) return { avg: null, count: 0, passed: false };

  const prices = [];
  const filter = "buyingOptions:{FIXED_PRICE}";

  for (let page = 0; page < 2; page++) {
    const r = await ebayBrowseSearch({
      token,
      marketplaceId,
      q,
      filter,
      limit: 50,
      offset: page * 50,
      fieldgroups: null, // no need after gate
    });

    if (!r.ok) throw new Error(`Browse error ${r.status} (${marketplaceId})`);

    for (const item of r.json?.itemSummaries || []) {
      const p = Number(item?.price?.value);
      if (Number.isFinite(p)) prices.push(p);
    }

    if (!r.json?.next) break;
  }

  return { avg: mean(prices), count: prices.length, passed: true };
}

/**
 * Sold avg (Buy Now only).
 *
 * eBay Browse currently supports various filters, but "sold items" filtering can vary by account/API availability.
 * We try a couple of commonly-seen filter patterns. If none work, we return nulls (but still keep active avg).
 */
async function fetchSoldAvg({ token, name, sport, marketplaceId }) {
  const q = `${name} ${sport} card`;

  // IMPORTANT: keep auctions out
  const baseBuyingOptions = "buyingOptions:{FIXED_PRICE}";

  // Try common patterns (if unsupported, API returns 400)
  const candidateFilters = [
    `${baseBuyingOptions},soldItemsOnly:true`,
    `soldItemsOnly:true,${baseBuyingOptions}`,
    `${baseBuyingOptions},soldItems:true`,
    `soldItemsOnly:true`,
  ];

  for (const filter of candidateFilters) {
    const prices = [];

    // quick probe
    const probe = await ebayBrowseSearch({
      token,
      marketplaceId,
      q,
      filter,
      limit: 50,
      offset: 0,
      fieldgroups: "ASPECT_REFINEMENTS",
    });

    if (!probe.ok) {
      // If it's a 400/409-ish filter rejection, try the next filter pattern
      if (probe.status >= 400 && probe.status < 500) continue;
      throw new Error(`Sold probe error ${probe.status} (${marketplaceId})`);
    }

    // Gate again (sold searches can have different refinement results)
    const refinement = probe.json?.refinement || {};
    const playerOk = aspectContains(refinement, "Player/Athlete", name);
    let sportOk = true;
    if (hasAspect(refinement, "Sport")) {
      sportOk = aspectContains(refinement, "Sport", sport);
    }
    if (!(playerOk && sportOk)) {
      // If sold results don't confirm the aspect, treat as "no match"
      return { avg: null, count: 0, passed: false };
    }

    // Page through a bit
    for (let page = 0; page < 2; page++) {
      const r = await ebayBrowseSearch({
        token,
        marketplaceId,
        q,
        filter,
        limit: 50,
        offset: page * 50,
        fieldgroups: null,
      });

      if (!r.ok) break; // stop paging this filter

      for (const item of r.json?.itemSummaries || []) {
        const p = Number(item?.price?.value);
        if (Number.isFinite(p)) prices.push(p);
      }

      if (!r.json?.next) break;
    }

    return { avg: mean(prices), count: prices.length, passed: true, filterUsed: filter };
  }

  // No sold filter worked on this API/account; keep active avg only
  return { avg: null, count: 0, passed: true, filterUsed: null };
}

async function main() {
  const athletes = readAthletes();
  const token = await getAppToken();
  const nowIso = new Date().toISOString();

  const out = {};

  for (let i = 0; i < athletes.length; i++) {
    const { name, sport } = athletes[i];
    console.log(`[${i + 1}/${athletes.length}] ${name}`);

    const results = {};

    // Run both marketplaces
    for (const marketplaceId of MARKETPLACES) {
      const active = await fetchActiveListingAvg({ token, name, sport, marketplaceId });

      // If active failed the aspect gate, we still try sold, but we ultimately require
      // at least one marketplace to pass a Player/Athlete gate (active or sold).
      const sold = await fetchSoldAvg({ token, name, sport, marketplaceId });

      results[marketplaceId] = {
        activeListingPriceAverage: active.avg,
        activeListingCount: active.count,
        soldPriceAverage: sold.avg,
        soldCount: sold.count,
        soldFilterUsed: sold.filterUsed ?? undefined,
        passedAspectGate:
          Boolean(active.passed && active.count >= 0) && active.passed !== false
            ? active.passed
            : sold.passed,
      };
    }

    // Skip entirely if BOTH marketplaces fail the Player/Athlete match gate (avoid fake data)
    const anyPassed =
      Object.values(results).some((r) => r?.passedAspectGate === true) ||
      Object.values(results).some(
        (r) => Number.isFinite(r?.activeListingPriceAverage) || Number.isFinite(r?.soldPriceAverage)
      );

    // Stronger skip condition: require at least one marketplace to have passed gate AND produced data
    const anyRealData = Object.values(results).some(
      (r) => Number.isFinite(r?.activeListingPriceAverage) || Number.isFinite(r?.soldPriceAverage)
    );

    // If neither marketplace can confirm Player/Athlete, skip
    // (This is what you asked for: if no match under Player/Athlete with name, skip.)
    const usGate = results.EBAY_US?.passedAspectGate === true;
    const caGate = results.EBAY_CA?.passedAspectGate === true;
    if (!usGate && !caGate) {
      console.log(`${name}: SKIPPED (no Player/Athlete match)`);
      continue;
    }

    // If it passed the gate but returned no prices at all, keep it (still useful), but you can tighten if desired
    out[name] = {
      sport,
      marketplaces: results,
      asOf: nowIso,
      method: "mean_fixed_price_only; sold_avg_best_effort",
      categoryId: CATEGORY_ID,
    };

    if (!anyPassed || !anyRealData) {
      // keep log hints, but don't skip—gate already passed
      console.log(`${name}: OK (gate passed, but limited data returned)`);
    }
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
