/**
 * The receiving end of "Upload to developer". Wakes per request; nothing
 * runs between uploads and no machine of ours is involved.
 *
 * Storage is KV, not R2, deliberately: KV's free tier needs nothing
 * enabled in the dashboard, and a bug recording is one small JSON value -
 * KV's 25 MB value cap is six times the worker's own upload cap.
 *
 * Endpoints:
 *   POST /upload            body: the replay JSON. Returns {"id":"ab12cd34"}.
 *   GET  /r/<id>?key=SECRET the stored JSON back.
 *   GET  /list?key=SECRET   the newest 100 keys.
 *
 * Guards: 4 MB cap, must parse as a v1 trace capture, ids are random so
 * nobody can enumerate recordings, and reading anything back needs the
 * SECRET_KEY - recordings are strangers' pen geometry, and only the
 * developer should see them again.
 */

const MAX_BYTES = 4 * 1024 * 1024;

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (request.method === "POST" && url.pathname === "/upload") {
			const len = Number(request.headers.get("content-length") ?? "0");
			if (len > MAX_BYTES) return json({ error: "too large" }, 413);
			const text = await request.text();
			if (text.length > MAX_BYTES) return json({ error: "too large" }, 413);
			let parsed;
			try {
				parsed = JSON.parse(text);
			} catch {
				return json({ error: "not json" }, 400);
			}
			if (parsed?.v !== 1 || !Array.isArray(parsed?.events)) {
				return json({ error: "not a trace capture" }, 400);
			}
			const id = [...crypto.getRandomValues(new Uint8Array(4))]
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");
			const stamp = new Date().toISOString().slice(0, 10);
			await env.TRACES.put(`${stamp}-${id}`, text);
			return json({ id });
		}

		if (url.searchParams.get("key") !== env.SECRET_KEY) {
			return json({ error: "no" }, 403);
		}

		if (request.method === "GET" && url.pathname.startsWith("/r/")) {
			const id = url.pathname.slice(3).replace(/[^a-z0-9-]/gi, "");
			const list = await env.TRACES.list({ limit: 1000 });
			const hit = list.keys.find((k) => k.name.includes(id));
			if (!hit) return json({ error: "not found" }, 404);
			const body = await env.TRACES.get(hit.name);
			return new Response(body, { headers: { "content-type": "application/json" } });
		}

		if (request.method === "GET" && url.pathname === "/list") {
			const list = await env.TRACES.list({ limit: 100 });
			return json(list.keys.map((k) => k.name));
		}

		return json({ error: "unknown route" }, 404);
	},
};

function json(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}
