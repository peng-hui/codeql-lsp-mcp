import { spawn, ChildProcess, ChildProcessWithoutNullStreams } from "child_process";
import {
    createMessageConnection,
    MessageConnection,
    InitializeParams,
    InitializeResult,
    CompletionParams,
    CompletionList,
    HoverParams,
    Hover,
    DefinitionParams,
    Location,
    DocumentFormattingParams,
    TextEdit,
    PublishDiagnosticsParams,
    Diagnostic,
    DidOpenTextDocumentParams,
    DidChangeTextDocumentParams,
    TextDocumentItem,
    VersionedTextDocumentIdentifier,
    TextDocumentContentChangeEvent,
} from "vscode-languageserver-protocol";
import { StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node.js";
import { existsSync, writeFileSync, appendFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, delimiter } from "path";
import { execSync } from "child_process";

export interface CodeQLClientOptions {
    codeqlPath?: string;
    verbose?: boolean;
}

export class CodeQLLanguageServer {
    private process: ChildProcessWithoutNullStreams | null = null;
    private connection: MessageConnection | null = null;
    private diagnosticsMap: Map<string, Diagnostic[]> = new Map();
    private documentVersions: Map<string, number> = new Map();
    private workspaceFolders: string[] = [];
    private keepaliveInterval?: NodeJS.Timeout;
    private readonly instanceId: string = `${process.pid}-${Date.now()}`;
    private readonly logFilePath: string | null = null;
    private readonly verbose: boolean;
    private codeqlPath?: string;

    constructor(options: CodeQLClientOptions = {}) {
        this.verbose = options.verbose ?? false;
        this.codeqlPath = options.codeqlPath;

        if (this.verbose) {
            this.logFilePath = join(process.cwd(), `codeql-lsp-${this.instanceId}.log`);

            try {
                writeFileSync(this.logFilePath, `[${new Date().toISOString()}] [${this.instanceId}] CodeQL LSP Client initialized\n`);
            } catch {
                // If we can't write to the log file, just continue without logging
            }
        }

        if (!this.codeqlPath) {
            this.codeqlPath = this.findCodeQLPath();
            if (!this.codeqlPath) {
                throw new Error(
                    "CodeQL CLI not found. Please set CODEQL_PATH environment variable or ensure 'codeql' is in PATH"
                );
            }
        }
    }

    private log(message: string): void {
        if (!this.verbose) return;

        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] [${this.instanceId}] ${message}\n`;

        console.error(logMessage.trim());

        try {
            appendFileSync(this.logFilePath!, logMessage);
        } catch {
            // If we can't write to log file, just continue
        }
    }

    private findCodeQLPath(): string | undefined {
        const possiblePaths = [
            process.env.CODEQL_PATH,
            process.env.PATH?.split(delimiter).map(dir => join(dir, "codeql")).find(p => existsSync(p)),
            join(homedir(), "codeql", "codeql"),
            join(homedir(), ".codeql", "codeql"),
            "codeql",
        ].filter(Boolean) as string[];

        for (const path of possiblePaths) {
            if (this.isCodeQLAvailable(path)) {
                return path;
            }
        }
        return undefined;
    }

    private isCodeQLAvailable(path: string): boolean {
        try {
            execSync(`"${path}" version`, { stdio: "ignore" });
            return true;
        } catch {
            return false;
        }
    }

    async start(workspaceFolders?: string[]): Promise<void> {
        this.log(`start() called with workspace folders: ${JSON.stringify(workspaceFolders)}`);

        if (this.process) {
            this.log(`Already started, returning early`);
            return;
        }

        if (workspaceFolders) {
            this.workspaceFolders = workspaceFolders;
            this.log(`Set workspace folders: ${JSON.stringify(this.workspaceFolders)}`);
        }

        this.log(`Starting CodeQL language server with: ${this.codeqlPath}`);

        const args = ["execute", "language-server", "--check-errors", "ON_CHANGE"];
        if (process.env.CODEQL_VERBOSE === "true") {
            args.push("-v");
        }
        this.log(`Spawning process with args: ${JSON.stringify(args)}`);

        this.process = spawn(this.codeqlPath!, args, {
            stdio: ["pipe", "pipe", "pipe"],
        }) as ChildProcessWithoutNullStreams;

        if (!this.process || !this.process.pid) {
            this.log(`Failed to start CodeQL language server`);
            throw new Error(`Failed to start CodeQL language server`);
        }

        this.log(`Process started with PID: ${this.process.pid}`);

        // Auto-restart on unexpected exit
        this.process.on("exit", (code, signal) => {
            this.log(`CodeQL language server exited with code ${code}, signal ${signal}`);
            this.process = null;
            this.connection = null;

            // Auto-restart after 2 seconds if it wasn't a clean shutdown
            if (code !== 0) {
                this.log(`Restarting CodeQL language server in 2 seconds...`);
                setTimeout(() => {
                    this.start(this.workspaceFolders).catch(err =>
                        this.log(`Failed to restart CodeQL language server: ${err}`)
                    );
                }, 2000);
            }
        });

        this.process.stderr?.on("data", (data) => {
            this.log(`CodeQL LSP stderr: ${data.toString().trim()}`);
        });

        const reader = new StreamMessageReader(this.process.stdout!);
        const writer = new StreamMessageWriter(this.process.stdin!);
        this.connection = createMessageConnection(reader, writer);

        this.log(`Message connection created`);

        // Handle diagnostics
        this.connection.onNotification(
            "textDocument/publishDiagnostics",
            (params: PublishDiagnosticsParams) => {
                this.log(`Received diagnostics for ${params.uri}: ${params.diagnostics.length} items`);
                if (params.diagnostics.length > 0) {
                    this.log(`First diagnostic: ${JSON.stringify(params.diagnostics[0])}`);
                }
                this.diagnosticsMap.set(params.uri, params.diagnostics);
            }
        );

        // Initialize the language server
        const initParams: InitializeParams = {
            processId: process.pid,
            capabilities: {
                textDocument: {
                    completion: {
                        completionItem: {
                            snippetSupport: true,
                            documentationFormat: ["markdown", "plaintext"],
                        },
                    },
                    hover: {
                        contentFormat: ["markdown", "plaintext"],
                    },
                    synchronization: {
                        willSave: false,
                        willSaveWaitUntil: false,
                        didSave: true,
                    },
                    definition: {
                        dynamicRegistration: false,
                    },
                    references: {
                        dynamicRegistration: false,
                    },
                },
                workspace: {
                    workspaceFolders: true,
                },
            },
            rootUri: this.workspaceFolders.length > 0 ? `file://${this.workspaceFolders[0]}` : `file://${process.cwd()}`,
            workspaceFolders: this.workspaceFolders.length > 0
                ? this.workspaceFolders.map((folder, index) => ({
                    uri: `file://${folder}`,
                    name: `workspace${index}`,
                }))
                : [
                    {
                        uri: `file://${process.cwd()}`,
                        name: "workspace",
                    },
                ],
        };

        this.log(`Starting connection listener`);
        this.connection.listen();
        this.log(`Connection listener started`);

        this.log(`Sending initialize request with params:`);
        this.log(`Init params: ${JSON.stringify(initParams, null, 2)}`);

        this.connection.sendRequest("initialize", initParams)
            .then(result => this.log(`Initialize response received: ${JSON.stringify(result)}`))
            .catch(err => this.log(`Initialize request failed: ${err}`));

        setTimeout(() => {
            this.log(`Sending initialized notification`);
            this.connection?.sendNotification("initialized", {})
                .then(() => this.log(`Initialized notification sent`))
                .catch(err => this.log(`Initialized notification failed: ${err}`));
            this.log(`Initialization complete`);
        }, 1000);

        this.startKeepalive();

        this.log("CodeQL language server initialized successfully");
    }

    private startKeepalive(): void {
        // Send a lightweight request every 60 seconds to keep the connection alive
        this.keepaliveInterval = setInterval(async () => {
            if (this.connection) {
                try {
                    await this.connection.sendRequest("$/cancelRequest", { id: -1 });
                } catch (error) {
                }
            }
        }, 60000);
    }

    async stop(): Promise<void> {
        this.log(`stop() called`);

        if (this.keepaliveInterval) {
            this.log(`Clearing keepalive interval`);
            clearInterval(this.keepaliveInterval);
            this.keepaliveInterval = undefined;
        }

        if (this.connection) {
            this.log(`Sending shutdown request`);
            try {
                await this.connection.sendRequest("shutdown");
                this.log(`Shutdown request sent`);
                this.log(`Sending exit notification`);
                this.connection.sendNotification("exit");
                this.log(`Exit notification sent`);
            } catch (e) {
                this.log(`Error during shutdown: ${e}`);
            }
            this.log(`Disposing connection`);
            this.connection.dispose();
            this.connection = null;
        }

        if (this.process) {
            this.log(`Killing process PID: ${this.process.pid}`);
            this.process.stdin?.end();
            this.process.kill();
            this.process.stdout?.destroy();
            this.process.stderr?.destroy();
            this.process = null;
            this.log(`Process killed`);
        }

        this.log(`Stop complete`);
    }

    async openDocument(uri: string, content: string): Promise<void> {
        this.log(`openDocument() called for ${uri}`);
        this.log(`Content length: ${content.length} chars`);

        if (!this.connection) {
            this.log(`No connection available`);
            throw new Error("Language server not started");
        }

        const version = 1;
        this.documentVersions.set(uri, version);
        this.log(`Set document version to ${version}`);

        const params: DidOpenTextDocumentParams = {
            textDocument: {
                uri,
                languageId: "ql",
                version,
                text: content,
            },
        };

        this.log(`Sending textDocument/didOpen`);
        await this.connection.sendNotification("textDocument/didOpen", params);
        this.log(`textDocument/didOpen sent`);

        this.log(`Sending textDocument/codeQLDidChangeVisibleFiles`);
        await this.connection.sendNotification("textDocument/codeQLDidChangeVisibleFiles", {
            visibleFiles: [uri]
        });
        this.log(`textDocument/codeQLDidChangeVisibleFiles sent`);

        // Use EXACT same logic as updateDocument
        this.log(`Sending didChange to trigger analysis (using updateDocument logic)`);

        // Get the version that was just set above (should be 1), then increment like updateDocument does
        const currentVersion = this.documentVersions.get(uri) || 0; // This will be 1
        const newVersion = currentVersion + 1; // This will be 2
        this.documentVersions.set(uri, newVersion);
        this.log(`Updated document version from ${currentVersion} to ${newVersion}`);

        const changeParams: DidChangeTextDocumentParams = {
            textDocument: {
                uri,
                version: newVersion,
            },
            contentChanges: [
                {
                    text: content,
                },
            ],
        };

        this.log(`Sending textDocument/didChange`);
        await this.connection.sendNotification("textDocument/didChange", changeParams);
        this.log(`didChange sent for ${uri} (version ${newVersion})`);
    }

    async updateDocument(uri: string, content: string): Promise<void> {
        this.log(`updateDocument() called for ${uri}`);
        this.log(`Content length: ${content.length} chars`);

        if (!this.connection) {
            this.log(`No connection available`);
            throw new Error("Language server not started");
        }

        // If file was never opened, send didOpen first
        const wasNeverOpened = !this.documentVersions.has(uri);
        if (wasNeverOpened) {
            this.log(`File never opened, sending didOpen first for ${uri}`);
            const openParams: DidOpenTextDocumentParams = {
                textDocument: {
                    uri,
                    languageId: "ql",
                    version: 1,
                    text: content,
                },
            };

            this.log(`Sending textDocument/didOpen (auto)`);
            await this.connection.sendNotification("textDocument/didOpen", openParams);
            this.documentVersions.set(uri, 1);
            this.log(`textDocument/didOpen sent (auto), version set to 1`);
        }

        const currentVersion = this.documentVersions.get(uri) || 0;
        const newVersion = currentVersion + 1;
        this.documentVersions.set(uri, newVersion);
        this.log(`Updated document version from ${currentVersion} to ${newVersion}`);

        const params: DidChangeTextDocumentParams = {
            textDocument: {
                uri,
                version: newVersion,
            },
            contentChanges: [
                {
                    text: content,
                },
            ],
        };

        this.log(`Sending textDocument/didChange`);
        await this.connection.sendNotification("textDocument/didChange", params);
        this.log(`textDocument/didChange sent for ${uri} (version ${newVersion})`);
    }

    async getCompletions(
        uri: string,
        line: number,
        character: number,
        triggerCharacter?: string
    ): Promise<CompletionList> {
        if (!this.connection) {
            throw new Error("Language server not started");
        }

        const params: CompletionParams = {
            textDocument: { uri },
            position: { line, character },
            context: triggerCharacter
                ? { triggerKind: 2, triggerCharacter }
                : { triggerKind: 1 },
        };

        const result = await this.connection.sendRequest<CompletionList>(
            "textDocument/completion",
            params
        );

        return result;
    }

    async getHover(
        uri: string,
        line: number,
        character: number
    ): Promise<Hover | null> {
        this.log(`getHover() called for ${uri} at ${line}:${character}`);

        if (!this.connection) {
            this.log(`No connection available for hover`);
            throw new Error("Language server not started");
        }

        const params: HoverParams = {
            textDocument: { uri },
            position: { line, character },
        };

        // Poll for hover information with exponential backoff
        const maxWaitTime = 60000; // 30 seconds max for hover 
        const pollInterval = 500; // Start with 500ms
        let totalWaited = 0;
        let currentInterval = pollInterval;
        let pollCount = 0;

        while (totalWaited < maxWaitTime) {
            this.log(`Hover attempt ${++pollCount}, waiting ${currentInterval}ms...`);

            try {
                const result = await this.connection.sendRequest<Hover | null>(
                    "textDocument/hover",
                    params
                );

                if (result && result.contents) {
                    this.log(`Hover found after ${totalWaited}ms!`);
                    this.log(`Hover content: ${JSON.stringify(result.contents).substring(0, 100)}...`);
                    return result;
                }

                this.log(`After ${totalWaited}ms: No hover content yet`);

                // If no result, wait and try again
                await new Promise(resolve => setTimeout(resolve, currentInterval));
                totalWaited += currentInterval;

                // Exponential backoff: 500ms, 1s, 2s, 2s, etc
                currentInterval = Math.min(currentInterval * 2, 2000);

            } catch (error) {
                this.log(`Hover request failed: ${error instanceof Error ? error.message : String(error)}`);

                // Wait and try again
                await new Promise(resolve => setTimeout(resolve, currentInterval));
                totalWaited += currentInterval;
                currentInterval = Math.min(currentInterval * 2, 2000);
            }
        }

        this.log(`No hover found after ${totalWaited}ms - returning null`);
        return null;
    }

    async getDefinition(
        uri: string,
        line: number,
        character: number
    ): Promise<Location | Location[] | null> {
        if (!this.connection) {
            throw new Error("Language server not started");
        }

        const params: DefinitionParams = {
            textDocument: { uri },
            position: { line, character },
        };

        const result = await this.connection.sendRequest<
            Location | Location[] | null
        >("textDocument/definition", params);

        return result;
    }

    async getDiagnostics(uri: string): Promise<Diagnostic[]> {
        this.log(`getDiagnostics() called for ${uri}`);

        if (!this.connection) {
            this.log(`No connection available for diagnostics`);
            throw new Error("Language server not started");
        }

        this.log(`Connection status: ${this.connection ? 'connected' : 'disconnected'}`);
        this.log(`Process PID: ${this.process?.pid || 'none'}`);

        let diagnostics = this.diagnosticsMap.get(uri) || [];
        this.log(`Immediate check: ${diagnostics.length} diagnostics in cache`);

        if (diagnostics.length > 0) {
            this.log(`Returning cached diagnostics`);
            return diagnostics;
        }

        this.log(`Starting polling for diagnostics...`);

        // Poll for diagnostics with exponential backoff
        const maxWaitTime = 120000; // 2 minutes max - CodeQL needs time to index workspace
        const pollInterval = 1000; // Start with 1 second - be more patient
        let totalWaited = 0;
        let currentInterval = pollInterval;
        let pollCount = 0;

        while (totalWaited < maxWaitTime) {
            this.log(`Polling attempt ${++pollCount}, waiting ${currentInterval}ms...`);
            await new Promise(resolve => setTimeout(resolve, currentInterval));
            totalWaited += currentInterval;

            diagnostics = this.diagnosticsMap.get(uri) || [];
            this.log(`After ${totalWaited}ms: ${diagnostics.length} diagnostics`);

            if (diagnostics.length > 0) {
                this.log(`Diagnostics found after ${totalWaited}ms!`);
                this.log(`First diagnostic: ${JSON.stringify(diagnostics[0], null, 2)}`);
                return diagnostics;
            }

            // Exponential backoff: 1s, 2s, 4s, 4s, etc
            currentInterval = Math.min(currentInterval * 2, 4000);
        }

        this.log(`No diagnostics found after ${totalWaited}ms - returning empty`);
        this.log(`Final state - Process alive: ${!!this.process}, Connection: ${!!this.connection}`);
        return [];
    }

    async formatDocument(uri: string, range?: any): Promise<TextEdit[]> {
        if (!this.connection) {
            throw new Error("Language server not started");
        }

        const params: DocumentFormattingParams = {
            textDocument: { uri },
            options: {
                tabSize: 2,
                insertSpaces: true,
            },
        };

        const edits = await this.connection.sendRequest<TextEdit[]>(
            "textDocument/formatting",
            params
        );

        return edits;
    }

    async getReferences(
        uri: string,
        line: number,
        character: number
    ): Promise<Location[] | null> {
        if (!this.connection) {
            throw new Error("Language server not started");
        }

        const params = {
            textDocument: { uri },
            position: { line, character },
            context: { includeDeclaration: true },
        };

        const result = await this.connection.sendRequest<Location[] | null>(
            "textDocument/references",
            params
        );

        return result;
    }

    setWorkspaceFolders(folders: string[]): void {
        this.log(`setWorkspaceFolders() called with: ${JSON.stringify(folders)}`);
        const oldFolders = [...this.workspaceFolders];
        this.workspaceFolders = folders;
        this.log(`Workspace folders changed from ${JSON.stringify(oldFolders)} to ${JSON.stringify(folders)}`);
    }

    getLogFilePath(): string | null {
        return this.logFilePath;
    }
}