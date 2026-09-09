// Test-only composition entry for the BRN service.
//
// It runs the same startup path as `src/service/main.ts` in a child process so
// tests exercise real ownership locking, real sockets and the real filesystem.
// At this stage the service hosts only authenticated health, so there is nothing
// to substitute; later capabilities add their seams here.
import { runService } from "../../src/service/main.ts";

process.exitCode = await runService(process.argv.slice(2));
