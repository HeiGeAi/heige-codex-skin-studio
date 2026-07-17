import { extname } from "node:path";

import { CdpSession, fetchRendererTargets, waitForRendererTargets } from "./cdp-client.mjs";
import { buildSkinCss } from "./skin-css.mjs";
import { buildSkinMenuScript, CSS_SENTINELS } from "./skin-menu.mjs";
import { classifyCodexTargets } from "./target-classifier.mjs";
import { validateImageMetadata } from "./image-metadata.mjs";
import { readBoundedFile, RESOURCE_LIMITS, sumWithinLimit } from "./resource-limits.mjs";

const STYLE_ID = "heige-codex-skin-style";
const MENU_ID = "heige-codex-skin-menu";
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
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

async function evaluateTargets(targets, expression, Session) {
  const succeeded = [];
  const failed = [];
  for (const target of targets) {
    let session;
    try {
      session = new Session(target.webSocketDebuggerUrl);
      await session.open();
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
    accent: loadedTheme.manifest.colors?.accent,
    appearance: loadedTheme.manifest.appearance,
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
    let controlRequest = null;
    try {
      if (typeof status?.generation === "string") generation = status.generation;
      if (status?.mode === "active" || status?.mode === "native") mode = status.mode;
      if (typeof status?.themeId === "string" || status?.themeId === null) themeId = status.themeId;
      persistenceEnabled = status?.persistenceEnabled === true;
      if (Number.isSafeInteger(status?.revision) && status.revision >= 0) revision = status.revision;
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
        const exact = (expected) =>
          keys.length === expected.length &&
          keys.every((key, index) => key === [...expected].sort()[index]);
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
