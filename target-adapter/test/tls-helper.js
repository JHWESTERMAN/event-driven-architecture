'use strict';
// Maakt voor de tests wegwerp-certificaten met openssl (zelf-getekend, gelden als eigen CA). Er staan bewust geen sleutels in git.
// Geeft null als openssl ontbreekt; de TLS-tests slaan zich dan over.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function maakPki() {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch (e) { return null; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-test-'));
  const maak = (naam, san) => {
    const conf = path.join(dir, `${naam}.cnf`);
    fs.writeFileSync(conf, `[req]\ndistinguished_name=dn\nprompt=no\nx509_extensions=ext\n[dn]\nCN=${naam}\n[ext]\nsubjectAltName=${san}\nbasicConstraints=critical,CA:TRUE\n`);
    const keyPad = path.join(dir, `${naam}.key`), certPad = path.join(dir, `${naam}.pem`);
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', conf, '-keyout', keyPad, '-out', certPad], { stdio: 'ignore' });
    return { keyPad, certPad, key: fs.readFileSync(keyPad), cert: fs.readFileSync(certPad) };
  };
  return {
    dir,
    goed: maak('goed', 'DNS:localhost,IP:127.0.0.1'),              // past bij 127.0.0.1
    anderen: maak('anderen', 'DNS:localhost,IP:127.0.0.1'),        // een ander certificaat: niet vertrouwd door wie alleen "goed" kent
    verkeerdeNaam: maak('verkeerd', 'DNS:andere.example.org'),     // vertrouwd, maar niet voor 127.0.0.1
    ruim() { fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

module.exports = { maakPki };
