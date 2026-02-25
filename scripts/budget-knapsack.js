function dollarsToCents(v) {
  const cleaned = String(v).replace(/[^0-9.]/g, "");
  const num = Number(cleaned);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.round(num * 100);
}

// points based on your stability ranges
function stabilityPoints(stabilityPct0to100) {
  if (!Number.isFinite(stabilityPct0to100)) return 0;
  const pct = stabilityPct0to100;

  if (pct <= 10) return 100; // Stable
  if (pct <= 20) return 70;  // Active
  if (pct <= 35) return 35;  // Volatile
  return 10;                 // Highly Unstable
}

/**
 * Liquidity multiplier from Avg. Days on Market (DOM)
 * Lower DOM => more liquid => boost score
 */
function liquidityMultiplier(daysOnMarket) {
  if (!Number.isFinite(daysOnMarket)) return 1.0; // unknown => neutral

  if (daysOnMarket <= 7) return 1.30;   // very liquid
  if (daysOnMarket <= 14) return 1.15;
  if (daysOnMarket <= 30) return 1.00;  // baseline
  if (daysOnMarket <= 60) return 0.90;
  return 0.75;                          // slow-moving market
}

// 0/1 knapsack: maximize points under budget
function knapsackPick(items, budgetCents) {
  const dp = Array(budgetCents + 1).fill(0);
  const pick = Array.from({ length: items.length }, () => Array(budgetCents + 1).fill(false));

  for (let i = 0; i < items.length; i++) {
    const w = items[i].priceCents;
    const v = items[i].valueScore;

    for (let b = budgetCents; b >= w; b--) {
      const cand = dp[b - w] + v;
      if (cand > dp[b]) {
        dp[b] = cand;
        pick[i][b] = true;
      }
    }
  }

  let b = budgetCents;
  const chosen = [];
  for (let i = items.length - 1; i >= 0; i--) {
    if (pick[i][b]) {
      chosen.push(items[i]);
      b -= items[i].priceCents;
    }
  }
  chosen.reverse();
  return chosen;
}

function getVisibleCards() {
  return Array.from(document.querySelectorAll(".athlete-card"))
    .filter(el => el.offsetParent !== null); // visible (not display:none)
}

function getListingsFromDOM() {
  const cards = getVisibleCards();

  return cards.map(el => {
    const name = el.dataset.athleteName
      || el.querySelector(".athlete-card__name")?.textContent?.trim()
      || "Unknown";

    const price = Number(el.dataset.price); // dollars
    const stabilityPct = Number(el.dataset.stabilityPct); // 0..100
    const daysOnMarket = Number(el.dataset.daysOnMarket); // days (e.g., 12.3)

    return {
      id: name,
      name,
      priceCents: Number.isFinite(price) ? Math.round(price * 100) : NaN,
      stabilityPct: Number.isFinite(stabilityPct) ? stabilityPct : NaN,
      daysOnMarket: Number.isFinite(daysOnMarket) ? daysOnMarket : NaN,
    };
  }).filter(x => Number.isFinite(x.priceCents) && x.priceCents > 0);
}

function renderRecommendations(chosen, budgetCents) {
  const out = document.querySelector("#budgetRecommendations");
  if (!out) return;

  if (!chosen.length) {
    out.innerHTML = `<div style="opacity:.8;margin-top:10px;">No picks found within this budget.</div>`;
    return;
  }

  const spent = chosen.reduce((s, it) => s + it.priceCents, 0);

  out.innerHTML = `
    <div style="margin-top:10px;">
      <div style="opacity:.85;margin-bottom:8px;">
        Suggested picks — Spent $${(spent/100).toFixed(2)} of $${(budgetCents/100).toFixed(2)}
      </div>
      <ol>
        ${chosen.map(it => {
          const domText = Number.isFinite(it.daysOnMarket) ? `${Math.round(it.daysOnMarket)}d` : "—";
          return `
            <li>
              <strong>${it.name}</strong> — $${(it.priceCents/100).toFixed(2)}
              <span style="opacity:.75;">(${it.stabilityPct.toFixed(1)}%)</span>
              <span style="opacity:.65;"> • DOM ${domText}</span>
            </li>
          `;
        }).join("")}
      </ol>
    </div>
  `;
}

function runBudgetSuggest() {
  // ✅ Guard: if budget UI isn't present, do nothing (keeps feature optional)
  const inputEl = document.querySelector("#budgetInput");
  const out = document.querySelector("#budgetRecommendations");
  if (!inputEl || !out) return;

  const budgetCents = dollarsToCents(inputEl.value);

  // optional: blank budget => no UI
  if (!budgetCents) {
    out.innerHTML = "";
    return;
  }

  const raw = getListingsFromDOM();

  const items = raw.map(x => {
    const base = stabilityPoints(x.stabilityPct);
    const liq = liquidityMultiplier(x.daysOnMarket);
    return {
      ...x,
      // ✅ value uses BOTH stability + time-on-market (liquidity)
      valueScore: base * liq,
    };
  })
  .filter(x => x.valueScore > 0 && x.priceCents <= budgetCents);

  const chosen = knapsackPick(items, budgetCents);
  renderRecommendations(chosen, budgetCents);
}

function clearBudgetSuggest() {
  const input = document.querySelector("#budgetInput");
  const out = document.querySelector("#budgetRecommendations");
  if (input) input.value = "";
  if (out) out.innerHTML = "";
}

/* ✅ expose to window so app.js can call it from renderGrid() */
window.runBudgetSuggest = runBudgetSuggest;
window.clearBudgetSuggest = clearBudgetSuggest;

document.addEventListener("DOMContentLoaded", () => {
  document.querySelector("#budgetBtn")?.addEventListener("click", runBudgetSuggest);
  document.querySelector("#budgetClear")?.addEventListener("click", clearBudgetSuggest);
});
