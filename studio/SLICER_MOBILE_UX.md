# Mobile UX

LEVO presents the same editor state on desktop and mobile instead of maintaining a simplified second slicer.

## Touch workflow

- The workspace opens immediately with a visible build plate and a large, explicit model/ZIP upload card.
- The persistent five-action bar exposes Files, Tools, Slice/Cancel/Print, Prepare/Preview, and Settings without horizontal scrolling.
- Tools opens an expandable grid with Add, Move, Rotate, Scale, Duplicate, Delete, Split, Place on Bed, Support Paint, Zoom All, Zoom Bed, Undo, Redo, Add Plate, Save 3MF, Slice All, and Delete All.
- Once slicing succeeds, the central action changes to Print and opens actual G-code download, file sharing, project save, multi-plate export, and the official Bambu handoff guidance.
- The native plate switcher, overflow warning, progress/status, preview layer controls, and settings drawer remain available above the LEVO bar.
- Quick setup uses compact X2D/H2D, quality, strength, and support choices. The complete Orca-style process, motion, filament, object, and preview controls remain in the responsive drawer.
- Arabic/RTL is the initial product language; English is available from the header. Coordinates, file names, and the embedded technical editor stay LTR.

## Desktop workflow

At 900 px and wider, LEVO removes the duplicated phone controls and exposes the native full workspace: top project actions, prepare/preview tabs, gizmos, object tools, right sidebar, plate tabs, slice current/all, and G-code export. The LEVO header adds explicit Files and Print & Export entry points.

## Visual system

- Neutral charcoal surfaces use one green action accent and fixed semantic warning/error colors.
- Cards, bars, dialogs, and native engine panels are opaque, compact, and use restrained 5–10 px corners; there are no decorative gradients or backdrop blur.
- Five equal bottom actions, compact 4-column tool grids below 420 px, and a 350 px breakpoint preserve target size on narrow phones.
- Safe-area insets protect controls on notched devices, while short landscape screens receive reduced bar and tray heights.

## Accessibility and resilience

- Buttons have visible labels or accessible names and keyboard focus indicators.
- Modal sheets use dialog semantics, close explicitly or by their solid backdrop, and honor device safe areas.
- Error and notice banners use alert/status roles.
- Slicing progress is reflected in visible state and the primary action.
- Reduced-motion preferences disable nonessential animation.
- Picker and drag/drop use the same format normalization, ZIP analysis, progress, and no-fixed-app-cap behavior.

## Known UX gaps

Focus trapping inside the setup/status sheet and complete localization of engine-owned English labels/errors remain incomplete. Unsupported geometry tools stay visible but disabled in the native object toolbar so their status is discoverable rather than hidden.
