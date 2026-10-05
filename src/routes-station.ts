import { Router } from 'express';
import { getDb } from './db.js';
import { verifyPassword, generateToken } from './auth.js';
import { buildShowState, confirmCue } from './state.js';
import { HttpError, requireStation, wrap } from './http-helpers.js';
import { broadcastShow } from './realtime.js';

export const stationRouter = Router();

// 凭场次码查询当场信息与可选岗位（不需要口令）
stationRouter.post(
  '/entry',
  wrap((req, res) => {
    const code = String(req.body?.code ?? '').trim().toUpperCase();
    if (!code) throw new HttpError(400, 'BAD_REQUEST', '请输入场次入场码');
    const show = getDb()
      .prepare(
        `SELECT s.id, s.code, s.label, s.status, s.version_id, s.opened_at, v.label AS version_label
         FROM shows s JOIN versions v ON v.id = s.version_id WHERE s.code = ?`,
      )
      .get(code) as
      | { id: number; code: string; label: string; status: string; version_id: number; opened_at: number; version_label: string }
      | undefined;
    if (!show) throw new HttpError(404, 'SHOW_NOT_FOUND', '入场码无效：找不到该场演出');

    // 该版本涉及的岗位
    const cueRows = getDb()
      .prepare(`SELECT position_names FROM version_cues WHERE version_id = ?`)
      .all(show.version_id) as { position_names: string }[];
    const names: string[] = [];
    for (const r of cueRows) for (const n of JSON.parse(r.position_names) as string[]) if (!names.includes(n)) names.push(n);
    const positions = (
      getDb().prepare(`SELECT id, name FROM positions`).all() as { id: number; name: string }[]
    ).filter((p) => names.includes(p.name));

    res.json({
      show: {
        id: show.id,
        code: show.code,
        label: show.label,
        status: show.status,
        versionId: show.version_id,
        versionLabel: show.version_label,
      },
      positions: positions.map((p) => ({ id: p.id, name: p.name })),
    });
  }),
);

// 岗位凭口令进入当场
stationRouter.post(
  '/login',
  wrap((req, res) => {
    const code = String(req.body?.code ?? '').trim().toUpperCase();
    const positionId = Number(req.body?.positionId);
    const password = String(req.body?.password ?? '');
    if (!code || !Number.isInteger(positionId) || !password)
      throw new HttpError(400, 'BAD_REQUEST', '请填写入场码、岗位与口令');

    const db = getDb();
    const show = db.prepare(`SELECT id, version_id FROM shows WHERE code = ?`).get(code) as
      | { id: number; version_id: number }
      | undefined;
    if (!show) throw new HttpError(404, 'SHOW_NOT_FOUND', '入场码无效：找不到该场演出');

    const position = db.prepare(`SELECT id, name, password_hash, password_salt FROM positions WHERE id = ?`).get(positionId) as
      | { id: number; name: string; password_hash: string; password_salt: string }
      | undefined;
    if (!position) throw new HttpError(404, 'POSITION_NOT_FOUND', '岗位不存在');

    // 该岗位必须在本场选定版本中承担提示项
    const cues = db.prepare(`SELECT position_names FROM version_cues WHERE version_id = ?`).all(show.version_id) as {
      position_names: string;
    }[];
    const isAssigned = cues.some((c) => (JSON.parse(c.position_names) as string[]).includes(position.name));
    if (!isAssigned)
      throw new HttpError(403, 'NOT_IN_VERSION', '该岗位未参与本场版本的任何提示项，禁止进入');

    if (!verifyPassword(password, position.password_salt, position.password_hash))
      throw new HttpError(401, 'BAD_PASSWORD', '口令错误，已拒绝（未写入任何记录）');

    const token = generateToken();
    db.prepare(
      `INSERT INTO sessions (token, role, position_id, show_id, created_at) VALUES (?, 'station', ?, ?, ?)`,
    ).run(token, position.id, show.id, Date.now());

    res.json({
      token,
      position: { id: position.id, name: position.name },
      state: buildShowState(show.id, position.name),
    });
  }),
);

// 查询当场权威状态（断线重连/页面刷新时与 WS 下发内容一致）
stationRouter.get(
  '/state',
  wrap((req, res) => {
    const auth = requireStation(req);
    const state = buildShowState(auth.showId, auth.positionName);
    if (!state) throw new HttpError(404, 'SHOW_NOT_FOUND', '场次不存在');
    res.json({ state });
  }),
);

// 确认提示项：服务端事务保证顺序互锁、全员完成、幂等
stationRouter.post(
  '/confirm',
  wrap((req, res) => {
    const auth = requireStation(req);
    const cueId = Number(req.body?.cueId);
    const versionId = Number(req.body?.versionId);
    if (!Number.isInteger(cueId) || !Number.isInteger(versionId))
      throw new HttpError(400, 'BAD_REQUEST', '缺少提示项或版本标识');

    const db = getDb();

    // 显式校验“提交版本与场次不符”
    const show = db.prepare(`SELECT version_id FROM shows WHERE id = ?`).get(auth.showId) as
      | { version_id: number }
      | undefined;
    if (!show) throw new HttpError(404, 'SHOW_NOT_FOUND', '场次不存在');
    if (show.version_id !== versionId)
      throw new HttpError(
        409,
        'VERSION_MISMATCH',
        '提交版本与开场选定版本不符，已拒绝（页面可能已过期，请刷新后重试）',
      );

    const result = db.transaction(() =>
      // SERIALIZABLE：better-sqlite3 事务默认 DEFERRED，写事务内顺序执行；确认操作以单个同步事务原子完成
      confirmCue(db, auth.showId, cueId, auth.positionName),
    )();

    if (!result.ok) throw new HttpError(result.status, result.code, result.message);

    if (!result.duplicate) {
      broadcastShow(auth.showId, { kind: 'confirmed', message: `${auth.positionName} 已确认一项提示` });
    }
    res.status(result.duplicate ? 200 : 201).json({
      duplicate: result.duplicate,
      message: result.duplicate ? '你此前已确认过该项，重复提交只保留一次' : '已确认',
      state: result.state,
    });
  }),
);

stationRouter.post(
  '/logout',
  wrap((req, res) => {
    const token = req.header('authorization')?.replace('Bearer ', '').trim();
    if (token) getDb().prepare(`DELETE FROM sessions WHERE token = ? AND role = 'station'`).run(token);
    res.json({ ok: true });
  }),
);
