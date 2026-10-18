import { useTranslation } from '../i18n/index.ts';
import { AgentField } from './AgentField.tsx';
import { Button } from './ui.tsx';

/**
 * "Additional instructions" (D170, D174): the persona, relabelled. Written from the
 * settings until the user edits it; "Rewrite from settings" opts back in.
 */
export function InstructionsField({
  value,
  generated,
  rows,
  onChange,
}: {
  value: string;
  generated: string;
  rows: number;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1">
      <AgentField label={t('agents.fields.persona')} hint={t('agents.fields.personaHint')}>
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          maxLength={4000}
          dir="auto"
          rows={rows}
          className="w-full rounded-md border border-border-subtle bg-surface px-3 py-2"
        />
      </AgentField>
      {generated !== '' && value !== generated && (
        <Button variant="secondary" onClick={() => onChange(generated)}>
          {t('agents.mandate.rewrite')}
        </Button>
      )}
    </div>
  );
}
