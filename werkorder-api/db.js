// Werkorder-opslag op SQLite (node:sqlite, ingebouwd in Node 22) met een transactionele outbox.
//
// - Eén werkorder = één JSON-document (het monteur-model) plus een paar kolommen om op te zoeken.
// - Elke schrijfactie en de bijbehorende outbox-regels staan in DEZELFDE transactie: of allebei, of geen van beide.
// - Idempotent op `versie`: een bericht met een versie die niet hoger is dan wat we al hebben, wordt genegeerd.
// - Een intrekking voor een nog onbekende werkorder wordt bewaard als tombstone (zie contracts/README.md).
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS werkorders (
  werkorder_id  TEXT PRIMARY KEY,
  monteur_id    TEXT,
  status        TEXT NOT NULL,
  versie        INTEGER NOT NULL,
  ingetrokken   INTEGER NOT NULL DEFAULT 0,
  doc           TEXT NOT NULL,
  bijgewerkt_op TEXT NOT NULL,
  laatste_message_id TEXT
);
CREATE INDEX IF NOT EXISTS ix_werkorders_monteur ON werkorders (monteur_id);

CREATE TABLE IF NOT EXISTS tombstones (
  werkorder_id TEXT PRIMARY KEY,
  versie       INTEGER NOT NULL,
  reden        TEXT,
  message_id   TEXT,
  ontvangen_op TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id     TEXT NOT NULL UNIQUE,
  topic        TEXT NOT NULL,
  sleutel      TEXT NOT NULL,
  payload      TEXT NOT NULL,
  aangemaakt_op TEXT NOT NULL,
  verzonden_op TEXT
);
CREATE INDEX IF NOT EXISTS ix_outbox_open ON outbox (verzonden_op, id);
`;

const TOPIC_NOTIFICATIES = process.env.TOPIC_NOTIFICATIES || 'werkorder-notificaties';
const TOPIC_EVENTS = process.env.TOPIC_EVENTS || 'werkorder-events';

// Velden die geen inhoud van de werkorder zijn
const META = ['versie', 'ingetrokken', 'redenIntrekking', 'bijgewerktOp'];

function inhoud(doc) {
  const kopie = { ...doc };
  for (const k of META) delete kopie[k];
  return kopie;
}

// Welke bovenliggende velden zijn anders? (voor het domeinevent en de notificatietekst)
function verschillen(oud, nieuw) {
  const a = inhoud(oud), b = inhoud(nieuw);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    .sort();
}

function maakStore({ pad = ':memory:', seed = null, nu = () => new Date().toISOString() } = {}) {
  const db = new DatabaseSync(pad);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(SCHEMA);

  const q = {
    een: db.prepare('SELECT doc FROM werkorders WHERE werkorder_id = ?'),
    alle: db.prepare('SELECT doc FROM werkorders WHERE monteur_id = ? ORDER BY werkorder_id'),
    ins: db.prepare(`INSERT INTO werkorders (werkorder_id, monteur_id, status, versie, ingetrokken, doc, bijgewerkt_op, laatste_message_id)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    upd: db.prepare(`UPDATE werkorders SET monteur_id = ?, status = ?, versie = ?, ingetrokken = ?, doc = ?, bijgewerkt_op = ?, laatste_message_id = ?
                     WHERE werkorder_id = ?`),
    tombGet: db.prepare('SELECT * FROM tombstones WHERE werkorder_id = ?'),
    tombSet: db.prepare(`INSERT INTO tombstones (werkorder_id, versie, reden, message_id, ontvangen_op) VALUES (?, ?, ?, ?, ?)
                         ON CONFLICT(werkorder_id) DO UPDATE SET versie = excluded.versie, reden = excluded.reden,
                         message_id = excluded.message_id, ontvangen_op = excluded.ontvangen_op`),
    tombDel: db.prepare('DELETE FROM tombstones WHERE werkorder_id = ?'),
    outIns: db.prepare(`INSERT INTO outbox (event_id, topic, sleutel, payload, aangemaakt_op) VALUES (?, ?, ?, ?, ?)`),
    outOpen: db.prepare('SELECT id, event_id, topic, sleutel, payload FROM outbox WHERE verzonden_op IS NULL ORDER BY id LIMIT ?'),
    outKlaar: db.prepare('UPDATE outbox SET verzonden_op = ? WHERE id = ?'),
    outTel: db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE verzonden_op IS NULL'),
    outOpruim: db.prepare('DELETE FROM outbox WHERE verzonden_op IS NOT NULL AND verzonden_op < ?'),
    telWo: db.prepare('SELECT COUNT(*) AS n FROM werkorders')
  };

  function transactie(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) { /* al teruggedraaid */ }
      throw e;
    }
  }

  function zet(doc, messageId) {
    q.ins.run(doc.werkorderId, doc.monteur ? doc.monteur.id : null, doc.status, doc.versie, doc.ingetrokken ? 1 : 0,
      JSON.stringify(doc), doc.bijgewerktOp, messageId || null);
  }

  // Startdata: alleen in een lege database, zonder events
  if (seed && q.telWo.get().n === 0) {
    transactie(() => {
      for (const w of Object.values(seed)) {
        zet({ ...w, versie: 1, ingetrokken: false, bijgewerktOp: w.aangemaaktOp }, null);
      }
    });
  }

  function leesDoc(rij) { return rij ? JSON.parse(rij.doc) : null; }

  function voegEventToe(topic, sleutel, payload) {
    q.outIns.run(payload.eventId, topic, sleutel, JSON.stringify(payload), nu());
  }

  function maakEvents({ oud, nieuw, soort, correlationId }) {
    const tijd = nu();
    const id = nieuw.werkorderId;
    const basis = { werkorderId: id, versie: nieuw.versie, occurredAt: tijd, correlationId: correlationId || null };
    const wijz = oud ? verschillen(oud, nieuw) : [];
    const events = [];

    const eventType = soort === 'ingetrokken' ? 'werkorder.ingetrokken' : oud ? 'werkorder.gewijzigd' : 'werkorder.aangemaakt';
    events.push([TOPIC_EVENTS, {
      eventId: crypto.randomUUID(), eventType, ...basis,
      status: nieuw.status, prioriteit: nieuw.prioriteit,
      monteur: nieuw.monteur || null,
      vorigeMonteurId: oud && oud.monteur ? oud.monteur.id : null,
      vorigeStatus: oud ? oud.status : null,
      ingetrokken: Boolean(nieuw.ingetrokken),
      gewijzigdeVelden: wijz
    }]);

    // Dunne notificaties voor de monteursapp (contract: werkorder-notificaties.schema.json)
    const notif = (monteurId, status, bericht) => events.push([TOPIC_NOTIFICATIES, {
      eventId: crypto.randomUUID(), werkorderId: id, monteurId, status, bericht
    }]);
    const nieuweId = nieuw.monteur ? nieuw.monteur.id : null;
    const oudeId = oud && oud.monteur ? oud.monteur.id : null;

    if (soort === 'ingetrokken') {
      if (nieuweId) notif(nieuweId, nieuw.status, `Werkorder ${id} is ingetrokken`);
    } else if (!oud) {
      if (nieuweId) notif(nieuweId, nieuw.status, `Nieuwe werkorder ${id}: ${nieuw.omschrijving}`);
    } else {
      if (oudeId && oudeId !== nieuweId) notif(oudeId, oud.status, `Werkorder ${id} is niet langer aan jou toegewezen`);
      if (nieuweId && oudeId !== nieuweId) notif(nieuweId, nieuw.status, `Werkorder ${id} is aan jou toegewezen: ${nieuw.omschrijving}`);
      else if (nieuweId && oud.status !== nieuw.status) notif(nieuweId, nieuw.status, `Werkorder ${id} heeft nu status ${nieuw.status}`);
      else if (nieuweId && wijz.length) notif(nieuweId, nieuw.status, `Werkorder ${id} is gewijzigd`);
    }
    return events;
  }

  return {
    // --- lezen ---
    haal(id) { return leesDoc(q.een.get(id)); },
    lijstVan(monteurId) { return q.alle.all(monteurId).map(leesDoc); },
    tombstone(id) { return q.tombGet.get(id) || null; },
    aantalWerkorders() { return q.telWo.get().n; },

    // --- schrijven (aangeroepen door de target-adapter via PUT /intern/werkorders/{id}) ---
    // invoer: { werkorderId, messageId, correlationId, versie, ingetrokken, reden, werkorder }
    // resultaat: { resultaat: 'VERWERKT' | 'GENEGEERD' | 'TOMBSTONE_BEWAARD', versie, reden? }
    verwerk(inv) {
      return transactie(() => {
        const id = inv.werkorderId;
        const bestaand = leesDoc(q.een.get(id));
        const tomb = q.tombGet.get(id);
        const tijd = nu();

        if (inv.ingetrokken) {
          if (!bestaand) {
            if (tomb && tomb.versie >= inv.versie) return { resultaat: 'GENEGEERD', versie: tomb.versie, reden: 'tombstone heeft al een gelijke of hogere versie' };
            q.tombSet.run(id, inv.versie, inv.reden || null, inv.messageId || null, tijd);
            return { resultaat: 'TOMBSTONE_BEWAARD', versie: inv.versie };
          }
          if (inv.versie <= bestaand.versie) return { resultaat: 'GENEGEERD', versie: bestaand.versie, reden: 'versie is niet hoger dan de opgeslagen versie' };
          const nieuw = { ...bestaand, status: 'AFGEROND', ingetrokken: true, redenIntrekking: inv.reden || null, versie: inv.versie, bijgewerktOp: tijd };
          q.upd.run(nieuw.monteur ? nieuw.monteur.id : null, nieuw.status, nieuw.versie, 1, JSON.stringify(nieuw), tijd, inv.messageId || null, id);
          for (const [topic, p] of maakEvents({ oud: bestaand, nieuw, soort: 'ingetrokken', correlationId: inv.correlationId })) voegEventToe(topic, id, p);
          return { resultaat: 'VERWERKT', versie: nieuw.versie };
        }

        // Aanmaken of wijzigen
        if (tomb) {
          if (inv.versie <= tomb.versie) return { resultaat: 'GENEGEERD', versie: tomb.versie, reden: 'werkorder is al ingetrokken (tombstone)' };
          q.tombDel.run(id); // een hogere versie na een intrekking: de bron heeft de werkorder heropend
        }
        if (bestaand && inv.versie <= bestaand.versie) {
          return { resultaat: 'GENEGEERD', versie: bestaand.versie, reden: 'versie is niet hoger dan de opgeslagen versie' };
        }
        if (bestaand && bestaand.ingetrokken) {
          return { resultaat: 'GENEGEERD', versie: bestaand.versie, reden: 'werkorder is ingetrokken' };
        }

        const nieuw = {
          ...inv.werkorder,
          werkorderId: id,
          aangemaaktOp: bestaand ? bestaand.aangemaaktOp : inv.werkorder.aangemaaktOp,
          versie: inv.versie, ingetrokken: false, bijgewerktOp: tijd
        };
        if (bestaand) {
          q.upd.run(nieuw.monteur ? nieuw.monteur.id : null, nieuw.status, nieuw.versie, 0, JSON.stringify(nieuw), tijd, inv.messageId || null, id);
        } else {
          zet(nieuw, inv.messageId);
        }
        // Alleen events als er echt iets in de inhoud veranderde (een versie-ophoging zonder wijziging is stil)
        if (!bestaand || verschillen(bestaand, nieuw).length) {
          for (const [topic, p] of maakEvents({ oud: bestaand, nieuw, soort: 'zet', correlationId: inv.correlationId })) voegEventToe(topic, id, p);
        }
        return { resultaat: 'VERWERKT', versie: nieuw.versie };
      });
    },

    // --- outbox ---
    outboxOpen(limiet = 50) {
      return q.outOpen.all(limiet).map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
    },
    outboxVerzonden(ids) {
      const t = nu();
      transactie(() => { for (const id of ids) q.outKlaar.run(t, id); });
    },
    outboxAantalOpen() { return q.outTel.get().n; },
    outboxOpruimen(voorTijdstip) { return Number(q.outOpruim.run(voorTijdstip).changes); },

    sluit() { db.close(); }
  };
}

module.exports = { maakStore, TOPIC_NOTIFICATIES, TOPIC_EVENTS };
