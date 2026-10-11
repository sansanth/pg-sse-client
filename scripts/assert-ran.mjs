// Reads the JSON report of a vitest run and fails unless tests ran and none was skipped: the integration suite skips itself
// without a database, and a skipped test is not a pass.
import { readFileSync } from 'node:fs';

const report = JSON.parse(readFileSync(process.argv[2] ?? 'integration.json', 'utf8'));
const { numPassedTests: passed, numFailedTests: failed, numPendingTests: skipped, numTodoTests: todo } = report;
console.log(`${passed} passed, ${failed} failed, ${skipped} skipped, ${todo} todo`);
if (passed === 0 || failed > 0 || skipped > 0 || todo > 0) process.exit(1);
