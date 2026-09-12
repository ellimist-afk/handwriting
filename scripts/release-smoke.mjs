/** A selected automated regression floor, never device or release acceptance.
 * Keep explicit paths: a removed test must fail, not silently shrink coverage.
 * The existing gate/release scripts deliberately remain unchanged.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
if (process.env.HW_SCROLL_BASELINE === "1") throw new Error("Unset HW_SCROLL_BASELINE: smoke must test candidate source, not a historical baseline.");
const unit = [
  "src/inline/InsertSpace.test.ts",
  "src/inline/InkHistoryIdentity.test.ts",
  "src/persistence/InkFolder.test.ts",
  "src/persistence/PageStore.test.ts",
  "src/ChangeInkFolderWiring.test.ts",
  "src/inline/InlineInkStore.reload.test.ts",
  "src/pdf/PdfInkReload.test.ts",
  "src/PdfSharedReload.test.ts",
  "src/LiveReloadIsolation.test.ts",
];
const render = [
  "test/render/ContentOriginColumn.test.ts",
  "test/render/MinimalResync.test.ts",
  "test/render/ZoomWrittenInkDrift.test.ts",
  "test/render/ScrollExpansion.test.ts",
];
for (const path of [...unit, ...render]) {
  if (!existsSync(new URL(`../${path}`, import.meta.url))) throw new Error(`Missing selected test: ${path}`);
}
console.log("AUTOMATED REGRESSION ONLY. Open workflow gaps: docs/release-workflow-checks.md");
for (const [config, paths] of [["vitest.config.mts", unit], ["vitest.render.mts", render]]) {
  const result = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--config", config, "--maxWorkers=2", ...paths], {
    cwd: root, stdio: "inherit", shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log("Selected automated regressions passed. Device acceptance remains separate and required.");
