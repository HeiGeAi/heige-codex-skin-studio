import { extname } from "node:path";

import { CdpSession, fetchRendererTargets, waitForRendererTargets } from "./cdp-client.mjs";
import { NATIVE_THEME_ID } from "./constants.mjs";
import { buildSkinCss } from "./skin-css.mjs";
import { buildSkinMenuScript, CSS_SENTINELS } from "./skin-menu.mjs";
import { classifyCodexTargets } from "./target-classifier.mjs";
import { validateImageMetadata } from "./image-metadata.mjs";
import { readBoundedFile, RESOURCE_LIMITS, sumWithinLimit } from "./resource-limits.mjs";

const STYLE_ID = "heige-codex-skin-style";
const MENU_ID = "heige-codex-skin-menu";
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const REQUEST_ID = /^[a-f0-9]{32}$/;
const THEME_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STABLE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const RELEASE_URL =
  /^https:\/\/github\.com\/HeiGeAi\/heige-codex-skin-studio\/releases\/tag\/v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
async function waitForMainTargets(wait, port, { timeoutMs = 20_000, pollMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const targets = classifyCodexTargets(await wait(port, { timeoutMs: remainingMs }));
    if (targets.some(({ kind }) => kind === "main")) return targets;
    if (Date.now() + pollMs >= deadline) {
      throw targetError(
        "NO_MAIN_RENDERER",
        "等不到经过严格识别的 Codex 主窗口 renderer",
        resultsFor(targets, { succeeded: [], failed: [] }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function safeId(target) {
  try {
    return typeof target.id === "string" || typeof target.id === "number"
      ? String(target.id)
      : "unknown";
  } catch {
    return "unknown";
  }
}

function safeUrl(target) {
  try { return typeof target.url === "string" ? target.url : ""; } catch { return ""; }
}

function safeTarget(target, extra = {}) {
  return {
    id: safeId(target),
    url: safeUrl(target),
    kind: target.kind ?? "unknown",
    ...extra,
  };
}

function safeEvaluationError(error) {
  let code;
  try { code = error?.code; } catch { code = undefined; }
  if (typeof code === "string" || Number.isSafeInteger(code)) {
    return `目标连接或执行失败（${String(code).slice(0, 64)}）`;
  }
  return "目标连接或执行失败";
}

async function bringTargetToFront(session) {
  // Best-effort：把目标页拉到前台，减轻 Windows 后台节流导致的「要点一下才继续」。
  if (typeof session?.send !== "function") return;
  try {
    await session.send("Page.bringToFront");
  } catch {}
}

async function evaluateTargets(targets, expression, Session) {
  const succeeded = [];
  const failed = [];
  for (const target of targets) {
    let session;
    try {
      session = new Session(target.webSocketDebuggerUrl);
      await session.open();
      await bringTargetToFront(session);
      succeeded.push(safeTarget(target, { value: await session.evaluate(expression) }));
    } catch (error) {
      failed.push(safeTarget(target, { error: safeEvaluationError(error) }));
    } finally {
      try { session?.close(); } catch {}
    }
  }
  return { succeeded, failed };
}

function skippedTarget(target) {
  return safeTarget(target, {
    reason: target.kind === "overlay"
      ? "该操作不会把宠物悬浮层当作主窗口"
      : "页面 URL 不属于已审核的 Codex renderer",
  });
}

function resultsFor(classified, { succeeded, failed }, touchedKinds = new Set(["main"])) {
  return {
    succeeded,
    failed,
    skipped: classified
      .filter(({ kind }) => !touchedKinds.has(kind))
      .map(skippedTarget),
  };
}

function targetError(code, message, results) {
  const error = new Error(message);
  error.code = code;
  error.results = results;
  return error;
}

function normalizeTargetIds(targetIds) {
  if (targetIds === undefined || targetIds === null) return null;
  if (!Array.isArray(targetIds)) throw new TypeError("targetIds 必须是 renderer ID 数组");
  const normalized = [];
  const seen = new Set();
  for (const value of targetIds) {
    if (typeof value !== "string" || value.length < 1 || value.length > 512 || seen.has(value)) {
      throw new TypeError("targetIds 必须包含互不重复的非空 renderer ID");
    }
    seen.add(value);
    normalized.push(value);
  }
  return new Set(normalized);
}

async function readThemeAsset(path, field, snapshot = null) {
  if (!path) return null;
  const mime = MIME[extname(path).toLowerCase()];
  if (snapshot instanceof Uint8Array && snapshot.byteLength > RESOURCE_LIMITS.assetBytes) {
    throw new RangeError(field + " 图片超过 " + RESOURCE_LIMITS.assetBytes + " bytes（8 MiB）");
  }
  if (!mime) throw new Error(`不支持的 ${field} 图片类型`);
  const bytes = snapshot instanceof Uint8Array
    ? Buffer.from(snapshot)
    : (await readBoundedFile(path, {
      maxBytes: RESOURCE_LIMITS.assetBytes,
      label: field + " 图片",
    })).bytes;
  validateImageMetadata(bytes, { expectedMime: mime });
  return { bytes, mime };
}

function dataUrl(asset) {
  return asset === null ? null : `data:${asset.mime};base64,${asset.bytes.toString("base64")}`;
}

async function readThemeResources(loadedTheme) {
  const hero = await readThemeAsset(loadedTheme.heroPath, "hero", loadedTheme.assetBuffers?.hero);
  const logo = await readThemeAsset(loadedTheme.logoPath, "logo", loadedTheme.assetBuffers?.logo);
  const polaroid = await readThemeAsset(loadedTheme.polaroidPath, "polaroid", loadedTheme.assetBuffers?.polaroid);
  const manifestBytes = loadedTheme.manifestBytes
    ?? Buffer.byteLength(JSON.stringify(loadedTheme.manifest), "utf8");
  const resourceBytes = sumWithinLimit(
    [manifestBytes, hero.bytes.byteLength, logo?.bytes.byteLength ?? 0, polaroid?.bytes.byteLength ?? 0],
    RESOURCE_LIMITS.themeBytes,
    `theme ${loadedTheme.manifest.id}`,
  );
  return { loadedTheme, hero, logo, polaroid, resourceBytes };
}

function themeEntry(resources) {
  const { loadedTheme, hero, logo, polaroid } = resources;
  return {
    id: loadedTheme.manifest.id,
    name: loadedTheme.manifest.name,
    origin: loadedTheme.origin === "user" ? "user" : "bundled",
    accent: loadedTheme.manifest.colors?.accent,
    appearance: loadedTheme.manifest.appearance,
    previewFocus: { ...loadedTheme.manifest.previewFocus },
    thumbnailFocus: { ...loadedTheme.manifest.thumbnailFocus },
    thumbnailZoom: loadedTheme.manifest.thumbnailZoom,
    colors: { ...loadedTheme.manifest.colors },
    css: buildSkinCss({
      theme: loadedTheme.manifest,
      heroDataUrl: dataUrl(hero),
      logoDataUrl: dataUrl(logo),
      polaroidDataUrl: dataUrl(polaroid),
    }),
  };
}

export async function applySkin({
  loadedTheme,
  themes,
  activeId,
  port,
  currentVersion,
  preferStored = false,
  control = null,
  targetIds = null,
  deps = {},
}) {
  const targetAllowlist = normalizeTargetIds(targetIds);
  const wait = deps.waitForRendererTargets ?? waitForRendererTargets;
  const Session = deps.Session ?? CdpSession;
  const menuThemes = themes?.length ? themes : [loadedTheme];
  const resourceSets = [];
  let menuBytes = 0;
  for (const theme of menuThemes) {
    const resources = await readThemeResources(theme);
    menuBytes = sumWithinLimit([menuBytes, resources.resourceBytes], RESOURCE_LIMITS.menuBytes, "menu");
    resourceSets.push(resources);
  }
  const entries = resourceSets.map(themeEntry);
  const themeId = activeId === undefined ? loadedTheme.manifest.id : activeId;
  // 自定义上传主题的客户端 CSS 模板：哨兵值占位，页面内替换，和内置主题同一套模板
  const cssTemplate = buildSkinCss({
    theme: {
      id: CSS_SENTINELS.id,
      name: "custom",
      colors: {
        accent: CSS_SENTINELS.accent,
        secondary: CSS_SENTINELS.secondary,
        surface: CSS_SENTINELS.surface,
        text: CSS_SENTINELS.text,
      },
      copy: null,
    },
    heroDataUrl: CSS_SENTINELS.hero,
  });
  const expression = buildSkinMenuScript({
    entries,
    activeId: themeId,
    styleId: STYLE_ID,
    menuId: MENU_ID,
    currentVersion: currentVersion ?? deps.currentVersion,
    cssTemplate,
    preferStored,
    control,
  });
  const classified = await waitForMainTargets(wait, port, {
    timeoutMs: deps.waitTimeoutMs ?? 20_000,
    pollMs: deps.pollMs ?? 500,
  });
  const allMainTargets = classified.filter(({ kind }) => kind === "main");
  const targets = targetAllowlist === null
    ? allMainTargets
    : allMainTargets.filter((target) => targetAllowlist.has(safeId(target)));
  const unselected = targetAllowlist === null
    ? []
    : allMainTargets
      .filter((target) => !targetAllowlist.has(safeId(target)))
      .map((target) => safeTarget(target, { reason: "未被本次目标 allowlist 选中" }));
  if (targetAllowlist !== null && targets.length === 0) {
    const results = resultsFor(classified, { succeeded: [], failed: [] });
    results.skipped.push(...unselected);
    throw targetError(
      "NO_SELECTED_MAIN_RENDERER",
      "未发现 targetIds 选中的 Codex 主窗口 renderer",
      results,
    );
  }
  const evaluated = await evaluateTargets(targets, expression, Session);
  const results = resultsFor(classified, evaluated);
  results.skipped.push(...unselected);
  if (evaluated.succeeded.length === 0) {
    throw targetError(
      "ALL_MAIN_TARGETS_FAILED",
      `全部 ${targets.length} 个 Codex 主窗口注入失败`,
      results,
    );
  }
  return {
    applied: evaluated.succeeded.length,
    themeId,
    menuThemes: entries.map(({ id }) => id),
    targets: evaluated.succeeded.map(({ id }) => id),
    failed: evaluated.failed.map(({ id }) => id),
    results,
  };
}

export async function removeSkin({ port, deps = {} }) {
  const fetchTargets = deps.fetchRendererTargets ?? fetchRendererTargets;
  const Session = deps.Session ?? CdpSession;
  const expression = `(() => {
    try { window.__heigeCodexSkinRuntime?.dispose?.(); } catch (error) {}
    document.getElementById(${JSON.stringify(STYLE_ID)})?.remove();
    document.getElementById(${JSON.stringify(MENU_ID)})?.remove();
    delete document.documentElement.dataset.heigeCodexSkin;
    // 删掉脚本化 API，卸载后残留的闭包不再可达，避免污染 status/dataset
    try { delete window.__heigeCodexSkin; } catch (error) { window.__heigeCodexSkin = undefined; }
    try { delete window.__heigeCodexSkinRuntime; } catch (error) { window.__heigeCodexSkinRuntime = undefined; }
    return true;
  })()`;
  const classified = classifyCodexTargets(await fetchTargets(port));
  const mainTargets = classified.filter(({ kind }) => kind === "main");
  const touchedKinds = new Set(["main", "overlay"]);
  const evaluated = await evaluateTargets(
    classified.filter(({ kind }) => touchedKinds.has(kind)),
    expression,
    Session,
  );
  const results = resultsFor(classified, evaluated, touchedKinds);
  if (mainTargets.length === 0) {
    throw targetError(
      "NO_MAIN_RENDERER",
      "未发现经过严格识别的 Codex 主窗口 renderer",
      results,
    );
  }
  const succeededMainIds = new Set(
    evaluated.succeeded.filter(({ kind }) => kind === "main").map(({ id }) => id),
  );
  if (succeededMainIds.size === 0) {
    throw targetError(
      "ALL_MAIN_TARGETS_FAILED",
      `全部 ${mainTargets.length} 个 Codex 主窗口清理失败`,
      results,
    );
  }
  return {
    removed: evaluated.succeeded.length,
    failed: evaluated.failed.map(({ id }) => id),
    results,
  };
}

export async function skinStatus({ port, includeControlRequest = false, deps = {} }) {
  if (typeof includeControlRequest !== "boolean") {
    throw new TypeError("includeControlRequest 必须是布尔值");
  }
  const fetchTargets = deps.fetchRendererTargets ?? fetchRendererTargets;
  const Session = deps.Session ?? CdpSession;
  const expression = `(() => {
    const includeControlRequest = ${JSON.stringify(includeControlRequest)};
    const installed = Boolean(document.getElementById(${JSON.stringify(STYLE_ID)}));
    const menu = Boolean(document.getElementById(${JSON.stringify(MENU_ID)}));
    let status = null;
    try { status = window.__heigeCodexSkinRuntime?.status?.() ?? null; } catch {}
    let generation = null;
    let mode = null;
    let themeId = document.documentElement.dataset.heigeCodexSkin ?? null;
    let persistenceEnabled = false;
    let revision = 0;
    let themeTransitionPending = false;
    let controlRequest = null;
    try {
      if (typeof status?.generation === "string") generation = status.generation;
      if (status?.mode === "active" || status?.mode === "native") mode = status.mode;
      if (typeof status?.themeId === "string" || status?.themeId === null) themeId = status.themeId;
      persistenceEnabled = status?.persistenceEnabled === true;
      if (Number.isSafeInteger(status?.revision) && status.revision >= 0) revision = status.revision;
      themeTransitionPending = status?.themeTransitionPending === true;
      const request = status?.controlRequest;
      if (includeControlRequest && request === null) controlRequest = null;
      if (
        includeControlRequest &&
        request !== null &&
        typeof request === "object" &&
        !Array.isArray(request)
      ) {
        const keys = Object.keys(request).sort();
        const persistenceKeys = [
          "action", "capability", "expectedRevision", "persistenceEnabled", "requestId", "schemaVersion"
        ];
        const themeKeys = [
          "action", "capability", "expectedRevision", "requestId", "schemaVersion", "themeId"
        ];
        const updateKeys = [
          "action", "capability", "generation", "requestId", "schemaVersion"
        ];
        const publishKeys = [
          "action", "capability", "expectedRevision", "image", "name", "requestId", "schemaVersion"
        ];
        const publishKeysWithColors = [
          "action", "capability", "colors", "expectedRevision", "image", "name", "requestId", "schemaVersion"
        ];
        const deleteUserThemeKeys = [
          "action", "capability", "expectedRevision", "requestId", "schemaVersion", "themeId"
        ];
        const exact = (expected) =>
          keys.length === expected.length &&
          keys.every((key, index) => key === [...expected].sort()[index]);
        const boundedString = (value, max) =>
          typeof value === "string" ? value.slice(0, max) : null;
        if (request.action === "set-persistence" && exact(persistenceKeys)) {
          controlRequest = {
            schemaVersion: request.schemaVersion,
            requestId: typeof request.requestId === "string" ? request.requestId.slice(0, 128) : null,
            action: request.action,
            capability: typeof request.capability === "string" ? request.capability.slice(0, 128) : null,
            expectedRevision: request.expectedRevision,
            persistenceEnabled: request.persistenceEnabled
          };
        } else if (request.action === "set-theme" && exact(themeKeys)) {
          controlRequest = {
            schemaVersion: request.schemaVersion,
            requestId: typeof request.requestId === "string" ? request.requestId.slice(0, 128) : null,
            action: request.action,
            capability: typeof request.capability === "string" ? request.capability.slice(0, 128) : null,
            expectedRevision: request.expectedRevision,
            themeId: typeof request.themeId === "string" ? request.themeId.slice(0, 128) : null
          };
        } else if (
          request.action === "publish-user-theme" &&
          (exact(publishKeys) || exact(publishKeysWithColors)) &&
          typeof request.image === "string" &&
          request.image.length >= 32 &&
          request.image.length <= 12_000_000 &&
          /^data:image\\/(?:png|jpeg|webp);base64,/i.test(request.image) &&
          typeof request.name === "string"
        ) {
          controlRequest = {
            schemaVersion: request.schemaVersion,
            requestId: boundedString(request.requestId, 128),
            action: request.action,
            capability: boundedString(request.capability, 128),
            expectedRevision: request.expectedRevision,
            name: boundedString(request.name.trim(), 80),
            image: request.image
          };
          if (exact(publishKeysWithColors) && request.colors && typeof request.colors === "object") {
            const accent = boundedString(request.colors.accent, 16);
            const secondary = boundedString(request.colors.secondary, 16);
            const surface = boundedString(request.colors.surface, 16);
            const text = boundedString(request.colors.text, 16);
            if (
              accent && secondary && surface && text &&
              /^#[0-9a-fA-F]{6}$/.test(accent) &&
              /^#[0-9a-fA-F]{6}$/.test(secondary) &&
              /^#[0-9a-fA-F]{6}$/.test(surface) &&
              /^#[0-9a-fA-F]{6}$/.test(text)
            ) {
              controlRequest.colors = { accent, secondary, surface, text };
            }
          }
        } else if (request.action === "delete-user-theme" && exact(deleteUserThemeKeys)) {
          controlRequest = {
            schemaVersion: request.schemaVersion,
            requestId: typeof request.requestId === "string" ? request.requestId.slice(0, 128) : null,
            action: request.action,
            capability: typeof request.capability === "string" ? request.capability.slice(0, 128) : null,
            expectedRevision: request.expectedRevision,
            themeId: typeof request.themeId === "string" ? request.themeId.slice(0, 128) : null
          };
        } else if (request.action === "check-update" && exact(updateKeys)) {
          controlRequest = {
            schemaVersion: request.schemaVersion,
            requestId: typeof request.requestId === "string" ? request.requestId.slice(0, 128) : null,
            action: request.action,
            capability: typeof request.capability === "string" ? request.capability.slice(0, 128) : null,
            generation: typeof request.generation === "string" ? request.generation.slice(0, 128) : null
          };
        }
      }
    } catch {}
    return {
      installed: installed,
      generation,
      mode: mode ?? (themeId === null ? "native" : "active"),
      themeId,
      menu,
      persistenceEnabled,
      revision,
      themeTransitionPending,
      ...(includeControlRequest ? { controlRequest } : {})
    };
  })()`;
  const classified = classifyCodexTargets(await fetchTargets(port));
  const targets = classified.filter(({ kind }) => kind === "main");
  if (targets.length === 0) {
    throw targetError(
      "NO_MAIN_RENDERER",
      "未发现经过严格识别的 Codex 主窗口 renderer",
      resultsFor(classified, { succeeded: [], failed: [] }),
    );
  }
  const evaluated = await evaluateTargets(targets, expression, Session);
  const results = resultsFor(classified, evaluated);
  if (evaluated.succeeded.length === 0) {
    throw targetError(
      "ALL_MAIN_TARGETS_FAILED",
      `全部 ${targets.length} 个 Codex 主窗口状态读取失败`,
      results,
    );
  }
  return {
    statuses: evaluated.succeeded.map(({ value }) => value),
    failed: evaluated.failed.map(({ id }) => id),
    results,
  };
}

function normalizedUpdateDelivery({ generation, requestId, result }) {
  if (
    typeof generation !== "string" ||
    !REQUEST_ID.test(generation) ||
    typeof requestId !== "string" ||
    !REQUEST_ID.test(requestId) ||
    result === null ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    !["latest", "update-available", "error"].includes(result.status) ||
    typeof result.currentVersion !== "string" ||
    !STABLE_VERSION.test(result.currentVersion)
  ) {
    throw new Error("更新检查结果无效");
  }
  const expectedKeys = result.status === "error"
    ? ["currentVersion", "status"]
    : ["currentVersion", "latestVersion", "releaseUrl", "status"];
  const keys = Object.keys(result).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== [...expectedKeys].sort()[index])
  ) {
    throw new Error("更新检查结果字段无效");
  }
  if (result.status !== "error") {
    const match = typeof result.releaseUrl === "string"
      ? RELEASE_URL.exec(result.releaseUrl)
      : null;
    if (
      typeof result.latestVersion !== "string" ||
      !STABLE_VERSION.test(result.latestVersion) ||
      match === null ||
      `${match[1]}.${match[2]}.${match[3]}` !== result.latestVersion
    ) {
      throw new Error("更新检查发布地址无效");
    }
  }
  return {
    schemaVersion: 1,
    requestId,
    generation,
    ...result,
  };
}

export async function deliverUpdateCheckResult({
  port,
  generation,
  requestId,
  result,
  deps = {},
}) {
  const payload = normalizedUpdateDelivery({ generation, requestId, result });
  const fetchTargets = deps.fetchRendererTargets ?? fetchRendererTargets;
  const Session = deps.Session ?? CdpSession;
  const expression = `(() => {
    try {
      return window.__heigeCodexSkinRuntime?.receiveUpdateCheckResult?.(
        ${JSON.stringify(payload)}
      ) === true;
    } catch {
      return false;
    }
  })()`;
  const classified = classifyCodexTargets(await fetchTargets(port));
  const targets = classified.filter(({ kind }) => kind === "main");
  if (targets.length === 0) {
    throw targetError(
      "NO_MAIN_RENDERER",
      "未发现经过严格识别的 Codex 主窗口 renderer",
      resultsFor(classified, { succeeded: [], failed: [] }),
    );
  }
  const evaluated = await evaluateTargets(targets, expression, Session);
  const results = resultsFor(classified, evaluated);
  const delivered = evaluated.succeeded.filter(({ value }) => value === true).length;
  if (delivered === 0) {
    throw targetError(
      "UPDATE_RESULT_NOT_DELIVERED",
      "更新检查结果未被当前主题面板接收",
      results,
    );
  }
  return {
    delivered,
    failed: evaluated.failed.map(({ id }) => id),
    results,
  };
}

function normalizedThemeSelectionDelivery({
  requestId,
  themeId,
  revision,
  persistenceEnabled,
}) {
  if (
    typeof requestId !== "string" ||
    !REQUEST_ID.test(requestId) ||
    !(
      themeId === NATIVE_THEME_ID ||
      (typeof themeId === "string" && THEME_ID.test(themeId))
    ) ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    typeof persistenceEnabled !== "boolean"
  ) {
    throw new Error("主题选择确认结果无效");
  }
  return {
    schemaVersion: 1,
    requestId,
    themeId,
    revision,
    persistenceEnabled,
  };
}

export async function deliverThemeSelectionResult({
  port,
  requestId,
  themeId,
  revision,
  persistenceEnabled,
  deps = {},
}) {
  const payload = normalizedThemeSelectionDelivery({
    requestId,
    themeId,
    revision,
    persistenceEnabled,
  });
  const fetchTargets = deps.fetchRendererTargets ?? fetchRendererTargets;
  const Session = deps.Session ?? CdpSession;
  const expression = `(() => {
    try {
      return window.__heigeCodexSkinRuntime?.receiveThemeSelectionResult?.(
        ${JSON.stringify(payload)}
      ) === true;
    } catch {
      return false;
    }
  })()`;
  const classified = classifyCodexTargets(await fetchTargets(port));
  const targets = classified.filter(({ kind }) => kind === "main");
  if (targets.length === 0) {
    throw targetError(
      "NO_MAIN_RENDERER",
      "未发现经过严格识别的 Codex 主窗口 renderer",
      resultsFor(classified, { succeeded: [], failed: [] }),
    );
  }
  const evaluated = await evaluateTargets(targets, expression, Session);
  const results = resultsFor(classified, evaluated);
  const delivered = evaluated.succeeded.filter(({ value }) => value === true).length;
  if (delivered === 0) {
    throw targetError(
      "THEME_RESULT_NOT_DELIVERED",
      "主题选择结果未被当前主题面板接收",
      results,
    );
  }
  return {
    delivered,
    failed: evaluated.failed.map(({ id }) => id),
    results,
  };
}
