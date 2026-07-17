# ChatGPT Desktop Brand Workbench Skin

## Intent

Give the lightweight ChatGPT Desktop skin Skill an original product surface instead of reproducing the legacy preset layout. The skin remains a single-image runtime, but the image is paired with a restrained brand workbench layer.

## Design Direction

Use the brand-workbench direction as the foundation and borrow immersion from the scene direction:

- The hero image owns the atmosphere and the primary portrait or product.
- The left rail becomes a branded navigation surface, not a generic translucent sidebar.
- The center work area keeps a transparent-to-surface vertical gradient so the hero remains visible behind the conversation.
- The composer becomes a branded workbench with themed border, shadow, and readable controls.
- Optional logo, brand copy, and polaroid assets reinforce identity without becoming required chrome. Headline and tagline are opt-in because unsolicited floating copy obscures the live work area.

## Theme Contract

Keep `hero + theme.json` as the runtime core. Optional presentation fields are:

- `logo`: an authorized local PNG, JPEG, or WebP brand mark used in the workspace selector.
- `polaroid`: a local PNG, JPEG, or WebP portrait or product card placed at the lower right.
- `copy.brand`: short brand label rendered in the left navigation when no logo is supplied.
- `copy.headline`: optional short theme-specific headline rendered in a right-side information card.
- `copy.tagline`: optional supporting line rendered in the same right-side information card.

All optional assets remain inside the theme directory, are copied atomically, decoded before injection, and restored with the previous style on failure.

## Layout Rules

- Keep the left 22% visually quiet enough for navigation while allowing the logo to be legible.
- Keep the center top transparent and the lower center more opaque for conversation and composer readability.
- Keep the right-side subject visible and out of controls.
- Keep the polaroid non-interactive and outside the composer hit area.
- Use the active-thread gradient and composer border as the primary UI signature.
- Reserve five explicit zones in every generated hero: left brand/navigation safety, center immersive gradient safety, right subject and information-card space, bottom input-workbench safety, and lower-right secondary portrait space.
- Scope brand replacement to the top workspace mode button only. Project session controls and the account footer must retain native layout and text.
- Do not add an in-app theme menu, pet, database, remote service, or application-bundle modification.

## Acceptance Criteria

1. Themes without optional fields behave exactly as before.
2. A theme with `logo`, `polaroid`, and `copy` validates, persists, injects, verifies, reports status, and rolls back atomically.
3. Logo and polaroid image decoding failures prevent successful activation.
4. User-provided copy is serialized as inert CSS content and cannot become executable CSS or JavaScript.
5. The lightweight Skill remains English ASCII-only and zero-dependency.
6. Focused and full test suites cover the new contract and packaging remains valid.
7. A requested create-and-apply flow has one-shot CLI support and cannot report completion before the renderer status is active.
