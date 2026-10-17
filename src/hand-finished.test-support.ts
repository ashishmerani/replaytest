/**
 * Returns every scaffold force command that is not covered by the disclosure's
 * explicit negation. This is intentionally broader than a sentence-specific
 * regex so copy drift cannot silently disarm a MUST-NOT-APPEAR pin.
 */
export function survivingScaffoldForceAdvice(text: string, slug?: string): string[] {
  const surviving: string[] = [];
  const commandPattern = /(?:replaytest )?scaffold ([a-z0-9-]+) --force/g;
  for (const match of text.matchAll(commandPattern)) {
    const matchedSlug = match[1];
    if (slug !== undefined && matchedSlug !== slug) continue;
    const index = match.index ?? 0;
    const before = text.slice(Math.max(0, index - 60), index);
    if (!/do not run\s+["'`]?(?:replaytest\s*)?$/.test(before)) {
      surviving.push(text.slice(Math.max(0, index - 60), index + match[0].length + 40));
    }
  }
  return surviving;
}
