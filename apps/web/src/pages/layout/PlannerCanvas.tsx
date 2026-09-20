import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  GRID_CM,
  clampRectToBounds,
  findLayoutIssues,
  issuesForItem,
  snapToGrid,
  type BalconyDimensions,
  type LayoutIssue,
  type LayoutPlantInfo,
} from '@balcony/shared';

export interface CanvasZone {
  id: string;
  name: string;
  xCm: number;
  yCm: number;
  widthCm: number;
  depthCm: number;
  plants: LayoutPlantInfo[];
}

interface PlannerCanvasProps {
  balcony: BalconyDimensions;
  zones: CanvasZone[];
  /** 受控几何；拖放/缩放结束（已吸附 + 已校验）时回调，由父级入历史栈。 */
  onChange: (next: CanvasZone[]) => void;
  /** 植物被放到某位置时回调；返回错误消息表示拒绝。 */
  onDropPlant?: (zoneId: string, plant: { id: string; name: string; potSizeCm?: number | null }) => string | null;
  /** 可从外部拖入的植物（植物列表面板用 HTML5 拖拽）。 */
  readOnly?: boolean;
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
}

type DragMode = 'move' | 'resize';

interface PointerSession {
  mode: DragMode;
  zoneId: string;
  startPointerX: number;
  startPointerY: number;
  start: { xCm: number; yCm: number; widthCm: number; depthCm: number };
  /** 拖放期间的临时几何，仅在合法时更新；非法则保持上一合法位置（视觉回弹）。 */
  live: { xCm: number; yCm: number; widthCm: number; depthCm: number };
}

const BORDER = '#8aa58f';
const INVALID_COLOR = '#ff4d4f';

export function PlannerCanvas({ balcony, zones, onChange, onDropPlant, readOnly = false, selectedId, onSelect }: PlannerCanvasProps) {
  const boardRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<PointerSession | null>(null);
  const liveRef = useRef<CanvasZone[] | null>(null);
  const [liveVersion, setLiveVersion] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [dragOverZone, setDragOverZone] = useState<string | null>(null);
  const [scale, setScale] = useState(2);

  useEffect(() => {
    const element = boardRef.current;
    if (!element) return;
    const update = () => {
      const width = element.clientWidth - 24;
      const next = Math.min(3, Math.max(0.6, width / balcony.widthCm));
      setScale(next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [balcony.widthCm]);

  // liveVersion 仅用于在拖拽期间触发重绘；真实数据在 liveRef，
  // pointerup 时读一次 ref 提交，避免 setState updater 副作用在 StrictMode 双跑。
  void liveVersion;
  useEffect(() => {
    // 非拖拽期间父组件数据更新（撤销/服务端刷新）时，丢弃临时帧
    if (!dragging) liveRef.current = null;
  }, [zones, dragging]);
  const displayed = liveRef.current ?? zones;

  const plantsByZone = useMemo(() => {
    const map = new Map<string, LayoutPlantInfo[]>();
    for (const zone of displayed) map.set(zone.id, zone.plants);
    return map;
  }, [displayed]);

  const issues = useMemo(
    () => findLayoutIssues({ balcony, items: displayed, plantsByZone }),
    [balcony, displayed, plantsByZone],
  );
  const issuesByZone = useMemo(() => {
    const map = new Map<string, LayoutIssue[]>();
    for (const zone of displayed) map.set(zone.id, issuesForItem(issues, zone.id));
    return map;
  }, [displayed, issues]);

  const finishGesture = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    const finalLive = liveRef.current;
    sessionRef.current = null;
    liveRef.current = null;
    setDragging(false);
    if (finalLive) onChange(finalLive);
  }, [onChange]);

  const updateGesture = useCallback(
    (event: PointerEvent) => {
      const session = sessionRef.current;
      const board = boardRef.current;
      if (!session || !board) return;
      const dx = (event.clientX - session.startPointerX) / scale;
      const dy = (event.clientY - session.startPointerY) / scale;
      let candidate: PointerSession['live'];
      if (session.mode === 'move') {
        candidate = clampRectToBounds(
          {
            xCm: snapToGrid(session.start.xCm + dx),
            yCm: snapToGrid(session.start.yCm + dy),
            widthCm: session.start.widthCm,
            depthCm: session.start.depthCm,
          },
          balcony,
        );
      } else {
        candidate = clampRectToBounds(
          {
            xCm: session.start.xCm,
            yCm: session.start.yCm,
            widthCm: snapToGrid(session.start.widthCm + dx),
            depthCm: snapToGrid(session.start.depthCm + dy),
          },
          balcony,
        );
      }
      // 边界在 clamp 中保证；重叠实时校验：非法位置不采纳（视觉回弹到上一合法帧）。
      const others = zones.filter((zone) => zone.id !== session.zoneId);
      const overlap = findLayoutIssues({
        balcony,
        items: [...others, { id: session.zoneId, name: session.zoneId, ...candidate }],
      }).some((issue) => issue.code === 'ZONE_OVERLAP' || issue.code === 'OUT_OF_BOUNDS');
      if (!overlap) {
        session.live = candidate;
        const base = liveRef.current ?? zones;
        liveRef.current = base.map((zone) => (zone.id === session.zoneId ? { ...zone, ...candidate } : zone));
        setLiveVersion((value) => value + 1);
      }
    },
    [balcony, scale, zones],
  );

  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => updateGesture(event);
    const up = () => finishGesture();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [updateGesture, finishGesture, dragging]);

  const startGesture = (event: React.PointerEvent, zone: CanvasZone, mode: DragMode) => {
    if (readOnly) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect?.(zone.id);
    sessionRef.current = {
      mode,
      zoneId: zone.id,
      startPointerX: event.clientX,
      startPointerY: event.clientY,
      start: { xCm: zone.xCm, yCm: zone.yCm, widthCm: zone.widthCm, depthCm: zone.depthCm },
      live: { xCm: zone.xCm, yCm: zone.yCm, widthCm: zone.widthCm, depthCm: zone.depthCm },
    };
    liveRef.current = zones;
    setDragging(true);
  };

  const boardWidthPx = balcony.widthCm * scale;
  const boardDepthPx = balcony.depthCm * scale;

  return (
    <div ref={boardRef} style={{ width: '100%', overflowX: 'auto', padding: '12px 12px 24px' }}>
      <div
        onPointerDown={() => onSelect?.(null)}
        style={{
          position: 'relative',
          width: boardWidthPx,
          height: boardDepthPx,
          background: 'repeating-linear-gradient(0deg, #f4f7f2, #f4f7f2 24px, #eef3ea 24px, #eef3ea 25px), repeating-linear-gradient(90deg, #f4f7f2, #f4f7f2 24px, #eef3ea 24px, #eef3ea 25px)',
          border: `2px solid ${BORDER}`,
          borderRadius: 6,
        }}
      >
        {displayed.map((zone) => {
          const zoneIssues = issuesByZone.get(zone.id) ?? [];
          const invalid = zoneIssues.length > 0;
          const selected = selectedId === zone.id;
          return (
            <div
              key={zone.id}
              onPointerDown={(event) => startGesture(event, zone, 'move')}
              onDragOver={(event) => {
                if (!onDropPlant) return;
                event.preventDefault();
                setDragOverZone(zone.id);
              }}
              onDragLeave={() => setDragOverZone((current) => (current === zone.id ? null : current))}
              onDrop={(event) => {
                setDragOverZone(null);
                if (!onDropPlant) return;
                const raw = event.dataTransfer.getData('application/x-balcony-plant');
                if (!raw) return;
                const plant = JSON.parse(raw) as { id: string; name: string; potSizeCm?: number | null };
                // 返回错误消息表示占用被拒，画布几何与数据均不变
                onDropPlant(zone.id, plant);
              }}
              style={{
                position: 'absolute',
                left: zone.xCm * scale,
                top: zone.yCm * scale,
                width: zone.widthCm * scale,
                height: zone.depthCm * scale,
                background: invalid ? 'rgba(255,77,79,0.14)' : dragOverZone === zone.id ? 'rgba(82,196,26,0.18)' : 'rgba(46,125,79,0.10)',
                border: `2px solid ${invalid ? INVALID_COLOR : selected ? '#1f6b43' : '#5d8a68'}`,
                borderRadius: 4,
                cursor: readOnly ? 'default' : 'grab',
                touchAction: 'none',
                padding: 6,
                overflow: 'hidden',
                boxSizing: 'border-box',
                userSelect: 'none',
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 600, color: invalid ? INVALID_COLOR : '#234d33' }}>
                {zone.name}
                <span style={{ fontWeight: 400, marginLeft: 6, color: '#6b8070' }}>
                  {zone.widthCm}×{zone.depthCm}cm · {zone.plants.length}株
                </span>
              </div>
              {invalid ? (
                <div style={{ fontSize: 11, color: INVALID_COLOR, marginTop: 2 }}>
                  {zoneIssues[0]?.message}
                </div>
              ) : null}
              {!readOnly ? (
                <span
                  onPointerDown={(event) => startGesture(event, zone, 'resize')}
                  title="拖拽调整大小（自动吸附 5cm 网格）"
                  style={{
                    position: 'absolute',
                    right: 0,
                    bottom: 0,
                    width: 14,
                    height: 14,
                    cursor: 'nwse-resize',
                    background: invalid ? INVALID_COLOR : '#1f6b43',
                    clipPath: 'polygon(100% 0, 100% 100%, 0 100%)',
                  }}
                />
              ) : null}
            </div>
          );
        })}
        <div style={{ position: 'absolute', left: 8, bottom: 6, fontSize: 11, color: '#7a8d7d' }}>
          网格约 25px · 吸附 {GRID_CM}cm · 阳台 {balcony.widthCm}×{balcony.depthCm}cm
        </div>
      </div>
    </div>
  );
}
