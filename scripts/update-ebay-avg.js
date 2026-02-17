#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const ATHLETES_PATH = path.join(ROOT, "data", "athletes.json");
const OUTPUT_PATH = path.join(ROOT, "data", "ebay-avg.json");

const EBAY_OAUTH_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const EBAY_SEARCH_URL =
  "https://api.ebay.com/buy/browse/v1/item_summary/search";

const CATEGORY_ID = "261328"; // Trading Card Singles

function readAthletes() {
  return JSON.parse(fs.readFileSync(ATHLETES_PATH, "utf8"));
}

async function getAppToken() {
  const creds = Buffer.from(
    `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
  ).toString("base64");

  const res = await fetch(EBAY_OAUTH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${creds}`,
    },
    body:
      "grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope",
  });

  if (!res.ok) throw new Error("Failed to get eBay token");

  const data = await res.json();
  return data.access_token;
}

function aspectContains(refinement, aspectName, expectedValue) {
  const distributions = refinement?.aspectDistributions || [];
  for (const ad of distributions) {
    if (
      (ad.localizedAspectName || "").toLowerCase() ===
      aspectName.toLowerCase()
    ) {
      for (const vd of ad.aspectValueDistributions || []) {
        if (
          (vd.localizedAspectValue || "").toLowerCase() ===
          expectedValue.toLowerCase()
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

async function fetchMarketplaceAvg(token, name, sport, marketplaceId) {
  let prices = [];
  let passedAspectCheck = false;

  for (let page = 0; page < 2; page++) {
    const url = new URL(EBAY_SEARCH_URL);
    url.searchParams.set("q", `${name} ${sport} card`);
    url.searchParams.set("category_ids", CATEGORY_ID);
    url.searchParams.set("limit", "50");
    url.searchParams.set("offset", String(page * 50));
    url.searchParams.set("filter", "buyingOptions:{FIXED_PRICE}");
    url.searchParams.set("fieldgroups", "ASPECT_REFINEMENTS");

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": marketplaceId,
      },
    });

    if (!res.ok) throw new Error(`Browse error ${res.status}`);

    const data = await res.json();
    const refinement = data.refinement || {};

    if (!passedAspectCheck) {
      const playerOk = aspectContains(
        refinement,
        "Player/Athlete",
        name
      );

      let sportOk = true;

      const hasSportAspect =
        (refinement.aspectDistributions || []).some(
          (a) =>
            (a.localizedAspectName || "").toLowerCase() === "sport"
        );

      if (hasSportAspect) {
        sportOk = aspectContains(refinement, "Sport", sport);
      }

      passedAspectCheck = playerOk && sportOk;

      if (!passedAspectCheck) {
        return { avg: null, count: 0, passed: false };
      }
    }

    for (const item of data.itemSummaries || []) {
      const price = Number(item?.price?.value);
      if (Number.isFinite(price)) prices.push(price);
    }

    if (!data.next) break;
  }

  if (!prices.length) {
    return { avg: null, count: 0, passed: true };
  }

  const avg =
    prices.reduce((sum, v) => sum + v, 0) / prices.length;

  return { avg, count: prices.length, passed: true };
}

async function main() {
  const athletes = readAthletes();
  const token = await getAppToken();
  const out = {};
  const nowIso = new Date().toISOString();

  for (let i = 0; i < athletes.length; i++) {
    const { name, sport } = athletes[i];

    console.log(`[${i + 1}/${athletes.length}] ${name}`);

    const us = await fetchMarketplaceAvg(
      token,
      name,
      sport,
      "EBAY_US"
    );

    const ca = await fetchMarketplaceAvg(
      token,
      name,
      sport,
      "EBAY_CA"
    );

    if (!us.passed && !ca.passed) {
      console.log(`${name}: SKIPPED (no Player/Athlete match)`);
      continue;
    }

    out[name] = {
      sport,
      activeListing: {
        EBAY_US: {
          avg: us.avg,
          count: us.count,
        },
        EBAY_CA: {
          avg: ca.avg,
          count: ca.count,
        },
      },
      asOf: nowIso,
      method: "mean_fixed_price_only",
    };
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
