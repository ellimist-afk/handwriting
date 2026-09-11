import { expect, it } from "vitest";
import { transformSync } from "esbuild";
import { readFileSync } from "node:fs";

it("keeps repaired Obsidian runtime scheduler and deprecated DOM access rules clear", () => {
 const files=["diag/UndoHistoryTrace.ts","inline/EmbedInk.ts","inline/PenToolsMode.ts","slides/SlidesInkSurface.ts","inline/DeviceInput.ts","inline/FoldOrderControl.ts","persistence/PageStore.ts","ink/InkPresetHost.ts","main.ts"];
 const failures:string[]=[];
 for(const file of files){
  // Parse TypeScript first so comments and type declarations cannot trigger rules.
  const {code}=transformSync(readFileSync(`src/${file}`,"utf8"),{loader:"ts",format:"esm",legalComments:"none"});
  for(const rule of [/(?<![.\w])(?:setTimeout|clearTimeout|requestAnimationFrame|cancelAnimationFrame)\(/g,/\.\s*(?:noticeEl|activeLeaf)\b/g,/\bglobalThis\b/g]){
   for(const match of code.matchAll(rule))failures.push(`${file}: ${match[0]}`);
  }
 }
 expect(failures).toEqual([]);
});
