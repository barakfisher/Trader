/**
 * A form field's draft of a value the server stores: it starts as the stored
 * value, the user edits it, and it is reset whenever the stored value changes
 * (it arrived, or a save replaced it).
 *
 * The reset happens during render, not in an effect. An effect runs after the
 * commit, so a card that mounted before its data arrived committed one frame
 * with the form shown and the field still empty, and only the next render
 * filled it. A user could see the flash; a test that found the field in that
 * frame read '' (the admin page's limits, intermittently under CPU load).
 * Setting state while rendering makes React re-render before anything is
 * committed, so no frame ever shows the field out of step with the value.
 */

import { useState, type Dispatch, type SetStateAction } from 'react';

export function useDraft(stored: string): [string, Dispatch<SetStateAction<string>>] {
  const [draft, setDraft] = useState(stored);
  const [draftOf, setDraftOf] = useState(stored);
  if (draftOf !== stored) {
    setDraftOf(stored);
    setDraft(stored);
  }
  return [draft, setDraft];
}
