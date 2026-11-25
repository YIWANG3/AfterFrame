const { test, expect } = require('@playwright/test');
const { launchApp, closeApp } = require('./helpers/app');
const { exerciseFolderOrder, exerciseFolderSearchAndSort } = require('./helpers/folder-order');

test('folder drag ordering persists and remains separate from photo drops', async () => {
  const { app, window, userDataDir } = await launchApp({ testName: 'folder-order' });
  try {
    await expect(window.locator('[data-gallery-item="true"]').first()).toBeVisible({ timeout: 15000 });
    // Room for the collections. The CI machine's screen leaves a window 684pt
    // tall, where the collection list was under 100pt and every drop target in
    // it sat in a drag's auto-scroll band (32pt at either end): the list
    // scrolled under the pointer and a drop before a row became a drop into
    // it. With the entries above put away (Settings › General › Sidebar) the
    // three rows show whole and the drops land where they aim.
    await window.evaluate(() => localStorage.setItem('afterframe.pref.sidebar.hidden',
      JSON.stringify(['recent', 'rated', 'lookalikes', 'discover', 'stickers', 'people', 'tags', 'stats'])));
    await window.reload();
    await expect(window.locator('[data-gallery-item="true"]').first()).toBeVisible({ timeout: 15000 });
    await exerciseFolderOrder(window, { reload: true });
    await exerciseFolderSearchAndSort(window);
  } finally {
    await closeApp(app, userDataDir);
  }
});
