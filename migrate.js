const db = require('./db');

async function migrate() {
  try {
    console.log("Creando tabla app_config...");
    await db.query(`
      CREATE TABLE IF NOT EXISTS app_config (
        id SERIAL PRIMARY KEY,
        version_name VARCHAR(50) NOT NULL,
        version_code INT NOT NULL,
        download_url TEXT NOT NULL,
        is_mandatory BOOLEAN DEFAULT false,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log("Verificando si existe la configuración...");
    const res = await db.query('SELECT COUNT(*) FROM app_config');
    if (parseInt(res.rows[0].count) === 0) {
      console.log("Insertando configuración inicial...");
      await db.query(`
        INSERT INTO app_config (version_name, version_code, download_url, is_mandatory) 
        VALUES ('1.0.0', 1, 'https://github.com', false);
      `);
    } else {
      console.log("La tabla ya tiene datos.");
    }

    console.log("¡Migración completada exitosamente!");
    process.exit(0);
  } catch (error) {
    console.error("Error en la migración:", error);
    process.exit(1);
  }
}

migrate();
