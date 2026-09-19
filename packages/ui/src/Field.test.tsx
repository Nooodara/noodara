import { describe, expect, it } from 'vitest';
import { Field } from './Field.js';
import { renderUi, screen } from './testing/render.js';

// A plain <input> is used as the child control throughout so these tests exercise only
// Field's own label/help/error/aria wiring, never a real Input/Textarea component
// (05-08-PLAN.md Task 1's own read_first note).

describe('Field', () => {
  it('associates the label with the control, so getByLabelText resolves to it', () => {
    renderUi(<Field label="Name">{(controlProps) => <input {...controlProps} />}</Field>);

    expect(screen.getByLabelText('Name')).toBeInstanceOf(HTMLInputElement);
  });

  it('includes the help id in aria-describedby and renders the help text when help is supplied', () => {
    renderUi(
      <Field label="Host" help="Hostname or IP address">
        {(controlProps) => <input {...controlProps} />}
      </Field>,
    );

    const control = screen.getByLabelText('Host');
    const helpEl = screen.getByText('Hostname or IP address');

    expect(control.getAttribute('aria-describedby')).toContain(helpEl.id);
  });

  it('sets aria-invalid and renders the error inside role="alert", referenced by aria-describedby, when error is supplied', () => {
    renderUi(
      <Field label="SSH port" error="Port must be between 1 and 65535">
        {(controlProps) => <input {...controlProps} />}
      </Field>,
    );

    const control = screen.getByLabelText('SSH port');
    const errorEl = screen.getByRole('alert');

    expect(control).toHaveAttribute('aria-invalid', 'true');
    expect(errorEl).toHaveTextContent('Port must be between 1 and 65535');
    expect(control.getAttribute('aria-describedby')).toContain(errorEl.id);
  });

  it('has no aria-invalid attribute and renders no role="alert" element when error is absent', () => {
    renderUi(<Field label="Name">{(controlProps) => <input {...controlProps} />}</Field>);

    expect(screen.getByLabelText('Name')).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('references both the help id and the error id in aria-describedby when both are supplied', () => {
    renderUi(
      <Field label="Credential" help="ed25519 keys are recommended." error="This credential could not be parsed.">
        {(controlProps) => <input {...controlProps} />}
      </Field>,
    );

    const control = screen.getByLabelText('Credential');
    const helpEl = screen.getByText('ed25519 keys are recommended.');
    const errorEl = screen.getByRole('alert');
    const describedBy = control.getAttribute('aria-describedby') ?? '';

    expect(describedBy).toContain(helpEl.id);
    expect(describedBy).toContain(errorEl.id);
  });

  it('renders the error text exactly as passed, never composed, prefixed or reformatted', () => {
    const message = 'A server named "web-01" already exists.';

    renderUi(<Field label="Name" error={message}>{(controlProps) => <input {...controlProps} />}</Field>);

    expect(screen.getByRole('alert')).toHaveTextContent(message);
  });
});
