const STATUS_EDGES: Record<string, string[]> = {
  backlog: ["todo"],
  todo: ["backlog", "in_progress"],
  in_progress: ["todo", "in_review"],
  in_review: ["in_progress", "done"],
  done: ["todo"],
};

export function statusPath(from: string, to: string): string[] {
  if (!from || !to || from === to) return [];
  const queue: Array<{ node: string; path: string[] }> = [{ node: from, path: [] }];
  const seen = new Set([from]);
  while (queue.length) {
    const current = queue.shift();
    if (!current) break;
    for (const next of STATUS_EDGES[current.node] ?? []) {
      if (seen.has(next)) continue;
      const path = [...current.path, next];
      if (next === to) return path;
      seen.add(next);
      queue.push({ node: next, path });
    }
  }
  return [];
}
