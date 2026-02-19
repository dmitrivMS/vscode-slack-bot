/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChatBridge } from './chatBridge';
import { ConversationManager } from './conversationManager';
import type { SlackBot } from './slackBot';

export const PARTICIPANT_ID = 'vscode-slack-bot.slack';

/** Short name used for `@slack` mentions in chat queries. Must match the `name` field in package.json `chatParticipants`. */
export const PARTICIPANT_NAME = 'slack';

/** Pending Slack thread info set by `SlackBot` before opening the chat. */
interface PendingThread {
	channelId: string;
	threadTs: string;
}

let pendingThread: PendingThread | undefined;

/** Called by `SlackBot.handleIncoming` to stash which thread the next request belongs to. */
export function setPendingThread(thread: PendingThread) {
	pendingThread = thread;
}

/**
 * Creates the `ChatRequestHandler` for the `@slack` participant.
 *
 * The handler runs the full tool-calling loop via `ChatBridge`, streams the
 * response into the standard Copilot Chat UI, and posts the result back to
 * the originating Slack thread.
 */
export function createSlackParticipantHandler(
	chatBridge: ChatBridge,
	conversationManager: ConversationManager,
	outputChannel: vscode.LogOutputChannel,
	getBot: () => SlackBot | undefined,
): vscode.ChatRequestHandler {
	return async (
		request: vscode.ChatRequest,
		_context: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
	): Promise<vscode.ChatResult> => {
		const prompt = request.prompt.trim();
		const thread = pendingThread;
		pendingThread = undefined;

		if (!thread) {
			stream.markdown(
				'**No active Slack thread.**\n\n' +
				'Start a conversation with your Slack bot first (send it a DM or mention it in a channel), ' +
				'then the incoming message will be routed here automatically.',
			);
			return {};
		}

		const { channelId, threadTs } = thread;

		const systemPrompt = vscode.workspace
			.getConfiguration('vscode-slack-bot')
			.get<string>('systemPrompt', '');

		const session = conversationManager.getOrCreate(channelId, threadTs, systemPrompt || undefined);

		stream.progress('Thinking\u2026');

		try {
			const fullResponse = await chatBridge.processMessageStreamed(
				session, prompt, stream, request.model, token, request.toolInvocationToken,
			);

			const bot = getBot();
			if (bot && fullResponse.trim()) {
				try {
					await bot.postMessage(channelId, threadTs, fullResponse);
				} catch (err) {
					stream.markdown(`\n\n> :warning: Could not post response to Slack: ${err instanceof Error ? err.message : err}`);
				}
			}

			return {};
		} catch (err) {
			outputChannel.error(`Participant handler error: ${err}`);
			stream.markdown(`\n**Error:** ${err instanceof Error ? err.message : String(err)}`);
			return {};
		}
	};
}
