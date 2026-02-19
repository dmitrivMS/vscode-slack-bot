/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	type LanguageModelChatMessage,
	LanguageModelChatMessage as LMChatMessage,
	LanguageModelChatMessageRole,
	workspace,
} from 'vscode';

/**
 * One conversation session corresponding to a single Slack thread.
 * Messages accumulate here and are replayed as context to the LM.
 */
export interface ConversationSession {
	readonly channelId: string;
	readonly threadTs: string;
	readonly messages: LanguageModelChatMessage[];
	readonly startedAt: Date;
	lastActivityAt: Date;
}

/**
 * In-memory store of conversation sessions keyed by `channelId::threadTs`.
 */
export class ConversationManager {
	private readonly sessions = new Map<string, ConversationSession>();

	private static key(channelId: string, threadTs: string): string {
		return `${channelId}::${threadTs}`;
	}

	/**
	 * Retrieve an existing session or create a new one.
	 * Optionally prepends a system prompt as a User+Assistant pair.
	 */
	getOrCreate(channelId: string, threadTs: string, systemPrompt?: string): ConversationSession {
		const k = ConversationManager.key(channelId, threadTs);
		if (!this.sessions.has(k)) {
			const messages: LanguageModelChatMessage[] = [];
			if (systemPrompt) {
				messages.push(LMChatMessage.User(systemPrompt));
				messages.push(LMChatMessage.Assistant('Understood. I am ready to help.'));
			}
			this.sessions.set(k, {
				channelId,
				threadTs,
				messages,
				startedAt: new Date(),
				lastActivityAt: new Date(),
			});
		}
		const session = this.sessions.get(k)!;
		session.lastActivityAt = new Date();
		return session;
	}

	addUser(session: ConversationSession, text: string) {
		session.messages.push(LMChatMessage.User(text));
		session.lastActivityAt = new Date();
		this.trim(session);
	}

	addAssistant(session: ConversationSession, text: string) {
		session.messages.push(LMChatMessage.Assistant(text));
		session.lastActivityAt = new Date();
	}

	private trim(session: ConversationSession) {
		const maxMessages = workspace
			.getConfiguration('vscode-slack-bot')
			.get<number>('maxHistoryMessages', 20);
		const prologue = session.messages[0]?.role === LanguageModelChatMessageRole.User &&
			session.messages[1]?.role === LanguageModelChatMessageRole.Assistant ? 2 : 0;
		while (session.messages.length > maxMessages + prologue) {
			session.messages.splice(prologue, 1);
		}
	}
}
