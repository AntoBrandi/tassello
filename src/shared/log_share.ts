// How much of the ROS log is kept, by the server and by the page: at most so
// many messages, shared fairly among the loggers that sent them (a node's,
// robot1.amcl, or one of its children's, robot1.amcl.costmap). Over that,
// the loggers that sent the most lose their oldest first: one flooding the log
// drops its own messages, never a quiet one's. Of N loggers, each keeps at
// least capacity / N of its latest messages, or all of them if it sent fewer.

// How many messages each logger keeps of counts, capacity in all: those that
// sent fewer than their share keep them all, the rest share what is left
// equally (one more each for the first of them, by name, while some is left)
export function fairShares(counts: ReadonlyMap<string, number>, capacity: number): Map<string, number> {
  const loggers = [...counts].sort(([a, m], [b, n]) => m - n || (a < b ? -1 : a > b ? 1 : 0));
  const shares = new Map<string, number>();
  let left = Math.max(0, Math.floor(capacity));
  for (let i = 0; i < loggers.length; i++) {
    const [name, count] = loggers[i];
    const rest = loggers.length - i;
    const share = Math.floor(left / rest);
    if (count <= share) {
      shares.set(name, count);
      left -= count;
      continue;
    }
    // This one and all after it sent more than their share: they split the rest
    let extra = left - share * rest;
    for (const [other] of loggers.slice(i).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      shares.set(other, share + (extra > 0 ? 1 : 0));
      extra--;
    }
    break;
  }
  return shares;
}

// Of messages in order, at most capacity, each logger's latest by its fair
// share (fairShares); the order kept. The same array if all fit.
export function keepFairly<T extends { name: string }>(messages: T[], capacity: number): T[] {
  if (messages.length <= capacity) {
    return messages;
  }
  const counts = new Map<string, number>();
  for (const message of messages) {
    counts.set(message.name, (counts.get(message.name) ?? 0) + 1);
  }
  // What each logger loses: its oldest
  const dropped = new Map<string, number>();
  for (const [name, share] of fairShares(counts, capacity)) {
    dropped.set(name, counts.get(name)! - share);
  }
  const kept: T[] = [];
  for (const message of messages) {
    const left = dropped.get(message.name)!;
    if (left > 0) {
      dropped.set(message.name, left - 1);
    } else {
      kept.push(message);
    }
  }
  return kept;
}
