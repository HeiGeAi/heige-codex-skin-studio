const DEFAULT_COLORS = {
  accent: "#24c9d7",
  secondary: "#ef8fd3",
  surface: "#f7fbff",
  text: "#17344f",
};

function color(value, fallback) {
  const result = value ?? fallback;
  if (!/^#[0-9a-f]{3,8}$/i.test(result)) throw new Error(`无效主题颜色：${result}`);
  return result;
}

function copy(value, fallback = "") {
  return JSON.stringify(typeof value === "string" ? value : fallback);
}

const DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i;

export function buildSkinCss({ theme, heroDataUrl, logoDataUrl = null, polaroidDataUrl = null }) {
  if (!DATA_URL.test(heroDataUrl)) {
    throw new Error("hero 必须是本地 PNG、JPEG 或 WebP 数据");
  }
  if (logoDataUrl !== null && !DATA_URL.test(logoDataUrl)) {
    throw new Error("logo 必须是本地 PNG、JPEG 或 WebP 数据");
  }
  if (polaroidDataUrl !== null && !DATA_URL.test(polaroidDataUrl)) {
    throw new Error("polaroid 必须是本地 PNG、JPEG 或 WebP 数据");
  }
  const colors = {
    accent: color(theme.colors?.accent, DEFAULT_COLORS.accent),
    secondary: color(theme.colors?.secondary, DEFAULT_COLORS.secondary),
    surface: color(theme.colors?.surface, DEFAULT_COLORS.surface),
    text: color(theme.colors?.text, DEFAULT_COLORS.text),
  };
  const id = String(theme.id ?? "custom").replace(/[^a-z0-9_-]/gi, "");

  return `/* HEIGE_CODEX_SKIN:${id} */
:root[data-codex-window-type="electron"] {
  color-scheme: light !important;
  --heige-accent: ${colors.accent};
  --heige-secondary: ${colors.secondary};
  --heige-surface: ${colors.surface};
  --heige-text: ${colors.text};
  --color-background-surface: color-mix(in srgb, var(--heige-surface) 90%, transparent) !important;
  --color-background-panel: color-mix(in srgb, var(--heige-surface) 94%, transparent) !important;
  --color-background-button-primary: var(--heige-accent) !important;
  --color-text-foreground: var(--heige-text) !important;
  --color-border: color-mix(in srgb, var(--heige-accent) 45%, transparent) !important;
}

#root {
  color: var(--heige-text) !important;
  background:
    linear-gradient(90deg, color-mix(in srgb, var(--heige-surface) 96%, transparent) 0 22%, transparent 46%),
    linear-gradient(180deg, transparent 0 45%, color-mix(in srgb, var(--heige-surface) 78%, transparent) 78% 100%),
    url(${JSON.stringify(heroDataUrl)}) right center / cover no-repeat fixed !important;
}

#root::before {
  position: fixed;
  z-index: 20;
  top: 76px;
  left: max(380px, 24vw);
  content: ${copy(theme.copy?.brand)};
  color: var(--heige-accent);
  font: 800 clamp(16px, 2vw, 30px)/1.2 ui-rounded, system-ui;
  text-shadow: 0 2px 10px white;
  pointer-events: none;
}

#root::after {
  position: fixed;
  z-index: 20;
  top: 120px;
  left: max(380px, 24vw);
  max-width: 42vw;
  content: ${copy(theme.copy?.headline)};
  color: var(--heige-text);
  font: 750 clamp(18px, 2.7vw, 42px)/1.15 ui-rounded, system-ui;
  text-shadow: 0 2px 12px white;
  pointer-events: none;
}

.app-shell-left-panel {
  background: color-mix(in srgb, var(--heige-surface) 88%, transparent) !important;
  border-right: 1px solid color-mix(in srgb, var(--heige-accent) 45%, transparent) !important;
  backdrop-filter: blur(20px) saturate(1.12);
}

.main-surface,
.browser-main-surface {
  background: linear-gradient(180deg, transparent 0 40%, color-mix(in srgb, var(--heige-surface) 74%, transparent) 100%) !important;
}

.composer-surface-chrome,
[data-user-message-bubble],
[data-local-conversation-final-assistant],
[data-codex-approval-surface] {
  color: var(--heige-text) !important;
  border-color: color-mix(in srgb, var(--heige-accent) 48%, transparent) !important;
  background: color-mix(in srgb, var(--heige-surface) 88%, transparent) !important;
  box-shadow: 0 8px 24px color-mix(in srgb, var(--heige-accent) 18%, transparent) !important;
  backdrop-filter: blur(18px) saturate(1.08);
}

[data-app-action-sidebar-thread-active="true"] {
  background: linear-gradient(90deg, color-mix(in srgb, var(--heige-accent) 22%, transparent), color-mix(in srgb, var(--heige-secondary) 16%, transparent)) !important;
}
${logoDataUrl === null ? "" : `
/* 侧栏工作区标题换品牌 Logo，按钮仍可点开模式切换 */
.app-shell-left-panel button[aria-haspopup="menu"][aria-label*="ChatGPT"] {
  background: url(${JSON.stringify(logoDataUrl)}) left center / contain no-repeat !important;
  width: 214px;
  height: 78px !important;
  margin: 4px 0 0;
}
.app-shell-left-panel button[aria-haspopup="menu"][aria-label*="ChatGPT"] > span,
.app-shell-left-panel button[aria-haspopup="menu"][aria-label*="ChatGPT"] > svg {
  visibility: hidden;
}
`}${polaroidDataUrl === null ? "" : `
/* 右下角拍立得挂件，点击穿透 */
body::after {
  content: "";
  position: fixed;
  right: 20px;
  bottom: 24px;
  width: 200px;
  height: 300px;
  background: url(${JSON.stringify(polaroidDataUrl)}) center / contain no-repeat;
  pointer-events: none;
  z-index: 15;
  filter: drop-shadow(0 12px 26px color-mix(in srgb, var(--heige-text) 24%, transparent));
}
`}`;
}
