(function () {
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Phones and tablets can't run the Claude desktop app, so pages swap in a
  // "finish on your laptop" handoff for them.
  var ua = navigator.userAgent;
  var isPhone = /iPhone|iPad|iPod|Android/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  document.documentElement.classList.toggle("phone", isPhone);

  document.querySelectorAll("[data-share]").forEach(function (button) {
    button.addEventListener("click", function () {
      var url = button.getAttribute("data-share");
      var text = "Finish setting up Brightspace MCP on your laptop (takes about a minute):";
      if (navigator.share) {
        navigator.share({ title: "Brightspace MCP setup", text: text, url: url }).catch(function () {});
      } else {
        location.href = "mailto:?subject=" + encodeURIComponent("Brightspace MCP setup") + "&body=" + encodeURIComponent(text + "\n" + url);
      }
    });
  });

  // Scroll reveals. Elements animate in when they enter the viewport and
  // reset once fully out of view, so they replay when scrolled back to.
  var els = document.querySelectorAll(".reveal, .wipe");
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) e.target.classList.add("in");
        else if (e.intersectionRatio === 0) e.target.classList.remove("in");
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: [0, 0.12] });
    els.forEach(function (el) { io.observe(el); });
  } else {
    els.forEach(function (el) { el.classList.add("in"); });
  }

  // Sticky header gets a border and blur once the page scrolls.
  var bar = document.querySelector(".top-bar");
  if (bar) {
    var onScroll = function () { bar.classList.toggle("scrolled", window.scrollY > 8); };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  // Copy buttons morph to "Copied".
  document.querySelectorAll("[data-copy]").forEach(function (button) {
    button.addEventListener("click", function () {
      var label = button.querySelector("span") || button;
      var done = function () {
        button.classList.add("copied");
        label.textContent = "Copied";
        setTimeout(function () { button.classList.remove("copied"); label.textContent = "Copy"; }, 1600);
      };
      try { navigator.clipboard.writeText(button.getAttribute("data-copy")).then(done, function () {}); } catch (e) {}
    });
  });

  // Setup tabs, preselected from the visitor's operating system.
  var setup = document.querySelector("[data-setup]");
  if (setup) {
    var tabs = setup.querySelectorAll("[data-os]");
    var show = function (os) {
      tabs.forEach(function (t) { t.setAttribute("aria-selected", t.getAttribute("data-os") === os ? "true" : "false"); });
      setup.querySelectorAll("[data-panel]").forEach(function (p) { p.hidden = p.getAttribute("data-panel") !== os; });
    };
    tabs.forEach(function (t) { t.addEventListener("click", function () { show(t.getAttribute("data-os")); }); });
    var ua = navigator.userAgent;
    show(/Mac|iPhone|iPad/.test(ua) ? "mac" : /Linux|X11/.test(ua) && !/Android/.test(ua) ? "linux" : "win");
  }

  // Hero card tilts toward the pointer with a little lag, for depth.
  var tilt = document.querySelector("[data-tilt]");
  if (tilt && !reduce && window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
    var tx = 0, ty = 0, cx = 0, cy = 0, raf = 0;
    var step = function () {
      cx += (tx - cx) * 0.12; cy += (ty - cy) * 0.12;
      tilt.style.transform = "perspective(900px) rotateX(" + cy.toFixed(2) + "deg) rotateY(" + cx.toFixed(2) + "deg)";
      raf = Math.abs(tx - cx) > 0.01 || Math.abs(ty - cy) > 0.01 ? requestAnimationFrame(step) : 0;
    };
    var kick = function () { if (!raf) raf = requestAnimationFrame(step); };
    window.addEventListener("pointermove", function (e) {
      tx = (e.clientX / window.innerWidth - 0.5) * 10;
      ty = (0.5 - e.clientY / window.innerHeight) * 8;
      kick();
    }, { passive: true });
    document.addEventListener("pointerleave", function () { tx = 0; ty = 0; kick(); });
  }
})();
