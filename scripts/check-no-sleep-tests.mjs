#!/usr/bin/env node
// Blocks new real-timer waits and polling loops in *.test.ts under src/ and test/.
// Fake-timer files are out of scope. The allowlist is a burn-down list: it only shrinks.
// Usage: node scripts/check-no-sleep-tests.mjs [--root <dir>] [--list <file>]
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : null;
};
const here = dirname(fileURLToPath(import.meta.url));
const root = flag('--root') ?? join(here, '..');
const listPath = flag('--list') ?? join(here, 'no-sleep-allowlist.txt');

const SCAN_DIRS = ['src', 'test'];
// (a) real sleep: await new Promise(... => setTimeout(...)) or setTimeout(resolve|r|res|done, ...)
const SLEEP = [
	/\bawait\s+new\s+Promise\b[\s\S]{0,300}?\bsetTimeout\s*\(/,
	/\bsetTimeout\s*\(\s*(resolve|r|res|done)\s*,/,
];
// (b) polling loop: a while/for block body that awaits a timer or a requestAnimationFrame promise
const LOOP_HEAD = /\b(?:while|for)\s*\(/g;
function loopAwaitsTimer(src) {
	for (const head of src.matchAll(LOOP_HEAD)) {
		let i = head.index + head[0].length - 1;
		let parens = 0;
		for (; i < src.length; i++) {
			if (src[i] === '(') parens++;
			else if (src[i] === ')' && --parens === 0) break;
		}
		let start = i + 1;
		while (/\s/.test(src[start] ?? '')) start++;
		let body;
		if (src[start] === '{') {
			let braces = 0;
			let close = start;
			for (; close < src.length; close++) {
				if (src[close] === '{') braces++;
				else if (src[close] === '}' && --braces === 0) break;
			}
			body = src.slice(start, close);
		} else {
			// unbraced body: one statement, ends at the first ';' outside brackets or at the enclosing close
			let depth = 0;
			let end = start;
			for (; end < src.length; end++) {
				const c = src[end];
				if (c === '(' || c === '{' || c === '[') depth++;
				else if (c === ')' || c === '}' || c === ']') {
					if (--depth < 0) break;
				} else if (c === ';' && depth === 0) break;
			}
			body = src.slice(start, end);
		}
		// a loop that declares tests (it/test/describe) only registers them; its awaits run later, inside each test
		if (/(?<![.$A-Za-z0-9_])(?:it|test|describe)(?:\.\w+)?\s*\(/.test(body)) continue;
		if (/\bawait\b[^;]{0,300}?\b(?:setTimeout|requestAnimationFrame)\b/.test(body)) return true;
	}
	return false;
}

function walk(dir, out) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== 'node_modules') walk(path, out);
		} else if (entry.name.endsWith('.test.ts')) {
			out.push(path);
		}
	}
	return out;
}

const matches = new Set();
for (const dir of SCAN_DIRS) {
	for (const file of walk(join(root, dir), [])) {
		const src = readFileSync(file, 'utf8');
		if (src.includes('vi.useFakeTimers')) continue;
		if (SLEEP.some((re) => re.test(src)) || loopAwaitsTimer(src)) {
			matches.add(relative(root, file).split(sep).join('/'));
		}
	}
}

const allow = new Set(
	readFileSync(listPath, 'utf8')
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith('#')),
);
const offenders = [...matches].filter((f) => !allow.has(f)).sort();
const stale = [...allow].filter((f) => !matches.has(f)).sort();

for (const f of offenders) {
	console.error(`NEW real sleep or poll in test, not allowlisted: ${f}`);
}
for (const f of stale) {
	console.error(`allowlisted but no longer matches, drop from scripts/no-sleep-allowlist.txt: ${f}`);
}
const failed = offenders.length > 0 || stale.length > 0;
process.stdout.write(`no-sleep: ${matches.size} files match, ${allow.size} allowlisted, ${failed ? 'FAIL' : 'ok'}\n`);
process.exitCode = failed ? 1 : 0;
