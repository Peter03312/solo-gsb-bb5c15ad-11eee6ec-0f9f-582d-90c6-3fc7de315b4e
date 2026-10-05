import { Router } from 'express';
import { getDb, getDirectorCredentials, setDirectorPassword } from './db.js';
import { verifyPassword, hashPassword, generateToken, generatePositionKey, generateShowCode } from './auth.js';
import { buildShowState } from './state.js';
import { HttpError, requireDirector, wrap } from './http-helpers.js';
import { broadcastShow } from './realtime.js';

export const directorRouter = Router();

directorRouter.post(
  '/login',
  wrap((req, res) => {
    const password = String(req.body?.password ?? '');
    const cred = getDirectorCredentials();
    if (!verifyPassword(password, cred.salt, cred.hash))
      throw new HttpError(401, 'BAD_PASSWORD', '导演口令错误，已拒绝');
    const token = generateToken();
    getDb()
      .prepare(`INSERT INTO sessions (token, role, position_id, show_id, created_at) VALUES (?, 'director', NULL, NULL, ?)`)
      .run(token, Date.now());
    res.json({ token });
  }),
);

directorRouter.post(
  '/change-password',
  requireDirector,
  wrap((req, res) => {
    const next = String(req.body?.password ?? '');
    if (next.length < 4) throw new HttpError(400, 'BAD_REQUEST', '新口令至少 4 个字符');
    setDirectorPassword(next);
    res.json({ ok: true });
  }),
);

directorRouter.post(
  '/logout',
  wrap((req, res) => {
    const token = req.header('authorization')?.replace('Bearer ', '').trim();
    if (token) getDb().prepare(`DELETE FROM sessions WHERE token = ? AND role = 'director'`).run(token);
    res.json({ ok: true });
  }),
);

/* ---------------- 岗位 ---------------- */

directorRouter.get(
  '/positions',
  requireDirector,
  wrap((_req, res) => {
    const rows = getDb().prepare(`SELECT id, key, name, created_at FROM positions ORDER BY id`).all();
    res.json({ positions: rows });
  }),
);

directorRouter.post(
  '/positions',
  requireDirector,
  wrap((req, res) => {
    const name = String(req.body?.name ?? '').trim();
    const password = String(req.body?.password ?? '');
    if (!name) throw new HttpError(400, 'BAD_REQUEST', '岗位名称不能为空');
    if (name.length > 40) throw new HttpError(400, 'BAD_REQUEST', '岗位名称过长（≤40 字）');
    if (password.length < 4) throw new HttpError(400, 'BAD_REQUEST', '岗位口令至少 4 个字符');
    const db = getDb();
    const exists = db.prepare(`SELECT 1 FROM positions WHERE name = ?`).get(name);
    if (exists) throw new HttpError(409, 'DUP_NAME', `岗位「${name}」已存在`);
    const { hash, salt } = hashPassword(password);
    const info = db
      .prepare(
        `INSERT INTO positions (key, name, password_hash, password_salt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(generatePositionKey(), name, hash, salt, Date.now(), Date.now());
    res.status(201).json({ id: Number(info.lastInsertRowid), name });
  }),
);

directorRouter.patch(
  '/positions/:id',
  requireDirector,
  wrap((req, res) => {
    const id = Number(req.params.id);
    const name = req.body?.name === undefined ? undefined : String(req.body.name).trim();
    const password = req.body?.password === undefined ? undefined : String(req.body.password);
    const db = getDb();
    const pos = db.prepare(`SELECT id FROM positions WHERE id = ?`).get(id);
    if (!pos) throw new HttpError(404, 'NOT_FOUND', '岗位不存在');
    if (name !== undefined) {
      if (!name) throw new HttpError(400, 'BAD_REQUEST', '岗位名称不能为空');
      const dup = db.prepare(`SELECT 1 FROM positions WHERE name = ? AND id <> ?`).get(name, id);
      if (dup) throw new HttpError(409, 'DUP_NAME', `岗位「${name}」已存在`);
      db.prepare(`UPDATE positions SET name = ?, updated_at = ? WHERE id = ?`).run(name, Date.now(), id);
    }
    if (password !== undefined) {
      if (password.length < 4) throw new HttpError(400, 'BAD_REQUEST', '岗位口令至少 4 个字符');
      const { hash, salt } = hashPassword(password);
      db.prepare(`UPDATE positions SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?`).run(
        hash,
        salt,
        Date.now(),
        id,
      );
    }
    res.json({ ok: true });
  }),
);

/* ---------------- 草稿提示项 ---------------- */

directorRouter.get(
  '/draft',
  requireDirector,
  wrap((_req, res) => {
    const db = getDb();
    const cues = db
      .prepare(`SELECT id, sort_order, title, note FROM draft_cues ORDER BY sort_order, id`)
      .all() as { id: number; sort_order: number; title: string; note: string }[];
    const links = db
      .prepare(`SELECT cue_id, position_id FROM draft_cue_positions`)
      .all() as { cue_id: number; position_id: number }[];
    const posById = new Map<number, { id: number; name: string }>();
    for (const p of db.prepare(`SELECT id, name FROM positions`).all() as { id: number; name: string }[])
      posById.set(p.id, { id: p.id, name: p.name });

    res.json({
      cues: cues.map((c) => ({
        id: c.id,
        order: c.sort_order,
        title: c.title,
        note: c.note,
        positions: links
          .filter((l) => l.cue_id === c.id)
          .map((l) => posById.get(l.position_id))
          .filter(Boolean),
      })),
    });
  }),
);

function normalizeCueBody(body: any): { title: string; note: string; positionIds: number[] } {
  const title = String(body?.title ?? '').trim();
  const note = String(body?.note ?? '').trim();
  const rawPositions: unknown[] = Array.isArray(body?.positionIds) ? body.positionIds : [];
  const positionIds = [...new Set(rawPositions.map(Number).filter((n: number) => Number.isInteger(n)))];
  if (!title) throw new HttpError(400, 'BAD_REQUEST', '提示项内容不能为空');
  if (title.length > 120) throw new HttpError(400, 'BAD_REQUEST', '提示项内容过长（≤120 字）');
  if (positionIds.length === 0) throw new HttpError(400, 'NO_POSITION', '每条提示项至少指定一个岗位');
  return { title, note, positionIds };
}

function assertPositionsExist(db: ReturnType<typeof getDb>, ids: number[]): void {
  const found = db
    .prepare(`SELECT COUNT(*) AS n FROM positions WHERE id IN (${ids.map(() => '?').join(',')})`)
    .get(...ids) as { n: number };
  if (found.n !== ids.length) throw new HttpError(400, 'BAD_POSITION', '存在无效岗位，请刷新岗位列表');
}

directorRouter.post(
  '/draft/cues',
  requireDirector,
  wrap((req, res) => {
    const { title, note, positionIds } = normalizeCueBody(req.body);
    const db = getDb();
    assertPositionsExist(db, positionIds);
    const result = db.transaction(() => {
      const maxOrder = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM draft_cues`).get() as { m: number };
      const order = maxOrder.m + 1;
      const info = db.prepare(`INSERT INTO draft_cues (sort_order, title, note) VALUES (?, ?, ?)`).run(order, title, note);
      const cueId = Number(info.lastInsertRowid);
      const ins = db.prepare(`INSERT INTO draft_cue_positions (cue_id, position_id) VALUES (?, ?)`);
      for (const pid of positionIds) ins.run(cueId, pid);
      return { cueId, order };
    })();
    res.status(201).json({ id: result.cueId, order: result.order });
  }),
);

directorRouter.patch(
  '/draft/cues/:id',
  requireDirector,
  wrap((req, res) => {
    const id = Number(req.params.id);
    const { title, note, positionIds } = normalizeCueBody(req.body);
    const db = getDb();
    db.transaction(() => {
      const cue = db.prepare(`SELECT id FROM draft_cues WHERE id = ?`).get(id);
      if (!cue) throw new HttpError(404, 'NOT_FOUND', '草稿提示项不存在');
      assertPositionsExist(db, positionIds);
      db.prepare(`UPDATE draft_cues SET title = ?, note = ? WHERE id = ?`).run(title, note, id);
      db.prepare(`DELETE FROM draft_cue_positions WHERE cue_id = ?`).run(id);
      const ins = db.prepare(`INSERT INTO draft_cue_positions (cue_id, position_id) VALUES (?, ?)`);
      for (const pid of positionIds) ins.run(id, pid);
    })();
    res.json({ ok: true });
  }),
);

directorRouter.delete(
  '/draft/cues/:id',
  requireDirector,
  wrap((req, res) => {
    const id = Number(req.params.id);
    const db = getDb();
    db.transaction(() => {
      const cue = db
        .prepare(`SELECT sort_order FROM draft_cues WHERE id = ?`)
        .get(id) as { sort_order: number } | undefined;
      if (!cue) return;
      db.prepare(`DELETE FROM draft_cues WHERE id = ?`).run(id);
      // 重新连续编号
      const rest = db.prepare(`SELECT id FROM draft_cues ORDER BY sort_order, id`).all() as { id: number }[];
      const upd = db.prepare(`UPDATE draft_cues SET sort_order = ? WHERE id = ?`);
      rest.forEach((r, i) => upd.run(i, r.id));
    })();
    res.json({ ok: true });
  }),
);

// 整体重排：body: { orderedIds: number[] }
directorRouter.post(
  '/draft/reorder',
  requireDirector,
  wrap((req, res) => {
    const orderedIds: number[] = Array.isArray(req.body?.orderedIds) ? req.body.orderedIds.map(Number) : null!;
    if (!orderedIds) throw new HttpError(400, 'BAD_REQUEST', '缺少 orderedIds');
    const db = getDb();
    db.transaction(() => {
      const all = db.prepare(`SELECT id FROM draft_cues`).all() as { id: number }[];
      const allIds = all.map((a) => a.id).sort((a, b) => a - b);
      const given = [...orderedIds].sort((a, b) => a - b);
      if (allIds.length !== given.length || allIds.some((v, i) => v !== given[i]))
        throw new HttpError(400, 'BAD_ORDER', '排序列表与当前草稿不一致，请刷新后重试');
      const upd = db.prepare(`UPDATE draft_cues SET sort_order = ? WHERE id = ?`);
      orderedIds.forEach((id, i) => upd.run(i, id));
    })();
    res.json({ ok: true });
  }),
);

/* ---------------- 版本（不可变快照） ---------------- */

directorRouter.get(
  '/versions',
  requireDirector,
  wrap((_req, res) => {
    const db = getDb();
    const versions = db
      .prepare(`SELECT id, label, note, created_at FROM versions ORDER BY id DESC`)
      .all() as { id: number; label: string; note: string; created_at: number }[];
    const cues = db
      .prepare(`SELECT id, version_id, sort_order, title, note, position_names FROM version_cues ORDER BY version_id, sort_order`)
      .all() as {
      id: number;
      version_id: number;
      sort_order: number;
      title: string;
      note: string;
      position_names: string;
    }[];
    const usedVersionIds = new Set(
      (db.prepare(`SELECT DISTINCT version_id FROM shows`).all() as { version_id: number }[]).map((r) => r.version_id),
    );
    res.json({
      versions: versions.map((v) => ({
        id: v.id,
        label: v.label,
        note: v.note,
        createdAt: v.created_at,
        usedByShow: usedVersionIds.has(v.id),
        cues: cues
          .filter((c) => c.version_id === v.id)
          .map((c) => ({
            id: c.id,
            order: c.sort_order,
            title: c.title,
            note: c.note,
            positionNames: JSON.parse(c.position_names),
          })),
      })),
    });
  }),
);

// 发布：把当前草稿冻结为不可变版本
directorRouter.post(
  '/versions',
  requireDirector,
  wrap((req, res) => {
    const note = String(req.body?.note ?? '').trim();
    const db = getDb();
    const result = db.transaction(() => {
      const cues = db
        .prepare(`SELECT id, sort_order, title, note FROM draft_cues ORDER BY sort_order, id`)
        .all() as { id: number; sort_order: number; title: string; note: string }[];
      if (cues.length === 0) throw new HttpError(400, 'EMPTY_DRAFT', '草稿为空，至少需要一条提示项才能发布');

      // 连续重排后快照
      const links = db
        .prepare(`SELECT cue_id, position_id FROM draft_cue_positions`)
        .all() as { cue_id: number; position_id: number }[];
      for (const c of cues) {
        const ids = links.filter((l) => l.cue_id === c.id).map((l) => l.position_id);
        if (ids.length === 0) throw new HttpError(400, 'NO_POSITION', `草稿第 ${c.sort_order + 1} 项未指定岗位`);
      }
      const posNames = new Map<number, string>(
        (db.prepare(`SELECT id, name FROM positions`).all() as { id: number; name: string }[]).map((p) => [p.id, p.name]),
      );

      const countRow = db.prepare(`SELECT COUNT(*) AS n FROM versions`).get() as { n: number };
      const label = `v${countRow.n + 1}`;
      const now = Date.now();
      const info = db.prepare(`INSERT INTO versions (label, note, created_at) VALUES (?, ?, ?)`).run(label, note, now);
      const versionId = Number(info.lastInsertRowid);
      const ins = db.prepare(
        `INSERT INTO version_cues (version_id, sort_order, title, note, position_names) VALUES (?, ?, ?, ?, ?)`,
      );
      cues.forEach((c, i) => {
        const ids = links.filter((l) => l.cue_id === c.id).map((l) => l.position_id);
        const names = ids.map((pid) => posNames.get(pid)).filter((n): n is string => Boolean(n));
        ins.run(versionId, i, c.title, c.note, JSON.stringify(names));
      });
      return { versionId, label };
    })();
    res.status(201).json({ id: result.versionId, label: result.label });
  }),
);

/* ---------------- 场次 ---------------- */

directorRouter.get(
  '/shows',
  requireDirector,
  wrap((_req, res) => {
    const rows = getDb()
      .prepare(
        `SELECT s.id, s.code, s.label, s.status, s.opened_at, s.closed_at, s.version_id, v.label AS version_label
         FROM shows s JOIN versions v ON v.id = s.version_id ORDER BY s.id DESC`,
      )
      .all();
    res.json({ shows: rows });
  }),
);

// 选定一个版本开场
directorRouter.post(
  '/shows',
  requireDirector,
  wrap((req, res) => {
    const versionId = Number(req.body?.versionId);
    const label = String(req.body?.label ?? '').trim();
    if (!Number.isInteger(versionId)) throw new HttpError(400, 'BAD_REQUEST', '请选择一个已发布版本');
    const db = getDb();
    const result = db.transaction(() => {
      const version = db.prepare(`SELECT id, label FROM versions WHERE id = ?`).get(versionId) as
        | { id: number; label: string }
        | undefined;
      if (!version) throw new HttpError(404, 'VERSION_NOT_FOUND', '版本不存在或尚未发布');
      const cueCount = db.prepare(`SELECT COUNT(*) AS n FROM version_cues WHERE version_id = ?`).get(versionId) as {
        n: number;
      };
      if (cueCount.n === 0) throw new HttpError(400, 'EMPTY_VERSION', '该版本没有提示项');

      // 生成唯一入场码
      let code = generateShowCode();
      for (let i = 0; i < 10; i++) {
        if (!db.prepare(`SELECT 1 FROM shows WHERE code = ?`).get(code)) break;
        code = generateShowCode();
      }
      const now = Date.now();
      const showLabel = label || `${version.label} 场`;
      const info = db
        .prepare(
          `INSERT INTO shows (code, version_id, label, status, opened_at) VALUES (?, ?, ?, 'open', ?)`,
        )
        .run(code, versionId, showLabel, now);
      const showId = Number(info.lastInsertRowid);
      db.prepare(
        `INSERT INTO events (show_id, seq, type, at, cue_id, position_name, detail) VALUES (?, 1, 'show_opened', ?, NULL, NULL, ?)`,
      ).run(showId, now, `开场：选定版本 ${version.label}`);
      return { showId, code, showLabel };
    })();
    res.status(201).json({ id: result.showId, code: result.code, label: result.showLabel });
  }),
);

directorRouter.get(
  '/shows/:id/state',
  requireDirector,
  wrap((req, res) => {
    const showId = Number(req.params.id);
    const state = buildShowState(showId);
    if (!state) throw new HttpError(404, 'SHOW_NOT_FOUND', '场次不存在');
    res.json({ state });
  }),
);

// 导演以监视身份加入某场 WS（不参与确认）
directorRouter.post(
  '/shows/:id/monitor',
  requireDirector,
  wrap((req, res) => {
    const showId = Number(req.params.id);
    const db = getDb();
    const show = db.prepare(`SELECT id FROM shows WHERE id = ?`).get(showId);
    if (!show) throw new HttpError(404, 'SHOW_NOT_FOUND', '场次不存在');
    const token = generateToken();
    db.prepare(
      `INSERT INTO sessions (token, role, position_id, show_id, created_at) VALUES (?, 'director', NULL, ?, ?)`,
    ).run(token, showId, Date.now());
    res.json({ token });
  }),
);

void broadcastShow;
