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

// Toegestane waarden voor het veld "status" (de enum uit het contract)
const TOEGESTANE_STATUSSEN = ['OPEN', 'IN_BEHANDELING', 'AFGEROND'];

// Formaat van een monteur-id, bijvoorbeeld M-017
const MONTEUR_PATROON = /^M-\d+$/;

// ---------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------
const wss = new WebSocketServer({ port: PORT });
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

wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  const url = new URL(req.url, 'http://localhost');
  const monteurId = url.searchParams.get('monteurId');

  // Zonder geldig monteurId weten we niet voor wie de verbinding is: weigeren.
  // Let op: dit is een identificatie, nog geen authenticatie. Iedereen kan elk id opgeven.
  if (!monteurId || !MONTEUR_PATROON.test(monteurId)) {
    console.warn(`Verbinding geweigerd vanaf ${clientIp}: monteurId ontbreekt of is ongeldig`);
    ws.close(1008, 'monteurId ontbreekt of is ongeldig');
    return;
  }

  // Optioneel: ?since=<ISO-tijdstip> = "stuur me wat ik gemist heb vanaf dit moment"
  let sindsMs = null;
  const sindsTekst = url.searchParams.get('since');
  if (sindsTekst !== null) {
    if (!ISO_TIJDSTIP.test(sindsTekst) || Number.isNaN(Date.parse(sindsTekst))) {
      console.warn(`Verbinding van ${monteurId} geweigerd: since '${sindsTekst}' is ongeldig`);
      ws.close(1008, 'since is ongeldig (verwacht ISO 8601, bijvoorbeeld 2026-10-16T14:03:22.123Z)');
      return;
    }
    sindsMs = Date.parse(sindsTekst);
  }

  ws.isLevend = true;
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

  ws.on('pong', () => {
    ws.isLevend = true;
  });

  ws.on('close', () => {
    verwijder(monteurId, ws);
    console.log(`Monteur ${monteurId} verbinding verbroken`);
  });

  ws.on('error', (err) => {
    console.error(`Fout op verbinding van ${monteurId}: ${err.message}`);
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
