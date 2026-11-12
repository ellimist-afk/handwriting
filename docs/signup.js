// Email signup through Kit, off until a form URL is set. The switch is the one line in index.html:
//   window.HANDWRITING_SIGNUP = { kitFormUrl: "" }
// A blank URL leaves the section hidden: no request, no Kit script. With a URL the section shows and the form posts the
// email straight to Kit, which sends the confirm email (double opt-in is set on the form in Kit). No Kit script loads.
(function () {
	"use strict";
	var cfg = window.HANDWRITING_SIGNUP || {};
	var url = typeof cfg.kitFormUrl === "string" ? cfg.kitFormUrl.trim() : "";
	if (!/^https:\/\//.test(url)) return;
	var section = document.getElementById("signup");
	var form = section && section.querySelector("form[data-signup]");
	if (!form) return;
	form.action = url;
	section.hidden = false;
})();
