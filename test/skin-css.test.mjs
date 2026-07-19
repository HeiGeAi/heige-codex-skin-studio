import assert from "node:assert/strict";
import test from "node:test";

import { buildSkinCss } from "../src/skin-css.mjs";

test("builds one fast generic skin from a theme and image data URL", () => {
  const css = buildSkinCss({
    theme: {
      id: "miku-488137",
      colors: { accent: "#19c9e5", secondary: "#ed6ec1", surface: "#f5f6fc", text: "#122c60" },
      copy: { brand: "Miku Codex", headline: "一起创造吧" },
    },
    heroDataUrl: "data:image/webp;base64,AAAA",
  });

  assert.match(css, /HEIGE_CODEX_SKIN:miku-488137/);
  assert.match(css, /data:image\/webp;base64,AAAA/);
  assert.match(css, /\.app-shell-left-panel/);
  assert.match(css, /\.composer-surface-chrome/);
  assert.match(
    css,
    /\[data-local-conversation-final-assistant\],\s*\[data-response-annotation-conversation\]\s*\{[^}]*background:\s*transparent[^}]*box-shadow:\s*none/s,
  );
  assert.match(
    css,
    /:root\[data-heige-readability="on"\]\s+\[data-response-annotation-conversation\]\s*\{[^}]*var\(--heige-surface\) 90%/s,
  );
  assert.doesNotMatch(
    css,
    /:root\[data-heige-readability="on"\]\s+\[data-local-conversation-final-assistant\]\s*\{/,
  );
  assert.match(
    css,
    /:root\[data-heige-readability="on"\]\s+\[data-response-annotation-conversation\]\s*\{[^}]*box-sizing:\s*border-box[^}]*border-radius:\s*22px[^}]*padding:\s*14px 16px 12px/s,
  );
  assert.match(
    css,
    /:root\[data-heige-readability="on"\]\s+\[data-response-annotation-conversation\]\s*\{[^}]*box-shadow:\s*none[^}]*backdrop-filter:\s*none/s,
  );
  assert.doesNotMatch(
    css,
    /:root\[data-heige-readability="on"\]\s+\[data-response-annotation-conversation\]\s*\{[^}]*backdrop-filter:\s*blur/s,
  );
  assert.match(
    css,
    /\.composer-surface-chrome,[\s\S]*background:\s*color-mix\(in srgb, var\(--heige-surface\) 80%, transparent\)/,
  );
  assert.match(
    css,
    /\.composer-surface-chrome,[\s\S]*backdrop-filter:\s*blur\(8px\)/,
    "气泡/输入框模糊半径上限 8px：盖在流式内容上的大模糊是卡顿主因",
  );
  assert.doesNotMatch(
    css,
    /background-attachment:\s*fixed|no-repeat\s+fixed/,
    "皮肤背景禁用 fixed 附着：滚动/流式 relayout 会强制整视口逐帧重绘",
  );
  assert.doesNotMatch(
    css,
    /\.composer-surface-chrome,[\s\S]*\[data-local-conversation-final-assistant\],[\s\S]*var\(--heige-surface\) 88%/,
  );
  assert.match(css, /pointer-events:\s*none/);
  assert.match(
    css,
    /\[data-app-action-sidebar-thread-active="false"\]\s+svg\[class\*="pr-status-dot-color"\]\s*\{[^}]*opacity:\s*0/s,
  );
  assert.match(
    css,
    /\[data-app-action-sidebar-thread-active="false"\]:hover\s+svg\[class\*="pr-status-dot-color"\]\s*\{[^}]*opacity:\s*1/s,
  );
  assert.doesNotMatch(
    css,
    /:has\(/,
    "皮肤样式禁用 :has()，流式输出高频 DOM 变更下反向失效扫描代价过高",
  );
  assert.match(css, /--heige-native-ink:\s*#172033/);
  assert.match(
    css,
    /\[data-pip-obstacle="thread-summary-panel"\]\s+button,[\s\S]*\[data-pip-obstacle="thread-summary-panel"\]\s+\.text-fade-truncate,[\s\S]*\[data-pip-obstacle="thread-summary-panel"\]\s+\.text-token-foreground\s*\{[^}]*color:\s*var\(--heige-native-ink\)\s*!important/s,
  );
  assert.match(
    css,
    /div\.no-drag\.pointer-events-auto\s+button\.bg-token-bg-fog\s*\{[^}]*color:\s*var\(--heige-native-ink\)\s*!important/s,
  );
  assert.doesNotMatch(
    css,
    /\[data-pip-obstacle="thread-summary-panel"\]\s+\*\s*\{/,
    "原生浅色面板不得用通配规则覆盖增删统计等语义颜色",
  );
  assert.doesNotMatch(css, /https?:\/\//);
});

test("rejects invalid colors instead of emitting arbitrary CSS", () => {
  assert.throws(
    () => buildSkinCss({ theme: { id: "bad", colors: { accent: "red;display:none" } }, heroDataUrl: "data:image/png;base64,AA" }),
    /颜色/,
  );
});

test("rejects 5 and 7 digit hex colors that CSS cannot parse", () => {
  const hero = "data:image/png;base64,iVBORw0KGgo=";
  for (const bad of ["#12345", "#1234567"]) {
    assert.throws(
      () => buildSkinCss({ theme: { id: "t", colors: { accent: bad } }, heroDataUrl: hero }),
      /无效主题颜色/,
      `${bad} 应被拒绝`,
    );
  }
  for (const good of ["#123", "#1234", "#123456", "#12345678"]) {
    assert.doesNotThrow(
      () => buildSkinCss({ theme: { id: "t", colors: { accent: good } }, heroDataUrl: hero }),
      `${good} 应通过`,
    );
  }
});

test("dark theme uses dark color-scheme and light native ink", () => {
  const css = buildSkinCss({
    theme: {
      id: "dalao-dianyan",
      appearance: "dark",
      colors: { accent: "#e09a52", secondary: "#9aa3b0", surface: "#111111", text: "#f2e8da" },
    },
    heroDataUrl: "data:image/webp;base64,AAAA",
  });

  assert.match(css, /color-scheme:\s*dark\s*!important/);
  assert.match(css, /--heige-native-ink:\s*#e8ecf0/);
  assert.doesNotMatch(css, /text-shadow:[^;]*white/);
});

test("infers dark appearance from surface luminance when appearance is absent", () => {
  const css = buildSkinCss({
    theme: {
      id: "custom-dark",
      colors: { accent: "#aabbcc", secondary: "#ccbbaa", surface: "#1a1a1a", text: "#eeeeee" },
    },
    heroDataUrl: "data:image/webp;base64,AAAA",
  });

  assert.match(css, /color-scheme:\s*dark\s*!important/);
  assert.match(css, /--heige-native-ink:\s*#e8ecf0/);
});
