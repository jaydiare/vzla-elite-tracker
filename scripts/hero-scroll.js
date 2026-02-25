(function () {
  const hero = document.getElementById("vzla-hero");
  if (!hero) return;

  const collapseAt = Math.max(120, Math.min(360, hero.offsetHeight * 0.35));
  let lastY = window.scrollY || 0;

  function onScroll() {
    const y = window.scrollY || 0;

    // Collapse hero once user scrolls past threshold
    if (y > collapseAt) document.body.classList.add("hero-collapsed");
    else document.body.classList.remove("hero-collapsed");

    lastY = y;
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  onScroll();
})();
