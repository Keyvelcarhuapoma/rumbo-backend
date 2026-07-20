const http = require('http');

const data = JSON.stringify({
  id_conductor: "00000000-0000-0000-0000-000000000000",
  id_vehiculo: null,
  origen_viaje: "paita",
  destino_viaje: "piura",
  fecha_hora_salida: "2026-06-29T20:02:00.000Z",
  asientos_totales: 4,
  precio_por_asiento: 5.0
});

const req = http.request({
  hostname: 'localhost',
  port: 3000,
  path: '/api/trips',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
}, res => {
  let body = '';
  res.on('data', d => body += d);
  res.on('end', () => console.log('STATUS:', res.statusCode, 'BODY:', body));
});
req.on('error', e => console.error(e));
req.write(data);
req.end();
