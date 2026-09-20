import { z } from 'zod';

/**
 * 阳台布局几何引擎。
 *
 * 所有坐标与尺寸均为整数厘米，原点在阳台左上角：
 * x 轴向右，y 轴向内。几何是布局的唯一事实表达，
 * API 与前端共用同一套校验，避免“前端放行、后端拒绝”或反之。
 */

export const GRID_CM = 5;
export const MIN_BALCONY_SIDE_CM = 50;
export const MAX_BALCONY_SIDE_CM = 5000;
export const MIN_ZONE_SIDE_CM = 10;
export const MAX_ZONE_ITEMS = 200;
/** 未记录花盆直径时的保守默认值（厘米）。 */
export const DEFAULT_POT_DIAMETER_CM = 15;
/** 浮点比较容差，允许两条边恰好贴合。 */
const EPS = 1e-6;

export interface BalconyDimensions {
  widthCm: number;
  depthCm: number;
}

export interface LayoutRect {
  xCm: number;
  yCm: number;
  widthCm: number;
  depthCm: number;
}

export interface LayoutItem extends LayoutRect {
  id: string;
  name?: string | null;
}

export interface LayoutPlantInfo {
  id: string;
  name: string;
  potSizeCm?: number | null;
}

export type LayoutIssueCode =
  | 'DUPLICATE_ITEM'
  | 'OUT_OF_BOUNDS'
  | 'ZONE_OVERLAP'
  | 'PLANT_TOO_LARGE'
  | 'PLANT_AREA_EXCEEDED';

export interface LayoutIssue {
  code: LayoutIssueCode;
  message: string;
  itemId?: string;
  otherItemId?: string;
  plantId?: string;
}

export interface LayoutValidationInput {
  balcony: BalconyDimensions;
  items: LayoutItem[];
  /** zoneId -> 该区域内植物（含花盆直径），用于占用校验。 */
  plantsByZone?: ReadonlyMap<string, readonly LayoutPlantInfo[]>;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function snapToGrid(value: number, gridCm: number = GRID_CM): number {
  return Math.round(value / gridCm) * gridCm;
}

function positiveOverlap(a: LayoutRect, b: LayoutRect): boolean {
  return (
    a.xCm < b.xCm + b.widthCm - EPS &&
    a.xCm + a.widthCm > b.xCm + EPS &&
    a.yCm < b.yCm + b.depthCm - EPS &&
    a.yCm + a.depthCm > b.yCm + EPS
  );
}

/** 花盆按直径折算占地面积（圆形），单位 cm²。 */
export function potFootprintCm2(potSizeCm?: number | null): number {
  const diameter = potSizeCm && potSizeCm > 0 ? potSizeCm : DEFAULT_POT_DIAMETER_CM;
  return (Math.PI * diameter * diameter) / 4;
}

export function zoneFootprintCm2(rect: LayoutRect): number {
  return Math.max(0, rect.widthCm) * Math.max(0, rect.depthCm);
}

export function rectInsideBounds(rect: LayoutRect, balcony: BalconyDimensions): boolean {
  return (
    rect.xCm >= -EPS &&
    rect.yCm >= -EPS &&
    rect.xCm + rect.widthCm <= balcony.widthCm + EPS &&
    rect.yCm + rect.depthCm <= balcony.depthCm + EPS
  );
}

/** 夹住矩形，使其完整落在阳台边界内（尺寸本身不变）。 */
export function clampRectToBounds(rect: LayoutRect, balcony: BalconyDimensions): LayoutRect {
  const widthCm = Math.min(rect.widthCm, balcony.widthCm);
  const depthCm = Math.min(rect.depthCm, balcony.depthCm);
  return {
    xCm: clamp(Math.round(rect.xCm), 0, balcony.widthCm - widthCm),
    yCm: clamp(Math.round(rect.yCm), 0, balcony.depthCm - depthCm),
    widthCm: Math.round(widthCm),
    depthCm: Math.round(depthCm),
  };
}

/**
 * 全量校验布局：重复 id、边界、两两重叠、植物占用。
 * 只报告正面积重叠；边贴合、角点接触不算冲突。
 */
export function findLayoutIssues(input: LayoutValidationInput): LayoutIssue[] {
  const { balcony, items, plantsByZone } = input;
  const issues: LayoutIssue[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    if (seen.has(item.id)) {
      issues.push({ code: 'DUPLICATE_ITEM', itemId: item.id, message: `位置「${item.name ?? item.id}」在提交中重复` });
      continue;
    }
    seen.add(item.id);

    if (!rectInsideBounds(item, balcony)) {
      issues.push({
        code: 'OUT_OF_BOUNDS',
        itemId: item.id,
        message: `位置「${item.name ?? item.id}」超出阳台边界（${balcony.widthCm}×${balcony.depthCm} cm）`,
      });
    }

    const plants = plantsByZone?.get(item.id) ?? [];
    let areaRequired = 0;
    for (const plant of plants) {
      const diameter = plant.potSizeCm && plant.potSizeCm > 0 ? plant.potSizeCm : DEFAULT_POT_DIAMETER_CM;
      if (diameter > item.widthCm + EPS || diameter > item.depthCm + EPS) {
        issues.push({
          code: 'PLANT_TOO_LARGE',
          itemId: item.id,
          plantId: plant.id,
          message: `植物「${plant.name}」花盆 ${diameter}cm，放不下「${item.name ?? item.id}」（${item.widthCm}×${item.depthCm} cm）`,
        });
      }
      areaRequired += potFootprintCm2(plant.potSizeCm);
    }
    if (plants.length > 0 && areaRequired > zoneFootprintCm2(item) + EPS) {
      issues.push({
        code: 'PLANT_AREA_EXCEEDED',
        itemId: item.id,
        message: `位置「${item.name ?? item.id}」面积不足以容纳 ${plants.length} 株植物`,
      });
    }
  }

  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i]!;
      const b = items[j]!;
      if (a.id === b.id) continue;
      if (positiveOverlap(a, b)) {
        issues.push({
          code: 'ZONE_OVERLAP',
          itemId: a.id,
          otherItemId: b.id,
          message: `位置「${a.name ?? a.id}」与「${b.name ?? b.id}」重叠`,
        });
      }
    }
  }

  return issues;
}

export function isValidLayout(input: LayoutValidationInput): boolean {
  return findLayoutIssues(input).length === 0;
}

/** 与指定区域有关的问题（拖拽时用于局部高亮）。 */
export function issuesForItem(issues: readonly LayoutIssue[], itemId: string): LayoutIssue[] {
  return issues.filter((issue) => issue.itemId === itemId || issue.otherItemId === itemId);
}

/**
 * 在网格上寻找第一个不越界、不与现有区域重叠（允许边贴合）的位置。
 * 找不到时返回 null，由调用方决定覆盖策略。
 */
export function autoPlaceItem(
  balcony: BalconyDimensions,
  items: readonly LayoutRect[],
  size: { widthCm: number; depthCm: number },
  gridCm: number = GRID_CM,
): { xCm: number; yCm: number } | null {
  const widthCm = Math.min(size.widthCm, balcony.widthCm);
  const depthCm = Math.min(size.depthCm, balcony.depthCm);
  for (let yCm = 0; yCm + depthCm <= balcony.depthCm + EPS; yCm += gridCm) {
    for (let xCm = 0; xCm + widthCm <= balcony.widthCm + EPS; xCm += gridCm) {
      const candidate: LayoutRect = { xCm, yCm, widthCm, depthCm };
      const collides = items.some((item) => positiveOverlap(candidate, item));
      if (!collides) return { xCm, yCm };
    }
  }
  return null;
}

/**
 * 按给定 id 顺序生成紧凑的 z 序值（步长 10，保留后续插入空间）。
 * 未出现在 orderedIds 中的 id 追加在末尾，保证不丢项。
 */
export function assignZOrder(orderedIds: readonly string[], allIds?: readonly string[]): Record<string, number> {
  const ordered = [...orderedIds];
  for (const id of allIds ?? []) {
    if (!ordered.includes(id)) ordered.push(id);
  }
  return Object.fromEntries(ordered.map((id, index) => [id, index * 10]));
}

export type DropPosition = 'before' | 'after';

/**
 * 在视觉排序列表中把 activeId 移到 overId 前/后。
 * 返回新的完整顺序，便于精确恢复（撤销即换回旧数组）。
 */
export function reorderIds(
  orderedIds: readonly string[],
  activeId: string,
  overId: string,
  position: DropPosition,
): string[] {
  if (activeId === overId) return [...orderedIds];
  const without = orderedIds.filter((id) => id !== activeId);
  const overIndex = without.indexOf(overId);
  if (overIndex === -1) return [...orderedIds];
  const insertAt = position === 'before' ? overIndex : overIndex + 1;
  const next = [...without];
  next.splice(insertAt, 0, activeId);
  return next;
}

/* ----------------------------- Zod 契约 ----------------------------- */

const cmCoordinate = z.number().int().min(0).max(MAX_BALCONY_SIDE_CM);
const cmSize = z.number().int().min(MIN_ZONE_SIDE_CM).max(MAX_BALCONY_SIDE_CM);

export const balconyDimensionsSchema = z.object({
  widthCm: z.number().int().min(MIN_BALCONY_SIDE_CM).max(MAX_BALCONY_SIDE_CM),
  depthCm: z.number().int().min(MIN_BALCONY_SIDE_CM).max(MAX_BALCONY_SIDE_CM),
});

export const layoutItemCommitSchema = z.object({
  id: z.string().cuid(),
  xCm: cmCoordinate,
  yCm: cmCoordinate,
  widthCm: cmSize,
  depthCm: cmSize,
  zIndex: z.number().int().min(0).max(1_000_000),
});

export const layoutCommitSchema = z.object({
  expectedVersion: z.number().int().min(0),
  items: z.array(layoutItemCommitSchema).min(1).max(MAX_ZONE_ITEMS),
});

export type LayoutItemCommit = z.infer<typeof layoutItemCommitSchema>;
export type LayoutCommitInput = z.infer<typeof layoutCommitSchema>;
