import assert from "node:assert/strict";
import test from "node:test";

import { buildLauncherPanelState } from "../src/launcher-panel-state.mjs";

const codexProfile = {
  id: "codex",
  label: "Codex",
  supportsControlChannel: true,
};

const workbuddyProfile = {
  id: "workbuddy",
  label: "WorkBuddy",
  supportsControlChannel: false,
};

test("builds the exact installed Codex launcher card contract", () => {
  const result = buildLauncherPanelState({
    profile: codexProfile,
    discovery: { appFound: true, app: "/Applications/ChatGPT.app" },
    studioState: { lastNonNativeThemeId: "smoke-boss" },
    themes: [{ id: "smoke-boss", name: "大佬 · 点烟" }],
    defaultThemeId: "miku-488137",
  });

  assert.deepEqual(result, {
    schemaVersion: 1,
    product: "codex",
    productName: "Codex",
    appInstalled: true,
    appPath: "/Applications/ChatGPT.app",
    themeId: "smoke-boss",
    themeName: "大佬 · 点烟",
    mode: "session",
  });
});

test("builds a disabled WorkBuddy card and falls back to the default theme", () => {
  const result = buildLauncherPanelState({
    profile: workbuddyProfile,
    discovery: { appFound: false, app: "/Applications/WorkBuddy.app" },
    studioState: null,
    themes: [{ id: "miku-488137", name: "Miku 488137" }],
    defaultThemeId: "miku-488137",
  });

  assert.deepEqual(result, {
    schemaVersion: 1,
    product: "workbuddy",
    productName: "WorkBuddy",
    appInstalled: false,
    appPath: null,
    themeId: "miku-488137",
    themeName: "Miku 488137",
    mode: "one-shot",
  });
});

test("uses the stored theme id as a safe display fallback when its manifest is missing", () => {
  const result = buildLauncherPanelState({
    profile: workbuddyProfile,
    discovery: { appFound: true, app: "/Users/test/Applications/WorkBuddy.app" },
    studioState: { lastNonNativeThemeId: "missing-theme" },
    themes: [],
    defaultThemeId: "miku-488137",
  });

  assert.equal(result.themeId, "missing-theme");
  assert.equal(result.themeName, "missing-theme");
  assert.equal(result.mode, "one-shot");
});

test("rejects malformed launcher card inputs instead of emitting ambiguous state", () => {
  assert.throws(() => buildLauncherPanelState({
    profile: codexProfile,
    discovery: { appFound: true, app: null },
    studioState: null,
    themes: [],
    defaultThemeId: "miku-488137",
  }), /discovery app/);

  assert.throws(() => buildLauncherPanelState({
    profile: codexProfile,
    discovery: { appFound: false, app: null },
    studioState: { lastNonNativeThemeId: "" },
    themes: [],
    defaultThemeId: "miku-488137",
  }), /lastNonNativeThemeId/);
});
