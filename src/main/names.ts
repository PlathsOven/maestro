// Conductor-style workspace names: a city plus a version suffix, e.g. "yokohama-v1".

const CITIES = [
  'yokohama', 'warsaw', 'lisbon', 'oslo', 'kyoto', 'dublin', 'austin', 'zurich',
  'seville', 'porto', 'quito', 'lagos', 'osaka', 'bergen', 'tampere', 'girona',
  'valencia', 'nagoya', 'krakow', 'tbilisi', 'riga', 'vilnius', 'ljubljana',
  'sapporo', 'fukuoka', 'malmo', 'aarhus', 'ghent', 'bruges', 'leiden',
  'granada', 'bologna', 'turin', 'nantes', 'lyon', 'bordeaux', 'toulouse',
  'geneva', 'basel', 'lucerne', 'salzburg', 'graz', 'brno', 'gdansk',
];

/**
 * Pick a workspace name that is unique among `existing` names.
 * Reuses a city with a bumped -vN suffix once all cities are taken.
 */
export function generateWorkspaceName(existing: string[]): string {
  const taken = new Set(existing);
  const shuffled = [...CITIES].sort(() => Math.random() - 0.5);
  for (const city of shuffled) {
    if (!taken.has(`${city}-v1`)) return `${city}-v1`;
  }
  // All cities used at v1: bump versions.
  for (const city of shuffled) {
    for (let v = 2; v < 100; v++) {
      if (!taken.has(`${city}-v${v}`)) return `${city}-v${v}`;
    }
  }
  return `workspace-${Date.now()}`;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'workspace';
}
