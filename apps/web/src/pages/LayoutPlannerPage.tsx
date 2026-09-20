import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Empty, Select, Space, Tag, Tooltip, Typography, message } from 'antd';
import {
  DeleteOutlined,
  RedoOutlined,
  ReloadOutlined,
  UndoOutlined,
  VerticalAlignBottomOutlined,
  VerticalAlignTopOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import {
  validatePlacement,
  type LayoutCommand,
  type LayoutItem,
  type LayoutSnapshot,
  type PlacementViolation,
} from '@balcony/shared';
import { api, errorMessage } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import type { Balcony } from '../api/types';

type LayoutPayload = { layout: LayoutSnapshot; canUndo: boolean; canRedo: boolean };
type ViolationError = { response?: { status?: number; data?: { message?: string; violations?: PlacementViolation[]; layout?: LayoutSnapshot; canUndo?: boolean; canRedo?: boolean } } };

type DragState = {
  mode: 'move' | 'resize';
  itemId: string;
  pointerId: number;
  startX: number;
  startY: number;
  origin: { x: number; y: number; w: number; h: number };
  candidate: { x: number; y: number; w: number; h: number };
  violations: PlacementViolation[];
  moved: boolean;
};

const ITEM_PRESETS: Array<{ kind: LayoutItem['kind']; name: string; w: number; h: number; clearanceCm?: number }> = [
  { kind: 'FURNITURE', name: '椅子', w: 40, h: 40 },
  { kind: 'FURNITURE', name: '折叠桌', w: 70, h: 50 },
  { kind: 'FURNITURE', name: '储物箱', w: 50, h: 40 },
  { kind: 'FURNITURE', name: '花架', w: 60, h: 30 },
  { kind: 'PLANT', name: '绿萝', w: 30, h: 30, clearanceCm: 5 },
  { kind: 'PLANT', name: '多肉', w: 20, h: 20, clearanceCm: 3 },
  { kind: 'PLANT', name: '柠檬树', w: 40, h: 40, clearanceCm: 10 },
];

const POLL_INTERVAL_MS = 10_000;
const GRID_CM = 10;

let idCounter = 0;
function newItemId() {
  idCounter += 1;
  return `item-${Date.now().toString(36)}-${idCounter}`;
}

export function LayoutPlannerPage() {
  const { workspaceId } = useAuth();
  const [balconyId, setBalconyId] = useState<string | null>(null);
  const [payload, setPayload] = useState<LayoutPayload | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [remoteVersion, setRemoteVersion] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;
  const versionRef = useRef<number | null>(null);
  versionRef.current = payload?.layout.version ?? null;

  const balconiesQuery = useQuery({
    queryKey: ['balconies', workspaceId],
    queryFn: async () => (await api.get<Balcony[]>('/balconies', { params: { workspaceId } })).data,
    enabled: Boolean(workspaceId),
  });

  const layout = payload?.layout ?? null;

  const applyPayload = useCallback((next: LayoutPayload) => {
    setPayload(next);
    setRemoteVersion(null);
  }, []);

  const loadLayout = useCallback(
    async (id: string) => {
      try {
        const { data } = await api.get<LayoutPayload>(`/balconies/${id}/layout`);
        applyPayload(data);
      } catch (error) {
        message.error(errorMessage(error));
      }
    },
    [applyPayload],
  );

  useEffect(() => {
    const first = balconiesQuery.data?.[0];
    if (!balconyId && first) setBalconyId(first.id);
  }, [balconiesQuery.data, balconyId]);

  useEffect(() => {
    setPayload(null);
    setSelectedId(null);
    setRemoteVersion(null);
    if (balconyId) void loadLayout(balconyId);
  }, [balconyId, loadLayout]);

  // 轮询检测他人编辑：只提示，不覆盖本地视图
  useEffect(() => {
    if (!balconyId) return;
    const timer = window.setInterval(async () => {
      if (dragRef.current) return;
      try {
        const { data } = await api.get<LayoutPayload>(`/balconies/${balconyId}/layout`);
        const localVersion = versionRef.current;
        if (localVersion === null) setPayload(data);
        else if (data.layout.version !== localVersion) setRemoteVersion(data.layout.version);
      } catch {
        /* 轮询失败静默 */
      }
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [balconyId]);

  const handleMutationError = useCallback(
    (error: unknown) => {
      const typed = error as ViolationError;
      const response = typed?.response;
      if (response?.status === 409 && response.data?.layout) {
        applyPayload({ layout: response.data.layout, canUndo: response.data.canUndo ?? false, canRedo: response.data.canRedo ?? false });
        setDrag(null);
        message.warning(response.data.message ?? '布局已被他人修改，已同步最新版本，请重试');
        return;
      }
      if (response?.status === 422 && response.data?.violations) {
        message.error(response.data.violations.map((v) => v.message).join('；'));
        setDrag(null);
        return;
      }
      message.error(errorMessage(error));
    },
    [applyPayload],
  );

  const sendCommand = useCallback(
    async (command: LayoutCommand) => {
      if (!balconyId || !layout) return;
      try {
        const { data } = await api.post<LayoutPayload>(`/balconies/${balconyId}/layout/commands`, {
          baseVersion: layout.version,
          command,
        });
        applyPayload(data);
      } catch (error) {
        handleMutationError(error);
      }
    },
    [balconyId, layout, applyPayload, handleMutationError],
  );

  const travel = useCallback(
    async (direction: 'undo' | 'redo') => {
      if (!balconyId || !layout) return;
      try {
        const { data } = await api.post<LayoutPayload>(`/balconies/${balconyId}/layout/${direction}`, {
          baseVersion: layout.version,
        });
        applyPayload(data);
      } catch (error) {
        const typed = error as ViolationError;
        if (typed?.response?.status === 400) {
          message.info(typed.response.data?.message ?? '没有更多操作');
          return;
        }
        handleMutationError(error);
      }
    },
    [balconyId, layout, applyPayload, handleMutationError],
  );

  /* ---------- 拖拽 ---------- */

  const toSvgPoint = useCallback((event: { clientX: number; clientY: number }) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const transformed = point.matrixTransform(ctm.inverse());
    return { x: transformed.x, y: transformed.y };
  }, []);

  const evaluateCandidate = useCallback(
    (state: DragState): DragState => {
      if (!layout) return state;
      const item = layout.items.find((entry) => entry.id === state.itemId);
      const check = validatePlacement(layout.items, layout, { id: state.itemId, clearanceCm: item?.clearanceCm ?? 0 }, state.candidate);
      return { ...state, violations: check.violations };
    },
    [layout],
  );

  const beginDrag = useCallback(
    (event: React.PointerEvent, item: LayoutItem, mode: DragState['mode']) => {
      if (!layout) return;
      event.stopPropagation();
      event.preventDefault();
      setSelectedId(item.id);
      const start = toSvgPoint(event);
      const origin = { x: item.x, y: item.y, w: item.w, h: item.h };
      setDrag({
        mode,
        itemId: item.id,
        pointerId: event.pointerId,
        startX: start.x,
        startY: start.y,
        origin,
        candidate: { ...origin },
        violations: [],
        moved: false,
      });
    },
    [layout, toSvgPoint],
  );

  useEffect(() => {
    if (!drag) return;
    const onMove = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      const point = toSvgPoint(event);
      const dx = point.x - current.startX;
      const dy = point.y - current.startY;
      if (!current.moved && Math.hypot(dx, dy) < 1) return;
      const candidate =
        current.mode === 'move'
          ? { ...current.origin, x: Math.round(current.origin.x + dx), y: Math.round(current.origin.y + dy) }
          : {
              ...current.origin,
              w: Math.max(5, Math.round(current.origin.w + dx)),
              h: Math.max(5, Math.round(current.origin.h + dy)),
            };
      setDrag(evaluateCandidate({ ...current, candidate, moved: true }));
    };
    const onUp = () => {
      const current = dragRef.current;
      setDrag(null);
      if (!current || !current.moved) return;
      if (current.violations.length > 0) {
        message.error(`位置不合法：${current.violations.map((v) => v.message).join('；')}`);
        return;
      }
      const changed =
        current.candidate.x !== current.origin.x ||
        current.candidate.y !== current.origin.y ||
        current.candidate.w !== current.origin.w ||
        current.candidate.h !== current.origin.h;
      if (!changed) return;
      void sendCommand(
        current.mode === 'move'
          ? { type: 'MOVE', itemId: current.itemId, x: current.candidate.x, y: current.candidate.y }
          : { type: 'RESIZE', itemId: current.itemId, w: current.candidate.w, h: current.candidate.h },
      );
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [drag ? true : false, evaluateCandidate, sendCommand, toSvgPoint]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- 工具条操作 ---------- */

  const addItem = useCallback(
    (preset: (typeof ITEM_PRESETS)[number]) => {
      if (!layout) return;
      const draft: LayoutItem = {
        id: newItemId(),
        kind: preset.kind,
        name: preset.name,
        x: 0,
        y: 0,
        w: preset.w,
        h: preset.h,
        clearanceCm: preset.clearanceCm ?? 0,
        sortOrder: 0,
        plantId: null,
      };
      let spot: { x: number; y: number } | null = null;
      for (let y = 0; y + preset.h <= layout.depthCm && !spot; y += 5) {
        for (let x = 0; x + preset.w <= layout.widthCm; x += 5) {
          if (validatePlacement(layout.items, layout, draft, { x, y, w: preset.w, h: preset.h }).ok) {
            spot = { x, y };
            break;
          }
        }
      }
      if (!spot) {
        message.warning('阳台已满，找不到合适的位置，请先移出一些物品');
        return;
      }
      void sendCommand({ type: 'ADD', item: { ...draft, x: spot.x, y: spot.y } });
    },
    [layout, sendCommand],
  );

  const selected = layout?.items.find((item) => item.id === selectedId) ?? null;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      const meta = event.ctrlKey || event.metaKey;
      if (meta && event.key.toLowerCase() === 'z' && !event.shiftKey) {
        event.preventDefault();
        void travel('undo');
      } else if ((meta && event.key.toLowerCase() === 'y') || (meta && event.shiftKey && event.key.toLowerCase() === 'z')) {
        event.preventDefault();
        void travel('redo');
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && selected) {
        event.preventDefault();
        void sendCommand({ type: 'REMOVE', itemId: selected.id });
      } else if (event.key.startsWith('Arrow') && selected) {
        event.preventDefault();
        const deltas: Record<string, [number, number]> = {
          ArrowLeft: [-1, 0],
          ArrowRight: [1, 0],
          ArrowUp: [0, -1],
          ArrowDown: [0, 1],
        };
        const delta = deltas[event.key];
        if (!delta) return;
        void sendCommand({ type: 'MOVE', itemId: selected.id, x: selected.x + delta[0], y: selected.y + delta[1] });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selected, sendCommand, travel]);

  /* ---------- 渲染 ---------- */

  if (!workspaceId) return <Alert type="warning" showIcon message="请先创建空间" />;

  const pad = 20;
  const dragItem = drag ? layout?.items.find((item) => item.id === drag.itemId) : null;

  return (
    <div className="page-stack">
      <Space style={{ justifyContent: 'space-between', width: '100%' }} wrap>
        <div>
          <Typography.Title level={2} style={{ margin: 0 }}>布局规划</Typography.Title>
          <Typography.Text type="secondary">拖拽摆放家具与植物，实时校验重叠、边界与植物占用；支持多人协作的版本冲突保护与撤销。</Typography.Text>
        </div>
        <Space wrap>
          <Select
            style={{ minWidth: 180 }}
            placeholder="选择阳台"
            value={balconyId ?? undefined}
            options={(balconiesQuery.data ?? []).map((balcony) => ({ value: balcony.id, label: balcony.name }))}
            onChange={setBalconyId}
          />
          <Tooltip title="撤销 (Ctrl+Z)">
            <Button icon={<UndoOutlined />} disabled={!payload?.canUndo} onClick={() => void travel('undo')} />
          </Tooltip>
          <Tooltip title="重做 (Ctrl+Y)">
            <Button icon={<RedoOutlined />} disabled={!payload?.canRedo} onClick={() => void travel('redo')} />
          </Tooltip>
          <Tooltip title="重新加载">
            <Button icon={<ReloadOutlined />} onClick={() => balconyId && void loadLayout(balconyId)} />
          </Tooltip>
          {layout ? <Tag color="green">v{layout.version}</Tag> : null}
        </Space>
      </Space>

      {remoteVersion !== null && layout ? (
        <Alert
          type="warning"
          showIcon
          message={`布局已有新版本（v${remoteVersion}），你正在查看 v${layout.version}`}
          action={<Button size="small" onClick={() => balconyId && void loadLayout(balconyId)}>同步最新</Button>}
        />
      ) : null}

      {!balconyId ? (
        <Card><Empty description={balconiesQuery.data?.length === 0 ? '请先在「阳台与位置」创建阳台' : '请选择阳台'} /></Card>
      ) : !layout ? (
        <Card loading />
      ) : (
        <div className="layout-planner">
          <Card
            size="small"
            title="添加物品"
            styles={{ body: { display: 'flex', flexWrap: 'wrap', gap: 8 } }}
          >
            {ITEM_PRESETS.map((preset) => (
              <Button key={preset.name} size="small" onClick={() => addItem(preset)}>
                {preset.kind === 'PLANT' ? '🌿' : '🪑'} {preset.name}
                <Typography.Text type="secondary" style={{ marginLeft: 4, fontSize: 12 }}>
                  {preset.w}×{preset.h}
                </Typography.Text>
              </Button>
            ))}
          </Card>

          <div className="layout-canvas-wrap">
            <svg
              ref={svgRef}
              className="layout-canvas"
              viewBox={`${-pad} ${-pad} ${layout.widthCm + pad * 2} ${layout.depthCm + pad * 2}`}
              onPointerDown={() => setSelectedId(null)}
            >
              <defs>
                <pattern id="layout-grid" width={GRID_CM} height={GRID_CM} patternUnits="userSpaceOnUse">
                  <path d={`M ${GRID_CM} 0 L 0 0 0 ${GRID_CM}`} fill="none" stroke="#e3eae3" strokeWidth="0.4" />
                </pattern>
              </defs>
              <rect x={0} y={0} width={layout.widthCm} height={layout.depthCm} className="layout-floor" />
              <rect x={0} y={0} width={layout.widthCm} height={layout.depthCm} fill="url(#layout-grid)" />

              {layout.items.map((item) => {
                const isDragSource = drag?.itemId === item.id && drag.moved;
                const isSelected = selectedId === item.id;
                return (
                  <g
                    key={item.id}
                    opacity={isDragSource ? 0.3 : 1}
                    onPointerDown={(event) => beginDrag(event, item, 'move')}
                    style={{ cursor: 'grab' }}
                  >
                    {item.kind === 'PLANT' && item.clearanceCm > 0 ? (
                      <rect
                        x={item.x - item.clearanceCm}
                        y={item.y - item.clearanceCm}
                        width={item.w + item.clearanceCm * 2}
                        height={item.h + item.clearanceCm * 2}
                        className="layout-clearance"
                      />
                    ) : null}
                    <rect
                      x={item.x}
                      y={item.y}
                      width={item.w}
                      height={item.h}
                      rx={1.5}
                      className={`layout-item ${item.kind === 'PLANT' ? 'layout-item-plant' : 'layout-item-furniture'} ${isSelected ? 'layout-item-selected' : ''}`}
                    />
                    <text x={item.x + item.w / 2} y={item.y + item.h / 2} className="layout-item-label">
                      {item.name}
                    </text>
                    {isSelected && !drag ? (
                      <circle
                        cx={item.x + item.w}
                        cy={item.y + item.h}
                        r={3}
                        className="layout-resize-handle"
                        onPointerDown={(event) => beginDrag(event, item, 'resize')}
                      />
                    ) : null}
                  </g>
                );
              })}

              {drag && drag.moved && dragItem ? (
                <g pointerEvents="none">
                  <rect
                    x={drag.candidate.x}
                    y={drag.candidate.y}
                    width={drag.candidate.w}
                    height={drag.candidate.h}
                    rx={1.5}
                    className={`layout-ghost ${drag.violations.length === 0 ? 'layout-ghost-valid' : 'layout-ghost-invalid'}`}
                  />
                  {drag.violations.length > 0 ? (
                    <text x={drag.candidate.x} y={drag.candidate.y - 3} className="layout-ghost-warning">
                      {drag.violations[0]?.message ?? ''}
                    </text>
                  ) : null}
                </g>
              ) : null}
            </svg>
          </div>

          <Card size="small" title={selected ? `已选中：${selected.name}` : '物品'}>
            {selected ? (
              <Space direction="vertical" style={{ width: '100%' }}>
                <Typography.Text type="secondary">
                  {selected.kind === 'PLANT' ? '植物' : '家具'} · 位置 ({selected.x}, {selected.y}) · 尺寸 {selected.w}×{selected.h}cm
                  {selected.clearanceCm > 0 ? ` · 生长缓冲 ${selected.clearanceCm}cm` : ''}
                </Typography.Text>
                <Space wrap>
                  <Button size="small" icon={<VerticalAlignTopOutlined />} onClick={() => void sendCommand({ type: 'REORDER', itemId: selected.id, direction: 'FRONT' })}>
                    置于顶层
                  </Button>
                  <Button size="small" icon={<VerticalAlignBottomOutlined />} onClick={() => void sendCommand({ type: 'REORDER', itemId: selected.id, direction: 'BACK' })}>
                    置于底层
                  </Button>
                  <Button size="small" danger icon={<DeleteOutlined />} onClick={() => void sendCommand({ type: 'REMOVE', itemId: selected.id })}>
                    删除
                  </Button>
                </Space>
              </Space>
            ) : (
              <Typography.Text type="secondary">
                共 {layout.items.length} 件物品。拖拽移动，拖右下角手柄调整尺寸；红色表示越界、重叠或侵入植物生长缓冲。方向键微调，Delete 删除，Ctrl+Z 撤销。
              </Typography.Text>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
