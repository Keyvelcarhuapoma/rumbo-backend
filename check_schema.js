const { Client } = require('pg');

const client = new Client({
    connectionString: 'postgresql://rumbo_db_fs0q_user:VuywlItRCixdl7tpwr2xSMkTnH4M9xeo@dpg-d8viqjegvqtc738hods0-a.oregon-postgres.render.com/rumbo_db_fs0q',
    ssl: { rejectUnauthorized: false }
});

async function run() {
    await client.connect();
    
    await client.query("UPDATE usuarios SET identidad_verificada = true, estado_cuenta = 'activo' WHERE id_usuario = '1c7b8608-29dc-4c66-b1c6-911a2d2b425a'");
    await client.query("UPDATE documentos_conductor SET estado_validacion = 'aprobado' WHERE id_conductor = '1c7b8608-29dc-4c66-b1c6-911a2d2b425a'");

    console.log("Updated Keyvel!");

    await client.end();
}
run();
