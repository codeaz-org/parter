// The hosted backend (functions/api), run in Node against an in-memory SQLite standing in for D1,
// a Map standing in for R2, and a fake fetch standing in for Anthropic, OpenAI and Stripe.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { onRequest, LIMITS } from '../functions/api/[[path]].js';

const ORIGIN = 'https://parter.test';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function makeEnv(extra) {
  const db = new DatabaseSync(':memory:'); db.exec(fs.readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) || null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => db.prepare(sql).run(...args),
    _run: () => db.prepare(sql).all(...args)
  });
  const r2 = new Map();
  return Object.assign({
    DEV_LINKS: '1', sqlite: db,
    DB: { prepare: sql => stmt(sql), batch: async list => list.map(s => s._run()) },
    BLOBS: {
      put: async (k, v) => { r2.set(k, v); }, get: async k => (r2.has(k) ? { body: r2.get(k) } : null),
      delete: async k => { for (const x of [].concat(k)) r2.delete(x); },
      list: async ({ prefix }) => ({ objects: [...r2.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })) })
    }
  }, extra);
}
function client(env) {
  let cookie = '';
  const call = async (path, method = 'GET', body, headers = {}) => {
    const h = Object.assign({ cookie }, method === 'GET' ? {} : { origin: ORIGIN, 'content-type': 'application/json' }, headers);
    const r = await onRequest({ env, request: new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), redirect: 'manual' }) });
    const set = r.headers.getSetCookie().map(c => c.split(';')[0]).find(c => c.startsWith('parter_s=')); if (set) cookie = set;
    return r;
  };
  call.signIn = async email => { const { link } = await (await call('/api/auth/email', 'POST', { email })).json(); return call(new URL(link).pathname + new URL(link).search); };
  return call;
}
const withFetch = async (fake, fn) => { const real = globalThis.fetch; globalThis.fetch = fake; try { return await fn(); } finally { globalThis.fetch = real; } };

test('cloud: sign in by link, keep plans and pictures per account, sign out', async () => {
  const env = makeEnv(), ana = client(env), bob = client(env);
  assert.equal((await (await ana('/api/local')).json()).user, null);
  assert.equal((await ana('/api/projects')).status, 401);
  assert.equal((await ana('/api/auth/email', 'POST', { email: 'nope' })).status, 400);

  const { link } = await (await ana('/api/auth/email', 'POST', { email: 'Ana@Example.com' })).json();
  assert.equal((await ana('/api/auth/email', 'POST', { email: 'ana@example.com' })).status, 429, 'one link a minute');
  const tok = new URL(link).search;
  assert.equal((await ana('/api/auth/verify' + tok)).headers.get('location'), '/app?signedin=1');
  assert.equal((await bob('/api/auth/verify' + tok)).headers.get('location'), '/app?signin=expired', 'a link works once');
  const me = (await (await ana('/api/local')).json()).user;
  assert.deepEqual([me.email, me.plan, me.usage.chat], ['ana@example.com', 'free', 0]);

  assert.equal((await ana('/api/projects/home', 'PUT', { name: 'Home', walls: [] })).status, 200);
  assert.equal((await ana('/api/blobs/home:underlay', 'PUT', PNG, { 'content-type': 'text/plain' })).status, 200);
  assert.equal((await ana('/api/blobs/home:underlay', 'PUT', 'not a picture')).status, 400);
  assert.deepEqual(await (await ana('/api/blobs?prefix=home:')).json(), ['home:underlay']);
  assert.equal(await (await ana('/api/blobs/home:underlay')).text(), PNG);
  assert.equal((await (await ana('/api/projects')).json())[0].name, 'Home');

  await bob.signIn('bob@example.com');
  assert.deepEqual(await (await bob('/api/projects')).json(), [], 'accounts do not see each other');
  assert.equal((await bob('/api/projects/home')).status, 404);
  assert.equal((await bob('/api/blobs/home:underlay')).status, 404);

  // free accounts hold a few plans; saving an existing one always works
  for (let n = 2; n <= LIMITS.free.plans; n++) assert.equal((await ana('/api/projects/p' + n, 'PUT', { name: 'P' + n })).status, 200);
  const full = await ana('/api/projects/one-too-many', 'PUT', { name: 'X' });
  assert.equal(full.status, 402); assert.match((await full.json()).error.message, /up to 3 plans/);
  assert.equal((await ana('/api/projects/home', 'PUT', { name: 'Home 2' })).status, 200);

  // another site cannot act with the visitor's cookie
  assert.equal((await ana('/api/projects/home', 'DELETE', undefined, { origin: 'https://evil.example' })).status, 403);

  await ana('/api/auth/logout', 'POST');
  assert.equal((await ana('/api/projects')).status, 401);
});

test('cloud: a share link gives the plan to anyone until it is switched off', async () => {
  const env = makeEnv(), ana = client(env), guest = client(env);
  await ana.signIn('ana@example.com'); await ana('/api/projects/home', 'PUT', { name: 'Home' });
  const { share } = await (await ana('/api/projects/home/share', 'POST')).json();
  assert.equal((await (await ana('/api/projects/home/share', 'POST')).json()).share, share, 'asking again keeps the same link');
  assert.equal((await (await guest('/api/shared/' + share)).json()).name, 'Home');
  await ana('/api/projects/home/share', 'DELETE');
  assert.equal((await guest('/api/shared/' + share)).status, 404);
});

test('cloud: the included assistant and renders use the site keys and stop at the monthly allowance', async () => {
  const env = makeEnv({ ANTHROPIC_API_KEY: 'sk-site', OPENAI_API_KEY: 'sk-img' }), ana = client(env), seen = [];
  assert.deepEqual((await (await ana('/api/local')).json()).on, { email: true, google: false, ai: true, images: true, billing: false });
  assert.equal((await ana('/api/ai/messages', 'POST', {})).status, 401);
  await ana.signIn('ana@example.com');
  await withFetch(async (url, init) => {
    seen.push({ url: String(url), init });
    if (String(url).includes('anthropic')) return Response.json({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
    return Response.json({ data: [{ b64_json: 'AAAA' }] });
  }, async () => {
    const r = await ana('/api/ai/messages', 'POST', { model: 'the-most-expensive-one', max_tokens: 999999, messages: [] });
    assert.equal((await r.json()).content[0].text, 'ok');
    const sent = JSON.parse(seen[0].init.body);
    assert.equal(seen[0].init.headers['x-api-key'], 'sk-site');
    assert.equal(sent.model, 'claude-sonnet-5-5', 'the visitor does not choose the model'); assert.equal(sent.max_tokens, 8000);

    const img = await (await ana('/api/ai/image', 'POST', { prompt: 'a room', images: [{ mime: 'image/png', b64: 'AAAA', name: 'layout.png' }] })).json();
    assert.equal(img.url, 'data:image/png;base64,AAAA');
    assert.deepEqual((await (await ana('/api/local')).json()).user.usage, { chat: 1, renders: 1 });

    env.sqlite.exec(`UPDATE usage SET chat = ${LIMITS.free.chat}, renders = ${LIMITS.free.renders}`);
    const over = await ana('/api/ai/messages', 'POST', { messages: [] });
    assert.equal(over.status, 429); assert.match((await over.json()).error.message, /all 30 assistant requests/);
    assert.equal((await ana('/api/ai/image', 'POST', { prompt: 'x', images: [{ mime: 'image/png', b64: 'AAAA' }] })).status, 429);
    assert.equal(seen.length, 2, 'nothing was sent to the providers once over the allowance');
  });
});

test('cloud: Stripe checkout, the signed webhook sets the plan, deleting the account removes everything', async () => {
  const env = makeEnv({ STRIPE_SECRET_KEY: 'sk_test', STRIPE_PRICE_ID: 'price_1', STRIPE_WEBHOOK_SECRET: 'whsec_x' }), ana = client(env), calls = [];
  await ana.signIn('ana@example.com'); await ana('/api/projects/home', 'PUT', { name: 'Home' }); await ana('/api/blobs/home:underlay', 'PUT', PNG);
  const id = env.sqlite.prepare('SELECT id FROM users').get().id;
  const hook = (event, sig) => {
    const body = JSON.stringify(event), t = Math.floor(Date.now() / 1000);
    return onRequest({ env, request: new Request(ORIGIN + '/api/stripe/webhook', { method: 'POST', body, headers: { 'stripe-signature': `t=${t},v1=${sig || crypto.createHmac('sha256', 'whsec_x').update(t + '.' + body).digest('hex')}` } }) });
  };
  await withFetch(async (url, init) => { calls.push([init.method, String(url), String(init.body || '')]); return Response.json(String(url).includes('subscriptions?') ? { data: [{ id: 'sub_1' }] } : { url: 'https://checkout.stripe.test/c/1' }); }, async () => {
    assert.equal((await (await ana('/api/billing/checkout', 'POST')).json()).url, 'https://checkout.stripe.test/c/1');
    assert.match(calls[0][2], new RegExp('client_reference_id=' + id)); assert.match(calls[0][2], /customer_email=ana%40example.com/);

    assert.equal((await hook({ type: 'checkout.session.completed', data: { object: { client_reference_id: id, customer: 'cus_1' } } }, 'ab'.repeat(32))).status, 400, 'a forged webhook is refused');
    assert.equal((await (await ana('/api/local')).json()).user.plan, 'free');
    assert.equal((await hook({ type: 'checkout.session.completed', data: { object: { client_reference_id: id, customer: 'cus_1' } } })).status, 200);
    assert.equal((await (await ana('/api/local')).json()).user.plan, 'pro');
    await hook({ type: 'customer.subscription.deleted', data: { object: { customer: 'cus_1', status: 'canceled' } } });
    assert.equal((await (await ana('/api/local')).json()).user.plan, 'free');

    assert.equal((await ana('/api/account', 'DELETE')).status, 200);
    assert.deepEqual(calls.at(-1).slice(0, 2), ['DELETE', 'https://api.stripe.com/v1/subscriptions/sub_1'], 'the subscription is cancelled too');
  });
  for (const t of ['users', 'projects', 'sessions', 'usage']) assert.equal(env.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, t);
  assert.equal((await env.BLOBS.list({ prefix: '' })).objects.length, 0);
});
