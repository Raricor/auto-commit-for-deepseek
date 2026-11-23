import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface RunLogFile {
    filePath: string;
    fileName: string;
    label: string;
    description: string;
    detail: string;
}

interface RunLine {
    type?: unknown;
    startedAt?: unknown;
    repo?: unknown;
    trigger?: unknown;
}

interface EndLine {
    type?: unknown;
    status?: unknown;
    totals?: { requests?: unknown };
}

/**
 * Reads the run record headers and end rows. Malformed or legacy files are
 * still listed with whatever metadata can be recovered.
 */
export async function listRunLogs(directory: string): Promise<RunLogFile[]> {
    let names: string[];
    try {
        names = (await readdir(directory, { withFileTypes: true }))
            .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
            .map((entry) => entry.name)
            .sort()
            .reverse();
    } catch {
        return [];
    }

    const files: RunLogFile[] = [];
    for (const fileName of names) {
        const filePath = join(directory, fileName);
        let text: string;
        try {
            text = await readFile(filePath, 'utf8');
        } catch {
            continue;
        }

        let run: RunLine | undefined;
        let end: EndLine | undefined;
        let candidates = 0;
        for (const line of text.split(/\r?\n/)) {
            if (!line.trim()) { continue; }
            let record: { type?: unknown };
            try {
                record = JSON.parse(line) as { type?: unknown };
            } catch {
                continue;
            }
            if (record.type === 'run') { run = record as RunLine; }
            else if (record.type === 'end') { end = record as EndLine; }
            else if (record.type === 'candidate') { candidates += 1; }
        }

        const repo = typeof run?.repo === 'string' ? run.repo : 'unknown';
        const trigger = typeof run?.trigger === 'string' ? run.trigger : 'run';
        const startedAt = typeof run?.startedAt === 'string' ? run.startedAt : undefined;
        files.push({
            filePath,
            fileName,
            label: formatLabel(startedAt, fileName),
            description: `${repo} · ${trigger}`,
            detail: formatDetail(end, candidates),
        });
    }
    return files;
}

function formatDetail(end: EndLine | undefined, candidates: number): string {
    if (!end || typeof end.status !== 'string') { return ''; }
    const requests = asNumber(end.totals?.requests);
    const parts = [end.status];
    if (requests !== undefined) {
        parts.push(`${requests} request${requests === 1 ? '' : 's'}`);
    }
    parts.push(`${candidates} commit${candidates === 1 ? '' : 's'}`);
    return parts.join(' · ');
}

function formatLabel(startedAt: string | undefined, fileName: string): string {
    const date = startedAt ? new Date(startedAt) : undefined;
    if (date && !Number.isNaN(date.getTime())) {
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
            `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }
    const match = fileName.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/);
    if (match) {
        return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}`;
    }
    return fileName;
}

function asNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function pad(value: number): string {
    return String(value).padStart(2, '0');
}
