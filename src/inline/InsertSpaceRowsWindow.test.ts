/**
 * Insert-space row grouping: the windowed floating-mark pass groups exactly
 * as the all-rows pass it replaced.
 *
 * The mark pass used to filter every row for every row (quadratic; 30-80 ms
 * on one to two thousand written lines, after each ink change). It now
 * checks only rows whose top lies within the tallest row's height below the
 * mark. `referenceRows` below is the previous implementation, verbatim, so
 * any drift in which host a mark joins, or in tie order, shows here.
 */
import { describe, expect, it } from "vitest";
import { InsertSpaceRows, type InkRow } from "./InsertSpace";
import type { InkStroke } from "../ink/Stroke";

// ---- the previous implementation, kept as the oracle -------------------------
function extentOf(stroke: InkStroke): { top: number; bottom: number; left:number; right:number } {
	const pts = stroke.points;
	if (pts.length === 0) return { top: stroke.bbox.y, bottom: stroke.bbox.y + stroke.bbox.height, left:stroke.bbox.x, right:stroke.bbox.x+stroke.bbox.width };
	let top = Infinity;
	let bottom = -Infinity;
	let left = Infinity, right = -Infinity;
	for (const p of pts) {
		if (p.y < top) top = p.y;
		if (p.y > bottom) bottom = p.y;
		if (p.x < left) left = p.x;
		if (p.x > right) right = p.x;
	}
	return { top, bottom, left, right };
}

function referenceRows(strokes: readonly InkStroke[]): InkRow[] {
	const items = strokes
		.map((s) => ({ id: s.id, ...extentOf(s) }))
		.sort((a, b) => a.top - b.top || a.left-b.left);
	const parents=items.map((_,i)=>i);
	const root=(i:number):number=>{
		while(parents[i]!==i){parents[i]=parents[parents[i]!]!;i=parents[i]!;}
		return i;
	};
	let active:number[]=[];
	for(let i=0;i<items.length;i++){
		const a=items[i]!;
		active=active.filter(j=>items[j]!.bottom>a.top);
		for(const j of active){
			const b=items[j]!;
			if(a.bottom<=b.top)continue;
			const gap=Math.max(0,a.left-b.right,b.left-a.right);
			if(gap<=3*Math.min(a.bottom-a.top,b.bottom-b.top))parents[root(i)]=root(j);
		}
		active.push(i);
	}
	const grouped=new Map<number,InkRow & {left:number;right:number}>();
	items.forEach((s,i)=>{
		const key=root(i),row=grouped.get(key);
		if(row){row.ids.push(s.id);row.top=Math.min(row.top,s.top);row.bottom=Math.max(row.bottom,s.bottom);row.left=Math.min(row.left,s.left);row.right=Math.max(row.right,s.right);}
		else grouped.set(key,{top:s.top,bottom:s.bottom,left:s.left,right:s.right,ids:[s.id]});
	});
	const rows=[...grouped.values()].sort((a,b)=>a.top-b.top||a.left-b.left);
	// A floating mark chooses the nearest eligible LOCAL host below it,
	// regardless of interleaved groups in another column. The height-relative
	// width/overhang allowance also handles a dot above a lone vertical stem.
	for(const mark of [...rows].reverse()){
		const hosts=rows.filter(host=>{
			if(host===mark)return false;
			const height=host.bottom-host.top,gap=host.top-mark.bottom;
			return height>0 && gap>=0 && gap<=height && mark.bottom-mark.top<=height*.34 &&
				mark.right-mark.left<=Math.max(host.right-host.left,height*.25)*.34 &&
				mark.left>=host.left-height*.1 && mark.right<=host.right+height*.1;
		}).sort((a,b)=>(a.top-mark.bottom)-(b.top-mark.bottom)||
			Math.abs(a.left+a.right-mark.left-mark.right)-Math.abs(b.left+b.right-mark.left-mark.right)||a.left-b.left);
		const host=hosts[0];
		if(!host)continue;
		host.ids.push(...mark.ids);host.top=mark.top;
		host.left=Math.min(host.left,mark.left);host.right=Math.max(host.right,mark.right);
		rows.splice(rows.indexOf(mark),1);
	}
	return rows.sort((a,b)=>a.top-b.top||a.left-b.left).map(({top,bottom,ids})=>({top,bottom,ids}));
}

// ---- fixtures ------------------------------------------------------------------

function mk(id: string, x0: number, y0: number, x1: number, y1: number): InkStroke {
	const points = [{ x: x0, y: y0, pressure: 0.5, t: 0 }, { x: x1, y: y1, pressure: 0.5, t: 8 }];
	return {
		id, tool: "pen", color: "#000000", width: 2, points,
		bbox: { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) },
		createdAt: 0,
	};
}

/** Handwriting-like: lines of word strokes, dots and accents above some, a
 * second column, the odd tall stroke across lines, and exact duplicates. */
function page(lines: number, seed: number): InkStroke[] {
	let s = seed;
	const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
	const out: InkStroke[] = [];
	let n = 0;
	for (let i = 0; i < lines; i++) {
		const base = i * 30;
		for (let col = 0; col < (rnd() < 0.2 ? 2 : 1); col++) {
			let x = col * 400 + rnd() * 10;
			const words = 1 + Math.floor(rnd() * 5);
			for (let w = 0; w < words; w++) {
				const width = 10 + rnd() * 60, h = 8 + rnd() * 14;
				out.push(mk(`w${n++}`, x, base + 20 - h, x + width, base + 20));
				if (rnd() < 0.4) {
					const dx = x + rnd() * width;
					out.push(mk(`d${n++}`, dx, base + 20 - h - 3 - rnd() * 3, dx + 1 + rnd() * 2, base + 20 - h - 2));
				}
				if (rnd() < 0.05) out.push(mk(`t${n++}`, x, base - 20, x + 3, base + 40));
				if (rnd() < 0.05) out.push(mk(`z${n++}`, x, base + 10, x + 8, base + 10));
				x += width + 8 + rnd() * 10;
			}
		}
		if (rnd() < 0.1) {
			const dup = out[out.length - 1]!;
			out.push({ ...dup, id: `dup${n++}` });
		}
	}
	// Store order is not spatial order.
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rnd() * (i + 1));
		[out[i], out[j]] = [out[j]!, out[i]!];
	}
	return out;
}

describe("insert-space row grouping, windowed mark pass", () => {
	it("groups 60 random pages exactly as the previous pass", () => {
		for (let seed = 1; seed <= 60; seed++) {
			const strokes = page(20 + (seed % 7) * 15, seed);
			expect(new InsertSpaceRows().get(strokes), `seed ${seed}`).toEqual(referenceRows(strokes));
		}
	});

	it("a mark between two identical hosts joins the one the previous pass chose", () => {
		const strokes = [
			mk("hostA", 0, 20, 60, 40), mk("hostB", 0, 20, 60, 40),
			mk("dot", 28, 12, 31, 15),
			mk("left", -40, 20, 20, 40), mk("right", 40, 20, 100, 40),
			mk("dot2", 38, 12, 41, 15),
		];
		expect(new InsertSpaceRows().get(strokes)).toEqual(referenceRows(strokes));
	});

	it("a chain of marks, each hosting the one above, groups as before", () => {
		const strokes = [
			mk("base", 0, 100, 300, 160),
			mk("m1", 100, 70, 160, 90),
			mk("m2", 120, 58, 130, 64),
			mk("m3", 124, 54, 126, 56),
		];
		expect(new InsertSpaceRows().get(strokes)).toEqual(referenceRows(strokes));
	});
});
