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
 *   GET  /list?key=SECRET   the newest 100 keys, newest first.
 *
 * Guards: 4 MB cap, must parse as a v1 trace capture, ids are random so
 * nobody can enumerate recordings, and reading anything back needs the
 * SECRET_KEY - recordings are strangers' pen geometry, and only the
 * developer should see them again. Uploads are anonymous, so each
 * recording expires after RETENTION_SECONDS and one address may upload
 * only UPLOADS_PER_HOUR times an hour (best effort: KV is eventually
 * consistent, so a burst can slip a few past the count).
 */

const MAX_BYTES = 4 * 1024 * 1024;
const RETENTION_SECONDS = 30 * 24 * 60 * 60;
const UPLOADS_PER_HOUR = 30;
const RATE_PREFIX = "rl-";

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
			const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
			const bucket = `${RATE_PREFIX}${ip}-${Math.floor(Date.now() / 3600000)}`;
			const used = Number((await env.TRACES.get(bucket)) ?? "0");
			if (used >= UPLOADS_PER_HOUR) return json({ error: "too many uploads" }, 429);
			await env.TRACES.put(bucket, String(used + 1), { expirationTtl: 3600 });
			const id = [...crypto.getRandomValues(new Uint8Array(4))]
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");
			const stamp = new Date().toISOString().slice(0, 10);
			await env.TRACES.put(`${stamp}-${id}`, text, { expirationTtl: RETENTION_SECONDS });
			return json({ id });
		}

		if (url.searchParams.get("key") !== env.SECRET_KEY) {
			return json({ error: "no" }, 403);
		}

		if (request.method === "GET" && url.pathname.startsWith("/r/")) {
			const id = url.pathname.slice(3).replace(/[^a-z0-9-]/gi, "");
			if (id === "") return json({ error: "no id" }, 400);
			const name = (await recordingNames(env)).find((n) => n === id || n.endsWith(`-${id}`));
			if (!name) return json({ error: "not found" }, 404);
			const body = await env.TRACES.get(name);
			if (body === null) return json({ error: "not found" }, 404);
			return new Response(body, { headers: { "content-type": "application/json" } });
		}

		if (request.method === "GET" && url.pathname === "/list") {
			return json((await recordingNames(env)).reverse().slice(0, 100));
		}

		return json({ error: "unknown route" }, 404);
	},
};

/** Every stored recording's key, oldest first: the whole namespace, page by page, minus the rate counters. */
async function recordingNames(env) {
	const names = [];
	let cursor;
	for (;;) {
		const page = await env.TRACES.list({ limit: 1000, cursor });
		for (const k of page.keys) if (!k.name.startsWith(RATE_PREFIX)) names.push(k.name);
		if (page.list_complete || !page.cursor) return names;
		cursor = page.cursor;
	}
}

function json(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}
