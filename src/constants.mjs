import { homedir } from "node:os";
import { join } from "node:path";

import { productProfile } from "./products.mjs";

export const PRODUCT_ID = "heige-codex-skin-studio";
export const PRODUCT_NAME = "HeiGe Codex Skin Studio";
export const STATE_SCHEMA_VERSION = 2;
export const THEME_SCHEMA_VERSION = 1;
export const DEFAULT_THEME_ID = "miku-488137";
export const NATIVE_THEME_ID = "__heige_native__";
export const DEFAULT_CDP_PORT = 9341;
export const CODEX_RENDERER_ORIGIN = "app://-";
export const EXPECTED_BUNDLE_ID = "com.openai.codex";
export const EXPECTED_TEAM_ID = "2DC432GLL2";

// 只放行 CSS 认得的三/四/六/八位 hex，5/7 位在 CSS 里是无效色会静默失效
export const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

// 每个宿主产品一套独立的安装位和状态位，互不覆盖：
// Codex 保持历史路径（.codex / HeiGeCodexSkinStudio）一字不改，老用户升级无感；
// WorkBuddy 落在 .workbuddy / HeiGeCodexSkinStudio-workbuddy，主题、会话、锁全部隔离。
export function resolveStudioPaths({
  home = homedir(),
  platform = process.platform,
  env = process.env,
  product = undefined,
} = {}) {
  const profile = productProfile(product);
  const installRoot = join(home, profile.installHomeDirName, PRODUCT_ID);
  const stateRoot =
    platform === "win32"
      ? join(env.APPDATA ?? join(home, "AppData", "Roaming"), profile.stateDirName)
      : join(home, "Library", "Application Support", profile.stateDirName);

  return {
    installRoot,
    stateRoot,
    statePath: join(stateRoot, "state.json"),
    sessionPath: join(stateRoot, "session.json"),
    transitionPath: join(stateRoot, "transition.json"),
    lockPath: join(stateRoot, "operation.lock"),
    logPath: join(stateRoot, "injector.log"),
    userThemesRoot: join(stateRoot, "themes"),
  };
}
