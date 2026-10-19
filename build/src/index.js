/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserManager } from './BrowserManager.js';
import { loadIssueDescriptions } from './devtools/issueDescriptions.js';
import { McpContext } from './McpContext.js';
import { HeapSnapshotManager } from './processors/HeapSnapshotManager.js';
import { ClearcutLogger } from './telemetry/ClearcutLogger.js';
import { FilePersistence } from './telemetry/persistence.js';
import { McpServer as SdkMcpServer, Mutex, puppeteer, } from './third_party/index.js';
import { ToolHandler } from './ToolHandler.js';
import { createTools } from './tools/tools.js';
import { logger } from './utils/logger.js';
import { VERSION } from './version.js';
puppeteer.setFollowSymlinks(false);
/**
 * Timeout for a `roots/list` that a tool call is waiting on, matching the 5s
 * default used for page operations. `getContext()` awaits it while
 * `ToolHandler` holds the tool mutex, so leaving it unbounded lets a client
 * that negotiates `roots` but does not answer block every tool for the SDK's
 * default of 60s. Background refreshes are not bounded by this, so roots a
 * slow client sends late still land.
 */
const ROOTS_REQUEST_TIMEOUT = 5_000;
export class McpServer {
    server;
    #serverArgs;
    #browserManager;
    #context;
    #heapSnapshotManager = new HeapSnapshotManager();
    /**
     * Client roots stay valid across browser reconnects and only the client can
     * invalidate them through a `roots/list_changed` notification. CLI-configured
     * roots are read from `#serverArgs` when combining roots.
     */
    #lastClientRoots;
    /**
     * Whether a tool call already waited for the initial `roots/list`, so a
     * client that negotiates roots but never answers only delays the first call.
     */
    #awaitedInitialRoots = false;
    #toolMutex = new Mutex();
    #tools = new Map();
    constructor(serverArgs, options) {
        this.#serverArgs = serverArgs;
        this.#browserManager = options.browserManager;
        if (this.#serverArgs.usageStatistics) {
            ClearcutLogger.initialize({
                persistence: new FilePersistence(),
                logFile: this.#serverArgs.logFile,
                appVersion: VERSION,
                clearcutEndpoint: this.#serverArgs.clearcutEndpoint,
                clearcutForceFlushIntervalMs: this.#serverArgs.clearcutForceFlushIntervalMs,
                clearcutIncludePidHeader: this.#serverArgs.clearcutIncludePidHeader,
            });
        }
        this.server = new SdkMcpServer({
            name: 'chrome_devtools',
            title: 'Chrome DevTools MCP server',
            version: VERSION,
        }, {
            capabilities: { logging: {}, tools: { listChanged: true } },
            // Enabling or updating many tools at once sends a single notification.
            debouncedNotificationMethods: ['notifications/tools/list_changed'],
        });
        this.#context = McpContext.create(logger, {
            experimentalDevToolsDebugging: this.#serverArgs.experimentalDevtools ?? false,
            experimentalIncludeAllPages: this.#serverArgs.experimentalIncludeAllPages,
            performanceCrux: this.#serverArgs.performanceCrux,
            sourceMaps: this.#serverArgs.sourceMaps,
            allowlist: this.#serverArgs.allowedUrlPattern,
            blocklist: this.#serverArgs.blockedUrlPattern,
            allowUnrestrictedPaths: this.#serverArgs.allowUnrestrictedPaths,
            categoryExtensions: this.#serverArgs.categoryExtensions,
            heapSnapshotManager: this.#heapSnapshotManager,
            getBrowser: () => this.#browserManager.ensureBrowser(),
        });
        this.#context.setRoots(this.#combinedRoots());
        this.server.server.setRequestHandler('logging/setLevel', () => {
            return {};
        });
        this.server.server.oninitialized = () => {
            const clientName = this.server.server.getClientVersion()?.name;
            if (clientName) {
                ClearcutLogger.get()?.setClientName(clientName);
            }
            if (this.server.server.getClientCapabilities()?.roots) {
                void this.#updateRoots();
                this.server.server.setNotificationHandler('notifications/roots/list_changed', () => {
                    void this.#updateRoots();
                });
            }
            else if (!this.#serverArgs.allowUnrestrictedPaths &&
                (this.#serverArgs.filesystemRoot ?? []).length === 0) {
                console.warn('[chrome-devtools-mcp] The connecting client did not negotiate the MCP roots ' +
                    'capability. Tools that read or write local files will be restricted to the OS temp directory. ' +
                    'To restore the previous unrestricted behavior, start the server with ' +
                    '--allow-unrestricted-paths.');
            }
        };
    }
    async connect(transport) {
        return await this.server.connect(transport);
    }
    async callTool(name, args = {}) {
        const toolHandler = this.#tools.get(name)?.handler;
        if (!toolHandler) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Tool ${name} not found`,
                    },
                ],
                isError: true,
            };
        }
        const parseResult = await toolHandler.registeredInputSchema.safeParseAsync(args);
        if (!parseResult.success) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Input validation error: Invalid arguments for tool ${name}: ${parseResult.error.issues
                            .map(issue => `${issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''}${issue.message}`)
                            .join(', ')}`,
                    },
                ],
                isError: true,
            };
        }
        return await toolHandler.handle(parseResult.data);
    }
    /**
     * Closes the MCP connection and disposes internal context/listeners.
     */
    async close() {
        try {
            this.#context.dispose();
        }
        catch (err) {
            logger?.('Failed to dispose context', err);
        }
        this.#heapSnapshotManager.dispose();
        await Promise.allSettled([
            this.#browserManager.close(),
            this.server.close(),
        ]);
    }
    [Symbol.dispose]() {
        this.close().catch(err => {
            logger?.('Failed to dispose McpServer', err);
        });
    }
    async [Symbol.asyncDispose]() {
        await this.close();
    }
    static async from(serverArgs, options) {
        const server = new McpServer(serverArgs, options);
        await server.#init();
        return server;
    }
    async #init() {
        for (const tool of createTools(this.#serverArgs)) {
            this.#registerTool(tool);
        }
        await loadIssueDescriptions();
    }
    #combinedRoots() {
        const configuredRoots = (this.#serverArgs.allowUnrestrictedPaths
            ? []
            : (this.#serverArgs.filesystemRoot ?? [])).map(root => {
            const rootPath = path.resolve(root);
            return {
                uri: pathToFileURL(rootPath).href,
                name: path.basename(rootPath) || rootPath,
            };
        });
        if (configuredRoots.length === 0 && this.#lastClientRoots === undefined) {
            return undefined;
        }
        return [...configuredRoots, ...(this.#lastClientRoots ?? [])];
    }
    /**
     * `timeout` is only passed where a tool call is waiting on the result – the
     * background refreshes (on initialization and `roots/list_changed`) block
     * nobody, so bounding them would just discard roots a slow client was about
     * to send
     */
    async #updateRoots(timeout) {
        if (!this.server.server.getClientCapabilities()?.roots) {
            return;
        }
        try {
            const result = await this.server.server.request({ method: 'roots/list' }, timeout === undefined ? undefined : { timeout });
            this.#lastClientRoots = result.roots;
            this.#context.setRoots(this.#combinedRoots());
        }
        catch (e) {
            logger?.('Failed to list roots', e);
        }
    }
    async #getContext() {
        if (this.#lastClientRoots === undefined && !this.#awaitedInitialRoots) {
            this.#awaitedInitialRoots = true;
            // Nothing listed yet, so this call has to wait – bounded, since it is
            // holding the tool mutex, and a later background refresh still lands
            await this.#updateRoots(ROOTS_REQUEST_TIMEOUT);
        }
        return this.#context;
    }
    #createToolHandler(tool) {
        return new ToolHandler(tool, this.#serverArgs, () => this.#getContext(), this.#toolMutex, () => this.#browserManager.abandonPendingAttempt());
    }
    #registerTool(tool) {
        const handler = this.#createToolHandler(tool);
        const registeredTool = this.server.registerTool(tool.name, {
            description: tool.description,
            inputSchema: handler.registeredInputSchema,
            annotations: tool.annotations,
        }, handler.handle);
        if (handler.disabled) {
            registeredTool.disable();
        }
        this.#tools.set(tool.name, { handler, registeredTool });
    }
}
/**
 * Creates and initializes a Chrome DevTools MCP server instance.
 *
 * Maintained as a public API for backwards compatibility because external
 * consumers and integrations rely on `createMcpServer()`. For new code,
 * prefer using `McpServer.from(serverArgs, options)`.
 */
export async function createMcpServer(serverArgs, options) {
    const browserManager = new BrowserManager(serverArgs, {
        logFile: options.logFile,
    });
    const server = await McpServer.from(serverArgs, {
        browserManager,
        ...options,
    });
    return { server: server.server };
}
//# sourceMappingURL=index.js.map