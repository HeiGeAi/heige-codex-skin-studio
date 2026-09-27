// 候选必须来自真实皮肤依赖。不要添加泛化兜底，否则会掩盖样式选择器失配。
export const COMPAT_ANCHORS = [
  {
    id: "electron-root",
    selectors: [':root[data-codex-window-type="electron"]'],
    description: "桌面窗口主题根节点",
    impact: "主题颜色变量可能无法生效。",
  },
  {
    id: "app-root",
    selectors: ["#root"],
    description: "应用背景根节点",
    impact: "背景图和品牌文字可能消失。",
  },
  {
    id: "left-panel",
    selectors: [".app-shell-left-panel"],
    description: "左侧栏（请展开侧栏）",
    impact: "侧栏底色和边框可能恢复原生样式。",
  },
  {
    id: "main-surface",
    selectors: [".main-surface", ".browser-main-surface", '[data-app-shell-main-surface="default"]'],
    description: "主内容区（新旧锚点任一命中）",
    impact: "原生不透明底色可能遮住背景图。",
  },
  {
    id: "composer",
    selectors: [".composer-surface-chrome"],
    description: "输入框外层表面（请打开可输入的对话）",
    impact: "输入区域可能失去主题底色、边框和文字配色。",
  },
  {
    id: "user-bubble",
    selectors: ["[data-user-message-bubble]"],
    description: "用户消息气泡（需有用户消息）",
    impact: "用户消息可能失去主题气泡样式。",
  },
  {
    id: "assistant-response",
    selectors: ["[data-local-conversation-final-assistant]", "[data-response-annotation-conversation]"],
    description: "助手回复区域（需有已完成回复）",
    impact: "回复底色透明化或阅读增强可能失效。",
  },
];
