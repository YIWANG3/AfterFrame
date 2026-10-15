// The app's z-index ladder, named. Previously an implicit convention spread
// across 8 hand-rolled overlay shells (100/3000/9000/10050/10100/10200/10210)
// that nobody owned. Components take their layer from here, as
// style={{ zIndex: Z.x }}; ESLint refuses a Tailwind `z-[…]` literal under
// src/ (eslint.config.js). A new layer gets a named rung here, between the
// ones it must sit above and below, never a number in a component.
//
// Stacking contexts: a rung is only compared with its siblings. The menus
// inside an overlay (a collage cell's menu) take `dropdown` and still sit
// over everything in that overlay; the popovers portaled to document.body
// (`popover`, `overlayPopover`) are compared with the overlays themselves.
export const Z = {
  dropdown: 100, //        toolbar menus, sort dropdown, a collage cell's menu
  designSystem: 9000, //   the dev-only design system panel (its launcher sits one rung below)
  lightbox: 10050,
  editor: 10100, //        editor / full-screen work surfaces
  overlay: 10200, //       collage, before/after compare
  overlayTop: 10210, //    modals stacked above the editor (provider/style modals, the collage's picker)
  overlayDrag: 10250, //   the thumbnail following the pointer in the collage's batch view
  overlayPopover: 10300, // popovers raised from a panel inside an overlay or a modal (the colour picker)
  dock: 11000, //          job dock
  settings: 11200, //      settings overlay — above every view, the dock included
  dialog: 11500, //        dialogs over Settings (filter groups)
  popover: 12000, //       context menus, face / person / filter popovers, activity center: portaled to body, over Settings too
  confirm: 13000, //       ConfirmDialog — above everything, settings included
  toast: 20000, //         the toast stack — above the confirm dialog, so a result is never hidden behind one
};
