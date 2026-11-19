// Site stats through Umami, off until a site ID is set. The switch is the one line in index.html:
//   window.HANDWRITING_STATS = { umamiId: "" }
// A blank ID adds no script tag, makes no request and sends no event. With an ID, Umami counts in aggregate: no cookies,
// no IP addresses stored, no fingerprinting, no per-person profile. Referrer, country and device type come from Umami's
// own page view. This file adds only the events: section views, scroll depth, install clicks, the email signup button, a pen used on the page
// and heard-from: the one answer to "how did you hear" (which chip, or skip, and which install button), asked once per browser.
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

	// How did you hear: a plain click on an install link opens the plugin page in a new tab (for that click only) and
	// asks once, on this page. A chip sends heard-from { source, where }; Skip, Close, Esc and the scrim send "skip".
	// The "hw-heard" key ("1") is set when it opens, so this browser is never asked again; if storage throws, once a load.
	var box = document.querySelector("dialog[data-heard]");
	if (box && typeof box.showModal === "function") (function () {
		var KEY = "hw-heard";
		var title = box.querySelector("h2");
		var chips = box.querySelectorAll("[data-source]");
		var still = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
		var asked = false, done = false, link = null, where = "", opened = 0, replay = false, replayed = false, wake = 0;
		function before() { try { return localStorage.getItem(KEY) === "1"; } catch (e) { return false; } }
		function mark() { try { localStorage.setItem(KEY, "1"); } catch (e) {} }
		function put(a, name, v) { if (v === null) a.removeAttribute(name); else a.setAttribute(name, v); }
		for (var i = 0; i < chips.length; i++) chips[i].style.setProperty("--i", i);

		function play() { box.classList.remove("go"); void box.offsetWidth; box.classList.add("go"); }
		// The new tab usually comes to the front, so the open plays where nobody sees it. If this tab is hidden at the open
		// or before it settles (600 ms), the card waits at the first state and the open plays once more, 150 ms after the
		// tab is seen again. Once only; never under reduced motion.
		function hold() { replay = true; clearTimeout(wake); box.classList.remove("go"); box.classList.add("held"); }
		function show(a) {
			link = a; where = a.getAttribute("data-install") || "";
			box.showModal();
			play();
			opened = Date.now();
			if (!still && document.visibilityState === "hidden") hold();
			title.focus();
		}
		document.addEventListener("visibilitychange", function () {
			if (!box.open || done || still || replayed) return;
			if (document.visibilityState === "hidden") {
				clearTimeout(wake);
				if (replay || Date.now() - opened < 600) hold();
				return;
			}
			if (!replay) return;
			wake = setTimeout(function () {
				if (!box.open || done || document.visibilityState === "hidden") return;
				replay = false; replayed = true;
				box.classList.remove("held");
				play();
			}, 150);
		});

		// The close plays for 150 ms (the heard-out animation), then the dialog closes on a timer of the same length.
		function shut() {
			if (!box.open) return;
			if (still) { box.close(); return; }
			box.classList.add("out");
			setTimeout(function () { box.close(); }, 150);
		}
		function answer(source) {
			if (done) return false;
			done = true;
			send("heard-from", { source: source, where: where });
			return true;
		}
		function skip() { if (answer("skip")) shut(); }

		// Held (the card is waiting, unseen, for its replay): a pointer click does nothing, and so does one whose press
		// began while held, whenever it is released. Each press sets the record afresh. Keyboard clicks and Esc still answer.
		var pressHeld = false;
		box.addEventListener("pointerdown", function () { pressHeld = replay; });
		box.addEventListener("click", function (e) {
			if (e.detail && (replay || pressHeld)) return;
			var chip = e.target.closest && e.target.closest("[data-source]");
			if (chip) {
				if (!answer(chip.getAttribute("data-source"))) return;
				chip.classList.add("on");
				if (still) shut(); else setTimeout(shut, 380);
				return;
			}
			if (e.target.closest && e.target.closest("[data-heard-skip]")) { skip(); return; }
			if (e.target !== box) return;
			var r = box.getBoundingClientRect();
			if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) skip();
		});
		box.addEventListener("cancel", function (e) { e.preventDefault(); skip(); });
		// Tab wraps inside the card at both ends: past Skip to Close, and Shift+Tab from Close or the title to Skip.
		var stops = box.querySelectorAll("button"), first = stops[0], last = stops[stops.length - 1];
		box.addEventListener("keydown", function (e) {
			if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey) return;
			var at = document.activeElement;
			if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
			else if (e.shiftKey && (at === first || at === title)) { e.preventDefault(); last.focus(); }
		});
		box.addEventListener("close", function () {
			answer("skip");
			clearTimeout(wake);
			box.classList.remove("go", "out", "held");
			if (link) { var a = link; link = null; a.focus({ preventScroll: true }); }
		});

		document.querySelectorAll("[data-install]").forEach(function (a) {
			a.addEventListener("click", function (e) {
				if (asked || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
				if (before()) return;
				asked = true;
				mark();
				var target = a.getAttribute("target"), rel = a.getAttribute("rel");
				a.setAttribute("target", "_blank");
				a.setAttribute("rel", "noopener");
				// After this click's own navigation: put the link back and open the card.
				setTimeout(function () { put(a, "target", target); put(a, "rel", rel); show(a); }, 0);
			});
		});
	})();

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
