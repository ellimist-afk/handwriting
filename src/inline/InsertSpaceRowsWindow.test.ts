/**
 * Insert-space row grouping: the windowed floating-mark pass groups exactly
 * as the all-rows pass it replaced.
 *
 * The mark pass used to filter every row for every row (quadratic; 30-80 ms
 * on one to two thousand written lines, after each ink change). It now
 * checks only rows whose top lies within the tallest group's height below
 * the mark. `referenceRows` below is that all-rows pass, kept as the oracle,
 * so any drift in which host a mark joins, or in tie order, shows here.
 *
 * The oracle judges a host by its own first-pass group, never by the marks
 * it has taken, as the production pass does. Both passes once judged a host
 * grown, so each mark it took could qualify the next row above it, and on a
 * heavy page one row ran most of the page's height (InsertSpaceHeavyPage).
 */
import { describe, expect, it } from "vitest";
import { InsertSpaceRows, type InkRow } from "./InsertSpace";
import type { InkStroke } from "../ink/Stroke";

// ---- the all-rows pass, kept as the oracle -----------------------------------
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
	// A mark (a full stop, a comma, a colon's dots, a dash) is too short for
	// the rule below: a tapped dot has no height, so it joined nothing and
	// Insert space left it behind its word. A stroke is a mark beside another
	// when its height is at most a quarter of the other's, its vertical span
	// lies inside the other's, and its width is at most 0.34 of the other's
	// height; it may then join across a gap of up to the larger of three of
	// its own heights and the other's height. A mark takes ONE such join, to
	// the nearest candidate (the first in sort order on a tie), so a full stop
	// between its word and a tall drawing never joins the two. A stroke that
	// joins a neighbour the ordinary way is not a mark: a letter of a word
	// passes the mark test beside a tall drawing, and would carry its word in.
	const markTo=items.map(()=>-1),markGap=items.map(()=>Infinity),joined=items.map(()=>false);
	const markJoin=(m:number,o:number,gap:number)=>{
		const mk=items[m]!,ot=items[o]!,hm=mk.bottom-mk.top,ho=ot.bottom-ot.top;
		if(!(hm<=ho/4&&mk.top>=ot.top&&mk.bottom<=ot.bottom&&mk.right-mk.left<=ho*.34&&gap<=Math.max(3*hm,ho)))return;
		if(gap<markGap[m]!||(gap===markGap[m]!&&o<markTo[m]!)){markGap[m]=gap;markTo[m]=o;}
	};
	let active:number[]=[];
	for(let i=0;i<items.length;i++){
		const a=items[i]!;
		active=active.filter(j=>items[j]!.bottom>a.top);
		for(const j of active){
			const b=items[j]!;
			if(a.bottom<=b.top)continue;
			const gap=Math.max(0,a.left-b.right,b.left-a.right);
			if(gap<=3*Math.min(a.bottom-a.top,b.bottom-b.top)){parents[root(i)]=root(j);joined[i]=joined[j]=true;}
			markJoin(i,j,gap);markJoin(j,i,gap);
		}
		active.push(i);
	}
	markTo.forEach((o,m)=>{if(o>=0&&!joined[m])parents[root(m)]=root(o);});
	const grouped=new Map<number,InkRow & {left:number;right:number}>();
	items.forEach((s,i)=>{
		const key=root(i),row=grouped.get(key);
		if(row){row.ids.push(s.id);row.top=Math.min(row.top,s.top);row.bottom=Math.max(row.bottom,s.bottom);row.left=Math.min(row.left,s.left);row.right=Math.max(row.right,s.right);}
		else grouped.set(key,{top:s.top,bottom:s.bottom,left:s.left,right:s.right,ids:[s.id]});
	});
	// `g` is each row's first-pass group: the only geometry a mark or a host is judged by.
	const rows=[...grouped.values()].sort((a,b)=>a.top-b.top||a.left-b.left)
		.map(r=>({...r,g:{top:r.top,bottom:r.bottom,left:r.left,right:r.right}}));
	// A floating mark chooses the nearest eligible LOCAL host below it,
	// regardless of interleaved groups in another column. The height-relative
	// width/overhang allowance also handles a dot above a lone vertical stem.
	for(const mark of [...rows].reverse()){
		const m=mark.g;
		const hosts=rows.filter(host=>{
			if(host===mark)return false;
			const c=host.g,height=c.bottom-c.top,gap=c.top-m.bottom;
			return height>0 && gap>=0 && gap<=height && m.bottom-m.top<=height*.34 &&
				m.right-m.left<=Math.max(c.right-c.left,height*.25)*.34 &&
				m.left>=c.left-height*.1 && m.right<=c.right+height*.1;
		}).sort((a,b)=>(a.g.top-m.bottom)-(b.g.top-m.bottom)||
			Math.abs(a.g.left+a.g.right-m.left-m.right)-Math.abs(b.g.left+b.g.right-m.left-m.right)||a.g.left-b.g.left);
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
	it("groups 60 random pages exactly as the all-rows pass", () => {
		// Every seed is compared, so a failure lists all the pages that differ, not the first.
		const same = (a: unknown, b: unknown) => { try { expect(a).toEqual(b); return true; } catch { return false; } };
		const differ: number[] = [];
		for (let seed = 1; seed <= 60; seed++) {
			const strokes = page(20 + (seed % 7) * 15, seed);
			if (!same(new InsertSpaceRows().get(strokes), referenceRows(strokes))) differ.push(seed);
		}
		expect(differ, "seeds whose rows differ from the all-rows pass").toEqual([]);
	});

	it("a mark between two identical hosts joins the one the all-rows pass chooses", () => {
		const strokes = [
			mk("hostA", 0, 20, 60, 40), mk("hostB", 0, 20, 60, 40),
			mk("dot", 28, 12, 31, 15),
			mk("left", -40, 20, 20, 40), mk("right", 40, 20, 100, 40),
			mk("dot2", 38, 12, 41, 15),
		];
		expect(new InsertSpaceRows().get(strokes)).toEqual(referenceRows(strokes));
	});

	it("a stack of marks over one host groups as the all-rows pass groups it", () => {
		const strokes = [
			mk("base", 0, 100, 300, 160),
			mk("m1", 100, 70, 160, 90),
			mk("m2", 120, 58, 130, 64),
			mk("m3", 124, 54, 126, 56),
		];
		expect(new InsertSpaceRows().get(strokes)).toEqual(referenceRows(strokes));
	});
});
