/**
 * Copies the Bootstrap LTR and RTL builds from node_modules into public/vendor.
 *
 * direction.ts swaps between the two stylesheets at runtime via plain
 * /vendor/... URLs. They must be static files: importing CSS with ?url is
 * broken in Vite 4 production builds (the __VITE_ASSET__ placeholder is never
 * replaced), so the files are served from publicDir instead. Runs as the
 * prebuild/predev step to stay in sync with the installed bootstrap version.
 */
const fs = require('fs');
const path = require('path');

const files = ['bootstrap.min.css', 'bootstrap.rtl.min.css'];
const srcDir = path.join(__dirname, '..', 'node_modules', 'bootstrap', 'dist', 'css');
const destDir = path.join(__dirname, '..', 'public', 'vendor');

fs.mkdirSync(destDir, { recursive: true });
for (const file of files) {
  const src = path.join(srcDir, file);
  const dest = path.join(destDir, file);
  if (!fs.existsSync(dest) || fs.readFileSync(src).toString() !== fs.readFileSync(dest).toString()) {
    fs.copyFileSync(src, dest);
    console.log(`[sync-bootstrap] copied ${file}`);
  }
}
