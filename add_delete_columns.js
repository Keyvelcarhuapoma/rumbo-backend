const db = require("./db");

async function migrate() {
  try {
    console.log("Iniciando migración de mensajes...");
    
    // Add deleted_for_everyone
    await db.query(`
      ALTER TABLE mensajes 
      ADD COLUMN IF NOT EXISTS deleted_for_everyone BOOLEAN DEFAULT false;
    `);
    
    // Add deleted_for_sender
    await db.query(`
      ALTER TABLE mensajes 
      ADD COLUMN IF NOT EXISTS deleted_for_sender BOOLEAN DEFAULT false;
    `);

    // Add deleted_for_receiver
    await db.query(`
      ALTER TABLE mensajes 
      ADD COLUMN IF NOT EXISTS deleted_for_receiver BOOLEAN DEFAULT false;
    `);

    console.log("Migración completada exitosamente.");
    process.exit(0);
  } catch (error) {
    console.error("Error en la migración:", error);
    process.exit(1);
  }
}

migrate();
