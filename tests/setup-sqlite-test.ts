// Test setup — MUST be the first import in tests/unit-test.ts.
//
// ESM evaluates imports before any module body runs, so the test file
// cannot set these env vars in its own body before src/db/index.ts
// creates the global `db` singleton. This side-effect import runs
// first and forces the suite onto a throwaway in-memory SQLite
// database:
//   - SQLITE_PATH=:memory: — no bot.db file is created in the repo,
//     and no live data is ever touched by the tests.
//   - DB_BACKEND=sqlite — the persona sections (§20, §28) exercise the
//     real SQLite client instead of the gateway (which 404s locally
//     because the persona worker routes were never deployed).
import "node:process";

if (!process.env.SQLITE_PATH) {
  process.env.SQLITE_PATH = ":memory:";
}
process.env.DB_BACKEND = "sqlite";
