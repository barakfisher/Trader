// @vitest-environment jsdom
/** The wait budget reaches Testing Library, through React's wrapper of it. */

import { expect, it } from 'vitest';
import '@testing-library/react';
import { getConfig } from '@testing-library/dom';

import { DOM_WAIT_BUDGET_MS } from './waitBudget.ts';

it('is the budget findBy and waitFor use, after the React wrapper configured its own hooks', () => {
  expect(getConfig().asyncUtilTimeout).toBe(DOM_WAIT_BUDGET_MS);
});
