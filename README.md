# HeiGe Codex Skin Studio

一个效率优先的 macOS Codex 换肤工具。给它一张图片，几秒钟做成主题并通过本机 CDP 实时注入。它不修改 `app.asar`，不破坏应用签名，也不需要为每次 Codex 更新重新适配安装包。

![HeiGe Codex Skin Studio 的初音未来预览](assets/previews/miku-studio.webp)

## 现在能做什么

- 一张 PNG、JPG、JPEG 或 WebP 直接生成皮肤。
- 应用后 Codex 右上角出现 🎨 菜单，点击即可在已装主题和原生界面之间即时切换。
- 菜单里选「＋ 自定义图片」直接上传本地图片：自动按图片风格取色（主色、辅色、面板底色、文字色），即点即换，重启后重新 apply 仍会保留。
- 自带 9 个预设：高精度定制的 `Miku 488137`，以及原神、鸣潮、火影忍者、恋与深空各两款轻量主题（配色 + 背景底图）。
- 自动正常退出 Codex，再以仅监听 `127.0.0.1:9341` 的 CDP 模式重新打开。
- 一键暂停并恢复 Codex 原始界面。
- 可选安装独立的 `Miku Future` 宠物。
- 让 Codex 先用图片生成能力产出主图，再交给本工具安装。

## 最快使用

需要 macOS 和已安装的 Codex Desktop。

```bash
open "$HOME/Downloads/heige-codex-skin-studio/scripts/install.command"
```

安装脚本会把工具放到 `~/.codex/heige-codex-skin-studio`，并默认应用初音未来预设。应用皮肤时 Codex 会被正常退出并重新打开，当前任务请先保存。

安装后，选择任意图片做新皮肤：

```bash
open "$HOME/.codex/heige-codex-skin-studio/scripts/customize.command"
```

暂停皮肤：

```bash
open "$HOME/.codex/heige-codex-skin-studio/scripts/pause.command"
```

## 交给 Codex 使用

把 `heige-codex-skin-studio.skill` 交给 Codex，可以直接说：

> 用这张图片给 Codex 做一个皮肤并应用。

或者：

> 先生成一张蓝紫色赛博城市主图，再把它做成 Codex 皮肤。

Skill 会优先调用 Codex 当前可用的图片生成能力生成一张完整主图，然后调用本地确定性工具创建并应用主题。换肤本身不需要额外 API Key。

## 极简主题格式

```json
{
  "schemaVersion": 1,
  "id": "my-skin",
  "name": "My Skin",
  "hero": "hero.webp",
  "colors": {
    "accent": "#24C9D7",
    "secondary": "#EF8FD3",
    "surface": "#F7FBFF",
    "text": "#17344F"
  },
  "copy": {
    "brand": "My Codex",
    "headline": "今天构建什么？"
  }
}
```

只有 `schemaVersion`、`id`、`name` 和 `hero` 必填。图片必须位于主题目录内，颜色和文案都可省略。

## 概念预览

这些图片用于展示「一张图就是一个皮肤方向」，不作为默认可安装素材分发。

| 原神 | 原神 |
| --- | --- |
| ![原神 Codex UI 概念一](assets/previews/genshin-impact-codex-ui-1.webp) | ![原神 Codex UI 概念二](assets/previews/genshin-impact-codex-ui-2.webp) |

| 鸣潮 | 鸣潮 |
| --- | --- |
| ![鸣潮 Codex UI 概念一](assets/previews/wuthering-waves-codex-ui-1.webp) | ![鸣潮 Codex UI 概念二](assets/previews/wuthering-waves-codex-ui-2.webp) |

| 火影忍者 | 火影忍者 |
| --- | --- |
| ![火影忍者 Codex UI 概念一](assets/previews/naruto-codex-ui-1.webp) | ![火影忍者 Codex UI 概念二](assets/previews/naruto-codex-ui-2.webp) |

| 恋与深空 | 恋与深空 |
| --- | --- |
| ![恋与深空 Codex UI 概念一](assets/previews/love-and-deepspace-codex-ui-1.webp) | ![恋与深空 Codex UI 概念二](assets/previews/love-and-deepspace-codex-ui-2.webp) |

## 命令行

```bash
node src/cli.mjs list
node src/cli.mjs create --image "/absolute/path/hero.webp" --name "My Skin"
node src/cli.mjs apply --theme my-skin-id
node src/cli.mjs status
node src/cli.mjs pause
node src/cli.mjs doctor
```

## 设计边界

这是一个轻量工具，不是主题商店或复杂设计平台。皮肤跟随当前 renderer 存活，Codex 完整重载界面后重新运行一次 `apply.command` 即可。当前版本只保证 macOS，且 CDP 只绑定本机回环地址。

旧版 ASAR 修改器已保存在 Git 标签 `v5-full-legacy` 和分支 `codex/archive-asar-v5`，不再作为主产品维护。

## 开发

```bash
npm test
npm run doctor
```

## 许可证与素材

代码使用 [MIT License](LICENSE)。预览中的角色、名称和视觉素材权利属于各自权利人，仅用于主题概念展示，不由本项目的软件许可证授权，详见 [NOTICE.md](NOTICE.md)。
