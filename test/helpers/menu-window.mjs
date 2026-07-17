import { Window } from "happy-dom";

import { buildSkinMenuScript } from "../../src/skin-menu.mjs";

const CONTROL_TOKEN = Buffer.alloc(32, 7).toString("base64url");

export function deferredResponse() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return structuredClone(body);
    },
  };
}

export function okResponse({ persistenceEnabled, revision }) {
  return jsonResponse(200, { ok: true, persistenceEnabled, revision });
}

export function errorResponse(status, body) {
  return jsonResponse(status, { ok: false, ...body });
}

export function sequenceFetch(responses, requests = []) {
  let index = 0;
  return async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (index >= responses.length) throw new Error("没有更多测试响应");
    const response = responses[index];
    index += 1;
    return typeof response === "function" ? response() : response;
  };
}

async function flushMicrotasks(window) {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

export async function menuWindow({
  persistenceEnabled = true,
  revision = 7,
  BroadcastChannelClass,
  activeId = "miku-488137",
  preferStored = false,
  initialStorage = {},
  entries = [{
    id: "miku-488137",
    name: "Miku 488137",
    accent: "#19c9e5",
    css: "html { color: #123456; }",
  }],
  fetch,
  sharedStyleCss = ':root{--heige-signature-card-frame-image:url("data:image/png;base64,RlJBTUU=");}',
} = {}) {
  const window = new Window({ url: "app://-/index.html" });
  let backendPersistence = persistenceEnabled;
  let backendRevision = revision;
  window.fetch = fetch ?? (async (url, options) => {
    const body = JSON.parse(options.body);
    backendRevision += 1;
    if (String(url).endsWith("/v1/theme")) {
      return jsonResponse(200, {
        ok: true,
        persistenceEnabled: backendPersistence,
        revision: backendRevision,
        themeId: body.themeId,
      });
    }
    backendPersistence = body.persistenceEnabled;
    return okResponse({
      persistenceEnabled: backendPersistence,
      revision: backendRevision,
    });
  });
  if (BroadcastChannelClass) window.BroadcastChannel = BroadcastChannelClass;
  for (const [key, value] of Object.entries(initialStorage)) {
    window.localStorage.setItem(key, value);
  }
  const buildOptions = {
    styleId: "heige-codex-skin-style",
    menuId: "heige-codex-skin-menu",
    activeId,
    preferStored,
    sharedStyleCss,
    entries,
    control: {
      available: true,
      persistenceEnabled,
      revision,
      endpoint: "http://127.0.0.1:43123/v1/persistence",
      token: CONTROL_TOKEN,
      launcherName: "HeiGe 皮肤启动器",
    },
  };
  const inject = () => window.eval(buildSkinMenuScript(buildOptions));
  inject();

  const query = (role) => window.document.querySelector(`[data-heige-role="${role}"]`);
  const page = {
    window,
    document: window.document,
    get trigger() { return query("menu-trigger") ?? window.document.querySelector("#heige-codex-skin-menu > button"); },
    get panel() { return query("theme-center") ?? query("menu-panel"); },
    get backdrop() { return query("theme-center-backdrop"); },
    get closeButton() { return query("theme-center-close"); },
    get saveState() { return query("save-state"); },
    get currentHero() { return query("current-theme-hero"); },
    get switch() { return query("persistence-switch"); },
    get confirmation() { return query("persistence-confirmation"); },
    get cancel() { return query("persistence-cancel"); },
    get confirm() { return query("persistence-confirm"); },
    get alert() { return query("persistence-alert"); },
    get themeId() { return window.document.documentElement.dataset.heigeCodexSkin ?? null; },
    get hidden() {
      return this.trigger.dataset.hidden === "true";
    },
    get controlRevision() {
      return window.__heigeCodexSkin.getPersistenceState().revision;
    },
    async clickPersistenceSwitch() {
      query("persistence-switch").click();
      await flushMicrotasks(window);
    },
    async clickConfirmOff() {
      query("persistence-confirm").click();
      await flushMicrotasks(window);
    },
    async clickCancelOff() {
      query("persistence-cancel").click();
      await flushMicrotasks(window);
    },
    async enablePersistence() {
      await this.clickPersistenceSwitch();
      await flushMicrotasks(window);
    },
    async disablePersistence() {
      await this.clickPersistenceSwitch();
      await this.clickConfirmOff();
      await flushMicrotasks(window);
    },
    async keyPersistenceSwitch(key) {
      query("persistence-switch").dispatchEvent(new window.KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      }));
      await flushMicrotasks(window);
    },
    async pickTheme(id) {
      window.document.querySelector(`[data-heige-theme-id="${id}"]`).click();
      await flushMicrotasks(window);
    },
    async openThemeCenter() {
      this.trigger.click();
      await flushMicrotasks(window);
    },
    async pickNative() {
      window.document.querySelector('[data-heige-role="native-option"]').click();
      await flushMicrotasks(window);
    },
    async hideMenu() {
      window.__heigeCodexSkin.setHidden(true);
      await flushMicrotasks(window);
    },
    async flush() {
      await flushMicrotasks(window);
    },
    async injectAgain() {
      inject();
      await flushMicrotasks(window);
      return window.__heigeCodexSkinRuntime;
    },
    close() {
      window.__heigeCodexSkinRuntime?.dispose?.();
      window.close();
    },
  };
  return page;
}
