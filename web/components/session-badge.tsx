// The human/AI distinction is rendered from each identity's declared session
// kind. An undeclared session is labelled undeclared, never assumed human.
const sessionLabels: Record<string, string> = { human: 'Human', ai: 'AI', undeclared: 'Session kind undeclared' };
export default function SessionBadge({ kind, suffix }: { kind?: string | null; suffix?: string }) {
  const resolved = kind === 'human' || kind === 'ai' ? kind : 'undeclared';
  return <span className={`identity ${resolved}`}>{suffix ? `${sessionLabels[resolved]} ${suffix}` : sessionLabels[resolved]}</span>;
}
