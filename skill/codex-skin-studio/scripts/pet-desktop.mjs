#!/usr/bin/env node

import { execFile } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";
import { delay, evaluateAll, MAIN_TARGET_PROBE, selectMainTarget, targets } from "./apply.mjs";
import { assertPetId, petError } from "./pet.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_PORT = 9341;
const ADAPTER_VERSION = "chatgpt-desktop-pets-settings-v1";
const SETTINGS_TIMEOUT_MS = 8000;
const UI_POLL_MS = 120;
const REFRESH_LABELS = new Set([
  "refresh",
  "\u5237\u65b0",
  "\u66f4\u65b0",
  "actualizar",
  "actualiser",
  "aktualisieren",
  "aggiorna",
]);
const SELECT_LABELS = new Set([
  "select",
  "\u9009\u62e9",
  "ausw\u00e4hlen",
  "s\u00e9lectionner",
  "seleccionar",
  "ausw\u00e4hlen",
]);
const SELECTED_LABELS = new Set([
  "selected",
  "\u5df2\u9009",
  "ausgew\u00e4hlt",
  "s\u00e9lectionn\u00e9",
  "seleccionado",
]);

const json = (value) => JSON.stringify(value);

function commandFailure(error, fallback = "PET_NATIVE_UI_UNAVAILABLE") {
  const message = String(error?.message || error || "native ChatGPT Desktop UI command failed");
  return petError(error?.code || fallback, message, error?.details);
}

export const PET_UI_STATE_EXPRESSION = `(() => ({
  settingsSlugs: [...document.querySelectorAll('[data-settings-panel-slug]')].map((node) => node.getAttribute('data-settings-panel-slug')).filter(Boolean),
  settings: Boolean(document.querySelector('[data-settings-panel-slug]')),
  petsPanel: Boolean(document.querySelector('[data-settings-panel-slug="pets"][aria-current="page"]') || [...document.querySelectorAll('button,[role="button"]')].some((node) => /refresh\\s+(custom\\s+)?pets?|custom\\s+pets?/i.test((node.getAttribute('aria-label') || '') + ' ' + (node.textContent || '')))),
  customPetIds: [...document.querySelectorAll('[data-avatar-id^="custom:"]')].map((node) => node.getAttribute('data-avatar-id').slice(7)),
  main: (() => { const probe = ${MAIN_TARGET_PROBE}; return Boolean(probe.main && probe.root); })()
}))()`;

export const OPEN_PETS_PANEL_EXPRESSION = `(() => {
  const button = document.querySelector('[data-settings-panel-slug="pets"], [data-settings-panel-slug="appearance"]');
  if (!button) return { ok: false, reason: "pets-settings-button-not-found" };
  button.click();
  return { ok: true };
})()`;

export const OPEN_SETTINGS_EXPRESSION = `(() => {
  const button = [...document.querySelectorAll('button,[role="button"],a')].find((candidate) => {
    const value = ((candidate.getAttribute('aria-label') || '') + ' ' + (candidate.getAttribute('title') || '') + ' ' + (candidate.textContent || '')).replace(/\\s+/g, ' ').trim().toLowerCase();
    return /^(settings|preferences|\\u504f\\u597d\\u8bbe\\u7f6e|\\u8bbe\\u7f6e)$/.test(value) || /(^|\\s)(settings|preferences)(\\s|$)/.test(value);
  });
  if (!button) return { ok: false, reason: "settings-control-not-found" };
  button.click();
  return { ok: true };
})()`;

export const REFRESH_PETS_EXPRESSION = `(() => {
  const labels = ${json([...REFRESH_LABELS])};
  const button = [...document.querySelectorAll('button,[role="button"]')].find((candidate) => {
    const value = ((candidate.getAttribute('aria-label') || '') + ' ' + (candidate.textContent || '')).replace(/\\s+/g, ' ').trim().toLowerCase();
    return labels.includes(value) || (value.includes('refresh') && /(custom\\s+)?pets?|avatars?/.test(value));
  });
  if (!button) return { ok: false, reason: "refresh-button-not-found" };
  button.click();
  return { ok: true };
})()`;

export function selectPetExpression(petId) {
  assertPetId(petId);
  const selector = `[data-avatar-id="custom:${petId}"]`;
  return `(() => {
    const avatar = document.querySelector(${JSON.stringify(selector)});
    if (!avatar) return { ok: false, reason: "pet-not-found" };
    let row = avatar.closest('[role="listitem"], .flex.items-center.justify-between');
    if (!row) row = avatar.parentElement?.parentElement?.parentElement || null;
    if (!row) return { ok: false, reason: "pet-row-not-found" };
    const labels = ${json([...SELECT_LABELS])};
    const selected = ${json([...SELECTED_LABELS])};
    const button = [...row.querySelectorAll('button')].find((candidate) => labels.includes((candidate.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase()));
    if (button) button.click();
    const rowText = (row.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    return { ok: true, clicked: Boolean(button), selected: selected.some((label) => rowText.includes(label)), rowText };
  })()`;
}

export function petSelectionStateExpression(petId) {
  assertPetId(petId);
  const selector = `[data-avatar-id="custom:${petId}"]`;
  return `(() => {
    const avatar = document.querySelector(${JSON.stringify(selector)});
    const row = avatar?.closest('[role="listitem"], .flex.items-center.justify-between') || null;
    const preview = avatar?.querySelector('[data-testid="codex-avatar"]') || null;
    const selected = ${json([...SELECTED_LABELS])};
    const rowText = (row?.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const backgroundImage = preview ? getComputedStyle(preview).backgroundImage : '';
    return {
      exists: Boolean(avatar),
      selected: selected.some((label) => rowText.includes(label)),
      assetLoaded: Boolean(backgroundImage && backgroundImage !== 'none'),
      assetSource: backgroundImage.startsWith('url("data:') || backgroundImage.startsWith('url(data:') ? 'embedded' : backgroundImage ? 'other' : 'none',
      rowText,
    };
  })()`;
}

export const RETURN_TO_APP_EXPRESSION = `(() => {
  const labels = ["back to app", "\u8fd4\u56de\u5e94\u7528", "retour \u00e0 l'application", "volver a la aplicaci\u00f3n"];
  const link = [...document.querySelectorAll('[role="link"]')].find((candidate) => labels.includes((candidate.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase()));
  if (!link) return { ok: false, reason: "return-link-not-found" };
  link.click();
  return { ok: true };
})()`;

export function buildMacOpenSettingsScript({ appName = "ChatGPT" } = {}) {
  const escaped = String(appName).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
  const settingsLabel = String.fromCodePoint(0x53, 0x65, 0x74, 0x74, 0x69, 0x6e, 0x67, 0x73, 0x2026);
  return `tell application "${escaped}" to activate\ndelay 0.2\ntell application "System Events"\n  tell process "${escaped}"\n    click menu item "${settingsLabel}" of menu 1 of menu bar item "${escaped}" of menu bar 1\n  end tell\nend tell`;
}

export function buildWindowsOpenSettingsScript() {
  return "$shell = New-Object -ComObject WScript.Shell; $activated = $shell.AppActivate('ChatGPT') -or $shell.AppActivate('Codex'); if (-not $activated) { throw 'ChatGPT Desktop window was not found' }; Start-Sleep -Milliseconds 200; $shell.SendKeys('^,')";
}

export async function openChatGptSettings({ platformName = platform(), execFileFn = execFileAsync } = {}) {
  try {
    if (platformName === "darwin") {
      await execFileFn("/usr/bin/osascript", ["-e", buildMacOpenSettingsScript()]);
      return { status: "opened", platform: platformName, adapterVersion: ADAPTER_VERSION };
    }
    if (platformName === "win32") {
      await execFileFn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", buildWindowsOpenSettingsScript()]);
      return { status: "opened", platform: platformName, adapterVersion: ADAPTER_VERSION };
    }
    throw petError("PET_NATIVE_UI_UNAVAILABLE", "ChatGPT Desktop Pet UI automation supports macOS and Windows only");
  } catch (error) {
    throw commandFailure(error);
  }
}

async function evaluateTarget(target, expression) {
  const values = await evaluateAll([target], expression);
  return values[0];
}

async function currentTarget(port) {
  const list = await targets(port);
  const target = await selectMainTarget(list, evaluateTarget, { allowTransient: true });
  if (!target) throw petError("PET_NATIVE_UI_UNAVAILABLE", "ChatGPT Desktop main renderer was not found");
  return target;
}

async function waitForExpression(port, expression, predicate, { timeoutMs = SETTINGS_TIMEOUT_MS, delayMs = UI_POLL_MS } = {}) {
  const started = Date.now();
  let lastError = null;
  let lastValue = null;
  while (Date.now() - started <= timeoutMs) {
    try {
      const target = await currentTarget(port);
      const value = await evaluateTarget(target, expression);
      lastValue = value;
      if (predicate(value)) return { target, value };
    } catch (error) {
      lastError = error;
    }
    await delay(delayMs);
  }
  throw petError("PET_NATIVE_UI_TIMEOUT", "ChatGPT Desktop Pet settings did not reach the expected state", { cause: lastError?.message || null, lastValue });
}

async function waitForState(port, predicate, options = {}) {
  return waitForExpression(port, PET_UI_STATE_EXPRESSION, predicate, options);
}

async function openSettingsThroughVisibleControl(port) {
  const target = await currentTarget(port);
  const opened = await evaluateTarget(target, OPEN_SETTINGS_EXPRESSION);
  if (!opened?.ok) throw petError("PET_NATIVE_UI_UNAVAILABLE", opened?.reason || "could not open ChatGPT Desktop Settings through visible UI");
  return opened;
}

export async function selectPetInChatGptDesktop({ petId, port = DEFAULT_PORT, openSettingsFn = openChatGptSettings, restoreApp = true } = {}) {
  assertPetId(petId);
  let state = null;
  try {
    state = (await waitForState(port, (value) => value.settings, { timeoutMs: 300 })).value;
  } catch {
    let nativeOpenError = null;
    try { await openSettingsFn(); } catch (error) { nativeOpenError = error; }
    try {
      state = (await waitForState(port, (value) => value.settings, { timeoutMs: 1800 })).value;
    } catch {
      try {
        await openSettingsThroughVisibleControl(port);
        state = (await waitForState(port, (value) => value.settings)).value;
      } catch (visibleError) {
        if (nativeOpenError) throw commandFailure(nativeOpenError);
        throw visibleError;
      }
    }
  }

  let target = await currentTarget(port);
  if (!state.petsPanel) {
    const opened = await evaluateTarget(target, OPEN_PETS_PANEL_EXPRESSION);
    if (!opened?.ok) throw petError("PET_NATIVE_UI_UNAVAILABLE", opened?.reason || "could not open ChatGPT Desktop Pets settings");
    target = (await waitForState(port, (value) => value.petsPanel)).target;
  }

  const refreshed = await evaluateTarget(target, REFRESH_PETS_EXPRESSION);
  if (!refreshed?.ok) throw petError("PET_NATIVE_UI_UNAVAILABLE", refreshed?.reason || "could not refresh ChatGPT Desktop custom Pets");
  target = (await waitForState(port, (value) => value.customPetIds.includes(petId))).target;

  const selected = await evaluateTarget(target, selectPetExpression(petId));
  if (!selected?.ok) throw petError("PET_NATIVE_UI_UNAVAILABLE", selected?.reason || "could not select the installed ChatGPT Desktop Pet");
  const selectionState = await waitForExpression(port, petSelectionStateExpression(petId), (value) => value.exists && value.selected && value.assetLoaded);

  if (restoreApp) {
    const appTarget = await currentTarget(port);
    await evaluateTarget(appTarget, RETURN_TO_APP_EXPRESSION).catch(() => null);
  }
  return { status: "selected", selection: "native-ui-confirmed", petId, adapterVersion: ADAPTER_VERSION, refreshed: true, assetLoaded: selectionState.value.assetLoaded, assetSource: selectionState.value.assetSource };
}

export { ADAPTER_VERSION, DEFAULT_PORT, REFRESH_LABELS, SELECT_LABELS, SELECTED_LABELS };
