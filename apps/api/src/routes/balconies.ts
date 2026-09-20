import type { FastifyInstance } from 'fastify';
import { balconySchema, balconyDimensionsSchema, booleanQuerySchema, layoutCommitSchema, zoneGeometryComplete, zoneSchema } from '@balcony/shared';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth } from '../lib/auth.js';
import { AppError, parseOrThrow } from '../lib/errors.js';
import { requireWorkspaceRole, workspaceIdForBalcony } from '../services/authorization.js';
import { commitBalconyLayout, validateLayoutForDimensions, validateZoneUpsert } from '../services/layout.js';

export async function balconyRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/balconies', async (request) => {
    const query = parseOrThrow(z.object({ workspaceId: z.string().cuid(), includeArchived: booleanQuerySchema }), request.query);
    await requireWorkspaceRole(request.auth!.user.id, query.workspaceId, 'VIEWER');
    return prisma.balcony.findMany({
      where: { workspaceId: query.workspaceId, ...(query.includeArchived ? {} : { archivedAt: null }) },
      include: { zones: { where: { archivedAt: null }, orderBy: [{ zIndex: 'asc' }, { sortOrder: 'asc' }] }, _count: { select: { observations: true, zones: true } } },
      orderBy: { createdAt: 'asc' },
    });
  });

  app.post('/balconies', async (request, reply) => {
    const input = parseOrThrow(balconySchema, request.body);
    await requireWorkspaceRole(request.auth!.user.id, input.workspaceId, 'EDITOR');
    const balcony = await prisma.balcony.create({ data: input });
    return reply.status(201).send(balcony);
  });

  app.patch('/balconies/:id', async (request) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    const input = parseOrThrow(balconySchema.omit({ workspaceId: true }).partial(), request.body);
    await workspaceIdForBalcony(params.id, request.auth!.user.id, 'EDITOR');
    const dimensions = balconyDimensionsSchema
      .pick({ widthCm: true, depthCm: true })
      .partial()
      .safeParse({ widthCm: input.widthCm, depthCm: input.depthCm });
    if (!dimensions.success) throw new AppError(422, 'VALIDATION_ERROR', '阳台尺寸不合法');
    const hasWidth = dimensions.data.widthCm !== undefined;
    const hasDepth = dimensions.data.depthCm !== undefined;
    if (hasWidth !== hasDepth) {
      throw new AppError(422, 'DIMENSIONS_INCOMPLETE', '宽度与进深必须同时设置');
    }
    return prisma.$transaction(async (tx) => {
      if (hasWidth && hasDepth) {
        await tx.$queryRaw`SELECT id FROM "Balcony" WHERE id = ${params.id} FOR UPDATE`;
        await validateLayoutForDimensions(tx, params.id, {
          widthCm: dimensions.data.widthCm!,
          depthCm: dimensions.data.depthCm!,
        });
      }
      return tx.balcony.update({ where: { id: params.id }, data: input });
    });
  });

  app.delete('/balconies/:id', async (request, reply) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    await workspaceIdForBalcony(params.id, request.auth!.user.id, 'OWNER');
    const archivedAt = new Date();
    await prisma.$transaction(async (tx) => {
      const zones = await tx.zone.findMany({ where: { balconyId: params.id }, select: { id: true } });
      const zoneIds = zones.map((zone) => zone.id);
      const plants = zoneIds.length > 0
        ? await tx.plant.findMany({ where: { zoneId: { in: zoneIds } }, select: { id: true } })
        : [];
      const plantIds = plants.map((plant) => plant.id);
      await tx.balcony.update({ where: { id: params.id }, data: { archivedAt } });
      await tx.zone.updateMany({ where: { balconyId: params.id }, data: { archivedAt } });
      if (zoneIds.length > 0) {
        await tx.plant.updateMany({ where: { zoneId: { in: zoneIds } }, data: { archivedAt } });
      }
      await tx.reminder.updateMany({
        where: {
          isActive: true,
          OR: [
            { balconyId: params.id },
            ...(zoneIds.length > 0 ? [{ zoneId: { in: zoneIds } }] : []),
            ...(plantIds.length > 0 ? [{ plantId: { in: plantIds } }] : []),
          ],
        },
        data: { isActive: false, nextRunAt: null },
      });
    });
    return reply.status(204).send();
  });

  app.get('/balconies/:id/zones', async (request) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    await workspaceIdForBalcony(params.id, request.auth!.user.id, 'VIEWER');
    return prisma.zone.findMany({
      where: { balconyId: params.id, archivedAt: null },
      orderBy: [{ zIndex: 'asc' }, { sortOrder: 'asc' }],
    });
  });

  /** 布局规划器数据：阳台尺寸/版本 + 带几何的位置（按层叠顺序）+ 植物占用信息。 */
  app.get('/balconies/:id/layout', async (request) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    await workspaceIdForBalcony(params.id, request.auth!.user.id, 'VIEWER');
    const balcony = await prisma.balcony.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        name: true,
        widthCm: true,
        depthCm: true,
        layoutVersion: true,
        zones: {
          where: { archivedAt: null },
          orderBy: [{ zIndex: 'asc' }, { sortOrder: 'asc' }],
          select: {
            id: true,
            name: true,
            description: true,
            sunExposure: true,
            xCm: true,
            yCm: true,
            widthCm: true,
            depthCm: true,
            zIndex: true,
            sortOrder: true,
            plants: {
              where: { archivedAt: null },
              select: { id: true, name: true, potSizeCm: true, status: true },
              orderBy: { createdAt: 'asc' },
            },
          },
        },
      },
    });
    if (!balcony) throw new AppError(404, 'BALCONY_NOT_FOUND', '阳台不存在');
    return balcony;
  });

  /** 提交整份布局；expectedVersion 不匹配时返回 409 LAYOUT_VERSION_CONFLICT。 */
  app.post('/balconies/:id/layout', async (request, reply) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    const input = parseOrThrow(layoutCommitSchema, request.body);
    await workspaceIdForBalcony(params.id, request.auth!.user.id, 'EDITOR');
    const result = await prisma.$transaction(
      (tx) => commitBalconyLayout(tx, params.id, input),
      { isolationLevel: 'Serializable' },
    );
    return reply.status(200).send(result);
  });

  app.post('/balconies/:id/zones', async (request, reply) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    const input = parseOrThrow(zoneSchema.omit({ balconyId: true }), request.body);
    await workspaceIdForBalcony(params.id, request.auth!.user.id, 'EDITOR');
    const duplicate = await prisma.zone.findFirst({
      where: {
        balconyId: params.id,
        archivedAt: null,
        name: { equals: input.name, mode: 'insensitive' },
      },
      select: { id: true },
    });
    if (duplicate) throw new AppError(409, 'ZONE_NAME_EXISTS', '该阳台已存在同名位置');
    if (!zoneGeometryComplete(input)) {
      const provided = ['xCm', 'yCm', 'widthCm', 'depthCm'].some((key) => (input as Record<string, unknown>)[key] !== undefined);
      if (provided) throw new AppError(422, 'ZONE_GEOMETRY_INCOMPLETE', '位置几何需要同时给出 x、y、宽、进深');
      return reply.status(201).send(await prisma.zone.create({ data: { balconyId: params.id, ...input } }));
    }
    const zone = await prisma.$transaction(async (tx) => {
      await validateZoneUpsert(tx, params.id, null, {
        xCm: input.xCm!,
        yCm: input.yCm!,
        widthCm: input.widthCm!,
        depthCm: input.depthCm!,
      });
      const maxZ = await tx.zone.aggregate({
        where: { balconyId: params.id, archivedAt: null },
        _max: { zIndex: true },
      });
      return tx.zone.create({
        data: {
          balconyId: params.id,
          ...input,
          xCm: input.xCm,
          yCm: input.yCm,
          widthCm: input.widthCm,
          depthCm: input.depthCm,
          zIndex: (maxZ._max.zIndex ?? -10) + 10,
        },
      });
    });
    return reply.status(201).send(zone);
  });

  app.patch('/zones/:id', async (request) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    const input = parseOrThrow(zoneSchema.omit({ balconyId: true }).partial(), request.body);
    const zone = await prisma.zone.findUnique({ where: { id: params.id }, include: { balcony: true } });
    if (!zone) throw new AppError(404, 'ZONE_NOT_FOUND', '位置不存在');
    await requireWorkspaceRole(request.auth!.user.id, zone.balcony.workspaceId, 'EDITOR');
    if (input.name && input.name.toLocaleLowerCase() !== zone.name.toLocaleLowerCase()) {
      const duplicate = await prisma.zone.findFirst({
        where: {
          balconyId: zone.balconyId,
          archivedAt: null,
          id: { not: zone.id },
          name: { equals: input.name, mode: 'insensitive' },
        },
        select: { id: true },
      });
      if (duplicate) throw new AppError(409, 'ZONE_NAME_EXISTS', '该阳台已存在同名位置');
    }
    const geometryProvided = ['xCm', 'yCm', 'widthCm', 'depthCm'].some(
      (key) => (input as Record<string, number | undefined>)[key] !== undefined,
    );
    if (geometryProvided) {
      const nextRect = {
        xCm: input.xCm ?? zone.xCm,
        yCm: input.yCm ?? zone.yCm,
        widthCm: input.widthCm ?? zone.widthCm,
        depthCm: input.depthCm ?? zone.depthCm,
      };
      if (Object.values(nextRect).some((value) => value === null)) {
        throw new AppError(422, 'ZONE_GEOMETRY_INCOMPLETE', '位置几何需要同时给出 x、y、宽、进深');
      }
      return prisma.$transaction(async (tx) => {
        await validateZoneUpsert(tx, zone.balconyId, zone.id, nextRect as {
          xCm: number; yCm: number; widthCm: number; depthCm: number;
        });
        return tx.zone.update({ where: { id: params.id }, data: input });
      });
    }
    return prisma.zone.update({ where: { id: params.id }, data: input });
  });

  app.delete('/zones/:id', async (request, reply) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    const zone = await prisma.zone.findUnique({ where: { id: params.id }, include: { balcony: true } });
    if (!zone) throw new AppError(404, 'ZONE_NOT_FOUND', '位置不存在');
    await requireWorkspaceRole(request.auth!.user.id, zone.balcony.workspaceId, 'EDITOR');
    const activePlants = await prisma.plant.count({ where: { zoneId: params.id, archivedAt: null } });
    if (activePlants > 0) {
      throw new AppError(409, 'ZONE_HAS_PLANTS', '该位置仍有植物，请先搬动或归档植物');
    }
    await prisma.$transaction([
      prisma.zone.update({ where: { id: params.id }, data: { archivedAt: new Date() } }),
      prisma.reminder.updateMany({
        where: { zoneId: params.id, isActive: true },
        data: { isActive: false, nextRunAt: null },
      }),
    ]);
    return reply.status(204).send();
  });
}
