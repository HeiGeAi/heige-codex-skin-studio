# HeiGe Codex Skin Studio

<p align="center">
  <a href="./README.md">中文</a> · <strong>English</strong>
</p>

<div align="center">

**Your coding window should look the way you like.**

One image becomes one theme. After install, switching skins is a single click in the top menu, and one click restores the official UI.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-black)
![Codex Desktop](https://img.shields.io/badge/Codex-Desktop-10a37f)

</div>

![Live screenshot: Miku theme with the top theme menu](docs/images/theme-switcher-live.webp)

*Live screenshot: the Miku 488137 preset. The top-center menu opens the theme center.*

![Live screenshot: theme center](docs/images/theme-center-live.webp)

*Live screenshot: the theme center. Current theme, custom image slot, native UI, built-in previews, readability enhancement, and persistence controls, all in one panel.*

## What it is

A local skin switcher for OpenAI Codex Desktop. It injects themes at runtime through loopback Chrome DevTools Protocol (`127.0.0.1:9341`) and never modifies `app.asar`, application binaries, or signature resources. Sidebar, suggestion cards, and the composer stay fully native and interactive.

- **One-click switching**: a 🎨 menu appears at the top of Codex; every installed theme and the native UI switch instantly, with light/dark appearance synced automatically.
- **One image, one theme**: any PNG, JPG, JPEG, or WebP becomes a full skin (palette + backdrop).
- **AI-generated themes**: hand `output/heige-codex-skin-studio.skill` to Codex and say "generate a cyberpunk hero image, then turn it into a skin". No extra API key needed.
- **10 built-in presets**: the high-detail `Miku 488137`, two lightweight themes each for Genshin Impact, Wuthering Waves, Naruto, and Love and Deepspace, plus one easter-egg preset.
- **Optional pet**: the package ships an independent `Miku Future` animated desktop pet. Installing it is your call.
- **User-controlled persistence**: the top-menu switch is the only supported way to enable next-launch persistence. Turning it off keeps the current session skinned and restores the native UI on the next launch.
- **Readability by default**: final and in-progress assistant responses use one consistent 90% theme-aware surface with balanced inset spacing. The Theme Center switch can turn it off, and the implementation avoids live blur, shadows, observers, scroll listeners, and background requests.

## Quick start

macOS (requires an installed Codex Desktop):

```bash
open "<repo-path>/scripts/install.command"
```

Windows: run `scripts\windows\install.bat`, then use `scripts/windows/apply.ps1`, the session-only compatibility entry `scripts/windows/enable-skin.bat`, `scripts/windows/pause.ps1`, `scripts/windows/resume.ps1`, and `scripts/windows/restore.ps1`. Microsoft Store/MSIX activation is implemented but still pending live-machine validation.

Applying a skin quits Codex normally and relaunches it with a local debug port, so save your work first. A system Node runtime must be Node.js 22 or newer.

## Make your own theme

1. Upload any image through the 🎨 menu ("＋ 自定义图片"): colors and appearance are picked automatically. This slot is a single local quick slot, not a durable distributable theme.
2. Run `customize.command` to turn an image into a full saved theme.
3. Give the `.skill` package to Codex and let it generate the artwork and build the theme end to end.

Ready-to-copy image prompts live in the [theme prompt gallery](docs/theme-prompts.md) (Chinese). Share your results in the [showcase discussions](https://github.com/HeiGeAi/heige-codex-skin-studio/discussions).

## Honest notes

- Loopback CDP is unauthenticated; local same-user processes remain inside the threat boundary. See [SECURITY.md](SECURITY.md).
- macOS has dated live-machine evidence. Windows is covered by cross-PowerShell automation, while Microsoft Store/MSIX remains pending live validation.
- Future Codex Desktop changes to startup arguments, renderer structure, or selectors may require adaptation.
- Full manual (CLI, theme JSON schema, persistence semantics, FAQ): [docs/manual.md](docs/manual.md) (Chinese).

## License and assets

Code is under the [MIT License](LICENSE). The license covers software code only and grants no rights to characters, trademarks, or third-party artwork. Per-file provenance lives in [ASSET_PROVENANCE.md](ASSET_PROVENANCE.md); release boundaries in [NOTICE.md](NOTICE.md).

Built by [HeiGeAi](https://github.com/HeiGeAi). More open-source projects on the org page.

---

**If you like it, star it. When your skin looks good, post a screenshot in the [showcase](https://github.com/HeiGeAi/heige-codex-skin-studio/discussions).**
