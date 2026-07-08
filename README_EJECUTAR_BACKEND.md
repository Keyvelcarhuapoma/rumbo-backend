# Ejecutar backend Rumbo

Si acabas de descomprimir el proyecto, instala primero las dependencias:

```powershell
cd backend
npm install
npm start
```

Si aparece un error de modulo faltante dentro de `node_modules`, limpia e instala de nuevo:

```powershell
cd backend
Remove-Item -Recurse -Force node_modules
npm install
npm start
```

El archivo `.env` debe tener la configuracion de PostgreSQL y demas claves del backend.

TIRAME TU GAAAAAAAAAA
