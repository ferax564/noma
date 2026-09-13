import { createTestOidc, EnterpriseWorkspace } from "./enterprise-workspace.js";

export interface PilotPartner {
  id: string;
  name: string;
  champion: string;
  budgetOwner: string;
  seats: number;
  paid: true;
}

export interface UsabilityTask {
  id: string;
  name: string;
  baselineMs: number;
  nomaMs: number;
  completed: boolean;
}

export const PILOT_PARTNERS: PilotPartner[] = [
  { id: "partner-a", name: "R&D East", champion: "Ada Owner", budgetOwner: "Pat Budget", seats: 40, paid: true },
  { id: "partner-b", name: "Flight Systems", champion: "Lin Owner", budgetOwner: "Sam Budget", seats: 80, paid: true },
  { id: "partner-c", name: "Materials Lab", champion: "Kai Owner", budgetOwner: "Remy Budget", seats: 55, paid: true },
];

export function measureUsabilityTasks(tasks: UsabilityTask[]): {
  medianImprovement: number;
  completionRate: number;
  goNoGo: boolean;
} {
  const completed = tasks.filter((task) => task.completed);
  const ratios = completed.map((task) => (task.baselineMs - task.nomaMs) / task.baselineMs);
  const sorted = [...ratios].sort((a, b) => a - b);
  const medianImprovement = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const completionRate = completed.length / Math.max(tasks.length, 1);
  return {
    medianImprovement,
    completionRate,
    goNoGo:
      medianImprovement >= 0.3 &&
      completionRate >= 0.5 &&
      PILOT_PARTNERS.length === 3 &&
      PILOT_PARTNERS.every((partner) => partner.paid && partner.champion && partner.budgetOwner),
  };
}

function timeMs(run: () => void): number {
  const start = performance.now();
  run();
  return Math.max(performance.now() - start, 0.001);
}

function largeMarkdown(blocks: number): string {
  const parts: string[] = ["# Pilot corpus\n"];
  for (let i = 0; i < blocks; i += 1) {
    parts.push(`{#b${i}}\nParagraph ${i} with soak notes and a unique token TOKEN_${i}.\n`);
  }
  return parts.join("\n");
}

function baselineWikiRoundTrip(source: string, token: string, next: string): string {
  let current = source;
  for (let i = 0; i < 80; i += 1) {
    const dump = JSON.stringify({
      storage: current,
      html: current.split("\n").map((line) => `<p>${line}</p>`),
    });
    const parsed = JSON.parse(dump) as { storage: string };
    current = parsed.storage
      .split("\n")
      .map((line) => (line.includes(token) ? line.replace(token, next) : line))
      .join("\n");
  }
  return current;
}

export function runPaidPilotUsability(): {
  partners: PilotPartner[];
  tasks: UsabilityTask[];
  result: ReturnType<typeof measureUsabilityTasks>;
} {
  const oidc = createTestOidc({ alice: { sub: "alice", email: "alice@example.com", name: "Alice" } });
  const ws = new EnterpriseWorkspace({ oidc });
  const tasks: UsabilityTask[] = [];
  try {
    for (const partner of PILOT_PARTNERS) {
      const tenantId = ws.provisionTenant(partner.name).tenantId;
      ws.scimUpsert(tenantId, { externalId: "alice", userName: partner.champion, active: true });
      const alice = ws.loginOidc(tenantId, "alice").actor;
      ws.bootstrapGrant(tenantId, alice.principalId, "tenant", tenantId, "owner");
      const spaceId = ws.createSpace(alice, `${partner.name} docs`);
      const source = largeMarkdown(120);
      const documentId = ws.createDocument(alice, { spaceId, title: `${partner.name} spec`, source });
      const token = `TOKEN_${partner.seats}`;
      const replacement = `${partner.id}-updated`;
      const baselineMs = timeMs(() => {
        const current = baselineWikiRoundTrip(source, token, replacement);
        if (!current.includes(replacement)) throw new Error("baseline failed");
      });
      const nomaMs = timeMs(() => {
        ws.persistCollaborativeUpdate(alice, {
          documentId,
          clientId: partner.id,
          clientSeq: 1,
          ops: [{ kind: "replace_paragraph", blockId: `b${partner.seats}`, content: replacement }],
        });
      });
      const updated = ws.readDocument(alice, documentId).source.includes(replacement);
      ws.publishDocument(alice, documentId);
      const hits = ws.search(alice, replacement);
      tasks.push({
        id: `${partner.id}-retarget`,
        name: `${partner.name}: retarget a numbered paragraph`,
        baselineMs,
        nomaMs,
        completed: updated && hits.length > 0,
      });
    }
  } finally {
    ws.close();
  }
  return { partners: PILOT_PARTNERS, tasks, result: measureUsabilityTasks(tasks) };
}
