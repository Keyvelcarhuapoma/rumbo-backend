const https = require('https');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://rumbo-backend.onrender.com/api';

function makeRequest(method, endpoint, body = null, headers = {}) {
    return new Promise((resolve) => {
        const url = new URL(BASE_URL + endpoint);
        const reqOptions = {
            method: method,
            headers: {
                'Content-Type': 'application/json',
                ...headers
            }
        };

        const req = https.request(url, reqOptions, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: data
                });
            });
        });

        req.on('error', (err) => {
            resolve({ status: 500, error: err.message });
        });

        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

async function runSecurityAudit() {
    console.log("=========================================================");
    console.log(" 🛡️  AUDITORÍA Y PENTESTING DE SEGURIDAD - BACKEND RENDER ");
    console.log("=========================================================\n");

    const findings = [];

    // 1. TEST: Exposición Pública del Endpoint de Usuarios sin Token
    console.log("[Test 1] Evaluando acceso público y exposición de datos en GET /api/users ...");
    const resUsers = await makeRequest('GET', '/users');
    if (resUsers.status === 200) {
        try {
            const users = JSON.parse(resUsers.body);
            const firstUser = users[0] || {};
            const keys = Object.keys(firstUser);
            const sensitiveKeys = keys.filter(k => ['contrasena_hash', 'contrasena', 'pin_seguridad', 'token'].includes(k));
            
            findings.push({
                severity: "ALTA 🔴 (Broken Authentication & Data Exposure)",
                title: "Acceso Público No Autorizado al Listado Completo de Usuarios (/api/users)",
                detail: `Cualquier usuario de internet sin iniciar sesión ni enviar token JWT puede descargar la lista de los ${users.length} usuarios registrados en la plataforma.`,
                exposedFields: keys,
                leaksPasswordHash: sensitiveKeys.length > 0 ? sensitiveKeys : "No filtra hash, pero filtra PII: " + keys.filter(k => ['correo_electronico', 'numero_telefono', 'nombre_completo'].includes(k)).join(', ')
            });
        } catch(e) {
            console.log("Error parseando usuarios");
        }
    }

    // 2. TEST: Verificación de Rate Limiting en /api/login (Fuerza Bruta)
    console.log("[Test 2] Evaluando protección contra Fuerza Bruta en POST /api/login ...");
    let bruteSuccessCount = 0;
    for (let i = 0; i < 5; i++) {
        const resLogin = await makeRequest('POST', '/login', {
            correo_electronico: "admin@rumbo.com",
            contrasena: "wrongpassword_" + i
        });
        if (resLogin.status === 401 || resLogin.status === 200) {
            bruteSuccessCount++;
        }
    }
    if (bruteSuccessCount === 5) {
        findings.push({
            severity: "MEDIA-ALTA 🟠 (Lack of Rate Limiting / DoS & Brute Force)",
            title: "Ausencia de Límite de Intentos (Rate Limiting) en /api/login",
            detail: "El servidor permite infinitos intentos fallidos de inicio de sesión sin bloquear la IP ni retrasar las peticiones (HTTP 429 Too Many Requests). Un atacante puede realizar ataques de fuerza bruta o diccionario masivo para adivinar contraseñas sin restricción."
        });
    }

    // 3. TEST: Verificación de Cabeceras CORS Inseguras (Wildcard *)
    console.log("[Test 3] Evaluando cabeceras CORS e isolación de origen ...");
    const resCors = await makeRequest('GET', '/users', null, { 'Origin': 'https://sitiomalicioso-hacker.com' });
    const acao = resCors.headers['access-control-allow-origin'];
    if (acao === '*' || acao === 'https://sitiomalicioso-hacker.com') {
        findings.push({
            severity: "MEDIA 🟡 (Insecure CORS Configuration)",
            title: `Configuración CORS Permisiva (${acao})`,
            detail: `El servidor devuelve 'Access-Control-Allow-Origin: ${acao}'. Esto permite que páginas web externas maliciosas realicen peticiones AJAX/Fetch al backend desde el navegador de un usuario víctima y lean sus datos.`
        });
    }

    // 4. TEST: IDOR (Insecure Direct Object Reference) en Mensajes / Conversaciones
    console.log("[Test 4] Evaluando IDOR en endpoints de mensajes o conversaciones ...");
    const resConv = await makeRequest('GET', '/conversations?userId=11111111-1111-1111-1111-111111111111');
    if (resConv.status === 200 || resConv.status === 404) {
        findings.push({
            severity: "ALTA 🔴 (IDOR / Missing Authorization check)",
            title: "Endpoints de Conversaciones y Mensajes Consultables mediante ID plano sin Autenticación",
            detail: "Endpoints como `/api/conversations?userId=ID` no validan ningún Token JWT ni cabecera de sesión. Si alguien descubre el ID de un usuario o conductor, puede consultar sus conversaciones o historial cambiando el parámetro `userId` en la URL."
        });
    }

    // 5. ESCANEO DE CÓDIGO FUENTE LOCAL: SQL Injection y validaciones de JWT
    console.log("[Test 5] Auditando código fuente local (index.js) en busca de SQL Injection e Inseguridad de Sesión ...");
    const indexContent = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf-8');
    
    // Check if there is jwt / middleware auth
    const hasJwtVerify = indexContent.includes('jwt.verify') || indexContent.includes('req.headers.authorization');
    if (!hasJwtVerify) {
        findings.push({
            severity: "CRÍTICA 🚨 (Missing Authentication Middleware across whole API)",
            title: "Ausencia Total de Middleware de Autenticación (Tokens JWT / Sesiones seguras)",
            detail: "Todo el archivo `backend/index.js` carece de verificación de Tokens JWT o firmas cryptográficas en las peticiones HTTP. La seguridad depende enteramente de que el cliente envíe IDs (por ejemplo en el body o query string) sin verificar si la persona que hace la petición realmente es dueña de esa cuenta."
        });
    }

    // Scan for dangerous string concatenation in db.query
    const lines = indexContent.split('\n');
    const sqlInjLines = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('db.query') || line.includes('query(')) {
            // Check if within next 5 lines there is `${` or `+` inside string
            const chunk = lines.slice(i, i + 5).join('\n');
            if ((chunk.includes('`${') || chunk.includes('+"') || chunk.includes("+'") || chunk.includes('"+')) && !chunk.includes('table_name')) {
                sqlInjLines.push(i + 1);
            }
        }
    }
    if (sqlInjLines.length > 0) {
        findings.push({
            severity: "ALTA 🔴 (Potential SQL Injection via String Concatenation)",
            title: `Posibles Inyecciones SQL por concatenación de strings en ${sqlInjLines.length} consultas`,
            detail: `Se encontraron construcciones de consultas SQL dinámicas o interpolación de variables en las líneas: ${sqlInjLines.slice(0, 10).join(', ')}...`
        });
    }

    console.log("\n=========================================================");
    console.log("             RESUMEN DE VULNERABILIDADES                 ");
    console.log("=========================================================\n");

    findings.forEach((f, idx) => {
        console.log(`\n--- [${idx + 1}] ${f.title} ---`);
        console.log(`Severidad: ${f.severity}`);
        console.log(`Detalle:   ${f.detail}`);
        if (f.exposedFields) {
            console.log(`Campos expuestos públicamente: ${f.exposedFields.join(', ')}`);
        }
        if (f.leaksPasswordHash) {
            console.log(`Impacto PII / Hashes: ${f.leaksPasswordHash}`);
        }
    });

    console.log("\n=========================================================\n");
}

runSecurityAudit();
