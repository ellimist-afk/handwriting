/**
 * PDFs built for tests, rather than checked in as bytes.
 *
 * A fixture whose cross-reference offsets are computed here is one whose
 * offsets are known to be right, and it can be varied - rotation, a shared
 * resources object, a box that does not start at the origin - without
 * finding a document in the wild that happens to have that shape. Shared by
 * the reader's suite and the append writer's.
 */

/** Objects numbered from 1, with a classic table over them. */
export function assemble(objects: readonly string[], trailerExtra = ""): string {
	let out = "%PDF-1.7\n";
	const offsets: number[] = [];
	objects.forEach((obj, i) => {
		offsets.push(out.length);
		out += `${i + 1} 0 obj\n${obj}\nendobj\n`;
	});
	const startxref = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
	out +=
		`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra}>>\n` +
		`startxref\n${startxref}\n%%EOF\n`;
	return out;
}

/**
 * A document of `count` pages. `page` adds to each page dictionary, `tree` to
 * the node above them, `after` appends further objects the pages can point at
 * - a content stream, a shared resources dictionary - and `box` is the page
 * box, or null to leave it out so the tree above can supply it.
 */
export function document(
	count: number,
	page: (i: number) => string = () => "",
	tree = "",
	after: readonly string[] = [],
	box: string | null = "[0 0 612 792]"
): string {
	const kids = Array.from({ length: count }, (_, i) => `${3 + i} 0 R`).join(" ");
	return assemble([
		"<< /Type /Catalog /Pages 2 0 R >>",
		`<< /Type /Pages /Kids [${kids}] /Count ${count} ${tree}>>`,
		...Array.from(
			{ length: count },
			(_, i) =>
				`<< /Type /Page /Parent 2 0 R ${box === null ? "" : `/MediaBox ${box} `}${page(i)}>>`
		),
		...after,
	]);
}

/** A content stream object, sized the way the reader will check it. */
export function streamObject(body: string): string {
	return `<< /Length ${body.length} >>\nstream\n${body}\nendstream`;
}

/** One cross-reference stream row, in the `/W [1 4 2]` shape this file uses. */
function row(type: number, a: number, b: number): string {
	return String.fromCharCode(
		type,
		(a >>> 24) & 0xff,
		(a >>> 16) & 0xff,
		(a >>> 8) & 0xff,
		a & 0xff,
		(b >>> 8) & 0xff,
		b & 0xff
	);
}

/**
 * A document whose table is a STREAM, which is what a 1.5+ writer emits.
 *
 * Written without a filter. That is legal, and it keeps the fixture readable
 * as bytes while still exercising every part of the reader except the
 * decompressor, which has its own suite.
 */
export function streamedDocument(
	count = 1,
	page: (i: number) => string = () => "",
	after: readonly string[] = []
): string {
	const kids = Array.from({ length: count }, (_, i) => `${3 + i} 0 R`).join(" ");
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		`<< /Type /Pages /Kids [${kids}] /Count ${count} >>`,
		...Array.from(
			{ length: count },
			(_, i) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ${page(i)}>>`
		),
		...after,
	];
	let out = "%PDF-1.5\n";
	const offsets: number[] = [];
	objects.forEach((obj, i) => {
		offsets.push(out.length);
		out += `${i + 1} 0 obj\n${obj}\nendobj\n`;
	});
	const self = objects.length + 1;
	const startxref = out.length;
	let table = row(0, 0, 65535);
	for (const off of offsets) table += row(1, off, 0);
	table += row(1, startxref, 0);
	out +=
		`${self} 0 obj\n<< /Type /XRef /Size ${self + 1} /Root 1 0 R /W [1 4 2] ` +
		`/Index [0 ${self + 1}] /Length ${table.length} >>\nstream\n${table}\nendstream\nendobj\n`;
	return out + `startxref\n${startxref}\n%%EOF\n`;
}

/**
 * A document whose catalog, page tree and pages are all PACKED into an object
 * stream - so none of them has a byte offset of its own, and reaching a page
 * means opening the bundle first.
 */
export function packedDocument(count = 1, page: (i: number) => string = () => ""): string {
	const kids = Array.from({ length: count }, (_, i) => `${3 + i} 0 R`).join(" ");
	const bodies = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		`<< /Type /Pages /Kids [${kids}] /Count ${count} >>`,
		...Array.from(
			{ length: count },
			(_, i) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ${page(i)}>>`
		),
	];
	let heads = "";
	let at = 0;
	const chunks = bodies.map((b) => `${b}\n`);
	chunks.forEach((chunk, i) => {
		heads += `${i + 1} ${at} `;
		at += chunk.length;
	});
	const content = heads + chunks.join("");
	const bundle = bodies.length + 1;
	const self = bodies.length + 2;

	let out = "%PDF-1.5\n";
	const bundleAt = out.length;
	out +=
		`${bundle} 0 obj\n<< /Type /ObjStm /N ${bodies.length} /First ${heads.length} ` +
		`/Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`;
	const startxref = out.length;
	let table = row(0, 0, 65535);
	for (let i = 0; i < bodies.length; i++) table += row(2, bundle, i);
	table += row(1, bundleAt, 0);
	table += row(1, startxref, 0);
	out +=
		`${self} 0 obj\n<< /Type /XRef /Size ${self + 1} /Root 1 0 R /W [1 4 2] ` +
		`/Index [0 ${self + 1}] /Length ${table.length} >>\nstream\n${table}\nendstream\nendobj\n`;
	return out + `startxref\n${startxref}\n%%EOF\n`;
}
