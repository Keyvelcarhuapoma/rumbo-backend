const { Client } = require('pg');
const https = require('https');

const client = new Client({
    connectionString: 'postgresql://rumbo_db_fs0q_user:VuywlItRCixdl7tpwr2xSMkTnH4M9xeo@dpg-d8viqjegvqtc738hods0-a.oregon-postgres.render.com/rumbo_db_fs0q',
    ssl: { rejectUnauthorized: false }
});

async function inspectRenderBackend() {
    console.log("=== 1. VERIFICANDO API REST EN RENDER ===");
    await new Promise((resolve) => {
        https.get('https://rumbo-backend.onrender.com/api/users', (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                console.log('HTTP Status de /api/users:', res.statusCode);
                try {
                    const parsed = JSON.parse(data);
                    console.log('Número total de usuarios desde API REST:', Array.isArray(parsed) ? parsed.length : parsed);
                } catch(e) {
                    console.log('Respuesta cruda (primeros 200 chars):', data.substring(0, 200));
                }
                resolve();
            });
        }).on('error', err => {
            console.log('Error conectando al API REST:', err.message);
            resolve();
        });
    });

    console.log("\n=== 2. VERIFICANDO BASE DE DATOS POSTGRES EN RENDER ===");
    try {
        await client.connect();
        console.log("¡Conectado exitosamente a PostgreSQL en Render!");
        
        const tablesRes = await client.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema='public' 
            ORDER BY table_name;
        `);
        
        const tables = tablesRes.rows.map(r => r.table_name);
        console.log("\nTablas encontradas (" + tables.length + "):", tables.join(', '));

        const mainTables = ['usuarios', 'viajes', 'pasajeros_viaje', 'mensajes', 'mensajes_comunidad', 'comunidades', 'alertas_sos', 'vehiculos'];
        console.log("\nConteo de filas en tablas clave:");
        for (const t of mainTables) {
            if (tables.includes(t)) {
                const countRes = await client.query(`SELECT COUNT(*) as count FROM ${t}`);
                console.log(` - ${t}: ${countRes.rows[0].count} registros`);
            } else {
                console.log(` - ${t}: [NO EXISTE EN BD]`);
            }
        }
    } catch (err) {
        console.error("Error consultando BD Render:", err.message);
    } finally {
        await client.end();
    }
}

inspectRenderBackend();
