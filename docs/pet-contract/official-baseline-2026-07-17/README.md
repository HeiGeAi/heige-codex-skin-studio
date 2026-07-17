# ChatGPT Desktop Codex V2 Pet Contract Record

Status: observed-reference

On 2026-07-17, ChatGPT Desktop `26.715.21316` was inspected on macOS. The
application resources include the official curated `hatch-pet` Skill and its
`references/codex-pet-contract.md` file. That source defines the Desktop v2
package contract used by this Skill.

## Observed Desktop contract

- Manifest requires `id`, `displayName`, `description`, `spriteVersionNumber: 2`, and `spritesheetPath`.
- The spritesheet is transparent PNG or WebP.
- The final atlas is `1536 x 2288`, with 8 columns, 11 rows, and `192 x 208` cells.
- Rows 0-8 are standard animation states.
- Rows 9-10 contain 16 clockwise look directions.
- Row 9 contains `000`, `022.5`, `045`, `067.5`, `090`, `112.5`, `135`, `157.5`.
- Row 10 contains `180`, `202.5`, `225`, `247.5`, `270`, `292.5`, `315`, `337.5`.
- `000` means up, not neutral/front. Neutral/front falls back to idle.
- The `1536 x 1872` 8x9 atlas is an intermediate artifact and must not be packaged.
- Unused standard-row cells must be fully transparent.

The corresponding source files are inside the installed application at:

```text
/Applications/ChatGPT.app/Contents/Resources/skills/skills/.curated/hatch-pet/
├── SKILL.md
└── references/codex-pet-contract.md
```

## Platform boundary

The contract is format-level evidence from the official bundled Skill. It is
expected to be shared by the macOS and Windows ChatGPT Desktop distributions.
The macOS build was inspected and its visible Settings > Pets Refresh,
selected-row, and embedded custom spritesheet loading postconditions were
verified. Windows path and
installation behavior is covered by automated tests; Windows application
selection still requires a Windows Desktop manual run.

## Application behavior and runtime postconditions

The supported selection flow is Settings > Pets > Refresh, then choose the
matching custom Pet. The versioned adapter verifies the visible selected row.
The runtime postcondition is a visible Pet Overlay with the matching avatar
asset and animation state. The inspected Desktop build returned
"/pet isn't a recognized command here", so `/pet` is not a valid wake-up
requirement for that build and must not be treated as evidence of success.

## Public Web baseline

The official Pets documentation separately states that a Web-uploaded custom
sprite sheet is transparent PNG or WebP, exactly `1536 x 1872` pixels, and no
larger than `20 MiB`. That Web format is not the Desktop v2 package contract.

Source: https://learn.chatgpt.com/docs/pets?surface=app
