// Screens, ticket list, filters, create/edit panel, responsive behaviour.
// Auth flow: failed login -> button becomes "Register", registration failure
// with USER_ALREADY_EXISTS -> auto login attempt -> surface the login error.
(function () {
    'use strict';
  
    const CATEGORIES = ['Бот', 'Интеграция', 'Отчёт', 'Другое'];
    const STATUS_LABELS = {
      draft: 'Черновик', new: 'Новая', in_work: 'В работе', done: 'Готово', closed: 'Закрыта'
    };
    const NOT_EDITABLE = [ 'closed'];   // closed -> server returns TICKET_NOT_EDITABLE
    const $ = (sel, root) => (root || document).querySelector(sel);
    const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  
    const esc = s => String(s === null || s === undefined ? '' : s)
      .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  
    const state = {
      tickets: [],
      filter: { search: '', status: 'all' },
      mode: 'none',        // none | create | edit
      selectedId: null,
      loading: false,
      confirmDelete: false,
      user: null,
      draftId: null
    };
  
    let searchTimer = null;
    let saveTimer = null;
  
    /* ================= TOASTS ================= */
    function toast(message, type, code) {
      const box = $('#toasts');
      const el = document.createElement('div');
      el.className = 'toast' + (type ? ' toast--' + type : '');
      el.innerHTML = (code ? '<span class="toast__code">' + esc(code) + '</span>' : '') +
                     '<span class="toast__msg">' + esc(message) + '</span>';
      box.appendChild(el);
      setTimeout(() => {
        el.style.transition = 'opacity .3s, transform .3s';
        el.style.opacity = '0';
        el.style.transform = 'translateY(10px)';
        setTimeout(() => el.remove(), 320);
      }, type === 'error' ? 6500 : 3200);
    }
  
    function showApiError(e, inlineEl) {
      const msg = e.message || 'Неизвестная ошибка';
      if (inlineEl) {
        inlineEl.innerHTML = esc(msg) + (e.code ? ' <code>' + esc(e.code) + '</code>' : '');
        inlineEl.classList.remove('hidden');
      }
      toast(msg, 'error', e.code);
    }
  
    // Inline error with an optional explanation prefix (used for the auto-login fallback).
    function renderFormError(box, message, code, prefix) {
      if (!box) return;
      box.innerHTML = (prefix ? esc(prefix) + ' ' : '') +
        esc(message) + (code ? ' <code>' + esc(code) + '</code>' : '');
      box.classList.remove('hidden');
    }
  
    /* ================= SCREENS ================= */
    function showScreen(name) {
      $('#screen-auth').classList.toggle('hidden', name !== 'auth');
      $('#screen-register').classList.toggle('hidden', name !== 'register');
      $('#screen-app').classList.toggle('hidden', name !== 'app');
      if (name === 'auth') { $('#login-input').focus({ preventScroll: true }); }
      if (name === 'register') { $('#reg-login').focus({ preventScroll: true }); }
    }
  
    /* ================= BUTTON STATE ================= */
    // Busy / idle without losing the current caption.
    function setLoading(btn, isLoading, labelBusy) {
      if (!btn) return;
      if (isLoading) {
        if (btn.dataset.originalLabel === undefined) btn.dataset.originalLabel = btn.textContent;
        btn.textContent = labelBusy || '…';
        btn.disabled = true;
      } else {
        if (btn.dataset.originalLabel !== undefined) btn.textContent = btn.dataset.originalLabel;
        btn.disabled = false;
      }
    }
  
    // Switch the login button between normal login and "register + auto login" modes.
    function setSubmitMode(mode) {
      const btn = $('#btn-submit-login');
      const link = $('#link-open-register');
      const errBox = $('#login-error');
      btn.dataset.mode = mode;
      delete btn.dataset.originalLabel;
      btn.disabled = false;
      if (mode === 'quick-register') {
        btn.textContent = 'Зарегистрироваться и войти';
        link.textContent = 'Уже есть аккаунт? Вернуться ко входу';
      } else {
        btn.textContent = 'Войти';
        link.textContent = 'Нет аккаунта? Открыть страницу регистрации';
        errBox.classList.add('hidden');
      }
    }
  
    /* ================= SESSION HELPERS ================= */
    function saveSessionFrom(authData) {
      Store.saveSession({
        host: Store.getHost(),
        accessToken: authData.accessToken,
        refreshToken: authData.refreshToken,
        user: authData.user,
        draftId: authData.user && authData.user.draft ? authData.user.draft.id : null
      });
    }
  
    // Registration with automatic login. If the user already exists, we still try to log in
    // and report the LOGIN error instead of a dead end (USER_ALREADY_EXISTS).
    async function registerWithAutoLogin(login, password) {
      let registered = true;
      try {
        await Api.register(login, password);
      } catch (regErr) {
        if (regErr.code !== 'USER_ALREADY_EXISTS') {
          return { ok: false, error: regErr };          // validation / network / etc.
        }
        registered = false;
        // Fall through: account exists -> try to authenticate with the same credentials.
      }
  
      try {
        const data = await Api.login(login, password);
        saveSessionFrom(data);
        return {
          ok: true,
          alreadyExisted: !registered,
          message: registered
            ? 'Аккаунт создан, выполнен автоматический вход'
            : 'Аккаунт уже существовал — выполнен вход'
        };
      } catch (loginErr) {
        return {
          ok: false,
          error: loginErr,
          alreadyExisted: !registered,
          prefix: !registered
            ? 'Аккаунт с таким логином уже существует (USER_ALREADY_EXISTS), но войти не удалось.'
            : 'Аккаунт создан, но войти не удалось.'
        };
      }
    }
  
    /* ================= AUTH SCREEN (LOGIN) ================= */
    async function handleLoginSubmit(ev) {
      ev.preventDefault();
      const btn = $('#btn-submit-login');
      const errBox = $('#login-error');
      errBox.classList.add('hidden');
  
      const host = Store.setHost($('#host-input').value);
      $('#host-input').value = host;
      const login = $('#login-input').value.trim();
      const password = $('#password-input').value;
  
      if (!login || !password) {
        errBox.textContent = 'Заполните логин и пароль';
        errBox.classList.remove('hidden');
        return;
      }
  
      setLoading(btn, true, 'Проверяем…');
      try {
        const data = await Api.login(login, password);
        Store.saveSession({
          host: host,
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          user: data.user,
          draftId: data.user && data.user.draft ? data.user.draft.id : null
        });
        setSubmitMode('login');
        await enterApp();
      } catch (e) {
        if (e.code === 'AUTH_INVALID_CREDENTIALS') {
          // Login failed -> offer registration (it will auto-login on success).
          setSubmitMode('quick-register');
          errBox.innerHTML = 'Такой учётной записи нет или пароль неверный <code>' + esc(e.code) +
            '</code>. Нажмите кнопку ниже — создадим аккаунт и сразу войдём.';
          errBox.classList.remove('hidden');
        } else {
          setSubmitMode('login');
          showApiError(e, errBox);
        }
      }
    }
  
    // Button is in "quick-register" mode.
    async function handleQuickRegister() {
      const btn = $('#btn-submit-login');
      const errBox = $('#login-error');
      const login = $('#login-input').value.trim();
      const password = $('#password-input').value;
  
      if (!login || !password) {
        errBox.textContent = 'Заполните логин и пароль';
        errBox.classList.remove('hidden');
        return;
      }
  
      errBox.classList.add('hidden');
      setLoading(btn, true, 'Создаём аккаунт…');
  
      const result = await registerWithAutoLogin(login, password);
  
      if (result.ok) {
        setLoading(btn, false);
        setSubmitMode('login');
        toast(result.message, 'success', result.alreadyExisted ? '409' : '201');
        await enterApp();
        return;
      }
  
      // Show the REAL error (login one when the account already existed).
      setLoading(btn, false);
      const e = result.error;
      if (result.alreadyExisted) {
        // Dead end avoided: back to normal login so the user can retry the password.
        setSubmitMode('login');
        renderFormError(errBox, e.message || 'Ошибка входа', e.code, result.prefix);
        toast(e.message, 'error', e.code);
        const pwd = $('#password-input');
        pwd.focus();
        pwd.select();
        return;
      }
  
      // Registration itself failed (validation / network): keep quick-register mode.
      setSubmitMode('quick-register');
      renderFormError(errBox, e.message || 'Ошибка регистрации', e.code, result.prefix);
      toast(e.message, 'error', e.code);
    }
  
    /* ================= AUTH SCREEN (REGISTRATION) ================= */
    async function handleRegisterSubmit(ev) {
      ev.preventDefault();
      const btn = $('#btn-submit-register');
      const errBox = $('#register-error');
      errBox.classList.add('hidden');
  
      const host = Store.setHost($('#host-input-reg').value);
      $('#host-input-reg').value = host;
      const login = $('#reg-login').value.trim();
      const p1 = $('#reg-password').value;
      const p2 = $('#reg-password2').value;
  
      if (login.length < 3) { errBox.textContent = 'Логин — минимум 3 символа'; errBox.classList.remove('hidden'); return; }
      if (p1.length < 6) { errBox.textContent = 'Пароль — минимум 6 символов'; errBox.classList.remove('hidden'); return; }
      if (p1 !== p2) { errBox.textContent = 'Пароли не совпадают'; errBox.classList.remove('hidden'); return; }
  
      setLoading(btn, true, 'Создаём…');
  
      const result = await registerWithAutoLogin(login, p1);
      setLoading(btn, false);
  
      if (result.ok) {
        toast(result.message, 'success', result.alreadyExisted ? '409' : '201');
        await enterApp();
        return;
      }
  
      const e = result.error;
      renderFormError(errBox, e.message || 'Ошибка', e.code, result.prefix);
      toast(e.message, 'error', e.code);
  
      if (result.alreadyExisted) {
        // Move the credentials to the login form so the user can retry in one step.
        $('#login-input').value = login;
        $('#password-input').value = p1;
        setSubmitMode('login');
        $('#host-input').value = host;
        setTimeout(() => showScreen('auth'), 900);
      }
    }
  
    async function checkHost() {
      const btn = $('#btn-check-host');
      const host = Store.setHost($('#host-input').value);
      $('#host-input').value = host;
      setLoading(btn, true, 'Проверяем…');
      try {
        await Api.health();
        toast('Соединение установлено: ' + host, 'success', 'OK');
      } catch (e) {
        showApiError(e);
      } finally {
        setLoading(btn, false);
      }
    }
  
    /* ================= APP ================= */
    async function enterApp() {
      const s = Store.getSession();
      state.user = s.user;
      state.draftId = s.draftId;
      showScreen('app');
      renderTopbar();
      closeDetail();
      await refreshProfile();
      await loadTickets();
    }
  
    function renderTopbar() {
      const s = Store.getSession();
      const host = s.host.replace(/^https?:\/\//, '');
      $('#host-chip-text').textContent = host;
      $('#host-chip').title = s.host;
      $('#user-chip').textContent = '@' + (s.user ? s.user.login : '—');
    }
  
    async function refreshProfile() {
      try {
        const me = await Api.me();
        state.user = me;
        state.draftId = me.draft ? me.draft.id : null;
        Store.setUser({ id: me.id, login: me.login, created_at: me.created_at });
        Store.setDraftId(state.draftId);
        renderTopbar();
      } catch (e) {
        if (e.code !== 'NETWORK_ERROR') toast('Не удалось обновить профиль: ' + e.message, 'error', e.code);
      }
    }
  
    async function loadTickets() {
      state.loading = true;
      renderTickets();
      try {
        state.tickets = await Api.listTickets(state.filter.search, state.filter.status);
      } catch (e) {
        state.tickets = [];
        toast(e.message, 'error', e.code);
      } finally {
        state.loading = false;
        renderTickets();
      }
    }
  
    function fmtDate(iso) {
      if (!iso) return '—';
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '—';
      return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' }) +
        ', ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    }
  
    function badgeStatus(status) {
      const key = STATUS_LABELS[status] ? status : 'closed';
      return '<span class="badge badge--' + key + '"><span class="sdot"></span>' +
        esc(STATUS_LABELS[key]) + '</span>';
    }
  
    function cardHtml(t) {
      return '' +
        '<article class="tcard' + (state.selectedId === t.id ? ' is-selected' : '') + '" data-id="' + esc(t.id) + '" tabindex="0">' +
          '<div class="tcard__top">' +
            '<div style="min-width:0">' +
              '<h3 class="tcard__title">' + esc(t.title || 'Без названия') + '</h3>' +
              '<p class="tcard__desc">' + esc(t.description || '') + '</p>' +
            '</div>' +
            badgeStatus(t.status) +
          '</div>' +
          '<div class="tcard__meta">' +
            '<span class="badge badge--cat">' + esc(t.category || '—') + '</span>' +
            '<span class="tcard__date">' + esc(fmtDate(t.created_at)) + '</span>' +
          '</div>' +
        '</article>';
    }
  
    function skeletonRows(n) {
      let html = '';
      for (let i = 0; i < n; i++) {
        html += '<div class="skeleton"><div class="sk-line w60"></div><div class="sk-line w85"></div><div class="sk-line w35"></div></div>';
      }
      return html;
    }
  
    function renderTickets() {
      const box = $('#tickets');
      const empty = $('#empty-state');
      $('#list-count').textContent = state.loading
        ? 'Загрузка…'
        : plural(state.tickets.length, ['заявка', 'заявки', 'заявок']) +
          (state.filter.search ? ' · поиск: «' + state.filter.search + '»' : '') +
          (state.filter.status !== 'all' ? ' · статус: ' + STATUS_LABELS[state.filter.status] : '');
  
      if (state.loading) { box.innerHTML = skeletonRows(3); empty.classList.add('hidden'); return; }
      if (!state.tickets.length) { box.innerHTML = ''; empty.classList.remove('hidden'); return; }
      empty.classList.add('hidden');
      box.innerHTML = state.tickets.map(cardHtml).join('');
    }
  
    function plural(n, forms) {
      const a = Math.abs(n) % 100, b = a % 10;
      if (a > 10 && a < 20) return n + ' ' + forms[2];
      if (b > 1 && b < 5) return n + ' ' + forms[1];
      if (b === 1) return n + ' ' + forms[0];
      return n + ' ' + forms[2];
    }
  
    /* ================= DETAIL PANEL ================= */
    function isWide() {
      return window.innerWidth >= 1100 &&
        !(window.innerHeight > window.innerWidth && window.innerWidth <= 1250);
    }
  
    function openDetail() {
      const d = $('#detail');
      d.classList.add('is-open');
      if (!isWide()) {
        $('#backdrop').classList.remove('hidden');
        document.body.classList.add('no-scroll');
      }
    }
  
    function closeDetail() {
      state.mode = 'none';
      state.selectedId = null;
      state.confirmDelete = false;
      $('#detail').classList.remove('is-open');
      $('#backdrop').classList.add('hidden');
      document.body.classList.remove('no-scroll');
      renderDetail();
      renderTickets();
    }
  
    function openCreate() {
      state.mode = 'create';
      state.selectedId = null;
      state.confirmDelete = false;
      renderDetail();
      openDetail();
      renderTickets();
    }
  
    function openEdit(id) {
      const t = state.tickets.find(x => x.id === id);
      if (!t) return;
      state.mode = 'edit';
      state.selectedId = id;
      state.confirmDelete = false;
      renderDetail();
      openDetail();
      renderTickets();
    }
  
    function categoryOptions(selected) {
      return CATEGORIES.map(c =>
        '<option value="' + esc(c) + '"' + (c === selected ? ' selected' : '') + '>' + esc(c) + '</option>'
      ).join('');
    }
  
    function statusOptions(selected) {
      return ['new', 'in_work', 'done', 'closed'].map(s =>
        '<option value="' + s + '"' + (s === selected ? ' selected' : '') + '>' + esc(STATUS_LABELS[s]) + '</option>'
      ).join('');
    }
  
    function renderDetail() {
      const body = $('#detail-body');
      const eyebrow = $('#detail-eyebrow');
      const title = $('#detail-title');
      const userId = state.user ? state.user.id : null;
  
      if (state.mode === 'create') {
        const cached = Store.loadForm(userId, 'create') || {};
        eyebrow.textContent = 'Новая заявка';
        title.textContent = 'Добавить запрос';
        body.innerHTML =
          '<div class="draft-note' + (cached.title || cached.description ? ' restored' : '') + '">' +
            '<span class="dot"></span>' +
            (cached.title || cached.description
              ? 'Восстановлены несохранённые данные с устройства'
              : 'Черновик подставлен автоматически') +
            (state.draftId ? ' · <code>' + esc(String(state.draftId).slice(0, 8)) + '</code>' : '') +
          '</div>' +
          (state.draftId ? '' : '<div class="readonly-note">Черновик не получен от сервера. Обновите страницу или выйдите и войдите снова.</div>') +
          '<form id="form-create" novalidate>' +
            '<div class="field" data-f="title">' +
              '<label for="c-title">Название *</label>' +
              '<input id="c-title" type="text" maxlength="140" placeholder="Например: Бот для согласования отпусков" value="' + esc(cached.title || '') + '">' +
              '<div class="field-error hidden"></div>' +
            '</div>' +
            '<div class="field" data-f="description">' +
              '<label for="c-desc">Описание задачи *</label>' +
              '<textarea id="c-desc" placeholder="Что нужно сделать, какой результат ожидается, сроки…">' + esc(cached.description || '') + '</textarea>' +
              '<div class="field-error hidden"></div>' +
            '</div>' +
            '<div class="field" data-f="category">' +
              '<label for="c-cat">Категория *</label>' +
              '<select id="c-cat">' +
                '<option value=""' + (cached.category ? '' : ' selected') + '>Выберите категорию</option>' +
                categoryOptions(cached.category) +
              '</select>' +
              '<div class="field-error hidden"></div>' +
            '</div>' +
            '<div class="form-error hidden" id="create-error"></div>' +
            '<div class="detail__actions">' +
              '<button type="submit" class="btn btn--primary" id="btn-create-save">Сохранить заявку</button>' +
              '<button type="button" class="btn btn--ghost" id="btn-create-cancel">Отмена</button>' +
            '</div>' +
            '<p class="hint" style="margin-top:14px">Статус «Новая» и дата создания проставляются сервером автоматически. После сохранения вы получите новый черновик.</p>' +
          '</form>';
        bindCreateForm();
        return;
      }
  
      if (state.mode === 'edit') {
        const t = state.tickets.find(x => x.id === state.selectedId);
        if (!t) { state.mode = 'none'; renderDetail(); return; }
        const canEdit = NOT_EDITABLE.indexOf(t.status) === -1;
        const cached = canEdit ? (Store.loadForm(userId, 'edit', t.id) || {}) : {};
        const v = {
          title: cached.title !== undefined ? cached.title : t.title,
          description: cached.description !== undefined ? cached.description : t.description,
          category: cached.category || t.category,
          status: cached.status || t.status
        };
  
        eyebrow.textContent = 'Заявка · ' + STATUS_LABELS[t.status];
        title.textContent = t.title || 'Без названия';
  
        body.innerHTML =
          '<div class="meta-grid">' +
            '<div class="meta-item"><span>Статус</span><b>' + esc(STATUS_LABELS[t.status]) + '</b></div>' +
            '<div class="meta-item"><span>Создана</span><b>' + esc(fmtDate(t.created_at)) + '</b></div>' +
            '<div class="meta-item"><span>Категория</span><b>' + esc(t.category || '—') + '</b></div>' +
            '<div class="meta-item"><span>Изменена</span><b>' + esc(fmtDate(t.updated_at)) + '</b></div>' +
          '</div>' +
          (cached.title !== undefined || cached.description !== undefined
            ? '<div class="draft-note restored"><span class="dot"></span>Восстановлены несохранённые правки с устройства</div>' : '') +
          (canEdit ? '' : '<div class="readonly-note">Заявка в статусе «' + esc(STATUS_LABELS[t.status]) + '» — редактирование недоступно (TICKET_NOT_EDITABLE).</div>') +
          '<form id="form-edit" novalidate>' +
            '<div class="field" data-f="title">' +
              '<label for="e-title">Название</label>' +
              '<input id="e-title" type="text" maxlength="140" value="' + esc(v.title || '') + '"' + (canEdit ? '' : ' disabled') + '>' +
              '<div class="field-error hidden"></div>' +
            '</div>' +
            '<div class="field" data-f="description">' +
              '<label for="e-desc">Описание задачи</label>' +
              '<textarea id="e-desc"' + (canEdit ? '' : ' disabled') + '>' + esc(v.description || '') + '</textarea>' +
              '<div class="field-error hidden"></div>' +
            '</div>' +
            '<div class="field" data-f="category">' +
              '<label for="e-cat">Категория</label>' +
              '<select id="e-cat"' + (canEdit ? '' : ' disabled') + '>' + categoryOptions(v.category) + '</select>' +
            '</div>' +
            '<div class="field" data-f="status">' +
              '<label for="e-status">Статус</label>' +
              '<select id="e-status"' + (canEdit ? '' : ' disabled') + '>' + statusOptions(v.status) + '</select>' +
            '</div>' +
            '<div class="form-error hidden" id="edit-error"></div>' +
            '<div class="detail__actions">' +
              (canEdit
                ? '<button type="submit" class="btn btn--primary" id="btn-edit-save">Сохранить изменения</button>'
                : '') +
              (state.confirmDelete
                ? '<div class="confirm-row">' +
                    '<button type="button" class="btn btn--danger" id="btn-delete-yes">Подтвердить удаление</button>' +
                    '<button type="button" class="btn btn--ghost" id="btn-delete-no">Отмена</button>' +
                  '</div>'
                : '<button type="button" class="btn btn--danger" id="btn-delete">Удалить заявку</button>') +
              '<button type="button" class="btn btn--ghost" id="btn-edit-cancel">Закрыть</button>' +
            '</div>' +
          '</form>';
        bindEditForm(t);
        return;
      }
  
      // nothing selected
      eyebrow.textContent = 'Панель';
      title.textContent = 'Заявка';
      body.innerHTML =
        '<div class="placeholder">' +
          '<div class="placeholder__mark">LDL</div>' +
          '<p>Выберите заявку из списка, чтобы открыть её,<br>или нажмите «Добавить запрос».</p>' +
        '</div>';
    }
  
    /* ---- create form ---- */
    function bindCreateForm() {
      const form = $('#form-create');
      const userId = state.user ? state.user.id : null;
  
      form.addEventListener('input', () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          Store.saveForm(userId, 'create', null, {
            title: $('#c-title').value,
            description: $('#c-desc').value,
            category: $('#c-cat').value
          });
        }, 350);
      });
  
      $('#btn-create-cancel').addEventListener('click', () => {
        Store.removeForm(userId, 'create', null);
        closeDetail();
      });
  
      form.addEventListener('submit', async ev => {
        ev.preventDefault();
        const errBox = $('#create-error');
        errBox.classList.add('hidden');
        $$('.field', form).forEach(f => {
          f.classList.remove('is-invalid');
          const e = $('.field-error', f);
          if (e) e.classList.add('hidden');
        });
  
        const title = $('#c-title').value.trim();
        const description = $('#c-desc').value.trim();
        const category = $('#c-cat').value;
  
        let bad = false;
        if (!title) { markInvalid(form, 'title', 'Название обязательно'); bad = true; }
        if (!description) { markInvalid(form, 'description', 'Описание задачи обязательно'); bad = true; }
        if (!category || CATEGORIES.indexOf(category) === -1) { markInvalid(form, 'category', 'Выберите категорию'); bad = true; }
        if (!state.draftId) {
          errBox.textContent = 'Нет черновика (draftId). Обновите страницу или войдите снова.';
          errBox.classList.remove('hidden');
          bad = true;
        }
        if (bad) return;
  
        const btn = $('#btn-create-save');
        setLoading(btn, true, 'Сохраняем…');
        try {
          const res = await Api.createTicket({ draftId: state.draftId, title, description, category });
          state.draftId = res.newDraft ? res.newDraft.id : null;
          Store.setDraftId(state.draftId);
          Store.removeForm(userId, 'create', null);
          toast('Заявка создана, выдан новый черновик', 'success', '201');
          state.mode = 'none';
          await loadTickets();
          renderDetail();
          if (!isWide()) closeDetail();
        } catch (e) {
          if (e.code === 'DRAFT_ALREADY_USED') {
            await refreshProfile();   // fetch a fresh draft uuid
            toast('Черновик уже использован — получен новый. Нажмите «Сохранить» ещё раз.', 'error', e.code);
            const note = $('.draft-note');
            if (note) note.classList.remove('restored');
          } else if (e.code === 'VALIDATION_ERROR') {
            renderFormError(errBox, e.message, e.code);
          } else {
            showApiError(e, errBox);
          }
        } finally {
          setLoading(btn, false);
        }
      });
    }
  
    function markInvalid(form, name, message) {
      const f = $('.field[data-f="' + name + '"]', form);
      if (!f) return;
      f.classList.add('is-invalid');
      const e = $('.field-error', f);
      if (e) { e.textContent = message; e.classList.remove('hidden'); }
    }
  
    /* ---- edit form ---- */
    function bindEditForm(ticket) {
      const form = $('#form-edit');
      const userId = state.user ? state.user.id : null;
      const canEdit = NOT_EDITABLE.indexOf(ticket.status) === -1;
  
      if (canEdit) {
        form.addEventListener('input', () => {
          clearTimeout(saveTimer);
          saveTimer = setTimeout(() => {
            Store.saveForm(userId, 'edit', ticket.id, {
              title: $('#e-title').value,
              description: $('#e-desc').value,
              category: $('#e-cat').value,
              status: $('#e-status').value
            });
          }, 350);
        });
      }
  
      $('#btn-edit-cancel').addEventListener('click', () => {
        Store.removeForm(userId, 'edit', ticket.id);
        closeDetail();
      });
  
      const delBtn = $('#btn-delete');
      if (delBtn) delBtn.addEventListener('click', () => { state.confirmDelete = true; renderDetail(); });
  
      const delNo = $('#btn-delete-no');
      if (delNo) delNo.addEventListener('click', () => { state.confirmDelete = false; renderDetail(); });
  
      const delYes = $('#btn-delete-yes');
      if (delYes) {
        delYes.addEventListener('click', async () => {
          setLoading(delYes, true, 'Удаляем…');
          try {
            await Api.deleteTicket(ticket.id);
            Store.removeForm(userId, 'edit', ticket.id);
            toast('Заявка удалена', 'success', '200');
            closeDetail();
            await loadTickets();
          } catch (e) {
            showApiError(e);
            if (e.code === 'TICKET_NOT_FOUND') { closeDetail(); await loadTickets(); }
          } finally {
            setLoading(delYes, false);
          }
        });
      }
  
      if (!canEdit) return;
  
      form.addEventListener('submit', async ev => {
        ev.preventDefault();
        const errBox = $('#edit-error');
        errBox.classList.add('hidden');
        $$('.field', form).forEach(f => {
          f.classList.remove('is-invalid');
          const e = $('.field-error', f);
          if (e) e.classList.add('hidden');
        });
  
        const title = $('#e-title').value.trim();
        const description = $('#e-desc').value.trim();
        const category = $('#e-cat').value;
        const status = $('#e-status').value;
  
        let bad = false;
        if (!title) { markInvalid(form, 'title', 'Название не может быть пустым'); bad = true; }
        if (!description) { markInvalid(form, 'description', 'Описание не может быть пустым'); bad = true; }
        if (CATEGORIES.indexOf(category) === -1) { markInvalid(form, 'category', 'Выберите категорию'); bad = true; }
        if (bad) return;
  
        const patch = {};
        if (title !== ticket.title) patch.title = title;
        if (description !== ticket.description) patch.description = description;
        if (category !== ticket.category) patch.category = category;
        if (status !== ticket.status) patch.status = status;
  
        if (!Object.keys(patch).length) {
          errBox.textContent = 'Нет изменений для сохранения';
          errBox.classList.remove('hidden');
          return;
        }
  
        const btn = $('#btn-edit-save');
        setLoading(btn, true, 'Сохраняем…');
        try {
          await Api.updateTicket(ticket.id, patch);
          Store.removeForm(userId, 'edit', ticket.id);
          toast('Изменения сохранены', 'success', '200');
          state.selectedId = null;
          state.mode = 'none';
          await loadTickets();
          openEdit(ticket.id);   // reopen with fresh data
        } catch (e) {
          if (e.code === 'TICKET_NOT_EDITABLE' || e.code === 'TICKET_NOT_FOUND') {
            toast(e.message, 'error', e.code);
            await loadTickets();
            renderDetail();
          } else {
            showApiError(e, errBox);
          }
        } finally {
          setLoading(btn, false);
        }
      });
    }
  
    /* ================= LOGOUT ================= */
    async function handleLogout() {
      const btn = $('#btn-logout');
      setLoading(btn, true, '…');
      const rt = Store.getSession().refreshToken;
      try { if (rt) await Api.logout(rt); } catch (e) { /* token may already be revoked */ }
      setLoading(btn, false);
      Store.clearSession();
      state.tickets = []; state.mode = 'none'; state.selectedId = null; state.user = null; state.draftId = null;
      $('#login-input').value = ''; $('#password-input').value = '';
      $('#host-input').value = Store.getHost();
      $('#host-input-reg').value = Store.getHost();
      setSubmitMode('login');
      showScreen('auth');
      toast('Вы вышли из аккаунта, refresh-токен удалён', 'success');
    }
  
    /* ================= BINDINGS ================= */
    function bind() {
      const s = Store.getSession();
      $('#host-input').value = s.host;
      $('#host-input-reg').value = s.host;
      setSubmitMode('login');
  
      $('#form-login').addEventListener('submit', ev => {
        if ($('#btn-submit-login').dataset.mode === 'quick-register') {
          ev.preventDefault();
          handleQuickRegister();
          return;
        }
        handleLoginSubmit(ev);
      });
  
      // Any credential edit resets "register" mode back to plain login.
      ['#login-input', '#password-input'].forEach(sel => {
        $(sel).addEventListener('input', () => {
          if ($('#btn-submit-login').dataset.mode === 'quick-register') setSubmitMode('login');
        });
      });
  
      $('#form-register').addEventListener('submit', handleRegisterSubmit);
      $('#btn-check-host').addEventListener('click', checkHost);
  
      $('#btn-eye-login').addEventListener('click', () => {
        const i = $('#password-input');
        i.type = i.type === 'password' ? 'text' : 'password';
      });
  
      $('#link-open-register').addEventListener('click', () => {
        if ($('#btn-submit-login').dataset.mode === 'quick-register') {
          // The link caption is "already have an account?" in that mode.
          setSubmitMode('login');
          $('#login-input').focus();
          return;
        }
        $('#host-input-reg').value = Store.getHost();
        showScreen('register');
      });
  
      $('#link-back-login').addEventListener('click', () => {
        $('#host-input').value = Store.getHost();
        setSubmitMode('login');
        showScreen('auth');
      });
  
      $('#btn-logout').addEventListener('click', handleLogout);
      $('#btn-create').addEventListener('click', openCreate);
      $('#btn-detail-close').addEventListener('click', closeDetail);
      $('#backdrop').addEventListener('click', closeDetail);
  
      // list interactions (event delegation)
      $('#tickets').addEventListener('click', ev => {
        const card = ev.target.closest('.tcard');
        if (card) openEdit(card.dataset.id);
      });
      $('#tickets').addEventListener('keydown', ev => {
        if (ev.key !== 'Enter') return;
        const card = ev.target.closest('.tcard');
        if (card) openEdit(card.dataset.id);
      });
  
      // search (debounced)
      $('#search-input').addEventListener('input', ev => {
        const v = ev.target.value;
        $('#btn-clear-search').classList.toggle('hidden', !v);
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => { state.filter.search = v.trim(); loadTickets(); }, 350);
      });
      $('#btn-clear-search').addEventListener('click', () => {
        $('#search-input').value = '';
        $('#btn-clear-search').classList.add('hidden');
        state.filter.search = '';
        loadTickets();
      });
  
      // status filter
      $('#filters').addEventListener('click', ev => {
        const chip = ev.target.closest('.fchip');
        if (!chip) return;
        $$('.fchip').forEach(c => c.classList.remove('is-active'));
        chip.classList.add('is-active');
        state.filter.status = chip.dataset.status;
        loadTickets();
      });
  
      // Esc closes the panel
      document.addEventListener('keydown', ev => {
        if (ev.key === 'Escape' && !$('#screen-app').classList.contains('hidden')) closeDetail();
      });
  
      // Session died -> back to login
      window.addEventListener('api:unauthorized', () => {
        setSubmitMode('login');
        showScreen('auth');
        toast('Сессия истекла, войдите снова', 'error', '401');
      });
  
      // Re-layout on resize / orientation change
      window.addEventListener('resize', () => {
        if (isWide()) {
          $('#backdrop').classList.add('hidden');
          document.body.classList.remove('no-scroll');
        } else if ($('#detail').classList.contains('is-open')) {
          $('#backdrop').classList.remove('hidden');
        }
      });
    }
  
    /* ================= INIT ================= */
    function init() {
      bind();
      const s = Store.getSession();
      if (s.accessToken && s.user) {
        state.user = s.user;
        state.draftId = s.draftId;
        showScreen('app');
        renderTopbar();
        renderDetail();
        refreshProfile().then(loadTickets);
      } else {
        showScreen('auth');
      }
    }
  
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  })();