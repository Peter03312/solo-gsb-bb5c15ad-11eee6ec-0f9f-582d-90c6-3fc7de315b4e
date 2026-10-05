import WebSocket from "ws";
// 端到端冒烟测试：通过 HTTP API 验证全部业务规则
const BASE = 'http://localhost:8080';
let pass = 0, fail = 0;

function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}
async function call(method, path, body, token, expectStatus) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  if (expectStatus !== undefined && res.status !== expectStatus) {
    throw new Error(`${method} ${path} 期望 ${expectStatus} 实际 ${res.status}: ${JSON.stringify(data)}`);
  }
  return { status: res.status, data };
}

(async () => {
  console.log('— 健康检查与静态资源 —');
  ok('GET /api/health', (await call('GET', '/api/health')).status === 200);
  const home = await fetch(BASE + '/');
  ok('GET / 首页 200', home.status === 200);
  ok('静态 app.js 可访问', (await fetch(BASE + '/app.js')).status === 200);

  console.log('— 导演登录 —');
  const bad = await call('POST', '/api/director/login', { password: 'wrong' }, null, 401);
  ok('错误导演口令被拒(401)', bad.data.error.code === 'BAD_PASSWORD');
  const dir = await call('POST', '/api/director/login', { password: 'dir1234' }, null, 200);
  const DT = dir.data.token;
  ok('正确导演口令登录', !!DT);
  const unauth = await call('GET', '/api/director/positions', null, null, 401);
  ok('无令牌访问被拒', unauth.data.error.code === 'UNAUTHORIZED');

  console.log('— 岗位管理 —');
  await call('POST', '/api/director/positions', { name: '灯光', password: 'light-pw' }, DT, 201);
  await call('POST', '/api/director/positions', { name: '音响', password: 'sound-pw' }, DT, 201);
  await call('POST', '/api/director/positions', { name: '舞台监督', password: 'sm-pw' }, DT, 201);
  const dup = await call('POST', '/api/director/positions', { name: '灯光', password: 'aaaa' }, DT, 409);
  ok('岗位重名被拒', dup.data.error.code === 'DUP_NAME');
  let positions = (await call('GET', '/api/director/positions', null, DT, 200)).data.positions;
  ok('岗位数量=3', positions.length === 3, positions.length);
  const P = Object.fromEntries(positions.map((p) => [p.name, p]));
  const shortPw = await call('POST', '/api/director/positions', { name: 'x', password: '1' }, DT, 400);
  ok('过短口令被拒', shortPw.status === 400);

  console.log('— 草稿编辑 —');
  const noPos = await call('POST', '/api/director/draft/cues', { title: '无岗位项', positionIds: [] }, DT, 400);
  ok('无岗位提示项被拒', noPos.data.error.code === 'NO_POSITION');
  const c1 = await call('POST', '/api/director/draft/cues', {
    title: '开场钟声', note: '三声长钟', positionIds: [P['舞台监督'].id],
  }, DT, 201);
  const c2 = await call('POST', '/api/director/draft/cues', {
    title: '灯光暗转+雷雨音效', note: '', positionIds: [P['灯光'].id, P['音响'].id],
  }, DT, 201);
  const c3 = await call('POST', '/api/director/draft/cues', {
    title: '谢幕灯光', note: '暖光全起', positionIds: [P['灯光'].id, P['舞台监督'].id],
  }, DT, 201);
  ok('草稿新增三条', c1.data.order === 0 && c2.data.order === 1 && c3.data.order === 2);

  // 重排：把 c3 移到 c1 前
  await call('POST', '/api/director/draft/reorder', { orderedIds: [c3.data.id, c1.data.id, c2.data.id] }, DT, 200);
  let draft = (await call('GET', '/api/director/draft', null, DT)).data.cues;
  ok('重排生效', draft[0].id === c3.data.id && draft[0].order === 0);
  // 排回去
  await call('POST', '/api/director/draft/reorder', { orderedIds: [c1.data.id, c2.data.id, c3.data.id] }, DT, 200);

  console.log('— 发布版本 v1（不可变快照） —');
  const v1 = await call('POST', '/api/director/versions', { note: '首映版' }, DT, 201);
  ok('v1 发布', v1.data.label === 'v1');

  console.log('— 发布后继续改草稿并发布 v2 —');
  // 改 c1 内容 + 删除 c3，不影响 v1
  await call('PATCH', `/api/director/draft/cues/${c1.data.id}`, {
    title: '开场钟声（修订）', note: '两声', positionIds: [P['音响'].id],
  }, DT, 200);
  await call('DELETE', `/api/director/draft/cues/${c3.data.id}`, undefined, DT, 200);
  const v2 = await call('POST', '/api/director/versions', { note: '草稿修订版' }, DT, 201);
  const versions = (await call('GET', '/api/director/versions', null, DT)).data.versions;
  const v1Data = versions.find((v) => v.id === v1.data.id);
  ok('v1 保持不可变（3 项、原标题、原岗位快照）',
    v1Data.cues.length === 3 &&
    v1Data.cues[0].title === '开场钟声' &&
    v1Data.cues[0].positionNames.includes('舞台监督') &&
    v1Data.cues[1].positionNames.length === 2,
    JSON.stringify(v1Data.cues.map((c) => [c.title, c.positionNames])));
  const v2Data = versions.find((v) => v.id === v2.data.id);
  ok('v2 反映新草稿（2 项）', v2Data.cues.length === 2 && v2Data.cues[0].title === '开场钟声（修订）');

  console.log('— 开场：选定 v1 —');
  const opened = await call('POST', '/api/director/shows', { versionId: v1.data.id, label: '10月5日晚场' }, DT, 201);
  ok('开场返回入场码', /^[A-Z0-9]{6}$/.test(opened.data.code), opened.data.code);
  const code = opened.data.code;
  const showId = opened.data.id;

  console.log('— 岗位入场与登录拒绝场景 —');
  const noEntry = await call('POST', '/api/station/entry', { code: 'BADCOD' }, null, 404);
  ok('错误入场码被拒', noEntry.data.error.code === 'SHOW_NOT_FOUND');
  const entry = (await call('POST', '/api/station/entry', { code }, null, 200)).data;
  ok('入场返回 3 个岗位', entry.positions.length === 3);

  const badPw = await call('POST', '/api/station/login', {
    code, positionId: P['灯光'].id, password: 'WRONG',
  }, null, 401);
  ok('错误岗位口令被拒(401)', badPw.data.error.code === 'BAD_PASSWORD');

  console.log('— 岗位正常登录 —');
  const loginLight = await call('POST', '/api/station/login', {
    code, positionId: P['灯光'].id, password: 'light-pw',
  }, null, 200);
  const LT = loginLight.data.token;
  ok('灯光登录并取得状态', loginLight.data.state.versionId === v1.data.id);
  const loginSound = await call('POST', '/api/station/login', {
    code, positionId: P['音响'].id, password: 'sound-pw',
  }, null, 200);
  const ST = loginSound.data.token;
  const loginSM = await call('POST', '/api/station/login', {
    code, positionId: P['舞台监督'].id, password: 'sm-pw',
  }, null, 200);
  const MT = loginSM.data.token;

  // v1 快照 id
  const v1cues = v1Data.cues; // order 0..2
  const cue0 = v1cues[0], cue1 = v1cues[1], cue2 = v1cues[2];

  console.log('— 顺序互锁：未完成第一项时抢确认第二项 —');
  const jump = await call('POST', '/api/station/confirm', { cueId: cue1.id, versionId: v1.data.id }, LT, 409);
  ok('越序确认被拒(OUT_OF_ORDER)', jump.data.error.code === 'OUT_OF_ORDER', jump.data.error.message);

  console.log('— 越权：音响确认未分配的第 1 项 —');
  const notAssigned = await call('POST', '/api/station/confirm', { cueId: cue0.id, versionId: v1.data.id }, ST, 403);
  ok('非本岗位提示项被拒(NOT_ASSIGNED)', notAssigned.data.error.code === 'NOT_ASSIGNED');

  console.log('— 版本不符：用 v2 的 cueId 向 v1 场次提交 —');
  const v2CueId = v2Data.cues[0].id;
  const mismatchId = await call('POST', '/api/station/confirm', { cueId: v2CueId, versionId: v2.data.id }, ST, 409);
  ok('提交版本与场次不符被拒(VERSION_MISMATCH)', mismatchId.data.error.code === 'VERSION_MISMATCH');
  const mismatchParam = await call('POST', '/api/station/confirm', { cueId: cue0.id, versionId: v2.data.id }, MT, 409);
  ok('显式 versionId 不符被拒', mismatchParam.data.error.code === 'VERSION_MISMATCH');

  console.log('— 正常流程：第 1 项（仅舞台监督）—');
  const conf1 = await call('POST', '/api/station/confirm', { cueId: cue0.id, versionId: v1.data.id }, MT, 201);
  ok('舞台监督确认第1项', conf1.data.state.cues[0].completed === true);
  // 重复提交
  const dup1 = await call('POST', '/api/station/confirm', { cueId: cue0.id, versionId: v1.data.id }, MT, 200);
  ok('重复提交幂等(duplicate=true)', dup1.data.duplicate === true);
  const stateAfterDup = (await call('GET', '/api/station/state', null, MT)).data.state;
  const confCountCue0 = stateAfterDup.cues[0].confirmations.length;
  ok('重复确认只保留一次（确认记录仍为 1）', confCountCue0 === 1, `实际 ${confCountCue0}`);

  console.log('— 第 2 项：灯光、音响均需确认；缺一不可 —');
  const confLight2 = await call('POST', '/api/station/confirm', { cueId: cue1.id, versionId: v1.data.id }, LT, 201);
  const cue1AfterLight = confLight2.data.state.cues[1];
  ok('仅灯光确认时第2项未完成', cue1AfterLight.completed === false && cue1AfterLight.confirmations.length === 1);

  // 此时第 3 项仍锁定
  const jump3 = await call('POST', '/api/station/confirm', { cueId: cue2.id, versionId: v1.data.id }, LT, 409);
  ok('第2项未完成时第3项仍锁定', jump3.data.error.code === 'OUT_OF_ORDER');

  const confSound2 = await call('POST', '/api/station/confirm', { cueId: cue1.id, versionId: v1.data.id }, ST, 201);
  ok("音响确认后第2项完成", confSound2.data.state.cues[1].completed === true);

  console.log('— 第 3 项：灯光 + 舞台监督，完成后整场结束 —');
  await call('POST', '/api/station/confirm', { cueId: cue2.id, versionId: v1.data.id }, LT, 201);
  const smView = await call('GET', '/api/station/state', null, MT);
  ok('第3项仅灯光确认时未完成', smView.data.state.cues[2].completed === false);
  const final = await call('POST', '/api/station/confirm', { cueId: cue2.id, versionId: v1.data.id }, MT, 201);
  ok("全部完成后演出状态=completed", final.data.state.status === "completed");

  // 结束后再确认
  const afterEnd = await call('POST', '/api/station/confirm', { cueId: cue0.id, versionId: v1.data.id }, ST, 409);
  ok('演出结束后确认被拒(SHOW_CLOSED)', afterEnd.data.error.code === 'SHOW_CLOSED');

  console.log('— 服务端事件顺序 —');
  const mon = await call('POST', `/api/director/shows/${showId}/monitor`, null, DT, 200);
  const monState = (await call('GET', `/api/director/shows/${showId}/state`, null, DT)).data.state;
  const types = monState.events.map((e) => e.type);
  ok('事件链完整且连续编号',
    types[0] === 'show_opened' &&
    types.includes('confirm') &&
    types.includes('cue_completed') &&
    types[types.length - 1] === 'show_completed' &&
    monState.events.every((e, i) => e.seq === i + 1),
    JSON.stringify(types));

  // 确认事件严格按提交顺序编号（舞台监督#1 → 灯光#2 → 音响#2 → 灯光#3 → 舞台监督#3）
  const confirms = monState.events.filter((e) => e.type === 'confirm').map((e) => `${e.positionName}:${e.cueOrder + 1}`);
  const expected = ['舞台监督:1', '灯光:2', '音响:2', '灯光:3', '舞台监督:3'];
  ok('确认事件顺序为服务端提交顺序', JSON.stringify(confirms) === JSON.stringify(expected), JSON.stringify(confirms));

  // 每个岗位视角只能看到自己的 mine 标记
  const lightState = (await call('GET', '/api/station/state', null, LT)).data.state;
  const myConfirms = lightState.cues.filter((c) => c.mine === true);
  ok('灯光视角 mine=true 恰为其确认的两项', myConfirms.length === 2 && myConfirms.every((c) => [1, 2].includes(c.order)));

  // 拒绝未写库：确认总数恰好 5
  const totalConf = monState.cues.reduce((n, c) => n + c.confirmations.length, 0);
  ok('所有拒绝请求均未写入记录（总确认=5）', totalConf === 5, `实际 ${totalConf}`);

  console.log('— 场次列表/重命名不影响已开场版本 —');
  const shows = (await call('GET', '/api/director/shows', null, DT)).data.shows;
  ok('场次列表含该场且已 completed', shows.some((s) => s.id === showId && s.status === 'completed'));
  await call('PATCH', `/api/director/positions/${P['灯光'].id}`, { name: '灯光师' }, DT, 200);
  const stateAfterRename = (await call('GET', `/api/director/shows/${showId}/state`, null, DT)).data.state;
  ok('已开场版本岗位名快照不变（仍为“灯光”）',
    stateAfterRename.cues.some((c) => c.positionNames.includes('灯光')) &&
    !stateAfterRename.cues.some((c) => c.positionNames.includes('灯光师')));

  console.log('— WebSocket 实时通道 —');
  const wsClose = await new Promise((resolve) => {
    const ws = new WebSocket('ws://localhost:8080/ws?token=garbage');
    ws.on('close', (code) => resolve(code));
    ws.on('error', () => {});
    setTimeout(() => resolve(0), 3000);
  });
  ok('无效 token 的 WS 被关闭(4401)', wsClose === 4401, `code=${wsClose}`);

  // 新开场一场，用岗位 WS 验证：连接即收权威状态，他人确认后收到广播
  const show2 = await call('POST', '/api/director/shows', { versionId: v1.data.id, label: 'WS测试场' }, DT, 201);
  const loginW = await call('POST', '/api/station/login', {
    code: show2.data.code, positionId: P['舞台监督'].id, password: 'sm-pw',
  }, null, 200);
  const wsLive = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:8080/ws?token=${loginW.data.token}`);
    let gotInitial = false;
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'state' && !gotInitial) {
        gotInitial = true;
        resolve({ ws, state: msg.state });
      } else if (msg.type === 'state') {
        ws.__latest = msg.state;
      }
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WS 初始状态超时')), 3000);
  });
  ok('WS 连接即收到服务端权威状态', wsLive.state.showId === show2.data.id && wsLive.state.events[0].type === 'show_opened');

  // 另一会话完成第一项（舞台监督只有这一个岗位在 cue1），验证广播到达
  await call('POST', '/api/station/confirm', { cueId: v1Data.cues[0].id, versionId: v1.data.id }, loginW.data.token, 201);
  await new Promise((r) => setTimeout(r, 500));
  ok('WS 广播了他人/本人操作后的最新状态', wsLive.ws.__latest && wsLive.ws.__latest.cues[0].completed === true);
  wsLive.ws.close();

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
