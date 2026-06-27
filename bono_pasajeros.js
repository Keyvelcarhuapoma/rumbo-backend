const db = require("./db.js");

async function addBonus() {
  try {
    const res = await db.query(
      "SELECT id_usuario FROM usuarios WHERE rol_usuario = 'pasajero'",
    );
    let count = 0;
    for (const u of res.rows) {
      await db.query(
        `
        INSERT INTO transacciones_billetera 
        (id_usuario, tipo_transaccion, monto, estado_transaccion, metadata) 
        VALUES ($1, $2, $3, $4, $5)
      `,
        [
          u.id_usuario,
          "recarga",
          100,
          "completada",
          JSON.stringify({ descripcion: "Bono pasajero" }),
        ],
      );
      count++;
    }
    console.log(
      `Bono de 100 soles agregado a ${count} pasajeros exitosamente.`,
    );
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

addBonus();
