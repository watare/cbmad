// Static check: ensure no duplicate mcp.registerTool names in src/server.js
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'src', 'server.js');
const src = fs.readFileSync(file, 'utf8');
const re = /mcp\.registerTool\(\s*['"]([^'"]+)['"]/g;
const seen = new Map();
let m;
while ((m = re.exec(src))) {
  const name = m[1];
  seen.set(name, (seen.get(name) || 0) + 1);
}
const dups = [...seen.entries()].filter(([_, c]) => c > 1);
if (dups.length) {
  console.error('Duplicate tool registrations found:', dups);
  process.exit(1);
}
console.log('No duplicate tool registrations.');

