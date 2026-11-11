import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { validateBatch, MAX_BATCH_SIZE } from '@pointwise/shared';
import { getDb } from './db.js';

export const apiRouter = Router();

interface StoredEvent {
  event_id: string;
  event_type: string;
  event_version: number;
  session_id: string;
  client_ts: number;
  received_ts: number;
  payload: string;
}

/**
 * 批量接收：逐条校验、逐条返回结果。
 * 批次中某条不合法不影响其他合法事件落库。
 * event_id 为主键：重试/超时重发命中重复时返回 duplicate，绝不多记一次。
 */
apiRouter.post('/events/batch', (req: Request, res: Response) => {
  const batch = (req.body as { events?: unknown } | undefined)?.events;
  const check = validateBatch(batch);

  if (!check.valid) {
    return res.status(400).json({
      error: check.reason,
      max_batch_size: MAX_BATCH_SIZE,
    });
  }

  const db = getDb();
  const insertEvent = db.prepare(
    `INSERT OR IGNORE INTO events
       (event_id, event_type, event_version, session_id, client_ts, received_ts, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertRejected = db.prepare(
    `INSERT INTO rejected_events (rejection_id, event_id, received_ts, reasons)
     VALUES (?, ?, ?, ?)`,
  );

  const events = batch as Record<string, unknown>[];
  const results = events.map((evt, index) => {
    const result = check.results![index];
    if (!result.valid) {
      // 只记录路径与原因，不回显/不落库任何原始字段值
      insertRejected.run(
        randomUUID(),
        result.event_id,
        Date.now(),
        JSON.stringify(result.errors),
      );
      return {
        event_id: result.event_id,
        status: 'rejected' as const,
        errors: result.errors,
      };
    }

    const info = insertEvent.run(
      evt.event_id as string,
      evt.event_type as string,
      evt.event_version as number,
      evt.session_id as string,
      evt.client_ts as number,
      Date.now(),
      JSON.stringify(evt),
    );
    // node:sqlite：changes=1 首次插入，changes=0 主键冲突（幂等命中）
    const inserted = Number(info.changes) === 1;
    return {
      event_id: evt.event_id as string,
      status: inserted ? ('accepted' as const) : ('duplicate' as const),
    };
  });

  const summary = results.reduce(
    (acc, r) => {
      acc[r.status] += 1;
      return acc;
    },
    { accepted: 0, duplicate: 0, rejected: 0 },
  );

  return res.json({ ...summary, results });
});

apiRouter.get('/events', (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM events ORDER BY received_ts DESC, client_ts DESC LIMIT ?')
    .all(limit) as StoredEvent[];
  res.json({
    events: rows.map((r) => ({
      ...JSON.parse(r.payload),
      received_ts: r.received_ts,
    })),
  });
});

apiRouter.get('/rejected', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db
    .prepare('SELECT rejection_id, event_id, received_ts, reasons FROM rejected_events ORDER BY received_ts DESC LIMIT 200')
    .all() as Array<{ rejection_id: string; event_id: string | null; received_ts: number; reasons: string }>;
  res.json({
    rejected: rows.map((r) => ({
      rejection_id: r.rejection_id,
      event_id: r.event_id,
      received_ts: r.received_ts,
      reasons: JSON.parse(r.reasons),
    })),
  });
});

apiRouter.get('/stats', (_req: Request, res: Response) => {
  const db = getDb();
  const byType = db
    .prepare('SELECT event_type, COUNT(*) AS count FROM events GROUP BY event_type ORDER BY event_type')
    .all() as Array<{ event_type: string; count: number }>;
  const totals = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM events) AS total_events,
         (SELECT COUNT(DISTINCT event_id) FROM events) AS distinct_ids,
         (SELECT COUNT(*) FROM rejected_events) AS total_rejected`,
    )
    .get() as { total_events: number; distinct_ids: number; total_rejected: number };
  res.json({ byType, ...totals });
});

apiRouter.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true, ts: Date.now() });
});
