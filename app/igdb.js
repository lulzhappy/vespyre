(function () {
// Consulta a IGDB direto do computador (sem servidor). Chaves vêm do config local.
let token = null, expires = 0, tokenFor = '';

async function getToken({ clientId, clientSecret }) {
  if (token && Date.now() < expires && tokenFor === clientId) return token;
  const r = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&grant_type=client_credentials`,
    { method: 'POST' }
  );
  if (!r.ok) throw new Error('Chaves inválidas ou Twitch indisponível (' + r.status + ')');
  const j = await r.json();
  token = j.access_token; tokenFor = clientId;
  expires = Date.now() + (j.expires_in - 600) * 1000;
  return token;
}

// limite da IGDB: 4 pedidos por segundo. Antes cada pedido esperava 270 ms pelo anterior (as buscas "paralelas" iam em fila);
// agora até 4 saem juntos e só o 5º em diante espera.
const recent = [];
async function throttle() {
  for (;;) {
    const now = Date.now();
    while (recent.length && now - recent[0] >= 1050) recent.shift();
    if (recent.length < 4) { recent.push(now); return; }
    await new Promise(r => setTimeout(r, 1050 - (now - recent[0]) + 5));
  }
}

// várias consultas numa viagem só ao servidor (a função "igdb" nova aceita {queries:[...]}); se for a antiga, faz uma por uma
let noBatch = false;
async function igdbMany(list, cfg) {
  if (cfg.proxyBatch && !noBatch) {
    try {
      await throttle();
      const r = await cfg.proxyBatch(list.map(([endpoint, query]) => ({ endpoint, query })));
      if (r.ok) {
        const j = await r.json();
        if (Array.isArray(j) && j.length === list.length) return j.map(x => x && x.ok ? { status: 'fulfilled', value: x.data } : { status: 'rejected', reason: new Error('IGDB: ' + ((x && x.error) || 'erro')) });
      }
      if (r.status === 400 || r.status === 404) noBatch = true; else if (r.status === 401) throw new Error('Sessão expirada. Saia e entre na conta de novo.');
    } catch (e) { if (/Sessão expirada/.test(e.message)) throw e; }
  }
  return Promise.allSettled(list.map(([e, q]) => igdb(e, q, cfg)));
}

async function igdb(endpoint, body, cfg, retry = true) {
  await throttle();
  if (cfg.proxy) {                       // modo conta: a busca passa pelo servidor (Supabase), que guarda as chaves
    const r = await cfg.proxy(endpoint, body);
    if (r.status === 429 && retry) { await new Promise(x => setTimeout(x, 1200)); return igdb(endpoint, body, cfg, false); }
    if (r.status === 401) throw new Error('Sessão expirada. Saia e entre na conta de novo.');
    if (r.status === 404) throw new Error('A busca de jogos ainda não foi publicada no servidor.');
    if (!r.ok) {
      let m = ''; try { m = (await r.json()).error || ''; } catch {}
      throw new Error('IGDB ' + endpoint + ': ' + r.status + (m ? ' — ' + m : ''));   // mostra o motivo que o servidor informou
    }
    return r.json();
  }
  const t = await getToken(cfg);
  const r = await fetch('https://api.igdb.com/v4/' + endpoint, {
    method: 'POST',
    headers: { 'Client-ID': cfg.clientId, Authorization: 'Bearer ' + t, Accept: 'application/json' },
    body,
  });
  if (r.status === 429 && retry) { await new Promise(x => setTimeout(x, 1200)); return igdb(endpoint, body, cfg, false); }
  if (!r.ok) throw new Error('IGDB ' + endpoint + ': ' + r.status);
  return r.json();
}

function mapPlatform(n = '') {
  if (/playstation 5/i.test(n)) return 'PS5';
  if (/playstation 4/i.test(n)) return 'PS4';
  if (/playstation 3/i.test(n)) return 'PS3';
  if (/vita/i.test(n)) return 'PS Vita';
  if (/switch 2/i.test(n)) return 'Nintendo Switch 2';
  if (/switch/i.test(n)) return 'Nintendo Switch 1';
  if (/wii u/i.test(n)) return 'Wii U';
  if (/3ds/i.test(n)) return 'Nintendo 3DS';
  if (/windows|^pc/i.test(n)) return 'PC - Steam';
  if (/xbox/i.test(n)) return 'Xbox';
  return null;
}

// buscas repetidas (apagar e digitar de novo, abrir o mesmo jogo) saem do cache na hora
const sCache = new Map(), sFlight = new Map(), S_TTL = 15 * 60 * 1000;
let noFX = false;
async function search(q, cfg) {
  const key = String(q || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const hit = sCache.get(key);
  if (hit && Date.now() - hit.t < S_TTL) return hit.v;
  if (sFlight.has(key)) return sFlight.get(key);
  const p = (async () => {
    const FX = ',collections.name,franchises.name';
    let v;
    if (noFX) v = await searchWith(q, cfg, '');
    else { try { v = await searchWith(q, cfg, FX); } catch (e) { noFX = true; v = await searchWith(q, cfg, ''); } }
    sCache.set(key, { t: Date.now(), v }); if (sCache.size > 200) sCache.delete(sCache.keys().next().value);
    return v;
  })();
  sFlight.set(key, p);
  try { return await p; } finally { sFlight.delete(key); }
}

// tempo para zerar: buscado DEPOIS de mostrar os resultados (não atrasa a lista); fica guardado por jogo
const bCache = new Map();
async function beats(ids, cfg) {
  ids = [...new Set((ids || []).map(Number).filter(Boolean))];
  const out = {}, need = ids.filter(id => { if (bCache.has(id)) { out[id] = bCache.get(id); return false; } return true; });
  if (need.length) {
    const t = await igdb('game_time_to_beats', `fields game_id,normally,hastily; where game_id = (${need.join(',')}); limit 50;`, cfg);
    need.forEach(id => bCache.set(id, ''));
    t.forEach(x => { const s = x.normally || x.hastily; if (s) bCache.set(x.game_id, Math.round((s / 3600) * 2) / 2); });
    need.forEach(id => { out[id] = bCache.get(id); });
  }
  return out;
}

async function searchWith(q, cfg, FX) {
  q = String(q || '').trim().slice(0, 80).replace(/["\\]/g, '');
  if (q.length < 2) return [];
  const F = 'fields name,first_release_date,summary,genres.name,platforms.name,cover.image_id,total_rating_count,version_parent' + FX + ';';
  const words = q.split(/\s+/).filter(Boolean);
  const where = words.map(w => `name ~ *"${w}"*`).join(' & ');
  // duas buscas juntas (numa viagem só, se o servidor aceitar): busca textual da IGDB + nome que CONTÉM o texto digitado
  const [a, b] = await igdbMany([
    ['games', `search "${q}"; ${F} limit 25;`],
    ['games', `${F} where ${where}; sort total_rating_count desc; limit 25;`],
  ], cfg);
  if (a.status === 'rejected' && b.status === 'rejected') throw a.reason;
  const byId = new Map();
  [...(a.value || []), ...(b.value || [])].forEach(g => byId.set(g.id, g));

  const ql = q.toLowerCase();
  const rank = g => {
    const n = (g.name || '').toLowerCase();
    let r = n === ql ? 1000 : n.startsWith(ql) ? 500 : words.every(w => n.includes(w.toLowerCase())) ? 200 : 0;
    r += Math.min(g.total_rating_count || 0, 300) / 3; // jogos populares primeiro
    if (g.version_parent) r -= 40;                      // edições/ports depois do jogo principal
    if (!g.cover) r -= 30;
    return r;
  };
  const games = [...byId.values()].sort((x, y) => rank(y) - rank(x)).slice(0, 10);

  // o tempo para zerar NÃO segura mais a lista: começa a buscar agora (fica no cache) e o app pega ao escolher o jogo
  beats(games.map(g => g.id), cfg).catch(() => {});
  return games.map(g => ({
    id: g.id,
    title: g.name,
    year: g.first_release_date ? new Date(g.first_release_date * 1000).getUTCFullYear() : '',
    genre: g.genres?.[0]?.name || '',
    platforms: [...new Set((g.platforms || []).map(p => mapPlatform(p.name)).filter(Boolean))],
    hours: bCache.get(g.id) || '',
    summary: g.summary || '',
    fr: g.collections?.[0] ? { kind: 'c', id: g.collections[0].id, name: g.collections[0].name }
      : g.franchises?.[0] ? { kind: 'f', id: g.franchises[0].id, name: g.franchises[0].name } : null,
    cover: g.cover?.image_id ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${g.cover.image_id}.jpg` : '',
  }));
}


// Jogos de uma franquia/série (sem DLC, pacotes, ports, edições, VR e jogos sem data)
async function franchiseGames(kind, id, cfg) {
  const field = kind === 'c' ? 'collections' : 'franchises';
  const base = 'name,first_release_date,cover.image_id,platforms.name,player_perspectives.name,version_parent';
  const q = f => `fields ${base},${f}; where ${field} = (${Number(id)}); sort first_release_date asc; limit 100;`;
  let rows;
  try { rows = await igdb('games', q('game_type'), cfg); } catch (e) { rows = await igdb('games', q('category'), cfg); }
  const OK = new Set([0, 4, 8, 10]); // jogo principal, standalone, remake, expandido
  const typeOf = g => { const t = g.game_type ?? g.category; return t && typeof t === 'object' ? t.id : t; };
  const VRP = /\bVR\b|oculus|quest|vive|mixed reality|steamvr|index/i;
  const isVR = g =>
    (g.player_perspectives || []).some(p => /virtual reality/i.test(p.name)) ||
    /\bVR\b|virtual reality/i.test(g.name || '') ||
    ((g.platforms || []).length > 0 && g.platforms.every(p => VRP.test(p.name)));
  const now = Date.now() / 1000;
  return rows
    .filter(g => g.first_release_date && !g.version_parent && (typeOf(g) == null || OK.has(typeOf(g))) && !isVR(g))
    .map(g => ({
      id: g.id,
      title: g.name,
      year: new Date(g.first_release_date * 1000).getUTCFullYear(),
      cover: g.cover?.image_id ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${g.cover.image_id}.jpg` : '',
      upcoming: g.first_release_date > now,
      remake: typeOf(g) === 8,
    }));
}


// Descobre franquia (e id da IGDB) de jogos já cadastrados. Itens que falharem por rede ficam de fora do resultado.
const normT = t => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
const frOf = g => g.collections?.[0] ? { kind: 'c', id: g.collections[0].id, name: g.collections[0].name }
  : g.franchises?.[0] ? { kind: 'f', id: g.franchises[0].id, name: g.franchises[0].name } : null;
const yearOf = g => g.first_release_date ? new Date(g.first_release_date * 1000).getUTCFullYear() : '';
const infoOf = g => ({ igdbId: g.id, fr: frOf(g), genre: g.genres?.[0]?.name || '', year: yearOf(g) });

async function enrich(items, cfg) {
  const out = {};
  const F = 'fields name,first_release_date,genres.name,collections.name,franchises.name,total_rating_count,version_parent;';
  const withId = items.filter(i => Number(i.igdbId));
  if (withId.length) {
    const rows = await igdb('games', `${F} where id = (${withId.map(i => Number(i.igdbId)).join(',')}); limit 500;`, cfg);
    const m = new Map(rows.map(r => [String(r.id), r]));
    withId.forEach(i => { const r = m.get(String(i.igdbId)); out[i.id] = r ? infoOf(r) : { igdbId: i.igdbId, fr: null }; });
  }
  for (const i of items.filter(i => !Number(i.igdbId))) {
    try {
      const q = String(i.title || '').trim().slice(0, 80).replace(/["\\]/g, '');
      if (q.length < 2) { out[i.id] = { igdbId: '', fr: null }; continue; }
      const rows = await igdb('games', `search "${q}"; ${F} limit 12;`, cfg);
      const n = normT(i.title), y0 = Number(i.year) || 0;
      let c = rows.filter(r => normT(r.name) === n);
      if (!c.length && y0) c = rows.filter(r => { const y = yearOf(r); const rn = normT(r.name); return y && Math.abs(y - y0) <= 1 && (rn.includes(n) || n.includes(rn)); });
      const yd = r => (y0 && yearOf(r)) ? Math.abs(yearOf(r) - y0) : 0;
      c.sort((a, b) => yd(a) - yd(b) || (a.version_parent ? 1 : 0) - (b.version_parent ? 1 : 0) || (b.total_rating_count || 0) - (a.total_rating_count || 0));
      const pick = c.length ? (c.find(r => yd(r) === yd(c[0]) && frOf(r)) || c[0]) : null;
      out[i.id] = pick ? infoOf(pick) : { igdbId: '', fr: null };
    } catch (e) {
      if (/\b40[13]\b|inválid/i.test(String(e.message))) throw e;
    }
  }
  return out;
}

// Sugestões: jogos bem avaliados dos gêneros informados (o app escolhe um que o usuário ainda não registrou)
const PLAT_IDS = { 'PC': [6], 'Mac': [14], 'Linux': [3], 'PS5': [167], 'PS4': [48], 'PS3': [9], 'PS2': [8], 'PS1': [7], 'PSP': [38], 'PS Vita': [46],
  'Xbox': [49, 169, 12, 11], 'Xbox Series X|S': [169], 'Xbox One': [49], 'Xbox 360': [12], 'Xbox Original': [11],
  'Nintendo Switch 2': [508], 'Nintendo Switch 1': [130], 'Wii U': [41], 'Wii': [5], 'GameCube': [21], 'Nintendo 64': [4], 'SNES': [19], 'NES': [18],
  'Nintendo 3DS': [37], 'Nintendo DS': [20], 'Game Boy Advance': [24], 'Game Boy Color': [22], 'Game Boy': [33],
  'Mega Drive': [29], 'Saturn': [32], 'Dreamcast': [23], 'Master System': [64], 'Atari 2600': [59], 'Android': [34], 'iOS': [39] };
// nome da plataforma na IGDB -> chave do console (só para as sugestões)
const REC_RX = [['PS5', /playstation 5/i], ['PS4', /playstation 4/i], ['PS3', /playstation 3/i], ['PS2', /playstation 2/i], ['PSP', /playstation portable|^psp$/i], ['PS Vita', /vita/i], ['PS1', /^playstation$/i],
  ['Xbox Series X|S', /series/i], ['Xbox One', /xbox one/i], ['Xbox 360', /xbox 360/i], ['Xbox Original', /^xbox$/i],
  ['Nintendo Switch 2', /switch 2/i], ['Nintendo Switch 1', /switch/i], ['Wii U', /wii u/i], ['Wii', /^wii$/i], ['GameCube', /gamecube/i], ['Nintendo 64', /^nintendo 64/i], ['SNES', /super nintendo|super famicom/i], ['NES', /^nintendo entertainment system|^famicom|^nes$/i],
  ['Nintendo 3DS', /3ds/i], ['Nintendo DS', /^nintendo ds$/i], ['Game Boy Advance', /game boy advance/i], ['Game Boy Color', /game boy color/i], ['Game Boy', /^game boy$/i],
  ['Mega Drive', /mega drive|genesis/i], ['Saturn', /saturn/i], ['Dreamcast', /dreamcast/i], ['Master System', /master system/i], ['Atari 2600', /atari 2600/i],
  ['Mac', /^mac|macos/i], ['Linux', /linux/i], ['Android', /^android/i], ['iOS', /^ios/i], ['PC', /windows|^pc/i]];
const mapRecPlatform = n => { const r = REC_RX.find(([, rx]) => rx.test(n || '')); return r ? r[0] : null; };
async function recommend(genres, cfg, consoles) {
  const names = [...new Set((genres || []).map(g => String(g).replace(/["\\]/g, '').trim()).filter(Boolean))].slice(0, 3);
  if (!names.length) return [];
  const gs = await igdb('genres', `fields name; where name = (${names.map(n => `"${n}"`).join(',')}); limit 10;`, cfg);
  const ids = gs.map(g => g.id);
  if (!ids.length) return [];
  const off = Math.floor(Math.random() * 40);
  const pids = [...new Set((consoles || []).flatMap(c => PLAT_IDS[c] || []))];
  const q = (withPlat, o) => igdb('games', `fields name,first_release_date,summary,genres.name,platforms.name,cover.image_id,total_rating,total_rating_count; where genres = (${ids.join(',')})${withPlat ? ` & platforms = (${pids.join(',')})` : ''} & total_rating_count >= 80 & total_rating >= 75 & version_parent = null & cover != null; sort total_rating_count desc; limit 40; offset ${o};`, cfg);
  let list = await q(pids.length > 0, off);
  if (pids.length && !list.length) list = await q(true, 0);
  return list.map(g => ({
    id: g.id,
    title: g.name,
    year: g.first_release_date ? new Date(g.first_release_date * 1000).getUTCFullYear() : '',
    genres: (g.genres || []).map(x => x.name),
    platforms: [...new Set((g.platforms || []).map(p => mapRecPlatform(p.name)).filter(Boolean))],
    summary: g.summary || '',
    score: g.total_rating ? Math.round(g.total_rating) : null,
    cover: g.cover?.image_id ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${g.cover.image_id}.jpg` : '',
  }));
}

const API = { search, beats, franchiseGames, enrich, recommend };
if (typeof module !== 'undefined' && module.exports) module.exports = API; else globalThis.MGIgdb = API;

})();
