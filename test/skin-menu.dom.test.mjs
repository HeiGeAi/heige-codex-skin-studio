import assert from "node:assert/strict";
import test from "node:test";

import {
  deferredResponse,
  errorResponse,
  jsonResponse,
  menuWindow,
  okResponse,
  sequenceFetch,
} from "./helpers/menu-window.mjs";

class SharedBroadcastChannel {
  static channels = new Map();
  static messages = [];

  static reset() {
    this.channels.clear();
    this.messages = [];
  }

  constructor(name) {
    this.name = name;
    this.listeners = new Set();
    this.closed = false;
    const channels = SharedBroadcastChannel.channels.get(name) ?? new Set();
    channels.add(this);
    SharedBroadcastChannel.channels.set(name, channels);
  }

  addEventListener(type, listener) {
    if (type === "message") this.listeners.add(listener);
  }

  removeEventListener(type, listener) {
    if (type === "message") this.listeners.delete(listener);
  }

  postMessage(value) {
    if (this.closed) throw new Error("channel closed");
    const message = structuredClone(value);
    SharedBroadcastChannel.messages.push(message);
    for (const peer of SharedBroadcastChannel.channels.get(this.name) ?? []) {
      if (peer === this || peer.closed) continue;
      queueMicrotask(() => {
        for (const listener of peer.listeners) listener({ data: structuredClone(message) });
      });
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    SharedBroadcastChannel.channels.get(this.name)?.delete(this);
  }
}

function png(width, height, bytes = 24) {
  const result = Buffer.alloc(Math.max(bytes, 24));
  Buffer.from("89504e470d0a1a0a", "hex").copy(result, 0);
  result.writeUInt32BE(13, 8);
  result.write("IHDR", 12, "ascii");
  result.writeUInt32BE(width, 16);
  result.writeUInt32BE(height, 20);
  return result;
}

function webpVp8x(width, height) {
  const result = Buffer.alloc(30);
  result.write("RIFF", 0, "ascii");
  result.writeUInt32LE(22, 4);
  result.write("WEBPVP8X", 8, "ascii");
  result.writeUInt32LE(10, 16);
  result.writeUIntLE(width - 1, 24, 3);
  result.writeUIntLE(height - 1, 27, 3);
  return result;
}

function jpeg(width, height) {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc2, 0x00, 0x0b, 0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00,
  ]);
}

function installSuccessfulImagePipeline(page, {
  decodedWidth,
  decodedHeight,
  drawCalls = [],
} = {}) {
  const originalGetContext = page.window.HTMLCanvasElement.prototype.getContext;
  const originalToDataURL = page.window.HTMLCanvasElement.prototype.toDataURL;
  page.window.FileReader = class ImmediateReader {
    readAsDataURL(file) {
      Promise.resolve(file.bytes ?? file.arrayBuffer()).then((value) => {
        this.result = "data:" + file.type + ";base64," + Buffer.from(value).toString("base64");
        queueMicrotask(() => this.onload?.());
      }, () => queueMicrotask(() => this.onerror?.()));
    }
    abort() { this.onabort?.(); }
  };
  page.window.Image = class ImmediateImage {
    constructor() {
      this.width = decodedWidth;
      this.height = decodedHeight;
      this.naturalWidth = decodedWidth;
      this.naturalHeight = decodedHeight;
    }
    set src(value) {
      this._src = value;
      if (value) queueMicrotask(() => this.onload?.());
    }
    get src() { return this._src; }
  };
  page.window.HTMLCanvasElement.prototype.getContext = function getContext() {
    return {
      drawImage: (_image, _x, _y, width, height) => drawCalls.push({ width, height }),
      getImageData: (_x, _y, width, height) => ({
        data: new Uint8ClampedArray(width * height * 4),
      }),
    };
  };
  page.window.HTMLCanvasElement.prototype.toDataURL = () => {
    const factor = Math.max(
      1,
      Math.ceil(decodedWidth / 2048),
      Math.ceil(decodedHeight / 2048),
      Math.ceil(Math.sqrt((decodedWidth / 4_000_000) * decodedHeight)),
    );
    return "data:image/webp;base64," + webpVp8x(
      Math.max(1, Math.ceil(decodedWidth / factor)),
      Math.max(1, Math.ceil(decodedHeight / factor)),
    ).toString("base64");
  };
  return () => {
    page.window.HTMLCanvasElement.prototype.getContext = originalGetContext;
    page.window.HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
  };
}

async function upload(page, { bytes, name = "upload.png", type = "image/png", size = bytes.byteLength, arrayBuffer } = {}) {
  const picker = page.document.querySelector('input[type="file"]');
  const file = {
    name,
    type,
    size,
    arrayBuffer: arrayBuffer ?? (async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    bytes,
  };
  Object.defineProperty(picker, "files", { configurable: true, value: [file] });
  picker.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  for (let index = 0; index < 24; index += 1) await page.flush();
}

function rgb(value) {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) return [0, 2, 4].map((offset) => Number.parseInt(hex[1].slice(offset, offset + 2), 16));
  const functional = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(value);
  if (functional) return functional.slice(1).map(Number);
  throw new Error(`unsupported test color: ${value}`);
}

function contrastRatio(left, right) {
  const luminance = (value) => rgb(value)
    .map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    })
    .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("theme trigger opens an accessible modal and restores focus on close paths", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());
  assert.equal(page.trigger.getAttribute("aria-label"), "打开主题中心");
  assert.equal(page.panel.getAttribute("role"), "dialog");
  assert.equal(page.panel.getAttribute("aria-modal"), "true");
  assert.equal(page.backdrop.hidden, true);

  await page.openThemeCenter();
  assert.equal(page.backdrop.hidden, false);
  assert.equal(page.trigger.getAttribute("aria-expanded"), "true");
  assert.equal(page.document.activeElement, page.closeButton);

  page.panel.dispatchEvent(new page.window.KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  }));
  assert.equal(page.backdrop.hidden, true);
  assert.equal(page.document.activeElement, page.trigger);

  await page.openThemeCenter();
  page.backdrop.dispatchEvent(new page.window.MouseEvent("click", {
    bubbles: true,
    cancelable: true,
  }));
  assert.equal(page.backdrop.hidden, true);
  assert.equal(page.document.activeElement, page.trigger);
});

test("theme center traps Tab focus inside the dialog", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());
  await page.openThemeCenter();
  const focusable = [...page.panel.querySelectorAll("button:not([disabled]),[tabindex='0']")];
  const first = focusable[0];
  const last = focusable.at(-1);
  last.focus();
  page.panel.dispatchEvent(new page.window.KeyboardEvent("keydown", {
    key: "Tab",
    bubbles: true,
    cancelable: true,
  }));
  assert.equal(page.document.activeElement, first);
});

test("theme center renders native upload and built-in preview cards", async (t) => {
  const page = await menuWindow({
    entries: [
      {
        id: "miku-488137",
        name: "Miku",
        accent: "#19c9e5",
        previewFocus: { x: 50, y: 33 },
        thumbnailFocus: { x: 66, y: 31 },
        thumbnailZoom: 350,
        colors: { accent: "#19c9e5", secondary: "#ed6ec1", surface: "#f5f6fc", text: "#122c60" },
        css: '#root{background:url("data:image/webp;base64,QUJDRA==")}',
      },
      {
        id: "night-city",
        name: "Night City",
        accent: "#4455aa",
        previewFocus: { x: 50, y: 17 },
        colors: { accent: "#4455aa", secondary: "#d25c9d", surface: "#121725", text: "#f4f6ff" },
        css: "html{color:#eee}",
      },
    ],
  });
  t.after(() => page.close());

  assert.equal(page.document.querySelector('[data-heige-role="native-option"]')?.tagName, "BUTTON");
  assert.equal(page.document.querySelector('[data-heige-role="upload-trigger"]')?.tagName, "BUTTON");
  const cards = [...page.document.querySelectorAll('[data-heige-role="theme-option"]')];
  assert.equal(cards.length, 2);
  assert.match(cards[0].querySelector('[data-heige-role="theme-preview"]').style.backgroundImage, /data:image\/webp/);
  assert.equal(cards[0].querySelector('[data-heige-role="theme-preview"]').style.backgroundPosition, "66% 31%");
  assert.equal(cards[0].querySelector('[data-heige-role="theme-preview"]').style.backgroundSize, "350% auto");
  assert.match(cards[1].querySelector('[data-heige-role="theme-preview"]').dataset.fallbackColors, /#4455aa/i);
  assert.equal(page.currentHero.dataset.themeId, "miku-488137");
  assert.equal(page.currentHero.style.backgroundPosition, "50% 33%");
  const triggerPreview = page.document.querySelector('[data-heige-role="menu-trigger-preview"]');
  assert.equal(triggerPreview.style.backgroundPosition, "66% 31%");
  assert.equal(triggerPreview.style.backgroundSize, "350% auto");
  await page.pickTheme("night-city");
  assert.equal(page.currentHero.style.backgroundPosition, "50% 17%");
  const appearanceHelp = page.document.querySelector('[data-heige-role="appearance-help"]');
  assert.equal(appearanceHelp?.parentElement?.dataset.heigeRole, "theme-center-scroll");
  assert.match(appearanceHelp?.textContent ?? "", /字体颜色显示不对/);
  assert.match(appearanceHelp?.textContent ?? "", /左下角头像👉设置👉外观👉选择 浅色\/深色 主题✅即可/);
});

test("readability enhancement defaults on and persists an explicit off choice", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());

  assert.equal(page.readabilitySwitch.getAttribute("role"), "switch");
  assert.equal(page.readabilitySwitch.getAttribute("aria-checked"), "true");
  assert.equal(page.readabilityEnabled, true);
  assert.equal(page.window.localStorage.getItem("heigeCodexReadabilityEnabled"), null);

  await page.toggleReadability();
  assert.equal(page.readabilitySwitch.getAttribute("aria-checked"), "false");
  assert.equal(page.readabilityEnabled, false);
  assert.equal(page.window.localStorage.getItem("heigeCodexReadabilityEnabled"), "0");

  await page.injectAgain();
  assert.equal(page.readabilitySwitch.getAttribute("aria-checked"), "false");
  assert.equal(page.readabilityEnabled, false);
});

test("readability switch supports keyboard input and a saved on choice", async (t) => {
  const page = await menuWindow({
    initialStorage: { heigeCodexReadabilityEnabled: "0" },
  });
  t.after(() => page.close());

  assert.equal(page.readabilityEnabled, false);
  await page.keyReadabilitySwitch("Enter");
  assert.equal(page.readabilityEnabled, true);
  assert.equal(page.window.localStorage.getItem("heigeCodexReadabilityEnabled"), "1");
  await page.keyReadabilitySwitch(" ");
  assert.equal(page.readabilityEnabled, false);
});

test("version bar stays offline until the user manually checks", async (t) => {
  const page = await menuWindow({ currentVersion: "5.2.2" });
  t.after(() => page.close());

  assert.equal(page.versionText.textContent, "当前版本 v5.2.2");
  assert.equal(page.updateButton.textContent, "检查更新");
  assert.equal(page.runtime.status().controlRequest, null);

  page.updateButton.click();
  await page.flush();
  const request = page.runtime.status().controlRequest;
  assert.equal(request.action, "check-update");
  assert.equal(request.generation, page.runtime.generation);
  assert.equal(page.updateButton.textContent, "检查中");
  assert.equal(page.updateButton.disabled, true);
});

test("update results are request-bound and paint latest retry and available states", async (t) => {
  const page = await menuWindow({ currentVersion: "5.2.2" });
  t.after(() => page.close());

  page.updateButton.click();
  await page.flush();
  const first = page.runtime.status().controlRequest;
  assert.equal(page.runtime.receiveUpdateCheckResult({
    schemaVersion: 1,
    requestId: "0".repeat(32),
    generation: page.runtime.generation,
    status: "latest",
    currentVersion: "5.2.2",
    latestVersion: "5.2.2",
    releaseUrl:
      "https://github.com/HeiGeAi/heige-codex-skin-studio/releases/tag/v5.2.2",
  }), false);
  assert.equal(page.updateButton.textContent, "检查中");

  assert.equal(page.runtime.receiveUpdateCheckResult({
    schemaVersion: 1,
    requestId: first.requestId,
    generation: first.generation,
    status: "latest",
    currentVersion: "5.2.2",
    latestVersion: "5.2.2",
    releaseUrl:
      "https://github.com/HeiGeAi/heige-codex-skin-studio/releases/tag/v5.2.2",
  }), true);
  assert.equal(page.versionText.textContent, "v5.2.2 已是最新版");
  assert.equal(page.updateButton.textContent, "再次检查");
  assert.equal(page.updateButton.disabled, false);
  assert.equal(page.runtime.status().controlRequest, null);
  page.updateButton.click();
  await page.flush();
  const repeated = page.runtime.status().controlRequest;
  assert.equal(repeated.action, "check-update");
  assert.notEqual(repeated.requestId, first.requestId);
  assert.equal(page.updateButton.textContent, "检查中");
  assert.equal(page.updateButton.disabled, true);

  const retryPage = await menuWindow({ currentVersion: "5.2.2" });
  t.after(() => retryPage.close());
  retryPage.updateButton.click();
  await retryPage.flush();
  const retry = retryPage.runtime.status().controlRequest;
  assert.equal(retryPage.runtime.receiveUpdateCheckResult({
    schemaVersion: 1,
    requestId: retry.requestId,
    generation: retry.generation,
    status: "error",
    currentVersion: "5.2.2",
  }), true);
  assert.equal(retryPage.versionText.textContent, "暂时无法检查更新");
  assert.equal(retryPage.updateButton.textContent, "重新检查");
  assert.equal(retryPage.updateButton.disabled, false);
});

test("available update copies a complete Codex instruction with a fallback", async (t) => {
  const page = await menuWindow({ currentVersion: "5.2.2" });
  t.after(() => page.close());
  let copied = null;
  Object.defineProperty(page.window.navigator, "clipboard", {
    configurable: true,
    value: {
      async writeText(value) {
        copied = value;
      },
    },
  });

  page.updateButton.click();
  await page.flush();
  const request = page.runtime.status().controlRequest;
  assert.equal(page.runtime.receiveUpdateCheckResult({
    schemaVersion: 1,
    requestId: request.requestId,
    generation: request.generation,
    status: "update-available",
    currentVersion: "5.2.2",
    latestVersion: "5.3.0",
    releaseUrl:
      "https://github.com/HeiGeAi/heige-codex-skin-studio/releases/tag/v5.3.0",
  }), true);
  assert.equal(page.versionText.textContent, "发现新版本 v5.3.0");
  assert.equal(page.updateButton.textContent, "复制更新指令");
  assert.equal(page.updateButton.disabled, false);

  page.updateButton.click();
  await page.flush();
  assert.match(copied, /github\.com\/HeiGeAi\/heige-codex-skin-studio/);
  assert.match(copied, /当前安装版本：v5\.2\.2/);
  assert.match(copied, /检测到最新版本：v5\.3\.0/);
  assert.match(copied, /不要修改 Codex 的 app\.asar/);
  assert.equal(page.alert.textContent, "更新指令已复制，请粘贴到 Codex 对话中执行。");

  const fallback = await menuWindow({ currentVersion: "5.2.2" });
  t.after(() => fallback.close());
  Object.defineProperty(fallback.window.navigator, "clipboard", {
    configurable: true,
    value: {
      async writeText() {
        throw new Error("clipboard permission denied");
      },
    },
  });
  let execCalls = 0;
  fallback.document.execCommand = (command) => {
    execCalls += 1;
    return command === "copy";
  };
  fallback.updateButton.click();
  await fallback.flush();
  const fallbackRequest = fallback.runtime.status().controlRequest;
  fallback.runtime.receiveUpdateCheckResult({
    schemaVersion: 1,
    requestId: fallbackRequest.requestId,
    generation: fallbackRequest.generation,
    status: "update-available",
    currentVersion: "5.2.2",
    latestVersion: "5.3.0",
    releaseUrl:
      "https://github.com/HeiGeAi/heige-codex-skin-studio/releases/tag/v5.3.0",
  });
  fallback.updateButton.click();
  await fallback.flush();
  assert.equal(execCalls, 1);
  assert.equal(fallback.document.querySelectorAll("textarea").length, 0);
  assert.match(fallback.alert.textContent, /已复制/);
});

test("clipboard failure never claims the update instruction was copied", async (t) => {
  const page = await menuWindow({ currentVersion: "5.2.2" });
  t.after(() => page.close());
  Object.defineProperty(page.window.navigator, "clipboard", {
    configurable: true,
    value: {
      async writeText() {
        throw new Error("clipboard permission denied");
      },
    },
  });
  page.document.execCommand = () => false;
  page.updateButton.click();
  await page.flush();
  const request = page.runtime.status().controlRequest;
  page.runtime.receiveUpdateCheckResult({
    schemaVersion: 1,
    requestId: request.requestId,
    generation: request.generation,
    status: "update-available",
    currentVersion: "5.2.2",
    latestVersion: "5.3.0",
    releaseUrl:
      "https://github.com/HeiGeAi/heige-codex-skin-studio/releases/tag/v5.3.0",
  });
  page.updateButton.click();
  await page.flush();
  assert.match(page.alert.textContent, /复制失败/);
  assert.doesNotMatch(page.alert.textContent, /已复制/);
});

test("switch exposes programmatic state and permanent re-enable guidance", async (t) => {
  const page = await menuWindow({ persistenceEnabled: true, revision: 7 });
  t.after(() => page.close());
  assert.equal(page.switch.getAttribute("role"), "switch");
  assert.equal(page.switch.getAttribute("tabindex"), "0");
  assert.equal(page.switch.getAttribute("aria-checked"), "true");
  assert.match(page.switch.getAttribute("aria-labelledby") ?? "", /persistence-title/);
  assert.match(page.switch.getAttribute("aria-describedby") ?? "", /persistence-state/);
  assert.match(page.switch.getAttribute("aria-describedby") ?? "", /persistence-helper/);
  assert.match(page.document.body.textContent, /关闭后本次继续使用；下次启动恢复原生界面/);
  assert.match(page.document.body.textContent, /恢复本次皮肤/);
  assert.match(page.document.body.textContent, /HeiGe 皮肤启动器/);
  assert.match(page.document.body.textContent, /启用 HeiGe 皮肤/);
  assert.match(page.document.body.textContent, /下次仍常驻：重新打开此开关/);
});

test("inline off confirmation is labelled and restores focus before every local hide", async (t) => {
  const pending = deferredResponse();
  const page = await menuWindow({ fetch: () => pending.promise });
  t.after(() => page.close());
  page.trigger.click();
  await page.clickPersistenceSwitch();
  assert.equal(page.confirmation.getAttribute("role"), "group");
  assert.match(page.confirmation.getAttribute("aria-labelledby") ?? "", /persistence-confirmation-text/);
  assert.match(page.confirmation.getAttribute("aria-describedby") ?? "", /persistence-helper/);
  assert.equal(page.document.activeElement?.dataset.heigeRole, "persistence-cancel");
  page.confirmation.dispatchEvent(new page.window.KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  }));
  await page.flush();
  assert.equal(page.confirmation.hidden, true);
  assert.equal(page.trigger.getAttribute("aria-expanded"), "true");
  assert.equal(page.document.activeElement, page.switch);

  await page.clickPersistenceSwitch();
  page.confirm.focus();
  await page.clickConfirmOff();
  assert.equal(page.confirmation.hidden, false);
  assert.equal(page.confirmation.getAttribute("aria-busy"), "true");
  assert.equal(page.document.activeElement, page.confirm);
  pending.resolve(okResponse({ persistenceEnabled: false, revision: 8 }));
  await page.flush();
  assert.equal(page.confirmation.hidden, true);
  assert.equal(page.document.activeElement, page.switch);
  assert.match(page.alert.textContent, /启动器.*只恢复本次/s);
  assert.match(page.alert.textContent, /下次仍常驻.*重新打开此开关/s);
});

test("menu actions use native buttons and expose selected theme state", async (t) => {
  const page = await menuWindow({
    entries: [
      { id: "miku-488137", name: "Miku 488137", accent: "#19c9e5", css: "html { color: #123456; }" },
      { id: "night-city", name: "Night City", accent: "#4455aa", css: "html { color: #eeeeee; }" },
    ],
  });
  t.after(() => page.close());
  const themeButtons = [...page.document.querySelectorAll('[data-heige-role="theme-option"]')];
  assert.equal(themeButtons.length, 2);
  assert.equal(themeButtons.every((item) => item.tagName === "BUTTON" && item.type === "button"), true);
  assert.equal(themeButtons[0].getAttribute("aria-pressed"), "true");
  assert.equal(themeButtons[1].getAttribute("aria-pressed"), "false");
  assert.match(
    themeButtons[0].querySelector('[data-heige-role="theme-preview"]')?.getAttribute("aria-label") ?? "",
    /主题预览/,
  );
  for (const role of ["upload-trigger", "native-option", "hide-trigger"]) {
    const action = page.document.querySelector(`[data-heige-role="${role}"]`);
    assert.equal(action?.tagName, "BUTTON", `${role} should be a native button`);
    assert.equal(action?.type, "button");
  }
  await page.pickTheme("night-city");
  assert.equal(page.themeId, "night-city");
  assert.equal(themeButtons[1].getAttribute("aria-pressed"), "true");
  assert.equal(page.backdrop.hidden, true);
});

test("menu disclosure publishes its state and Escape closes back to the trigger", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());
  assert.equal(page.trigger.getAttribute("aria-label"), "打开主题中心");
  assert.equal(page.trigger.getAttribute("aria-expanded"), "false");
  assert.equal(page.trigger.getAttribute("aria-controls"), page.panel.id);
  page.trigger.click();
  assert.equal(page.trigger.getAttribute("aria-expanded"), "true");
  assert.equal(page.panel.style.display, "grid");
  assert.equal(page.backdrop.hidden, false);
  const firstTheme = page.document.querySelector('[data-heige-role="theme-option"]');
  firstTheme.focus();
  firstTheme.dispatchEvent(new page.window.KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  }));
  assert.equal(page.trigger.getAttribute("aria-expanded"), "false");
  assert.equal(page.panel.style.display, "none");
  assert.equal(page.document.activeElement, page.trigger);
});

test("minimized menu keeps a twenty-four-pixel target around its ten-pixel dot", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());
  await page.hideMenu();
  const dot = page.document.querySelector('[data-heige-role="menu-trigger-preview"]');
  assert.ok(Number.parseFloat(page.trigger.style.width) >= 24);
  assert.ok(Number.parseFloat(page.trigger.style.height) >= 24);
  assert.equal(dot?.style.width, "10px");
  assert.equal(dot?.style.height, "10px");
  assert.equal(page.trigger.getAttribute("aria-label"), "显示主题入口");
});

test("menu panel is vertically scrollable and keeps focused actions in view", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());
  const scroll = page.document.querySelector('[data-heige-role="theme-center-scroll"]');
  assert.equal(scroll.parentElement, page.panel);
  const firstTheme = page.document.querySelector('[data-heige-role="theme-option"]');
  let scrollOptions = null;
  firstTheme.scrollIntoView = (options) => { scrollOptions = options; };
  firstTheme.dispatchEvent(new page.window.FocusEvent("focusin", { bubbles: true }));
  assert.equal(scrollOptions?.block, "nearest");
});

test("switch track and border colors meet three-to-one non-text contrast", async (t) => {
  for (const persistenceEnabled of [true, false]) {
    const page = await menuWindow({ persistenceEnabled });
    t.after(() => page.close());
    assert.ok(contrastRatio(page.switch.style.backgroundColor, "#ffffff") >= 3);
    assert.ok(contrastRatio(page.switch.style.borderColor, "#ffffff") >= 3);
  }
});

test("off is painted only after the controller ACK", async (t) => {
  const pending = deferredResponse();
  const page = await menuWindow({ fetch: () => pending.promise });
  t.after(() => page.close());
  await page.clickPersistenceSwitch();
  assert.equal(page.confirmation.hidden, false);
  await page.clickConfirmOff();
  assert.equal(page.switch.getAttribute("aria-checked"), "true");
  assert.equal(page.switch.getAttribute("aria-busy"), "true");
  pending.resolve(okResponse({ persistenceEnabled: false, revision: 8 }));
  await page.flush();
  assert.equal(page.switch.getAttribute("aria-checked"), "false");
  assert.equal(page.switch.getAttribute("aria-busy"), "false");
});

test("cancel keeps persistence on without contacting the controller", async (t) => {
  let calls = 0;
  const page = await menuWindow({ fetch: async () => { calls += 1; } });
  t.after(() => page.close());
  await page.clickPersistenceSwitch();
  await page.clickCancelOff();
  assert.equal(page.confirmation.hidden, true);
  assert.equal(page.switch.getAttribute("aria-checked"), "true");
  assert.equal(calls, 0);
});

test("a renderer-blocked request is queued for the controller poll without painting an ACK", async (t) => {
  const page = await menuWindow({ fetch: async () => { throw new Error("Failed to fetch"); } });
  t.after(() => page.close());
  await page.disablePersistence();
  assert.equal(page.switch.getAttribute("aria-checked"), "true");
  assert.equal(page.switch.getAttribute("aria-busy"), "true");
  const request = page.window.__heigeCodexSkinRuntime.status().controlRequest;
  assert.deepEqual(Object.keys(request).sort(), [
    "action",
    "capability",
    "expectedRevision",
    "persistenceEnabled",
    "requestId",
    "schemaVersion",
  ]);
  assert.equal(request.action, "set-persistence");
  assert.equal(request.expectedRevision, 7);
  assert.equal(request.persistenceEnabled, false);
  assert.match(request.requestId, /^[0-9a-f]{32}$/);
  assert.match(request.capability, /^[A-Za-z0-9_-]{43}$/);
  assert.match(page.alert.textContent, /后台确认/);
  assert.equal(page.alert.getAttribute("role"), "alert");
});

test("a compensated enable failure syncs revision without painting on", async (t) => {
  const requests = [];
  const page = await menuWindow({
    persistenceEnabled: false,
    revision: 3,
    fetch: sequenceFetch([
      errorResponse(503, {
        code: "BACKGROUND_START_FAILED",
        message: "后台控制器启动失败，常驻仍为关闭",
        persistenceEnabled: false,
        revision: 5,
      }),
      okResponse({ persistenceEnabled: true, revision: 6 }),
    ], requests),
  });
  t.after(() => page.close());
  await page.enablePersistence();
  assert.equal(page.switch.getAttribute("aria-checked"), "false");
  assert.equal(page.controlRevision, 5);
  assert.match(page.alert.textContent, /后台控制器启动失败/);
  await page.enablePersistence();
  assert.equal(requests[1].revision, 5);
  assert.equal(page.switch.getAttribute("aria-checked"), "true");
});

test("malformed and mismatched ACKs never change the painted state", async (t) => {
  for (const response of [
    okResponse({ persistenceEnabled: true, revision: 8 }),
    okResponse({ persistenceEnabled: false, revision: 7 }),
    { ok: true, status: 200, async json() { return { ok: true, persistenceEnabled: false, revision: "8" }; } },
  ]) {
    const page = await menuWindow({ fetch: async () => response });
    t.after(() => page.close());
    await page.disablePersistence();
    assert.equal(page.switch.getAttribute("aria-checked"), "true");
    assert.match(page.alert.textContent, /响应无效/);
  }
});

test("scripted Enter and Space keydown operate the switch while pending input is ignored", async (t) => {
  const pending = deferredResponse();
  let calls = 0;
  const page = await menuWindow({
    persistenceEnabled: false,
    fetch: () => { calls += 1; return pending.promise; },
  });
  t.after(() => page.close());
  await page.keyPersistenceSwitch("Enter");
  await page.keyPersistenceSwitch(" ");
  assert.equal(calls, 1);
  assert.equal(page.switch.getAttribute("aria-checked"), "false");
  pending.resolve(okResponse({ persistenceEnabled: true, revision: 8 }));
  await page.flush();
  assert.equal(page.switch.getAttribute("aria-checked"), "true");
});

test("persistence state and token are never written to localStorage", async (t) => {
  const page = await menuWindow({ persistenceEnabled: false, revision: 2 });
  t.after(() => page.close());
  await page.enablePersistence();
  const entries = Array.from({ length: page.window.localStorage.length }, (_, index) => {
    const key = page.window.localStorage.key(index);
    return [key, page.window.localStorage.getItem(key)];
  });
  assert.equal(entries.some(([key, value]) => /persist|token|control/i.test(`${key}:${value}`)), false);
  const controlToken = Buffer.alloc(32, 7).toString("base64url");
  assert.equal(entries.some(([, value]) => value.includes(controlToken)), false);
});

test("reinjection disposes the previous generation and invalidates its API", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());
  const firstRuntime = page.window.__heigeCodexSkinRuntime;
  const firstApi = page.window.__heigeCodexSkin;
  const secondRuntime = await page.injectAgain();
  assert.equal(firstRuntime.signal.aborted, true);
  assert.equal(firstRuntime.channel.closed, true);
  assert.notEqual(secondRuntime.generation, firstRuntime.generation);
  assert.throws(() => firstApi.setTheme("miku-488137"), /disposed/i);
  assert.equal(page.document.querySelectorAll("#heige-codex-skin-menu").length, 1);
});

test("runtime disposal is idempotent and removes only its owned globals and DOM", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());
  const runtime = page.window.__heigeCodexSkinRuntime;
  assert.equal(runtime.dispose(), true);
  assert.equal(runtime.dispose(), false);
  assert.equal(runtime.signal.aborted, true);
  assert.equal(runtime.channel.closed, true);
  assert.equal(page.document.getElementById("heige-codex-skin-menu"), null);
  assert.equal(page.document.getElementById("heige-codex-skin-style"), null);
  assert.equal(page.window.__heigeCodexSkin, undefined);
  assert.equal(page.window.__heigeCodexSkinRuntime, undefined);
});

test("a stale persistence response cannot mutate the new generation", async (t) => {
  const pending = deferredResponse();
  const page = await menuWindow({ fetch: () => pending.promise });
  t.after(() => page.close());
  await page.clickPersistenceSwitch();
  await page.clickConfirmOff();
  const firstRuntime = page.window.__heigeCodexSkinRuntime;
  await page.injectAgain();
  pending.resolve(okResponse({ persistenceEnabled: false, revision: 8 }));
  await page.flush();
  assert.equal(firstRuntime.signal.aborted, true);
  assert.deepEqual(JSON.parse(JSON.stringify(page.window.__heigeCodexSkinRuntime.status())), {
    generation: page.window.__heigeCodexSkinRuntime.generation,
    themeId: "miku-488137",
    menu: true,
    mode: "active",
    persistenceEnabled: true,
    revision: 7,
    themeTransitionPending: false,
    controlRequest: null,
  });
  assert.equal(page.switch.getAttribute("aria-checked"), "true");
  assert.equal(page.alert.hidden, true);
});

test("a stale Image callback rejects and cannot overwrite the new generation", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());
  const images = [];
  page.window.Image = class DelayedImage {
    constructor() {
      this.width = 80;
      this.height = 40;
      this.onload = null;
      this.onerror = null;
      this.src = "";
      images.push(this);
    }
  };
  const oldApi = page.window.__heigeCodexSkin;
  const imported = oldApi.importFromDataUrl("data:image/png;base64," + png(80, 40).toString("base64"), "old");
  const rejected = assert.rejects(imported, (error) => error.name === "AbortError" && /disposed/i.test(error.message));
  const staleOnload = images[0].onload;
  await page.injectAgain();
  staleOnload();
  await rejected;
  assert.equal(page.document.documentElement.dataset.heigeCodexSkin, "miku-488137");
  assert.equal(page.window.localStorage.getItem("heigeCodexCustomTheme"), null);
});

test("dispose aborts an active FileReader and its stale callback becomes inert", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());
  let reader;
  page.window.FileReader = class DelayedReader {
    constructor() {
      reader = this;
      this.result = "data:image/png;base64,old";
      this.abortCalls = 0;
    }
    readAsDataURL() {}
    abort() { this.abortCalls += 1; }
  };
  const picker = page.document.querySelector('input[type="file"]');
  Object.defineProperty(picker, "files", {
    configurable: true,
    value: [{
      name: "old.png",
      type: "image/png",
      size: png(80, 40).byteLength,
      arrayBuffer: async () => {
        const bytes = png(80, 40);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    }],
  });
  picker.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  await page.flush();
  const staleOnload = reader.onload;
  await page.injectAgain();
  assert.equal(reader.abortCalls, 1);
  staleOnload();
  await page.flush();
  assert.equal(page.document.documentElement.dataset.heigeCodexSkin, "miku-488137");
  assert.equal(page.window.localStorage.getItem("heigeCodexCustomTheme"), null);
});

test("browser upload rejects byte and dimension bombs before decode", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());
  let imageCalls = 0;
  let readerCalls = 0;
  page.window.Image = class CountingImage { constructor() { imageCalls += 1; } };
  page.window.FileReader = class CountingReader { constructor() { readerCalls += 1; } };

  await upload(page, {
    bytes: png(10, 10),
    size: (8 * 1024 * 1024) + 1,
  });
  const alert = page.document.querySelector('[data-heige-role="upload-alert"]');
  assert.match(alert.textContent, /8 MiB|8388608/);
  assert.equal(page.backdrop.hidden, false);
  assert.equal(imageCalls, 0);
  assert.equal(readerCalls, 0);

  await upload(page, { bytes: png(8000, 8000, 1024) });
  assert.match(alert.textContent, /像素|pixel/i);
  assert.equal(imageCalls, 0);
  assert.equal(readerCalls, 0);
  assert.equal(page.document.documentElement.dataset.heigeCodexSkin, "miku-488137");
});

test("browser upload rejects MIME mismatch before FileReader or Image", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());
  let imageCalls = 0;
  let readerCalls = 0;
  page.window.Image = class CountingImage { constructor() { imageCalls += 1; } };
  page.window.FileReader = class CountingReader { constructor() { readerCalls += 1; } };
  await upload(page, { bytes: png(100, 100), name: "wrong.jpg", type: "image/jpeg" });
  const alert = page.document.querySelector('[data-heige-role="upload-alert"]');
  assert.match(alert.textContent, /MIME|JPEG|PNG/i);
  assert.equal(imageCalls, 0);
  assert.equal(readerCalls, 0);
});

test("browser upload timeout settles visibly without decoding", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());
  let imageCalls = 0;
  page.window.Image = class CountingImage { constructor() { imageCalls += 1; } };
  const originalSetTimeout = page.window.setTimeout;
  const originalClearTimeout = page.window.clearTimeout;
  let timerId = 0;
  page.window.setTimeout = (callback) => {
    timerId += 1;
    queueMicrotask(callback);
    return timerId;
  };
  page.window.clearTimeout = () => {};
  try {
    await upload(page, {
      bytes: png(100, 100),
      arrayBuffer: () => new Promise(() => {}),
    });
    const alert = page.document.querySelector('[data-heige-role="upload-alert"]');
    assert.match(alert.textContent, /超时|timeout/i);
    assert.equal(alert.getAttribute("aria-busy"), "false");
    assert.equal(imageCalls, 0);
  } finally {
    page.window.setTimeout = originalSetTimeout;
    page.window.clearTimeout = originalClearTimeout;
  }
});

test("validated upload scales within both canvas budgets and persists", async (t) => {
  const messages = [];
  const page = await menuWindow({
    electronBridgeFactory: () => ({
      async sendMessageFromView(message) {
        messages.push(structuredClone(message));
      },
    }),
  });
  t.after(() => page.close());
  messages.length = 0;
  const drawCalls = [];
  const restore = installSuccessfulImagePipeline(page, {
    decodedWidth: 4000,
    decodedHeight: 1000,
    drawCalls,
  });
  t.after(restore);
  await upload(page, { bytes: png(4000, 1000), name: "wide.png" });
  const alert = page.document.querySelector('[data-heige-role="upload-alert"]');
  assert.equal(alert.getAttribute("aria-busy"), "false");
  assert.match(alert.textContent, /已应用并保存/);
  assert.match(alert.textContent, /不会改写最近正式主题/);
  assert.match(alert.textContent, /自动补针或常驻启动时可能继续显示/);
  assert.deepEqual(drawCalls[0], { width: 2000, height: 500 });
  assert.equal(page.document.documentElement.dataset.heigeCodexSkin, "custom-upload");
  assert.equal(
    page.currentHero.style.backgroundSize,
    "100% 100%, contain",
    "custom artwork must remain fully visible in the current-theme board",
  );
  assert.equal(page.currentHero.style.backgroundRepeat, "no-repeat");
  assert.match(page.window.localStorage.getItem("heigeCodexCustomTheme"), /data:image\/webp/);
  const custom = page.document.querySelector('[data-heige-theme-id="custom-upload"]');
  const remove = page.document.querySelector('[data-heige-role="custom-delete"]');
  assert.equal(custom?.tagName, "BUTTON");
  assert.equal(custom?.getAttribute("aria-pressed"), "true");
  assert.equal(remove?.tagName, "BUTTON");
  assert.match(remove?.getAttribute("aria-label") ?? "", /删除自定义主题.*wide/i);
  assert.match(
    custom.querySelector('[data-heige-role="theme-preview"]').style.backgroundImage,
    /data:image\/webp/,
  );
  assert.equal(page.document.documentElement.classList.contains("electron-dark"), true);
  const savedCustom = JSON.parse(page.window.localStorage.getItem("heigeCodexCustomTheme"));
  assert.equal(savedCustom.appearance, "dark");
  const appearanceRequest = messages.find((message) =>
    message.type === "fetch" && message.url === "vscode://codex/set-setting");
  assert.equal(JSON.parse(appearanceRequest?.body ?? "null")?.value, "dark");
});

test("remote persistence changes close inline confirmation after restoring focus", async (t) => {
  SharedBroadcastChannel.reset();
  const left = await menuWindow({ BroadcastChannelClass: SharedBroadcastChannel });
  const right = await menuWindow({ BroadcastChannelClass: SharedBroadcastChannel });
  t.after(() => { left.close(); right.close(); SharedBroadcastChannel.reset(); });
  await right.clickPersistenceSwitch();
  assert.equal(right.document.activeElement, right.cancel);
  await left.disablePersistence();
  await right.flush();
  assert.equal(right.confirmation.hidden, true);
  assert.equal(right.document.activeElement?.dataset.heigeRole, "persistence-switch");
});

test("a newer window ACK clears a queued persistence request without leaving the switch busy", async (t) => {
  SharedBroadcastChannel.reset();
  const left = await menuWindow({
    BroadcastChannelClass: SharedBroadcastChannel,
    fetch: async () => { throw new Error("Failed to fetch"); },
  });
  const right = await menuWindow({ BroadcastChannelClass: SharedBroadcastChannel });
  t.after(() => { left.close(); right.close(); SharedBroadcastChannel.reset(); });

  await left.disablePersistence();
  assert.equal(left.switch.getAttribute("aria-busy"), "true");
  assert.notEqual(left.window.__heigeCodexSkinRuntime.status().controlRequest, null);

  await right.disablePersistence();
  await left.flush();

  assert.equal(left.switch.getAttribute("aria-checked"), "false");
  assert.equal(left.switch.getAttribute("aria-busy"), "false");
  assert.equal(left.switch.disabled, false);
  assert.equal(left.window.__heigeCodexSkinRuntime.status().controlRequest, null);
});

test("a newer persistence revision cancels a stale queued theme request while rows stay interactive", async (t) => {
  SharedBroadcastChannel.reset();
  const entries = [
    { id: "miku-488137", name: "Miku", accent: "#19c9e5", css: "html { color: #123456; }" },
    { id: "night-city", name: "Night City", accent: "#4455aa", css: "html { color: #eeeeee; }" },
  ];
  const left = await menuWindow({
    BroadcastChannelClass: SharedBroadcastChannel,
    entries,
    fetch: async () => { throw new Error("Failed to fetch"); },
  });
  const right = await menuWindow({ BroadcastChannelClass: SharedBroadcastChannel, entries });
  t.after(() => { left.close(); right.close(); SharedBroadcastChannel.reset(); });

  await left.pickTheme("night-city");
  const nightRow = left.document.querySelector('[data-heige-theme-id="night-city"]');
  assert.equal(nightRow.disabled, false);

  await right.disablePersistence();
  await left.flush();

  assert.equal(left.themeId, "miku-488137");
  assert.equal(nightRow.disabled, false);
  assert.equal(left.window.__heigeCodexSkinRuntime.status().controlRequest, null);
});

test("vertical boundary images keep the palette canvas below 48 pixels per side", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());
  const drawCalls = [];
  const restore = installSuccessfulImagePipeline(page, {
    decodedWidth: 81,
    decodedHeight: 8100,
    drawCalls,
  });
  t.after(restore);
  await upload(page, { bytes: png(81, 8100), name: "vertical.png" });
  assert.equal(page.document.documentElement.dataset.heigeCodexSkin, "custom-upload");
  assert.ok(drawCalls[1].width <= 48);
  assert.ok(drawCalls[1].height <= 48);
});

for (const fixture of [
  { name: "photo.jpg", type: "image/jpeg", bytes: jpeg(320, 180), width: 320, height: 180 },
  { name: "photo.webp", type: "image/webp", bytes: webpVp8x(320, 180), width: 320, height: 180 },
]) {
  test("browser upload validates " + fixture.type + " headers before decode", async (t) => {
    const page = await menuWindow();
    t.after(() => page.close());
    const restore = installSuccessfulImagePipeline(page, {
      decodedWidth: fixture.width,
      decodedHeight: fixture.height,
    });
    t.after(restore);
    await upload(page, fixture);
    assert.equal(page.document.documentElement.dataset.heigeCodexSkin, "custom-upload");
    assert.match(
      page.document.querySelector('[data-heige-role="upload-alert"]').textContent,
      /已应用并保存/,
    );
  });
}

test("browser upload derives MIME from a valid extension when File.type is empty", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());
  const restore = installSuccessfulImagePipeline(page, {
    decodedWidth: 100,
    decodedHeight: 100,
  });
  t.after(restore);
  await upload(page, { bytes: png(100, 100), name: "photo.png", type: "" });
  assert.equal(page.document.documentElement.dataset.heigeCodexSkin, "custom-upload");
  assert.match(
    page.document.querySelector('[data-heige-role="upload-alert"]').textContent,
    /已应用并保存/,
  );
});

test("decoded dimensions must match the validated header before canvas allocation", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());
  const drawCalls = [];
  const restore = installSuccessfulImagePipeline(page, {
    decodedWidth: 101,
    decodedHeight: 100,
    drawCalls,
  });
  t.after(restore);
  await upload(page, { bytes: png(100, 100) });
  const alert = page.document.querySelector('[data-heige-role="upload-alert"]');
  assert.match(alert.textContent, /尺寸与 header 不一致/);
  assert.equal(drawCalls.length, 0);
  assert.equal(page.document.documentElement.dataset.heigeCodexSkin, "miku-488137");
});

test("storage quota failure keeps only the current generation and says restart will not retain it", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());
  const restore = installSuccessfulImagePipeline(page, {
    decodedWidth: 100,
    decodedHeight: 100,
  });
  t.after(restore);
  const originalSetItem = page.window.localStorage.setItem.bind(page.window.localStorage);
  Object.defineProperty(page.window.localStorage, "setItem", {
    configurable: true,
    value(key, value) {
      if (key === "heigeCodexCustomTheme") throw new page.window.DOMException("quota", "QuotaExceededError");
      return originalSetItem(key, value);
    },
  });
  t.after(() => {
    Object.defineProperty(page.window.localStorage, "setItem", {
      configurable: true,
      value: originalSetItem,
    });
  });
  await upload(page, { bytes: png(100, 100) });
  const alert = page.document.querySelector('[data-heige-role="upload-alert"]');
  assert.match(alert.textContent, /本次已应用.*重启后不会保留/);
  assert.equal(page.document.documentElement.dataset.heigeCodexSkin, "custom-upload");
  assert.equal(page.window.localStorage.getItem("heigeCodexCustomTheme"), null);
});

test("theme native hidden and persistence ACK synchronize to a second renderer", async (t) => {
  SharedBroadcastChannel.reset();
  const entries = [
    {
      id: "miku-488137",
      name: "Miku 488137",
      accent: "#19c9e5",
      css: "html { color: #123456; }",
    },
    {
      id: "night-city",
      name: "Night City",
      accent: "#4455aa",
      css: "html { color: #eeeeee; }",
    },
  ];
  const left = await menuWindow({ BroadcastChannelClass: SharedBroadcastChannel, entries });
  const right = await menuWindow({ BroadcastChannelClass: SharedBroadcastChannel, entries });
  t.after(() => { left.close(); right.close(); SharedBroadcastChannel.reset(); });

  await left.pickTheme("night-city");
  await right.flush();
  assert.equal(right.themeId, "night-city");
  assert.equal(right.window.localStorage.getItem("heigeCodexSkinSelected"), "night-city");

  await left.pickNative();
  await right.flush();
  assert.equal(right.themeId, null);

  await left.hideMenu();
  await right.flush();
  assert.equal(right.hidden, true);
  assert.equal(right.window.localStorage.getItem("heigeCodexSkinMenuHidden"), "1");

  await left.toggleReadability();
  await right.flush();
  assert.equal(left.readabilityEnabled, false);
  assert.equal(right.readabilityEnabled, false);
  assert.equal(right.window.localStorage.getItem("heigeCodexReadabilityEnabled"), "0");
  assert.equal(
    SharedBroadcastChannel.messages.filter(({ kind }) => kind === "readability").length,
    1,
  );

  await left.disablePersistence();
  await right.flush();
  assert.equal(right.switch.getAttribute("aria-checked"), "false");
  assert.equal(right.controlRevision, left.controlRevision);
  const persistenceMessage = SharedBroadcastChannel.messages.find(({ kind }) => kind === "persistence");
  assert.deepEqual(Object.keys(persistenceMessage).sort(), [
    "kind", "schemaVersion", "senderGeneration", "sequence", "value",
  ]);
  assert.doesNotMatch(JSON.stringify(persistenceMessage), /token|endpoint|43123/i);
});

test("disposing the current generation removes its readability marker", async () => {
  const page = await menuWindow();
  assert.equal(page.readabilityEnabled, true);

  assert.equal(page.runtime.dispose(), true);
  assert.equal(page.document.documentElement.hasAttribute("data-heige-readability"), false);
  page.window.close();
});

test("a menu theme choice renders immediately while durable confirmation is pending", async (t) => {
  const pending = deferredResponse();
  const page = await menuWindow({
    persistenceEnabled: false,
    revision: 7,
    entries: [
      { id: "miku-488137", name: "Miku", accent: "#19c9e5", css: "html { color: #123456; }" },
      { id: "night-city", name: "Night City", accent: "#4455aa", css: "html { color: #eeeeee; }" },
    ],
    fetch: async () => pending.promise,
  });
  t.after(() => page.close());

  await page.openThemeCenter();
  await page.pickTheme("night-city");

  assert.equal(page.themeId, "night-city");
  assert.equal(page.backdrop.hidden, false);
  assert.equal(page.saveState.dataset.state, "saving");
  assert.equal(page.saveState.textContent, "正在保存");
  assert.equal(page.currentHero.dataset.themeId, "night-city");
  assert.equal(page.window.localStorage.getItem("heigeCodexSkinSelected"), "miku-488137");
  assert.equal(
    page.document.querySelector('[data-heige-theme-id="night-city"]').disabled,
    true,
  );
  assert.equal(page.window.__heigeCodexSkinRuntime.status().themeTransitionPending, true);

  pending.resolve(jsonResponse(200, {
    ok: true,
    persistenceEnabled: false,
    revision: 8,
    themeId: "night-city",
  }));
  await page.flush();

  assert.equal(page.window.localStorage.getItem("heigeCodexSkinSelected"), "night-city");
  assert.equal(page.controlRevision, 8);
  assert.equal(page.saveState.dataset.state, "saved");
  assert.equal(page.saveState.textContent, "已保存");
  assert.equal(page.backdrop.hidden, false);
  assert.equal(page.window.__heigeCodexSkinRuntime.status().themeTransitionPending, false);
});

test("a preset theme immediately updates Codex appearance and writes the native setting", async (t) => {
  const messages = [];
  const page = await menuWindow({
    entries: [
      {
        id: "miku-488137",
        name: "Miku",
        accent: "#19c9e5",
        appearance: "light",
        css: "html { color: #123456; }",
      },
      {
        id: "night-city",
        name: "Night City",
        accent: "#4455aa",
        appearance: "dark",
        css: "html { color: #eeeeee; }",
      },
    ],
    electronBridgeFactory: (window) => ({
      async sendMessageFromView(message) {
        messages.push(structuredClone(message));
        queueMicrotask(() => {
          window.dispatchEvent(new window.MessageEvent("message", {
            data: {
              type: "fetch-response",
              responseType: "success",
              requestId: message.requestId,
              status: 200,
              headers: { "content-type": "application/json" },
              bodyJsonString: JSON.stringify({ success: true }),
            },
          }));
        });
      },
    }),
  });
  t.after(() => page.close());
  messages.length = 0;

  await page.pickTheme("night-city");

  assert.equal(page.document.documentElement.classList.contains("electron-dark"), true);
  assert.equal(page.document.documentElement.classList.contains("electron-light"), false);
  const appearanceRequest = messages.find((message) =>
    message.type === "fetch" && message.url === "vscode://codex/set-setting");
  assert.ok(appearanceRequest);
  assert.deepEqual(JSON.parse(appearanceRequest.body), {
    key: "appearanceTheme",
    value: "dark",
  });
});

test("a menu theme choice persists the authoritative theme revision", async (t) => {
  const requests = [];
  const page = await menuWindow({
    persistenceEnabled: false,
    revision: 7,
    entries: [
      {
        id: "miku-488137",
        name: "Miku 488137",
        accent: "#19c9e5",
        css: "html { color: #123456; }",
      },
      {
        id: "night-city",
        name: "Night City",
        accent: "#4455aa",
        css: "html { color: #eeeeee; }",
      },
    ],
    fetch: async (url, options) => {
      requests.push({ url: String(url), body: JSON.parse(options.body) });
      return jsonResponse(200, {
        ok: true,
        persistenceEnabled: false,
        revision: 8,
        themeId: "night-city",
      });
    },
  });
  t.after(() => page.close());

  await page.pickTheme("night-city");

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://127.0.0.1:43123/v1/theme");
  assert.equal(requests[0].body.revision, 7);
  assert.equal(requests[0].body.themeId, "night-city");
  assert.match(requests[0].body.requestId, /^[0-9a-f]{32}$/);
  assert.equal(page.themeId, "night-city");
  assert.equal(page.controlRevision, 8);
  assert.equal(page.window.localStorage.getItem("heigeCodexSkinSelected"), "night-city");
});

test("a renderer-blocked theme request keeps its optimistic theme until controller confirmation", async (t) => {
  const page = await menuWindow({
    persistenceEnabled: false,
    revision: 7,
    entries: [
      { id: "miku-488137", name: "Miku", accent: "#19c9e5", css: "html { color: #123456; }" },
      { id: "night-city", name: "Night City", accent: "#4455aa", css: "html { color: #eeeeee; }" },
    ],
    fetch: async () => { throw new Error("Failed to fetch"); },
  });
  t.after(() => page.close());

  await page.pickTheme("night-city");

  const request = page.window.__heigeCodexSkinRuntime.status().controlRequest;
  assert.deepEqual(JSON.parse(JSON.stringify(request)), {
    schemaVersion: 1,
    requestId: request.requestId,
    action: "set-theme",
    capability: request.capability,
    expectedRevision: 7,
    themeId: "night-city",
  });
  assert.match(request.requestId, /^[0-9a-f]{32}$/);
  assert.match(request.capability, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(page.themeId, "night-city");
  assert.equal(page.window.localStorage.getItem("heigeCodexSkinSelected"), "miku-488137");
  assert.match(page.alert.textContent, /后台确认/);
  assert.equal(page.window.__heigeCodexSkinRuntime.status().themeTransitionPending, true);
  assert.equal(
    page.document.querySelector('[data-heige-theme-id="night-city"]').disabled,
    false,
  );
});

test("renderer fallback stays interactive and coalesces rapid theme choices to the latest one", async (t) => {
  const page = await menuWindow({
    persistenceEnabled: false,
    revision: 7,
    entries: [
      { id: "miku-488137", name: "Miku", accent: "#19c9e5", css: "html { color: #123456; }" },
      { id: "night-city", name: "Night City", accent: "#4455aa", css: "html { color: #eeeeee; }" },
      { id: "dawn-city", name: "Dawn City", accent: "#e7bf68", css: "html { color: #222222; }" },
    ],
    fetch: async () => { throw new Error("Failed to fetch"); },
  });
  t.after(() => page.close());

  await page.pickTheme("night-city");

  assert.equal(
    page.document.querySelector('[data-heige-theme-id="dawn-city"]').disabled,
    false,
  );

  await page.pickTheme("dawn-city");

  assert.equal(page.themeId, "dawn-city");
  assert.equal(
    page.window.__heigeCodexSkinRuntime.status().controlRequest.themeId,
    "dawn-city",
  );
  assert.equal(
    page.document.querySelector('[data-heige-theme-id="night-city"]').disabled,
    false,
  );
});

test("a delivered theme selection ACK clears the fallback queue as saved", async (t) => {
  const page = await menuWindow({
    persistenceEnabled: false,
    revision: 7,
    entries: [
      { id: "miku-488137", name: "Miku", accent: "#19c9e5", css: "html { color: #123456; }" },
      { id: "night-city", name: "Night City", accent: "#4455aa", css: "html { color: #eeeeee; }" },
    ],
    fetch: async () => { throw new Error("Failed to fetch"); },
  });
  t.after(() => page.close());

  await page.openThemeCenter();
  await page.pickTheme("night-city");

  const pending = page.window.__heigeCodexSkinRuntime.status().controlRequest;
  assert.equal(pending.action, "set-theme");
  assert.equal(pending.themeId, "night-city");
  assert.equal(page.saveState.dataset.state, "saving");
  assert.match(page.alert.textContent, /正在等待后台确认/);

  assert.equal(
    page.window.__heigeCodexSkinRuntime.receiveThemeSelectionResult({
      schemaVersion: 1,
      requestId: pending.requestId,
      themeId: "night-city",
      revision: 8,
      persistenceEnabled: false,
    }),
    true,
  );
  await page.flush();

  assert.equal(page.window.__heigeCodexSkinRuntime.status().controlRequest, null);
  assert.equal(page.controlRevision, 8);
  assert.equal(page.themeId, "night-city");
  assert.equal(page.window.localStorage.getItem("heigeCodexSkinSelected"), "night-city");
  assert.equal(page.saveState.dataset.state, "saved");
  assert.equal(page.saveState.textContent, "已保存");
  assert.match(page.alert.textContent, /主题选择已保存/);
});

test("an authoritative formal theme replaces stale formal storage during background repair", async (t) => {
  const page = await menuWindow({
    activeId: "night-city",
    preferStored: true,
    initialStorage: {
      heigeCodexSkinSelected: "miku-488137",
    },
    entries: [
      { id: "miku-488137", name: "Miku", accent: "#19c9e5", css: "html { color: #123456; }" },
      { id: "night-city", name: "Night City", accent: "#4455aa", css: "html { color: #eeeeee; }" },
    ],
  });
  t.after(() => page.close());

  assert.equal(page.themeId, "night-city");
  assert.equal(page.window.localStorage.getItem("heigeCodexSkinSelected"), "night-city");
});

test("background repair may restore a valid local quick image without changing formal state", async (t) => {
  const custom = {
    name: "Local image",
    dataUrl: `data:image/png;base64,${png(1, 1).toString("base64")}`,
    colors: {
      accent: "#112233",
      secondary: "#223344",
      surface: "#334455",
      text: "#ddeeff",
    },
  };
  const page = await menuWindow({
    activeId: "night-city",
    preferStored: true,
    initialStorage: {
      heigeCodexSkinSelected: "custom-upload",
      heigeCodexCustomTheme: JSON.stringify(custom),
    },
    entries: [
      { id: "miku-488137", name: "Miku", accent: "#19c9e5", css: "html { color: #123456; }" },
      { id: "night-city", name: "Night City", accent: "#4455aa", css: "html { color: #eeeeee; }" },
    ],
  });
  t.after(() => page.close());

  assert.equal(page.themeId, "custom-upload");
  assert.equal(page.document.documentElement.classList.contains("electron-dark"), true);
  assert.equal(page.window.localStorage.getItem("heigeCodexSkinSelected"), "custom-upload");
});

test("a rejected theme request leaves the renderer unchanged and refreshes its revision", async (t) => {
  const page = await menuWindow({
    persistenceEnabled: false,
    revision: 7,
    entries: [
      { id: "miku-488137", name: "Miku", accent: "#19c9e5", css: "html { color: #123456; }" },
      { id: "night-city", name: "Night City", accent: "#4455aa", css: "html { color: #eeeeee; }" },
    ],
    fetch: async () => errorResponse(409, {
      code: "REVISION_CONFLICT",
      message: "状态已发生变化，请重试",
      persistenceEnabled: false,
      revision: 8,
    }),
  });
  t.after(() => page.close());

  await page.pickTheme("night-city");

  assert.equal(page.themeId, "miku-488137");
  assert.equal(page.window.localStorage.getItem("heigeCodexSkinSelected"), "miku-488137");
  assert.equal(page.controlRevision, 8);
  assert.equal(page.alert.textContent, "状态已发生变化，请重试");
  assert.equal(page.currentHero.dataset.themeId, "miku-488137");
  assert.equal(page.saveState.dataset.state, "error");
  assert.match(page.saveState.textContent, /未保存|重试/);
  assert.equal(
    page.document.querySelector('[data-heige-theme-id="night-city"]').disabled,
    false,
  );
});

test("an idempotent theme ACK can restore a formal theme over a local quick image", async (t) => {
  const page = await menuWindow({
    persistenceEnabled: false,
    revision: 7,
    fetch: async () => jsonResponse(200, {
      ok: true,
      persistenceEnabled: false,
      revision: 7,
      themeId: "miku-488137",
    }),
  });
  t.after(() => page.close());
  page.document.documentElement.dataset.heigeCodexSkin = "custom-upload";

  await page.pickTheme("miku-488137");

  assert.equal(page.themeId, "miku-488137");
  assert.equal(page.controlRevision, 7);
  assert.equal(page.alert.textContent, "主题选择已保存。");
});

test("broadcast protocol rejects loops stale sequences unknown fields and malformed values", async (t) => {
  SharedBroadcastChannel.reset();
  const page = await menuWindow({ BroadcastChannelClass: SharedBroadcastChannel });
  t.after(() => { page.close(); SharedBroadcastChannel.reset(); });
  const attacker = new SharedBroadcastChannel("heige-codex-skin-v2");
  t.after(() => attacker.close());
  const senderGeneration = "a".repeat(32);

  attacker.postMessage({
    schemaVersion: 1,
    senderGeneration,
    sequence: 2,
    kind: "theme",
    value: "__heige_native__",
  });
  await page.flush();
  assert.equal(page.themeId, null);

  attacker.postMessage({
    schemaVersion: 1,
    senderGeneration,
    sequence: 1,
    kind: "theme",
    value: "miku-488137",
  });
  attacker.postMessage({
    schemaVersion: 1,
    senderGeneration,
    sequence: 3,
    kind: "menu-hidden",
    value: "yes",
  });
  attacker.postMessage({
    schemaVersion: 1,
    senderGeneration,
    sequence: 4,
    kind: "theme",
    value: "miku-488137",
    token: "must-not-be-accepted",
  });
  attacker.postMessage({
    schemaVersion: 1,
    senderGeneration: page.window.__heigeCodexSkin.generation,
    sequence: 99,
    kind: "theme",
    value: "miku-488137",
  });
  attacker.postMessage({
    schemaVersion: 2,
    senderGeneration: "b".repeat(32),
    sequence: 1,
    kind: "theme",
    value: "miku-488137",
  });
  attacker.postMessage({
    schemaVersion: 1,
    senderGeneration: "c".repeat(32),
    sequence: 1,
    kind: "unknown",
    value: true,
  });
  attacker.postMessage({
    schemaVersion: 1,
    senderGeneration: "d".repeat(32),
    sequence: 1,
    kind: "persistence",
    value: { enabled: false, revision: 99, endpoint: "http://attacker.invalid" },
  });
  await page.flush();
  assert.equal(page.themeId, null, "stale and extra-field messages are inert");
  assert.equal(page.hidden, false, "malformed hidden value is inert");
  assert.equal(SharedBroadcastChannel.messages.length, 8, "remote changes never echo back");
});

test("storage compatibility events update theme and hidden state without broadcast loops", async (t) => {
  SharedBroadcastChannel.reset();
  const page = await menuWindow({ BroadcastChannelClass: SharedBroadcastChannel });
  t.after(() => { page.close(); SharedBroadcastChannel.reset(); });
  const storageEvent = (key, newValue) => {
    const event = new page.window.Event("storage");
    Object.defineProperties(event, {
      key: { value: key },
      newValue: { value: newValue },
    });
    page.window.dispatchEvent(event);
  };
  storageEvent("heigeCodexSkinSelected", "__heige_native__");
  storageEvent("heigeCodexSkinMenuHidden", "1");
  await page.flush();
  assert.equal(page.themeId, null);
  assert.equal(page.hidden, true);
  assert.equal(SharedBroadcastChannel.messages.length, 0);
});

test("theme center keeps persistence controls fixed outside its scrolling region", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());
  const scroll = page.document.querySelector('[data-heige-role="theme-center-scroll"]');
  const footer = page.document.querySelector('[data-heige-role="theme-center-footer"]');
  assert.equal(scroll.contains(page.switch), false);
  assert.equal(footer.contains(page.switch), true);
  assert.equal(footer.contains(page.document.querySelector('[data-heige-role="hide-trigger"]')), true);
});

test("reinjection removes the old theme center style backdrop and focus handlers", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());
  const oldRuntime = page.window.__heigeCodexSkinRuntime;
  const oldStyle = page.document.querySelector('[data-heige-role="theme-center-style"]');
  const oldBackdrop = page.backdrop;
  await page.injectAgain();
  assert.equal(oldStyle.isConnected, false);
  assert.equal(oldBackdrop.isConnected, false);
  assert.throws(() => oldRuntime.status(), /disposed|generation/i);
  assert.equal(page.document.querySelectorAll('[data-heige-role="theme-center-style"]').length, 1);
  assert.equal(page.document.querySelectorAll('[data-heige-role="theme-center-backdrop"]').length, 1);
});

test("reinjection restores an open theme center after a mid-switch repair", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());
  await page.openThemeCenter();
  assert.equal(page.backdrop.hidden, false);
  assert.equal(page.window.sessionStorage.getItem("heigeCodexThemeCenterOpen"), "1");

  await page.injectAgain();
  assert.equal(page.backdrop.hidden, false);
  assert.equal(page.panel.style.display, "grid");
  assert.equal(page.trigger.getAttribute("aria-expanded"), "true");
});

test("closing the theme center clears the reopen marker", async (t) => {
  const page = await menuWindow();
  t.after(() => page.close());
  await page.openThemeCenter();
  page.closeButton.click();
  await page.flush();
  assert.equal(page.window.sessionStorage.getItem("heigeCodexThemeCenterOpen"), null);
  await page.injectAgain();
  assert.equal(page.backdrop.hidden, true);
});
