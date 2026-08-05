# Account profile save and newer-draft race review

Date: 2026-08-05

## Executive conclusion

A reproducible browser-side race allowed an older profile-save response to replace a newer, still-unsaved account-settings draft. The affected draft included both the display name and avatar preview.

The server mutation itself remained scoped to the authenticated account. The defect was in client reconciliation: the response always assigned `state.user` and immediately called `fillAccountSettings()`, regardless of whether the user had changed the visible form after submitting.

## Vulnerable sequence

1. Select avatar A and submit the profile form.
2. The profile PATCH remains in flight.
3. Before it returns, select avatar B, remove the avatar, or edit the display name.
4. The older PATCH response arrives.
5. `fillAccountSettings()` rebuilds the form from the submitted server response and silently discards the newer local draft.

This was possible because only the save button was disabled. Display-name and avatar controls intentionally remained interactive, but response reconciliation did not distinguish the submitted snapshot from newer intent.

## Correction

- Added a separate account-scoped generation for profile-save requests.
- Captured an immutable submitted draft containing account key, normalized name, and avatar value.
- Added `isAccountProfileDraftUnchanged()` as a pure comparison boundary.
- The authenticated user model may accept the current account's successful response, but the settings form is repopulated only when its visible draft still matches the submitted snapshot and no avatar preparation is active.
- Newer name, avatar-selection, avatar-removal, settings-reopen, and account-boundary intent therefore remains visible and available for a subsequent save.
- A programmatic duplicate submit is rejected while a profile save is active.

## Reproduction

```bash
npm run reproduce:account-profile-draft-race
```

Expected corrected fields:

```json
{
  "newerNamePreserved": true,
  "newerAvatarPreserved": true,
  "crossAccountDraftMatches": false
}
```

## Regression coverage

Added `tests/account-profile-save-race.node.test.mjs`, covering:

- same-account and cross-account draft comparison;
- name and avatar changes after submission;
- profile-save generation and duplicate-submit blocking;
- conditional form replacement rather than unconditional `fillAccountSettings()`;
- deterministic vulnerable and corrected reproductions.
