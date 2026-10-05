(() => {
  const { $, $$, el, esc, api, toast, fmtTime, fmtDateTime, openWS } = window.App;

  const TOKEN_KEY = 'cue_director_token';
  let token = sessionStorage.getItem(TOKEN_KEY);
  let positions = [];
  let draftCues = [];
  let versions = [];
  let monitorWs = null;
  let monitoredShowId = null;

  /* ---------------- 登录 ---------------- */

  const passwordInput = $('#passwordInput');
  $('#loginBtn').addEventListener('click', login);
  passwordInput.addEventListener('keydown', (e) => e.key === 'Enter' && login());

  async function login() {
    const password = passwordInput.value;
    if (!password) return toast('请输入导演口令', 'error');
    $('#loginBtn').disabled = true;
    try {
      const res = await api('POST', '/api/director/login', { password });
      token = res.token;
      sessionStorage.setItem(TOKEN_KEY, token);
      enterApp();
    } catch (err) {
      toast(err.message, 'error', 4000);
      passwordInput.select();
    } finally {
      $('#loginBtn').disabled = false;
    }
  }

  $('#logoutBtn').addEventListener('click', async () => {
    if (monitorWs) { monitorWs.close(); monitorWs = null; }
    await api('POST', '/api/director/logout', undefined, token).catch(() => {});
    sessionStorage.removeItem(TOKEN_KEY);
    token = null;
    $('#appView').classList.add('hidden');
    $('#loginView').classList.remove('hidden');
    $('#logoutBtn').classList.add('hidden');
    passwordInput.value = '';
  });

  async function tryAutoLogin() {
    if (!token) return;
    try {
      await api('GET', '/api/director/positions', undefined, token);
      enterApp();
    } catch {
      sessionStorage.removeItem(TOKEN_KEY);
      token = null;
    }
  }

  function enterApp() {
    $('#loginView').classList.add('hidden');
    $('#appView').classList.remove('hidden');
    $('#logoutBtn').classList.remove('hidden');
    switchTab('draft');
  }

  /* ---------------- Tab 切换 ---------------- */

  const loaders = {
    draft: loadDraft,
    versions: loadVersions,
    shows: loadShows,
    positions: loadPositions,
    settings: async () => {},
  };

  $$('#tabs button').forEach((btn) =>
    btn.addEventListener('click', () => switchTab(btn.dataset.tab)),
  );

  async function switchTab(name) {
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('section[data-pane]').forEach((s) => s.classList.toggle('hidden', s.dataset.pane !== name));
    if (monitorWs && name !== 'shows') { monitorWs.close(); monitorWs = null; monitoredShowId = null; $('#wsStatus').classList.add('hidden'); }
    await loaders[name]();
  }

  /* ---------------- 岗位 ---------------- */

  async function loadPositions() {
    positions = (await api('GET', '/api/director/positions', undefined, token)).positions;
    const list = $('#positionList');
    list.innerHTML = '';
    if (positions.length === 0) list.appendChild(el('div', { class: 'muted', text: '还没有岗位，先在上方新增（如：灯光、音响、舞台监督）。' }));
    for (const p of positions) {
      const item = el('div', { class: 'list-item' }, [
        el('div', {}, [
          el('strong', { text: p.name }),
          el('div', { class: 'meta', text: `创建于 ${fmtDateTime(p.created_at)} · 标识 ${p.key.slice(0, 8)}…` }),
        ]),
        el('div', { style: 'display:flex;gap:6px' }, [
          (() => {
            const b = el('button', { class: 'btn-sm', text: '改名' });
            b.addEventListener('click', () => renamePosition(p));
            return b;
          })(),
          (() => {
            const b = el('button', { class: 'btn-sm', text: '重置口令' });
            b.addEventListener('click', () => resetPositionPassword(p));
            return b;
          })(),
        ]),
      ]);
      list.appendChild(item);
    }
    renderPositionCheckboxes();
  }

  async function renamePosition(p) {
    const name = prompt('修改岗位名称：', p.name);
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) return toast('名称不能为空', 'error');
    try {
      await api('PATCH', `/api/director/positions/${p.id}`, { name: trimmed }, token);
      toast('已改名', 'ok');
      loadPositions();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function resetPositionPassword(p) {
    const pw = prompt(`为岗位「${p.name}」设置新专属口令（≥4 位）：`);
    if (pw === null) return;
    if (pw.trim().length < 4) return toast('口令至少 4 位', 'error');
    try {
      await api('PATCH', `/api/director/positions/${p.id}`, { password: pw }, token);
      toast(`「${p.name}」口令已更新`, 'ok');
    } catch (err) { toast(err.message, 'error'); }
  }

  $('#addPosBtn').addEventListener('click', async () => {
    const name = $('#posName').value.trim();
    const password = $('#posPassword').value;
    if (!name || password.length < 4) return toast('请填写岗位名称与不少于 4 位的口令', 'error');
    try {
      await api('POST', '/api/director/positions', { name, password }, token);
      $('#posName').value = '';
      $('#posPassword').value = '';
      toast(`岗位「${name}」已创建`, 'ok');
      loadPositions();
    } catch (err) { toast(err.message, 'error'); }
  });

  function renderPositionCheckboxes(selectedIds = []) {
    const box = $('#cuePositions');
    box.innerHTML = '';
    if (positions.length === 0) {
      box.appendChild(el('span', { class: 'muted', text: '请先在“④ 岗位与口令”中创建岗位。' }));
      return;
    }
    for (const p of positions) {
      const id = `poschk_${p.id}`;
      const input = el('input', { type: 'checkbox', value: p.id, id });
      if (selectedIds.includes(p.id)) input.checked = true;
      const label = el('label', {}, [input, esc(p.name)]);
      box.appendChild(label);
    }
  }

  function selectedPositionIds() {
    return $$('#cuePositions input:checked').map((i) => Number(i.value));
  }

  /* ---------------- 草稿 ---------------- */

  async function loadDraft() {
    await Promise.all([
      positions.length ? Promise.resolve() : loadPositionsSilently(),
      (async () => { draftCues = (await api('GET', '/api/director/draft', undefined, token)).cues; })(),
    ]);
    renderDraft();
  }

  async function loadPositionsSilently() {
    positions = (await api('GET', '/api/director/positions', undefined, token)).positions;
    renderPositionCheckboxes();
  }

  function renderDraft() {
    const list = $('#draftList');
    list.innerHTML = '';
    if (draftCues.length === 0) list.appendChild(el('div', { class: 'muted', text: '草稿为空，在下方新增第一条提示项。' }));

    draftCues.forEach((cue, idx) => {
      const item = el('div', { class: 'cue', style: 'border-left-color:var(--accent-dim)' });
      const head = el('div', { class: 'cue-head' }, [
        el('div', { class: 'cue-title' }, [
          el('span', { class: 'cue-order', text: `#${idx + 1}` }),
          esc(cue.title),
        ]),
        el('div', { class: 'nowrap' }, [
          (() => {
            const b = el('button', { class: 'btn-sm btn-ghost', text: '↑', disabled: idx === 0 });
            b.addEventListener('click', () => moveCue(idx, idx - 1));
            return b;
          })(),
          (() => {
            const b = el('button', { class: 'btn-sm btn-ghost', text: '↓', disabled: idx === draftCues.length - 1 });
            b.addEventListener('click', () => moveCue(idx, idx + 1));
            return b;
          })(),
          (() => {
            const b = el('button', { class: 'btn-sm', text: '编辑' });
            b.addEventListener('click', () => editCue(cue));
            return b;
          })(),
          (() => {
            const b = el('button', { class: 'btn-sm btn-danger', text: '删除' });
            b.addEventListener('click', () => deleteCue(cue));
            return b;
          })(),
        ]),
      ]);
      item.appendChild(head);
      if (cue.note) item.appendChild(el('div', { class: 'cue-note', text: cue.note }));
      const tags = el('div', { style: 'margin-top:6px' });
      for (const p of cue.positions) tags.appendChild(el('span', { class: 'tag hot', text: p.name }));
      item.appendChild(tags);
      list.appendChild(item);
    });
  }

  async function moveCue(from, to) {
    const ids = draftCues.map((c) => c.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    try {
      await api('POST', '/api/director/draft/reorder', { orderedIds: ids }, token);
      await loadDraft();
    } catch (err) { toast(err.message, 'error'); }
  }

  $('#addCueBtn').addEventListener('click', async () => {
    const title = $('#cueTitle').value.trim();
    const note = $('#cueNote').value.trim();
    const positionIds = selectedPositionIds();
    if (!title) return toast('请填写提示内容', 'error');
    if (positionIds.length === 0) return toast('至少勾选一个岗位', 'error');
    try {
      await api('POST', '/api/director/draft/cues', { title, note, positionIds }, token);
      $('#cueTitle').value = '';
      $('#cueNote').value = '';
      $$('#cuePositions input:checked').forEach((i) => (i.checked = false));
      toast('已追加到草稿', 'ok');
      loadDraft();
    } catch (err) { toast(err.message, 'error'); }
  });

  async function editCue(cue) {
    const title = prompt('提示内容：', cue.title);
    if (title === null) return;
    const note = prompt('备注（可留空）：', cue.note ?? '') ?? cue.note;
    // 岗位选择用 confirm 风格不够用，这里给出简单多选：浏览器 prompt 不支持多选，
    // 故用页内 checkbox 弹层
    const positionIds = await choosePositions(cue.positions.map((p) => p.id));
    if (positionIds === null) return;
    try {
      await api('PATCH', `/api/director/draft/cues/${cue.id}`, { title: title.trim(), note, positionIds }, token);
      toast('已保存（仅影响草稿，不影响已开场演出）', 'ok');
      loadDraft();
    } catch (err) { toast(err.message, 'error'); }
  }

  // 简易岗位多选弹层
  function choosePositions(initial = []) {
    return new Promise((resolve) => {
      const wrap = el('div', {
        style: 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:500;display:flex;align-items:center;justify-content:center',
      });
      const panel = el('div', { class: 'panel', style: 'width:min(90vw,420px);margin:0' });
      panel.appendChild(el('h2', { text: '指定岗位（至少一个）' }));
      const box = el('div', { class: 'checkbox-row' });
      const checks = [];
      for (const p of positions) {
        const input = el('input', { type: 'checkbox' });
        if (initial.includes(p.id)) input.checked = true;
        checks.push(input);
        box.appendChild(el('label', {}, [input, esc(p.name)]));
      }
      panel.appendChild(box);
      const btns = el('div', { class: 'row', style: 'margin-top:16px;justify-content:flex-end' });
      const cancel = el('button', { text: '取消' });
      const ok = el('button', { class: 'btn-primary', text: '确定' });
      cancel.addEventListener('click', () => { wrap.remove(); resolve(null); });
      ok.addEventListener('click', () => {
        const ids = checks.map((c, i) => (c.checked ? positions[i].id : null)).filter((v) => v !== null);
        if (ids.length === 0) return toast('至少勾选一个岗位', 'error');
        wrap.remove();
        resolve(ids);
      });
      btns.append(cancel, ok);
      panel.appendChild(btns);
      wrap.appendChild(panel);
      wrap.addEventListener('click', (e) => { if (e.target === wrap) { wrap.remove(); resolve(null); } });
      document.body.appendChild(wrap);
    });
  }

  async function deleteCue(cue) {
    if (!confirm(`删除第 ${draftCues.indexOf(cue) + 1} 项「${cue.title}」？仅影响草稿。`)) return;
    try {
      await api('DELETE', `/api/director/draft/cues/${cue.id}`, undefined, token);
      toast('已删除', 'ok');
      loadDraft();
    } catch (err) { toast(err.message, 'error'); }
  }

  /* ---------------- 版本 ---------------- */

  async function loadVersions() {
    versions = (await api('GET', '/api/director/versions', undefined, token)).versions;
    renderVersions();
  }

  function renderVersions() {
    const list = $('#versionList');
    list.innerHTML = '';
    if (versions.length === 0) list.appendChild(el('div', { class: 'muted', text: '还没有发布版本。' }));
    for (const v of versions) {
      const item = el('div', { class: 'panel', style: 'margin:0 0 10px' });
      const head = el('div', { class: 'cue-head' }, [
        el('div', {}, [
          el('strong', { style: 'font-size:16px', text: v.label }),
          el('span', { class: 'meta muted', style: 'margin-left:10px', text: `发布于 ${fmtDateTime(v.createdAt)}${v.note ? ` · ${v.note}` : ''}` }),
        ]),
        el('div', {}, v.usedByShow
          ? el('span', { class: 'tag', text: '已被场次选用（永久保留）' })
          : el('span', { class: 'tag ok', text: '可用于开场' })),
      ]);
      item.appendChild(head);
      const ol = el('div', { class: 'cue-list', style: 'margin-top:10px' });
      v.cues.forEach((c) => {
        ol.appendChild(el('div', { class: 'cue locked' }, [
          el('div', { class: 'cue-head' }, [
            el('div', { class: 'cue-title' }, [el('span', { class: 'cue-order', text: `#${c.order + 1}` }), esc(c.title)]),
          ]),
          c.note ? el('div', { class: 'cue-note', text: c.note }) : null,
          el('div', { style: 'margin-top:4px' }, c.positionNames.map((n) => el('span', { class: 'tag', text: n }))),
        ]));
      });
      item.appendChild(ol);
      list.appendChild(item);
    }
  }

  $('#publishBtn').addEventListener('click', async () => {
    if (!confirm('将当前草稿发布为新的不可变版本？发布后该版本不能修改。')) return;
    try {
      const res = await api('POST', '/api/director/versions', { note: $('#versionNote').value.trim() }, token);
      $('#versionNote').value = '';
      toast(`已发布 ${res.label}`, 'ok');
      loadVersions();
    } catch (err) { toast(err.message, 'error', 4000); }
  });

  /* ---------------- 场次 ---------------- */

  async function loadShows() {
    const [vers, data] = await Promise.all([
      api('GET', '/api/director/versions', undefined, token),
      api('GET', '/api/director/shows', undefined, token),
    ]);
    versions = vers.versions;
    const sel = $('#openVersionSelect');
    sel.innerHTML = '';
    if (versions.length === 0) {
      sel.appendChild(el('option', { value: '', text: '（请先到“版本发布”发布一个版本）' }));
    }
    for (const v of versions) {
      sel.appendChild(el('option', { value: v.id, text: `${v.label}（${v.cues.length} 项 · ${fmtDateTime(v.createdAt)}）` }));
    }

    const list = $('#showsList');
    list.innerHTML = '';
    if (data.shows.length === 0) {
      list.appendChild(el('div', { class: 'panel muted', text: '还没有开场的演出。' }));
    }
    for (const s of data.shows) list.appendChild(renderShowCard(s));
  }

  function renderShowCard(s) {
    const card = el('div', { class: 'panel' });
    const head = el('div', { class: 'cue-head' });
    head.appendChild(el('div', {}, [
      el('strong', { style: 'font-size:16px' }, [
        el('span', { class: `status-dot ${s.status === 'open' ? 'open' : 'closed'}` }),
        document.createTextNode(s.label),
      ]),
      el('div', { class: 'meta muted', text: `版本 ${s.version_label} · 开场 ${fmtDateTime(s.opened_at)}${s.closed_at ? ` · 结束 ${fmtTime(s.closed_at)}` : ''}` }),
    ]));
    head.appendChild(el('div', { style: 'display:flex;align-items:center;gap:12px;flex-wrap:wrap' }, [
      el('div', { style: 'text-align:center' }, [
        el('div', { class: 'meta muted', text: '入场码（发给岗位）' }),
        el('div', { class: 'code-box', text: s.code }),
      ]),
      (() => {
        const watching = monitoredShowId === s.id;
        const b = el('button', { class: watching ? 'btn-danger' : '', text: watching ? '停止监视' : '📡 监视现场' });
        b.addEventListener('click', () => (watching ? stopMonitor() : startMonitor(s.id)));
        return b;
      })(),
    ]));
    card.appendChild(head);
    const live = el('div', { id: `monitor_${s.id}`, style: 'margin-top:0' });
    card.appendChild(live);
    return card;
  }

  async function startMonitor(showId) {
    stopMonitor(false);
    const host = $(`#monitor_${showId}`);
    host.innerHTML = '<div class="muted" style="padding:10px">正在接入现场数据…</div>';
    try {
      const initial = await api('GET', `/api/director/shows/${showId}/state`, undefined, token);
      const res = await api('POST', `/api/director/shows/${showId}/monitor`, undefined, token);
      monitoredShowId = showId;
      renderMonitorState(initial.state);
      monitorWs = openWS(res.token, (st) => renderMonitorState(st));
      $('#wsStatus').classList.remove('hidden');
      monitorWs.onStatus((s) => {
        const node = $('#wsStatus');
        node.classList.remove('connected', 'connecting');
        const map = { connected: ['connected', '现场实时同步中'], connecting: ['connecting', '连接中…'], disconnected: ['', '现场连接断开，重连中'] };
        const [cls, text] = map[s];
        if (cls) node.classList.add(cls);
        node.querySelector('span:last-child').textContent = text;
      });
    } catch (err) {
      toast(err.message, 'error');
      host.innerHTML = '';
    }
  }

  function stopMonitor(redraw = true) {
    if (monitorWs) { monitorWs.close(); monitorWs = null; }
    monitoredShowId = null;
    $('#wsStatus').classList.add('hidden');
    if (redraw) loadShows();
  }

  function renderMonitorState(st) {
    const host = $(`#monitor_${st.showId}`);
    if (!host) return;
    host.innerHTML = '';
    const grid = el('div', { class: 'grid-2', style: 'margin-top:12px' });

    const cuePanel = el('div', { style: 'min-width:0' });
    cuePanel.appendChild(el('h3', { class: 'section-label', text: `岗位确认情况（当前第 ${st.currentOrder === null ? '—' : st.currentOrder + 1} 项）` }));
    const list = el('div', { class: 'cue-list' });
    for (const cue of st.cues) {
      const cls = cue.completed ? 'done' : st.currentOrder === cue.order ? 'current' : 'locked';
      const card = el('div', { class: `cue ${cls}` });
      card.appendChild(el('div', { class: 'cue-head' }, [
        el('div', { class: 'cue-title' }, [el('span', { class: 'cue-order', text: `#${cue.order + 1}` }), esc(cue.title)]),
        el('div', {}, cue.completed
          ? el('span', { class: 'tag ok', text: '✓ 全员完成' })
          : st.currentOrder === cue.order
            ? el('span', { class: 'tag hot', text: '执行中' })
            : el('span', { class: 'tag', text: '等待' })),
      ]));
      const chips = el('div', { class: 'conf-chips', style: 'margin-top:6px' });
      const done = new Map(cue.confirmations.map((c) => [c.positionName, c]));
      for (const name of cue.positionNames) {
        const c = done.get(name);
        chips.appendChild(el('span', { class: `chip ${c ? 'done' : ''}`, title: c ? fmtTime(c.at) : '未确认' },
          `${c ? '✓' : '○'} ${esc(name)}${c ? ` ${fmtTime(c.at)}` : ''}`));
      }
      card.appendChild(chips);
      list.appendChild(card);
    }
    cuePanel.appendChild(list);

    const eventPanel = el('div');
    eventPanel.appendChild(el('h3', { class: 'section-label', text: '事件顺序（服务端编号）' }));
    const log = el('div', { class: 'event-log', style: 'max-height:420px' });
    for (const ev of [...st.events].reverse()) {
      const body = ev.type === 'confirm'
        ? el('span', {}, [el('strong', { text: esc(ev.positionName || '岗位') }), ` 确认第 ${ev.cueOrder !== null ? ev.cueOrder + 1 : '?'} 项`])
        : el('span', { text: ev.detail });
      log.appendChild(el('div', { class: `event type-${ev.type}` }, [
        el('span', { class: 'seq', text: `#${ev.seq}` }),
        el('span', { class: 't', text: fmtTime(ev.at) }),
        el('span', { class: 'body' }, body),
      ]));
    }
    eventPanel.appendChild(log);

    grid.append(cuePanel, eventPanel);
    host.appendChild(grid);
  }

  $('#openShowBtn').addEventListener('click', async () => {
    const versionId = Number($('#openVersionSelect').value);
    if (!versionId) return toast('请先发布并选择一个版本', 'error');
    const label = $('#openShowLabel').value.trim();
    try {
      const res = await api('POST', '/api/director/shows', { versionId, label }, token);
      $('#openShowLabel').value = '';
      toast(`已开场，入场码：${res.code}（请发给各岗位）`, 'ok', 6000);
      loadShows();
    } catch (err) { toast(err.message, 'error'); }
  });

  /* ---------------- 设置 ---------------- */

  $('#changePwdBtn').addEventListener('click', async () => {
    const pw = $('#newDirectorPassword').value;
    if (pw.length < 4) return toast('新口令至少 4 位', 'error');
    try {
      await api('POST', '/api/director/change-password', { password: pw }, token);
      $('#newDirectorPassword').value = '';
      toast('导演口令已更新', 'ok');
    } catch (err) { toast(err.message, 'error'); }
  });

  tryAutoLogin();
})();
