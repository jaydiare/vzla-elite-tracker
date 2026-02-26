// scripts/budget-knapsack.js

(function () {
  // ✅ Toggle this:
  // true  = hide non-picked cards (FILTER)
  // false = only highlight picks (HIGHLIGHT ONLY)
  const FILTER_TO_CHOSEN = true;

  function dollarsToCents(v) {
    const cleaned = String(v).replace(/[^0-9.]/g, "");
    const num = Number(cleaned);
    if (!Number.isFinite(num) || num <= 0) return null;
    return Math.round(num * 100);
  }

  function toPositiveInt(v) {
    const cleaned = String(v ?? "").replace(/[^0-9]/g, "");
    const n = Number(cleaned);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.floor(n);
  }

  // stability scoring
  function stabilityPoints(stabilityPct0to100) {
    if (!Number.isFinite(stabilityPct0to100)) return 0;

    if (stabilityPct0to100 <= 10) return 100;
    if (stabilityPct0to100 <= 20) return 70;
    if (stabilityPct0to100 <= 35) return 35;
    return 10;
  }

  // liquidity multiplier
  function liquidityMultiplier(daysOnMarket) {
    if (!Number.isFinite(daysOnMarket)) return 1.0;
    if (daysOnMarket <= 7) return 1.30;
    if (daysOnMarket <= 14) return 1.15;
    if (daysOnMarket <= 30) return 1.00;
    if (daysOnMarket <= 60) return 0.90;
    return 0.75;
  }

  // ============================
  // Standard 0/1 Knapsack (budget only): maximize valueScore under budget
  // ============================
  function knapsackPick(items, budgetCents) {
    const dp = Array(budgetCents + 1).fill(0);
    const pick = Array.from({ length: items.length }, () =>
      Array(budgetCents + 1).fill(false)
    );

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

  // ============================
  // Knapsack WITH max card count
  // ✅ When card target is set:
  //   1) spend as much budget as possible (primary)
  //   2) then maximize valueScore (secondary)
  //   3) tie-break: prefer more cards (closer to target)
  // ============================
  function knapsackPickWithMaxCount(items, budgetCents, maxCount) {
    const B = budgetCents;
    const K = Math.max(1, maxCount | 0);

    const width = B + 1;
    const size = (K + 1) * width;

    // dp[k,b] = best value using exactly k items with total cost exactly b
    const dp = new Float64Array(size);
    dp.fill(-Infinity);
    dp[0 * width + 0] = 0;

    // reconstruction pointers
    const choice = new Int32Array(size);
    const prevB = new Int32Array(size);
    choice.fill(-1);
    prevB.fill(-1);

    for (let i = 0; i < items.length; i++) {
      const w = items[i].priceCents;
      const v = items[i].valueScore;

      for (let k = K; k >= 1; k--) {
        const row = k * width;
        const prevRow = (k - 1) * width;

        for (let b = B; b >= w; b--) {
          const from = prevRow + (b - w);
          const to = row + b;

          const base = dp[from];
          if (base === -Infinity) continue;

          const cand = base + v;
          if (cand > dp[to]) {
            dp[to] = cand;
            choice[to] = i;
            prevB[to] = b - w;
          }
        }
      }
    }

    // ✅ Find max spend first (b closest to B), then best value at that spend
    let bestB = -1;
    let bestK = 0;
    let bestVal = -Infinity;

    for (let b = B; b >= 0; b--) {
      let foundAny = false;
      let localBestVal = -Infinity;
      let localBestK = 0;

      for (let k = 1; k <= K; k++) {
        const val = dp[k * width + b];
        if (val === -Infinity) continue;

        foundAny = true;
        if (val > localBestVal || (val === localBestVal && k > localBestK)) {
          localBestVal = val;
          localBestK = k;
        }
      }

      if (foundAny) {
        bestB = b;
        bestK = localBestK;
        bestVal = localBestVal;
        break;
      }
    }

    if (bestB < 0 || bestVal === -Infinity) return [];

    // reconstruct
    const chosen = [];
    let k = bestK;
    let b = bestB;

    while (k > 0) {
      const idx = k * width + b;
      const i = choice[idx];
      if (i < 0) break;

      chosen.push(items[i]);
      b = prevB[idx];
      k--;
    }

    chosen.reverse();
    return chosen;
  }

  function normKey(s) {
    return String(s || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  // ✅ Prefer full filtered dataset from app.js (not paginated)
  function getListingsPreferred() {
    if (typeof window.getBudgetCandidates === "function") {
      const list = window.getBudgetCandidates();
      if (Array.isArray(list) && list.length) return list;
    }
    return getListingsFromDOM();
  }

  // DOM fallback
  function getVisibleCardsInGrid() {
    const grid = document.getElementById("athletes-grid");
    if (!grid) return [];
    return Array.from(grid.querySelectorAll(".athlete-card"))
      .filter(el => el.offsetParent !== null);
  }

  function getListingsFromDOM() {
    const cards = getVisibleCardsInGrid();

    return cards
      .map(el => {
        const name =
          el.dataset.athleteName ||
          el.querySelector(".athlete-card__name")?.textContent?.trim() ||
          "Unknown";

        const price = Number(el.dataset.price);
        const stabilityPct = Number(el.dataset.stabilityPct);
        const daysOnMarket = Number(el.dataset.daysOnMarket);

        return {
          id: normKey(name),
          name,
          priceCents: Number.isFinite(price) ? Math.round(price * 100) : NaN,
          stabilityPct: Number.isFinite(stabilityPct) ? stabilityPct : NaN,
          daysOnMarket: Number.isFinite(daysOnMarket) ? daysOnMarket : NaN
        };
      })
      .filter(x => Number.isFinite(x.priceCents) && x.priceCents > 0);
  }

  function applyHighlights(chosen) {
    const grid = document.getElementById("athletes-grid");
    if (!grid) return;

    grid.querySelectorAll(".athlete-card.is-recommended")
      .forEach(el => el.classList.remove("is-recommended"));

    const chosenSet = new Set(chosen.map(x => x.id));

    grid.querySelectorAll(".athlete-card").forEach(el => {
      const name =
        el.dataset.athleteName ||
        el.querySelector(".athlete-card__name")?.textContent?.trim() ||
        "";

      if (chosenSet.has(normKey(name))) {
        el.classList.add("is-recommended");
      }
    });
  }

  function applyFilterToChosen(chosen) {
    const grid = document.getElementById("athletes-grid");
    if (!grid) return;

    const chosenSet = new Set(chosen.map(x => x.id));

    grid.querySelectorAll(".athlete-card").forEach(el => {
      const name =
        el.dataset.athleteName ||
        el.querySelector(".athlete-card__name")?.textContent?.trim() ||
        "";

      const isChosen = chosenSet.has(normKey(name));
      el.style.display = isChosen ? "" : "none";
    });
  }

  function clearFilter() {
    const grid = document.getElementById("athletes-grid");
    if (!grid) return;
    grid.querySelectorAll(".athlete-card")
      .forEach(el => el.style.display = "");
  }

  function renderRecommendationsSummary(chosen, budgetCents, maxCards) {
    const out = document.querySelector("#budgetRecommendations");
    if (!out) return;

    if (!chosen.length) {
      out.innerHTML = `<div style="opacity:.8;">No picks found within this budget.</div>`;
      return;
    }

    const spent = chosen.reduce((s, it) => s + it.priceCents, 0);

    out.innerHTML = `
      <div style="opacity:.9;">
        ${FILTER_TO_CHOSEN ? "Showing" : "Highlighted"}
        <strong>${chosen.length}</strong> card(s)
        ${maxCards ? `(target ≤ <strong>${maxCards}</strong>)` : ""}
        — Spent <strong>$${(spent / 100).toFixed(2)}</strong>
        of <strong>$${(budgetCents / 100).toFixed(2)}</strong>
      </div>
    `;
  }

  function runBudgetSuggest() {
    const inputEl = document.querySelector("#budgetInput");
    const cardsInputEl = document.querySelector("#cardsInput");
    const out = document.querySelector("#budgetRecommendations");

    if (!inputEl || !out) return;

    const budgetCents = dollarsToCents(inputEl.value);
    const maxCards = cardsInputEl ? toPositiveInt(cardsInputEl.value) : null;

    if (!budgetCents) {
      out.innerHTML = "";
      applyHighlights([]);
      clearFilter();
      return;
    }

    const raw = getListingsPreferred();

    const items = raw
      .map(x => {
        const base = stabilityPoints(x.stabilityPct);
        const liq = liquidityMultiplier(x.daysOnMarket);

        return {
          ...x,
          id: normKey(x.name),
          valueScore: base * liq
        };
      })
      .filter(x => x.valueScore > 0 && x.priceCents <= budgetCents);

    const chosen = maxCards
      ? knapsackPickWithMaxCount(items, budgetCents, maxCards)
      : knapsackPick(items, budgetCents);

    applyHighlights(chosen);

    if (FILTER_TO_CHOSEN) {
      applyFilterToChosen(chosen);
    } else {
      clearFilter();
    }

    renderRecommendationsSummary(chosen, budgetCents, maxCards);
  }

  function clearBudgetSuggest() {
    const input = document.querySelector("#budgetInput");
    const cardsInput = document.querySelector("#cardsInput");
    const out = document.querySelector("#budgetRecommendations");

    if (input) input.value = "";
    if (cardsInput) cardsInput.value = "";
    if (out) out.innerHTML = "";

    applyHighlights([]);
    clearFilter();
  }

  window.runBudgetSuggest = runBudgetSuggest;
  window.clearBudgetSuggest = clearBudgetSuggest;

  document.addEventListener("DOMContentLoaded", () => {
    document
      .querySelector("#budgetBtn")
      ?.addEventListener("click", runBudgetSuggest);

    document
      .querySelector("#budgetClear")
      ?.addEventListener("click", clearBudgetSuggest);
  });
})();
