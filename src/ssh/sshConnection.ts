// Implementation using native OpenSSH with no ssh2 compatibility

import { EventEmitter } from 'events';
import * as cp from 'child_process';
import * as net from 'net';
import Log from '../common/logger';

export interface SSHConnectConfig {
    /** Host to connect to */
    host: string;
    /** Port to connect to (default: 22) */
    port?: number;
    /** Username for authentication */
    username?: string;
    /** Path to private key */
    identity?: string;
    /** Connection timeout in seconds */
    connectTimeout?: number;
    /** Additional SSH options */
    sshOptions?: string[];
}

export interface SSHTunnelConfig {
    /** Remote Address to connect */
    remoteAddr?: string;
    /** Local port to bind to. By default, it will bind to a random port, if not passed */
    localPort?: number;
    /** Remote Port to connect */
    remotePort?: number;
    /** Remote socket path to connect */
    remoteSocketPath?: string;
    /** Unique name */
    name?: string;
}

const defaultOptions: Partial<SSHConnectConfig> = {
    port: 22,
    connectTimeout: 60
};

const SSHConstants = {
    'CHANNEL': {
        SSH: 'ssh',
        TUNNEL: 'tunnel'
    },
    'STATUS': {
        BEFORECONNECT: 'beforeconnect',
        CONNECT: 'connect',
        BEFOREDISCONNECT: 'beforedisconnect',
        DISCONNECT: 'disconnect'
    }
};

export default class SSHConnection extends EventEmitter {
    public config: SSHConnectConfig;

    private activeTunnels: { [index: string]: SSHTunnelConfig & { process?: cp.ChildProcess } } = {};
    private sshProcess: cp.ChildProcess | null = null;
    private logger: Log;

    constructor(options: SSHConnectConfig, logger: Log) {
        super();
        this.config = Object.assign({}, defaultOptions, options);
        this.logger = logger;
    }

    /**
     * Build SSH command arguments based on configuration and options
     * @param options Additional SSH options
     * @param includeDestination Whether to include the destination in the arguments
     * @param includeConnectOptions Whether to include connection-specific options
     * @returns Array of SSH command arguments
     */
    private buildSSHArgs(): string[] {
        const sshArgs: string[] = [];

        // Add connection options if requested
        sshArgs.push(
            '-o', `ConnectTimeout=${this.config.connectTimeout}`,
            '-o', 'ServerAliveInterval=60',
            '-o', 'ServerAliveCountMax=3',
            '-o', 'EnableEscapeCommandline=yes', // Enable tilde-C sequence
            '-T', // Disable pseudo-terminal allocation
        );

        // Add identity file if provided
        if (this.config.identity) {
            sshArgs.push('-i', this.config.identity);
        }

        // Add port if not default
        if (this.config.port && this.config.port !== 22) {
            sshArgs.push('-p', this.config.port.toString());
        }

        // Add any additional SSH options from config
        if (this.config.sshOptions && this.config.sshOptions.length > 0) {
            sshArgs.push(...this.config.sshOptions);
        }

        // Add destination if requested
        let destination = this.config.host;
        if (this.config.username) {
            destination = `${this.config.username}@${destination}`;
        }
        sshArgs.push(destination);

        return sshArgs;
    }

    /**
     * Emit message on this channel
     */
    override emit(channel: string, status: string, payload?: any): boolean {
        super.emit(channel, status, this, payload);
        return super.emit(`${channel}:${status}`, this, payload);
    }

    /**
     * Execute a command on the remote host
     */
    exec(cmd: string, params?: Array<string>, options: any = {}): Promise<{ stdout: string; stderr: string }> {
        cmd += (Array.isArray(params) ? (' ' + params.join(' ')) : '');

        return new Promise((resolve, reject) => {
            // Build SSH command with basic options
            const sshArgs = this.buildSSHArgs();

            // Add the command to execute
            sshArgs.push(cmd);

            this.logger.info(`Starting SSH command with arguments ${sshArgs}`);
            const execProcess = cp.spawn('ssh', sshArgs);

            let stdout = '';
            let stderr = '';

            execProcess.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            execProcess.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            execProcess.on('close', (code) => {
                if (code === 0 || options.ignoreExitCode) {
                    resolve({ stdout, stderr });
                } else {
                    const error = new Error(`Command ${sshArgs} failed with exit code ${code}: ${stdout} ${stderr}`);
                    reject(error);
                }
            });

            execProcess.on('error', (err) => {
                reject(err);
            });
        });
    }

    /**
     * Execute a command and resolve when a specific condition is met
     */
    execAndWaitUntil(cmd: string, tester: (stdout: string, stderr: string) => boolean, params?: Array<string>, options: any = {}): Promise<{ stdout: string; stderr: string }> {
        cmd += (Array.isArray(params) ? (' ' + params.join(' ')) : '');

        return new Promise((resolve, reject) => {
            // Build SSH command with basic options
            const sshArgs = this.buildSSHArgs();

            // Add the command to execute
            sshArgs.push(cmd);

            this.logger.info(`Starting SSH command with arguments ${sshArgs}`);
            const execProcess = cp.spawn('ssh', sshArgs);

            let stdout = '';
            let stderr = '';
            let resolved = false;

            execProcess.stdout.on('data', (data) => {
                stdout += data.toString();

                if (!resolved && tester(stdout, stderr)) {
                    resolved = true;
                    resolve({ stdout, stderr });
                }
            });

            execProcess.stderr.on('data', (data) => {
                stderr += data.toString();

                if (!resolved && tester(stdout, stderr)) {
                    resolved = true;
                    resolve({ stdout, stderr });
                }
            });

            execProcess.on('close', (code) => {
                if (!resolved) {
                    if (code === 0 || options.ignoreExitCode) {
                        resolve({ stdout, stderr });
                    } else {
                        const error = new Error(`Command failed with exit code ${code}: ${stdout} ${stderr}`);
                        reject(error);
                    }
                }
            });

            execProcess.on('error', (err) => {
                if (!resolved) {
                    reject(err);
                }
            });
        });
    }

    /**
     * Create an SSH tunnel
     */
    addTunnel(tunnelConfig: SSHTunnelConfig): Promise<SSHTunnelConfig & { process?: cp.ChildProcess }> {
        this.logger.info(`Creating tunnel: name: ${tunnelConfig.name}, remoteAddr: ${tunnelConfig.remoteAddr}@${tunnelConfig.remotePort || tunnelConfig.remoteSocketPath}, localPort ${tunnelConfig.localPort}`);

        tunnelConfig.name = tunnelConfig.name || `${tunnelConfig.remoteAddr}@${tunnelConfig.remotePort || tunnelConfig.remoteSocketPath}`;
        this.emit(SSHConstants.CHANNEL.TUNNEL, SSHConstants.STATUS.BEFORECONNECT, { SSHTunnelConfig: tunnelConfig });

        if (this.getTunnel(tunnelConfig.name)) {
            this.emit(SSHConstants.CHANNEL.TUNNEL, SSHConstants.STATUS.CONNECT, { SSHTunnelConfig: tunnelConfig });
            return Promise.resolve(this.getTunnel(tunnelConfig.name));
        }

        return this._createTunnel(tunnelConfig);
    }

    /**
     * Internal method to create the actual tunnel
     */
    private _createTunnel(tunnelConfig: SSHTunnelConfig): Promise<SSHTunnelConfig & { process?: cp.ChildProcess }> {
        return new Promise((resolve, reject) => {
            // Determine local port
            const localPort = tunnelConfig.localPort || 0;

            // Create a server to get a random port if needed
            if (localPort === 0) {
                const server = net.createServer();
                server.listen(0, () => {
                    const port = (server.address() as net.AddressInfo).port;
                    server.close(() => {
                        // Now we have a random port, create the actual tunnel
                        this._startTunnelProcess(tunnelConfig, port)
                            .then(resolve)
                            .catch(reject);
                    });
                });
            } else {
                // Use the specified port
                this._startTunnelProcess(tunnelConfig, localPort)
                    .then(resolve)
                    .catch(reject);
            }
        });
    }

    /**
     * Start the SSH tunnel process
     */
    private _startTunnelProcess(tunnelConfig: SSHTunnelConfig, localPort: number): Promise<SSHTunnelConfig & { process?: cp.ChildProcess }> {
        return new Promise((resolve, reject) => {
            // Prepare tunnel-specific arguments
            const tunnelArgs: string[] = ['-N']; // Don't execute a remote command

            if (tunnelConfig.remoteSocketPath) {
                // Forward to a Unix socket
                tunnelArgs.push('-L', `${localPort}:${tunnelConfig.remoteSocketPath}`);
            } else {
                // Standard port forwarding
                tunnelArgs.push(
                    '-L',
                    `${localPort}:${tunnelConfig.remoteAddr || 'localhost'}:${tunnelConfig.remotePort}`
                );
            }

            // Build SSH command with connection options and tunnel-specific args
            const sshArgs = this.buildSSHArgs();
            sshArgs.push(...tunnelArgs);

            // Start the tunnel process
            this.logger.info(`Starting SSH command with arguments ${sshArgs}`);
            const tunnelProcess = cp.spawn('ssh', sshArgs);

            // Store the tunnel configuration
            const tunnel = {
                ...tunnelConfig,
                localPort,
                process: tunnelProcess
            };

            this.activeTunnels[tunnelConfig.name!] = tunnel;

            // Handle errors
            tunnelProcess.on('error', (err) => {
                this.emit(SSHConstants.CHANNEL.TUNNEL, SSHConstants.STATUS.DISCONNECT, {
                    SSHTunnelConfig: tunnelConfig,
                    err
                });
                delete this.activeTunnels[tunnelConfig.name!];
                reject(err);
            });

            // Check if the process exits unexpectedly
            tunnelProcess.on('exit', (code) => {
                if (code !== 0 && this.activeTunnels[tunnelConfig.name!]) {
                    this.emit(SSHConstants.CHANNEL.TUNNEL, SSHConstants.STATUS.DISCONNECT, {
                        SSHTunnelConfig: tunnelConfig,
                        err: new Error(`Tunnel process exited with code ${code}`)
                    });
                    delete this.activeTunnels[tunnelConfig.name!];
                }
            });

            // Collect stderr output for error reporting
            let stderr = '';
            tunnelProcess.stderr?.on('data', (data) => {
                stderr += data.toString();

                // Check for common error messages
                if (stderr.includes('Address already in use') ||
                    stderr.includes('Permission denied') ||
                    stderr.includes('Connection refused')) {
                    tunnelProcess.kill();
                    delete this.activeTunnels[tunnelConfig.name!];
                    reject(new Error(`Failed to create tunnel: ${stderr.trim()}`));
                }
            });

            // Wait a short time to ensure the tunnel is established
            setTimeout(() => {
                // If the process is still running, assume the tunnel is established
                if (tunnelProcess.exitCode === null) {
                    this.emit(SSHConstants.CHANNEL.TUNNEL, SSHConstants.STATUS.CONNECT, {
                        SSHTunnelConfig: tunnel
                    });
                    resolve(tunnel);
                } else if (!stderr) {
                    // Process exited but no error message
                    reject(new Error(`Tunnel process exited with code ${tunnelProcess.exitCode}`));
                }
                // If there was an error message, it would have been handled in the stderr handler
            }, 1000);
        });
    }

    /**
     * Get an existing tunnel by name
     */
    getTunnel(name: string) {
        return this.activeTunnels[name];
    }

    /**
     * Close a specific tunnel or all tunnels
     */
    closeTunnel(name?: string): Promise<void> {
        if (name && this.activeTunnels[name]) {
            return new Promise((resolve) => {
                const tunnel = this.activeTunnels[name];
                this.emit(
                    SSHConstants.CHANNEL.TUNNEL,
                    SSHConstants.STATUS.BEFOREDISCONNECT,
                    { SSHTunnelConfig: tunnel }
                );

                // Close the tunnel process
                if (tunnel.process) {
                    tunnel.process.kill();
                }

                this.emit(
                    SSHConstants.CHANNEL.TUNNEL,
                    SSHConstants.STATUS.DISCONNECT,
                    { SSHTunnelConfig: tunnel }
                );
                delete this.activeTunnels[name];
                resolve();
            });
        } else if (!name) {
            const tunnels = Object.keys(this.activeTunnels).map((key) => this.closeTunnel(key));
            return Promise.all(tunnels).then(() => { });
        }

        return Promise.resolve();
    }

    /**
     * Close the SSH connection
     */
    close(): Promise<void> {
        this.emit(SSHConstants.CHANNEL.SSH, SSHConstants.STATUS.BEFOREDISCONNECT);

        return this.closeTunnel().then(() => {
            if (this.sshProcess) {
                this.sshProcess.kill();
                this.sshProcess = null;
            }

            this.emit(SSHConstants.CHANNEL.SSH, SSHConstants.STATUS.DISCONNECT);
        });
    }
}
