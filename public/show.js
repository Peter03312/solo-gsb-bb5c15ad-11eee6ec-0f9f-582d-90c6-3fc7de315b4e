(() => {
  const { $, el, esc, api, toast, fmtTime, fmtDateTime, openWS } = window.App;

  const SESSION_KEY = 'cue_station_session';
  let session = null; // { token, positionId, positionName, showId, versionId }
  let state = null;
  let ws = null;
  let busy = false;

  /* ---------------- 登录流程 ---------------- */

  const codeInput = $('#codeInput');
  const entryBtn = $('#entryBtn');
  const stepEntry = $('#stepEntry');
  const stepLogin = $('#stepLogin');
  const positionSelect = $('#positionSelect');
  const passwordInput = $('#passwordInput');
  let entryData = null;

  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  });
  codeInput.addEventListener('keydown', (e) => e.key === 'Enter' && entryBtn.click());

  entryBtn.addEventListener('click', async () => {
    const code = codeInput.value.trim();
    if (code.length < 4) return toast('请输入完整的场次入场码', 'error');
    entryBtn.disabled = true;
    try {
      entryData = await api('POST', '/api/station/entry', { code });
      $('#showLabel').textContent = entryData.show.label;
      $('#showMeta').textContent =
        `版本 ${entryData.show.versionLabel} · ${entryData.show.status === 'completed' ? '已结束' : '进行中'} · 入场码 ${entryData.show.code}`;
      $('#showCode').textContent = entryData.show.code;
      positionSelect.innerHTML = '';
      for (const p of entryData.positions) {
        positionSelect.appendChild(el('option', { value: p.id, text: p.name }));
      }
      if (entryData.positions.length === 0) {
        positionSelect.appendChild(el('option', { value: '', text: '（该版本没有岗位）' }));
      }
      stepEntry.classList.add('hidden');
      stepLogin.classList.remove('hidden');
      passwordInput.focus();
    } catch (err) {
      toast(err.message, 'error', 5000);
    } finally {
      entryBtn.disabled = false;
    }
  });

  $('#backBtn').addEventListener('click', () => {
    stepLogin.classList.add('hidden');
    stepEntry.classList.remove('hidden');
  });

  $('#loginBtn').addEventListener('click', doLogin);
  passwordInput.addEventListener('keydown', (e) => e.key === 'Enter' && doLogin());

  async function doLogin() {
    const positionId = Number(positionSelect.value);
    const password = passwordInput.value;
    if (!positionId || !password) return toast('请选择岗位并输入口令', 'error');
    const btn = $('#loginBtn');
    btn.disabled = true;
    try {
      const res = await api('POST', '/api/station/login', {
        code: codeInput.value.trim(),
        positionId,
        password,
      });
      session = {
        token: res.token,
        positionId: res.position.id,
        positionName: res.position.name,
        showId: res.state.showId,
        versionId: res.state.versionId,
      };
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
      enterShow(res.state);
    } catch (err) {
      // 口令错误等：明确提示，不写入记录
      toast(err.message, 'error', 5000);
      passwordInput.select();
    } finally {
      btn.disabled = false;
    }
  }

  $('#logoutBtn').addEventListener('click', () => {
    if (session) api('POST', '/api/station/logout', undefined, session.token).catch(() => {});
    sessionStorage.removeItem(SESSION_KEY);
    if (ws) ws.close();
    ws = null;
    state = null;
    session = null;
    $('#showView').classList.add('hidden');
    $('#loginView').classList.remove('hidden');
    passwordInput.value = '';
    stepLogin.classList.add('hidden');
    stepEntry.classList.remove('hidden');
  });

  /* ---------------- 当场页面 ---------------- */

  function enterShow(initial) {
    $('#loginView').classList.add('hidden');
    $('#showView').classList.remove('hidden');
    state = initial;
    render();
    if (ws) ws.close();
    ws = openWS(
      session.token,
      (next) => { state = next; render(); },
      (msg) => { if (msg.message) toast(msg.message, 'info', 2200); },
    );
    ws.onStatus((s) => {
      const node = $('#wsStatus');
      node.classList.remove('connected', 'connecting');
      const map = { connected: ['connected', '实时同步中'], connecting: ['connecting', '连接中…'], disconnected: ['', '已断开，正在重连'] };
      const [cls, text] = map[s];
      if (cls) node.classList.add(cls);
      node.querySelector('span:last-child').textContent = text;
    });
  }

  async function restoreSession() {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return;
    try {
      session = JSON.parse(raw);
      const res = await api('GET', '/api/station/state', undefined, session.token);
      enterShow(res.state);
    } catch {
      sessionStorage.removeItem(SESSION_KEY);
      session = null;
    }
  }

  function render() {
    if (!state) return;
    $('#headerTitle').textContent = `${state.label} — ${session.positionName}岗`;
    const statusText = state.status === 'completed' ? '演出已结束' : '演出进行中';
    $('#headerMeta').textContent =
      `版本 ${state.versionLabel} · 开场 ${fmtDateTime(state.openedAt)} · 共 ${state.cues.length} 项 · ${statusText}`;
    $('#headerTags').innerHTML = '';
    const tags = $('#headerTags');
    tags.appendChild(el('span', { class: `tag ${state.status === 'open' ? 'hot' : 'danger'}`, text: statusText }));
    tags.appendChild(el('span', { class: 'tag', text: `入场码 ${state.code}` }));

    renderCues();
    renderEvents();
  }

  function renderCues() {
    const list = $('#cueList');
    list.innerHTML = '';
    const myName = session.positionName;

    for (const cue of state.cues) {
      const mineAssigned = cue.positionNames.includes(myName);
      const mineDone = cue.mine === true;
      const isCurrent = state.currentOrder === cue.order;
      const fullyDone = cue.completed;
      const showClosed = state.status !== 'open';

      const stateCls = fullyDone ? 'done' : isCurrent ? 'current' : 'locked';
      const card = el('div', { class: `cue ${stateCls}` });

      const head = el('div', { class: 'cue-head' });
      head.appendChild(
        el('div', { class: 'cue-title' }, [
          el('span', { class: 'cue-order', text: `#${cue.order + 1}` }),
          esc(cue.title),
        ]),
      );
      const headRight = el('div');
      if (fullyDone) headRight.appendChild(el('span', { class: 'tag ok', text: '✓ 已完成' }));
      else if (isCurrent) headRight.appendChild(el('span', { class: 'tag hot', text: '当前项' }));
      else headRight.appendChild(el('span', { class: 'tag', text: '待执行' }));
      head.appendChild(headRight);
      card.appendChild(head);

      if (cue.note) card.appendChild(el('div', { class: 'cue-note', text: cue.note }));

      const chips = el('div', { class: 'conf-chips' });
      const confByName = new Map(cue.confirmations.map((c) => [c.positionName, c]));
      for (const name of cue.positionNames) {
        const done = confByName.has(name);
        const isMe = name === myName;
        chips.appendChild(
          el(
            'span',
            { class: `chip ${done ? (isMe ? 'mine-done' : 'done') : ''}`, title: done ? `确认于 ${fmtTime(confByName.get(name).at)}` : '尚未确认' },
            `${done ? '✓' : '○'} ${esc(name)}${isMe ? '（我）' : ''}`,
          ),
        );
      }
      card.appendChild(chips);

      if (mineAssigned) {
        const foot = el('div', { class: 'cue-foot', style: 'margin-top:10px' });
        let btn;
        if (showClosed) {
          btn = el('button', { class: 'big-confirm', disabled: true, text: '演出已结束' });
        } else if (mineDone) {
          btn = el('button', { class: 'big-confirm', disabled: true, text: '✓ 本岗位已确认' });
        } else if (isCurrent) {
          btn = el('button', { class: 'big-confirm', text: '确认本项（本岗位）' });
          btn.addEventListener('click', () => doConfirm(cue, btn));
        } else {
          const reason =
            state.currentOrder !== null && cue.order > state.currentOrder
              ? `等待第 ${state.currentOrder + 1} 项完成`
              : '等待前序项目完成';
          btn = el('button', { class: 'big-confirm', disabled: true, text: reason });
        }
        foot.appendChild(el('span', { class: 'muted', text: `本项需 ${cue.positionNames.length} 个岗位确认，已确认 ${cue.confirmations.length} 个` }));
        foot.appendChild(btn);
        card.appendChild(foot);
      }

      list.appendChild(card);
    }

    if (state.status === 'completed') {
      list.appendChild(el('div', { class: 'panel', style: 'text-align:center;border-style:dashed;margin-top:6px' }, [
        el('div', { class: 'ok-text', style: 'font-weight:700;font-size:16px', text: '🎉 本场全部提示项已完成，演出结束' }),
      ]));
    }
  }

  async function doConfirm(cue, btn) {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    const oldText = btn.textContent;
    btn.textContent = '提交中…';
    try {
      const res = await api(
        'POST',
        '/api/station/confirm',
        { cueId: cue.id, versionId: state.versionId },
        session.token,
      );
      state = res.state;
      render();
      if (res.duplicate) toast(res.message || '重复提交只保留一次', 'info');
    } catch (err) {
      // 越序 / 版本不符 / 越权：明确拒绝；以服务端状态刷新页面
      toast(`已拒绝：${err.message}`, 'error', 5000);
      try {
        const res = await api('GET', '/api/station/state', undefined, session.token);
        state = res.state;
        render();
      } catch { /* ignore */ }
    } finally {
      busy = false;
      btn.disabled = false;
      btn.textContent = oldText;
    }
  }

  const EVENT_LABEL = {
    show_opened: '开场',
    confirm: '确认',
    cue_completed: '提示项完成',
    show_completed: '演出结束',
  };

  function renderEvents() {
    const box = $('#eventLog');
    box.innerHTML = '';
    const events = [...state.events].reverse();
    if (events.length === 0) {
      box.appendChild(el('div', { class: 'muted', text: '暂无事件' }));
      return;
    }
    for (const ev of events) {
      let body;
      if (ev.type === 'confirm') {
        body = el('span', {}, [
          el('strong', { text: esc(ev.positionName || '岗位') }),
          ` 确认第 ${ev.cueOrder !== null ? ev.cueOrder + 1 : '?'} 项`,
        ]);
      } else {
        body = el('span', { text: ev.detail || EVENT_LABEL[ev.type] || ev.type });
      }
      box.appendChild(
        el('div', { class: `event type-${ev.type}` }, [
          el('span', { class: 'seq', text: `#${ev.seq}` }),
          el('span', { class: 't', text: fmtTime(ev.at) }),
          el('span', { class: 'body' }, body),
        ]),
      );
    }
  }

  restoreSession();
})();
