const { Kafka } = require('kafkajs');
const { WebSocketServer, WebSocket } = require('ws');

const KAFKA_BROKER = process.env.KAFKA_BROKER || 'redpanda:9092';
const KAFKA_TOPIC = process.env.KAFKA_TOPIC || 'werkorder-notificaties';
const DLQ_TOPIC = process.env.DLQ_TOPIC || `${KAFKA_TOPIC}.dlq`;
const PORT = process.env.PORT || 8080;
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS) || 30000;

// Inhalen: hoeveel meldingen en hoe lang bewaren we per monteur voor wie even weg was?
const INHAAL_MAX_PER_MONTEUR = Number(process.env.INHAAL_MAX_PER_MONTEUR) || 100;
const INHAAL_MAX_LEEFTIJD_MS = Number(process.env.INHAAL_MAX_LEEFTIJD_MS) || 24 * 60 * 60 * 1000;
const OPRUIM_MS = Number(process.env.OPRUIM_MS) || 10 * 60 * 1000;

// Tijdstip zoals Date.toISOString() dat maakt, bijvoorbeeld 2026-10-16T14:03:22.123Z
const ISO_TIJDSTIP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

// Authenticatie: na het verbinden moet de client binnen deze tijd een AUTH-bericht sturen
const AUTH_TIMEOUT_MS = Number(process.env.AUTH_TIMEOUT_MS) || 5000;
// Een AUTH-bericht is klein (een token is een paar KB). Alles wat groter is, sluiten we af.
const MAX_BERICHT_BYTES = 16 * 1024;

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

// Toegestane waarden voor het veld "status" (de enum uit het contract)
const TOEGESTANE_STATUSSEN = ['OPEN', 'IN_BEHANDELING', 'AFGEROND'];

// Formaat van een monteur-id, bijvoorbeeld M-017
const MONTEUR_PATROON = /^M-\d+$/;

// ---------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------
const wss = new WebSocketServer({ port: PORT, maxPayload: MAX_BERICHT_BYTES });
console.log(`WebSocket Microservice gestart op poort ${PORT}`);

// Wie is waar verbonden? monteurId -> verzameling verbindingen
// Eén monteur kan meerdere verbindingen hebben (bijvoorbeeld telefoon en tablet).
const verbindingen = new Map();

function registreer(monteurId, ws) {
  if (!verbindingen.has(monteurId)) {
    verbindingen.set(monteurId, new Set());
  }
  verbindingen.get(monteurId).add(ws);
}

function verwijder(monteurId, ws) {
  const set = verbindingen.get(monteurId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) {
    verbindingen.delete(monteurId);
  }
}

// ---------------------------------------------------------------
// Inhaalbuffer: de laatste meldingen per monteur, ook als die offline is.
// Bij het verbinden vraagt de client met ?since= wat hij gemist heeft.
// Let op: dit leeft in het geheugen van dit proces. Na een herstart is de buffer leeg.
// In productie hoort dit in een gedeelde opslag (bijvoorbeeld Redis) of in Kafka zelf.
// ---------------------------------------------------------------
const inhaalBuffer = new Map(); // monteurId -> [{ eventId, tijdstipMs, melding }]

function bewaarVoorInhalen(monteurId, invoer) {
  let lijst = inhaalBuffer.get(monteurId);
  if (!lijst) {
    lijst = [];
    inhaalBuffer.set(monteurId, lijst);
  }
  // Kafka garandeert "minstens één keer": dezelfde melding kan dubbel binnenkomen.
  if (lijst.some((e) => e.eventId === invoer.eventId)) return;

  lijst.push(invoer);
  while (lijst.length > INHAAL_MAX_PER_MONTEUR) lijst.shift();
}

// Meldingen vanaf (en inclusief) dit tijdstip, oudste eerst, nooit ouder dan de maximale leeftijd.
function haalInhaalOp(monteurId, sindsMs) {
  const lijst = inhaalBuffer.get(monteurId) || [];
  const grens = Math.max(sindsMs, Date.now() - INHAAL_MAX_LEEFTIJD_MS);
  return lijst
    .filter((e) => e.tijdstipMs >= grens)
    .sort((a, b) => a.tijdstipMs - b.tijdstipMs);
}

function ruimInhaalBufferOp() {
  const grens = Date.now() - INHAAL_MAX_LEEFTIJD_MS;
  for (const [monteurId, lijst] of inhaalBuffer) {
    const over = lijst.filter((e) => e.tijdstipMs >= grens);
    if (over.length === 0) inhaalBuffer.delete(monteurId);
    else if (over.length !== lijst.length) inhaalBuffer.set(monteurId, over);
  }
}

// unref: deze timer mag het proces niet in leven houden
setInterval(ruimInhaalBufferOp, OPRUIM_MS).unref();

// Stuurt een melding alleen naar de verbindingen van deze monteur.
// Geeft het aantal verbindingen terug waarnaar is verstuurd.
function stuurNaarMonteur(monteurId, data) {
  const set = verbindingen.get(monteurId);
  let aantal = 0;

  if (set) {
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
        aantal++;
      }
    }
  }

  if (aantal === 0) {
    console.warn(`Monteur ${monteurId} is niet verbonden: melding bewaard voor inhalen`);
  } else {
    console.log(`Melding voor ${monteurId} afgeleverd aan ${aantal} verbinding(en)`);
  }
  return aantal;
}

// Verbinden gaat in twee stappen:
//   1. De client verbindt met /ws (optioneel met ?since=<tijdstip> om gemiste meldingen op te halen).
//   2. De client stuurt als EERSTE bericht {"type":"AUTH","token":"<access token>"}.
// Het token zit bewust niet in de URL: URL's komen in logs van proxies en gateways terecht, berichten niet.
// Het monteur-id komt uit het token. Wat de client zelf beweert, doet er niet toe.
wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  const url = new URL(req.url, 'http://localhost');

  // Optioneel: ?since=<ISO-tijdstip> = "stuur me wat ik gemist heb vanaf dit moment"
  let sindsMs = null;
  const sindsTekst = url.searchParams.get('since');
  if (sindsTekst !== null) {
    if (!ISO_TIJDSTIP.test(sindsTekst) || Number.isNaN(Date.parse(sindsTekst))) {
      console.warn(`Verbinding vanaf ${clientIp} geweigerd: since '${sindsTekst}' is ongeldig`);
      ws.close(1008, 'since is ongeldig (verwacht ISO 8601, bijvoorbeeld 2026-10-16T14:03:22.123Z)');
      return;
    }
    sindsMs = Date.parse(sindsTekst);
  }

  ws.isLevend = true;
  ws.monteurId = null;      // pas gevuld na een geslaagde AUTH
  ws.authBezig = false;

  // Wie niet binnen korte tijd inlogt, wordt losgelaten. Zo blijven er geen halve verbindingen hangen.
  const authTimer = setTimeout(() => {
    if (!ws.monteurId) {
      console.warn(`Verbinding vanaf ${clientIp} gesloten: geen AUTH-bericht binnen ${AUTH_TIMEOUT_MS} ms`);
      ws.close(1008, 'geen AUTH-bericht ontvangen');
    }
  }, AUTH_TIMEOUT_MS);

  ws.on('message', async (data) => {
    // Na het inloggen verwachten we niets meer van de client; verder verkeer negeren we.
    if (ws.monteurId || ws.authBezig) return;
    ws.authBezig = true;

    let bericht = null;
    try { bericht = JSON.parse(data.toString()); } catch (fout) { /* hieronder afgehandeld */ }
    if (!bericht || bericht.type !== 'AUTH' || typeof bericht.token !== 'string') {
      console.warn(`Verbinding vanaf ${clientIp} gesloten: eerste bericht was geen AUTH`);
      ws.close(1008, 'eerste bericht moet {"type":"AUTH","token":"..."} zijn');
      return;
    }

    let gebruiker;
    try {
      gebruiker = await verifieerToken(bericht.token);
    } catch (fout) {
      if (fout instanceof TokenFout && fout.soort === 'ONBESCHIKBAAR') {
        console.error(`Token van ${clientIp} kon niet worden gecontroleerd: ${fout.message}`);
        ws.close(1013, 'inloggen is tijdelijk niet beschikbaar, probeer het zo opnieuw');
      } else if (fout instanceof TokenFout) {
        // De reden staat alleen in de log; de client krijgt een algemene melding
        console.warn(`Verbinding vanaf ${clientIp} geweigerd: ${fout.message}`);
        ws.close(1008, 'authenticatie mislukt');
      } else {
        console.error(`Onverwachte fout bij het controleren van een token: ${fout.message}`);
        ws.close(1011, 'interne fout');
      }
      return;
    }

    if (ws.readyState !== WebSocket.OPEN) return; // de client was intussen weg

    const monteurId = gebruiker.monteurId;
    ws.monteurId = monteurId;
    clearTimeout(authTimer);
    registreer(monteurId, ws);
    console.log(`Monteur ${monteurId} verbonden via Gateway vanaf IP: ${clientIp}`);

    ws.send(JSON.stringify({
      type: 'SYSTEM',
      message: `Verbonden met het Werkorder Notificatiesysteem als ${monteurId}`
    }));

    // Inhalen gebeurt in dezelfde stap als registreren. Node verwerkt dit zonder onderbreking,
    // dus er kan geen nieuwe melding tussen het inhalen en het live ontvangen glippen of dubbel komen.
    if (sindsMs !== null) {
      const gemist = haalInhaalOp(monteurId, sindsMs);
      for (const invoer of gemist) {
        ws.send(JSON.stringify({ ...invoer.melding, inhaal: true }));
      }
      console.log(`Monteur ${monteurId}: ${gemist.length} bewaarde melding(en) nagestuurd (since ${sindsTekst})`);
    }

    // Een verbinding mag niet langer duren dan het token. Bij verloop sluiten we met code 4401;
    // de app ververst dan zijn token en verbindt opnieuw (waarbij hij via ?since= inhaalt wat er tussen zat).
    const msTotVerloop = gebruiker.exp * 1000 - Date.now();
    ws.verlooptimer = setTimeout(
      () => ws.close(4401, 'token verlopen'),
      Math.min(Math.max(msTotVerloop, 0), 2 ** 31 - 1)
    );
    ws.verlooptimer.unref?.();
  });

  ws.on('pong', () => {
    ws.isLevend = true;
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    clearTimeout(ws.verlooptimer);
    if (ws.monteurId) {
      verwijder(ws.monteurId, ws);
      console.log(`Monteur ${ws.monteurId} verbinding verbroken`);
    }
  });

  ws.on('error', (err) => {
    console.error(`Fout op verbinding van ${ws.monteurId || clientIp}: ${err.message}`);
  });
});

// Heartbeat: verbindingen die niet meer antwoorden op een ping worden opgeruimd.
// Zonder dit blijven verbindingen van monteurs zonder bereik in het register staan.
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isLevend === false) {
      ws.terminate();
      return;
    }
    ws.isLevend = false;
    ws.ping();
  });
}, HEARTBEAT_MS);

wss.on('close', () => clearInterval(heartbeat));

// ---------------------------------------------------------------
// Validatie van het berichtcontract
// Geeft een lijst met fouten terug; lege lijst = geldig bericht
// ---------------------------------------------------------------
function valideerWerkorder(data) {
  const fouten = [];

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return ['Bericht moet een JSON-object zijn'];
  }

  if (typeof data.werkorderId !== 'string' || data.werkorderId.trim() === '') {
    fouten.push('werkorderId ontbreekt of is geen tekst');
  }

  if (typeof data.monteurId !== 'string' || !MONTEUR_PATROON.test(data.monteurId)) {
    fouten.push('monteurId ontbreekt of heeft een ongeldig formaat (verwacht: M- gevolgd door cijfers)');
  }

  if (!TOEGESTANE_STATUSSEN.includes(data.status)) {
    fouten.push(
      `status '${data.status}' is ongeldig (toegestaan: ${TOEGESTANE_STATUSSEN.join(', ')})`
    );
  }

  if (typeof data.bericht !== 'string' || data.bericht.trim() === '') {
    fouten.push('bericht ontbreekt of is geen tekst');
  }

  return fouten;
}

// ---------------------------------------------------------------
// Kafka: consumer + producer (de producer is voor de dead letter topic)
// ---------------------------------------------------------------
const kafka = new Kafka({
  clientId: 'werkorder-ws-service',
  brokers: [KAFKA_BROKER]
});

const consumer = kafka.consumer({ groupId: 'monteur-notificatie-group' });
const producer = kafka.producer();

consumer.on(consumer.events.CRASH, ({ payload }) => {
  console.error(`Consumer gecrasht: ${payload.error.message}`);

  // Alleen stoppen als kafkajs zichzelf niet meer herstelt (zoals bij Snappy)
  if (!payload.restart) {
    console.error('Geen automatisch herstel mogelijk, container wordt herstart');
    process.exit(1);
  }
});

// Stuurt een onverwerkbaar bericht naar het dead letter topic,
// samen met de reden en de herkomst (topic, partitie, offset)
async function stuurNaarDlq({ topic, partition, message, reden }) {
  try {
    await producer.send({
      topic: DLQ_TOPIC,
      messages: [{
        key: message.key,
        value: message.value, // originele bericht ongewijzigd bewaren
        headers: {
          'dlq-reden': String(reden),
          'dlq-bron-topic': topic,
          'dlq-bron-partitie': String(partition),
          'dlq-bron-offset': String(message.offset),
          'dlq-tijdstip': new Date().toISOString()
        }
      }]
    });
    console.warn(
      `Naar dead letter topic '${DLQ_TOPIC}' gestuurd (partitie ${partition}, offset ${message.offset}): ${reden}`
    );
  } catch (err) {
    console.error(
      `Kon bericht NIET naar dead letter topic sturen (partitie ${partition}, offset ${message.offset}): ${err.message}`
    );
  }
}

async function verwerkBericht({ topic, partition, message }) {
  const bron = { topic, partition, message };

  // 1. Leeg bericht
  if (!message.value) {
    await stuurNaarDlq({ ...bron, reden: 'Leeg bericht' });
    return;
  }

  const tekst = message.value.toString();
  console.log(`Nieuw Kafka bericht ontvangen op [${topic}]: ${tekst}`);

  // 2. Geldige JSON?
  let data;
  try {
    data = JSON.parse(tekst);
  } catch (err) {
    await stuurNaarDlq({ ...bron, reden: `Ongeldige JSON: ${err.message}` });
    return;
  }

  // 3. Voldoet het aan het contract?
  const fouten = valideerWerkorder(data);
  if (fouten.length > 0) {
    await stuurNaarDlq({ ...bron, reden: `Validatie mislukt: ${fouten.join('; ')}` });
    return;
  }

  // 4. Alles in orde. We sturen alleen de contractvelden door (geen extra velden van de producer)
  //    plus eventId en tijdstip, zodat de client kan ontdubbelen en kan zeggen wat hij gemist heeft.
  const tijdstipMs = Number(message.timestamp) || Date.now();
  const melding = {
    werkorderId: data.werkorderId,
    monteurId: data.monteurId,
    status: data.status,
    bericht: data.bericht,
    eventId: `${partition}-${message.offset}`,
    tijdstip: new Date(tijdstipMs).toISOString()
  };

  // Eerst bewaren, dan versturen: ook een offline monteur kan deze melding later nog ophalen
  bewaarVoorInhalen(melding.monteurId, { eventId: melding.eventId, tijdstipMs, melding });
  stuurNaarMonteur(melding.monteurId, melding);
}

async function runKafkaConsumer() {
  try {
    await producer.connect();
    await consumer.connect();
    console.log(`Succesvol verbonden met Redpanda/Kafka broker: ${KAFKA_BROKER}`);

    await consumer.subscribe({ topic: KAFKA_TOPIC, fromBeginning: false });
    console.log(`Luisteren naar Kafka topic: '${KAFKA_TOPIC}' (dead letter topic: '${DLQ_TOPIC}')...`);

    await consumer.run({
      eachMessage: async (payload) => {
        try {
          await verwerkBericht(payload);
        } catch (err) {
          // Laatste vangnet: een onverwachte fout mag de consumer nooit laten crashen
          console.error(
            `Onverwachte fout (partitie ${payload.partition}, offset ${payload.message.offset}): ${err.message}`
          );
        }
      }
    });
  } catch (error) {
    console.error('Kafka Consumer Fout:', error);
    setTimeout(runKafkaConsumer, 5000);
  }
}

runKafkaConsumer();
