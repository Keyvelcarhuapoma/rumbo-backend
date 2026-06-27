Set-Location $PSScriptRoot

if (Test-Path -LiteralPath ".\node_modules") {
  Write-Host "Limpiando node_modules anterior..."
  Remove-Item -LiteralPath ".\node_modules" -Recurse -Force
}

Write-Host "Instalando dependencias del backend..."
npm install

if ($LASTEXITCODE -ne 0) {
  Write-Error "npm install fallo. Revisa tu conexion o la instalacion de Node.js."
  exit $LASTEXITCODE
}

Write-Host "Iniciando backend..."
npm start
