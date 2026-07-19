import { HEX_COLOR } from "./constants.mjs";
import { RESOURCE_LIMITS } from "./resource-limits.mjs";
import { THEME_CENTER_STYLE } from "./theme-center-style.mjs";

const DEFAULT_ACCENT = "#24c9d7";
const CONTROL_ENDPOINT = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/v1\/persistence$/;
const CONTROL_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const STABLE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export function previewFromGeneratedCss(css) {
  if (typeof css !== "string" || css.length === 0) return null;
  const match = /url\("(data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+)"\)/.exec(css);
  return match?.[1] ?? null;
}

// 客户端 CSS 由 Node 端模板加哨兵生成，替换后与内置主题同源，避免两套模板漂移
export const CSS_SENTINELS = {
  id: "heige-custom-sentinel-id",
  hero: "data:image/png;base64,HEIGEHEROSENTINEL",
  accent: "#010203",
  secondary: "#040506",
  surface: "#070809",
  text: "#0a0b0c",
};

function normalizeControl(control) {
  if (control === undefined || control === null) return null;
  if (typeof control !== "object" || Array.isArray(control)) {
    throw new Error("菜单控制描述必须是对象");
  }
  const keys = Object.keys(control).sort();
  const expectedKeys = [
    "available",
    "endpoint",
    "launcherName",
    "persistenceEnabled",
    "revision",
    "token",
  ];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("菜单控制描述字段无效");
  }
  const endpointMatch = typeof control.endpoint === "string"
    ? CONTROL_ENDPOINT.exec(control.endpoint)
    : null;
  const port = endpointMatch === null ? 0 : Number(endpointMatch[1]);
  if (
    control.available !== true ||
    typeof control.persistenceEnabled !== "boolean" ||
    !Number.isSafeInteger(control.revision) ||
    control.revision < 0 ||
    endpointMatch === null ||
    port > 65_535 ||
    !CONTROL_TOKEN.test(control.token ?? "") ||
    Buffer.from(control.token, "base64url").length !== 32 ||
    Buffer.from(control.token, "base64url").toString("base64url") !== control.token ||
    control.launcherName !== "HeiGe 皮肤启动器"
  ) {
    throw new Error("菜单控制描述无效");
  }
  return {
    available: true,
    persistenceEnabled: control.persistenceEnabled,
    revision: control.revision,
    endpoint: control.endpoint,
    token: control.token,
    launcherName: control.launcherName,
  };
}

export function buildSkinMenuScript({
  entries,
  activeId,
  styleId,
  menuId,
  currentVersion,
  cssTemplate = "",
  preferStored = false,
  control = null,
}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("皮肤菜单至少需要一个主题");
  }
  const colorValue = (value, fallback) => HEX_COLOR.test(value ?? "") ? value : fallback;
  const previewFocusValue = (value) => (
    value
    && Number.isInteger(value.x)
    && Number.isInteger(value.y)
    && value.x >= 0
    && value.x <= 100
    && value.y >= 0
    && value.y <= 100
      ? { x: value.x, y: value.y }
      : { x: 50, y: 50 }
  );
  const themes = entries.map((entry) => {
    if (!entry?.id || typeof entry.css !== "string") throw new Error("主题条目缺少 id 或 css");
    const accent = colorValue(entry.colors?.accent ?? entry.accent, DEFAULT_ACCENT);
    return {
      id: String(entry.id),
      name: typeof entry.name === "string" && entry.name.trim() ? entry.name : String(entry.id),
      origin: entry.origin === "user" ? "user" : "bundled",
      accent,
      appearance: ["system", "light", "dark"].includes(entry.appearance)
        ? entry.appearance
        : "system",
      previewFocus: previewFocusValue(entry.previewFocus),
      thumbnailFocus: previewFocusValue(entry.thumbnailFocus),
      thumbnailZoom: Number.isInteger(entry.thumbnailZoom)
        && entry.thumbnailZoom >= 100
        && entry.thumbnailZoom <= 400
        ? entry.thumbnailZoom
        : 100,
      colors: {
        accent,
        secondary: colorValue(entry.colors?.secondary, "#ed6ec1"),
        surface: colorValue(entry.colors?.surface, "#f5f6fc"),
        text: colorValue(entry.colors?.text, "#17344f"),
      },
      css: entry.css,
    };
  });
  if (activeId !== null && !themes.some((theme) => theme.id === activeId)) {
    throw new Error(`当前主题不在菜单列表中：${activeId}`);
  }
  if (typeof currentVersion !== "string" || !STABLE_VERSION.test(currentVersion)) {
    throw new Error("当前版本必须是稳定的 X.Y.Z 版本号");
  }
  const payload = JSON.stringify({
    styleId,
    menuId,
    currentVersion,
    activeId,
    themes,
    cssTemplate,
    sentinels: CSS_SENTINELS,
    customId: "custom-upload",
    storageKey: "heigeCodexCustomTheme",
    hiddenKey: "heigeCodexSkinMenuHidden",
    panelOpenKey: "heigeCodexThemeCenterOpen",
    readabilityKey: "heigeCodexReadabilityEnabled",
    selectedKey: "heigeCodexSkinSelected",
    nativeSel: "__heige_native__",
    preferStored,
    control: normalizeControl(control),
    limits: RESOURCE_LIMITS,
    themeCenterStyle: THEME_CENTER_STYLE,
  });
  const previewParserSource = previewFromGeneratedCss.toString();

  return `(() => {
  try { window.__heigeCodexSkinRuntime?.dispose?.(); } catch {}
  const data = ${payload};
  // 可变副本：上传成功后立刻 upsert 正式用户主题，不依赖 reinject 才出现在「我的主题」。
  const themes = data.themes.slice();
  const previewFromGeneratedCss = ${previewParserSource};

  const runtimeAbortController = new AbortController();
  const signal = runtimeAbortController.signal;
  const generationBytes = new Uint8Array(16);
  if (!globalThis.crypto?.getRandomValues) throw new Error("HeiGe menu requires crypto.getRandomValues");
  globalThis.crypto.getRandomValues(generationBytes);
  const generation = [...generationBytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  const trackedListeners = [];
  const trackedTimers = new Set();
  const trackedReaders = new Set();
  const trackedImages = new Map();
  const trackedControllers = new Set();
  const rawChannel = typeof BroadcastChannel === "function"
    ? new BroadcastChannel("heige-codex-skin-v2")
    : null;
  const channel = {
    closed: false,
    postMessage(value) {
      if (this.closed) throw new DOMException("HeiGe menu generation disposed", "InvalidStateError");
      rawChannel?.postMessage(value);
    },
    close() {
      if (this.closed) return;
      this.closed = true;
      try { rawChannel?.close(); } catch {}
    },
  };
  const listen = (target, type, listener, options) => {
    target.addEventListener(type, listener, options);
    trackedListeners.push([target, type, listener, options]);
    return listener;
  };
  const later = (callback, milliseconds) => {
    const id = setTimeout(() => {
      trackedTimers.delete(id);
      if (!signal.aborted) callback();
    }, milliseconds);
    trackedTimers.add(id);
    return id;
  };
  const clearLater = (id) => {
    clearTimeout(id);
    trackedTimers.delete(id);
  };
  const childController = () => {
    const controller = new AbortController();
    trackedControllers.add(controller);
    if (signal.aborted) controller.abort();
    return controller;
  };
  let statusSnapshot = () => ({
    generation,
    themeId: null,
    menu: false,
    mode: "native",
    persistenceEnabled: data.control?.persistenceEnabled ?? false,
    revision: data.control?.revision ?? 0,
  });
  let disposed = false;
  let runtime;
  const dispose = () => {
    if (disposed) return false;
    disposed = true;
    runtimeAbortController.abort();
    for (const controller of trackedControllers) { try { controller.abort(); } catch {} }
    trackedControllers.clear();
    for (const [target, type, listener, options] of trackedListeners.splice(0)) {
      try { target.removeEventListener(type, listener, options); } catch {}
    }
    for (const id of trackedTimers) clearTimeout(id);
    trackedTimers.clear();
    for (const reader of trackedReaders) {
      try { reader.onload = null; reader.onerror = null; reader.onabort = null; reader.abort?.(); } catch {}
    }
    trackedReaders.clear();
    for (const [image, reject] of trackedImages) {
      try { image.onload = null; image.onerror = null; image.src = ""; } catch {}
      try { reject(new DOMException("HeiGe menu generation disposed", "AbortError")); } catch {}
    }
    trackedImages.clear();
    channel.close();
    const ownedMenu = document.getElementById(data.menuId);
    const ownedStyle = document.getElementById(data.styleId);
    const ownedChromeStyle = document.querySelector(
      '[data-heige-role="theme-center-style"][data-heige-generation="' + generation + '"]',
    );
    if (ownedMenu?.dataset.heigeGeneration === generation) ownedMenu.remove();
    if (ownedStyle?.dataset.heigeGeneration === generation) ownedStyle.remove();
    ownedChromeStyle?.remove();
    if (window.__heigeCodexSkinRuntime === runtime) {
      delete document.documentElement.dataset.heigeCodexSkin;
      delete document.documentElement.dataset.heigeReadability;
      try { delete window.__heigeCodexSkin; } catch { window.__heigeCodexSkin = undefined; }
      try { delete window.__heigeCodexSkinRuntime; } catch { window.__heigeCodexSkinRuntime = undefined; }
    }
    return true;
  };
  runtime = { generation, signal, channel, dispose, status: () => statusSnapshot() };
  window.__heigeCodexSkinRuntime = runtime;
  const isCurrent = () => !signal.aborted && window.__heigeCodexSkinRuntime === runtime;
  const assertCurrent = () => {
    if (!isCurrent()) throw new DOMException("HeiGe menu generation disposed", "AbortError");
  };
  let outboundSequence = 0;
  const publish = (kind, value) => {
    assertCurrent();
    if (rawChannel === null) return false;
    outboundSequence += 1;
    try {
      channel.postMessage({
        schemaVersion: 1,
        senderGeneration: generation,
        sequence: outboundSequence,
        kind,
        value,
      });
      return true;
    } catch { return false; }
  };

  let style = document.getElementById(data.styleId);
  if (!style) {
    style = document.createElement("style");
    style.id = data.styleId;
    document.head.appendChild(style);
  }
  style.dataset.heigeGeneration = generation;

  document.querySelectorAll('[data-heige-role="theme-center-style"]').forEach((node) => node.remove());
  const chromeStyle = document.createElement("style");
  chromeStyle.dataset.heigeRole = "theme-center-style";
  chromeStyle.dataset.heigeGeneration = generation;
  chromeStyle.textContent = data.themeCenterStyle;
  document.head.appendChild(chromeStyle);

  document.getElementById(data.menuId)?.remove();
  const root = document.createElement("div");
  root.id = data.menuId;
  root.dataset.heigeGeneration = generation;

  const button = document.createElement("button");
  button.type = "button";
  button.dataset.heigeRole = "menu-trigger";
  button.setAttribute("aria-label", "打开主题中心");
  button.setAttribute("aria-expanded", "false");
  button.title = "HeiGe Codex Skin Studio";
  const triggerPreview = document.createElement("span");
  triggerPreview.dataset.heigeRole = "menu-trigger-preview";
  triggerPreview.setAttribute("aria-hidden", "true");
  const triggerText = document.createElement("span");
  triggerText.textContent = "主题";
  const triggerGlyph = document.createElement("span");
  triggerGlyph.dataset.heigeRole = "menu-trigger-glyph";
  triggerGlyph.textContent = "\\u2726";
  triggerGlyph.setAttribute("aria-hidden", "true");
  button.append(triggerPreview, triggerText, triggerGlyph);

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
  panel.style.display = "none";
  button.setAttribute("aria-controls", panel.id);

  const header = document.createElement("header");
  header.dataset.heigeRole = "theme-center-header";
  const headerCopy = document.createElement("div");
  const title = document.createElement("h2");
  title.id = data.menuId + "-title";
  title.textContent = "HeiGe 主题中心";
  title.style.cssText = "margin:0;font-size:19px;line-height:1.2;letter-spacing:-.02em;";
  const description = document.createElement("p");
  description.id = data.menuId + "-description";
  description.textContent = "换个背景，也换个工作心情";
  description.style.cssText = "margin:3px 0 0;font-size:11px;color:rgba(23,52,79,.62);";
  headerCopy.append(title, description);
  const saveState = document.createElement("div");
  saveState.dataset.heigeRole = "save-state";
  saveState.dataset.state = "saved";
  saveState.setAttribute("aria-live", "polite");
  saveState.textContent = "已保存";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.dataset.heigeRole = "theme-center-close";
  closeButton.setAttribute("aria-label", "关闭主题中心");
  closeButton.textContent = "\\u00d7";
  closeButton.style.cssText = "width:34px;height:34px;padding:0;border:1px solid rgba(23,77,102,.12);border-radius:50%;background:rgba(255,255,255,.68);color:#17344f;cursor:pointer;font-size:22px;line-height:30px;";
  const headerActions = document.createElement("div");
  headerActions.style.cssText = "display:flex;align-items:center;gap:10px;";
  headerActions.append(saveState, closeButton);
  header.append(headerCopy, headerActions);

  const scroll = document.createElement("div");
  scroll.dataset.heigeRole = "theme-center-scroll";
  const currentHero = document.createElement("section");
  currentHero.dataset.heigeRole = "current-theme-hero";
  const heroCopy = document.createElement("div");
  const heroEyebrow = document.createElement("small");
  heroEyebrow.textContent = "当前主题";
  heroEyebrow.style.cssText = "display:block;margin-bottom:4px;font-size:10px;letter-spacing:.12em;text-transform:uppercase;opacity:.76;";
  const heroName = document.createElement("strong");
  heroName.style.cssText = "display:block;font-size:18px;text-shadow:0 1px 8px rgba(0,0,0,.24);";
  heroCopy.append(heroEyebrow, heroName);
  currentHero.appendChild(heroCopy);
  const updateBar = document.createElement("section");
  updateBar.dataset.heigeRole = "update-bar";
  updateBar.setAttribute("aria-label", "版本与更新");
  const versionText = document.createElement("span");
  versionText.dataset.heigeRole = "update-version";
  versionText.setAttribute("aria-live", "polite");
  versionText.textContent = "当前版本 v" + data.currentVersion;
  const updateButton = document.createElement("button");
  updateButton.type = "button";
  updateButton.dataset.heigeRole = "update-check";
  updateButton.textContent = "检查更新";
  updateButton.disabled = data.control?.available !== true;
  updateBar.append(versionText, updateButton);
  const appearanceHelp = document.createElement("aside");
  appearanceHelp.dataset.heigeRole = "appearance-help";
  appearanceHelp.setAttribute("role", "note");
  appearanceHelp.setAttribute("aria-label", "字体颜色显示异常处理");
  appearanceHelp.textContent = "字体颜色显示不对？这通常是 Codex 本体的外观配色不匹配。点击左下角头像👉设置👉外观👉选择 浅色/深色 主题✅即可。";
  const quickActions = document.createElement("section");
  quickActions.dataset.heigeRole = "quick-actions";
  const customSection = document.createElement("section");
  customSection.dataset.heigeRole = "custom-theme-section";
  customSection.hidden = true;
  const customHeading = document.createElement("h3");
  customHeading.textContent = "我的主题";
  customHeading.style.cssText = "margin:0 0 9px;font-size:13px;";
  const customGrid = document.createElement("div");
  customGrid.dataset.heigeRole = "custom-theme-grid";
  customSection.append(customHeading, customGrid);
  const builtInHeading = document.createElement("h3");
  builtInHeading.textContent = "内置主题";
  builtInHeading.style.cssText = "margin:0 0 9px;font-size:13px;";
  const themeGrid = document.createElement("section");
  themeGrid.dataset.heigeRole = "theme-grid";
  scroll.append(currentHero, updateBar, appearanceHelp, quickActions, customSection, builtInHeading, themeGrid);
  const footer = document.createElement("footer");
  footer.dataset.heigeRole = "theme-center-footer";
  panel.append(header, scroll, footer);
  backdrop.appendChild(panel);

  const readReadability = () => {
    assertCurrent();
    try { return localStorage.getItem(data.readabilityKey) !== "0"; } catch { return true; }
  };
  const writeReadability = (value) => {
    assertCurrent();
    try { localStorage.setItem(data.readabilityKey, value ? "1" : "0"); } catch {}
  };
  const readabilitySection = document.createElement("section");
  readabilitySection.dataset.heigeRole = "readability-section";
  const readabilityCopy = document.createElement("div");
  readabilityCopy.style.cssText = "min-width:0;";
  const readabilityTitle = document.createElement("div");
  readabilityTitle.id = data.menuId + "-readability-title";
  readabilityTitle.textContent = "阅读增强";
  readabilityTitle.style.cssText = "font-weight:750;letter-spacing:.01em;color:#17344f;";
  const readabilityState = document.createElement("div");
  readabilityState.id = data.menuId + "-readability-state";
  readabilityState.dataset.heigeRole = "readability-state";
  readabilityState.style.cssText = "margin-top:1px;font-size:11px;color:rgba(23,52,79,.68);";
  readabilityCopy.append(readabilityTitle, readabilityState);
  const readabilitySwitch = document.createElement("button");
  readabilitySwitch.type = "button";
  readabilitySwitch.dataset.heigeRole = "readability-switch";
  readabilitySwitch.setAttribute("role", "switch");
  readabilitySwitch.setAttribute("tabindex", "0");
  readabilitySwitch.setAttribute("aria-labelledby", readabilityTitle.id);
  readabilitySwitch.setAttribute("aria-describedby", readabilityState.id);
  readabilitySwitch.style.cssText = "position:relative;flex:none;width:42px;height:24px;padding:0;border:1px solid #31526b;border-radius:999px;cursor:pointer;-webkit-app-region:no-drag;";
  const readabilityKnob = document.createElement("span");
  readabilityKnob.setAttribute("aria-hidden", "true");
  readabilityKnob.style.cssText = "position:absolute;top:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.24);";
  readabilitySwitch.appendChild(readabilityKnob);
  readabilitySection.append(readabilityCopy, readabilitySwitch);
  footer.appendChild(readabilitySection);

  let readabilityEnabled = true;
  const paintReadability = () => {
    assertCurrent();
    readabilitySwitch.setAttribute("aria-checked", String(readabilityEnabled));
    readabilitySwitch.style.background = readabilityEnabled ? "#087d8a" : "#66788a";
    readabilityKnob.style.left = readabilityEnabled ? "21px" : "4px";
    readabilityState.textContent = readabilityEnabled ? "已开启，文字更清晰" : "已关闭，背景完全通透";
  };
  const setReadability = (value, persist = true, broadcast = true) => {
    assertCurrent();
    if (typeof value !== "boolean") return false;
    readabilityEnabled = value;
    document.documentElement.dataset.heigeReadability = value ? "on" : "off";
    paintReadability();
    if (persist) writeReadability(value);
    if (broadcast) publish("readability", value);
    return true;
  };
  listen(readabilitySwitch, "click", () => setReadability(!readabilityEnabled));
  listen(readabilitySwitch, "keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    setReadability(!readabilityEnabled);
  });
  setReadability(readReadability(), false, false);

  let hidden = false;
  const writePanelOpen = (open) => {
    try {
      if (open) sessionStorage.setItem(data.panelOpenKey, "1");
      else sessionStorage.removeItem(data.panelOpenKey);
    } catch {}
  };
  const readPanelOpen = () => {
    try { return sessionStorage.getItem(data.panelOpenKey) === "1"; } catch { return false; }
  };
  const setPanelOpen = (open, { focusTrigger = false } = {}) => {
    assertCurrent();
    const next = open === true && !hidden;
    backdrop.hidden = !next;
    panel.style.display = next ? "grid" : "none";
    button.setAttribute("aria-expanded", String(next));
    button.setAttribute("aria-label", hidden ? "显示主题入口" : "打开主题中心");
    writePanelOpen(next);
    if (next) closeButton.focus();
    else if (focusTrigger) button.focus();
  };
  listen(panel, "focusin", (event) => {
    event.target?.scrollIntoView?.({ block: "nearest" });
  });
  listen(panel, "keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
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
  listen(closeButton, "click", () => setPanelOpen(false, { focusTrigger: true }));
  listen(backdrop, "click", (event) => {
    if (event.target === backdrop) setPanelOpen(false, { focusTrigger: true });
  });

  const rows = new Map();
  const paint = (id) => {
    for (const [rowId, item] of rows) {
      const selected = rowId === id || (id === data.nativeSel && rowId === null);
      if (item.hasAttribute("aria-pressed")) item.setAttribute("aria-pressed", String(selected));
      item.querySelector('[data-heige-role="theme-check"]')?.toggleAttribute("hidden", !selected);
    }
  };
  const row = (label, dotColor, onPick, before, { role = "menu-action", selectable = false } = {}) => {
    const item = document.createElement("button");
    item.type = "button";
    item.dataset.heigeRole = role;
    if (selectable) item.setAttribute("aria-pressed", "false");
    item.style.cssText = "display:flex;align-items:center;gap:9px;min-height:42px;width:100%;padding:8px 12px;color:inherit;cursor:pointer;text-align:left;";
    const dot = document.createElement("span");
    dot.setAttribute("aria-hidden", "true");
    dot.style.cssText = "width:10px;height:10px;border-radius:50%;flex:none;background:" + dotColor + ";";
    const text = document.createElement("span");
    text.textContent = label;
    item.append(dot, text);
    listen(item, "click", () => onPick(item));
    const parent = role === "upload-trigger" || role === "native-option"
      ? quickActions
      : role === "hide-trigger"
        ? footer
        : themeGrid;
    if (before?.parentElement === parent) parent.insertBefore(item, before);
    else parent.appendChild(item);
    return item;
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
      preview.style.background = "linear-gradient(135deg," + list[0] + "," + list[1] + " 52%," + list[2] + ")";
    }
    return preview;
  };
  const createThemeCard = (theme, onPick) => {
    const thumbnailFocus = theme.thumbnailFocus ?? { x: 50, y: 50 };
    const thumbnailZoom = theme.thumbnailZoom ?? 100;
    const card = document.createElement("button");
    card.type = "button";
    card.dataset.heigeRole = "theme-option";
    card.dataset.heigeThemeId = theme.id;
    card.setAttribute("aria-pressed", "false");
    const preview = themePreview({
      dataUrl: theme.dataUrl ?? previewFromGeneratedCss(theme.css),
      colors: theme.colors,
      label: theme.name + " 主题预览",
    });
    preview.style.backgroundPosition = thumbnailFocus.x + "% " + thumbnailFocus.y + "%";
    preview.style.backgroundSize = thumbnailZoom + "% auto";
    const copy = document.createElement("span");
    copy.dataset.heigeRole = "theme-card-copy";
    copy.style.cssText = "align-self:center;min-width:0;";
    const name = document.createElement("strong");
    name.textContent = theme.name;
    name.style.cssText = "display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    const id = document.createElement("small");
    id.textContent = theme.id.toUpperCase().replaceAll("-", " ");
    id.style.cssText = "display:block;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:9px;letter-spacing:.08em;opacity:.58;";
    const colors = document.createElement("span");
    colors.dataset.heigeRole = "theme-color-dots";
    colors.style.cssText = "display:flex;gap:4px;margin-top:7px;";
    for (const value of [theme.colors.accent, theme.colors.secondary, theme.colors.surface]) {
      const dot = document.createElement("i");
      dot.style.cssText = "width:7px;height:7px;border-radius:50%;background:" + value + ";";
      colors.appendChild(dot);
    }
    copy.append(name, id, colors);
    const check = document.createElement("span");
    check.dataset.heigeRole = "theme-check";
    check.textContent = "\\u2713";
    check.setAttribute("aria-hidden", "true");
    check.hidden = true;
    card.append(preview, copy, check);
    listen(card, "click", () => onPick(card));
    return card;
  };

  // 正式主题由 controller state 决定。localStorage 只保留本机快捷图片与兼容事件。
  const writeSelected = (id) => { assertCurrent(); try { localStorage.setItem(data.selectedKey, id); } catch {} };
  const readSelected = () => { assertCurrent(); try { return localStorage.getItem(data.selectedKey); } catch { return null; } };
  // 卸载皮肤后 style 已脱离 DOM，任何脚本化调用不得再改 dataset/写存储，否则污染 status
  const alive = () => { assertCurrent(); return style.isConnected; };
  let paintCurrentTheme = () => {};
  let lastRequestedAppearance = null;
  const effectiveAppearance = (appearance) => {
    if (appearance === "light" || appearance === "dark") return appearance;
    try {
      const system = globalThis.electronBridge?.getSystemThemeVariant?.();
      if (system === "light" || system === "dark") return system;
    } catch {}
    return globalThis.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
  };
  const applyCodexAppearance = (appearance) => {
    if (!["system", "light", "dark"].includes(appearance)) return false;
    const effective = effectiveAppearance(appearance);
    document.documentElement.classList.toggle("electron-dark", effective === "dark");
    document.documentElement.classList.toggle("electron-light", effective === "light");
    if (lastRequestedAppearance === appearance) return true;
    const bridge = globalThis.electronBridge;
    if (typeof bridge?.sendMessageFromView !== "function") return false;
    lastRequestedAppearance = appearance;
    const requestId = "heige-appearance-" + generation + "-" + globalThis.crypto.randomUUID();
    void Promise.resolve(bridge.sendMessageFromView({
      type: "fetch",
      requestId,
      url: "vscode://codex/set-setting",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "appearanceTheme", value: appearance }),
    })).catch(() => {
      if (lastRequestedAppearance === appearance) lastRequestedAppearance = null;
    });
    return true;
  };

  const setTheme = (id, persist = true, broadcast = true) => {
    if (!alive()) return;
    const theme = themes.find((candidate) => candidate.id === id);
    if (!theme) return;
    style.textContent = theme.css;
    document.documentElement.dataset.heigeCodexSkin = theme.id;
    applyCodexAppearance(theme.appearance);
    paint(theme.id);
    paintCurrentTheme(theme.id);
    if (persist) writeSelected(theme.id);
    if (broadcast) publish("theme", theme.id);
  };
  const clearTheme = (persist = true, broadcast = true) => {
    if (!alive()) return;
    style.textContent = "";
    delete document.documentElement.dataset.heigeCodexSkin;
    paint(data.nativeSel);
    paintCurrentTheme(data.nativeSel);
    if (persist) writeSelected(data.nativeSel);
    if (broadcast) publish("theme", data.nativeSel);
  };

  let requestThemeSelection = async (id) => {
    if (id === data.nativeSel) clearTheme();
    else setTheme(id);
    return true;
  };
  let publishUserThemeToLauncher = async (theme) => {
    const persisted = saveCustom(theme);
    applyCustomTheme(theme);
    showUploadAlert(
      persisted
        ? "控制通道不可用：自定义图仅保存在本机快捷槽，未写入启动器。"
        : "控制通道不可用，且本地存储不足；本次外观已应用但重启后可能丢失。",
      persisted ? "warning" : "error",
    );
    return false;
  };

  let requestDeleteUserTheme = async () => false;
  const mountUserThemeRow = (theme) => {
    const existing = document.querySelector(
      '[data-heige-role="user-theme-row"][data-heige-theme-id="' + theme.id + '"]',
    );
    if (existing) {
      const card = rows.get(theme.id);
      if (card) {
        card.querySelector('[data-heige-role="theme-card-copy"] strong').textContent = theme.name;
        const preview = card.querySelector('[data-heige-role="theme-preview"]');
        const previewUrl = theme.dataUrl ?? previewFromGeneratedCss(theme.css);
        if (preview && previewUrl) {
          preview.style.backgroundImage = "url(" + JSON.stringify(previewUrl) + ")";
        }
      }
      existing.querySelector('[data-heige-role="user-theme-delete"]')
        ?.setAttribute("aria-label", "删除自定义主题：" + theme.name);
      customSection.hidden = false;
      return;
    }
    const themeRow = createThemeCard(theme, () => {
      void requestThemeSelection(theme.id);
    });
    rows.set(theme.id, themeRow);
    const wrap = document.createElement("div");
    wrap.dataset.heigeRole = "user-theme-row";
    wrap.dataset.heigeThemeId = theme.id;
    wrap.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr) 30px;align-items:center;gap:4px;margin-bottom:10px;";
    const del = document.createElement("button");
    del.type = "button";
    del.dataset.heigeRole = "user-theme-delete";
    del.setAttribute("aria-label", "删除自定义主题：" + theme.name);
    del.textContent = "\\u00d7";
    // 加大热区，避免点到旁边主题卡；禁止拖入 Electron 窗口拖拽区。
    del.style.cssText = "flex:none;width:32px;height:32px;margin:0;padding:0;border:0;border-radius:50%;background:transparent;color:#713a31;cursor:pointer;font:700 18px/32px system-ui;position:relative;z-index:2;-webkit-app-region:no-drag;";
    listen(del, "mouseenter", () => { del.style.background = "rgba(220,60,60,.15)"; del.style.color = "#8f211d"; });
    listen(del, "mouseleave", () => { del.style.background = "transparent"; del.style.color = "#713a31"; });
    listen(del, "click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void requestDeleteUserTheme(theme.id);
    });
    wrap.append(themeRow, del);
    customGrid.appendChild(wrap);
    customSection.hidden = false;
  };

  for (const theme of themes) {
    if (theme.origin === "user") {
      mountUserThemeRow(theme);
    } else {
      const themeRow = createThemeCard(theme, () => {
        void requestThemeSelection(theme.id);
      });
      rows.set(theme.id, themeRow);
      themeGrid.appendChild(themeRow);
    }
  }

  // ---- 自定义图片：本地选图 -> 压缩 -> 取色 -> 生成 CSS -> 持久化 ----
  const imageError = (message) => new Error(message);
  const u16be = (bytes, offset) => {
    if (offset + 2 > bytes.length) throw imageError("图片 header 已截断");
    return bytes[offset] * 256 + bytes[offset + 1];
  };
  const u16le = (bytes, offset) => {
    if (offset + 2 > bytes.length) throw imageError("图片 header 已截断");
    return bytes[offset] + bytes[offset + 1] * 256;
  };
  const u24le = (bytes, offset) => {
    if (offset + 3 > bytes.length) throw imageError("图片 header 已截断");
    return bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65536;
  };
  const u32be = (bytes, offset) => {
    if (offset + 4 > bytes.length) throw imageError("图片 header 已截断");
    return bytes[offset] * 16777216 + bytes[offset + 1] * 65536 + bytes[offset + 2] * 256 + bytes[offset + 3];
  };
  const u32le = (bytes, offset) => {
    if (offset + 4 > bytes.length) throw imageError("图片 header 已截断");
    return (bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65536 + bytes[offset + 3] * 16777216) >>> 0;
  };
  const ascii = (bytes, offset, length) => {
    if (offset + length > bytes.length) throw imageError("图片 header 已截断");
    let value = "";
    for (let index = 0; index < length; index += 1) value += String.fromCharCode(bytes[offset + index]);
    return value;
  };
  const checkedDimensions = (mime, width, height) => {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw imageError("图片尺寸无效");
    return { mime, width, height };
  };
  const parseBrowserImage = (input) => {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length >= 8 && ascii(bytes, 0, 8) === "\\u0089PNG\\r\\n\\u001a\\n") {
      if (bytes.length < 24 || u32be(bytes, 8) !== 13 || ascii(bytes, 12, 4) !== "IHDR") throw imageError("PNG header 无效或已截断");
      return checkedDimensions("image/png", u32be(bytes, 16), u32be(bytes, 20));
    }
    if (bytes.length >= 2 && bytes[0] === 255 && bytes[1] === 216) {
      const sof = new Set([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207]);
      let offset = 2;
      while (offset < bytes.length) {
        if (bytes[offset] !== 255) throw imageError("JPEG marker header 无效");
        while (offset < bytes.length && bytes[offset] === 255) offset += 1;
        if (offset >= bytes.length) throw imageError("JPEG header 已截断");
        const marker = bytes[offset++];
        if (marker === 0 || marker === 217 || marker === 218) break;
        if (marker === 1 || marker === 216 || (marker >= 208 && marker <= 215)) continue;
        const length = u16be(bytes, offset);
        if (length < 2 || offset + length > bytes.length) throw imageError("JPEG segment header 已截断");
        if (sof.has(marker)) {
          if (length < 7) throw imageError("JPEG SOF header 已截断");
          return checkedDimensions("image/jpeg", u16be(bytes, offset + 5), u16be(bytes, offset + 3));
        }
        offset += length;
      }
      throw imageError("JPEG 缺少尺寸 header");
    }
    if (bytes.length >= 4 && ascii(bytes, 0, 4) === "RIFF") {
      if (bytes.length < 20 || ascii(bytes, 8, 4) !== "WEBP") throw imageError("WebP RIFF header 无效");
      const riffEnd = u32le(bytes, 4) + 8;
      if (riffEnd < 20 || riffEnd > bytes.length) throw imageError("WebP RIFF header 已截断");
      let offset = 12;
      while (offset + 8 <= riffEnd) {
        const type = ascii(bytes, offset, 4);
        const length = u32le(bytes, offset + 4);
        const start = offset + 8;
        const end = start + length;
        if (!Number.isSafeInteger(end) || end > riffEnd) throw imageError("WebP chunk header 已截断");
        if (type === "VP8X") {
          if (length < 10) throw imageError("WebP VP8X header 已截断");
          return checkedDimensions("image/webp", u24le(bytes, start + 4) + 1, u24le(bytes, start + 7) + 1);
        }
        if (type === "VP8L") {
          if (length < 5 || bytes[start] !== 47) throw imageError("WebP VP8L header 无效");
          return checkedDimensions(
            "image/webp",
            1 + bytes[start + 1] + ((bytes[start + 2] & 63) << 8),
            1 + ((bytes[start + 2] & 192) >>> 6) + (bytes[start + 3] << 2) + ((bytes[start + 4] & 15) << 10),
          );
        }
        if (type === "VP8 ") {
          if (length < 10 || bytes[start + 3] !== 157 || bytes[start + 4] !== 1 || bytes[start + 5] !== 42) throw imageError("WebP VP8 header 无效");
          return checkedDimensions("image/webp", u16le(bytes, start + 6) & 16383, u16le(bytes, start + 8) & 16383);
        }
        offset = end + (length & 1);
      }
      throw imageError("WebP 缺少尺寸 header");
    }
    throw imageError("不支持或无法识别的图片 header");
  };
  const validateBrowserImage = (input, expectedMime) => {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const metadata = parseBrowserImage(bytes);
    if (expectedMime && metadata.mime !== expectedMime) throw imageError("MIME 不匹配：期望 " + expectedMime + "，实际 " + metadata.mime);
    if (metadata.width > data.limits.imageWidth) throw imageError("图片宽度 width 超过 " + data.limits.imageWidth);
    if (metadata.height > data.limits.imageHeight) throw imageError("图片高度 height 超过 " + data.limits.imageHeight);
    if (metadata.width > Math.floor(data.limits.imagePixels / metadata.height)) throw imageError("图片像素 pixel 总数超过 " + data.limits.imagePixels);
    const shorter = Math.min(metadata.width, metadata.height);
    const longer = Math.max(metadata.width, metadata.height);
    if (longer > shorter * data.limits.aspectRatio) throw imageError("图片纵横比 aspect ratio 超过 " + data.limits.aspectRatio + ":1");
    return metadata;
  };
  const parseDataUrlImage = (dataUrl) => {
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) throw imageError("图片 data URL 无效");
    const marker = ";base64,";
    const split = dataUrl.indexOf(marker);
    if (split < 0) throw imageError("图片 data URL 必须使用 base64");
    const mime = dataUrl.slice(5, split).toLowerCase();
    if (mime !== "image/png" && mime !== "image/jpeg" && mime !== "image/webp") throw imageError("图片 MIME 不受支持");
    let binary;
    try { binary = atob(dataUrl.slice(split + marker.length)); }
    catch { throw imageError("图片 base64 无效"); }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return { bytes, metadata: validateBrowserImage(bytes, mime) };
  };
  const expectedUploadMime = (file) => {
    const lower = String(file.name ?? "").toLowerCase();
    const extensionMime = lower.endsWith(".png") ? "image/png"
      : lower.endsWith(".jpg") || lower.endsWith(".jpeg") ? "image/jpeg"
        : lower.endsWith(".webp") ? "image/webp" : null;
    if (!extensionMime) throw imageError("文件扩展名必须是 PNG、JPEG 或 WebP");
    const declared = typeof file.type === "string" ? file.type.toLowerCase() : "";
    if (declared && declared !== extensionMime) throw imageError("MIME 与文件扩展名不匹配");
    return extensionMime;
  };
  const fitCanvas = (width, height) => {
    const sideFactor = Math.max(Math.ceil(width / data.limits.processedCanvasSide), Math.ceil(height / data.limits.processedCanvasSide));
    const pixelFactor = Math.ceil(Math.sqrt((width / data.limits.processedCanvasPixels) * height));
    let factor = Math.max(1, sideFactor, pixelFactor);
    while (true) {
      const fitted = {
        width: Math.max(1, Math.ceil(width / factor)),
        height: Math.max(1, Math.ceil(height / factor)),
      };
      if (
        fitted.width <= data.limits.processedCanvasSide
        && fitted.height <= data.limits.processedCanvasSide
        && fitted.width <= Math.floor(data.limits.processedCanvasPixels / fitted.height)
      ) return fitted;
      factor += 1;
    }
  };
  const boundedOperation = (operation, label) => new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearLater(timeoutId);
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, new DOMException("HeiGe menu generation disposed", "AbortError"));
    const timeoutId = later(() => finish(reject, imageError(label + "超时，请重试")), data.limits.browserOperationMs);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(operation).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
  const buildCustomCss = (dataUrl, colors, themeId = data.customId) => data.cssTemplate
    .split(data.sentinels.hero).join(dataUrl)
    .split(data.sentinels.accent).join(colors.accent)
    .split(data.sentinels.secondary).join(colors.secondary)
    .split(data.sentinels.surface).join(colors.surface)
    .split(data.sentinels.text).join(colors.text)
    .split(data.sentinels.id).join(themeId);

  const hex = (r, g, b) => "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  const appearanceFromColors = (colors) => {
    const surface = typeof colors?.surface === "string" ? colors.surface : "";
    if (!/^#[0-9a-f]{6}$/i.test(surface)) return "system";
    const r = Number.parseInt(surface.slice(1, 3), 16);
    const g = Number.parseInt(surface.slice(3, 5), 16);
    const b = Number.parseInt(surface.slice(5, 7), 16);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 128 ? "light" : "dark";
  };

  const extractPalette = (canvas) => {
    const ctx = canvas.getContext("2d");
    if (!ctx || typeof ctx.getImageData !== "function") throw imageError("无法读取图片像素");
    const { data: px } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const buckets = new Map();
    let lumSum = 0, count = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lumSum += lum; count += 1;
      const sat = max === 0 ? 0 : (max - min) / max;
      if (sat < 0.18 || lum < 24 || lum > 245) continue;   // 灰、过暗、过曝不参与取主色
      const d = max - min || 1;
      let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      const bucket = Math.round(h) % 6 * 2 + (sat > 0.55 ? 1 : 0);
      const entry = buckets.get(bucket) ?? { w: 0, r: 0, g: 0, b: 0, h: h * 60 };
      const weight = sat * sat;
      entry.w += weight; entry.r += r * weight; entry.g += g * weight; entry.b += b * weight;
      buckets.set(bucket, entry);
    }
    const avgLum = count ? lumSum / count : 128;
    const ranked = [...buckets.values()].sort((a, b2) => b2.w - a.w)
      .map((e) => ({ rgb: [e.r / e.w, e.g / e.w, e.b / e.w], h: e.h, w: e.w }));
    const accent = ranked[0]?.rgb ?? [36, 201, 215];
    // 色相是环形量：355° 与 10° 实际只差 15°，线性差会误判成对比色
    const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
    const second = ranked.find((e) => hueGap(e.h, ranked[0]?.h ?? 0) > 50)?.rgb
      ?? mix(accent, [255, 255, 255], 0.35);
    const light = avgLum > 128;
    const surface = light ? mix(accent, [252, 252, 255], 0.92) : mix(accent, [12, 12, 18], 0.86);
    const text = light ? mix(accent, [16, 24, 40], 0.82) : mix(accent, [244, 246, 252], 0.85);
    return {
      appearance: light ? "light" : "dark",
      colors: {
        accent: hex(...accent),
        secondary: hex(...second),
        surface: hex(...surface),
        text: hex(...text),
      },
    };
  };

  let currentCustom = null;   // 内存态：save 失败时仍以它为准，不被 localStorage 里的旧图覆盖
  const paintSaveState = (state, message) => {
    saveState.dataset.state = state;
    saveState.textContent = message;
  };
  paintCurrentTheme = (themeId) => {
    const theme = themes.find((candidate) => candidate.id === themeId);
    const custom = themeId === data.customId
      ? currentCustom ?? loadCustom()
      : (theme ? null : currentCustom);
    const preview = theme
      ? (theme.dataUrl ?? previewFromGeneratedCss(theme.css))
      : custom?.dataUrl ?? null;
    currentHero.dataset.themeId = themeId;
    const previewFocus = theme?.previewFocus ?? { x: 50, y: 50 };
    const thumbnailFocus = theme?.thumbnailFocus ?? { x: 50, y: 50 };
    const thumbnailZoom = theme?.thumbnailZoom ?? 100;
    if (custom !== null || theme?.origin === "user") {
      currentHero.style.backgroundPosition = "center, center";
      currentHero.style.backgroundSize = "100% 100%, contain";
      currentHero.style.backgroundRepeat = "no-repeat";
    } else {
      currentHero.style.backgroundPosition = previewFocus.x + "% " + previewFocus.y + "%";
      currentHero.style.backgroundSize = "";
      currentHero.style.backgroundRepeat = "";
    }
    currentHero.style.backgroundImage = preview === null
      ? "linear-gradient(135deg,#26343b,#67757a)"
      : "linear-gradient(90deg,rgba(7,28,52,.84),rgba(7,28,52,.18)),url("
        + JSON.stringify(preview) + ")";
    heroName.textContent = theme?.name
      ?? (custom ? custom?.name ?? "我的主题" : "原生 Codex");
    for (const [id, card] of rows) {
      const selected = id === themeId || (themeId === data.nativeSel && id === null);
      card.setAttribute("aria-pressed", String(selected));
      card.querySelector('[data-heige-role="theme-check"]')?.toggleAttribute("hidden", !selected);
    }
    const triggerUrl = theme === undefined ? custom?.dataUrl ?? null : previewFromGeneratedCss(theme.css);
    triggerPreview.style.backgroundPosition = theme === undefined
      ? "center"
      : thumbnailFocus.x + "% " + thumbnailFocus.y + "%";
    triggerPreview.style.backgroundSize = theme === undefined
      ? "cover"
      : thumbnailZoom + "% auto";
    triggerPreview.style.backgroundImage = triggerUrl === null
      ? "linear-gradient(135deg,#26343b,#98a4a8)"
      : "url(" + JSON.stringify(triggerUrl) + ")";
    root.style.setProperty("--heige-accent", theme?.colors.accent ?? custom?.colors?.accent ?? "#19c9e5");
  };
  const applyCustomTheme = (theme, persist = true, broadcast = true) => {
    if (!alive()) return;
    currentCustom = theme;
    applyCodexAppearance(theme.appearance ?? appearanceFromColors(theme.colors));
    style.textContent = buildCustomCss(theme.dataUrl, theme.colors);
    document.documentElement.dataset.heigeCodexSkin = data.customId;
    ensureCustomRow(theme);
    paint(data.customId);
    paintCurrentTheme(data.customId);
    // 自定义是 renderer 本地快捷槽，永不写入启动器 selectedThemeId / lastNonNativeThemeId。
    paintSaveState("local", "仅本机快捷 · 未写入启动器");
    if (persist) writeSelected(data.customId);
    if (broadcast) publish("theme", data.customId);
  };

  let customRow = null;
  let customRowContainer = null;
  let customDelete = null;
  const removeLegacyCustomRow = () => {
    try { localStorage.removeItem(data.storageKey); } catch {}
    currentCustom = null;
    customRowContainer?.remove();
    rows.delete(data.customId);
    customRow = null;
    customRowContainer = null;
    customDelete = null;
    if (customGrid.childElementCount === 0) customSection.hidden = true;
  };
  // publish 成功后立刻把正式用户主题插进「我的主题」，不依赖 reinject。
  const upsertPublishedUserTheme = (source, themeId) => {
    if (typeof themeId !== "string" || themeId.length === 0) return null;
    if (typeof source?.dataUrl !== "string" || source.dataUrl.length === 0) return null;
    if (!source?.colors || typeof source.colors !== "object") return null;
    const appearance = source.appearance ?? appearanceFromColors(source.colors);
    const name = typeof source.name === "string" && source.name.trim()
      ? source.name.trim()
      : "我的主题";
    const entry = {
      id: themeId,
      name,
      origin: "user",
      accent: source.colors.accent,
      appearance,
      colors: source.colors,
      css: buildCustomCss(source.dataUrl, source.colors, themeId),
      dataUrl: source.dataUrl,
    };
    const index = themes.findIndex((candidate) => candidate.id === themeId);
    if (index >= 0) themes[index] = entry;
    else themes.push(entry);
    removeLegacyCustomRow();
    mountUserThemeRow(entry);
    return entry;
  };
  const deleteCustom = () => {
    assertCurrent();
    const wasActive = document.documentElement.dataset.heigeCodexSkin === data.customId;
    removeLegacyCustomRow();
    if (wasActive) clearTheme();
  };
  const ensureCustomRow = (theme) => {
    if (customRow) {
      customRow.querySelector('[data-heige-role="theme-card-copy"] strong').textContent = theme.name;
      customRow.querySelector('[data-heige-role="theme-preview"]').style.backgroundImage =
        "url(" + JSON.stringify(theme.dataUrl) + ")";
      customDelete.setAttribute("aria-label", "删除自定义主题：" + theme.name);
      return;
    }
    customRow = createThemeCard({
      id: data.customId,
      name: theme.name,
      dataUrl: theme.dataUrl,
      colors: theme.colors,
      css: "",
    }, () => {
      const next = currentCustom ?? loadCustom() ?? theme;
      if (!next) return;
      // 控制通道可用时：旧本机快捷槽点击改为写入启动器，不再停留在「仅本机快捷」。
      if (data.control?.available === true) {
        void publishUserThemeToLauncher(next);
        return;
      }
      applyCustomTheme(next);
    });
    customDelete = document.createElement("button");
    customDelete.type = "button";
    customDelete.dataset.heigeRole = "custom-delete";
    customDelete.setAttribute("aria-label", "删除自定义主题：" + theme.name);
    customDelete.textContent = "\\u00d7";
    customDelete.style.cssText = "flex:none;width:24px;height:24px;padding:0;border:0;border-radius:50%;background:transparent;color:#713a31;cursor:pointer;font:700 14px/24px system-ui;";
    listen(customDelete, "mouseenter", () => { customDelete.style.background = "rgba(220,60,60,.15)"; customDelete.style.color = "#8f211d"; });
    listen(customDelete, "mouseleave", () => { customDelete.style.background = "transparent"; customDelete.style.color = "#713a31"; });
    listen(customDelete, "click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      deleteCustom();
    });
    customRowContainer = document.createElement("div");
    customRowContainer.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr) 30px;align-items:center;gap:4px;margin-bottom:18px;";
    customRowContainer.append(customRow, customDelete);
    customGrid.appendChild(customRowContainer);
    customSection.hidden = false;
    rows.set(data.customId, customRow);
  };

  const loadCustom = () => {
    assertCurrent();
    try {
      const saved = JSON.parse(localStorage.getItem(data.storageKey) ?? "null");
      if (!saved || typeof saved !== "object" || typeof saved.dataUrl !== "string" || typeof saved.colors !== "object") return null;
      for (const key of ["accent", "secondary", "surface", "text"]) {
        if (typeof saved.colors[key] !== "string" || !/^#[0-9a-f]{6}$/i.test(saved.colors[key])) return null;
      }
      parseDataUrlImage(saved.dataUrl);
      return {
        name: typeof saved.name === "string" ? saved.name.slice(0, 120) : "我的图片",
        dataUrl: saved.dataUrl,
        colors: Object.fromEntries(["accent", "secondary", "surface", "text"].map((key) => [key, saved.colors[key]])),
        appearance: ["light", "dark"].includes(saved.appearance)
          ? saved.appearance
          : appearanceFromColors(saved.colors),
      };
    } catch { return null; }
  };
  const saveCustom = (theme) => {
    assertCurrent();
    try { localStorage.setItem(data.storageKey, JSON.stringify(theme)); return true; }
    catch (error) { console.warn("HeiGe Codex Skin：自定义主题图片过大，本次生效但重启后会回退到上一张图", error); return false; }
  };

  let uploadPending = 0;
  const uploadAlert = document.createElement("div");
  uploadAlert.dataset.heigeRole = "upload-alert";
  uploadAlert.setAttribute("role", "alert");
  uploadAlert.setAttribute("aria-live", "polite");
  uploadAlert.setAttribute("aria-busy", "false");
  uploadAlert.hidden = true;
  uploadAlert.style.cssText = "margin:6px 4px;padding:7px 8px;border-radius:7px;background:rgba(187,72,50,.10);font-size:11px;line-height:1.5;color:#713a31;white-space:pre-line;";
  scroll.insertBefore(uploadAlert, customSection);
  const showUploadAlert = (message, kind = "error") => {
    assertCurrent();
    uploadAlert.textContent = String(message).replace(/[\\r\\n\\t]+/g, " ").slice(0, 180);
    uploadAlert.style.background = kind === "success" ? "rgba(26,132,103,.10)" : kind === "warning" ? "rgba(191,128,24,.12)" : "rgba(187,72,50,.10)";
    uploadAlert.style.color = kind === "success" ? "#175f4d" : kind === "warning" ? "#714d16" : "#713a31";
    uploadAlert.hidden = false;
  };
  const hideUploadAlert = () => {
    assertCurrent();
    uploadAlert.hidden = true;
    uploadAlert.textContent = "";
  };
  const setUploadPending = (value) => {
    uploadPending = Math.max(0, uploadPending + value);
    uploadAlert.setAttribute("aria-busy", String(uploadPending > 0));
  };
  const safeUploadError = (error) => {
    if (error?.name === "AbortError") return "图片处理已取消";
    const message = typeof error?.message === "string" ? error.message : "图片处理失败，请重试";
    if (/data:image|base64/i.test(message)) return "图片处理失败，请换一张图片";
    return message.replace(/[\\r\\n\\t]+/g, " ").slice(0, 160);
  };

  const importValidatedDataUrl = (dataUrl, name, metadata) => new Promise((resolve, reject) => {
    assertCurrent();
    let settled = false;
    const img = new Image();
    const finishImage = () => {
      trackedImages.delete(img);
      clearLater(timeoutId);
      signal.removeEventListener("abort", onAbort);
      img.onload = null;
      img.onerror = null;
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      finishImage();
      callback(value);
    };
    const fail = (error) => finish(reject, error);
    const onAbort = () => fail(new DOMException("HeiGe menu generation disposed", "AbortError"));
    const timeoutId = later(() => {
      fail(imageError("图片解码超时，请重试"));
      try { img.src = ""; } catch {}
    }, data.limits.browserOperationMs);
    signal.addEventListener("abort", onAbort, { once: true });
    trackedImages.set(img, fail);
    img.onload = () => {
      try {
        assertCurrent();
        const decodedWidth = Number(img.naturalWidth || img.width);
        const decodedHeight = Number(img.naturalHeight || img.height);
        if (decodedWidth !== metadata.width || decodedHeight !== metadata.height) throw imageError("图片解码尺寸与 header 不一致");
        const fitted = fitCanvas(decodedWidth, decodedHeight);
        if (
          fitted.width > data.limits.processedCanvasSide
          || fitted.height > data.limits.processedCanvasSide
          || fitted.width > Math.floor(data.limits.processedCanvasPixels / fitted.height)
        ) throw imageError("处理后画布超过安全预算");
        const full = document.createElement("canvas");
        full.width = fitted.width;
        full.height = fitted.height;
        const fullContext = full.getContext("2d");
        if (!fullContext || typeof fullContext.drawImage !== "function") throw imageError("无法创建图片画布");
        fullContext.drawImage(img, 0, 0, full.width, full.height);
        const sample = document.createElement("canvas");
        const sampleScale = Math.min(1, 48 / decodedWidth, 48 / decodedHeight);
        sample.width = Math.max(1, Math.floor(decodedWidth * sampleScale));
        sample.height = Math.max(1, Math.floor(decodedHeight * sampleScale));
        const sampleContext = sample.getContext("2d");
        if (!sampleContext || typeof sampleContext.drawImage !== "function") throw imageError("无法创建取色画布");
        sampleContext.drawImage(img, 0, 0, sample.width, sample.height);
        const encoded = full.toDataURL("image/webp", 0.8);
        if (typeof encoded !== "string" || !encoded.startsWith("data:image/webp")) throw imageError("图片压缩失败");
        const encodedMetadata = parseDataUrlImage(encoded).metadata;
        if (encodedMetadata.width !== full.width || encodedMetadata.height !== full.height) throw imageError("图片压缩结果尺寸不一致");
        const palette = extractPalette(sample);
        const theme = {
          name: name || "\\u6211\\u7684\\u56fe\\u7247",
          dataUrl: encoded,
          colors: palette.colors,
          appearance: palette.appearance,
        };
        assertCurrent();
        void publishUserThemeToLauncher(theme).then(
          () => finish(resolve, theme.colors),
          (error) => fail(error),
        );
      } catch (error) {
        fail(error);
      }
    };
    img.onerror = () => fail(isCurrent() ? imageError("图片解码失败") : new DOMException("HeiGe menu generation disposed", "AbortError"));
    try { img.src = dataUrl; }
    catch (error) { fail(error); }
  });

  const importFromDataUrl = async (dataUrl, name) => {
    assertCurrent();
    const validated = parseDataUrlImage(dataUrl);
    return importValidatedDataUrl(dataUrl, name, validated.metadata);
  };

  const readFileAsDataUrl = (file) => new Promise((resolve, reject) => {
    assertCurrent();
    let settled = false;
    const reader = new FileReader();
    const finishReader = () => {
      trackedReaders.delete(reader);
      clearLater(timeoutId);
      signal.removeEventListener("abort", onAbort);
      reader.onload = null;
      reader.onerror = null;
      reader.onabort = null;
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      finishReader();
      callback(value);
    };
    const onAbort = () => {
      try { reader.abort(); } catch {}
      finish(reject, new DOMException("HeiGe menu generation disposed", "AbortError"));
    };
    const timeoutId = later(() => {
      finish(reject, imageError("文件读取超时，请重试"));
      try { reader.abort(); } catch {}
    }, data.limits.browserOperationMs);
    signal.addEventListener("abort", onAbort, { once: true });
    trackedReaders.add(reader);
    reader.onload = () => {
      if (typeof reader.result !== "string") finish(reject, imageError("文件读取结果无效"));
      else finish(resolve, reader.result);
    };
    reader.onerror = () => finish(reject, imageError("文件读取失败，请重试"));
    reader.onabort = () => finish(reject, isCurrent() ? imageError("文件读取已取消") : new DOMException("HeiGe menu generation disposed", "AbortError"));
    try { reader.readAsDataURL(file); }
    catch (error) { finish(reject, error); }
  });

  const uploadFile = async (file) => {
    assertCurrent();
    if (!Number.isSafeInteger(file.size) || file.size < 1) throw imageError("图片文件大小无效");
    if (typeof file.arrayBuffer !== "function") throw imageError("浏览器无法读取图片文件");
    const expectedMime = expectedUploadMime(file);
    const arrayBuffer = await boundedOperation(() => file.arrayBuffer(), "文件读取");
    assertCurrent();
    if (Object.prototype.toString.call(arrayBuffer) !== "[object ArrayBuffer]") throw imageError("文件读取结果无效");
    const bytes = new Uint8Array(arrayBuffer);
    if (bytes.byteLength !== file.size) throw imageError("图片文件大小在读取时发生变化");
    const metadata = validateBrowserImage(bytes, expectedMime);
    const verifiedBlob = new Blob([bytes], { type: expectedMime });
    const dataUrl = await readFileAsDataUrl(verifiedBlob);
    assertCurrent();
    const reparsed = parseDataUrlImage(dataUrl);
    if (
      reparsed.metadata.mime !== metadata.mime
      || reparsed.metadata.width !== metadata.width
      || reparsed.metadata.height !== metadata.height
    ) throw imageError("图片读取内容前后不一致");
    return importValidatedDataUrl(dataUrl, file.name.replace(/\\.[a-z0-9]+$/i, ""), metadata);
  };

  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = "image/png,image/jpeg,image/webp";
  picker.style.display = "none";
  listen(picker, "change", () => {
    assertCurrent();
    const file = picker.files?.[0];
    if (!file) return;
    hideUploadAlert();
    setUploadPending(1);
    void uploadFile(file)
      .catch((error) => { if (isCurrent()) showUploadAlert(safeUploadError(error)); })
      .finally(() => { if (isCurrent()) setUploadPending(-1); });
    picker.value = "";
    setPanelOpen(true);
  });

  const uploadRow = row("\\uff0b \\u81ea\\u5b9a\\u4e49\\u56fe\\u7247", "rgba(36,201,215,.9)", () => picker.click(), null, { role: "upload-trigger" });
  uploadRow.style.borderTop = "1px solid rgba(0,0,0,.08)";

  const native = row("\\u539f\\u751f\\u754c\\u9762", "rgba(0,0,0,.24)", () => {
    void requestThemeSelection(data.nativeSel).then((applied) => {
      if (applied) setPanelOpen(false, { focusTrigger: true });
    });
  }, null, { role: "native-option", selectable: true });
  native.dataset.heigeThemeId = data.nativeSel;
  rows.set(null, native);

  // ---- 常驻开关：只显示控制器确认的真实状态，不使用 localStorage 伪造持久化 ----
  let getPersistenceState = () => null;
  let applyRemotePersistence = () => false;
  let controlRequest = null;
  let themePending = false;
  if (data.control?.available === true) {
    const section = document.createElement("section");
    section.dataset.heigeRole = "persistence-section";
    section.style.cssText = "display:flex;align-items:center;flex:1;min-width:0;";

    const heading = document.createElement("div");
    heading.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:14px;";
    const headingCopy = document.createElement("div");
    headingCopy.style.cssText = "min-width:0;";
    const headingTitle = document.createElement("div");
    headingTitle.id = data.menuId + "-persistence-title";
    headingTitle.textContent = "皮肤常驻";
    headingTitle.style.cssText = "font-weight:750;letter-spacing:.01em;color:#17344f;";
    const headingState = document.createElement("div");
    headingState.id = data.menuId + "-persistence-state";
    headingState.dataset.heigeRole = "persistence-state";
    headingState.style.cssText = "margin-top:1px;font-size:11px;color:rgba(23,52,79,.68);";
    headingCopy.append(headingTitle, headingState);

    const persistenceSwitch = document.createElement("button");
    persistenceSwitch.type = "button";
    persistenceSwitch.dataset.heigeRole = "persistence-switch";
    persistenceSwitch.setAttribute("role", "switch");
    persistenceSwitch.setAttribute("tabindex", "0");
    persistenceSwitch.setAttribute("aria-labelledby", headingTitle.id);
    persistenceSwitch.style.cssText = "position:relative;flex:none;width:42px;height:24px;padding:0;border:1px solid #31526b;border-radius:999px;cursor:pointer;-webkit-app-region:no-drag;";
    const switchKnob = document.createElement("span");
    switchKnob.setAttribute("aria-hidden", "true");
    switchKnob.style.cssText = "position:absolute;top:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.24);";
    persistenceSwitch.appendChild(switchKnob);
    heading.append(headingCopy, persistenceSwitch);

    const helper = document.createElement("p");
    helper.id = data.menuId + "-persistence-helper";
    helper.dataset.heigeRole = "persistence-helper";
    helper.textContent = "关闭后本次继续使用；下次启动恢复原生界面。\\n恢复本次皮肤：打开「HeiGe 皮肤启动器」，或在 Codex 中说「启用 HeiGe 皮肤」。\\n下次仍常驻：重新打开此开关。";
    helper.style.cssText = "margin:8px 0 0;white-space:pre-line;font-size:11px;line-height:1.55;color:rgba(23,52,79,.74);";
    persistenceSwitch.setAttribute("aria-describedby", headingState.id + " " + helper.id);

    const confirmation = document.createElement("div");
    confirmation.dataset.heigeRole = "persistence-confirmation";
    confirmation.setAttribute("role", "group");
    confirmation.setAttribute("aria-describedby", helper.id);
    confirmation.setAttribute("aria-busy", "false");
    confirmation.hidden = true;
    confirmation.style.cssText = "padding:12px;border:1px solid rgba(187,72,50,.24);border-radius:12px;background:rgba(255,244,240,.96);";
    const confirmationText = document.createElement("div");
    confirmationText.id = data.menuId + "-persistence-confirmation-text";
    confirmationText.textContent = "确认关闭常驻？本次会话仍继续使用皮肤，下次启动将恢复原生界面。";
    confirmationText.style.cssText = "font-size:11px;line-height:1.55;color:#713a31;";
    confirmation.setAttribute("aria-labelledby", confirmationText.id);
    const confirmationActions = document.createElement("div");
    confirmationActions.style.cssText = "display:flex;justify-content:flex-end;gap:7px;margin-top:8px;";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.dataset.heigeRole = "persistence-cancel";
    cancel.textContent = "取消";
    cancel.style.cssText = "padding:4px 9px;border:1px solid rgba(23,52,79,.18);border-radius:6px;background:#fff;color:#17344f;cursor:pointer;";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.dataset.heigeRole = "persistence-confirm";
    confirm.textContent = "确认关闭";
    confirm.style.cssText = "padding:4px 9px;border:1px solid #a84232;border-radius:6px;background:#a84232;color:#fff;cursor:pointer;";
    confirmationActions.append(cancel, confirm);
    confirmation.append(confirmationText, confirmationActions);

    const alert = document.createElement("div");
    alert.dataset.heigeRole = "persistence-alert";
    alert.setAttribute("role", "alert");
    alert.setAttribute("aria-live", "polite");
    alert.hidden = true;
    alert.style.cssText = "padding:10px 12px;border-radius:12px;background:rgba(248,252,255,.96);font-size:11px;line-height:1.5;color:#17344f;white-space:pre-line;";

    section.append(heading, helper, confirmation, alert);
    footer.appendChild(section);

    let persistenceEnabled = data.control.persistenceEnabled;
    let controlRevision = data.control.revision;
    let pending = false;
    let controlRequestTimeout = null;
    const themeEndpoint = data.control.endpoint.slice(0, -"/v1/persistence".length) + "/v1/theme";
    const userThemeEndpoint = data.control.endpoint.slice(0, -"/v1/persistence".length) + "/v1/user-theme";
    const newRequestId = () => {
      const bytes = new Uint8Array(16);
      globalThis.crypto.getRandomValues(bytes);
      return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
    };

    const closeConfirmation = ({ restoreFocus = false } = {}) => {
      assertCurrent();
      if (confirmation.hidden) return false;
      if (restoreFocus) {
        if (pending) button.focus();
        else persistenceSwitch.focus();
      }
      confirmation.hidden = true;
      confirmation.setAttribute("aria-busy", "false");
      cancel.removeAttribute("aria-disabled");
      confirm.removeAttribute("aria-disabled");
      return true;
    };

    const showAlert = (message, kind = "error") => {
      assertCurrent();
      alert.textContent = message;
      alert.style.background = kind === "success" ? "rgba(26,132,103,.10)" : "rgba(187,72,50,.10)";
      alert.style.color = kind === "success" ? "#175f4d" : "#713a31";
      alert.hidden = false;
    };
    const hideAlert = () => { assertCurrent(); alert.hidden = true; alert.textContent = ""; };
    const paintPersistence = () => {
      assertCurrent();
      persistenceSwitch.setAttribute("aria-checked", String(persistenceEnabled));
      persistenceSwitch.setAttribute("aria-busy", String(pending));
      persistenceSwitch.disabled = pending;
      persistenceSwitch.style.background = persistenceEnabled ? "#087d8a" : "#66788a";
      persistenceSwitch.style.opacity = pending ? ".64" : "1";
      switchKnob.style.left = persistenceEnabled ? "21px" : "4px";
      headingState.textContent = pending
        ? persistenceEnabled
          ? "已开启，正在后台静默保存…"
          : "已关闭，正在后台静默保存…"
        : persistenceEnabled
          ? "已开启，下次启动继续使用"
          : "已关闭，仅保留本次会话";
    };
    const safeClientError = (error) => {
      if (error?.name === "AbortError") return "控制器请求超时，请重试";
      let detail = typeof error?.message === "string" ? error.message : "无法连接后台控制器";
      detail = detail
        .split(data.control.token).join("[已隐去]")
        .split(data.control.endpoint).join("本机控制端点")
        .split(themeEndpoint).join("本机主题端点");
      detail = detail.replace(/[\\r\\n\\t]+/g, " ").slice(0, 160);
      return detail.includes("控制器不可用") ? detail : "控制器不可用：" + detail;
    };
    const clearControlRequest = () => {
      const cleared = controlRequest;
      if (controlRequestTimeout !== null) clearLater(controlRequestTimeout);
      controlRequestTimeout = null;
      controlRequest = null;
      return cleared;
    };
    let availableUpdate = null;
    const paintUpdateState = (state, latestVersion = null) => {
      assertCurrent();
      if (state === "checking") {
        versionText.textContent = "正在检查 GitHub…";
        updateButton.textContent = "检查中";
        updateButton.disabled = true;
      } else if (state === "latest") {
        versionText.textContent = "v" + data.currentVersion + " 已是最新版";
        updateButton.textContent = "再次检查";
        updateButton.disabled = false;
      } else if (state === "available") {
        versionText.textContent = "发现新版本 v" + latestVersion;
        updateButton.textContent = "复制更新指令";
        updateButton.disabled = false;
      } else if (state === "error") {
        versionText.textContent = "暂时无法检查更新";
        updateButton.textContent = "重新检查";
        updateButton.disabled = false;
      } else {
        versionText.textContent = "当前版本 v" + data.currentVersion;
        updateButton.textContent = "检查更新";
        updateButton.disabled = false;
      }
    };
    const exactUpdateKeys = (value, expected) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
      const keys = Object.keys(value).sort();
      const sorted = [...expected].sort();
      return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
    };
    const stableVersion = /^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$/;
    const receiveUpdateCheckResult = (result) => {
      assertCurrent();
      const pendingRequest = controlRequest;
      if (
        pendingRequest?.action !== "check-update"
        || result?.status === undefined
        || !["latest", "update-available", "error"].includes(result.status)
      ) return false;
      const expectedKeys = result.status === "error"
        ? ["schemaVersion", "requestId", "generation", "status", "currentVersion"]
        : ["schemaVersion", "requestId", "generation", "status", "currentVersion", "latestVersion", "releaseUrl"];
      if (
        !exactUpdateKeys(result, expectedKeys)
        || result.schemaVersion !== 1
        || result.requestId !== pendingRequest.requestId
        || result.generation !== pendingRequest.generation
        || result.generation !== generation
        || result.currentVersion !== data.currentVersion
      ) return false;
      if (result.status !== "error") {
        const expectedReleaseUrl =
          "https://github.com/HeiGeAi/heige-codex-skin-studio/releases/tag/v" + result.latestVersion;
        if (!stableVersion.test(result.latestVersion) || result.releaseUrl !== expectedReleaseUrl) return false;
      }
      clearControlRequest();
      if (result.status === "latest") {
        availableUpdate = null;
        paintUpdateState("latest");
        showAlert("当前已经是最新版本。", "success");
      } else if (result.status === "update-available") {
        availableUpdate = {
          currentVersion: result.currentVersion,
          latestVersion: result.latestVersion,
          releaseUrl: result.releaseUrl,
        };
        paintUpdateState("available", result.latestVersion);
        showAlert("发现新版本，复制更新指令后粘贴到 Codex 对话中即可。", "success");
      } else {
        availableUpdate = null;
        paintUpdateState("error");
        showAlert("暂时无法连接 GitHub，请稍后重试。");
      }
      return true;
    };
    runtime.receiveUpdateCheckResult = receiveUpdateCheckResult;
    const removeUserThemeRow = (themeId) => {
      document.querySelector('[data-heige-role="user-theme-row"][data-heige-theme-id="' + themeId + '"]')?.remove();
      rows.get(themeId)?.remove();
      rows.delete(themeId);
      const index = themes.findIndex((candidate) => candidate.id === themeId);
      if (index >= 0) themes.splice(index, 1);
      if (customGrid.childElementCount === 0 && !customRow) customSection.hidden = true;
    };
    const receiveThemeSelectionResult = (result) => {
      assertCurrent();
      const pendingRequest = controlRequest;
      if (
        pendingRequest?.action !== "publish-user-theme" &&
        pendingRequest?.action !== "delete-user-theme"
      ) return false;
      if (
        result === null
        || typeof result !== "object"
        || Array.isArray(result)
        || result.schemaVersion !== 1
        || result.requestId !== pendingRequest.requestId
        || typeof result.persistenceEnabled !== "boolean"
        || !isRevision(result.revision)
        || result.revision < pendingRequest.expectedRevision
        || result.revision < controlRevision
      ) return false;
      if (typeof result.themeId !== "string" || result.themeId.length === 0) {
        return false;
      }
      const keys = Object.keys(result).sort();
      const expectedKeys = ["persistenceEnabled", "requestId", "revision", "schemaVersion", "themeId"];
      if (
        keys.length !== expectedKeys.length
        || keys.some((key, index) => key !== expectedKeys[index])
      ) return false;
      clearControlRequest();
      persistenceEnabled = result.persistenceEnabled;
      controlRevision = result.revision;
      themePending = false;
      for (const item of rows.values()) item.disabled = false;
      if (pendingRequest.action === "delete-user-theme") {
        removeUserThemeRow(pendingRequest.themeId);
        if (result.themeId === data.nativeSel) clearTheme(true, false);
        else setTheme(result.themeId, true, false);
        paintSaveState("saved", "已删除");
        showAlert("自定义主题已从启动器删除。", "success");
      } else if (pendingRequest.action === "publish-user-theme") {
        const source = {
          name: pendingRequest.name,
          dataUrl: pendingRequest.image,
          colors: pendingRequest.colors,
          appearance: currentCustom?.appearance,
        };
        if (!source.dataUrl || !source.colors) {
          source.name = source.name || currentCustom?.name;
          source.dataUrl = source.dataUrl || currentCustom?.dataUrl;
          source.colors = source.colors || currentCustom?.colors;
          source.appearance = source.appearance || currentCustom?.appearance;
        }
        if (source.dataUrl && source.colors) {
          upsertPublishedUserTheme(source, result.themeId);
          setTheme(result.themeId, true, false);
        } else {
          removeLegacyCustomRow();
          writeSelected(result.themeId);
          document.documentElement.dataset.heigeCodexSkin = result.themeId;
          paint(result.themeId);
          paintCurrentTheme(result.themeId);
        }
        paintSaveState("saved", "已保存");
        showAlert("自定义主题已保存到启动器。", "success");
      }
      paintPersistence();
      return true;
    };
    runtime.receiveThemeSelectionResult = receiveThemeSelectionResult;
    const queueUpdateCheck = () => {
      assertCurrent();
      if (controlRequest !== null) {
        showAlert("请等待当前操作完成后再检查更新。");
        return false;
      }
      const request = {
        schemaVersion: 1,
        requestId: newRequestId(),
        action: "check-update",
        capability: data.control.token,
        generation,
      };
      controlRequest = request;
      availableUpdate = null;
      hideAlert();
      paintUpdateState("checking");
      controlRequestTimeout = later(() => {
        if (controlRequest?.requestId !== request.requestId) return;
        clearControlRequest();
        paintUpdateState("error");
        showAlert("后台控制器未返回检查结果，请重试。");
      }, 15000);
      return true;
    };
    const updateInstruction = () => [
      "请帮我更新 HeiGe Codex Skin Studio。",
      "",
      "项目地址：https://github.com/HeiGeAi/heige-codex-skin-studio",
      "当前安装版本：v" + availableUpdate.currentVersion,
      "检测到最新版本：v" + availableUpdate.latestVersion,
      "发布页面：" + availableUpdate.releaseUrl,
      "",
      "请先检查本机现有安装，再按项目 README 的最新版安装流程完成更新。",
      "保留现有主题、宠物和常驻设置，更新后运行项目测试并做一次真实启动验证。",
      "不要修改 Codex 的 app.asar，也不要覆盖与本项目无关的用户配置。",
    ].join("\\n");
    const copyUpdateInstruction = async () => {
      assertCurrent();
      const text = updateInstruction();
      try {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
        await navigator.clipboard.writeText(text);
        assertCurrent();
        showAlert("更新指令已复制，请粘贴到 Codex 对话中执行。", "success");
        return true;
      } catch {}
      let textarea = null;
      try {
        assertCurrent();
        textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        if (document.execCommand?.("copy") !== true) throw new Error("copy command failed");
        showAlert("更新指令已复制，请粘贴到 Codex 对话中执行。", "success");
        return true;
      } catch {
        if (isCurrent()) showAlert("复制失败，请手动复制项目地址。");
        return false;
      } finally {
        textarea?.remove();
      }
    };
    listen(updateButton, "click", () => {
      if (availableUpdate === null) queueUpdateCheck();
      else void copyUpdateInstruction();
    });
    const renderThemeSelection = (themeId, persist = false, broadcast = false) => {
      if (themeId === data.customId) {
        const custom = currentCustom ?? loadCustom();
        if (custom) applyCustomTheme(custom, persist, broadcast);
        return;
      }
      if (themeId === data.nativeSel) clearTheme(persist, broadcast);
      else setTheme(themeId, persist, broadcast);
    };
    const queueControlRequest = (request, { silent = false } = {}) => {
      if (controlRequest !== null) return false;
      controlRequest = request;
      // Windows 首次注册并启动计划任务可能明显超过 20 秒。常驻切换已经在前端
      // 乐观生效，这里只给后台静默保存留出完整窗口，不再让超时回退 UI。
      const fallbackTimeoutMs = request.action === "set-persistence" ? 120_000 : 60_000;
      controlRequestTimeout = later(() => {
        if (controlRequest?.requestId !== request.requestId) return;
        const timedOut = controlRequest;
        clearControlRequest();
        if (timedOut.action === "set-persistence") {
          pending = false;
          closeConfirmation({ restoreFocus: true });
          paintPersistence();
        } else if (timedOut.action === "delete-user-theme") {
          paintSaveState("error", "未删除，请重试");
          themePending = false;
          for (const item of rows.values()) item.disabled = false;
        } else {
          paintSaveState("error", "未保存，请重试");
          themePending = false;
          for (const item of rows.values()) item.disabled = false;
        }
        if (!silent) showAlert("后台控制器未确认，请重试");
      }, fallbackTimeoutMs);
      if (!silent) showAlert("正在等待后台确认…", "success");
      return true;
    };
    const isRevision = (value) => Number.isSafeInteger(value) && value >= 0;
    requestThemeSelection = async (themeId) => {
      assertCurrent();
      const currentThemeId = document.documentElement.dataset.heigeCodexSkin ?? data.nativeSel;
      if (themeId === currentThemeId) return false;
      if (
        themeId !== data.nativeSel &&
        !themes.some((theme) => theme.id === themeId)
      ) return false;
      const requestRevision = controlRevision;
      const requestId = newRequestId();
      // 主题选择是前端优先操作：当前 renderer 与本地选择立即生效，
      // 后台提交只负责静默保存，不能决定或回退用户已经看到的主题。
      renderThemeSelection(themeId, true, true);
      paintSaveState("saved", "已本地切换");
      hideAlert();
      const abortController = childController();
      const timeoutId = later(() => abortController.abort(), 15000);
      void (async () => {
      try {
        const response = await fetch(themeEndpoint, {
          method: "POST",
          mode: "cors",
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          headers: {
            "Content-Type": "application/json",
            "X-HeiGe-Control-Token": data.control.token,
          },
          body: JSON.stringify({
            revision: requestRevision,
            themeId,
            requestId,
          }),
          signal: abortController.signal,
        });
        assertCurrent();
        const body = await response.json();
        assertCurrent();
        if (!response.ok) {
          if (
            body?.ok === false &&
            body.persistenceEnabled === persistenceEnabled &&
            isRevision(body.revision) &&
            body.revision > controlRevision
          ) {
            controlRevision = body.revision;
            publish("persistence", { enabled: persistenceEnabled, revision: controlRevision });
          }
          paintSaveState("saved", "已本地切换");
          return true;
        }
        if (
          body?.ok !== true ||
          body.themeId !== themeId ||
          body.persistenceEnabled !== persistenceEnabled ||
          !isRevision(body.revision) ||
          body.revision < requestRevision ||
          body.revision < controlRevision
        ) {
          throw new Error("后台未确认主题选择");
        }
        controlRevision = body.revision;
        publish("persistence", { enabled: persistenceEnabled, revision: controlRevision });
        paintSaveState("saved", "已保存");
        return true;
      } catch (error) {
        if (isCurrent()) {
          // 后台保存失败保持静默；本地主题已经持久化，不参与回退。
          paintSaveState("saved", "已本地切换");
        }
        return true;
      } finally {
        clearLater(timeoutId);
        trackedControllers.delete(abortController);
      }
      })();
      return true;
    };

    publishUserThemeToLauncher = async (theme) => {
      assertCurrent();
      if (!theme?.dataUrl || !theme?.colors || !theme?.name) {
        showUploadAlert("自定义主题数据无效");
        return false;
      }
      const requestRevision = controlRevision;
      const requestId = newRequestId();
      const fallbackRequest = {
        schemaVersion: 1,
        requestId,
        action: "publish-user-theme",
        capability: data.control.token,
        expectedRevision: requestRevision,
        name: theme.name,
        image: theme.dataUrl,
        colors: theme.colors,
      };
      paintSaveState("saving", "正在保存启动器主题…");
      themePending = true;
      hideAlert();
      hideUploadAlert();
      showUploadAlert("正在写入启动器主题库…", "success");
      for (const item of rows.values()) item.disabled = true;
      const abortController = childController();
      const timeoutId = later(() => abortController.abort(), 30000);
      let queued = false;
      try {
        const response = await fetch(userThemeEndpoint, {
          method: "POST",
          mode: "cors",
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          headers: {
            "Content-Type": "application/json",
            "X-HeiGe-Control-Token": data.control.token,
          },
          body: JSON.stringify({
            revision: requestRevision,
            requestId,
            name: theme.name,
            image: theme.dataUrl,
            colors: theme.colors,
          }),
          signal: abortController.signal,
        });
        assertCurrent();
        const body = await response.json();
        assertCurrent();
        if (!response.ok) {
          const message = typeof body?.message === "string" && body.message.length <= 160
            ? body.message
            : "后台拒绝写入自定义主题";
          paintSaveState("error", "未保存，请重试");
          showUploadAlert(message);
          showAlert(message);
          return false;
        }
        if (
          body?.ok !== true ||
          typeof body.themeId !== "string" ||
          body.persistenceEnabled !== persistenceEnabled ||
          !isRevision(body.revision) ||
          body.revision < requestRevision
        ) {
          throw new Error("后台未确认自定义主题写入");
        }
        controlRevision = body.revision;
        publish("persistence", { enabled: persistenceEnabled, revision: controlRevision });
        // 立刻 upsert 正式用户主题卡，不再等 reinject 才出现在「我的主题」。
        upsertPublishedUserTheme(theme, body.themeId);
        setTheme(body.themeId, true, true);
        paintSaveState("saved", "已保存");
        showUploadAlert("自定义主题已写入启动器，常驻/重启后可继续使用。", "success");
        showAlert("自定义主题已保存到启动器。", "success");
        return true;
      } catch (error) {
        if (isCurrent()) {
          queued = queueControlRequest(fallbackRequest);
          if (!queued) {
            paintSaveState("error", "未保存，请重试");
            showUploadAlert(safeClientError(error));
            showAlert(safeClientError(error));
          } else {
            // 等待 ACK 期间保留本机快捷预览，避免「我的主题」先空一截。
            currentCustom = theme;
            ensureCustomRow(theme);
            style.textContent = buildCustomCss(theme.dataUrl, theme.colors);
            applyCodexAppearance(theme.appearance ?? appearanceFromColors(theme.colors));
            paintCurrentTheme(data.customId);
            showUploadAlert("正在等待后台确认写入启动器…", "success");
          }
        }
        return false;
      } finally {
        clearLater(timeoutId);
        trackedControllers.delete(abortController);
        if (!isCurrent()) return;
        if (queued) {
          for (const item of rows.values()) item.disabled = false;
          return;
        }
        themePending = false;
        for (const item of rows.values()) item.disabled = false;
      }
    };

    requestDeleteUserTheme = async (themeId) => {
      assertCurrent();
      if (typeof themeId !== "string" || themeId.length === 0) return false;
      if (themePending || controlRequest !== null) {
        showAlert("请等待当前操作完成后再删除。");
        return false;
      }
      const requestRevision = controlRevision;
      const requestId = newRequestId();
      const fallbackRequest = {
        schemaVersion: 1,
        requestId,
        action: "delete-user-theme",
        capability: data.control.token,
        expectedRevision: requestRevision,
        themeId,
      };
      paintSaveState("saving", "正在删除启动器主题…");
      themePending = true;
      hideAlert();
      for (const item of rows.values()) item.disabled = true;
      const abortController = childController();
      const timeoutId = later(() => abortController.abort(), 15000);
      let queued = false;
      try {
        const response = await fetch(userThemeEndpoint, {
          method: "POST",
          mode: "cors",
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          headers: {
            "Content-Type": "application/json",
            "X-HeiGe-Control-Token": data.control.token,
          },
          body: JSON.stringify({
            action: "delete",
            revision: requestRevision,
            requestId,
            themeId,
          }),
          signal: abortController.signal,
        });
        assertCurrent();
        const body = await response.json();
        assertCurrent();
        if (!response.ok || body?.ok !== true || !isRevision(body.revision)) {
          const message = typeof body?.message === "string" && body.message.length <= 160
            ? body.message
            : "删除自定义主题失败";
          paintSaveState("error", "未删除，请重试");
          showAlert(message);
          return false;
        }
        controlRevision = body.revision;
        publish("persistence", { enabled: persistenceEnabled, revision: controlRevision });
        removeUserThemeRow(themeId);
        if (typeof body.themeId === "string") {
          if (body.themeId === data.nativeSel) clearTheme(true, true);
          else setTheme(body.themeId, true, true);
        }
        paintSaveState("saved", "已删除");
        showAlert("自定义主题已从启动器删除。", "success");
        return true;
      } catch (error) {
        if (isCurrent()) {
          // Codex CSP 会拦本机 HTTP；与发布一样排队 CDP 兜底。
          queued = queueControlRequest(fallbackRequest);
          if (!queued) {
            paintSaveState("error", "未删除，请重试");
            showAlert(safeClientError(error));
          } else {
            showAlert("正在等待后台确认删除…", "success");
          }
        }
        return false;
      } finally {
        clearLater(timeoutId);
        trackedControllers.delete(abortController);
        if (!isCurrent()) return;
        if (queued) {
          for (const item of rows.values()) item.disabled = false;
          return;
        }
        themePending = false;
        for (const item of rows.values()) item.disabled = false;
      }
    };

    const requestPersistence = async (target, restoreFocus = false) => {
      assertCurrent();
      if (pending || target === persistenceEnabled) return;
      const previousEnabled = persistenceEnabled;
      const requestRevision = controlRevision;
      const fallbackRequest = {
        schemaVersion: 1,
        requestId: newRequestId(),
        action: "set-persistence",
        capability: data.control.token,
        expectedRevision: requestRevision,
        persistenceEnabled: target,
      };
      pending = true;
      // 常驻与主题选择采用相同的本地优先交互：开关先按用户意图改变，
      // 计划任务注册和控制器交接只在后台同步，不能阻塞主题面板。
      persistenceEnabled = target;
      let queued = false;
      if (!target && !confirmation.hidden) {
        confirmation.setAttribute("aria-busy", "true");
        cancel.setAttribute("aria-disabled", "true");
        confirm.setAttribute("aria-disabled", "true");
      }
      hideAlert();
      paintPersistence();
      const abortController = childController();
      // Windows 首次 ACL 校验、计划任务注册和控制器握手可能超过一分钟。
      const timeoutId = later(() => abortController.abort(), 90_000);
      try {
        const response = await fetch(data.control.endpoint, {
          method: "POST",
          mode: "cors",
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          headers: {
            "Content-Type": "application/json",
            "X-HeiGe-Control-Token": data.control.token,
          },
          body: JSON.stringify({ revision: requestRevision, persistenceEnabled: target }),
          signal: abortController.signal,
        });
        assertCurrent();
        const body = await response.json();
        assertCurrent();
        if (response.ok) {
          if (
            body?.ok !== true ||
            body.persistenceEnabled !== target ||
            !isRevision(body.revision) ||
            body.revision <= requestRevision
          ) {
            throw new Error("后台响应无效，开关未更改");
          }
          if (body.revision <= controlRevision) return;
          persistenceEnabled = target;
          controlRevision = body.revision;
          publish("persistence", { enabled: persistenceEnabled, revision: controlRevision });
          showAlert(target
            ? "常驻已开启，下次启动继续使用皮肤。"
            : "常驻已关闭。本次继续使用，下次启动恢复原生界面。\\n「HeiGe 皮肤启动器」或「启用 HeiGe 皮肤」只恢复本次皮肤。\\n下次仍常驻：重新打开此开关。",
          "success");
        } else {
          persistenceEnabled = previousEnabled;
          if (
            body?.ok === false &&
            body.persistenceEnabled === previousEnabled &&
            isRevision(body.revision) &&
            body.revision > requestRevision
          ) {
            controlRevision = body.revision;
          }
          // 业务拒绝（含后台启动失败补偿）必须立刻可见，禁止再静默走 CDP 兜底。
          const message = typeof body?.message === "string" && body.message.length <= 160
            ? body.message
            : "后台拒绝了常驻设置，开关未更改";
          showAlert(message);
        }
      } catch (error) {
        if (!isCurrent()) return;
        if (error?.message?.includes("后台响应无效")) {
          persistenceEnabled = previousEnabled;
          showAlert(error.message);
        } else if (
          error?.name === "AbortError" ||
          /Failed to fetch|NetworkError|Load failed|CSP|blocked/i.test(String(error?.message ?? error))
        ) {
          // 仅超时/网络/CSP 才排队 CDP 兜底。
          queued = queueControlRequest(fallbackRequest, { silent: true });
          if (!queued) {
            persistenceEnabled = previousEnabled;
            showAlert(safeClientError(error));
          }
        } else {
          persistenceEnabled = previousEnabled;
          showAlert(safeClientError(error));
        }
      } finally {
        clearLater(timeoutId);
        trackedControllers.delete(abortController);
        if (!isCurrent()) return;
        if (!queued) pending = false;
        paintPersistence();
        if (restoreFocus) closeConfirmation({ restoreFocus: true });
      }
    };
    applyRemotePersistence = (value) => {
      assertCurrent();
      if (value.revision <= controlRevision) return false;
      const cleared = clearControlRequest();
      if (cleared?.action === "set-persistence") pending = false;
      if (
        cleared?.action === "publish-user-theme" ||
        cleared?.action === "delete-user-theme"
      ) {
        paintSaveState(
          "error",
          cleared.action === "delete-user-theme" ? "未删除，请重试" : "未保存，请重试",
        );
        themePending = false;
        for (const item of rows.values()) item.disabled = false;
      }
      if (cleared?.action === "check-update") paintUpdateState("error");
      closeConfirmation({ restoreFocus: !confirmation.hidden });
      persistenceEnabled = value.enabled;
      controlRevision = value.revision;
      hideAlert();
      paintPersistence();
      return true;
    };
    const activatePersistenceSwitch = () => {
      assertCurrent();
      if (pending) return;
      if (persistenceEnabled) {
        hideAlert();
        confirmation.hidden = false;
        confirmation.setAttribute("aria-busy", "false");
        cancel.focus();
      } else {
        void requestPersistence(true);
      }
    };
    listen(persistenceSwitch, "click", activatePersistenceSwitch);
    listen(persistenceSwitch, "keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      activatePersistenceSwitch();
    });
    listen(cancel, "click", () => {
      if (pending) return;
      closeConfirmation({ restoreFocus: true });
    });
    listen(confirmation, "keydown", (event) => {
      if (event.key !== "Escape" || confirmation.hidden || pending) return;
      event.preventDefault();
      event.stopPropagation();
      closeConfirmation({ restoreFocus: true });
    });
    listen(confirm, "click", () => { void requestPersistence(false, true); });
    getPersistenceState = () => { assertCurrent(); return { persistenceEnabled, revision: controlRevision, pending }; };
    paintPersistence();
  }

  // ---- 隐藏按钮：收成半透明小圆点少占地方，点圆点恢复，状态跨重启保留 ----
  const readHidden = () => { assertCurrent(); try { return localStorage.getItem(data.hiddenKey) === "1"; } catch { return false; } };
  const writeHidden = (value) => { assertCurrent(); try { if (value) localStorage.setItem(data.hiddenKey, "1"); else localStorage.removeItem(data.hiddenKey); } catch {} };
  const FULL_BUTTON_CSS = button.style.cssText;
  const MINI_BUTTON_CSS = "width:24px;height:24px;min-width:24px;padding:0;border:0;background:transparent;box-shadow:none;cursor:pointer;font-size:0;-webkit-app-region:no-drag;";
  const setHidden = (value, persist = true, broadcast = true) => {
    assertCurrent();
    if (typeof value !== "boolean") return;
    const panelHadFocus = panel.contains(document.activeElement);
    if (value) setPanelOpen(false, { focusTrigger: panelHadFocus });
    hidden = value;
    button.dataset.hidden = String(value);
    button.style.cssText = value ? MINI_BUTTON_CSS : FULL_BUTTON_CSS;
    triggerText.hidden = value;
    triggerGlyph.hidden = value;
    triggerPreview.style.cssText = value
      ? "display:block;margin:auto;width:10px;height:10px;border-radius:50%;background:#66788a;box-shadow:0 1px 4px rgba(0,0,0,.18);opacity:.55;"
      : "";
    if (!value) paintCurrentTheme(document.documentElement.dataset.heigeCodexSkin ?? data.nativeSel);
    button.title = value ? "\\u663e\\u793a\\u6362\\u80a4\\u6309\\u94ae" : "HeiGe Codex Skin Studio";
    button.setAttribute("aria-label", value ? "显示主题入口" : "打开主题中心");
    setPanelOpen(false);
    if (persist) writeHidden(value);
    if (broadcast) publish("menu-hidden", value);
  };
  listen(button, "mouseenter", () => { if (hidden) { triggerPreview.style.opacity = ".9"; triggerPreview.style.transform = "scale(1.15)"; } });
  listen(button, "mouseleave", () => { if (hidden) { triggerPreview.style.opacity = ".55"; triggerPreview.style.transform = "scale(1)"; } });
  const hideRow = row("\\u9690\\u85cf\\u6b64\\u6309\\u94ae", "rgba(0,0,0,.18)", () => setHidden(true), null, { role: "hide-trigger" });
  hideRow.style.borderTop = "1px solid rgba(0,0,0,.08)";

  const saved = loadCustom();
  if (saved) ensureCustomRow(saved);

  const receivedSequences = new Map();
  const rememberSequence = (senderGeneration, sequence) => {
    if (!receivedSequences.has(senderGeneration) && receivedSequences.size >= 256) {
      receivedSequences.delete(receivedSequences.keys().next().value);
    }
    receivedSequences.delete(senderGeneration);
    receivedSequences.set(senderGeneration, sequence);
  };
  const exactKeys = (value, expected) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const keys = Object.keys(value).sort();
    const sorted = [...expected].sort();
    return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
  };
  const normalizeBroadcast = (message) => {
    if (!exactKeys(message, ["schemaVersion", "senderGeneration", "sequence", "kind", "value"])) return null;
    if (
      message.schemaVersion !== 1
      || typeof message.senderGeneration !== "string"
      || !/^[0-9a-f]{32}$/.test(message.senderGeneration)
      || message.senderGeneration === generation
      || !Number.isSafeInteger(message.sequence)
      || message.sequence < 1
      || !["theme", "menu-hidden", "persistence", "readability"].includes(message.kind)
    ) return null;
    if (message.kind === "theme") {
      if (
        typeof message.value !== "string"
        || (
          message.value !== data.nativeSel
          && message.value !== data.customId
          && !themes.some((theme) => theme.id === message.value)
        )
      ) return null;
    } else if (message.kind === "menu-hidden") {
      if (typeof message.value !== "boolean") return null;
    } else if (message.kind === "readability") {
      if (typeof message.value !== "boolean") return null;
    } else if (
      !exactKeys(message.value, ["enabled", "revision"])
      || typeof message.value.enabled !== "boolean"
      || !Number.isSafeInteger(message.value.revision)
      || message.value.revision < 0
    ) return null;
    return message;
  };
  const receiveBroadcast = (event) => {
    try {
      const message = normalizeBroadcast(event?.data);
      if (message === null) return;
      const previous = receivedSequences.get(message.senderGeneration) ?? 0;
      if (message.sequence <= previous) return;
      if (message.kind === "theme" && message.value === data.customId) {
        const custom = currentCustom ?? loadCustom();
        if (!custom) return;
        applyCustomTheme(custom, true, false);
      } else if (message.kind === "theme" && message.value === data.nativeSel) {
        clearTheme(true, false);
      } else if (message.kind === "theme") {
        setTheme(message.value, true, false);
      } else if (message.kind === "menu-hidden") {
        setHidden(message.value, true, false);
      } else if (message.kind === "readability") {
        setReadability(message.value, true, false);
      } else {
        applyRemotePersistence(message.value);
      }
      rememberSequence(message.senderGeneration, message.sequence);
    } catch {}
  };
  if (rawChannel !== null) listen(rawChannel, "message", receiveBroadcast);
  listen(window, "storage", (event) => {
    try {
      if (event.key === data.selectedKey) {
        if (event.newValue === data.nativeSel) clearTheme(false, false);
        else if (event.newValue === data.customId) {
          const custom = currentCustom ?? loadCustom();
          if (custom) applyCustomTheme(custom, false, false);
        } else if (themes.some((theme) => theme.id === event.newValue)) {
          setTheme(event.newValue, false, false);
        }
      } else if (event.key === data.hiddenKey && (event.newValue === "1" || event.newValue === null)) {
        setHidden(event.newValue === "1", false, false);
      } else if (
        event.key === data.readabilityKey
        && (event.newValue === "0" || event.newValue === "1" || event.newValue === null)
      ) {
        setReadability(event.newValue !== "0", false, false);
      }
    } catch {}
  });

  listen(button, "click", () => {
    assertCurrent();
    if (hidden) { setHidden(false); return; }
    setPanelOpen(backdrop.hidden);
  });

  root.append(button, backdrop, picker);
  document.body.appendChild(root);
  // 自动补针优先恢复本地可验证选择；后台状态可能因静默保存尚未完成而暂时落后。
  const restore = () => {
    if (data.preferStored) {
      const sel = readSelected();
      if (sel === data.customId && data.activeId === null) {
        const custom = currentCustom ?? loadCustom();
        if (custom) { applyCustomTheme(custom, false, false); return; }
      }
      if (sel === data.nativeSel || themes.some((theme) => theme.id === sel)) {
        if (sel === data.nativeSel) clearTheme(false, false);
        else setTheme(sel, false, false);
        return;
      }
    }
    if (data.activeId !== null) setTheme(data.activeId, true, false);
    else clearTheme(true, false);
  };
  restore();
  if (readHidden()) setHidden(true, false, false);
  // reinject 会销毁弹窗；若切换主题过程中被误修复，恢复打开态，避免「还没切完就关了」。
  else if (readPanelOpen()) setPanelOpen(true);

  // 供脚本化调用与测试：window.__heigeCodexSkin.importFromDataUrl(dataUrl, name)
  statusSnapshot = () => {
    assertCurrent();
    const themeId = document.documentElement.dataset.heigeCodexSkin ?? null;
    const persistence = getPersistenceState();
    return {
      generation,
      themeId,
      menu: root.isConnected,
      mode: themeId === null ? "native" : "active",
      persistenceEnabled: persistence?.persistenceEnabled ?? false,
      revision: persistence?.revision ?? 0,
      themeTransitionPending: themePending === true ||
        controlRequest?.action === "publish-user-theme" ||
        controlRequest?.action === "delete-user-theme",
      controlRequest: controlRequest === null ? null : { ...controlRequest },
    };
  };
  window.__heigeCodexSkin = {
    generation,
    importFromDataUrl,
    setTheme,
    clearTheme,
    deleteCustom,
    setHidden,
    setReadability,
    getPersistenceState,
  };
  return true;
})()`;
}
