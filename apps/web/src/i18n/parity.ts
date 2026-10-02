/**
 * What a translated catalogue must have in common with the English one.
 *
 * TypeScript checks the keys code asks for against English; it cannot check
 * that another language has them, because i18next looks a translation up at
 * runtime and quietly falls back to English when it is missing. A Hebrew page
 * with one English sentence in it is the failure this module exists to turn
 * into a red test (`test/i18n.test.ts`) instead.
 *
 * Four things must agree, per key:
 *  - the key exists - in every plural form the language uses, where English
 *    has a plural (`findings_one`/`findings_other` -> Hebrew's `_one`, `_two`,
 *    `_other`, from `Intl.PluralRules`), and nowhere English has none;
 *  - no key exists that English has dropped (a stale translation is dead copy);
 *  - the placeholders: a translation without `{{symbol}}` loses the figure;
 *  - the markup tags `<Trans>` fills (`<code>`, `<strong>`, `<delta>`).
 */

export type Catalogue = { [key: string]: string | Catalogue };

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

export function flatten(catalogue: Catalogue, prefix = ''): Map<string, string> {
  const flat = new Map<string, string>();
  for (const [key, value] of Object.entries(catalogue)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') flat.set(path, value);
    else for (const [inner, text] of flatten(value, path)) flat.set(inner, text);
  }
  return flat;
}

/** The placeholders and tags a string uses, as one sorted signature. */
export function slots(text: string): string {
  const placeholders = [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((match) => `{{${match[1]}}}`);
  const tags = [...text.matchAll(/<\/?(\w+)\s*\/?>/g)].map((match) => `<${match[1]}>`);
  return [...new Set([...placeholders, ...tags])].sort().join(' ');
}

/** Every disagreement between `target` (in `language`) and the English `source`, as sentences. */
export function catalogueProblems(source: Catalogue, target: Catalogue, language: string): string[] {
  const english = flatten(source);
  const translated = flatten(target);
  const categories = new Intl.PluralRules(language).resolvedOptions().pluralCategories;
  const problems: string[] = [];

  // English keys grouped by stem: `findings` -> its `_one`/`_other` forms.
  const stems = new Map<string, string[]>();
  for (const key of english.keys()) {
    const stem = key.replace(PLURAL_SUFFIX, '');
    stems.set(stem, [...(stems.get(stem) ?? []), key]);
  }

  const expected = new Set<string>();
  for (const [stem, forms] of stems) {
    const plural = forms.some((key) => PLURAL_SUFFIX.test(key));
    const wanted = plural ? categories.map((category) => `${stem}_${category}`) : [stem];
    // The signature English uses for this text; plural forms share one.
    const signature = slots(english.get(forms.find((key) => key.endsWith('_other')) ?? forms[0]!)!);
    for (const key of wanted) {
      expected.add(key);
      const text = translated.get(key);
      if (text === undefined) {
        problems.push(`${language}: missing "${key}"`);
        continue;
      }
      // A singular or dual form may name its count in words ("one finding", Hebrew's dual).
      const own = slots(text);
      const relaxed = /_(one|two)$/.test(key)
        ? signature
            .split(' ')
            .filter((slot) => slot !== '{{count}}')
            .join(' ')
        : null;
      if (own !== signature && own !== relaxed) {
        problems.push(`${language}: "${key}" uses ${own || 'nothing'}, English uses ${signature || 'nothing'}`);
      }
    }
  }

  for (const key of translated.keys()) {
    if (!expected.has(key)) problems.push(`${language}: "${key}" is not in the English catalogue`);
  }
  return problems;
}
