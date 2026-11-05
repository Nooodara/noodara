// 13-14: every route without its own inspector renders an empty slot. A soft navigation keeps an
// unmatched parallel slot showing what it had, so without this the service inspector would stay
// open after leaving the service page; matching here (and rendering nothing) closes it.
// 30-04: the one exception is `?ask=1`, which opens the AI chat on any page.
import { AskInspector } from '../ask-inspector';

export default function InspectorEmpty() {
  return <AskInspector />;
}
