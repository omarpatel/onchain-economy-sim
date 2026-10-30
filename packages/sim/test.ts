import { createTester, type Tester } from "./tests/harness.ts";
import { run as invariants } from "./tests/invariants.ts";
import { run as intents } from "./tests/intents.ts";
import { run as serialization } from "./tests/serialization.ts";
import { run as sinks } from "./tests/sinks.ts";
import { run as balance } from "./tests/balance.ts";
import { run as hardening } from "./tests/hardening.ts";

const suites: [string, (t: Tester) => void][] = [
  ["invariants", invariants],
  ["intents", intents],
  ["serialization", serialization],
  ["sinks", sinks],
  ["hardening", hardening],
  ["balance", balance],
];

const only = process.argv[2];
const t = createTester();
console.log("=== Economy Sim tests ===");
for (const [name, fn] of suites) {
  if (only && name !== only) continue;
  console.log(`\n## ${name}`);
  const t0 = Date.now();
  try {
    fn(t);
  } catch (e) {
    t.failures++;
    console.error(`FAIL  ${name} suite threw:`, e);
  }
  console.log(`   (${Date.now() - t0} ms)`);
}
console.log(t.failures === 0 ? `\nALL PASS` : `\n${t.failures} FAILURE(S)`);
process.exit(t.failures === 0 ? 0 : 1);
