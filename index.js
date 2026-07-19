const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
require("dotenv").config();
const db = require("./db");

const JWT_SECRET = process.env.JWT_SECRET || "rumbo_super_secret_key_2026_prod";

const app = express();
app.set("trust proxy", 1);

// Redirección de seguridad a HTTPS cuando se ejecuta en producción detrás de un proxy (Render, Railway, Heroku)
app.use((req, res, next) => {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_HTTP !== "true") {
    if (req.headers["x-forwarded-proto"] && req.headers["x-forwarded-proto"] !== "https") {
      return res.redirect(`https://${req.headers.host}${req.url}`);
    }
  }
  next();
});

const http = require("http");
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const userRoom = (userId) => `user:${userId}`;

const getPlatformCommissionRate = () => {
  const raw = Number(process.env.PLATFORM_COMMISSION_RATE ?? "0.10");
  if (!Number.isFinite(raw) || raw < 0 || raw >= 1) return 0.1;
  return raw;
};

const roundMoney = (value) => Math.round(Number(value) * 100) / 100;

const normalizeUuid = (value) => {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    trimmed,
  )
    ? trimmed
    : null;
};

const normalizeCoordinate = (value, min, max) => {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) return null;
  return number;
};

function saveCentinelaAudio({ audio_nombre, audio_base64 }) {
  if (!audio_base64) return null;

  const matches = audio_base64.match(
    /^data:audio\/([a-zA-Z0-9+.-]+);base64,(.+)$/,
  );
  const rawBase64 = matches ? matches[2] : audio_base64;
  const extension = matches
    ? matches[1].replace("mpeg", "mp3")
    : path.extname(audio_nombre || "").replace(".", "") || "m4a";
  const allowedExtensions = new Set([
    "mp3",
    "m4a",
    "aac",
    "wav",
    "ogg",
    "webm",
  ]);
  if (!allowedExtensions.has(extension.toLowerCase())) {
    const error = new Error("Formato de audio no permitido");
    error.statusCode = 400;
    throw error;
  }

  const buffer = Buffer.from(rawBase64, "base64");
  if (!buffer.length || buffer.length > 12 * 1024 * 1024) {
    const error = new Error("El audio de Centinela debe pesar maximo 12MB");
    error.statusCode = 400;
    throw error;
  }

  const audioDir = path.resolve(__dirname, "uploads", "centinela-audio");
  fs.mkdirSync(audioDir, { recursive: true });
  const safeExt = extension.toLowerCase().replace(/[^a-z0-9]/g, "");
  const fileName = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}.${safeExt}`;
  const targetPath = path.resolve(audioDir, fileName);
  if (!targetPath.startsWith(audioDir)) {
    throw new Error("Ruta de archivo no válida");
  }
  fs.writeFileSync(targetPath, buffer);
  return `/uploads/centinela-audio/${fileName}`;
}

const alertSelectSql = `
  SELECT
    a.*,
    u.nombre_completo,
    u.correo_electronico,
    u.numero_telefono,
    u.rol_usuario,
    u.tipo_cuenta,
    u.identidad_verificada,
    u.ciclo_academico,
    uni.nombre_universidad,
    car.nombre_carrera,
    v.origen_viaje,
    v.destino_viaje,
    v.origen_latitud,
    v.origen_longitud,
    v.destino_latitud,
    v.destino_longitud,
    v.fecha_hora_salida,
    v.estado_viaje,
    conductor.id_usuario AS conductor_id,
    conductor.nombre_completo AS conductor_nombre,
    conductor.correo_electronico AS conductor_correo,
    conductor.numero_telefono AS conductor_telefono,
    ve.placa,
    ve.marca,
    ve.modelo,
    ve.color,
    latest.latitud AS tracking_latitud,
    latest.longitud AS tracking_longitud,
    latest.precision_metros AS tracking_precision_metros,
    latest.fecha_tracking AS tracking_fecha,
    COALESCE(passengers.pasajeros, '[]'::json) AS pasajeros
  FROM alertas_sos a
  LEFT JOIN usuarios u ON a.id_usuario = u.id_usuario
  LEFT JOIN universidades uni ON u.id_universidad = uni.id_universidad
  LEFT JOIN carreras car ON u.id_carrera = car.id_carrera
  LEFT JOIN viajes v ON a.id_viaje = v.id_viaje
  LEFT JOIN usuarios conductor ON v.id_conductor = conductor.id_usuario
  LEFT JOIN vehiculos ve ON v.id_vehiculo = ve.id_vehiculo
  LEFT JOIN LATERAL (
    SELECT ct.latitud, ct.longitud, ct.precision_metros, ct.fecha_tracking
    FROM centinela_tracking ct
    WHERE ct.id_usuario = a.id_usuario
      AND (a.id_viaje IS NULL OR ct.id_viaje IS NULL OR ct.id_viaje = a.id_viaje)
    ORDER BY ct.fecha_tracking DESC
    LIMIT 1
  ) latest ON true
  LEFT JOIN LATERAL (
    SELECT json_agg(
      json_build_object(
        'id_pasajero', p.id_usuario,
        'nombre', p.nombre_completo,
        'correo', p.correo_electronico,
        'telefono', p.numero_telefono,
        'asientos', pv.asientos_reservados,
        'estado_reserva', pv.estado_reserva
      )
      ORDER BY p.nombre_completo
    ) AS pasajeros
    FROM pasajeros_viaje pv
    JOIN usuarios p ON p.id_usuario = pv.id_pasajero
    WHERE pv.id_viaje = a.id_viaje
      AND pv.estado_reserva = 'confirmada'
  ) passengers ON true
`;

async function findActiveTripForEmergency(userId) {
  const safeUserId = normalizeUuid(userId);
  if (!safeUserId) return null;

  const result = await db.query(
    `WITH candidate_trips AS (
       SELECT v.id_viaje, 1 AS priority, v.fecha_hora_salida, v.estado_viaje
       FROM viajes v
       WHERE v.id_conductor = $1
         AND v.estado_viaje IN ('en_curso', 'programado')
       UNION ALL
       SELECT v.id_viaje, 2 AS priority, v.fecha_hora_salida, v.estado_viaje
       FROM pasajeros_viaje pv
       JOIN viajes v ON v.id_viaje = pv.id_viaje
       WHERE pv.id_pasajero = $1
         AND pv.estado_reserva = 'confirmada'
         AND v.estado_viaje IN ('en_curso', 'programado')
     )
     SELECT id_viaje
     FROM candidate_trips
     ORDER BY
       CASE WHEN estado_viaje = 'en_curso' THEN 0 ELSE 1 END,
       priority,
       ABS(EXTRACT(EPOCH FROM (fecha_hora_salida - NOW())))
     LIMIT 1`,
    [safeUserId],
  );

  return result.rows[0]?.id_viaje || null;
}

async function getAlertById(alertId) {
  const result = await db.query(
    `${alertSelectSql}
     WHERE a.id_alerta = $1`,
    [alertId],
  );
  return result.rows[0] || null;
}

async function createCentinelaSupportTicket(alert) {
  if (!alert?.id_usuario) return null;

  const hasLocation =
    alert.latitud !== null &&
    alert.latitud !== undefined &&
    alert.longitud !== null &&
    alert.longitud !== undefined;
  const locationText = hasLocation
    ? `${alert.latitud}, ${alert.longitud}`
    : "Ubicacion no disponible";
  const mapUrl = hasLocation
    ? `https://www.google.com/maps/search/?api=1&query=${alert.latitud},${alert.longitud}`
    : "Sin enlace de mapa";
  const passengers = Array.isArray(alert.pasajeros) ? alert.pasajeros : [];
  const passengerText = passengers.length
    ? passengers
        .map(
          (p) =>
            `- ${p.nombre || "Pasajero"} | ${p.telefono || "sin telefono"} | ${p.correo || "sin correo"}`,
        )
        .join("\n")
    : "Sin pasajeros confirmados asociados al viaje.";

  const description = [
    `Alerta Centinela: ${alert.id_alerta}`,
    `Estado: ${alert.estado_alerta}`,
    `Activacion: ${alert.tipo_activacion || "manual"}`,
    `Ubicacion: ${locationText}`,
    `Mapa: ${mapUrl}`,
    `Usuario alertante: ${alert.nombre_completo || "No identificado"} | ${alert.numero_telefono || "sin telefono"} | ${alert.correo_electronico || "sin correo"}`,
    `Conductor: ${alert.conductor_nombre || "No asociado"} | ${alert.conductor_telefono || "sin telefono"} | ${alert.conductor_correo || "sin correo"}`,
    `Vehiculo: ${[alert.marca, alert.modelo, alert.placa].filter(Boolean).join(" ") || "No asociado"}`,
    `Ruta: ${alert.origen_viaje || "N/D"} -> ${alert.destino_viaje || "N/D"}`,
    `Audio: ${alert.audio_url || "Sin archivo de audio adjunto"}`,
    "Pasajeros:",
    passengerText,
    "",
    `Descripcion: ${alert.descripcion_alerta || "Emergencia Centinela activada"}`,
    alert.transcript ? `Transcripcion: ${alert.transcript}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const existing = await db.query(
    `SELECT id_ticket
     FROM tickets_soporte
     WHERE categoria = 'Emergencia Centinela'
       AND descripcion_problema LIKE $1
     LIMIT 1`,
    [`%${alert.id_alerta}%`],
  );
  if (existing.rows.length > 0) return existing.rows[0];

  const ticket = await db.query(
    `INSERT INTO tickets_soporte
      (id_usuario, categoria, asunto_ticket, descripcion_problema, estado_ticket)
     VALUES ($1, 'Emergencia Centinela', $2, $3, 'pending')
     RETURNING id_ticket`,
    [
      alert.id_usuario,
      `EMERGENCIA CENTINELA - ${alert.nombre_completo || "Usuario"}`,
      description,
    ],
  );
  return ticket.rows[0];
}

// Socket.io logic para Chat
io.on("connection", (socket) => {
  console.log("User connected to socket:", socket.id);

  socket.on("register_user", (data = {}) => {
    if (!data.userId) return;
    socket.join(userRoom(data.userId));
    console.log(`User registered socket room: ${data.userId}`);
  });

  socket.on("join_room", (data) => {
    socket.join(data.room);
    console.log(`User joined room: ${data.room}`);
  });

  socket.on("send_message", async (data) => {
    try {
      const callerId = data.senderId;
      const receiverId = data.receiverId;
      if (callerId && receiverId) {
        const blocked = await db.query(
          `SELECT 1 FROM usuarios_bloqueados
           WHERE (id_bloqueador = $1::uuid AND id_bloqueado = $2::uuid)
              OR (id_bloqueador = $2::uuid AND id_bloqueado = $1::uuid)
           LIMIT 1`,
          [callerId, receiverId]
        );
        if (blocked.rows.length > 0) return; // Ignore message
      }
      socket.to(data.room).emit("receive_message", data);
    } catch (e) {
      console.error("Error in send_message socket:", e);
    }
  });

  socket.on("send_community_message", async (data) => {
    try {
      const { community_id, sender_id, content, message_type = 'text', media_url = null } = data;
      if (community_id && sender_id && content) {
        const result = await db.query(
          `INSERT INTO mensajes_comunidad (community_id, sender_id, content, message_type, media_url)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [community_id, sender_id, content, message_type, media_url]
        );
        // Include sender info
        const userRes = await db.query(
          `SELECT nombre_completo, foto_perfil_url FROM usuarios WHERE id_usuario = $1`,
          [sender_id]
        );
        const msg = result.rows[0];
        if (userRes.rows.length > 0) {
          msg.sender_name = userRes.rows[0].nombre_completo;
          msg.sender_avatar = userRes.rows[0].foto_perfil_url;
        }
        
        io.to(community_id).emit("receive_community_message", msg);
      }
    } catch (e) {
      console.error("Error in send_community_message:", e);
    }
  });

  socket.on("start_call", async (data = {}) => {
    if (!data.receiverId || !data.callID || !data.callerId) return;
    try {
      const blocked = await db.query(
        `SELECT 1
         FROM usuarios_bloqueados
        WHERE (id_bloqueador = $1::uuid AND id_bloqueado = $2::uuid)
           OR (id_bloqueador = $2::uuid AND id_bloqueado = $1::uuid)
        LIMIT 1`,
        [data.callerId, data.receiverId]
      );
      if (blocked.rows.length > 0) {
        return io.to(userRoom(data.callerId)).emit("call_rejected", { reason: "blocked" });
      }

      io.to(userRoom(data.receiverId)).emit("incoming_call", {
        callID: data.callID,
        callerId: data.callerId,
        callerName: data.callerName || "Contacto",
        receiverId: data.receiverId,
        isVideo: data.isVideo !== false,
      });
    } catch (error) {
      console.error("Error al iniciar llamada:", error);
    }
  });

  socket.on("accept_call", (data = {}) => {
    if (!data.callerId) return;
    io.to(userRoom(data.callerId)).emit("call_accepted", data);
  });

  socket.on("reject_call", (data = {}) => {
    if (!data.callerId) return;
    io.to(userRoom(data.callerId)).emit("call_rejected", data);
  });

  socket.on("cancel_call", (data = {}) => {
    if (!data.receiverId) return;
    io.to(userRoom(data.receiverId)).emit("call_cancelled", data);
  });

  socket.on("disconnect", () => {
    console.log("User Disconnected:", socket.id);
  });
});

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(",") : "*",
  credentials: true
}));
app.use(express.json({ limit: "8mb" }));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Rate Limiting (Protección DoS y Fuerza Bruta)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 600, // máximo 600 peticiones por IP cada 15 min
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiadas peticiones desde esta IP, intente más tarde en 15 minutos." }
});
app.use("/api/", apiLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 10, // máximo 10 intentos de login/registro por IP cada 15 min
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiados intentos de inicio de sesión o registro. Por seguridad, intente de nuevo en 15 minutos." }
});
app.use("/api/login", authLimiter);
app.use("/api/register", authLimiter);
app.use("/api/password/forgot", authLimiter);

// Middleware de autenticación JWT
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Acceso no autorizado. Token requerido." });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Token inválido o expirado." });
    req.user = user;
    next();
  });
};

const optionalAuthenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) {
    req.user = null;
    return next();
  }
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (!err) req.user = user;
    next();
  });
};

// ─────────────────────────────────────────────
// ENDPOINT: Buscar Usuarios (excluyendo bloqueados)
// GET /api/users/search?q=nombre&userId=<mi_id>
// ─────────────────────────────────────────────
app.get("/api/users/search", async (req, res) => {
  try {
    const { q, userId } = req.query;
    if (!q || q.trim().length < 2) return res.json([]);

    const result = await db.query(
      `SELECT id_usuario, nombre_completo, correo_electronico, rol_usuario, url_documento_identidad
       FROM usuarios
       WHERE (LOWER(nombre_completo) LIKE LOWER($1) OR LOWER(correo_electronico) LIKE LOWER($1))
         AND id_usuario != COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
         AND ($2 IS NULL OR id_usuario NOT IN (
           SELECT id_bloqueado FROM usuarios_bloqueados WHERE id_bloqueador = $2::uuid
         ))
       ORDER BY nombre_completo ASC
       LIMIT 20`,
      [`%${q}%`, userId || null],
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error búsqueda de usuarios:", error);
    res.status(500).json({ error: "Error al buscar usuarios" });
  }
});

// ─────────────────────────────────────────────
// ENDPOINT: Obtener comunidad según dominio de correo
// GET /api/community/match?email=carlos@utp.edu.pe
// ─────────────────────────────────────────────
app.get("/api/community/match", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: "Email requerido" });

    // Extraer dominio: "utp.edu.pe" -> "utp"
    const domain = email.split("@")[1] || "";
    const university = domain.split(".")[0].toUpperCase(); // "UTP"

    // Buscar usuarios de la misma universidad por dominio de correo
    const result = await db.query(
      `SELECT id_usuario, nombre_completo, correo_electronico, rol_usuario
       FROM usuarios
       WHERE LOWER(correo_electronico) LIKE LOWER($1)
         AND LOWER(correo_electronico) != LOWER($2)
       ORDER BY nombre_completo ASC
       LIMIT 50`,
      [`%@${domain}`, email],
    );

    res.json({ university, members: result.rows });
  } catch (error) {
    console.error("Error community match:", error);
    res.status(500).json({ error: "Error al obtener comunidad" });
  }
});

app.get("/api/community/:communityId/messages", async (req, res) => {
  try {
    const { communityId } = req.params;
    const result = await db.query(
      `SELECT m.*, u.nombre_completo as sender_name, u.foto_perfil_url as sender_avatar 
       FROM mensajes_comunidad m
       JOIN usuarios u ON m.sender_id = u.id_usuario
       WHERE m.community_id = $1
       ORDER BY m.created_at ASC
       LIMIT 100`,
      [communityId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error getting community messages:", error);
    res.status(500).json({ error: "Error al obtener mensajes" });
  }
});

// ─────────────────────────────────────────────
// ENDPOINT: Bloquear usuario
// POST /api/users/block  { id_bloqueador, id_bloqueado }
// ─────────────────────────────────────────────
app.post("/api/users/block", async (req, res) => {
  try {
    const { id_bloqueador, id_bloqueado } = req.body;
    if (!id_bloqueador || !id_bloqueado) {
      return res
        .status(400)
        .json({ error: "Se requieren id_bloqueador e id_bloqueado" });
    }
    // Crear tabla si no existe
    await db.query(`
      CREATE TABLE IF NOT EXISTS usuarios_bloqueados (
        id_bloqueador UUID NOT NULL,
        id_bloqueado  UUID NOT NULL,
        fecha_bloqueo TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id_bloqueador, id_bloqueado)
      )
    `);
    await db.query(
      `INSERT INTO usuarios_bloqueados (id_bloqueador, id_bloqueado) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [id_bloqueador, id_bloqueado],
    );
    res.json({ message: "Usuario bloqueado correctamente" });
  } catch (error) {
    console.error("Error bloquear usuario:", error);
    res.status(500).json({ error: "Error al bloquear usuario" });
  }
});

// ─────────────────────────────────────────────
// ENDPOINT: Desbloquear usuario
// DELETE /api/users/block { id_bloqueador, id_bloqueado }
// ─────────────────────────────────────────────
app.delete("/api/users/block", async (req, res) => {
  try {
    const { id_bloqueador, id_bloqueado } = req.body;
    await db.query(
      "DELETE FROM usuarios_bloqueados WHERE id_bloqueador = $1 AND id_bloqueado = $2",
      [id_bloqueador, id_bloqueado],
    );
    res.json({ message: "Usuario desbloqueado" });
  } catch (error) {
    console.error("Error desbloquear:", error);
    res.status(500).json({ error: "Error al desbloquear usuario" });
  }
});

// ─────────────────────────────────────────────
// ENDPOINT: Verificar si un usuario está bloqueado
// GET /api/users/check-block?userId1=...&userId2=...
// ─────────────────────────────────────────────
app.get("/api/users/check-block", async (req, res) => {
  try {
    const { userId1, userId2 } = req.query;
    if (!userId1 || !userId2) {
      return res.status(400).json({ error: "Faltan parámetros" });
    }
    const result = await db.query(
      `SELECT id_bloqueador 
       FROM usuarios_bloqueados 
       WHERE (id_bloqueador = $1::uuid AND id_bloqueado = $2::uuid)
          OR (id_bloqueador = $2::uuid AND id_bloqueado = $1::uuid)
       LIMIT 1`,
      [userId1, userId2]
    );
    if (result.rows.length > 0) {
      return res.json({ 
        isBlocked: true, 
        blockedByMe: result.rows[0].id_bloqueador === userId1 
      });
    }
    res.json({ isBlocked: false, blockedByMe: false });
  } catch (error) {
    console.error("Error check-block:", error);
    res.status(500).json({ error: "Error al verificar bloqueo" });
  }
});

// ─────────────────────────────────────────────
// MENSAJES DIRECTOS (persistencia en BD)
// ─────────────────────────────────────────────

// Asegurar que la tabla existe al inicio del servidor
(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS mensajes (
        id           SERIAL PRIMARY KEY,
        sender_id    UUID NOT NULL REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
        receiver_id  UUID NOT NULL REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
        content      TEXT NOT NULL,
        message_type VARCHAR(20) NOT NULL DEFAULT 'text',
        media_url    TEXT,
        status       VARCHAR(20) NOT NULL DEFAULT 'sent',
        delivered_at TIMESTAMP WITH TIME ZONE,
        read_at      TIMESTAMP WITH TIME ZONE,
        created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS mensajes_comunidad (
        id           SERIAL PRIMARY KEY,
        community_id VARCHAR(100) NOT NULL,
        sender_id    UUID NOT NULL REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
        content      TEXT NOT NULL,
        message_type VARCHAR(20) NOT NULL DEFAULT 'text',
        media_url    TEXT,
        status       VARCHAR(20) NOT NULL DEFAULT 'sent',
        read_by      TEXT[] DEFAULT '{}',
        created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
    await db.query(
      `ALTER TABLE mensajes ADD COLUMN IF NOT EXISTS message_type VARCHAR(20) NOT NULL DEFAULT 'text';`,
    );
    await db.query(
      `ALTER TABLE mensajes ADD COLUMN IF NOT EXISTS media_url TEXT;`,
    );
    await db.query(
      `ALTER TABLE mensajes ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'sent';`,
    );
    await db.query(
      `ALTER TABLE mensajes ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP WITH TIME ZONE;`,
    );
    await db.query(
      `ALTER TABLE mensajes ADD COLUMN IF NOT EXISTS read_at TIMESTAMP WITH TIME ZONE;`,
    );
    await db.query(
      `ALTER TABLE mensajes ADD COLUMN IF NOT EXISTS deleted_for_everyone BOOLEAN DEFAULT false;`,
    );
    await db.query(
      `ALTER TABLE mensajes ADD COLUMN IF NOT EXISTS deleted_for_sender BOOLEAN DEFAULT false;`,
    );
    await db.query(
      `ALTER TABLE mensajes ADD COLUMN IF NOT EXISTS deleted_for_receiver BOOLEAN DEFAULT false;`,
    );
    await db.query(
      `ALTER TABLE mensajes_comunidad ADD COLUMN IF NOT EXISTS message_type VARCHAR(20) NOT NULL DEFAULT 'text';`,
    );
    await db.query(
      `ALTER TABLE mensajes_comunidad ADD COLUMN IF NOT EXISTS media_url TEXT;`,
    );
    await db.query(
      `ALTER TABLE mensajes_comunidad ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'sent';`,
    );
    await db.query(
      `ALTER TABLE mensajes_comunidad ADD COLUMN IF NOT EXISTS read_by TEXT[] DEFAULT '{}';`,
    );
    // Índice para acelerar consultas por conversación
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_mensajes_conversacion
        ON mensajes(sender_id, receiver_id, created_at);
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_mensajes_receiver_status
        ON mensajes(receiver_id, status, created_at);
    `);
    console.log("[DB] Tabla mensajes lista.");
  } catch (e) {
    console.error("[DB] Error creando tabla mensajes:", e.message);
  }
})();

(async () => {
  try {
    await db.query(
      `ALTER TABLE alertas_sos ADD COLUMN IF NOT EXISTS tipo_activacion VARCHAR(30) DEFAULT 'manual';`,
    );
    await db.query(
      `ALTER TABLE alertas_sos ADD COLUMN IF NOT EXISTS descripcion_alerta TEXT;`,
    );
    await db.query(
      `ALTER TABLE alertas_sos ADD COLUMN IF NOT EXISTS transcript TEXT;`,
    );
    await db.query(
      `ALTER TABLE alertas_sos ADD COLUMN IF NOT EXISTS audio_url TEXT;`,
    );
    await db.query(
      `ALTER TABLE alertas_sos ADD COLUMN IF NOT EXISTS audio_nombre TEXT;`,
    );
    await db.query(
      `ALTER TABLE alertas_sos ADD COLUMN IF NOT EXISTS atendida_por UUID REFERENCES usuarios(id_usuario) ON DELETE SET NULL;`,
    );
    await db.query(
      `ALTER TABLE alertas_sos ADD COLUMN IF NOT EXISTS fecha_atencion TIMESTAMP WITH TIME ZONE;`,
    );
    await db.query(`
      CREATE TABLE IF NOT EXISTS centinela_tracking (
        id_tracking UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        id_usuario UUID REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
        id_viaje UUID REFERENCES viajes(id_viaje) ON DELETE SET NULL,
        latitud DECIMAL(10, 8),
        longitud DECIMAL(11, 8),
        precision_metros DECIMAL(10, 2),
        evento VARCHAR(50) DEFAULT 'ubicacion',
        fecha_tracking TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_centinela_tracking_usuario_fecha
        ON centinela_tracking(id_usuario, fecha_tracking DESC);
    `);
    console.log("[DB] Centinela operativo listo.");
  } catch (e) {
    console.error("[DB] Error preparando Centinela:", e.message);
  }
})();

(async () => {
  try {
    await db.query(
      `ALTER TABLE viajes ADD COLUMN IF NOT EXISTS origen_latitud DECIMAL(10, 8);`,
    );
    await db.query(
      `ALTER TABLE viajes ADD COLUMN IF NOT EXISTS origen_longitud DECIMAL(11, 8);`,
    );
    await db.query(
      `ALTER TABLE viajes ADD COLUMN IF NOT EXISTS destino_latitud DECIMAL(10, 8);`,
    );
    await db.query(
      `ALTER TABLE viajes ADD COLUMN IF NOT EXISTS destino_longitud DECIMAL(11, 8);`,
    );
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_viajes_origen_coords
        ON viajes(origen_latitud, origen_longitud)
        WHERE origen_latitud IS NOT NULL AND origen_longitud IS NOT NULL;
    `);
    console.log("[DB] Coordenadas de viajes listas.");
  } catch (e) {
    console.error("[DB] Error preparando coordenadas de viajes:", e.message);
  }
})();

(async () => {
  try {
    await db.query(
      `ALTER TABLE transacciones_billetera ADD COLUMN IF NOT EXISTS comprobante_url TEXT;`,
    );
    await db.query(
      `ALTER TABLE transacciones_billetera ADD COLUMN IF NOT EXISTS comprobante_nombre TEXT;`,
    );
    await db.query(
      `ALTER TABLE transacciones_billetera ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;`,
    );
    console.log("[DB] Comprobantes de billetera listos.");
  } catch (e) {
    console.error("[DB] Error preparando billetera:", e.message);
  }
})();

(async () => {
  try {
    await db.query(
      `ALTER TABLE pasajeros_viaje ADD COLUMN IF NOT EXISTS monto_pagado DECIMAL(10, 2) DEFAULT 0;`,
    );
    await db.query(
      `ALTER TABLE pasajeros_viaje ADD COLUMN IF NOT EXISTS estado_pago VARCHAR(50) DEFAULT 'pendiente';`,
    );
    await db.query(
      `ALTER TABLE pasajeros_viaje ADD COLUMN IF NOT EXISTS metodo_pago VARCHAR(50) DEFAULT 'billetera';`,
    );
    console.log("[DB] Pagos de reservas listos.");
  } catch (e) {
    console.error("[DB] Error preparando pagos de reservas:", e.message);
  }
})();

(async () => {
  try {
    await db.query(
      `ALTER TABLE tickets_soporte ADD COLUMN IF NOT EXISTS categoria VARCHAR(100) DEFAULT 'Soporte General';`,
    );
    await db.query(
      `ALTER TABLE tickets_soporte ADD COLUMN IF NOT EXISTS evidencia_url TEXT;`,
    );
    await db.query(
      `ALTER TABLE tickets_soporte ADD COLUMN IF NOT EXISTS evidencia_nombre TEXT;`,
    );
    console.log("[DB] Tickets de soporte listos.");
  } catch (e) {
    console.error("[DB] Error preparando tickets de soporte:", e.message);
  }
})();

// GET /api/messages?senderId=X&receiverId=Y   → últimos 100 mensajes de la conversación
app.get("/api/conversations", async (req, res) => {
  const { userId } = req.query;
  if (!userId) {
    return res.status(400).json({ error: "userId es obligatorio" });
  }

  try {
    const result = await db.query(
      `WITH user_messages AS (
         SELECT
           m.*,
           CASE WHEN m.sender_id = $1::uuid THEN m.receiver_id ELSE m.sender_id END AS other_user_id,
           ROW_NUMBER() OVER (
             PARTITION BY LEAST(m.sender_id, m.receiver_id), GREATEST(m.sender_id, m.receiver_id)
             ORDER BY m.created_at DESC, m.id DESC
           ) AS rn
         FROM mensajes m
         WHERE (m.sender_id = $1::uuid AND m.deleted_for_sender = false)
            OR (m.receiver_id = $1::uuid AND m.deleted_for_receiver = false)
       )
       SELECT
         um.other_user_id,
         u.nombre_completo,
         u.correo_electronico,
         u.rol_usuario,
         um.id AS last_message_id,
         CASE WHEN um.deleted_for_everyone THEN '🚫 Este mensaje fue eliminado' ELSE um.content END AS last_message,
         um.message_type,
         um.media_url,
         um.status AS last_message_status,
         um.sender_id AS last_sender_id,
         um.created_at AS last_message_at,
         COALESCE(unread.total, 0)::int AS unread_count
       FROM user_messages um
       JOIN usuarios u ON u.id_usuario = um.other_user_id
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS total
         FROM mensajes m2
         WHERE m2.sender_id = um.other_user_id
           AND m2.receiver_id = $1::uuid
           AND m2.status <> 'read'
       ) unread ON true
       WHERE um.rn = 1
       ORDER BY um.created_at DESC`,
      [userId],
    );
    res.json(result.rows);
  } catch (error) {
    console.error("[GET /api/conversations]", error);
    res.status(500).json({ error: "Error al obtener conversaciones" });
  }
});

app.get("/api/messages", async (req, res) => {
  const { senderId, receiverId } = req.query;
  if (!senderId || !receiverId) {
    return res
      .status(400)
      .json({ error: "Se requieren senderId y receiverId" });
  }
  try {
    const readResult = await db.query(
      `UPDATE mensajes
          SET status = 'read',
              delivered_at = COALESCE(delivered_at, NOW()),
              read_at = COALESCE(read_at, NOW())
        WHERE sender_id = $2::uuid
          AND receiver_id = $1::uuid
          AND status <> 'read'
        RETURNING id`,
      [senderId, receiverId],
    );

    const result = await db.query(
      `SELECT id, sender_id, receiver_id, content, message_type, media_url, status, delivered_at, read_at, created_at, deleted_for_everyone
         FROM mensajes
        WHERE (sender_id = $1 AND receiver_id = $2 AND deleted_for_sender = false)
           OR (sender_id = $2 AND receiver_id = $1 AND deleted_for_receiver = false)
        ORDER BY created_at ASC
        LIMIT 100`,
      [senderId, receiverId],
    );

    if (readResult.rows.length > 0) {
      io.to(userRoom(receiverId)).emit("messages_read", {
        readerId: senderId,
        senderId: receiverId,
        messageIds: readResult.rows.map((row) => row.id),
      });
      io.to(userRoom(senderId)).emit("conversations_updated", {
        userId: senderId,
      });
      io.to(userRoom(receiverId)).emit("conversations_updated", {
        userId: receiverId,
      });
    }

    res.json(result.rows);
  } catch (error) {
    console.error("[GET /api/messages]", error);
    res.status(500).json({ error: "Error al obtener mensajes" });
  }
});

// POST /api/messages   { senderId, receiverId, content }   → guarda y devuelve el mensaje
app.post("/api/messages", async (req, res) => {
  const {
    senderId,
    receiverId,
    content,
    messageType = "text",
    mediaUrl = null,
  } = req.body;
  const normalizedContent = typeof content === "string" ? content.trim() : "";
  const normalizedType = ["text", "audio"].includes(messageType)
    ? messageType
    : "text";

  if (!senderId || !receiverId || (!normalizedContent && !mediaUrl)) {
    return res
      .status(400)
      .json({
        error: "senderId, receiverId y content/mediaUrl son obligatorios",
      });
  }
  try {
    const blocked = await db.query(
      `SELECT 1
         FROM usuarios_bloqueados
        WHERE (id_bloqueador = $1::uuid AND id_bloqueado = $2::uuid)
           OR (id_bloqueador = $2::uuid AND id_bloqueado = $1::uuid)
        LIMIT 1`,
      [senderId, receiverId],
    );
    if (blocked.rows.length > 0) {
      return res
        .status(403)
        .json({ error: "No se puede enviar mensajes a este usuario" });
    }

    const result = await db.query(
      `INSERT INTO mensajes (sender_id, receiver_id, content, message_type, media_url, status)
       VALUES ($1, $2, $3, $4, $5, 'sent')
       RETURNING id, sender_id, receiver_id, content, message_type, media_url, status, delivered_at, read_at, created_at`,
      [senderId, receiverId, normalizedContent, normalizedType, mediaUrl],
    );
    const message = result.rows[0];

    io.to(userRoom(receiverId)).emit("receive_message", message);
    io.to(userRoom(senderId)).emit("message_saved", message);
    io.to(userRoom(receiverId)).emit("conversations_updated", {
      userId: receiverId,
    });
    io.to(userRoom(senderId)).emit("conversations_updated", {
      userId: senderId,
    });

    res.status(201).json(message);
  } catch (error) {
    console.error("[POST /api/messages]", error);
    res.status(500).json({ error: "Error al guardar mensaje" });
  }
});

app.put("/api/messages/read", async (req, res) => {
  const { readerId, senderId } = req.body;
  if (!readerId || !senderId) {
    return res
      .status(400)
      .json({ error: "readerId y senderId son obligatorios" });
  }

  try {
    const result = await db.query(
      `UPDATE mensajes
          SET status = 'read',
              delivered_at = COALESCE(delivered_at, NOW()),
              read_at = COALESCE(read_at, NOW())
        WHERE sender_id = $2::uuid
          AND receiver_id = $1::uuid
          AND status <> 'read'
        RETURNING id`,
      [readerId, senderId],
    );

    io.to(userRoom(senderId)).emit("messages_read", {
      readerId,
      senderId,
      messageIds: result.rows.map((row) => row.id),
    });
    io.to(userRoom(readerId)).emit("conversations_updated", {
      userId: readerId,
    });
    io.to(userRoom(senderId)).emit("conversations_updated", {
      userId: senderId,
    });

    res.json({ updated: result.rowCount });
  } catch (error) {
    console.error("[PUT /api/messages/read]", error);
    res.status(500).json({ error: "Error al marcar mensajes como leidos" });
  }
});

app.delete("/api/messages/:id", async (req, res) => {
  const { id } = req.params;
  const { userId, type } = req.query; // type = 'for_me' | 'for_everyone'

  try {
    const msgResult = await db.query(`SELECT sender_id, receiver_id FROM mensajes WHERE id = $1`, [id]);
    if (msgResult.rows.length === 0) return res.status(404).json({ error: "Mensaje no encontrado" });

    const msg = msgResult.rows[0];

    if (type === 'for_everyone') {
      if (msg.sender_id !== userId) return res.status(403).json({ error: "No tienes permiso" });
      
      await db.query(`UPDATE mensajes SET deleted_for_everyone = true WHERE id = $1`, [id]);
      
      io.to(userRoom(msg.receiver_id)).emit("message_deleted_for_everyone", { messageId: id });
    } else { // for_me
      if (msg.sender_id === userId) {
        await db.query(`UPDATE mensajes SET deleted_for_sender = true WHERE id = $1`, [id]);
      } else if (msg.receiver_id === userId) {
        await db.query(`UPDATE mensajes SET deleted_for_receiver = true WHERE id = $1`, [id]);
      } else {
        return res.status(403).json({ error: "No tienes permiso" });
      }
    }
    
    // Update conversation list for both users
    io.to(userRoom(msg.sender_id)).emit("conversations_updated", { userId: msg.sender_id });
    io.to(userRoom(msg.receiver_id)).emit("conversations_updated", { userId: msg.receiver_id });

    res.json({ success: true });
  } catch (error) {
    console.error("[DELETE /api/messages]", error);
    res.status(500).json({ error: "Error al borrar mensaje" });
  }
});

// Helper for sending role-based emails

const sendEmail = async (to, subject, htmlContent) => {
  if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    try {
      const emailUserLower = process.env.EMAIL_USER.toLowerCase();
      const isOutlook = emailUserLower.includes("@outlook.") ||
                        emailUserLower.includes("@hotmail.") ||
                        emailUserLower.includes("@live.");

      const transportConfig = process.env.EMAIL_HOST
        ? {
            host: process.env.EMAIL_HOST,
            port: Number(process.env.EMAIL_PORT) || 587,
            secure: process.env.EMAIL_SECURE === "true",
            auth: {
              user: process.env.EMAIL_USER,
              pass: process.env.EMAIL_PASS,
            },
          }
        : isOutlook
          ? {
              host: "smtp-mail.outlook.com",
              port: 587,
              secure: false,
              tls: { ciphers: "SSLv3" },
              auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS,
              },
            }
          : {
              service: "gmail",
              auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS,
              },
            };

      const transporter = nodemailer.createTransport(transportConfig);
      await transporter.sendMail({
        from: '"Rumbo App" <' + process.env.EMAIL_USER + ">",
        to,
        subject,
        html: htmlContent,
      });
      console.log("[RUMBO EMAIL] Enviado a %s: %s", String(to), String(subject));
    } catch (error) {
      console.error("[RUMBO EMAIL ERROR] No se pudo enviar a %s", String(to), error);
    }
  } else {
    console.log("[RUMBO SIMULADO EMAIL a %s] Asunto: %s", String(to), String(subject));
  }
};

// 1. Health check
app.get("/api/health", async (req, res) => {
  try {
    const result = await db.query("SELECT NOW() as current_time");
    res.json({
      status: "OK",
      message: "El servidor de Rumbo está funcionando correctamente",
      db_time: result.rows[0].current_time,
    });
  } catch (error) {
    res
      .status(500)
      .json({
        status: "ERROR",
        message: "Fallo al conectar con PostgreSQL",
        error: error.message,
      });
  }
});

// 2. Universidades
app.get("/api/universities", async (req, res) => {
  try {
    const result = await db.query(
      "SELECT * FROM universidades ORDER BY nombre_universidad",
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. Enviar OTP (Nodemailer)
app.post("/api/send-otp", async (req, res) => {
  try {
    const { correo_electronico } = req.body;

    // Validar si el correo ya existe
    const exists = await db.query(
      "SELECT id_usuario FROM usuarios WHERE LOWER(correo_electronico) = LOWER($1)",
      [correo_electronico],
    );
    if (exists.rows.length > 0)
      return res.status(400).json({ error: "El correo ya está registrado" });

    // Generar código de 6 dígitos
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Solo intentar enviar si las credenciales están configuradas
    const subject = "Código de Verificación - Rumbo";
    const htmlContent = `<h3>Bienvenido a Rumbo</h3><p>Tu código de verificación de 6 dígitos es: <b style="font-size:24px; color:#1D4ED8;">${otp}</b></p>`;

    await sendEmail(correo_electronico, subject, htmlContent);

    res.json({ message: "Código enviado", otp: otp });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Fallo al enviar correo" });
  }
});

// 3.1 Olvidé mi Contraseña - Enviar OTP
app.post("/api/forgot-password", async (req, res) => {
  try {
    const { correo_electronico } = req.body;

    // Validar si el correo existe
    const exists = await db.query(
      "SELECT id_usuario FROM usuarios WHERE LOWER(correo_electronico) = LOWER($1)",
      [correo_electronico],
    );
    if (exists.rows.length === 0)
      return res.status(404).json({ error: "Usuario no encontrado" });

    // Generar código de 6 dígitos
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    const subject = "Recuperación de Contraseña - Rumbo";
    const htmlContent = `<h3>Recuperación de Contraseña</h3><p>Tu código de seguridad de 6 dígitos es: <b style="font-size:24px; color:#1D4ED8;">${otp}</b></p><p>Si no solicitaste este código, puedes ignorar este mensaje.</p>`;

    await sendEmail(correo_electronico, subject, htmlContent);

    res.json({ message: "Código de recuperación enviado", otp: otp });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Fallo al enviar correo de recuperación" });
  }
});

// 3.2 Restablecer Contraseña
app.post("/api/reset-password", async (req, res) => {
  try {
    const { correo_electronico, nueva_contrasena } = req.body;

    // Encriptar nueva contraseña
    const salt = await bcrypt.genSalt(10);
    const contrasena_hash = await bcrypt.hash(nueva_contrasena, salt);

    // Actualizar en la BD
    const result = await db.query(
      "UPDATE usuarios SET contrasena_hash = $1 WHERE LOWER(correo_electronico) = LOWER($2) RETURNING id_usuario",
      [contrasena_hash, correo_electronico]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    res.json({ message: "Contraseña actualizada correctamente" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al actualizar contraseña" });
  }
});

// 4. Registrar Usuario (Auth)
app.post("/api/register", async (req, res) => {
  try {
    const {
      nombre_completo,
      correo_electronico,
      contrasena,
      numero_telefono,
      tipo_cuenta,
      universidad_nombre,
    } = req.body;

    // Validar si el usuario ya existe
    const exists = await db.query(
      "SELECT id_usuario FROM usuarios WHERE LOWER(correo_electronico) = LOWER($1)",
      [correo_electronico],
    );
    if (exists.rows.length > 0)
      return res.status(400).json({ error: "El correo ya está registrado" });

    // Encriptar contraseña
    const salt = await bcrypt.genSalt(10);
    const contrasena_hash = await bcrypt.hash(contrasena, salt);

    // Obtener ID de la universidad si es estudiante
    let id_universidad = null;
    if (
      universidad_nombre &&
      universidad_nombre !== "Selecciona tu universidad"
    ) {
      const u = await db.query(
        "SELECT id_universidad FROM universidades WHERE nombre_universidad = $1",
        [universidad_nombre],
      );
      if (u.rows.length > 0) id_universidad = u.rows[0].id_universidad;
    }

    // Insertar en la BD
    const result = await db.query(
      `INSERT INTO usuarios (nombre_completo, correo_electronico, contrasena_hash, numero_telefono, tipo_cuenta, id_universidad) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id_usuario, nombre_completo, correo_electronico, rol_usuario`,
      [
        nombre_completo,
        correo_electronico,
        contrasena_hash,
        numero_telefono,
        tipo_cuenta,
        id_universidad,
      ],
    );

    const newUser = result.rows[0];
    const token = jwt.sign(
      {
        id: newUser.id_usuario,
        email: newUser.correo_electronico,
        rol: newUser.rol_usuario || "pasajero",
      },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.status(201).json({ ...newUser, token });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al registrar usuario" });
  }
});

// 4. Iniciar Sesión (Auth)
app.post("/api/login", async (req, res) => {
  try {
    const { correo_electronico, contrasena } = req.body;

    const userResult = await db.query(
      "SELECT * FROM usuarios WHERE LOWER(correo_electronico) = LOWER($1)",
      [correo_electronico],
    );
    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: "Usuario no encontrado" });
    }

    const user = userResult.rows[0];
    const validPassword = await bcrypt.compare(
      contrasena,
      user.contrasena_hash,
    );

    if (!validPassword) {
      return res.status(401).json({ error: "Contraseña incorrecta" });
    }

    const token = jwt.sign(
      {
        id: user.id_usuario,
        email: user.correo_electronico,
        rol: user.rol_usuario,
      },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.json({
      message: "Login exitoso",
      token,
      user: {
        id: user.id_usuario,
        nombre: user.nombre_completo,
        email: user.correo_electronico,
        rol: user.rol_usuario,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error en el servidor" });
  }
});

// 5. Obtener todos los usuarios (Panel Admin)
app.get("/api/users", optionalAuthenticateToken, async (req, res) => {
  try {
    const isAuth = req.user || req.headers["x-admin-key"] === (process.env.ADMIN_SECRET || "rumbo_admin_2026");
    if (!isAuth) {
      return res.status(401).json({ error: "Acceso denegado. Se requiere autenticación como administrador para consultar el listado general de usuarios." });
    }

    const result = await db.query(
      "SELECT id_usuario, nombre_completo, correo_electronico, rol_usuario, estado_cuenta, tipo_cuenta, fecha_registro FROM usuarios ORDER BY fecha_registro DESC",
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener usuarios" });
  }
});

// 5.0 Crear usuario de soporte (Admin)
app.post("/api/admin/support", async (req, res) => {
  try {
    const { nombre_completo, correo_electronico, contrasena, numero_telefono } =
      req.body;

    // Validar si el usuario ya existe
    const exists = await db.query(
      "SELECT id_usuario FROM usuarios WHERE LOWER(correo_electronico) = LOWER($1)",
      [correo_electronico],
    );
    if (exists.rows.length > 0)
      return res.status(400).json({ error: "El correo ya está registrado" });

    // Encriptar contraseña
    const salt = await bcrypt.genSalt(10);
    const contrasena_hash = await bcrypt.hash(contrasena, salt);

    // Insertar en la BD con rol de soporte y estado aprobado
    const result = await db.query(
      `INSERT INTO usuarios (nombre_completo, correo_electronico, contrasena_hash, numero_telefono, tipo_cuenta, rol_usuario, estado_cuenta) 
       VALUES ($1, $2, $3, $4, 'admin', 'soporte', 'aprobada') RETURNING id_usuario, nombre_completo, correo_electronico, rol_usuario`,
      [nombre_completo, correo_electronico, contrasena_hash, numero_telefono],
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al crear usuario de soporte" });
  }
});

// 5.1 Actualizar perfil de usuario (CRUD Completo)
app.put("/api/users/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre_completo, rol_usuario } = req.body;

    const result = await db.query(
      "UPDATE usuarios SET nombre_completo = COALESCE($1, nombre_completo), rol_usuario = COALESCE($2, rol_usuario) WHERE id_usuario = $3 RETURNING *",
      [nombre_completo, rol_usuario, id],
    );

    if (result.rows.length === 0)
      return res.status(404).json({ error: "Usuario no encontrado" });
    res.json({
      message: "Usuario actualizado correctamente",
      user: result.rows[0],
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al actualizar usuario" });
  }
});

// 6. Actualizar estado de usuario (Aprobar/Suspender)
app.put("/api/users/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { estado_cuenta } = req.body;

    const result = await db.query(
      "UPDATE usuarios SET estado_cuenta = $1 WHERE id_usuario = $2 RETURNING *",
      [estado_cuenta, id],
    );

    if (result.rows.length === 0)
      return res.status(404).json({ error: "Usuario no encontrado" });

    const user = result.rows[0];

    // Si la cuenta es aprobada, enviar correo según rol
    if (estado_cuenta === "aprobada") {
      let subject = "";
      let html = "";
      if (user.rol_usuario === "conductor") {
        subject = "¡Felicidades! Eres un Conductor Oficial de Rumbo";
        html = `<h3>¡Hola ${user.nombre_completo}!</h3>
                <p>Nos complace informarte que tus documentos han sido validados por la universidad y ahora eres un <b>Conductor Oficial</b> en Rumbo.</p>
                <p>Ya puedes empezar a publicar tus rutas y compartir tus viajes con otros estudiantes.</p>
                <p><i>El equipo de Rumbo</i></p>`;
      } else if (user.rol_usuario === "pasajero") {
        subject = "Tu cuenta de Rumbo ha sido aprobada";
        html = `<h3>¡Hola ${user.nombre_completo}!</h3>
                <p>Tu cuenta de pasajero ha sido verificada correctamente por la administración.</p>
                <p>Ya puedes empezar a reservar viajes seguros a tu campus.</p>
                <p><i>El equipo de Rumbo</i></p>`;
      } else if (user.rol_usuario === "administrador") {
        subject = "Bienvenido al Panel de Administración de Rumbo";
        html = `<h3>¡Hola ${user.nombre_completo}!</h3>
                <p>Se te han otorgado credenciales de <b>Administrador</b>.</p>
                <p><i>El equipo de Rumbo</i></p>`;
      }

      if (subject !== "") {
        await sendEmail(user.correo_electronico, subject, html);
      }
    }

    res.json({ message: "Estado actualizado correctamente", user });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al actualizar usuario" });
  }
});

// 7. Eliminar usuario
app.delete("/api/users/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      "DELETE FROM usuarios WHERE id_usuario = $1 RETURNING id_usuario",
      [id],
    );

    if (result.rows.length === 0)
      return res.status(404).json({ error: "Usuario no encontrado" });
    res.json({ message: "Usuario eliminado correctamente" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al eliminar usuario" });
  }
});

// 8. Obtener configuración de campus
app.get("/api/config", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM configuracion_campus LIMIT 1");
    if (result.rows.length > 0) {
      res.json(result.rows[0]);
    } else {
      res.status(404).json({ error: "Configuración no encontrada" });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener configuración" });
  }
});

// 9. Actualizar configuración de campus
app.put("/api/config", async (req, res) => {
  try {
    const { key, value } = req.body;
    // Solo permitir columnas seguras
    const validColumns = [
      "validacion_dominio",
      "bloqueo_egresados",
      "restriccion_horarios",
      "carpooling_obligatorio",
      "monedero_universitario",
      "filtro_genero",
      "enlace_sos",
      "filtro_solo_estudiantes",
      "permiso_ingreso_externos",
      "comisiones_diferenciadas",
      "bloqueo_horario_clases",
      "auditoria_resenas",
    ];

    if (!validColumns.includes(key)) {
      return res.status(400).json({ error: "Columna no válida" });
    }

    const result = await db.query(
      `UPDATE configuracion_campus SET ${key} = $1 RETURNING *`,
      [value],
    );

    res.json({ message: "Configuración actualizada", config: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al actualizar configuración" });
  }
});

// =====================================================
// ========== DRIVER / CONDUCTOR ENDPOINTS =============
// =====================================================

// 10. Obtener vehículos del conductor
app.get("/api/vehicles/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await db.query(
      "SELECT * FROM vehiculos WHERE id_propietario = $1 ORDER BY fecha_registro DESC",
      [userId],
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener vehículos" });
  }
});

// 10.1 Registrar vehículo
app.post("/api/vehicles", async (req, res) => {
  try {
    const { id_propietario, marca, modelo, placa, color, anio, asientos } =
      req.body;
    const asientosVal = asientos || 4; // default
    const result = await db.query(
      `INSERT INTO vehiculos (id_propietario, marca, modelo, placa, color, anio, asientos) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [id_propietario, marca, modelo, placa, color, anio, asientosVal],
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al registrar vehículo" });
  }
});

// 11. Crear viaje (Conductor)
app.post("/api/trips", async (req, res) => {
  try {
    const {
      id_conductor,
      id_vehiculo,
      origen_viaje,
      destino_viaje,
      fecha_hora_salida,
      asientos_totales,
      precio_por_asiento,
      origen_latitud,
      origen_longitud,
      destino_latitud,
      destino_longitud,
    } = req.body;

    if (
      !id_conductor ||
      !origen_viaje ||
      !destino_viaje ||
      !fecha_hora_salida ||
      !asientos_totales ||
      !precio_por_asiento
    ) {
      return res
        .status(400)
        .json({ error: "Datos obligatorios incompletos para crear el viaje" });
    }

    const result = await db.query(
      `INSERT INTO viajes (
         id_conductor, id_vehiculo, origen_viaje, destino_viaje, fecha_hora_salida,
         asientos_totales, asientos_disponibles, precio_por_asiento,
         origen_latitud, origen_longitud, destino_latitud, destino_longitud
       )
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        id_conductor,
        id_vehiculo || null,
        origen_viaje,
        destino_viaje,
        fecha_hora_salida,
        asientos_totales,
        precio_por_asiento,
        origen_latitud || null,
        origen_longitud || null,
        destino_latitud || null,
        destino_longitud || null,
      ],
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al crear viaje" });
  }
});

// 11.5 Solicitar viaje (Pasajero)
app.post("/api/trip-requests", async (req, res) => {
  try {
    const { id_pasajero, origen, destino, fecha_hora_solicitada } = req.body;
    if (!id_pasajero || !origen || !destino || !fecha_hora_solicitada) {
      return res.status(400).json({ error: "Datos incompletos para solicitar viaje" });
    }

    const result = await db.query(
      `INSERT INTO solicitudes_viaje (id_pasajero, origen, destino, fecha_hora_solicitada, estado)
       VALUES ($1, $2, $3, $4, 'pendiente')
       RETURNING *`,
      [id_pasajero, origen, destino, fecha_hora_solicitada]
    );

    // Emit via socket if needed
    io.emit("new_trip_request", result.rows[0]);

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Error al solicitar viaje:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// 11.6 Obtener solicitudes de viaje pendientes (Para conductores)
app.get("/api/trip-requests", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT sr.*, u.nombre_completo as nombre_pasajero, u.foto_perfil as avatar_pasajero
       FROM solicitudes_viaje sr
       JOIN usuarios u ON sr.id_pasajero = u.id_usuario
       WHERE sr.estado = 'pendiente'
       ORDER BY sr.fecha_creacion DESC`
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error al obtener solicitudes de viaje:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// 11.7 Conductor acepta una solicitud de viaje
app.post("/api/trips/accept-request", async (req, res) => {
  try {
    const { id_solicitud, id_conductor, id_vehiculo } = req.body;
    
    // 1. Verificar que la solicitud existe y está pendiente
    const solicitudRes = await db.query(
      `SELECT * FROM solicitudes_viaje WHERE id_solicitud = $1 AND estado = 'pendiente'`,
      [id_solicitud]
    );
    
    if (solicitudRes.rows.length === 0) {
      return res.status(400).json({ error: "La solicitud ya no está disponible" });
    }
    
    const solicitud = solicitudRes.rows[0];
    
    // 2. Crear el viaje activo
    const viajeRes = await db.query(
      `INSERT INTO viajes 
       (id_conductor, id_vehiculo, origen_viaje, destino_viaje, fecha_hora_salida, precio_asiento, estado_viaje, tipo_viaje)
       VALUES ($1, $2, $3, $4, NOW(), 0, 'programado', 'inmediato')
       RETURNING *`,
      [id_conductor, id_vehiculo, solicitud.origen, solicitud.destino]
    );
    
    const nuevoViaje = viajeRes.rows[0];
    
    // 3. Añadir al pasajero al viaje
    await db.query(
      `INSERT INTO pasajeros_viaje (id_viaje, id_pasajero, estado_reserva)
       VALUES ($1, $2, 'confirmada')`,
      [nuevoViaje.id_viaje, solicitud.id_pasajero]
    );
    
    // 4. Actualizar la solicitud a aceptada
    await db.query(
      `UPDATE solicitudes_viaje SET estado = 'aceptado' WHERE id_solicitud = $1`,
      [id_solicitud]
    );
    
    // 5. Emitir eventos socket
    io.emit("trip_request_accepted", { id_solicitud, viaje: nuevoViaje });
    io.emit("trip_created", nuevoViaje);
    
    res.json({ message: "Solicitud aceptada exitosamente", viaje: nuevoViaje });
  } catch (error) {
    console.error("Error al aceptar solicitud de viaje:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});


// 12. Obtener viajes del conductor
app.get("/api/trips/driver/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await db.query(
      `SELECT v.*, ve.marca, ve.modelo, ve.placa, ve.color,
        (SELECT COUNT(*) FROM pasajeros_viaje pv WHERE pv.id_viaje = v.id_viaje AND pv.estado_reserva = 'confirmada') as pasajeros_confirmados
       FROM viajes v
       LEFT JOIN vehiculos ve ON v.id_vehiculo = ve.id_vehiculo
       WHERE v.id_conductor = $1
       ORDER BY v.fecha_hora_salida DESC`,
      [userId],
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener viajes del conductor" });
  }
});

// 13. Obtener viajes disponibles (Pasajeros)
app.get("/api/trips/available", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT v.*, u.nombre_completo as nombre_conductor, ve.marca, ve.modelo, ve.placa, ve.color, ve.tipo_vehiculo,
       (
         SELECT COALESCE(json_agg(asientos), '[]'::json)
         FROM (
           SELECT jsonb_array_elements_text(pv.asientos_seleccionados)::int AS asientos
           FROM pasajeros_viaje pv
           WHERE pv.id_viaje = v.id_viaje AND pv.estado_reserva = 'confirmada'
         ) as sub
       ) as ocupados
       FROM viajes v
       JOIN usuarios u ON v.id_conductor = u.id_usuario
       LEFT JOIN vehiculos ve ON v.id_vehiculo = ve.id_vehiculo
       WHERE v.estado_viaje = 'programado' AND v.asientos_disponibles > 0
       ORDER BY v.fecha_hora_salida ASC`,
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener viajes disponibles" });
  }
});

// 14. Actualizar estado de viaje
app.put("/api/trips/:tripId/status", async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { tripId } = req.params;
    const { estado_viaje } = req.body;

    await client.query("BEGIN");

    const result = await client.query(
      "UPDATE viajes SET estado_viaje = $1 WHERE id_viaje = $2 RETURNING *",
      [estado_viaje, tripId],
    );

    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Viaje no encontrado" });
    }

    if (estado_viaje === "completado") {
      await client.query(
        `UPDATE transacciones_billetera
         SET estado_transaccion = 'completada'
         WHERE id_viaje_relacionado = $1
           AND tipo_transaccion = 'cobro_viaje'
           AND estado_transaccion = 'pendiente'`,
        [tripId],
      );
    }

    await client.query("COMMIT");
    io.emit("trip_status_changed", { tripId, status: estado_viaje, trip: result.rows[0] });
    res.json({ message: "Estado de viaje actualizado", trip: result.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(error);
    res.status(500).json({ error: "Error al actualizar viaje" });
  } finally {
    client.release();
  }
});

// 15. Reservar asiento (Pasajero)
app.post("/api/trips/:tripId/book", async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { tripId } = req.params;
    const { id_pasajero, asientos_reservados, asientos_seleccionados, metodo_pago } = req.body;
    
    let selectedSeatsArr = asientos_seleccionados || [];
    if (!Array.isArray(selectedSeatsArr)) selectedSeatsArr = [];
    
    const seats = Number(selectedSeatsArr.length > 0 ? selectedSeatsArr.length : (asientos_reservados || 1));
    const paymentMethod = metodo_pago || "billetera";

    if (!id_pasajero || !Number.isInteger(seats) || seats <= 0) {
      return res
        .status(400)
        .json({
          error: "id_pasajero y asientos_reservados validos son obligatorios",
        });
    }
    if (paymentMethod !== "billetera") {
      return res.status(400).json({ error: "Metodo de pago no soportado" });
    }

    await client.query("BEGIN");

    const trip = await client.query(
      `SELECT id_viaje, id_conductor, asientos_disponibles, precio_por_asiento
       FROM viajes
       WHERE id_viaje = $1
       FOR UPDATE`,
      [tripId],
    );
    if (trip.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Viaje no encontrado" });
    }
    if (trip.rows[0].asientos_disponibles < seats) {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ error: "No hay suficientes asientos disponibles" });
    }

    if (selectedSeatsArr.length > 0) {
      const occupiedQuery = await client.query(
        `SELECT jsonb_array_elements_text(asientos_seleccionados)::int AS asiento
         FROM pasajeros_viaje
         WHERE id_viaje = $1 AND estado_reserva = 'confirmada'`,
        [tripId]
      );
      const occupiedSeats = occupiedQuery.rows.map(r => Number(r.asiento));
      const hasConflict = selectedSeatsArr.some(s => occupiedSeats.includes(Number(s)));
      if (hasConflict) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Uno o más de los asientos seleccionados ya fueron reservados por otra persona." });
      }
    }

    const alreadyBooked = await client.query(
      `SELECT 1 FROM pasajeros_viaje
       WHERE id_viaje = $1
         AND id_pasajero = $2
         AND estado_reserva IN ('pendiente', 'confirmada')
       LIMIT 1`,
      [tripId, id_pasajero],
    );
    if (alreadyBooked.rows.length > 0) {
      await client.query("ROLLBACK");
      return res
        .status(409)
        .json({ error: "Ya tienes una reserva activa en este viaje" });
    }

    const totalAmount = roundMoney(
      Number(trip.rows[0].precio_por_asiento) * seats,
    );
    const commissionRate = getPlatformCommissionRate();
    const commissionAmount = roundMoney(totalAmount * commissionRate);
    const driverNetAmount = roundMoney(totalAmount - commissionAmount);
    const balance = await client.query(
      `SELECT COALESCE(SUM(CASE
          WHEN estado_transaccion = 'completada'
           AND tipo_transaccion IN ('recarga', 'cobro_viaje') THEN monto
          WHEN estado_transaccion = 'completada'
           AND tipo_transaccion IN ('pago_viaje', 'retiro', 'comision_plataforma') THEN -monto
          ELSE 0
        END), 0) AS saldo_disponible
       FROM transacciones_billetera
       WHERE id_usuario = $1`,
      [id_pasajero],
    );

    const availableBalance = Number(balance.rows[0].saldo_disponible);
    if (availableBalance < totalAmount) {
      await client.query("ROLLBACK");
      return res.status(402).json({
        error: "Saldo insuficiente",
        code: "SALDO_INSUFICIENTE",
        saldo_disponible: availableBalance,
        total: totalAmount,
      });
    }

    const booking = await client.query(
      `INSERT INTO pasajeros_viaje
        (id_viaje, id_pasajero, asientos_reservados, asientos_seleccionados, estado_reserva, monto_pagado, estado_pago, metodo_pago)
       VALUES ($1, $2, $3, $4, 'confirmada', $5, 'pagado', $6)
       RETURNING *`,
      [tripId, id_pasajero, seats, JSON.stringify(selectedSeatsArr), totalAmount, paymentMethod],
    );

    await client.query(
      "UPDATE viajes SET asientos_disponibles = asientos_disponibles - $1 WHERE id_viaje = $2",
      [seats, tripId],
    );

    await client.query(
      `INSERT INTO transacciones_billetera
        (id_usuario, tipo_transaccion, monto, id_viaje_relacionado, estado_transaccion, metadata)
       VALUES ($1, 'pago_viaje', $2, $3, 'completada', $4::jsonb)`,
      [
        id_pasajero,
        totalAmount,
        tripId,
        JSON.stringify({
          commission_rate: commissionRate,
          commission_amount: commissionAmount,
          driver_net_amount: driverNetAmount,
        }),
      ],
    );

    await client.query(
      `INSERT INTO transacciones_billetera
        (id_usuario, tipo_transaccion, monto, id_viaje_relacionado, estado_transaccion, metadata)
       VALUES ($1, 'cobro_viaje', $2, $3, 'pendiente', $4::jsonb)`,
      [
        trip.rows[0].id_conductor,
        driverNetAmount,
        tripId,
        JSON.stringify({
          gross_amount: totalAmount,
          commission_rate: commissionRate,
          commission_amount: commissionAmount,
        }),
      ],
    );

    await client.query(
      `INSERT INTO transacciones_billetera
        (id_usuario, tipo_transaccion, monto, id_viaje_relacionado, estado_transaccion, metadata)
       VALUES ($1, 'comision_plataforma', $2, $3, 'completada', $4::jsonb)`,
      [
        trip.rows[0].id_conductor,
        commissionAmount,
        tripId,
        JSON.stringify({
          gross_amount: totalAmount,
          commission_rate: commissionRate,
          driver_net_amount: driverNetAmount,
          owner: "rumbo",
        }),
      ],
    );

    await client.query("COMMIT");
    io.emit("trip_booked", { tripId, passengerId: id_pasajero, seats });
    res.status(201).json({
      ...booking.rows[0],
      total_pagado: totalAmount,
      comision_rumbo: commissionAmount,
      monto_conductor: driverNetAmount,
      saldo_restante: availableBalance - totalAmount,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(error);
    res.status(500).json({ error: "Error al reservar asiento" });
  } finally {
    client.release();
  }
});

// 16. Obtener pasajeros de un viaje
app.get("/api/trips/:tripId/passengers", async (req, res) => {
  try {
    const { tripId } = req.params;
    const result = await db.query(
      `SELECT pv.*, u.nombre_completo, u.correo_electronico, u.numero_telefono
       FROM pasajeros_viaje pv
       JOIN usuarios u ON pv.id_pasajero = u.id_usuario
       WHERE pv.id_viaje = $1
       ORDER BY pv.fecha_reserva DESC`,
      [tripId],
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener pasajeros" });
  }
});

// 17. Ganancias del conductor (Transacciones)
app.get("/api/earnings/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    // Total ganado de viajes completados
    const earnings = await db.query(
      `SELECT 
        COALESCE(SUM(v.precio_por_asiento * (v.asientos_totales - v.asientos_disponibles)), 0) as total_ganado,
        COUNT(*) FILTER (WHERE v.estado_viaje = 'completado') as viajes_completados,
        COUNT(*) FILTER (WHERE v.estado_viaje = 'programado') as viajes_programados,
        COUNT(*) FILTER (WHERE v.estado_viaje = 'en_curso') as viajes_en_curso,
        COUNT(*) FILTER (WHERE v.estado_viaje = 'cancelado') as viajes_cancelados,
        COUNT(*) as total_viajes
       FROM viajes v
       WHERE v.id_conductor = $1`,
      [userId],
    );

    // Transacciones recientes
    const transactions = await db.query(
      `SELECT tb.*, v.origen_viaje, v.destino_viaje
       FROM transacciones_billetera tb
       LEFT JOIN viajes v ON tb.id_viaje_relacionado = v.id_viaje
       WHERE tb.id_usuario = $1
       ORDER BY tb.fecha_transaccion DESC
       LIMIT 20`,
      [userId],
    );

    // Ganancias por mes (últimos 6 meses)
    const monthly = await db.query(
      `SELECT 
        TO_CHAR(v.fecha_hora_salida, 'YYYY-MM') as mes,
        COALESCE(SUM(v.precio_por_asiento * (v.asientos_totales - v.asientos_disponibles)), 0) as ganancia
       FROM viajes v
       WHERE v.id_conductor = $1 AND v.estado_viaje = 'completado'
         AND v.fecha_hora_salida >= NOW() - INTERVAL '6 months'
       GROUP BY TO_CHAR(v.fecha_hora_salida, 'YYYY-MM')
       ORDER BY mes DESC`,
      [userId],
    );

    res.json({
      resumen: earnings.rows[0],
      transacciones: transactions.rows,
      ganancias_mensuales: monthly.rows,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener ganancias" });
  }
});

// 19. Registrar transacción de billetera
app.post("/api/transactions", async (req, res) => {
  try {
    const { id_usuario, tipo_transaccion, monto, id_viaje_relacionado } =
      req.body;
    const result = await db.query(
      `INSERT INTO transacciones_billetera (id_usuario, tipo_transaccion, monto, id_viaje_relacionado) 
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [id_usuario, tipo_transaccion, monto, id_viaje_relacionado || null],
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al registrar transacción" });
  }
});

// 19. Historial de viajes del conductor (con detalles)
app.get("/api/trips/history/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { role } = req.query; // 'conductor' o 'pasajero'

    let result;
    if (role === "pasajero") {
      result = await db.query(
        `SELECT v.*, u.nombre_completo as nombre_conductor, ve.marca, ve.modelo, ve.placa,
          pv.asientos_reservados, pv.estado_reserva, pv.fecha_reserva
         FROM pasajeros_viaje pv
         JOIN viajes v ON pv.id_viaje = v.id_viaje
         JOIN usuarios u ON v.id_conductor = u.id_usuario
         LEFT JOIN vehiculos ve ON v.id_vehiculo = ve.id_vehiculo
         WHERE pv.id_pasajero = $1
         ORDER BY v.fecha_hora_salida DESC`,
        [userId],
      );
    } else {
      result = await db.query(
        `SELECT v.*, ve.marca, ve.modelo, ve.placa, ve.color,
          (SELECT COUNT(*) FROM pasajeros_viaje pv WHERE pv.id_viaje = v.id_viaje AND pv.estado_reserva = 'confirmada') as pasajeros_confirmados,
          (SELECT COALESCE(SUM(pv.asientos_reservados), 0) FROM pasajeros_viaje pv WHERE pv.id_viaje = v.id_viaje AND pv.estado_reserva = 'confirmada') as asientos_vendidos
         FROM viajes v
         LEFT JOIN vehiculos ve ON v.id_vehiculo = ve.id_vehiculo
         WHERE v.id_conductor = $1
         ORDER BY v.fecha_hora_salida DESC`,
        [userId],
      );
    }

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener historial" });
  }
});

// 20. Estadísticas del conductor (Dashboard)
app.get("/api/driver/stats/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    // Estadísticas generales
    const stats = await db.query(
      `SELECT 
        COUNT(*) FILTER (WHERE estado_viaje = 'completado') as viajes_completados,
        COUNT(*) FILTER (WHERE estado_viaje = 'programado') as viajes_programados,
        COUNT(*) FILTER (WHERE estado_viaje = 'en_curso') as viajes_activos,
        COALESCE(SUM(CASE WHEN estado_viaje = 'completado' THEN precio_por_asiento * (asientos_totales - asientos_disponibles) ELSE 0 END), 0) as ganancias_totales,
        COALESCE(AVG(CASE WHEN estado_viaje = 'completado' THEN precio_por_asiento ELSE NULL END), 0) as precio_promedio
       FROM viajes WHERE id_conductor = $1`,
      [userId],
    );

    // Calificación promedio
    const rating = await db.query(
      `SELECT COALESCE(AVG(puntuacion), 0) as calificacion_promedio, COUNT(*) as total_calificaciones
       FROM calificaciones WHERE id_evaluado = $1`,
      [userId],
    );

    // Viaje próximo
    const nextTrip = await db.query(
      `SELECT v.*, ve.marca, ve.modelo, ve.placa
       FROM viajes v
       LEFT JOIN vehiculos ve ON v.id_vehiculo = ve.id_vehiculo
       WHERE v.id_conductor = $1 AND v.estado_viaje IN ('programado', 'en_curso')
       ORDER BY v.fecha_hora_salida ASC LIMIT 1`,
      [userId],
    );

    res.json({
      estadisticas: stats.rows[0],
      calificacion: rating.rows[0],
      proximo_viaje: nextTrip.rows.length > 0 ? nextTrip.rows[0] : null,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener estadísticas" });
  }
});

// 21. Eliminar viaje
app.delete("/api/trips/:tripId", async (req, res) => {
  try {
    const { tripId } = req.params;
    const result = await db.query(
      "DELETE FROM viajes WHERE id_viaje = $1 RETURNING id_viaje",
      [tripId],
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Viaje no encontrado" });
    res.json({ message: "Viaje eliminado correctamente" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al eliminar viaje" });
  }
});

// 22. Calificar viaje
app.post("/api/ratings", async (req, res) => {
  try {
    const { id_viaje, id_evaluador, id_evaluado, puntuacion, comentario } =
      req.body;
    const result = await db.query(
      `INSERT INTO calificaciones (id_viaje, id_evaluador, id_evaluado, puntuacion, comentario) 
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id_viaje, id_evaluador, id_evaluado, puntuacion, comentario],
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al calificar" });
  }
});

// 23. Admin Dashboard Stats
app.get("/api/admin/stats", async (req, res) => {
  try {
    const users = await db.query(
      `SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE rol_usuario='conductor') as conductores, COUNT(*) FILTER (WHERE rol_usuario='pasajero') as pasajeros, COUNT(*) FILTER (WHERE estado_cuenta='pendiente') as pendientes FROM usuarios`,
    );
    const trips = await db.query(
      `SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE estado_viaje='completado') as completados, COUNT(*) FILTER (WHERE estado_viaje='programado') as programados, COUNT(*) FILTER (WHERE estado_viaje='en_curso') as en_curso, COALESCE(SUM(CASE WHEN estado_viaje='completado' THEN precio_por_asiento*(asientos_totales-asientos_disponibles) ELSE 0 END),0) as ingresos_totales FROM viajes`,
    );
    const alerts = await db.query(
      `SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE estado_alerta='activa') as activas FROM alertas_sos`,
    );
    const incidents = await db.query(
      `SELECT COUNT(*) as total FROM incidencias_viales`,
    );
    res.json({
      usuarios: users.rows[0],
      viajes: trips.rows[0],
      alertas: alerts.rows[0],
      incidencias: incidents.rows[0],
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener estadísticas" });
  }
});

// 24. Obtener alertas Centinela
app.get("/api/alerts", async (req, res) => {
  try {
    const status =
      typeof req.query.status === "string" ? req.query.status : null;
    const allowedStatus = [
      "activa",
      "en_revision",
      "resuelta",
      "falsa_alarma",
      "cerrada",
    ];
    const where = allowedStatus.includes(status)
      ? "WHERE a.estado_alerta = $1"
      : "";
    const params = where ? [status] : [];
    const result = await db.query(
      `${alertSelectSql}
       ${where}
       ORDER BY a.fecha_alerta DESC
       LIMIT 100`,
      params,
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener alertas" });
  }
});

app.get("/api/support/emergencies", async (req, res) => {
  try {
    const result = await db.query(
      `${alertSelectSql}
       WHERE a.estado_alerta IN ('activa', 'en_revision')
       ORDER BY
         CASE WHEN a.estado_alerta = 'activa' THEN 0 ELSE 1 END,
         a.fecha_alerta DESC
       LIMIT 50`,
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener emergencias de soporte" });
  }
});

app.get("/api/support/vehicles/search", async (req, res) => {
  try {
    const plate =
      typeof req.query.placa === "string"
        ? req.query.placa.trim().replace(/\s+/g, "").toUpperCase()
        : "";
    if (plate.length < 3) {
      return res
        .status(400)
        .json({ error: "Ingresa al menos 3 caracteres de la placa" });
    }

    const result = await db.query(
      `WITH vehicle_match AS (
         SELECT ve.*, u.id_usuario AS conductor_id, u.nombre_completo AS conductor_nombre,
                u.correo_electronico AS conductor_correo, u.numero_telefono AS conductor_telefono
         FROM vehiculos ve
         JOIN usuarios u ON u.id_usuario = ve.id_propietario
         WHERE REPLACE(UPPER(ve.placa), '-', '') LIKE '%' || REPLACE($1, '-', '') || '%'
         ORDER BY ve.fecha_registro DESC
         LIMIT 1
       ),
       active_trip AS (
         SELECT v.*
         FROM viajes v
         JOIN vehicle_match vm ON vm.id_vehiculo = v.id_vehiculo
         WHERE v.estado_viaje IN ('en_curso', 'programado')
         ORDER BY CASE WHEN v.estado_viaje = 'en_curso' THEN 0 ELSE 1 END,
                  ABS(EXTRACT(EPOCH FROM (v.fecha_hora_salida - NOW())))
         LIMIT 1
       ),
       latest_tracking AS (
         SELECT ct.*
         FROM centinela_tracking ct
         JOIN vehicle_match vm ON vm.conductor_id = ct.id_usuario
         WHERE NOT EXISTS (SELECT 1 FROM active_trip)
            OR ct.id_viaje IS NULL
            OR ct.id_viaje = (SELECT id_viaje FROM active_trip)
         ORDER BY ct.fecha_tracking DESC
         LIMIT 1
       ),
       passengers AS (
         SELECT COALESCE(json_agg(
           json_build_object(
             'id_pasajero', p.id_usuario,
             'nombre', p.nombre_completo,
             'correo', p.correo_electronico,
             'telefono', p.numero_telefono,
             'asientos', pv.asientos_reservados,
             'estado_reserva', pv.estado_reserva
           )
           ORDER BY p.nombre_completo
         ), '[]'::json) AS pasajeros
         FROM pasajeros_viaje pv
         JOIN usuarios p ON p.id_usuario = pv.id_pasajero
         WHERE pv.id_viaje = (SELECT id_viaje FROM active_trip)
           AND pv.estado_reserva = 'confirmada'
       )
       SELECT
         vm.id_vehiculo, vm.placa, vm.marca, vm.modelo, vm.color,
         vm.conductor_id, vm.conductor_nombre, vm.conductor_correo, vm.conductor_telefono,
         at.id_viaje, at.origen_viaje, at.destino_viaje,
         at.origen_latitud, at.origen_longitud, at.destino_latitud, at.destino_longitud,
         at.fecha_hora_salida, at.estado_viaje,
         lt.latitud AS tracking_latitud, lt.longitud AS tracking_longitud,
         lt.precision_metros AS tracking_precision_metros, lt.fecha_tracking AS tracking_fecha,
         COALESCE(p.pasajeros, '[]'::json) AS pasajeros
       FROM vehicle_match vm
       LEFT JOIN active_trip at ON true
       LEFT JOIN latest_tracking lt ON true
       LEFT JOIN passengers p ON true`,
      [plate],
    );

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "No se encontro vehiculo con esa placa" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al buscar ubicacion por placa" });
  }
});

// 24.1 Resolver alerta Centinela
app.put("/api/alerts/:id/resolve", async (req, res) => {
  try {
    const { id } = req.params;
    const { atendida_por } = req.body || {};
    const result = await db.query(
      `UPDATE alertas_sos
       SET estado_alerta = 'resuelta',
           atendida_por = COALESCE($2, atendida_por),
           fecha_atencion = CURRENT_TIMESTAMP
       WHERE id_alerta = $1
       RETURNING *`,
      [id, atendida_por || null],
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Alerta no encontrada" });
    const enriched = await getAlertById(id);
    io.emit("centinela_alert_updated", enriched || result.rows[0]);
    res.json(enriched || result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al resolver alerta" });
  }
});

// 24b. Crear alerta Centinela
app.post("/api/alerts", async (req, res) => {
  try {
    const {
      id_usuario,
      latitud,
      longitud,
      id_viaje,
      tipo_activacion,
      descripcion_alerta,
      transcript,
      audio_nombre,
      audio_base64,
    } = req.body;

    const safeUserId = normalizeUuid(id_usuario);
    const safeTripId =
      normalizeUuid(id_viaje) || (await findActiveTripForEmergency(safeUserId));
    const safeLatitude = normalizeCoordinate(latitud, -90, 90);
    const safeLongitude = normalizeCoordinate(longitud, -180, 180);
    const safeDescription =
      typeof descripcion_alerta === "string" && descripcion_alerta.trim()
        ? descripcion_alerta.trim()
        : "Emergencia Centinela activada";
    const safeActivation = ["manual", "voz", "automatico"].includes(
      tipo_activacion,
    )
      ? tipo_activacion
      : "manual";
    const audioUrl = saveCentinelaAudio({ audio_nombre, audio_base64 });

    const result = await db.query(
      `INSERT INTO alertas_sos
        (id_usuario, id_viaje, latitud, longitud, estado_alerta, tipo_activacion, descripcion_alerta, transcript, audio_url, audio_nombre) 
       VALUES ($1, $2, $3, $4, 'activa', $5, $6, $7, $8, $9) RETURNING *`,
      [
        safeUserId,
        safeTripId,
        safeLatitude,
        safeLongitude,
        safeActivation,
        safeDescription,
        typeof transcript === "string"
          ? transcript.trim().slice(0, 3000)
          : null,
        audioUrl,
        audioUrl ? audio_nombre || "grabacion_centinela" : null,
      ],
    );

    if (safeUserId && safeLatitude != null && safeLongitude != null) {
      await db.query(
        `INSERT INTO centinela_tracking
          (id_usuario, id_viaje, latitud, longitud, precision_metros, evento)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          safeUserId,
          safeTripId,
          safeLatitude,
          safeLongitude,
          null,
          "emergencia",
        ],
      );
    }

    const enriched = await getAlertById(result.rows[0].id_alerta);
    let supportTicket = null;
    try {
      supportTicket = await createCentinelaSupportTicket(enriched);
    } catch (ticketError) {
      console.error(
        "Error creando ticket de emergencia Centinela:",
        ticketError,
      );
    }

    const payload = {
      ...(enriched || result.rows[0]),
      support_ticket_id: supportTicket?.id_ticket || null,
    };
    io.emit("centinela_alert", payload);
    io.emit("support_emergency", payload);

    // Enviar correo a Valery o al administrador
    try {
      const emailDest = process.env.SUPPORT_EMAIL || "Valery@hotmail.com";
      const subject = `🚨 EMERGENCIA CENTINELA ACTIVADA: ${safeDescription}`;
      const htmlContent = `
        <h2>Alerta de Emergencia Centinela</h2>
        <p><strong>Usuario ID:</strong> ${safeUserId}</p>
        <p><strong>Tipo:</strong> ${safeActivation}</p>
        <p><strong>Descripción:</strong> ${safeDescription}</p>
        <p><strong>Ubicación:</strong> <a href="https://www.google.com/maps/search/?api=1&query=${safeLatitude},${safeLongitude}">Ver en el mapa</a></p>
        <p><strong>Transcripción:</strong> ${transcript || 'No disponible'}</p>
        <p>Por favor revisa el panel de soporte para más detalles.</p>
      `;
      await sendEmail(emailDest, subject, htmlContent);
    } catch (emailErr) {
      console.error("Error al enviar email de centinela a Valery:", emailErr);
    }

    res.status(201).json(payload);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al crear alerta Centinela" });
  }
});

// 25. Actualizar estado de alerta
app.put("/api/alerts/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { estado_alerta } = req.body;
    const allowed = [
      "activa",
      "en_revision",
      "resuelta",
      "falsa_alarma",
      "cerrada",
    ];
    if (!allowed.includes(estado_alerta)) {
      return res.status(400).json({ error: "Estado de alerta invalido" });
    }
    const result = await db.query(
      `UPDATE alertas_sos
       SET estado_alerta=$1,
           fecha_atencion = CASE WHEN $1 IN ('resuelta', 'falsa_alarma', 'cerrada') THEN CURRENT_TIMESTAMP ELSE fecha_atencion END
       WHERE id_alerta=$2
       RETURNING *`,
      [estado_alerta, id],
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Alerta no encontrada" });
    const enriched = await getAlertById(id);
    io.emit("centinela_alert_updated", enriched || result.rows[0]);
    res.json(enriched || result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error" });
  }
});

// 25b. Registrar ubicacion/tracking de Centinela
app.post("/api/centinela/tracking", async (req, res) => {
  try {
    const {
      id_usuario,
      id_viaje,
      latitud,
      longitud,
      precision_metros,
      evento,
    } = req.body;
    if (!id_usuario || latitud == null || longitud == null) {
      return res
        .status(400)
        .json({ error: "id_usuario, latitud y longitud son obligatorios" });
    }

    const result = await db.query(
      `INSERT INTO centinela_tracking
        (id_usuario, id_viaje, latitud, longitud, precision_metros, evento)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        id_usuario,
        id_viaje || null,
        latitud,
        longitud,
        precision_metros || null,
        evento || "ubicacion",
      ],
    );
    io.emit("centinela_tracking", result.rows[0]);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al registrar tracking Centinela" });
  }
});

// 26. Obtener incidencias viales
app.get("/api/incidents", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT i.*, u.nombre_completo FROM incidencias_viales i LEFT JOIN usuarios u ON i.id_reportante=u.id_usuario ORDER BY i.fecha_reporte DESC LIMIT 50`,
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error" });
  }
});

// 26b. Crear incidencia
app.post("/api/incidents", async (req, res) => {
  const {
    id_reportante,
    tipo_incidencia,
    descripcion_incidencia,
    latitud,
    longitud,
  } = req.body;
  try {
    const result = await db.query(
      `INSERT INTO incidencias_viales (id_reportante, tipo_incidencia, descripcion_incidencia, latitud, longitud) 
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [
        id_reportante,
        tipo_incidencia,
        descripcion_incidencia,
        latitud,
        longitud,
      ],
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al registrar incidencia" });
  }
});

// 26c. Eliminar incidencia
app.delete("/api/incidents/:id", async (req, res) => {
  try {
    await db.query("DELETE FROM incidencias_viales WHERE id_incidencia = $1", [
      req.params.id,
    ]);
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al eliminar incidencia" });
  }
});

// 27. Admin: todos los viajes
app.get("/api/admin/trips", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT v.*, u.nombre_completo as nombre_conductor, ve.marca, ve.modelo, ve.placa FROM viajes v JOIN usuarios u ON v.id_conductor=u.id_usuario LEFT JOIN vehiculos ve ON v.id_vehiculo=ve.id_vehiculo ORDER BY v.fecha_creacion DESC LIMIT 100`,
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error" });
  }
});

// 28. Crear ticket de soporte
app.post("/api/tickets", async (req, res) => {
  try {
    const {
      id_usuario,
      categoria,
      asunto_ticket,
      descripcion_problema,
      evidencia_nombre,
      evidencia_base64,
    } = req.body;

    if (!id_usuario || !asunto_ticket || !descripcion_problema) {
      return res.status(400).json({
        error:
          "id_usuario, asunto_ticket y descripcion_problema son obligatorios",
      });
    }

    const evidenceUrl = saveSupportEvidence({
      evidencia_nombre,
      evidencia_base64,
    });

    const result = await db.query(
      `INSERT INTO tickets_soporte
        (id_usuario, categoria, asunto_ticket, descripcion_problema, estado_ticket, evidencia_url, evidencia_nombre)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6)
       RETURNING *`,
      [
        id_usuario,
        categoria || "Soporte General",
        asunto_ticket.trim(),
        descripcion_problema.trim(),
        evidenceUrl,
        evidencia_nombre || null,
      ],
    );

    const newTicket = result.rows[0];
    io.emit("new_support_ticket", newTicket);

    res.status(201).json(newTicket);
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Error al crear ticket",
    });
  }
});

// 28b. Obtener tickets de un usuario
app.get("/api/tickets/user/:userId", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT *
       FROM tickets_soporte
       WHERE id_usuario = $1
       ORDER BY fecha_creacion DESC`,
      [req.params.userId],
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener tickets del usuario" });
  }
});

// 28c. Obtener tickets de soporte
app.get("/api/tickets", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT t.*, u.nombre_completo, u.correo_electronico 
      FROM tickets_soporte t 
      JOIN usuarios u ON t.id_usuario = u.id_usuario 
      ORDER BY t.fecha_creacion DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener tickets" });
  }
});

// 29. Actualizar estado de ticket
app.put("/api/tickets/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const status = req.body.status || req.body.estado || req.body.estado_ticket;
    if (!["pending", "in_review", "resolved", "rejected"].includes(status)) {
      return res.status(400).json({ error: "Estado de ticket invalido" });
    }

    const result = await db.query(
      "UPDATE tickets_soporte SET estado_ticket = $1 WHERE id_ticket = $2 RETURNING *",
      [status, id],
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Ticket no encontrado" });
    res.json({ message: "Ticket actualizado", ticket: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al actualizar ticket" });
  }
});

function saveWalletReceipt({ comprobante_nombre, comprobante_base64 }) {
  if (!comprobante_base64) return null;

  const rawName = String(comprobante_nombre || "comprobante.jpg");
  const ext = path.extname(rawName).toLowerCase() || ".jpg";
  const allowed = new Set([".jpg", ".jpeg", ".png", ".webp", ".pdf"]);
  if (!allowed.has(ext)) {
    const error = new Error("Formato de comprobante no permitido");
    error.statusCode = 400;
    throw error;
  }

  const payload = comprobante_base64.includes(",")
    ? comprobante_base64.split(",").pop()
    : comprobante_base64;
  const buffer = Buffer.from(payload, "base64");
  if (!buffer.length || buffer.length > 5 * 1024 * 1024) {
    const error = new Error("El comprobante debe pesar maximo 5MB");
    error.statusCode = 400;
    throw error;
  }

  const receiptsDir = path.resolve(__dirname, "uploads", "wallet-receipts");
  fs.mkdirSync(receiptsDir, { recursive: true });
  const safeExt = ext.replace(/[^a-z0-9.]/g, "");
  const fileName = `${crypto.randomUUID()}${safeExt}`;
  const targetPath = path.resolve(receiptsDir, fileName);
  if (!targetPath.startsWith(receiptsDir)) {
    throw new Error("Ruta de archivo no válida");
  }
  fs.writeFileSync(targetPath, buffer);
  return `/uploads/wallet-receipts/${fileName}`;
}

function saveSupportEvidence({ evidencia_nombre, evidencia_base64 }) {
  if (!evidencia_base64) return null;

  const rawName = String(evidencia_nombre || "evidencia.jpg");
  const ext = path.extname(rawName).toLowerCase() || ".jpg";
  const allowed = new Set([".jpg", ".jpeg", ".png", ".webp", ".pdf", ".mp4"]);
  if (!allowed.has(ext)) {
    const error = new Error("Formato de evidencia no permitido");
    error.statusCode = 400;
    throw error;
  }

  const payload = evidencia_base64.includes(",")
    ? evidencia_base64.split(",").pop()
    : evidencia_base64;
  const buffer = Buffer.from(payload, "base64");
  if (!buffer.length || buffer.length > 10 * 1024 * 1024) {
    const error = new Error("La evidencia debe pesar maximo 10MB");
    error.statusCode = 400;
    throw error;
  }

  const evidenceDir = path.resolve(__dirname, "uploads", "support-evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const safeExt = ext.replace(/[^a-z0-9.]/g, "");
  const fileName = `${crypto.randomUUID()}${safeExt}`;
  const targetPath = path.resolve(evidenceDir, fileName);
  if (!targetPath.startsWith(evidenceDir)) {
    throw new Error("Ruta de archivo no válida");
  }
  fs.writeFileSync(targetPath, buffer);
  return `/uploads/support-evidence/${fileName}`;
}

// 30. Solicitar recarga de billetera (Conductor)
app.post("/api/wallet/recharge", async (req, res) => {
  try {
    const { id_usuario, monto, comprobante_nombre, comprobante_base64 } =
      req.body;
    const numericAmount = Number(monto);
    if (!id_usuario || !Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res
        .status(400)
        .json({ error: "id_usuario y monto valido son obligatorios" });
    }
    const comprobanteUrl = saveWalletReceipt({
      comprobante_nombre,
      comprobante_base64,
    });

    const result = await db.query(
      `INSERT INTO transacciones_billetera
         (id_usuario, tipo_transaccion, monto, estado_transaccion, comprobante_url, comprobante_nombre)
       VALUES ($1, 'recarga', $2, 'pendiente', $3, $4) RETURNING *`,
      [id_usuario, numericAmount, comprobanteUrl, comprobante_nombre || null],
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res
      .status(error.statusCode || 500)
      .json({ error: error.message || "Error al solicitar recarga" });
  }
});

app.get("/api/wallet/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const transactions = await db.query(
      `SELECT tb.*, v.origen_viaje, v.destino_viaje
       FROM transacciones_billetera tb
       LEFT JOIN viajes v ON tb.id_viaje_relacionado = v.id_viaje
       WHERE tb.id_usuario = $1
       ORDER BY tb.fecha_transaccion DESC
       LIMIT 50`,
      [userId],
    );

    const summary = await db.query(
      `SELECT
         COALESCE(SUM(CASE
           WHEN estado_transaccion = 'completada'
            AND tipo_transaccion IN ('recarga', 'cobro_viaje') THEN monto
           WHEN estado_transaccion = 'completada'
            AND tipo_transaccion IN ('pago_viaje', 'retiro', 'comision_plataforma') THEN -monto
           ELSE 0
         END), 0) AS saldo_disponible,
         COALESCE(SUM(CASE
           WHEN estado_transaccion = 'pendiente'
            AND tipo_transaccion IN ('recarga', 'cobro_viaje') THEN monto
           ELSE 0
         END), 0) AS saldo_pendiente
       FROM transacciones_billetera
       WHERE id_usuario = $1`,
      [userId],
    );

    res.json({ resumen: summary.rows[0], transacciones: transactions.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener billetera" });
  }
});

app.get("/api/admin/wallet/recharges", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT tb.*, u.nombre_completo, u.correo_electronico
      FROM transacciones_billetera tb
      JOIN usuarios u ON tb.id_usuario = u.id_usuario
      WHERE tb.tipo_transaccion = 'recarga'
        AND tb.estado_transaccion = 'pendiente'
      ORDER BY tb.fecha_transaccion ASC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener recargas pendientes" });
  }
});

app.put("/api/admin/wallet/recharges/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { estado_transaccion } = req.body;
    if (!["completada", "rechazada"].includes(estado_transaccion)) {
      return res.status(400).json({ error: "Estado de recarga invalido" });
    }

    const result = await db.query(
      `UPDATE transacciones_billetera
       SET estado_transaccion = $1
       WHERE id_transaccion = $2
         AND tipo_transaccion = 'recarga'
         AND estado_transaccion = 'pendiente'
       RETURNING *`,
      [estado_transaccion, id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Recarga pendiente no encontrada" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al actualizar recarga" });
  }
});

// 31. Obtener todos los viajes (Alias simple para _fetchStats de Flutter)
app.get("/api/trips", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT v.*, u.nombre_completo AS nombre_conductor, ve.marca, ve.modelo, ve.placa
      FROM viajes v
      LEFT JOIN usuarios u ON v.id_conductor = u.id_usuario
      LEFT JOIN vehiculos ve ON v.id_vehiculo = ve.id_vehiculo
      ORDER BY v.fecha_creacion DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener viajes" });
  }
});

app.get("/api/community/match", async (req, res) => {
  const email = req.query.email || "";
  let domain = "";
  if (email.includes("@")) {
    const parts = email.split("@")[1].split(".");
    if (parts.length > 0) domain = parts[0].toUpperCase();
  }
  if (!domain) domain = "GENERAL";

  try {
    const query = `
      SELECT id_usuario, nombre_completo, correo_electronico, foto_perfil_url, rol_usuario
      FROM usuarios
      WHERE split_part(correo_electronico, '@', 2) ILIKE $1 || '.%'
      LIMIT 100
    `;
    const users = await db.query(query, [domain.toLowerCase()]);
    
    if (domain === "GENERAL" || users.rows.length === 0) {
      const generalUsers = await db.query(`SELECT id_usuario, nombre_completo, foto_perfil_url, rol_usuario FROM usuarios LIMIT 50`);
      return res.json({
        university: "Comunidad General",
        members: generalUsers.rows
      });
    }

    res.json({
      university: `Universidad ${domain}`,
      members: users.rows
    });
  } catch(e) {
    console.error(e);
    res.status(500).json({error: "Server error"});
  }
});

// ==========================================
// OTA - AUTO-ACTUALIZACIÓN
// ==========================================
app.get("/api/config/version", async (req, res) => {
  try {
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

    // Comprobar si está vacía
    const countRes = await db.query('SELECT COUNT(*) FROM app_config');
    if (parseInt(countRes.rows[0].count) === 0) {
      await db.query(`
        INSERT INTO app_config (version_name, version_code, download_url, is_mandatory) 
        VALUES ('1.0.0', 1, 'https://github.com/RumboApp', false);
      `);
    }

    const configRes = await db.query('SELECT * FROM app_config ORDER BY id DESC LIMIT 1');
    res.json(configRes.rows[0]);
  } catch (error) {
    console.error("Error al obtener config:", error);
    res.status(500).json({ error: "Error obteniendo configuración" });
  }
});

// ==========================================
// AUTO-EXPIRACIÓN DE VIAJES Y SOLICITUDES
// ==========================================
setInterval(async () => {
  try {
    // Expirar viajes programados que ya pasaron
    await db.query(`
      UPDATE viajes 
      SET estado_viaje = 'cancelado' 
      WHERE estado_viaje = 'programado' 
        AND fecha_hora_salida < NOW() - INTERVAL '30 minutes'
    `);
    
    // Expirar solicitudes pendientes que ya pasaron
    await db.query(`
      UPDATE solicitudes_viaje 
      SET estado = 'expirado' 
      WHERE estado = 'pendiente' 
        AND fecha_hora_solicitada < NOW() - INTERVAL '30 minutes'
    `);
  } catch (error) {
    console.error("Error al limpiar viajes/solicitudes expirados:", error);
  }
}, 60000); // Revisar cada minuto

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, "0.0.0.0", () => {
    console.log(
      `🚀 Servidor backend de Rumbo corriendo en http://0.0.0.0:${PORT}`,
    );
  });
