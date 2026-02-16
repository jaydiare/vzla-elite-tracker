async function updateShopButton() {
  const btn = document.getElementById("shop-btn");
  const athlete = btn.dataset.athlete;

  // cache-bust so GitHub Pages/CDN doesn't serve stale JSON
  const url = `./data/ebay-avg.json?v=${Date.now()}`;

  const res = await fetch(url);
  if (!res.ok) return;

  const data = await res.json();

  // Example JSON shape:
  // { "Salomon Rondon": { "avg": 12.34, "n": 18, "currency": "CAD", "asOf": "..." } }

  const rec = data[athlete];
  if (!rec || !rec.avg || rec.n < 5) return;

  btn.textContent = `Shop collectibles (Avg sold: ${rec.currency}$${rec.avg})`;
}

updateShopButton();
