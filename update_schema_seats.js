require("dotenv").config();
const db = require("./db");

async function run() {
  try {
    console.log("Añadiendo tipo_vehiculo a vehiculos...");
    await db.query("ALTER TABLE vehiculos ADD COLUMN IF NOT EXISTS tipo_vehiculo VARCHAR(50) DEFAULT 'auto'");
    
    console.log("Añadiendo asientos_seleccionados a pasajeros_viaje...");
    await db.query("ALTER TABLE pasajeros_viaje ADD COLUMN IF NOT EXISTS asientos_seleccionados JSONB DEFAULT '[]'::jsonb");
    
    console.log("Schema actualizado correctamente.");
  } catch (err) {
    console.error("Error:", err);
  } finally {
    process.exit(0);
  }
}
run();
