/**
 * Copies vendor files that must NOT go through Vite's own asset pipeline
 * from node_modules into public/vendor: the Bootstrap LTR/RTL builds, the
 * bootstrap-icons font, and pdf.js's worker script.
 *
 * direction.ts swaps between the two Bootstrap stylesheets at runtime via
 * plain /vendor/... URLs, and index.html links the icon font CSS. They must
 * be static files: Vite 4 production builds leave unreplaced __VITE_ASSET__
 * placeholders both for ?url CSS imports and for the font url()s inside
 * imported CSS (bootstrap-icons' woff/woff2), which 404s at runtime. Serving
 * from publicDir bypasses the asset pipeline entirely. Runs as the
 * prebuild/predev step to stay in sync with the installed package versions.
 *
 * pdf.worker.min.mjs hits the exact same bug: pdf-decrypt.ts's
 * `new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url)` also
 * built to an unresolved __VITE_ASSET__ placeholder (confirmed by inspecting
 * the actual dist/ output, not assumed), so it is synced here too and
 * referenced by pdf-decrypt.ts as a plain /vendor/ URL instead. pdf.js
 * requires its API and worker to be the exact same version (see
 * pdf-decrypt.ts's loadPdfJs), so this file is version-locked to whatever
 * pdfjs-dist package.json pins, the same way the Bootstrap files above are
 * locked to that package's version -- there is no separate version to drift.
 */
const fs = require('fs');
const path = require('path');

const nodeModules = path.join(__dirname, '..', 'node_modules');
const destDir = path.join(__dirname, '..', 'public', 'vendor');

// dest is relative to public/vendor. bootstrap-icons.min.css references its
// fonts at ./fonts/..., so the woff files live in vendor/fonts.
const files = [
  { src: 'bootstrap/dist/css/bootstrap.min.css', dest: 'bootstrap.min.css' },
  { src: 'bootstrap/dist/css/bootstrap.rtl.min.css', dest: 'bootstrap.rtl.min.css' },
  { src: 'bootstrap-icons/font/bootstrap-icons.min.css', dest: 'bootstrap-icons.min.css' },
  { src: 'bootstrap-icons/font/fonts/bootstrap-icons.woff2', dest: 'fonts/bootstrap-icons.woff2' },
  { src: 'bootstrap-icons/font/fonts/bootstrap-icons.woff', dest: 'fonts/bootstrap-icons.woff' },
  { src: 'pdfjs-dist/build/pdf.worker.min.mjs', dest: 'pdf.worker.min.mjs' },
];

for (const { src, dest } of files) {
  const srcPath = path.join(nodeModules, src);
  const destPath = path.join(destDir, dest);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (!fs.existsSync(destPath) || !fs.readFileSync(srcPath).equals(fs.readFileSync(destPath))) {
    fs.copyFileSync(srcPath, destPath);
    console.log(`[sync-bootstrap] copied ${dest}`);
  }
}
