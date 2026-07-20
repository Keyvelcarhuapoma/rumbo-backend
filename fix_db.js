const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS usuarios_bloqueados (
        id_bloqueador UUID REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
        id_bloqueado UUID REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
        fecha_bloqueo TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id_bloqueador, id_bloqueado)
      );
    `);
    console.log("Tabla usuarios_bloqueados creada con éxito.");
  } catch (e) {
    console.error(e);
  } finally {
    await client.end();
  }
}
run();
