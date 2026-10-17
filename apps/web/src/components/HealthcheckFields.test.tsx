import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { renderUi, screen, userEvent } from '@noodara/ui/testing';
import { emptyHealthcheckForm, type HealthcheckFormErrors } from '../lib/healthcheck-form';
import { HealthcheckFields } from './HealthcheckFields';

function Harness({ errors = {} }: { errors?: HealthcheckFormErrors }) {
  const [values, setValues] = useState(emptyHealthcheckForm());
  return <HealthcheckFields values={values} errors={errors} onChange={(patch) => { setValues((previous) => ({ ...previous, ...patch })); }} />;
}

describe('HealthcheckFields (19-02)', () => {
  it('starts on "Container is running" with no probe fields', () => {
    renderUi(<Harness />);
    expect(screen.getByRole('radio', { name: /Container is running/ })).toBeChecked();
    expect(screen.queryByTestId('healthcheck-probe-fields')).not.toBeInTheDocument();
  });

  it('HTTP reveals path, port and status; TCP only the port', async () => {
    const user = userEvent.setup();
    renderUi(<Harness />);
    await user.click(screen.getByRole('radio', { name: /HTTP request/ }));
    expect(screen.getByTestId('healthcheck-path')).toBeInTheDocument();
    expect(screen.getByTestId('healthcheck-port')).toBeInTheDocument();
    expect(screen.getByTestId('healthcheck-statuses')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /TCP connection/ }));
    expect(screen.getByTestId('healthcheck-port')).toBeInTheDocument();
    expect(screen.queryByTestId('healthcheck-path')).not.toBeInTheDocument();
    expect(screen.queryByTestId('healthcheck-statuses')).not.toBeInTheDocument();
  });

  it('auto-rollback is a labelled switch, on by default', async () => {
    const user = userEvent.setup();
    renderUi(<Harness />);
    const toggle = screen.getByRole('switch', { name: 'Roll back automatically' });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(toggle).not.toBeChecked();
  });

  it('shows errors under their fields', async () => {
    const user = userEvent.setup();
    renderUi(<Harness errors={{ path: 'Bad path.', healthcheck: 'Too long.' }} />);
    expect(screen.getByTestId('healthcheck-error')).toHaveTextContent('Too long.');
    await user.click(screen.getByRole('radio', { name: /HTTP request/ }));
    expect(screen.getByText('Bad path.')).toBeInTheDocument();
  });
});
