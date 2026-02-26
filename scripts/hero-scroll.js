// scripts/hero-scroll.js

(function () {
  function init() {
    // ✅ Support either an id or a class so it doesn't silently fail
    const hero =
      document.getElementById("vzla-hero") ||
      document.querySelector(".vzla-hero") ||
      document.querySelector(".hero") ||
      document.querySelector("section.hero");

    if (!hero) return;

    // ✅ Mobile UX: don't auto-collapse on small screens
    const mql = window.matchMedia("(max-width: 768px)");

    function ensureMobileState() {
      if (mql.matches) {
        document.body.classList.remove("hero-collapsed");
        return true; // is mobile
      }
      return false;
    }

    // initial mobile check
    if (ensureMobileState()) return;

    // If user prefers reduced motion, keep it stable
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) {
      document.body.classList.remove("hero-collapsed");
      return;
    }

    function computeCollapseAt() {
      // Use bounding rect height (more reliable than offsetHeight in some layouts)
      const h = hero.getBoundingClientRect().height || hero.offsetHeight || 0;
      // Clamp between 140 and 420, based on ~35% of hero height
      return Math.max(140, Math.min(420, h * 0.35));
    }

    let collapseAt = computeCollapseAt();

    // ✅ RAF scroll handler (prevents jitter)
    let ticking = false;

    function applyState() {
      const y = window.scrollY || window.pageYOffset || 0;
      if (y > collapseAt) document.body.classList.add("hero-collapsed");
      else document.body.classList.remove("hero-collapsed");
    }

    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        applyState();
      });
    }

    // ✅ Recompute collapseAt when hero changes size (index cards render, fonts load, etc.)
    let ro = null;
    if ("ResizeObserver" in window) {
      ro = new ResizeObserver(() => {
        collapseAt = computeCollapseAt();
        applyState();
      });
      ro.observe(hero);
    }

    // Also recalc on resize + when fonts finish loading
    function onResize() {
      collapseAt = computeCollapseAt();
      applyState();
    }

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);

    if (document.fonts && typeof document.fonts.ready?.then === "function") {
      document.fonts.ready.then(() => {
        collapseAt = computeCollapseAt();
        applyState();
      });
    }

    // If viewport crosses into mobile after load, disable collapsing
    mql.addEventListener?.("change", () => {
      if (ensureMobileState()) {
        window.removeEventListener("scroll", onScroll);
        window.removeEventListener("resize", onResize);
        ro?.disconnect?.();
      } else {
        // back to desktop
        collapseAt = computeCollapseAt();
        window.addEventListener("scroll", onScroll, { passive: true });
        window.addEventListener("resize", onResize);
        applyState();
      }
    });

    // initial state
    applyState();
  }

  // ✅ Ensure DOM is ready (prevents null hero if script loads in <head>)
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
