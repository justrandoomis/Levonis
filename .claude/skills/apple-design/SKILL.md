---
name: Apple Design for Levonis
description: Apply Apple Human Interface Guidelines principles to Levonis UI reviews and implementations, especially mobile-first product, checkout, merchant, auth, and admin experiences.
---

# Apple Design for Levonis

Use this skill whenever designing, reviewing, or implementing user-facing Levonis UI/UX.

The goal is NOT to copy iOS, Safari, Apple Store, or Liquid Glass literally. Apply Apple Human Interface Guidelines principles to make the existing Levonis web experience feel intentional, clear, calm, responsive, familiar, and highly crafted while preserving Levonis brand identity.

Official reference when web access is available:
- https://developer.apple.com/design/human-interface-guidelines/
- https://developer.apple.com/design/

## 1. Core design principles

Prioritize, in this order:

1. Purpose — every visual element must support a user task.
2. Agency — users must understand what will happen before they act and be able to recover from mistakes.
3. Familiarity — use recognizable interaction patterns and predictable control placement.
4. Simplicity — remove visual noise before adding decoration.
5. Flexibility — support different viewport sizes, RTL/LTR, content lengths, and input methods.
6. Craft — alignment, spacing, state transitions, typography, icons, borders, and feedback must feel deliberate.
7. Delight — use subtle polish and satisfying feedback, never decorative excess.

## 2. Levonis-specific visual direction

Levonis should feel premium, modern, technical, and calm — not like a generic SaaS template and not like an AI-generated UI.

Prefer:
- restrained dark surfaces
- clear hierarchy
- compact controls
- subtle warm/gold accent only where it communicates importance or state
- semantic color for success, warning, destructive actions, and information
- 1px subtle borders instead of heavy outlines
- consistent spacing and corner radii
- strong alignment
- crisp modern icons
- high legibility

Avoid:
- large gold outlines around selected controls
- brown/gold-tinted blocks everywhere
- excessive glow, gradients, glassmorphism, or neon
- giant text and giant buttons
- multiple competing accent colors
- excessive card nesting
- using border + tinted background + colored text + glow all at once for a single state

## 3. Selection states

Selection must be obvious but restrained.

For option cards, variants, delivery choices, filters, and segmented choices:

Inactive state:
- neutral surface
- subtle 1px border
- normal foreground text
- no glow

Selected state:
- keep the main surface mostly neutral
- use ONE primary state cue, optionally supported by ONE secondary cue
- preferred cues: small checkmark, accent indicator, subtle border change, slight surface lift, or small leading/trailing accent
- text should normally remain readable neutral foreground rather than turning the entire label gold

Do NOT make selected variants look like warning banners.
Do NOT use thick full-card gold borders unless there is a strong product-specific reason.

If an option includes a thumbnail, the thumbnail container must visually belong to the option and should not become a random white square in dark mode.

## 4. Hierarchy and grouping

Use proximity and spacing before boxes.

Before adding a border/card, ask whether spacing, typography, or alignment can communicate the grouping.

Important hierarchy order for commerce screens:
- product identity
- primary price / offer
- required choice
- purchase action
- supporting information
- secondary explanation

Informational notes must not visually compete with the main price, selected option, or purchase button.

## 5. Typography

Keep mobile typography compact and intentional.

- body text should remain highly readable
- secondary labels should be visibly quieter, not just smaller
- avoid too many font weights on one screen
- avoid oversized headings on mobile
- use tabular numbers where useful for prices, quantities, timers, statistics
- Arabic must receive enough line height and must not be compressed vertically
- support both RTL and LTR without manual visual hacks

Never rely on text color alone to convey state.

## 6. Buttons and controls

Controls should communicate importance through hierarchy rather than size inflation.

Primary action:
- strongest contrast on the screen
- concise label
- comfortable touch target
- no unnecessary ornamentation

Secondary action:
- clearly lower emphasis

Tertiary action:
- text/icon treatment when appropriate

Destructive actions must be visually distinct and require confirmation when consequences are significant.

Keep mobile touch targets practical even when controls look visually compact.

## 7. Color

Use color intentionally and sparingly.

Gold/warm Levonis accent:
- primary CTA where appropriate
- premium/pro membership indicators
- selected state accent when needed
- small emphasis details

Do not use gold as the default border, text, icon, background, and shadow simultaneously.

Semantic colors:
- green = success/complete
- amber = caution/pending
- red = destructive/error
- blue or neutral info color only where the current Levonis design system already supports it

Ensure contrast is sufficient in dark mode.

## 8. Layout and spacing

Design mobile-first.

- prefer a consistent spacing scale
- align related controls to shared edges
- preserve safe areas around fixed bottom bars
- do not allow sticky purchase bars to cover content
- prevent horizontal overflow
- support small Android devices as well as iPhone-sized layouts
- do not assume one exact viewport height

For dense commerce/admin screens, compactness is desirable but must not sacrifice tap accuracy or readability.

## 9. Motion and feedback

Motion should explain state changes, not decorate them.

Use short transitions for:
- selected options
- expansion/collapse
- success state
- cart updates
- sheet/dialog presentation

Avoid:
- continuous decorative animation
- slow transitions
- large spring/bounce effects for routine controls

Respect reduced-motion preferences.

## 10. Sheets, dialogs, and menus

Use overlays only when the task is focused and temporary.

A dialog should have:
- clear title
- concise explanation only when needed
- obvious primary action
- obvious cancel/dismiss path
- correct focus handling
- no hidden destructive action

On mobile, prefer a well-designed bottom sheet when it better matches the interaction.

## 11. Forms

Forms must feel effortless.

- labels remain visible; do not depend only on placeholders
- errors appear close to the related field
- keyboard type should match the input
- avoid asking for information that can be derived automatically
- group related fields
- keep primary action visible when practical
- preserve entered data on recoverable errors

## 12. Accessibility

Every redesign must preserve or improve accessibility.

Check:
- keyboard navigation
- visible focus state
- semantic HTML
- labels and accessible names
- color contrast
- touch target sizes
- screen-reader order
- RTL behavior
- reduced motion
- zoom/text scaling robustness

Do not remove focus rings without replacing them with an accessible equivalent.

## 13. Responsive behavior

Do not create a desktop design and shrink it.

Define behavior for:
- small mobile
- large mobile
- tablet
- desktop

Content priority may change by viewport, but functionality must remain available.

## 14. Existing Levonis architecture

Before changing UI:

1. Inspect the current component and its call sites.
2. Inspect existing tokens, primitives, shared controls, and responsive utilities.
3. Reuse existing components when they are sound.
4. Do not duplicate business logic inside redesigned components.
5. Preserve routes, API behavior, analytics, auth, cart behavior, and accessibility unless the task explicitly changes them.
6. Keep state logic separate from visual presentation where practical.

Do not rewrite working systems unnecessarily just to achieve a visual redesign.

## 15. Design review workflow

For every UI task:

1. Identify the user's primary task.
2. Identify the strongest visual element currently competing with that task.
3. Remove unnecessary visual emphasis.
4. Establish hierarchy using spacing, typography, alignment, and surface contrast.
5. Apply accent color only where necessary.
6. Verify all interaction states: default, hover, active, selected, focus, disabled, loading, success, error.
7. Test dark mode and actual small mobile widths.
8. Verify RTL Arabic first, then LTR.
9. Compare before/after screenshots when possible.
10. Run existing tests/build checks after implementation.

## 16. Screenshot-driven tasks

When the user provides a screenshot and points to a bad-looking area:

- inspect the exact geometry, spacing, border treatment, color balance, hierarchy, and state styling
- do not interpret a complaint about appearance as merely a request to change one color
- improve the component systemically so all equivalent variants/states remain consistent
- preserve behavior unless explicitly requested otherwise

For a poorly styled selected option, prefer a refined neutral card with a subtle state indicator instead of a strong gold outline/background combination.

## 17. Final implementation standard

A finished Levonis UI should feel:

- immediately understandable
- visually quiet until attention is needed
- consistent across screens
- polished at small details
- comfortable on mobile
- clearly Levonis
- inspired by Apple-level discipline, not visually copied from Apple

When implementing, do the work rather than only describing it. Verify the result in the existing project and keep the change narrowly scoped to the requested experience unless a shared primitive clearly needs a reusable fix.
