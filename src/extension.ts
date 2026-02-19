/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	type ExtensionContext,
	type LogOutputChannel,
	ThemeIcon,
	chat,
	commands,
	window,
	workspace,
} from 'vscode';
import { SlackBot } from './slackBot';
import { ChatBridge } from './chatBridge';
import { ConversationManager } from './conversationManager';
import { BotStatusBar } from './statusBar';
import { createSlackParticipantHandler, PARTICIPANT_ID } from './slackParticipant';

let currentBot: SlackBot | undefined;

export async function activate(context: ExtensionContext) {
	const outputChannel = window.createOutputChannel('Slack Bot', { log: true });
	context.subscriptions.push(outputChannel);

	const statusBar = new BotStatusBar();
	context.subscriptions.push(statusBar);

	const conversationManager = new ConversationManager();
	const chatBridge = new ChatBridge(outputChannel, conversationManager);

	const participantHandler = createSlackParticipantHandler(
		chatBridge,
		conversationManager,
		outputChannel,
		() => currentBot,
	);

	const chatParticipant = chat.createChatParticipant(PARTICIPANT_ID, participantHandler);
	chatParticipant.iconPath = new ThemeIcon('comment-discussion');
	context.subscriptions.push(chatParticipant);

	context.subscriptions.push(
		commands.registerCommand('vscode-slack-bot.start', async () => {
			await startBot(context, outputChannel, statusBar);
		}),
		commands.registerCommand('vscode-slack-bot.stop', async () => {
			await stopBot(outputChannel, statusBar);
		}),
		commands.registerCommand('vscode-slack-bot.configure', async () => {
			await configureTokens(context, outputChannel);
		}),
		commands.registerCommand('vscode-slack-bot.showLogs', () => {
			outputChannel.show();
		}),
	);

	if (workspace.getConfiguration('vscode-slack-bot').get<boolean>('autoStart')) {
		await startBot(context, outputChannel, statusBar);
	}
}

export async function deactivate() {
	if (currentBot) {
		await currentBot.stop().catch(() => { /* ignore during shutdown */ });
		currentBot = undefined;
	}
}

async function startBot(
	context: ExtensionContext,
	outputChannel: LogOutputChannel,
	statusBar: BotStatusBar,
) {
	const [botToken, appToken] = await Promise.all([
		context.secrets.get('vscode-slack-bot.botToken'),
		context.secrets.get('vscode-slack-bot.appToken'),
	]);

	if (!botToken || !appToken) {
		const action = await window.showErrorMessage(
			'Slack Bot tokens are not configured. Please configure them first.',
			'Configure Tokens',
		);
		if (action === 'Configure Tokens') {
			await commands.executeCommand('vscode-slack-bot.configure');
		}
		return;
	}

	if (currentBot) {
		await currentBot.stop().catch(err => outputChannel.warn(`Error stopping previous bot: ${err}`));
		currentBot = undefined;
	}

	try {
		const bot = new SlackBot(botToken, appToken, outputChannel);
		await bot.start();
		currentBot = bot;
		statusBar.setRunning(true);
		window.showInformationMessage('Slack Bot started — listening for messages via Socket Mode.');
	} catch (err) {
		outputChannel.error(`Failed to start Slack bot: ${err}`);
		window.showErrorMessage(
			`Failed to start Slack Bot: ${err instanceof Error ? err.message : err}`,
			'Show Logs',
		).then(action => {
			if (action === 'Show Logs') {
				outputChannel.show();
			}
		});
		statusBar.setRunning(false);
	}
}

async function stopBot(
	outputChannel: LogOutputChannel,
	statusBar: BotStatusBar,
) {
	if (!currentBot) {
		window.showInformationMessage('Slack Bot is not running.');
		return;
	}
	try {
		await currentBot.stop();
	} catch (err) {
		outputChannel.warn(`Error during bot stop: ${err}`);
	}
	currentBot = undefined;
	statusBar.setRunning(false);
	window.showInformationMessage('Slack Bot stopped.');
}

async function configureTokens(
	context: ExtensionContext,
	outputChannel: LogOutputChannel,
) {
	const botToken = await window.showInputBox({
		title: 'Slack Bot Token (1/2)',
		prompt: 'Enter your Slack Bot User OAuth Token (starts with xoxb-)',
		password: true,
		placeHolder: 'xoxb-…',
		validateInput: value =>
			value.startsWith('xoxb-') ? undefined : 'Bot token must start with xoxb-',
	});
	if (!botToken) {
		return;
	}

	const appToken = await window.showInputBox({
		title: 'Slack App-Level Token (2/2)',
		prompt: 'Enter your Slack App-Level Token for Socket Mode (starts with xapp-)',
		password: true,
		placeHolder: 'xapp-…',
		validateInput: value =>
			value.startsWith('xapp-') ? undefined : 'App token must start with xapp-',
	});
	if (!appToken) {
		return;
	}

	await Promise.all([
		context.secrets.store('vscode-slack-bot.botToken', botToken),
		context.secrets.store('vscode-slack-bot.appToken', appToken),
	]);

	outputChannel.info('Tokens stored securely in VS Code SecretStorage.');
	const action = await window.showInformationMessage(
		'Slack Bot tokens saved. Would you like to start the bot now?',
		'Start Bot',
	);
	if (action === 'Start Bot') {
		await commands.executeCommand('vscode-slack-bot.start');
	}
}
