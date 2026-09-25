import { createZip, type ZipEntryInput } from "../src/zip.js";

export const HOME = "0123456789abcdef0123456789abcdef";
export const DESIGN = "11111111111111111111111111111111";
export const TASKS = "22222222222222222222222222222222";
export const TASK_A = "33333333333333333333333333333333";
export const TASK_B = "44444444444444444444444444444444";
export const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4f60000000049454e44ae426082", "hex");

/** A Notion "Markdown & CSV" export: Home → Design Doc, Home → Tasks (database with two row pages). */
export function notionFixture(extra: ZipEntryInput[] = []): Buffer {
  const root = "Export-6f1c";
  const home = `${root}/Home ${HOME}`;
  return createZip([
    {
      path: `${home}.md`,
      data: [
        "# Home",
        "",
        "Welcome to the **team** wiki. Read the [Design Doc](Home%20" + HOME + "/Design%20Doc%20" + DESIGN + ".md) first.",
        "",
        "Track work in [Tasks](Home%20" + HOME + "/Tasks%20" + TASKS + ".csv).",
        "",
        "<aside>",
        "💡 Notion callouts become Noma callouts.",
        "",
        `![Team photo](Home%20${HOME}/team%20photo.png)`,
        "</aside>",
        "",
        "Broken: [Gone](Home%20" + HOME + "/Missing%20ffffffffffffffffffffffffffffffff.md).",
        "",
        "::include{page=\"Secrets\"} stays literal, and so does [[not a link]].",
        "",
        "<details>",
        "<summary>Toggle</summary>",
        "Hidden text",
        "</details>",
      ].join("\n"),
    },
    {
      path: `${home}/Design Doc ${DESIGN}.md`,
      data: [
        "# Design Doc",
        "",
        "Status: this line is prose, not a property, on a normal page.",
        "",
        "## Architecture",
        "",
        `![Diagram](Design%20Doc%20${DESIGN}/arch%20(v2).png)`,
        "",
        `Spec attached: [spec.pdf](Design%20Doc%20${DESIGN}/spec.pdf). Back to [Home](../Home%20${HOME}.md).`,
        "",
        "See also https://www.notion.so/acme/Tasks-" + TASKS + " and [the task](https://www.notion.so/Task-A-" + TASK_A + "?pvs=21).",
        "",
        "```js",
        "const link = \"[x](Home.md)\";",
        "```",
      ].join("\n"),
    },
    { path: `${home}/Design Doc ${DESIGN}/arch (v2).png`, data: PNG },
    { path: `${home}/Design Doc ${DESIGN}/spec.pdf`, data: "%PDF-1.4\n%fake\n" },
    { path: `${home}/team photo.png`, data: PNG },
    {
      path: `${home}/Tasks ${TASKS}.csv`,
      data: "﻿Name,Status,Tags,Notes\nShip importer,Done,\"import, notion\",\"Line one\nline two\"\nWrite docs,In progress,docs,\"Has | pipe, and \"\"quotes\"\"\"\n",
    },
    {
      path: `${home}/Tasks ${TASKS}_all.csv`,
      data: "﻿Name,Status,Tags,Notes\nShip importer,Done,\"import, notion\",\"Line one\nline two\"\nWrite docs,In progress,docs,\"Has | pipe, and \"\"quotes\"\"\"\nArchived,Done,,\n",
    },
    {
      path: `${home}/Tasks ${TASKS}/Ship importer ${TASK_A}.md`,
      data: [
        "# Ship importer",
        "",
        "Status: Done",
        "Tags: import, notion",
        `Blocked by: Write docs (Write%20docs%20${TASK_B}.md)`,
        "",
        "The importer ships with the [Design Doc](../Design%20Doc%20" + DESIGN + ".md).",
      ].join("\n"),
    },
    { path: `${home}/Tasks ${TASKS}/Write docs ${TASK_B}.md`, data: "# Write docs\n\nStatus: In progress\nOwner: Ada\n\n## Outline\n\nTBD.\n" },
    { path: `${root}/.DS_Store`, data: "junk" },
    ...extra,
  ]);
}
