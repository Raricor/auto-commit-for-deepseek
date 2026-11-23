/**
 * Incremental Server-Sent Events line decoding.
 *
 * The decoder keeps a `TextDecoder` in stream mode, so a multi-byte UTF-8
 * character split across two network chunks is never corrupted. It also
 * buffers a partial line until its newline arrives.
 */

/** Returns false when the consumer wants to stop reading (e.g. `[DONE]`). */
export type SseLineHandler = (line: string) => boolean;

export class SseLineReader {
    private readonly decoder = new TextDecoder();
    private buffer = '';

    constructor(private readonly onLine: SseLineHandler) {}

    /** Feeds one decoded network chunk. Returns false when reading should stop. */
    feed(chunk: Uint8Array): boolean {
        this.buffer += this.decoder.decode(chunk, { stream: true });
        return this.drain(false);
    }

    /** Flushes decoder state and any unterminated final line. */
    flush(): boolean {
        this.buffer += this.decoder.decode();
        return this.drain(true);
    }

    private drain(final: boolean): boolean {
        for (;;) {
            const newline = this.buffer.indexOf('\n');
            if (newline < 0) {
                break;
            }
            let line = this.buffer.slice(0, newline);
            this.buffer = this.buffer.slice(newline + 1);
            if (line.endsWith('\r')) {
                line = line.slice(0, -1);
            }
            if (!this.onLine(line)) {
                return false;
            }
        }
        if (final && this.buffer.length > 0) {
            let line = this.buffer;
            this.buffer = '';
            if (line.endsWith('\r')) {
                line = line.slice(0, -1);
            }
            if (!this.onLine(line)) {
                return false;
            }
        }
        return true;
    }
}

/**
 * Returns the payload of an SSE `data:` line, or undefined for comments,
 * blank lines and other SSE fields. The value keeps its internal whitespace;
 * only the one optional space after the colon is removed.
 */
export function parseSseDataLine(line: string): string | undefined {
    if (!line.startsWith('data:')) {
        return undefined;
    }
    let data = line.slice('data:'.length);
    if (data.startsWith(' ')) {
        data = data.slice(1);
    }
    return data;
}
