import type { Request, Response, NextFunction } from 'express';
import { getDb } from './db.js';

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface DirectorSession {
  token: string;
}

export function requireDirector(req: Request, _res: Response, next: NextFunction): void {
  const token = bearerToken(req);
  if (!token) throw new HttpError(401, 'UNAUTHORIZED', '未登录或会话已失效，请重新输入导演口令');
  const row = getDb()
    .prepare(`SELECT token FROM sessions WHERE token = ? AND role = 'director'`)
    .get(token);
  if (!row) throw new HttpError(401, 'UNAUTHORIZED', '导演会话无效，请重新登录');
  next();
}

export interface StationAuth {
  token: string;
  positionId: number;
  positionName: string;
  showId: number;
}

export function requireStation(req: Request): StationAuth {
  const token = bearerToken(req);
  if (!token) throw new HttpError(401, 'UNAUTHORIZED', '未登录或会话已失效，请重新输入岗位口令');
  const session = getDb()
    .prepare(`SELECT position_id, show_id FROM sessions WHERE token = ? AND role = 'station'`)
    .get(token) as { position_id: number | null; show_id: number | null } | undefined;
  if (!session || !session.position_id || !session.show_id)
    throw new HttpError(401, 'UNAUTHORIZED', '岗位会话无效，请重新登录');
  const pos = getDb().prepare(`SELECT name FROM positions WHERE id = ?`).get(session.position_id) as
    | { name: string }
    | undefined;
  if (!pos) throw new HttpError(401, 'UNAUTHORIZED', '岗位不存在');
  return { token, positionId: session.position_id, positionName: pos.name, showId: session.show_id };
}

function bearerToken(req: Request): string | null {
  const h = req.header('authorization');
  if (h && h.startsWith('Bearer ')) return h.slice(7).trim();
  return null;
}

export function wrap<T extends Request>(
  handler: (req: T, res: Response) => unknown | Promise<unknown>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    try {
      Promise.resolve(handler(req as T, res)).catch(next);
    } catch (err) {
      next(err);
    }
  };
}
