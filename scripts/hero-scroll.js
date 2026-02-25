(function () {
  const hero = document.getElementById("vzla-hero");
  if (!hero) return;

  // ✅ Mobile UX: don't auto-collapse the hero on small screens (it can block taps / feel jumpy on iOS)
  const isMobile = window.matchMedia("(max-width: 768px)").matches;
  if (isMobile) {
    document.body.classList.remove("hero-collapsed");
    return;
  }

  function computeCollapseAt() {
    return Math.max(120, Math.min(360, hero.offsetHeight * 0.35));
  }

  let collapseAt = computeCollapseAt();

  function onScroll() {
    const y = window.scrollY || 0;
    if (y > collapseAt) document.body.classList.add("hero-collapsed");
    else document.body.classList.remove("hero-collapsed");
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", () => {
    collapseAt = computeCollapseAt();
    onScroll();
  });

  onScroll();
})();
