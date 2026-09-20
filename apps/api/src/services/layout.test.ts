import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { LayoutVersionConflictError, commitBalconyLayout } from './layout.js';

type ZoneRow = {
  id: string;
  name: string;
  xCm: number | null;
  yCm: number | null;
  widthCm: number | null;
  depthCm: number | null;
  zIndex: number;
};

type PlantRow = { id: string; zoneId: string; name: string; potSizeCm: number | null };

function makeTx(options: {
  version: number;
  zones: ZoneRow[];
  plants?: PlantRow[];
}) {
  const zones = [...options.zones];
  const plants = options.plants ?? [];
  let version = options.version;

  const tx: unknown = {
    $queryRaw: vi.fn(async () => [
      { workspace_id: 'ws1', width_cm: 300, depth_cm: 120, layout_version: version },
    ]),
    zone: {
      findMany: vi.fn(async () => zones.map((zone) => ({ ...zone }))),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<ZoneRow> }) => {
        const index = zones.findIndex((zone) => zone.id === where.id);
        zones[index] = { ...zones[index]!, ...data };
        return zones[index];
      }),
      findUnique: vi.fn(),
      aggregate: vi.fn(),
    },
    plant: {
      findMany: vi.fn(async ({ where }: { where: { zoneId?: { in: string[] }; archivedAt?: Date | null } }) =>
        where.zoneId ? plants.filter((plant) => where.zoneId!.in.includes(plant.zoneId)) : plants,
      ),
    },
    balcony: {
      findUnique: vi.fn(),
      update: vi.fn(async ({ data }: { data: { layoutVersion?: { increment: number } } }) => {
        version += data.layoutVersion?.increment ?? 0;
        return { layoutVersion: version };
      }),
    },
  };
  return { tx: tx as Prisma.TransactionClient, getZones: () => zones, getVersion: () => version };
}

const baseZones = (): ZoneRow[] => [
  { id: 'z1', name: '东侧栏杆', xCm: 0, yCm: 0, widthCm: 50, depthCm: 50, zIndex: 0 },
  { id: 'z2', name: '西侧花架', xCm: 50, yCm: 0, widthCm: 50, depthCm: 50, zIndex: 10 },
];

describe('commitBalconyLayout', () => {
  it('accepts a matching version and increments it while persisting geometry and z-order', async () => {
    const harness = makeTx({ version: 3, zones: baseZones() });
    const result = await commitBalconyLayout(harness.tx, 'b1', {
      expectedVersion: 3,
      items: [
        { id: 'z2', xCm: 100, yCm: 0, widthCm: 50, depthCm: 50, zIndex: 0 },
        { id: 'z1', xCm: 0, yCm: 0, widthCm: 50, depthCm: 50, zIndex: 10 },
      ],
    });
    expect(result.layoutVersion).toBe(4);
    expect(harness.getVersion()).toBe(4);
    const z2 = harness.getZones().find((zone) => zone.id === 'z2');
    expect(z2?.xCm).toBe(100);
    // 提交顺序即视觉顺序：z2 在第一项 → zIndex 0
    expect(z2?.zIndex).toBe(0);
  });

  it('rejects a stale expectedVersion with LAYOUT_VERSION_CONFLICT and changes nothing', async () => {
    const harness = makeTx({ version: 5, zones: baseZones() });
    await expect(
      commitBalconyLayout(harness.tx, 'b1', {
        expectedVersion: 4,
        items: [{ id: 'z1', xCm: 0, yCm: 0, widthCm: 50, depthCm: 50, zIndex: 0 }],
      }),
    ).rejects.toBeInstanceOf(LayoutVersionConflictError);
    expect(harness.getVersion()).toBe(5);
    expect(harness.getZones()[0]).toEqual(baseZones()[0]);
  });

  it('rejects overlapping geometry even when the version matches', async () => {
    const harness = makeTx({ version: 0, zones: baseZones() });
    await expect(
      commitBalconyLayout(harness.tx, 'b1', {
        expectedVersion: 0,
        items: [
          { id: 'z1', xCm: 0, yCm: 0, widthCm: 80, depthCm: 50, zIndex: 0 },
          { id: 'z2', xCm: 50, yCm: 0, widthCm: 50, depthCm: 50, zIndex: 10 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'LAYOUT_INVALID' });
    // 版本不递增、几何不落库
    expect(harness.getVersion()).toBe(0);
  });

  it('rejects out-of-bounds geometry', async () => {
    const harness = makeTx({ version: 0, zones: baseZones() });
    await expect(
      commitBalconyLayout(harness.tx, 'b1', {
        expectedVersion: 0,
        items: [
          { id: 'z1', xCm: 0, yCm: 0, widthCm: 50, depthCm: 50, zIndex: 0 },
          { id: 'z2', xCm: 260, yCm: 0, widthCm: 50, depthCm: 50, zIndex: 10 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'LAYOUT_INVALID' });
  });

  it('rejects when plants cannot fit the committed geometry', async () => {
    const harness = makeTx({
      version: 2,
      zones: baseZones(),
      plants: [{ id: 'p1', zoneId: 'z1', name: '龟背竹', potSizeCm: 60 }],
    });
    // z1 原 50×50 放得下小盆；改成 40×40 且植物盆径 60 → 单边放不下
    await expect(
      commitBalconyLayout(harness.tx, 'b1', {
        expectedVersion: 2,
        items: [
          { id: 'z1', xCm: 0, yCm: 0, widthCm: 40, depthCm: 40, zIndex: 0 },
          { id: 'z2', xCm: 50, yCm: 0, widthCm: 50, depthCm: 50, zIndex: 10 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'LAYOUT_INVALID' });
  });

  it('rejects items that do not belong to this balcony', async () => {
    const harness = makeTx({ version: 0, zones: baseZones() });
    await expect(
      commitBalconyLayout(harness.tx, 'b1', {
        expectedVersion: 0,
        items: [
          { id: 'z1', xCm: 0, yCm: 0, widthCm: 50, depthCm: 50, zIndex: 0 },
          { id: 'z-other', xCm: 50, yCm: 0, widthCm: 50, depthCm: 50, zIndex: 10 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'ZONE_NOT_IN_BALCONY' });
  });
});
