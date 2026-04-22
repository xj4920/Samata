/**
 * User Workspace — per (user x agent) markdown file storing preferences and session summaries.
 *
 * File layout: data/workspaces/{agentName}/{userId}.md
 */
import fs from 'fs';
import { resolve, join, dirname } from 'path';

const WORKSPACES_DIR = resolve(process.cwd(), 'data/workspaces');

export function getWorkspacePath(agentName: string, userId: string): string {
  return join(WORKSPACES_DIR, agentName, `${userId}.md`);
}

export function loadWorkspace(agentName: string, userId: string): string {
  const filePath = getWorkspacePath(agentName, userId);
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf-8');
}

export function writeWorkspace(agentName: string, userId: string, content: string): void {
  const filePath = getWorkspacePath(agentName, userId);
  fs.mkdirSync(dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

/**
 * Parse workspace md into sections: { '偏好': ['line1', 'line2'], '近期对话': [...] }
 */
export function parseWorkspaceSections(content: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let currentSection = '';
  for (const line of content.split('\n')) {
    const heading = line.match(/^##\s+(.+)/);
    if (heading) {
      currentSection = heading[1].trim();
      if (!sections.has(currentSection)) sections.set(currentSection, []);
    } else if (currentSection) {
      sections.get(currentSection)!.push(line);
    }
  }
  return sections;
}

function renderSections(sections: Map<string, string[]>): string {
  const parts: string[] = [];
  for (const [name, lines] of sections) {
    parts.push(`## ${name}`);
    parts.push(...lines);
  }
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

const MAX_RECENT_SESSIONS = 10;

/**
 * Append a session summary line and optionally merge new preferences.
 * Keeps only the most recent MAX_RECENT_SESSIONS entries in "近期对话".
 */
export function updateWorkspace(
  agentName: string,
  userId: string,
  summary: string,
  newPreferences: string[],
): void {
  const existing = loadWorkspace(agentName, userId);
  const sections = existing ? parseWorkspaceSections(existing) : new Map<string, string[]>();

  // Preferences section
  if (!sections.has('偏好')) sections.set('偏好', ['']);
  if (newPreferences.length > 0) {
    const prefLines = sections.get('偏好')!;
    const existingSet = new Set(prefLines.map(l => l.replace(/^-\s*/, '').trim()).filter(Boolean));
    for (const pref of newPreferences) {
      if (!existingSet.has(pref)) {
        prefLines.push(`- ${pref}`);
        existingSet.add(pref);
      }
    }
  }

  // Recent sessions section
  if (!sections.has('近期对话')) sections.set('近期对话', ['']);
  const sessionLines = sections.get('近期对话')!;
  const today = new Date().toISOString().slice(0, 10);
  sessionLines.push(`- ${today}: ${summary}`);

  // Trim to keep only the most recent entries
  const bulletLines = sessionLines.filter(l => l.startsWith('- '));
  if (bulletLines.length > MAX_RECENT_SESSIONS) {
    const keep = bulletLines.slice(-MAX_RECENT_SESSIONS);
    sections.set('近期对话', ['', ...keep]);
  }

  writeWorkspace(agentName, userId, renderSections(sections));
}
