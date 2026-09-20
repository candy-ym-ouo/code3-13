import { describe, expect, it } from 'vitest';
import {
  LayoutEngine,
  occupiedRect,
  rectInBounds,
  rectsOverlap,
  validatePlacement,
  type LayoutItem,
  type LayoutSnapshot,
} from './layout.js';

function item(partial: Partial<LayoutItem> & Pick<LayoutItem, 'id'>): LayoutItem {
  return {
    kind: 'FURNITURE',
    name: partial.id,
    x: 0,
    y: 0,
    w: 40,
    h: 40,
    clearanceCm: 0,
    sortOrder: 0,
    plantId: null,
    ...partial,
  };
}

function seed(): LayoutSnapshot {
  return {
    version: 1,
    widthCm: 200,
    depthCm: 100,
    items: [
      item({ id: 'table', name: '折叠桌', x: 0, y: 0, w: 50, h: 50, sortOrder: 0 }),
      item({ id: 'plant', kind: 'PLANT', name: '绿萝', x: 150, y: 0, w: 30, h: 30, clearanceCm: 5, sortOrder: 10 }),
    ],
  };
}

describe('rectsOverlap', () => {
  const a = { x: 0, y: 0, w: 10, h: 10 };

  it('detects partial overlap and containment', () => {
    expect(rectsOverlap(a, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
    expect(rectsOverlap(a, { x: 2, y: 2, w: 2, h: 2 })).toBe(true);
  });

  it('treats touching edges as non-overlapping', () => {
    expect(rectsOverlap(a, { x: 10, y: 0, w: 10, h: 10 })).toBe(false);
    expect(rectsOverlap(a, { x: 0, y: 10, w: 10, h: 10 })).toBe(false);
  });

  it('detects separated rectangles', () => {
    expect(rectsOverlap(a, { x: 20, y: 20, w: 5, h: 5 })).toBe(false);
  });
});

describe('occupiedRect / rectInBounds', () => {
  it('inflates plant rect by clearance', () => {
    expect(occupiedRect({ x: 10, y: 10, w: 20, h: 20, clearanceCm: 5 })).toEqual({ x: 5, y: 5, w: 30, h: 30 });
    expect(occupiedRect({ x: 10, y: 10, w: 20, h: 20 })).toEqual({ x: 10, y: 10, w: 20, h: 20 });
  });

  it('checks bounds inclusively at the far edge', () => {
    expect(rectInBounds({ x: 0, y: 0, w: 200, h: 100 }, 200, 100)).toBe(true);
    expect(rectInBounds({ x: 199.9, y: 0, w: 0.2, h: 10 }, 200, 100)).toBe(false);
    expect(rectInBounds({ x: -0.1, y: 0, w: 10, h: 10 }, 200, 100)).toBe(false);
  });
});

describe('validatePlacement', () => {
  const state = seed();

  it('accepts a valid free spot', () => {
    const check = validatePlacement(state.items, state, { id: 'table' }, { x: 60, y: 10, w: 50, h: 50 });
    expect(check).toEqual({ ok: true, violations: [] });
  });

  it('rejects out-of-bounds placement', () => {
    const check = validatePlacement(state.items, state, { id: 'table' }, { x: 160, y: 0, w: 50, h: 50 });
    expect(check.ok).toBe(false);
    expect(check.violations.map((v) => v.type)).toContain('OUT_OF_BOUNDS');
  });

  it('reports overlap with furniture', () => {
    const items = [...state.items, item({ id: 'chair', name: '椅子', x: 60, y: 0, w: 40, h: 40 })];
    const check = validatePlacement(items, state, { id: 'table' }, { x: 70, y: 0, w: 50, h: 50 });
    expect(check.violations).toEqual([{ type: 'OVERLAP', itemId: 'chair', message: '与「椅子」重叠' }]);
  });

  it('reports plant occupancy inside the clearance halo without touching the plant', () => {
    // 植物本体 150..180，缓冲区 145..185；桌子放 100..150 只侵入缓冲区
    const check = validatePlacement(state.items, state, { id: 'table' }, { x: 100, y: 0, w: 50, h: 50 });
    expect(check.ok).toBe(false);
    expect(check.violations).toEqual([{ type: 'PLANT_OCCUPIED', itemId: 'plant', message: '被植物「绿萝」占用' }]);
  });

  it('ignores the moving item itself', () => {
    const check = validatePlacement(state.items, state, { id: 'table' }, { x: 0, y: 0, w: 50, h: 50 });
    expect(check.ok).toBe(true);
  });

  it('lets a dragged plant push others away with its own clearance', () => {
    // 绿萝（缓冲 5）放到 55,0：自身占用 50..90，与桌子 0..50 贴边不冲突
    const ok = validatePlacement(state.items, state, { id: 'plant', clearanceCm: 5 }, { x: 55, y: 0, w: 30, h: 30 });
    expect(ok.ok).toBe(true);
    // 放到 54,0：占用 49..89，与桌子重叠
    const bad = validatePlacement(state.items, state, { id: 'plant', clearanceCm: 5 }, { x: 54, y: 0, w: 30, h: 30 });
    expect(bad.ok).toBe(false);
  });
});

describe('LayoutEngine.apply', () => {
  it('applies a move, quantizes geometry and bumps version', () => {
    const engine = new LayoutEngine(seed());
    const result = engine.apply({ type: 'MOVE', itemId: 'table', x: 60.04, y: 10.06 }, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.version).toBe(2);
    expect(result.effect.type).toBe('PUSH');
    const table = result.snapshot.items.find((i) => i.id === 'table');
    expect([table?.x, table?.y]).toEqual([60, 10.1]);
  });

  it('rejects stale baseVersion with 409 and keeps state untouched', () => {
    const engine = new LayoutEngine(seed());
    const result = engine.apply({ type: 'MOVE', itemId: 'table', x: 60, y: 10 }, 7);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.code).toBe('VERSION_CONFLICT');
    expect(result.snapshot.items.find((i) => i.id === 'table')).toMatchObject({ x: 0, y: 0 });
    expect(engine.version).toBe(1);
  });

  it('rejects invalid placement with 422 and does not bump version', () => {
    const engine = new LayoutEngine(seed());
    const result = engine.apply({ type: 'MOVE', itemId: 'table', x: 100, y: 0 }, 1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(422);
    expect(result.code).toBe('INVALID_PLACEMENT');
    expect(result.violations?.[0]?.type).toBe('PLANT_OCCUPIED');
    expect(engine.version).toBe(1);
    expect(engine.canUndo).toBe(false);
  });

  it('treats a no-op move as success without version bump or history', () => {
    const engine = new LayoutEngine(seed());
    const result = engine.apply({ type: 'MOVE', itemId: 'table', x: 0, y: 0 }, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.version).toBe(1);
    expect(result.effect.type).toBe('NONE');
    expect(result.canUndo).toBe(false);
  });

  it('validates resize and rejects shrinking below minimum', () => {
    const engine = new LayoutEngine(seed());
    const tooSmall = engine.apply({ type: 'RESIZE', itemId: 'table', w: 3, h: 3 }, 1);
    expect(tooSmall.ok).toBe(false);
    if (tooSmall.ok) return;
    expect(tooSmall.code).toBe('ITEM_TOO_SMALL');

    const ok = engine.apply({ type: 'RESIZE', itemId: 'table', w: 60, h: 60 }, 1);
    expect(ok.ok).toBe(true);
    expect(engine.snapshot().items.find((i) => i.id === 'table')).toMatchObject({ w: 60, h: 60 });
  });

  it('adds and removes items, keeping z-order contiguous', () => {
    const engine = new LayoutEngine(seed());
    const added = engine.apply(
      { type: 'ADD', item: item({ id: 'chair', name: '椅子', x: 60, y: 60, w: 40, h: 40 }) },
      1,
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.snapshot.items.map((i) => [i.id, i.sortOrder])).toEqual([
      ['table', 0],
      ['plant', 10],
      ['chair', 20],
    ]);

    const duplicate = engine.apply(
      { type: 'ADD', item: item({ id: 'chair', name: '椅子', x: 0, y: 60, w: 40, h: 40 }) },
      2,
    );
    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) return;
    expect(duplicate.code).toBe('ITEM_EXISTS');

    const removed = engine.apply({ type: 'REMOVE', itemId: 'plant' }, 2);
    expect(removed.ok).toBe(true);
    expect(engine.snapshot().items.map((i) => i.id)).toEqual(['table', 'chair']);
  });

  it('reorders items to front and back', () => {
    const engine = new LayoutEngine(seed());
    const result = engine.apply({ type: 'REORDER', itemId: 'table', direction: 'FRONT' }, 1);
    expect(result.ok).toBe(true);
    expect(engine.snapshot().items.map((i) => i.id)).toEqual(['plant', 'table']);
    const back = engine.apply({ type: 'REORDER', itemId: 'table', direction: 'BACK' }, 2);
    expect(back.ok).toBe(true);
    expect(engine.snapshot().items.map((i) => i.id)).toEqual(['table', 'plant']);
  });
});

describe('LayoutEngine undo/redo', () => {
  it('restores exact geometry and ordering after undo', () => {
    const engine = new LayoutEngine(seed());
    engine.apply({ type: 'MOVE', itemId: 'table', x: 33.3, y: 44.4 }, 1);
    engine.apply({ type: 'REORDER', itemId: 'table', direction: 'FRONT' }, 2);
    engine.apply({ type: 'RESIZE', itemId: 'plant', w: 35, h: 25 }, 3);
    expect(engine.version).toBe(4);

    const undone = engine.undo(4);
    expect(undone.ok).toBe(true);
    expect(engine.version).toBe(5);
    // 撤销 resize：植物恢复 30x30
    expect(engine.snapshot().items.find((i) => i.id === 'plant')).toMatchObject({ w: 30, h: 30 });

    engine.undo(5);
    // 撤销 reorder：顺序恢复 table 在底层
    expect(engine.snapshot().items.map((i) => [i.id, i.sortOrder])).toEqual([
      ['table', 0],
      ['plant', 10],
    ]);

    engine.undo(6);
    // 撤销 move：几何精确恢复
    expect(engine.snapshot().items.find((i) => i.id === 'table')).toMatchObject({ x: 0, y: 0, w: 50, h: 50 });
    expect(engine.canUndo).toBe(false);
  });

  it('restores a removed item at its original z position', () => {
    const engine = new LayoutEngine(seed());
    engine.apply(
      { type: 'ADD', item: item({ id: 'chair', name: '椅子', x: 60, y: 60, w: 40, h: 40 }) },
      1,
    );
    engine.apply({ type: 'REMOVE', itemId: 'plant' }, 2);
    expect(engine.snapshot().items.map((i) => i.id)).toEqual(['table', 'chair']);

    engine.undo(3);
    const snapshot = engine.snapshot();
    expect(snapshot.items.map((i) => i.id)).toEqual(['table', 'plant', 'chair']);
    const plant = snapshot.items.find((i) => i.id === 'plant');
    expect(plant).toMatchObject({ x: 150, y: 0, w: 30, h: 30, clearanceCm: 5, sortOrder: 10 });
  });

  it('redoes in reverse order and clears redo stack on new command', () => {
    const engine = new LayoutEngine(seed());
    engine.apply({ type: 'MOVE', itemId: 'table', x: 60, y: 10 }, 1);
    engine.apply({ type: 'MOVE', itemId: 'table', x: 70, y: 10 }, 2);
    engine.undo(3);
    engine.undo(4);
    expect(engine.snapshot().items.find((i) => i.id === 'table')).toMatchObject({ x: 0, y: 0 });

    const redo1 = engine.redo(5);
    expect(redo1.ok).toBe(true);
    expect(engine.snapshot().items.find((i) => i.id === 'table')).toMatchObject({ x: 60, y: 10 });

    engine.undo(6);
    // 新命令清空重做栈
    engine.apply({ type: 'MOVE', itemId: 'table', x: 80, y: 10 }, 7);
    expect(engine.canRedo).toBe(false);
    const redo = engine.redo(8);
    expect(redo.ok).toBe(false);
    if (redo.ok) return;
    expect(redo.code).toBe('NOTHING_TO_REDO');
  });

  it('requires matching baseVersion for undo/redo', () => {
    const engine = new LayoutEngine(seed());
    engine.apply({ type: 'MOVE', itemId: 'table', x: 60, y: 10 }, 1);
    const stale = engine.undo(1);
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.status).toBe(409);
    expect(engine.version).toBe(2);
    expect(engine.canUndo).toBe(true);
  });

  it('reports empty history', () => {
    const engine = new LayoutEngine(seed());
    const undo = engine.undo(1);
    expect(undo.ok).toBe(false);
    if (undo.ok) return;
    expect(undo.code).toBe('NOTHING_TO_UNDO');
  });
});
