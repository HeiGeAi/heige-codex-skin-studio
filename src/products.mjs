import { homedir } from "node:os";
import { posix, win32 } from "node:path";

// 产品档案层：所有「跟具体宿主应用绑死」的事实只在这里出现一次。
// 上层模块（注入、生命周期、状态、CLI）一律读档案字段，不再写死 Codex。
//
// 新增一个宿主应用 = 在 PROFILES 里加一条 + 写一份皮肤 CSS 档案，其余代码不动。

export const DEFAULT_PRODUCT_ID = "codex";

const CODEX = {
  id: "codex",
  // label 会进错误文案。Codex 侧必须保持 "Codex" 原字，否则既有用例和用户认知全变。
  label: "Codex",
  appDisplayName: "Codex（ChatGPT.app）",
  defaultCdpPort: 9341,
  rendererOrigin: "app://-",
  expectedBundleId: "com.openai.codex",
  expectedTeamId: "2DC432GLL2",
  appPathEnvVar: "HEIGE_CODEX_APP",
  // macOS 可执行文件名：Codex 用产品名，WorkBuddy 用 Electron 默认名
  macExecutableName: "ChatGPT",
  macAppNames: ["ChatGPT.app"],
  windowsExecutableNames: ["ChatGPT.exe", "Codex.exe"],
  windowsDirNames: ["ChatGPT", "Codex"],
  // Codex 读命令行参数开调试端口，端口号因此在 ps 里可见
  cdpLaunch: { kind: "args" },
  cdpPortVisibleInArgs: true,
  // 渲染进程能不能回调本机控制服务（常驻开关、发布自定义主题都走它）。
  // 控制服务只认 Origin: app://-（control-server.mjs 双重校验），这是防 CSRF 的硬闸门。
  supportsControlChannel: true,
  // 主题中心里露给用户看的两句话：改外观配色的指路，和「原生」那一项的名字
  menuAppearanceHelp: "字体颜色显示不对？这通常是 Codex 本体的外观配色不匹配。点击左下角头像👉设置👉外观👉选择 浅色/深色 主题✅即可。",
  menuNativeLabel: "原生 Codex",
  // Codex 自带 node，常驻代理直接复用它，避免依赖用户机器上的 node
  bundledNodeRelativePaths: [
    ["Contents", "Resources", "cua_node", "bin", "node"],
    ["Contents", "Resources", "cua_node", "node"],
  ],
  windowsBundledNodeRelativePaths: [
    ["resources", "cua_node", "node.exe"],
    ["resources", "cua_node", "bin", "node.exe"],
  ],
  // 状态与安装位点：Codex 侧保持历史路径一字不改，老用户升级不迁移不丢数据
  installHomeDirName: ".codex",
  stateDirName: "HeiGeCodexSkinStudio",
  windowsVerified: true,
};

const WORKBUDDY = {
  id: "workbuddy",
  label: "WorkBuddy",
  appDisplayName: "WorkBuddy（腾讯 CodeBuddy 桌面端）",
  // 跟 Codex 的 9341 错开，两个产品可以同时开着各自的调试端口
  defaultCdpPort: 9342,
  // Vite 打包后走 loadFile，renderer 是 app.asar 里的本地文件
  rendererOrigin: "file://",
  expectedBundleId: "com.workbuddy.workbuddy",
  expectedTeamId: "FN2V63AD2J",
  appPathEnvVar: "HEIGE_WORKBUDDY_APP",
  macExecutableName: "Electron",
  macAppNames: ["WorkBuddy.app"],
  // Windows 侧未在真机验证，见 docs/manual.md 的未验证声明
  windowsExecutableNames: ["WorkBuddy.exe"],
  windowsDirNames: ["WorkBuddy"],
  // WorkBuddy 主进程读环境变量再自己 appendSwitch，命令行参数里看不到端口
  cdpLaunch: { kind: "env", name: "WORKBUDDY_REMOTE_DEBUGGING_PORT" },
  cdpPortVisibleInArgs: false,
  // renderer 是 file://，发请求带的是 Origin: null。放行 null 等于把控制服务的
  // 来源校验掏空，所以这版直接不开控制通道：WorkBuddy 只做一次性皮肤，
  // 主题在页面内本地切换，不常驻、不回调。宁可少个功能，不动 CSRF 闸门。
  supportsControlChannel: false,
  // WorkBuddy 的外观开关在设置页的外观面板（app.asar 里的 settings.appearance.*），
  // 具体几级菜单没在真机逐级核过，所以只指到面板，不照抄 Codex 那串点击路径
  menuAppearanceHelp: "字体颜色显示不对？这通常是 WorkBuddy 本体的外观配色不匹配。打开 WorkBuddy 设置里的「外观」，切换 浅色/深色✅即可。",
  menuNativeLabel: "原生 WorkBuddy",
  // WorkBuddy 只带 node.tar.gz 压缩包，没有可直接执行的 node，常驻走系统 node
  bundledNodeRelativePaths: [],
  windowsBundledNodeRelativePaths: [],
  installHomeDirName: ".workbuddy",
  stateDirName: "HeiGeCodexSkinStudio-workbuddy",
  // 没有 LaunchAgent 标签字段：不支持控制通道就不支持常驻，常驻代理压根不会为
  // WorkBuddy 注册。等哪天要开常驻，再连同 macos-launch-agent.mjs 的标签校验一起加
  windowsVerified: false,
};

const PROFILES = new Map([
  [CODEX.id, Object.freeze(CODEX)],
  [WORKBUDDY.id, Object.freeze(WORKBUDDY)],
]);

export const PRODUCT_IDS = Object.freeze([...PROFILES.keys()]);

export function isProductId(value) {
  return typeof value === "string" && PROFILES.has(value);
}

// 统一入口：所有调用点都用这个取档案，传 null/undefined 落到 Codex，
// 保证任何一条没显式传产品的老路径行为跟改造前完全一致。
export function productProfile(product = DEFAULT_PRODUCT_ID) {
  if (product === null || product === undefined) return PROFILES.get(DEFAULT_PRODUCT_ID);
  if (typeof product === "object" && isProductId(product.id)) return PROFILES.get(product.id);
  if (!isProductId(product)) {
    throw new Error(`未知产品：${String(product)}，可选 ${PRODUCT_IDS.join(" / ")}`);
  }
  return PROFILES.get(product);
}

// 从应用路径反推产品。生命周期动作文件、进程校验这些地方只拿得到 appPath，
// 靠这个反推就不用往落盘 schema 里加字段，老的动作文件继续能读。
// 认不出来就落到 Codex：后续的可执行文件校验会失败并明确报错，不会走偏。
export function productForAppPath(appPath, { platform = process.platform } = {}) {
  if (typeof appPath !== "string" || !appPath) return null;
  const separator = platform === "win32" ? /[\\/]/ : /\//;
  const basename = appPath.split(separator).filter(Boolean).pop() ?? "";
  for (const profile of PROFILES.values()) {
    const names = platform === "win32" ? profile.windowsExecutableNames : profile.macAppNames;
    if (names.some((name) => name.toLowerCase() === basename.toLowerCase())) return profile.id;
  }
  return null;
}

export function profileForAppPath(appPath, options = {}) {
  return productProfile(productForAppPath(appPath, options) ?? DEFAULT_PRODUCT_ID);
}

export function productAppCandidates(product, {
  platform = process.platform,
  env = process.env,
  home = homedir(),
} = {}) {
  const profile = productProfile(product);
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA ?? win32.join(home, "AppData", "Local");
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    const user = profile.windowsDirNames.map((dir, index) =>
      win32.join(localAppData, "Programs", dir, profile.windowsExecutableNames[index] ?? profile.windowsExecutableNames[0]));
    const system = profile.windowsDirNames.map((dir, index) =>
      win32.join(programFiles, dir, profile.windowsExecutableNames[index] ?? profile.windowsExecutableNames[0]));
    return [...user, ...system];
  }
  // 无管理员权限时 macOS 标准安装位是 ~/Applications，必须一并探测
  return profile.macAppNames.flatMap((name) => [
    posix.join("/Applications", name),
    posix.join(home, "Applications", name),
  ]);
}

export function productExecutablePath(product, appPath, { platform = process.platform } = {}) {
  const profile = productProfile(product);
  if (platform === "win32") return appPath;
  return posix.join(appPath, "Contents", "MacOS", profile.macExecutableName);
}

export function productBundledNodeCandidates(product, appPath, { platform = process.platform } = {}) {
  const profile = productProfile(product);
  const segments = platform === "win32"
    ? profile.windowsBundledNodeRelativePaths
    : profile.bundledNodeRelativePaths;
  if (platform === "win32") {
    const appDir = win32.dirname(appPath);
    return segments.map((parts) => win32.join(appDir, ...parts));
  }
  return segments.map((parts) => posix.join(appPath, ...parts));
}

// 启动时怎么把调试端口交给宿主：Codex 走命令行参数，WorkBuddy 走环境变量。
// 返回 { args, env }，调用方原样喂给 spawn，不需要知道是哪个产品。
export function productCdpLaunchSpec(product, port) {
  const profile = productProfile(product);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new TypeError("CDP 端口必须是 1024 到 65535 的整数");
  }
  if (profile.cdpLaunch.kind === "env") {
    return { args: [], env: { [profile.cdpLaunch.name]: String(port) } };
  }
  return {
    args: ["--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`],
    env: {},
  };
}
