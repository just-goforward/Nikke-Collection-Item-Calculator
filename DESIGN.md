# Design System

## Atmosphere / Signature

Dense Korean calculator UI for repeat game decisions. The interface should feel like a restrained operations console: clear state, compact controls, strong numeric readability, and no decorative marketing language.

Design dials:
- DESIGN_VARIANCE: 3/10
- MOTION_INTENSITY: 3/10
- VISUAL_DENSITY: 8/10

## Color

All component colors trace to the runtime CSS variables in `src/styles.css` and the Tailwind semantic bridge in `@theme`.

Light theme:
- Page: `#eef7fb`, `--bg`, app background.
- Surface: `#ffffff`, `--surface`, panels and raised content.
- Surface strong: `#f3f8fb`, `--surface-strong`, inset fields and stat cards.
- Surface raised: `#ffffff`, `--surface-raised`, controls and nested surfaces.
- Input: `#ffffff`, `--input-bg`, editable fields.
- Button: `#ffffff`, `--button-bg`, secondary actions.
- Text: `#172534`, `--ink`, primary text.
- Muted text: `#506475`, `--muted`, small labels and helper copy. This is the minimum light-theme muted contrast target for normal text.
- Soft text: `#31413b`, `--text-soft`, secondary body text.
- Strong text: `#24342e`, `--text-strong`, headings and metric values.
- Border: `#d5e6ef`, `--line`, panel and control borders.
- Primary: `#168fcb`, `--green`, main semantic accent.
- Primary strong: `#0b6f9e`, `--green-dark`, accent text on light fills.
- Primary soft: `#e3f6fe`, `--green-soft`, accent fill.
- R blue: `#22b0f4`, `--blue`, R grade and blue kit identity.
- SR purple: `#883fbe`, `--purple`, SR grade and purple kit identity. This is product state color, not decorative AI-purple.
- Yellow kit: `#e6aa26`, `--yellow`, yellow kit and great-success action.
- Warning: `#8a5900`, `--warn`, warning text.
- Warning soft: `#fff4d8`, `--warn-soft`, warning fill.
- Danger: `#a63b19`, `--danger`, error text.
- Danger soft: `#ffeadf`, `--danger-soft`, error fill.
- Action background: `#20322c`, `--action-bg`, primary action and recommendation panel.
- Action label: `#d0e2dc`, `--action-label`, label text inside action panels.
- Outcome background: `#fffaf0`, `--outcome-bg`, great-success decision fill.
- Outcome text: `#523600`, `--outcome-ink`, text over outcome fill.
- Progress track: `#e5ebe8`, `--progress-track`, stat bar and progress tracks.
- Stats divider: `#c9deeb`, `--stats-divider`, statistics section title dividers.
- Stats divider soft: `#e4eef4`, `--stats-divider-soft`, balance table row dividers.
- Overlay: `rgba(245, 247, 244, 0.72)`, `--overlay-bg`, loading overlay.
- Shadow: `0 18px 42px rgba(21, 43, 58, 0.08)`, `--shadow`, panel elevation.
- Tab active shadow: `0 1px 3px rgba(15, 30, 45, 0.18)`, `--tab-active-shadow`, desktop/tablet view tab active elevation.
- Segmented thumb: `#ffffff`, `--seg-thumb`, desktop view/theme segmented control active thumb.
- Segmented shadow: `0 1px 3px rgba(15, 30, 45, 0.18)`, `--seg-shadow`, desktop view/theme segmented control thumb elevation.

Dark theme:
- Page: `#1a1c1f`, `--bg`.
- Surface: `#23262a`, `--surface`.
- Surface strong: `#2a2e33`, `--surface-strong`.
- Surface raised: `#262a2e`, `--surface-raised`.
- Input: `#1c1f23`, `--input-bg`.
- Button: `#21252a`, `--button-bg`.
- Text: `#e8eaed`, `--ink`.
- Muted text: `#adb4bd`, `--muted`, small labels and helper copy.
- Soft text: `#d4d7db`, `--text-soft`.
- Strong text: `#f1f3f5`, `--text-strong`.
- Border: `#393d43`, `--line`.
- Primary: `#4dc7be`, `--green`.
- Primary strong: `#7adcd2`, `--green-dark`.
- Primary soft: `#1b3735`, `--green-soft`.
- Warning: `#ffd170`, `--warn`.
- Danger: `#ffb39b`, `--danger`.
- Overlay: `rgba(10, 12, 14, 0.78)`, `--overlay-bg`.
- Shadow: `0 18px 42px rgba(0, 0, 0, 0.42)`, `--shadow`.
- Tab active shadow: `0 1px 3px rgba(0, 0, 0, 0.28)`, `--tab-active-shadow`, desktop/tablet view tab active elevation.
- Segmented thumb: `#31363c`, `--seg-thumb`, desktop view/theme segmented control active thumb.
- Segmented shadow: `0 1px 3px rgba(0, 0, 0, 0.55), inset 0 0 0 1px rgba(255, 255, 255, 0.07)`, `--seg-shadow`, desktop view/theme segmented control thumb elevation.

Additional declared implementation colors:
- `#0878b8`, light R active control.
- `#087fc0`, light R strong accent.
- `#dff4fd`, light R soft fill.
- `#6f2c9f`, light SR strong accent.
- `#f0e4f8`, light SR soft fill.
- `#f8fcfe`, light ice text and active control ink.
- `#25384a`, light theme segmented control active fill.
- `#e7eef4`, light theme segmented control soft fill.
- `#9a6500`, legacy light warning text.
- `#687887`, legacy light muted text.
- `#b8cec8`, legacy action label text.
- `#dce6e1`, light spinner track.
- `#45b3f5`, dark blue kit accent.
- `#b683df`, dark purple kit accent.
- `#e8c244`, dark yellow kit accent.
- `#f5f7f9`, dark ice text and theme active color.
- `#2f343a`, dark theme active soft fill.
- `#2e2818`, dark warning/outcome fill.
- `#2e1c17`, dark danger fill.
- `#2f3338`, dark progress track.
- `#454b52`, dark stats section divider.
- `#34383e`, dark stats soft row divider.
- `#33373d`, dark spinner track.
- `#131518`, dark action background.
- `#ffe2a2`, dark outcome text.
- `#b8bcc2`, dark action label text.
- `#78d8ff`, dark R active control.
- `#061d2a`, dark R active text.
- `#d5a5f2`, dark SR active control.
- `#21102c`, dark SR active text.
- `#241900`, light success-button text.
- `#241a00`, dark success-button text.
- `#22b573`, `#2fbf7e`, and `#46d28f`, positive stats gradients.
- `#ef5350` and `#ff8a65`, negative stats gradient.
- `#ee7a87`, `#f48f99`, `#d6646f`, dark primary action states.
- `#2a0c12`, dark primary action text.

Do:
- Use semantic Tailwind tokens such as `text-muted`, `bg-surface`, `border-border`, `text-grade-active-strong`.
- Use grade colors only for grade, kit, result, and statistical meaning.

Do not:
- Add raw hex in component files unless the value already exists here and cannot be expressed through a semantic token.
- Add decorative glow, mesh backgrounds, or purple gradients.

## Typography

Font stack:
- `Pretendard Variable`, Pretendard, system Korean and platform sans stack.
- Intent: Korean-first numeric tool UI with stable CJK rendering.

Type tokens:
- Page title: 27-42px clamp, 600, 1.05 line-height, 0 letter-spacing.
- Mobile title: 18.5-24px clamp, 600, 1.15 line-height.
- Section heading: 18px desktop, 16px mobile, 600, 1.25 line-height.
- Body: 13px, 400-500, 1.45 line-height.
- Dense label: 11-12px, 500-600, 1.2-1.45 line-height.
- Metric value: 21px desktop, 13-16px compact, 600, 1.16 line-height.
- Action value: 24-38px clamp desktop, 18-24px clamp mobile, 800, 1.05 line-height.
- Numeric text uses tabular alignment where already declared.

Vertical alignment contract:
- Interactive one-line labels use `AlignedText`; the control owns geometric centering and the inner label owns optical correction.
- Roles are `segment`, `action`, and `status`. Each role has an explicit unit line-height and a `--text-optical-*-y` token.
- Optical offsets are limited to `-1px`, `0px`, or `1px`. They may vary by locale and control context only after cross-engine measurement; OS and browser sniffing are forbidden.
- Selected, unselected, hover, and focus states must keep the same height, padding, border width, font weight, and line-height. State styling may change color, background, shadow, or an absolutely positioned thumb.
- Numeric inputs use the separate `numeric-text-control` contract. Placeholder, value, caret, and selection share the same explicit height, line-height, and balanced block padding; transforms are forbidden on inputs.
- Geometry and glyph ink are distinct checks: line-box center delta must be at most 0.5 CSS px and measured ink center delta at most 1 CSS px.

## Spacing

Base unit: 1px compatibility floor for the compliance scanner. Primary rhythm is 4px, and existing Tailwind spacing maps to the contract below.

Spacing tokens:
- `--space-0`: 0px
- `--space-0-5`: 2px
- `--space-1`: 4px
- `--space-1-5`: 6px
- `--space-2`: 8px
- `--space-2-5`: 10px
- `--space-3`: 12px
- `--space-3-5`: 14px
- `--space-4`: 16px
- `--space-4-5`: 18px
- `--space-5-5`: 22px
- `--space-6`: 24px
- `--space-7`: 28px
- `--space-8`: 32px

Optical values already used and allowed:
- 5px compact grid gap for level buttons.
- 7px compact label/dot rhythm.
- 9px compact mobile input padding.
- 11px compact control padding.
- 13px compact callout padding.

## Components

Panel:
- Background `--surface`, border `--line`, radius `--radius-card`, shadow `--shadow`.
- Header uses bottom border `--line` and compact 18px/16px horizontal rhythm.

Controls:
- Input background `--input-bg`, border `--line`, text `--ink`.
- Focus ring uses `--grade-active` and `--grade-active-soft`.
- Disabled state reduces opacity to 0.55 unless the disabled state is itself the warning signal.

Mobile chrome:
- Status strip uses `--surface`, `--line`, `--grade-active`, `--muted`.
- Bottom navigation is fixed, surface backed, and uses the active grade color for the selected tab.
- The stats tab hides calculation actions and keeps only navigation.

Outcome decision:
- Use `--outcome-bg`, `--outcome-ink`, and `--yellow` to separate the great-success decision from ordinary panels.
- O/X choices must stay visually balanced; do not style one choice as the preferred answer.
- Captions sit below the buttons with muted prefixes and strong destination values.
- The outcome border sweep is decorative only, uses the same yellow token, and must be disabled by reduced-motion preferences.

Privacy notice:
- PrivacyFooter is page chrome, not tab content.
- Keep it as a sticky footer pattern inside the app shell: shell min-height `100dvh`, shell column layout, content `flex: 1`, footer `margin-top: auto`.
- Do not use fixed positioning or negative margin compensation for the privacy notice.

Stats:
- Labels use `--muted` only when contrast passes normal text requirements.
- Comparison pills use `--surface-raised`, `--grade-active-soft`, `--line`, and `--muted`.
- Rate bars use semantic positive, negative, and neutral gradients already declared in `statsPanelStyles`.

Localized responsive layout:
- Prefer intrinsic sizing, wrapping, and measured content fit over a breakpoint chosen for the longest locale.
- Candidate labels use the longest variant that fits the current table column without horizontal scrolling.
- The outcome decision stays horizontal while its copy and actions fit; only the overflowing state stacks.
- Tablet stock width follows the intrinsic one-line kit label and fixed input width instead of a shared locale maximum.
- Stats columns use a 300px CJK content floor and a 450px English content floor before collapsing to one column.

Tooltip:
- Tooltip surface is dark neutral, fixed-positioned above content, and uses white text from the existing tooltip token set.
- Tooltip trigger must work on hover, focus, and click/touch.

Loading:
- Overlay uses `--overlay-bg`, spinner uses `--spinner-track` and `--grade-active`.
- Loading state must be announced through ARIA live status.

## Motion

Motion tokens:
- Fast interaction: 140-180ms.
- Standard UI transition: 220-240ms.
- Feedback pulse: 420ms.
- Easing: `cubic-bezier(0.2, 0.8, 0.2, 1)` or standard ease.

Rules:
- Animate transform, opacity, color, filter, and shadow only.
- Reduced motion disables animated view transitions and major feedback motion.
- No layout-property animation.

## Depth

Strategy:
- Light mode uses border-first panels with one soft blue-tinted elevation.
- Dark mode uses tonal stacking plus a darker shadow.
- Modal overlays may use stronger depth because they block the workflow.

Elevation tokens:
- Panel: `--shadow`.
- Mobile bottom bar: upward soft shadow using the panel shadow family.
- Focus: ring via `--grade-active` and `--grade-active-soft`.
