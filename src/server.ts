import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { getDb } from './db.js';
import { HttpError } from './http-helpers.js';
import { stationRouter } from './routes-station.js';
import { directorRouter } from './routes-director.js';
import { initRealtime } from './realtime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: '256kb' }));

// 安全响应头（本地部署也保持最小集）
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, at: Date.now() });
});

app.use('/api/station', stationRouter);
app.use('/api/director', directorRouter);

// 静态前端
const publicDir = path.resolve(__dirname, '..', 'public');
app.use(express.static(publicDir));

// 非 API 路由回退到入口页（便于 /director、/show 直达）
app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// 统一错误处理：明确拒绝，不写库
app.use(
  (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    // 预期外错误只记录服务端日志，不透出堆栈
    console.error('[unhandled]', err);
    res.status(500).json({ error: { code: 'INTERNAL', message: '服务器内部错误' } });
  },
);

// 初始化数据库后启动
getDb();

const server = http.createServer(app);
initRealtime(server);

server.listen(config.port, config.host, () => {
  console.log(`小剧场提示单已启动: http://localhost:${config.port}`);
  console.log(`  导演台:  /director.html`);
  console.log(`  岗位端:  /show.html`);
  console.log(`  数据库:  ${config.dbPath}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`\n收到 ${sig}，正在退出…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
