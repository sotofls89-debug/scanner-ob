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

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const swPath = path.join(__dirname, 'sw.js');
const htmlPath = path.join(__dirname, 'index.html');

// Genera versión con fecha y hora actual
const now = new Date();
const pad = n => String(n).padStart(2, '0');
const version = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;

// 1. Reconstruir bundle.js unificado
const jsFiles = [
  'js/binance_api.js',
  'js/trade_tracker.js',
  'js/smc_detector.js',
  'js/scanner.js',
  'js/binance_trade.js',
  'js/cloud_sync.js',
  'js/app.js'
];
let bundleContent = '/* SMC BOT UNIFIED BUNDLE */\n';
for (const f of jsFiles) {
  const fp = path.join(__dirname, f);
  if (fs.existsSync(fp)) {
    bundleContent += `\n/* --- ${f} --- */\n` + fs.readFileSync(fp, 'utf8') + '\n';
  }
}
fs.writeFileSync(path.join(__dirname, 'bundle.js'), bundleContent, 'utf8');

// 2. Actualiza sw.js
if (fs.existsSync(swPath)) {
  let swContent = fs.readFileSync(swPath, 'utf8');
  swContent = swContent.replace(/v__BUILD__|v\d{8}-\d{4}/g, `v${version}`);
  fs.writeFileSync(swPath, swContent, 'utf8');
}

// 3. Inyectar bundle.js unificado directamente en index.html (Zero-404 Inlined) y actualizar etiquetas
if (fs.existsSync(htmlPath)) {
  let htmlContent = fs.readFileSync(htmlPath, 'utf8');

  const inlinedRegex = /<script id="smc-bundle">[\s\S]*?<\/script>/;
  const externalScriptRegex = /<script src="bundle\.js[^>]*><\/script>/;
  const newScriptTag = `<script id="smc-bundle">\n/* SMC BOT UNIFIED INLINED BUNDLE v${version} */\n${bundleContent}\n  </script>`;

  if (inlinedRegex.test(htmlContent)) {
    htmlContent = htmlContent.replace(inlinedRegex, newScriptTag);
  } else if (externalScriptRegex.test(htmlContent)) {
    htmlContent = htmlContent.replace(externalScriptRegex, newScriptTag);
  }

  htmlContent = htmlContent.replace(/href="styles\.css(?:\?v=[^"]*)?"/g, `href="styles.css?v=${version}"`);
  htmlContent = htmlContent.replace(/(<span[^>]*class="[^"]*build-version-tag[^"]*"[^>]*>)[^<]*(<\/span>)/g, `$1v${version}$2`);
  fs.writeFileSync(htmlPath, htmlContent, 'utf8');
}

console.log(`✅ Bundle y versión actualizados: v${version}`);
console.log(`   Bundle JavaScript inyectado directamente en index.html (Zero-404 garantizado).`);
