---
name: heige-codex-skin-studio
description: 在 macOS 上用一张本地图片或 Codex 生成的图片快速制作、应用、暂停 Codex Desktop 皮肤。用户提到 Codex 换肤、主题、皮肤主图、初音未来预设或 Miku Future 宠物时使用。
---

# HeiGe Codex Skin Studio

目标是快速完成换肤。不要扩展成设计平台，不要拆分多层素材，不要修改 `app.asar`。

## 首次安装

运行：

```bash
open "$HOME/.agents/skills/heige-codex-skin-studio/scripts/install.command"
```

安装位置固定为 `~/.codex/heige-codex-skin-studio`。

## 用户给了一张图片

1. 确认图片是非空的 PNG、JPG、JPEG 或 WebP。
2. 使用 Codex 自带的 Node 创建主题：

```bash
"/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" \
  "$HOME/.codex/heige-codex-skin-studio/src/cli.mjs" create \
  --image "/绝对路径/hero.webp" --name "主题名"
```

3. 从返回 JSON 读取 `id`。
4. 告知用户应用操作会正常退出并重新打开当前 Codex。
5. 用户已要求立即应用时，打开应用脚本并传入 `id`：

```bash
open "$HOME/.codex/heige-codex-skin-studio/scripts/apply.command" --args "主题-id"
```

## 用户只给了创意描述

先使用当前环境可用的 `imagegen` 技能生成一张完整的横向 UI 主图。画面要预留左侧导航和底部输入区的可读空间，不要把按钮、菜单文字或聊天内容烘焙进图片。拿到本地图片路径后，继续执行「用户给了一张图片」。

图片生成不可用时，直接请用户给一张本地图片，不要要求额外 API Key。

## 内置预设

默认预设是高精度定制的 `miku-488137`，另有 8 个轻量预设（配色 + 背景底图）：
`genshin-dawn`、`genshin-night`、`wuthering-tide`、`wuthering-echo`、`naruto-hokage`、`naruto-sasuke`、`deepspace-dawn`、`deepspace-star`。

```bash
open "$HOME/.codex/heige-codex-skin-studio/scripts/apply.command" --args "miku-488137"
```

应用任意一个后，其余预设都在右上角 🎨 菜单里一键切换。

## 界面内切换菜单

应用任意主题后，Codex 右上角会出现一个 🎨 按钮。点开可以在所有已装主题和原生界面之间即时切换，不需要再跑命令。新建主题后重新执行一次 `apply.command`，菜单列表会刷新。

菜单里的「＋ 自定义图片」支持用户直接上传本地图片：页面内自动压缩、按图片风格提取配色并立即应用，结果存在 Codex 本地存储里，重启后重新 apply 会自动回到菜单；菜单里该行行尾的 × 可随时删除。自定义槽位只有一个，再次上传会覆盖上一张。用户只是想快速试一张图时优先推荐这个入口；要做成可分发的正式主题再走 `create` 命令。

## 暂停或恢复原界面

```bash
open "$HOME/.codex/heige-codex-skin-studio/scripts/pause.command"
```

这里只移除实时注入的 `<style>` 和切换菜单，因为工具从未修改 Codex 应用文件。

## 可选宠物

仅当用户明确需要 `Miku Future` 宠物时运行：

```bash
open "$HOME/.codex/heige-codex-skin-studio/custom-pet/install.command"
```

## 边界

- 当前只支持 macOS。
- CDP 固定监听 `127.0.0.1`，默认端口 `9341`。
- Codex 完整重载 renderer 后需要重新应用一次。
- 不修改应用包，不做 ASAR 注入，不处理 Windows 或 Linux。
