// API transport: fetch wrapper + auto refresh on 401 + ngrok diagnostics.
var Api = (function () {
    'use strict';
  
    function err(code, message, status) {
      var e = new Error(message);
      e.code = code || 'UNKNOWN';
      e.status = status || 0;
      return e;
    }
  
    function base() { return Store.getHost(); }
    function isNgrok() { return /ngrok/i.test(base()); }
  
    function query(params) {
      var usp = new URLSearchParams();
      Object.keys(params || {}).forEach(function (k) {
        var v = params[k];
        if (v !== undefined && v !== null && v !== '') usp.set(k, v);
      });
      var s = usp.toString();
      return s ? '?' + s : '';
    }
  
    async function request(path, opts) {
      var o = opts || {};
      var method = o.method || 'GET';
      var auth = o.auth !== false;
      var allowRetry = o.allowRetry !== false;
  
      var headers = { Accept: 'application/json' };
      if (o.body !== undefined) headers['Content-Type'] = 'application/json';
      if (isNgrok()) headers['ngrok-skip-browser-warning'] = '1';   // bypass ngrok free interstitial
      if (auth) {
        var t = Store.getSession().accessToken;
        if (t) headers['Authorization'] = 'Bearer ' + t;
      }
  
      var res;
      try {
        res = await fetch(base() + path, {
          method: method,
          headers: headers,
          body: o.body !== undefined ? JSON.stringify(o.body) : undefined
        });
      } catch (networkError) {
        throw err('NETWORK_ERROR',
          'Сервер недоступен: ' + base() + '. Проверьте, что API запущен и хост указан верно.', 0);
      }
  
      var ctype = res.headers.get('content-type') || '';
      if (ctype.indexOf('json') === -1) {
        var text = (await res.text()).slice(0, 240);
        if (/ngrok|You are about to visit/i.test(text)) {
          throw err('NGROK_INTERSTITIAL',
            'ngrok вернул страницу-предупреждение вместо API. В CORS сервера должен быть разрешён заголовок ngrok-skip-browser-warning (см. README).',
            res.status);
        }
        throw err('BAD_RESPONSE', 'Сервер вернул не JSON: ' + (text || 'пустой ответ'), res.status);
      }
  
      var data = await res.json().catch(function () { return null; });
  
      // Token expired -> refresh once and repeat the request.
      if (res.status === 401 && auth && allowRetry) {
        var ok = await refreshTokens();
        if (ok) return request(path, { method: method, body: o.body, auth: true, allowRetry: false });
        Store.clearSession();
        window.dispatchEvent(new CustomEvent('api:unauthorized'));
        throw err('SESSION_EXPIRED', 'Сессия истекла. Войдите снова.', 401);
      }
  
      if (!res.ok) {
        var e = (data && data.error) || {};
        throw err(e.code || ('HTTP_' + res.status),
          e.message || ('Запрос завершился с кодом ' + res.status), res.status);
      }
      return data;
    }
  
    async function refreshTokens() {
      var rt = Store.getSession().refreshToken;
      if (!rt) return false;
      try {
        var data = await request('/auth/refresh', {
          method: 'POST', body: { refreshToken: rt }, auth: false, allowRetry: false
        });
        Store.setTokens(data.accessToken, data.refreshToken);
        return true;
      } catch (e) {
        return false;
      }
    }
  
    return {
      health: function () { return request('/health', { auth: false }); },
  
      login: function (login, password) {
        return request('/auth', { method: 'POST', body: { login: login, password: password }, auth: false });
      },
  
      register: function (login, password) {
        return request('/registration', { method: 'POST', body: { login: login, password: password }, auth: false });
      },
  
      me: function () { return request('/auth/me'); },
  
      logout: function (refreshToken) {
        return request('/logout', { method: 'POST', body: { refreshToken: refreshToken } });
      },
  
      listTickets: function (search, status) {
        return request('/tickets' + query({ search: search, status: status === 'all' ? '' : status }));
      },
  
      createTicket: function (payload) { return request('/tickets', { method: 'POST', body: payload }); },
  
      updateTicket: function (id, patch) {
        return request('/tickets/' + encodeURIComponent(id), { method: 'PATCH', body: patch });
      },
  
      deleteTicket: function (id) {
        return request('/tickets/' + encodeURIComponent(id), { method: 'DELETE' });
      }
    };
  })();