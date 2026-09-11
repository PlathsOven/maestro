import { Settings } from '../db';

/** Minimal Linear integration: fetch an issue by identifier (e.g. ENG-123) using a personal API token. */
export async function fetchLinearIssue(
  identifier: string
): Promise<{ title: string; description: string } | null> {
  const token = Settings.global().linearToken.trim();
  if (!token) return null;
  try {
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify({
        query: `query Issue($id: String!) { issue(id: $id) { title description } }`,
        variables: { id: identifier },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const j: any = await res.json();
    const issue = j?.data?.issue;
    if (!issue) return null;
    return { title: issue.title ?? identifier, description: issue.description ?? '' };
  } catch {
    return null;
  }
}
