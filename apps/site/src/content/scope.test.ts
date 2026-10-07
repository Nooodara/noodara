// H1: Verify that every UI label quoted in the first-deploy.mdx guide exists in the web app source.
// This ensures the documentation stays in sync with the actual UI labels.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';

describe('first-deploy.mdx documentation', () => {
  it('all quoted UI labels exist in apps/web/src', () => {
    // Read the first-deploy.mdx file
    const docPath = path.join(process.cwd(), 'apps/site/content/docs/getting-started/first-deploy.mdx');
    const docContent = readFileSync(docPath, 'utf-8');

    // Extract all quoted strings (UI labels). Matches both **text** (bold) and plain **text** markdown.
    // Pattern: **text** captures the exact UI label
    const boldLabelPattern = /\*\*([^*]+)\*\*/g;
    const labels = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = boldLabelPattern.exec(docContent)) !== null) {
      const label = match[1];
      if (label !== undefined) {
        labels.add(label);
      }
    }

    // Known sections or structural labels that are not UI labels
    const nonUILabels = new Set([
      'Name',
      'Source',
      'Server',
      'Logs',
      'Deploy', // when used as section heading, not button
      'Git',
      'Dockerfile',
      'Image',
      'Noodara',
    ]);

    // Verify each label exists in the web source
    const webDir = path.join(process.cwd(), 'apps/web/src');
    const missingLabels: string[] = [];

    for (const label of labels) {
      if (nonUILabels.has(label)) {
        continue;
      }

      try {
        // Search for the exact label in the web source
        const grepResult = execSync(
          `grep -r "${label.replace(/"/g, '\\"')}" "${webDir}" --include="*.tsx" --include="*.ts" 2>/dev/null || true`,
          { encoding: 'utf-8' }
        );

        if (!grepResult.trim()) {
          missingLabels.push(label);
        }
      } catch {
        missingLabels.push(label);
      }
    }

    if (missingLabels.length > 0) {
      throw new Error(`The following UI labels from first-deploy.mdx are not found in apps/web/src: ${missingLabels.join(', ')}`);
    }

    expect(labels.size).toBeGreaterThan(0);
  });
});
