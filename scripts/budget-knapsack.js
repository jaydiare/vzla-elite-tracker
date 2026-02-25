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

    return {
      id: name,
      name,
      priceCents: Number.isFinite(price) ? Math.round(price * 100) : NaN,
      stabilityPct: Number.isFinite(stabilityPct) ? stabilityPct : NaN,
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
        ${chosen.map(it => `
          <li>
            <strong>${it.name}</strong> — $${(it.priceCents/100).toFixed(2)}
            <span style="opacity:.75;">(${it.stabilityPct.toFixed(1)}%)</span>
          </li>
        `).join("")}
      </ol>
    </div>
  `;
}

function runBudgetSuggest() {
  const out = document.querySelector("#budgetRecommendations");
  const budgetCents = dollarsToCents(document.querySelector("#budgetInput")?.value);

  // optional: blank budget => no UI
  if (!budgetCents) {
    if (out) out.innerHTML = "";
    return;
  }

  const raw = getListingsFromDOM();

  const items = raw.map(x => ({
    ...x,
    valueScore: stabilityPoints(x.stabilityPct),
  }))
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

document.addEventListener("DOMContentLoaded", () => {
  document.querySelector("#budgetBtn")?.addEventListener("click", runBudgetSuggest);
  document.querySelector("#budgetClear")?.addEventListener("click", clearBudgetSuggest);
});
