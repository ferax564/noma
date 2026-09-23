import { runNomaCloudMaintenanceOnce } from "../../src/cloud-server.js";

const result = await runNomaCloudMaintenanceOnce();
process.stdout.write(JSON.stringify({ sweptSpaces: result.runs.length, runs: result.runs }) + "\n");
if (result.runs.some((run) => run.status === "failed")) process.exitCode = 1;
