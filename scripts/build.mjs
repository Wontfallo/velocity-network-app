import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let html = await readFile(resolve(root, 'index.html'), 'utf8');
const css = await readFile(resolve(root, 'src/styles.css'), 'utf8');
// Each module retains its own lexical scope. No third-party build tooling is needed.
const modules = [];
for (const name of ['data', 'engine', 'app']) {
  let code = await readFile(resolve(root, `src/${name}.js`), 'utf8');
  const exports = [...code.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let)\s+(\w+)/gm)].map(m => m[1]);
  code = code.replace(/^import\s+\{([^}]+)\}\s+from\s+['"]\.\/(\w+)\.js['"];?\s*$/gm, 'const {$1} = __modules.$2;');
  code = code.replace(/^export\s+(?=(?:async\s+)?(?:function|class|const|let)\s)/gm, '');
  modules.push(`__modules.${name} = (() => {\n${code}\nreturn {${exports.join(',')}};\n})();`);
}
const script = `(() => { 'use strict'; const __modules = {};\n${modules.join('\n')}\n})();`;
html = html.replace(/<link\b[^>]*href=["'](?:\.\/)?src\/styles\.css["'][^>]*>/, () => `<style>\n${css}\n</style>`);
html = html.replace(/<script\b[^>]*src=["'](?:\.\/)?src\/app\.js["'][^>]*><\/script>/, () => `<script type="module">\n${script.replace(/<\/script/gi, '<\\/script')}\n</script>`);
await mkdir(resolve(root, 'dist'), {recursive:true});
await writeFile(resolve(root, 'dist/Velocity.html'), html);
console.log('Built dist/Velocity.html (standalone, no CDN dependencies)');
