'use strict';
// Referentie-implementatie: Rijksdriehoek (EPSG:28992) naar WGS84, met de benaderingsformule van
// Schreutelkamp en Strang van Hees (nauwkeurig tot circa 1 meter in Nederland, ruim genoeg voor een werkorder).
// De source-adapter krijgt een eigen implementatie die tegen dezelfde golden files wordt getest.

const X0 = 155000, Y0 = 463000;
const LAT0 = 52.15517440, LON0 = 5.38720621;

// [p, q, coefficient in boogseconden]
const LAT = [[0,1,3235.65389],[2,0,-32.58297],[0,2,-0.24750],[2,1,-0.84978],[0,3,-0.06550],[2,2,-0.01709],
  [1,0,-0.00738],[4,0,0.00530],[2,3,-0.00039],[4,1,0.00033],[1,1,-0.00012]];
const LON = [[1,0,5260.52916],[1,1,105.94684],[1,2,2.45656],[3,0,-0.81885],[1,3,0.05594],[3,1,-0.05607],
  [0,1,0.01199],[3,2,-0.00256],[1,4,0.00128],[0,2,0.00022],[2,0,-0.00022],[5,0,0.00026]];

function rdNaarWgs84(x, y) {
  const dx = (x - X0) / 1e5, dy = (y - Y0) / 1e5;
  const som = (tabel) => tabel.reduce((t, [p, q, k]) => t + k * Math.pow(dx, p) * Math.pow(dy, q), 0);
  return {
    lat: Number((LAT0 + som(LAT) / 3600).toFixed(6)),
    lon: Number((LON0 + som(LON) / 3600).toFixed(6))
  };
}

module.exports = { rdNaarWgs84 };
