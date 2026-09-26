/**
 * node:test reporter that prints only a summary of failed tests after the run. CI log viewers keep
 * the tail of long logs, so repeating failures at the end makes them findable.
 */
export default async function* failureSummary(source) {
  const failures = [];
  for await (const event of source) {
    if (event.type !== "test:fail" || event.data.details?.type === "suite") continue;
    const error = event.data.details?.error;
    const cause = error?.cause ?? error;
    failures.push(`✖ ${event.data.name}${event.data.file ? ` (${event.data.file})` : ""}\n  ${String(cause?.message ?? cause ?? "failed").split("\n").slice(0, 12).join("\n  ")}`);
  }
  if (failures.length) yield `\n# Failed tests (${failures.length})\n${failures.join("\n")}\n`;
}
