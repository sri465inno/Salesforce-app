/**
 * Local demo reservation service: GraphQL API (contracts/reservation.graphql) plus a
 * Lightning-style UI that mirrors the force-app LWCs. Contains one intentionally seeded
 * defect (BR-002 accepts customerCount = 0) so the QE platform has something real to find.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { AddressInfo } from 'node:net';
import { BROWSER_DIST, ROOT } from '../shared/paths';
import { maskDeep } from '../shared/mask';
import { execute } from './graphql';
import { ReservationService } from './reservation-service';
import { ValidatorOptions } from './reservation-validator';

export interface ServiceLogEntry {
  seq: number;
  at: string;
  testId: string | null;
  operationName: string | null;
  variables: unknown;
  response: unknown;
  durationMs: number;
}

export interface DemoService {
  url: string;
  build: string;
  log: ServiceLogEntry[];
  close(): Promise<void>;
}

export function createDemoApp(options: ValidatorOptions = {}) {
  const service = new ReservationService(options);
  const log: ServiceLogEntry[] = [];
  const build = options.fixedDefects?.length ? `reservation-demo@1.0.1 (fixed: ${options.fixedDefects.join(', ')})` : 'reservation-demo@1.0.0 (seeded defect BR-002)';
  const app = express();
  app.use(express.json({ limit: '200kb' }));
  const uiDir = path.join(ROOT, 'src', 'demo-service', 'ui');

  app.get('/', (_req, res) => res.sendFile(path.join(uiDir, 'index.html')));
  app.get('/styles.css', (_req, res) => res.sendFile(path.join(uiDir, 'styles.css')));
  app.get('/app.js', (_req, res) => {
    const file = path.join(BROWSER_DIST, 'demo-service', 'ui', 'app.js');
    if (!fs.existsSync(file)) return res.status(500).type('text').send('UI bundle missing: run npm run build');
    return res.type('application/javascript').sendFile(file);
  });
  app.get('/__build', (_req, res) => res.json({ build }));
  app.get('/__log', (req, res) => {
    const testId = typeof req.query.testId === 'string' ? req.query.testId : null;
    res.json(testId ? log.filter((l) => l.testId === testId) : log);
  });

  app.post('/graphql', async (req, res) => {
    const started = Date.now();
    const { query, variables, operationName } = (req.body ?? {}) as { query?: string; variables?: Record<string, unknown>; operationName?: string };
    if (typeof query !== 'string') return res.status(400).json({ errors: [{ message: 'query is required' }] });
    const result = await execute(service, query, variables, operationName);
    const body = JSON.parse(JSON.stringify(result));
    log.push({
      seq: log.length + 1,
      at: new Date(started).toISOString(),
      testId: req.header('x-aqe-test-id') ?? null,
      operationName: operationName ?? (/(?:query|mutation)\s+(\w+)/.exec(query)?.[1] || null),
      variables: maskDeep(variables ?? {}),
      response: maskDeep(body),
      durationMs: Date.now() - started,
    });
    if (log.length > 5000) log.splice(0, log.length - 5000);
    return res.json(body);
  });

  return { app, service, log, build };
}

export async function startDemoService(port = 0, options: ValidatorOptions = {}): Promise<DemoService> {
  const { app, log, build } = createDemoApp(options);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const { port: actual } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${actual}`,
    build,
    log,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
