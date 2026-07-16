import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const themePath = new URL("../src/theme.css", import.meta.url);

test("defines the Miku palette and Codex surface tokens", async () => {
  const css = await readFile(themePath, "utf8");

  assert.match(css, /CODEX_MIKU_THEME v5 488137 SIDEBAR/);

  for (const token of [
    "--miku-cyan",
    "--miku-blue",
    "--miku-pink",
    "--miku-violet",
    "--miku-ice",
    "--color-background-surface",
    "--color-background-surface-under",
    "--color-background-control",
    "--color-background-panel",
    "--color-background-button-secondary",
    "--color-text-foreground",
    "--color-text-foreground-secondary",
    "--color-text-foreground-tertiary",
    "--color-icon-primary",
    "--vscode-editor-background",
    "--vscode-sideBar-background",
    "--color-token-main-surface-primary",
  ]) {
    assert.match(css, new RegExp(token.replaceAll("-", "\\-")));
  }

  for (const color of [
    "#f5f6fc",
    "#dbf4fc",
    "#19c9e5",
    "#90b3fa",
    "#ed6ec1",
    "#ad7ed5",
    "#122c60",
  ]) {
    assert.ok(css.toLowerCase().includes(color), `missing reference color: ${color}`);
  }
});

test("styles stable Codex shell, composer, and interaction surfaces", async () => {
  const css = await readFile(themePath, "utf8");

  for (const selector of [
    ':root[data-codex-window-type="electron"]',
    ".app-shell-left-panel",
    ".main-surface",
    ".app-header-tint",
    ".composer-surface-chrome",
    '[data-app-action-sidebar-thread-active="true"]',
    "[data-user-message-bubble]",
    "[data-local-conversation-final-assistant]",
    "[data-codex-approval-surface]",
    "::-webkit-scrollbar-thumb",
  ]) {
    assert.ok(css.includes(selector), `missing selector: ${selector}`);
  }
});

test("builds the reference sidebar hierarchy and interaction states", async () => {
  const css = await readFile(themePath, "utf8");

  for (const selector of [
    "[data-app-action-sidebar-scroll]",
    "[data-app-action-sidebar-section]",
    "[data-app-action-sidebar-section-heading]",
    "[data-app-action-sidebar-section-toggle]",
    "[data-app-action-sidebar-project-row]",
    "[data-app-action-sidebar-project-label]",
    "[data-app-action-sidebar-thread-row]",
    "[data-app-action-sidebar-thread-title]",
    "[data-app-shell-sidebar-trigger]",
  ]) {
    assert.ok(css.includes(selector), `missing optimized sidebar selector: ${selector}`);
  }

  assert.match(css, /data-app-action-sidebar-thread-row[^}]*min-height:\s*32px/s);
  assert.match(css, /data-app-action-sidebar-section-heading[^}]*letter-spacing/s);
  assert.match(css, /data-app-action-sidebar-thread-row[^}]*:hover/s);
});

test("uses clean hero art, supporting crops, and main-window-only decorative layers", async () => {
  const css = await readFile(themePath, "utf8");

  for (const asset of [
    "dialog-artwork-connected-NZKCls7p.png",
    "page-artwork-allow-host-CPm7eJR2.png",
    "page-artwork-waiting-pzj85BPm.png",
    "dialog-artwork-waiting-phone-UTYmfLHs.png",
  ]) {
    assert.ok(css.includes(asset), `missing embedded artwork: ${asset}`);
  }

  assert.match(css, /#root:has\(\.app-shell-left-panel\)\s*\{/);
  assert.match(css, /#root:has\(\.app-shell-left-panel\)::before/);
  assert.doesNotMatch(css, /(?:^|\n)#root(?:\s*\{|::)/);
  assert.doesNotMatch(
    css.match(/\.main-surface,[\s\S]*?\.browser-main-surface\s*\{([\s\S]*?)\}/)?.[1] ?? "",
    /page-artwork-allow-host-CPm7eJR2\.png/,
    "the full hero and character crop must not be stacked on the same surface",
  );
  assert.match(css, /[✦♡♪☆]/u);
  assert.match(css, /saturate\(/);
  assert.match(css, /backdrop-filter/);
});

test("widens the branded sidebar, home cards, and conversation canvas", async () => {
  const css = await readFile(themePath, "utf8");

  assert.match(css, /\.app-shell-left-panel[\s\S]*?width:\s*clamp\([^;]*20vw/);
  assert.match(css, /\.app-shell-left-panel::before[\s\S]*?Miku Codex/);
  assert.match(css, /\.main-surface \.max-w-3xl/);
  assert.match(css, /min-h-26/);
});

test("keeps the full chat canvas themed below the hero artwork", async () => {
  const css = await readFile(themePath, "utf8");
  const mainSurface = css.match(/\.main-surface,[\s\S]*?\.browser-main-surface\s*\{([\s\S]*?)\}/)?.[1] ?? "";

  assert.match(mainSurface, /min-height:\s*100%/);
  assert.match(mainSurface, /#dbf4fc/i);
  assert.match(mainSurface, /#e7dbf5/i);
  assert.doesNotMatch(mainSurface, /#f8f8fcf7\s+100%/i);
});

test("does not load remote assets or force motion", async () => {
  const css = await readFile(themePath, "utf8");
  assert.doesNotMatch(css, /https?:\/\//i);
  assert.doesNotMatch(css, /@keyframes|animation\s*:/i);
});
