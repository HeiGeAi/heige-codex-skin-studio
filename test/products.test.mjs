import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PRODUCT_ID,
  PRODUCT_IDS,
  isProductId,
  productAppCandidates,
  productBundledNodeCandidates,
  productCdpLaunchSpec,
  productExecutablePath,
  productForAppPath,
  productProfile,
  profileForAppPath,
} from "../src/products.mjs";
import { resolveStudioPaths } from "../src/constants.mjs";
import { buildWorkBuddySkinCss } from "../src/skin-css-workbuddy.mjs";
import { classifyWorkBuddyTarget } from "../src/target-classifier.mjs";

const HERO = "data:image/png;base64,aGVybw==";

const THEME = {
  id: "naruto-sasuke",
  appearance: "dark",
  colors: { accent: "#8E1B2E", secondary: "#3B1F4B", surface: "#171019", text: "#FFD9D2" },
};

test("默认产品是 Codex，没显式传产品的老路径行为不变", () => {
  assert.equal(DEFAULT_PRODUCT_ID, "codex");
  assert.deepEqual([...PRODUCT_IDS], ["codex", "workbuddy"]);
  assert.equal(productProfile().id, "codex");
  assert.equal(productProfile(null).id, "codex");
  assert.equal(productProfile(undefined).id, "codex");
  assert.equal(productProfile({ id: "workbuddy" }).id, "workbuddy");
  assert.equal(isProductId("workbuddy"), true);
  assert.equal(isProductId("cursor"), false);
  assert.throws(() => productProfile("cursor"), /未知产品：cursor/);
});

test("Codex 档案的对外事实一字不改", () => {
  const codex = productProfile("codex");
  assert.equal(codex.label, "Codex");
  assert.equal(codex.defaultCdpPort, 9341);
  assert.equal(codex.rendererOrigin, "app://-");
  assert.equal(codex.expectedBundleId, "com.openai.codex");
  assert.equal(codex.expectedTeamId, "2DC432GLL2");
  assert.equal(codex.macExecutableName, "ChatGPT");
  assert.equal(codex.installHomeDirName, ".codex");
  assert.equal(codex.stateDirName, "HeiGeCodexSkinStudio");
  assert.equal(codex.supportsControlChannel, true);
  assert.equal(codex.cdpPortVisibleInArgs, true);
  assert.equal(codex.windowsVerified, true);
});

test("WorkBuddy 档案记的是真机核过的身份，端口跟 Codex 错开", () => {
  const wb = productProfile("workbuddy");
  assert.equal(wb.label, "WorkBuddy");
  assert.equal(wb.defaultCdpPort, 9342);
  assert.notEqual(wb.defaultCdpPort, productProfile("codex").defaultCdpPort);
  assert.equal(wb.expectedBundleId, "com.workbuddy.workbuddy");
  assert.equal(wb.expectedTeamId, "FN2V63AD2J");
  // WorkBuddy 是标准 Electron 打包，主程序名不是应用名
  assert.equal(wb.macExecutableName, "Electron");
  assert.equal(wb.rendererOrigin, "file://");
  // Windows 侧只留结构，没在真机验证过，档案里必须如实标注
  assert.equal(wb.windowsVerified, false);
});

test("WorkBuddy 不开控制通道：file:// 的 Origin 是 null，放行等于掏空 CSRF 校验", () => {
  assert.equal(productProfile("workbuddy").supportsControlChannel, false);
  // 不支持控制通道就没有常驻，因此档案里不该出现 LaunchAgent 标签字段
  assert.equal("launchAgentSuffix" in productProfile("workbuddy"), false);
  assert.equal("launchAgentSuffix" in productProfile("codex"), false);
});

test("状态根按产品隔离，两个产品的锁和 state.json 不会互相抢", () => {
  const codex = resolveStudioPaths({ home: "/Users/example", product: "codex" });
  const wb = resolveStudioPaths({ home: "/Users/example", product: "workbuddy" });
  // Codex 侧保持历史路径，老用户升级不迁移
  assert.equal(codex.stateRoot, "/Users/example/Library/Application Support/HeiGeCodexSkinStudio");
  assert.equal(codex.installRoot, "/Users/example/.codex/heige-codex-skin-studio");
  assert.equal(
    wb.stateRoot,
    "/Users/example/Library/Application Support/HeiGeCodexSkinStudio-workbuddy",
  );
  assert.equal(wb.installRoot, "/Users/example/.workbuddy/heige-codex-skin-studio");
  for (const key of ["stateRoot", "statePath", "lockPath", "sessionPath", "userThemesRoot"]) {
    assert.notEqual(codex[key], wb[key], `${key} 必须按产品分开`);
  }
  // 不传 product 必须和显式传 codex 完全一致
  assert.deepEqual(resolveStudioPaths({ home: "/Users/example" }), codex);
});

test("从应用路径反推产品，认不出返回 null 交给上层落到 Codex", () => {
  assert.equal(productForAppPath("/Applications/ChatGPT.app"), "codex");
  assert.equal(productForAppPath("/Applications/WorkBuddy.app"), "workbuddy");
  assert.equal(productForAppPath("/Users/x/Applications/WorkBuddy.app/"), "workbuddy");
  assert.equal(productForAppPath("/Applications/Cursor.app"), null);
  assert.equal(productForAppPath(""), null);
  assert.equal(productForAppPath(undefined), null);
  assert.equal(
    productForAppPath("C:\\Program Files\\WorkBuddy\\WorkBuddy.exe", { platform: "win32" }),
    "workbuddy",
  );
  // 认不出来时 profileForAppPath 落到 Codex，后续可执行文件校验会明确报错
  assert.equal(profileForAppPath("/Applications/Cursor.app").id, "codex");
  assert.equal(profileForAppPath("/Applications/WorkBuddy.app").id, "workbuddy");
});

test("可执行文件路径跟着产品走，别拿 ChatGPT 去校 WorkBuddy", () => {
  assert.equal(
    productExecutablePath("codex", "/Applications/ChatGPT.app"),
    "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  );
  assert.equal(
    productExecutablePath("workbuddy", "/Applications/WorkBuddy.app"),
    "/Applications/WorkBuddy.app/Contents/MacOS/Electron",
  );
});

test("探测位点覆盖 /Applications 和 ~/Applications 两处", () => {
  assert.deepEqual(
    productAppCandidates("workbuddy", { platform: "darwin", home: "/Users/example" }),
    ["/Applications/WorkBuddy.app", "/Users/example/Applications/WorkBuddy.app"],
  );
  assert.deepEqual(
    productAppCandidates("codex", { platform: "darwin", home: "/Users/example" }),
    ["/Applications/ChatGPT.app", "/Users/example/Applications/ChatGPT.app"],
  );
});

test("WorkBuddy 没有可执行的内置 Node，候选列表必须是空的", () => {
  assert.deepEqual(
    productBundledNodeCandidates("workbuddy", "/Applications/WorkBuddy.app"),
    [],
  );
  assert.deepEqual(
    productBundledNodeCandidates("codex", "/Applications/ChatGPT.app"),
    [
      "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node",
      "/Applications/ChatGPT.app/Contents/Resources/cua_node/node",
    ],
  );
});

test("开调试端口的方式跟着产品走：Codex 走参数，WorkBuddy 走环境变量", () => {
  assert.deepEqual(productCdpLaunchSpec("codex", 9341), {
    args: ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9341"],
    env: {},
  });
  assert.deepEqual(productCdpLaunchSpec("workbuddy", 9342), {
    args: [],
    env: { WORKBUDDY_REMOTE_DEBUGGING_PORT: "9342" },
  });
  // 端口在 WorkBuddy 的 ps 命令行里看不见，身份判定不能按参数筛
  assert.equal(productProfile("workbuddy").cdpPortVisibleInArgs, false);
  for (const bad of [80, 70000, 9341.5, "9341", null]) {
    assert.throws(() => productCdpLaunchSpec("workbuddy", bad), TypeError);
  }
});

test("WorkBuddy 皮肤 CSS 同时写 :root 和 body，只写 :root 会被宿主主题盖掉", () => {
  const css = buildWorkBuddySkinCss({ theme: THEME, heroDataUrl: HERO });
  // WorkBuddy 的主题文件用 `:root, body[data-vscode-theme-name="IDE Light"]`
  // 把整套令牌在 body 上又声明了一遍，只写 :root 的话 body 以下读到的还是原生浅色
  assert.match(css, /^:root,\nbody \{/m);
  assert.match(css, /HEIGE_WORKBUDDY_SKIN:naruto-sasuke/);
  assert.match(css, /color-scheme: dark !important/);
});

test("WorkBuddy 皮肤覆盖三层令牌，结构色改、品牌色和状态色不动", () => {
  const css = buildWorkBuddySkinCss({ theme: THEME, heroDataUrl: HERO });
  for (const token of [
    "--cb-text-primary",
    "--cb-vscode-editor-background",
    // --wb-* 是新版结构层，写成 var(--wb-x, var(--cb-x, …)) 的回退链，
    // 只改 --cb-* 压不住它。--wb-sidebar-bg 是折叠区标题那条高特异性 !important 规则的取值来源
    "--wb-sidebar-bg",
    "--wb-bg-card",
    "--wb-text-primary",
    "--wb-border-default",
  ]) {
    assert.match(css, new RegExp(`${token}:`), `缺少令牌覆盖：${token}`);
  }
  for (const untouched of [
    "--wb-bg-connector-github",
    "--wb-text-enterprise",
    "--wb-bg-error-soft",
    "--wb-bg-success-soft",
    // 对比双方不都归我们管的，改了会做出浅底浅字，必须原样放过
    "--wb-bg-tooltip",
    "--wb-bg-overlay",
    "--wb-text-white",
  ]) {
    assert.doesNotMatch(css, new RegExp(`${untouched}:`), `不该动的令牌被改了：${untouched}`);
  }
});

test("WorkBuddy 皮肤只挂稳定选择器，一个构建哈希类名都不许出现", () => {
  const css = buildWorkBuddySkinCss({ theme: THEME, heroDataUrl: HERO });
  // _gridViewItem_1ens7_14 / _chipLabel_12mii_44 这类 CSS Module 哈希每次构建都会变
  const hashed = css.match(/\._[A-Za-z][A-Za-z0-9]*_[a-z0-9]{4,}(_\d+)?\b/g) ?? [];
  assert.deepEqual(hashed, []);
  // 换成宿主写死颜色时用的稳定挂钩
  for (const hook of [
    "[data-slate-editor=\"true\"]",
    "[data-cb-chat-input-toolbar-selector]",
    ".conversation-list-tab-button",
    ".quick-actions__item",
    "#root [data-view-id]",
  ]) {
    assert.ok(css.includes(hook), `缺少稳定挂钩：${hook}`);
  }
});

test("AI 回复垫了蒙版就必须一起接管正文和底部文字，只垫底会做出黑字压深色蒙版", () => {
  const css = buildWorkBuddySkinCss({ theme: THEME, heroDataUrl: HERO });
  // WorkBuddy 会把一条回复拆成多个同 request-id 的消息壳，未使用的分片只有一个空子节点。
  // 蒙版如果直接打在外壳上，padding 会把每个空分片撑成一条横向白条。
  assert.doesNotMatch(
    css,
    /:root\[data-heige-readability="on"\] \.cb-assistant-message \{[^}]*background:/,
    "回复外壳不能直接承载蒙版，否则空分片会被撑成白条",
  );
  // 蒙版本身挂阅读增强开关，并且只落在真正非空的直接内容节点上。
  assert.match(
    css,
    /:root\[data-heige-readability="on"\] \.cb-assistant-message > :not\(:empty\) \{[^}]*background:[^}]*padding:/,
    "回复蒙版必须只命中非空内容节点并挂在阅读增强开关下",
  );
  // 正文的 rgb(0,0,0) 和底部那排图标、消耗计数、时间的 rgba(0,0,0,.7) 都写死在各自节点上，
  // 不继承外层容器。漏掉任何一条，深色主题下就是黑字压深色蒙版，比不垫更糊
  for (const hook of [
    ".cb-assistant-message .cb-markdown",
    ".cb-assistant-message .cb-credit-usage-text",
    ".cb-assistant-message .cb-message-time-tip",
    ".cb-assistant-message button",
    // 发言人名字在蒙版外面，任何时候都直接压在背景图上
    ".avatar-container .name",
  ]) {
    assert.ok(css.includes(hook), `缺少稳定挂钩：${hook}`);
  }
  // 这几条颜色接管不挂开关：颜色写死是 WorkBuddy 自己的毛病，关掉蒙版一样要治
  assert.match(css, /^\.cb-assistant-message \.cb-markdown,$/m, "正文颜色接管不该挂在开关下");
  assert.match(css, /\.avatar-container \.name \{[^}]*text-shadow:/, "名字没有底可垫，必须留光晕");
  for (const [label, pattern] of [
    ["正文", /^\.cb-assistant-message \.cb-markdown,[\s\S]*?\}/m],
    ["名字", /^\.avatar-container \.name \{[\s\S]*?\}/m],
  ]) {
    const rule = css.match(pattern);
    assert.ok(rule, `找不到${label}的颜色接管规则`);
    assert.ok(rule[0].includes("var(--heige-text)"), `${label}必须取主题色而不是写死颜色`);
  }
});

test("浮层一律实底：半透明只给对话区，菜单和弹层透光就会跟底下正文叠字", () => {
  const css = buildWorkBuddySkinCss({ theme: THEME, heroDataUrl: HERO });

  // 实底令牌本身不能掺 transparent，掺了等于没治
  const solid = css.match(/^\s*--heige-solid:.*$/m);
  assert.ok(solid, "缺少浮层专用的实底令牌 --heige-solid");
  assert.match(solid[0], /var\(--heige-surface\)/, "实底令牌必须直接取主题底色");
  assert.doesNotMatch(solid[0], /color-mix|transparent/, "实底令牌不许掺透明");

  // 读令牌的那批浮层：模态、弹出层、下拉、悬浮卡全要指向实底，不许再落回半透明的 veil
  for (const token of [
    "--cb-vscode-dropdown-background",
    "--cb-bg-elevated",
    "--cb-bg-overlay",
    "--cb-hover-card-bg-color",
    "--cb-dialog-bg",
    "--cb-popover-bg",
    "--wb-bg-modal",
    "--wb-bg-popover",
    "--wb-bg-elevated",
  ]) {
    const line = css.match(new RegExp(`^\\s*${token}:.*$`, "m"));
    assert.ok(line, `缺少浮层令牌 ${token}`);
    assert.match(line[0], /var\(--heige-solid\)/, `${token} 必须实底`);
  }

  // 什么令牌都不读的那批浮层：只能按稳定类名钉实底
  for (const hook of [".settings-modal", ".user-menu-popover", ".wb-popover", ".wb-dropdown", ".wb-modal"]) {
    assert.ok(css.includes(`${hook},`) || css.includes(`${hook} {`), `浮层名单缺少 ${hook}`);
  }

  // BEM 子面板兜底：连字符和双下划线两种写法都得在，只写一种会漏掉添加模型框
  for (const suffix of ["-modal-overlay", "__modal-overlay", "-editor-overlay", "__editor-overlay", "__overlay"]) {
    assert.ok(css.includes(`[class$="${suffix}"] > *`), `兜底选择器缺少 ${suffix}`);
  }

  // 遮罩自己必须留半透明黑纱，被兜底规则连坐会让整个界面全黑
  assert.doesNotMatch(
    css,
    /^\[class\$="[^"]*overlay"\] \{/m,
    "遮罩本体不许被垫实底",
  );

  // 强调色按钮的字色不能跟着编辑区底色一起透明，否则实心按钮上一个字都看不见
  const primary = css.match(/^\.wb-button--primary,[\s\S]*?\}/m);
  assert.ok(primary, "缺少强调色按钮的字色接管");
  assert.match(primary[0], /var\(--heige-on-accent\)/, "强调色上的字必须走 --heige-on-accent");
});

test("WorkBuddy 主窗口识别放行 hash 路由，但仍按解码后的 pathname 认身份", () => {
  const main = "file:///Applications/WorkBuddy.app/Contents/Resources/app.asar/renderer/index.html";
  // 打开设置弹层就会把地址变成 index.html#，连 # 都拒会让皮肤在正常使用中途认不出主窗口
  for (const url of [main, `${main}#`, `${main}#/settings/models`]) {
    assert.equal(classifyWorkBuddyTarget({ type: "page", url }), "main", `应认出：${url}`);
  }
  // 放行 fragment 不等于放行伪造：身份只看 pathname，fragment 影响不到它
  for (const url of [
    `file:///tmp/evil.html#${main.slice("file://".length)}`,
    `file:///tmp/evil.html#/WorkBuddy.app/Contents/Resources/app.asar/renderer/index.html`,
    `${main}?a=1`,
    "file:///Applications/WorkBuddy.app/Contents/Resources/app.asar/renderer/%2e%2e/index.html",
    "file:///Applications/Evil.app/Contents/Resources/app.asar/renderer/index.html",
  ]) {
    assert.equal(classifyWorkBuddyTarget({ type: "page", url }), "unknown", `应挡掉：${url}`);
  }
});

test("WorkBuddy 皮肤拒绝非本地图片，防止皮肤把外链塞进宿主页面", () => {
  assert.throws(
    () => buildWorkBuddySkinCss({ theme: THEME, heroDataUrl: "https://example.com/a.png" }),
    /hero 必须是本地/,
  );
  assert.throws(
    () => buildWorkBuddySkinCss({ theme: THEME, heroDataUrl: HERO, logoDataUrl: "javascript:0" }),
    /logo 必须是本地/,
  );
  assert.throws(
    () => buildWorkBuddySkinCss({ theme: THEME, heroDataUrl: HERO, polaroidDataUrl: "/tmp/a.png" }),
    /polaroid 必须是本地/,
  );
  assert.throws(
    () => buildWorkBuddySkinCss({
      theme: { ...THEME, colors: { ...THEME.colors, accent: "red; }" } },
      heroDataUrl: HERO,
    }),
    /无效主题颜色/,
  );
});
