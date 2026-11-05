'use client';

// 30-04: one assistant answer, answer first (A2): the answer text, then diagnosis and confidence,
// the entity chips, what evidence was missing (for `unknown`), and the evidence and tools consulted
// behind collapsed disclosures. Model text is rendered only as React text children (A3): no HTML
// parsing and no linkifying, so markup, scripts and URLs in an answer stay inert text (H1). Chips
// link only to routes entity-links.ts built from validated UUIDs.
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Disclosure, TonePill } from '@noodara/ui';
import type { AiAnswer, AiEntity, AiToolCall } from '../../lib/api/ai-api';
import { confidenceLabel, DIAGNOSIS_LABELS, diagnosisTone } from './ai-copy';
import { entityHref, useEntityIndex } from './entity-links';

const CHIP_CLASSES =
  'inline-flex h-6 max-w-full items-center gap-1 rounded-full border border-hairline bg-surface-2 px-2.5 text-caption text-ink';
const LINK_CHIP_CLASSES = `${CHIP_CLASSES} hover:border-hairline-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`;

function EntityChip({ entity, href }: { entity: AiEntity; href: string | null }): ReactNode {
  const body = (
    <>
      <span className="shrink-0 text-ink-tertiary">{entity.kind}</span>
      <span className="truncate">{entity.label}</span>
    </>
  );
  if (href === null) {
    return (
      <span data-testid="ai-entity-chip" data-kind={entity.kind} className={CHIP_CLASSES}>
        {body}
      </span>
    );
  }
  return (
    <Link href={href} data-testid="ai-entity-chip" data-kind={entity.kind} className={LINK_CHIP_CLASSES}>
      {body}
    </Link>
  );
}

export function ToolCallList({ calls }: { calls: readonly AiToolCall[] }): ReactNode {
  return (
    <ul data-testid="ai-tools-list" className="flex flex-col gap-1 px-1 pb-1">
      {calls.map((call, position) => (
        // Calls are append-only and never reordered; the same tool can run twice.
        <li key={position} className="flex items-baseline gap-2 text-caption text-ink-secondary">
          <span className="font-mono text-ink">{call.name}</span>
          {call.scope === null ? null : <span>{call.scope.kind}</span>}
        </li>
      ))}
    </ul>
  );
}

export interface AiAnswerViewProps {
  readonly answer: AiAnswer;
  readonly toolCalls: readonly AiToolCall[];
}

export function AiAnswerView({ answer, toolCalls }: AiAnswerViewProps): ReactNode {
  const index = useEntityIndex(answer.entities);
  return (
    <div data-testid="ai-answer" className="flex flex-col gap-3">
      <p data-testid="ai-answer-text" className="whitespace-pre-wrap break-words text-body text-ink">
        {answer.answer}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <TonePill tone={diagnosisTone(answer.diagnosis)} label={DIAGNOSIS_LABELS[answer.diagnosis]} data-testid="ai-diagnosis" />
        <span data-testid="ai-confidence" className="text-caption text-ink-secondary">
          {confidenceLabel(answer.confidence)}
        </span>
      </div>

      {answer.entities.length > 0 ? (
        <ul aria-label="Related resources" data-testid="ai-entities" className="flex flex-wrap gap-1.5">
          {answer.entities.map((entity) => (
            <li key={`${entity.kind}:${entity.id}`} className="min-w-0 max-w-full">
              <EntityChip entity={entity} href={entityHref(entity, index)} />
            </li>
          ))}
        </ul>
      ) : null}

      {answer.diagnosis === 'unknown' ? (
        <div data-testid="ai-missing-evidence" className="flex flex-col gap-1 rounded-[10px] bg-surface-2 px-3 py-2">
          <span className="text-callout font-medium text-ink">Missing evidence</span>
          {answer.missingEvidence.length > 0 ? (
            <ul className="flex list-disc flex-col gap-0.5 pl-4 text-callout text-ink-secondary">
              {answer.missingEvidence.map((note, position) => (
                <li key={position} className="break-words">
                  {note}
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-callout text-ink-secondary">The assistant did not say which evidence was missing.</span>
          )}
        </div>
      ) : null}

      {answer.evidence.length > 0 ? (
        <Disclosure title={`Evidence (${String(answer.evidence.length)})`} data-testid="ai-evidence">
          <ul data-testid="ai-evidence-list" className="flex flex-col gap-1.5 px-1 pb-1">
            {answer.evidence.map((item, position) => (
              <li key={position} className="flex flex-col text-caption">
                <span className="truncate font-mono text-ink-secondary">{item.ref}</span>
                {item.note === '' ? null : <span className="break-words text-ink">{item.note}</span>}
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}

      <Disclosure title={`Tools consulted (${String(toolCalls.length)})`} data-testid="ai-tools">
        {toolCalls.length > 0 ? (
          <ToolCallList calls={toolCalls} />
        ) : (
          <p className="px-1 pb-1 text-caption text-ink-secondary">No tools were needed for this answer.</p>
        )}
      </Disclosure>
    </div>
  );
}
