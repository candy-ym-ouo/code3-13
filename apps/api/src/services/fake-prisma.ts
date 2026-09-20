/**
 * 内存版 Prisma 客户端：仅实现布局服务与权限校验用到的最小接口，
 * 让服务层的事务、乐观锁与历史持久化逻辑可以在无数据库环境下测试。
 */

type Row = Record<string, any>;

export function createFakePrisma() {
  const state = {
    balconies: new Map<string, Row>(),
    members: new Map<string, Row>(),
    layout: null as Row | null,
    items: [] as Row[],
    revisions: [] as Row[],
    idSeq: 0,
    /** 测试用：在下一次 updateMany 前模拟并发事务已推进版本 */
    bumpVersionOnNextUpdateMany: false,
  };

  const nextId = () => `fake-${++state.idSeq}`;

  const withRelations = (layout: Row | null) =>
    layout
      ? {
          ...layout,
          items: state.items.filter((item) => item.layoutId === layout.id).map((item) => ({ ...item })),
          revisions: state.revisions.filter((rev) => rev.layoutId === layout.id).map((rev) => ({ ...rev })),
        }
      : null;

  const balconyLayout = {
    findUnique: async ({ where }: any) => {
      const layout = state.layout;
      if (!layout) return null;
      if (where.balconyId && layout.balconyId !== where.balconyId) return null;
      if (where.id && layout.id !== where.id) return null;
      return withRelations(layout);
    },
    create: async ({ data }: any) => {
      state.layout = {
        id: nextId(),
        version: 1,
        widthCm: 360,
        depthCm: 240,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      return withRelations(state.layout);
    },
    updateMany: async ({ where, data }: any) => {
      if (state.bumpVersionOnNextUpdateMany && state.layout) {
        state.bumpVersionOnNextUpdateMany = false;
        state.layout = { ...state.layout, version: state.layout.version + 1 };
      }
      if (state.layout && state.layout.id === where.id && state.layout.version === where.version) {
        state.layout = { ...state.layout, ...data };
        return { count: 1 };
      }
      return { count: 0 };
    },
  };

  const layoutItem = {
    deleteMany: async ({ where }: any) => {
      state.items = state.items.filter((item) => item.layoutId !== where.layoutId);
      return { count: 0 };
    },
    createMany: async ({ data }: any) => {
      state.items.push(...data.map((row: Row) => ({ ...row })));
      return { count: data.length };
    },
  };

  const layoutRevision = {
    deleteMany: async ({ where }: any) => {
      state.revisions = state.revisions.filter((rev) => {
        if (where.id?.in) return !where.id.in.includes(rev.id);
        if (where.layoutId && where.undone !== undefined) {
          return !(rev.layoutId === where.layoutId && rev.undone === where.undone);
        }
        if (where.layoutId) return rev.layoutId !== where.layoutId;
        return true;
      });
      return { count: 0 };
    },
    aggregate: async ({ where }: any) => {
      const seqs = state.revisions.filter((rev) => rev.layoutId === where.layoutId).map((rev) => rev.seq);
      return { _max: { seq: seqs.length > 0 ? Math.max(...seqs) : null } };
    },
    create: async ({ data }: any) => {
      const row = { id: nextId(), createdAt: new Date(), undone: false, ...data };
      state.revisions.push(row);
      return row;
    },
    findMany: async ({ where, orderBy, skip, select }: any) => {
      let rows = state.revisions.filter((rev) => rev.layoutId === where.layoutId);
      rows = [...rows].sort((a, b) => (orderBy?.seq === 'desc' ? b.seq - a.seq : a.seq - b.seq));
      if (skip) rows = rows.slice(skip);
      if (select?.id) return rows.map((row) => ({ id: row.id }));
      return rows;
    },
    findFirst: async ({ where, orderBy }: any) => {
      const rows = state.revisions
        .filter((rev) => rev.layoutId === where.layoutId && rev.undone === where.undone)
        .sort((a, b) => (orderBy?.seq === 'desc' ? b.seq - a.seq : a.seq - b.seq));
      return rows[0] ?? null;
    },
    update: async ({ where, data }: any) => {
      const row = state.revisions.find((rev) => rev.id === where.id);
      if (row) Object.assign(row, data);
      return row ?? null;
    },
  };

  const prisma: any = {
    balconyLayout,
    layoutItem,
    layoutRevision,
    balcony: {
      findUnique: async ({ where }: any) => state.balconies.get(where.id) ?? null,
    },
    workspaceMember: {
      findUnique: async ({ where }: any) => {
        const key = `${where.workspaceId_userId.workspaceId}:${where.workspaceId_userId.userId}`;
        return state.members.get(key) ?? null;
      },
    },
    $transaction: async (fn: any) => fn(prisma),
  };

  return { prisma, state };
}

export const fakeDb = createFakePrisma();

export function resetFakeDb() {
  fakeDb.state.balconies.clear();
  fakeDb.state.members.clear();
  fakeDb.state.layout = null;
  fakeDb.state.items = [];
  fakeDb.state.revisions = [];
  fakeDb.state.idSeq = 0;
  fakeDb.state.bumpVersionOnNextUpdateMany = false;
  fakeDb.state.balconies.set('bal-1', { id: 'bal-1', workspaceId: 'ws-1' });
  fakeDb.state.members.set('ws-1:user-1', { workspaceId: 'ws-1', userId: 'user-1', role: 'EDITOR' });
  fakeDb.state.members.set('ws-1:viewer-1', { workspaceId: 'ws-1', userId: 'viewer-1', role: 'VIEWER' });
}
