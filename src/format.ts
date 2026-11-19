// Wording shared by the server's model summary and the UI.

// "About 4 messages until Codex compacts", or null without an estimate.
export function messagesLeftText(left: number | null): string | null {
  if (left === null) return null;
  if (left === 0) return "Codex compacts on the next message";
  if (left >= 50) return "50+ messages until Codex compacts";
  return `About ${left} message${left === 1 ? "" : "s"} until Codex compacts`;
}

export function durationText(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 1) return ms > 0 ? "<1s" : "0s";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  if (hours) return `${hours}h ${minutes}m`;
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}
