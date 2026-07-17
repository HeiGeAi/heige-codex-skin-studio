---
name: codex-skin-studio
description: Design, generate, validate, apply, inspect, or remove single-image skins for ChatGPT Desktop on macOS. Supports text-to-image generation, direct background images, subject-preserving image composition, style-reference generation, and multi-image composition. Use when the user asks to reskin ChatGPT Desktop, create a desktop theme or background, preserve a person, product, or object from an image, derive a skin from a style reference, apply a generated workspace, inspect the active skin, or restore the native interface.
---

# ChatGPT Desktop Skin Studio

Let Codex handle visual decisions. Delegate file validation, application discovery,
restart orchestration, and CDP injection to `scripts/apply.mjs`.

## Operating rules

- Keep the runtime theme hero-led. Optional presentation assets are limited to a brand logo and one portrait card; do not create component packs, websites, or another runtime.
- Never modify `app.asar`, the application bundle, the code signature, or official JavaScript.
- Target ChatGPT Desktop on macOS. Its current technical bundle identifier is `com.openai.codex`.
- Generate without restarting when the user asks only for a design. When the user explicitly asks to apply or replace a skin, complete application and enable persistence for the selected theme.
- Use the built-in `$imagegen` skill by default. When a generated or edited image is required, invoke `$imagegen` before creating theme files or running `apply.mjs`; do not treat a prompt such as "use imagegen" as a completed generation step.
- `$imagegen` must use the native `image_gen` tool by default. Do not replace it with a Node script, an HTTP request, an OpenAI API call, or the CLI fallback. If native generation is unavailable or returns an error, report the exact error and ask for a final local background image. Do not request an API key or switch to an external image service automatically.
- Use one canonical role schema for multi-image inputs: `subject/object`, `style-reference`, `composition/layout-reference`, or `brand/logo`. Direct background and single-image subject workflows are separate modes and do not use this multi-image role schema.
- For a specified subject, preserve identity, silhouette, proportions, materials, clothing, defining details, colors, markings, or product geometry. Change only the environment, lighting, shadows, framing space, and placement.
- For a style reference, carry over visual traits such as color, materials, lighting, rendering, density, mood, and period. Do not copy its subject or unique composition by default.
- Do not generate buttons, menus, chat text, watermarks, shortcut instructions, or fake UI. Preserve a source logo only when explicitly requested and authorized.
- Optional presentation assets are allowed only when explicitly requested: `logo` replaces the ChatGPT workspace label in the left menu, `polaroid` adds a non-interactive portrait card at the lower right, and `copy.brand`, `copy.headline`, or `copy.tagline` define brand workbench text. `copy.brand` replaces the live workspace label in the left navigation with styled text when no logo is supplied. `copy.headline` and `copy.tagline` create a right-side information card only when explicitly requested; do not add them by default.
- Write every distributed artifact, script comment, diagnostic, log message, example, and template in English ASCII. Reply in the user's language.

## Brand workbench composition contract

Every generated hero must be designed as a background for a layered ChatGPT Desktop workbench, not as a standalone poster or a baked UI mockup. Include these zones in the visual brief and generation prompt:

- Left: reserve quiet, low-contrast space for the brand logo and the dedicated navigation system. The real sidebar and its navigation remain live UI; never draw them into the image.
- Center: provide the immersive background scene and preserve room for the runtime gradient safety layer behind conversation content.
- Right: place the preserved person or product subject in the open right third and reserve nearby breathing room for an optional brand information card.
- Bottom: keep the lower 20% calm and low-contrast for the dedicated input workbench and approval controls.
- Lower right: treat the optional portrait card as a secondary non-core accent. It must never cover the subject, the composer, or the primary brand information.

The generated image supplies the scene, atmosphere, subject, and negative space. The injector supplies the live logo, navigation styling, gradient safety layer, optional brand copy, composer treatment, and optional portrait card. Do not generate text, cards, menus, buttons, chat bubbles, or fake UI inside the hero image.

## Runtime readability contract

The hero is never the only contrast layer. The injector must keep live controls
readable above the image by using opaque or nearly opaque theme-derived surfaces
for the composer, send button, menus, dialogs, right-side file or document
previews, selected items, and keyboard focus. Prefer the theme surface and text
colors over white or black defaults. Pick a foreground for the accent button
that has the strongest contrast against the accent. Never rely on opacity alone
for disabled or secondary controls, and never allow a light default panel token
to remain behind light theme text.

## Five-zone generation contract

Every visual brief and image-generation prompt must explicitly reserve these five zones:

1. Left: a quiet brand-logo and dedicated-navigation safe zone. The live ChatGPT Desktop navigation remains interactive and is overlaid by the injector.
2. Center: an immersive scene with a readable gradient safety layer behind conversation content.
3. Right: the preserved person or product in the open right third, with adjacent breathing room for an optional brand information card.
4. Bottom: a calm, low-contrast input-workbench safe zone covering roughly the lower 20 percent of the hero.
5. Lower right: an optional portrait card area treated as secondary decoration; it must not cover the subject or composer.

The hero must be a background asset, not a screenshot or poster. Do not draw UI controls, fake navigation, chat content, cards, buttons, logos, or text into it.

When no logo asset is supplied, `copy.brand` replaces the live top workspace label with scoped styled text. The selector must target only the top navigation mode button; never use a broad sidebar `:first-child`, generic menu-button, project-action, or account-button selector.

## Runtime discovery

Treat the directory containing this file as `SKILL_ROOT`. Prefer the current
`node` executable. If it is unavailable, use the Node executable bundled with
Codex:

```bash
node "$SKILL_ROOT/scripts/apply.mjs" doctor --json
```

```bash
"/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" \
  "$SKILL_ROOT/scripts/apply.mjs" doctor --json
```

Use the second command only when the first cannot run.

## Classify input images

1. Inspect every local image with `view_image` before editing or composing it.
2. Select the workflow mode from the user's wording:
   - Direct background: use the image itself as the final background.
   - Single-image subject: preserve the specified subject and rebuild the rest.
   - Style reference: derive visual language only.
   - Multi-image composition: assign each input exactly one role from the canonical four-role schema.
3. Label multi-image inputs explicitly, such as `Image 1: subject/object` and `Image 2: style-reference`.
4. State what each image may contribute and what must remain unchanged. Do not assign conflicting or ambiguous roles.
5. Prioritize subject fidelity over style matching, and safe zones over reference composition. Validate subject, style, and layout separately.
6. Do not ask again when the user already specified a role. If subject preservation versus style-only use is unclear, ask only that question.
7. Reject empty files and formats other than PNG, JPEG, or WebP.

## Invoke image generation

Use this gate for every workflow that is not `direct-background`:

1. Finish the visual brief and label every input image role before calling `$imagegen`.
2. Add the full brand workbench composition contract to the prompt: left logo/navigation, center immersive scene plus gradient safety layer, right subject plus brand information card, bottom input workbench, and optional lower-right portrait card.
3. For a local subject or reference image, pass its exact absolute path as the native tool's reference input after `view_image` has succeeded. For an image attached only to the current conversation, use the native tool's conversation-image input instead.
4. For subject preservation, use edit or compositing semantics and repeat the invariants in the prompt. For style-only references, use generation semantics and explicitly forbid copying the source subject.
5. Wait for the native tool result. Do not create `hero`, `theme.json`, or claim that generation completed before a result is returned.
6. If the native tool returns `404 Not Found`, first verify that the referenced file exists and is readable. Retry once only with the corrected input or an image that is actually available in the current visual context. If the tool reports that no conversation images are available, stop and ask the user to reattach the source image in the current task or provide a final local background. Do not loop and do not switch to CLI/API mode.
7. Inspect the returned image with Vision. If one invariant fails, make one targeted `$imagegen` retry; otherwise continue to theme creation.

## Use a final background directly

1. Use the direct-background mode and skip Image Generation.
2. Check aspect ratio, safe zones, text, watermarks, and interface readability.
3. Explain any failure. Switch to edit mode only when the user allows image modification.
4. Save an accepted image as the final `hero.<ext>`.

## Preserve a specified subject

1. Use the single-image subject mode.
2. Invoke `$imagegen` and use its native `image_gen` edit or composition flow directly. Do not create a transparent cutout first.
3. Repeat these invariants in the prompt: identity, face, silhouette, proportions, clothing, colors, materials, markings, source logo, and product geometry as applicable.
4. Allow changes only to the background, environment, lighting, shadows, framing space, canvas extension, and subject placement.
5. Create a reusable transparent cutout only when explicitly requested. Start with the built-in chroma-key workflow.
6. For hair, glass, smoke, translucent materials, or other complex edges that require true native transparency, explain the API or CLI fallback and API-key requirement, then wait for explicit approval before using it.
7. Compare source and result with Vision. If identity or product structure drifts, retry once with only the failed invariant strengthened.

## Use a style reference

1. Mark the image as `style-reference` and use generation, not source-image editing.
2. Extract colors, contrast, materials, brushwork or rendering, lighting, density, mood, and period.
3. Create a new scene and composition. Do not copy people, characters, text, logos, trademarks, or unique arrangement unless explicitly requested and authorized.
4. Combine the style traits with the Codex safe-zone constraints in the `$imagegen` prompt.
5. Verify that the result matches the requested visual language while remaining a new skin image.

## Generate from multiple images

1. Inspect every input with Vision and assign each image exactly one explicit role: `subject/object`, `style-reference`, `composition/layout-reference`, or `brand/logo`.
2. State the role and permitted contribution before generation. Preserve the subject or object source's identity, silhouette, proportions, materials, colors, markings, and geometry. Transfer only visual language from the style reference. Use the composition/layout reference only for camera, framing, balance, and spatial relationships. Preserve a brand or logo only when the user explicitly requests it and is authorized to use it; otherwise omit it.
3. Combine the inputs in one generation prompt with the brand workbench contract: create a 16:9 landscape ChatGPT Desktop hero; reserve the left 26% for the brand logo and live navigation; keep the center immersive but readable behind the gradient safety layer; place the preserved subject or object in the right third with space for a brand information card; keep the bottom 20% low-contrast for the input workbench; treat the lower-right portrait card as optional and secondary.
4. Do not add text, logos, watermarks, buttons, menus, fake panels, chat bubbles, or code unless the user explicitly requests them. Do not copy a reference image's subject or unique arrangement when its role is style or composition only.
5. After generation, inspect the result with Vision for subject or object preservation, layout safety in the left sidebar and bottom composer zones, and UI contrast/readability. If any check fails, regenerate once with only the failed constraint strengthened.
6. After the result passes inspection, create `hero.png` and `theme.json` in the theme directory. Add `logo.png` and/or `polaroid.png` only when the user explicitly requests those presentation assets. Do not retain input copies, reference images, cutouts, or intermediate files. When the user explicitly asks to apply the theme, validate and apply the directory with the provided script:

```bash
node "$SKILL_ROOT/scripts/apply.mjs" validate "/absolute/path/to/theme" --json
node "$SKILL_ROOT/scripts/apply.mjs" apply "/absolute/path/to/theme" --json
```

## Generate from text

1. Create a visual brief covering theme, mood, palette, subject placement, safe zones, and prohibited content.
2. Invoke `$imagegen` and use the native `image_gen` tool to generate a 16:9 landscape hero image.
3. Follow the brand workbench contract: keep the left 26% quiet for the brand logo and dedicated navigation, make the center immersive but readable behind a gradient safety layer, place the main subject and optional brand information card in the right third, keep the bottom 20% low-contrast for the dedicated input workbench, and keep any portrait card secondary in the lower right.
4. Keep important faces and objects out of the left sidebar safe zone. Avoid dense detail, bright highlights behind text, centered subjects, fake panels, cropped faces, text, logos, watermarks, buttons, chat bubbles, and code.
5. Use Vision to verify readability. If the result fails, make one targeted regeneration; do not iterate without a bound.

## One-shot theme output contract

When the user asks to create a skin, finish the full file-producing workflow in one pass: obtain or generate the final hero, inspect it, derive colors, create the manifest and optional local assets, run validation, and report the resulting directory. Do not leave a partially written theme or ask the user to assemble files manually.

When the user asks to create and apply, use the one-shot apply path. Do not stop after writing files, and do not report success from a CDP command alone. The final evidence must be `application.status: "applied"` or a subsequent `status` result of `active`.

## Create theme files

1. Decide the final theme id, display name, hero path, four colors, and any explicitly requested optional assets before writing files.
2. Create one clean output directory. For generated output, copy the final image returned by `$imagegen` from its reported local output path into that directory; never reference only the cache path. If no local output path is reported, ask for a final local background instead of guessing a cache filename.
3. For a supplied or directly accepted image, copy it into the output directory as the hero asset.
4. Derive six-digit hex values for `accent`, `secondary`, `surface`, and `text` from the final hero image.
5. Use `scripts/create-theme.mjs` once to create the complete theme directory and manifest in one operation. Add `--replace` when replacing an existing generated directory:

```bash
node "$SKILL_ROOT/scripts/create-theme.mjs" \
  --id "theme-id" \
  --name "Theme Name" \
  --out "/absolute/path/to/theme-id" \
  --hero "/absolute/path/to/final-hero.webp" \
  --accent "#00AAFF" \
  --secondary "#FF00AA" \
  --surface "#101018" \
  --text "#FFFFFF" \
  --brand "Brand Name" \
  --headline "Short headline" \
  --tagline "Short tagline" \
  --replace
```

6. Add `--logo` and/or `--polaroid` only when the user explicitly requests those assets and provides or authorizes the source files. The manifest accepts optional `copy.brand`, `copy.headline`, and `copy.tagline` strings.
7. Keep every final asset as a non-empty local PNG, JPEG, or WebP file inside the theme directory. Do not add CSS, JavaScript, remote URLs, source copies, transparent intermediates, or reference images.
8. Immediately run `validate` against the directory. Treat the returned JSON as the creation result and report the exact theme directory and files.
9. If application was explicitly requested, use the same creator with `--apply` (and `--port` only when needed), or run `apply.mjs apply` immediately after creation. Poll `apply.mjs status` after a `scheduled` result until it is `active`, with a bounded wait. Never call a `scheduled` or `pending` result active.

For a single command after the final hero is ready:

```bash
node "$SKILL_ROOT/scripts/create-theme.mjs" \
  --id "theme-id" \
  --name "Theme Name" \
  --out "/absolute/path/to/theme-id" \
  --hero "/absolute/path/to/final-hero.webp" \
  --accent "#00AAFF" \
  --secondary "#FF00AA" \
  --surface "#101018" \
  --text "#FFFFFF" \
  --brand "Brand Name" \
  --replace \
  --apply
```

This command creates, validates, persists, and applies the theme. Its JSON `application.status` is authoritative. If it is `scheduled`, wait for `status` to become `active` before reporting completion.

## Validate

```bash
node "$SKILL_ROOT/scripts/apply.mjs" validate "/absolute/path/to/theme" --json
```

Fix validation failures and retry. Never bypass validation.

## Apply

Run only when the user explicitly asks to apply the theme:

```bash
node "$SKILL_ROOT/scripts/apply.mjs" apply "/absolute/path/to/theme" --json
```

- `applied`: injection completed and verification passed; the skin is active.
- `scheduled`: the theme was persisted and restart-time injection was scheduled. Report the theme path, id, and restart behavior, but do not call it active.
- `failed`: read the error code, fix a recoverable problem, and retry once.

Stable error codes are `THEME_INVALID`, `INVALID_PORT`, `APP_UNAVAILABLE`,
`CDP_ERROR`, `INJECTION_FAILED`, `NO_ELIGIBLE_RENDERER`, `RESTORE_FAILED`,
`RESTART_SCHEDULE_FAILED`, and `COMMAND_FAILED`.

`apply` copies the validated theme into `~/Library/Application Support/CodexSkinStudio/themes/`
and persists state. Without CDP it starts a detached restart worker and returns
`scheduled` with `restartRequired: true`. A later `status` must confirm injection.

## Persist across ChatGPT Desktop restarts

CDP-injected CSS lives in renderer memory and disappears when ChatGPT Desktop exits or reloads. Saving `theme.json` alone cannot make CSS persistent. The supported opt-in solution is a macOS LaunchAgent worker that keeps ChatGPT Desktop on loopback CDP and re-injects the persisted theme whenever a renderer returns:

```bash
node "$SKILL_ROOT/scripts/persist.mjs" install --json
node "$SKILL_ROOT/scripts/persist.mjs" status --json
```

Skill installation itself only copies files and cannot start a process. On the first explicit apply or replace request, check `persist.mjs status`; when it is `disabled`, run `persist.mjs install` automatically before reporting completion. This is the default persistence behavior for an applied skin, not a requirement for design-only work.

Do not use a ChatGPT Scheduled Task for this job. Scheduled Tasks do not provide a reliable local macOS process, loopback CDP, or application-lifecycle hook. The LaunchAgent starts at the user login session, keeps the worker alive, launches ChatGPT Desktop with loopback CDP when a selected theme exists, and reapplies the theme after a renderer restart.

The LaunchAgent may restart ChatGPT Desktop after a normal launch and may reopen it while persistence is enabled. It never modifies `app.asar` or the code signature. Remove it with:

```bash
node "$SKILL_ROOT/scripts/persist.mjs" uninstall --json
```

The worker uses the active theme state under `~/Library/Application Support/CodexSkinStudio/state.json`; it does not generate images or create new themes. The apply workflow is:

1. Generate and validate the complete theme.
2. Install the LaunchAgent when persistence status is `disabled`.
3. Apply the selected theme.
4. Poll `apply.mjs status` until it reports `active`.

Do not report completion from `scheduled`, `pending`, or `enabled` alone.

When persistence is enabled, the injector also adds a `Skins` button in the
upper-right corner of the main conversation area. It reads valid local themes
from the worker's loopback-only control service and applies a selected theme
through the same validated `apply.mjs` flow. The control service listens only
on `127.0.0.1:9342`, accepts a theme id rather than a filesystem path, and does
not expose arbitrary command execution. If the worker is unavailable, the
button remains non-destructive and reports that local skin switching is
temporarily unavailable.
When a native ChatGPT Desktop menu or popover opens, the switcher temporarily
hides itself and releases pointer events so file open-method menus and other
native controls always receive the interaction.

## Inspect or restore

```bash
node "$SKILL_ROOT/scripts/apply.mjs" status --json
node "$SKILL_ROOT/scripts/apply.mjs" restore --json
```

Use this command when the user also asks to close the debugging port:

```bash
node "$SKILL_ROOT/scripts/apply.mjs" restore --restart-normal --json
```

`restore` removes the injected style but keeps user theme files. The
`--restart-normal` form schedules a normal restart without CDP arguments after
the style removal. It returns `scheduled`; the worker records any quit, launch,
or restart failure in `state.json`.

## Completion criteria

- The theme directory contains a non-empty hero image and valid `theme.json`.
- `validate` succeeds.
- The five visual zones are present in the brief and the hero passes safe-zone inspection.
- When application was requested, the final result is `applied` or `status` confirms `active`; `scheduled` alone is not completion.
- Never report generated files as an active skin without `applied` or matching injected theme id from `status`.
- Report the final theme id, theme directory, exact command result, and truthful application status.
