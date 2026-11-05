// 08-09-PLAN.md Task 1 (D-08, UI-11): the default for the `@inspector` parallel-route slot.
// Rendering nothing is what keeps the shell layout's `<aside data-testid="shell-inspector-slot">`
// at zero width and with no border. 30-04: the only content it can show is the AI chat, and only
// when the URL carries `?ask=1` (AskInspector renders nothing otherwise).
import { AskInspector } from './ask-inspector';

export default function InspectorDefault() {
  return <AskInspector />;
}
