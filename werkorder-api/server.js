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
// Routes
//   GET /health
//   GET /api/werkorders             (optioneel ?status=OPEN&limit=10)
//   GET /api/werkorders/{id}
// ---------------------------------------------------------------
const server = http.createServer((req, res) => {
  const start = Date.now();
  const url = new URL(req.url, 'http://localhost');
  const pad = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;

  res.on('finish', () => {
    console.log(`${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - start} ms)`);
  });

  if (req.method !== 'GET') {
    return stuurFout(res, 405, 'Method Not Allowed', `${req.method} wordt niet ondersteund`, { Allow: 'GET' });
  }

  // Gezondheidscheck
  if (pad === '/health') {
    return stuurJson(res, 200, { status: 'UP' });
  }

  // Lijst met werkorders, met optioneel filter en limiet
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

    let resultaat = Object.values(WERKORDERS);
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

    return stuurJson(res, 200, { totaal: resultaat.length, items });
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

    return stuurJson(res, 200, werkorder, { 'Cache-Control': 'no-store' });
  }

  return stuurFout(res, 404, 'Not Found', `Onbekend pad: ${pad}`);
});

server.listen(PORT, () => {
  console.log(`Werkorder-API gestart op poort ${PORT}`);
});
