import type { Prisma } from '@prisma/client';
import {
  findLayoutIssues,
  type LayoutCommitInput,
  type LayoutPlantInfo,
} from '@balcony/shared';
import { AppError } from '../lib/errors.js';

type TransactionClient = Prisma.TransactionClient;

interface ZoneGeometryRow {
  id: string;
  name: string;
  xCm: number | null;
  yCm: number | null;
  widthCm: number | null;
  depthCm: number | null;
  zIndex: number;
}

/** 乐观锁冲突（HTTP 409）；与“几何不合法”（422）区分开。 */
export class LayoutVersionConflictError extends AppError {
  constructor(public currentVersion: number) {
    super(409, 'LAYOUT_VERSION_CONFLICT', '布局已被他人修改，请刷新后基于最新版本重试');
  }
}

export class LayoutNotConfiguredError extends AppError {
  constructor() {
    super(409, 'LAYOUT_NOT_CONFIGURED', '请先设置阳台尺寸后再使用布局规划');
  }
}

/**
 * 读取阳台的当前布局（加行锁，必须在事务中调用）。
 * 版本号在同一行上递增，配合 SELECT ... FOR UPDATE 串行化并发提交。
 */
export async function lockBalconyLayout(tx: TransactionClient, balconyId: string) {
  const balcony = await tx.$queryRaw<{ workspace_id: string; width_cm: number | null; depth_cm: number | null; layout_version: number | bigint }[]>`
    SELECT "workspaceId" AS workspace_id,
           "widthCm" AS width_cm,
           "depthCm" AS depth_cm,
           "layoutVersion" AS layout_version
    FROM "Balcony"
    WHERE id = ${balconyId}
    FOR UPDATE
  `;
  const row = balcony[0];
  if (!row) throw new AppError(404, 'BALCONY_NOT_FOUND', '阳台不存在');
  return {
    workspaceId: row.workspace_id,
    widthCm: row.width_cm,
    depthCm: row.depth_cm,
    layoutVersion: Number(row.layout_version),
  };
}

async function loadZoneGeometry(tx: TransactionClient, balconyId: string): Promise<ZoneGeometryRow[]> {
  return tx.zone.findMany({
    where: { balconyId, archivedAt: null },
    select: { id: true, name: true, xCm: true, yCm: true, widthCm: true, depthCm: true, zIndex: true },
    orderBy: [{ zIndex: 'asc' }, { sortOrder: 'asc' }],
  });
}

async function loadPlantsByZone(tx: TransactionClient, zoneIds: string[]) {
  if (zoneIds.length === 0) return new Map<string, LayoutPlantInfo[]>();
  const plants = await tx.plant.findMany({
    where: { zoneId: { in: zoneIds }, archivedAt: null },
    select: { id: true, zoneId: true, name: true, potSizeCm: true },
  });
  const map = new Map<string, LayoutPlantInfo[]>();
  for (const plant of plants) {
    const list = map.get(plant.zoneId) ?? [];
    list.push({ id: plant.id, name: plant.name, potSizeCm: plant.potSizeCm });
    map.set(plant.zoneId, list);
  }
  return map;
}

function geometryComplete(row: Pick<ZoneGeometryRow, 'xCm' | 'yCm' | 'widthCm' | 'depthCm'>) {
  return row.xCm !== null && row.yCm !== null && row.widthCm !== null && row.depthCm !== null;
}

/**
 * 提交整份布局：
 * 1. 行锁 + expectedVersion 乐观校验（并发后写者收到 409，绝不覆盖先写者的几何）；
 * 2. 服务端重算重叠/边界/植物占用，不信任前端；
 * 3. 全量更新几何与 zIndex，并把未提交的现有区域保留在提交集合之后；
 * 4. 版本 +1，原子返回新版本。
 */
export async function commitBalconyLayout(tx: TransactionClient, balconyId: string, input: LayoutCommitInput) {
  const locked = await lockBalconyLayout(tx, balconyId);
  if (locked.widthCm === null || locked.depthCm === null) throw new LayoutNotConfiguredError();
  if (input.expectedVersion !== locked.layoutVersion) {
    throw new LayoutVersionConflictError(locked.layoutVersion);
  }

  const existing = await loadZoneGeometry(tx, balconyId);
  const existingById = new Map(existing.map((zone) => [zone.id, zone]));

  // 提交项必须都是该阳台下的未归档位置
  for (const submitted of input.items) {
    const current = existingById.get(submitted.id);
    if (!current) throw new AppError(422, 'ZONE_NOT_IN_BALCONY', `位置 ${submitted.id} 不属于该阳台`);
  }

  const plantsByZone = await loadPlantsByZone(tx, existing.map((zone) => zone.id));

  // 合并：提交项用新几何，未提交的现有区域保留旧几何（部分提交不丢项）
  const submittedIds = new Set(input.items.map((item) => item.id));
  const allItems = [
    ...input.items.map((item) => ({ id: item.id, name: existingById.get(item.id)?.name ?? item.id, xCm: item.xCm, yCm: item.yCm, widthCm: item.widthCm, depthCm: item.depthCm })),
    ...existing
      .filter((zone) => !submittedIds.has(zone.id) && geometryComplete(zone))
      .map((zone) => ({ id: zone.id, name: zone.name, xCm: zone.xCm as number, yCm: zone.yCm as number, widthCm: zone.widthCm as number, depthCm: zone.depthCm as number })),
  ];

  const issues = findLayoutIssues({
    balcony: { widthCm: locked.widthCm, depthCm: locked.depthCm },
    items: allItems,
    plantsByZone,
  });
  if (issues.length > 0) {
    throw new AppError(422, 'LAYOUT_INVALID', '布局校验未通过', { layout: issues.map((issue) => issue.message) });
  }

  // 按提交顺序重排 zIndex（步长 10）
  const zOrderById = new Map(input.items.map((item, index) => [item.id, index * 10]));

  await Promise.all(
    input.items.map((item) =>
      tx.zone.update({
        where: { id: item.id },
        data: {
          xCm: item.xCm,
          yCm: item.yCm,
          widthCm: item.widthCm,
          depthCm: item.depthCm,
          zIndex: zOrderById.get(item.id) ?? item.zIndex,
        },
      }),
    ),
  );

  const updated = await tx.balcony.update({
    where: { id: balconyId },
    data: { layoutVersion: { increment: 1 } },
    select: { layoutVersion: true },
  });

  return { layoutVersion: updated.layoutVersion, zoneCount: input.items.length };
}

/**
 * 修改阳台尺寸后校验：所有已布局区域必须仍在新边界内且互不重叠，
 * 植物占用关系不因改尺寸而豁免。
 */
export async function validateLayoutForDimensions(
  tx: TransactionClient,
  balconyId: string,
  dimensions: { widthCm: number; depthCm: number },
) {
  const zones = await loadZoneGeometry(tx, balconyId);
  const placed = zones.filter(geometryComplete);
  const plantsByZone = await loadPlantsByZone(tx, placed.map((zone) => zone.id));
  const issues = findLayoutIssues({
    balcony: dimensions,
    items: placed.map((zone) => ({
      id: zone.id,
      name: zone.name,
      xCm: zone.xCm as number,
      yCm: zone.yCm as number,
      widthCm: zone.widthCm as number,
      depthCm: zone.depthCm as number,
    })),
    plantsByZone,
  });
  if (issues.length > 0) {
    throw new AppError(422, 'LAYOUT_INVALID', '新尺寸会使现有布局越界或重叠', {
      layout: issues.map((issue) => issue.message),
    });
  }
}

/**
 * 新建/调整单个位置的几何校验（其他区域保持不动）。
 * 阳台尚未设置尺寸时只接受不带几何的提交。
 */
export async function validateZoneUpsert(
  tx: TransactionClient,
  balconyId: string,
  zoneId: string | null,
  rect: { xCm: number; yCm: number; widthCm: number; depthCm: number },
) {
  const balcony = await tx.balcony.findUnique({
    where: { id: balconyId },
    select: { widthCm: true, depthCm: true },
  });
  if (!balcony) throw new AppError(404, 'BALCONY_NOT_FOUND', '阳台不存在');
  if (balcony.widthCm === null || balcony.depthCm === null) {
    throw new AppError(422, 'LAYOUT_NOT_CONFIGURED', '请先设置阳台尺寸，再摆放位置');
  }

  const others = await loadZoneGeometry(tx, balconyId);
  const siblingItems = others
    .filter((zone) => zone.id !== zoneId && geometryComplete(zone))
    .map((zone) => ({
      id: zone.id,
      name: zone.name,
      xCm: zone.xCm as number,
      yCm: zone.yCm as number,
      widthCm: zone.widthCm as number,
      depthCm: zone.depthCm as number,
    }));
  const candidate = { id: zoneId ?? '__new__', name: '', ...rect };
  const issues = findLayoutIssues({
    balcony: { widthCm: balcony.widthCm, depthCm: balcony.depthCm },
    items: [...siblingItems, candidate],
  });
  if (issues.length > 0) {
    throw new AppError(422, 'LAYOUT_INVALID', issues.map((issue) => issue.message).join('；'), {
      layout: issues.map((issue) => issue.message),
    });
  }
}

/**
 * 植物搬入目标位置前的占用校验：
 * 花盆单边放得下，且连同现有植物的总占地不超过区域面积。
 * 返回 true 表示可以搬入；调用方也可直接依赖抛错。
 */
export async function assertPlantFitsZone(
  tx: TransactionClient,
  zoneId: string,
  candidate: { id: string; name: string; potSizeCm?: number | null },
) {
  const zone = await tx.zone.findUnique({
    where: { id: zoneId },
    select: { id: true, name: true, xCm: true, yCm: true, widthCm: true, depthCm: true },
  });
  if (!zone) throw new AppError(404, 'ZONE_NOT_FOUND', '位置不存在');

  // 未布局的位置沿用旧逻辑，不做几何占用校验
  if (!geometryComplete(zone)) return true;

  const issues = findLayoutIssues({
    balcony: { widthCm: zone.xCm! + zone.widthCm!, depthCm: zone.yCm! + zone.depthCm! },
    items: [{ id: zone.id, name: zone.name, xCm: 0, yCm: 0, widthCm: zone.widthCm!, depthCm: zone.depthCm! }],
    plantsByZone: new Map([
      [
        zone.id,
        [
          // 目标位置的现有植物
          ...(await tx.plant.findMany({
            where: { zoneId, archivedAt: null, NOT: { id: candidate.id } },
            select: { id: true, name: true, potSizeCm: true },
          })),
          { id: candidate.id, name: candidate.name, potSizeCm: candidate.potSizeCm },
        ],
      ],
    ]),
  });
  if (issues.length > 0) {
    const tooLarge = issues.find((issue) => issue.code === 'PLANT_TOO_LARGE' && issue.plantId === candidate.id);
    if (tooLarge) throw new AppError(409, 'PLANT_TOO_LARGE_FOR_ZONE', tooLarge.message);
    throw new AppError(409, 'ZONE_AT_CAPACITY', issues[0]!.message);
  }
  return true;
}
