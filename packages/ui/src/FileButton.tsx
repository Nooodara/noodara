import { useId, useRef, type ChangeEvent } from 'react';
import * as VisuallyHidden from '@radix-ui/react-visually-hidden';
import { Button } from './Button.js';

export interface FileButtonProps {
  readonly label?: string;
  readonly accept?: string;
  readonly disabled?: boolean;
  readonly onText: (text: string) => void;
  readonly onError: (message: string) => void;
}

// D-04's boundary: a read failure never surfaces the browser's own FileReader error (which can
// echo a path fragment or a decoding detail) and never the file's own contents -- always this
// one fixed sentence, the same discipline the backend's own error responses follow.
const READ_ERROR_MESSAGE = 'Could not read the selected file. Try again, or paste the value instead.';

// 05-17-PLAN.md security item 4: a private key is a few KB at most (even RSA-4096 in PEM form) --
// 64KB is a generous ceiling that still rejects an obviously-wrong file (a whole disk image, a
// screenshot, ...) before ever reading it into memory or handing its contents to a caller.
const MAX_FILE_BYTES = 64 * 1024;
const FILE_TOO_LARGE_MESSAGE = 'This file is too large. Choose a smaller key file, or paste the value instead.';

// FileButton (D-04, 05-UI-SPEC.md SS2.4 "Choose file") -- a ghost Button that triggers a
// visually-hidden native file input and reads the chosen file entirely client-side with
// FileReader.readAsText. The resulting text is handed to the caller's onText callback and
// nowhere else: this component never places it in a browser-persisted store of any kind, never
// writes it to the developer console, never renders it into a URL, and the request body it
// eventually feeds stays the same JSON shape the paste path already produces -- there is no
// second, binary upload path here. The input's value is cleared after every read (success or
// failure) so re-selecting the same path always fires a fresh read.
export function FileButton({ label = 'Choose file', accept, disabled = false, onText, onError }: FileButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) {
      return;
    }

    if (file.size > MAX_FILE_BYTES) {
      onError(FILE_TOO_LARGE_MESSAGE);
      input.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      onText(typeof result === 'string' ? result : '');
      input.value = '';
    };
    reader.onerror = () => {
      onError(READ_ERROR_MESSAGE);
      input.value = '';
    };
    reader.readAsText(file);
  };

  return (
    <span className="inline-flex items-center">
      <Button
        type="button"
        variant="ghost"
        disabled={disabled}
        onClick={() => {
          inputRef.current?.click();
        }}
      >
        {label}
      </Button>
      <VisuallyHidden.Root>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          disabled={disabled}
          onChange={handleChange}
          tabIndex={-1}
          {...(accept === undefined ? {} : { accept })}
        />
      </VisuallyHidden.Root>
    </span>
  );
}
