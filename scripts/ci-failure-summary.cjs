// Prints a GitHub Actions error annotation with the details of failed tests (annotations are readable without signing in).
const lines = require('fs').readFileSync(process.argv[2] || 'pg-tests.log', 'utf8').split(/\r?\n/);
const start = Math.max(lines.findIndex(l => /failing tests:/.test(l)), 0);
const keep = lines.slice(start).filter(l => /✖|error:|message:|code:|Error|expected|actual|detail|hint|at .*(test|server).*:\d+/.test(l)).map(l => l.trim().slice(0, 260));
console.log('::error title=PostgreSQL test failures::' + keep.slice(0, 45).join('%0A'));
