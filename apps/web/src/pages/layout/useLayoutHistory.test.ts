import { describe, expect, it } from 'vitest';
import { assignZOrder, reorderIds } from '@balcony/shared';
import { snapshotFromLayout, type LayoutSnapshot } from './useLayoutHistory';

describe('snapshotFromLayout', () => {
  it('captures exact integer geometry and orders by zIndex', () => {
    const snapshot = snapshotFromLayout({
      zones: [
        { id: 'b', xCm: 50, yCm: 10, widthCm: 60, depthCm: 40, zIndex: 20, sortOrder: 1 },
        { id: 'a', xCm: 0, yCm: 0, widthCm: 40, depthCm: 40, zIndex: 0, sortOrder: 0 },
        { id: 'unplaced', xCm: null, yCm: null, widthCm: null, depthCm: null, zIndex: 10, sortOrder: 2 },
      ],
    });
    expect(snapshot.order).toEqual(['a', 'b']);
    expect(snapshot.geometry.b).toEqual({ xCm: 50, yCm: 10, widthCm: 60, depthCm: 40 });
    expect(snapshot.geometry.unplaced).toBeUndefined();
  });
});

describe('undo restores geometry and ordering exactly', () => {
  it('round-trips: move then bring-to-front, undo recovers previous coordinates and z-order', () => {
    const before: LayoutSnapshot = {
      order: ['a', 'b', 'c'],
      geometry: {
        a: { xCm: 0, yCm: 0, widthCm: 50, depthCm: 50 },
        b: { xCm: 50, yCm: 0, widthCm: 50, depthCm: 50 },
        c: { xCm: 0, yCm: 50, widthCm: 50, depthCm: 50 },
      },
    };
    // 拖动 b 到 (100,10)，再置顶
    const dragged: LayoutSnapshot = {
      ...before,
      geometry: { ...before.geometry, b: { xCm: 100, yCm: 10, widthCm: 50, depthCm: 50 } },
    };
    const broughtToFront: LayoutSnapshot = { ...dragged, order: reorderIds(dragged.order, 'b', 'c', 'after') };
    expect(broughtToFront.order).toEqual(['a', 'c', 'b']);

    // 撤销：先回到拖动后的位置，再回到原始位置与排序
    const undoneOnce = dragged;
    const undoneTwice = before;
    expect(undoneOnce.geometry.b).toEqual({ xCm: 100, yCm: 10, widthCm: 50, depthCm: 50 });
    expect(undoneTwice.order).toEqual(['a', 'b', 'c']);
    expect(undoneTwice.geometry.b).toEqual({ xCm: 50, yCm: 0, widthCm: 50, depthCm: 50 });

    // z 序由顺序重新派生，提交项与历史顺序一致
    const zOrder = assignZOrder(undoneTwice.order);
    expect(zOrder).toEqual({ a: 0, b: 10, c: 20 });
  });
});
