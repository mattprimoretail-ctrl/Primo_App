/* Primo Cannabis: Alpine IQ relay (Netlify Function)
   The Alpine API key lives ONLY in Netlify environment variables, never in the app.

   Required env vars:  ALPINE_API_KEY, ALPINE_USER_ID, TOKEN_SECRET (any long random string)
   Optional env vars (use these if Alpine's paths or formats differ from the defaults below):
     ALPINE_BASE         default https://lab.alpineiq.com
     ALPINE_AUTH         "xapikey" or "bearer" (if unset, the server tests both against /api/v1.1/verify and uses the one that works)
     ALPINE_VERIFY_URL   default {base}/api/v2/verify/contact/wallet   (POST, texts the PIN)
     ALPINE_VIEW_URL     default {base}/api/v2/view/contact/wallet     (POST, returns the wallet after PIN)
     ALPINE_REFRESH_URL  default {base}/api/v2/wallet/{phone}          (GET, API key only, used for Refresh)
     ALPINE_PHONE_FORMAT "digits" (default, 5095550123), "e164" (+15095550123) or "us" (1-509-555-0123)
     DIAG_TOKEN          lets you call the "diag" action to see the SHAPE of Alpine's reply (no personal values)
   The paths above are best guesses from Alpine's help docs and could not be tested from where this was written.
   Use the diag action once (see README) to confirm them. */
const crypto = require('crypto');
const E = process.env;
const BASE = (E.ALPINE_BASE || 'https://lab.alpineiq.com').replace(/\/$/, '');
const UID = E.ALPINE_USER_ID || '';
const fill = (t, o) => t.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(o[k] == null ? '' : o[k]));
const VERIFY_URL = () => fill(E.ALPINE_VERIFY_URL || '{base}/api/v2/verify/contact/wallet', {base: BASE, uid: UID}).replace(encodeURIComponent(BASE), BASE);
const VIEW_URL = () => fill(E.ALPINE_VIEW_URL || '{base}/api/v2/view/contact/wallet', {base: BASE, uid: UID}).replace(encodeURIComponent(BASE), BASE);
const refreshUrl = phone => fill(E.ALPINE_REFRESH_URL || '{base}/api/v2/wallet/{phone}', {base: BASE, uid: UID, phone}).replace(encodeURIComponent(BASE), BASE);
let PF = E.ALPINE_PHONE_FORMAT || '';
const fmtAs = (d, k) => k === 'e164' ? '+1' + d : k === 'us' ? '1-' + d.slice(0,3) + '-' + d.slice(3,6) + '-' + d.slice(6) : d;
const fmtPhone = d => fmtAs(d, PF || 'digits');

let AUTH = E.ALPINE_AUTH || '';
const headers = (mode) => { const h = {'Content-Type': 'application/json', 'Accept': 'application/json'}; const m = mode || AUTH || 'xapikey';
  if(m === 'bearer') h.Authorization = 'Bearer ' + E.ALPINE_API_KEY; else h['X-APIKEY'] = E.ALPINE_API_KEY; return h; };
async function checkAuth(){
  const res = {};
  for(const m of ['xapikey', 'bearer']){
    try{ const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 7000);
      const r = await fetch(BASE + '/api/v1.1/verify', {method: 'GET', headers: headers(m), signal: ctl.signal}); clearTimeout(t);
      const tx = await r.text(); res[m] = {status: r.status, body: tx.slice(0, 120)}; if(r.ok && !AUTH) AUTH = m;
    }catch(e){ res[m] = {status: 0, error: errCode(e)}; }
  }
  res.using = AUTH || 'xapikey (neither worked)'; return res;
}
async function ensureAuth(){ if(!AUTH) await checkAuth(); }

async function alpine(method, url, body){
  await ensureAuth();
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 9000);
  try{
    const r = await fetch(url, {method, headers: headers(), body: body ? JSON.stringify(body) : undefined, signal: ctl.signal});
    const text = await r.text(); let json = null; try{ json = JSON.parse(text); }catch(e){}
    return {status: r.status, ok: r.ok, json, text: json ? '' : text.slice(0, 200)};
  } finally { clearTimeout(t); }
}

/* ---- signed sign-in token: proves the phone passed the text-message check, expires in 30 days ---- */
const b64 = b => Buffer.from(b).toString('base64url');
const sign = s => crypto.createHmac('sha256', E.TOKEN_SECRET).update(s).digest('base64url');
const makeToken = phone => { const p = b64(JSON.stringify({p: phone, e: Date.now() + 30 * 864e5})); return p + '.' + sign(p); };
function readToken(tok){
  if(typeof tok !== 'string' || !E.TOKEN_SECRET) return null;
  const [p, s] = tok.split('.'); if(!p || !s) return null;
  const good = sign(p); if(s.length !== good.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good))) return null;
  try{ const o = JSON.parse(Buffer.from(p, 'base64url').toString()); return o.e > Date.now() && /^\d{10}$/.test(o.p) ? o.p : null; }catch(e){ return null; }
}

/* ---- best-effort throttles (per warm function instance; add Netlify rate limiting for hard limits) ---- */
const hits = new Map();
function throttle(key, max, windowMs){
  const now = Date.now(), a = (hits.get(key) || []).filter(t => now - t < windowMs);
  if(a.length >= max){ hits.set(key, a); return false; } a.push(now); hits.set(key, a); return true;
}
const cache = new Map(); /* phone -> {t, data}, protects Alpine's 5/sec, 120/min limits */

/* ---- find fields in whatever shape Alpine returns ---- */
const KEYS = {
  points: ['pointbalance','pointsavailable','availablepoints','availablebalance','loyaltypoints','loyaltybalance','pointsbalance','loyaltypointsbalance','balancepoints','currentpoints','availablepoints','points','balance','loyaltypoints','pointbalance','currentbalance'],
  lifetime: ['lifetimepoints','totalpoints','pointsearned','lifetimeearned','lifetimepointsearned','earnedpoints'],
  redeemed: ['pointsredeemed','redeemedpoints','pointsused','totalredeemed','redeemed'],
  purchases: ['purchasecount','totalpurchases','ordercount','totalorders','numorders','visits','visitcount','transactions','totaltransactions','numpurchases'],
  joined: ['joined','joineddate','membersince','createdat','created','signupdate','signupdt','dateadded','registered','registereddate','createddate','firstseen'],
  name: ['firstname','fname','givenname','name','fullname','displayname']
};
function deepFind(obj, names, want){
  const seen = new Set(); const q = [obj];
  while(q.length){
    const o = q.shift(); if(!o || typeof o !== 'object' || seen.has(o)) continue; seen.add(o);
    for(const name of names){
      for(const k of Object.keys(o)){
        if(k.toLowerCase().replace(/[^a-z]/g, '') === name){
          const v = o[k];
          if(want === 'number' && (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !isNaN(v)))) return Number(v);
          if(want === 'string' && typeof v === 'string' && v.trim()) return v.trim();
          if(want === 'date' && (typeof v === 'string' || typeof v === 'number') && !isNaN(new Date(v))) return new Date(v).toISOString();
        }
      }
    }
    for(const v of Object.values(o)) if(v && typeof v === 'object' && !Array.isArray(v)) q.push(v); /* skip lists such as discountTemplates, whose items have their own names */
  }
  return undefined;
}
function mapWallet(j){
  const points = deepFind(j, KEYS.points, 'number'), lifetime = deepFind(j, KEYS.lifetime, 'number'), redeemed = deepFind(j, KEYS.redeemed, 'number'),
        purchases = deepFind(j, KEYS.purchases, 'number'), joined = deepFind(j, KEYS.joined, 'date'), name = deepFind(j, KEYS.name, 'string');
  return {name: name ? name.split(' ')[0] : 'there', balance: points, lifetime, redeemed, purchases, joined,
    found: {points: points !== undefined, lifetime: lifetime !== undefined, redeemed: redeemed !== undefined, purchases: purchases !== undefined, joined: joined !== undefined}};
}
const shape = (v, d = 0) => v === null ? 'null' : Array.isArray(v) ? (d > 3 || !v.length ? 'array(' + v.length + ')' : [shape(v[0], d + 1)])
  : typeof v === 'object' ? (d > 4 ? 'object' : Object.fromEntries(Object.keys(v).slice(0, 60).map(k => [k, shape(v[k], d + 1)]))) : typeof v;

const cors = event => { const o = (event && event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const allow = (E.ALLOWED_ORIGIN || '*').split(',').map(x => x.trim());
  const ok = allow.includes('*') || allow.includes(o);
  return ok ? {'Access-Control-Allow-Origin': allow.includes('*') ? '*' : o, 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Vary': 'Origin'} : {}; };
let CORS = {};
const out = (code, obj) => ({statusCode: code, headers: Object.assign({'Content-Type': 'application/json', 'Cache-Control': 'no-store'}, CORS), body: JSON.stringify(obj)});
const errCode = e => e && e.name === 'AbortError' ? 'timeout' : 'network_' + ((e && e.cause && (e.cause.code || e.cause.message)) || (e && e.message) || 'error').toString().slice(0, 40).replace(/\W+/g, '_');
const FAIL = 'We could not reach Primo Rewards right now. Please try again in a minute.';

exports.handler = async event => {
  CORS = cors(event);
  if(event.httpMethod === 'OPTIONS') return {statusCode: 204, headers: CORS, body: ''};
  if(event.httpMethod !== 'POST') return out(405, {ok: false, message: 'Not allowed'});
  if(!E.ALPINE_API_KEY || !UID || !E.TOKEN_SECRET) return out(500, {ok: false, code: 'env_missing', message: 'Rewards sign-in is not set up yet.'});
  let b; try{ b = JSON.parse(event.body || '{}'); }catch(e){ return out(400, {ok: false, message: 'Bad request'}); }
  const ip = (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || 'x').split(',')[0].trim();
  const phone = typeof b.phone === 'string' ? b.phone.replace(/\D/g, '') : '';
  try{
    if(b.action === 'swagger' || b.action === 'probe' || b.action === 'page'){
      if(!E.DIAG_TOKEN || b.token !== E.DIAG_TOKEN) return out(403, {ok: false});
      const res = {};
      const raw = async (method, url) => { const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 7000);
        try{ const r = await fetch(url, {method, headers: headers(), signal: ctl.signal}); const tx = await r.text(); return {status: r.status, allow: r.headers.get('allow') || '', ct: r.headers.get('content-type') || '', text: tx}; }
        catch(e){ return {status: 0, error: errCode(e), text: ''}; } finally { clearTimeout(t); } };
      if(b.action === 'page'){
        const p = typeof b.path === 'string' && /^\/[\w\-./]*$/.test(b.path) ? b.path : '/swagger/index.html';
        const r = await raw('GET', BASE + p); const t = r.text || '';
        const refs = Array.from(new Set((t.match(/["'(=]\/?[^"'()\s<>]*(?:swagger|openapi|api-docs|apidocs|spec)[^"'()\s<>]*/gi) || []).map(x => x.replace(/^["'(=]/, '')))).slice(0, 40);
        const srcs = Array.from(new Set((t.match(/(?:src|href)=["'][^"']+["']/gi) || []))).slice(0, 25);
        const urlLines = (t.match(/url\s*[:=]\s*["'][^"']+["']/gi) || []).slice(0, 10);
        const term = typeof b.find === 'string' ? b.find.slice(0, 60) : '';
        let matches = [], chunks = [];
        if(term){ const lo = t.toLowerCase(), tl = term.toLowerCase(); let i = 0; while(matches.length < 14 && (i = lo.indexOf(tl, i)) !== -1){ matches.push(t.slice(Math.max(0, i - 140), i + 220).replace(/\s+/g, ' ')); i += tl.length + 200; } }
        chunks = Array.from(new Set(t.match(/[\w./-]*\/static\/js\/[\w.-]+\.js|assets\/[\w.-]+\.js|[\w-]+-[A-Za-z0-9_-]{8}\.js/g) || [])).slice(0, 60);
        return out(200, {path: p, status: r.status, ct: r.ct, length: t.length, term, matchCount: matches.length, matches, chunks, refs: refs.slice(0, 15), urlLines, head: term ? '' : t.slice(0, 500)});
      }
      if(b.action === 'swagger'){
        res.tried = []; res.paths = [];
        for(const p of ['/swagger/v1/swagger.json', '/swagger/v2/swagger.json', '/swagger/docs/v2', '/swagger/swagger.json', '/swagger.json', '/swagger/docs/v1', '/api/swagger.json', '/api/v2/swagger.json', '/api/v1.1/swagger.json', '/swagger/index.html']){
          const r = await raw('GET', BASE + p); res.tried.push({p, status: r.status, ct: r.ct.slice(0, 40)});
          if(r.status === 200){ try{ const j = JSON.parse(r.text); if(j && j.paths){
            res.found = p; res.servers = j.servers || j.host || j.basePath || null;
            for(const k of Object.keys(j.paths)) if(/wallet|verify|lookup|loyalty|contact\/\{?phone/i.test(k)) res.paths.push({path: k, methods: Object.keys(j.paths[k]).filter(m => /^(get|post|put|delete|patch)$/i.test(m)).map(m => m.toUpperCase())});
            break; } }catch(e){} }
        }
        return out(200, res);
      }
      const cands = ['/api/v1.1/verify/wallet/{uid}', '/api/v1.1/verify/wallet', '/api/v2/verify/wallet', '/api/v2/verify/wallet/{uid}', '/api/v2/verify/contact/wallet', '/api/v2/{uid}/verify/wallet', '/api/v1.1/view/wallet/{uid}', '/api/v2/view/wallet', '/api/v2/wallet', '/api/v1.1/wallet/{uid}'];
      res.probes = [];
      for(const c of cands){ const url = BASE + c.replace('{uid}', encodeURIComponent(UID));
        const o = await raw('OPTIONS', url), g = await raw('GET', url);
        res.probes.push({path: c, options: o.status, allow: o.allow, get: g.status, getBody: g.text.slice(0, 80)}); }
      return out(200, res);
    }
    if(b.action === 'diagwallet'){
      if(!E.DIAG_TOKEN || b.token !== E.DIAG_TOKEN) return out(403, {ok: false});
      if(!/^\d{10}$/.test(phone)) return out(400, {ok: false, message: 'phone must be 10 digits'});
      const r = await alpine('GET', refreshUrl(fmtPhone(phone)));
      const scalars = {}; const walk = (o, p, d) => { if(!o || typeof o !== 'object' || d > 3) return; for(const k of Object.keys(o)){ const v = o[k], key = p + k;
        if(/redemptionurl|token|email|phone|name|avatar/i.test(k)) continue;
        if(Array.isArray(v)) { scalars[key + '[]'] = 'array(' + v.length + ')'; continue; }
        if(v && typeof v === 'object') walk(v, key + '.', d + 1); else if(typeof v === 'number' || typeof v === 'boolean') scalars[key] = v; else if(typeof v === 'string') scalars[key] = 'string'; } };
      if(r.json) walk(r.json, '', 0);
      return out(200, {status: r.status, shape: r.json ? shape(r.json) : r.text, values: scalars, mapped: r.json ? mapWallet(r.json) : null});
    }
    if(b.action === 'ping' || b.action === 'diagstart'){
      if(!E.DIAG_TOKEN || b.token !== E.DIAG_TOKEN) return out(403, {ok: false});
      const info = {env: {ALPINE_API_KEY: !!E.ALPINE_API_KEY, ALPINE_USER_ID: !!UID, TOKEN_SECRET: !!E.TOKEN_SECRET, DIAG_TOKEN: true}, auth: AUTH || E.ALPINE_AUTH || 'auto', verifyUrl: VERIFY_URL(), viewUrl: VIEW_URL(), phoneFormat: E.ALPINE_PHONE_FORMAT || 'digits'};
      if(b.action === 'ping'){ info.authCheck = await checkAuth(); return out(200, info); }
      if(!/^\d{10}$/.test(phone)) return out(400, {ok: false, message: 'phone must be 10 digits'});
      const r = await alpine('POST', VERIFY_URL(), {phone: fmtPhone(phone)});
      return out(200, Object.assign(info, {alpineStatus: r.status, alpineBody: r.json ? shape(r.json) : r.text, alpineMessage: r.json && typeof r.json === 'object' ? String(r.json.message || r.json.error || r.json.Message || '').slice(0, 200) : ''}));
    }
    if(b.action === 'start'){
      if(!/^\d{10}$/.test(phone)) return out(400, {ok: false, message: 'Enter a 10-digit mobile number.'});
      if(!throttle('s:' + phone, 3, 36e5) || !throttle('i:' + ip, 10, 36e5)) return out(429, {ok: false, message: 'Too many codes requested. Try again in a bit.'});
      let r = await alpine('POST', VERIFY_URL(), {phone: fmtPhone(phone)});
      if(r.ok) return out(200, {ok: true});
      if(r.status === 404 || r.status === 400){
        const body = JSON.stringify(r.json || r.text || '').toLowerCase();
        if(body.includes('not an active loyalty member')) return out(200, {ok: false, code: 'not_member', message: 'That number is on file but not an active Primo Rewards member yet. Ask us in store and we will get you set up.'});
        return out(200, {ok: false, code: 'alpine_' + r.status, message: 'We could not find a Primo Rewards account for that number. Check the number, or join free with the link below.'});
      }
      return out(502, {ok: false, code: 'alpine_' + r.status, message: FAIL});
    }
    if(b.action === 'verify' || b.action === 'diag'){
      const code = typeof b.code === 'string' ? b.code.replace(/\D/g, '') : '';
      if(!/^\d{10}$/.test(phone) || code.length < 4) return out(400, {ok: false, message: 'Enter the code from your text.'});
      if(b.action === 'diag' && (!E.DIAG_TOKEN || b.token !== E.DIAG_TOKEN)) return out(403, {ok: false});
      if(!throttle('v:' + phone, 8, 36e5) || !throttle('vi:' + ip, 30, 36e5)) return out(429, {ok: false, message: 'Too many tries. Try again in a bit.'});
      const r = await alpine('POST', VIEW_URL(), {phone: fmtPhone(phone), code});
      if(b.action === 'diag') return out(200, {status: r.status, shape: r.json ? shape(r.json) : r.text, mapped: r.json ? mapWallet(r.json).found : null});
      if(!r.ok || !r.json) return out(200, {ok: false, message: r.status >= 500 ? FAIL : 'That code did not work. Check it or request a new one.'});
      const m = mapWallet(r.json); cache.set(phone, {t: Date.now(), data: m});
      return out(200, Object.assign({ok: true, token: makeToken(phone)}, m));
    }
    if(b.action === 'refresh'){
      const p = readToken(b.token); if(!p) return out(200, {ok: false, expired: true});
      if(!throttle('r:' + p, 20, 36e5)) return out(429, {ok: false, message: 'Slow down a little and try again.'});
      const c = cache.get(p); if(c && Date.now() - c.t < 60000) return out(200, Object.assign({ok: true}, c.data));
      const r = await alpine('GET', refreshUrl(fmtPhone(p)));
      if(!r.ok || !r.json) return out(200, {ok: false, message: r.status >= 500 || !r.status ? FAIL : 'Could not refresh. Sign in again to update.', expired: r.status === 404});
      const m = mapWallet(r.json);
      if(!m.found.points) return out(200, {ok: false, expired: true});
      cache.set(p, {t: Date.now(), data: m});
      return out(200, Object.assign({ok: true}, m));
    }
    return out(400, {ok: false, message: 'Bad request'});
  }catch(e){ return out(502, {ok: false, code: errCode(e), message: FAIL}); }
};
