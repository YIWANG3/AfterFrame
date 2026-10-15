const { test, expect } = require('@playwright/test');
const { launchApp, closeApp } = require('./helpers/app');
const { exerciseFolderOrder, exerciseFolderSearchAndSort } = require('./helpers/folder-order');

test('folder drag ordering persists and remains separate from photo drops', async () => {
  const { app, window, userDataDir } = await launchApp({ testName: 'folder-order' });
  try {
    await expect(window.locator('[data-gallery-item="true"]').first()).toBeVisible({ timeout: 15000 });
    await exerciseFolderOrder(window, { reload: true });
    await exerciseFolderSearchAndSort(window);
  } finally {
    await closeApp(app, userDataDir);
  }
});
