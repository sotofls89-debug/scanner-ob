/**
 * bump-version.js
 * Ejecuta este script cada vez que termines de modificar la app:
 *   node bump-version.js
 * 
 * Lo que hace:
 *   1. Genera un timestamp único como versión (ej: 20260825-2217)
 *   2. Lo escribe en sw.js reemplazando v__BUILD__
 *   3. Cualquier móvil que abra la app recibirá la actualización automáticamente
 */

const fs = require('fs');
const path = require('path');

const swPath = path.join(__dirname, 'sw.js');
const htmlPath = path.join(__dirname, 'index.html');

// Genera versión con fecha y hora actual
const now = new Date();
const pad = n => String(n).padStart(2, '0');
const version = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;

// 1. Actualiza sw.js
if (fs.existsSync(swPath)) {
  let swContent = fs.readFileSync(swPath, 'utf8');
  swContent = swContent.replace(/v__BUILD__|v\d{8}-\d{4}/g, `v${version}`);
  fs.writeFileSync(swPath, swContent, 'utf8');
}

// 2. Invalida la caché de scripts y css en index.html
if (fs.existsSync(htmlPath)) {
  let htmlContent = fs.readFileSync(htmlPath, 'utf8');
  htmlContent = htmlContent.replace(/src="js\/([^"]+?)(?:\?v=[^"]*)?"/g, `src="js/$1?v=${version}"`);
  htmlContent = htmlContent.replace(/href="styles\.css(?:\?v=[^"]*)?"/g, `href="styles.css?v=${version}"`);
  fs.writeFileSync(htmlPath, htmlContent, 'utf8');
}

console.log(`✅ Versión actualizada: v${version}`);
console.log(`   Caché de scripts en index.html y sw.js sincronizada.`);
