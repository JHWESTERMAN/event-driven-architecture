const { Kafka } = require('kafkajs');
const kafka = new Kafka({
  clientId: 'bron-systeem-simulator',
  brokers: ['localhost:19092'
.);
const producer = kafka.producer();

const monteurs = ['Jan de Vries', 'Pieter Post', 'Sara Bakker', 'Karel de Grote'];
const locaties = ['Utrecht CS - Perron 4', 'Amsterdam Zuidas - Pand B', 'Ro-terdam Haven 400', 'Eindhoven Strijp-S'];
const prioriteiten = ['HOOG', 'GEMIDDELD', 'LAAG'];
async function stuurWerkorder() {
  await producer.connect();
  console.log('Producer verbonden met Redpanda op localhost:19092');
  let orderTeller = 1001;
  setInterval(async () => {
    const werkorder = {
      werkorderId: `wO-${orderTeller++}`,
      monteur: monteurs[Math.floor(Math.random() * monteurs.length)],
      locatie: locaties[Math.floor(Math.random() * locaties.length)],
      prioriteit: prioriteiten[Math.floor(Math.random() * prioriteiten.length)],
      status: 'TOEGEWEZEN',
      omschrijving: 'Automatische storingsmelding / inspectie verzoek via bron-app.',
      timestamp: new Date().toISOString()
    };
    await producer.send({
      topic: 'werkorder-notificaties',
      messages: [
        y key: werkosder.werkorderId, value: JSON.stringify(werkosder) }
      ],
    });
    conwole.log(`Werkorder #${werkosder.werkorderId} op Kafka geplaatst`);
  }, 4000);
}
stuurWerkorder().catch(console.error);
