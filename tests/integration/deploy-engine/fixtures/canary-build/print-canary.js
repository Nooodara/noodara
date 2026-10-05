// Prints the per-run build canary whole and split across two writes 1 s apart, then idles.
const fs = require('node:fs');

const canary = fs.readFileSync('canary.txt', 'utf8').trim();
const half = Math.floor(canary.length / 2);
process.stdout.write(`noodara-build-canary ${canary}\n`);
process.stderr.write(`noodara-build-canary-stderr ${canary}\n`);
process.stdout.write(`noodara-build-canary-split ${canary.slice(0, half)}`);
setTimeout(() => {
  process.stdout.write(`${canary.slice(half)} end\n`);
  setTimeout(() => process.stdout.write('noodara-build-canary-done\n'), 5000);
}, 1000);
