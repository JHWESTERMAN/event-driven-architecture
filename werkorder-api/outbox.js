// Outbox-relay: leest onverzonden regels uit de database en publiceert ze op Kafka.
// At-least-once: gaat het mis tussen publiceren en markeren, dan komt een event dubbel aan.
// Consumenten ontdubbelen op `eventId`. De volgorde per sleutel blijft behouden (we sturen op `id`).
function maakRelay({ store, publiceer, interval = 1000, batch = 50, log = console, opruimNaMs = 24 * 3600 * 1000 }) {
  let timer = null;
  let bezig = false;
  let laatsteFout = null;
  let laatsteOpruiming = 0;

  async function eenRonde() {
    if (bezig) return 0;
    bezig = true;
    let verstuurd = 0;
    try {
      for (;;) {
        const rijen = store.outboxOpen(batch);
        if (!rijen.length) break;
        await publiceer(rijen.map((r) => ({ topic: r.topic, key: r.sleutel, value: JSON.stringify(r.payload), eventId: r.event_id })));
        store.outboxVerzonden(rijen.map((r) => r.id));
        verstuurd += rijen.length;
        if (rijen.length < batch) break;
      }
      laatsteFout = null;
      const nu = Date.now();
      if (nu - laatsteOpruiming > 3600 * 1000) {
        laatsteOpruiming = nu;
        store.outboxOpruimen(new Date(nu - opruimNaMs).toISOString());
      }
    } catch (fout) {
      laatsteFout = fout;
      log.error(`Outbox-relay: publiceren mislukt (${fout.message}); ${store.outboxAantalOpen()} regel(s) wachten`);
    } finally {
      bezig = false;
    }
    return verstuurd;
  }

  return {
    eenRonde,
    start() { if (!timer) { timer = setInterval(eenRonde, interval); timer.unref?.(); } },
    stop() { if (timer) clearInterval(timer); timer = null; },
    status() { return { open: store.outboxAantalOpen(), laatsteFout: laatsteFout ? laatsteFout.message : null }; }
  };
}

module.exports = { maakRelay };
