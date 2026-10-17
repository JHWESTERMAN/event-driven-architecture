'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { leesGeheim } = require('../src/omgeving');
const { configUitOmgeving } = require('../src/server');

function tijdelijkBestand(inhoud) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geheim-'));
  const pad = path.join(dir, 'geheim');
  fs.writeFileSync(pad, inhoud);
  return { pad, ruim: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('geheim: NAAM_FILE gaat voor NAAM en één afsluitende regeleinde valt weg', (t) => {
  const f = tijdelijkBestand('uit-bestand\n'); t.after(f.ruim);
  assert.equal(leesGeheim({ W: 'uit-omgeving', W_FILE: f.pad }, 'W'), 'uit-bestand');
});

test('geheim: spaties en een tweede regeleinde horen bij het geheim', (t) => {
  const f = tijdelijkBestand(' a b \n\n'); t.after(f.ruim);
  assert.equal(leesGeheim({ W_FILE: f.pad }, 'W'), ' a b \n');
});

test('geheim: zonder bestand telt de omgevingsvariabele, anders de standaardwaarde', () => {
  assert.equal(leesGeheim({ W: 'x' }, 'W'), 'x');
  assert.equal(leesGeheim({}, 'W', 'standaard'), 'standaard');
  assert.equal(leesGeheim({ W: '' }, 'W'), '');
});

test('geheim: een ontbrekend of leeg bestand is een duidelijke fout, geen stille terugval', (t) => {
  const leeg = tijdelijkBestand('\n'); t.after(leeg.ruim);
  assert.throws(() => leesGeheim({ W: 'terugval', W_FILE: '/bestaat/niet' }, 'W'), /W_FILE: kan \/bestaat\/niet niet lezen/);
  assert.throws(() => leesGeheim({ W: 'terugval', W_FILE: leeg.pad }, 'W'), /is leeg/);
});

test('config: het brokerwachtwoord en de TLS-instelling komen uit de omgeving, bestand boven variabele', (t) => {
  const f = tijdelijkBestand('uit-kluis'); t.after(f.ruim);
  const c = configUitOmgeving({ BROKER_PASSWORD: 'oud', BROKER_PASSWORD_FILE: f.pad, BROKER_TLS: 'true' });
  assert.equal(c.brokerPassword, 'uit-kluis');
  assert.equal(c.brokerTls.transport, 'tls');
  assert.deepEqual(configUitOmgeving({}).brokerTls, {});
});
