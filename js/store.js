// Local storage layer: host, session tokens, user, cached draft form.
const Store = (function () {
    'use strict';
  
    const SESSION_KEY = 'ldlatte.session.v1';
    const DEFAULT_HOST = 'http://localhost:5678';
  
    function readSession() {
      try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || {}; }
      catch (e) { return {}; }
    }
  
    function writeSession(patch) {
      const next = Object.assign(readSession(), patch);
      localStorage.setItem(SESSION_KEY, JSON.stringify(next));
      return next;
    }
  
    // "localhost:5678" -> "http://localhost:5678"; ngrok always https; trailing slash removed.
    function normalizeHost(value) {
      let h = String(value || '').trim();
      if (!h) return DEFAULT_HOST;
      if (!/^https?:\/\//i.test(h)) {
        h = (/ngrok/i.test(h) ? 'https://' : 'http://') + h;
      }
      return h.replace(/\/+$/, '');
    }
  
    function getHost() { return normalizeHost(readSession().host || DEFAULT_HOST); }
    function setHost(value) { return writeSession({ host: normalizeHost(value) }).host; }
  
    function getSession() {
      const s = readSession();
      return {
        host: normalizeHost(s.host || DEFAULT_HOST),
        accessToken: s.accessToken || null,
        refreshToken: s.refreshToken || null,
        user: s.user || null,
        draftId: s.draftId || null
      };
    }
  
    function saveSession(data) { return writeSession(data); }
    function setTokens(accessToken, refreshToken) { return writeSession({ accessToken, refreshToken }); }
    function setUser(user) { return writeSession({ user }); }
    function setDraftId(draftId) { return writeSession({ draftId }); }
  
    function clearSession() {
      const host = getHost();
      localStorage.removeItem(SESSION_KEY);
      writeSession({ host });            // keep host for the next login
      clearAllFormCaches();
    }
  
    // ---- form caches (per user) ----
    function formKey(userId, kind, ticketId) {
      return 'ldlatte.form.' + (userId || 'anon') + '.' + kind + (ticketId ? '.' + ticketId : '');
    }
  
    function saveForm(userId, kind, ticketId, data) {
      try { localStorage.setItem(formKey(userId, kind, ticketId), JSON.stringify(data)); } catch (e) { /* quota */ }
    }
  
    function loadForm(userId, kind, ticketId) {
      try {
        const raw = localStorage.getItem(formKey(userId, kind, ticketId));
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    }
  
    function removeForm(userId, kind, ticketId) {
      localStorage.removeItem(formKey(userId, kind, ticketId));
    }
  
    function clearAllFormCaches() {
      Object.keys(localStorage)
        .filter(k => k.indexOf('ldlatte.form.') === 0)
        .forEach(k => localStorage.removeItem(k));
    }
  
    return {
      DEFAULT_HOST,
      normalizeHost, getHost, setHost,
      getSession, saveSession, setTokens, setUser, setDraftId, clearSession,
      saveForm, loadForm, removeForm, clearAllFormCaches
    };
  })();