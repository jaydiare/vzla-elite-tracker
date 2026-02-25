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
    if (daysOnMarket <= 7) return 1.30;
    if (daysOnMarket <= 14) return 1.15;
    if (daysOnMarket <= 30) return 1.00;
    if (daysOnMarket <= 60) return 0.90;
    return 0.75;
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

  // safer matching (prevents "I see more than chosen" surprises)
  function normKey(s) {
    return String(s || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  /**
   * ✅ IMPORTANT:
   * Only consider athlete cards actually in the grid below.
   */
  function getVisibleCardsInGrid() {
    const grid = document.getElementById("athletes-grid");
    if (!grid) return [];
    return Array.from(grid.querySelectorAll(".athlete-card"))
      .filter(el => el.offsetParent !== null);
  }

  function getListingsFromDOM() {
    const cards = getVisibleCardsInGrid();

    return cards.map(el => {
      const name =
        el.dataset.athleteName ||
        el.querySelector(".athlete-card__name")?.textContent?.trim() ||
        "Unknown";

      const price = Number(el.dataset.price); // dollars
      const stabilityPct = Number(el.dataset.stabilityPct); // 0..100

      // ✅ expects: data-days-on-market="123"
      const daysOnMarket = Number(el.dataset.daysOnMarket);

      return {
        id: normKey(name),
        name,
        priceCents: Number.isFinite(price) ? Math.round(price * 100) : NaN,
        stabilityPct: Number.isFinite(stabilityPct) ? stabilityPct : NaN,
        daysOnMarket: Number.isFinite(daysOnMarket) ? daysOnMarket : NaN,
      };
    }).filter(x => Number.isFinite(x.priceCents) && x.priceCents > 0);
  }

  /**
   * Highlight chosen cards in the grid
   */
  function applyHighlights(chosen) {
    const grid = document.getElementById("athletes-grid");
    if (!grid) return;

    grid.querySelectorAll(".athlete-card.is-recommended").forEach(el => {
      el.classList.remove("is-recommended");
    });

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

  /**
   * OPTIONAL: hide all non-chosen cards
   */
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

      // Use inline style so you don't need extra CSS
      el.style.display = isChosen ? "" : "none";
    });
  }

  /**
   * Restore grid visibility (undo filter)
   */
  function clearFilter() {
    const grid = document.getElementById("athletes-grid");
    if (!grid) return;
    grid.querySelectorAll(".athlete-card").forEach(el => {
      el.style.display = "";
    });
  }

  function renderRecommendationsSummary(chosen, budgetCents) {
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
        <strong>${chosen.length}</strong> card(s) —
        Spent <strong>$${(spent / 100).toFixed(2)}</strong> of <strong>$${(budgetCents / 100).toFixed(2)}</strong>
      </div>
    `;
  }

  function runBudgetSuggest() {
    const inputEl = document.querySelector("#budgetInput");
    const out = document.querySelector("#budgetRecommendations");
    if (!inputEl || !out) return;

    const budgetCents = dollarsToCents(inputEl.value);

    // blank budget => clear UI + restore grid
    if (!budgetCents) {
      out.innerHTML = "";
      applyHighlights([]);
      clearFilter();
      return;
    }

    const raw = getListingsFromDOM();

    const items = raw.map(x => {
      const base = stabilityPoints(x.stabilityPct);
      const liq = liquidityMultiplier(x.daysOnMarket);
      return {
        ...x,
        valueScore: base * liq,
      };
    }).filter(x => x.valueScore > 0 && x.priceCents <= budgetCents);

    const chosen = knapsackPick(items, budgetCents);

    // ✅ apply UI behavior
    applyHighlights(chosen);

    if (FILTER_TO_CHOSEN) {
      applyFilterToChosen(chosen);
    } else {
      clearFilter();
    }

    renderRecommendationsSummary(chosen, budgetCents);
  }

  function clearBudgetSuggest() {
    const input = document.querySelector("#budgetInput");
    const out = document.querySelector("#budgetRecommendations");
    if (input) input.value = "";
    if (out) out.innerHTML = "";
    applyHighlights([]);
    clearFilter();
  }

  // expose to window so app.js can call it from renderGrid()
  window.runBudgetSuggest = runBudgetSuggest;
  window.clearBudgetSuggest = clearBudgetSuggest;

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelector("#budgetBtn")?.addEventListener("click", runBudgetSuggest);
    document.querySelector("#budgetClear")?.addEventListener("click", clearBudgetSuggest);
  });
})();
