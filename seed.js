const db = require('./db');

async function seed() {
  try {
    console.log('Seeding data...');
    
    // 1. Crear conductores
    const res1 = await db.query(`
      INSERT INTO usuarios (nombre_completo, correo_electronico, contrasena_hash, rol_usuario, estado_cuenta)
      VALUES 
        ('Carlos Ruiz', 'carlos.r@utp.edu.pe', 'mockhash', 'conductor', 'aprobada'),
        ('Andrea Morales', 'andrea.m@utp.edu.pe', 'mockhash', 'conductor', 'aprobada'),
        ('Juan Pérez', 'juan.p@utp.edu.pe', 'mockhash', 'conductor', 'aprobada')
      ON CONFLICT (correo_electronico) DO NOTHING
      RETURNING id_usuario, correo_electronico
    `);

    // Fetch them just in case they already existed
    const users = await db.query("SELECT id_usuario, correo_electronico FROM usuarios WHERE correo_electronico IN ('carlos.r@utp.edu.pe', 'andrea.m@utp.edu.pe', 'juan.p@utp.edu.pe')");
    
    const carlosId = users.rows.find(u => u.correo_electronico === 'carlos.r@utp.edu.pe').id_usuario;
    const andreaId = users.rows.find(u => u.correo_electronico === 'andrea.m@utp.edu.pe').id_usuario;
    const juanId = users.rows.find(u => u.correo_electronico === 'juan.p@utp.edu.pe').id_usuario;

    // 2. Crear vehículos
    await db.query(`
      INSERT INTO vehiculos (id_propietario, marca, modelo, placa, color, anio)
      VALUES 
        ($1, 'Toyota', 'Yaris', 'ABC-123', 'Rojo', 2020),
        ($2, 'Kia', 'Rio', 'XYZ-987', 'Azul', 2021),
        ($3, 'Hyundai', 'Accent', 'LMN-456', 'Plata', 2019)
    `, [carlosId, andreaId, juanId]);

    const vehiculos = await db.query("SELECT id_vehiculo, id_propietario FROM vehiculos");
    const carlosVeh = vehiculos.rows.find(v => v.id_propietario === carlosId).id_vehiculo;
    const andreaVeh = vehiculos.rows.find(v => v.id_propietario === andreaId).id_vehiculo;
    const juanVeh = vehiculos.rows.find(v => v.id_propietario === juanId).id_vehiculo;

    // 3. Crear viajes programados
    await db.query(`
      INSERT INTO viajes (id_conductor, id_vehiculo, origen_viaje, destino_viaje, fecha_hora_salida, asientos_totales, asientos_disponibles, precio_por_asiento, estado_viaje)
      VALUES 
        ($1, $2, 'La Union', 'Campus UTP Piura', NOW() + INTERVAL '2 hours', 4, 4, 12.00, 'programado'),
        ($3, $4, 'Piura Centro', 'Campus UTP Piura', NOW() + INTERVAL '1 hour', 3, 3, 8.50, 'programado'),
        ($5, $6, 'Paita', 'Campus UTP Piura', NOW() + INTERVAL '3 hours', 4, 4, 15.00, 'programado')
    `, [carlosId, carlosVeh, andreaId, andreaVeh, juanId, juanVeh]);

    console.log('Seeding completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Error seeding DB:', error);
    process.exit(1);
  }
}

seed();
