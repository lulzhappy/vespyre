/* Vespyre — camada web: implementa window.api (a mesma do app do Windows) no navegador.
   Dados locais em IndexedDB, sessões em localStorage, nuvem direto no Supabase, IGDB pela função "igdb". */
(function () {
  'use strict';
  const CFG = window.MG_CFG || {};
  const J = { get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }, del(k) { try { localStorage.removeItem(k); } catch {} } };
  const SS = { get(k) { try { return sessionStorage.getItem(k); } catch { return null; } }, set(k, v) { try { sessionStorage.setItem(k, v); } catch {} }, del(k) { try { sessionStorage.removeItem(k); } catch {} } };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));

  // ---------- dados locais (IndexedDB; cai para localStorage se o navegador bloquear) ----------
  let _db = null;
  const idb = () => _db || (_db = new Promise((res, rej) => { try { const r = indexedDB.open('mgdb', 1); r.onupgradeneeded = () => r.result.createObjectStore('data'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); } catch (e) { rej(e); } }));
  const idbGet = async k => { try { const db = await idb(); return await new Promise((res, rej) => { const q = db.transaction('data').objectStore('data').get(k); q.onsuccess = () => res(q.result === undefined ? null : q.result); q.onerror = () => rej(q.error); }); } catch { return J.get('mg-data-' + k, null); } };
  const idbPut = async (k, v) => { try { const db = await idb(); await new Promise((res, rej) => { const t = db.transaction('data', 'readwrite'); t.objectStore('data').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); } catch { J.set('mg-data-' + k, v); } };
  const idbDel = async k => { try { const db = await idb(); await new Promise((res, rej) => { const t = db.transaction('data', 'readwrite'); t.objectStore('data').delete(k); t.oncomplete = res; t.onerror = () => rej(t.error); }); } catch { J.del('mg-data-' + k); } };

  // ---------- perfis ----------
  const readP = () => { const p = J.get('mg-profiles', null); return p && Array.isArray(p.profiles) ? p : { profiles: [], last: null }; };
  const writeP = p => J.set('mg-profiles', p);
  const cur = () => SS.get('mg-current');
  let DATA = null, saveT = null;
  const flush = () => { clearTimeout(saveT); saveT = null; const c = cur(); if (c && DATA) idbPut(c, JSON.parse(JSON.stringify(DATA))); };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

  // ---------- sessões da conta ----------
  const sessKey = id => 'mg-sess-' + id;
  const getSess = id => (id ? J.get(sessKey(id), null) : pending);
  let pending = null, PENDING = null, pendingName = "";
  const cloudCfg = () => (CFG.supabaseUrl && CFG.supabaseKey ? { url: CFG.supabaseUrl, key: CFG.supabaseKey } : null);
  function cloudFor(id) {
    const c = cloudCfg(); if (!c) return null;
    return MGCloud.createCloud({ ...c, getSession: () => getSess(id), setSession: s => { if (id) J.set(sessKey(id), s); else pending = s; } });
  }
  const cerr = e => ({ error: String(e.message || e), code: e.code || 'ERR' });
  const FR_ = async (fn, ...a) => { const { x } = curP(); if (!x || !x.cloud) return { error: 'Entre em uma conta para usar os amigos.', code: 'NO_LINK' }; const c = cloudFor(x.id); if (!c) return { error: 'Serviço não configurado.', code: 'CONFIG' }; try { return { data: await c[fn](...a) }; } catch (e) { return cerr(e); } };
  const curP = () => { const p = readP(); return { p, x: p.profiles.find(y => y.id === cur()) }; };
  const webUrl = () => CFG.webUrl || (location.origin + location.pathname);

  // ---------- IGDB (pela função do Supabase) ----------
  function igdbCfg() {
    const { x } = curP(), cfg = cloudCfg();
    if (x && x.cloud && cfg) {
      if (!getSess(x.id)) return { noSession: true };
      const c = cloudFor(x.id);
      const post = async body => fetch(cfg.url + '/functions/v1/igdb', { method: 'POST', headers: { apikey: cfg.key, Authorization: 'Bearer ' + (await c.accessToken()), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { proxy: (endpoint, query) => post({ endpoint, query }), proxyBatch: queries => post({ queries }) };
    }
    return null;
  }
  const igdbCall = fn => async (...a) => {
    const c = igdbCfg();
    if (c && c.noSession) return { error: 'Sessão expirada. Entre de novo na conta (☁️).' };
    if (!c) return { error: 'Entre na sua conta (☁️) para buscar jogos.' };
    try { return await fn(...a, c); } catch (e) { return { error: String(e.message || e) }; }
  };
  const blobToData = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); });

  const API = {
    web: true,
    loadSync: () => DATA,
    save: d => { if (!cur()) return; DATA = d; clearTimeout(saveT); saveT = setTimeout(flush, 350); },
    getConfig: async () => ({ clientId: '-', clientSecret: '-', web: true }),   // as chaves da IGDB ficam no servidor
    setConfig: async () => true,
    search: q => igdbCall((q2, c) => MGIgdb.search(q2, c))(q),
    beats: async ids => { const c = igdbCfg(); if (!c || c.noSession) return {}; try { return await MGIgdb.beats(ids, c); } catch (e) { return {}; } },
    franchise: (k, i) => igdbCall((k2, i2, c) => MGIgdb.franchiseGames(k2, i2, c))(k, i),
    enrich: it => igdbCall((i2, c) => MGIgdb.enrich(i2, c))(it),
    recommend: (g, cs) => igdbCall((g2, cs2, c) => MGIgdb.recommend(g2, c, cs2))(g, cs),
    cover: async url => {
      const u = new URL(url); if (u.hostname !== 'images.igdb.com') throw new Error('url não permitida');
      try { const r = await fetch(url); if (r.ok) return await blobToData(await r.blob()); } catch {}
      const c = igdbCfg(), cfg = cloudCfg(), i = url.indexOf('/igdb/image/upload/');
      if (!c || !c.proxy || i < 0) throw new Error('capa indisponível');
      const r = await fetch(cfg.url + '/functions/v1/igdb', { method: 'POST', headers: { apikey: cfg.key, Authorization: 'Bearer ' + (await cloudFor(curP().x.id).accessToken()), 'Content-Type': 'application/json' }, body: JSON.stringify({ image: url.slice(i + 19) }) });
      if (!r.ok) throw new Error('capa indisponível');
      return blobToData(await r.blob());
    },
    // screenshots: só no app do Windows
    shotsScan: async () => ({ error: 'As screenshots só estão disponíveis no app do Windows.' }),
    shotsSetOn: async () => true, shotsAddFolder: async () => null, shotsDelFolder: async () => true, shotsShow: async () => true, shotsNames: async () => ({}),

    profilesState: () => { const p = readP(); return { profiles: p.profiles.map(({ id, name, photo, cloud }) => ({ id, name, photo, cloud: cloud || null })), current: cur(), auto: false, last: p.last }; },
    profileCreate: async (name, photo) => { const p = readP(), id = uuid(); p.profiles.push({ id, name: String(name || '').trim().slice(0, 40) || 'Jogador', photo: typeof photo === 'string' ? photo : '', createdAt: Date.now() }); writeP(p); return id; },
    profileSelect: async id => { const p = readP(); if (!p.profiles.some(x => x.id === id)) return false; p.last = id; writeP(p); SS.set('mg-current', id); DATA = await idbGet(id); return true; },
    profileLogout: async () => { flush(); SS.del('mg-current'); DATA = null; return true; },
    profileUpdate: async (id, patch) => { const p = readP(), x = p.profiles.find(y => y.id === id); if (!x || !patch) return false; if (patch.name !== undefined) x.name = String(patch.name).trim().slice(0, 40) || x.name; if (patch.photo !== undefined) x.photo = typeof patch.photo === 'string' ? patch.photo : ''; writeP(p); return true; },
    profileRemove: async id => {
      const p = readP(); p.profiles = p.profiles.filter(x => x.id !== id); if (p.last === id) p.last = null; writeP(p);
      const d = await idbGet(id); if (d) await idbPut('removido-' + id, d);       // não apaga: guarda uma cópia
      await idbDel(id); J.del(sessKey(id));
      if (cur() === id) { SS.del('mg-current'); DATA = null; }
      return true;
    },

    loginGet: async () => { try { return JSON.parse(localStorage.getItem('cofre-login') || 'null'); } catch { return null; } },
    loginSet: async o => { try { if (o && o.email) localStorage.setItem('cofre-login', JSON.stringify(o)); else localStorage.removeItem('cofre-login'); } catch {} return true; },
    cloudState: () => { const cfg = cloudCfg(), { x } = curP(); return { configured: !!cfg, bundled: true, recovery: CFG.recovery !== false, recoveryMode: 'link', url: cfg ? cfg.url : '', linked: x && x.cloud ? x.cloud : null, signedIn: !!(x && x.cloud && getSess(x.id)), canPersist: true }; },
    cloudConfig: async () => ({ error: 'Este app já vem configurado.' }),
    cloudAuth: async (mode, email, password, username) => {
      const c = cloudFor(null); if (!c) return { error: 'Serviço não configurado.', code: 'CONFIG' };
      try {
        const r = mode === 'signup' ? await c.signUp(String(email || '').trim(), String(password || ''), username) : await c.signIn(String(email || '').trim(), String(password || ''));
        if (r.needsConfirm) return { ok: true, needsConfirm: true };
        pending = r.session; pendingName = r.username || ''; return { ok: true, userId: r.session.user.id, email: r.session.user.email };
      } catch (e) { return cerr(e); }
    },
    friends: async () => FR_('friendsList'),
    friendAdd: async u => FR_('friendAdd', u),
    friendRespond: async (id, ok) => FR_('friendRespond', id, ok),
    friendRemove: async id => FR_('friendRemove', id),
    friendGames: async id => FR_('friendGames', id),
    timeline: async () => FR_('timeline'),
    timelineLike: async (o, g) => FR_('likeToggle', o, g),
    friendsNow: async () => FR_('friendsNow'),
    playersNow: async () => FR_('playersNow'),
    profilePreview: async id => FR_('profilePreview', id),
    msgSend: async (id, b) => FR_('msgSend', id, String(b || '').slice(0, 1000)),
    msgThread: async id => FR_('msgThread', id),
    msgInbox: async () => FR_('msgInbox'),
    msgAudio: async (id, b64, mime, secs) => { const bin = atob(String(b64 || '')), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return FR_('msgAudio', id, u, mime, secs); },
    msgVoice: async p => FR_('getVoice', p),
    roomList: async () => FR_('roomList'),
    roomCreate: async (n, m, pw) => FR_('roomCreate', n, m, pw),
    roomJoin: async (id, pw) => FR_('roomJoin', id, pw),
    roomLeave: async id => FR_('roomLeave', id),
    roomState: async (id, after) => FR_('roomState', id, after),
    roomSay: async (id, b) => FR_('roomSay', id, b),
    roomSignal: async (id, to, k, d) => FR_('roomSignal', id, to, k, d),
    roomPull: async (id, after) => FR_('roomPull', id, after),
    roomInvite: async (id, ids) => FR_('roomInvite', id, ids),
    roomDelete: async id => FR_('roomDelete', id),
    bugSend: async (body, ctx) => FR_('bugSend', String(body || '').slice(0, 4000), { ...(ctx && typeof ctx === 'object' ? ctx : {}), v: 'web', os: navigator.userAgent.slice(0, 160) }),
    bugAdmin: async () => FR_('bugAdmin'),
    bugList: async () => FR_('bugList'),
    bugMark: async (id, d) => FR_('bugMark', id, d),
    bugDelete: async id => FR_('bugDelete', id),
    callStart: async ids => FR_('callStart', ids),
    callInvite: async (cid, ids) => FR_('callInvite', cid, ids),
    callJoin: async cid => FR_('callJoin', cid),
    callLeave: async (cid, dec) => FR_('callLeave', cid, dec),
    callState: async () => FR_('callState'),
    callList: async () => FR_('callList'),
    actGet: async () => null, onAct: () => {},   // no navegador não dá para ver jogos/músicas do computador
    activitySet: async a => FR_('activitySet', a),
    callFlags: async (id, mic, snd) => FR_('callFlags', id, mic, snd),
    roomFlags: async (id, mic, snd) => FR_('roomFlags', id, mic, snd),
    callSignal: async (cid, to, kind, data) => FR_('callSignal', cid, to, kind, data),
    callPull: async (cid, after) => FR_('callPull', cid, after),
    iceServers: async () => FR_('iceServers'),
    callSay: async (cid, b) => FR_('callSay', cid, String(b || '').slice(0, 500)),
    callMsgs: async (cid, after) => FR_('callMsgs', cid, after),
    presencePing: async st => FR_('presencePing', st),
    // avisos: no navegador/PWA usa o selo do app (quando o navegador suporta); bandeja só existe no app do Windows
    setBadge: n => { try { if (navigator.setAppBadge) { if (+n > 0) navigator.setAppBadge(+n).catch(() => {}); else navigator.clearAppBadge().catch(() => {}); } } catch {} },
    flash: () => {},
    trayGet: async () => false, traySet: async () => false,
    screenSources: async () => null,   // no navegador, a escolha de tela/janela é feita pelo próprio navegador (getDisplayMedia)
    audioStart: async () => ({ error: 'O som só pode ser compartilhado no app do Windows.' }), audioStop: async () => true, onAudioPcm: () => {}, onAudioEnd: () => {},
    presenceOff: async () => FR_('presenceOff'),
    postImage: async p => FR_('getShot', p),
    postDelete: async id => FR_('postDelete', id),
    shotShare: async () => ({ error: 'Compartilhar screenshots só está disponível no app do Windows.' }),
    cloudUsername: async () => { const { x } = curP(); if (!x || !x.cloud) return { error: 'Sem conta ligada.', code: 'NO_LINK' }; const c = cloudFor(x.id); if (!c) return { error: 'Serviço não configurado.', code: 'CONFIG' }; try { return { username: await c.getUsername() }; } catch (e) { return cerr(e); } },
    cloudSetUsername: async u => { const { x } = curP(); if (!x || !x.cloud) return { error: 'Sem conta ligada.', code: 'NO_LINK' }; const c = cloudFor(x.id); if (!c) return { error: 'Serviço não configurado.', code: 'CONFIG' }; try { return { username: await c.setUsername(u) }; } catch (e) { return cerr(e); } },
    cloudRecover: async email => { const c = cloudFor(null); if (!c) return { error: 'Serviço não configurado.', code: 'CONFIG' }; try { await c.recover(String(email || '').trim(), webUrl()); return { ok: true }; } catch (e) { return cerr(e); } },
    cloudReset: async () => ({ error: 'Use o link enviado por e-mail.' }),
    cloudPending: () => PENDING,                                   // chegou pelo link do e-mail?
    cloudNewPassword: async pw => {
      const c = cloudFor(null); if (!c || !pending) return { error: 'Link expirado. Peça um novo.' };
      try { await c.setPassword(String(pw || '')); return { ok: true, userId: pending.user.id, email: pending.user.email }; } catch (e) { return cerr(e); }
    },
    cloudAttach: async () => { const { p, x } = curP(); if (!x || !pending) return false; x.cloud = { userId: pending.user.id, email: pending.user.email }; writeP(p); J.set(sessKey(x.id), pending); pending = null; return true; },
    cloudEnter: async () => {
      if (!pending) return { error: 'Faça login primeiro.' };
      const p = readP(), uid = pending.user.id, email = pending.user.email;
      let x = p.profiles.find(y => y.cloud && y.cloud.userId === uid), created = false;
      if (!x) { x = { id: uuid(), name: (pendingName || email.split('@')[0] || 'Jogador').slice(0, 40), photo: '', createdAt: Date.now(), cloud: { userId: uid, email } }; p.profiles.push(x); created = true; }
      pendingName = '';
      p.last = x.id; writeP(p); J.set(sessKey(x.id), pending); pending = null; PENDING = null;
      return { profileId: x.id, created };
    },
    cloudPull: async since => {
      const { x } = curP(); if (!x || !x.cloud) return { error: 'Sem conta ligada.', code: 'NO_LINK' };
      const c = cloudFor(x.id); if (!c) return { error: 'Serviço não configurado.', code: 'CONFIG' };
      try { const r = await c.pull(since || null); if (r.userId !== x.cloud.userId) return { error: 'A sessão é de outra conta.', code: 'NO_SESSION' }; return r; } catch (e) { return cerr(e); }
    },
    cloudPush: async payload => {
      const { x } = curP(); if (!x || !x.cloud) return { error: 'Sem conta ligada.', code: 'NO_LINK' };
      const c = cloudFor(x.id); if (!c) return { error: 'Serviço não configurado.', code: 'CONFIG' };
      try { const r = await c.push(payload || {}); return { ok: true, covers: r.covers || {} }; } catch (e) { return cerr(e); }
    },
    cloudCover: async path => {
      const { x } = curP(); if (!x || !x.cloud) return { error: 'Sem conta ligada.', code: 'NO_LINK' };
      const c = cloudFor(x.id); if (!c) return { error: 'Serviço não configurado.', code: 'CONFIG' };
      try { return { data: await c.getCover(path) }; } catch (e) { return cerr(e); }
    },
    cloudSignOut: async () => { const { p, x } = curP(); if (!x) return false; delete x.cloud; writeP(p); J.del(sessKey(x.id)); return true; },
  };
  window.api = API;
  document.documentElement.classList.add('web');

  // ---------- inicialização assíncrona (o app só começa depois disso) ----------
  window.MGBoot = async function () {
    // 1) link do e-mail (recuperar senha / confirmar cadastro): tokens vêm no #hash
    const h = location.hash || '';
    if (/access_token=|error=/.test(h)) {
      const q = new URLSearchParams(h.replace(/^#/, ''));
      try { history.replaceState(null, '', location.pathname + location.search); } catch {}
      if (q.get('error')) PENDING = { type: 'error', message: /expired|invalid/i.test((q.get('error_description') || '') + q.get('error_code')) ? 'Esse link expirou ou já foi usado. Peça um novo.' : (q.get('error_description') || 'Link inválido.') };
      else { try { const c = cloudFor(null), r = c && await c.fromHash(h); if (r) { pending = r.session; PENDING = { type: r.type === 'recovery' ? 'recovery' : 'signup', email: r.session.user.email }; } } catch (e) { PENDING = { type: 'error', message: String(e.message || e) }; } }
    }
    // 2) dados do perfil aberto (se a aba foi recarregada)
    const c = cur();
    if (c) { if (readP().profiles.some(x => x.id === c)) DATA = await idbGet(c); else SS.del('mg-current'); }
    // 3) pedir ao navegador para não apagar os dados locais
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch {}
  };
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) && location.hostname !== 'localhost') window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
})();
