import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POT_DIAMETER_CM,
  GRID_CM,
  assignZOrder,
  autoPlaceItem,
  clampRectToBounds,
  findLayoutIssues,
  issuesForItem,
  layoutCommitSchema,
  potFootprintCm2,
  reorderIds,
  snapToGrid,
} from './layout.js';

const BALCONY = { widthCm: 300, depthCm: 120 };

const item = (
  id: string,
  rect: { xCm: number; yCm: number; widthCm: number; depthCm: number },
  name?: string,
) => ({ id, name: name ?? id, ...rect });

describe('findLayoutIssues', () => {
  it('accepts disjoint rectangles inside bounds', () => {
    const issues = findLayoutIssues({
      balcony: BALCONY,
      items: [
        item('a', { xCm: 0, yCm: 0, widthCm: 50, depthCm: 50 }),
        item('b', { xCm: 50, yCm: 0, widthCm: 50, depthCm: 50 }),
      ],
    });
    expect(issues).toEqual([]);
  });

  it('flags every kind of boundary violation', () => {
    const cases = [
      item('a', { xCm: -1, yCm: 0, widthCm: 50, depthCm: 50 }),
      item('b', { xCm: 260, yCm: 0, widthCm: 50, depthCm: 50 }),
      item('c', { xCm: 0, yCm: 0, widthCm: 50, depthCm: 130 }),
    ];
    for (const candidate of cases) {
      const issues = findLayoutIssues({ balcony: BALCONY, items: [candidate] });
      expect(issues.map((entry) => entry.code)).toEqual(['OUT_OF_BOUNDS']);
      expect(issues[0].itemId).toBe(candidate.id);
    }
  });

  it('treats edge and corner touching as non-overlapping', () => {
    const touching = findLayoutIssues({
      balcony: BALCONY,
      items: [
        item('a', { xCm: 0, yCm: 0, widthCm: 50, depthCm: 50 }),
        item('b', { xCm: 50, yCm: 0, widthCm: 50, depthCm: 50 }),
        item('c', { xCm: 0, yCm: 50, widthCm: 50, depthCm: 50 }),
      ],
    });
    expect(touching).toEqual([]);
  });

  it('reports a positive-area overlap in both directions', () => {
    const issues = findLayoutIssues({
      balcony: BALCONY,
      items: [
        item('a', { xCm: 0, yCm: 0, widthCm: 60, depthCm: 50 }),
        item('b', { xCm: 50, yCm: 0, widthCm: 50, depthCm: 50 }),
      ],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('ZONE_OVERLAP');
    expect(issues[0].itemId).toBe('a');
    expect(issues[0].otherItemId).toBe('b');
    expect(issuesForItem(issues, 'b').map((entry) => entry.code)).toEqual(['ZONE_OVERLAP']);
  });

  it('flags plants whose pot does not fit a zone side', () => {
    const issues = findLayoutIssues({
      balcony: BALCONY,
      items: [item('z1', { xCm: 0, yCm: 0, widthCm: 40, depthCm: 80 })],
      plantsByZone: new Map([
        [
          'z1',
          [
            { id: 'p1', name: '龟背竹', potSizeCm: 50 },
            { id: 'p2', name: '多肉', potSizeCm: 10 },
          ],
        ],
      ]),
    });
    expect(issues.map((entry) => entry.code)).toEqual(['PLANT_TOO_LARGE']);
    expect(issues[0].plantId).toBe('p1');
  });

  it('flags aggregate area overflow but allows an exact-fit round area', () => {
    // 默认花盆直径 15cm，占地面积 ~176.7cm²；50×50 = 2500cm² 可容纳 14 株。
    const plants = Array.from({ length: 14 }, (_, index) => ({ id: `p${index}`, name: `多肉${index}` }));
    expect(
      findLayoutIssues({
        balcony: BALCONY,
        items: [item('z1', { xCm: 0, yCm: 0, widthCm: 50, depthCm: 50 })],
        plantsByZone: new Map([['z1', plants]]),
      }),
    ).toEqual([]);

    // 20×20 = 400cm² 可放 2 株（~353.5cm²），3 株即溢出，但单盆仍放得下。
    const overflow = findLayoutIssues({
      balcony: BALCONY,
      items: [item('z1', { xCm: 0, yCm: 0, widthCm: 20, depthCm: 20 })],
      plantsByZone: new Map([
        [
          'z1',
          [
            { id: 'p1', name: '多肉1' },
            { id: 'p2', name: '多肉2' },
            { id: 'p3', name: '多肉3' },
          ],
        ],
      ]),
    });
    expect(overflow.map((entry) => entry.code)).toEqual(['PLANT_AREA_EXCEEDED']);
  });

  it('uses the default pot diameter when pot size is missing', () => {
    expect(potFootprintCm2(null)).toBeCloseTo(Math.PI * DEFAULT_POT_DIAMETER_CM ** 2 / 4);
    expect(potFootprintCm2(0)).toBe(potFootprintCm2(undefined));
  });

  it('detects duplicate committed ids', () => {
    const issues = findLayoutIssues({
      balcony: BALCONY,
      items: [
        item('same', { xCm: 0, yCm: 0, widthCm: 10, depthCm: 10 }),
        item('same', { xCm: 100, yCm: 100, widthCm: 10, depthCm: 10 }),
      ],
    });
    expect(issues.map((entry) => entry.code)).toEqual(['DUPLICATE_ITEM']);
  });
});

describe('geometry helpers', () => {
  it('snaps coordinates to the 5cm grid', () => {
    expect(snapToGrid(12)).toBe(10);
    expect(snapToGrid(13)).toBe(15);
    expect(GRID_CM).toBe(5);
  });

  it('clamps a dragged rect fully inside bounds without resizing it', () => {
    expect(clampRectToBounds({ xCm: 280, yCm: 10, widthCm: 80, depthCm: 40 }, BALCONY)).toEqual({
      xCm: 220,
      yCm: 10,
      widthCm: 80,
      depthCm: 40,
    });
    const oversized = clampRectToBounds({ xCm: 0, yCm: 0, widthCm: 400, depthCm: 30 }, BALCONY);
    expect(oversized.widthCm).toBe(300);
    expect(oversized.xCm).toBe(0);
  });

  it('auto-places at the first free grid cell and skips occupied cells', () => {
    expect(autoPlaceItem(BALCONY, [], { widthCm: 50, depthCm: 50 })).toEqual({ xCm: 0, yCm: 0 });
    expect(
      autoPlaceItem(BALCONY, [item('a', { xCm: 0, yCm: 0, widthCm: 50, depthCm: 50 })], {
        widthCm: 50,
        depthCm: 50,
      }),
    ).toEqual({ xCm: 50, yCm: 0 });
  });

  it('returns null when nothing fits', () => {
    expect(
      autoPlaceItem(
        { widthCm: 60, depthCm: 60 },
        [item('a', { xCm: 0, yCm: 0, widthCm: 60, depthCm: 60 })],
        { widthCm: 50, depthCm: 50 },
      ),
    ).toBeNull();
  });
});

describe('z-order', () => {
  it('assigns compact multiples of 10', () => {
    expect(assignZOrder(['a', 'b', 'c'])).toEqual({ a: 0, b: 10, c: 20 });
  });

  it('appends ids missing from the requested order instead of dropping them', () => {
    expect(assignZOrder(['b'], ['a', 'b'])).toEqual({ b: 0, a: 10 });
  });

  it('moves an item before or after another in visual order', () => {
    expect(reorderIds(['a', 'b', 'c', 'd'], 'd', 'b', 'before')).toEqual(['a', 'd', 'b', 'c']);
    expect(reorderIds(['a', 'b', 'c', 'd'], 'a', 'c', 'after')).toEqual(['b', 'c', 'a', 'd']);
    expect(reorderIds(['a', 'b'], 'a', 'a', 'before')).toEqual(['a', 'b']);
  });
});

describe('layoutCommitSchema', () => {
  it('rejects fractional or oversized geometry', () => {
    const valid = {
      expectedVersion: 3,
      items: [{ id: 'ckx1234567890123456789012', xCm: 0, yCm: 0, widthCm: 50, depthCm: 50, zIndex: 10 }],
    };
    expect(layoutCommitSchema.parse(valid).expectedVersion).toBe(3);
    expect(layoutCommitSchema.safeParse({ ...valid, items: [] }).success).toBe(false);
    expect(
      layoutCommitSchema.safeParse({
        ...valid,
        items: [{ ...valid.items[0], widthCm: 5 }],
      }).success,
    ).toBe(false);
  });
});
