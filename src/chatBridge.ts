/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ConversationManager, ConversationSession } from './conversationManager';

/** Safety cap on tool-calling rounds per turn to prevent runaway loops. */
const MAX_TOOL_ROUNDS = 20;

/**
 * Multi-turn tool-calling bridge between the language model and VS Code chat.
 *
 * Manages the message loop: sends conversation history to the model with
 * available tools, streams text to the chat UI, invokes tools as requested,
 * and accumulates the final response.
 */
export class ChatBridge {
	constructor(
		private readonly outputChannel: vscode.LogOutputChannel,
		private readonly conversationManager: ConversationManager,
	) { }

	/**
	 * Stream a message through the full tool-calling loop,
	 * forwarding text fragments to the VS Code chat stream as they arrive.
	 */
	async processMessageStreamed(
		session: ConversationSession,
		userText: string,
		stream: vscode.ChatResponseStream,
		model: vscode.LanguageModelChat,
		token: vscode.CancellationToken,
		toolInvocationToken: vscode.ChatParticipantToolToken,
	): Promise<string> {
		this.outputChannel.info(`[${session.channelId}/${session.threadTs}] User (VS Code): ${userText}`);

		this.conversationManager.addUser(session, userText);

		const fullText = await this.runToolLoop(
			[...session.messages],
			model,
			token,
			stream,
			toolInvocationToken,
		);

		this.conversationManager.addAssistant(session, fullText);
		return fullText;
	}

	/**
	 * Core multi-turn tool-calling loop.
	 *
	 * Sends messages to the LM with all available tools attached, then:
	 *  - Streams text parts to `stream` and accumulates them.
	 *  - On tool call parts: invokes each tool via `lm.invokeTool`,
	 *    appends the assistant-turn + tool-result messages, and loops.
	 *  - Stops when the model emits no tool calls (pure text response) or
	 *    after MAX_TOOL_ROUNDS to prevent infinite loops.
	 */
	private async runToolLoop(
		workingMessages: vscode.LanguageModelChatMessage[],
		model: vscode.LanguageModelChat,
		token: vscode.CancellationToken,
		stream: vscode.ChatResponseStream | undefined,
		toolInvocationToken?: vscode.ChatParticipantToolToken,
	): Promise<string> {
		const tools = [...vscode.lm.tools];
		let accumulatedText = '';

		for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
			const response = await model.sendRequest(workingMessages, { tools }, token);

			const toolCalls: vscode.LanguageModelToolCallPart[] = [];
			let roundText = '';

			for await (const part of response.stream) {
				if (part instanceof vscode.LanguageModelTextPart) {
					roundText += part.value;
					accumulatedText += part.value;
					stream?.markdown(part.value);
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					toolCalls.push(part);
				}
			}

			if (toolCalls.length === 0) {
				break;
			}

			for (const tc of toolCalls) {
				this.outputChannel.info(`Tool call: ${tc.name} (${tc.callId})`);
				stream?.progress(`Running tool: ${tc.name}…`);
			}

			const assistantContent: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [
				...(roundText ? [new vscode.LanguageModelTextPart(roundText)] : []),
				...toolCalls,
			];
			workingMessages.push(vscode.LanguageModelChatMessage.Assistant(assistantContent));

			const toolResults: vscode.LanguageModelToolResultPart[] = [];
			for (const tc of toolCalls) {
				try {
					const result = await vscode.lm.invokeTool(
						tc.name,
						{ input: tc.input, toolInvocationToken },
						token,
					);
					toolResults.push(new vscode.LanguageModelToolResultPart(tc.callId, [...result.content]));
					this.outputChannel.info(
						`Tool result: ${tc.name} → ${summarizeToolContent(result.content)}`,
					);
				} catch (err) {
					const fallback = await tryFallbackToolCall(tc);
					if (fallback) {
						toolResults.push(new vscode.LanguageModelToolResultPart(tc.callId, fallback));
						this.outputChannel.info(`Tool fallback: ${tc.name} → ${fallback.map(p => p.value).join('').slice(0, 200)}`);
					} else {
						const errMsg = err instanceof Error ? err.message : String(err);
						this.outputChannel.warn(`Tool error: ${tc.name}: ${errMsg}`);
						toolResults.push(new vscode.LanguageModelToolResultPart(
							tc.callId,
							[new vscode.LanguageModelTextPart(`Error invoking tool: ${errMsg}`)],
						));
					}
				}
			}

			workingMessages.push(vscode.LanguageModelChatMessage.User(toolResults));
		}

		return accumulatedText;
	}
}

/**
 * Produce a short log-friendly summary of tool result content.
 *
 * Extracts text from `LanguageModelTextPart` items for the log; non-text
 * parts (TSX, data, etc.) are counted but not serialised.
 */
function summarizeToolContent(content: ReadonlyArray<unknown>): string {
	const texts: string[] = [];
	let otherCount = 0;
	for (const item of content) {
		if (item instanceof vscode.LanguageModelTextPart) {
			texts.push(item.value);
		} else if (
			item !== null &&
			typeof item === 'object' &&
			'value' in item &&
			typeof (item as { value: unknown }).value === 'string'
		) {
			texts.push((item as { value: string }).value);
		} else {
			otherCount++;
		}
	}
	const preview = texts.join('').slice(0, 200);
	if (otherCount > 0) {
		return `${preview || '(no text)'}  [+${otherCount} non-text part(s)]`;
	}
	return preview || '(empty)';
}

/**
 * Copilot's file-editing tools (`copilot_createFile`, `copilot_editFile`)
 * require an internal "prompt context" stream that is unavailable when tools
 * are invoked from a third-party participant's tool loop. When they fail,
 * fall back to direct filesystem operations using the tool-call input.
 */
async function tryFallbackToolCall(tc: vscode.LanguageModelToolCallPart): Promise<vscode.LanguageModelTextPart[] | undefined> {
	const input = tc.input as Record<string, unknown> | undefined;
	if (!input || typeof input !== 'object') {
		return undefined;
	}

	if (tc.name === 'copilot_createFile') {
		const filePath = input.filePath;
		const content = input.content;
		if (typeof filePath !== 'string' || typeof content !== 'string') {
			return undefined;
		}
		const uri = resolveFilePath(filePath);
		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
		return [new vscode.LanguageModelTextPart(`File created: ${filePath}`)];
	}

	if (tc.name === 'copilot_editFile') {
		const filePath = input.filePath;
		const newContent = input.newContent;
		if (typeof filePath !== 'string' || typeof newContent !== 'string') {
			return undefined;
		}
		const uri = resolveFilePath(filePath);
		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(newContent));
		return [new vscode.LanguageModelTextPart(`File edited: ${filePath}`)];
	}

	return undefined;
}

/** Resolve a tool-provided file path to a workspace URI. */
function resolveFilePath(filePath: string): vscode.Uri {
	// If already absolute, use as-is.
	if (/^[/\\]|^[a-zA-Z]:/.test(filePath)) {
		return vscode.Uri.file(filePath);
	}
	// Relative path → resolve against first workspace folder.
	const root = vscode.workspace.workspaceFolders?.[0]?.uri;
	return root ? vscode.Uri.joinPath(root, filePath) : vscode.Uri.file(filePath);
}
