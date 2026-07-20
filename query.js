const { Client } = require('pg');
const client = new Client({
    connectionString: 'postgresql://rumbo_db_fs0q_user:VuywlItRCixdl7tpwr2xSMkTnH4M9xeo@dpg-d8viqjegvqtc738hods0-a.oregon-postgres.render.com/rumbo_db_fs0q',
    ssl: { rejectUnauthorized: false }
});
async function run() {
    await client.connect();
    const res = await client.query("SELECT id_viaje, fecha_creacion, fecha_hora_salida, estado_viaje FROM viajes ORDER BY fecha_creacion DESC LIMIT 5;");
    console.log(res.rows);
    await client.end();
}
run();
