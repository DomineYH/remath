// Fastify 앱: 라우트 표에서만 등록(A-2), 오류 모양(M-2), 실 확인(C-9·C-10), /healthz(O-8), 정적 서빙(A-4).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { ERROR_STATUS, routes } from '@remath/shared';
import Fastify, { type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { hasZodFastifySchemaValidationErrors, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { authenticate, COOKIE, createLimiter, resolveRealm, type Auth } from './auth.ts';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { ApiFail } from './errors.ts';
import type { ProvidersFor } from './providers/types.ts';
import { adminAiHandlers } from './routes/admin-ai.ts';
import { adminScenarioHandlers } from './routes/admin-scenarios.ts';
import { adminSessionHandlers } from './routes/admin-sessions.ts';
import { adminUserHandlers } from './routes/admin-users.ts';
import { authHandlers } from './routes/auth.ts';
import { sessionHandlers } from './routes/sessions.ts';

declare module 'fastify' { interface FastifyRequest { auth?: Auth } }

export interface Deps { db: Db; config: Config; limiter: ReturnType<typeof createLimiter>; now: () => Date; providersFor: ProvidersFor }
/** 키 = 라우트 표의 `METHOD path`. 핸들러가 없는 표의 라우트는 등록하지 않는다(Fastify 기본 404). */
export type Handlers = Record<string, (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>>;

const DIST = fileURLToPath(new URL('../../client/dist/', import.meta.url));

export async function buildApp(d: Pick<Deps, 'db' | 'config'> & Partial<Deps>, opts: FastifyServerOptions = {}) {
  // providersFor: index.ts 가 providers/index.ts 의 실 팩토리를 넘긴다. 기본값은 테스트용: 넘기지 않으면 실 모드의 키 저장·턴이 실패한다.
  const deps: Deps = { limiter: createLimiter(), now: () => new Date(), providersFor: () => { throw new Error('providersFor not wired'); }, ...d };
  const app = Fastify(opts);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(cookie);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiFail) return reply.code(ERROR_STATUS[err.code]).send({ error: { code: err.code, message: err.message, details: err.details } });
    if (hasZodFastifySchemaValidationErrors(err)) {
      const details = err.validation.map(v => ({ code: v.keyword, path: v.instancePath.split('/').filter(Boolean), message: v.message }));
      return reply.code(ERROR_STATUS.validation_failed).send({ error: { code: 'validation_failed', message: 'validation failed', details } });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status < 500) return reply.code(ERROR_STATUS.validation_failed).send({ error: { code: 'validation_failed', message: (err as Error).message } });   // 깨진 JSON·content-type 등
    req.log.error({ err }, 'unhandled error');
    // Coordinator-approved transport fallback (#40 review): 'internal' is not an ErrorCode, it only keeps the {error} body shape for ApiError.
    return reply.code(500).send({ error: { code: 'internal', message: 'internal error' } });
  });

  const handlers: Handlers = { ...authHandlers(deps), ...sessionHandlers(deps), ...adminScenarioHandlers(deps), ...adminUserHandlers(deps),
    ...adminSessionHandlers(deps), ...adminAiHandlers(deps) };
  const table = new Set(routes.map(r => `${r.method} ${r.path}`));
  for (const k of Object.keys(handlers)) if (!table.has(k)) throw new Error(`handler ${k} is not in the route table`);

  for (const r of routes) {
    const handler = handlers[`${r.method} ${r.path}`];
    if (!handler) continue;
    const realm = r.realm;
    app.route({
      method: r.method, url: r.path, handler,
      schema: { ...r.body && { body: r.body }, ...r.query && { querystring: r.query }, ...typeof r.response === 'object' && { response: { '2xx': r.response } } },
      // 표의 실로 로그인을 먼저 확인하고(401/403) 본문을 검증한다(400) — 목 API와 같은 순서.
      preValidation: realm === 'none' ? undefined : async req => {
        const h = req.headers['x-remath-realm'];
        const res = resolveRealm(realm, Array.isArray(h) ? h.join() : h, { teacher: req.cookies[COOKIE.teacher], admin: req.cookies[COOKIE.admin] });
        if ('error' in res) throw new ApiFail(res.error, res.error === 'unauthorized' ? 'login required' : 'ambiguous realm: send X-Remath-Realm');
        const auth = await authenticate(deps.db, res.realm, res.token, deps.now());
        if (typeof auth === 'string') throw new ApiFail(auth, auth === 'unauthorized' ? 'login required' : 'wrong realm');
        req.auth = auth;
      },
    });
  }

  app.get('/healthz', async () => ({ ok: true }));

  // 프로덕션 빌드가 있으면 `/`에서 SPA를 서빙하고, 알 수 없는 비-/api GET은 index.html로 폴백한다. 개발은 Vite 프록시(A-5).
  const spa = existsSync(DIST + 'index.html');
  if (spa) await app.register(fastifyStatic, { root: DIST });
  app.setNotFoundHandler((req, reply) => {
    if (spa && req.method === 'GET' && !/^\/api(\/|$|\?)/.test(req.url)) return reply.sendFile('index.html');
    reply.code(404).send({ message: `Route ${req.method}:${req.url} not found`, error: 'Not Found', statusCode: 404 });
  });
  return app;
}
