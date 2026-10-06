import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderUi, screen, userEvent } from '@noodara/ui/testing';
import { emptyServiceForm, type ServiceFormErrors, type ServiceFormValues } from '../lib/service-form';
import { SourceFields } from './SourceFields';

function Harness({ errors = {}, onChange }: { errors?: ServiceFormErrors; onChange?: (patch: Partial<ServiceFormValues>) => void }) {
  const [values, setValues] = useState(emptyServiceForm());
  return (
    <SourceFields
      values={values}
      errors={errors}
      onChange={(patch) => {
        onChange?.(patch);
        setValues((previous) => ({ ...previous, ...patch }));
      }}
    />
  );
}

describe('SourceFields (13-11 A1, A4)', () => {
  it('offers Git, Dockerfile and Image, starting on Git with repository and branch only', () => {
    renderUi(<Harness />);
    expect(screen.getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['Git', 'Dockerfile', 'Image']);
    expect(screen.getByRole('radio', { name: 'Git' })).toBeChecked();
    expect(screen.getByTestId('source-repositoryUrl')).toBeInTheDocument();
    expect(screen.getByTestId('source-branch')).toHaveValue('main');
    expect(screen.queryByTestId('source-dockerfilePath')).not.toBeInTheDocument();
    expect(screen.queryByTestId('source-imageRef')).not.toBeInTheDocument();
  });

  it('Dockerfile adds the build paths; Image shows only the image reference', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderUi(<Harness onChange={onChange} />);

    await user.click(screen.getByRole('radio', { name: 'Dockerfile' }));
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'dockerfile' });
    expect(screen.getByTestId('source-buildContext')).toHaveValue('.');
    expect(screen.getByTestId('source-dockerfilePath')).toHaveValue('Dockerfile');
    expect(screen.getByTestId('source-target')).toHaveValue('');
    expect(screen.getByTestId('source-repositoryUrl')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Image' }));
    expect(screen.getByTestId('source-imageRef')).toBeInTheDocument();
    expect(screen.queryByTestId('source-repositoryUrl')).not.toBeInTheDocument();
    expect(screen.queryByTestId('source-branch')).not.toBeInTheDocument();
  });

  it('has no environment variable or build argument field in any mode (A4)', async () => {
    const user = userEvent.setup();
    renderUi(<Harness />);
    for (const mode of ['Git', 'Dockerfile', 'Image']) {
      await user.click(screen.getByRole('radio', { name: mode }));
      expect(screen.queryByLabelText(/environment|variable|build arg/i)).not.toBeInTheDocument();
    }
  });

  it('shows a field error under its input and a source error under the control', () => {
    renderUi(<Harness errors={{ repositoryUrl: 'Repository URL scheme must be https:// or ssh://.', source: 'BuildKit is off.' }} />);
    expect(screen.getByTestId('source-repositoryUrl')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Repository URL scheme must be https:// or ssh://.')).toBeInTheDocument();
    expect(screen.getByTestId('source-error')).toHaveTextContent('BuildKit is off.');
  });

  it('reports typed values as patches', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderUi(<Harness onChange={onChange} />);
    await user.type(screen.getByTestId('source-repositoryUrl'), 'h');
    expect(onChange).toHaveBeenLastCalledWith({ repositoryUrl: 'h' });
  });
});
