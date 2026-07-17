# HeiGe Codex Theme Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the compact list menu with the approved Aurora Gallery theme center, including real theme previews, immediate switching, durable confirmation, rollback, responsive layout, and accessible dialog behavior.

**Architecture:** Keep `buildSkinMenuScript` as the single injected runtime, but move the static visual stylesheet into a focused module. Enrich the existing theme payload with its four validated manifest colors, derive built-in previews from the already embedded generated CSS instead of duplicating image bytes, and preserve the current controller protocol and optimistic transaction state machine.

**Tech Stack:** Node.js 22 ESM, browser DOM APIs, generated vanilla JavaScript, CSS Grid, Happy DOM, Node test runner, CDP renderer injection.

---

## File structure

- Create `src/theme-center-style.mjs`: one exported static CSS string for the trigger, backdrop, dialog, cards, responsive grid, and fixed footer.
- Modify `src/skin-menu.mjs`: payload normalization, preview extraction, dialog DOM, focus management, theme cards, status painting, upload, native restore, custom theme, persistence footer, and disposal.
- Modify `src/injector.mjs`: pass all four validated theme colors into each menu entry.
- Modify `test/skin-menu.test.mjs`: payload and preview-parser contract tests.
- Modify `test/skin-menu.dom.test.mjs`: dialog, focus, cards, status, rollback, custom theme, native restore, and responsive contract tests.
- Modify `test/helpers/menu-window.mjs`: expose the new dialog, backdrop, status, hero, and card helpers.
- Modify `scripts/skill-package-manifest.json`: package the new stylesheet module.
- Modify `test/skill-package.test.mjs`: require the new module in the deterministic archive.
- Rebuild `output/heige-codex-skin-studio.skill` and update `docs/release/2026-07-16-audit-hardening-disposition.md` only after all source tests pass.

### Task 1: Theme preview and color payload contract

**Files:**
- Modify: `src/injector.mjs:153-168`
- Modify: `src/skin-menu.mjs:1-105`
- Modify: `test/skin-menu.test.mjs`

- [ ] **Step 1: Write failing tests for colors and zero-duplication preview extraction**

Add these imports and tests to `test/skin-menu.test.mjs`:

```js
import {
  buildSkinMenuScript,
  CSS_SENTINELS,
  previewFromGeneratedCss,
} from "../src/skin-menu.mjs";

test("extracts one validated hero data URL from generated theme CSS", () => {
  const hero = "data:image/webp;base64,QUJDRA==";
  const css = `#root { background:
    linear-gradient(#fff, transparent),
    url(${JSON.stringify(hero)}) right center / cover no-repeat fixed !important;
  }`;
  assert.equal(previewFromGeneratedCss(css), hero);
  assert.equal(previewFromGeneratedCss("html { color: red; }"), null);
  assert.equal(previewFromGeneratedCss("#root{background:url(https://example.com/x.webp)}"), null);
});

test("embeds validated theme colors without adding a duplicate preview field", () => {
  const script = buildSkinMenuScript({
    ...base,
    activeId: "miku-488137",
    entries: [{
      id: "miku-488137",
      name: "Miku",
      accent: "#19c9e5",
      colors: {
        accent: "#19c9e5",
        secondary: "#ed6ec1",
        surface: "#f5f6fc",
        text: "#122c60",
      },
      css: `#root{background:url("data:image/webp;base64,QUJDRA==")}`,
    }],
  });
  assert.match(script, /"secondary":"#ed6ec1"/);
  assert.doesNotMatch(script, /"preview":/);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
node --test --test-name-pattern="validated hero|validated theme colors" test/skin-menu.test.mjs
```

Expected: FAIL because `previewFromGeneratedCss` is not exported and theme entries discard all colors except accent.

- [ ] **Step 3: Implement the strict preview parser**

Add this self-contained export near the constants in `src/skin-menu.mjs`:

```js
const GENERATED_HERO = /url\("(data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+)"\)/;

export function previewFromGeneratedCss(css) {
  if (typeof css !== "string" || css.length === 0) return null;
  const match = GENERATED_HERO.exec(css);
  return match?.[1] ?? null;
}
```

When building the injected string, serialize this exact implementation rather than maintaining a second parser:

```js
const previewParserSource = previewFromGeneratedCss.toString();
```

Inside the returned script, define:

```js
const previewFromGeneratedCss = ${previewParserSource};
```

- [ ] **Step 4: Pass and normalize all four manifest colors**

Change `themeEntry` in `src/injector.mjs` to:

```js
function themeEntry(resources) {
  const { loadedTheme, hero, logo, polaroid } = resources;
  return {
    id: loadedTheme.manifest.id,
    name: loadedTheme.manifest.name,
    accent: loadedTheme.manifest.colors?.accent,
    colors: { ...loadedTheme.manifest.colors },
    css: buildSkinCss({
      theme: loadedTheme.manifest,
      heroDataUrl: dataUrl(hero),
      logoDataUrl: dataUrl(logo),
      polaroidDataUrl: dataUrl(polaroid),
    }),
  };
}
```

Normalize each menu theme in `buildSkinMenuScript`:

```js
const colorValue = (value, fallback) => HEX_COLOR.test(value ?? "") ? value : fallback;
const themes = entries.map((entry) => {
  if (!entry?.id || typeof entry.css !== "string") {
    throw new Error("主题条目缺少 id 或 css");
  }
  const accent = colorValue(entry.colors?.accent ?? entry.accent, DEFAULT_ACCENT);
  return {
    id: String(entry.id),
    name: typeof entry.name === "string" && entry.name.trim() ? entry.name : String(entry.id),
    colors: {
      accent,
      secondary: colorValue(entry.colors?.secondary, "#ed6ec1"),
      surface: colorValue(entry.colors?.surface, "#f5f6fc"),
      text: colorValue(entry.colors?.text, "#17344f"),
    },
    css: entry.css,
  };
});
```

- [ ] **Step 5: Run focused tests and commit**

Run:

```bash
node --test test/skin-menu.test.mjs test/injector.test.mjs
```

Expected: all selected tests pass.

Commit:

```bash
git add src/injector.mjs src/skin-menu.mjs test/skin-menu.test.mjs
git commit -m "feat: expose safe theme preview metadata"
```

### Task 2: Aurora Gallery stylesheet module

**Files:**
- Create: `src/theme-center-style.mjs`
- Modify: `src/skin-menu.mjs`
- Modify: `scripts/skill-package-manifest.json`
- Modify: `test/skill-package.test.mjs`
- Modify: `test/skin-menu.test.mjs`

- [ ] **Step 1: Write failing style and package tests**

Add to `test/skin-menu.test.mjs`:

```js
test("ships the responsive Aurora Gallery dialog without external resources or animation", () => {
  const script = buildSkinMenuScript({
    ...base,
    activeId: "a",
    entries: [{ id: "a", name: "A", accent: "#123456", css: "#root{}" }],
  });
  assert.match(script, /data-heige-role="theme-center"/);
  assert.match(script, /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(script, /@media \(max-width:979px\)/);
  assert.match(script, /@media \(max-width:679px\)/);
  assert.doesNotMatch(script, /https?:\/\//);
  assert.doesNotMatch(script, /@keyframes|animation:/);
});
```

Add the expected archive entry to the exact file list in `test/skill-package.test.mjs`:

```js
"heige-codex-skin-studio/payload/src/theme-center-style.mjs",
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
node --test --test-name-pattern="Aurora Gallery|explicitly allowlists every runtime source module" \
  test/skin-menu.test.mjs test/skill-package.test.mjs
```

Expected: FAIL because the style module and manifest entry do not exist.

- [ ] **Step 3: Create the focused style module**

Create `src/theme-center-style.mjs` with one static export. The complete class contract is:

```js
export const THEME_CENTER_STYLE = String.raw`
#heige-codex-skin-menu {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  pointer-events: none;
  color: #17344f;
  font: 500 13px/1.4 ui-rounded, "SF Pro Rounded", system-ui, sans-serif;
  -webkit-app-region: no-drag;
}
#heige-codex-skin-menu [hidden] { display: none !important; }
[data-heige-role="menu-trigger"] {
  pointer-events: auto;
  position: fixed;
  top: 9px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  padding: 0 10px 0 5px;
  border: 1px solid color-mix(in srgb, var(--heige-accent, #19c9e5) 25%, transparent);
  border-radius: 999px;
  background: rgba(255,255,255,.78);
  box-shadow: 0 6px 22px rgba(26,111,126,.16);
  backdrop-filter: blur(18px) saturate(1.06);
  color: #17344f;
  cursor: pointer;
}
[data-heige-role="menu-trigger-preview"] {
  width: 19px;
  height: 19px;
  flex: none;
  border-radius: 50%;
  background-position: center;
  background-size: cover;
  box-shadow: 0 0 0 2px rgba(255,255,255,.82);
}
[data-heige-role="theme-center-backdrop"] {
  pointer-events: auto;
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 48px 16px 16px;
  background: rgba(17,35,47,.22);
  backdrop-filter: blur(7px) saturate(.94);
}
[data-heige-role="theme-center"] {
  width: min(70vw, 1100px);
  min-width: min(760px, calc(100vw - 32px));
  height: min(760px, calc(100vh - 72px));
  display: grid;
  grid-template-rows: 76px minmax(0,1fr) 58px;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,.82);
  border-radius: 26px;
  background:
    radial-gradient(circle at 94% 0, rgba(23,206,210,.15), transparent 29%),
    radial-gradient(circle at 2% 100%, rgba(238,108,187,.11), transparent 28%),
    rgba(246,251,251,.9);
  box-shadow: 0 30px 80px rgba(27,76,97,.25);
  backdrop-filter: blur(32px) saturate(1.08);
}
[data-heige-role="theme-center-header"],
[data-heige-role="theme-center-footer"] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  background: rgba(248,252,255,.64);
}
[data-heige-role="theme-center-header"] { border-bottom: 1px solid rgba(23,77,102,.1); }
[data-heige-role="theme-center-footer"] { border-top: 1px solid rgba(23,77,102,.1); }
[data-heige-role="theme-center-scroll"] {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 20px 24px 24px;
}
[data-heige-role="current-theme-hero"] {
  min-height: 112px;
  display: flex;
  align-items: end;
  justify-content: space-between;
  padding: 18px;
  border-radius: 18px;
  background-position: center;
  background-size: cover;
  box-shadow: 0 15px 35px rgba(29,97,120,.2);
  color: #fff;
}
[data-heige-role="quick-actions"] {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
[data-heige-role="theme-grid"] {
  display: grid;
  grid-template-columns: repeat(3,minmax(0,1fr));
  gap: 10px;
}
[data-heige-role="theme-option"],
[data-heige-role="native-option"],
[data-heige-role="upload-trigger"] {
  min-width: 0;
  border: 1px solid rgba(25,122,139,.13);
  border-radius: 15px;
  background: rgba(255,255,255,.62);
  color: inherit;
  cursor: pointer;
}
[data-heige-role="theme-option"] { display: grid; grid-template-columns: 92px minmax(0,1fr) 20px; gap: 10px; padding: 7px; text-align: left; }
[data-heige-role="theme-option"][aria-pressed="true"] {
  border-color: #13b7bd;
  box-shadow: 0 0 0 3px rgba(237,110,193,.16), 0 10px 24px rgba(33,128,142,.12);
}
[data-heige-role="theme-preview"] {
  width: 92px;
  height: 62px;
  border-radius: 11px;
  background-position: center;
  background-size: cover;
}
[data-heige-role="save-state"] { border-radius: 999px; padding: 6px 9px; font-size: 11px; font-weight: 750; }
[data-heige-role="save-state"][data-state="saved"] { background: rgba(17,173,171,.1); color: #087875; }
[data-heige-role="save-state"][data-state="saving"] { background: rgba(224,170,62,.12); color: #7a5a12; }
[data-heige-role="save-state"][data-state="error"] { background: rgba(187,72,50,.1); color: #713a31; }
@media (max-width:979px) {
  [data-heige-role="theme-center"] { width: calc(100vw - 32px); min-width: 0; }
  [data-heige-role="theme-grid"] { grid-template-columns: repeat(2,minmax(0,1fr)); }
}
@media (max-width:679px) {
  [data-heige-role="theme-center-backdrop"] { padding: 42px 8px 8px; }
  [data-heige-role="theme-center"] { width: 100%; height: 100%; border-radius: 18px; }
  [data-heige-role="theme-grid"],
  [data-heige-role="quick-actions"] { grid-template-columns: 1fr; }
}
`;
```

- [ ] **Step 4: Import and inject the style**

At the top of `src/skin-menu.mjs`:

```js
import { THEME_CENTER_STYLE } from "./theme-center-style.mjs";
```

Add `themeCenterStyle: THEME_CENTER_STYLE` to the serialized payload and create one generation-owned style node:

```js
const chromeStyle = document.createElement("style");
chromeStyle.dataset.heigeRole = "theme-center-style";
chromeStyle.dataset.heigeGeneration = generation;
chromeStyle.textContent = data.themeCenterStyle;
document.head.appendChild(chromeStyle);
```

Remove `chromeStyle` in `dispose`.

- [ ] **Step 5: Package the new module**

Add this exact manifest entry immediately after `src/skin-menu.mjs`:

```json
{
  "source": "src/theme-center-style.mjs",
  "destination": "payload/src/theme-center-style.mjs",
  "recursive": false,
  "exclude": []
}
```

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
node --test test/skin-menu.test.mjs test/skill-package.test.mjs
```

Expected: all selected tests pass.

Commit:

```bash
git add src/theme-center-style.mjs src/skin-menu.mjs scripts/skill-package-manifest.json \
  test/skin-menu.test.mjs test/skill-package.test.mjs
git commit -m "feat: add Aurora Gallery theme center styles"
```

### Task 3: Accessible trigger, backdrop, and dialog shell

**Files:**
- Modify: `src/skin-menu.mjs:225-335`
- Modify: `test/helpers/menu-window.mjs`
- Modify: `test/skin-menu.dom.test.mjs:230-315`

- [ ] **Step 1: Write failing dialog and focus tests**

Add to `test/skin-menu.dom.test.mjs`:

```js
test("theme trigger opens an accessible modal and restores focus on every close path", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());

  assert.equal(page.dialog.getAttribute("role"), "dialog");
  assert.equal(page.dialog.getAttribute("aria-modal"), "true");
  assert.equal(page.backdrop.hidden, true);

  await page.openThemeCenter();
  assert.equal(page.backdrop.hidden, false);
  assert.equal(page.trigger.getAttribute("aria-expanded"), "true");
  assert.equal(page.document.activeElement, page.closeButton);

  page.closeButton.click();
  assert.equal(page.backdrop.hidden, true);
  assert.equal(page.document.activeElement, page.trigger);

  await page.openThemeCenter();
  page.backdrop.dispatchEvent(new page.window.MouseEvent("click", { bubbles: true }));
  assert.equal(page.backdrop.hidden, true);
  assert.equal(page.document.activeElement, page.trigger);
});

test("theme center traps Tab focus and Escape closes it", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());
  await page.openThemeCenter();

  const focusable = [...page.dialog.querySelectorAll("button:not([disabled]),[tabindex='0']")];
  focusable.at(-1).focus();
  page.dialog.dispatchEvent(new page.window.KeyboardEvent("keydown", {
    key: "Tab",
    bubbles: true,
    cancelable: true,
  }));
  assert.equal(page.document.activeElement, focusable[0]);

  page.dialog.dispatchEvent(new page.window.KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  }));
  assert.equal(page.backdrop.hidden, true);
  assert.equal(page.document.activeElement, page.trigger);
});
```

- [ ] **Step 2: Extend the DOM harness and verify RED**

Add these getters and helper to `test/helpers/menu-window.mjs`:

```js
get backdrop() { return query("theme-center-backdrop"); },
get dialog() { return query("theme-center"); },
get closeButton() { return query("theme-center-close"); },
get saveState() { return query("save-state"); },
get currentHero() { return query("current-theme-hero"); },
async openThemeCenter() {
  this.trigger.click();
  await flushMicrotasks(window);
},
```

Run:

```bash
node --test --test-name-pattern="accessible modal|traps Tab" test/skin-menu.dom.test.mjs
```

Expected: FAIL because the current compact panel has no backdrop, dialog semantics, or focus trap.

- [ ] **Step 3: Replace the compact trigger and panel shell**

Use native elements and stable roles:

```js
const button = document.createElement("button");
button.type = "button";
button.dataset.heigeRole = "menu-trigger";
button.setAttribute("aria-label", "打开主题中心");
button.setAttribute("aria-expanded", "false");

const triggerPreview = document.createElement("span");
triggerPreview.dataset.heigeRole = "menu-trigger-preview";
triggerPreview.setAttribute("aria-hidden", "true");
const triggerText = document.createElement("span");
triggerText.textContent = "主题";
const triggerMark = document.createElement("span");
triggerMark.textContent = "✦";
triggerMark.setAttribute("aria-hidden", "true");
button.append(triggerPreview, triggerText, triggerMark);

const backdrop = document.createElement("div");
backdrop.dataset.heigeRole = "theme-center-backdrop";
backdrop.hidden = true;

const panel = document.createElement("section");
panel.id = data.menuId + "-panel";
panel.dataset.heigeRole = "theme-center";
panel.setAttribute("role", "dialog");
panel.setAttribute("aria-modal", "true");
panel.setAttribute("aria-labelledby", data.menuId + "-title");
panel.setAttribute("aria-describedby", data.menuId + "-description");
button.setAttribute("aria-controls", panel.id);
backdrop.appendChild(panel);
root.append(button, backdrop);
```

Create one close function used by every path:

```js
const setPanelOpen = (open, { focusTrigger = false } = {}) => {
  assertCurrent();
  const next = open === true && !hidden;
  backdrop.hidden = !next;
  button.setAttribute("aria-expanded", String(next));
  if (next) closeButton.focus();
  else if (focusTrigger) button.focus();
};
```

Backdrop clicks close only when the event target is the backdrop:

```js
listen(backdrop, "click", (event) => {
  if (event.target === backdrop) setPanelOpen(false, { focusTrigger: true });
});
```

Trap focus and close on Escape:

```js
listen(panel, "keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    setPanelOpen(false, { focusTrigger: true });
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [...panel.querySelectorAll("button:not([disabled]),[tabindex='0']")];
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});
```

- [ ] **Step 4: Preserve hidden-entry recovery**

When hidden, keep the existing 24px minimum target and hide only text:

```js
button.dataset.hidden = String(hidden);
triggerText.hidden = hidden;
triggerMark.hidden = hidden;
button.setAttribute("aria-label", hidden ? "显示主题入口" : "打开主题中心");
```

Do not reduce `button` below 24px in either dimension.

- [ ] **Step 5: Run focused tests and commit**

Run:

```bash
node --test --test-name-pattern="modal|Tab focus|Escape|twenty-four-pixel" test/skin-menu.dom.test.mjs
```

Expected: all selected tests pass.

Commit:

```bash
git add src/skin-menu.mjs test/helpers/menu-window.mjs test/skin-menu.dom.test.mjs
git commit -m "feat: open themes in an accessible gallery dialog"
```

### Task 4: Hero, quick actions, custom theme, and built-in cards

**Files:**
- Modify: `src/skin-menu.mjs:280-850`
- Modify: `test/helpers/menu-window.mjs`
- Modify: `test/skin-menu.dom.test.mjs`

- [ ] **Step 1: Write failing visual content tests**

Add:

```js
test("theme center renders native upload custom and built-in preview cards", async (t) => {
  const page = await menuWindow({
    entries: [
      {
        id: "miku-488137",
        name: "Miku",
        accent: "#19c9e5",
        colors: { accent: "#19c9e5", secondary: "#ed6ec1", surface: "#f5f6fc", text: "#122c60" },
        css: '#root{background:url("data:image/webp;base64,QUJDRA==")}',
      },
      {
        id: "night-city",
        name: "Night City",
        accent: "#4455aa",
        colors: { accent: "#4455aa", secondary: "#d25c9d", surface: "#121725", text: "#f4f6ff" },
        css: "html{color:#eee}",
      },
    ],
  });
  t.after(() => page.close());

  assert.equal(page.document.querySelector('[data-heige-role="native-option"]')?.tagName, "BUTTON");
  assert.equal(page.document.querySelector('[data-heige-role="upload-trigger"]')?.tagName, "BUTTON");
  const cards = [...page.document.querySelectorAll('[data-heige-role="theme-option"]')];
  assert.equal(cards.length, 2);
  assert.match(cards[0].querySelector('[data-heige-role="theme-preview"]').style.backgroundImage, /data:image\/webp/);
  assert.match(cards[1].querySelector('[data-heige-role="theme-preview"]').dataset.fallbackColors, /#4455aa/i);
  assert.equal(page.currentHero.dataset.themeId, "miku-488137");
});
```

Keep the existing successful-upload test and add:

```js
const customCard = page.document.querySelector('[data-heige-theme-id="custom-upload"]');
assert.match(
  customCard.querySelector('[data-heige-role="theme-preview"]').style.backgroundImage,
  /data:image\/webp/,
);
assert.ok(customCard.querySelector('[data-heige-role="custom-delete"]'));
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
node --test --test-name-pattern="preview cards|validated upload scales" test/skin-menu.dom.test.mjs
```

Expected: FAIL because the current rows expose only colored dots.

- [ ] **Step 3: Build one reusable native button card**

Inside the injected script, define:

```js
const buttonElement = (role) => {
  const element = document.createElement("button");
  element.type = "button";
  element.dataset.heigeRole = role;
  return element;
};

const themePreview = ({ dataUrl, colors, label }) => {
  const preview = document.createElement("span");
  preview.dataset.heigeRole = "theme-preview";
  preview.setAttribute("aria-label", label);
  if (dataUrl !== null) {
    preview.style.backgroundImage = "url(" + JSON.stringify(dataUrl) + ")";
  } else {
    const list = [colors.accent, colors.secondary, colors.surface];
    preview.dataset.fallbackColors = list.join(",");
    preview.style.background =
      "linear-gradient(135deg," + list[0] + "," + list[1] + " 52%," + list[2] + ")";
  }
  return preview;
};

const createThemeCard = (theme, onPick) => {
  const card = buttonElement("theme-option");
  card.dataset.heigeThemeId = theme.id;
  card.setAttribute("aria-pressed", "false");
  const previewUrl = previewFromGeneratedCss(theme.css);
  const preview = themePreview({
    dataUrl: previewUrl,
    colors: theme.colors,
    label: theme.name + " 主题预览",
  });
  const copy = document.createElement("span");
  copy.dataset.heigeRole = "theme-card-copy";
  const name = document.createElement("strong");
  name.textContent = theme.name;
  const id = document.createElement("small");
  id.textContent = theme.id.toUpperCase().replaceAll("-", " ");
  const colors = document.createElement("span");
  colors.dataset.heigeRole = "theme-color-dots";
  for (const value of [theme.colors.accent, theme.colors.secondary, theme.colors.surface]) {
    const dot = document.createElement("i");
    dot.style.background = value;
    colors.appendChild(dot);
  }
  copy.append(name, id, colors);
  const check = document.createElement("span");
  check.dataset.heigeRole = "theme-check";
  check.textContent = "✓";
  check.setAttribute("aria-hidden", "true");
  card.append(preview, copy, check);
  listen(card, "click", () => onPick(card));
  return card;
};
```

- [ ] **Step 4: Build the fixed sections**

Create and append:

```js
const header = document.createElement("header");
header.dataset.heigeRole = "theme-center-header";
const title = document.createElement("h2");
title.id = data.menuId + "-title";
title.textContent = "HeiGe 主题中心";
const description = document.createElement("p");
description.id = data.menuId + "-description";
description.textContent = "换个背景，也换个工作心情";
const saveState = document.createElement("div");
saveState.dataset.heigeRole = "save-state";
saveState.setAttribute("aria-live", "polite");
const closeButton = buttonElement("theme-center-close");
closeButton.setAttribute("aria-label", "关闭主题中心");
closeButton.textContent = "×";
header.append(title, description, saveState, closeButton);

const scroll = document.createElement("div");
scroll.dataset.heigeRole = "theme-center-scroll";
const currentHero = document.createElement("section");
currentHero.dataset.heigeRole = "current-theme-hero";
const quickActions = document.createElement("section");
quickActions.dataset.heigeRole = "quick-actions";
const themeGrid = document.createElement("section");
themeGrid.dataset.heigeRole = "theme-grid";
scroll.append(currentHero, quickActions, themeGrid);

const footer = document.createElement("footer");
footer.dataset.heigeRole = "theme-center-footer";
panel.append(header, scroll, footer);
```

Place the controls with this exact ownership:

```js
quickActions.append(native, uploadRow);

const customSection = document.createElement("section");
customSection.dataset.heigeRole = "custom-theme-section";
customSection.hidden = customRow === null;
if (customRowContainer !== null) customSection.appendChild(customRowContainer);

for (const theme of data.themes) {
  const card = createThemeCard(theme, () => {
    void requestThemeSelection(theme.id);
  });
  rows.set(theme.id, card);
  themeGrid.appendChild(card);
}

scroll.insertBefore(customSection, themeGrid);
footer.append(heading, persistenceSwitch, hideRow, confirmation, alert);
```

When `ensureCustomRow` creates a new card, append its container to `customSection` and set `customSection.hidden = false`. When `deleteCustom` removes it, set `customSection.hidden = true`. Keep the existing request functions attached to `native`, `uploadRow`, `persistenceSwitch`, `confirm`, and `hideRow`; only their parent containers change.

- [ ] **Step 5: Prevent custom delete from selecting**

The delete listener must be:

```js
listen(customDelete, "click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  deleteCustom();
});
```

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
node --test test/skin-menu.dom.test.mjs
```

Expected: all DOM tests pass.

Commit:

```bash
git add src/skin-menu.mjs test/helpers/menu-window.mjs test/skin-menu.dom.test.mjs
git commit -m "feat: render image-first theme cards"
```

### Task 5: Save state, immediate switching, and rollback painting

**Files:**
- Modify: `src/skin-menu.mjs:920-1230`
- Modify: `test/skin-menu.dom.test.mjs:840-1030`

- [ ] **Step 1: Write failing state tests**

Add assertions to the deferred-response test:

```js
await page.openThemeCenter();
await page.pickTheme("night-city");
assert.equal(page.backdrop.hidden, false);
assert.equal(page.saveState.dataset.state, "saving");
assert.equal(page.saveState.textContent, "正在保存");
assert.equal(page.currentHero.dataset.themeId, "night-city");
```

After resolving the ACK:

```js
assert.equal(page.saveState.dataset.state, "saved");
assert.equal(page.saveState.textContent, "已保存");
assert.equal(page.backdrop.hidden, false);
```

In the rejected-request test:

```js
assert.equal(page.currentHero.dataset.themeId, "miku-488137");
assert.equal(page.saveState.dataset.state, "error");
assert.match(page.saveState.textContent, /未保存|重试/);
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
node --test --test-name-pattern="renders immediately|rejected theme request" test/skin-menu.dom.test.mjs
```

Expected: FAIL because the theme changes but the new hero and save-state UI are not painted.

- [ ] **Step 3: Centralize visual state painting**

Add:

```js
const paintSaveState = (state, message) => {
  saveState.dataset.state = state;
  saveState.textContent = message;
};

const paintCurrentTheme = (themeId) => {
  const theme = data.themes.find((candidate) => candidate.id === themeId);
  const custom = themeId === data.customId ? currentCustom ?? loadCustom() : null;
  currentHero.dataset.themeId = themeId;
  const preview = theme ? previewFromGeneratedCss(theme.css) : custom?.dataUrl ?? null;
  currentHero.style.backgroundImage = preview === null
    ? "linear-gradient(135deg,#26343b,#67757a)"
    : "linear-gradient(90deg,rgba(7,28,52,.84),rgba(7,28,52,.18)),url("
      + JSON.stringify(preview) + ")";
  currentHero.querySelector("strong").textContent =
    theme?.name ?? (themeId === data.customId ? currentCustom?.name ?? "我的主题" : "原生 Codex");
  for (const [id, card] of rows) {
    const selected = id === themeId || (themeId === data.nativeSel && id === null);
    card.setAttribute("aria-pressed", String(selected));
    card.querySelector('[data-heige-role="theme-check"]')?.toggleAttribute("hidden", !selected);
  }
  const triggerUrl = theme === undefined ? custom?.dataUrl ?? null : previewFromGeneratedCss(theme.css);
  triggerPreview.style.backgroundImage = triggerUrl === null
    ? "linear-gradient(135deg,#26343b,#98a4a8)"
    : "url(" + JSON.stringify(triggerUrl) + ")";
};
```

Call `paintCurrentTheme` from formal, native, custom, broadcast, storage-event, and rollback paths.

- [ ] **Step 4: Paint transaction states without changing protocol order**

Immediately before optimistic rendering:

```js
paintSaveState("saving", "正在保存");
```

On exact ACK:

```js
paintSaveState("saved", "已保存");
```

On HTTP rejection, revision supersession, fallback timeout, or non-queued client failure:

```js
rollbackOptimisticTheme();
paintSaveState("error", "未保存，请重试");
```

Do not move `writeSelected`, `publish("theme", ...)`, controller fetch, fallback request, or revision checks earlier than their current positions.

- [ ] **Step 5: Keep the dialog open after a card choice**

Remove the old successful-theme callback that calls:

```js
setPanelOpen(false, { focusTrigger: true });
```

The dialog closes only through close button, Escape, backdrop, hidden-entry action, disposal, or reinjection.

- [ ] **Step 6: Run regression tests and commit**

Run:

```bash
node --test test/skin-menu.test.mjs test/skin-menu.dom.test.mjs test/injector.test.mjs
```

Expected: all selected tests pass.

Commit:

```bash
git add src/skin-menu.mjs test/skin-menu.dom.test.mjs
git commit -m "feat: keep gallery state aligned with durable theme commits"
```

### Task 6: Persistence footer, disposal, and full verification

**Files:**
- Modify: `src/skin-menu.mjs`
- Modify: `test/skin-menu.dom.test.mjs`
- Modify: `output/heige-codex-skin-studio.skill`
- Modify: `docs/release/2026-07-16-audit-hardening-disposition.md`

- [ ] **Step 1: Add final regression assertions**

Add:

```js
test("theme center keeps persistence controls fixed outside its scrolling region", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());
  const scroll = page.document.querySelector('[data-heige-role="theme-center-scroll"]');
  const footer = page.document.querySelector('[data-heige-role="theme-center-footer"]');
  assert.equal(scroll.contains(page.switch), false);
  assert.equal(footer.contains(page.switch), true);
  assert.equal(footer.contains(page.document.querySelector('[data-heige-role="hide-trigger"]')), true);
});

test("reinjection removes the old theme center style backdrop and focus handlers", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());
  const oldRuntime = page.window.__heigeCodexSkinRuntime;
  const oldStyle = page.document.querySelector('[data-heige-role="theme-center-style"]');
  const oldBackdrop = page.backdrop;
  await page.injectAgain();
  assert.equal(oldStyle.isConnected, false);
  assert.equal(oldBackdrop.isConnected, false);
  assert.throws(() => oldRuntime.status(), /disposed|generation/i);
  assert.equal(page.document.querySelectorAll('[data-heige-role="theme-center-style"]').length, 1);
  assert.equal(page.document.querySelectorAll('[data-heige-role="theme-center-backdrop"]').length, 1);
});
```

- [ ] **Step 2: Run all menu and packaging tests**

Run:

```bash
node --test \
  test/skin-menu.test.mjs \
  test/skin-menu.dom.test.mjs \
  test/injector.test.mjs \
  test/skill-package.test.mjs \
  test/release-governance.test.mjs
```

Expected: all selected tests pass.

- [ ] **Step 3: Run the complete test suite**

Run:

```bash
npm test
```

Expected: zero failures; live platform tests may remain explicitly skipped.

- [ ] **Step 4: Rebuild the deterministic package**

Run:

```bash
HEIGE_ALLOW_TRACKED_PACKAGE_OUTPUT=1 node scripts/package-skill.mjs \
  --output "/Users/blakexu/Documents/Codex 皮肤/output/heige-codex-skin-studio.skill" \
  --source-date-epoch 1704067200

node scripts/update-release-hash.mjs \
  --artifact "/Users/blakexu/Documents/Codex 皮肤/output/heige-codex-skin-studio.skill" \
  --disposition "/Users/blakexu/Documents/Codex 皮肤/docs/release/2026-07-16-audit-hardening-disposition.md"
```

Expected: the package path and a 64-character SHA-256 digest are printed.

- [ ] **Step 5: Re-run release governance after the final build**

Run:

```bash
node --test test/skill-package.test.mjs test/release-governance.test.mjs
```

Expected: the tracked artifact exactly matches current source and the release marker matches its SHA-256.

- [ ] **Step 6: Install without forcing a theme reset**

Run:

```bash
launchctl bootout "gui/$(id -u)/com.heige.codex-skin-controller" 2>/dev/null || true
HEIGE_SKIP_APPLY=1 ./scripts/install.command
cmp -s src/skin-menu.mjs "$HOME/.codex/heige-codex-skin-studio/src/skin-menu.mjs"
cmp -s src/theme-center-style.mjs "$HOME/.codex/heige-codex-skin-studio/src/theme-center-style.mjs"
```

Expected: install returns `decision: commit`, both comparisons exit zero, and the controller is loaded again.

- [ ] **Step 7: Perform live renderer acceptance**

Run this exact read-only CDP probe against the exact `app://-/index.html` main target:

```bash
node --input-type=module -e '
import { fetchRendererTargets, CdpSession } from "./src/cdp-client.mjs";
const targets = await fetchRendererTargets(9341, { timeoutMs: 5000 });
const target = targets.find((item) => item.url === "app://-/index.html");
if (!target) throw new Error("missing exact Codex main renderer");
const session = new CdpSession(target.webSocketDebuggerUrl);
await session.open();
try {
  const result = await session.evaluate(`(() => ({
    trigger: document.querySelector("[data-heige-role=menu-trigger]")?.tagName,
    dialog: document.querySelector("[data-heige-role=theme-center]")?.getAttribute("role"),
    cards: document.querySelectorAll("[data-heige-role=theme-option]").length,
    previews: [...document.querySelectorAll("[data-heige-role=theme-preview]")]
      .filter((element) => getComputedStyle(element).backgroundImage !== "none").length,
    active: document.documentElement.dataset.heigeCodexSkin ?? null,
  }))()`);
  console.log(JSON.stringify(result));
} finally {
  session.close();
}
'
```

Expected:

```js
{
  trigger: "BUTTON",
  dialog: "dialog",
  cards: 10,
  previews: 10,
  active: "miku-488137",
}
```

Click at least six alternating built-in theme cards through CDP. For every click, measure immediate renderer change below 20ms, wait for the revision to advance, and confirm the dialog remains open. Finish on `miku-488137`.

- [ ] **Step 8: Verify the earlier glass fix did not regress**

Query computed style and require:

```js
{
  assistantBackground: "rgba(0, 0, 0, 0)",
  assistantShadow: "none",
  composerBackdrop: "blur(22px) saturate(1.08)",
}
```

- [ ] **Step 9: Commit release artifacts**

```bash
git add \
  output/heige-codex-skin-studio.skill \
  docs/release/2026-07-16-audit-hardening-disposition.md
git commit -m "build: package the Aurora Gallery theme center"
```
