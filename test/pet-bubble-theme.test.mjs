import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceThemeUrl = new URL("../src/theme.css", import.meta.url);
const bundledThemeUrl = new URL(
  "../skill/codex-miku-theme/payload/src/theme.css",
  import.meta.url,
);

for (const [label, url] of [
  ["source", sourceThemeUrl],
  ["bundled", bundledThemeUrl],
]) {
  test(`${label} theme gives the pet notification bubble a light Miku surface`, async () => {
    const css = await readFile(url, "utf8");

    assert.match(
      css,
      /\._cssMaterial_wdtwh_1\s*,/,
    );
    assert.match(
      css,
      /\._cssMaterial_wdtwh_1[\s\S]*?\{[\s\S]*?border:\s*1px solid #90b3fa80\s*!important;[\s\S]*?background:\s*#fafaffe8\s*!important;/,
    );
  });

  test(`${label} theme keeps main-window root decoration out of the pet WebView`, async () => {
    const css = await readFile(url, "utf8");

    assert.match(css, /html,\s*body\s*\{[\s\S]*?background:\s*transparent\s*!important/);
    assert.match(css, /body:has\(\.app-shell-left-panel\)/);
    assert.match(css, /#root:has\(\.app-shell-left-panel\)/);
    assert.doesNotMatch(css, /(?:^|\n)#root(?:\s*\{|::)/);
  });
}
