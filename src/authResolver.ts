import * as vscode from 'vscode';
import Log from './common/logger';
import SSHDestination from './ssh/sshDestination';
import SSHConnection from './ssh/sshConnection';
import { findRandomPort } from './common/ports';
import { disposeAll } from './common/disposable';
import { installCodeServer } from './serverSetup';

export const REMOTE_SSH_AUTHORITY = 'ssh-remote';

export function getRemoteAuthority(host: string) {
    return `${REMOTE_SSH_AUTHORITY}+${host}`;
}

class TunnelInfo implements vscode.Disposable {
    constructor(
        readonly localPort: number,
        readonly remotePortOrSocketPath: number | string,
        private disposables: vscode.Disposable[]
    ) {
    }

    dispose() {
        disposeAll(this.disposables);
    }
}

export class RemoteSSHResolver implements vscode.RemoteAuthorityResolver, vscode.Disposable {
    private sshConnection: SSHConnection | undefined;
    private tunnels: TunnelInfo[] = [];

    constructor(
        readonly context: vscode.ExtensionContext,
        readonly logger: Log
    ) {
    }

    resolve(authority: string, context: vscode.RemoteAuthorityResolverContext): Thenable<vscode.ResolverResult> {
        const [type, dest] = authority.split('+');
        if (type !== REMOTE_SSH_AUTHORITY) {
            throw new Error(`Invalid authority type for SSH resolver: ${type}`);
        }

        this.logger.info(`Resolving ssh remote authority '${authority}' (attempt #${context.resolveAttempt})`);

        const sshDest = SSHDestination.parseEncoded(dest);

        // Get configuration settings
        const remoteSSHconfig = vscode.workspace.getConfiguration('remote.SSH');
        const serverDownloadUrlTemplate = remoteSSHconfig.get<string>('serverDownloadUrlTemplate');
        const defaultExtensions = remoteSSHconfig.get<string[]>('defaultExtensions', []);
        const remotePlatformMap = remoteSSHconfig.get<Record<string, string>>('remotePlatform', {});
        const remoteServerListenOnSocket = remoteSSHconfig.get<boolean>('remoteServerListenOnSocket', false);
        const connectTimeout = remoteSSHconfig.get<number>('connectTimeout', 60);

        return vscode.window.withProgress({
            title: `Setting up SSH Host ${sshDest.hostname}`,
            location: vscode.ProgressLocation.Notification,
            cancellable: false
        }, async () => {
            try {
                // Create SSH connection
                this.sshConnection = new SSHConnection({
                    host: sshDest.hostname,
                    port: sshDest.port,
                    username: sshDest.user || process.env["USER"] || "",
                    connectTimeout
                }, this.logger);

                // Detect platform
                let platform = remotePlatformMap[sshDest.hostname];
                if (!platform) {
                    try {
                        const result = await this.sshConnection.exec('uname -s');
                        if (result.stdout.includes('Linux')) {
                            platform = 'linux';
                        } else if (result.stdout.includes('Darwin')) {
                            platform = 'macos';
                        } else if (result.stdout.includes('Windows') || result.stdout.includes('MINGW') || result.stdout.includes('MSYS')) {
                            platform = 'windows';
                        }
                    } catch (err) {
                        this.logger.error(`Failed to detect platform: ${err}`);
                    }
                }

                // Install and start the server
                const serverResult = await installCodeServer(
                    this.sshConnection,
                    serverDownloadUrlTemplate,
                    defaultExtensions,
                    [],
                    platform,
                    remoteServerListenOnSocket,
                    this.logger
                );

                // Create tunnel to the server
                let tunnel: TunnelInfo;
                if (typeof serverResult.listeningOn === 'number') {
                    // Server is listening on a port
                    const localPort = await findRandomPort();
                    await this.sshConnection.addTunnel({
                        localPort,
                        remoteAddr: 'localhost',
                        remotePort: serverResult.listeningOn
                    });
                    tunnel = new TunnelInfo(localPort, serverResult.listeningOn, []);
                } else {
                    // Server is listening on a socket
                    const localPort = await findRandomPort();
                    await this.sshConnection.addTunnel({
                        localPort,
                        remoteSocketPath: serverResult.listeningOn
                    });
                    tunnel = new TunnelInfo(localPort, serverResult.listeningOn, []);
                }

                this.tunnels.push(tunnel);

                // Return the resolver result
                return {
                    host: 'localhost',
                    port: tunnel.localPort,
                    connectionToken: serverResult.connectionToken
                };
            } catch (err) {
                this.logger.error(`Failed to resolve SSH authority: ${err}`);
                throw new vscode.RemoteAuthorityResolverError(
                    err instanceof Error ? err.message : String(err)
                );
            }
        });
    }

    dispose() {
        for (const tunnel of this.tunnels) {
            tunnel.dispose();
        }
        this.tunnels = [];

        if (this.sshConnection) {
            this.sshConnection.close().catch(err => {
                this.logger.error(`Failed to close SSH connection: ${err}`);
            });
            this.sshConnection = undefined;
        }
    }
}
