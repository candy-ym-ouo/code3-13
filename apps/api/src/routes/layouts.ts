import type { FastifyInstance, FastifyReply } from 'fastify';
import { layoutCommandRequestSchema, layoutHistoryRequestSchema, type LayoutEngineResult } from '@balcony/shared';
import { z } from 'zod';
import { requireAuth } from '../lib/auth.js';
import { parseOrThrow } from '../lib/errors.js';
import { applyLayoutCommand, getLayout, redoLayout, undoLayout } from '../services/layout-service.js';

const balconyParamsSchema = z.object({ id: z.string().cuid() });

function sendLayoutResult(reply: FastifyReply, result: LayoutEngineResult) {
  if (result.ok) {
    return reply.send({ layout: result.snapshot, canUndo: result.canUndo, canRedo: result.canRedo });
  }
  return reply.status(result.status).send({
    code: result.code,
    message: result.message,
    violations: result.violations,
    layout: result.snapshot,
    canUndo: result.canUndo,
    canRedo: result.canRedo,
  });
}

export async function layoutRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/balconies/:id/layout', async (request) => {
    const params = parseOrThrow(balconyParamsSchema, request.params);
    return getLayout(params.id, request.auth!.user.id);
  });

  app.post('/balconies/:id/layout/commands', async (request, reply) => {
    const params = parseOrThrow(balconyParamsSchema, request.params);
    const body = parseOrThrow(layoutCommandRequestSchema, request.body);
    const result = await applyLayoutCommand(params.id, request.auth!.user.id, body.baseVersion, body.command);
    return sendLayoutResult(reply, result);
  });

  app.post('/balconies/:id/layout/undo', async (request, reply) => {
    const params = parseOrThrow(balconyParamsSchema, request.params);
    const body = parseOrThrow(layoutHistoryRequestSchema, request.body);
    const result = await undoLayout(params.id, request.auth!.user.id, body.baseVersion);
    return sendLayoutResult(reply, result);
  });

  app.post('/balconies/:id/layout/redo', async (request, reply) => {
    const params = parseOrThrow(balconyParamsSchema, request.params);
    const body = parseOrThrow(layoutHistoryRequestSchema, request.body);
    const result = await redoLayout(params.id, request.auth!.user.id, body.baseVersion);
    return sendLayoutResult(reply, result);
  });
}
