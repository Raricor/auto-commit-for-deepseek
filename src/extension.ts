import * as vscode from 'vscode';
import { clearApiKey, setApiKey } from './config/apiKey';
import { SETTINGS_SECTION } from './config/settings';
import { PanelManager } from './ui/panelManager';
import { createStatusBar } from './ui/statusBar';

export function activate(context: vscode.ExtensionContext): void {
    const panelManager = PanelManager.getInstance(context);

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'autocommit-for-deepseek.generate',
            (sourceControl?: { rootUri?: vscode.Uri }) => {
                // When invoked from the SCM title bar (`scm/title` menu),
                // VS Code passes the SourceControl whose ✨ button was clicked.
                // We forward its rootUri so the panel locks onto that exact repo.
                void panelManager.openAndGenerate(sourceControl?.rootUri);
            }
        ),
        vscode.commands.registerCommand(
            'autocommit-for-deepseek.setApiKey',
            () => setApiKey(context.secrets)
        ),
        vscode.commands.registerCommand(
            'autocommit-for-deepseek.clearApiKey',
            () => clearApiKey(context.secrets)
        ),
        context.secrets.onDidChange(() => {
            void panelManager.notifyEndpointChanged(true);
        }),
        vscode.workspace.onDidChangeConfiguration((event) => {
            const baseUrlChanged = event.affectsConfiguration(
                `${SETTINGS_SECTION}.baseUrl`
            );
            const headersChanged = event.affectsConfiguration(
                `${SETTINGS_SECTION}.requestHeaders`
            );
            const modelChanged = event.affectsConfiguration(
                `${SETTINGS_SECTION}.model`
            );
            if (baseUrlChanged || headersChanged || modelChanged) {
                void panelManager.notifyEndpointChanged(baseUrlChanged || headersChanged);
            }
        })
    );

    createStatusBar(context);
}

export function deactivate(): void { }
