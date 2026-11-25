import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runChecks } from "./index.ts";
import { writeReport } from "../report.ts";

export async function main(args: string[]): Promise<number> {
  try {
    if (args.length !== 1)
      throw new Error("Usage: node scripts/upclose/checks/cli.ts <run-folder>");
    const run = resolve(args[0]!);
    await runChecks(run);
    const report = await writeReport(run);
    console.log(
      `${report.counts.open} open findings, ${report.counts.waived} waived. Report: ${run}/report.md`,
    );
    return report.counts.open ? 2 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = await main(process.argv.slice(2));
