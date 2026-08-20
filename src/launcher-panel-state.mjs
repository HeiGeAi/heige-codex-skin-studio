function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} 必须是非空字符串`);
  }
  return value;
}

export function buildLauncherPanelState({
  profile,
  discovery,
  studioState,
  themes,
  defaultThemeId,
} = {}) {
  if (profile === null || typeof profile !== "object" || Array.isArray(profile)) {
    throw new TypeError("profile 必须是产品档案");
  }
  const product = nonEmptyString(profile.id, "profile id");
  const productName = nonEmptyString(profile.label, "profile label");
  if (typeof profile.supportsControlChannel !== "boolean") {
    throw new TypeError("profile supportsControlChannel 必须是布尔值");
  }
  if (discovery === null || typeof discovery !== "object" || Array.isArray(discovery)) {
    throw new TypeError("discovery 必须是对象");
  }
  if (typeof discovery.appFound !== "boolean") {
    throw new TypeError("discovery appFound 必须是布尔值");
  }
  if (discovery.appFound && (typeof discovery.app !== "string" || discovery.app.length === 0)) {
    throw new TypeError("discovery app 必须是已安装 APP 路径");
  }
  if (!Array.isArray(themes)) throw new TypeError("themes 必须是数组");
  defaultThemeId = nonEmptyString(defaultThemeId, "defaultThemeId");

  let themeId = defaultThemeId;
  if (studioState !== null && studioState !== undefined) {
    if (typeof studioState !== "object" || Array.isArray(studioState)) {
      throw new TypeError("studioState 必须是对象或 null");
    }
    if (Object.hasOwn(studioState, "lastNonNativeThemeId")) {
      themeId = nonEmptyString(
        studioState.lastNonNativeThemeId,
        "studioState lastNonNativeThemeId",
      );
    }
  }

  const selected = themes.find((theme) => theme?.id === themeId);
  const themeName = typeof selected?.name === "string" && selected.name.length > 0
    ? selected.name
    : themeId;

  return {
    schemaVersion: 1,
    product,
    productName,
    appInstalled: discovery.appFound,
    appPath: discovery.appFound ? discovery.app : null,
    themeId,
    themeName,
    mode: profile.supportsControlChannel ? "session" : "one-shot",
  };
}
