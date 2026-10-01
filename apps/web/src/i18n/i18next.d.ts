import 'i18next';

import type en from './locales/en.json';

/** `t()` is typed against the English catalogue: a key it does not have does not compile. */
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof en };
    returnNull: false;
  }
}
