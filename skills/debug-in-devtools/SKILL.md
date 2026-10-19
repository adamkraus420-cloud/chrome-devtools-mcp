---
name: debug-in-devtools
description: Use this skill to connect to the Chrome DevTools UI for interactive debugging, UI/UX review, Q&A, showing elements/network requests/panels to the user, inspecting the user's current DevTools selection, and addressing or waiting for DevTools UI comment threads.
---

# Debug, Review, and Q&A in DevTools

Use this skill whenever you need to:

1. **Show targets to the user in the DevTools UI**: Open the Chrome DevTools window (`open_devtools`) and navigate to a specific panel (`elements`, `network`, `sources`, `console`), DOM element (`uid`), or network request (`reqid`) using `reveal_in_devtools`.
2. **Let the user debug or review interactively in DevTools**: Open DevTools for a page and inspect the element or network request the user currently has selected in the DevTools UI.
3. **Address user feedback and Q&A via DevTools comments**: Fetch comment threads anchored to elements or network requests (`get_devtools_comments`), answer questions or apply requested code/UI fixes in the workspace, and resolve threads with an appropriate reply (`resolve_devtools_comment`).

## Prerequisites

- **Required flag**: `open_devtools`, `reveal_in_devtools`, `get_devtools_comments`, and `resolve_devtools_comment` require the MCP server to be started with `--devtoolsComments`.
- **Headed browser**: Opening and interacting with the DevTools UI requires a visible browser window (Chrome must not be running in `--headless` mode).
- **Page targeting**: All tools in this skill are page-scoped and require a `pageId` parameter (obtained from `list_pages` or `new_page`).

## Workflows

### 1. Open DevTools for the Target Page

1. If the target `pageId` is unknown, call `list_pages` to find the page's ID.
2. Call `open_devtools` with `pageId` to open the Chrome DevTools window for that page.
   - Ensure DevTools is open (`open_devtools`) before calling `reveal_in_devtools`, `get_devtools_comments`, or `resolve_devtools_comment`.

### 2. Show Panels, Elements, or Network Requests in DevTools

To highlight a specific item or switch panels for the user:

1. Ensure DevTools is open (`open_devtools`).
2. Obtain the target identifier if revealing a specific item:
   - **DOM element**: Call `take_snapshot` (`pageId`) to get the element's `uid` (string).
   - **Network request**: Call `list_network_requests` (`pageId`) to get the request's `reqid` (number).
3. Call `reveal_in_devtools` with `pageId` and:
   - `panelName` _(optional)_: `"elements"`, `"network"`, `"sources"`, or `"console"`.
   - `uid` _(optional)_: Snapshot element `uid` to reveal in the Elements panel.
   - `reqid` _(optional)_: Network request `reqid` to reveal in the Network panel.
   - Note: `uid` and `reqid` are mutually exclusive. You may pass `panelName` alone to switch panels without selecting a target.

### 3. Inspect What the User Selected in DevTools

When the user selects an element or network request in the open DevTools window and asks a question or asks you to inspect it:

- **Selected DOM element**: Call `take_snapshot` (`pageId`). The snapshot marks the element currently selected in the DevTools Elements panel. You can then pass its `uid` to `get_css_styles`, `take_screenshot`, or `evaluate_script`.
- **Selected network request**: Call `get_network_request` with `pageId` and **omit `reqid`**. It automatically returns the request currently selected in the DevTools Network panel.

### 4. Handling DevTools Comment Threads (Two Invocation Modes)

`get_devtools_comments` accepts an optional `timeout` parameter (milliseconds, `0`–`30000`, default `10000`):

- If open threads exist, the tool returns them immediately.
- If no thread is pending, the tool waits on the server for the user to send a comment. It returns as soon as a comment arrives or when `timeout` elapses.
- On timeout, the response contains `Waited <N>ms for new DevTools comments. Call get_devtools_comments again to keep waiting.`
- With `timeout: 0`, the tool returns immediately. If no thread is pending, the response is `No open DevTools comments found.`
- Other tool calls continue to run while `get_devtools_comments` waits. A wait does not block the MCP server.
- The tool returns each thread only once. Resolve each returned thread before you wait again. Do not expect the same thread in the next response.

Choose the appropriate mode based on the user's request:

> **CRITICAL RULES**:
>
> - **Do NOT wait in Explicit / One-Shot Mode or when asked not to**: If the user says they already added comments (e.g., _"I added comments in DevTools, please address them"_) or asks not to wait, call `get_devtools_comments` **once** with `timeout: 0`. Resolve the comments and **end your turn immediately**.
> - **Do NOT add your own delays**: Do not use `sleep`, timer tools, or shell commands between `get_devtools_comments` calls. The `timeout` parameter does the wait on the server.
> - **Use the maximum wait in Interactive Watch / Review Mode**: Pass `timeout: 30000` to reduce the number of tool calls.

#### Mode A: Explicit / One-Shot Mode (Comments Already Added)

Use this mode when the user indicates comments have already been added in DevTools and asks you to address or check them (or when the user asks not to wait):

1. Call `get_devtools_comments` (`pageId`, `timeout: 0`) **once**.
2. For each returned thread (`### Thread: <id>`), inspect its context, answer the question or apply the requested fix, and call `resolve_devtools_comment` (see **Processing & Resolving Threads** below).
3. **End your turn immediately** after resolving the threads and summarizing your changes/answers in chat. Do **not** start a wait loop.

#### Mode B: Interactive Watch / Review Mode (Waiting for User Feedback)

Use this mode when the user asks to open DevTools and wait while they interactively debug, review the UI, or leave comment threads:

1. **Wait for comments**:
   - Call `get_devtools_comments` (`pageId`, `timeout: 30000`).
   - If the response contains open threads, process and resolve them (see **Processing & Resolving Threads** below).
   - If the response reports a timeout (`Waited <N>ms ...`), call `get_devtools_comments` (`pageId`, `timeout: 30000`) again immediately.
   - Stop after **4 consecutive empty waits (~2 minutes)**, or when the user asks to stop. Tell the user that you stopped waiting and how to resume.
2. **Resume watching after resolution**:
   - After you resolve all returned threads, reset the empty-wait counter.
   - Call `get_devtools_comments` (`pageId`, `timeout: 30000`) again to receive follow-up comments.
3. **Optional background sub-agent**:
   - Each wait blocks the current agent turn for up to 30 seconds.
   - If the main conversation must stay responsive and sub-agent tools are available, run the wait loop in a background sub-agent.
   - Give the sub-agent the same instructions as steps 1 and 2. Tell it to return new threads to the main agent, or to resolve them directly if it has workspace and MCP tools.

#### Processing & Resolving Threads (Reply vs. Resolve Guidance)

When `get_devtools_comments` returns one or more open threads (`### Thread: <id>`):

1. **Inspect the anchored target**:
   - `Related element uid` (`elementUid`): Inspect the element using `get_css_styles` (`pageId`, `uid`), `take_snapshot` (`pageId`), or `take_screenshot` (`pageId`, `uid`).
   - `Related network reqid` (`reqid`): Inspect the request details, headers, and payload using `get_network_request` (`pageId`, `reqid`).
   - Optionally call `reveal_in_devtools` (`pageId`, `uid` or `reqid`) if visual alignment in DevTools is helpful.
2. **Address the comment**:
   - If the comment requests a code or styling change, apply the fix in the workspace (and reload/verify the page if needed).
   - If the comment is a question or root-cause investigation, gather the necessary diagnostic information from the page, styles, or network requests without making unnecessary code edits.
3. **Resolve with tailored `replyText`**:
   - Call `resolve_devtools_comment` with `pageId`, `threadId` (the thread's `id`), and `replyText`:
     - **For questions or root-cause explanations**: Provide a **detailed, informative `replyText`** that clearly answers the user's question or explains the root cause found during inspection.
     - **For straightforward visual or code TODOs**: Keep `replyText` **concise** (1–2 sentences stating what was changed and in which file).
