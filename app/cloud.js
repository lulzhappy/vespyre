(function () {
'use strict';
// Funciona no Node (app do Windows) e no navegador (versão web).
const nodeCrypto = typeof module !== 'undefined' && module.exports && typeof require === 'function' ? require('crypto') : null;
const fromB64 = s => { if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64')); const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
const toB64 = u => { if (typeof Buffer !== 'undefined') return Buffer.from(u).toString('base64'); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
const sha1hex = async u => { if (nodeCrypto) return nodeCrypto.createHash('sha1').update(u).digest('hex'); const d = await crypto.subtle.digest('SHA-1', u); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join(''); };
// Cliente mínimo do Supabase (Auth + PostgREST) via fetch. Não depende do Electron.
// Usa SOMENTE a chave pública (publishable / anon). A segurança vem das regras RLS do banco.

const err = (code, message, extra) => Object.assign(new Error(message), { code }, extra || {});

function b64json(s) { try { let t = s.replace(/-/g, '+').replace(/_/g, '/'); while (t.length % 4) t += '='; return JSON.parse(new TextDecoder().decode(fromB64(t))); } catch { return null; } }

// Valida URL e chave. Recusa chaves secretas / service_role (nunca podem ficar num app instalado).
function checkConfig(url, key) {
  url = String(url || '').trim().replace(/\/+$/, ''); key = String(key || '').trim();
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(url)) throw err('CONFIG', 'URL inválida. Use algo como https://xxxx.supabase.co');
  if (!key) throw err('CONFIG', 'Cole a chave pública (publishable / anon).');
  if (/^sb_secret_/i.test(key)) throw err('CONFIG', 'Essa é a chave SECRETA. Nunca use no app. Copie a chave “publishable” (sb_publishable_…) ou “anon”.');
  if (key.split('.').length === 3) {
    const p = b64json(key.split('.')[1]);
    if (!p) throw err('CONFIG', 'Chave não reconhecida.');
    if (p.role === 'service_role') throw err('CONFIG', 'Essa é a chave service_role (secreta). Nunca use no app. Copie a chave “anon” ou “publishable”.');
    if (p.role !== 'anon') throw err('CONFIG', 'Chave não reconhecida (esperado: anon).');
  } else if (!/^sb_publishable_/i.test(key)) throw err('CONFIG', 'Chave não reconhecida. Ela deve começar com sb_publishable_ (ou ser a chave anon).');
  return { url, key };
}

const USER_RE = /^[a-z0-9][a-z0-9_.]{1,18}[a-z0-9]$/;
function checkUsername(u) {
  const n = String(u || '').trim().replace(/^@/, '').toLowerCase();
  if (!n) throw err('AUTH', 'Escolha um nome de usuário.');
  if (n.length < 3 || n.length > 20) throw err('AUTH', 'O nome de usuário precisa ter de 3 a 20 caracteres.');
  if (!USER_RE.test(n)) throw err('AUTH', 'Use só letras, números, “_” e “.” (sem espaços e sem acentos).');
  return n;
}

function friendly(status, body) {
  const code = String((body && (body.error_code || body.code)) || ''), raw = String((body && (body.error_description || body.msg || body.message || body.error)) || '');
  if (/invalid_credentials/.test(code) || /invalid login credentials/i.test(raw)) return 'E-mail ou senha incorretos.';
  if (/email_not_confirmed/.test(code) || /email not confirmed/i.test(raw)) return 'Confirme seu e-mail (link enviado pelo Supabase) e tente entrar de novo.';
  if (/database error saving new user/i.test(raw) || /profiles_username/.test(raw)) return 'Esse nome de usuário já está em uso. Escolha outro.';
  if (/user_already_exists|email_exists/.test(code) || /already registered/i.test(raw)) return 'Esse e-mail já tem conta. Use “Entrar”.';
  if (/weak_password/.test(code) || /password should be/i.test(raw)) return 'Senha fraca. Use pelo menos 6 caracteres (de preferência 8+).';
  if (/signup_disabled/.test(code)) return 'O cadastro está desativado neste projeto do Supabase.';
  if (/otp_expired|invalid.*(token|otp)|expired/i.test(code + raw)) return 'Código inválido ou expirado.';
  if (/same_password/.test(code)) return 'Escolha uma senha diferente da atual.';
  if (/over_.*rate_limit|rate limit/i.test(code + raw) || status === 429) return 'Muitas tentativas. Espere um pouco e tente de novo.';
  if (/validation_failed|invalid.*email/i.test(code + raw)) return 'E-mail inválido.';
  if (status === 404 && /relation|schema cache|table/i.test(raw)) return 'As tabelas não existem no Supabase. Rode o arquivo supabase/schema.sql no SQL Editor.';
  if (/invalid api key|apikey/i.test(raw)) return 'Chave do projeto inválida.';
  return raw || 'Erro ' + status;
}

function createCloud({ url, key, fetchFn, getSession, setSession }) {
  const f = fetchFn || fetch;

  async function call(path, { method = 'GET', body, token, headers, raw } = {}) {
    let r;
    try {
      r = await f(url + path, {
        method,
        headers: { apikey: key, Authorization: 'Bearer ' + (token || key), 'Content-Type': 'application/json', ...(headers || {}) },
        body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) { throw err('NETWORK', 'Sem conexão com o Supabase.'); }
    const text = await r.text(); let j = null;
    if (text) { try { j = JSON.parse(text); } catch { j = null; } }
    if (!r.ok) throw err(r.status === 401 || r.status === 403 ? 'AUTH' : 'HTTP', friendly(r.status, j), { status: r.status, body: j });
    return j;
  }

  const norm = j => ({
    access_token: j.access_token, refresh_token: j.refresh_token,
    expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600),
    user: { id: j.user.id, email: j.user.email },
  });

  async function usernameAvailable(u) {
    try { return (await call('/rest/v1/rpc/username_available', { method: 'POST', body: { u } })) === true; }
    catch (e) { if (e.code === 'NETWORK') throw e; throw err('HTTP', 'O Supabase ainda não tem o recurso de nome de usuário. Rode de novo o supabase/schema.sql no SQL Editor.'); }
  }
  async function signUp(email, password, username) {
    const un = checkUsername(username);
    if (!(await usernameAvailable(un))) throw err('AUTH', 'Esse nome de usuário já está em uso. Escolha outro.');
    const j = await call('/auth/v1/signup', { method: 'POST', body: { email, password, data: { username: un } } });
    if (j && j.access_token && j.user) return { session: norm(j), needsConfirm: false, username: un };
    const u = j && (j.user || j);
    if (u && Array.isArray(u.identities) && u.identities.length === 0) throw err('AUTH', 'Esse e-mail já tem conta. Use “Entrar”.');
    return { session: null, needsConfirm: true };
  }
  async function getUsername() {
    const s = await valid();
    const r = await rest('/rest/v1/profiles?select=username&id=eq.' + encodeURIComponent(s.user.id));
    return (r && r[0] && r[0].username) || '';
  }
  async function setUsername(u) {
    const un = checkUsername(u);
    if ((await rest('/rest/v1/rpc/set_username', { method: 'POST', body: { u: un } })) !== true) throw err('AUTH', 'Esse nome de usuário já está em uso. Escolha outro.');
    return un;
  }
  // ---- amigos ----
  const rpc = (name, body) => rest('/rest/v1/rpc/' + name, { method: 'POST', body: body || {} }).catch(e => {
    if (e.status === 404) throw err('HTTP', 'O Supabase ainda não tem o recurso de amigos. Rode de novo o supabase/schema.sql no SQL Editor.');
    if (/not_friends/.test(JSON.stringify(e.body || ''))) throw err('HTTP', 'Vocês ainda não são amigos.');
    { const b = JSON.stringify(e.body || ''), M = { wrong_password: 'Senha incorreta.', friends_only: 'Essa sala é só para amigos de quem criou.', room_not_found: 'Essa sala não existe mais.', password_required: 'Sala privada precisa de uma senha (mín. 3 caracteres).', too_many_rooms: 'Você já tem 10 salas. Apague alguma para criar outra.', room_mode_taken: 'Você já tem uma sala desse tipo. Cada pessoa pode ter 1 pública, 1 privada e 1 de amigos — apague a antiga para criar outra.', invalid_name: 'Dê um nome para a sala.', not_in_room: 'Você não está mais nessa sala.', not_in_call: 'Você não está mais nessa chamada.', invalid_bug: 'Descreva o problema com pelo menos 5 caracteres.', too_many_bugs: 'Você já enviou 10 relatos na última hora. Tente de novo mais tarde.', not_allowed: 'Você não tem acesso a isso.' };
      for (const k in M) if (b.includes(k)) throw err('HTTP', M[k]); }
    throw e;
  });
  const friendsList = async () => (await rpc('friends_list')).map(r => ({ id: r.id, username: r.username || '', name: r.display_name || r.username || 'Jogador', photo: r.photo || '', status: r.status === 'accepted' ? 'accepted' : r.direction }));
  const friendAdd = async u => {
    const un = String(u || '').trim().replace(/^@/, '').toLowerCase();
    if (!un) throw err('AUTH', 'Digite o nome de usuário do seu amigo.');
    return { result: await rpc('friend_request', { u: un }) };
  };
  const friendRespond = async (id, accept) => { await rpc('friend_respond', { other: id, accept: !!accept }); return true; };
  const friendRemove = async id => { await rpc('friend_remove', { other: id }); return true; };
  const friendGames = id => rpc('friend_games', { other: id });
  const timeline = () => rpc('timeline_feed', { lim: 80 });
  const likeToggle = (o, gid) => rpc('like_toggle', { o, gid: String(gid) });
  const friendsNow = () => rpc('friends_now');
  const playersNow = () => rpc('players_now');
  const profilePreview = id => rpc('profile_preview', { other: id });
  const msgSend = (id, body) => rpc('msg_send', { other: id, body });
  const msgThread = id => rpc('msg_thread', { other: id, lim: 150 });
  const msgInbox = () => rpc('msg_inbox');
  // presence_status (com Online/Ocupado/Offline) — se o servidor ainda não tiver, cai para o presence_ping antigo
  let noStatus = false;
  const presencePing = async st => {
    if (!noStatus) {
      try { return await rest('/rest/v1/rpc/presence_status', { method: 'POST', body: { st: ['online', 'busy', 'off'].includes(st) ? st : 'online' } }); }
      catch (e) { if (e.status !== 404) throw e; noStatus = true; }
    }
    return rpc('presence_ping');
  };
  // relatos de bug (só o admin lê)
  const bugSend = (body, ctx) => rpc('bug_send', { body, ctx: ctx || {} });
  const bugAdmin = async () => { try { return (await rest('/rest/v1/rpc/bug_is_admin', { method: 'POST', body: {} })) === true; } catch { return false; } };
  const bugList = () => rpc('bug_list');
  const bugMark = (id, d) => rpc('bug_mark', { bid: id, d: !!d });
  const bugDelete = id => rpc('bug_delete', { bid: id });
  const roomList = () => rpc('room_list');
  const roomCreate = (n, m, pw) => rpc('room_create', { n, m, pw: pw || null });
  const roomJoin = (id, pw) => rpc('room_join', { rid: id, pw: pw || null });
  const roomLeave = id => rpc('room_leave', { rid: id });
  const roomState = (id, after) => rpc('room_state', { rid: id, after: after || 0 });
  const roomSay = (id, body) => rpc('room_say', { rid: id, body });
  const roomSignal = (id, to, kind, data) => rpc('room_signal', { rid: id, recip: to, k: kind, d: data || {} });
  const roomPull = (id, after) => rpc('room_pull', { rid: id, after: after || 0 });
  const roomInvite = (id, ids) => rpc('room_invite', { rid: id, ids });
  const roomDelete = id => rpc('room_delete', { rid: id });
  const callStart = ids => rpc('call_start', { invitees: ids });
  const callInvite = (cid, ids) => rpc('call_invite', { cid, invitees: ids });
  const callJoin = cid => rpc('call_join', { cid });
  const callLeave = (cid, decline) => rpc('call_leave', { cid, decline: !!decline });
  const callState = () => rpc('call_state');
  const callList = () => rpc('call_list');
  // jogo/música atual (null apaga). Servidor antigo sem a função: ignora.
  const activitySet = a => rest('/rest/v1/rpc/activity_set', { method: 'POST', body: { a: a || null } }).catch(e => { if (e.status === 404) return false; throw e; });
  // mudo/som: se o servidor ainda não tiver a função, ignora (só o ícone não aparece para os outros)
  const flags = (fn, k, id, mic, snd) => rest('/rest/v1/rpc/' + fn, { method: 'POST', body: { [k]: id, mic: !!mic, snd: !!snd } }).catch(e => { if (e.status === 404) return false; throw e; });
  const callFlags = (id, mic, snd) => flags('call_flags', 'cid', id, mic, snd);
  const roomFlags = (id, mic, snd) => flags('room_flags', 'rid', id, mic, snd);
  const callSignal = (cid, to, kind, data) => rpc('call_signal', { cid, recip: to, k: kind, d: data || {} });
  const callPull = (cid, after) => rpc('call_pull', { cid, after: after || 0 });
  // servidores TURN: 1º a Edge Function "turn" (Cloudflare, senhas temporárias); se ela não existir, a lista fixa de app_config
  const iceServers = async () => {
    try {
      const r = await f(url + '/functions/v1/turn', { method: 'POST', headers: { apikey: key, Authorization: 'Bearer ' + (await accessToken()), 'Content-Type': 'application/json' }, body: '{}' });
      if (r.ok) { const j = await r.json(); if (j && Array.isArray(j.iceServers) && j.iceServers.length) return j.iceServers; }
    } catch {}
    try { const L = await rpc('ice_servers'); return Array.isArray(L) ? L : []; } catch { return []; }
  };
  const presenceOff = () => rpc('presence_off');
  const callSay = (cid, body) => rpc('call_say', { cid, body });
  const callMsgs = (cid, after) => rpc('call_msgs', { cid, after: after || 0 });
  async function signIn(email, password) {
    if (!String(email).includes('@')) {   // entrou com nome de usuário: descobre o e-mail da conta
      let em = null;
      try { em = await call('/rest/v1/rpc/email_for_username', { method: 'POST', body: { u: email } }); }
      catch (e) { if (e.code === 'NETWORK') throw e; throw err('HTTP', 'Para entrar com o usuário, rode de novo o supabase/schema.sql no SQL Editor.'); }
      if (!em) throw err('AUTH', 'Usuário ou senha incorretos.');
      email = em;
    }
    const j = await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
    return { session: norm(j), needsConfirm: false };
  }
  async function refresh(s) {
    try { return norm(await call('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: s.refresh_token } })); }
    catch (e) { if (e.code === 'NETWORK') throw e; throw err('NO_SESSION', 'Sessão expirada. Entre de novo.'); }
  }
  async function valid() {
    let s = getSession();
    if (!s) throw err('NO_SESSION', 'Entre na sua conta para sincronizar.');
    if (s.expires_at - 60 < Date.now() / 1000) { s = await refresh(s); setSession(s); }
    return s;
  }
  async function rest(path, opt) {
    let s = await valid();
    try { return await call(path, { ...opt, token: s.access_token }); }
    catch (e) {
      if (e.status !== 401) throw e;
      s = await refresh(s); setSession(s);              // token recusado: renova uma vez e repete
      return call(path, { ...opt, token: s.access_token });
    }
  }

  // ---- dados ----
  const PAGE = 1000;
  async function pull(since) {
    const s = await valid(), uid = s.user.id, games = [];
    let q = '';
    if (since) { const t = Date.parse(since); if (!isNaN(t)) q = '&synced_at=gte.' + encodeURIComponent(new Date(t - 60000).toISOString()); }  // folga de 1 min; a mescla é idempotente
    for (let off = 0; off < 100000; off += PAGE) {
      const rows = await rest(`/rest/v1/games?select=id,data,updated_at,deleted,synced_at&order=synced_at.asc,id.asc&limit=${PAGE}&offset=${off}${q}`);
      games.push(...rows);
      if (rows.length < PAGE) break;
    }
    const pr = await rest(`/rest/v1/profiles?select=display_name,photo,settings,settings_at&id=eq.${encodeURIComponent(uid)}`);
    return { games, profile: pr[0] || null, userId: uid };
  }
  // ---- capas no Storage (bucket privado "covers", pasta = id da conta) ----
  const sent = new Map();                  // path -> hash já enviado nesta sessão
  let storageOffUntil = 0;                 // se o Storage falhar (ex.: SQL não rodado), mantém a capa dentro do jogo por um tempo
  const parseData = u => { const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(u || ''); if (!m) return null; try { return { type: m[1], buf: fromB64(m[2]) }; } catch { return null; } };
  const safeName = id => String(id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60);
  async function putCover(uid, name, dataUrl) {
    const p = parseData(dataUrl);
    if (!p || p.buf.length > 1000000 || Date.now() < storageOffUntil) return null;
    const hash = (await sha1hex(p.buf)).slice(0, 12), path = uid + '/' + name;
    if (sent.get(path) === hash) return { path, hash };
    try { await rest('/storage/v1/object/covers/' + path, { method: 'POST', raw: p.buf, headers: { 'Content-Type': p.type, 'x-upsert': 'true' } }); }
    catch (e) { if (e.code === 'NETWORK' || e.code === 'NO_SESSION') throw e; storageOffUntil = Date.now() + 10 * 60000; return null; }
    sent.set(path, hash);
    return { path, hash };
  }
  async function getCover(path, bucket = 'covers') {
    const s = await valid();
    if (!/^[0-9a-fA-F-]{36}\/[A-Za-z0-9_-]+$/.test(String(path))) throw err('HTTP', 'Capa inválida.');   // o servidor só libera a própria pasta e a de amigos
    const go = async t => f(url + '/storage/v1/object/authenticated/' + bucket + '/' + path, { headers: { apikey: key, Authorization: 'Bearer ' + t } });
    let r; try { r = await go(s.access_token); } catch { throw err('NETWORK', 'Sem conexão com o Supabase.'); }
    if (r.status === 401) { const n = await refresh(s); setSession(n); r = await go(n.access_token); }
    if (!r.ok) throw err('HTTP', 'Capa indisponível (' + r.status + ').');
    const type = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
    return 'data:' + type + ';base64,' + toB64(new Uint8Array(await r.arrayBuffer()));
  }
  // ---- mensagens de áudio (bucket privado "voice") ----
  async function msgAudio(id, buf, mime, secs) {
    const s = await valid(), uid = s.user.id;
    if (!buf || !buf.length || buf.length > 1950000) throw err('HTTP', 'O áudio ficou grande demais (máx. ~1 min).');
    const ext = /ogg/.test(mime) ? 'ogg' : /mp4|m4a|aac/.test(mime) ? 'm4a' : 'webm';
    const type = /ogg/.test(mime) ? 'audio/ogg' : /mp4|m4a|aac/.test(mime) ? 'audio/mp4' : 'audio/webm';
    const path = uid + '/v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    try { await rest('/storage/v1/object/voice/' + path, { method: 'POST', raw: buf, headers: { 'Content-Type': type, 'x-upsert': 'true' } }); }
    catch (e) { if (e.code === 'NETWORK' || e.code === 'NO_SESSION') throw e; throw err('HTTP', 'Não consegui enviar o áudio. Rode de novo o supabase/schema.sql no SQL Editor.'); }
    try { return await rpc('msg_send_audio', { other: id, path, secs: Math.round(+secs || 0) }); }
    catch (e) { try { await rest('/storage/v1/object/voice/' + path, { method: 'DELETE' }); } catch {} throw e; }
  }
  const getVoice = path => getCover(path, 'voice');
  // ---- screenshots compartilhadas (bucket privado "shots") ----
  const getShot = path => getCover(path, 'shots');
  async function sharePost(buf, game, caption) {
    const s = await valid(), uid = s.user.id;
    if (!buf || !buf.length || buf.length > 2900000) throw err('HTTP', 'A imagem ficou grande demais para enviar.');
    const path = uid + '/s' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    try { await rest('/storage/v1/object/shots/' + path, { method: 'POST', raw: buf, headers: { 'Content-Type': 'image/jpeg', 'x-upsert': 'true' } }); }
    catch (e) { if (e.code === 'NETWORK' || e.code === 'NO_SESSION') throw e; throw err('HTTP', 'Não consegui enviar a imagem. Rode de novo o supabase/schema.sql no SQL Editor (falta o armazenamento de screenshots).'); }
    try { await rpc('post_create', { g: String(game || ''), c: String(caption || ''), path }); }
    catch (e) { try { await rest('/storage/v1/object/shots/' + path, { method: 'DELETE' }); } catch {} throw e; }
    return true;
  }
  async function postDelete(id) {
    const pth = await rpc('post_delete', { pid: id });
    if (pth) { try { await rest('/storage/v1/object/shots/' + pth, { method: 'DELETE' }); } catch {} }
    return !!pth;
  }
  async function dropCover(uid, name) { try { await rest('/storage/v1/object/covers/' + uid + '/' + name, { method: 'DELETE' }); } catch {} }

  async function push({ games, profile }) {
    const s = await valid(), uid = s.user.id, covers = {};
    games = (games || []).map(g => ({ ...g }));
    for (const g of games) {
      const name = 'g-' + safeName(g.id);
      if (g.deleted) { await dropCover(uid, name); continue; }
      if (g.data && typeof g.data.cover === 'string' && g.data.cover.startsWith('data:')) {
        const c = await putCover(uid, name, g.data.cover);
        if (c) { g.data = { ...g.data, coverPath: c.path, coverHash: c.hash }; delete g.data.cover; covers[g.id] = c; }
      }
    }
    if (profile && profile.settings && Array.isArray(profile.settings.wish)) {
      const wish = [];
      for (const w of profile.settings.wish) {
        if (w && typeof w.cover === 'string' && w.cover.startsWith('data:')) {
          const c = await putCover(uid, 'w-' + safeName(w.id), w.cover);
          if (c) { const { cover, ...rest2 } = w; wish.push({ ...rest2, coverPath: c.path, coverHash: c.hash }); covers['w:' + w.id] = c; continue; }
        }
        wish.push(w);
      }
      profile = { ...profile, settings: { ...profile.settings, wish } };
    }
    for (let i = 0; i < (games || []).length; i += 15) {
      const rows = games.slice(i, i + 15).map(g => ({ user_id: uid, id: String(g.id), data: g.data || {}, updated_at: Math.round(g.updated_at || 0), deleted: !!g.deleted }));
      await rest('/rest/v1/games?on_conflict=user_id,id', { method: 'POST', body: rows, headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
    }
    if (profile) await rest('/rest/v1/profiles?on_conflict=id', { method: 'POST', body: [{ id: uid, display_name: profile.display_name, photo: profile.photo || '', settings: profile.settings || {}, settings_at: Math.round(profile.settings_at || 0) }], headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
    return { covers };
  }
  // Recuperar senha sem página web: o e-mail leva um CÓDIGO (modelo de e-mail com {{ .Token }}), que é trocado por sessão.
  async function recover(email, redirectTo) { await call('/auth/v1/recover' + (redirectTo ? '?redirect_to=' + encodeURIComponent(redirectTo) : ''), { method: 'POST', body: { email } }); return true; }
  // Link do e-mail (recuperar senha / confirmar cadastro): o Supabase devolve os tokens no #hash da página.
  async function fromHash(hash) {
    const q = new URLSearchParams(String(hash || '').replace(/^#/, '')), at = q.get('access_token'), rt = q.get('refresh_token');
    if (!at || !rt) return null;
    const u = await call('/auth/v1/user', { token: at });
    return { type: q.get('type') || '', session: norm({ access_token: at, refresh_token: rt, expires_at: +q.get('expires_at') || 0, expires_in: +q.get('expires_in') || 3600, user: u }) };
  }
  async function verifyRecovery(email, token) {
    const j = await call('/auth/v1/verify', { method: 'POST', body: { type: 'recovery', email, token: String(token).trim() } });
    if (!j || !j.access_token) throw err('AUTH', 'Código inválido ou expirado.');
    return { session: norm(j) };
  }
  async function setPassword(password) { const s = await valid(); await call('/auth/v1/user', { method: 'PUT', body: { password }, token: s.access_token }); return true; }
  async function accessToken() { return (await valid()).access_token; }
  return { activitySet, callList, callFlags, roomFlags, bugSend, bugAdmin, bugList, bugMark, bugDelete, friendsList, friendAdd, friendRespond, friendRemove, friendGames, timeline, likeToggle, friendsNow, playersNow, profilePreview, msgSend, msgThread, msgInbox, presencePing, presenceOff, callSay, callMsgs, msgAudio, getVoice, roomList, roomCreate, roomJoin, roomLeave, roomState, roomSay, roomSignal, roomPull, roomInvite, roomDelete, callStart, callInvite, callJoin, callLeave, callState, callSignal, callPull, iceServers, sharePost, postDelete, getShot, signUp, signIn, usernameAvailable, getUsername, setUsername, pull, push, recover, verifyRecovery, setPassword, accessToken, getCover, fromHash };
}

const API = { createCloud, checkConfig };
if (typeof module !== 'undefined' && module.exports) module.exports = API; else globalThis.MGCloud = API;

})();
