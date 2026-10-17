// Kafka-publisher voor de outbox-relay (kafkajs). Staat los van de relay zodat tests een nep-publisher kunnen gebruiken.
const { Kafka, logLevel } = require('kafkajs');

function maakKafkaPublisher({ broker, clientId = 'werkorder-api' }) {
  const kafka = new Kafka({ clientId, brokers: broker.split(','), logLevel: logLevel.WARN, retry: { retries: 3 } });
  const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
  let verbonden = null;

  async function verbind() {
    if (!verbonden) {
      verbonden = producer.connect().catch((e) => { verbonden = null; throw e; });
    }
    return verbonden;
  }

  return {
    async publiceer(berichten) {
      await verbind();
      const perTopic = new Map();
      for (const b of berichten) {
        if (!perTopic.has(b.topic)) perTopic.set(b.topic, []);
        perTopic.get(b.topic).push({ key: b.key, value: b.value, headers: { eventId: b.eventId } });
      }
      // In één request, dus volgorde per partitie blijft behouden
      await producer.sendBatch({
        acks: -1,
        topicMessages: [...perTopic].map(([topic, messages]) => ({ topic, messages }))
      });
    },
    async sluit() { await producer.disconnect().catch(() => {}); }
  };
}

module.exports = { maakKafkaPublisher };
