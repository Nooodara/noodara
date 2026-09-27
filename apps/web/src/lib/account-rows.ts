// SET-06/D-17 -- editable account rows are a structurally distinct type from `SettingsRow`
// (apps/web/src/lib/settings-rows.ts). `SettingsRow` can never carry an edit handler; this module
// is the only place an editable row's shape lives, and it is deliberately handler-free itself --
// the actual `onClick`/open-sheet handlers are wired in
// apps/web/src/components/SettingsGroups.tsx, which owns each row's own Sheet/open state, keeping
// this type pure data (settings-rows.test.ts carries the @ts-expect-error proof that the two types
// are not interchangeable).
export type AccountRowField = 'name' | 'email' | 'password';

export interface EditableAccountRow {
  readonly field: AccountRowField;
  readonly label: string;
  readonly value: string | null;
  readonly action: 'Edit' | 'Change';
}

const LABELS: Record<AccountRowField, string> = {
  name: 'Name',
  email: 'Email',
  password: 'Password',
};

/**
 * accountRows -- the `Account` group's three rows (09-UI-SPEC.md §1.1). The Password row's value
 * is always `null`: never a credential, not even masked (§9 #16). A `null` user (the session store
 * has not resolved yet) degrades Name/Email to `''` rather than throwing -- the page shows
 * skeleton text in that state instead.
 */
export function accountRows(user: { readonly name: string; readonly email: string } | null): readonly EditableAccountRow[] {
  return [
    { field: 'name', label: LABELS.name, value: user?.name ?? '', action: 'Edit' },
    { field: 'email', label: LABELS.email, value: user?.email ?? '', action: 'Edit' },
    { field: 'password', label: LABELS.password, value: null, action: 'Change' },
  ];
}
