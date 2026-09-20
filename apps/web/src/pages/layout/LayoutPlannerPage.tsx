import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Form,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  RedoOutlined,
  SaveOutlined,
  UndoOutlined,
  VerticalAlignBottomOutlined,
  VerticalAlignTopOutlined,
} from '@ant-design/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_POT_DIAMETER_CM,
  assignZOrder,
  autoPlaceItem,
  findLayoutIssues,
  potFootprintCm2,
  reorderIds,
  zoneFootprintCm2,
  type LayoutItemCommit,
} from '@balcony/shared';
import { api, errorMessage } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import type { Balcony, BalconyLayout, LayoutCommitResult } from '../../api/types';
import { PlannerCanvas, type CanvasZone } from './PlannerCanvas';
import { snapshotFromLayout, useLayoutHistory, type LayoutSnapshot } from './useLayoutHistory';

interface CanvasState {
  order: string[];
  zones: CanvasZone[];
}

function toCanvas(layout: BalconyLayout): CanvasState & { unplaced: BalconyLayout['zones'] } {
  const placed = layout.zones
    .filter(
      (zone): zone is BalconyLayout['zones'][number] & { xCm: number; yCm: number; widthCm: number; depthCm: number } =>
        zone.xCm !== null && zone.yCm !== null && zone.widthCm !== null && zone.depthCm !== null,
    )
    .sort((a, b) => a.zIndex - b.zIndex);
  return {
    order: placed.map((zone) => zone.id),
    zones: placed.map((zone) => ({
      id: zone.id,
      name: zone.name,
      xCm: zone.xCm,
      yCm: zone.yCm,
      widthCm: zone.widthCm,
      depthCm: zone.depthCm,
      plants: zone.plants.map((plant) => ({ id: plant.id, name: plant.name, potSizeCm: plant.potSizeCm })),
    })),
    // 尚未上屏的位置（在「阳台与位置」中新建但还没摆上画布）
    unplaced: layout.zones.filter((zone) => zone.xCm === null || zone.widthCm === null),
  };
}

export function LayoutPlannerPage() {
  const { workspaces, workspaceId } = useAuth();
  const queryClient = useQueryClient();
  const role = workspaces.find((workspace) => workspace.id === workspaceId)?.role ?? 'VIEWER';
  const readOnly = role === 'VIEWER';

  const balconiesQuery = useQuery({
    queryKey: ['balconies', workspaceId],
    queryFn: async () => (await api.get<Balcony[]>('/balconies', { params: { workspaceId } })).data,
    enabled: Boolean(workspaceId),
  });
  const [selectedBalconyId, setSelectedBalconyId] = useState<string | null>(null);
  const effectiveBalconyId = selectedBalconyId ?? balconiesQuery.data?.[0]?.id ?? null;

  const layoutQuery = useQuery({
    queryKey: ['balcony-layout', effectiveBalconyId],
    queryFn: async () => (await api.get<BalconyLayout>(`/balconies/${effectiveBalconyId}/layout`)).data,
    enabled: Boolean(effectiveBalconyId),
  });

  const [canvas, setCanvas] = useState<CanvasState>({ order: [], zones: [] });
  const [unplaced, setUnplaced] = useState<BalconyLayout['zones']>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dimensionsOpen, setDimensionsOpen] = useState(false);
  const [conflict, setConflict] = useState<{ myItems: LayoutItemCommit[] } | null>(null);
  const serverVersionRef = useRef(0);
  const [dimensionsForm] = Form.useForm();

  const history = useLayoutHistory(null);

  // 服务端数据到达（或切换阳台）后初始化画布与历史基线
  useEffect(() => {
    if (!layoutQuery.data) return;
    const next = toCanvas(layoutQuery.data);
    setCanvas({ order: next.order, zones: next.zones });
    setUnplaced(next.unplaced);
    serverVersionRef.current = layoutQuery.data.layoutVersion;
    const snapshot = snapshotFromLayout(layoutQuery.data);
    history.reset(snapshot);
    setSelectedId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutQuery.data]);

  const balconyDims = layoutQuery.data;
  const configured = balconyDims?.widthCm && balconyDims?.depthCm;

  const applySnapshot = (snapshot: LayoutSnapshot) => {
    setCanvas((current) => ({
      order: [...snapshot.order, ...current.zones.map((z) => z.id).filter((id) => !snapshot.order.includes(id))],
      zones: current.zones.map((zone) => {
        const geometry = snapshot.geometry[zone.id];
        return geometry ? { ...zone, ...geometry } : zone;
      }),
    }));
  };

  const commitLocalChange = (nextZones: CanvasZone[], nextOrder?: string[]) => {
    const order = nextOrder ?? canvas.order;
    setCanvas({ order, zones: nextZones });
    history.push({
      order,
      geometry: Object.fromEntries(
        nextZones.map((zone) => [zone.id, { xCm: zone.xCm, yCm: zone.yCm, widthCm: zone.widthCm, depthCm: zone.depthCm }]),
      ),
    });
  };

  const handleCanvasChange = (nextZones: CanvasZone[]) => commitLocalChange(nextZones);

  const selectedZone = canvas.zones.find((zone) => zone.id === selectedId) ?? null;

  const moveSelected = (direction: 'front' | 'forward' | 'backward' | 'back') => {
    if (!selectedZone) return;
    let nextOrder: string[];
    const ids = canvas.order;
    const index = ids.indexOf(selectedZone.id);
    if (direction === 'front') nextOrder = reorderIds(ids, selectedZone.id, ids[ids.length - 1]!, 'after');
    else if (direction === 'back') nextOrder = reorderIds(ids, selectedZone.id, ids[0]!, 'before');
    else if (direction === 'forward' && index < ids.length - 1) {
      nextOrder = reorderIds(ids, selectedZone.id, ids[index + 1]!, 'after');
    } else if (direction === 'backward' && index > 0) {
      nextOrder = reorderIds(ids, selectedZone.id, ids[index - 1]!, 'before');
    } else return;
    commitLocalChange(canvas.zones, nextOrder);
  };

  const orderedZones = useMemo(() => {
    const byId = new Map(canvas.zones.map((zone) => [zone.id, zone]));
    return canvas.order.map((id) => byId.get(id)).filter((zone): zone is CanvasZone => Boolean(zone));
  }, [canvas]);

  const liveIssues = useMemo(() => {
    if (!configured) return [];
    return findLayoutIssues({
      balcony: { widthCm: balconyDims.widthCm!, depthCm: balconyDims.depthCm! },
      items: orderedZones,
      plantsByZone: new Map(orderedZones.map((zone) => [zone.id, zone.plants])),
    });
  }, [balconyDims, configured, orderedZones]);

  const buildCommitItems = (): LayoutItemCommit[] => {
    // 按视觉顺序（含层叠调整）提交；z 序由顺序派生
    const zOrder = assignZOrder(orderedZones.map((zone) => zone.id));
    return orderedZones.map((zone) => ({
      id: zone.id,
      xCm: zone.xCm,
      yCm: zone.yCm,
      widthCm: zone.widthCm,
      depthCm: zone.depthCm,
      zIndex: zOrder[zone.id] ?? 0,
    }));
  };

  /** 把尚未上屏的位置自动放到第一个空闲格（单区域立即保存，服务端重校验）。 */
  const placeUnplaced = async (zoneId: string) => {
    if (!configured) return;
    const dims = { widthCm: balconyDims.widthCm!, depthCm: balconyDims.depthCm! };
    const source = unplaced.find((zone) => zone.id === zoneId);
    if (!source) return;
    const size = { widthCm: source.widthCm ?? 40, depthCm: source.depthCm ?? 40 };
    const spot = autoPlaceItem(dims, orderedZones, size) ?? { xCm: 0, yCm: 0 };
    try {
      await api.patch(`/zones/${zoneId}`, { ...size, ...spot });
      message.success(`已放置「${source.name}」，请确认位置后保存排序`);
      await queryClient.invalidateQueries({ queryKey: ['balcony-layout', effectiveBalconyId] });
    } catch (error) {
      message.error(errorMessage(error));
    }
  };

  const postLayout = async (items: LayoutItemCommit[], expectedVersion: number, overwrite = false) => {
    setSaving(true);
    try {
      const result = await api.post<LayoutCommitResult>(`/balconies/${effectiveBalconyId}/layout`, {
        expectedVersion,
        items,
      });
      serverVersionRef.current = result.data.layoutVersion;
      message.success(overwrite ? '已用你的版本覆盖最新布局' : '布局已保存');
      setConflict(null);
      await queryClient.invalidateQueries({ queryKey: ['balcony-layout', effectiveBalconyId] });
      await queryClient.invalidateQueries({ queryKey: ['balconies'] });
    } catch (error) {
      const code = (error as { response?: { data?: { code?: string } } }).response?.data?.code;
      if (code === 'LAYOUT_VERSION_CONFLICT') {
        // 拉取对方版本号：选择“以我为准”时将基于最新版本重新提交，而不是盲目覆盖
        const latest = await api.get<BalconyLayout>(`/balconies/${effectiveBalconyId}/layout`);
        serverVersionRef.current = latest.data.layoutVersion;
        setConflict({ myItems: items });
        message.warning('布局已被他人修改');
      } else {
        message.error(errorMessage(error));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => {
    if (liveIssues.length > 0) {
      message.error(`存在 ${liveIssues.length} 个校验问题，请修正后再保存`);
      return;
    }
    void postLayout(buildCommitItems(), serverVersionRef.current);
  };

  const handleUndo = () => {
    const snapshot = history.undo();
    if (snapshot) applySnapshot(snapshot);
  };
  const handleRedo = () => {
    const snapshot = history.redo();
    if (snapshot) applySnapshot(snapshot);
  };

  // 拖入植物：本地先用几何规则预检，占用拒绝不动任何数据
  const handleDropPlant = (zoneId: string, plant: { id: string; name: string; potSizeCm?: number | null }) => {
    const target = canvas.zones.find((zone) => zone.id === zoneId);
    if (!target) return '位置不存在';
    const currentOwner = canvas.zones.find((zone) => zone.plants.some((entry) => entry.id === plant.id));
    if (currentOwner?.id === zoneId) return null;
    const candidatePlants = [
      ...target.plants.filter((entry) => entry.id !== plant.id),
      { id: plant.id, name: plant.name, potSizeCm: plant.potSizeCm },
    ];
    const issues = findLayoutIssues({
      balcony: { widthCm: target.widthCm, depthCm: target.depthCm },
      items: [{ id: target.id, name: target.name, xCm: 0, yCm: 0, widthCm: target.widthCm, depthCm: target.depthCm }],
      plantsByZone: new Map([[target.id, candidatePlants]]),
    });
    if (issues.length > 0) {
      message.error(issues[0]!.message);
      return issues[0]!.message;
    }
    // 预检通过，调搬动接口；服务端会再次校验占用
    void (async () => {
      try {
        await api.post(`/plants/${plant.id}/move`, { toZoneId: zoneId });
        message.success(`已将「${plant.name}」搬到「${target.name}」`);
        await queryClient.invalidateQueries({ queryKey: ['balcony-layout', effectiveBalconyId] });
        await queryClient.invalidateQueries({ queryKey: ['plants'] });
      } catch (error) {
        message.error(errorMessage(error));
      }
    })();
    return null;
  };

  const autoPlaceAll = () => {
    if (!configured) return;
    const dims = { widthCm: balconyDims.widthCm!, depthCm: balconyDims.depthCm! };
    const placedRects: CanvasZone[] = [];
    const nextZones = canvas.zones.map((zone) => {
      const spot = autoPlaceItem(dims, placedRects, { widthCm: zone.widthCm, depthCm: zone.depthCm });
      const moved = spot ? { ...zone, ...spot } : zone;
      placedRects.push(moved);
      return moved;
    });
    commitLocalChange(nextZones);
    message.info('已自动摆放，请检查后保存');
  };

  const saveDimensions = async (values: { widthCm: number; depthCm: number }) => {
    try {
      await api.patch(`/balconies/${effectiveBalconyId}`, values);
      setDimensionsOpen(false);
      message.success('阳台尺寸已更新');
      await queryClient.invalidateQueries({ queryKey: ['balcony-layout', effectiveBalconyId] });
      await queryClient.invalidateQueries({ queryKey: ['balconies'] });
    } catch (error) {
      message.error(errorMessage(error));
    }
  };

  if (!workspaceId) return <Alert type="warning" showIcon message="请先创建空间" />;
  if (balconiesQuery.isLoading) return <Spin />;
  if (!effectiveBalconyId) return <Empty description="还没有阳台，请先在「阳台与位置」创建阳台" />;

  return (
    <div className="page-stack">
      <Space style={{ justifyContent: 'space-between', width: '100%' }} wrap>
        <div>
          <Typography.Title level={2} style={{ margin: 0 }}>阳台布局规划</Typography.Title>
          <Typography.Text type="secondary">拖拽位置时实时校验重叠、边界与植物占用；并发编辑按版本冲突处理。</Typography.Text>
        </div>
        <Space wrap>
          <Select
            value={effectiveBalconyId ?? undefined}
            style={{ minWidth: 180 }}
            options={(balconiesQuery.data ?? []).map((balcony) => ({ value: balcony.id, label: balcony.name }))}
            onChange={setSelectedBalconyId}
          />
          <Button onClick={() => setDimensionsOpen(true)}>
            {configured ? `尺寸 ${balconyDims!.widthCm}×${balconyDims!.depthCm}cm` : '设置阳台尺寸'}
          </Button>
        </Space>
      </Space>

      {readOnly ? <Alert type="info" showIcon message="当前为只读角色，可查看布局但不能拖拽或保存" /> : null}

      {!readOnly && unplaced.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={`有 ${unplaced.length} 个位置尚未摆上画布`}
          description={
            <Space wrap>
              {unplaced.map((zone) => (
                <Button key={zone.id} size="small" onClick={() => void placeUnplaced(zone.id)}>
                  放置「{zone.name}」
                </Button>
              ))}
            </Space>
          }
        />
      ) : null}

      {layoutQuery.isLoading ? (
        <Spin />
      ) : !configured ? (
        <Card>
          <Empty description="尚未设置阳台尺寸">
            <Button type="primary" onClick={() => setDimensionsOpen(true)}>设置宽度与进深</Button>
          </Empty>
        </Card>
      ) : (
        <Row gutter={[16, 16]}>
          <Col xs={24} xl={17}>
            <Card
              title="布局画布"
              extra={
                <Space wrap>
                  <Button icon={<UndoOutlined />} disabled={!history.canUndo || readOnly} onClick={handleUndo}>撤销</Button>
                  <Button icon={<RedoOutlined />} disabled={!history.canRedo || readOnly} onClick={handleRedo}>重做</Button>
                  <Button icon={<VerticalAlignTopOutlined />} disabled={!selectedZone || readOnly} onClick={() => moveSelected('front')}>置顶</Button>
                  <Button icon={<ArrowUpOutlined />} disabled={!selectedZone || readOnly} onClick={() => moveSelected('forward')}>上移一层</Button>
                  <Button icon={<ArrowDownOutlined />} disabled={!selectedZone || readOnly} onClick={() => moveSelected('backward')}>下移一层</Button>
                  <Button icon={<VerticalAlignBottomOutlined />} disabled={!selectedZone || readOnly} onClick={() => moveSelected('back')}>置底</Button>
                  <Button disabled={readOnly || canvas.zones.length === 0} onClick={autoPlaceAll}>自动摆放</Button>
                  <Button type="primary" icon={<SaveOutlined />} loading={saving} disabled={readOnly} onClick={handleSave}>
                    保存布局
                  </Button>
                </Space>
              }
            >
              {liveIssues.length > 0 ? (
                <Alert
                  style={{ marginBottom: 12 }}
                  type="error"
                  showIcon
                  message={`${liveIssues.length} 个校验问题`}
                  description={
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {liveIssues.slice(0, 6).map((issue, index) => <li key={index}>{issue.message}</li>)}
                    </ul>
                  }
                />
              ) : null}
              <PlannerCanvas
                balcony={{ widthCm: balconyDims.widthCm!, depthCm: balconyDims.depthCm! }}
                zones={orderedZones}
                onChange={handleCanvasChange}
                onDropPlant={readOnly ? undefined : handleDropPlant}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            </Card>
          </Col>
          <Col xs={24} xl={7}>
            <PlantOccupancyCard zones={orderedZones} selectedId={selectedId} />
          </Col>
        </Row>
      )}

      <Modal
        title="阳台尺寸"
        open={dimensionsOpen}
        onCancel={() => setDimensionsOpen(false)}
        onOk={() => dimensionsForm.submit()}
        destroyOnClose
      >
        <Typography.Paragraph type="secondary">
          单位厘米。缩小尺寸后，如果现有位置会越界或重叠，服务端会拒绝本次修改。
        </Typography.Paragraph>
        <Form
          form={dimensionsForm}
          layout="vertical"
          initialValues={{ widthCm: balconyDims?.widthCm ?? 180, depthCm: balconyDims?.depthCm ?? 90 }}
          onFinish={saveDimensions}
        >
          <Form.Item name="widthCm" label="宽度 cm" rules={[{ required: true, message: '请输入宽度' }]}>
            <InputNumber min={50} max={5000} step={5} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="depthCm" label="进深 cm" rules={[{ required: true, message: '请输入进深' }]}>
            <InputNumber min={50} max={5000} step={5} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="布局版本冲突"
        open={Boolean(conflict)}
        okText="放弃我的修改，加载最新布局"
        cancelText="仍要覆盖（以我为准）"
        onOk={async () => {
          await queryClient.invalidateQueries({ queryKey: ['balcony-layout', effectiveBalconyId] });
          await layoutQuery.refetch();
          setConflict(null);
        }}
        onCancel={() => {
          if (conflict) void postLayout(conflict.myItems, serverVersionRef.current, true);
        }}
      >
        <Typography.Paragraph>
          你编辑期间，他人已经保存了新版本。直接保存会覆盖对方的几何与排序。
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary">
          建议加载最新布局后，再决定如何调整；选择“仍要覆盖”将以你的版本为准重新提交。
        </Typography.Paragraph>
      </Modal>
    </div>
  );
}

function PlantOccupancyCard({ zones, selectedId }: { zones: CanvasZone[]; selectedId: string | null }) {
  return (
    <Card title="植物占用（可拖动画布中的位置之间）">
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        从下方把植物拖到目标位置。系统按花盆直径与总占地校验，放不下会被拒绝。默认花盆直径 {DEFAULT_POT_DIAMETER_CM}cm。
      </Typography.Paragraph>
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        {zones.map((zone) => {
          const used = zone.plants.reduce((sum, plant) => sum + potFootprintCm2(plant.potSizeCm), 0);
          const ratio = used / zoneFootprintCm2(zone);
          return (
            <Card
              key={zone.id}
              size="small"
              style={{ borderColor: selectedId === zone.id ? '#1f6b43' : undefined }}
              title={
                <Space size={6} wrap>
                  <span>{zone.name}</span>
                  <Tag color={ratio > 1 ? 'red' : ratio > 0.8 ? 'orange' : 'green'}>
                    {Math.round(ratio * 100)}%
                  </Tag>
                </Space>
              }
            >
              {zone.plants.length === 0 ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>空闲，可拖入植物</Typography.Text>
              ) : (
                <Space size={[6, 6]} wrap>
                  {zone.plants.map((plant) => (
                    <Tag
                      key={plant.id}
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.setData(
                          'application/x-balcony-plant',
                          JSON.stringify({ id: plant.id, name: plant.name, potSizeCm: plant.potSizeCm }),
                        );
                        event.dataTransfer.effectAllowed = 'move';
                      }}
                      style={{ cursor: 'grab', marginInlineEnd: 0 }}
                    >
                      {plant.name}
                      <span style={{ color: '#8a9a8d', marginLeft: 4 }}>
                        {plant.potSizeCm ? `⌀${plant.potSizeCm}` : `⌀${DEFAULT_POT_DIAMETER_CM}`}
                      </span>
                    </Tag>
                  ))}
                </Space>
              )}
            </Card>
          );
        })}
      </Space>
    </Card>
  );
}
