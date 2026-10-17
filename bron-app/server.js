'use strict';
// Bronapp (OMS-simulator). Vervangt producer.js.
//
// Wat hij doet: werkopdrachten bouwen in de bron-interface (zie bouw.js en contracts/bron/) en versturen
// naar de source-adapter via HTTP POST. Zonder ADAPTER_URL draait hij "droog": berichten worden alleen
// gebouwd en bewaard, zodat je ze kunt bekijken op GET /berichten.
//
// Een echt bronsysteem valideert niet tegen het schema van de integratielaag: dat doet de adapter.
// Daarom kun je met ?fout=<soort> opzettelijk een ongeldig bericht sturen om de afwijzing te zien.
const http = require('http');
const bouw = require('./bouw');

const PORT = Number(process.env.PORT) || 8095;
const ADAPTER_URL = process.env.ADAPTER_URL || '';
const AUTO_INTERVAL_MS = Number(process.env.AUTO_INTERVAL_MS) || 0;
const OPDRACHT_START = Number(process.env.OPDRACHT_START) || 2001;   // 1001 t/m 1003 zijn de voorbeeldwerkorders in de API
const RETRY_MAX = Number(process.env.RETRY_MAX ?? 5);
const RETRY_BASIS_MS = Number(process.env.RETRY_BASIS_MS) || 1000;
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS) || 5000;
const MAX_BODY = 64 * 1024;
const LOG_MAX = 100;

const staat = bouw.nieuweStaat({ start: OPDRACHT_START });
const berichtenLog = [];   // laatste LOG_MAX verzendpogingen, nieuwste achteraan

function log(regel) { console.log(`${new Date().toISOString()} ${regel}`); }

// ---------- Versturen ----------
// Uitkomsten: DRY_RUN | AFGELEVERD (2xx) | AFGEKEURD (4xx, geen herhaling) | OPNIEUW_PROBEREN | MISLUKT
async function eenPoging(invoer) {
  invoer.pogingen++;
  try {
    const antwoord = await fetch(ADAPTER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': invoer.bericht.kop.berichtId },
      body: JSON.stringify(invoer.bericht),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    invoer.http = antwoord.status;
    const tekst = (await antwoord.text()).slice(0, 500);
    if (antwoord.status >= 200 && antwoord.status < 300) { invoer.uitkomst = 'AFGELEVERD'; invoer.detail = tekst || null; }
    else if (antwoord.status >= 400 && antwoord.status < 500) { invoer.uitkomst = 'AFGEKEURD'; invoer.detail = tekst; }
    else { invoer.uitkomst = 'OPNIEUW_PROBEREN'; invoer.detail = tekst; }
  } catch (fout) {
    invoer.http = null;
    invoer.uitkomst = 'OPNIEUW_PROBEREN';
    invoer.detail = `geen antwoord van de adapter: ${fout.message}`;
  }

  if (invoer.uitkomst === 'OPNIEUW_PROBEREN') {
    if (invoer.pogingen > RETRY_MAX) { invoer.uitkomst = 'MISLUKT'; }
    else {
      // Zelfde bericht, zelfde berichtId: de adapter en de ontvanger moeten hiertegen bestand zijn (idempotent)
      const wacht = RETRY_BASIS_MS * 2 ** (invoer.pogingen - 1);
      setTimeout(() => eenPoging(invoer), wacht).unref?.();
    }
  }
  log(`${invoer.soort} ${invoer.opdrachtNr} (${invoer.berichtId}) poging ${invoer.pogingen}: ${invoer.uitkomst}${invoer.http ? ` HTTP ${invoer.http}` : ''}`);
  return invoer;
}

async function verstuur(bericht, { fout = null } = {}) {
  const invoer = {
    tijd: new Date().toISOString(),
    berichtId: bericht.kop.berichtId,
    soort: bericht.kop.berichtSoort,
    opdrachtNr: bericht.opdracht.opdrachtNr,
    opzettelijkFout: fout,
    pogingen: 0, uitkomst: null, http: null, detail: null,
    bericht
  };
  berichtenLog.push(invoer);
  while (berichtenLog.length > LOG_MAX) berichtenLog.shift();

  if (!ADAPTER_URL) {
    invoer.uitkomst = 'DRY_RUN';
    log(`${invoer.soort} ${invoer.opdrachtNr} (${invoer.berichtId}): DRY_RUN, niet verstuurd (ADAPTER_URL ontbreekt)`);
    return invoer;
  }
  return eenPoging(invoer);
}

const samenvatting = (i) => ({ opdrachtNr: i.opdrachtNr, berichtId: i.berichtId, soort: i.soort, uitkomst: i.uitkomst, http: i.http, detail: i.detail });

// ---------- HTTP ----------
function antwoord(res, status, data) {
  const tekst = JSON.stringify(data, null, 2) + '\n';
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(tekst);
}

function leesBody(req) {
  return new Promise((resolve, reject) => {
    const delen = []; let grootte = 0;
    req.on('data', (d) => {
      grootte += d.length;
      if (grootte > MAX_BODY) { reject(Object.assign(new Error('body te groot'), { code: 413 })); req.destroy(); return; }
      delen.push(d);
    });
    req.on('end', () => {
      const tekst = Buffer.concat(delen).toString('utf8').trim();
      if (!tekst) return resolve({});
      try { const o = JSON.parse(tekst); resolve(o && typeof o === 'object' && !Array.isArray(o) ? o : {}); }
      catch (e) { reject(Object.assign(new Error('body is geen geldige JSON'), { code: 400 })); }
    });
    req.on('error', reject);
  });
}

async function afhandelen(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pad = url.pathname.replace(/\/+$/, '') || '/';
  const m = req.method;

  if (m === 'GET' && pad === '/health') return antwoord(res, 200, { status: 'UP', adapter: ADAPTER_URL || 'DRY_RUN', automatisch: AUTO_INTERVAL_MS > 0 });

  if (m === 'GET' && pad === '/opdrachten') {
    return antwoord(res, 200, [...staat.opdrachten.entries()].map(([nr, s]) => ({
      opdrachtNr: nr, statusCode: s.opdracht.statusCode, volgnummer: s.volgnummer, ingetrokken: s.ingetrokken,
      medewerkerNr: s.opdracht.toewijzing?.medewerkerNr ?? null
    })));
  }

  if (m === 'GET' && pad === '/berichten') {
    const limiet = Math.min(Number(url.searchParams.get('limit')) || 10, LOG_MAX);
    const metBericht = url.searchParams.get('bericht') === '1';
    return antwoord(res, 200, berichtenLog.slice(-limiet).map((i) => (metBericht ? i : { ...i, bericht: undefined })));
  }

  // Nieuwe opdracht. Query: ?fout=statusCode|toewijzing|tijdstip|onbekendVeld|opdrachtNr|eenheid
  // Body (optioneel): { medewerkerNr, plaats, objectType, statusCode: "01"|"03" }
  if (m === 'POST' && pad === '/opdrachten') {
    const opties = await leesBody(req);
    const fout = url.searchParams.get('fout');
    if (fout && !bouw.FOUTEN.includes(fout)) return antwoord(res, 400, { fout: `onbekende fout '${fout}'`, toegestaan: bouw.FOUTEN });
    if (opties.plaats && !bouw.LOCATIES[opties.plaats]) return antwoord(res, 400, { fout: `onbekende plaats '${opties.plaats}'`, toegestaan: Object.keys(bouw.LOCATIES) });
    if (opties.objectType && !bouw.OBJECTSOORTEN[opties.objectType]) return antwoord(res, 400, { fout: `onbekend objectType '${opties.objectType}'`, toegestaan: Object.keys(bouw.OBJECTSOORTEN) });
    if (opties.statusCode && !['01', '03'].includes(opties.statusCode)) return antwoord(res, 400, { fout: "statusCode voor een nieuwe opdracht is '01' of '03'" });
    if (opties.medewerkerNr && !bouw.MEDEWERKERS.some((x) => x.nr === opties.medewerkerNr)) return antwoord(res, 400, { fout: `onbekende medewerker '${opties.medewerkerNr}'`, toegestaan: bouw.MEDEWERKERS.map((x) => x.nr) });
    const invoer = await verstuur(bouw.maakNieuw(staat, opties, fout), { fout });
    return antwoord(res, 201, samenvatting(invoer));
  }

  let t;
  // Wijzigen: body { statusCode, prioriteitCode, medewerkerNr, stappenGereed: [10, 20] }
  if (m === 'POST' && (t = pad.match(/^\/opdrachten\/(WOP-\d{6})\/wijzigen$/))) {
    const invoer = await verstuur(bouw.maakWijziging(staat, t[1], await leesBody(req)));
    return antwoord(res, 200, samenvatting(invoer));
  }
  // Intrekken: body { redenCode: "DUBBEL"|"FOUTIEF"|"VERVALLEN"|"OVERIG" }
  if (m === 'POST' && (t = pad.match(/^\/opdrachten\/(WOP-\d{6})\/intrekken$/))) {
    const body = await leesBody(req);
    const invoer = await verstuur(bouw.maakIntrekking(staat, t[1], body.redenCode));
    return antwoord(res, 200, samenvatting(invoer));
  }
  // Een willekeurige volgende actie (zoals de automatische modus)
  if (m === 'POST' && pad === '/volgende') {
    const invoer = await verstuur(bouw.volgendeActie(staat));
    return antwoord(res, 200, samenvatting(invoer));
  }

  antwoord(res, 404, { fout: 'niet gevonden', endpoints: [
    'GET /health', 'GET /opdrachten', 'GET /berichten?limit=10&bericht=1',
    'POST /opdrachten[?fout=...]', 'POST /opdrachten/{WOP-nr}/wijzigen', 'POST /opdrachten/{WOP-nr}/intrekken', 'POST /volgende'
  ] });
}

const server = http.createServer((req, res) => {
  afhandelen(req, res).catch((fout) => {
    const status = fout.code && Number.isInteger(fout.code) ? fout.code : 500;
    if (status === 500) console.error(`Onverwachte fout: ${fout.stack || fout.message}`);
    if (!res.headersSent) antwoord(res, status, { fout: status === 500 ? 'interne fout' : fout.message });
  });
});

server.listen(PORT, () => {
  log(`Bronapp (OMS) gestart op poort ${PORT}; adapter: ${ADAPTER_URL || 'geen (DRY_RUN)'}; eerste opdrachtnummer: WOP-${String(OPDRACHT_START).padStart(6, '0')}`);
});

let timer = null;
if (AUTO_INTERVAL_MS > 0) {
  log(`Automatische modus: elke ${AUTO_INTERVAL_MS} ms een willekeurige actie`);
  timer = setInterval(() => { verstuur(bouw.volgendeActie(staat)).catch((e) => console.error(`Automatische actie mislukt: ${e.message}`)); }, AUTO_INTERVAL_MS);
}

for (const signaal of ['SIGTERM', 'SIGINT']) {
  process.on(signaal, () => { if (timer) clearInterval(timer); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
}
