const db = require("./db.js");

async function setupTripRequests() {
  try {
    console.log("Creando tabla solicitudes_viaje...");
    await db.query(`
      CREATE TABLE IF NOT EXISTS solicitudes_viaje (
        id_solicitud UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        id_pasajero UUID REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
        origen VARCHAR(255) NOT NULL,
        destino VARCHAR(255) NOT NULL,
        fecha_hora_solicitada TIMESTAMP WITH TIME ZONE NOT NULL,
        estado VARCHAR(50) DEFAULT 'pendiente',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
    console.log("Tabla solicitudes_viaje creada.");
    process.exit(0);
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

setupTripRequests();
