const bcrypt = require("bcrypt");
const db = require("./db.js");

async function updatePw() {
  const hash = await bcrypt.hash("123456", 10);
  await db.query(
    "UPDATE usuarios SET contrasena_hash = $1 WHERE correo_electronico = $2",
    [hash, "test12345@utp.edu.pe"],
  );
  console.log("CONTRASEÑA CAMBIADA. AHORA ES: 123456");
  process.exit();
}
updatePw();
