/**
 * Persona templates: starting text for a new agent's name and persona.
 *
 * A template is UI copy, not stored state - its words live in the catalogue in
 * every language, and once applied they are the user's text like any other.
 * Applying one never overwrites what the user wrote: a field is filled only
 * while it is empty or still holds a template's words untouched, so switching
 * between templates works and a typed persona is never lost to a click.
 */

import { t } from '../i18n/index.ts';

export const PERSONA_TEMPLATES = ['warren', 'george', 'ray', 'cathie'] as const;
export type PersonaTemplate = (typeof PERSONA_TEMPLATES)[number];

export function templateName(template: PersonaTemplate): string {
  return t(`agents.templates.${template}.name`);
}

export function templatePersona(template: PersonaTemplate): string {
  return t(`agents.templates.${template}.persona`);
}

/** Whether a template may replace `value`: it is empty, or one template's words unedited. */
export function replaceableBy(value: string, words: (template: PersonaTemplate) => string): boolean {
  const trimmed = value.trim();
  return trimmed === '' || PERSONA_TEMPLATES.some((template) => words(template) === trimmed);
}
