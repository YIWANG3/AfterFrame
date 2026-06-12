// The app's z-index ladder, named. Previously an implicit convention spread
// across 8 hand-rolled overlay shells (100/3000/9000/10050/10100/10200/10210)
// that nobody owned. New layers MUST pick from here, not invent numbers.
export const Z = {
  dropdown: 100, //     toolbar menus, sort dropdown, context menus
  settings: 3000, //    settings overlay
  designSystem: 9000,
  lightbox: 10050,
  editor: 10100, //     editor / full-screen work surfaces
  overlay: 10200, //    collage, before/after compare
  overlayTop: 10210, // modals stacked above the editor (provider/style modals)
  dock: 11000, //       job dock + toast stack — always on top
};
