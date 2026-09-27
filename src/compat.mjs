import { CdpSession, fetchRendererTargets } from "./cdp-client.mjs";
import { COMPAT_ANCHORS } from "./compat-anchors.mjs";
import { classifyCodexTargets } from "./target-classifier.mjs";

export function buildCompatExpression() {
  return `(() => ${JSON.stringify(COMPAT_ANCHORS)}.map((anchor) => {
    const nodes = new Set();
    const candidates = anchor.selectors.map((selector) => {
      const matches = document.querySelectorAll(selector);
      matches.forEach((node) => nodes.add(node));
      return { selector, count: matches.length };
    });
    return { ...anchor, candidates, count: nodes.size, ok: nodes.size > 0 };
  }))()`;
}

export async function runCompat({ port, deps = {} }) {
  const report = {
    schemaVersion: 1,
    timestamp: (deps.now ?? (() => new Date()))().toISOString(),
    codexVersion: null,
    versionSource: "installed-app-metadata",
    port,
    ok: false,
    warnings: [],
    targets: [],
  };
  try {
    report.codexVersion = await deps.readVersion?.() ?? null;
  } catch {}
  if (!report.codexVersion) report.warnings.push("无法读取 Codex 版本，请从关于页补充；不会使用 Chromium 版本代替。");
  try {
    const targets = classifyCodexTargets(await (deps.fetchRendererTargets ?? fetchRendererTargets)(port))
      .filter((target) => target.kind === "main");
    if (targets.length === 0) throw new Error("未发现 Codex 主窗口，请确认调试端口已开启且对话窗口已打开。");
    const Session = deps.Session ?? CdpSession;
    for (const target of targets) {
      const result = { id: target.id ?? null, ok: false, anchors: [] };
      let session;
      try {
        session = new Session(target.webSocketDebuggerUrl);
        await session.open();
        const anchors = await session.evaluate(buildCompatExpression());
        if (!Array.isArray(anchors) || anchors.length !== COMPAT_ANCHORS.length
          || anchors.some((anchor, index) => anchor.id !== COMPAT_ANCHORS[index].id
            || !Number.isInteger(anchor.count) || anchor.count < 0
            || anchor.ok !== (anchor.count > 0)
            || !Array.isArray(anchor.candidates)
            || anchor.candidates.length !== COMPAT_ANCHORS[index].selectors.length
            || anchor.candidates.some((candidate, candidateIndex) =>
              candidate.selector !== COMPAT_ANCHORS[index].selectors[candidateIndex]
              || !Number.isInteger(candidate.count) || candidate.count < 0))) {
          throw new Error("巡检返回了无效的锚点计数");
        }
        result.anchors = anchors;
        result.ok = anchors.every((anchor) => anchor.ok);
      } catch (error) {
        result.error = error.message;
      } finally {
        session?.close();
      }
      report.targets.push(result);
    }
    report.ok = report.targets.every((target) => target.ok);
  } catch (error) {
    report.error = error.message;
  }
  return report;
}

export function formatCompatReport(report) {
  const lines = [
    `${report.ok ? "✅" : "❌"} Codex DOM 兼容巡检：${report.ok ? "通过" : "未通过"}`,
    `Codex 版本：${report.codexVersion ?? "未知"}（安装元数据）`,
    `时间：${report.timestamp}，端口：${report.port}`,
    ...report.warnings.map((warning) => `⚠️ ${warning}`),
  ];
  if (report.error) lines.push(`❌ ${report.error}`);
  if (report.error && report.targets.length === 0) {
    lines.push("下一步：先应用一次皮肤（macOS 运行 scripts/apply.command，Windows 运行 scripts\\windows\\apply.ps1），让 Codex 带本机调试端口启动，再重新巡检。");
  }
  for (const target of report.targets) {
    lines.push(`${target.ok ? "✅" : "❌"} 主窗口：${target.id ?? "未知"}`);
    if (target.error) lines.push(`❌ ${target.error}`);
    for (const anchor of target.anchors) {
      lines.push(`${anchor.ok ? "✅" : "❌"} ${anchor.id}：${anchor.count}，${anchor.description}`);
      for (const candidate of anchor.candidates) lines.push(`  ${candidate.selector}：${candidate.count}`);
      if (!anchor.ok) lines.push(`  影响：${anchor.impact}`);
    }
  }
  lines.push("⚠️ 请在侧栏展开、已有一轮完整问答的对话页检查；缺失也可能由页面状态造成。全部命中不代表视觉效果已验收。");
  return lines.join("\n");
}
