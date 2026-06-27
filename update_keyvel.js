const db = require("./db.js");

async function updateKeyvel() {
  try {
    console.log("Updating Keyvel...");
    await db.query(
      `UPDATE usuarios 
       SET rol_usuario = 'conductor'
       WHERE correo_electronico = 'U23235115@utp.edu.pe'`
    );
    console.log("Updated Keyvel to conductor successfully.");
    process.exit(0);
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

updateKeyvel();
