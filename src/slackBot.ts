/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { App, LogLevel } from '@slack/bolt';
import { PARTICIPANT_NAME, setPendingThread } from './slackParticipant';

// Slack message character limit — stay well under it so Markdown fences are usable.
const SLACK_MAX_CHUNK = 3000;

/**
 * Blocked Copilot-internal tool-calling narration patterns.
 * These phrases appear when the model narrates its tool-calling steps;
 * they add noise to Slack threads and should be stripped.
 */
const NARRATION_LINE_RE = /^(Let me |Now let me |I'll |Now I |Let me also |Good,? now |I see |I need to |Let me now |Let me start |Let me continue |Let me check |Let me handle |The \w+ file |It seems )/;

/**
 * Wraps a Slack Bolt App configured for Socket Mode.
 *
 * Socket Mode requires:
 *  - A regular Bot User OAuth Token (xoxb-…)
 *  - An App-Level Token (xapp-…) with the `connections:write` scope
 *  - Socket Mode enabled in the Slack app settings
 */
export class SlackBot {
	private readonly app: App;

	constructor(
		botToken: string,
		appToken: string,
		private readonly outputChannel: vscode.LogOutputChannel,
	) {
		this.app = new App({
			token: botToken,
			socketMode: true,
			appToken,
			logger: {
				debug: (...msgs) => this.outputChannel.debug(msgs.join(' ')),
				info: (...msgs) => this.outputChannel.info(msgs.join(' ')),
				warn: (...msgs) => this.outputChannel.warn(msgs.join(' ')),
				error: (...msgs) => this.outputChannel.error(msgs.join(' ')),
				setLevel: () => { /* no-op */ },
				getLevel: () => LogLevel.ERROR,
				setName: () => { /* no-op */ },
			},
		});

		this.registerHandlers();
	}

	async start() {
		await this.app.start();
		this.outputChannel.info('Slack bot connected via Socket Mode.');
	}

	async stop() {
		await this.app.stop();
		this.outputChannel.info('Slack bot disconnected.');
	}

	/**
	 * Post a message to a Slack thread.
	 *
	 * Automatically converts Markdown to Slack mrkdwn, strips noisy
	 * tool-calling narration, and splits long messages into chunks.
	 */
	async postMessage(channelId: string, threadTs: string, text: string) {
		const formatted = markdownToSlackMrkdwn(stripNarration(text));
		if (!formatted.trim()) {
			return;
		}
		for (const chunk of splitIntoChunks(formatted, SLACK_MAX_CHUNK)) {
			await this.app.client.chat.postMessage({
				channel: channelId,
				thread_ts: threadTs,
				text: chunk,
				mrkdwn: true,
				reply_broadcast: false,
				unfurl_links: false,
			});
		}
	}

	private registerHandlers() {
		this.app.message(async ({ message }) => {
			if ('subtype' in message && message.subtype) {
				return;
			}
			if ('bot_id' in message && message.bot_id) {
				return;
			}

			const channel = message.channel;
			const text = 'text' in message ? message.text : undefined;
			if (!text) {
				return;
			}

			// Skip messages that @mention the bot — the app_mention handler below
			// will process those, so handling them here too would cause duplicates.
			if (/<@[A-Z0-9]+>/i.test(text)) {
				return;
			}

			const threadTs = 'thread_ts' in message && message.thread_ts
				? message.thread_ts
				: message.ts;

			await this.handleIncoming(channel, threadTs, text);
		});

		this.app.event('app_mention', async ({ event }) => {
			const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
			if (!text) {
				return;
			}

			const channelId = event.channel;
			const threadTs = event.thread_ts ?? event.ts;

			await this.handleIncoming(channelId, threadTs, text);
		});
	}

	private async handleIncoming(channelId: string, threadTs: string, userText: string) {
		setPendingThread({ channelId, threadTs });

		try {
			await vscode.commands.executeCommand('workbench.action.chat.open', {
				query: `@${PARTICIPANT_NAME} ${userText}`,
				mode: 'agent',
			});
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			this.outputChannel.error(`Error opening chat for Slack message: ${errorMsg}`);
			await this.postMessage(channelId, threadTs, `:warning: *Error:* ${errorMsg}`);
		}
	}
}

/**
 * Split text into chunks of at most `maxLength` characters, preferring
 * newline boundaries so code blocks are not broken mid-line.
 */
function splitIntoChunks(text: string, maxLength: number): string[] {
	if (text.length <= maxLength) {
		return [text];
	}
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > 0) {
		if (remaining.length <= maxLength) {
			chunks.push(remaining);
			break;
		}
		let splitAt = remaining.lastIndexOf('\n', maxLength);
		if (splitAt < maxLength / 2) {
			splitAt = maxLength;
		}
		chunks.push(remaining.slice(0, splitAt));
		remaining = remaining.slice(splitAt).replace(/^\n+/, '');
	}
	return chunks;
}

/**
 * Strip noisy tool-calling narration lines that the LM produces while
 * working through multi-step tool loops.
 */
function stripNarration(text: string): string {
	return text
		.split('\n')
		.filter(line => !NARRATION_LINE_RE.test(line.trimStart()))
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/**
 * Convert GitHub-flavoured Markdown to Slack mrkdwn.
 *
 * Key transformations:
 *  - `**bold**` / `__bold__` → `*bold*`
 *  - `~~strike~~` → `~strike~`
 *  - `[text](url)` → `<url|text>`
 *  - `# Heading` → `*Heading*`
 *  - Code fences: strip language hints (Slack doesn't support them)
 *  - Horizontal rules → `———`
 */
function markdownToSlackMrkdwn(md: string): string {
	const placeholders: string[] = [];
	let text = md;

	// 1. Protect fenced code blocks — remove language hints.
	text = text.replace(/```\w*\n?/g, match => {
		const cleaned = match.startsWith('```') && match.trim() !== '```'
			? '```\n'
			: match;
		placeholders.push(cleaned);
		return `\x00PH${placeholders.length - 1}\x00`;
	});

	// 2. Protect inline code.
	text = text.replace(/`[^`]+`/g, match => {
		placeholders.push(match);
		return `\x00PH${placeholders.length - 1}\x00`;
	});

	// 3. Convert Markdown tables to plain-text columns.
	text = convertTables(text);

	// 4. Images → links.
	text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<$2|$1>');

	// 5. Links [text](url) → <url|text>.
	text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

	// 6. Headings → bold.
	text = text.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

	// 7. Bold: **text** or __text__ → *text*.
	text = text.replace(/\*\*(.+?)\*\*/g, '*$1*');
	text = text.replace(/__(.+?)__/g, '*$1*');

	// 8. Strikethrough: ~~text~~ → ~text~.
	text = text.replace(/~~(.+?)~~/g, '~$1~');

	// 9. Horizontal rules.
	text = text.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, '———');

	// 10. Restore placeholders.
	text = text.replace(/\x00PH(\d+)\x00/g, (_, i) => placeholders[parseInt(i)]);

	return text;
}

/**
 * Convert Markdown tables into a plain-text layout readable in Slack.
 *
 * Cells are separated by " | " and the header separator row (`|---|---|`)
 * is replaced with a thin "———" line.
 */
function convertTables(text: string): string {
	const lines = text.split('\n');
	const out: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// Detect table rows: lines that start and end with '|'
		if (!line.trimStart().startsWith('|') || !line.trimEnd().endsWith('|')) {
			out.push(line);
			continue;
		}

		// Skip separator rows (e.g. |------|--------|
		if (/^\|[\s:|-]+\|$/.test(line.trim())) {
			out.push('———');
			continue;
		}

		// Parse cells, trim whitespace
		const cells = line
			.replace(/^\|/, '')
			.replace(/\|$/, '')
			.split('|')
			.map(c => c.trim());

		out.push(cells.join('  |  '));
	}

	return out.join('\n');
}
