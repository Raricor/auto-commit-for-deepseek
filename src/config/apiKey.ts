import * as vscode from 'vscode';

export const API_KEY_SECRET = 'autocommit-for-deepseek.apiKey';
export const API_KEY_ENV = 'DEEPSEEK_API_KEY';

export interface ResolvedApiKey {
    key: string;
    source: 'secret' | 'env';
}

/**
 * Reads the API key from SecretStorage first, then from the environment.
 * Blank values are ignored.
 */
export async function resolveApiKey(
    secrets: vscode.SecretStorage
): Promise<ResolvedApiKey | undefined> {
    const stored = (await secrets.get(API_KEY_SECRET) ?? '').trim();
    if (stored) {
        return { key: stored, source: 'secret' };
    }
    const fromEnv = (process.env[API_KEY_ENV] ?? '').trim();
    if (fromEnv) {
        return { key: fromEnv, source: 'env' };
    }
    return undefined;
}

/** Prompts for an API key and stores it in SecretStorage. */
export async function setApiKey(secrets: vscode.SecretStorage): Promise<void> {
    const value = await vscode.window.showInputBox({
        prompt: 'Enter your DeepSeek API key',
        placeHolder: 'sk-…',
        password: true,
        ignoreFocusOut: true,
        validateInput: (input) => input.trim() ? undefined : 'API key cannot be empty',
    });
    if (value === undefined) {
        return;
    }
    const key = value.trim();
    if (!key) {
        return;
    }
    await secrets.store(API_KEY_SECRET, key);
}

/** Removes the stored API key. */
export async function clearApiKey(secrets: vscode.SecretStorage): Promise<void> {
    await secrets.delete(API_KEY_SECRET);
}
