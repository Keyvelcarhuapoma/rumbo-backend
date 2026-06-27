const db = require("./db.js");

async function grantWalletAndCars() {
  try {
    console.log("🚀 Iniciando proceso de asignación de saldo y vehículos...");

    // 1. Asignar 100 soles a pasajeros
    console.log("\n💳 Procesando billeteras de pasajeros...");
    const passengersResult = await db.query(
      "SELECT id_usuario, nombre_completo FROM usuarios WHERE rol_usuario IN ('pasajero', 'passenger')"
    );
    const passengers = passengersResult.rows;
    console.log(`Total de pasajeros registrados: ${passengers.length}`);

    let walletCount = 0;
    for (const passenger of passengers) {
      // Verificar si ya tiene un bono de recarga previo para no duplicarlo innecesariamente
      const existingBonus = await db.query(
        `SELECT id_transaccion FROM transacciones_billetera 
         WHERE id_usuario = $1 AND tipo_transaccion = 'recarga' 
           AND (metadata->>'descripcion' LIKE '%Bono%' OR metadata->>'descripcion' LIKE '%bienvenida%')`,
        [passenger.id_usuario]
      );

      if (existingBonus.rows.length === 0) {
        await db.query(
          `INSERT INTO transacciones_billetera 
            (id_usuario, tipo_transaccion, monto, estado_transaccion, metadata) 
           VALUES ($1, 'recarga', 100.00, 'completada', $2::jsonb)`,
          [
            passenger.id_usuario,
            JSON.stringify({ descripcion: "Bono de bienvenida de 100 soles" }),
          ]
        );
        console.log(`  - Bono asignado a: ${passenger.nombre_completo}`);
        walletCount++;
      } else {
        console.log(`  - ${passenger.nombre_completo} ya cuenta con bono de bienvenida.`);
      }
    }
    console.log(`✅ Se agregaron 100 soles a ${walletCount} pasajeros.`);

    // 2. Asignar vehículos a conductores que no tengan
    console.log("\n🚗 Procesando vehículos de conductores...");
    const driversResult = await db.query(
      `SELECT id_usuario, nombre_completo, correo_electronico, rol_usuario 
       FROM usuarios 
       WHERE rol_usuario IN ('conductor', 'driver')`
    );
    const drivers = driversResult.rows;
    console.log(`Total de conductores registrados: ${drivers.length}`);

    let vehicleCount = 0;
    const carBrands = ["Toyota", "Hyundai", "Kia", "Nissan", "Chevrolet"];
    const carModels = ["Corolla", "Elantra", "Rio", "Sentra", "Onix"];
    const carColors = ["Plata", "Negro", "Blanco", "Gris", "Rojo"];

    for (const driver of drivers) {
      // Verificar si ya tiene carro
      const existingVehicle = await db.query(
        "SELECT id_vehiculo FROM vehiculos WHERE id_propietario = $1",
        [driver.id_usuario]
      );

      if (existingVehicle.rows.length === 0) {
        // Generar placa única y realista (Formato peruano: ABC-123)
        let plate = "";
        let isUnique = false;
        
        while (!isUnique) {
          const letters = Array.from({ length: 3 }, () => 
            String.fromCharCode(65 + Math.floor(Math.random() * 26))
          ).join("");
          const numbers = Math.floor(100 + Math.random() * 900);
          plate = `${letters}-${numbers}`;

          const checkPlate = await db.query(
            "SELECT id_vehiculo FROM vehiculos WHERE placa = $1",
            [plate]
          );
          if (checkPlate.rows.length === 0) {
            isUnique = true;
          }
        }

        const brandIndex = Math.floor(Math.random() * carBrands.length);
        const brand = carBrands[brandIndex];
        const model = carModels[brandIndex];
        const color = carColors[Math.floor(Math.random() * carColors.length)];
        const year = 2018 + Math.floor(Math.random() * 6); // 2018 - 2023

        await db.query(
          `INSERT INTO vehiculos 
            (id_propietario, marca, modelo, placa, color, anio, estado_verificacion) 
           VALUES ($1, $2, $3, $4, $5, $6, 'aprobado')`,
          [driver.id_usuario, brand, model, plate, color, year]
        );

        console.log(
          `  - Vehículo asignado a: ${driver.nombre_completo} (${brand} ${model}, Placa: ${plate}, Color: ${color})`
        );
        vehicleCount++;
      } else {
        console.log(`  - Conductor ${driver.nombre_completo} ya tiene un vehículo registrado.`);
      }
    }
    console.log(`✅ Se registraron ${vehicleCount} nuevos vehículos para conductores.`);
    
    console.log("\n🎉 ¡Proceso completado con éxito!");
    process.exit(0);
  } catch (error) {
    console.error("❌ Error ejecutando script:", error);
    process.exit(1);
  }
}

grantWalletAndCars();
