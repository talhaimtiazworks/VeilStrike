// Minimal unlock-service stand-in used only by the isolated Progress persistence test.
export function defaultUnlocks() {
  return { weapons: {}, characters: {}, challenge: { accShots: 0, accHits: 0 }, notified: [] };
}

export function sanitizeUnlocks(data) {
  return data && typeof data === 'object' ? data : defaultUnlocks();
}

export function evaluateUnlocks() {
  return [];
}
