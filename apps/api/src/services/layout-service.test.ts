import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb, resetFakeDb } from './fake-prisma.js';

vi.mock('../db.js', async () => ({ prisma: (await import('./fake-prisma.js')).fakeDb.prisma }));

import { applyLayoutCommand, getLayout, redoLayout, undoLayout } from './layout-service.js';

const TABLE = { id: 'table', kind: 'FURNITURE' as const, name: '折叠桌', x: 0, y: 0, w: 50, h: 50, clearanceCm: 0, plantId: null };
const PLANT = { id: 'plant', kind: 'PLANT' as const, name: '绿萝', x: 150, y: 0, w: 30, h: 30, clearanceCm: 5, plantId: null };

async function seedLayout() {
  await getLayout('bal-1', 'user-1');
  await applyLayoutCommand('bal-1', 'user-1', 1, { type: 'ADD', item: TABLE });
  return applyLayoutCommand('bal-1', 'user-1', 2, { type: 'ADD', item: PLANT });
}

beforeEach(() => {
  resetFakeDb();
});

describe('getLayout', () => {
  it('creates a default layout on first access', async () => {
    const view = await getLayout('bal-1', 'user-1');
    expect(view.layout.version).toBe(1);
    expect(view.layout.widthCm).toBe(360);
    expect(view.layout.depthCm).toBe(240);
    expect(view.layout.items).toEqual([]);
    expect(view.canUndo).toBe(false);
    expect(view.canRedo).toBe(false);
  });

  it('rejects users without workspace membership', async () => {
    await expect(getLayout('bal-1', 'stranger')).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('applyLayoutCommand', () => {
  it('persists items and revisions, bumps version', async () => {
    const result = await seedLayout();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.version).toBe(3);
    expect(result.snapshot.items.map((item) => item.id)).toEqual(['table', 'plant']);
    expect(result.canUndo).toBe(true);
    expect(fakeDb.state.items).toHaveLength(2);
    expect(fakeDb.state.revisions).toHaveLength(2);
    expect(fakeDb.state.revisions[1]).toMatchObject({ seq: 2, label: '添加「绿萝」', undone: false });
    expect(fakeDb.state.layout?.version).toBe(3);
  });

  it('rejects stale baseVersion with 409 and writes nothing', async () => {
    await seedLayout();
    const result = await applyLayoutCommand('bal-1', 'user-1', 1, { type: 'MOVE', itemId: 'table', x: 60, y: 10 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.code).toBe('VERSION_CONFLICT');
    expect(result.snapshot.version).toBe(3);
    expect(fakeDb.state.items.find((item) => item.id === 'table')).toMatchObject({ x: 0, y: 0 });
    expect(fakeDb.state.layout?.version).toBe(3);
    expect(fakeDb.state.revisions).toHaveLength(2);
  });

  it('rejects placement violating plant occupancy with 422', async () => {
    await seedLayout();
    const result = await applyLayoutCommand('bal-1', 'user-1', 3, { type: 'MOVE', itemId: 'table', x: 100, y: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(422);
    expect(result.code).toBe('INVALID_PLACEMENT');
    expect(result.violations?.[0]?.type).toBe('PLANT_OCCUPIED');
    expect(fakeDb.state.layout?.version).toBe(3);
    expect(fakeDb.state.revisions).toHaveLength(2);
  });

  it('detects concurrent commits via optimistic lock and returns fresh state', async () => {
    await seedLayout();
    fakeDb.state.bumpVersionOnNextUpdateMany = true; // 模拟事务期间他人提交了新版本
    const result = await applyLayoutCommand('bal-1', 'user-1', 3, { type: 'MOVE', itemId: 'table', x: 60, y: 10 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.code).toBe('VERSION_CONFLICT');
    expect(result.snapshot.version).toBe(4);
    // 本次事务已回滚：几何保持原值
    expect(fakeDb.state.items.find((item) => item.id === 'table')).toMatchObject({ x: 0, y: 0 });
    expect(fakeDb.state.revisions).toHaveLength(2);
  });

  it('requires EDITOR role for mutations', async () => {
    await getLayout('bal-1', 'user-1');
    await expect(applyLayoutCommand('bal-1', 'viewer-1', 1, { type: 'REMOVE', itemId: 'table' })).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});

describe('undo/redo persistence', () => {
  it('undo restores exact geometry and z-order into the database', async () => {
    await seedLayout();
    await applyLayoutCommand('bal-1', 'user-1', 3, { type: 'MOVE', itemId: 'table', x: 33.3, y: 44.4 });
    await applyLayoutCommand('bal-1', 'user-1', 4, { type: 'REORDER', itemId: 'table', direction: 'FRONT' });

    const undoReorder = await undoLayout('bal-1', 'user-1', 5);
    expect(undoReorder.ok).toBe(true);
    if (!undoReorder.ok) return;
    expect(undoReorder.snapshot.items.map((item) => item.id)).toEqual(['table', 'plant']);
    expect(fakeDb.state.revisions.find((rev) => rev.seq === 4)?.undone).toBe(true);

    const undoMove = await undoLayout('bal-1', 'user-1', 6);
    expect(undoMove.ok).toBe(true);
    if (!undoMove.ok) return;
    expect(undoMove.snapshot.items.find((item) => item.id === 'table')).toMatchObject({ x: 0, y: 0 });
    // 数据库中的几何与排序同样精确恢复
    expect(fakeDb.state.items.find((item) => item.id === 'table')).toMatchObject({ x: 0, y: 0, sortOrder: 0 });
    expect(undoMove.canUndo).toBe(true);
    expect(undoMove.canRedo).toBe(true);

    const redo = await redoLayout('bal-1', 'user-1', 7);
    expect(redo.ok).toBe(true);
    if (!redo.ok) return;
    expect(redo.snapshot.items.find((item) => item.id === 'table')).toMatchObject({ x: 33.3, y: 44.4 });
    expect(fakeDb.state.revisions.find((rev) => rev.seq === 3)?.undone).toBe(false);
  });

  it('undo of REMOVE restores the item at its original z position', async () => {
    await seedLayout();
    await applyLayoutCommand('bal-1', 'user-1', 3, { type: 'REMOVE', itemId: 'table' });
    expect(fakeDb.state.items.map((item) => item.id)).toEqual(['plant']);

    const undone = await undoLayout('bal-1', 'user-1', 4);
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(undone.snapshot.items.map((item) => item.id)).toEqual(['table', 'plant']);
    expect(fakeDb.state.items.find((item) => item.id === 'table')).toMatchObject({ x: 0, y: 0, w: 50, h: 50, sortOrder: 0 });
  });

  it('a new command clears the redo stack in the database', async () => {
    await seedLayout();
    await applyLayoutCommand('bal-1', 'user-1', 3, { type: 'MOVE', itemId: 'table', x: 60, y: 10 });
    await undoLayout('bal-1', 'user-1', 4);
    expect(fakeDb.state.revisions.some((rev) => rev.undone)).toBe(true);

    await applyLayoutCommand('bal-1', 'user-1', 5, { type: 'MOVE', itemId: 'table', x: 70, y: 10 });
    expect(fakeDb.state.revisions.every((rev) => !rev.undone)).toBe(true);

    const redo = await redoLayout('bal-1', 'user-1', 6);
    expect(redo.ok).toBe(false);
    if (redo.ok) return;
    expect(redo.code).toBe('NOTHING_TO_REDO');
  });

  it('undo requires the matching baseVersion', async () => {
    await seedLayout();
    const result = await undoLayout('bal-1', 'user-1', 99);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.code).toBe('VERSION_CONFLICT');
  });

  it('reports empty history', async () => {
    await getLayout('bal-1', 'user-1');
    const result = await undoLayout('bal-1', 'user-1', 1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.code).toBe('NOTHING_TO_UNDO');
  });
});
