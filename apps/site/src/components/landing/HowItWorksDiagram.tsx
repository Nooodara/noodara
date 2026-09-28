'use client';

// 10-11-PLAN.md deviation (Rule 3, blocking issue): `'use client'` added when this file was first
// composed into Landing.tsx (a Server Component) -- `@noodara/ui`'s barrel re-exports hook-using
// components with no `'use client'` of their own, so any Server Component importing `Logo` from
// it pulls that whole graph in and fails the build (same reason
// apps/site/src/components/DocsNavTitle.tsx isolates its own Lockup import, 10-05-PLAN.md). This
// component itself uses no hook; the directive only draws the client/server boundary.
//
// 10-09-PLAN.md Task 2 (D-05, T-10-05). "How it works" in three steps, hand-drawn inline SVG in
// `currentColor` on the brand-kit's own 24-unit grid / 3-unit stroke (packages/ui/src/brand/
// geometry.ts's GRID/STROKE, cited rather than re-imported: the geometry primitives are not
// barrel exports, per this plan's own interfaces note). No third-party icon or illustration --
// the VPS outline and server stack are drawn here on that same grid; the third node reuses
// `<Logo />` from '@noodara/ui', the one brand mark for "Noodara discovers".
//
// Captions render as ordinary HTML text next to/under the SVG, never SVG <text>, so they scale
// with the app's own type system instead of a fixed SVG font-size. Responsive: a horizontal row
// at >=900px, a stacked column below that breakpoint (UI-SPEC layout contract). No animation --
// D-18 reserves the one motion moment for the hero's own aperture focus, not this diagram.
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
  readonly caption: string;
}

const STEPS: readonly Step[] = [
  { caption: 'Install Noodara on an Ubuntu VPS' },
  { caption: 'Add your servers over SSH — no agent' },
  { caption: 'Noodara discovers and watches them' },
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

/** A straight connector between two adjacent nodes, `currentColor`, `STROKE`-wide. */
function Connector({ fromX, toX, y }: { fromX: number; toX: number; y: number }) {
  return <line x1={fromX} y1={y} x2={toX} y2={y} stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />;
}

export function HowItWorksDiagram() {
  const centerY = VIEW_HEIGHT / 2;

  return (
    <div className="flex flex-col gap-6 min-[900px]:gap-4">
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
      <div className="grid grid-cols-1 gap-4 text-center min-[900px]:grid-cols-3">
        {STEPS.map((step) => (
          <p key={step.caption} className="text-body font-normal text-ink-secondary">
            {step.caption}
          </p>
        ))}
      </div>
    </div>
  );
}
