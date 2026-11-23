// Parter's hosted backend: one Cloudflare Pages Function for everything under /api.
//
//   accounts   sign in by emailed link or Google; a session cookie
//   plans      the same /api/projects and /api/blobs routes as server/local.mjs, per account (D1 + R2)
//   sharing    a link that hands anyone a copy of a plan
//   AI         the assistant and renders on the site's own provider keys, with a monthly allowance
//   billing    Stripe Checkout, the customer portal and the webhook that sets the plan
//
// Every outside service is optional: leave its secret unset and that feature is switched off
// and hidden in the app. Signed-out visitors keep working in their own browser, as before.
//
// Bindings: DB (D1), BLOBS (R2).
// Secrets:  EMAIL_API_TOKEN (Cloudflare token allowed to send email), GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY,
//           STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID.
// Vars:     CF_ACCOUNT_ID, MAIL_FROM, PRICE_LABEL (shown on the landing page), CHAT_MODEL, IMAGE_MODEL, DEV_LINKS (=1 returns sign-in links instead of emailing them).
import { generateImage } from '../../public/js/ai/providers.js';

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KEY = /^[a-z0-9][a-z0-9-]{0,63}(:[a-z0-9]+){1,3}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY = 864e5, SESSION_DAYS = 30, LINK_MINUTES = 20;
export const LIMITS = { free: { chat: 30, renders: 3, plans: 3 }, pro: { chat: 1500, renders: 100, plans: 500 } };

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, headers) });
const fail = (status, message) => json({ error: { message } }, status);
const redirect = (to, cookie) => { const h = new Headers({ location: to, 'cache-control': 'no-store' }); for (const c of [].concat(cookie || [])) h.append('set-cookie', c); return new Response(null, { status: 302, headers: h }); };
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha = async s => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
const secret = (n = 32) => hex(crypto.getRandomValues(new Uint8Array(n)));
const cookieOf = (req, name) => { const m = new RegExp('(?:^|; )' + name + '=([^;]*)').exec(req.headers.get('cookie') || ''); return m ? m[1] : null; };
const setCookie = (name, value, maxAge) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const month = () => new Date().toISOString().slice(0, 7);

const q = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);

async function currentUser(req, env) {
  const tok = cookieOf(req, 'parter_s'); if (!tok) return null;
  return q(env, 'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires > ?', await sha(tok), Date.now()).first();
}
async function signIn(env, email, name) {
  email = email.toLowerCase();
  let u = await q(env, 'SELECT * FROM users WHERE email = ?', email).first();
  if (!u) { u = { id: secret(12) }; await q(env, 'INSERT INTO users (id, email, name, created) VALUES (?, ?, ?, ?)', u.id, email, name || null, Date.now()).run(); }
  const tok = secret();
  await env.DB.batch([
    q(env, 'DELETE FROM sessions WHERE expires < ?', Date.now()),
    q(env, 'INSERT INTO sessions (id, user_id, expires) VALUES (?, ?, ?)', await sha(tok), u.id, Date.now() + SESSION_DAYS * DAY)
  ]);
  return setCookie('parter_s', tok, SESSION_DAYS * 86400);
}
async function usageOf(env, u) {
  return (await q(env, 'SELECT chat, renders FROM usage WHERE user_id = ? AND month = ?', u.id, month()).first()) || { chat: 0, renders: 0 };
}
/** null when the account still has allowance, otherwise the sentence to show. */
async function overLimit(env, u, kind) {
  const used = (await usageOf(env, u))[kind], max = (LIMITS[u.plan] || LIMITS.free)[kind];
  if (used < max) return null;
  const what = kind === 'chat' ? 'assistant requests' : 'renders';
  return `You have used all ${max} ${what} included this month.` + (u.plan === 'pro' ? ' They reset on the 1st.' : ' Upgrade in Account for more, or add your own API key in Settings.');
}
const count = (env, u, kind) => q(env, `INSERT INTO usage (user_id, month, ${kind}) VALUES (?, ?, 1) ON CONFLICT (user_id, month) DO UPDATE SET ${kind} = ${kind} + 1`, u.id, month()).run();

async function stripe(env, path, params) {
  const r = await fetch('https://api.stripe.com/v1/' + path, { method: params ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, 'content-type': 'application/x-www-form-urlencoded' }, body: params ? new URLSearchParams(params) : undefined });
  const j = await r.json(); if (!r.ok) throw new Error((j.error && j.error.message) || 'Stripe error ' + r.status);
  return j;
}
async function stripeEvent(req, env) {
  const body = await req.text(), sig = Object.fromEntries((req.headers.get('stripe-signature') || '').split(',').map(p => p.split('=')));
  if (!sig.t || !sig.v1 || Math.abs(Date.now() / 1000 - sig.t) > 300) return null;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('HMAC', key, Uint8Array.from(sig.v1.match(/../g).map(h => parseInt(h, 16))), new TextEncoder().encode(sig.t + '.' + body));
  return ok ? JSON.parse(body) : null;
}

export async function onRequest({ request: req, env }) {
  try { return await route(req, env); }
  catch (e) { console.error(e); return fail(500, 'Something went wrong on our side. Try again in a moment.'); }
}

async function route(req, env) {
  const url = new URL(req.url), p = decodeURIComponent(url.pathname), M = req.method;
  const on = { email: !!(env.DEV_LINKS === '1' || (env.EMAIL_API_TOKEN && env.CF_ACCOUNT_ID && env.MAIL_FROM)), google: !!env.GOOGLE_CLIENT_ID, ai: !!env.ANTHROPIC_API_KEY, images: !!(env.OPENAI_API_KEY || env.GEMINI_API_KEY), billing: !!(env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_ID) };

  // Stripe calls this one itself; it proves who it is with a signature instead of a cookie
  if (p === '/api/stripe/webhook' && M === 'POST') {
    const ev = env.STRIPE_WEBHOOK_SECRET && await stripeEvent(req, env); if (!ev) return fail(400, 'bad signature');
    const o = ev.data.object;
    if (ev.type === 'checkout.session.completed' && o.client_reference_id) await q(env, "UPDATE users SET stripe_customer = ?, plan = 'pro' WHERE id = ?", o.customer, o.client_reference_id).run();
    if (ev.type === 'customer.subscription.updated' || ev.type === 'customer.subscription.deleted') await q(env, 'UPDATE users SET plan = ? WHERE stripe_customer = ?', /^(active|trialing)$/.test(o.status) ? 'pro' : 'free', o.customer).run();
    return json({ received: true });
  }

  // a page on another site must not be able to act with this visitor's cookie
  if (M !== 'GET' && req.headers.get('origin') !== url.origin) return fail(403, 'forbidden');

  const user = await currentUser(req, env);

  // the app asks this once at start (the local server answers the same address)
  if (p === '/api/local') {
    return json({ parter: true, cloud: true, on, limits: LIMITS, price: env.PRICE_LABEL || '', user: user && { email: user.email, name: user.name, plan: user.plan, usage: await usageOf(env, user) } });
  }

  // ---- signing in
  if (p === '/api/auth/email' && M === 'POST' && on.email) {
    const email = String((await req.json()).email || '').trim().toLowerCase();
    if (!EMAIL.test(email) || email.length > 200) return fail(400, 'That does not look like an email address.');
    if (await q(env, 'SELECT 1 FROM login_links WHERE email = ? AND created > ?', email, Date.now() - 60000).first()) return fail(429, 'A link was sent a moment ago. Check your inbox, or try again in a minute.');
    const tok = secret(), link = url.origin + '/api/auth/verify?token=' + tok;
    await env.DB.batch([
      q(env, 'DELETE FROM login_links WHERE expires < ?', Date.now()),
      q(env, 'INSERT INTO login_links (id, email, created, expires) VALUES (?, ?, ?, ?)', await sha(tok), email, Date.now(), Date.now() + LINK_MINUTES * 60000)
    ]);
    if (env.DEV_LINKS === '1') return json({ ok: true, link });
    const text = `Open this link to sign in to Parter. It works once and for ${LINK_MINUTES} minutes.\n\n${link}\n\nIf you did not ask for it, ignore this message.`;
    // Pages Functions cannot bind Cloudflare's email service, so it is called over its REST API
    try {
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/email/sending/send`, { method: 'POST', headers: { authorization: 'Bearer ' + env.EMAIL_API_TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ to: email, from: { address: env.MAIL_FROM, name: 'Parter' }, subject: 'Your sign-in link for Parter', text, html: `<p>Open this link to sign in to Parter. It works once and for ${LINK_MINUTES} minutes.</p><p><a href="${link}">Sign in to Parter</a></p><p>If you did not ask for it, ignore this message.</p>` }) });
      if (!r.ok) throw new Error(r.status + ' ' + await r.text());
    }
    catch (e) { console.error('email', e); return fail(503, 'We could not send the email. Try again in a minute, or use another way to sign in.'); }
    return json({ ok: true });
  }
  if (p === '/api/auth/verify' && M === 'GET') {
    const row = await q(env, 'DELETE FROM login_links WHERE id = ? AND expires > ? RETURNING email', await sha(url.searchParams.get('token') || ''), Date.now()).first();
    return row ? redirect('/app?signedin=1', await signIn(env, row.email)) : redirect('/app?signin=expired');
  }
  if (p === '/api/auth/google' && M === 'GET' && on.google) {
    const state = secret(16);
    return redirect('https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: url.origin + '/api/auth/google/callback', response_type: 'code', scope: 'openid email profile', state }), setCookie('parter_o', state, 600));
  }
  if (p === '/api/auth/google/callback' && M === 'GET' && on.google) {
    const state = url.searchParams.get('state'), code = url.searchParams.get('code');
    if (!code || !state || state !== cookieOf(req, 'parter_o')) return redirect('/app?signin=failed');
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: url.origin + '/api/auth/google/callback', grant_type: 'authorization_code' }) });
    const t = await r.json(); if (!r.ok || !t.id_token) return redirect('/app?signin=failed');
    // the token came straight from Google over TLS in exchange for our secret, so its claims can be read as they are
    const who = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(t.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))));
    if (!who.email || !who.email_verified) return redirect('/app?signin=failed');
    return redirect('/app?signedin=1', [await signIn(env, who.email, who.name), setCookie('parter_o', '', 0)]);
  }
  if (p === '/api/auth/logout' && M === 'POST') {
    const tok = cookieOf(req, 'parter_s'); if (tok) await q(env, 'DELETE FROM sessions WHERE id = ?', await sha(tok)).run();
    return json({ ok: true }, 200, { 'set-cookie': setCookie('parter_s', '', 0) });
  }

  // ---- a shared plan: anyone with the link may read it
  let m = /^\/api\/shared\/([a-f0-9]{24})$/.exec(p);
  if (m && M === 'GET') {
    const row = await q(env, 'SELECT data FROM projects WHERE share = ?', m[1]).first();
    return row ? new Response(row.data, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }) : fail(404, 'This link no longer works. Ask the owner for a new one.');
  }

  if (!user) return fail(401, 'Please sign in again.');

  // ---- plans
  if (p === '/api/projects' && M === 'GET') return json((await q(env, 'SELECT id, name, modified, share FROM projects WHERE user_id = ? ORDER BY modified DESC', user.id).all()).results);
  m = /^\/api\/projects\/([^/]+)(\/share)?$/.exec(p);
  if (m) {
    const id = m[1]; if (!ID.test(id)) return fail(400, 'bad project id');
    if (m[2]) {
      if (M !== 'POST' && M !== 'DELETE') return fail(405, 'not allowed');
      const row = await q(env, `UPDATE projects SET share = ${M === 'POST' ? 'COALESCE(share, ?)' : '?'} WHERE user_id = ? AND id = ? RETURNING share`, M === 'POST' ? secret(12) : null, user.id, id).first();
      return row ? json({ share: row.share }) : fail(404, 'not found');
    }
    if (M === 'GET') {
      const row = await q(env, 'SELECT data FROM projects WHERE user_id = ? AND id = ?', user.id, id).first();
      return row ? new Response(row.data, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }) : fail(404, 'not found');
    }
    if (M === 'PUT') {
      const text = await req.text(); if (text.length > 2e6) return fail(413, 'This plan is too large to save.');
      const name = String(JSON.parse(text).name || id).slice(0, 80), max = (LIMITS[user.plan] || LIMITS.free).plans;
      const have = await q(env, 'SELECT COUNT(*) AS n, SUM(id = ?) AS mine FROM projects WHERE user_id = ?', id, user.id).first();
      if (!have.mine && have.n >= max) return fail(402, `Your account holds up to ${max} plans. Delete one` + (user.plan === 'pro' ? '.' : ', or upgrade in Account.'));
      await q(env, 'INSERT INTO projects (user_id, id, name, data, modified) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id, id) DO UPDATE SET name = excluded.name, data = excluded.data, modified = excluded.modified', user.id, id, name, text, Date.now()).run();
      return json({ ok: true });
    }
    if (M === 'DELETE') { await q(env, 'DELETE FROM projects WHERE user_id = ? AND id = ?', user.id, id).run(); return json({ ok: true }); }
  }

  // ---- pictures. ponytail: stored as the data-URL text the app already uses; store raw bytes if R2 size ever matters
  const pre = user.id + '/';
  if (p === '/api/blobs' && M === 'GET') {
    const out = await env.BLOBS.list({ prefix: pre + (url.searchParams.get('prefix') || ''), limit: 1000 });
    return json(out.objects.map(o => o.key.slice(pre.length)));
  }
  m = /^\/api\/blobs\/([^/]+)$/.exec(p);
  if (m) {
    if (!KEY.test(m[1])) return fail(400, 'bad key');
    if (M === 'GET') { const o = await env.BLOBS.get(pre + m[1]); return o ? new Response(o.body, { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } }) : fail(404, 'not found'); }
    if (M === 'PUT') {
      const body = await req.text();
      if (!/^data:image\/(jpeg|png|webp);base64,/.test(body)) return fail(400, 'expected an image data URL');
      if (body.length > 20e6) return fail(413, 'That picture is too large.');
      await env.BLOBS.put(pre + m[1], body); return json({ ok: true });
    }
    if (M === 'DELETE') { await env.BLOBS.delete(pre + m[1]); return json({ ok: true }); }
  }

  // ---- the included assistant: the browser sends a Claude Messages request, we add the key and the model
  if (p === '/api/ai/messages' && M === 'POST' && on.ai) {
    const over = await overLimit(env, user, 'chat'); if (over) return fail(429, over);
    const body = await req.json();
    body.model = env.CHAT_MODEL || 'claude-sonnet-5-5'; body.max_tokens = Math.min(body.max_tokens || 4096, 8000); delete body.stream;
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });
    if (r.ok) await count(env, user, 'chat');
    else if (r.status === 401 || r.status === 403) { console.error('anthropic', r.status, await r.text()); return fail(502, 'The assistant is not available right now.'); }
    return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }
  if (p === '/api/ai/image' && M === 'POST' && on.images) {
    const over = await overLimit(env, user, 'renders'); if (over) return fail(429, over);
    const b = await req.json(), provider = env.OPENAI_API_KEY ? 'openai' : 'gemini';
    if (typeof b.prompt !== 'string' || !Array.isArray(b.images) || !b.images.length || b.images.length > 2) return fail(400, 'A prompt and one or two pictures are required.');
    try {
      const out = await generateImage({ provider, key: env.OPENAI_API_KEY || env.GEMINI_API_KEY, model: env.IMAGE_MODEL || (provider === 'openai' ? 'gpt-image-2' : 'gemini-3.1-flash-image') }, { prompt: b.prompt.slice(0, 8000), images: b.images, size: b.size });
      await count(env, user, 'renders'); return json({ url: out });
    } catch (e) { console.error('image', e); return fail(502, e.status === 401 || e.status === 403 ? 'Renders are not available right now.' : String(e.message || e)); }
  }

  // ---- billing
  if (p === '/api/billing/checkout' && M === 'POST' && on.billing) {
    const s = await stripe(env, 'checkout/sessions', Object.assign({ mode: 'subscription', 'line_items[0][price]': env.STRIPE_PRICE_ID, 'line_items[0][quantity]': '1', client_reference_id: user.id, success_url: url.origin + '/app?upgraded=1', cancel_url: url.origin + '/app', allow_promotion_codes: 'true' }, user.stripe_customer ? { customer: user.stripe_customer } : { customer_email: user.email }));
    return json({ url: s.url });
  }
  if (p === '/api/billing/portal' && M === 'POST' && on.billing && user.stripe_customer) {
    return json({ url: (await stripe(env, 'billing_portal/sessions', { customer: user.stripe_customer, return_url: url.origin + '/app' })).url });
  }

  // ---- closing the account removes everything we hold
  if (p === '/api/account' && M === 'DELETE') {
    if (on.billing && user.stripe_customer) for (const s of (await stripe(env, 'subscriptions?status=active&customer=' + user.stripe_customer)).data) await fetch('https://api.stripe.com/v1/subscriptions/' + s.id, { method: 'DELETE', headers: { authorization: 'Bearer ' + env.STRIPE_SECRET_KEY } });
    for (let l; (l = await env.BLOBS.list({ prefix: pre, limit: 1000 })).objects.length;) await env.BLOBS.delete(l.objects.map(o => o.key));
    await env.DB.batch(['projects', 'usage', 'sessions'].map(t => q(env, `DELETE FROM ${t} WHERE user_id = ?`, user.id)).concat(q(env, 'DELETE FROM users WHERE id = ?', user.id)));
    return json({ ok: true }, 200, { 'set-cookie': setCookie('parter_s', '', 0) });
  }

  return fail(404, 'not found');
}
