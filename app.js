(() => {
  'use strict';

  // =========================================================================
  // À MODIFIER : URL de l'application web Apps Script (Déployer → Application web → URL …/exec)
  // =========================================================================
  const API_URL = 'https://script.google.com/macros/s/AKfycbytspFtRz2ZdoM53m-56cvmcDTj-fIn1qRxHolEDV4w3lE_40nxdOkpr0TmTnVP_3c/exec';

  const BLOCK_COPY = true;   // false = la copie fonctionne mais reste journalisée silencieusement
  const CATEGORY_LABELS = { dotnet: '.NET / C#', angular: 'Angular / TypeScript', sql: 'SQL', archi: 'Architecture' };

  const state = {
    config: { fastSeconds: 5, slowSeconds: 30, prepSeconds: 3, minWidth: 1024 },
    sessionId: null,
    total: 0,
    status: 'idle',          // idle | prep | running | paused | finished
    question: null,          // question currently displayed
    pending: null,           // promise of the next question (prefetched during "Get ready")
    selected: [],
    timerHandle: null,
    prepHandle: null,
    deadline: 0,             // local timestamp (ms) at which the current question closes
    submitting: false,
    burstLogged: false,
    lastSelectionLogged: '',
    lastFullscreenChange: 0,
    devtoolsLogged: false,
    keystrokes: [],
  };

  const $ = (id) => document.getElementById(id);
  const screens = ['screen-mobile', 'screen-intro', 'screen-prep', 'screen-question', 'screen-result'];
  const show = (id) => screens.forEach((s) => $(s).classList.toggle('hidden', s !== id));

  // -------------------------------------------------------------------------
  // API (Apps Script : POST en text/plain pour éviter le pré-vol CORS, redirection suivie)
  // -------------------------------------------------------------------------
  async function api(action, payload, opts) {
    const res = await fetch(API_URL, {
      method: 'POST',
      redirect: 'follow',
      keepalive: !!(opts && opts.keepalive),
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ action }, payload || {})),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data && data.error) throw new Error(data.error);
    return data;
  }

  function incident(type, detail) {
    if (!state.sessionId) return Promise.resolve();
    return api('incident', {
      sessionId: state.sessionId, type,
      detail: detail == null ? null : String(detail).slice(0, 300),
      questionIndex: state.question ? state.question.index : null,
    }, { keepalive: true }).catch(() => { /* never block the test on monitoring */ });
  }

  // -------------------------------------------------------------------------
  // Device checks
  // -------------------------------------------------------------------------
  function isMobileDevice() {
    const uaMobile = navigator.userAgentData && navigator.userAgentData.mobile === true;
    const coarse = window.matchMedia('(pointer: coarse) and (hover: none)').matches;
    const small = Math.min(screen.width, screen.height) < 768;
    const ua = /Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(navigator.userAgent);
    return uaMobile || coarse || small || ua;
  }

  function screenInfo() {
    return JSON.stringify({
      sw: screen.width, sh: screen.height, iw: innerWidth, ih: innerHeight,
      dpr: devicePixelRatio, ext: !!screen.isExtended,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone, lang: navigator.language,
      platform: (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform,
    });
  }

  // -------------------------------------------------------------------------
  // Init
  // -------------------------------------------------------------------------
  async function init() {
    if (isMobileDevice()) { show('screen-mobile'); return; }
    show('screen-intro');
    $('form-intro').addEventListener('submit', startTest);
    $('btn-fullscreen').addEventListener('click', resumeFullscreen);
    $('btn-submit').addEventListener('click', () => submit(false));

    try {   // also warms the script up while the candidate reads the rules
      const cfg = await api('config');
      state.config = cfg;
      $('intro-fast').textContent = cfg.fastSeconds;
      $('intro-slow').textContent = cfg.slowSeconds;
    } catch (_) { /* defaults */ }

    const saved = sessionStorage.getItem('tt_session');   // refresh in the middle of a test
    if (saved) {
      try {
        const s = JSON.parse(saved);
        state.sessionId = s.id; state.total = s.total;
        await incident('reload', 'page reloaded during the test');
        state.status = 'paused';
        $('screen-fullscreen').classList.remove('hidden');
      } catch (_) { sessionStorage.removeItem('tt_session'); }
    }
  }

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------
  async function startTest(e) {
    e.preventDefault();
    const err = $('intro-error');
    err.classList.add('hidden');
    if (innerWidth < state.config.minWidth) {
      err.textContent = `Please maximise your browser window (minimum width ${state.config.minWidth} px) before starting.`;
      err.classList.remove('hidden'); return;
    }
    if (!document.documentElement.requestFullscreen) {
      err.textContent = 'Your browser does not support fullscreen mode. Please use a recent version of Chrome, Edge or Firefox.';
      err.classList.remove('hidden'); return;
    }
    $('btn-start').disabled = true;
    try {
      await document.documentElement.requestFullscreen();   // must be triggered by the click
      const created = await api('create', {
        firstName: $('firstName').value, lastName: $('lastName').value, company: $('company').value,
        userAgent: navigator.userAgent, screenInfo: screenInfo(),
      });
      state.sessionId = created.sessionId;
      state.total = created.total;
      sessionStorage.setItem('tt_session', JSON.stringify({ id: created.sessionId, total: created.total }));
      installMonitoring();
      if (screen.isExtended) incident('multi_screen', 'more than one screen detected');
      prep(0, api('current', { sessionId: state.sessionId }));
    } catch (ex) {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      err.textContent = 'Could not start: ' + (ex.message || ex);
      err.classList.remove('hidden');
      $('btn-start').disabled = false;
    }
  }

  // -------------------------------------------------------------------------
  // "Get ready" : le compte à rebours tourne pendant que la question suivante se charge
  // -------------------------------------------------------------------------
  function prep(index, pendingPromise) {
    state.status = 'prep';
    state.question = null;
    stopTimer();
    show('screen-prep');
    $('prep-badge').textContent = `Question ${index + 1} / ${state.total}`;
    $('prep-title').textContent = index === 0 ? 'Get ready…' : 'Next question…';

    let next = null, revealAt = Date.now() + (state.config.prepSeconds || 3) * 1000;
    state.pending = pendingPromise.then((cur) => {
      if (cur.finished) { next = { finished: true }; return; }
      next = cur;
      // The server deadline includes the "Get ready" time: reveal so that the candidate keeps the full answering time
      state.deadline = Date.now() + cur.question.secondsRemaining * 1000;
      revealAt = Math.min(revealAt, state.deadline - cur.question.seconds * 1000);
    }).catch(() => { next = { retry: true }; });

    clearInterval(state.prepHandle);
    state.prepHandle = setInterval(() => {
      if (state.status !== 'prep') { clearInterval(state.prepHandle); return; }
      const left = Math.max(0, Math.ceil((revealAt - Date.now()) / 1000));
      $('prep-count').textContent = next ? left : (left || '…');
      if (!next || Date.now() < revealAt) return;
      clearInterval(state.prepHandle);
      if (next.finished) showResult();
      else if (next.retry) prep(index, api('current', { sessionId: state.sessionId }));   // network hiccup: retry
      else renderQuestion(next.question);
    }, 100);
  }

  // -------------------------------------------------------------------------
  // Question rendering
  // -------------------------------------------------------------------------
  function renderQuestion(q) {
    state.status = 'running';
    state.question = q;
    state.selected = [];
    state.submitting = false;
    state.burstLogged = false;
    state.keystrokes = [];

    show('screen-question');
    $('q-progress').textContent = `Question ${q.index + 1} / ${q.total}`;
    $('q-category').textContent = CATEGORY_LABELS[q.category] || q.category;
    const speed = $('q-speed');
    speed.textContent = (q.speed === 'fast' ? 'QUICK · ' : 'THINK · ') + q.seconds + ' s';
    speed.className = 'badge speed ' + q.speed;
    $('q-text').textContent = q.text;

    const code = $('q-code');
    if (q.code) { code.textContent = q.code; code.classList.remove('hidden'); } else { code.classList.add('hidden'); }

    const box = $('q-options'), textWrap = $('q-textwrap');
    box.innerHTML = '';
    if (q.type === 'text') {
      box.classList.add('hidden');
      textWrap.classList.remove('hidden');
      const input = $('q-input');
      input.value = '';
      $('q-hint').textContent = 'Type your answer, then press Enter or Submit.';
      setTimeout(() => input.focus(), 50);
    } else {
      textWrap.classList.add('hidden');
      box.classList.remove('hidden');
      q.options.forEach((opt, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'option';
        b.dataset.id = opt.id;
        b.innerHTML = `<span class="key">${i + 1}</span><span class="label"></span><span class="seq hidden"></span>`;
        b.querySelector('.label').textContent = opt.text;
        b.addEventListener('click', () => pick(opt.id));
        box.appendChild(b);
      });
      $('q-hint').textContent = q.type === 'single' ? 'Press 1-' + q.options.length + ' or click. Enter to submit.'
        : q.type === 'multiple' ? 'Select all that apply (keys 1-' + q.options.length + ' toggle). Enter to submit.'
        : 'Click the items in the correct order (keys 1-' + q.options.length + '). Enter to submit.';
    }
    startTimer(q.seconds);
  }

  function pick(id) {
    if (state.status !== 'running' || !state.question) return;
    const t = state.question.type;
    if (t === 'single') state.selected = [id];
    else if (t === 'multiple') state.selected = state.selected.includes(id) ? state.selected.filter((x) => x !== id) : [...state.selected, id];
    else if (t === 'order') state.selected = state.selected.includes(id) ? state.selected.filter((x) => x !== id) : [...state.selected, id];
    paintSelection();
  }

  function paintSelection() {
    document.querySelectorAll('#q-options .option').forEach((b) => {
      const id = Number(b.dataset.id), pos = state.selected.indexOf(id);
      b.classList.toggle('selected', pos >= 0);
      const seq = b.querySelector('.seq');
      if (state.question.type === 'order' && pos >= 0) { seq.textContent = pos + 1; seq.classList.remove('hidden'); }
      else seq.classList.add('hidden');
    });
  }

  // -------------------------------------------------------------------------
  // Timer (local countdown to the server deadline computed in prep())
  // -------------------------------------------------------------------------
  function startTimer(total) {
    stopTimer();
    const timerEl = $('q-timer'), bar = $('q-bar');
    const tick = () => {
      const left = Math.max(0, (state.deadline - Date.now()) / 1000);
      timerEl.textContent = Math.ceil(left);
      bar.style.width = Math.min(100, 100 * left / total) + '%';
      const warn = left <= Math.min(3, total / 3);
      timerEl.classList.toggle('warn', warn);
      bar.classList.toggle('warn', warn);
      if (left <= 0) { stopTimer(); submit(true); }
    };
    tick();
    state.timerHandle = setInterval(tick, 100);
  }

  function stopTimer() {
    if (state.timerHandle) { clearInterval(state.timerHandle); state.timerHandle = null; }
  }

  // -------------------------------------------------------------------------
  // Submit : la réponse part, et le "Get ready" suivant démarre immédiatement
  // -------------------------------------------------------------------------
  function currentAnswer() {
    if (!state.question) return null;
    if (state.question.type === 'text') return $('q-input').value.trim();
    return state.selected;
  }

  function submit(auto) {
    if (state.status !== 'running' || state.submitting || !state.question) return;
    state.submitting = true;
    stopTimer();
    const q = state.question;
    const timeMs = Math.round(q.seconds * 1000 - Math.max(0, state.deadline - Date.now()));
    const answerPromise = api('answer', { sessionId: state.sessionId, index: q.index, answer: currentAnswer(), timeMs })
      .catch(() => ({ accepted: false, finished: false }))   // the server times the question out by itself
      .then((r) => (r.finished ? { finished: true } : api('current', { sessionId: state.sessionId })));
    prep(q.index + 1, answerPromise);
  }

  async function showResult() {
    state.status = 'finished';
    state.question = null;
    stopTimer();
    sessionStorage.removeItem('tt_session');
    show('screen-result');
    $('r-percent').textContent = '…';
    try {
      const r = await api('result', { sessionId: state.sessionId });
      $('r-name').textContent = r.firstName + ' ' + r.lastName;
      $('r-percent').textContent = r.percent + ' %';
      $('r-score').textContent = `${r.score} / ${r.maxScore} points · ${Math.floor(r.durationSeconds / 60)} min ${r.durationSeconds % 60} s`;
      const cats = $('r-categories');
      cats.innerHTML = '';
      r.byCategory.forEach((c) => {
        const pct = c.max ? Math.round(100 * c.earned / c.max) : 0;
        const row = document.createElement('div');
        row.className = 'row';
        row.innerHTML = `<span></span><div class="bar"><div style="width:${pct}%"></div></div><span>${c.earned} / ${c.max}</span>`;
        row.firstChild.textContent = CATEGORY_LABELS[c.category] || c.category;
        cats.appendChild(row);
      });
    } catch (_) {
      $('r-percent').textContent = '—';
      $('r-score').textContent = 'Your answers were recorded.';
    }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Fullscreen handling
  // -------------------------------------------------------------------------
  async function onFullscreenChange() {
    state.lastFullscreenChange = Date.now();
    if (document.fullscreenElement) return;
    if (state.status === 'running' || state.status === 'prep') {
      const wasRunning = state.status === 'running';
      state.status = 'paused';
      stopTimer();
      $('screen-fullscreen').classList.remove('hidden');
      await incident('fullscreen_exit', wasRunning ? 'left fullscreen during a question (question voided)' : 'left fullscreen between questions');
    }
  }

  async function resumeFullscreen() {
    try { await document.documentElement.requestFullscreen(); } catch (_) { return; }
    $('screen-fullscreen').classList.add('hidden');
    if (state.status !== 'paused') return;
    installMonitoring();
    // The server already voided the interrupted question: fetch whatever is current now
    let cur;
    try { cur = await api('current', { sessionId: state.sessionId }); } catch (_) { cur = null; }
    if (!cur || cur.finished) { showResult(); return; }
    prep(cur.question.index, Promise.resolve(cur));
  }

  // -------------------------------------------------------------------------
  // Monitoring: copy / paste / selection / focus / typing / devtools / resize
  // -------------------------------------------------------------------------
  let monitoringInstalled = false;
  function installMonitoring() {
    if (monitoringInstalled) return;
    monitoringInstalled = true;
    const active = () => state.status === 'running' || state.status === 'prep' || state.status === 'paused';
    const snippet = () => (window.getSelection ? String(window.getSelection()) : '').replace(/\s+/g, ' ').trim().slice(0, 80);

    document.addEventListener('fullscreenchange', onFullscreenChange);

    document.addEventListener('copy', (e) => { if (!active()) return; if (BLOCK_COPY) e.preventDefault(); incident('copy', snippet()); });
    document.addEventListener('cut', (e) => { if (!active()) return; if (BLOCK_COPY) e.preventDefault(); incident('cut', snippet()); });
    document.addEventListener('paste', (e) => {
      if (!active()) return;
      e.preventDefault();
      const text = e.clipboardData ? e.clipboardData.getData('text') : '';
      incident('paste_blocked', `${text.length} chars: ${text.replace(/\s+/g, ' ').slice(0, 120)}`);
    });
    document.addEventListener('drop', (e) => { if (!active()) return; e.preventDefault(); incident('drop_blocked'); });
    document.addEventListener('dragover', (e) => { if (active()) e.preventDefault(); });
    document.addEventListener('contextmenu', (e) => { if (!active()) return; e.preventDefault(); incident('contextmenu', snippet()); });

    let selTimer = null;
    document.addEventListener('selectionchange', () => {
      if (state.status !== 'running') return;
      clearTimeout(selTimer);
      selTimer = setTimeout(() => {
        const s = snippet();
        if (s.length >= 4 && s !== state.lastSelectionLogged) { state.lastSelectionLogged = s; incident('selection', s); }
      }, 400);
    });

    document.addEventListener('keydown', (e) => {
      if (!active()) return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && ['c', 'v', 'x', 'a', 'p', 's', 'u', 'f'].includes(k)) {
        incident('shortcut', (e.ctrlKey ? 'Ctrl+' : 'Cmd+') + k.toUpperCase());
        if (k !== 'c') e.preventDefault();
        return;
      }
      if (k === 'printscreen' || e.key === 'F12' || (e.ctrlKey && e.shiftKey && ['i', 'j'].includes(k))) {
        incident('shortcut', e.key);
        if (e.key === 'F12' || e.shiftKey) e.preventDefault();
        return;
      }
      if (state.status !== 'running' || !state.question) return;
      if (e.key === 'Enter') { e.preventDefault(); submit(false); return; }
      if (state.question.type !== 'text' && /^[1-9]$/.test(e.key)) {
        const opt = state.question.options[Number(e.key) - 1];
        if (opt) pick(opt.id);
      }
    });

    const input = $('q-input');
    input.addEventListener('beforeinput', (e) => {
      if (e.inputType === 'insertFromPaste' || e.inputType === 'insertFromDrop' || e.inputType === 'insertFromYank') {
        e.preventDefault(); incident('paste_blocked', 'via ' + e.inputType); return;
      }
      if (e.inputType === 'insertText' && e.data && e.data.length > 2) incident('multi_char_input', e.data.slice(0, 60));
    });
    input.addEventListener('input', () => {
      const now = Date.now();
      state.keystrokes.push(now);
      state.keystrokes = state.keystrokes.filter((t) => now - t < 600);
      if (state.keystrokes.length >= 8 && !state.burstLogged) { state.burstLogged = true; incident('typing_burst', '8+ chars in 600 ms'); }
    });

    window.addEventListener('blur', () => { if (state.status === 'running') incident('window_blur'); });
    document.addEventListener('visibilitychange', () => { if (document.hidden && active()) incident('tab_hidden'); });

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      if (!active() || Date.now() - state.lastFullscreenChange < 1500) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => incident('resize', `${innerWidth}x${innerHeight}`), 500);
    });

    setInterval(() => {
      if (!active() || state.devtoolsLogged || !document.fullscreenElement) return;
      if (outerWidth - innerWidth > 200 || outerHeight - innerHeight > 200) {
        state.devtoolsLogged = true; incident('devtools_suspected', `${outerWidth - innerWidth}x${outerHeight - innerHeight}`);
      }
    }, 2000);

    window.addEventListener('beforeunload', (e) => {
      if (!active()) return;
      incident('unload', 'page closed or navigated away');
      e.preventDefault();
      e.returnValue = '';
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
