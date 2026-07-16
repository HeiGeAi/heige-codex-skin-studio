import { homedir } from "node:os";
import { join } from "node:path";

export const PRODUCT_ID = "heige-codex-skin-studio";
export const PRODUCT_NAME = "HeiGe Codex Skin Studio";
export const STATE_SCHEMA_VERSION = 1;
export const THEME_SCHEMA_VERSION = 1;
export const DEFAULT_THEME_ID = "miku-488137";
export const DEFAULT_CDP_PORT = 9341;
export const EXPECTED_BUNDLE_ID = "com.openai.codex";
export const EXPECTED_TEAM_ID = "2DC432GLL2";

export function resolveStudioPaths({ home = homedir() } = {}) {
  const installRoot = join(home, ".codex", PRODUCT_ID);
  const stateRoot = join(
    home,
    "Library",
    "Application Support",
    "HeiGeCodexSkinStudio",
  );

  return {
    installRoot,
    stateRoot,
    statePath: join(stateRoot, "state.json"),
    logPath: join(stateRoot, "injector.log"),
    userThemesRoot: join(stateRoot, "themes"),
  };
}
