import { join } from 'node:path';
import * as vscode from 'vscode';
import { listRunLogs, type RunLogFile } from './runLogs';

interface RunLogQuickPickItem extends vscode.QuickPickItem {
    filePath: string;
}

/** Lists <globalStorage>/runs newest first and opens the chosen JSONL file. */
export async function openRunLogPicker(globalStorageUri: vscode.Uri): Promise<void> {
    const runsDirectory = join(globalStorageUri.fsPath, 'runs');
    const files = await listRunLogs(runsDirectory);
    if (files.length === 0) {
        void vscode.window.showInformationMessage('No run records yet.');
        return;
    }

    const items: RunLogQuickPickItem[] = files.map((file: RunLogFile) => ({
        label: file.label,
        description: file.description,
        detail: file.detail || undefined,
        filePath: file.filePath,
    }));
    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a run record',
        matchOnDescription: true,
        matchOnDetail: true,
    });
    if (!picked) { return; }

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(picked.filePath));
    await vscode.window.showTextDocument(document);
}
