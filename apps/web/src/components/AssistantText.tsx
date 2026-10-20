import type { ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useRouter } from '@tanstack/react-router';

import { writtenLanguage } from '@traders/shared';

/**
 * An assistant reply, rendered from its markdown by `react-markdown` (the
 * user's choice, 2026-10-12, over extending our concept-text parser): bold,
 * lists, links and the occasional table. Never HTML - raw HTML in the text is
 * not rendered, and neither are images: a reply shows words and links.
 *
 * Links to this app (`/insights`, `/agents/...`) go through the router; any
 * other opens in a new tab. The server has already reduced a link to a page
 * that does not exist to its words (`reply.py`).
 *
 * In the language the question was asked in (D220) - not necessarily the
 * interface's - so it is marked with the language its own text is written in,
 * and takes the direction of that text.
 */
export function AssistantText({ text }: { text: string }) {
  const router = useRouter();
  const components: Components = {
    a: ({ href, children }) => {
      if (href?.startsWith('/')) {
        return (
          <a
            href={href}
            onClick={(event) => {
              event.preventDefault();
              void router.navigate({ to: href } as never);
            }}
            className="text-accent hover:underline"
          >
            {children}
          </a>
        );
      }
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
          {children}
        </a>
      );
    },
    p: ({ children }) => <p className="leading-relaxed">{children}</p>,
    ul: ({ children }) => <ul className="list-disc space-y-1 ps-5">{children}</ul>,
    ol: ({ children }) => <ol className="list-decimal space-y-1 ps-5">{children}</ol>,
    strong: ({ children }) => <strong className="font-semibold text-text-primary">{children}</strong>,
    h1: Heading,
    h2: Heading,
    h3: Heading,
    h4: Heading,
    code: ({ children }) => <code className="rounded bg-surface-hover px-1 text-xs">{children}</code>,
    table: ({ children }) => (
      <div className="overflow-x-auto">
        <table className="w-full text-start text-xs">{children}</table>
      </div>
    ),
    th: ({ children }) => <th className="border-b border-border-subtle px-2 py-1 text-start font-medium">{children}</th>,
    td: ({ children }) => <td className="border-b border-border-subtle px-2 py-1">{children}</td>,
  };
  return (
    <div lang={writtenLanguage(text)} dir="auto" className="space-y-2 text-sm text-text-primary">
      <Markdown remarkPlugins={[remarkGfm]} components={components} disallowedElements={['img']} skipHtml>
        {text}
      </Markdown>
    </div>
  );
}

function Heading({ children }: { children?: ReactNode }) {
  return <p className="font-semibold">{children}</p>;
}
