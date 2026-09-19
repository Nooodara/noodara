// 05-17-PLAN.md Task 2, RED gate for the D-04 credential block: default selection, autoComplete
// off on every credential-bearing input, edit-mode dots-plus-Replace collapse, branch switching
// with no residual value, and no value echoed into a second attribute anywhere in the render.
// ADR-0005's division of labour: this file proves the block's own props/state contract in jsdom;
// the full flow (request content type, storage, history) is Task 3's Playwright `@sheet` spec.
//
// "Every textbox-role element" (05-17-PLAN.md's own wording) is queried at the DOM level
// (`input, textarea`, excluding the FileButton's own `type="file"` trigger), not via
// `getByRole('textbox')` -- a `type="password"` input carries no ARIA "textbox" role per the
// HTML-AAM spec, so a role-based query would silently skip the exact fields this test cares most
// about (the passphrase and password inputs). This is a deliberate strengthening of the plan's own
// wording, not a narrower interpretation of it.
import { describe, expect, it } from 'vitest';
import { renderUi, screen, userEvent, within } from '@noodara/ui/testing';
import { CredentialFields } from './CredentialFields';

function credentialInputs(container: HTMLElement): (HTMLInputElement | HTMLTextAreaElement)[] {
  return Array.from(container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')).filter(
    (el) => el.getAttribute('type') !== 'file',
  );
}

describe('CredentialFields', () => {
  it('renders Private key as the checked segment on first render in create mode', () => {
    renderUi(<CredentialFields mode="create" onChange={() => undefined} />);

    const group = screen.getByTestId('server-sheet-credential-type');
    expect(within(group).getByRole('radio', { name: 'Private key' })).toHaveAttribute('data-state', 'checked');
    expect(within(group).getByRole('radio', { name: 'Password' })).toHaveAttribute('data-state', 'unchecked');
  });

  it('carries autoComplete="off" on every credential-bearing input in both branches', async () => {
    const user = userEvent.setup();
    const { container } = renderUi(<CredentialFields mode="create" onChange={() => undefined} />);

    const privateKeyBranchInputs = credentialInputs(container);
    expect(privateKeyBranchInputs.length).toBeGreaterThan(0);
    for (const el of privateKeyBranchInputs) {
      expect(el).toHaveAttribute('autocomplete', 'off');
    }

    await user.click(within(screen.getByTestId('server-sheet-credential-type')).getByRole('radio', { name: 'Password' }));

    const passwordBranchInputs = credentialInputs(container);
    expect(passwordBranchInputs.length).toBeGreaterThan(0);
    for (const el of passwordBranchInputs) {
      expect(el).toHaveAttribute('autocomplete', 'off');
    }
  });

  it('switching from Private key to Password removes the key/passphrase fields and renders one masked password input, and switching back removes it', async () => {
    const user = userEvent.setup();
    renderUi(<CredentialFields mode="create" onChange={() => undefined} />);

    expect(screen.getByLabelText('Private key')).toBeInTheDocument();
    expect(screen.getByLabelText('Passphrase')).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();

    await user.click(within(screen.getByTestId('server-sheet-credential-type')).getByRole('radio', { name: 'Password' }));

    expect(screen.queryByLabelText('Private key')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Passphrase')).not.toBeInTheDocument();
    const passwordInput = screen.getByLabelText('Password');
    expect(passwordInput).toHaveAttribute('type', 'password');

    await user.click(within(screen.getByTestId('server-sheet-credential-type')).getByRole('radio', { name: 'Private key' }));

    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Private key')).toBeInTheDocument();
  });

  it('a value typed into one branch is absent from the document after switching branches', async () => {
    const user = userEvent.setup();
    const { container } = renderUi(<CredentialFields mode="create" onChange={() => undefined} />);

    const secret = 'distinctive-fake-key-zK9qL';
    await user.type(screen.getByLabelText('Private key'), secret);
    expect(screen.getByLabelText('Private key')).toHaveValue(secret);

    await user.click(within(screen.getByTestId('server-sheet-credential-type')).getByRole('radio', { name: 'Password' }));

    expect(container.innerHTML.includes(secret)).toBe(false);
  });

  it('renders the ed25519 help text only in the private-key branch', async () => {
    const user = userEvent.setup();
    renderUi(<CredentialFields mode="create" onChange={() => undefined} />);

    expect(screen.getByText('ed25519 keys are recommended.')).toBeInTheDocument();

    await user.click(within(screen.getByTestId('server-sheet-credential-type')).getByRole('radio', { name: 'Password' }));

    expect(screen.queryByText('ed25519 keys are recommended.')).not.toBeInTheDocument();
  });

  it('in edit mode renders no textbox at all until Replace is activated, then renders empty fields', async () => {
    const user = userEvent.setup();
    renderUi(<CredentialFields mode="edit" onChange={() => undefined} />);

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Private key')).not.toBeInTheDocument();
    expect(screen.getByText('••••••••')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replace' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Replace' }));

    expect(screen.queryByText('••••••••')).not.toBeInTheDocument();
    const privateKeyField = screen.getByLabelText('Private key');
    expect(privateKeyField).toHaveValue('');
    expect(screen.getByLabelText('Passphrase')).toHaveValue('');
  });

  it('a typed key appears only in the textarea\'s value and in no other attribute in the render', async () => {
    const user = userEvent.setup();
    const secret = '-----BEGIN OPENSSH PRIVATE KEY-----zK9qLdistinctive';
    const { container } = renderUi(<CredentialFields mode="create" onChange={() => undefined} />);
    const textarea = screen.getByLabelText('Private key');

    await user.type(textarea, secret);
    expect(textarea).toHaveValue(secret);

    const otherAttributeValues = Array.from(container.querySelectorAll('*')).flatMap((el) =>
      Array.from(el.attributes)
        .filter((attr) => !(el === textarea && attr.name === 'value'))
        .map((attr) => attr.value),
    );
    expect(otherAttributeValues.some((value) => value.includes(secret))).toBe(false);
  });

  it('unmounting and remounting the block in the same test renders empty fields again', async () => {
    const user = userEvent.setup();
    const { unmount } = renderUi(<CredentialFields mode="create" onChange={() => undefined} />);

    await user.type(screen.getByLabelText('Private key'), 'a-value-that-must-not-survive');
    expect(screen.getByLabelText('Private key')).toHaveValue('a-value-that-must-not-survive');

    unmount();

    renderUi(<CredentialFields mode="create" onChange={() => undefined} />);
    expect(screen.getByLabelText('Private key')).toHaveValue('');
  });
});
