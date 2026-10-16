const { Kafka } = require('kafkajs');
const { WebSocketServer, WebSocket } = require('ws');

const KAFKA_BROKER = process.env.KAFKA_BROKER || 'redpanda:9092';
const KAFKA_TOPIC = process.env.KAFKA_TOPIC || 'werkorder-notificaties';
const DLQ_TOPIC = process.env.DLQ_TOPIC || `${KAFKA_TOPIC}.dlq`;
const PORT = process.env.PORT || 8080;

// Toegestane waarden voor het veld "status" (de enum uit het contract)
const TOEGESTANE_STATUSSEN = ['OPEN', 'IN_BEHANDELING', 'AFGEROND'];

// ---------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------
const wss = new WebSocketServer({ port: PORT });
console.log(`WebSocket Microservice gestart op poort ${PORT}`);

function broadcast(data) {
  let clientCount = 0;

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
      clientCount++;
    }
  });

  console.log(`Bericht gebroadcast naar ${clientCount} actieve monteur(s)`);
}

wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`Nieuwe monteur verbonden via Gateway vanaf IP: ${clientIp}`);

  ws.send(JSON.stringify({
    type: 'SYSTEM',
    message: 'Verbonden met het Werkorder Notificatiesysteem via API Gateway'
  }));

  ws.on('close', () => console.log('Monteur verbinding verbroken'));
});

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

  // 4. Alles in orde: doorsturen naar de monteurs
  broadcast(data);
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
