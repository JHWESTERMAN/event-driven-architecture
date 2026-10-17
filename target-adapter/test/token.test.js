const test = require('node:test');
const assert = require('node:assert/strict');
const { maakTokenBron } = require('../src/token');
const { schrijfWerkorder } = require('../src/api');

const antwoordJson = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

test('token wordt opgehaald met client credentials, bewaard en vlak voor verlopen vernieuwd', async () => {
  let nu = 1_000_000, aantal = 0, laatste;
  const fetchFn = async (url, opt) => { aantal++; laatste = { url, opt }; return antwoordJson(200, { access_token: `t${aantal}`, expires_in: 300 }); };
  const bron = maakTokenBron({ tokenUrl: 'http://kc/token', clientId: 'target-adapter', clientSecret: 'geheim', fetchFn, nu: () => nu });
  assert.equal(await bron.haal(), 't1');
  assert.equal(await bron.haal(), 't1');
  assert.equal(aantal, 1);
  assert.match(laatste.opt.body, /grant_type=client_credentials/);
  assert.match(laatste.opt.body, /client_id=target-adapter/);
  assert.match(laatste.opt.body, /client_secret=geheim/);
  nu += 280_000;                                    // binnen de marge van 30 s voor verlopen
  assert.equal(await bron.haal(), 't2');
});

test('gelijktijdige aanvragen delen één ophaalactie', async () => {
  let aantal = 0;
  const fetchFn = async () => { aantal++; await new Promise((r) => setTimeout(r, 20)); return antwoordJson(200, { access_token: 'x', expires_in: 60 }); };
  const bron = maakTokenBron({ tokenUrl: 'u', clientId: 'c', clientSecret: 's', fetchFn });
  await Promise.all([bron.haal(), bron.haal(), bron.haal()]);
  assert.equal(aantal, 1);
});

test('Keycloak weigert of is weg: fout met duidelijke tekst', async () => {
  const weigert = maakTokenBron({ tokenUrl: 'u', clientId: 'c', clientSecret: 'fout', fetchFn: async () => antwoordJson(401, {}) });
  await assert.rejects(weigert.haal(), /weigerde de inlog.*401/);
  const weg = maakTokenBron({ tokenUrl: 'u', clientId: 'c', clientSecret: 's', fetchFn: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(weg.haal(), /niet bereikbaar/);
});

test('API-aanroep gebruikt Bearer; geen token is een tijdelijke fout; 401 laat het token vergeten', async () => {
  const gezien = [];
  const fetchFn = async (url, opt) => { gezien.push(opt.headers); return antwoordJson(401, { title: 'Unauthorized' }); };
  let vergeten = 0;
  const tokenBron = { haal: async () => 'abc', vergeet: () => { vergeten++; } };
  const r = await schrijfWerkorder({ baseUrl: 'http://api', tokenBron, werkorderId: 'WO-1', body: {}, fetchFn });
  assert.equal(r.soort, 'TIJDELIJK');
  assert.equal(gezien[0].Authorization, 'Bearer abc');
  assert.equal('X-Api-Key' in gezien[0], false);
  assert.equal(vergeten, 1);

  const kapot = { haal: async () => { throw new Error('Keycloak niet bereikbaar'); }, vergeet() {} };
  const r2 = await schrijfWerkorder({ baseUrl: 'http://api', tokenBron: kapot, werkorderId: 'WO-1', body: {}, fetchFn });
  assert.equal(r2.soort, 'TIJDELIJK');
  assert.match(r2.reden, /geen token/);
});

test('zonder tokenBron wordt de API-sleutel gebruikt (lokale modus)', async () => {
  let h;
  await schrijfWerkorder({ baseUrl: 'http://api', apiKey: 'k', werkorderId: 'WO-1', body: {}, fetchFn: async (u, o) => { h = o.headers; return antwoordJson(200, {}); } });
  assert.equal(h['X-Api-Key'], 'k');
});
