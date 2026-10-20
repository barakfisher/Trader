import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

import { useTranslation } from '../i18n/index.ts';

/**
 * A password field with a button that shows what was typed. Every password
 * field in the app is this one, so the toggle reads and behaves the same at
 * sign-in, signup and on Settings. The button sits at the field's end edge
 * (`end-*`), which is the left in Hebrew, and is a toggle (`aria-pressed`) so
 * a screen reader hears its state rather than a label that flips.
 */
export function PasswordInput({
  value,
  onChange,
  autoComplete,
}: {
  value: string;
  onChange: (value: string) => void;
  autoComplete: 'current-password' | 'new-password';
}) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const Icon = visible ? EyeOff : Eye;
  return (
    <div className="relative w-full">
      <input
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        spellCheck={false}
        autoCapitalize="none"
        className="input pe-9"
      />
      <button
        type="button"
        onClick={() => setVisible((shown) => !shown)}
        aria-pressed={visible}
        aria-label={t('password.show')}
        title={t(visible ? 'password.hide' : 'password.show')}
        className="absolute inset-y-0 end-0 flex items-center px-2 text-text-muted hover:text-text-primary"
      >
        <Icon className="size-4" aria-hidden />
      </button>
    </div>
  );
}
