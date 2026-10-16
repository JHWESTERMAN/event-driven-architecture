const http = require('http');

const PORT = process.env.PORT || 8081;

// ---------------------------------------------------------------
// Voorbeelddata (in een echte situatie komt dit uit het werkordersysteem)
// De werkorder is de "volledige" versie; het Kafka-event bevat alleen id, status en bericht.
// Let op: "taken" en "materiaal" zijn lijsten (kardinaliteit 0..*)
// ---------------------------------------------------------------
const WERKORDERS = {
  'WO-1001': {
    werkorderId: 'WO-1001',
    status: 'OPEN',
    prioriteit: 'HOOG',
    omschrijving: 'Storing wissel 214, wisselmotor reageert niet',
    locatie: { plaats: 'Breda', spoorEmplacement: 'Breda Noord', coordinaten: { lat: 51.6, lon: 4.78 } },
    monteur: { id: 'M-017', naam: 'J. de Vries' },
    aangemaaktOp: '2026-10-16T06:12:00Z',
    taken: [
      { taakId: 'T-1', omschrijving: 'Wissel veiligstellen', gereed: true },
      { taakId: 'T-2', omschrijving: 'Wisselmotor controleren', gereed: false },
      { taakId: 'T-3', omschrijving: 'Rapport invullen', gereed: false }
    ],
    materiaal: [
      { artikelnr: 'WM-204', omschrijving: 'Wisselmotor 220V', aantal: 1 }
    ]
  },
  'WO-1002': {
    werkorderId: 'WO-1002',
    status: 'IN_BEHANDELING',
    prioriteit: 'NORMAAL',
    omschrijving: 'Seinlamp vervangen',
    locatie: { plaats: 'Tilburg', spoorEmplacement: 'Tilburg West', coordinaten: { lat: 51.56, lon: 5.08 } },
    monteur: { id: 'M-017', naam: 'J. de Vries' },
    aangemaaktOp: '2026-10-16T07:40:00Z',
    taken: [
      { taakId: 'T-1', omschrijving: 'Lamp vervangen', gereed: false }
    ],
    materiaal: []
  },
  'WO-1003': {
    werkorderId: 'WO-1003',
    status: 'AFGEROND',
    prioriteit: 'LAAG',
    omschrijving: 'Jaarlijkse inspectie overweg',
    locatie: { plaats: 'Eindhoven', spoorEmplacement: 'Eindhoven Zuid', coordinaten: { lat: 51.43, lon: 5.48 } },
    monteur: { id: 'M-022', naam: 'S. Jansen' },
    aangemaaktOp: '2026-10-15T13:05:00Z',
    taken: [
      { taakId: 'T-1', omschrijving: 'Inspectie uitvoeren', gereed: true },
      { taakId: 'T-2', omschrijving: 'Rapport indienen', gereed: true }
    ],
    materiaal: []
  }
};

const TOEGESTANE_STATUSSEN = ['OPEN', 'IN_BEHANDELING', 'AFGEROND'];
const ID_PATROON = /^WO-\d+$/;

// ===============================================================
// OIDC-tokenvalidatie (staat identiek in ws-microservice en werkorder-api)
//
// Controleert een JWT (access token) van Keycloak zonder extra bibliotheken:
//   - handtekening: alleen RS256, met de publieke sleutels uit de JWKS van de identity provider
//   - uitgever (iss) en doelgroep (aud) moeten kloppen
//   - exp en nbf (met een kleine marge voor klokverschil)
//   - het monteur-id komt uit de gebruikersnaam in het token (M-017 staat in Keycloak als m-017)
// Het token wordt hier nooit gelogd.
// ===============================================================
const crypto = require('crypto');

if (typeof fetch !== 'function') {
  console.error('Deze service heeft Node.js 18 of hoger nodig (fetch ontbreekt)');
  process.exit(1);
}

// De uitgever die in het token staat. Dit is de URL waarmee de BROWSER bij Keycloak komt.
const OIDC_ISSUER = process.env.OIDC_ISSUER || 'http://localhost:8180/realms/werkorders';
// Waar deze service de publieke sleutels ophaalt. Dat mag een interne URL zijn (binnen Docker of het cluster).
const OIDC_JWKS_URL = process.env.OIDC_JWKS_URL ||
  'http://keycloak:8080/realms/werkorders/protocol/openid-connect/certs';
// Voor wie het token bedoeld moet zijn (de "aud" claim). Keycloak zet die via een audience-mapper.
const OIDC_AUDIENCE = process.env.OIDC_AUDIENCE || 'werkorders-api';

const JWKS_CACHE_MS = 10 * 60 * 1000;                                           // sleutels zo lang bewaren
const JWKS_MIN_INTERVAL_MS = Number(process.env.OIDC_JWKS_MIN_INTERVAL_MS) || 30 * 1000; // bij onbekende sleutel: niet vaker ophalen
const KLOK_MARGE_S = 5;
const TOKEN_MONTEUR_PATROON = /^M-\d+$/;

// soort: 'ONGELDIG' (het token deugt niet) of 'ONBESCHIKBAAR' (we kunnen het nu niet controleren)
class TokenFout extends Error {
  constructor(bericht, soort = 'ONGELDIG') {
    super(bericht);
    this.name = 'TokenFout';
    this.soort = soort;
  }
}

let jwksSleutels = new Map(); // kid -> publieke sleutel
let jwksPoging = 0;           // tijdstip van de laatste poging (gelukt of mislukt)
let jwksBezig = null;

function haalJwksOp() {
  if (jwksBezig) return jwksBezig;
  jwksBezig = (async () => {
    try {
      const antwoord = await fetch(OIDC_JWKS_URL, { signal: AbortSignal.timeout(5000) });
      if (!antwoord.ok) throw new Error(`HTTP ${antwoord.status}`);
      const { keys } = await antwoord.json();
      if (!Array.isArray(keys)) throw new Error('antwoord bevat geen sleutels');

      const nieuw = new Map();
      for (const jwk of keys) {
        // Keycloak publiceert ook sleutels om mee te versleutelen (use=enc); die gebruiken we niet.
        if (jwk && jwk.kty === 'RSA' && typeof jwk.kid === 'string' && (jwk.use === undefined || jwk.use === 'sig')) {
          nieuw.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
        }
      }
      if (nieuw.size === 0) throw new Error('geen RSA-sleutels gevonden');
      jwksSleutels = nieuw;
    } catch (fout) {
      throw new TokenFout(`sleutels ophalen bij de identity provider mislukt: ${fout.message}`, 'ONBESCHIKBAAR');
    } finally {
      jwksPoging = Date.now();
      jwksBezig = null;
    }
  })();
  return jwksBezig;
}

async function zoekSleutel(kid) {
  const leeftijd = Date.now() - jwksPoging;

  if (jwksSleutels.size === 0) {
    // Nog nooit gelukt (of net mislukt): niet bij elk token opnieuw proberen
    if (leeftijd > 2000) await haalJwksOp();
  } else if (leeftijd > JWKS_CACHE_MS) {
    // Verlopen cache vernieuwen; is de identity provider even weg, dan blijven de oude sleutels bruikbaar
    try { await haalJwksOp(); } catch (fout) { /* oude sleutels blijven staan */ }
  }

  let sleutel = jwksSleutels.get(kid);
  if (!sleutel && Date.now() - jwksPoging > JWKS_MIN_INTERVAL_MS) {
    await haalJwksOp(); // onbekende sleutel: misschien is er geroteerd
    sleutel = jwksSleutels.get(kid);
  }

  if (!sleutel) {
    if (jwksSleutels.size === 0) throw new TokenFout('identity provider niet bereikbaar', 'ONBESCHIKBAAR');
    throw new TokenFout('onbekende sleutel (kid)');
  }
  return sleutel;
}

function decodeerJson(deel) {
  return JSON.parse(Buffer.from(deel, 'base64url').toString('utf8'));
}

// Geeft { sub, monteurId, naam, exp } terug, of gooit een TokenFout.
async function verifieerToken(token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 8192) {
    throw new TokenFout('token ontbreekt of is te lang');
  }
  const delen = token.split('.');
  if (delen.length !== 3) throw new TokenFout('geen geldig JWT-formaat');

  let kop, claims;
  try {
    kop = decodeerJson(delen[0]);
    claims = decodeerJson(delen[1]);
  } catch (fout) {
    throw new TokenFout('token is geen geldige JSON');
  }
  if (!kop || typeof kop !== 'object' || !claims || typeof claims !== 'object') {
    throw new TokenFout('token is geen geldig object');
  }

  // Alleen RS256. Daarmee vallen "alg: none" en HS256-trucs (publieke sleutel als wachtwoord) af.
  if (kop.alg !== 'RS256') throw new TokenFout(`algoritme '${kop.alg}' is niet toegestaan (alleen RS256)`);
  if (typeof kop.kid !== 'string' || kop.kid === '') throw new TokenFout('kid ontbreekt');

  const sleutel = await zoekSleutel(kop.kid);
  const geldig = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${delen[0]}.${delen[1]}`),
    sleutel,
    Buffer.from(delen[2], 'base64url')
  );
  if (!geldig) throw new TokenFout('handtekening klopt niet');

  if (claims.iss !== OIDC_ISSUER) {
    throw new TokenFout(`uitgever '${claims.iss}' komt niet overeen met '${OIDC_ISSUER}'`);
  }
  const doelgroep = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!doelgroep.includes(OIDC_AUDIENCE)) {
    throw new TokenFout(`token is niet bedoeld voor '${OIDC_AUDIENCE}'`);
  }

  const nu = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(claims.exp) || claims.exp + KLOK_MARGE_S <= nu) throw new TokenFout('token is verlopen');
  if (Number.isFinite(claims.nbf) && claims.nbf - KLOK_MARGE_S > nu) throw new TokenFout('token is nog niet geldig');

  // Keycloak bewaart gebruikersnamen in kleine letters: m-017 hoort bij monteur M-017
  const monteurId = typeof claims.preferred_username === 'string' ? claims.preferred_username.toUpperCase() : '';
  if (!TOKEN_MONTEUR_PATROON.test(monteurId)) throw new TokenFout('token bevat geen geldig monteur-id');

  return {
    sub: typeof claims.sub === 'string' ? claims.sub : null,
    monteurId,
    naam: typeof claims.name === 'string' ? claims.name : null,
    exp: claims.exp
  };
}
// ===== einde OIDC-tokenvalidatie =====

// ---------------------------------------------------------------
// Hulpfuncties
// ---------------------------------------------------------------
function stuurJson(res, statusCode, body, extraHeaders = {}) {
  const tekst = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(tekst),
    ...extraHeaders
  });
  res.end(tekst);
}

// Foutantwoord in de stijl van RFC 7807 (problem+json): een vaste, voorspelbare structuur
function stuurFout(res, statusCode, titel, detail, extraHeaders = {}) {
  stuurJson(res, statusCode, { status: statusCode, title: titel, detail }, extraHeaders);
}

// ---------------------------------------------------------------
// Authenticatie
// Elk verzoek onder /api/ moet een geldig access token van Keycloak meesturen:
//   Authorization: Bearer <token>
// Het monteur-id komt uit het token, nooit uit de URL of de body.
// ---------------------------------------------------------------
function haalBearerToken(req) {
  const kop = req.headers.authorization;
  if (typeof kop !== 'string') return null;
  const gevonden = kop.match(/^Bearer\s+(\S+)$/i);
  return gevonden ? gevonden[1] : null;
}

// Geeft de gegevens van de aanvrager terug. Is er iets mis, dan stuurt deze functie zelf het
// foutantwoord (401 of 503) en geeft ze null terug.
async function authenticeer(req, res) {
  const token = haalBearerToken(req);
  if (!token) {
    stuurFout(res, 401, 'Unauthorized',
      'Inloggen is vereist: stuur een Bearer-token mee in de Authorization-header',
      { 'WWW-Authenticate': 'Bearer realm="werkorders"' });
    return null;
  }

  try {
    const gebruiker = await verifieerToken(token);
    req.monteurId = gebruiker.monteurId; // voor in de log
    return gebruiker;
  } catch (fout) {
    if (fout instanceof TokenFout && fout.soort === 'ONBESCHIKBAAR') {
      console.error(`Token kon niet worden gecontroleerd: ${fout.message}`);
      stuurFout(res, 503, 'Service Unavailable',
        'Inloggen is tijdelijk niet beschikbaar, probeer het zo opnieuw', { 'Retry-After': '5' });
      return null;
    }
    if (!(fout instanceof TokenFout)) throw fout;

    // De precieze reden staat alleen in de log. Naar de client geven we geen aanwijzingen die een aanvaller helpen.
    console.warn(`Token geweigerd: ${fout.message}`);
    stuurFout(res, 401, 'Unauthorized', 'Het token is ongeldig of verlopen',
      { 'WWW-Authenticate': 'Bearer realm="werkorders", error="invalid_token"' });
    return null;
  }
}

// ---------------------------------------------------------------
// Routes
//   GET /health                      (zonder token)
//   GET /api/werkorders              (eigen werkorders; optioneel ?status=OPEN&limit=10)
//   GET /api/werkorders/{id}         (alleen als de werkorder bij jou hoort, anders 403)
// ---------------------------------------------------------------
async function verwerk(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pad = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;

  if (req.method !== 'GET') {
    return stuurFout(res, 405, 'Method Not Allowed', `${req.method} wordt niet ondersteund`, { Allow: 'GET' });
  }

  // Gezondheidscheck: bewust zonder token, zodat Kubernetes en Docker hem kunnen gebruiken
  if (pad === '/health') {
    return stuurJson(res, 200, { status: 'UP' });
  }

  if (pad !== '/api' && !pad.startsWith('/api/')) {
    return stuurFout(res, 404, 'Not Found', `Onbekend pad: ${pad}`);
  }

  const gebruiker = await authenticeer(req, res);
  if (!gebruiker) return;

  // Lijst met eigen werkorders, met optioneel filter en limiet
  if (pad === '/api/werkorders') {
    const status = url.searchParams.get('status');
    const limietTekst = url.searchParams.get('limit');

    if (status !== null && !TOEGESTANE_STATUSSEN.includes(status)) {
      return stuurFout(
        res, 400, 'Bad Request',
        `status '${status}' is ongeldig (toegestaan: ${TOEGESTANE_STATUSSEN.join(', ')})`
      );
    }

    let limiet = 50;
    if (limietTekst !== null) {
      limiet = Number(limietTekst);
      if (!Number.isInteger(limiet) || limiet < 1 || limiet > 100) {
        return stuurFout(res, 400, 'Bad Request', 'limit moet een geheel getal tussen 1 en 100 zijn');
      }
    }

    // Je ziet alleen je eigen werkorders, ook in de lijst
    let resultaat = Object.values(WERKORDERS).filter((w) => w.monteur.id === gebruiker.monteurId);
    if (status !== null) {
      resultaat = resultaat.filter((w) => w.status === status);
    }

    // Lijst bewust compacter dan het detail (alleen de kern per werkorder)
    const items = resultaat.slice(0, limiet).map((w) => ({
      werkorderId: w.werkorderId,
      status: w.status,
      prioriteit: w.prioriteit,
      omschrijving: w.omschrijving
    }));

    return stuurJson(res, 200, { totaal: resultaat.length, items }, { 'Cache-Control': 'no-store' });
  }

  // Detail van één werkorder
  const match = pad.match(/^\/api\/werkorders\/([^/]+)$/);
  if (match) {
    let id;
    try {
      id = decodeURIComponent(match[1]);
    } catch (err) {
      return stuurFout(res, 400, 'Bad Request', 'Ongeldig id (verkeerde codering)');
    }

    if (!ID_PATROON.test(id)) {
      return stuurFout(res, 400, 'Bad Request', `Ongeldig id '${id}' (verwacht: WO- gevolgd door cijfers)`);
    }

    const werkorder = WERKORDERS[id];
    if (!werkorder) {
      return stuurFout(res, 404, 'Not Found', `Werkorder ${id} bestaat niet`);
    }

    // De eigenaarscheck: een geldig token is niet genoeg, de werkorder moet ook bij deze monteur horen.
    // Dit is de controle die voorkomt dat je andermans werkorders kunt lezen door een id te raden.
    if (werkorder.monteur.id !== gebruiker.monteurId) {
      console.warn(`Toegang geweigerd: ${gebruiker.monteurId} vroeg ${id} op (eigenaar: ${werkorder.monteur.id})`);
      return stuurFout(res, 403, 'Forbidden', `Je hebt geen toegang tot werkorder ${id}`);
    }

    return stuurJson(res, 200, werkorder, { 'Cache-Control': 'no-store' });
  }

  return stuurFout(res, 404, 'Not Found', `Onbekend pad: ${pad}`);
}

const server = http.createServer((req, res) => {
  const start = Date.now();

  res.on('finish', () => {
    const wie = req.monteurId ? ` [${req.monteurId}]` : '';
    console.log(`${req.method} ${req.url} -> ${res.statusCode}${wie} (${Date.now() - start} ms)`);
  });

  verwerk(req, res).catch((fout) => {
    console.error('Onverwachte fout:', fout);
    if (!res.headersSent) {
      stuurFout(res, 500, 'Internal Server Error', 'Er ging iets mis');
    } else {
      res.end();
    }
  });
});

server.listen(PORT, () => {
  console.log(`Werkorder-API gestart op poort ${PORT} (uitgever: ${OIDC_ISSUER}, doelgroep: ${OIDC_AUDIENCE})`);
});
