// Site stats through Umami, off until a site ID is set. The switch is the one line in index.html:
//   window.HANDWRITING_STATS = { umamiId: "" }
// A blank ID adds no script tag, makes no request and sends no event. With an ID, Umami counts in aggregate: no cookies,
// no IP addresses stored, no fingerprinting, no per-person profile. Referrer, country and device type come from Umami's
// own page view. This file adds only the events: section views, scroll depth, install clicks, the email signup button and a pen used on the page.
// A reader with Do Not Track set is never counted. No other tracker or third-party script is loaded.
(function () {
	"use strict";
	var cfg = window.HANDWRITING_STATS || {};
	var id = typeof cfg.umamiId === "string" ? cfg.umamiId.trim() : "";
	if (!id) return;
	if (navigator.doNotTrack === "1" || window.doNotTrack === "1") return;

	var queue = [];
	var ready = false;
	function send(name, data) {
		if (!ready) { queue.push([name, data]); return; }
		if (window.umami && window.umami.track) window.umami.track(name, data);
	}

	var s = document.createElement("script");
	s.async = true;
	s.src = "https://cloud.umami.is/script.js";
	s.setAttribute("data-website-id", id);
	s.setAttribute("data-do-not-track", "true");
	s.onload = function () {
		ready = true;
		var q = queue; queue = [];
		for (var i = 0; i < q.length; i++) send(q[i][0], q[i][1]);
	};
	document.head.appendChild(s);

	// Section views: once per section per visit, when it crosses the middle of the screen (a tall section never shows half).
	if ("IntersectionObserver" in window) {
		var seen = {};
		var io = new IntersectionObserver(function (entries) {
			entries.forEach(function (e) {
				var name = e.target.getAttribute("data-section");
				if (!e.isIntersecting || seen[name]) return;
				seen[name] = true;
				send("section-view", { section: name });
			});
		}, { rootMargin: "-45% 0px -45% 0px" });
		document.querySelectorAll("[data-section]").forEach(function (el) { io.observe(el); });
	}

	// Scroll depth: 25, 50, 75 and 100 percent, each once.
	var marks = [25, 50, 75, 100], hit = {};
	window.addEventListener("scroll", function () {
		var h = document.documentElement.scrollHeight - window.innerHeight;
		var pct = h > 0 ? (window.scrollY / h) * 100 : 100;
		marks.forEach(function (m) { if (pct >= m - 1 && !hit[m]) { hit[m] = true; send("scroll-depth", { percent: m }); } });
	}, { passive: true });

	// Install clicks, by which button.
	document.querySelectorAll("[data-install]").forEach(function (a) {
		a.addEventListener("click", function () { send("install-click", { where: a.getAttribute("data-install") }); });
	});

	// Email signup: the button was pressed. The email itself is never sent to Umami.
	var signup = document.querySelector("form[data-signup]");
	if (signup) signup.addEventListener("submit", function () { send("signup-click"); });

	// A pen touched the page: once per visit. Says the reader has a pen, nothing about who they are.
	var pen = false;
	window.addEventListener("pointerdown", function (e) {
		if (pen || e.pointerType !== "pen") return;
		pen = true;
		send("pen-on-page");
	}, { passive: true });
})();
