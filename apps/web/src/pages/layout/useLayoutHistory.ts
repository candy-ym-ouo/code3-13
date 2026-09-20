import { useCallback, useMemo, useState } from 'react';
import { assignZOrder, type LayoutItemCommit } from '@balcony/shared';

/**
 * 布局撤销/重做。
 *
 * 历史快照只保存每个位置的精确几何（整数厘米）与视觉顺序（id 数组）；
 * z 序由顺序数组重新派生，因此「拖动 → 置顶 → 保存 → 撤销」能同时
 * 回到旧坐标与旧层叠关系。
 *
 * 乐观锁版本不进快照：已保存的撤销是“用旧几何发起一次新版本提交”，
 * expectedVersion 始终取服务端最新版本，否则正常撤销也会被 409 拒绝。
 */
export interface LayoutSnapshot {
  /** 视觉顺序（从前到后）。 */
  order: string[];
  geometry: Record<string, { xCm: number; yCm: number; widthCm: number; depthCm: number }>;
}

const MAX_HISTORY = 50;

export function useLayoutHistory(initial: LayoutSnapshot | null) {
  const [past, setPast] = useState<LayoutSnapshot[]>([]);
  const [present, setPresent] = useState<LayoutSnapshot | null>(initial);
  const [future, setFuture] = useState<LayoutSnapshot[]>([]);

  /** 完成一次本地编辑（拖放/缩放/排序）：当前帧入历史，清空重做栈。 */
  const push = useCallback((next: LayoutSnapshot) => {
    setPresent((current) => {
      setPast((history) => [...history.slice(-(MAX_HISTORY - 1)), ...(current ? [current] : [])]);
      return next;
    });
    setFuture([]);
  }, []);

  const undo = useCallback((): LayoutSnapshot | null => {
    let restored: LayoutSnapshot | null = null;
    setPast((history) => {
      if (history.length === 0) return history;
      const previous = history[history.length - 1]!;
      restored = previous;
      setPresent((current) => {
        if (current) setFuture((upcoming) => [current, ...upcoming]);
        return previous;
      });
      return history.slice(0, -1);
    });
    return restored;
  }, []);

  const redo = useCallback((): LayoutSnapshot | null => {
    let restored: LayoutSnapshot | null = null;
    setFuture((upcoming) => {
      if (upcoming.length === 0) return upcoming;
      const next = upcoming[0]!;
      restored = next;
      setPresent((current) => {
        if (current) setPast((history) => [...history, current].slice(-MAX_HISTORY));
        return next;
      });
      return upcoming.slice(1);
    });
    return restored;
  }, []);

  /** 服务端合并/刷新后重置基线，不产生可撤销步骤。 */
  const reset = useCallback((snapshot: LayoutSnapshot) => {
    setPast([]);
    setFuture([]);
    setPresent(snapshot);
  }, []);

  const canUndo = past.length > 0;
  const canRedo = future.length > 0;

  const commitItems = useMemo((): LayoutItemCommit[] => {
    if (!present) return [];
    const allIds = Object.keys(present.geometry);
    const zOrder = assignZOrder(present.order, allIds);
    const ordered = [...present.order, ...allIds.filter((id) => !present!.order.includes(id))];
    return ordered.map((id) => ({ id, ...present!.geometry[id]!, zIndex: zOrder[id] ?? 0 }));
  }, [present]);

  return { present, push, undo, redo, reset, canUndo, canRedo, commitItems };
}

export function snapshotFromLayout(layout: {
  zones: Array<{
    id: string;
    xCm?: number | null;
    yCm?: number | null;
    widthCm?: number | null;
    depthCm?: number | null;
    zIndex?: number;
    sortOrder?: number;
  }>;
}): LayoutSnapshot {
  const placed = layout.zones
    .filter(
      (zone): zone is typeof zone & { xCm: number; yCm: number; widthCm: number; depthCm: number } =>
        zone.xCm !== null && zone.yCm !== null && zone.widthCm !== null && zone.depthCm !== null,
    )
    .sort((a, b) => (a.zIndex ?? a.sortOrder ?? 0) - (b.zIndex ?? b.sortOrder ?? 0));
  return {
    order: placed.map((zone) => zone.id),
    geometry: Object.fromEntries(
      placed.map((zone) => [zone.id, { xCm: zone.xCm, yCm: zone.yCm, widthCm: zone.widthCm, depthCm: zone.depthCm }]),
    ),
  };
}
