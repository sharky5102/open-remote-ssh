import * as vscode from 'vscode';
import { REMOTE_SSH_AUTHORITY } from './authResolver';
import SSHDestination from './ssh/sshDestination';
import Log from './common/logger';

export class RemoteLocationHistory {
    private static STORAGE_KEY = 'remoteLocationHistory_v0';

    private remoteLocationHistory: Record<string, string[]> = {};

    constructor(private context: vscode.ExtensionContext) {
        // context.globalState.update(RemoteLocationHistory.STORAGE_KEY, undefined);
        this.remoteLocationHistory = context.globalState.get(RemoteLocationHistory.STORAGE_KEY) || {};
    }

    getHistory(): Record<string, string[]> {
        return this.remoteLocationHistory;
    }

    async addLocation(host: string, path: string) {
        let hostLocations = this.remoteLocationHistory[host] || [];
        if (!hostLocations.includes(path)) {
            hostLocations.unshift(path);
            this.remoteLocationHistory[host] = hostLocations;

            await this.context.globalState.update(RemoteLocationHistory.STORAGE_KEY, this.remoteLocationHistory);
        }
    }

    async removeLocation(host: string, path: string) {
        let hostLocations = this.remoteLocationHistory[host] || [];
        hostLocations = hostLocations.filter(l => l !== path);
        this.remoteLocationHistory[host] = hostLocations;

        await this.context.globalState.update(RemoteLocationHistory.STORAGE_KEY, this.remoteLocationHistory);
    }
}

export function getRemoteWorkspaceLocationData(logger: Log): [string, string] | undefined {
    let location = vscode.workspace.workspaceFile;
    logger.info(`Starting with remote workspace ${location}`);
    if (location && location.scheme === 'vscode-remote' && location.authority.startsWith(REMOTE_SSH_AUTHORITY) && location.path.endsWith('.code-workspace')) {
        const [, host] = location.authority.split('+');
        const sshDest = SSHDestination.parseEncoded(host);
        return [sshDest.hostname, location.path];
    }

    location = vscode.workspace.workspaceFolders?.[0].uri;
    logger.info(`Starting with remote workspace folder ${location}`);
    if (location && location.scheme === 'vscode-remote' && location.authority.startsWith(REMOTE_SSH_AUTHORITY)) {
        const [, host] = location.authority.split('+');
        const sshDest = SSHDestination.parseEncoded(host);
        return [sshDest.hostname, location.path];
    }

    return undefined;
}
