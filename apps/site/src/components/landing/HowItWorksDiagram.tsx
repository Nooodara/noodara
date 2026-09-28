'use client';

// 10-11-PLAN.md deviation (Rule 3, blocking issue): `'use client'` added when this file was first
// composed into Landing.tsx (a Server Component) -- `@noodara/ui`'s barrel re-exports hook-using
// components with no `'use client'` of their own, so any Server Component importing `Logo` from
// it pulls that whole graph in and fails the build (same reason
// apps/site/src/components/DocsNavTitle.tsx isolates its own Lockup import, 10-05-PLAN.md). This
// component itself uses no hook; the directive only draws the client/server boundary.
//
// 10-09-PLAN.md Task 2 (D-05, T-10-05), compacted in the orchestrator's Round 1 review batch
// (item 5): the brief asked for "a compact three-step numbered sequence" replacing the previous
// full-bleed, oversized diagram (it rendered at the landing's own 1120px content width with no
// cap, dwarfing every other section at 1280px). Fixed with a `max-w-[520px]` centered wrapper, a
// numbered badge per step (the one place this landing uses section numbers -- craft-floor.md's
// own "01/02/03" default is a ban with no brief exception EXCEPT this one, which the Round 1
// brief names explicitly: "a compact three-step numbered sequence"), and once-only
// stroke-dashoffset connectors that draw in when the section scrolls into view (D-18a),
// `prefers-reduced-motion` leaving them fully drawn and static.
//
// Hand-drawn inline SVG in `currentColor` on the brand-kit's own 24-unit grid / 3-unit stroke
// (packages/ui/src/brand/geometry.ts's GRID/STROKE, cited rather than re-imported: the geometry
// primitives are not barrel exports). No third-party icon or illustration -- the VPS outline and
// server stack are drawn here on that same grid; the third node reuses `<Logo />` from
// '@noodara/ui', the one brand mark for "Noodara discovers".
//
// Captions render as ordinary HTML text next to/under the SVG, never SVG <text>, so they scale
// with the app's own type system instead of a fixed SVG font-size. Responsive: a horizontal row
// at >=900px, a stacked column below that breakpoint (UI-SPEC layout contract).
import type { CSSProperties } from 'react';
import { Logo } from '@noodara/ui';

// Mirrors geometry.ts: GRID = 24 units per node, STROKE = 3.
const GRID = 24;
const STROKE = 3;
const NODE_GAP = GRID * 1.5;
const NODE_SIZE = GRID * 1.5;
const VIEW_HEIGHT = NODE_SIZE + GRID / 2;
const NODE_Y = (VIEW_HEIGHT - NODE_SIZE) / 2;
const NODE_X_1 = 0;
const NODE_X_2 = NODE_SIZE + NODE_GAP;
const NODE_X_3 = (NODE_SIZE + NODE_GAP) * 2;
const VIEW_WIDTH = NODE_X_3 + NODE_SIZE;

const ACCESSIBLE_TITLE =
  'How Noodara works: install on an Ubuntu VPS, add servers over SSH, Noodara discovers and watches them';

interface Step {
  readonly number: 1 | 2 | 3;
  readonly caption: string;
}

const STEPS: readonly Step[] = [
  { number: 1, caption: 'Install Noodara on an Ubuntu VPS' },
  { number: 2, caption: 'Add your servers over SSH — no agent' },
  { number: 3, caption: 'Noodara discovers and watches them' },
];

/** A rounded-rect outline standing for the VPS (step 1) -- filled `none`, stroked `currentColor`,
 *  `STROKE`-wide to match the brand kit's own stroke weight. */
function VpsOutline({ x, y }: { x: number; y: number }) {
  const inset = STROKE / 2;
  return (
    <rect
      x={x + inset}
      y={y + inset}
      width={NODE_SIZE - STROKE}
      height={NODE_SIZE - STROKE}
      rx={GRID / 6}
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinejoin="round"
    />
  );
}

/** Three stacked rounded rects standing for the discovered server fleet (step 2). */
function ServerStack({ x, y }: { x: number; y: number }) {
  const barHeight = (NODE_SIZE - GRID / 3) / 3;
  const barGap = GRID / 12;
  return (
    <g>
      {[0, 1, 2].map((row) => (
        <rect
          key={row}
          x={x + GRID / 6}
          y={y + GRID / 6 + row * (barHeight + barGap)}
          width={NODE_SIZE - GRID / 3}
          height={barHeight}
          rx={barHeight / 3}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE}
          strokeLinejoin="round"
        />
      ))}
    </g>
  );
}

/** A straight connector between two adjacent nodes, `currentColor`, `STROKE`-wide. `.site-
 *  connector-draw` (global.css) draws it in once via stroke-dashoffset when the diagram's
 *  RevealSection ancestor reports `data-revealed="true"` (D-18a); `--dash-length` is this
 *  connector's own path length in SVG user units, so the dash pattern always matches exactly. */
function Connector({ fromX, toX, y }: { fromX: number; toX: number; y: number }) {
  const length = Math.abs(toX - fromX);
  const dashStyle = { '--dash-length': length } as CSSProperties;
  return (
    <line
      x1={fromX}
      y1={y}
      x2={toX}
      y2={y}
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinecap="round"
      className="site-connector-draw"
      style={dashStyle}
    />
  );
}

export function HowItWorksDiagram() {
  const centerY = VIEW_HEIGHT / 2;

  return (
    <div className="mx-auto flex w-full max-w-[520px] flex-col gap-6">
      <svg
        role="img"
        aria-label={ACCESSIBLE_TITLE}
        viewBox={`0 0 ${String(VIEW_WIDTH)} ${String(VIEW_HEIGHT)}`}
        className="h-auto w-full text-ink"
        fill="none"
      >
        <title>{ACCESSIBLE_TITLE}</title>
        <Connector fromX={NODE_X_1 + NODE_SIZE} toX={NODE_X_2} y={centerY} />
        <Connector fromX={NODE_X_2 + NODE_SIZE} toX={NODE_X_3} y={centerY} />
        <VpsOutline x={NODE_X_1} y={NODE_Y} />
        <ServerStack x={NODE_X_2} y={NODE_Y} />
        <g
          transform={`translate(${String(NODE_X_3 + NODE_SIZE / 2 - GRID / 2)}, ${String(NODE_Y + NODE_SIZE / 2 - GRID / 2)})`}
        >
          <Logo size={GRID} />
        </g>
      </svg>
      <div className="grid grid-cols-1 gap-4 min-[900px]:grid-cols-3">
        {STEPS.map((step) => (
          <div key={step.caption} className="flex flex-col items-center gap-2 text-center">
            <span className="flex h-6 w-6 items-center justify-center rounded-pill border border-hairline text-caption font-semibold text-ink-secondary">
              {step.number}
            </span>
            <p className="text-body font-normal text-ink-secondary">{step.caption}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
