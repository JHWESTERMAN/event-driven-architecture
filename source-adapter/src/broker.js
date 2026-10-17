'use strict';
// AMQP 1.0-verbinding naar ActiveMQ Artemis (via rhea). Een sender, een queue.
//
// send() levert pas een resultaat als de broker het bericht heeft overgenomen (disposition 'accepted'). Bij een persistent bericht
// betekent dat: het staat op schijf (journal). Daarop baseert server.js zijn 202.
// Alles anders (afgewezen, vrijgegeven, geen antwoord, verbinding weg) is een BrokerFout: de bron krijgt 503 en probeert opnieuw
// met dezelfde berichtId. Een bericht dat de broker wel ontving maar waarvan het antwoord verloren ging, komt dan dubbel aan; de broker
// ontdubbelt op _AMQ_DUPL_ID (zie server.js).
const rhea = require('rhea');

// soort: GEEN_VERBINDING | TIMEOUT | AFGEWEZEN | VRIJGEGEVEN | VERBROKEN
class BrokerFout extends Error {
  constructor(bericht, soort) { super(bericht); this.name = 'BrokerFout'; this.soort = soort; }
}

class BrokerVerbinding {
  constructor({ host, port, user, password, adres, tls = {}, log = () => {} }) {
    this.opties = { host, port, user, password, tls };
    this.adres = adres;
    this.log = log;
    this.verbonden = false;
    this.lopend = new Map();   // delivery -> { resolve, reject, timer }
  }

  start() {
    this.container = rhea.create_container();

    this.container.on('connection_open', () => { this.log({ stap: 'broker', gebeurtenis: 'verbonden', adres: this.adres }); });
    this.container.on('sender_open', () => { this.verbonden = true; this.log({ stap: 'broker', gebeurtenis: 'sender-open', adres: this.adres }); });
    this.container.on('disconnected', (ctx) => {
      this.verbonden = false;
      this.#faalAlles(new BrokerFout('verbinding met de broker verbroken', 'VERBROKEN'));
      this.log({ niveau: 'waarschuwing', stap: 'broker', gebeurtenis: 'verbinding-verbroken', fout: ctx.error ? String(ctx.error.message || ctx.error) : null });
    });
    this.container.on('error', (ctx) => { this.log({ niveau: 'fout', stap: 'broker', gebeurtenis: 'fout', fout: String(ctx.error && ctx.error.message || ctx.error) }); });

    this.container.on('accepted', (ctx) => this.#klaar(ctx.delivery, null));
    this.container.on('rejected', (ctx) => {
      const e = ctx.delivery.remote_state && ctx.delivery.remote_state.error;
      this.#klaar(ctx.delivery, new BrokerFout(`broker wees het bericht af${e ? `: ${e.condition} ${e.description || ''}` : ''}`.trim(), 'AFGEWEZEN'));
    });
    this.container.on('released', (ctx) => this.#klaar(ctx.delivery, new BrokerFout('broker gaf het bericht vrij (niet overgenomen)', 'VRIJGEGEVEN')));
    this.container.on('modified', (ctx) => this.#klaar(ctx.delivery, new BrokerFout('broker kon het bericht niet overnemen (modified)', 'VRIJGEGEVEN')));

    this.connection = this.container.connect({
      host: this.opties.host, port: this.opties.port,
      username: this.opties.user, password: this.opties.password,
      ...this.opties.tls,                       // transport: 'tls', ca, servername (zie omgeving.js)
      container_id: 'source-adapter',
      reconnect: true, initial_reconnect_delay: 200, max_reconnect_delay: 5000
    });
    this.sender = this.connection.open_sender({ name: 'source-adapter-sender', target: { address: this.adres } });
  }

  isVerbonden() {
    return this.verbonden && this.sender && this.sender.is_open();
  }

  #klaar(delivery, fout) {
    const l = this.lopend.get(delivery);
    if (!l) return;
    this.lopend.delete(delivery);
    clearTimeout(l.timer);
    if (fout) l.reject(fout); else l.resolve();
  }

  #faalAlles(fout) {
    for (const [delivery] of this.lopend) this.#klaar(delivery, fout);
  }

  // message: rhea-bericht (zie server.js). Geeft een promise die slaagt als de broker het heeft aangenomen.
  async send(message, timeoutMs) {
    if (!this.isVerbonden()) throw new BrokerFout('geen verbinding met de broker', 'GEEN_VERBINDING');
    if (!this.sender.sendable()) await this.#wachtOpKrediet(timeoutMs);
    return new Promise((resolve, reject) => {
      const delivery = this.sender.send(message);
      const timer = setTimeout(() => {
        this.lopend.delete(delivery);
        reject(new BrokerFout(`geen bevestiging van de broker binnen ${timeoutMs} ms`, 'TIMEOUT'));
      }, timeoutMs);
      this.lopend.set(delivery, { resolve, reject, timer });
    });
  }

  #wachtOpKrediet(timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.sender.removeListener('sendable', klaar); reject(new BrokerFout('broker geeft geen ruimte om te versturen (geen krediet)', 'TIMEOUT')); }, timeoutMs);
      const klaar = () => { clearTimeout(timer); resolve(); };
      this.sender.once('sendable', klaar);
    });
  }

  close() {
    this.#faalAlles(new BrokerFout('adapter wordt afgesloten', 'VERBROKEN'));
    try {
      if (this.connection) {
        this.connection.options.reconnect = false;   // anders blijft een nooit-geopende verbinding opnieuw proberen
        this.connection.close();
      }
    } catch (e) { /* al dicht */ }
  }
}

module.exports = { BrokerVerbinding, BrokerFout };
