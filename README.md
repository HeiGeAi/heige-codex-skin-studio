# ChatGPT Desktop Skin Studio

AI-orchestrated skins for ChatGPT Desktop on macOS.

This repository contains the `codex-skin-studio` Codex Skill and its zero-dependency Node.js runtime. The Skill turns a generated or user-provided image into a complete ChatGPT Desktop theme, validates the local assets, applies the theme through loopback CDP, and can keep the selected theme alive across app and computer restarts through a macOS LaunchAgent.

The current application is ChatGPT Desktop. Its technical bundle identifier is `com.openai.codex`.

## Highlights

- Text-to-skin orchestration through Codex native image generation.
- Image-to-skin workflows for direct backgrounds, subject preservation, style references, and multi-image composition.
- Five-zone visual contract for safe ChatGPT Desktop composition.
- One-shot theme creation with `hero`, `theme.json`, optional logo, optional portrait card, and optional brand copy.
- Scoped CSS injection that replaces only the top workspace label and preserves project session controls and account controls.
- Local-only CDP communication on `127.0.0.1`.
- Optional macOS LaunchAgent persistence for login, app launch, and renderer reload recovery.
- No `app.asar` modification, code-signature changes, database, website, remote service, or arbitrary theme CSS.
- English-only Skill distribution files; the Skill can respond to users in their language.

## Architecture

```text
User request or reference image
            |
            v
Codex Vision + native image_gen
            |
            v
Final hero + colors + optional assets
            |
            v
create-theme.mjs
            |
            v
validate -> persist -> apply.mjs -> loopback CDP
                                      |
                                      v
                              ChatGPT Desktop
                                      ^
                                      |
                         optional macOS LaunchAgent
```

The Skill is the agent layer. `create-theme.mjs` creates a complete local theme directory. `apply.mjs` discovers the signed ChatGPT Desktop app, selects the main renderer, injects one verified style element, persists the theme, and reports a truthful status. `persist.mjs` runs the long-lived recovery worker when persistence is enabled.

## Repository Layout

```text
skill/codex-skin-studio/
├── SKILL.md
├── agents/openai.yaml
├── scripts/
│   ├── apply.mjs
│   ├── create-theme.mjs
│   └── persist.mjs
├── templates/theme.json
└── examples/cyberpunk/

themes/
└── slayers-xellos-night/

output/
└── codex-skin-studio.skill
```

## Install The Skill

Build the distributable Skill package:

```bash
npm run package:codex-skin-studio
```

The output is `output/codex-skin-studio.skill`. Install that package through the Codex Skill installer, or install the source directory for local development:

```bash
mkdir -p "$HOME/.codex/skills"
rsync -a --delete skill/codex-skin-studio/ "$HOME/.codex/skills/codex-skin-studio/"
```

Skill installation copies files only. It does not start a background process. Persistence starts automatically during the first explicit apply flow, after a theme has been selected.

## User Workflows

### Text-to-skin

Example request:

```text
Create and apply a dark cyberpunk ChatGPT Desktop skin with neon cyan accents.
```

The Skill writes a visual brief, calls native image generation, inspects the result, derives colors, creates the theme directory, applies it, and verifies `active` status.

### Subject-preserving image-to-skin

Example request:

```text
Use the attached character as the subject. Create and apply a Japanese anime ChatGPT Desktop skin. Preserve the face, silhouette, clothing, staff, colors, and proportions. Rebuild the scene around it.
```

The source image is inspected with Vision first. The subject is assigned an explicit role and remains separate from the style and layout constraints.

### Style-reference skin

Example request:

```text
Use this image only as a style reference. Create a new ChatGPT Desktop skin with the same palette, lighting, rendering density, and mood, but do not copy its subject or composition.
```

### Direct background

Example request:

```text
Use this local image directly as the ChatGPT Desktop background and apply it.
```

The Skill checks aspect ratio, safe zones, contrast, text, and watermarks before applying it.

## Five-Zone Visual Contract

Every generated hero is a background for the live ChatGPT Desktop workbench, not a screenshot or poster.

1. **Left: brand and navigation safe zone.** Reserve quiet space for a logo or styled brand label and the live navigation. No face, important object, high-contrast highlight, or dense detail belongs here.
2. **Center: immersive scene and gradient safety.** Keep the scene visible while leaving room for the runtime gradient behind conversations.
3. **Right: subject and information-card space.** Place the preserved person or product in the right third with breathing room for optional brand information.
4. **Bottom: input workbench safe zone.** Keep roughly the lower 20 percent calm and low contrast for the composer and approval controls.
5. **Lower right: optional portrait card.** Treat it as secondary decoration. It must not cover the subject, composer, or primary information.

The hero must not contain fake menus, buttons, chat bubbles, code, text, watermarks, or a baked-in ChatGPT interface.

## One-Shot Theme Creation And Apply

After the final hero has been generated and inspected, the Skill can create and apply a theme in one command:

```bash
node "$HOME/.codex/skills/codex-skin-studio/scripts/create-theme.mjs" \
  --id "slayers-xellos-night" \
  --name "Slayers Xellos Night" \
  --out "/absolute/path/to/themes/slayers-xellos-night" \
  --hero "/absolute/path/to/final-hero.webp" \
  --accent "#D76CFF" \
  --secondary "#806CFF" \
  --surface "#090D2A" \
  --text "#FFFFFF" \
  --brand "SLAYERS // XELLOS" \
  --replace \
  --apply
```

The command creates the files in a temporary directory, validates them, atomically replaces the output directory, persists the theme, and applies it when a renderer is available. `--replace` never deletes the old theme until the new one passes validation.

When a user explicitly asks to apply a theme, the Skill also checks the persistence worker. If it is disabled, the Skill enables it before reporting completion:

```bash
node "$HOME/.codex/skills/codex-skin-studio/scripts/persist.mjs" status --json
node "$HOME/.codex/skills/codex-skin-studio/scripts/persist.mjs" install --json
```

The final result must be `applied` or a later `apply.mjs status` result of `active`. `scheduled`, `pending`, and `enabled` are not proof that the skin is currently visible.

## Theme Format

The runtime core is a local hero image and `theme.json`:

```json
{
  "schemaVersion": 1,
  "id": "slayers-xellos-night",
  "name": "Slayers Xellos Night",
  "hero": "hero.webp",
  "logo": "logo.png",
  "polaroid": "polaroid.png",
  "copy": {
    "brand": "SLAYERS // XELLOS",
    "headline": "The Black Cloak of Xellos",
    "tagline": "Arcane ruins. Violet stars. Quiet mischief."
  },
  "colors": {
    "accent": "#D76CFF",
    "secondary": "#806CFF",
    "surface": "#090D2A",
    "text": "#FFFFFF"
  }
}
```

Only `schemaVersion`, `id`, `name`, `hero`, and the four colors are required by the current Skill workflow. `logo` replaces the top workspace label with an authorized local asset. Without a logo, `copy.brand` replaces the live label with scoped styled text. `headline` and `tagline` are optional and create a right-side information card only when explicitly requested. `polaroid` is a non-interactive lower-right asset.

Current runtime media support is PNG, JPEG, and WebP. GIF and video backgrounds are not enabled in this MVP; they require additional animation and media-lifecycle validation.

## Persistence

CDP CSS lives in renderer memory and normally disappears after a full app restart. The optional LaunchAgent solves this without modifying the application package:

```bash
node "$HOME/.codex/skills/codex-skin-studio/scripts/persist.mjs" install --json
node "$HOME/.codex/skills/codex-skin-studio/scripts/persist.mjs" status --json
node "$HOME/.codex/skills/codex-skin-studio/scripts/persist.mjs" uninstall --json
```

The worker is a separate Node.js process managed by macOS `launchd`. It uses loopback CDP, watches for the selected renderer, and reapplies the persisted theme after login, app launch, or renderer reload. It does not generate images or modify `app.asar`.

Do not use ChatGPT Scheduled Tasks for local skin persistence. They do not provide a reliable local process or app lifecycle hook.

## Inspect And Restore

```bash
node "$HOME/.codex/skills/codex-skin-studio/scripts/apply.mjs" doctor --json
node "$HOME/.codex/skills/codex-skin-studio/scripts/apply.mjs" status --json
node "$HOME/.codex/skills/codex-skin-studio/scripts/apply.mjs" restore --json
node "$HOME/.codex/skills/codex-skin-studio/scripts/apply.mjs" restore --restart-normal --json
```

`restore` removes the injected style but keeps theme files. `restore --restart-normal` also restarts ChatGPT Desktop without the debugging argument.

## Troubleshooting

### The skin disappears after restart

Check the worker:

```bash
node "$HOME/.codex/skills/codex-skin-studio/scripts/persist.mjs" status --json
```

The expected result is `status: "enabled"` and `running: true`. If it is disabled, run `install` and then reapply the selected theme.

### Application returns `scheduled`

ChatGPT Desktop did not expose a renderer yet. Wait briefly and run `apply.mjs status --json`. Report success only after `active`.

### Image generation fails

The Skill uses Codex native image generation. If the current provider does not expose image generation, provide a final local PNG, JPEG, or WebP background. The runtime does not silently switch to an external image API.

### The wrong UI element changes

This is a regression. The brand selector must be scoped to the top navigation mode button. Project session buttons and the account footer must remain native. Run the repository test suite before changing selectors.

## Development

```bash
npm test
npm run test:codex-skin-studio
npm run package:codex-skin-studio
```

The Skill distribution is intentionally zero-dependency and English ASCII-only. Theme names and user-facing responses may use any language.

## Security Boundary

- CDP is restricted to `127.0.0.1`.
- Theme assets must be local files inside the theme directory.
- Manifest fields are validated; themes cannot provide arbitrary CSS or JavaScript.
- The application bundle and code signature are never modified.
- Persistence is user-level and removable with `persist.mjs uninstall`.

## License

The project code is released under the [MIT License](LICENSE). Character names, logos, and third-party visual assets remain subject to their respective rights; see [NOTICE.md](NOTICE.md).

For the Chinese guide, see [README.zh-CN.md](README.zh-CN.md).
