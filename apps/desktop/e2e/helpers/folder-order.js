const { expect } = require('@playwright/test');

async function exerciseFolderOrder(page, { reload = false } = {}) {
  const scroll = page.getByTestId('sidebar-folder-scroll');
  for (const name of ['Order Zulu', 'Order Alpha', 'Order Middle']) {
    await page.getByTitle('New folder', { exact: true }).click();
    await scroll.locator('input').fill(name);
    await scroll.locator('input').press('Enter');
    await expect(scroll.locator('[data-collection-id]').filter({ hasText: name })).toBeVisible();
  }
  const row = (name) => scroll.locator('[data-collection-id]').filter({ hasText: name });
  const ids = await scroll.locator('[data-collection-id]').evaluateAll((rows) => rows.map((r) => r.dataset.collectionId));
  const sourceId = await row('Order Middle').getAttribute('data-collection-id');
  const targetId = await row('Order Zulu').getAttribute('data-collection-id');
  const expected = ids.filter((id) => id !== sourceId);
  expected.splice(expected.indexOf(targetId), 0, sourceId);
  const order = () => scroll.locator('[data-collection-id]').evaluateAll((rows) => rows.map((r) => r.dataset.collectionId));
  await row('Order Middle').dragTo(row('Order Zulu'), { targetPosition: { x: 20, y: 2 } });
  await expect.poll(order).toEqual(expected);
  await expect(row('Order Middle')).toHaveAttribute('draggable', 'true');
  if (reload) {
    await page.reload();
    await expect.poll(order).toEqual(expected);
  }
  await page.getByTitle('Show covers', { exact: true }).click();
  const box = await row('Order Alpha').boundingBox();
  await row('Order Middle').dragTo(row('Order Alpha'), { targetPosition: { x: 20, y: box.height - 2 } });
  const final = expected.filter((id) => id !== sourceId);
  const alphaId = await row('Order Alpha').getAttribute('data-collection-id');
  final.splice(final.indexOf(alphaId) + 1, 0, sourceId);
  await expect.poll(order).toEqual(final);
  await expect(row('Order Middle')).toHaveAttribute('draggable', 'true');
  // Cancelling a drag removes the marker without changing saved order.
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await row('Order Middle').dispatchEvent('dragstart', { dataTransfer: transfer });
  const targetBox = await row('Order Zulu').boundingBox();
  await row('Order Zulu').dispatchEvent('dragover', { dataTransfer: transfer, clientY: targetBox.y + 1 });
  await expect(row('Order Zulu')).toHaveAttribute('data-folder-insertion', 'before');
  await row('Order Middle').dispatchEvent('dragend', { dataTransfer: transfer });
  await transfer.dispose();
  await expect(scroll.locator('[data-folder-insertion]')).toHaveCount(0);
  await expect.poll(order).toEqual(final);
  // Moving a photo must add membership, never reorder the folder list.
  const card = page.locator('[data-gallery-item="true"]').first();
  if (reload) {
    // Electron hands photo drags to macOS; dispatch its DOM payload here so
    // the test does not enter a native drag loop outside Playwright's control.
    const assetId = await card.getAttribute('data-asset-id');
    const transfer = await page.evaluateHandle((id) => {
      const data = new DataTransfer();
      data.setData('application/x-media-workspace-asset', JSON.stringify({ assetIds: [id] }));
      return data;
    }, assetId);
    await row('Order Alpha').dispatchEvent('dragover', { dataTransfer: transfer });
    await expect(row('Order Alpha')).toHaveClass(/ring-inset/);
    await row('Order Alpha').dispatchEvent('drop', { dataTransfer: transfer });
    await transfer.dispose();
  } else {
    await card.dragTo(row('Order Alpha'));
  }
  await expect(row('Order Alpha')).toContainText('1 item');
  await expect.poll(order).toEqual(final);
  await expect(scroll.locator('[data-folder-insertion]')).toHaveCount(0);
}
module.exports = { exerciseFolderOrder };
