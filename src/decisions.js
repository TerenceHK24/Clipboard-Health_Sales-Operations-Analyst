import { hash } from './config.js';

/** Stable decision identity: unchanged proposed corrections stay decided even
 * when an unrelated field changes. Full guards/revisions remain separate.
 */
export function decisionKey(item) {
  return hash({ key: item.key, kind: item.kind, manual: item.website?.manual_match_account_id || null,
    steps: item.steps.map(step => {
      const resource = step.resource || 'accounts';
      const check = (resource === 'contacts' ? item.contactGuards : item.checks)?.find(c => c.id === step.id);
      const body = Object.fromEntries(Object.entries(step.body).map(([key, value]) => [key,
        typeof value === 'string' ? value.replace(/(?:^|\n)\[review-op:[a-f0-9]{64}\] Source: [^\n]*/g, '').trim() : value
      ]).filter(([, value]) => value !== ''));
      return { resource, method: step.method, id: step.id || null, body,
        before: step.method === 'PATCH' ? Object.fromEntries(Object.keys(body).map(key => [key, check?.before[key] ?? null])) : null };
    }) });
}
