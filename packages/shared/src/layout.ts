import { z } from 'zod';

/**
 * 阳台空间布局规划：几何校验、版本化并发控制、撤销/重做。
 * 该模块为纯逻辑，前端拖拽实时校验与后端持久化共用同一份实现。
 */

/* ==================== 几何基础 ==================== */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const LAYOUT_ITEM_KINDS = ['FURNITURE', 'PLANT'] as const;
export type LayoutItemKind = (typeof LAYOUT_ITEM_KINDS)[number];

export interface LayoutItem extends Rect {
  id: string;
  kind: LayoutItemKind;
  name: string;
  /** 植物生长缓冲（cm）：其他物品不可侵入的外扩区域，家具为 0 */
  clearanceCm: number;
  /** 叠放次序，越大越靠上 */
  sortOrder: number;
  plantId: string | null;
}

export interface LayoutSnapshot {
  version: number;
  widthCm: number;
  depthCm: number;
  /** 按 sortOrder 升序，数组顺序即叠放次序 */
  items: LayoutItem[];
}

/** 坐标量化到 0.1cm（毫米精度），保证拖拽、撤销与并发比较时几何完全一致 */
export function quantize(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 物品实际占用区域：植物向外扩展生长缓冲 */
export function occupiedRect(item: Rect & { clearanceCm?: number }): Rect {
  const clearance = item.clearanceCm ?? 0;
  return {
    x: item.x - clearance,
    y: item.y - clearance,
    w: item.w + 2 * clearance,
    h: item.h + 2 * clearance,
  };
}

/** 贴边相邻不算重叠 */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function rectInBounds(rect: Rect, widthCm: number, depthCm: number): boolean {
  return rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= widthCm && rect.y + rect.h <= depthCm;
}

/* ==================== 放置校验 ==================== */

export type PlacementViolationType = 'OUT_OF_BOUNDS' | 'OVERLAP' | 'PLANT_OCCUPIED';

export interface PlacementViolation {
  type: PlacementViolationType;
  itemId?: string;
  message: string;
}

export interface PlacementCheck {
  ok: boolean;
  violations: PlacementViolation[];
}

/**
 * 校验把 moving 放置到 rect 是否合法：边界、物品重叠、植物占用。
 * moving.id 用于排除自身；moving.clearanceCm 让被拖植物自身的缓冲区也参与校验。
 */
export function validatePlacement(
  items: LayoutItem[],
  bounds: { widthCm: number; depthCm: number },
  moving: { id: string | null; clearanceCm?: number },
  rect: Rect,
): PlacementCheck {
  const violations: PlacementViolation[] = [];
  if (!rectInBounds(rect, bounds.widthCm, bounds.depthCm)) {
    violations.push({ type: 'OUT_OF_BOUNDS', message: '超出阳台边界' });
  }
  const movingOccupied = occupiedRect({ ...rect, clearanceCm: moving.clearanceCm ?? 0 });
  for (const other of items) {
    if (moving.id !== null && other.id === moving.id) continue;
    if (!rectsOverlap(movingOccupied, occupiedRect(other))) continue;
    violations.push(
      other.kind === 'PLANT'
        ? { type: 'PLANT_OCCUPIED', itemId: other.id, message: `被植物「${other.name}」占用` }
        : { type: 'OVERLAP', itemId: other.id, message: `与「${other.name}」重叠` },
    );
  }
  return { ok: violations.length === 0, violations };
}

/* ==================== 命令与输入校验 ==================== */

export const layoutItemInputSchema = z.object({
  id: z.string().trim().min(1).max(64),
  kind: z.enum(LAYOUT_ITEM_KINDS),
  name: z.string().trim().min(1).max(80),
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite().positive().max(2000),
  h: z.number().finite().positive().max(2000),
  clearanceCm: z.number().finite().min(0).max(200).default(0),
  plantId: z.string().cuid().nullable().default(null),
});

export const layoutCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('MOVE'), itemId: z.string().min(1).max(64), x: z.number().finite(), y: z.number().finite() }),
  z.object({
    type: z.literal('RESIZE'),
    itemId: z.string().min(1).max(64),
    w: z.number().finite().positive().max(2000),
    h: z.number().finite().positive().max(2000),
  }),
  z.object({ type: z.literal('ADD'), item: layoutItemInputSchema }),
  z.object({ type: z.literal('REMOVE'), itemId: z.string().min(1).max(64) }),
  z.object({ type: z.literal('REORDER'), itemId: z.string().min(1).max(64), direction: z.enum(['FRONT', 'BACK']) }),
]);
export type LayoutCommand = z.infer<typeof layoutCommandSchema>;

export const layoutCommandRequestSchema = z.object({
  baseVersion: z.number().int().min(0),
  command: layoutCommandSchema,
});

export const layoutHistoryRequestSchema = z.object({
  baseVersion: z.number().int().min(0),
});

/* ==================== 布局引擎 ==================== */

const SORT_STEP = 10;
const MIN_ITEM_SIZE_CM = 5;
export const LAYOUT_HISTORY_LIMIT = 100;

export interface LayoutHistoryEntry {
  label: string;
  /** 变更前的完整物品列表（含几何与 sortOrder） */
  before: LayoutItem[];
  after: LayoutItem[];
}

/** 告知持久化层本次变更对历史栈的影响 */
export type LayoutHistoryEffect =
  | { type: 'NONE' }
  | { type: 'PUSH'; entry: LayoutHistoryEntry }
  | { type: 'UNDO' }
  | { type: 'REDO' };

export interface LayoutEngineOk {
  ok: true;
  version: number;
  snapshot: LayoutSnapshot;
  canUndo: boolean;
  canRedo: boolean;
  effect: LayoutHistoryEffect;
}

export interface LayoutEngineError {
  ok: false;
  status: number;
  code: string;
  message: string;
  violations?: PlacementViolation[];
  snapshot: LayoutSnapshot;
  canUndo: boolean;
  canRedo: boolean;
}

export type LayoutEngineResult = LayoutEngineOk | LayoutEngineError;

type ExecuteOk = { ok: true; label: string; noop?: boolean };
type ExecuteError = { ok: false; status: number; code: string; message: string; violations?: PlacementViolation[] };

function cloneItems(items: LayoutItem[]): LayoutItem[] {
  return items.map((item) => ({ ...item }));
}

function cloneEntry(entry: LayoutHistoryEntry): LayoutHistoryEntry {
  return { label: entry.label, before: cloneItems(entry.before), after: cloneItems(entry.after) };
}

export class LayoutEngine {
  readonly widthCm: number;
  readonly depthCm: number;
  version: number;
  private items: LayoutItem[];
  private undoStack: LayoutHistoryEntry[];
  private redoStack: LayoutHistoryEntry[];

  constructor(
    snapshot: LayoutSnapshot,
    history?: { undoStack?: LayoutHistoryEntry[]; redoStack?: LayoutHistoryEntry[] },
  ) {
    this.widthCm = snapshot.widthCm;
    this.depthCm = snapshot.depthCm;
    this.version = snapshot.version;
    this.items = cloneItems(snapshot.items).sort((a, b) => a.sortOrder - b.sortOrder);
    this.undoStack = (history?.undoStack ?? []).map(cloneEntry);
    this.redoStack = (history?.redoStack ?? []).map(cloneEntry);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  snapshot(): LayoutSnapshot {
    return {
      version: this.version,
      widthCm: this.widthCm,
      depthCm: this.depthCm,
      items: cloneItems(this.items),
    };
  }

  /** 应用一条变更命令。baseVersion 与当前版本不一致时拒绝（乐观并发控制）。 */
  apply(command: LayoutCommand, baseVersion: number): LayoutEngineResult {
    const conflict = this.versionConflict(baseVersion);
    if (conflict) return conflict;
    const before = cloneItems(this.items);
    const executed = this.execute(command);
    if (!executed.ok) return this.failure(executed);
    if (executed.noop) {
      return this.success({ type: 'NONE' });
    }
    const entry: LayoutHistoryEntry = { label: executed.label, before, after: cloneItems(this.items) };
    this.undoStack.push(entry);
    if (this.undoStack.length > LAYOUT_HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.version += 1;
    return this.success({ type: 'PUSH', entry });
  }

  /** 撤销最近一次变更，精确恢复几何与叠放次序 */
  undo(baseVersion: number): LayoutEngineResult {
    return this.travel(baseVersion, 'undo');
  }

  redo(baseVersion: number): LayoutEngineResult {
    return this.travel(baseVersion, 'redo');
  }

  private travel(baseVersion: number, direction: 'undo' | 'redo'): LayoutEngineResult {
    const conflict = this.versionConflict(baseVersion);
    if (conflict) return conflict;
    const [from, to] = direction === 'undo' ? [this.undoStack, this.redoStack] : [this.redoStack, this.undoStack];
    const entry = from.pop();
    if (!entry) {
      return this.failure({
        ok: false,
        status: 400,
        code: direction === 'undo' ? 'NOTHING_TO_UNDO' : 'NOTHING_TO_REDO',
        message: direction === 'undo' ? '没有可撤销的操作' : '没有可重做的操作',
      });
    }
    to.push(entry);
    this.items = cloneItems(direction === 'undo' ? entry.before : entry.after);
    this.version += 1;
    return this.success({ type: direction === 'undo' ? 'UNDO' : 'REDO' });
  }

  private versionConflict(baseVersion: number): LayoutEngineError | null {
    if (baseVersion === this.version) return null;
    return this.failure({
      ok: false,
      status: 409,
      code: 'VERSION_CONFLICT',
      message: `布局已被他人修改（当前版本 v${this.version}），请同步后重试`,
    });
  }

  private success(effect: LayoutHistoryEffect): LayoutEngineOk {
    return {
      ok: true,
      version: this.version,
      snapshot: this.snapshot(),
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      effect,
    };
  }

  private failure(error: ExecuteError): LayoutEngineError {
    return { ...error, snapshot: this.snapshot(), canUndo: this.canUndo, canRedo: this.canRedo };
  }

  private execute(command: LayoutCommand): ExecuteOk | ExecuteError {
    switch (command.type) {
      case 'MOVE': {
        const item = this.findItem(command.itemId);
        if (!item) return itemNotFound();
        const rect = { x: quantize(command.x), y: quantize(command.y), w: item.w, h: item.h };
        if (rect.x === item.x && rect.y === item.y) return { ok: true, label: '', noop: true };
        const check = validatePlacement(this.items, this, item, rect);
        if (!check.ok) return invalidPlacement(check.violations);
        item.x = rect.x;
        item.y = rect.y;
        return { ok: true, label: `移动「${item.name}」` };
      }
      case 'RESIZE': {
        const item = this.findItem(command.itemId);
        if (!item) return itemNotFound();
        const rect = { x: item.x, y: item.y, w: quantize(command.w), h: quantize(command.h) };
        if (rect.w < MIN_ITEM_SIZE_CM || rect.h < MIN_ITEM_SIZE_CM) {
          return { ok: false, status: 422, code: 'ITEM_TOO_SMALL', message: `物品尺寸不能小于 ${MIN_ITEM_SIZE_CM}cm` };
        }
        if (rect.w === item.w && rect.h === item.h) return { ok: true, label: '', noop: true };
        const check = validatePlacement(this.items, this, item, rect);
        if (!check.ok) return invalidPlacement(check.violations);
        item.w = rect.w;
        item.h = rect.h;
        return { ok: true, label: `调整「${item.name}」尺寸` };
      }
      case 'ADD': {
        if (this.items.some((item) => item.id === command.item.id)) {
          return { ok: false, status: 409, code: 'ITEM_EXISTS', message: '物品已存在（可能是重复提交）' };
        }
        const item: LayoutItem = {
          ...command.item,
          x: quantize(command.item.x),
          y: quantize(command.item.y),
          w: quantize(command.item.w),
          h: quantize(command.item.h),
          clearanceCm: quantize(command.item.clearanceCm),
          sortOrder: 0,
        };
        const check = validatePlacement(this.items, this, item, item);
        if (!check.ok) return invalidPlacement(check.violations);
        this.items.push(item);
        this.normalizeSortOrder();
        return { ok: true, label: `添加「${item.name}」` };
      }
      case 'REMOVE': {
        const index = this.items.findIndex((item) => item.id === command.itemId);
        if (index < 0) return itemNotFound();
        const removed = this.items[index]!;
        this.items.splice(index, 1);
        this.normalizeSortOrder();
        return { ok: true, label: `删除「${removed.name}」` };
      }
      case 'REORDER': {
        const index = this.items.findIndex((item) => item.id === command.itemId);
        if (index < 0) return itemNotFound();
        const targetIndex = command.direction === 'FRONT' ? this.items.length - 1 : 0;
        if (index === targetIndex) return { ok: true, label: '', noop: true };
        const item = this.items[index]!;
        this.items.splice(index, 1);
        if (command.direction === 'FRONT') this.items.push(item);
        else this.items.unshift(item);
        this.normalizeSortOrder();
        return { ok: true, label: `调整「${item.name}」层级` };
      }
    }
  }

  private findItem(itemId: string): LayoutItem | undefined {
    return this.items.find((item) => item.id === itemId);
  }

  /** 结构性变更后重排 sortOrder 为等差序列，保持数组顺序即叠放次序 */
  private normalizeSortOrder(): void {
    this.items.forEach((item, index) => {
      item.sortOrder = index * SORT_STEP;
    });
  }
}

function itemNotFound(): ExecuteError {
  return { ok: false, status: 404, code: 'ITEM_NOT_FOUND', message: '物品不存在（可能已被他人删除）' };
}

function invalidPlacement(violations: PlacementViolation[]): ExecuteError {
  return {
    ok: false,
    status: 422,
    code: 'INVALID_PLACEMENT',
    message: violations.map((violation) => violation.message).join('；'),
    violations,
  };
}
