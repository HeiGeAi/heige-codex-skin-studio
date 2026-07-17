export const THEME_CENTER_STYLE = String.raw`
#heige-codex-skin-menu {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  pointer-events: none;
  color: #17344f;
  font: 500 13px/1.4 ui-rounded, "SF Pro Rounded", system-ui, sans-serif;
  user-select: none;
  -webkit-app-region: no-drag;
}
#heige-codex-skin-menu [hidden] { display: none !important; }
#heige-codex-skin-menu button { font: inherit; }
#heige-codex-skin-menu button:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--heige-accent, #19c9e5) 78%, #17344f);
  outline-offset: 2px;
}
[data-heige-role="menu-trigger"] {
  pointer-events: auto;
  position: fixed;
  top: 9px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 30px;
  height: 30px;
  padding: 0 10px 0 5px;
  border: 1px solid color-mix(in srgb, var(--heige-accent, #19c9e5) 25%, transparent);
  border-radius: 999px;
  background: rgba(255,255,255,.78);
  box-shadow: 0 6px 22px rgba(26,111,126,.16);
  backdrop-filter: blur(18px) saturate(1.06);
  color: #17344f;
  cursor: pointer;
  -webkit-app-region: no-drag;
}
[data-heige-role="menu-trigger"]:hover {
  border-color: color-mix(in srgb, var(--heige-accent, #19c9e5) 52%, transparent);
  box-shadow: 0 8px 26px rgba(26,111,126,.21);
}
[data-heige-role="menu-trigger"][data-hidden="true"] {
  display: block;
  border: 0;
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
  width: min(70vw,1100px);
  min-width: min(760px,calc(100vw - 32px));
  height: min(760px,calc(100vh - 72px));
  display: grid;
  grid-template-rows: 76px minmax(0,1fr) 58px;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,.82);
  border-radius: 26px;
  background:
    radial-gradient(circle at 94% 0,rgba(23,206,210,.15),transparent 29%),
    radial-gradient(circle at 2% 100%,rgba(238,108,187,.11),transparent 28%),
    rgba(246,251,251,.9);
  box-shadow: 0 30px 80px rgba(27,76,97,.25);
  backdrop-filter: blur(32px) saturate(1.08);
}
[data-heige-role="theme-center-header"],
[data-heige-role="theme-center-footer"] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 0 24px;
  background: rgba(248,252,255,.64);
}
[data-heige-role="theme-center-header"] {
  border-bottom: 1px solid rgba(23,77,102,.1);
}
[data-heige-role="theme-center-footer"] {
  position: relative;
  border-top: 1px solid rgba(23,77,102,.1);
}
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
  margin: 10px 0 20px;
}
[data-heige-role="appearance-help"] {
  margin: 10px 0 0;
  padding: 9px 12px;
  border: 1px solid rgba(25,122,139,.12);
  border-radius: 12px;
  background: rgba(255,255,255,.48);
  color: rgba(23,52,79,.7);
  font-size: 10px;
  line-height: 1.55;
}
[data-heige-role="theme-grid"] {
  display: grid;
  grid-template-columns:repeat(3,minmax(0,1fr));
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
[data-heige-role="native-option"],
[data-heige-role="upload-trigger"] {
  justify-content: flex-start;
  padding: 11px 14px !important;
  box-shadow: 0 8px 20px rgba(33,128,142,.07);
}
[data-heige-role="native-option"]:hover,
[data-heige-role="upload-trigger"]:hover,
[data-heige-role="theme-option"]:hover {
  border-color: color-mix(in srgb, var(--heige-accent, #19c9e5) 42%, transparent);
  background: rgba(255,255,255,.86);
}
[data-heige-role="theme-option"] {
  display: grid;
  grid-template-columns: 92px minmax(0,1fr) 20px;
  gap: 10px;
  padding: 7px;
  text-align: left;
  box-shadow: 0 8px 18px rgba(33,128,142,.055);
}
[data-heige-role="theme-option"][aria-pressed="true"] {
  border-color: #13b7bd;
  box-shadow: 0 0 0 3px rgba(237,110,193,.16),0 10px 24px rgba(33,128,142,.12);
}
[data-heige-role="theme-preview"] {
  width: 92px;
  height: 62px;
  border-radius: 11px;
  background-position: center;
  background-size: cover;
  box-shadow: inset 0 0 0 1px rgba(255,255,255,.24);
}
[data-heige-role="theme-check"] {
  align-self: center;
  display: grid;
  place-items: center;
  width: 19px;
  height: 19px;
  border-radius: 50%;
  background: #13aeb6;
  color: #fff;
  font-size: 11px;
  box-shadow: 0 4px 10px rgba(19,174,182,.24);
}
[data-heige-role="custom-theme-grid"] [data-heige-role="theme-option"] {
  max-width: 350px;
}
[data-heige-role="custom-delete"] {
  border: 1px solid rgba(113,58,49,.12) !important;
  background: rgba(255,255,255,.6) !important;
}
[data-heige-role="persistence-section"] {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
}
[data-heige-role="persistence-helper"] {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
[data-heige-role="persistence-confirmation"],
[data-heige-role="persistence-alert"] {
  position: absolute;
  right: 24px;
  bottom: 68px;
  z-index: 2;
  width: min(360px,calc(100vw - 48px));
  box-shadow: 0 16px 42px rgba(27,76,97,.22);
}
[data-heige-role="hide-trigger"] {
  flex: none;
  width: auto !important;
  min-height: 34px !important;
  padding: 6px 10px !important;
  border: 1px solid rgba(23,77,102,.1) !important;
  border-radius: 10px;
  background: rgba(255,255,255,.54);
}
[data-heige-role="hide-trigger"] span:first-child {
  display: none;
}
[data-heige-role="save-state"] {
  border-radius: 999px;
  padding: 6px 9px;
  font-size: 11px;
  font-weight: 750;
}
[data-heige-role="save-state"][data-state="saved"] {
  background: rgba(17,173,171,.1);
  color: #087875;
}
[data-heige-role="save-state"][data-state="saving"] {
  background: rgba(224,170,62,.12);
  color: #7a5a12;
}
[data-heige-role="save-state"][data-state="error"] {
  background: rgba(187,72,50,.1);
  color: #713a31;
}
@media (max-width:979px) {
  [data-heige-role="theme-center"] { width: calc(100vw - 32px); min-width: 0; }
  [data-heige-role="theme-grid"] { grid-template-columns: repeat(2,minmax(0,1fr)); }
}
@media (max-width:679px) {
  [data-heige-role="theme-center-backdrop"] { padding: 42px 8px 8px; }
  [data-heige-role="theme-center"] { width: 100%; min-width: 0; height: 100%; border-radius: 18px; }
  [data-heige-role="theme-grid"],
  [data-heige-role="quick-actions"] { grid-template-columns: 1fr; }
  [data-heige-role="theme-center-header"],
  [data-heige-role="theme-center-footer"] { padding-right: 14px; padding-left: 14px; }
  [data-heige-role="theme-center-scroll"] { padding: 14px; }
  [data-heige-role="hide-trigger"] span:last-child { font-size: 0; }
  [data-heige-role="hide-trigger"] span:last-child::after { content: "隐藏入口"; font-size: 11px; }
}
`;
