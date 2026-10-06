import { describe, expect, it } from 'vitest';
import {
  deploymentInspectorHref,
  INSPECTOR_SLOT_CLASSES,
  inspectorSelection,
  RUNTIME_LOGS_INSPECTOR_HREF,
} from './inspector-route';

const DEPLOYMENT_ID = '00000000-0000-4000-8000-000000000001';

describe('inspectorSelection', () => {
  it('is null when nothing is selected, so the slot stays empty', () => {
    expect(inspectorSelection(new URLSearchParams(''))).toBeNull();
    expect(inspectorSelection(new URLSearchParams('tab=other'))).toBeNull();
  });

  it('reads a deployment selection from the URL', () => {
    expect(inspectorSelection(new URLSearchParams(`deployment=${DEPLOYMENT_ID}`))).toEqual({
      kind: 'deployment',
      deploymentId: DEPLOYMENT_ID,
    });
  });

  it('turns a malformed deployment id into a not-found selection, never a fetch', () => {
    expect(inspectorSelection(new URLSearchParams('deployment=../../etc'))).toEqual({
      kind: 'not-found',
    });
    expect(inspectorSelection(new URLSearchParams('deployment='))).toEqual({
      kind: 'not-found',
    });
  });

  it('reads the runtime logs selection', () => {
    expect(inspectorSelection(new URLSearchParams('logs=runtime'))).toEqual({
      kind: 'runtime',
    });
    expect(inspectorSelection(new URLSearchParams('logs=other'))).toBeNull();
  });
});

describe('inspector hrefs', () => {
  it('select through the query string of the current page', () => {
    expect(deploymentInspectorHref(DEPLOYMENT_ID)).toBe(`?deployment=${DEPLOYMENT_ID}`);
    expect(RUNTIME_LOGS_INSPECTOR_HREF).toBe('?logs=runtime');
  });
});

describe('INSPECTOR_SLOT_CLASSES', () => {
  it('keeps the empty slot at zero width and only sizes a populated one', () => {
    expect(INSPECTOR_SLOT_CLASSES).toContain('w-0 border-0');
    for (const token of INSPECTOR_SLOT_CLASSES.split(/\s+/).filter(
      (t) => /(^|:)w-/.test(t) && t !== 'w-0',
    )) {
      expect(token.startsWith('has-[>*]:')).toBe(true);
    }
  });

  it('is a full-height, full-width sheet on a phone and a 384px panel above it', () => {
    expect(INSPECTOR_SLOT_CLASSES).toContain('has-[>*]:max-[639px]:w-full');
    expect(INSPECTOR_SLOT_CLASSES).toContain('has-[>*]:max-[1279px]:inset-y-0');
    expect(INSPECTOR_SLOT_CLASSES).toContain('has-[>*]:min-[640px]:max-[1279px]:w-[384px]');
    expect(INSPECTOR_SLOT_CLASSES).toContain('has-[>*]:min-[1280px]:w-[384px]');
  });
});
