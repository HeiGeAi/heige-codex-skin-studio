import { HEX_COLOR } from "./constants.mjs";

const DEFAULT_COLORS = {
  accent: "#24c9d7",
  secondary: "#ef8fd3",
  surface: "#f7fbff",
  text: "#17344f",
};

function color(value, fallback) {
  const result = value ?? fallback;
  if (!HEX_COLOR.test(result)) throw new Error(`无效主题颜色：${result}`);
  return result;
}

const DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i;

// WorkBuddy 的设计令牌分三层：--cb-* 是语义层（组件直接读），
// --cb-vscode-* 是 VS Code 主题桥接层（语义层的一部分回退到它），
// --wb-* 是新版结构层（真机 5.3.11 上共 912 个，侧栏、卡片、浮层的底色都读它，
// 而且写成 var(--wb-x, var(--cb-x, …)) 的回退链，只改 --cb-* 压不住它）。
// 换肤只改这三层，不碰任何哈希类名（如 _gridViewItem_1ens7_14 每次构建都会变）。
const surfaceMix = (percent) =>
  `color-mix(in srgb, var(--heige-surface) ${percent}%, transparent)`;
const accentMix = (percent) =>
  `color-mix(in srgb, var(--heige-accent) ${percent}%, transparent)`;
const textMix = (percent) =>
  `color-mix(in srgb, var(--heige-text) ${percent}%, transparent)`;

export function buildWorkBuddySkinCss({
  theme,
  heroDataUrl,
  logoDataUrl = null,
  polaroidDataUrl = null,
}) {
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
  const appearance = theme.appearance === "dark" ? "dark" : "light";
  const id = String(theme.id ?? "custom").replace(/[^a-z0-9_-]/gi, "");

  return `/* HEIGE_WORKBUDDY_SKIN:${id} */
/* 令牌必须同时写在 :root 和 body 上。WorkBuddy 的主题文件用的选择器是
   \`:root, body[data-vscode-theme-name="IDE Light"]\`，等于把整套令牌在 body 上又声明了一遍。
   只写 :root 的话，html 那一层是被改了，但 body 自己的声明会盖掉继承下来的值，
   body 以下（也就是整个界面）读到的还是原生浅色。真机 5.3.11 上定位到的 */
:root,
body {
  color-scheme: ${appearance} !important;
  --heige-accent: ${colors.accent};
  --heige-secondary: ${colors.secondary};
  --heige-surface: ${colors.surface};
  --heige-text: ${colors.text};
  /* 强调色上的文字统一用主题底色，浅色主题得到浅字、深色主题得到深字，无需分支 */
  --heige-on-accent: var(--heige-surface);
  --heige-veil: ${surfaceMix(88)};
  --heige-veil-soft: ${surfaceMix(70)};
  /* 浮层专用，完全不透明。设置弹层、对话框、下拉、右键菜单一旦透光，
     底下的对话正文就印上来跟浮层文字叠在一起，没法读。
     半透明只留给对话区自己，浮层一律实底 */
  --heige-solid: var(--heige-surface);
  --heige-line: ${accentMix(32)};
  --heige-line-soft: ${accentMix(18)};

  /* VS Code 桥接层 */
  --cb-vscode-editor-background: transparent !important;
  --cb-vscode-sideBar-background: transparent !important;
  --cb-vscode-titleBar-activeBackground: transparent !important;
  --cb-vscode-titleBar-inactiveBackground: transparent !important;
  --cb-vscode-editor-foreground: var(--heige-text) !important;
  --cb-vscode-foreground: var(--heige-text) !important;
  --cb-vscode-titleBar-activeForeground: var(--heige-text) !important;
  --cb-vscode-titleBar-inactiveForeground: ${textMix(62)} !important;
  --cb-vscode-descriptionForeground: ${textMix(62)} !important;
  --cb-vscode-button-background: var(--heige-accent) !important;
  --cb-vscode-button-foreground: var(--heige-on-accent) !important;
  --cb-vscode-button-hoverBackground: ${accentMix(82)} !important;
  --cb-vscode-button-secondaryBackground: var(--heige-veil-soft) !important;
  --cb-vscode-button-secondaryForeground: var(--heige-text) !important;
  --cb-vscode-button-secondaryHoverBackground: ${accentMix(20)} !important;
  --cb-vscode-input-background: ${surfaceMix(78)} !important;
  --cb-vscode-dropdown-background: var(--heige-solid) !important;
  --cb-vscode-panel-border: var(--heige-line) !important;
  --cb-vscode-widget-border: var(--heige-line) !important;
  --cb-vscode-widget-shadow: ${accentMix(16)} !important;
  --cb-vscode-menu-foreground: var(--heige-text) !important;
  --cb-vscode-menu-border: var(--heige-line) !important;
  --cb-vscode-menu-separatorBackground: var(--heige-line-soft) !important;
  --cb-vscode-list-hoverBackground: ${accentMix(15)} !important;
  --cb-vscode-list-activeSelectionForeground: var(--heige-text) !important;
  --cb-vscode-list-inactiveForeground: ${textMix(62)} !important;
  --cb-vscode-list-inactiveSelectionBackground: ${accentMix(16)} !important;
  --cb-vscode-quickInputList-focusBackground: ${accentMix(22)} !important;
  --cb-vscode-toolbar-hoverBackground: ${accentMix(15)} !important;
  --cb-vscode-scrollbarSlider-background: ${accentMix(32)} !important;

  /* 文字与图标 */
  --cb-text-primary: var(--heige-text) !important;
  --cb-text-primary-strong: var(--heige-text) !important;
  --cb-text-solid: var(--heige-text) !important;
  --cb-text-secondary: ${textMix(74)} !important;
  --cb-text-secondary-strong: ${textMix(84)} !important;
  --cb-text-color-secondary: ${textMix(74)} !important;
  /* 次级文字的透明度整体抬高：原生底是纯白，皮肤底是照片，
     46% 的灰在原生上还能读，压到花背景上就糊了。真机核对过 v5.3.11 侧栏 */
  --cb-text-tertiary: ${textMix(70)} !important;
  --cb-text-tertiary-strong: ${textMix(78)} !important;
  --cb-text-quaternary: ${textMix(62)} !important;
  --cb-text-muted: ${textMix(62)} !important;
  --cb-text-desc: ${textMix(72)} !important;
  --cb-text-placeholder: ${textMix(64)} !important;
  --cb-text-disabled: ${textMix(48)} !important;
  --cb-text-link: var(--heige-accent) !important;
  --cb-text-link-hover: ${accentMix(84)} !important;
  --cb-text-highlight: var(--heige-accent) !important;
  --cb-link-foreground: var(--heige-accent) !important;
  --cb-icon-foreground: ${textMix(78)} !important;
  --cb-icon-button-color: ${textMix(78)} !important;
  --cb-icon-button-hover-background: ${accentMix(16)} !important;
  --cb-sidebar-text: var(--heige-text) !important;
  --cb-sidebar-text-secondary: ${textMix(80)} !important;
  --cb-sidebar-text-muted: ${textMix(64)} !important;

  /* 面板与卡片 */
  --cb-bg-primary: transparent !important;
  --cb-bg-primary-default: transparent !important;
  --cb-bg-primary-hover: ${accentMix(12)} !important;
  --cb-bg-primary-active: ${accentMix(18)} !important;
  --cb-bg-secondary: var(--heige-veil-soft) !important;
  --cb-bg-tertiary: var(--heige-veil-soft) !important;
  --cb-bg-surface: var(--heige-veil) !important;
  --cb-bg-surface-hover: ${accentMix(14)} !important;
  --cb-bg-surface-active: ${accentMix(20)} !important;
  --cb-bg-card: var(--heige-veil) !important;
  --cb-bg-elevated: var(--heige-solid) !important;
  --cb-bg-overlay: var(--heige-solid) !important;
  --cb-bg-color-container: var(--heige-veil-soft) !important;
  --cb-card-background: var(--heige-veil) !important;
  --cb-hover-card-bg-color: var(--heige-solid) !important;
  --cb-panel-bg-primary: var(--heige-veil) !important;
  --cb-panel-bg-secondary: var(--heige-veil-soft) !important;
  --cb-overlay-background: var(--heige-solid) !important;
  --cb-hover-bg: ${accentMix(12)} !important;
  --cb-hover-bg-fc: ${accentMix(12)} !important;

  /* 侧栏 */
  --cb-sidebar-background: transparent !important;
  --cb-sidebar-bg: transparent !important;
  --cb-sidebar-surface: ${surfaceMix(60)} !important;
  --cb-sidebar-surface-hover: ${accentMix(14)} !important;
  --cb-sidebar-item-hover-background: ${accentMix(14)} !important;
  --cb-sidebar-active: ${accentMix(24)} !important;
  --cb-sidebar-search-bg: ${surfaceMix(72)} !important;

  /* 列表 */
  --cb-list-item-bg: transparent !important;
  --cb-list-item-hover-bg: ${accentMix(14)} !important;
  --cb-list-item-active-bg: ${accentMix(22)} !important;
  --cb-list-item-selected-bg: ${accentMix(22)} !important;
  --cb-list-item-foreground: var(--heige-text) !important;
  --cb-list-item-selected-foreground: var(--heige-text) !important;
  --cb-list-activeSelectionBackground: ${accentMix(22)} !important;
  --cb-list-focusBackground: ${accentMix(22)} !important;

  /* 浮层：可读性优先，底色比常规表面更实 */
  --cb-popover-background: var(--heige-solid) !important;
  --cb-popover-background-fc: var(--heige-solid) !important;
  --cb-popover-bg: var(--heige-solid) !important;
  --cb-popover-bg-fc: var(--heige-solid) !important;
  --cb-popover-bg-color: var(--heige-solid) !important;
  --cb-popover-bg-color-fc: var(--heige-solid) !important;
  --cb-popover-active-background: ${accentMix(20)} !important;
  --cb-popover-border: var(--heige-line) !important;
  --cb-popover-border-fc: var(--heige-line) !important;
  --cb-popover-divider: var(--heige-line-soft) !important;
  --cb-popover-divider-fc: var(--heige-line-soft) !important;
  --cb-popover-secondary: ${textMix(70)} !important;
  --cb-dialog-bg: var(--heige-solid) !important;
  --cb-dialog-content-bg: var(--heige-solid) !important;
  --cb-dialog-title-color: var(--heige-text) !important;
  --cb-dialog-hint-color: ${textMix(64)} !important;
  --cb-dialog-close-color: ${textMix(70)} !important;
  --cb-dialog-close-hover-bg: ${accentMix(18)} !important;
  --cb-dialog-btn-primary-bg: var(--heige-accent) !important;
  --cb-dialog-btn-primary-text: var(--heige-on-accent) !important;
  --cb-dialog-btn-secondary-bg: var(--heige-veil-soft) !important;
  --cb-dialog-btn-secondary-text: var(--heige-text) !important;
  --cb-dialog-btn-secondary-hover-bg: ${accentMix(18)} !important;
  --cb-tooltip-bg: ${textMix(90)} !important;
  --cb-tooltip-text-color: var(--heige-surface) !important;
  --cb-tooltip-arrow-color: ${textMix(90)} !important;

  /* 按钮、开关、标签 */
  --cb-accent: var(--heige-accent) !important;
  --cb-accent-hover: ${accentMix(84)} !important;
  --cb-button-primary: var(--heige-accent) !important;
  --cb-button-primary-foreground: var(--heige-on-accent) !important;
  --cb-button-foreground: var(--heige-text) !important;
  --cb-button-secondary-background: var(--heige-veil-soft) !important;
  --cb-button-secondary-foreground: var(--heige-text) !important;
  --cb-button-secondary-hover-background: ${accentMix(18)} !important;
  --cb-button-ghost-hover-background: ${accentMix(14)} !important;
  --cb-button-grey-bg: var(--heige-veil-soft) !important;
  --cb-button-grey-fg: var(--heige-text) !important;
  --cb-button-dark-background: var(--heige-accent) !important;
  --cb-button-dark-foreground: var(--heige-on-accent) !important;
  --cb-button-dark-hover-background: ${accentMix(84)} !important;
  --cb-switch-bg: ${textMix(24)} !important;
  --cb-switch-active-bg: var(--heige-accent) !important;
  --cb-tag-background: ${accentMix(16)} !important;
  --cb-tag-selected-background: ${accentMix(26)} !important;
  --cb-tag-selected-text: var(--heige-text) !important;
  --cb-tag-skill-background: ${accentMix(16)} !important;
  --cb-tag-skill-background-hover: ${accentMix(24)} !important;
  --cb-tab-background: transparent !important;
  --cb-tab-header-background: transparent !important;
  --cb-tab-foreground: ${textMix(70)} !important;
  --cb-tab-active-background: ${accentMix(18)} !important;
  --cb-tab-active-foreground: var(--heige-text) !important;
  --cb-tab-active-border: var(--heige-accent) !important;
  --cb-tab-border: var(--heige-line-soft) !important;
  --cb-tab-header-border: var(--heige-line-soft) !important;
  --cb-tab-hover-background: ${accentMix(12)} !important;

  /* 输入区 */
  --cb-input-background: ${surfaceMix(78)} !important;
  --cb-input-foreground: var(--heige-text) !important;
  --cb-input-placeholder: ${textMix(48)} !important;
  --cb-input-border-color: var(--heige-line) !important;
  --cb-input-focus-border-color: var(--heige-accent) !important;
  --cb-input-active-border: var(--heige-accent) !important;
  --cb-input-button-foreground: var(--heige-on-accent) !important;
  --cb-input-button-background: var(--heige-accent) !important;

  /* 描边、滚动条、阴影 */
  --cb-border: var(--heige-line-soft) !important;
  --cb-border-color: var(--heige-line) !important;
  --cb-border-default: var(--heige-line) !important;
  --cb-border-subtle: var(--heige-line-soft) !important;
  --cb-border-secondary: var(--heige-line-soft) !important;
  --cb-border-strong: ${accentMix(52)} !important;
  --cb-border-bright: ${accentMix(52)} !important;
  --cb-border-color-emphasis: ${accentMix(52)} !important;
  --cb-panel-border-color: var(--heige-line) !important;
  --cb-scrollbar-thumb: ${accentMix(34)} !important;
  --cb-scrollbar-thumb-hover: ${accentMix(56)} !important;
  --cb-shadow: 0 6px 18px ${accentMix(12)} !important;
  --cb-shadow-lg: 0 14px 34px ${accentMix(16)} !important;
  --cb-shadow-popover: 0 14px 34px ${accentMix(16)} !important;
  --cb-shadow-popover-fc: 0 14px 34px ${accentMix(16)} !important;

  /* ---- --wb-* 结构层 ---- */
  /* 只接管「结构色」：表面、文字、描边、滚动条。
     品牌色（--wb-bg-connector-*、--wb-text-enterprise）和状态色
     （error / success / warning）一律不动，它们的语义跟主题无关，改了反而认不出。
     配对原则：凡是改了某处文字色，同一处的底色必须一起改，否则会做出
     浅底浅字。所以对比双方不都归我管的令牌（--wb-bg-tooltip 配死的
     --wb-text-white、--wb-bg-pill-active、模态遮罩 --wb-bg-overlay）保持原样，
     它们本来就是黑底白字，深浅两种主题下都读得清。 */

  /* 结构表面：主区域透明放行 hero 图，卡片和浮层用主题面纱 */
  --wb-bg-app: transparent !important;
  --wb-bg-primary: transparent !important;
  --wb-bg-content: transparent !important;
  --wb-bg-secondary: var(--heige-veil-soft) !important;
  --wb-bg-tertiary: var(--heige-veil-soft) !important;
  --wb-bg-inset-strong: var(--heige-veil-soft) !important;
  --wb-bg-card: var(--heige-veil) !important;
  --wb-bg-card-strong: var(--heige-solid) !important;
  --wb-bg-card-hover: ${accentMix(14)} !important;
  --wb-bg-elevated: var(--heige-solid) !important;
  --wb-bg-modal: var(--heige-solid) !important;
  --wb-bg-popover: var(--heige-solid) !important;
  --wb-bg-popover-picker: var(--heige-solid) !important;
  --wb-bg-scrim-light: ${surfaceMix(80)} !important;
  --wb-bg-hover: ${accentMix(12)} !important;
  --wb-bg-hover-light: ${accentMix(12)} !important;
  --wb-bg-active: ${accentMix(18)} !important;
  --wb-bg-active-hover: ${accentMix(22)} !important;
  --wb-bg-pill-hover: ${accentMix(12)} !important;
  --wb-bg-tab-active: ${accentMix(18)} !important;
  --wb-bg-item-selected: ${accentMix(22)} !important;
  --wb-bg-row-selected: ${accentMix(22)} !important;
  --wb-bg-surface-overlay-soft: ${accentMix(8)} !important;
  --wb-bg-surface-overlay-strong: ${accentMix(16)} !important;
  --wb-bg-input-inset: transparent !important;
  --wb-bg-input-slot-gradient: linear-gradient(180deg, ${surfaceMix(72)} 0%, ${surfaceMix(84)} 100%) !important;
  /* 反色块是自洽的一对：底给文字色、字给底色，两种主题都天然拉开对比 */
  --wb-bg-inverse: var(--heige-text) !important;
  --wb-text-inverse: var(--heige-surface) !important;
  --wb-text-on-inverse: var(--heige-surface) !important;
  --wb-text-on-primary: var(--heige-on-accent) !important;

  /* 侧栏：--wb-sidebar-bg 是那条 !important 高特异性规则的取值来源
     （.conversation-section-content [class^="collapsible-section"] > [class*="header"]），
     跟它拼选择器权重赢不了，直接把它读的变量改掉才是正解。
     透明是因为外层 .conversation-sidebar 已经铺了主题底 */
  --wb-sidebar-bg: transparent !important;
  --wb-sidebar-border: var(--heige-line) !important;
  --wb-sidebar-mask-end: ${surfaceMix(90)} !important;

  /* 主区域画布 */
  --wb-main-area-background: transparent !important;
  --wb-main-area-border-color: var(--heige-line) !important;
  --wb-main-area-box-shadow: 0 12px 24px -8px ${accentMix(10)}, 0 2px 4px -4px ${accentMix(10)} !important;

  /* 结构文字 */
  --wb-text-primary: var(--heige-text) !important;
  --wb-text-strong: var(--heige-text) !important;
  --wb-text-secondary: ${textMix(74)} !important;
  --wb-text-medium: ${textMix(74)} !important;
  --wb-text-tertiary: ${textMix(70)} !important;
  --wb-text-author: ${textMix(70)} !important;
  --wb-text-weak: ${textMix(64)} !important;
  --wb-text-faded: ${textMix(58)} !important;
  --wb-text-muted: ${textMix(58)} !important;
  --wb-text-placeholder-soft: ${textMix(56)} !important;
  --wb-text-version-badge: ${textMix(46)} !important;
  --wb-text-disable: ${textMix(44)} !important;
  --wb-text-link: var(--heige-accent) !important;
  --wb-text-link-default: var(--heige-accent) !important;
  --wb-text-action: var(--heige-accent) !important;

  /* 结构描边 */
  --wb-border: var(--heige-line-soft) !important;
  --wb-border-default: var(--heige-line) !important;
  --wb-border-secondary: var(--heige-line-soft) !important;
  --wb-border-light-alt: var(--heige-line-soft) !important;
  --wb-border-weak: var(--heige-line-soft) !important;
  --wb-border-faint: var(--heige-line-soft) !important;
  --wb-border-subtle: var(--heige-line-soft) !important;
  --wb-border-subtle-soft: var(--heige-line-soft) !important;
  --wb-border-mask: var(--heige-line-soft) !important;
  --wb-border-card: var(--heige-line-soft) !important;
  --wb-border-card-static: var(--heige-line-soft) !important;
  --wb-border-control: var(--heige-line) !important;
  --wb-border-input: var(--heige-line) !important;
  --wb-border-popover: var(--heige-line) !important;
  --wb-border-tooltip: var(--heige-line) !important;
  --wb-border-strong: ${accentMix(52)} !important;
  --wb-border-popover-strong: ${accentMix(40)} !important;
  --wb-border-hover: ${accentMix(40)} !important;
  --wb-border-selected: ${accentMix(52)} !important;
  --wb-border-focus: var(--heige-accent) !important;
  --wb-border-action: var(--heige-accent) !important;
  --wb-border-drag-indicator: var(--heige-accent) !important;

  /* 滚动条与阴影 */
  --wb-scrollbar-thumb: ${accentMix(34)} !important;
  --wb-scrollbar-thumb-bg: ${accentMix(22)} !important;
  --wb-scrollbar-thumb-hover: ${accentMix(56)} !important;
  --wb-shadow-card: 0 1px 2px ${accentMix(8)} !important;
  --wb-shadow-card-hover: 0 8px 20px ${accentMix(16)} !important;
  --wb-shadow-card-soft: 0 16px 32px -8px ${accentMix(8)} !important;
  --wb-shadow-dialog: 0 8px 48px ${accentMix(14)}, 0 6px 12px ${accentMix(8)} !important;
  --wb-shadow-dialog-md: 0 8px 24px ${accentMix(12)} !important;
  --wb-shadow-dropdown: 0 6px 24px ${accentMix(10)}, 0 4px 6px ${accentMix(8)} !important;
  --wb-shadow-popover: 0 4px 12px -4px ${accentMix(10)}, 0 3px 6px -8px ${accentMix(8)} !important;
  --wb-shadow-sm: 0 1px 2px ${accentMix(10)} !important;
  --wb-shadow-md: 0 2px 8px ${accentMix(14)} !important;
  --wb-shadow-lg: 0 4px 16px ${accentMix(18)} !important;
}

html,
body {
  background: transparent !important;
  color: var(--heige-text) !important;
}

#root {
  color: var(--heige-text) !important;
  background:
    linear-gradient(90deg, ${surfaceMix(94)} 0 20%, transparent 46%),
    linear-gradient(180deg, transparent 0 42%, ${surfaceMix(76)} 82% 100%),
    /* 不用 fixed 背景附着：流式输出/滚动时会强制整视口逐帧重绘 */
    url(${JSON.stringify(heroDataUrl)}) right center / cover no-repeat !important;
}

/* 栅格容器的类名带构建哈希，只能按稳定的 data-view-id 打 */
#root [data-view-id] {
  background: transparent !important;
}

.teams-container,
.teams-content-wrapper,
.teams-main-content,
.main-content,
.chat-container,
.workbuddy-topbar,
.wb-home-page,
.wb-home-page__main-content,
.conversation-list-topbar,
.conversation-list-header,
.conversation-list-content,
.conversation-list-footer {
  background: transparent !important;
  /* 常驻表面覆盖动态背景，禁用背景采样以避免滚动和流式输出逐帧重合成 */
  backdrop-filter: none !important;
}

.conversation-sidebar,
.conversation-list {
  background: ${surfaceMix(90)} !important;
  border-right: 1px solid var(--heige-line) !important;
  backdrop-filter: none !important;
}

/* 浮层自己不画底，靠的是页面底色本来是纯白。皮肤把页面底改成透明好让主题图透出来，
   这些浮层就跟着一起透了：设置弹层背后的对话正文直接印在设置文字上，两层字叠着没法读。
   上面那批 --wb-bg-modal / --cb-popover-bg 令牌已经改成实底，覆盖的是「读令牌」的那批浮层；
   这里补的是「什么底都不读」的那批，只能按稳定类名把实底显式钉上去。
   遮罩层（*-overlay、*-mask）不在这份名单里：它本来就该是半透明的黑纱，
   改成不透明整个界面会全黑。真机核对自 WorkBuddy 5.3.11 */
.settings-modal,
.settings-modal__nav,
.user-menu-popover,
.account-panel,
.wb-modal,
.wb-drawer,
.wb-popover,
.wb-shadow-popover,
.wb-dropdown,
.wb-kb-dialog,
.wb-todo-menu,
.cb-dialog,
.cb-popover,
.cb-dropdown,
.cb-context-menu,
.cb-add-marketplace-modal,
.cb-plugin-detail-dropdown,
.context-menu,
.dropdown-menu,
.base-menu,
.memory-modal,
.connector-detail-modal,
.connector-auth-modal,
.connector-device-code-modal,
.bind-channel-modal,
.share-task-dialog,
.skill-scan-result-dialog,
.skill-card-menu,
.task-transfer-popover,
.task-list-popover,
.sidebar-next-overview-popover,
.my-files-context-menu,
.my-files-filter-menu,
.notification-ctx-menu,
.notification-action-menu,
.welcome-screen-menu,
.project-connectors-drawer {
  background: var(--heige-solid) !important;
  /* 常驻表面覆盖动态背景，禁用背景采样以避免滚动和流式输出逐帧重合成 */
  backdrop-filter: none !important;
}

/* 上面那份名单是逐个真机核过的。名单之外还有一大类「面板自带的小对话框」，
   比如模型设置里的添加模型框 .models-settings-panel__editor，挨个列既列不全，
   又容易被 .menu、.modal、.delete 这种同名普通元素误伤。
   这里按 WorkBuddy 自己的命名规律兜底：模态遮罩统一叫 *-modal-overlay、*__overlay、
   *-editor-overlay、*-dialog-overlay、*-confirm-overlay，遮罩的直接子节点就是那块面板。
   用 [class$=] 收尾匹配而不是 [class*=] 包含匹配，是为了避开 *-loading-overlay、
   *-stencil-overlay、*-startup-overlay 这些同样带 overlay 但不是模态遮罩的元素，
   它们的子节点是转圈图标和图片裁剪框，垫上实底反而糊。
   连字符和 BEM 双下划线两种写法都要列：添加模型框的遮罩叫 panel__editor-overlay，
   只写 -editor-overlay 收尾匹配会漏掉它。
   遮罩自己一律不动，保持半透明黑纱。真机核对自 WorkBuddy 5.3.11 */
[class$="__overlay"] > *,
[class$="-modal-overlay"] > *,
[class$="__modal-overlay"] > *,
[class$="-dialog-overlay"] > *,
[class$="__dialog-overlay"] > *,
[class$="-editor-overlay"] > *,
[class$="__editor-overlay"] > *,
[class$="-confirm-overlay"] > *,
[class$="__confirm-overlay"] > * {
  background: var(--heige-solid) !important;
  backdrop-filter: none !important;
}

/* 添加模型框的保存按钮把「编辑区底色」当自己的文字色使（WorkBuddy 自己的写法：
   color: var(--cb-vscode-editor-background)）。皮肤把编辑区底改成透明好让主题图透出来，
   这个按钮的字就跟着透明了，实心强调色上一个字都看不见。
   强调色上的文字本来就该走 --heige-on-accent，这里按稳定的 wb-button--primary 钉回去。
   浮层没垫实底之前这个按钮是跟整块面板一起透着的，看不出来，垫实之后才暴露。
   真机核对自 WorkBuddy 5.3.11：全量样式表里这么写的只有这一个按钮和它的 hover 态 */
.wb-button--primary,
.wb-button--primary :is(span, svg) {
  color: var(--heige-on-accent) !important;
}

/* 侧栏这几处文字在 WorkBuddy 里是写死的 rgba(0,0,0,.9)/.5，不读任何 --cb-* 令牌。
   深色主题下就是黑字压黑底，只能按稳定语义类名逐个接管。
   同一节点上并存的 _title_fpw7i_48 这类哈希类名一律不碰，构建一变就失效。
   真机核对自 WorkBuddy 5.3.11 */
.conversation-list-tab-button,
.conversation-list-tab-button > span,
.collapsible-section-label,
.user-menu-trigger-name {
  color: var(--heige-text) !important;
}

.conversation-list-tab-button-sub,
.conversation-section-label-text,
.logo-workbuddy-title,
.conversation-list-version-badge {
  color: ${textMix(66)} !important;
}

/* 这几块底色同样是写死的浅灰（#e6e6e6 / #f2f2f2）。上面刚把字改成主题色，
   底不跟着换就成了浅底浅字，比原来还难读，两处必须成对改 */
.conversation-list-tab-button.active {
  background: ${accentMix(26)} !important;
}

/* 折叠区标题（.collapsible-section-header）不在这里管：
   它的底色由上面 --wb-sidebar-bg 那条负责，写在这儿也是白写 */
.conversation-section-label {
  background: ${accentMix(12)} !important;
}

/* AI 回复原生没有任何底色，正文颜色写死 rgb(0,0,0)，整段直接压在主题背景图上。
   浅色图勉强能读，深色图和高饱和图上就糊成一片。这和 Codex 侧是同一类问题，
   解法也照搬 Codex：阅读增强开着时，给整条回复垫一层主题色蒙版并接管文字色。
   钩子取稳定的 cb-assistant-message，同节点并存的 _assistantMessage_7jxnj_178 不碰。
   消息列表是 virtuoso 虚拟滚动，条目高度由 ResizeObserver 重测，改内边距不会错位。
   真机核对自 WorkBuddy 5.3.11 */
:root[data-heige-readability="on"] .cb-assistant-message {
  box-sizing: border-box;
  color: var(--heige-text) !important;
  background: ${surfaceMix(90)} !important;
  border: 1px solid ${accentMix(18)} !important;
  border-radius: 22px;
  /* 原生左右内边距就是 24px，跟着保留；只补垂直方向，蒙版才不会贴着字 */
  padding: 14px 24px 12px !important;
  /* 常驻表面覆盖动态背景，禁用背景采样以避免流式输出逐帧重合成 */
  backdrop-filter: none !important;
}

/* 回复里的引用块、行内代码和分隔线原生也吃写死的浅色，垫上蒙版后要跟着换成主题色，
   否则深色主题下是浅块压深蒙版，比不垫还刺眼 */
:root[data-heige-readability="on"] .cb-assistant-message .cb-markdown :is(pre, code, blockquote) {
  background: ${accentMix(10)} !important;
  color: var(--heige-text) !important;
}

/* 正文和底部那排图标、消耗计数、时间的颜色也写死在各自节点上（rgb(0,0,0) 和
   rgba(0,0,0,.7)），不继承外层容器。只垫蒙版不接管这两处，深色主题下就是黑字压
   深色蒙版，比不垫更糊。所以这里和侧栏、输入区一样不挂阅读增强开关：颜色写死是
   WorkBuddy 自己的毛病，关掉蒙版也一样要治。
   正文按稳定的 cb-markdown 打；图标按钮没有稳定类名，用元素选择器限定在回复内部，
   构建改名也不受影响；哈希类名一律不碰。真机核对自 WorkBuddy 5.3.11 */
.cb-assistant-message .cb-markdown,
.cb-assistant-message .cb-markdown :is(p, li, td, th, h1, h2, h3, h4, h5, h6) {
  color: var(--heige-text) !important;
}

.cb-assistant-message .cb-credit-usage-text,
.cb-assistant-message .cb-message-time-tip,
.cb-assistant-message button,
.cb-assistant-message button :is(svg, span) {
  color: ${textMix(72)} !important;
}

/* 发言人名字在蒙版外面，颜色同样写死 rgb(0,0,0)，而且它任何时候都直接压在主题
   背景图上、没有底可垫，所以换成主题色之后还要补一圈同底色光晕才拉得开对比 */
.avatar-container .name {
  color: var(--heige-text) !important;
  text-shadow:
    0 0 8px ${surfaceMix(92)},
    0 0 18px ${surfaceMix(74)};
}

/* 首页大标题压在人物脸上，靠一圈同底色光晕拉开对比，别指望背景够干净 */
.wb-home-header__title {
  color: var(--heige-text) !important;
  text-shadow:
    0 0 10px ${surfaceMix(96)},
    0 0 22px ${surfaceMix(88)},
    0 2px 30px ${surfaceMix(76)};
}

.wb-home-composer__input-slot {
  border-radius: 18px;
  box-shadow: 0 10px 28px ${accentMix(14)} !important;
}

/* 输入框正文写死 rgb(0,0,0)，深色主题下是黑字压深色底，直接看不见。
   挂钩用 Slate 自己的 data-slate-editor，不是构建哈希类名，版本升级也在。
   占位符是它的子节点，颜色继承，不用单独接管 */
[data-slate-editor="true"] {
  color: var(--heige-text) !important;
}

/* 输入区底部工具条（选择工作空间 / 默认权限）、技能胶囊、任务概览小标题，
   文字都是写死的 rgba(0,0,0,.5~.7)，不读任何令牌，深色主题下直接沉进底色。
   挂钩用稳定语义类名和 data-cb-* 属性，同节点上的 _chipLabel_12mii_44 一律不碰 */
.wb-input-footer,
.wb-input-footer button,
.wb-input-footer span,
[data-cb-chat-input-toolbar-selector] span,
.cb-overview-section__title-label {
  /* 这一排压在输入框最下沿，底下透出去的图最亮，比别处再提一档才够读 */
  color: ${textMix(80)} !important;
}

/* 快捷入口胶囊原生只有一圈描边、没有底色。原生底是纯白所以读得清，
   换成照片背景后字就糊在画面里了，补一层主题底把它托起来 */
.quick-actions__item {
  background: ${surfaceMix(92)} !important;
}

/* 快捷入口那一排横向滚动，右侧渐隐遮罩写死白色，深色主题下会糊出一道白边。
   渐变要收在同一个主题底色上，不能只改透明度 */
.quick-actions--fade-right::after,
.quick-actions--fade-left::before {
  background-image: linear-gradient(270deg, ${surfaceMix(96)} 50%, ${surfaceMix(0)} 99.99%) !important;
}

.quick-actions--fade-left::before {
  background-image: linear-gradient(90deg, ${surfaceMix(96)} 50%, ${surfaceMix(0)} 99.99%) !important;
}
${logoDataUrl === null ? "" : `
/* 侧栏产品名换品牌 Logo，原文字仅隐藏不移除，还原时不需要重建节点 */
.conversation-list-logo {
  background: url(${JSON.stringify(logoDataUrl)}) left center / contain no-repeat !important;
  height: 44px !important;
  margin-top: 2px;
}
.conversation-list-logo > * {
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
  filter: drop-shadow(0 12px 26px ${textMix(24)});
}
`}`;
}
