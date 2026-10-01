import { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Check, Link2, Send } from 'lucide-react';

import { errorMessage } from '../api/client.ts';
import { Trans, useTranslation } from '../i18n/index.ts';
import { formatExactTime } from '../lib/relativeTime.ts';
import { useTelegramBindingQuery } from '../queries/telegram.ts';
import { useStore } from '../stores/context.tsx';
import { Button, ErrorNote } from './ui.tsx';

/**
 * Connecting a Telegram chat, from the settings page.
 *
 * The API for this shipped in M4 and the only way to reach it was a fetch from
 * the browser console - the same gap the target weights had, and with the same
 * consequence: a feature that works and that nobody can find is a feature the
 * product does not have.
 *
 * Two things this component says out loud rather than assuming the reader
 * knows. The link is a **bearer credential** - whoever opens it in Telegram
 * binds their chat to this account, so it must not be forwarded - and
 * disconnecting happens in the chat rather than here, because `/stop` to the
 * bot is the only thing that removes a binding today.
 */
export const TelegramConnect = observer(function TelegramConnect() {
  const { telegram } = useStore();
  const { t } = useTranslation();
  const bindingQuery = useTelegramBindingQuery();
  const binding = bindingQuery.data;
  const connected = binding?.connected === true;
  const [copied, setCopied] = useState(false);
  const link = telegram.link;
  const startCommand = link === null ? null : startCommandFor(link.url);

  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused, and the command is selectable text
      // regardless. Saying "Copied" when nothing was would be worse than
      // leaving the button alone.
    }
  }

  return (
    <div className="space-y-3">
      {bindingQuery.error && (
        <ErrorNote
          message={errorMessage(bindingQuery.error, t('telegram.checkFailed'))}
          onRetry={() => void bindingQuery.refetch()}
        />
      )}
      {telegram.error && <ErrorNote message={telegram.error} onRetry={() => void telegram.connect()} />}

      {telegram.unavailable && (
        <p className="text-sm text-text-muted">
          {t('telegram.unavailable')}
        </p>
      )}

      {connected ? (
        <div className="space-y-1">
          <p className="flex items-center gap-2 text-sm text-gain">
            <Check className="size-4" aria-hidden />
            {binding?.username
              ? t('telegram.connectedAs', { username: binding.username })
              : t('telegram.connected')}
          </p>
          <p className="text-xs text-text-muted">
            {binding?.boundAt && t('telegram.linked', { when: formatExactTime(binding.boundAt) })}
            {t('telegram.buttonsExplained')}
          </p>
          <p className="text-xs text-text-muted">
            <Trans i18nKey="telegram.disconnect" components={{ mono: <span className="font-mono" /> }} />
          </p>
        </div>
      ) : binding === undefined ? null : (
        // Only once the server has said "not connected": before that - or after
        // a failed check - offering to connect could re-bind a chat that is
        // connected, which the reader has no way to tell from this card.
        <div className="space-y-2">
          <p className="text-sm text-text-muted">
            {t('telegram.notConnected')}
          </p>

          {link === null ? (
            <Button onClick={() => void telegram.connect()} disabled={telegram.minting}>
              <span className="flex items-center gap-1">
                <Send className="size-4" aria-hidden />
                {telegram.minting ? t('telegram.creatingLink') : t('telegram.connect')}
              </span>
            </Button>
          ) : (
            <div className="space-y-2 rounded-lg border border-border-subtle bg-surface-hover p-3">
              <p className="text-sm text-text-primary">
                {t('telegram.openAndStart')}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <a
                  className="flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-surface hover:brightness-110"
                  href={link.url}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  <Link2 className="size-4" aria-hidden />
                  {t('telegram.openInTelegram')}
                </a>
                <Button variant="ghost" onClick={() => void bindingQuery.refetch()}>
                  {t('telegram.pressedStart')}
                </Button>
              </div>

              {/* Shown as text as well as a button: on a desktop without Telegram
                  installed the link has to travel to a phone, and a link you
                  cannot read is a link you cannot move. */}
              <p className="break-all font-mono text-[11px] text-text-muted">{link.url}</p>

              {/*
                The deep link only sends its payload for a bot you have never
                started. Open it on a chat that already exists and Telegram just
                shows the chat - no Start button, nothing sent, and no way to
                tell from this side that nothing happened. Found by using it,
                against a bot left over from earlier testing.

                The command below is exactly what the link would have sent, and
                the webhook cannot tell the two apart: it splits `/start <token>`
                whichever way the message arrives.
              */}
              {startCommand && (
                <div className="space-y-1 border-t border-border-subtle pt-2">
                  <p className="text-xs text-text-muted">
                    {t('telegram.alreadyStarted')}
                  </p>
                  <div className="flex items-start gap-2">
                    <code className="block flex-1 break-all rounded bg-surface px-2 py-1 font-mono text-[11px] text-text-primary">
                      {startCommand}
                    </code>
                    <Button variant="secondary" onClick={() => void copy(startCommand)}>
                      {copied ? t('telegram.copied') : t('telegram.copy')}
                    </Button>
                  </div>
                </div>
              )}

              <p className="text-xs text-warn">
                {t('telegram.bearerWarning', { when: formatExactTime(link.expiresAt) })}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

/**
 * The message the deep link would have sent, for pasting into a chat that
 * already exists.
 *
 * Read out of the URL rather than requested separately: the link *is* the
 * token plus the bot, and asking the server for the same secret twice would
 * mean two ways for it to be stale.
 */
function startCommandFor(url: string): string | null {
  try {
    const token = new URL(url).searchParams.get('start');
    return token === null ? null : `/start ${token}`;
  } catch {
    return null;
  }
}
