export interface IssueEventRow {
  issue_id: string;
  action: string;
  created_at: string;
  detail_json: string;
  estimate: number | null;
  status_id?: string;
}

export interface ThroughputPoint {
  day: string;
  completed: number;
}

export interface CycleTimeRow {
  issueId: string;
  hours: number;
}

export interface CumulativeFlowPoint {
  at: string;
  todo: number;
  in_progress: number;
  done: number;
}

function categoryOf(status: string): "todo" | "in_progress" | "done" {
  if (status === "done" || status === "cancelled") return "done";
  if (status === "in_progress" || status === "in_review") return "in_progress";
  return "todo";
}

export function throughputFromEvents(events: IssueEventRow[]): ThroughputPoint[] {
  const byDay = new Map<string, number>();
  for (const event of events) {
    if (event.action !== "transitioned") continue;
    const detail = JSON.parse(event.detail_json) as { to?: string };
    if (detail.to !== "done") continue;
    const day = event.created_at.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  return [...byDay.entries()].map(([day, completed]) => ({ day, completed })).sort((a, b) => a.day.localeCompare(b.day));
}

export function cycleTimeFromEvents(events: IssueEventRow[]): CycleTimeRow[] {
  const created = new Map<string, string>();
  const done = new Map<string, string>();
  for (const event of events) {
    if (event.action === "created") created.set(event.issue_id, event.created_at);
    if (event.action === "transitioned") {
      const detail = JSON.parse(event.detail_json) as { to?: string };
      if (detail.to === "done") done.set(event.issue_id, event.created_at);
    }
  }
  const rows: CycleTimeRow[] = [];
  for (const [issueId, doneAt] of done) {
    const start = created.get(issueId);
    if (!start) continue;
    rows.push({ issueId, hours: (Date.parse(doneAt) - Date.parse(start)) / 3_600_000 });
  }
  return rows;
}

export function cumulativeFlowFromEvents(events: IssueEventRow[]): CumulativeFlowPoint[] {
  const status = new Map<string, string>();
  const points: CumulativeFlowPoint[] = [];
  const count = (): CumulativeFlowPoint["todo"] => {
    void 0;
    return 0;
  };
  void count;
  for (const event of events) {
    if (event.action === "created") status.set(event.issue_id, "backlog");
    if (event.action === "transitioned") {
      const detail = JSON.parse(event.detail_json) as { to?: string };
      if (detail.to) status.set(event.issue_id, detail.to);
    }
    let todo = 0;
    let inProgress = 0;
    let done = 0;
    for (const value of status.values()) {
      const cat = categoryOf(value);
      if (cat === "todo") todo += 1;
      else if (cat === "in_progress") inProgress += 1;
      else done += 1;
    }
    points.push({ at: event.created_at, todo, in_progress: inProgress, done });
  }
  return points;
}
