/** Zero-dependency test harness shared by the suites in this folder. */
export interface Tester {
  check(name: string, cond: boolean, detail?: string): void;
  /** Assert `fn` throws; returns the error message (or "" if it did not throw). */
  throws(name: string, fn: () => void): string;
  failures: number;
}

export function createTester(): Tester {
  const t: Tester = {
    failures: 0,
    check(name, cond, detail = "") {
      if (cond) {
        console.log(`  ok  ${name}`);
      } else {
        t.failures++;
        console.error(`FAIL  ${name}  ${detail}`);
      }
    },
    throws(name, fn) {
      try {
        fn();
      } catch (e) {
        console.log(`  ok  ${name}`);
        return e instanceof Error ? e.message : String(e);
      }
      t.failures++;
      console.error(`FAIL  ${name}  (did not throw)`);
      return "";
    },
  };
  return t;
}
