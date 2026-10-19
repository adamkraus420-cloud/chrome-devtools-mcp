/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { McpResponse } from './McpResponse.js';
import { SlimMcpResponse } from './SlimMcpResponse.js';
import { ClearcutLogger } from './telemetry/ClearcutLogger.js';
import { zod } from './third_party/index.js';
import { labels } from './tools/categories.js';
import { categoryToFlagName } from './config/category-options.js';
import { isAvailableInMode, isBrowserlessTool, isPageScopedTool, isSlimTool, } from './tools/ToolDefinition.js';
import { logger } from './utils/logger.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isLocalhost } from './utils/url.js';
/**
 * Upper bound on how long a tool call may wait to acquire the browser
 * (connect/launch and McpContext initialization). A connect attempt on a
 * half-open socket can hang without ever failing; this bound turns that into
 * a clear error and abandons the attempt so the next call starts fresh.
 *
 * This does not bound the tool's own work. A slow but valid call (a long
 * `wait_for` timeout, an `evaluate_script` awaiting a slow promise, a
 * Lighthouse audit) must finish on its own terms without the browser being
 * closed underneath it. A transport that dies mid-call is detected by the
 * WebSocket keep-alive configured in BrowserManager#connect(), which rejects
 * the in-flight CDP calls and fires `disconnected`.
 */
export const TOOL_CALL_TIMEOUT_MS = 60_000;
class ToolCallTimeoutError extends Error {
}
function buildDisabledMessage(toolName, flag, categoryLabel) {
    const reason = categoryLabel
        ? `is in category ${categoryLabel} which`
        : `requires ${flag.startsWith('--experimental') ? 'experimental feature' : 'flag'} ${flag} and`;
    return `Tool ${toolName} ${reason} is currently disabled. Enable it by running chrome-devtools start ${flag}=true. For more information check the README.`;
}
function getToolStatusInfo(tool, serverArgs) {
    if (!isAvailableInMode(tool, serverArgs)) {
        return {
            disabled: true,
            unavailableInMode: true,
            reason: isSlimTool(tool)
                ? `Tool ${tool.name} is only available with --slim.`
                : `Tool ${tool.name} is not available with --slim.`,
        };
    }
    const category = tool.annotations.category;
    if (category) {
        const flag = categoryToFlagName(category);
        if (!serverArgs[flag]) {
            return {
                disabled: true,
                reason: buildDisabledMessage(tool.name, `--${flag}`, labels[category]),
            };
        }
    }
    for (const condition of tool.annotations.conditions || []) {
        if (!serverArgs[condition]) {
            return {
                disabled: true,
                reason: buildDisabledMessage(tool.name, `--${condition}`),
            };
        }
    }
    return { disabled: false };
}
async function validateAndResolvePathOrUrl(filePathOrUrl, context, allowUrl) {
    if (filePathOrUrl.trim().length === 0) {
        return undefined;
    }
    let url;
    try {
        url = new URL(filePathOrUrl);
    }
    catch {
        // Not a URL; fall through and validate it as a regular file path.
    }
    if (url) {
        if (url.protocol === 'file:') {
            return pathToFileURL(await context.validatePath(fileURLToPath(url))).href;
        }
        if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
            // Only pass a remote URL through unchanged for parameters whose sink
            // actually fetches the URL or hands it to the browser (allowUrl). For a
            // filesystem-path parameter, a value that merely looks like an http/ws
            // URL must still be rejected outright: `new URL()` accepts
            // `http://x/../../etc/passwd`, and the downstream filesystem API (e.g.
            // Puppeteer's uploadFile) path.resolve()s that non-absolute string into
            // an absolute host path, which would bypass validatePath (workspace
            // roots and the temp-dir fallback) if it fell through to it unchanged.
            if (allowUrl) {
                return filePathOrUrl;
            }
            throw new Error('This parameter expects a file path, not a URL.');
        }
    }
    return await context.validatePath(filePathOrUrl);
}
function isLocalBrowser(browser) {
    if (browser.process()) {
        return true;
    }
    const wsEndpoint = browser.wsEndpoint();
    if (wsEndpoint && isLocalhost(wsEndpoint)) {
        return true;
    }
    return false;
}
function shouldValidateFile(option, isLocal) {
    if (option === true) {
        return true;
    }
    if (typeof option === 'object' && option !== null) {
        if (isLocal) {
            return Boolean(option.local);
        }
        return Boolean(option.remote);
    }
    return false;
}
/**
 * `isLocal` tells whether files are accessed on the machine the server runs on,
 * which is always the case for browserless tools.
 */
async function validateToolFiles(tool, params, context, isLocal) {
    for (const [key, option] of Object.entries(tool.verifyFilesSchema)) {
        if (shouldValidateFile(option, isLocal)) {
            const allowUrl = option !== true && option.allowUrl === true;
            const val = params[key];
            if (typeof val === 'string') {
                params[key] = await validateAndResolvePathOrUrl(val, context, allowUrl);
            }
            else if (Array.isArray(val)) {
                const updated = [];
                for (const item of val) {
                    if (typeof item === 'string') {
                        const resolved = await validateAndResolvePathOrUrl(item, context, allowUrl);
                        if (resolved !== undefined) {
                            updated.push(resolved);
                        }
                    }
                    else {
                        throw new Error('Unexpected non-string value as a file path or URL');
                    }
                }
                params[key] = updated;
            }
        }
    }
}
export class ToolHandler {
    tool;
    serverArgs;
    getContext;
    toolMutex;
    abandonPendingBrowserAttemptOnTimeout;
    inputSchema;
    registeredInputSchema;
    disabled;
    disabledReason;
    constructor(tool, serverArgs, getContext, toolMutex, abandonPendingBrowserAttemptOnTimeout) {
        this.tool = tool;
        this.serverArgs = serverArgs;
        this.getContext = getContext;
        this.toolMutex = toolMutex;
        this.abandonPendingBrowserAttemptOnTimeout = abandonPendingBrowserAttemptOnTimeout;
        const { disabled, reason, unavailableInMode } = getToolStatusInfo(tool, serverArgs);
        this.disabledReason = reason;
        this.disabled =
            disabled && (Boolean(unavailableInMode) || !serverArgs.viaCli);
        this.inputSchema = tool.schema;
        this.registeredInputSchema = zod.object(this.inputSchema).strict();
    }
    /**
     * Races a promise against TOOL_CALL_TIMEOUT_MS, calling onTimeout() if the
     * timer wins. The loser of the race is left running — there is no way to
     * cancel a pending connect/launch — but since nothing is left awaiting it,
     * it cannot block subsequent tool calls.
     */
    async #raceWithTimeout(promise, onTimeout) {
        const timeoutError = new ToolCallTimeoutError(`Tool "${this.tool.name}" timed out after ${TOOL_CALL_TIMEOUT_MS}ms waiting for the browser connection to be established. The connection attempt will be retried automatically on the next tool call.`);
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(timeoutError), TOOL_CALL_TIMEOUT_MS);
            timer.unref?.();
        });
        try {
            return await Promise.race([promise, timeout]);
        }
        catch (err) {
            if (err === timeoutError) {
                onTimeout();
            }
            throw err;
        }
        finally {
            clearTimeout(timer);
        }
    }
    #dataFormat() {
        // --experimentalDataFormat takes precedence over the legacy
        // --experimentalToonFormat.
        return (this.serverArgs.experimentalDataFormat ??
            (this.serverArgs.experimentalToonFormat ? 'toon' : 'default'));
    }
    /**
     * Browserless tools never establish a browser connection, so they also never
     * wait for one under TOOL_CALL_TIMEOUT_MS.
     */
    async #runBrowserlessTool(tool, params, response, context, lock) {
        try {
            await validateToolFiles(tool, params, context, true);
            lock.releaseIfYielding();
            await tool.handler({ params }, response, context);
        }
        catch (err) {
            response.setError(err);
        }
        finally {
            await lock.reacquire();
        }
        return await response.handle(context, this.#dataFormat());
    }
    async #runBrowserTool(tool, params, response, context, lock, onTelemetryData) {
        // ensureBrowser() has no cancellation mechanism, so this timeout only
        // stops us from waiting — the attempt itself keeps running abandoned.
        // abandonPendingBrowserAttemptOnTimeout() tells BrowserManager to
        // discard that attempt if it succeeds later instead of handing it to a
        // subsequent caller — see BrowserManager#abandonPendingAttempt()'s doc
        // comment for the full mechanism.
        const browser = await this.#raceWithTimeout(context.ensureBrowser(), () => this.abandonPendingBrowserAttemptOnTimeout());
        logger?.(`${tool.name} browser: resolved`);
        if (context.consumeReconnectNotice()) {
            response.setReconnectNotice();
        }
        let page;
        try {
            await validateToolFiles(tool, params, context, isLocalBrowser(browser));
            if (isPageScopedTool(tool)) {
                const pageId = typeof params.pageId === 'number' ? params.pageId : undefined;
                page =
                    this.serverArgs.pageIdRouting &&
                        pageId !== undefined &&
                        !isSlimTool(tool)
                        ? context.getPageById(pageId)
                        : context.getSelectedMcpPage();
                await page?.init();
                response.setPage(page);
                if (tool.blockedByDialog) {
                    page.throwIfDialogOpen();
                }
                lock.releaseIfYielding();
                await tool.handler({
                    params,
                    page,
                }, response, context);
            }
            else {
                lock.releaseIfYielding();
                await tool.handler({
                    params,
                }, response, context);
            }
        }
        catch (err) {
            response.setError(err);
        }
        finally {
            await lock.reacquire();
        }
        onTelemetryData(await context.getDevToolsData(page), context.getSelectedMcpPageUrl(page));
        return await response.handle(context, this.#dataFormat());
    }
    handle = async (params) => {
        let guard = await this.toolMutex.acquire();
        if (this.disabledReason) {
            guard[Symbol.dispose]();
            return {
                content: [
                    {
                        type: 'text',
                        text: this.disabledReason,
                    },
                ],
                isError: true,
            };
        }
        const startTime = Date.now();
        let success = false;
        let devToolsData;
        let pageUrl;
        try {
            logger?.(`${this.tool.name} request: ${JSON.stringify(params, null, '  ')}`);
            const context = await this.getContext();
            const response = this.serverArgs.slim
                ? new SlimMcpResponse(this.serverArgs)
                : new McpResponse(this.serverArgs);
            response.setRedactNetworkHeaders(this.serverArgs.redactNetworkHeaders);
            // When the tool yields the lock, the handler waits for external events.
            // Release the lock so other tool calls proceed, and re-acquire it
            // before the response is built.
            const lock = {
                releaseIfYielding: () => {
                    if (this.tool.yieldsToolLock && guard) {
                        guard[Symbol.dispose]();
                        guard = undefined;
                    }
                },
                reacquire: async () => {
                    guard ??= await this.toolMutex.acquire();
                },
            };
            const { content, structuredContent } = isBrowserlessTool(this.tool)
                ? await this.#runBrowserlessTool(this.tool, params, response, context, lock)
                : await this.#runBrowserTool(this.tool, params, response, context, lock, (data, url) => {
                    devToolsData = data;
                    pageUrl = url;
                });
            const result = {
                content,
            };
            if (response.error) {
                result.isError = true;
            }
            success = true;
            if (this.serverArgs.experimentalStructuredContent) {
                result.structuredContent = structuredContent;
            }
            return result;
        }
        catch (err) {
            logger?.(`${this.tool.name} error:`, err, err?.stack);
            let errorText = err && 'message' in err ? err.message : String(err);
            if ('cause' in err && err.cause) {
                errorText += `\nCause: ${err.cause.message}`;
            }
            return {
                content: [
                    {
                        type: 'text',
                        text: errorText,
                    },
                ],
                isError: true,
            };
        }
        finally {
            guard?.[Symbol.dispose]();
            void ClearcutLogger.get()?.logToolInvocation({
                toolName: this.tool.name,
                params,
                schema: this.inputSchema,
                success,
                latencyMs: Date.now() - startTime,
                devToolsData,
                pageUrl,
            });
        }
    };
}
//# sourceMappingURL=ToolHandler.js.map