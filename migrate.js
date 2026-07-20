const db = require('./db');

async function migrate() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS configuracion_campus (
          id SERIAL PRIMARY KEY,
          id_universidad UUID REFERENCES universidades(id_universidad),
          validacion_dominio BOOLEAN DEFAULT true,
          bloqueo_egresados BOOLEAN DEFAULT true,
          restriccion_horarios BOOLEAN DEFAULT false,
          carpooling_obligatorio BOOLEAN DEFAULT false,
          monedero_universitario BOOLEAN DEFAULT false,
          filtro_genero BOOLEAN DEFAULT true,
          enlace_sos BOOLEAN DEFAULT true
      );
    `);
    console.log('Table created');
    
    const count = await db.query('SELECT COUNT(*) FROM configuracion_campus');
    if (parseInt(count.rows[0].count) === 0) {
      await db.query(`
        INSERT INTO configuracion_campus (id_universidad)
        SELECT id_universidad FROM universidades LIMIT 1;
      `);
      console.log('Inserted default config');
    }
  } catch (e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}

migrate();
