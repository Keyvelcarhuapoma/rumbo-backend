const db = require('./db');

async function migrate2() {
  try {
    await db.query(`
      ALTER TABLE configuracion_campus 
      ADD COLUMN IF NOT EXISTS filtro_solo_estudiantes BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS permiso_ingreso_externos BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS comisiones_diferenciadas BOOLEAN DEFAULT true,
      ADD COLUMN IF NOT EXISTS bloqueo_horario_clases BOOLEAN DEFAULT true,
      ADD COLUMN IF NOT EXISTS auditoria_resenas BOOLEAN DEFAULT true;
    `);
    console.log('Columns added for hybrid driver model');
  } catch (e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}

migrate2();
