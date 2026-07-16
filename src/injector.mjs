import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import { CdpSession, fetchRendererTargets, waitForRendererTargets } from "./cdp-client.mjs";
import { buildSkinCss } from "./skin-css.mjs";
import { buildSkinMenuScript, CSS_SENTINELS } from "./skin-menu.mjs";

const STYLE_ID = "heige-codex-skin-style";
const MENU_ID = "heige-codex-skin-menu";
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const OVERLAY_MARKER = "avatar-overlay";

// 宠物悬浮层也是 app:// renderer，皮肤只能进主窗口
function isMainTarget(target) {
  return typeof target.url === "string" && !target.url.includes(OVERLAY_MARKER);
}

async function waitForMainTargets(wait, port, { timeoutMs = 20_000, pollMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const targets = (await wait(port, { timeoutMs: remainingMs })).filter(isMainTarget);
    if (targets.length > 0) return targets;
    if (Date.now() + pollMs >= deadline) {
      throw new Error("只发现宠物悬浮层，等不到 Codex 主窗口 renderer");
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

async function evaluateTargets(targets, expression, Session) {
  const values = [];
  for (const target of targets) {
    const session = new Session(target.webSocketDebuggerUrl);
    try {
      await session.open();
      values.push(await session.evaluate(expression));
    } finally {
      session.close();
    }
  }
  return values;
}

async function assetDataUrl(path, field) {
  if (!path) return null;
  const mime = MIME[extname(path).toLowerCase()];
  if (!mime) throw new Error(`不支持的 ${field} 图片类型`);
  const bytes = await readFile(path);
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

async function themeEntry(loadedTheme) {
  const heroDataUrl = await assetDataUrl(loadedTheme.heroPath, "hero");
  const logoDataUrl = await assetDataUrl(loadedTheme.logoPath, "logo");
  const polaroidDataUrl = await assetDataUrl(loadedTheme.polaroidPath, "polaroid");
  return {
    id: loadedTheme.manifest.id,
    name: loadedTheme.manifest.name,
    accent: loadedTheme.manifest.colors?.accent,
    css: buildSkinCss({ theme: loadedTheme.manifest, heroDataUrl, logoDataUrl, polaroidDataUrl }),
  };
}

export async function applySkin({ loadedTheme, themes, port, deps = {} }) {
  const wait = deps.waitForRendererTargets ?? waitForRendererTargets;
  const Session = deps.Session ?? CdpSession;
  const menuThemes = themes?.length ? themes : [loadedTheme];
  const entries = [];
  for (const theme of menuThemes) entries.push(await themeEntry(theme));
  const themeId = loadedTheme.manifest.id;
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
  });
  const targets = await waitForMainTargets(wait, port, {
    timeoutMs: deps.waitTimeoutMs ?? 20_000,
    pollMs: deps.pollMs ?? 500,
  });
  const values = await evaluateTargets(targets, expression, Session);
  return { applied: values.length, themeId, menuThemes: entries.map(({ id }) => id), targets: targets.map(({ id }) => id) };
}

export async function removeSkin({ port, deps = {} }) {
  const fetchTargets = deps.fetchRendererTargets ?? fetchRendererTargets;
  const Session = deps.Session ?? CdpSession;
  const expression = `(() => {
    document.getElementById(${JSON.stringify(STYLE_ID)})?.remove();
    document.getElementById(${JSON.stringify(MENU_ID)})?.remove();
    delete document.documentElement.dataset.heigeCodexSkin;
    return true;
  })()`;
  const targets = await fetchTargets(port);
  const values = await evaluateTargets(targets, expression, Session);
  return { removed: values.length };
}

export async function skinStatus({ port, deps = {} }) {
  const fetchTargets = deps.fetchRendererTargets ?? fetchRendererTargets;
  const Session = deps.Session ?? CdpSession;
  const expression = `(() => ({
    installed: Boolean(document.getElementById(${JSON.stringify(STYLE_ID)})),
    menu: Boolean(document.getElementById(${JSON.stringify(MENU_ID)})),
    themeId: document.documentElement.dataset.heigeCodexSkin ?? null
  }))()`;
  const targets = (await fetchTargets(port)).filter(isMainTarget);
  return evaluateTargets(targets, expression, Session);
}
