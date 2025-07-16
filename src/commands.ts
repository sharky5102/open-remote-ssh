import * as vscode from 'vscode';
import { getRemoteAuthority } from './authResolver';
import SSHDestination from './ssh/sshDestination';

export async function promptOpenRemoteSSHWindow(reuseWindow: boolean) {
    const host = await vscode.window.showInputBox({
        title: 'Enter [user@]hostname[:port]'
    });

    if (!host) {
        return;
    }

    const sshDest = new SSHDestination(host);
    openRemoteSSHWindow(sshDest.toEncodedString(), reuseWindow);
}

export function openRemoteSSHWindow(host: string, reuseWindow: boolean) {
    vscode.commands.executeCommand('vscode.newWindow', { remoteAuthority: getRemoteAuthority(host), reuseWindow });
}

export function openRemoteSSHLocationWindow(host: string, path: string, reuseWindow: boolean) {
    vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.from({ scheme: 'vscode-remote', authority: getRemoteAuthority(host), path }), { forceNewWindow: !reuseWindow });
}

