import {
  LayoutEngine,
  LAYOUT_HISTORY_LIMIT,
  type LayoutCommand,
  type LayoutEngineResult,
  type LayoutHistoryEffect,
  type LayoutHistoryEntry,
  type LayoutItem,
  type LayoutSnapshot,
} from '@balcony/shared';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { AppError } from '../lib/errors.js';
import { workspaceIdForBalcony } from './authorization.js';

type LayoutWithRelations = Prisma.BalconyLayoutGetPayload<{ include: { items: true; revisions: true } }>;
type Tx = Prisma.TransactionClient;

export interface LayoutView {
  layout: LayoutSnapshot;
  canUndo: boolean;
  canRedo: boolean;
}

/** 并发事务已提交了新版本，当前事务必须回滚 */
class ConcurrentLayoutModification extends Error {}

function toEngine(layout: LayoutWithRelations): LayoutEngine {
  const bySeq = [...layout.revisions].sort((a, b) => a.seq - b.seq);
  const toEntry = (revision: LayoutWithRelations['revisions'][number]): LayoutHistoryEntry => ({
    label: revision.label,
    before: revision.beforeJson as unknown as LayoutItem[],
    after: revision.afterJson as unknown as LayoutItem[],
  });
  return new LayoutEngine(
    {
      version: layout.version,
      widthCm: layout.widthCm,
      depthCm: layout.depthCm,
      items: layout.items.map((item) => ({
        id: item.id,
        kind: item.kind,
        name: item.name,
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h,
        clearanceCm: item.clearanceCm,
        sortOrder: item.sortOrder,
        plantId: item.plantId,
      })),
    },
    {
      // 撤销栈：未撤销的修订按 seq 升序，栈顶是最新一条
      undoStack: bySeq.filter((revision) => !revision.undone).map(toEntry),
      // 重做栈：已撤销的修订按 seq 降序，栈顶是最近撤销的一条
      redoStack: bySeq.filter((revision) => revision.undone).reverse().map(toEntry),
    },
  );
}

async function loadLayout(balconyId: string): Promise<LayoutWithRelations> {
  const layout = await prisma.balconyLayout.findUnique({
    where: { balconyId },
    include: { items: true, revisions: true },
  });
  if (!layout) throw new AppError(404, 'LAYOUT_NOT_FOUND', '布局不存在');
  return layout;
}

export async function getLayout(balconyId: string, userId: string): Promise<LayoutView> {
  await workspaceIdForBalcony(balconyId, userId, 'VIEWER');
  const existing = await prisma.balconyLayout.findUnique({
    where: { balconyId },
    include: { items: true, revisions: true },
  });
  if (existing) {
    const engine = toEngine(existing);
    return { layout: engine.snapshot(), canUndo: engine.canUndo, canRedo: engine.canRedo };
  }
  // 首次访问时创建默认布局；并发创建撞唯一约束则重读
  try {
    const created = await prisma.balconyLayout.create({
      data: { balconyId },
      include: { items: true, revisions: true },
    });
    const engine = toEngine(created);
    return { layout: engine.snapshot(), canUndo: false, canRedo: false };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return getLayout(balconyId, userId);
    }
    throw error;
  }
}

async function persistHistoryEffect(
  tx: Tx,
  layoutId: string,
  effect: LayoutHistoryEffect,
  actorId: string,
): Promise<void> {
  if (effect.type === 'NONE') return;
  if (effect.type === 'PUSH') {
    // 新命令使重做栈失效
    await tx.layoutRevision.deleteMany({ where: { layoutId, undone: true } });
    const { _max } = await tx.layoutRevision.aggregate({ where: { layoutId }, _max: { seq: true } });
    await tx.layoutRevision.create({
      data: {
        layoutId,
        seq: (_max.seq ?? 0) + 1,
        label: effect.entry.label,
        beforeJson: effect.entry.before as unknown as Prisma.InputJsonValue,
        afterJson: effect.entry.after as unknown as Prisma.InputJsonValue,
        actorId,
      },
    });
    // 修剪超出上限的旧历史
    const excess = await tx.layoutRevision.findMany({
      where: { layoutId },
      orderBy: { seq: 'desc' },
      skip: LAYOUT_HISTORY_LIMIT,
      select: { id: true },
    });
    if (excess.length > 0) {
      await tx.layoutRevision.deleteMany({ where: { id: { in: excess.map((row) => row.id) } } });
    }
    return;
  }
  if (effect.type === 'UNDO') {
    const target = await tx.layoutRevision.findFirst({
      where: { layoutId, undone: false },
      orderBy: { seq: 'desc' },
    });
    if (target) await tx.layoutRevision.update({ where: { id: target.id }, data: { undone: true } });
    return;
  }
  const target = await tx.layoutRevision.findFirst({
    where: { layoutId, undone: true },
    orderBy: { seq: 'asc' },
  });
  if (target) await tx.layoutRevision.update({ where: { id: target.id }, data: { undone: false } });
}

async function mutateLayout(
  balconyId: string,
  userId: string,
  mutate: (engine: LayoutEngine) => LayoutEngineResult,
): Promise<LayoutEngineResult> {
  await workspaceIdForBalcony(balconyId, userId, 'EDITOR');
  try {
    return await prisma.$transaction(async (tx) => {
      const layout = await tx.balconyLayout.findUnique({
        where: { balconyId },
        include: { items: true, revisions: true },
      });
      if (!layout) throw new AppError(404, 'LAYOUT_NOT_FOUND', '布局不存在');
      const engine = toEngine(layout);
      const result = mutate(engine);
      // 校验失败 / 版本冲突 / 无操作：不落库，直接返回
      if (!result.ok || result.effect.type === 'NONE') return result;

      // 乐观锁：仅当版本仍是读取时的版本才推进，否则说明有并发事务已提交
      const locked = await tx.balconyLayout.updateMany({
        where: { id: layout.id, version: layout.version },
        data: { version: result.version },
      });
      if (locked.count === 0) throw new ConcurrentLayoutModification();

      await tx.layoutItem.deleteMany({ where: { layoutId: layout.id } });
      if (result.snapshot.items.length > 0) {
        await tx.layoutItem.createMany({
          data: result.snapshot.items.map((item) => ({ ...item, layoutId: layout.id })),
        });
      }
      await persistHistoryEffect(tx, layout.id, result.effect, userId);
      return result;
    });
  } catch (error) {
    if (error instanceof ConcurrentLayoutModification) {
      const fresh = await loadLayout(balconyId);
      const engine = toEngine(fresh);
      return {
        ok: false,
        status: 409,
        code: 'VERSION_CONFLICT',
        message: '布局被他人同时修改，已回滚本次操作，请基于最新版本重试',
        snapshot: engine.snapshot(),
        canUndo: engine.canUndo,
        canRedo: engine.canRedo,
      };
    }
    throw error;
  }
}

export async function applyLayoutCommand(
  balconyId: string,
  userId: string,
  baseVersion: number,
  command: LayoutCommand,
): Promise<LayoutEngineResult> {
  return mutateLayout(balconyId, userId, (engine) => engine.apply(command, baseVersion));
}

export async function undoLayout(balconyId: string, userId: string, baseVersion: number): Promise<LayoutEngineResult> {
  return mutateLayout(balconyId, userId, (engine) => engine.undo(baseVersion));
}

export async function redoLayout(balconyId: string, userId: string, baseVersion: number): Promise<LayoutEngineResult> {
  return mutateLayout(balconyId, userId, (engine) => engine.redo(baseVersion));
}
