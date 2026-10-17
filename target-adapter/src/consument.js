'use strict';
// AMQP 1.0-consument voor ActiveMQ Artemis (rhea). Eén bericht tegelijk (krediet 1): zo blijft de volgorde binnen
// één werkorder zo goed als mogelijk behouden en is de belasting op de werkorder-api voorspelbaar.
//
// Wat de broker per bericht te horen krijgt (dit is de "taakgerichte" statusbijhouding aan de kant van de broker):
//   accepted   verwerkt: de broker verwijdert het bericht                                (bevestigd)
//   modified   {delivery_failed:true}: mislukte aflevering; de broker telt de poging, herlevert met vertraging
//              en zet het na max-delivery-attempts op de dead letter address              (mislukt)
//   Permanente fouten: eerst naar eam.workorder.v1.dlq met reden-headers, dan accepted op het origineel.
//   Lukt dat doorsturen niet, dan wordt het gewoon een mislukte aflevering (modified).
//   Tussen ontvangen en een van deze antwoorden staat het bericht bij de broker als "aangeboden / in verwerking".
const rhea = require('rhea');

class Consument {
  constructor({ host, port, user, password, queue, dlq, beslis, log = () => {}, dlqTimeoutMs = 5000 }) {
    Object.assign(this, { opties: { host, port, user, password }, queue, dlq, beslis, log, dlqTimeoutMs });
    this.lopendDlq = new Map();
    this.generatie = 0;
    this.stats = { ontvangen: 0, bevestigd: 0, opnieuw: 0, naarDlq: 0 };
    this.klaarVoorOntvangst = false;
  }

  start() {
    this.container = rhea.create_container();
    const c = this.container;

    c.on('receiver_open', () => {
      this.generatie++;
      this.klaarVoorOntvangst = true;
      this.log({ stap: 'broker', gebeurtenis: 'receiver-open', queue: this.queue });
      this.receiver.add_credit(1);
    });
    c.on('disconnected', (ctx) => {
      this.klaarVoorOntvangst = false;
      for (const [d] of this.lopendDlq) this.#dlqKlaar(d, new Error('verbinding verbroken'));
      this.log({ niveau: 'waarschuwing', stap: 'broker', gebeurtenis: 'verbinding-verbroken', fout: ctx.error ? String(ctx.error.message || ctx.error) : null });
    });
    c.on('error', (ctx) => this.log({ niveau: 'fout', stap: 'broker', gebeurtenis: 'fout', fout: String(ctx.error && ctx.error.message || ctx.error) }));
    c.on('accepted', (ctx) => this.#dlqKlaar(ctx.delivery, null));
    for (const soort of ['rejected', 'released', 'modified']) {
      c.on(soort, (ctx) => this.#dlqKlaar(ctx.delivery, new Error(`broker antwoordde ${soort} op het DLQ-bericht`)));
    }
    c.on('message', (ctx) => { this.#verwerk(ctx).catch((e) => this.log({ niveau: 'fout', stap: 'verwerken', fout: e.message })); });

    this.connection = c.connect({
      host: this.opties.host, port: this.opties.port, username: this.opties.user, password: this.opties.password,
      container_id: 'target-adapter', reconnect: true, initial_reconnect_delay: 200, max_reconnect_delay: 5000
    });
    this.receiver = this.connection.open_receiver({ name: 'target-adapter-receiver', source: { address: this.queue }, credit_window: 0, autoaccept: false });
    this.dlqSender = this.connection.open_sender({ name: 'target-adapter-dlq', target: { address: this.dlq } });
  }

  isVerbonden() { return this.klaarVoorOntvangst && this.receiver && this.receiver.is_open(); }

  async #verwerk(ctx) {
    const gen = this.generatie;
    const { delivery, message } = ctx;
    this.stats.ontvangen++;
    const props = message.application_properties || {};
    const poging = (message.delivery_count || 0) + 1;
    let besluit;
    try {
      besluit = await this.beslis(message.body, message);
    } catch (e) {
      besluit = { actie: 'RETRY', reden: `onverwachte fout: ${e.message}` };
    }

    const log = { stap: 'verwerken', messageId: besluit.messageId || message.message_id || null, correlationId: besluit.correlationId || null,
      werkorderId: besluit.werkorderId || props.workOrderId || null, versie: besluit.versie, poging };

    try {
      if (besluit.actie === 'ACCEPT') {
        delivery.accept(); this.stats.bevestigd++;
        this.log({ ...log, uitkomst: 'bevestigd', api: besluit.apiResultaat });
      } else if (besluit.actie === 'DLQ') {
        try {
          await this.#naarDlq(message, besluit);
          delivery.accept(); this.stats.naarDlq++;
          this.log({ niveau: 'fout', ...log, uitkomst: 'naar-dlq', reden: besluit.reden, detail: besluit.detail });
        } catch (e) {
          delivery.release({ delivery_failed: true }); this.stats.opnieuw++;
          this.log({ niveau: 'waarschuwing', ...log, uitkomst: 'mislukt', reden: `doorsturen naar DLQ mislukte: ${e.message}` });
        }
      } else {
        delivery.release({ delivery_failed: true }); this.stats.opnieuw++;
        this.log({ niveau: 'waarschuwing', ...log, uitkomst: 'mislukt-opnieuw', reden: besluit.reden });
      }
    } catch (e) {
      // verbinding is tijdens de verwerking weggevallen: de broker herlevert het bericht zelf
      this.log({ niveau: 'waarschuwing', ...log, uitkomst: 'niet-afgehandeld', reden: e.message });
    }
    if (gen === this.generatie && this.isVerbonden()) this.receiver.add_credit(1);
  }

  #naarDlq(origineel, besluit) {
    return new Promise((resolve, reject) => {
      if (!this.dlqSender || !this.dlqSender.is_open()) return reject(new Error('DLQ-sender is niet open'));
      if (!this.dlqSender.sendable()) return reject(new Error('geen krediet op de DLQ-sender'));
      const props = { ...(origineel.application_properties || {}),
        dlqReden: besluit.reden, dlqDetail: String(besluit.detail || '').slice(0, 2000),
        dlqBron: this.queue, dlqAdapter: 'target-adapter', dlqTijd: new Date().toISOString() };
      const delivery = this.dlqSender.send({
        message_id: origineel.message_id, correlation_id: origineel.correlation_id, subject: origineel.subject,
        group_id: origineel.group_id, content_type: origineel.content_type, durable: true,
        application_properties: props, body: origineel.body
      });
      const timer = setTimeout(() => { this.lopendDlq.delete(delivery); reject(new Error(`geen bevestiging van de DLQ binnen ${this.dlqTimeoutMs} ms`)); }, this.dlqTimeoutMs);
      this.lopendDlq.set(delivery, { resolve, reject, timer });
    });
  }

  #dlqKlaar(delivery, fout) {
    const l = this.lopendDlq.get(delivery);
    if (!l) return;
    this.lopendDlq.delete(delivery);
    clearTimeout(l.timer);
    if (fout) l.reject(fout); else l.resolve();
  }

  close() { try { if (this.connection) this.connection.close(); } catch (e) { /* al dicht */ } }
}

module.exports = { Consument };
