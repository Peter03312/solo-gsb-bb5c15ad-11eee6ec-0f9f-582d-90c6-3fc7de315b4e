import type Database from 'better-sqlite3';
import { getDb } from './db.js';

export interface ConfirmationView {
  positionName: string;
  at: number;
  seq: number;
}

export interface CueView {
  id: number;
  order: number;
  title: string;
  note: string;
  positionNames: string[];
  confirmations: ConfirmationView[];
  completed: boolean;
  /** 当前岗位是否已确认（岗位视角时使用） */
  mine?: boolean;
}

export interface EventView {
  seq: number;
  type: string;
  at: number;
  cueId: number | null;
  cueOrder: number | null;
  positionName: string | null;
  detail: string;
}

export interface ShowState {
  showId: number;
  code: string;
  label: string;
  status: 'open' | 'completed';
  versionId: number;
  versionLabel: string;
  openedAt: number;
  closedAt: number | null;
  positions: string[];
  cues: CueView[];
  events: EventView[];
  /** 第一个尚未全部确认的提示项序号（0 基）；全部完成则为 null */
  currentOrder: number | null;
  serverNow: number;
}

export function buildShowState(showId: number, forPositionName?: string): ShowState | null {
  const db = getDb();
  const show = db
    .prepare(
      `SELECT s.id, s.code, s.label, s.status, s.version_id, s.opened_at, s.closed_at, v.label AS version_label
       FROM shows s JOIN versions v ON v.id = s.version_id WHERE s.id = ?`,
    )
    .get(showId) as
    | {
        id: number;
        code: string;
        label: string;
        status: 'open' | 'completed';
        version_id: number;
        opened_at: number;
        closed_at: number | null;
        version_label: string;
      }
    | undefined;
  if (!show) return null;

  const cueRows = db
    .prepare(`SELECT id, sort_order, title, note, position_names FROM version_cues WHERE version_id = ? ORDER BY sort_order`)
    .all(show.version_id) as { id: number; sort_order: number; title: string; note: string; position_names: string }[];

  const confRows = db
    .prepare(`SELECT cue_id, position_name, seq, at FROM confirmations WHERE show_id = ? ORDER BY seq`)
    .all(showId) as { cue_id: number; position_name: string; seq: number; at: number }[];

  const confByCue = new Map<number, ConfirmationView[]>();
  for (const c of confRows) {
    const list = confByCue.get(c.cue_id) ?? [];
    list.push({ positionName: c.position_name, at: c.at, seq: c.seq });
    confByCue.set(c.cue_id, list);
  }

  let currentOrder: number | null = null;
  const cues: CueView[] = cueRows.map((r) => {
    const positionNames = JSON.parse(r.position_names) as string[];
    const confirmations = confByCue.get(r.id) ?? [];
    const completed = confirmations.length >= positionNames.length;
    if (!completed && currentOrder === null) currentOrder = r.sort_order;
    return {
      id: r.id,
      order: r.sort_order,
      title: r.title,
      note: r.note,
      positionNames,
      confirmations,
      completed,
      mine: forPositionName ? confirmations.some((c) => c.positionName === forPositionName) : undefined,
    };
  });

  const eventRows = db
    .prepare(
      `SELECT e.seq, e.type, e.at, e.cue_id, e.position_name, e.detail, vc.sort_order AS cue_order
       FROM events e LEFT JOIN version_cues vc ON vc.id = e.cue_id
       WHERE e.show_id = ? ORDER BY e.seq`,
    )
    .all(showId) as {
    seq: number;
    type: string;
    at: number;
    cue_id: number | null;
    cue_order: number | null;
    position_name: string | null;
    detail: string;
  }[];

  // 该版本涉及的全部岗位（去重、保序）
  const positionSet: string[] = [];
  for (const c of cues) for (const p of c.positionNames) if (!positionSet.includes(p)) positionSet.push(p);

  return {
    showId: show.id,
    code: show.code,
    label: show.label,
    status: show.status,
    versionId: show.version_id,
    versionLabel: show.version_label,
    openedAt: show.opened_at,
    closedAt: show.closed_at,
    positions: positionSet,
    cues,
    events: eventRows.map((e) => ({
      seq: e.seq,
      type: e.type,
      at: e.at,
      cueId: e.cue_id,
      cueOrder: e.cue_order,
      positionName: e.position_name,
      detail: e.detail,
    })),
    currentOrder,
    serverNow: Date.now(),
  };
}

export type ConfirmResult =
  | { ok: true; duplicate: boolean; state: ShowState }
  | { ok: false; status: number; code: string; message: string };

/**
 * 岗位确认提示项。整体在一个 SERIALIZABLE 事务内执行：
 * - 演出/版本必须匹配，演出未结束
 * - 提示项必须分配给该岗位
 * - 前一项未全部完成则拒绝（顺序互锁）
 * - 重复确认幂等：不重复写入
 */
export function confirmCue(tx: Database.Database, showId: number, cueId: number, positionName: string): ConfirmResult {
  const show = tx
    .prepare(`SELECT id, status, version_id FROM shows WHERE id = ?`)
    .get(showId) as { id: number; status: string; version_id: number } | undefined;
  if (!show) return { ok: false, status: 404, code: 'SHOW_NOT_FOUND', message: '场次不存在' };
  if (show.status !== 'open')
    return { ok: false, status: 409, code: 'SHOW_CLOSED', message: '该场演出已结束，不能再确认提示项' };

  const cue = tx
    .prepare(`SELECT id, version_id, sort_order, title, position_names FROM version_cues WHERE id = ?`)
    .get(cueId) as { id: number; version_id: number; sort_order: number; title: string; position_names: string } | undefined;
  if (!cue || cue.version_id !== show.version_id)
    return {
      ok: false,
      status: 409,
      code: 'VERSION_MISMATCH',
      message: '提交的提示项不属于本场选定版本，已拒绝（场次与版本不符）',
    };

  const assigned = JSON.parse(cue.position_names) as string[];
  const cueTitle = cue.title;
  if (!assigned.includes(positionName))
    return { ok: false, status: 403, code: 'NOT_ASSIGNED', message: '该提示项未分配给本岗位，禁止确认' };

  // 顺序互锁：所有更小编号的提示项必须已全部确认
  const prevCues = tx
    .prepare(`SELECT id, position_names FROM version_cues WHERE version_id = ? AND sort_order < ? ORDER BY sort_order`)
    .all(show.version_id, cue.sort_order) as { id: number; position_names: string }[];

  for (const prev of prevCues) {
    const need = JSON.parse(prev.position_names) as string[];
    const got = tx
      .prepare(`SELECT COUNT(*) AS n FROM confirmations WHERE show_id = ? AND cue_id = ?`)
      .get(showId, prev.id) as { n: number };
    if (got.n < need.length) {
      return {
        ok: false,
        status: 409,
        code: 'OUT_OF_ORDER',
        message: `前一项（第 ${prevCues.findIndex((p) => p.id === prev.id) + 1} 项）尚未完成，不能确认本项`,
      };
    }
  }

  // 幂等：本岗位已确认过
  const existing = tx
    .prepare(`SELECT id FROM confirmations WHERE show_id = ? AND cue_id = ? AND position_name = ?`)
    .get(showId, cueId, positionName);
  if (existing) {
    return { ok: true, duplicate: true, state: buildShowState(showId, positionName)! };
  }

  const now = Date.now();
  const nextSeq = (tx.prepare(`SELECT COALESCE(MAX(seq),0) + 1 AS n FROM events WHERE show_id = ?`).get(showId) as {
    n: number;
  }).n;

  tx.prepare(
    `INSERT INTO confirmations (show_id, cue_id, position_name, seq, at) VALUES (?, ?, ?, ?, ?)`,
  ).run(showId, cueId, positionName, nextSeq, now);
  tx.prepare(
    `INSERT INTO events (show_id, seq, type, at, cue_id, position_name, detail) VALUES (?, ?, 'confirm', ?, ?, ?, '')`,
  ).run(showId, nextSeq, now, cueId, positionName);

  // 该项是否已全部确认？
  const needCount = assigned.length;
  const gotCount = tx
    .prepare(`SELECT COUNT(*) AS n FROM confirmations WHERE show_id = ? AND cue_id = ?`)
    .get(showId, cueId) as { n: number };

  if (gotCount.n === needCount) {
    const cseq = nextSeq + 1;
    tx.prepare(
      `INSERT INTO events (show_id, seq, type, at, cue_id, position_name, detail) VALUES (?, ?, 'cue_completed', ?, ?, NULL, ?)`,
    ).run(showId, cseq, now, cueId, `第 ${cue.sort_order + 1} 项「${cueTitle}」全部岗位确认完成`);

    // 是否整场结束？（所有提示项均已全部确认）
    const allCues = tx
      .prepare(`SELECT id, position_names FROM version_cues WHERE version_id = ?`)
      .all(show.version_id) as { id: number; position_names: string }[];
    const allDone = allCues.every(
      (c) =>
        (tx.prepare(`SELECT COUNT(*) AS n FROM confirmations WHERE show_id = ? AND cue_id = ?`).get(showId, c.id) as {
          n: number;
        }).n >= (JSON.parse(c.position_names) as string[]).length,
    );
    if (allDone) {
      const sseq = (
        tx.prepare(`SELECT COALESCE(MAX(seq),0) + 1 AS n FROM events WHERE show_id = ?`).get(showId) as { n: number }
      ).n;
      tx.prepare(`UPDATE shows SET status = 'completed', closed_at = ? WHERE id = ?`).run(now, showId);
      tx.prepare(
        `INSERT INTO events (show_id, seq, type, at, cue_id, position_name, detail) VALUES (?, ?, 'show_completed', ?, NULL, NULL, '本场全部提示项完成，演出结束')`,
      ).run(showId, sseq, now);
    }
  }

  return { ok: true, duplicate: false, state: buildShowState(showId, positionName)! };
}
